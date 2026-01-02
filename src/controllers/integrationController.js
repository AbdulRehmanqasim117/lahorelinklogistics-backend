const IntegrationConfig = require('../models/IntegrationConfig');
const User = require('../models/User');
const Order = require('../models/Order');
const ExternalOrderLink = require('../models/ExternalOrderLink');
const generateBookingId = require('../config/bookingId');
const generateTrackingId = require('../config/trackingId');
const mappers = require('../utils/providerMappers');

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

    // Use integration data from middleware
    const integration = req.integration;
    if (!integration || !integration.shipperId) {
      return sendError(res, 401, 'Unauthorized');
    }

    const shipperId = integration.shipperId;
    const providerName = providerMeta.name;

    console.log('[handleProviderOrder] Processing order for provider:', providerName, 'shipper:', shipperId);

    // Map payload to standard order fields
    const payload = req.body || {};
    const mapped = providerMeta.mapper(payload);
    // Validate mapped.weightKg
    if (!mapped.weightKg || mapped.weightKg <= 0) {
      return sendError(res, 400, 'weightKg (weight in kg) is required and must be > 0');
    }
    console.log('[handleProviderOrder] Mapped payload:', { externalOrderId: mapped.externalOrderId, consigneeName: mapped.consigneeName });

    // Validate presence of externalOrderId to avoid duplicates
    const extId = String(mapped.externalOrderId || '').trim();
    if (!extId) return sendError(res, 400, 'externalOrderId required');

    // Duplicate protection using ExternalOrderLink
    const existingLink = await ExternalOrderLink.findOne({ 
      provider: providerName, 
      externalOrderId: extId, 
      shipper: shipperId 
    }).populate('lahorelinkOrder').lean();

    if (existingLink && existingLink.lahorelinkOrder) {
      console.log('[handleProviderOrder] Duplicate prevented, returning existing order');
      return res.status(200).json({
        message: 'Order already imported',
        orderId: existingLink.lahorelinkOrder._id,
        bookingId: existingLink.lahorelinkOrder.bookingId,
        trackingId: existingLink.lahorelinkOrder.trackingId
      });
    }

    // Generate bookingId & trackingId
    const bookingId = await generateBookingId();
    const trackingId = await generateTrackingId();

    // Commission config logic for weight charges
    const commissionConfig = await require('../models/CommissionConfig').findOne({ shipper: shipperId });
    if (!commissionConfig || !Array.isArray(commissionConfig.weightBrackets) || commissionConfig.weightBrackets.length === 0) {
      return sendError(res, 400, 'No commission weight brackets configured for this shipper');
    }
    const bracketsSorted = commissionConfig.weightBrackets.slice().sort((a,b)=>a.minKg-b.minKg);
    const matching = bracketsSorted.find(b => (mapped.weightKg >= b.minKg) && (b.maxKg === null || typeof b.maxKg==='undefined' || mapped.weightKg < b.maxKg));
    if (!matching) {
      return sendError(res, 400, 'No weight bracket matched for this shipper');
    }
    const serviceCharges = matching.charge;

    // Build order doc
    const orderDoc = {
      bookingId,
      trackingId,
      shipper: shipperId,
      consigneeName: mapped.consigneeName || '',
      consigneePhone: mapped.consigneePhone || '',
      consigneeAddress: mapped.consigneeAddress || '',
      destinationCity: mapped.destinationCity || '',
      serviceType: mapped.serviceType || 'SAME_DAY',
      paymentType: mapped.paymentType || (Number(mapped.codAmount || 0) > 0 ? 'COD' : 'ADVANCE'),
      codAmount: mapped.paymentType === 'ADVANCE' ? 0 : Number(mapped.codAmount || 0),
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
      statusHistory: [{
        status: 'CREATED',
        updatedBy: shipperId,
        note: `Created via ${providerName} integration`
      }],
      weightKg: Number(mapped.weightKg),
      serviceCharges
    };

    const created = await Order.create(orderDoc);
    console.log('[handleProviderOrder] Order created:', { id: created._id, bookingId: created.bookingId, trackingId: created.trackingId });

    // Create ExternalOrderLink for duplicate prevention
    await ExternalOrderLink.create({
      provider: providerName,
      externalOrderId: extId,
      shipper: shipperId,
      lahorelinkOrder: created._id
    });

    return res.status(201).json({
      message: 'Order created',
      orderId: created._id,
      bookingId: created.bookingId,
      trackingId: created.trackingId
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
    const shipperId = req.user && (req.user._id || req.user.id);
    if (!shipperId) return sendError(res, 401, 'Unauthorized');

    let config = await IntegrationConfig.findOne({ shipper: shipperId }).lean();
    if (!config) {
      // Create new config with generated API key
      const apiKey = generateApiKey();
      const newConfig = await IntegrationConfig.create({ 
        shipper: shipperId, 
        apiKey, 
        enabled: false, 
        providers: [] 
      });
      config = newConfig.toObject ? newConfig.toObject() : newConfig;
    }

    // Ensure apiKey exists (should always exist, but safety check)
    if (!config.apiKey) {
      const apiKey = generateApiKey();
      config = await IntegrationConfig.findOneAndUpdate(
        { shipper: shipperId },
        { $set: { apiKey } },
        { new: true }
      ).lean();
    }

    // Return in format expected by frontend
    return res.json({
      shipper: config.shipper,
      apiKey: config.apiKey,
      enabled: config.enabled || false,
      providers: config.providers || []
    });
  } catch (err) {
    console.error('[getMyIntegration] Error:', err);
    next(err);
  }
};

