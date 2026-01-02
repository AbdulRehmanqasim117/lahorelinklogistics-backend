const CompanyProfile = require('../models/CompanyProfile');

// Get active company profile
const getCompanyProfile = async (req, res) => {
  try {
    const profile = await CompanyProfile.getActiveProfile();

    res.json({
      success: true,
      data: profile
    });
  } catch (error) {
    console.error('Error fetching company profile:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch company profile',
      error: error.message
    });
  }
};

// Update company profile (CEO only)
const updateCompanyProfile = async (req, res) => {
  try {
    const {
      companyName,
      logoUrl,
      address,
      phone,
      alternatePhone,
      email,
      website,
      ntn,
      strn,
      footerNote
    } = req.body;

    // Validate required fields
    if (!companyName || !address?.line1 || !address?.city || !address?.country || !phone || !email) {
      return res.status(400).json({
        success: false,
        message: 'Required fields are missing: companyName, address (line1, city, country), phone, email'
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format'
      });
    }

    const updateData = {
      companyName,
      logoUrl: logoUrl || '',
      address: {
        line1: address.line1,
        city: address.city,
        country: address.country
      },
      phone,
      alternatePhone: alternatePhone || '',
      email,
      website: website || '',
      ntn: ntn || '',
      strn: strn || '',
      footerNote: footerNote || ''
    };

    const profile = await CompanyProfile.updateActiveProfile(updateData);

    res.json({
      success: true,
      message: 'Company profile updated successfully',
      data: profile
    });
  } catch (error) {
    console.error('Error updating company profile:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update company profile',
      error: error.message
    });
  }
};

// Upload company logo (CEO only)
const uploadCompanyLogo = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No logo file uploaded'
      });
    }

    // For now, we'll store the file path. In production, you might want to use cloud storage
    const logoUrl = `/uploads/company/${req.file.filename}`;

    // Update the profile with new logo URL
    const profile = await CompanyProfile.updateActiveProfile({ logoUrl });

    res.json({
      success: true,
      message: 'Company logo uploaded successfully',
      data: {
        logoUrl,
        profile
      }
    });
  } catch (error) {
    console.error('Error uploading company logo:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload company logo',
      error: error.message
    });
  }
};

// Get public company info (for invoices, etc.)
const getPublicCompanyInfo = async (req, res) => {
  try {
    const profile = await CompanyProfile.getActiveProfile();

    // Return only public information
    const publicInfo = {
      companyName: profile.companyName,
      logoUrl: profile.logoUrl,
      address: profile.address,
      phone: profile.phone,
      email: profile.email,
      website: profile.website,
      footerNote: profile.footerNote
    };

    res.json({
      success: true,
      data: publicInfo
    });
  } catch (error) {
    console.error('Error fetching public company info:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch company information',
      error: error.message
    });
  }
};

module.exports = {
  getCompanyProfile,
  updateCompanyProfile,
  uploadCompanyLogo,
  getPublicCompanyInfo
};
