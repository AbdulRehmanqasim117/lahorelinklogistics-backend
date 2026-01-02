const Order = require("../models/Order");
const {
  recalculateAndUpdateServiceCharges,
  validateWeight,
} = require("../utils/serviceChargeCalculator");

/**
 * Get order details for warehouse scan confirmation
 * GET /api/orders/:bookingId/scan-preview
 * Only accessible by CEO and MANAGER roles
 */
exports.getOrderForScan = async (req, res, next) => {
  try {
    const { bookingId } = req.params;

    if (!bookingId) {
      return res.status(400).json({ message: "Booking ID is required" });
    }

    // Extract bookingId from QR format "LLL|<bookingId>" if present
    let extractedBookingId = bookingId;
    if (bookingId.includes("|")) {
      const parts = bookingId.split("|");
      if (parts.length === 2 && parts[0] === "LLL") {
        extractedBookingId = parts[1];
      }
    }

    // Find order by bookingId
    const order = await Order.findOne({ bookingId: extractedBookingId })
      .populate("shipper", "name email companyName")
      .populate("assignedRider", "name")
      .populate("weightVerifiedBy", "name")
      .populate("warehouseReceivedBy", "name");

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
        code: "ORDER_NOT_FOUND",
      });
    }

    // Check if order is in a state that allows warehouse scanning
    const invalidStates = ["DELIVERED", "CANCELLED", "RETURNED"];
    if (invalidStates.includes(order.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot scan order in ${order.status} status`,
        code: "INVALID_STATUS",
      });
    }

    // Check if order is already invoiced (prevents weight changes)
    const isInvoiced = order.invoice !== null;

    res.json({
      success: true,
      data: {
        order: {
          _id: order._id,
          bookingId: order.bookingId,
          consigneeName: order.consigneeName,
          destinationCity: order.destinationCity,
          status: order.status,
          weightKg: order.weightKg,
          weightOriginalKg: order.weightOriginalKg,
          weightSource: order.weightSource,
          weightVerifiedAt: order.weightVerifiedAt,
          serviceCharges: order.serviceCharges,
          codAmount: order.codAmount,
          shipper: order.shipper,
          assignedRider: order.assignedRider,
          warehouseReceivedAt: order.warehouseReceivedAt,
          warehouseReceivedBy: order.warehouseReceivedBy,
          isInvoiced: isInvoiced,
          canChangeWeight: !isInvoiced,
        },
      },
    });
  } catch (error) {
    console.error("Error fetching order for scan:", error);
    next(error);
  }
};

/**
 * Enhanced warehouse scan with weight verification
 * POST /api/orders/:bookingId/warehouse-scan
 * Only accessible by CEO and MANAGER roles
 */
exports.warehouseScan = async (req, res, next) => {
  try {
    const { bookingId } = req.params;
    const { scannedWeightKg } = req.body;
    const userId = req.user.id || req.user._id;

    if (!bookingId) {
      return res.status(400).json({
        success: false,
        message: "Booking ID is required",
      });
    }

    // Extract bookingId from QR format if present
    let extractedBookingId = bookingId;
    if (bookingId.includes("|")) {
      const parts = bookingId.split("|");
      if (parts.length === 2 && parts[0] === "LLL") {
        extractedBookingId = parts[1];
      }
    }

    // Find order
    const order = await Order.findOne({
      bookingId: extractedBookingId,
    }).populate("shipper", "name email companyName");

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
        code: "ORDER_NOT_FOUND",
      });
    }

    // Validate order status
    const invalidStates = ["DELIVERED", "CANCELLED", "RETURNED"];
    if (invalidStates.includes(order.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot scan order in ${order.status} status`,
        code: "INVALID_STATUS",
      });
    }

    // Check if already invoiced
    if (order.invoice !== null) {
      return res.status(400).json({
        success: false,
        message: "Order already paid; cannot change weight",
        code: "ORDER_INVOICED",
      });
    }

    // Validate weight if provided
    if (scannedWeightKg !== undefined && scannedWeightKg !== null) {
      const weightValidation = validateWeight(scannedWeightKg);
      if (!weightValidation.isValid) {
        return res.status(400).json({
          success: false,
          message: weightValidation.error,
          code: "INVALID_WEIGHT",
        });
      }
    }

    // Determine if weight is being updated
    const newWeight =
      scannedWeightKg !== undefined ? Number(scannedWeightKg) : order.weightKg;
    const isWeightChanged = newWeight !== order.weightKg;

    // If weight is changing, recalculate service charges
    if (isWeightChanged) {
      await recalculateAndUpdateServiceCharges(order, newWeight, userId);
    }

    // Update warehouse status if not already set
    let statusChanged = false;
    if (order.status !== "AT_LLL_WAREHOUSE") {
      order.status = "AT_LLL_WAREHOUSE";
      order.statusHistory.push({
        status: "AT_LLL_WAREHOUSE",
        timestamp: new Date(),
        updatedBy: userId,
        note: isWeightChanged
          ? `Scanned into warehouse with weight verification (${order.weightKg}kg)`
          : "Scanned into warehouse",
      });
      statusChanged = true;
    }

    // Update warehouse tracking
    if (!order.warehouseReceivedAt) {
      order.warehouseReceivedAt = new Date();
      order.warehouseReceivedBy = userId;
    }

    // Save the order
    await order.save();

    // Return updated order with populated fields
    const updatedOrder = await Order.findById(order._id)
      .populate("shipper", "name email companyName")
      .populate("assignedRider", "name")
      .populate("weightVerifiedBy", "name")
      .populate("warehouseReceivedBy", "name");

    res.json({
      success: true,
      message: "Order successfully scanned into warehouse",
      data: {
        order: updatedOrder,
        changes: {
          statusChanged,
          weightChanged: isWeightChanged,
          oldWeight: isWeightChanged
            ? order.weightChangeLog[order.weightChangeLog.length - 1]
                ?.oldWeightKg
            : null,
          newWeight: isWeightChanged ? newWeight : null,
          serviceChargesRecalculated: isWeightChanged,
        },
      },
    });
  } catch (error) {
    console.error("Error in warehouse scan:", error);
    next(error);
  }
};

/**
 * Legacy scan endpoint for backward compatibility
 * POST /api/orders/scan
 * Redirects to new warehouse scan functionality
 */
exports.scanOrder = async (req, res, next) => {
  try {
    const { bookingId } = req.body;

    if (!bookingId) {
      return res.status(400).json({ message: "Booking ID is required" });
    }

    // Call the new warehouse scan method without weight change
    req.params.bookingId = bookingId;
    req.body = {}; // No weight change

    return exports.warehouseScan(req, res, next);
  } catch (error) {
    next(error);
  }
};
