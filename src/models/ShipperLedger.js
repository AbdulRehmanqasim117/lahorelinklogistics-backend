const mongoose = require('mongoose');

const shipperLedgerSchema = new mongoose.Schema(
  {
    shipperId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    date: {
      type: Date,
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ['ORDER', 'PAYOUT', 'ADJUSTMENT'],
      required: true,
      index: true,
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      default: null,
      index: true,
    },
    bookingId: {
      type: String,
      default: null,
      index: true,
    },
    particular: {
      type: String,
      default: '',
    },
    codAmount: {
      type: Number,
      default: null,
    },
    serviceCharges: {
      type: Number,
      default: null,
    },
    weightKg: {
      type: Number,
      default: null,
    },
    receivable: {
      type: Number,
      default: null,
    },
    amount: {
      type: Number,
      required: true,
    },
    status: {
      type: String,
      enum: ['PAID', 'UNPAID'],
      default: 'UNPAID',
      index: true,
    },
    notes: {
      type: String,
      default: '',
    },
    createdBy: {
      type: String,
      default: 'system',
    },
  },
  {
    timestamps: true,
  },
);

shipperLedgerSchema.index(
  { shipperId: 1, bookingId: 1, type: 1 },
  {
    unique: true,
    partialFilterExpression: {
      type: 'ORDER',
      bookingId: { $type: 'string' },
    },
  },
);

shipperLedgerSchema.index({ shipperId: 1, date: -1 });

module.exports = mongoose.model('ShipperLedger', shipperLedgerSchema);
