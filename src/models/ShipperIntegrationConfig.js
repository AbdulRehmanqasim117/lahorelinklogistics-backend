const mongoose = require('mongoose');

const providerSchema = new mongoose.Schema({
  provider: {
    type: String,
    enum: ['SHOPIFY', 'WOOCOMMERCE', 'CUSTOM'],
    required: true
  },
  enabled: { type: Boolean, default: false },
  meta: { type: Object, default: {} }
}, { _id: false });

const shipperIntegrationConfigSchema = new mongoose.Schema({
  shipper: { type: mongoose.Schema.Types.ObjectId, ref: 'User', unique: true, required: true },
  enabled: { type: Boolean, default: false },
  apiKey: { type: String, index: true },
  providers: { type: [providerSchema], default: [] }
}, { timestamps: true });

module.exports = mongoose.model('ShipperIntegrationConfig', shipperIntegrationConfigSchema);

