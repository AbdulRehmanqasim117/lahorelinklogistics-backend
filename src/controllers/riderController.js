const RiderProfile = require('../models/RiderProfile');
const User = require('../models/User');
const Order = require('../models/Order');
const ExcelJS = require('exceljs');
const prisma = require('../prismaClient');

/**
 * Rider Self-Assign via QR Scanner
 * POST /api/rider/scan-assign
 * Auth: Rider only
 * Body: { "bookingId": "LLL12345" }
 * 
 * Business Rules:
 * - Order must NOT be delivered/returned/cancelled
 * - Order must be in CREATED / ASSIGNED / AT_LLL_WAREHOUSE state
 * - If order is already assigned to another rider, reject (409)
 * - Assign order to current rider and set status to OUT_FOR_DELIVERY
 */
exports.scanAssign = async (req, res, next) => {
  try {
    const { bookingId } = req.body;
    const riderId = req.user.id || req.user._id;

    if (!bookingId || !bookingId.trim()) {
      return res.status(400).json({ message: 'bookingId is required' });
    }

    // Find order by bookingId
    const order = await Order.findOne({ bookingId: bookingId.trim() })
      .populate('shipper', 'name email')
      .populate('assignedRider', 'name email');

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    // Validate order is not in final states
    const finalStates = ['DELIVERED', 'RETURNED', 'FAILED'];
    if (finalStates.includes(order.status)) {
      return res.status(400).json({ 
        message: `Cannot assign order. Order is already ${order.status}` 
      });
    }

    // Validate order is in assignable state
    const assignableStates = ['CREATED', 'ASSIGNED', 'AT_LLL_WAREHOUSE'];
    if (!assignableStates.includes(order.status)) {
      return res.status(400).json({ 
        message: `Order cannot be assigned in current status: ${order.status}` 
      });
    }

    // Check if order is already assigned to another rider
    const assignedRiderId = order.assignedRider 
      ? (order.assignedRider._id ? order.assignedRider._id.toString() : order.assignedRider.toString())
      : null;
    
    if (assignedRiderId && assignedRiderId !== riderId.toString()) {
      return res.status(409).json({ 
        message: 'Order already assigned to another rider' 
      });
    }

    // Assign order to current rider
    order.assignedRider = riderId;
    order.status = 'OUT_FOR_DELIVERY';
    order.outForDeliveryAt = new Date();

    // Add status history entry
    order.statusHistory.push({
      status: 'OUT_FOR_DELIVERY',
      timestamp: new Date(),
      updatedBy: riderId,
      note: 'Assigned and marked Out for Delivery via QR scan'
    });

    const updatedOrder = await order.save();

    res.json({
      message: 'Assigned to you and marked Out for Delivery',
      order: updatedOrder
    });
  } catch (error) {
    next(error);
  }
};

// Manager/CEO rider finance list (used by ManagerRiders & CEO Riders pages)
// Migrated to Prisma to avoid Mongo users.find() timeouts.
exports.getRidersWithFinance = async (req, res, next) => {
  try {
    const riders = await prisma.user.findMany({
      where: { role: 'RIDER' },
      orderBy: { createdAt: 'desc' },
      include: {
        riderProfile: true,
        ordersRidden: {
          where: { isDeleted: false },
          select: { id: true },
        },
      },
    });

    const mapped = riders.map((rider) => {
      const profile = rider.riderProfile;
      const assignedOrders = rider.ordersRidden ? rider.ordersRidden.length : 0;

      return {
        _id: String(rider.id),
        id: rider.id,
        name: rider.name,
        email: rider.email,
        phone: rider.phone,
        role: rider.role,
        status: rider.status,
        codCollected: profile?.codCollected || 0,
        serviceCharges: profile?.serviceCharges || 0,
        serviceChargeStatus: profile?.serviceChargeStatus || 'unpaid',
        assignedOrders,
      };
    });

    res.json(mapped);
  } catch (error) {
    next(error);
  }
};

