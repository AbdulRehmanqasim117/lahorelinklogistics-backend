const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const auth = require('../middleware/auth');

// Standard email/password auth
router.post('/login', authController.login);
router.post('/signup', authController.signup);

router.get('/me', auth, authController.me);

// Password reset flow
router.post('/forgot-password', authController.forgotPassword);
router.post('/verify-reset-code', authController.verifyResetCode);
router.post('/reset-password', authController.resetPassword);

// Google OAuth (redirect flow - legacy)
router.get('/google', authController.googleAuthStart);
router.get('/google/callback', authController.googleAuthCallback);

// Google OAuth (token-based flow)
router.post('/google', authController.googleAuth);

// Logout
router.post('/logout', authController.logout);

module.exports = router;
