const mongoose = require('mongoose');

const bracketSchema = new mongoose.Schema({
  minKg: { type: Number, required: true, min: 0 },
  maxKg: { type: Number, required: false }, // null means infinity
  charge: { type: Number, required: true, min: 0 }
}, { _id: false });

const commissionConfigSchema = new mongoose.Schema({
  shipper: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "User", 
    unique: true,
    required: true
  },
  type: { 
    type: String, 
    enum: ["FLAT", "PERCENTAGE"], 
    default: "PERCENTAGE" 
  },
  value: { 
    type: Number, 
    required: true 
  },
  riderType: {
    type: String,
    enum: ["FLAT", "PERCENTAGE"],
    default: "FLAT"
  },
  riderValue: {
    type: Number,
    default: 0
  },
  weightBrackets: [bracketSchema] // <-- REPLACES weightCharges
});

module.exports = mongoose.model('CommissionConfig', commissionConfigSchema);
