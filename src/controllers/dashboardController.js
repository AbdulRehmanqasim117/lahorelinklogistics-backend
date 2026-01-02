const Order = require('../models/Order');
const User = require('../models/User');

exports.getManagerDashboard = async (req, res, next) => {
  try {
    const { period = 'today' } = req.query;
    
    let startDate = new Date();
    startDate.setHours(0, 0, 0, 0);
    let endDate = new Date();
    endDate.setHours(23, 59, 59, 999);

    if (period === '7days') {
      startDate.setDate(startDate.getDate() - 6);
    } else if (period === '15days') {
      startDate.setDate(startDate.getDate() - 14);
    } else if (period === 'month') {
      startDate.setDate(1);
    }

    const visibility = {
      $or: [
        { isIntegrated: { $ne: true } },
        { isIntegrated: true, bookingState: 'BOOKED' }
      ]
    };

    const orders = await Order.find({
      createdAt: { $gte: startDate, $lte: endDate },
      ...visibility
    }).populate('shipper', 'name email').populate('assignedRider', 'name');

    const totalOrders = orders.length;
    const completedOrders = orders.filter(o => o.status === 'DELIVERED').length;
    const pendingOrders = orders.filter(o => ['CREATED', 'ASSIGNED'].includes(o.status)).length;
    const assignedOrders = orders.filter(o => o.assignedRider && ['ASSIGNED', 'OUT_FOR_DELIVERY'].includes(o.status)).length;
    const unassignedOrders = orders.filter(o => !o.assignedRider || o.status === 'CREATED').length;

    const totalCod = orders
      .filter(o => o.status === 'DELIVERED')
      .reduce((sum, o) => sum + Number(o.amountCollected || o.codAmount || 0), 0);

    const totalServiceCharges = orders
      .filter(o => o.status === 'DELIVERED')
      .reduce((sum, o) => sum + Number(o.serviceCharges || 0), 0);

    // Count orders at LLL warehouse
    const warehouseOrdersCount = await Order.countDocuments({
      status: 'AT_LLL_WAREHOUSE',
      ...visibility
    });

    res.json({
      period,
      stats: {
        totalOrders,
        completedOrders,
        pendingOrders,
        assignedOrders,
        unassignedOrders,
        totalCod,
        totalServiceCharges,
        warehouseOrdersCount
      },
      orders: orders.slice(0, 50) // Return recent orders
    });
  } catch (error) {
    next(error);
  }
};

exports.getCeoDashboard = async (req, res, next) => {
  try {
    const { period = 'today' } = req.query;
    
    let startDate = new Date();
    startDate.setHours(0, 0, 0, 0);
    let endDate = new Date();
    endDate.setHours(23, 59, 59, 999);

    if (period === '7days') {
      startDate.setDate(startDate.getDate() - 6);
    } else if (period === '15days') {
      startDate.setDate(startDate.getDate() - 14);
    } else if (period === 'month') {
      startDate.setDate(1);
    }

    const visibility = {
      $or: [
        { isIntegrated: { $ne: true } },
        { isIntegrated: true, bookingState: 'BOOKED' }
      ]
    };

    const orders = await Order.find({
      createdAt: { $gte: startDate, $lte: endDate },
      ...visibility
    }).populate('shipper', 'name email').populate('assignedRider', 'name');

    const totalOrders = orders.length;
    const completedOrders = orders.filter(o => o.status === 'DELIVERED').length;
    const pendingOrders = orders.filter(o => ['CREATED', 'ASSIGNED'].includes(o.status)).length;
    const assignedOrders = orders.filter(o => o.assignedRider && ['ASSIGNED', 'OUT_FOR_DELIVERY'].includes(o.status)).length;
    const unassignedOrders = orders.filter(o => !o.assignedRider || o.status === 'CREATED').length;

    const totalCod = orders
      .filter(o => o.status === 'DELIVERED')
      .reduce((sum, o) => sum + Number(o.amountCollected || o.codAmount || 0), 0);

    const totalServiceCharges = orders
      .filter(o => o.status === 'DELIVERED')
      .reduce((sum, o) => sum + Number(o.serviceCharges || 0), 0);

    // Get user counts
    const totalShippers = await User.countDocuments({ role: 'SHIPPER' });
    const totalRiders = await User.countDocuments({ role: 'RIDER' });

    // Count orders at LLL warehouse
    const warehouseOrdersCount = await Order.countDocuments({
      status: 'AT_LLL_WAREHOUSE',
      ...visibility
    });

    res.json({
      period,
      stats: {
        totalOrders,
        completedOrders,
        pendingOrders,
        assignedOrders,
        unassignedOrders,
        totalCod,
        totalServiceCharges,
        totalShippers,
        totalRiders,
        warehouseOrdersCount
      },
      orders: orders.slice(0, 50) // Return recent orders
    });
  } catch (error) {
    next(error);
  }
};

