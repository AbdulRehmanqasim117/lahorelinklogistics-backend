const mongoose = require('mongoose');

const integratedOrderSchema = new mongoose.Schema(
  {
    shipper: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    provider: {
      type: String,
      enum: ['SHOPIFY'],
      default: 'SHOPIFY',
      required: true,
      index: true,
    },
    shopDomain: {
      type: String,
      required: true,
      index: true,
    },
    providerOrderId: {
      type: String,
      required: true,
      index: true,
    },
    providerOrderNumber: {
      type: String,
    },
    // Store the minimal payload we need for debugging / re-booking. In practice
    // this can be trimmed further if size becomes an issue.
    rawPayload: {
      type: mongoose.Schema.Types.Mixed,
    },

    customerName: { type: String },
    phone: { type: String },
    address: { type: String },
    city: { type: String },

    itemsSummary: { type: String },
    totalPrice: { type: Number },
    currency: { type: String },

    financialStatus: { type: String },
    fulfillmentStatus: { type: String },

    createdAtProvider: { type: Date },
    importedAt: { type: Date, default: Date.now },

    lllBookingStatus: {
      type: String,
      enum: ['NOT_BOOKED', 'BOOKED'],
      default: 'NOT_BOOKED',
      index: true,
    },
    bookedAt: { type: Date },
    bookedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    lllOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },

    tags: { type: [String], default: [] },
    notes: { type: String },

    lastWebhookId: { type: String },
    lastWebhookAt: { type: Date },
    lastPayloadHash: { type: String },
    webhookDeliveryCount: { type: Number, default: 0 },
  },
  {
    timestamps: true,
  },
);

integratedOrderSchema.index(
  { shipper: 1, provider: 1, shopDomain: 1, providerOrderId: 1 },
  { unique: true },
);

module.exports = mongoose.model('IntegratedOrder', integratedOrderSchema);
