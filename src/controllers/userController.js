const User = require('../models/User');
const ShipperProfile = require('../models/ShipperProfile');
const RiderProfile = require('../models/RiderProfile');
const bcrypt = require('bcryptjs');
const Order = require('../models/Order');
const CommissionConfig = require('../models/CommissionConfig');

exports.getUsers = async (req, res, next) => {
  try {
    const users = await User.find({}).sort({ createdAt: -1 });
    res.json(users);
  } catch (error) {
    next(error);
  }
};

exports.createUser = async (req, res, next) => {
  try {
    const { 
      name,
      email,
      phone,
      password,
      role,
      // Shipper specific
      companyName,
      address,
      cnicNumber,
      contactNumber,
      emergencyContact,
      pickupAddress,
      bankAccountDetails,
      // Rider specific
      vehicleInfo,
      // Generic CNIC (used for MANAGER or others when provided)
      cnic,
    } = req.body;

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'User with this email already exists' });
    }
    if (role === 'CEO') {
      return res.status(400).json({ message: 'Creating additional CEO accounts is not allowed' });
    }

    // Generate password if not provided (for RIDER role)
    let finalPassword = password;
    if (!finalPassword && role === 'RIDER') {
      finalPassword = generateTemporaryPassword();
    }

    // Validate password length
    if (!finalPassword || finalPassword.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters long' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(finalPassword, salt);

    const user = new User({
      name,
      email,
      phone,
      passwordHash,
      role,
      // Store shipper business fields directly in User for consistency
      companyName: role === 'SHIPPER' ? companyName : undefined,
      cnicNumber: role === 'SHIPPER' ? cnicNumber : undefined,
      contactNumber: role === 'SHIPPER' ? (contactNumber || phone) : undefined,
      emergencyContact: role === 'SHIPPER' ? emergencyContact : undefined,
      pickupAddress: role === 'SHIPPER' ? (pickupAddress || address) : undefined,
      bankAccountDetails: role === 'SHIPPER' ? bankAccountDetails : undefined,

      // Generic CNIC for roles where CEO provides it (e.g. MANAGER)
      cnic: role === 'MANAGER' && cnic ? cnic : undefined,

      commissionStatus: role === 'SHIPPER' ? 'PENDING' : undefined,
      isCommissionApproved: role === 'SHIPPER' ? false : undefined
    });

    const savedUser = await user.save();

    // Create related profiles
    if (role === 'SHIPPER') {
      if (!companyName) {
        // Cleanup if validation fails (in a real app, use transactions)
        await User.findByIdAndDelete(savedUser._id);
        return res.status(400).json({ message: 'Company Name is required for Shippers' });
      }
      await ShipperProfile.create({
        user: savedUser._id,
        companyName,
        address
      });
    } else if (role === 'RIDER') {
      if (!vehicleInfo) {
        await User.findByIdAndDelete(savedUser._id);
        return res.status(400).json({ message: 'Vehicle Info is required for Riders' });
      }
      await RiderProfile.create({
        user: savedUser._id,
        vehicleInfo
      });
    }

    // For RIDER role, return password once for CEO to copy
    const response = { 
      message: 'User created successfully', 
      user: savedUser 
    };
    
    if (role === 'RIDER') {
      response.password = finalPassword; // Return password once (already hashed in DB)
      response.isTemporary = !password; // true if auto-generated
    }
    
    res.status(201).json(response);
  } catch (error) {
    next(error);
  }
};

exports.updateUserStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['ACTIVE', 'INACTIVE'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const user = await User.findByIdAndUpdate(
      id, 
      { status }, 
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json(user);
  } catch (error) {
    next(error);
  }
};