// Toggle rider service charge status (paid/unpaid) using Prisma RiderProfile
exports.updateServiceChargeStatus = async (req, res, next) => {
  try {
    const rawId = req.params && req.params.id;
    const userId = Number(rawId);
    const { status } = req.body || {};

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ message: 'Invalid rider id' });
    }

    if (!['paid', 'unpaid'].includes(status)) {
      return res
        .status(400)
        .json({ message: 'Invalid status. Must be "paid" or "unpaid"' });
    }

    // Ensure rider exists
    const rider = await prisma.user.findUnique({ where: { id: userId } });
    if (!rider || rider.role !== 'RIDER') {
      return res.status(404).json({ message: 'Rider not found' });
    }

    let profile = await prisma.riderProfile.findUnique({
      where: { userId },
    });

    if (!profile) {
      profile = await prisma.riderProfile.create({
        data: {
          userId,
          codCollected: 0,
          serviceCharges: 0,
          serviceChargeStatus: status,
        },
      });
    } else {
      if (status === 'paid') {
        profile = await prisma.riderProfile.update({
          where: { userId },
          data: {
            serviceCharges: 0,
            serviceChargeStatus: 'paid',
          },
        });
      } else {
        profile = await prisma.riderProfile.update({
          where: { userId },
          data: {
            serviceChargeStatus: 'unpaid',
          },
        });
      }
    }

    res.json(profile);
  } catch (error) {
    next(error);
  }
};

// Daily Excel report for a rider's orders on a specific date (Prisma-based)
exports.getDailyReport = async (req, res, next) => {
  try {
    const rawId = req.params && req.params.id;
    const riderId = Number(rawId);
    const { date } = req.query;

    if (!Number.isInteger(riderId) || riderId <= 0) {
      return res.status(400).json({ message: 'Invalid rider id' });
    }

    if (!date) {
      return res
        .status(400)
        .json({ message: 'Date parameter is required (YYYY-MM-DD)' });
    }

    const rider = await prisma.user.findUnique({ where: { id: riderId } });
    if (!rider || rider.role !== 'RIDER') {
      return res.status(404).json({ message: 'Rider not found' });
    }

    const startDate = new Date(date);
    if (Number.isNaN(startDate.getTime())) {
      return res
        .status(400)
        .json({ message: 'Invalid date format. Use YYYY-MM-DD' });
    }
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(startDate);
    endDate.setHours(23, 59, 59, 999);

    const orders = await prisma.order.findMany({
      where: {
        assignedRiderId: riderId,
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
        isDeleted: false,
      },
      include: {
        shipper: {
          select: { name: true, companyName: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Rider Daily Report');

    worksheet.columns = [
      { header: 'Order ID', key: 'bookingId', width: 15 },
      { header: 'Consignee Name', key: 'consigneeName', width: 25 },
      { header: 'COD', key: 'codAmount', width: 15 },
      { header: 'Status', key: 'status', width: 20 },
      { header: 'City', key: 'destinationCity', width: 15 },
      { header: 'Service Charges', key: 'serviceCharges', width: 18 },
    ];

    orders.forEach((order) => {
      worksheet.addRow({
        bookingId: order.bookingId,
        consigneeName: order.consigneeName,
        codAmount: order.amountCollected || order.codAmount || 0,
        status: order.status,
        destinationCity: order.destinationCity,
        serviceCharges: order.serviceCharges || 0,
      });
    });

    const totalCod = orders.reduce(
      (sum, o) => sum + Number(o.amountCollected || o.codAmount || 0),
      0,
    );
    const totalServiceCharges = orders.reduce(
      (sum, o) => sum + Number(o.serviceCharges || 0),
      0,
    );

    worksheet.addRow({});
    worksheet.addRow({
      bookingId: 'TOTAL',
      consigneeName: '',
      codAmount: totalCod,
      status: '',
      destinationCity: '',
      serviceCharges: totalServiceCharges,
    });

    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' },
    };

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=rider-${rider.name}-${date}.xlsx`,
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    next(error);
  }
};

