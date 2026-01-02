const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { sendResetEmail } = require('../utils/mailer');
const { OAuth2Client } = require('google-auth-library');
const { google } = require('googleapis');
const CommissionConfig = require('../models/CommissionConfig');

exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({ message: 'Please provide email and password' });
    }

    // Check for user
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Check status
    if (user.status !== 'ACTIVE') {
      return res.status(403).json({ message: 'Account is inactive. Contact administrator.' });
    }

    // Check password
    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const secret = process.env.JWT_SECRET || 'dev_secret_key';
    const expiresIn = process.env.JWT_EXPIRES_IN || '30d'; // 30 days
    const token = jwt.sign(
      { id: user._id, role: user.role, name: user.name, email: user.email },
      secret,
      { expiresIn }
    );

    // Set HTTP-only cookie with the token
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production', // Use secure in production
      sameSite: 'strict',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days in milliseconds
      path: '/',
    });

    // Also send token in response for clients that need it
    res.json({ 
      token, 
      role: user.role, 
      name: user.name,
      email: user.email,
      id: user._id
    });
  } catch (error) {
    next(error);
  }
};

exports.signup = async (req, res, next) => {
  try {
    const { 
      name, email, password, role,
      companyName,
      cnicNumber,
      contactNumber,
      emergencyContact,
      pickupAddress,
      bankAccountDetails,
      // Structured bank fields (preferred)
      bankName,
      accountHolderName,
      accountNumber,
      iban,
      // Generic CNIC for riders or future roles
      cnic,
      // Rider-specific fields
      vehicleType,
      vehicleNumber,
      vehicleModel
    } = req.body;
    if (!name || !email || !password || !role) {
      return res.status(400).json({ message: 'Missing required fields' });
    }
    if (!['SHIPPER', 'RIDER'].includes(role)) {
      return res.status(403).json({ message: 'Only Shipper or Rider can sign up' });
    }
    const exists = await User.findOne({ email });
    if (exists) {
      return res.status(409).json({ message: 'Email already registered' });
    }
    const hash = await bcrypt.hash(password, 10);
    const payload = { name, email, passwordHash: hash, role };
    if (role === 'SHIPPER') {
      // Save shipper business fields
      payload.companyName = companyName || '';
      // Prefer explicit CNIC, but keep legacy cnicNumber
      payload.cnicNumber = cnicNumber || cnic || '';
      payload.cnic = cnic || cnicNumber || '';
      payload.contactNumber = contactNumber || '';
      payload.emergencyContact = emergencyContact || '';
      payload.pickupAddress = pickupAddress || '';

      // Structured bank fields
      payload.bankName = bankName || '';
      payload.accountHolderName = accountHolderName || '';
      payload.accountNumber = accountNumber || '';
      payload.iban = iban || '';

      // Preserve legacy free-text field for backwards compatibility / old UIs
      if (bankAccountDetails && bankAccountDetails.trim()) {
        payload.bankAccountDetails = bankAccountDetails.trim();
      } else {
        const parts = [];
        if (accountHolderName) parts.push(accountHolderName.trim());
        if (accountNumber) parts.push(accountNumber.trim());
        if (iban) parts.push(iban.trim());
        payload.bankAccountDetails = parts.join(' | ');
      }
      // Also set primary phone for convenience
      payload.phone = contactNumber || '';
    } else if (role === 'RIDER') {
      // Rider specific fields captured at signup
      if (cnic) {
        payload.cnic = cnic;
      }
      if (vehicleType) {
        payload.vehicleType = vehicleType;
      }
      if (vehicleNumber) {
        payload.vehicleNumber = vehicleNumber;
      }
      if (vehicleModel) {
        payload.vehicleModel = vehicleModel;
      }
    }
    const user = await User.create(payload);
    res.status(201).json({ id: user._id, role: user.role, name: user.name, email: user.email });
  } catch (error) {
    next(error);
  }
};

