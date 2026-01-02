const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: { 
    type: String, 
    required: true 
  },
  email: { 
    type: String, 
    required: true, 
    unique: true, 
    lowercase: true 
  },
  phone: { 
    type: String 
  },
  passwordHash: { 
    type: String, 
    required: true 
  },
  role: { 
    type: String, 
    enum: ["CEO", "MANAGER", "SHIPPER", "RIDER"], 
    required: true 
  },
  status: { 
    type: String, 
    enum: ["ACTIVE", "INACTIVE"], 
    default: "ACTIVE" 
  },
  // Fields for password reset flow
  resetPasswordToken: { type: String },
  resetPasswordCode: { type: String },
  resetPasswordExpires: { type: Date },
  // Shipper business fields (optional, used when role === 'SHIPPER')
  companyName: { type: String },
  cnicNumber: { type: String },
  contactNumber: { type: String },
  emergencyContact: { type: String },
  pickupAddress: { type: String },
  bankAccountDetails: { type: String },
  bankName: { type: String },
  accountHolderName: { type: String },
  accountNumber: { type: String },
  iban: { type: String },
  // Generic CNIC field (used for MANAGER, RIDER, or future roles)
  cnic: { type: String },
  // Rider-specific fields
  vehicleType: { type: String },
  vehicleNumber: { type: String },
  vehicleModel: { type: String }
}, {
  timestamps: true
});

// Remove sensitive data when returning JSON
userSchema.methods.toJSON = function() {
  const user = this.toObject();
  delete user.passwordHash;
  return user;
};

module.exports = mongoose.model('User', userSchema);
