const CommissionConfig = require('../models/CommissionConfig');

/**
 * Calculate service charges based on weight and shipper's weight brackets
 * @param {Object} order - Order object with shipper and weightKg
 * @param {Number} weightKg - Weight in kg (optional, uses order.weightKg if not provided)
 * @returns {Object} - { serviceCharges, snapshot }
 */
const calculateServiceCharges = async (order, weightKg = null) => {
  try {
    const weight = weightKg || order.weightKg;
    const shipperId = order.shipper?._id || order.shipper;

    if (!shipperId || !weight) {
      return {
        serviceCharges: 0,
        snapshot: null
      };
    }

    // Get commission config for the shipper
    const commissionConfig = await CommissionConfig.findOne({ shipper: shipperId });

    if (!commissionConfig || !Array.isArray(commissionConfig.weightBrackets) || commissionConfig.weightBrackets.length === 0) {
      console.warn(`No weight brackets found for shipper ${shipperId}`);
      return {
        serviceCharges: 0,
        snapshot: null
      };
    }

    // Find matching weight bracket
    const matchingBracket = commissionConfig.weightBrackets.find(bracket => {
      const withinMin = weight >= bracket.minKg;
      const withinMax = bracket.maxKg === null || bracket.maxKg === undefined || weight <= bracket.maxKg;
      return withinMin && withinMax;
    });

    if (!matchingBracket) {
      console.warn(`No matching weight bracket found for weight ${weight}kg and shipper ${shipperId}`);
      return {
        serviceCharges: 0,
        snapshot: null
      };
    }

    // Create calculation snapshot for audit
    const snapshot = {
      weightUsed: weight,
      bracketMin: matchingBracket.minKg,
      bracketMax: matchingBracket.maxKg,
      rate: matchingBracket.charge,
      calculatedAt: new Date()
    };

    return {
      serviceCharges: matchingBracket.charge,
      snapshot
    };
  } catch (error) {
    console.error('Error calculating service charges:', error);
    return {
      serviceCharges: 0,
      snapshot: null
    };
  }
};

/**
 * Recalculate service charges for an order and update the order
 * @param {Object} order - Mongoose order document
 * @param {Number} newWeightKg - New weight in kg
 * @param {String} userId - User ID who made the change
 * @returns {Object} - Updated order with new service charges
 */
const recalculateAndUpdateServiceCharges = async (order, newWeightKg, userId) => {
  try {
    // Store original weight if not already stored
    if (!order.weightOriginalKg && order.weightKg !== newWeightKg) {
      order.weightOriginalKg = order.weightKg;
    }

    // Store weight change in audit log
    if (order.weightKg !== newWeightKg) {
      order.weightChangeLog.push({
        oldWeightKg: order.weightKg,
        newWeightKg: newWeightKg,
        changedBy: userId,
        changedAt: new Date(),
        reason: 'Warehouse scan weight verification'
      });
    }

    // Update weight
    order.weightKg = newWeightKg;
    order.weightVerifiedBy = userId;
    order.weightVerifiedAt = new Date();
    order.weightSource = 'WAREHOUSE_SCAN';

    // Calculate new service charges
    const { serviceCharges, snapshot } = await calculateServiceCharges(order, newWeightKg);

    // Update service charges and snapshot
    order.serviceCharges = serviceCharges;
    if (snapshot) {
      order.serviceChargesCalcSnapshot = snapshot;
    }

    // Update total amount (COD + service charges)
    order.totalAmount = (order.paymentType === 'ADVANCE' ? 0 : Number(order.codAmount || 0)) + serviceCharges;

    return order;
  } catch (error) {
    console.error('Error recalculating service charges:', error);
    throw error;
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
  recalculateAndUpdateServiceCharges,
  validateWeight
};
