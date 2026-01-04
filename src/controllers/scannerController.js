const prisma = require("../prismaClient");
const { calculateServiceCharges, validateWeight } = require("../utils/serviceChargeCalculator");

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

    // Find order by bookingId (Prisma)
    const order = await prisma.order.findFirst({
      where: {
        bookingId: extractedBookingId,
        isDeleted: false,
      },
      include: {
        shipper: {
          select: { id: true, name: true, email: true, companyName: true, phone: true },
        },
        assignedRider: {
          select: { id: true, name: true },
        },
        weightVerifiedBy: {
          select: { id: true, name: true },
        },
        warehouseReceivedBy: {
          select: { id: true, name: true },
        },
        invoice: {
          select: { id: true },
        },
      },
    });

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
    const isInvoiced = order.invoiceId != null;

    res.json({
      success: true,
      data: {
        order: {
          _id: order.id,
          id: order.id,
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

    const userIdRaw = req.user && (req.user.id || req.user._id);
    const userId = Number(userIdRaw);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

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

    // Find order (Prisma)
    const order = await prisma.order.findFirst({
      where: {
        bookingId: extractedBookingId,
        isDeleted: false,
      },
      include: {
        shipper: {
          select: { id: true, name: true, email: true, companyName: true, phone: true },
        },
        invoice: {
          select: { id: true },
        },
      },
    });

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
    if (order.invoiceId != null) {
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
    const currentWeight = Number(order.weightKg || 0);
    const newWeight =
      scannedWeightKg !== undefined && scannedWeightKg !== null
        ? Number(scannedWeightKg)
        : currentWeight;
    const isWeightChanged = newWeight !== currentWeight;

    let statusChanged = false;
    let oldWeightForResponse = currentWeight;

    // Build update payload
    const updateData = {};

    if (isWeightChanged) {
      // Preserve original weight if not set
      if (order.weightOriginalKg == null && currentWeight !== newWeight) {
        updateData.weightOriginalKg = currentWeight;
      }

      // Calculate new service charges using Prisma-based calculator
      const { serviceCharges, snapshot } = await calculateServiceCharges(order, newWeight);

      updateData.weightKg = newWeight;
      updateData.weightVerifiedById = userId;
      updateData.weightVerifiedAt = new Date();
      updateData.weightSource = "WAREHOUSE_SCAN";
      updateData.serviceCharges = serviceCharges;

      if (snapshot) {
        updateData.serviceChargesWeightUsed = snapshot.weightUsed;
        updateData.serviceChargesBracketMin = snapshot.bracketMin;
        updateData.serviceChargesBracketMax = snapshot.bracketMax;
        updateData.serviceChargesRate = snapshot.rate;
        updateData.serviceChargesCalculatedAt = snapshot.calculatedAt || new Date();
      }

      const codBase =
        order.paymentType === "ADVANCE" ? 0 : Number(order.codAmount || 0);
      updateData.totalAmount = codBase + Number(serviceCharges || 0);
    }

    // Update warehouse status if not already set
    if (order.status !== "AT_LLL_WAREHOUSE") {
      updateData.status = "AT_LLL_WAREHOUSE";
      statusChanged = true;
    }

    // Update warehouse tracking
    if (!order.warehouseReceivedAt) {
      updateData.warehouseReceivedAt = new Date();
      updateData.warehouseReceivedById = userId;
    }

    // Persist updates via Prisma
    const updatedOrder = await prisma.order.update({
      where: { id: order.id },
      data: updateData,
      include: {
        shipper: {
          select: { id: true, name: true, email: true, companyName: true, phone: true },
        },
        assignedRider: {
          select: { id: true, name: true },
        },
        weightVerifiedBy: {
          select: { id: true, name: true },
        },
        warehouseReceivedBy: {
          select: { id: true, name: true },
        },
      },
    });

    // Record an order event for audit trail if status changed
    if (statusChanged) {
      const note = isWeightChanged
        ? `Scanned into warehouse with weight verification (${currentWeight}kg → ${newWeight}kg)`
        : "Scanned into warehouse";

      await prisma.orderEvent.create({
        data: {
          orderId: order.id,
          status: "AT_LLL_WAREHOUSE",
          note,
          createdById: userId,
        },
      });
    }

    res.json({
      success: true,
      message: "Order successfully scanned into warehouse",
      data: {
        order: {
          ...updatedOrder,
          _id: updatedOrder.id,
        },
        changes: {
          statusChanged,
          weightChanged: isWeightChanged,
          oldWeight: isWeightChanged ? oldWeightForResponse : null,
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
