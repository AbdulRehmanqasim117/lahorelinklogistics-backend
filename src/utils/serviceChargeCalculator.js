const prisma = require('../prismaClient');

// Normalize a CommissionConfig into the new single-rule fields, falling back to
// legacy WeightBracket[] data if the new fields are not populated.
function normalizeCommissionRule(config) {
  if (!config) return null;

  let {
    minWeightKg,
    maxWeightKg,
    flatChargePkr,
    overagePerKgPkr,
  } = config;

  // Consider the new rule "configured" only when min/max have been explicitly
  // set. flatCharge/overage have DB defaults of 0, so they are not reliable
  // signals on their own.
  const hasNewRule =
    minWeightKg !== null && minWeightKg !== undefined ||
    maxWeightKg !== null && maxWeightKg !== undefined;

  if (!hasNewRule && Array.isArray(config.weightBrackets) && config.weightBrackets.length) {
    const norm = config.weightBrackets
      .map((b) => ({
        min: Number(b.minKg),
        max:
          b.maxKg === null || b.maxKg === undefined || b.maxKg === ''
            ? null
            : Number(b.maxKg),
        charge: Number(b.chargePkr ?? b.charge ?? 0),
      }))
      .filter(
        (b) =>
          Number.isFinite(b.min) &&
          b.min >= 0 &&
          (b.max === null || Number.isFinite(b.max)) &&
          Number.isFinite(b.charge) &&
          b.charge >= 0,
      );

    if (!norm.length) {
      return null;
    }

    const min = norm.reduce((acc, b) => (b.min < acc ? b.min : acc), norm[0].min);

    const withMax = norm.reduce((best, b) => {
      if (!best) return b;
      const bestMax = best.max === null ? Infinity : best.max;
      const currMax = b.max === null ? Infinity : b.max;
      return currMax >= bestMax ? b : best;
    }, null);

    minWeightKg = min;
    maxWeightKg = withMax.max === null ? withMax.min : withMax.max;
    flatChargePkr = withMax.charge;
    overagePerKgPkr = 0;
  }

  const min =
    minWeightKg === null || minWeightKg === undefined
      ? 0
      : Number(minWeightKg);
  const max =
    maxWeightKg === null || maxWeightKg === undefined || maxWeightKg === ''
      ? null
      : Number(maxWeightKg);
  const flat = Number(flatChargePkr || 0);
  const overage = Number(overagePerKgPkr || 0);

  if (!Number.isFinite(min) || min < 0) return null;
  if (max !== null && (!Number.isFinite(max) || max <= min)) return null;
  if (!Number.isFinite(flat) || flat < 0) return null;
  if (!Number.isFinite(overage) || overage < 0) return null;

  return {
    minWeightKg: min,
    maxWeightKg: max,
    flatChargePkr: flat,
    overagePerKgPkr: overage,
  };
}

/**
 * Compute service charge for a given weight using the new single-rule
 * configuration.
 *
 * Rules:
 * - If actualWeightKg <= maxWeightKg (or maxWeightKg is null):
 *     charge = flatChargePkr
 * - If actualWeightKg > maxWeightKg:
 *     overKg = ceil(actualWeightKg - maxWeightKg)
 *     charge = flatChargePkr + overKg * overagePerKgPkr
 *
 * Returns both the numeric charge and a small snapshot for auditing.
 */
function computeServiceChargeKgBased(actualWeightKg, config) {
  const weight = Number(actualWeightKg);
  if (!Number.isFinite(weight) || weight <= 0) {
    return {
      serviceCharges: 0,
      overageKg: 0,
      rule: null,
    };
  }

  const rule = normalizeCommissionRule(config);
  if (!rule) {
    return {
      serviceCharges: 0,
      overageKg: 0,
      rule: null,
    };
  }

  const { minWeightKg, maxWeightKg, flatChargePkr, overagePerKgPkr } = rule;

  if (weight < minWeightKg) {
    return {
      serviceCharges: 0,
      overageKg: 0,
      rule,
    };
  }

  let overageKg = 0;
  if (maxWeightKg != null && weight > maxWeightKg) {
    overageKg = Math.ceil(weight - maxWeightKg);
  }

  const overagePart = overageKg > 0 ? overageKg * overagePerKgPkr : 0;
  const total = Math.max(0, flatChargePkr + overagePart);

  return {
    serviceCharges: total,
    overageKg,
    rule,
  };
}

/**
 * Calculate service charges based on weight and shipper's commission
 * configuration (Prisma-based lookup).
 *
 * @param {Object} order - Order-like object with at least shipperId (or shipper.id) and weightKg
 * @param {number|null} weightKg - Explicit weight in kg (optional, falls back to order.weightKg)
 * @returns {Promise<{ serviceCharges: number, snapshot: object|null }>}
 */
const calculateServiceCharges = async (order, weightKg = null) => {
  try {
    const weight =
      weightKg != null && !Number.isNaN(Number(weightKg))
        ? Number(weightKg)
        : Number(order.weightKg || 0);

    const shipperId =
      (order && (order.shipperId || order.shipper_id)) ||
      (order && order.shipper && (order.shipper.id || order.shipper.shipperId));

    if (!shipperId || !weight || weight <= 0) {
      return {
        serviceCharges: 0,
        snapshot: null,
      };
    }

    const commissionConfig = await prisma.commissionConfig.findUnique({
      where: { shipperId: Number(shipperId) },
      include: { weightBrackets: true },
    });

    const { serviceCharges, overageKg, rule } = computeServiceChargeKgBased(
      weight,
      commissionConfig,
    );

    if (!rule) {
      console.warn(
        `[ServiceChargeCalculator] No valid commission rule found for shipper ${shipperId}`,
      );
      return {
        serviceCharges: 0,
        snapshot: null,
      };
    }

    const snapshot = {
      weightUsed: weight,
      bracketMin: rule.minWeightKg,
      bracketMax: rule.maxWeightKg,
      rate: rule.flatChargePkr,
      overagePerKgPkr: rule.overagePerKgPkr,
      overageKg,
      calculatedAt: new Date(),
    };

    return {
      serviceCharges,
      snapshot,
    };
  } catch (error) {
    console.error('[ServiceChargeCalculator] Error calculating service charges (Prisma):', error);
    return {
      serviceCharges: 0,
      snapshot: null,
    };
  }
};

/**
 * Validate weight value
 * @param {Number} weight - Weight to validate
 * @param {Number} maxWeight - Maximum allowed weight (default: 50kg)
 * @returns {Object} - { isValid, error }
 */
const validateWeight = (weight, maxWeight = 50) => {
  if (weight === null || weight === undefined) {
    return { isValid: false, error: 'Weight is required' };
  }

  const numWeight = Number(weight);

  if (isNaN(numWeight)) {
    return { isValid: false, error: 'Weight must be a valid number' };
  }

  if (numWeight <= 0) {
    return { isValid: false, error: 'Weight must be greater than 0' };
  }

  if (numWeight > maxWeight) {
    return { isValid: false, error: `Weight cannot exceed ${maxWeight}kg` };
  }

  // Check for reasonable precision (max 3 decimal places)
  const decimalPlaces = (numWeight.toString().split('.')[1] || '').length;
  if (decimalPlaces > 3) {
    return { isValid: false, error: 'Weight can have maximum 3 decimal places' };
  }

  return { isValid: true, error: null };
};

module.exports = {
  calculateServiceCharges,
  validateWeight,
  computeServiceChargeKgBased,
  normalizeCommissionRule,
};
