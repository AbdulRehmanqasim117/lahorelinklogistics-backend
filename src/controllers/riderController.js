const RiderProfile = require('../models/RiderProfile');
const User = require('../models/User');
const Order = require('../models/Order');
const ExcelJS = require('exceljs');

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

exports.getRidersWithFinance = async (req, res, next) => {
  try {
    const riders = await User.find({ role: 'RIDER' }).sort({ createdAt: -1 });
    
    const ridersWithFinance = await Promise.all(
      riders.map(async (rider) => {
        const profile = await RiderProfile.findOne({ user: rider._id });
        const assignedOrders = await Order.countDocuments({ assignedRider: rider._id });
        
        return {
          ...rider.toObject(),
          codCollected: profile?.codCollected || 0,
          serviceCharges: profile?.serviceCharges || 0,
          serviceChargeStatus: profile?.serviceChargeStatus || 'unpaid',
          assignedOrders
        };
      })
    );

    res.json(ridersWithFinance);
  } catch (error) {
    next(error);
  }
};

exports.updateServiceChargeStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['paid', 'unpaid'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status. Must be "paid" or "unpaid"' });
    }

    let riderProfile = await RiderProfile.findOne({ user: id });
    
    if (!riderProfile) {
      // Create profile if it doesn't exist
      riderProfile = await RiderProfile.create({
        user: id,
        codCollected: 0,
        serviceCharges: 0,
        serviceChargeStatus: status
      });
    } else {
      if (status === 'paid') {
        riderProfile.serviceCharges = 0;
        riderProfile.serviceChargeStatus = 'paid';
      } else {
        riderProfile.serviceChargeStatus = 'unpaid';
      }
      await riderProfile.save();
    }

    res.json(riderProfile);
  } catch (error) {
    next(error);
  }
};

exports.getDailyReport = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({ message: 'Date parameter is required (YYYY-MM-DD)' });
    }

    const rider = await User.findById(id);
    if (!rider || rider.role !== 'RIDER') {
      return res.status(404).json({ message: 'Rider not found' });
    }

    const startDate = new Date(date);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(date);
    endDate.setHours(23, 59, 59, 999);

    const orders = await Order.find({
      assignedRider: id,
      createdAt: { $gte: startDate, $lte: endDate }
    }).populate('shipper', 'name');

    // Create Excel workbook
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Rider Daily Report');

    // Add headers
    worksheet.columns = [
      { header: 'Order ID', key: 'bookingId', width: 15 },
      { header: 'Consignee Name', key: 'consigneeName', width: 25 },
      { header: 'COD', key: 'codAmount', width: 15 },
      { header: 'Status', key: 'status', width: 20 },
      { header: 'City', key: 'destinationCity', width: 15 },
      { header: 'Service Charges', key: 'serviceCharges', width: 18 }
    ];

    // Add data
    orders.forEach(order => {
      worksheet.addRow({
        bookingId: order.bookingId,
        consigneeName: order.consigneeName,
        codAmount: order.amountCollected || order.codAmount || 0,
        status: order.status,
        destinationCity: order.destinationCity,
        serviceCharges: order.serviceCharges || 0
      });
    });

    // Add summary row
    const totalCod = orders.reduce((sum, o) => sum + Number(o.amountCollected || o.codAmount || 0), 0);
    const totalServiceCharges = orders.reduce((sum, o) => sum + Number(o.serviceCharges || 0), 0);
    
    worksheet.addRow({});
    worksheet.addRow({
      bookingId: 'TOTAL',
      consigneeName: '',
      codAmount: totalCod,
      status: '',
      destinationCity: '',
      serviceCharges: totalServiceCharges
    });

    // Style header row
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' }
    };

    // Set response headers
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=rider-${rider.name}-${date}.xlsx`);

    // Write to response
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    next(error);
  }
};

