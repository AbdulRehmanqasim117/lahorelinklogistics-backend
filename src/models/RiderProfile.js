const mongoose = require('mongoose');

const riderProfileSchema = new mongoose.Schema({
  user: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "User", 
    unique: true,
    required: true
  },
  vehicleInfo: { 
    type: String 
  },
  codCollected: {
    type: Number,
    default: 0
  },
  serviceCharges: {
    type: Number,
    default: 0
  },
  serviceChargeStatus: {
    type: String,
    enum: ["paid", "unpaid"],
    default: "unpaid"
  }
});

module.exports = mongoose.model('RiderProfile', riderProfileSchema);