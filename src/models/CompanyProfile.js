const mongoose = require('mongoose');

const CompanyProfileSchema = new mongoose.Schema({
  companyName: {
    type: String,
    required: true,//here
    default: 'LahoreLink Courier Services'
  },
  logoUrl: {
    type: String,
    default: ''
  },
  address: {
    line1: {
      type: String,
      required: true,
      default: 'Office # 123, Main Boulevard, Gulberg III'
    },
    city: {
      type: String,
      required: true,
      default: 'Lahore'
    },
    country: {
      type: String,
      required: true,
      default: 'Pakistan'
    }
  },
  phone: {
    type: String,
    required: true,
    default: '+92-42-111-LINK (5465)'
  },
  alternatePhone: {
    type: String,
    default: ''
  },
  email: {
    type: String,
    required: true,
    default: 'finance@lahorelink.com'
  },
  website: {
    type: String,
    default: 'www.lahorelink.com'
  },
  ntn: {
    type: String,
    default: ''
  },
  strn: {
    type: String,
    default: ''
  },
  footerNote: {
    type: String,
    default: 'For support contact: +92-42-111-LINK (5465) | Email: support@lahorelink.com'
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Ensure only one active profile exists
CompanyProfileSchema.index({ isActive: 1 }, { unique: true, partialFilterExpression: { isActive: true } });

// Static method to get the active profile
CompanyProfileSchema.statics.getActiveProfile = async function() {
  let profile = await this.findOne({ isActive: true });

  // If no profile exists, create default one
  if (!profile) {
    profile = await this.create({});
  }

  return profile;
};

// Static method to update the active profile
CompanyProfileSchema.statics.updateActiveProfile = async function(updateData) {
  let profile = await this.findOne({ isActive: true });

  if (!profile) {
    // Create new profile with update data
    profile = await this.create({ ...updateData });
  } else {
    // Update existing profile
    Object.assign(profile, updateData);
    await profile.save();
  }

  return profile;
};

module.exports = mongoose.model('CompanyProfile', CompanyProfileSchema);
