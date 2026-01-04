const prisma = require('../prismaClient');

/**
 * Calculate service charges based on weight and shipper's weight brackets (Prisma-based).
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

    if (
      !commissionConfig ||
      !Array.isArray(commissionConfig.weightBrackets) ||
      commissionConfig.weightBrackets.length === 0
    ) {
      console.warn(`[ServiceChargeCalculator] No weight brackets found for shipper ${shipperId}`);
      return {
        serviceCharges: 0,
        snapshot: null,
      };
    }

    const bracketsSorted = commissionConfig.weightBrackets
      .slice()
      .sort((a, b) => Number(a.minKg || 0) - Number(b.minKg || 0));

    const matchingBracket = bracketsSorted.find((bracket) => {
      const min = Number(bracket.minKg || 0);
      const max =
        bracket.maxKg === null || typeof bracket.maxKg === 'undefined'
          ? null
          : Number(bracket.maxKg);
      const withinMin = weight >= min;
      const withinMax = max === null ? true : weight < max;
      return withinMin && withinMax;
    });

    if (!matchingBracket) {
      console.warn(
        `[ServiceChargeCalculator] No matching weight bracket for weight ${weight}kg and shipper ${shipperId}`,
      );
      return {
        serviceCharges: 0,
        snapshot: null,
      };
    }

    const snapshot = {
      weightUsed: weight,
      bracketMin: matchingBracket.minKg,
      bracketMax: matchingBracket.maxKg,
      rate: matchingBracket.chargePkr,
      calculatedAt: new Date(),
    };

    return {
      serviceCharges: Number(matchingBracket.chargePkr || 0),
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
  validateWeight
};
