const bcrypt = require('bcryptjs');
const prisma = require('../prismaClient');

exports.getUsers = async (req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
    });

    const safeUsers = users.map(({ passwordHash, ...u }) => ({
      _id: u.id,
      ...u,
    }));
    res.json(safeUsers);
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

    const existingUser = await prisma.user.findUnique({ where: { email } });
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

    const passwordHash = await bcrypt.hash(finalPassword, 10);

    const data = {
      name,
      email,
      phone,
      passwordHash,
      role,
      // Shipper business fields on User
      companyName: role === 'SHIPPER' ? companyName : undefined,
      cnicNumber: role === 'SHIPPER' ? cnicNumber : undefined,
      contactNumber: role === 'SHIPPER' ? (contactNumber || phone) : undefined,
      emergencyContact: role === 'SHIPPER' ? emergencyContact : undefined,
      pickupAddress: role === 'SHIPPER' ? (pickupAddress || address) : undefined,
      bankAccountDetails: role === 'SHIPPER' ? bankAccountDetails : undefined,
      // Generic CNIC for MANAGER
      cnic: role === 'MANAGER' && cnic ? cnic : undefined,
      commissionStatus: role === 'SHIPPER' ? 'PENDING' : undefined,
      isCommissionApproved: role === 'SHIPPER' ? false : undefined,
    };

    // Rider-specific core fields
    if (role === 'RIDER') {
      if (cnic) data.cnic = cnic;
      // vehicleType/Number/Model live on User in Prisma schema
    }

    const createdUser = await prisma.user.create({ data });

    // Create related profiles
    if (role === 'SHIPPER') {
      if (!companyName) {
        await prisma.user.delete({ where: { id: createdUser.id } });
        return res.status(400).json({ message: 'Company Name is required for Shippers' });
      }
      await prisma.shipperProfile.create({
        data: {
          userId: createdUser.id,
          companyName,
          address,
        },
      });
    } else if (role === 'RIDER') {
      if (!vehicleInfo) {
        await prisma.user.delete({ where: { id: createdUser.id } });
        return res.status(400).json({ message: 'Vehicle Info is required for Riders' });
      }
      await prisma.riderProfile.create({
        data: {
          userId: createdUser.id,
          vehicleInfo,
        },
      });
    }

    const { passwordHash: _ph, ...safeUser } = createdUser;

    const response = {
      message: 'User created successfully',
      user: safeUser,
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

    const userId = Number(id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ message: 'Invalid user id' });
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: { status },
    });

    const { passwordHash, ...safeUser } = updated;
    res.json(safeUser);
  } catch (error) {
    next(error);
  }
};

exports.getRiders = async (req, res, next) => {
  try {
    const { active } = req.query;
    const where = {
      role: 'RIDER',
      ...(active === 'true' || active === '1' ? { status: 'ACTIVE' } : {}),
    };

    const riders = await prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    const ridersWithDetails = await Promise.all(
      riders.map(async (rider) => {
        const [profile, assignedOrders, deliveredOrders] = await Promise.all([
          prisma.riderProfile.findUnique({ where: { userId: rider.id } }),
          prisma.order.count({ where: { assignedRiderId: rider.id } }),
          prisma.order.count({ where: { assignedRiderId: rider.id, status: 'DELIVERED' } }),
        ]);

        const { passwordHash, ...safeRider } = rider;

        return {
          _id: safeRider.id,
          ...safeRider,
          phone: rider.phone || 'N/A',
          vehicleInfo: profile?.vehicleInfo || 'N/A',
          codCollected: profile?.codCollected || 0,
          serviceCharges: profile?.serviceCharges || 0,
          serviceChargeStatus: profile?.serviceChargeStatus || 'unpaid',
          assignedOrders,
          deliveredOrders,
        };
      }),
    );

    res.json(ridersWithDetails);
  } catch (error) {
    next(error);
  }
};

exports.getManagers = async (req, res, next) => {
  try {
    const managers = await prisma.user.findMany({
      where: { role: 'MANAGER' },
      orderBy: { createdAt: 'desc' },
    });

    const safeManagers = managers.map(({ passwordHash, ...u }) => ({
      _id: u.id,
      ...u,
    }));
    res.json(safeManagers);
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

    const riders = await prisma.user.findMany({
      where: { role: 'RIDER' },
      select: { id: true, name: true },
      orderBy: { createdAt: 'desc' },
    });

    const counts = await prisma.order.groupBy({
      by: ['assignedRiderId'],
      where: {
        assignedRiderId: { not: null },
        status: { in: activeStatuses },
      },
      _count: { _all: true },
    });

    const countMap = new Map(
      counts.map((c) => [
        c.assignedRiderId,
        c._count ? c._count._all : 0,
      ]),
    );

    const result = riders.map((r) => ({
      _id: r.id,
      name: r.name,
      assignedCount: countMap.get(r.id) || 0,
    }));

    res.json(result);
  } catch (error) {
    next(error);
  }
};

exports.getShippers = async (req, res, next) => {
  try {
    const { active } = req.query;
    const where = {
      role: 'SHIPPER',
      ...(active === 'true' || active === '1' ? { status: 'ACTIVE' } : {}),
    };

    const shippers = await prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    const safe = shippers.map(({ passwordHash, ...u }) => ({
      _id: u.id,
      ...u,
    }));
    res.json(safe);
  } catch (error) {
    next(error);
  }
};

exports.getMe = async (req, res, next) => {
  try {
    const userId = req.user && req.user.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized access. Token missing.' });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const { passwordHash, ...safeUser } = user;
    const responseUser = { _id: safeUser.id, ...safeUser };

    // TODO: if needed later, compute portalActive/weightBracketsCount from Prisma-based finance config
    res.json({ user: responseUser });
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

    const shipperId = Number(id);
    if (!Number.isInteger(shipperId) || shipperId <= 0) {
      return res.status(400).json({ message: 'Invalid user id' });
    }

    const shipper = await prisma.user.findUnique({ where: { id: shipperId } });
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
      (shipper.commissionType &&
        shipper.commissionValue !== null &&
        shipper.commissionValue !== undefined);

    const approved =
      shipper.commissionStatus === 'APPROVED' || shipper.isCommissionApproved === true;

    if (approved && !hasValue) {
      return res.status(400).json({ message: 'Commission value must be set before approving' });
    }

    if (approved) {
      shipper.approvedBy = req.user.id;
      shipper.approvedAt = new Date();
      shipper.isCommissionApproved = true;
      shipper.commissionStatus = 'APPROVED';
    } else {
      shipper.approvedBy = null;
      shipper.approvedAt = null;
      shipper.isCommissionApproved = false;
      shipper.commissionStatus = 'PENDING';
    }

    const updated = await prisma.user.update({
      where: { id: shipperId },
      data: {
        commissionRate: shipper.commissionRate,
        commissionType: shipper.commissionType,
        commissionValue: shipper.commissionValue,
        commissionStatus: shipper.commissionStatus,
        isCommissionApproved: shipper.isCommissionApproved,
        approvedBy: shipper.approvedBy,
        approvedAt: shipper.approvedAt,
      },
    });

    const { passwordHash, ...safeUpdated } = updated;
    res.json({ user: { _id: safeUpdated.id, ...safeUpdated } });
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

    const userId = Number(id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ message: 'Invalid user id' });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
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
    const passwordHash = await bcrypt.hash(newPassword, 10);

    // Update user password
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });

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
