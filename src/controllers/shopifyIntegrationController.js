const Joi = require('joi');
const generateBookingId = require('../config/bookingId');
const generateTrackingId = require('../config/trackingId');
const mappers = require('../utils/providerMappers');
const prisma = require('../prismaClient');

const sendError = (res, status, message) => res.status(status).json({ message });

const normalizeWhitespace = (value) => {
  if (!value) return '';
  return String(value).replace(/\s+/g, ' ').trim();
};

const normalizePhone = (value) => {
  if (!value) return '';
  return String(value).replace(/\D/g, '');
};

exports.connectStore = async (req, res, next) => {
  try {
    const shipperIdRaw = req.user && (req.user._id || req.user.id);
    const shipperId = Number(shipperIdRaw);
    if (!Number.isInteger(shipperId) || shipperId <= 0)
      return sendError(res, 401, 'Unauthorized');

    const body = req.body || {};
    let { shopDomain, accessToken, scopes, status, webhookVersion } = body;

    if (!shopDomain || !String(shopDomain).trim()) {
      return sendError(res, 400, 'shopDomain is required');
    }

    shopDomain = String(shopDomain).trim().toLowerCase();

    if (Array.isArray(scopes)) {
      scopes = scopes.map((s) => String(s || '').trim()).filter(Boolean);
    } else if (typeof scopes === 'string' && scopes.trim()) {
      scopes = scopes
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      scopes = [];
    }

    const update = {
      shopDomain,
      accessToken: accessToken || undefined,
      scopes,
      status: status || 'active',
    };

    if (webhookVersion) {
      update.webhookVersion = String(webhookVersion);
    }
    if (!body.installedAt) {
      update.installedAt = new Date();
    }

    const integration = await prisma.shipperIntegration.upsert({
      where: {
        shipperId_provider_shopDomain: {
          shipperId,
          provider: 'SHOPIFY',
          shopDomain,
        },
      },
      update: update,
      create: {
        shipperId,
        provider: 'SHOPIFY',
        shopDomain,
        ...update,
      },
    });

    return res.json({
      message: 'Shopify store connected',
      integration,
    });
  } catch (err) {
    console.error('[ShopifyIntegration] connectStore error', err);
    next(err);
  }
};

exports.listShipperIntegratedOrders = async (req, res, next) => {
  try {
    const shipperIdRaw = req.user && (req.user._id || req.user.id);
    const shipperId = Number(shipperIdRaw);
    if (!Number.isInteger(shipperId) || shipperId <= 0)
      return sendError(res, 401, 'Unauthorized');

    const orders = await prisma.integratedOrder.findMany({
      where: { shipperId, provider: 'SHOPIFY' },
      orderBy: { createdAt: 'desc' },
    });

    const apiOrders = orders.map((o) => ({
      ...o,
      _id: o.id,
    }));

    return res.json(apiOrders);
  } catch (err) {
    console.error('[ShopifyIntegration] listShipperIntegratedOrders error', err);
    next(err);
  }
};

