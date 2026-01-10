const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const {
  getCompanyProfile,
  updateCompanyProfile,
  uploadCompanyLogo,
  getCompanyLogoFile,
  getPublicCompanyInfo
} = require('../controllers/companyProfileController');

const router = express.Router();

// Configure multer for logo upload
const createUploadDir = () => {
  const uploadDir = path.join(__dirname, '../../uploads/company');
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
  return uploadDir;
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = createUploadDir();
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Create unique filename with timestamp
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const extension = path.extname(file.originalname);
    cb(null, `company-logo-${uniqueSuffix}${extension}`);
  }
});

const fileFilter = (req, file, cb) => {
  // Allow only image files
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];

  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only JPEG, PNG, GIF, and WebP images are allowed.'), false);
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  }
});

// Public routes - company info + logo file (for invoices, public displays)
router.get('/public', getPublicCompanyInfo);
router.get('/logo/:filename', getCompanyLogoFile);

// Protected routes - require authentication
router.use(auth);

// Get company profile (CEO and Manager can read)
router.get('/', requireRole('CEO', 'Manager'), getCompanyProfile);

// Update company profile (CEO only)
router.put('/', requireRole('CEO'), updateCompanyProfile);

// Upload company logo (CEO only)
router.post('/logo', requireRole('CEO'), upload.single('logo'), uploadCompanyLogo);

// Error handler for multer errors
router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        message: 'File too large. Maximum size allowed is 5MB.'
      });
    }
  }

  if (error.message.includes('Invalid file type')) {
    return res.status(400).json({
      success: false,
      message: error.message
    });
  }

  next(error);
});

module.exports = router;