// Return the currently authenticated user's profile
// Used by the frontend AuthContext via GET /api/auth/me
exports.me = async (req, res, next) => {
  try {
    const userId = req.user?.id || req.user?._id;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized. Missing user in token.' });
    }

    const user = await User.findById(userId).select('-passwordHash').lean();
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // For SHIPPER accounts, derive portalActive and weightBracketsCount from
    // commission configuration so the frontend can gate portal access.
    if (user.role === 'SHIPPER') {
      try {
        const cfg = await CommissionConfig.findOne({ shipper: user._id })
          .select('weightBrackets')
          .lean();

        const count = Array.isArray(cfg?.weightBrackets)
          ? cfg.weightBrackets.length
          : 0;

        user.weightBracketsCount = count;
        user.portalActive = count > 0;
      } catch (err) {
        console.error('Error deriving shipper portal flags in /auth/me:', err);
        user.weightBracketsCount = null;
        user.portalActive = false;
      }
    }

    res.json({ user });
  } catch (error) {
    next(error);
  }
};

// Generate a 6-digit verification code
function generateVerificationCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Forgot password - request a verification code
exports.forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email is required' });
    
    const user = await User.findOne({ email });
    if (user) {
      // Generate a 6-digit verification code
      const verificationCode = generateVerificationCode();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes from now
      
      // Save the verification code and expiry
      user.resetPasswordCode = verificationCode;
      user.resetPasswordExpires = expiresAt;
      await user.save();

      // Send verification code via email and log it for testing
      console.log('\n======================================');
      console.log('VERIFICATION CODE:', verificationCode);
      console.log('Sending to:', user.email);
      
      try {
        await sendResetEmail(user.email, verificationCode, user.name);
        console.log('✅ Verification email sent successfully');
        console.log('📧 Check your email or Mailtrap inbox');
      } catch (emailError) {
        console.error('❌ Failed to send verification email:', emailError.message);
        console.log('ℹ️ Using Mailtrap test account - check Mailtrap inbox');
      }
      
      console.log('======================================\n');
    }
    
    // Always return success to prevent email enumeration
    res.status(200).json({ 
      message: 'If that email exists, a verification code has been sent to your email.',
      // In development, return the code for testing
      ...(process.env.NODE_ENV !== 'production' && user ? { verificationCode: user.resetPasswordCode } : {})
    });
  } catch (err) {
    next(err);
  }
};

// Verify reset code
exports.verifyResetCode = async (req, res, next) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ message: 'Email and verification code are required' });
    }

    const user = await User.findOne({
      email,
      resetPasswordCode: code,
      resetPasswordExpires: { $gt: new Date() }
    });

    if (!user) {
      return res.status(400).json({ message: 'Invalid or expired verification code' });
    }

    // Generate a one-time token for password reset
    const resetToken = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken = resetToken;
    user.resetPasswordExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    user.resetPasswordCode = undefined; // Clear the code after verification
    await user.save();

    res.json({ 
      message: 'Verification successful',
      resetToken
    });
  } catch (error) {
    next(error);
  }
};

// Reset password after verification
exports.resetPassword = async (req, res, next) => {
  try {
    const { token, password, confirmPassword } = req.body;
    
    if (!token || !password) {
      return res.status(400).json({ message: 'Token and password are required' });
    }
    
    if (password !== confirmPassword) {
      return res.status(400).json({ message: 'Passwords do not match' });
    }

    // Find user by token and check expiration
    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: new Date() }
    });

    if (!user) {
      return res.status(400).json({ message: 'Invalid or expired token' });
    }

    // Update password and clear reset token
    user.passwordHash = await bcrypt.hash(password, 10);
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    res.json({ message: 'Password has been reset successfully' });
  } catch (error) {
    next(error);
    next(err);
  }
};