exports.bookIntegratedOrder = async (req, res, next) => {
  try {
    const shipperIdRaw = req.user && (req.user._id || req.user.id);
    const shipperId = Number(shipperIdRaw);
    if (!Number.isInteger(shipperId) || shipperId <= 0)
      return sendError(res, 401, 'Unauthorized');

    const rawId = req.params.integratedOrderId;
    const integratedOrderId = Number(rawId);
    if (!Number.isInteger(integratedOrderId) || integratedOrderId <= 0) {
      return sendError(res, 400, 'Invalid integratedOrderId');
    }

    const integrated = await prisma.integratedOrder.findFirst({
      where: {
        id: integratedOrderId,
        shipperId,
        provider: 'SHOPIFY',
      },
    });

    if (!integrated) {
      return sendError(res, 404, 'Integrated order not found');
    }

    if (integrated.lllBookingStatus === 'BOOKED' && integrated.lllOrderId) {
      const existingOrder = await prisma.order.findUnique({
        where: { id: integrated.lllOrderId },
      });
      return res.status(200).json({
        message: 'Already booked',
        order: existingOrder,
        integratedOrder: { ...integrated, _id: integrated.id },
      });
    }

    if (!integrated.rawPayload) {
      return sendError(
        res,
        400,
        'Integrated order is missing rawPayload for booking',
      );
    }

    const mapped = mappers.mapShopify(integrated.rawPayload || {});

    if (!mapped.weightKg || mapped.weightKg <= 0) {
      return sendError(res, 400, 'weightKg for integrated order is invalid');
    }

    const commissionConfig = await prisma.commissionConfig.findUnique({
      where: { shipperId },
      include: { weightBrackets: true },
    });

    if (
      !commissionConfig ||
      !Array.isArray(commissionConfig.weightBrackets) ||
      commissionConfig.weightBrackets.length === 0
    ) {
      return sendError(
        res,
        400,
        'No commission weight brackets configured for this shipper',
      );
    }

    const bracketsSorted = commissionConfig.weightBrackets
      .slice()
      .sort((a, b) => a.minKg - b.minKg);

    const numericWeight = Number(mapped.weightKg);
    const matching = bracketsSorted.find(
      (b) =>
        numericWeight >= b.minKg &&
        (b.maxKg == null || numericWeight < b.maxKg),
    );
    if (!matching) {
      return sendError(res, 400, 'No weight bracket matched for this shipper');
    }

    const serviceCharges = matching.chargePkr;

    const bookingId = await generateBookingId();
    const trackingId = await generateTrackingId();

    const paymentType =
      Number(mapped.codAmount || 0) > 0 ? 'COD' : 'ADVANCE';
    const codAmount =
      paymentType === 'ADVANCE' ? 0 : Number(mapped.codAmount || 0);

    const order = await prisma.order.create({
      data: {
        bookingId,
        trackingId,
        shipperId,
        consigneeName: normalizeWhitespace(
          mapped.consigneeName || integrated.customerName || '',
        ),
        consigneePhone: normalizePhone(
          mapped.consigneePhone || integrated.phone || '',
        ),
        consigneeAddress: normalizeWhitespace(
          mapped.consigneeAddress || integrated.address || '',
        ),
        destinationCity: normalizeWhitespace(
          mapped.destinationCity || integrated.city || '',
        ),
        serviceType: mapped.serviceType || 'SAME_DAY',
        paymentType,
        codAmount,
        productDescription: normalizeWhitespace(
          mapped.productDescription || integrated.itemsSummary || '',
        ),
        pieces: Number(mapped.pieces || 1),
        fragile: !!mapped.fragile,
        weightKg: numericWeight,
        serviceCharges,
        totalAmount: codAmount + serviceCharges,
        remarks: normalizeWhitespace(
          mapped.remarks || 'Imported via Shopify',
        ),
        status: 'CREATED',
        isIntegrated: true,
        bookingState: 'BOOKED',
        source: 'SHOPIFY',
        bookedWithLLL: true,
        sourceShopDomain: integrated.shopDomain,
        sourceProviderOrderId: integrated.providerOrderId,
        sourceProviderOrderNumber: integrated.providerOrderNumber,
      },
    });

    const updatedIntegrated = await prisma.integratedOrder.update({
      where: { id: integrated.id },
      data: {
        lllBookingStatus: 'BOOKED',
        bookedAt: new Date(),
        bookedById: shipperId,
        lllOrderId: order.id,
      },
    });

    return res.status(201).json({
      message: 'Order booked with LahoreLink Logistics',
      order,
      integratedOrder: { ...updatedIntegrated, _id: updatedIntegrated.id },
    });
  } catch (err) {
    console.error('[ShopifyIntegration] bookIntegratedOrder error', err);
    next(err);
  }
};

exports.getConnectedStore = async (req, res, next) => {
  try {
    const shipperIdRaw = req.user && (req.user._id || req.user.id);
    const shipperId = Number(shipperIdRaw);
    if (!Number.isInteger(shipperId) || shipperId <= 0)
      return sendError(res, 401, 'Unauthorized');

    const integrations = await prisma.shipperIntegration.findMany({
      where: {
        shipperId,
        provider: 'SHOPIFY',
        status: 'active',
      },
      orderBy: { createdAt: 'desc' },
    });

    const primary = integrations[0] || null;

    return res.json({
      shopDomain: primary ? primary.shopDomain : '',
      integration: primary,
    });
  } catch (err) {
    console.error('[ShopifyIntegration] getConnectedStore error', err);
    next(err);
  }
};
