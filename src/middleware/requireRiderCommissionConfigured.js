const prisma = require('../prismaClient');

module.exports = async function requireRiderCommissionConfigured(req, res, next) {
  try {
    // Only gate rider accounts; all other roles continue as normal
    if (!req.user || req.user.role !== 'RIDER') {
      return next();
    }

    const riderIdNum = Number(req.user.id);
    if (!riderIdNum || !Number.isInteger(riderIdNum)) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const cfg = await prisma.riderCommissionConfig.findUnique({
      where: { riderId: riderIdNum },
      include: { rules: true },
    });

    const hasRules = cfg && Array.isArray(cfg.rules) && cfg.rules.length > 0;
    const hasBaseCommission =
      cfg && cfg.type && cfg.value !== undefined && cfg.value !== null;

    if (hasRules || hasBaseCommission) {
      return next();
    }

    return res.status(403).json({
      code: 'RIDER_PORTAL_INACTIVE',
      message:
        'Your rider account is under configuration. Please wait for management to set your commission rules.',
    });
  } catch (error) {
    next(error);
  }
};
