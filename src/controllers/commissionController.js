const CommissionConfig = require('../models/CommissionConfig');
const User = require('../models/User');
const RiderCommissionConfig = require('../models/RiderCommissionConfig');

function validateWeightBrackets(brackets) {
  if (!Array.isArray(brackets) || brackets.length === 0) {
    return { valid: false, message: 'At least one weight bracket is required' };
  }
  // Sort by minKg (do not mutate input)
  const sorted = brackets.map(b => ({...b})).sort((a, b) => a.minKg - b.minKg);
  for (let i = 0; i < sorted.length; ++i) {
    const b = sorted[i];
    if (b.minKg == null || isNaN(b.minKg) || b.minKg < 0) return { valid: false, message: `Invalid minKg for bracket ${i+1}` };
    if (b.charge == null || isNaN(b.charge) || b.charge < 0) return { valid: false, message: `Invalid charge for bracket ${i+1}` };
    if (b.maxKg != null && (isNaN(b.maxKg) || b.maxKg <= b.minKg)) return { valid: false, message: `maxKg must be > minKg for bracket ${i+1}` };
    if (i > 0) {
      const prev = sorted[i-1];
      // Gaps allowed, but overlap not allowed
      if (prev.maxKg != null) {
        if (b.minKg < prev.maxKg) {
          return { valid: false, message: `Overlap between ${prev.minKg}-${prev.maxKg}kg and ${b.minKg}-${b.maxKg || '∞'}kg` };
        }
      }
    }
    // Only last can be maxKg == null
    if (b.maxKg == null && i !== sorted.length-1) {
      return { valid: false, message: `Only last bracket can have no maxKg (infinity bracket)` };
    }
  }
  return { valid: true };
}

exports.validateWeightBrackets = validateWeightBrackets;

exports.getConfigs = async (req, res, next) => {
  try {
    const configs = await CommissionConfig.find({})
      .populate('shipper', 'name email');
    res.json(configs);
  } catch (error) {
    next(error);
  }
};

exports.upsertConfig = async (req, res, next) => {
  try {
    const { 
      shipperId, 
      type, 
      value, 
      riderType, 
      riderValue,
      weightCharges 
    } = req.body;

    if (!shipperId || !type || value === undefined) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const update = { 
      type, 
      value,
      // Only include weightCharges if provided
      ...(weightCharges && { weightCharges })
    };
    
    if (riderType !== undefined) update.riderType = riderType;
    if (riderValue !== undefined) update.riderValue = riderValue;

    const config = await CommissionConfig.findOneAndUpdate(
      { shipper: shipperId },
      update,
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    res.json(config);
  } catch (error) {
    next(error);
  }
};

exports.getRiderConfigs = async (req, res, next) => {
  try {
    const configs = await RiderCommissionConfig.find({})
      .populate('rider', 'name email');
    res.json(configs);
  } catch (error) {
    next(error);
  }
};

exports.upsertRiderConfig = async (req, res, next) => {
  try {
    const { riderId, type, value, rules } = req.body;
    if (!riderId) {
      return res.status(400).json({ message: 'Missing fields' });
    }
    const update = {};
    if (type !== undefined && value !== undefined) {
      update.type = type;
      update.value = value;
    }
    if (Array.isArray(rules)) {
      update.rules = rules.filter(r => r && r.status && r.type && r.value !== undefined);
    }
    const config = await RiderCommissionConfig.findOneAndUpdate(
      { rider: riderId },
      update,
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    res.json(config);
  } catch (error) {
    next(error);
  }
};

// GET /api/commission/:shipperId - CEO/MANAGER only
exports.getConfigByShipper = async (req, res, next) => {
  try {
    const shipperId = req.params.shipperId;
    if (!shipperId) return res.status(400).json({ message: 'shipperId required' });
    const config = await CommissionConfig.findOne({ shipper: shipperId });
    if (!config) return res.status(404).json({ message: 'No commission config found for this shipper' });
    res.json(config);
  } catch (err) { next(err); }
};

// PUT /api/commission/:shipperId - CEO/MANAGER only
exports.putConfigByShipper = async (req, res, next) => {
  try {
    const shipperId = req.params.shipperId;
    if (!shipperId) return res.status(400).json({ message: 'shipperId required' });
    const { type, value, weightBrackets } = req.body;
    if (!type || typeof value !== 'number') {
      return res.status(400).json({ message: 'type and value required' });
    }
    // Validate brackets:
    const valRes = validateWeightBrackets(weightBrackets);
    if (!valRes.valid) {
      return res.status(400).json({ message: valRes.message });
    }
    const toUpdate = { type, value, weightBrackets };
    // Upsert config
    const updated = await CommissionConfig.findOneAndUpdate(
      { shipper: shipperId },
      toUpdate,
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    res.json(updated);
  } catch (err) { next(err); }
};
