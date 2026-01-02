const mongoose = require('mongoose');

const financialTransactionSchema = new mongoose.Schema({
  order: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "Order", 
    unique: true,
    required: true
  },
  shipper: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "User",
    required: true
  },
  rider: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "User" 
  },
  totalCodCollected: { 
    type: Number, 
    required: true 
  },
  shipperShare: { 
    type: Number, 
    required: true 
  },
  companyCommission: { 
    type: Number, 
    required: true 
  },
  riderCommission: {
    type: Number,
    default: 0
  },
  settlementStatus: { 
    type: String, 
    // Backward-compatible enum: older data uses PENDING/SETTLED
    enum: ["PENDING", "SETTLED", "UNPAID", "PAID"],
    default: "UNPAID"
  },
  paidAt: {
    type: Date,
    default: null
  },
  paidBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  settlementBatchId: {
    type: String,
    default: null
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('FinancialTransaction', financialTransactionSchema);
