const prisma = require('../prismaClient');
const path = require('path');
const fs = require('fs');

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

function resolveLogoUrlForResponse(logoUrl, req) {
  if (!logoUrl) return '';

  const asString = String(logoUrl);

  // Legacy values stored as /uploads/company/filename should be served
  // through the API path so they work correctly behind /api proxies.
  if (asString.startsWith('/uploads/company/')) {
    const filename = path.basename(asString);
    const base = req.baseUrl || '/api/company-profile';
    return `${base}/logo/${filename}`;
  }

  return asString;
}

// Serve the stored company logo file via an API path so that frontends
// can reliably load it even when the API is running behind a proxy.
// If the specific logo filename referenced in the DB no longer exists on
// disk (for example after a redeploy or manual cleanup), we attempt to
// fall back to the most recently modified company logo in the uploads
// directory so that the UI still has a logo to display.
const getCompanyLogoFile = async (req, res) => {
  try {
    const filename = path.basename(req.params.filename || '');
    if (!filename) {
      return res.status(400).send('Invalid logo filename');
    }

    const dirPath = path.join(__dirname, '../../uploads/company');
    const filePath = path.join(dirPath, filename);

    if (!fs.existsSync(filePath)) {
      // Requested logo file does not exist on disk. Try to serve the latest
      // available logo from the uploads directory as a graceful fallback.
      try {
        if (fs.existsSync(dirPath)) {
          const files = fs
            .readdirSync(dirPath)
            .filter((name) => name.toLowerCase().startsWith('company-logo-'));

          if (files.length > 0) {
            const latest = files
              .map((name) => {
                try {
                  const fullPath = path.join(dirPath, name);
                  const stat = fs.statSync(fullPath);
                  return { name, mtime: stat.mtime };
                } catch (e) {
                  return null;
                }
              })
              .filter(Boolean)
              .sort((a, b) => b.mtime - a.mtime)[0];

            if (latest && latest.name) {
              const fallbackPath = path.join(dirPath, latest.name);
              console.warn('Company logo file missing, using fallback', {
                requested: filename,
                fallback: latest.name,
              });
              return res.sendFile(fallbackPath);
            }
          }
        }
      } catch (innerError) {
        console.error('Error resolving fallback company logo file:', innerError);
      }

      // No suitable fallback found
      return res.status(404).send('Logo not found');
    }

    return res.sendFile(filePath);
  } catch (error) {
    console.error('Error serving company logo file:', error);
    return res.status(500).send('Failed to load logo');
  }
};

// Get active company profile
const getCompanyProfile = async (req, res) => {
  try {
    const profile = await getOrCreateActiveProfile();
    const mapped = mapProfileToApiShape(profile);
    if (mapped) {
      mapped.logoUrl = resolveLogoUrlForResponse(mapped.logoUrl, req);
    }

    res.json({
      success: true,
      data: mapped,
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

    const mapped = mapProfileToApiShape(profile);
    if (mapped) {
      mapped.logoUrl = resolveLogoUrlForResponse(mapped.logoUrl, req);
    }

    res.json({
      success: true,
      message: 'Company profile updated successfully',
      data: mapped,
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

    // For now, we'll store the file path on disk, but expose it via an
    // API URL so that frontends behind a proxy can load it reliably.
    const storedPath = `/uploads/company/${req.file.filename}`;

    const active = await getOrCreateActiveProfile();
    const profile = await prisma.companyProfile.update({
      where: { id: active.id },
      data: { logoUrl: storedPath },
    });

    const responseLogoUrl = resolveLogoUrlForResponse(storedPath, req);
    const mapped = mapProfileToApiShape(profile);
    if (mapped) {
      mapped.logoUrl = responseLogoUrl;
    }

    res.json({
      success: true,
      message: 'Company logo uploaded successfully',
      data: {
        logoUrl: responseLogoUrl,
        profile: mapped,
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
      logoUrl: resolveLogoUrlForResponse(mapped.logoUrl, req),
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
  getCompanyLogoFile,
  getPublicCompanyInfo,
};
