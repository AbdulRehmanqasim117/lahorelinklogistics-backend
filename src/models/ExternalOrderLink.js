const mongoose = require('mongoose');

const externalOrderLinkSchema = new mongoose.Schema({
  provider: {
    type: String,
    enum: ['SHOPIFY', 'WOOCOMMERCE', 'CUSTOM'],
    required: true
  },
  externalOrderId: { type: String, required: true },
  shipper: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  lahorelinkOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true }
}, { timestamps: true });

externalOrderLinkSchema.index({ provider: 1, externalOrderId: 1, shipper: 1 }, { unique: true });

module.exports = mongoose.model('ExternalOrderLink', externalOrderLinkSchema);