exports.getRiders = async (req, res, next) => {
  try {
    const { active } = req.query;
    const filter = { role: 'RIDER' };
    if (active === 'true' || active === '1') {
      filter.status = 'ACTIVE';
    }

    const riders = await User.find(filter)
      .select('-passwordHash') // Never return password hash
      .sort({ createdAt: -1 });
    
    // Enrich with rider profile data
    const ridersWithDetails = await Promise.all(
      riders.map(async (rider) => {
        const profile = await RiderProfile.findOne({ user: rider._id });
        const Order = require('../models/Order');
        const assignedOrders = await Order.countDocuments({ assignedRider: rider._id });
        const deliveredOrders = await Order.countDocuments({ 
          assignedRider: rider._id, 
          status: 'DELIVERED' 
        });
        
        return {
          ...rider.toObject(),
          phone: rider.phone || 'N/A',
          vehicleInfo: profile?.vehicleInfo || 'N/A',
          codCollected: profile?.codCollected || 0,
          serviceCharges: profile?.serviceCharges || 0,
          serviceChargeStatus: profile?.serviceChargeStatus || 'unpaid',
          assignedOrders,
          deliveredOrders
        };
      })
    );
    
    res.json(ridersWithDetails);
  } catch (error) {
    next(error);
  }
};

exports.getManagers = async (req, res, next) => {
  try {
    const managers = await User.find({ role: 'MANAGER' })
      .select('-passwordHash')
      .sort({ createdAt: -1 });

    res.json(managers);
  } catch (error) {
    next(error);
  }
};

exports.getRidersAssignedCounts = async (req, res, next) => {
  try {
    const activeStatuses = [
      'ASSIGNED',
      'PICKED',
      'OUT_FOR_DELIVERY',
      'IN_TRANSIT',
      'AT_LLL_WAREHOUSE',
      'FIRST_ATTEMPT',
      'SECOND_ATTEMPT',
      'THIRD_ATTEMPT',
      'FAILED',
    ];

    const [riders, counts] = await Promise.all([
      User.find({ role: 'RIDER' }).select('name').sort({ createdAt: -1 }).lean(),
      Order.aggregate([
        {
          $match: {
            assignedRider: { $ne: null },
            status: { $in: activeStatuses },
          },
        },
        {
          $group: {
            _id: '$assignedRider',
            assignedCount: { $sum: 1 },
          },
        },
      ]),
    ]);

    const countMap = new Map(counts.map((c) => [String(c._id), Number(c.assignedCount || 0)]));

    const result = riders.map((r) => ({
      _id: r._id,
      name: r.name,
      assignedCount: countMap.get(String(r._id)) || 0,
    }));

    res.json(result);
  } catch (error) {
    next(error);
  }
};

exports.getShippers = async (req, res, next) => {
  try {
    const { active } = req.query;
    const filter = { role: 'SHIPPER' };
    if (active === 'true' || active === '1') {
      filter.status = 'ACTIVE';
    }

    const shippers = await User.find(filter).sort({ createdAt: -1 });
    res.json(shippers);
  } catch (error) {
    next(error);
  }
};

exports.getMe = async (req, res, next) => {
  try {
    const userId = req.user && (req.user.id || req.user._id);
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized access. Token missing.' });
    }

    const user = await User.findById(userId)
      .select('-passwordHash')
      .lean();

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Derive portalActive + weightBracketsCount for SHIPPER accounts based on
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
        console.error('Error deriving shipper portal flags:', err);
        user.weightBracketsCount = null;
        user.portalActive = false;
      }
    }

    res.json({ user });
  } catch (error) {
    next(error);
  }
};

