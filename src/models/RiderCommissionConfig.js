const mongoose = require('mongoose');

const riderCommissionConfigSchema = new mongoose.Schema({
  rider: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    unique: true,
    required: true
  },
  type: {
    type: String,
    enum: ["FLAT", "PERCENTAGE"],
    default: "FLAT"
  },
  value: {
    type: Number,
    required: true
  },
  rules: [
    {
      status: { type: String, enum: ["DELIVERED", "RETURNED", "FAILED", "OUT_FOR_DELIVERY"] },
      type: { type: String, enum: ["FLAT", "PERCENTAGE"], default: "FLAT" },
      value: { type: Number, required: true }
    }
  ]
});

module.exports = mongoose.model('RiderCommissionConfig', riderCommissionConfigSchema);