exports.updateMyIntegration = async (req, res, next) => {
  try {
    const shipperId = req.user && (req.user._id || req.user.id);
    if (!shipperId) return sendError(res, 401, 'Unauthorized');

    const body = req.body || {};
    
    // Get existing config or create new one
    let config = await IntegrationConfig.findOne({ shipper: shipperId });
    
    if (!config) {
      // Create new config with API key
      const apiKey = generateApiKey();
      config = await IntegrationConfig.create({ 
        shipper: shipperId, 
        apiKey, 
        enabled: false, 
        providers: [] 
      });
    }

    // Build update object
    const update = {};
    if (typeof body.enabled === 'boolean') {
      update.enabled = body.enabled;
    }
    
    if (Array.isArray(body.providers)) {
      // Normalize providers array - ensure all valid providers are included
      const validProviders = ['SHOPIFY', 'WOOCOMMERCE', 'CUSTOM'];
      const providedMap = new Map();
      
      // Process provided providers
      body.providers.forEach(p => {
        const providerName = String(p.provider || '').toUpperCase();
        if (validProviders.includes(providerName)) {
          providedMap.set(providerName, {
            provider: providerName,
            enabled: !!p.enabled,
            settings: p.settings || {}
          });
        }
      });
      
      // Add any existing providers that weren't provided (preserve their state)
      (config.providers || []).forEach(p => {
        const name = String(p.provider || '').toUpperCase();
        if (validProviders.includes(name) && !providedMap.has(name)) {
          providedMap.set(name, {
            provider: name,
            enabled: !!p.enabled,
            settings: p.settings || {}
          });
        }
      });
      
      // Ensure all valid providers are present (default to disabled if missing)
      validProviders.forEach(name => {
        if (!providedMap.has(name)) {
          providedMap.set(name, {
            provider: name,
            enabled: false,
            settings: {}
          });
        }
      });
      
      update.providers = Array.from(providedMap.values());
    }

    // Update the config
    config = await IntegrationConfig.findOneAndUpdate(
      { shipper: shipperId }, 
      { $set: update }, 
      { new: true }
    );

    console.log('[updateMyIntegration] Updated config:', { 
      shipper: shipperId, 
      enabled: config.enabled, 
      providers: config.providers 
    });

    // Return in format expected by frontend
    return res.json({
      shipper: config.shipper,
      apiKey: config.apiKey,
      enabled: config.enabled,
      providers: config.providers || []
    });
  } catch (err) {
    console.error('[updateMyIntegration] Error:', err);
    next(err);
  }
};

exports.regenerateKey = async (req, res, next) => {
  try {
    const shipperId = req.user && (req.user._id || req.user.id);
    if (!shipperId) return sendError(res, 401, 'Unauthorized');

    const newKey = generateApiKey();
    const config = await IntegrationConfig.findOneAndUpdate(
      { shipper: shipperId }, 
      { $set: { apiKey: newKey } }, 
      { new: true, upsert: true }
    );
    
    console.log('[regenerateKey] API key regenerated for shipper:', shipperId);
    
    return res.json({ message: 'API key regenerated', apiKey: config.apiKey });
  } catch (err) {
    console.error('[regenerateKey] Error:', err);
    next(err);
  }
};