exports.setShipperCommissionApproval = async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      commissionRate,
      commissionType,
      commissionValue,
      commissionStatus,
      isCommissionApproved,
    } = req.body;

    const shipper = await User.findById(id);
    if (!shipper) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (shipper.role !== 'SHIPPER') {
      return res.status(400).json({ message: 'Commission approval can only be set for SHIPPER users' });
    }

    const nextStatus = commissionStatus
      ? String(commissionStatus).toUpperCase()
      : undefined;

    const nextIsApproved =
      typeof isCommissionApproved === 'boolean'
        ? isCommissionApproved
        : undefined;

    if (commissionRate !== undefined) {
      const num = commissionRate === null ? null : Number(commissionRate);
      if (num !== null && Number.isNaN(num)) {
        return res.status(400).json({ message: 'commissionRate must be a number or null' });
      }
      shipper.commissionRate = num;
      shipper.commissionType = null;
      shipper.commissionValue = null;
    }

    if (commissionType !== undefined || commissionValue !== undefined) {
      const type = commissionType === null ? null : String(commissionType).toUpperCase();
      if (type !== null && !['PERCENTAGE', 'FLAT'].includes(type)) {
        return res.status(400).json({ message: 'commissionType must be PERCENTAGE or FLAT' });
      }
      const val = commissionValue === null ? null : Number(commissionValue);
      if (val !== null && Number.isNaN(val)) {
        return res.status(400).json({ message: 'commissionValue must be a number or null' });
      }
      shipper.commissionType = type;
      shipper.commissionValue = val;
      shipper.commissionRate = null;
    }

    if (nextStatus !== undefined) {
      if (!['PENDING', 'APPROVED'].includes(nextStatus)) {
        return res.status(400).json({ message: 'commissionStatus must be PENDING or APPROVED' });
      }
      shipper.commissionStatus = nextStatus;
    }

    if (nextIsApproved !== undefined) {
      shipper.isCommissionApproved = nextIsApproved;
      shipper.commissionStatus = nextIsApproved ? 'APPROVED' : 'PENDING';
    }

    const hasValue =
      (shipper.commissionRate !== null && shipper.commissionRate !== undefined) ||
      (shipper.commissionType && shipper.commissionValue !== null && shipper.commissionValue !== undefined);

    const approved =
      shipper.commissionStatus === 'APPROVED' || shipper.isCommissionApproved === true;

    if (approved && !hasValue) {
      return res.status(400).json({ message: 'Commission value must be set before approving' });
    }

    if (approved) {
      shipper.approvedBy = req.user.id || req.user._id;
      shipper.approvedAt = new Date();
      shipper.isCommissionApproved = true;
      shipper.commissionStatus = 'APPROVED';
    } else {
      shipper.approvedBy = null;
      shipper.approvedAt = null;
      shipper.isCommissionApproved = false;
      shipper.commissionStatus = 'PENDING';
    }

    const updated = await shipper.save();
    res.json({ user: updated.toJSON() });
  } catch (error) {
    next(error);
  }
};

/**
 * Generate a secure temporary password
 */
const generateTemporaryPassword = () => {
  const length = 12;
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  let password = '';
  for (let i = 0; i < length; i++) {
    password += charset.charAt(Math.floor(Math.random() * charset.length));
  }
  return password;
};

/**
 * Reset user password (CEO only)
 * POST /api/users/:id/reset-password
 * Auth: CEO only
 * Body: { "newPassword": "string" } OR empty body to generate temporary password
 * 
 * Security Note: Passwords are hashed with bcrypt. We never store or return plaintext passwords.
 * CEO can set a new password or generate a temporary one and see it once in the response.
 */
exports.resetPassword = async (req, res, next) => {
  try {
    const { id } = req.params;
    let { newPassword } = req.body;

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Validate user is a RIDER or MANAGER (CEO can reset these accounts)
    if (!['RIDER', 'MANAGER'].includes(user.role)) {
      return res.status(400).json({ 
        message: 'Password reset is currently only available for RIDER or MANAGER accounts' 
      });
    }

    // If no password provided, generate a temporary one
    if (!newPassword) {
      newPassword = generateTemporaryPassword();
    } else if (newPassword.length < 8) {
      return res.status(400).json({ 
        message: 'Password must be at least 8 characters long' 
      });
    }

    // Hash the new password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);

    // Update user password
    user.passwordHash = passwordHash;
    await user.save();

    // Return success message with temporary password (one-time display)
    res.json({ 
      message: 'Password updated successfully',
      // Return plaintext password once for CEO to copy (already hashed in DB)
      password: newPassword,
      isTemporary: !req.body.newPassword // true if auto-generated
    });
  } catch (error) {
    next(error);
  }
};
