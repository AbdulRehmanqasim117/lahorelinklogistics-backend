const Joi = require('joi');
const IntegratedOrder = require('../models/IntegratedOrder');
const ShipperIntegration = require('../models/ShipperIntegration');
const Order = require('../models/Order');
const CommissionConfig = require('../models/CommissionConfig');
const generateBookingId = require('../config/bookingId');
const generateTrackingId = require('../config/trackingId');
const mappers = require('../utils/providerMappers');

const sendError = (res, status, message) => res.status(status).json({ message });

const bookIntegratedOrderSchema = Joi.object({
  integratedOrderId: Joi.string().length(24).hex().required(),
});

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
    const shipperId = req.user && (req.user._id || req.user.id);
    if (!shipperId) return sendError(res, 401, 'Unauthorized');

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

    const integration = await ShipperIntegration.findOneAndUpdate(
      { shipper: shipperId, provider: 'SHOPIFY', shopDomain },
      { $set: update, $setOnInsert: { installedAt: update.installedAt } },
      { new: true, upsert: true },
    );

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
    const shipperId = req.user && (req.user._id || req.user.id);
    if (!shipperId) return sendError(res, 401, 'Unauthorized');

    const orders = await IntegratedOrder.find({
      shipper: shipperId,
      provider: 'SHOPIFY',
    })
      .sort({ createdAt: -1 })
      .lean();

    return res.json(orders);
  } catch (err) {
    console.error('[ShopifyIntegration] listShipperIntegratedOrders error', err);
    next(err);
  }
};

exports.bookIntegratedOrder = async (req, res, next) => {
  try {
    const shipperId = req.user && (req.user._id || req.user.id);
    if (!shipperId) return sendError(res, 401, 'Unauthorized');

    const { error, value } = bookIntegratedOrderSchema.validate({
      integratedOrderId: req.params.integratedOrderId,
    });
    if (error) {
      return sendError(res, 400, 'Invalid integratedOrderId');
    }

    const { integratedOrderId } = value;

    const integrated = await IntegratedOrder.findOne({
      _id: integratedOrderId,
      shipper: shipperId,
      provider: 'SHOPIFY',
    });

    if (!integrated) {
      return sendError(res, 404, 'Integrated order not found');
    }

    if (integrated.lllBookingStatus === 'BOOKED' && integrated.lllOrder) {
      const existingOrder = await Order.findById(integrated.lllOrder);
      return res.status(200).json({
        message: 'Already booked',
        order: existingOrder,
        integratedOrder: integrated,
      });
    }

    if (!integrated.rawPayload) {
      return sendError(res, 400, 'Integrated order is missing rawPayload for booking');
    }

    // Map Shopify payload to normalized fields using existing mapper
    const mapped = mappers.mapShopify(integrated.rawPayload || {});

    if (!mapped.weightKg || mapped.weightKg <= 0) {
      return sendError(res, 400, 'weightKg for integrated order is invalid');
    }

    // Commission / weight bracket logic (same as manual order creation)
    const commissionConfig = await CommissionConfig.findOne({ shipper: shipperId });
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
    const matching = bracketsSorted.find(
      (b) =>
        mapped.weightKg >= b.minKg &&
        (b.maxKg === null || typeof b.maxKg === 'undefined' || mapped.weightKg < b.maxKg),
    );
    if (!matching) {
      return sendError(res, 400, 'No weight bracket matched for this shipper');
    }

    const serviceCharges = matching.charge;

    const bookingId = await generateBookingId();
    const trackingId = await generateTrackingId();

    const paymentType =
      Number(mapped.codAmount || 0) > 0 ? 'COD' : 'ADVANCE';
    const codAmount =
      paymentType === 'ADVANCE' ? 0 : Number(mapped.codAmount || 0);

    const orderDoc = {
      bookingId,
      trackingId,
      shipper: shipperId,
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
      weightKg: Number(mapped.weightKg),
      serviceCharges,
      totalAmount: codAmount + serviceCharges,
      remarks: normalizeWhitespace(mapped.remarks || 'Imported via Shopify'),
      status: 'CREATED',
      statusHistory: [
        {
          status: 'CREATED',
          updatedBy: shipperId,
          note: 'Order created from Shopify integrated order',
        },
      ],
      isIntegrated: true,
      bookingState: 'BOOKED',
      source: 'SHOPIFY',
      bookedWithLLL: true,
      sourceMeta: {
        shopDomain: integrated.shopDomain,
        providerOrderId: integrated.providerOrderId,
        providerOrderNumber: integrated.providerOrderNumber,
      },
    };

    const createdOrder = await Order.create(orderDoc);

    integrated.lllBookingStatus = 'BOOKED';
    integrated.bookedAt = new Date();
    integrated.bookedBy = shipperId;
    integrated.lllOrder = createdOrder._id;
    await integrated.save();

    return res.status(201).json({
      message: 'Order booked with LahoreLink Logistics',
      order: createdOrder,
      integratedOrder: integrated,
    });
  } catch (err) {
    console.error('[ShopifyIntegration] bookIntegratedOrder error', err);
    next(err);
  }
};
