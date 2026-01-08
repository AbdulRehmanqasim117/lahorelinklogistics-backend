const prisma = require('../prismaClient');
const { normalizeCommissionRule } = require('../utils/serviceChargeCalculator');

module.exports = async function requireCommissionApproved(req, res, next) {
  try {
    // Only gate shipper accounts; all other roles continue as normal
    if (!req.user || req.user.role !== 'SHIPPER') {
      return next();
    }

    const shipperIdNum = Number(req.user.id);
    if (!shipperIdNum || !Number.isInteger(shipperIdNum)) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const cfg = await prisma.commissionConfig.findUnique({
      where: { shipperId: shipperIdNum },
      include: { weightBrackets: true },
    });

    const hasRule = !!normalizeCommissionRule(cfg || null);

    if (hasRule) {
      return next();
    }

    return res.status(403).json({
      code: 'PORTAL_INACTIVE',
      message:
        'Your account is under configuration. Please wait for management to set your commission rule.',
    });
  } catch (error) {
    next(error);
  }
};
