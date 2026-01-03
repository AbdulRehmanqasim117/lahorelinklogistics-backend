const generateBookingId = require('../config/bookingId');
const generateTrackingId = require('../config/trackingId');
const mappers = require('../utils/providerMappers');
const prisma = require('../prismaClient');

const PROVIDERS = {
  custom: { name: 'CUSTOM', mapper: mappers.mapCustom },
  shopify: { name: 'SHOPIFY', mapper: mappers.mapShopify },
  woocommerce: { name: 'WOOCOMMERCE', mapper: mappers.mapWoo }
};

const crypto = require('crypto');

const generateApiKey = () => crypto.randomBytes(24).toString('hex');

const sendError = (res, status, message) => res.status(status).json({ message });

// Generic handler factory
exports.handleProviderOrder = (providerKey) => async (req, res, next) => {
  try {
    const providerMeta = PROVIDERS[providerKey];
    if (!providerMeta) return sendError(res, 404, 'Provider not supported');

    // Use integration data from middleware (now Prisma-backed)
    const integration = req.integration;
    if (!integration || !integration.shipperId) {
      return sendError(res, 401, 'Unauthorized');
    }

    const shipperId = integration.shipperId;
    const providerName = providerMeta.name; // matches IntegrationProvider enum values

    console.log(
      '[handleProviderOrder] Processing order for provider:',
      providerName,
      'shipper:',
      shipperId,
    );

    // Map payload to standard order fields
    const payload = req.body || {};
    const mapped = providerMeta.mapper(payload);

    if (!mapped.weightKg || mapped.weightKg <= 0) {
      return sendError(
        res,
        400,
        'weightKg (weight in kg) is required and must be > 0',
      );
    }
    console.log('[handleProviderOrder] Mapped payload:', {
      externalOrderId: mapped.externalOrderId,
      consigneeName: mapped.consigneeName,
    });

    // Validate presence of externalOrderId to avoid duplicates
    const extId = String(mapped.externalOrderId || '').trim();
    if (!extId) return sendError(res, 400, 'externalOrderId required');

    // Duplicate protection using ExternalOrderLink (Prisma)
    const existingLink = await prisma.externalOrderLink.findUnique({
      where: {
        provider_externalOrderId_shipperId: {
          provider: providerName,
          externalOrderId: extId,
          shipperId,
        },
      },
      include: { lahorelinkOrder: true },
    });

    if (existingLink && existingLink.lahorelinkOrder) {
      console.log('[handleProviderOrder] Duplicate prevented, returning existing order');
      return res.status(200).json({
        message: 'Order already imported',
        orderId: existingLink.lahorelinkOrder.id,
        bookingId: existingLink.lahorelinkOrder.bookingId,
        trackingId: existingLink.lahorelinkOrder.trackingId,
      });
    }

    const bookingId = await generateBookingId();
    const trackingId = await generateTrackingId();

    // Commission config logic for weight charges (Prisma CommissionConfig)
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
    const matching = bracketsSorted.find((b) => {
      const withinMin = numericWeight >= b.minKg;
      const withinMax = b.maxKg == null || numericWeight < b.maxKg;
      return withinMin && withinMax;
    });

    if (!matching) {
      return sendError(res, 400, 'No weight bracket matched for this shipper');
    }

    const serviceCharges = matching.chargePkr;

    const numericCod = Number(mapped.codAmount || 0);
    const paymentType =
      mapped.paymentType || (numericCod > 0 ? 'COD' : 'ADVANCE');
    const codAmount = paymentType === 'ADVANCE' ? 0 : numericCod;

    const createdOrder = await prisma.order.create({
      data: {
        bookingId,
        trackingId,
        shipperId,
        consigneeName: mapped.consigneeName || '',
        consigneePhone: mapped.consigneePhone || '',
        consigneeAddress: mapped.consigneeAddress || '',
        destinationCity: mapped.destinationCity || '',
        serviceType: mapped.serviceType || 'SAME_DAY',
        paymentType,
        codAmount,
        productDescription: mapped.productDescription || '',
        pieces: Number(mapped.pieces || 1),
        fragile: !!mapped.fragile,
        remarks: mapped.remarks || `Imported via ${providerName}`,
        externalOrderId: extId,
        status: 'CREATED',
        isIntegrated: true,
        source: 'integrated',
        shipperApprovalStatus: 'pending',
        isDeleted: false,
        bookingState: 'UNBOOKED',
        weightKg: numericWeight,
        serviceCharges,
        totalAmount: codAmount + serviceCharges,
      },
    });

    await prisma.externalOrderLink.create({
      data: {
        provider: providerName,
        externalOrderId: extId,
        shipperId,
        lahorelinkOrderId: createdOrder.id,
      },
    });

    return res.status(201).json({
      message: 'Order created',
      orderId: createdOrder.id,
      bookingId: createdOrder.bookingId,
      trackingId: createdOrder.trackingId,
    });
  } catch (err) {
    console.error('[handleProviderOrder] Error:', err);
    next(err);
  }
};