// Google sign-in (server-side redirect flow)
exports.googleAuthStart = (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirect = process.env.GOOGLE_REDIRECT_URL || `${process.env.SERVER_URL || ''}/api/auth/google/callback`;
  if (!clientId) return res.status(500).send('Google OAuth not configured');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'select_account'
  });
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  res.redirect(url);
};

// Verify Google ID token and authenticate/register user
const verifyGoogleToken = async (idToken) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error('Google OAuth not configured');
  
  const client = new OAuth2Client(clientId);
  const ticket = await client.verifyIdToken({
    idToken,
    audience: clientId,
  });
  
  const payload = ticket.getPayload();
  if (!payload.email_verified) {
    throw new Error('Google email not verified');
  }
  
  return {
    email: payload.email,
    name: payload.name || payload.email.split('@')[0],
    picture: payload.picture
  };
};

// New endpoint for token-based Google OAuth
exports.googleAuth = async (req, res, next) => {
  try {
    const { credential } = req.body;
    if (!credential) {
      return res.status(400).json({ message: 'Missing credential' });
    }

    // Verify the Google ID token
    const googleUser = await verifyGoogleToken(credential);
    
    // Find or create user
    let user = await User.findOne({ email: googleUser.email });
    
    if (user) {
      // Existing user - check status
      if (user.status !== 'ACTIVE') {
        return res.status(403).json({ 
          message: 'User inactive, please contact LahoreLink admin.' 
        });
      }
    } else {
      // New user - create with default SHIPPER role
      user = await User.create({
        name: googleUser.name,
        email: googleUser.email,
        // Generate a random password that won't be used
        passwordHash: crypto.randomBytes(32).toString('hex'),
        role: 'SHIPPER',
        status: 'ACTIVE'
      });
    }

    // Generate JWT token (same as regular login)
    const secret = process.env.JWT_SECRET || 'dev_secret_key';
    const expires = process.env.JWT_EXPIRES_IN || '7d';
    const token = jwt.sign(
      { id: user._id, role: user.role, name: user.name, email: user.email },
      secret,
      { expiresIn: expires }
    );

    // Return the same response format as regular login
    res.json({ 
      token, 
      role: user.role, 
      name: user.name,
      email: user.email
    });
  } catch (error) {
    console.error('Google auth error:', error);
    next(error);
  }
};

// Existing redirect-based Google OAuth
exports.googleAuthCallback = async (req, res, next) => {
  try {
    const { code } = req.query;
    if (!code) {
      return res.status(400).json({ message: 'Authorization code is required' });
    }

    const oauth2Client = new OAuth2Client(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      `${process.env.API_URL}/api/auth/google/callback`
    );

    const { tokens } = await oauth2Client.getToken(code);
    const ticket = await oauth2Client.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload();
    const { email, name, picture } = payload;

    // Find or create user
    let user = await User.findOne({ email });
    if (!user) {
      // Create new user
      user = await User.create({
        name,
        email,
        role: 'SHIPPER', // Default role for Google signup
        status: 'ACTIVE',
        emailVerified: true,
        profileImage: picture
      });
    }

    // Generate JWT
    const expiresIn = process.env.JWT_EXPIRES_IN || '30d';
    const token = jwt.sign(
      { id: user._id, role: user.role, name: user.name, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn }
    );

    // Set HTTP-only cookie with the token
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days in milliseconds
      path: '/',
    });

    // Redirect to frontend with token in URL for clients that need it
    res.redirect(`${process.env.FRONTEND_URL}/auth/callback?token=${token}`);
  } catch (error) {
    console.error('Google auth callback error:', error);
    res.redirect(`${process.env.FRONTEND_URL}/login?error=google_auth_failed`);
  }
};

// Logout endpoint
exports.logout = (req, res) => {
  try {
    // Clear the token cookie
    res.clearCookie('token', {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict'
    });
    
    res.json({ success: true, message: 'Successfully logged out' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ success: false, message: 'Error during logout' });
  }
};
