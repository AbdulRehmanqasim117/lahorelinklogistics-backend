const mongoose = require('mongoose');

const shipperIntegrationSchema = new mongoose.Schema(
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
    accessToken: {
      // In a real production setup this should be encrypted at rest using a KMS or
      // application-level encryption key. For now we store as-is and keep the
      // field name explicit.
      type: String,
    },
    scopes: {
      type: [String],
      default: [],
    },
    installedAt: {
      type: Date,
    },
    status: {
      type: String,
      enum: ['active', 'inactive', 'uninstalled'],
      default: 'active',
      index: true,
    },
    webhookVersion: {
      type: String,
    },
  },
  {
    timestamps: true,
  },
);

shipperIntegrationSchema.index(
  { shipper: 1, provider: 1, shopDomain: 1 },
  { unique: true },
);

module.exports = mongoose.model('ShipperIntegration', shipperIntegrationSchema);
