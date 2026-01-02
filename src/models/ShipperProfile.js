const mongoose = require('mongoose');

const shipperProfileSchema = new mongoose.Schema({
  user: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "User", 
    unique: true,
    required: true
  },
  companyName: { 
    type: String, 
    required: true 
  },
  address: { 
    type: String 
  },
  defaultServiceTypes: [String]
});

module.exports = mongoose.model('ShipperProfile', shipperProfileSchema);