// Adapter to support route using :provider param
exports.createFromProvider = (req, res, next) => {
  const providerKey = String(req.params.provider || '').toLowerCase();
  const handler = exports.handleProviderOrder(providerKey);
  return handler(req, res, next);
};

// Shipper-managed endpoints
exports.getMyIntegration = async (req, res, next) => {
  try {
    const shipperIdRaw = req.user && (req.user._id || req.user.id);
    const shipperId = Number(shipperIdRaw);
    if (!Number.isInteger(shipperId) || shipperId <= 0) {
      return sendError(res, 401, 'Unauthorized');
    }

    let config = await prisma.integrationConfig.findUnique({
      where: { shipperId },
    });

    if (!config) {
      config = await prisma.integrationConfig.create({
        data: {
          shipperId,
          apiKey: generateApiKey(),
          enabled: false,
          providers: [],
        },
      });
    }

    if (!config.apiKey) {
      config = await prisma.integrationConfig.update({
        where: { shipperId },
        data: { apiKey: generateApiKey() },
      });
    }

    return res.json({
      shipper: shipperId,
      apiKey: config.apiKey,
      enabled: config.enabled || false,
      providers: config.providers || [],
    });
  } catch (err) {
    console.error('[getMyIntegration] Error:', err);
    next(err);
  }
};

exports.updateMyIntegration = async (req, res, next) => {
  try {
    const shipperIdRaw = req.user && (req.user._id || req.user.id);
    const shipperId = Number(shipperIdRaw);
    if (!Number.isInteger(shipperId) || shipperId <= 0) {
      return sendError(res, 401, 'Unauthorized');
    }

    const body = req.body || {};

    let config = await prisma.integrationConfig.findUnique({ where: { shipperId } });
    if (!config) {
      config = await prisma.integrationConfig.create({
        data: {
          shipperId,
          apiKey: generateApiKey(),
          enabled: false,
          providers: [],
        },
      });
    }

    const update = {};
    if (typeof body.enabled === 'boolean') {
      update.enabled = body.enabled;
    }

    if (Array.isArray(body.providers)) {
      const validProviders = ['SHOPIFY', 'WOOCOMMERCE', 'CUSTOM'];
      const providedMap = new Map();

      body.providers.forEach((p) => {
        const providerName = String(p.provider || '').toUpperCase();
        if (validProviders.includes(providerName)) {
          providedMap.set(providerName, {
            provider: providerName,
            enabled: !!p.enabled,
            settings: p.settings || {},
          });
        }
      });

      (config.providers || []).forEach((p) => {
        const name = String(p.provider || '').toUpperCase();
        if (validProviders.includes(name) && !providedMap.has(name)) {
          providedMap.set(name, {
            provider: name,
            enabled: !!p.enabled,
            settings: p.settings || {},
          });
        }
      });

      validProviders.forEach((name) => {
        if (!providedMap.has(name)) {
          providedMap.set(name, {
            provider: name,
            enabled: false,
            settings: {},
          });
        }
      });

      update.providers = Array.from(providedMap.values());
    }

    config = await prisma.integrationConfig.update({
      where: { shipperId },
      data: update,
    });

    console.log('[updateMyIntegration] Updated config:', {
      shipper: shipperId,
      enabled: config.enabled,
      providers: config.providers,
    });

    return res.json({
      shipper: shipperId,
      apiKey: config.apiKey,
      enabled: config.enabled,
      providers: config.providers || [],
    });
  } catch (err) {
    console.error('[updateMyIntegration] Error:', err);
    next(err);
  }
};

exports.regenerateKey = async (req, res, next) => {
  try {
    const shipperIdRaw = req.user && (req.user._id || req.user.id);
    const shipperId = Number(shipperIdRaw);
    if (!Number.isInteger(shipperId) || shipperId <= 0) {
      return sendError(res, 401, 'Unauthorized');
    }

    const newKey = generateApiKey();
    const config = await prisma.integrationConfig.upsert({
      where: { shipperId },
      update: { apiKey: newKey },
      create: {
        shipperId,
        apiKey: newKey,
        enabled: false,
        providers: [],
      },
    });

    console.log('[regenerateKey] API key regenerated for shipper:', shipperId);

    return res.json({ message: 'API key regenerated', apiKey: config.apiKey });
  } catch (err) {
    console.error('[regenerateKey] Error:', err);
    next(err);
  }
};

