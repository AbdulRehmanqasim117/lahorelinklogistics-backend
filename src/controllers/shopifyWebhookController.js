const crypto = require('crypto');
const prisma = require('../prismaClient');

const normalizeShopDomain = (value) => {
  if (!value) return '';
  let v = String(value).trim().toLowerCase();

  v = v.replace(/^https?:\/\//, '');

  const adminMatch = v.match(/admin\.shopify\.com\/store\/([^/?#]+)/);
  if (adminMatch && adminMatch[1]) {
    return `${adminMatch[1]}.myshopify.com`;
  }

  const hashIndex = v.indexOf('#');
  if (hashIndex !== -1) {
    v = v.slice(0, hashIndex);
  }

  const queryIndex = v.indexOf('?');
  if (queryIndex !== -1) {
    v = v.slice(0, queryIndex);
  }

  const slashIndex = v.indexOf('/');
  if (slashIndex !== -1) {
    v = v.slice(0, slashIndex);
  }

  return v;
};

const getWebhookSecret = () => {
  return (
    (process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_API_SECRET || '')
      .trim()
  );
};

const verifyShopifyHmac = (rawBody, hmacHeader) => {
  const secret = getWebhookSecret();
  // If no secret is configured, treat verification as a no-op (useful for local/dev environments)
  if (!secret) {
    console.warn('[ShopifyWebhook] No webhook secret configured, skipping HMAC verification');
    return true;
  }

  if (!hmacHeader || !rawBody) {
    return false;
  }

  const digest = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('base64');

  try {
    const received = Buffer.from(String(hmacHeader), 'utf8');
    const expected = Buffer.from(digest, 'utf8');
    if (received.length !== expected.length) return false;
    return crypto.timingSafeEqual(received, expected);
  } catch (e) {
    return false;
  }
};

const mapShopifyToIntegratedOrder = (payload) => {
  const shipping = payload.shipping_address || {};
  const billing = payload.billing_address || {};

  const customerName =
    shipping.name || billing.name || payload.customer?.first_name || '';
  const phone =
    shipping.phone ||
    billing.phone ||
    payload.phone ||
    (Array.isArray(payload.customer?.phone_numbers)
      ? payload.customer.phone_numbers[0]
      : '');

  const city = shipping.city || shipping.province || billing.city || '';
  const addressParts = [
    shipping.address1,
    shipping.address2,
    city,
    shipping.country,
  ].filter(Boolean);

  const address = addressParts.join(', ');

  const lineItems = Array.isArray(payload.line_items) ? payload.line_items : [];
  const itemsSummary = lineItems
    .map((i) => {
      const qty = Number(i.quantity || 1);
      const title = i.title || 'Item';
      return `${qty}x ${title}`;
    })
    .join(', ');

  const totalPrice = Number(payload.total_price || 0);
  const currency = payload.currency || '';

  return {
    customerName,
    phone,
    address,
    city,
    itemsSummary,
    totalPrice,
    currency,
    financialStatus: payload.financial_status || '',
    fulfillmentStatus: payload.fulfillment_status || '',
    createdAtProvider: payload.created_at ? new Date(payload.created_at) : new Date(),
  };
};

exports.handleShopifyWebhook = async (req, res) => {
  try {
    const topic = req.header('X-Shopify-Topic') || '';
    const shopDomain = normalizeShopDomain(
      req.header('X-Shopify-Shop-Domain') || '',
    );
    const hmacHeader = req.header('X-Shopify-Hmac-Sha256') || '';
    const webhookId = req.header('X-Shopify-Webhook-Id') || '';
    const webhookCreatedAtHeader = req.header('X-Shopify-Webhook-Created-At') || '';

    const rawBody = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(req.body || '');

    if (!verifyShopifyHmac(rawBody, hmacHeader)) {
      console.warn('[ShopifyWebhook] Invalid HMAC', { topic, shopDomain });
      return res.status(401).send('Invalid HMAC');
    }

    const rawString = rawBody.toString('utf8') || '{}';

    let payload;
    try {
      payload = JSON.parse(rawString);
    } catch (e) {
      console.error('[ShopifyWebhook] Failed to parse JSON body', e);
      return res.status(400).send('Invalid JSON');
    }

    const orderId = String(payload.id || payload.admin_graphql_api_id || '');
    if (!orderId) {
      console.warn('[ShopifyWebhook] Missing order id in payload', {
        topic,
        shopDomain,
      });
      return res.status(200).send('Ignored');
    }

    const payloadHash = crypto.createHash('sha256').update(rawString).digest('hex');

    let webhookCreatedAt = new Date();
    if (webhookCreatedAtHeader) {
      const parsedDate = new Date(webhookCreatedAtHeader);
      if (!Number.isNaN(parsedDate.getTime())) {
        webhookCreatedAt = parsedDate;
      }
    }

    const integration = await prisma.shipperIntegration.findFirst({
      where: {
        provider: 'SHOPIFY',
        shopDomain,
        status: 'active',
      },
    });

    if (!integration) {
      console.log('[ShopifyWebhook] No active ShipperIntegration for shop', {
        shopDomain,
        topic,
      });
      return res.status(200).send('No integration for shop');
    }

    const shipperId = integration.shipperId;

    const whereUnique = {
      shipperId_provider_shopDomain_providerOrderId: {
        shipperId,
        provider: 'SHOPIFY',
        shopDomain,
        providerOrderId: orderId,
      },
    };

    const existing = await prisma.integratedOrder.findUnique({
      where: whereUnique,
    });

    const updatedAt =
      payload.updated_at || payload.processed_at || payload.created_at || null;

    if (existing) {
      const sameWebhookId =
        webhookId && existing.lastWebhookId && existing.lastWebhookId === webhookId;

      const sameUpdatedAt =
        updatedAt &&
        existing.rawPayload &&
        existing.rawPayload.updated_at &&
        existing.rawPayload.updated_at === updatedAt;

      const samePayloadHash =
        existing.lastPayloadHash && existing.lastPayloadHash === payloadHash;

      if (sameWebhookId || (sameUpdatedAt && samePayloadHash)) {
        console.log('[ShopifyWebhook] Replay detected, skipping upsert', {
          topic,
          shopDomain,
          orderId,
          webhookId,
        });

        await prisma.integratedOrder.update({
          where: whereUnique,
          data: {
            webhookDeliveryCount: { increment: 1 },
            lastWebhookId: webhookId || existing.lastWebhookId || null,
            lastWebhookAt: webhookCreatedAt,
            lastPayloadHash: payloadHash,
          },
        });

        return res.status(200).send('OK');
      }
    }

    const mapped = mapShopifyToIntegratedOrder(payload);

    const update = {
      shipperId,
      provider: 'SHOPIFY',
      shopDomain,
      providerOrderNumber: String(payload.order_number || payload.name || ''),
      rawPayload: payload,
      ...mapped,
      lastWebhookId: webhookId || (existing && existing.lastWebhookId) || null,
      lastWebhookAt: webhookCreatedAt,
      lastPayloadHash: payloadHash,
    };

    // Mark cancelled orders in tags for quick visibility
    if (topic === 'orders/cancelled') {
      update.tags = ['cancelled'];
    }

    const integratedOrder = await prisma.integratedOrder.upsert({
      where: whereUnique,
      update: {
        ...update,
        webhookDeliveryCount: { increment: 1 },
      },
      create: {
        shipperId,
        provider: 'SHOPIFY',
        shopDomain,
        providerOrderId: orderId,
        importedAt: webhookCreatedAt,
        lllBookingStatus: 'NOT_BOOKED',
        webhookDeliveryCount: 1,
        ...update,
      },
    });

    console.log('[ShopifyWebhook] Upserted integrated order', {
      id: integratedOrder.id,
      shipper: String(shipperId),
      shopDomain,
      topic,
    });

    return res.status(200).send('OK');
  } catch (err) {
    console.error('[ShopifyWebhook] Error handling webhook', err);
    return res.status(500).send('Internal error');
  }
};
