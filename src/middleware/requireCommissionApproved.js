const CommissionConfig = require('../models/CommissionConfig');

module.exports = async function requireCommissionApproved(req, res, next) {
  try {
    if (!req.user || req.user.role !== 'SHIPPER') {
      return next();
    }

    const shipperId = req.user.id || req.user._id;
    const cfg = await CommissionConfig.findOne({ shipper: shipperId })
      .select('weightBrackets')
      .lean();

    const hasWeightBrackets =
      cfg && Array.isArray(cfg.weightBrackets) && cfg.weightBrackets.length > 0;

    if (hasWeightBrackets) {
      return next();
    }

    return res.status(403).json({
      code: 'PORTAL_INACTIVE',
      message:
        'Your account is under configuration. Please wait for management to set your weight brackets.',
    });
  } catch (error) {
    next(error);
  }
};
