const mongoose = require('mongoose');

const providerSchema = new mongoose.Schema({
  provider: { type: String, enum: ['CUSTOM','SHOPIFY','WOOCOMMERCE'], required: true },
  enabled: { type: Boolean, default: false },
  settings: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { _id: false });

const integrationConfigSchema = new mongoose.Schema({
  shipper: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true, unique: true },
  apiKey: { type: String, required: true, unique: true, index: true },
  enabled: { type: Boolean, default: false },
  providers: { type: [providerSchema], default: [] }
}, { timestamps: true });

module.exports = mongoose.model('IntegrationConfig', integrationConfigSchema);
