const mongoose = require('mongoose');

const financePeriodSchema = new mongoose.Schema(
  {
    periodStart: {
      type: Date,
      required: true,
      index: true,
    },
    periodEnd: {
      type: Date,
      default: null,
      index: true,
    },
    status: {
      type: String,
      enum: ['OPEN', 'CLOSED'],
      default: 'OPEN',
      index: true,
    },
    closedAt: {
      type: Date,
      default: null,
    },
    closedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

financePeriodSchema.index({ status: 1, periodStart: -1 });

module.exports = mongoose.model('FinancePeriod', financePeriodSchema);
