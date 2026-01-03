const prisma = require('../prismaClient');

// Helper to load (or lazily create) the active company profile
async function getOrCreateActiveProfile() {
  let profile = await prisma.companyProfile.findFirst({ where: { isActive: true } });
  if (!profile) {
    profile = await prisma.companyProfile.create({ data: {} });
  }
  return profile;
}

function mapProfileToApiShape(profile) {
  if (!profile) return null;
  return {
    id: profile.id,
    companyName: profile.companyName,
    logoUrl: profile.logoUrl,
    address: {
      line1: profile.addressLine1,
      city: profile.addressCity,
      country: profile.addressCountry,
    },
    phone: profile.phone,
    alternatePhone: profile.alternatePhone,
    email: profile.email,
    website: profile.website,
    ntn: profile.ntn,
    strn: profile.strn,
    footerNote: profile.footerNote,
    isActive: profile.isActive,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

// Get active company profile
const getCompanyProfile = async (req, res) => {
  try {
    const profile = await getOrCreateActiveProfile();

    res.json({
      success: true,
      data: mapProfileToApiShape(profile),
    });
  } catch (error) {
    console.error('Error fetching company profile:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch company profile',
      error: error.message,
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
      footerNote,
    } = req.body;

    // Validate required fields
    if (!companyName || !address?.line1 || !address?.city || !address?.country || !phone || !email) {
      return res.status(400).json({
        success: false,
        message:
          'Required fields are missing: companyName, address (line1, city, country), phone, email',
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format',
      });
    }

    const active = await getOrCreateActiveProfile();

    const updateData = {
      companyName,
      logoUrl: logoUrl || '',
      addressLine1: address.line1,
      addressCity: address.city,
      addressCountry: address.country,
      phone,
      alternatePhone: alternatePhone || '',
      email,
      website: website || '',
      ntn: ntn || '',
      strn: strn || '',
      footerNote: footerNote || '',
      isActive: true,
    };

    const profile = await prisma.companyProfile.update({
      where: { id: active.id },
      data: updateData,
    });

    res.json({
      success: true,
      message: 'Company profile updated successfully',
      data: mapProfileToApiShape(profile),
    });
  } catch (error) {
    console.error('Error updating company profile:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update company profile',
      error: error.message,
    });
  }
};

// Upload company logo (CEO only)
const uploadCompanyLogo = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No logo file uploaded',
      });
    }

    // For now, we'll store the file path. In production, you might want to use cloud storage
    const logoUrl = `/uploads/company/${req.file.filename}`;

    const active = await getOrCreateActiveProfile();
    const profile = await prisma.companyProfile.update({
      where: { id: active.id },
      data: { logoUrl },
    });

    res.json({
      success: true,
      message: 'Company logo uploaded successfully',
      data: {
        logoUrl,
        profile: mapProfileToApiShape(profile),
      },
    });
  } catch (error) {
    console.error('Error uploading company logo:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload company logo',
      error: error.message,
    });
  }
};

// Get public company info (for invoices, etc.)
const getPublicCompanyInfo = async (req, res) => {
  try {
    const profile = await getOrCreateActiveProfile();
    const mapped = mapProfileToApiShape(profile);

    const publicInfo = {
      companyName: mapped.companyName,
      logoUrl: mapped.logoUrl,
      address: mapped.address,
      phone: mapped.phone,
      email: mapped.email,
      website: mapped.website,
      footerNote: mapped.footerNote,
    };

    res.json({
      success: true,
      data: publicInfo,
    });
  } catch (error) {
    console.error('Error fetching public company info:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch company information',
      error: error.message,
    });
  }
};

module.exports = {
  getCompanyProfile,
  updateCompanyProfile,
  uploadCompanyLogo,
  getPublicCompanyInfo,
};
