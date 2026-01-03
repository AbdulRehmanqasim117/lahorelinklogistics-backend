// Legacy Mongoose models replaced by Prisma for dashboard stats
// const Order = require('../models/Order');
// const User = require('../models/User');
const prisma = require('../prismaClient');

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

    const visibilityWhere = {
      OR: [
        { isIntegrated: false },
        { isIntegrated: true, bookingState: 'BOOKED' },
      ],
    };

    const orders = await prisma.order.findMany({
      where: {
        createdAt: { gte: startDate, lte: endDate },
        ...visibilityWhere,
      },
      include: {
        shipper: { select: { id: true, name: true, email: true } },
        assignedRider: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const totalOrders = orders.length;
    const completedOrders = orders.filter((o) => o.status === 'DELIVERED').length;
    const pendingOrders = orders.filter((o) => ['CREATED', 'ASSIGNED'].includes(o.status)).length;
    const assignedOrders = orders.filter(
      (o) => o.assignedRiderId && ['ASSIGNED', 'OUT_FOR_DELIVERY'].includes(o.status),
    ).length;
    const unassignedOrders = orders.filter(
      (o) => !o.assignedRiderId || o.status === 'CREATED',
    ).length;

    const totalCod = orders
      .filter((o) => o.status === 'DELIVERED')
      .reduce(
        (sum, o) => sum + Number(o.amountCollected ?? o.codAmount ?? 0),
        0,
      );

    const totalServiceCharges = orders
      .filter((o) => o.status === 'DELIVERED')
      .reduce((sum, o) => sum + Number(o.serviceCharges ?? 0), 0);

    const warehouseOrdersCount = await prisma.order.count({
      where: {
        status: 'AT_LLL_WAREHOUSE',
        ...visibilityWhere,
      },
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
        warehouseOrdersCount,
      },
      orders: orders.slice(0, 50),
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

    const visibilityWhere = {
      OR: [
        { isIntegrated: false },
        { isIntegrated: true, bookingState: 'BOOKED' },
      ],
    };

    const orders = await prisma.order.findMany({
      where: {
        createdAt: { gte: startDate, lte: endDate },
        ...visibilityWhere,
      },
      include: {
        shipper: { select: { id: true, name: true, email: true } },
        assignedRider: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const totalOrders = orders.length;
    const completedOrders = orders.filter((o) => o.status === 'DELIVERED').length;
    const pendingOrders = orders.filter((o) => ['CREATED', 'ASSIGNED'].includes(o.status)).length;
    const assignedOrders = orders.filter(
      (o) => o.assignedRiderId && ['ASSIGNED', 'OUT_FOR_DELIVERY'].includes(o.status),
    ).length;
    const unassignedOrders = orders.filter(
      (o) => !o.assignedRiderId || o.status === 'CREATED',
    ).length;

    const totalCod = orders
      .filter((o) => o.status === 'DELIVERED')
      .reduce(
        (sum, o) => sum + Number(o.amountCollected ?? o.codAmount ?? 0),
        0,
      );

    const totalServiceCharges = orders
      .filter((o) => o.status === 'DELIVERED')
      .reduce((sum, o) => sum + Number(o.serviceCharges ?? 0), 0);

    const [totalShippers, totalRiders, warehouseOrdersCount] = await Promise.all([
      prisma.user.count({ where: { role: 'SHIPPER' } }),
      prisma.user.count({ where: { role: 'RIDER' } }),
      prisma.order.count({
        where: {
          status: 'AT_LLL_WAREHOUSE',
          ...visibilityWhere,
        },
      }),
    ]);

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
        warehouseOrdersCount,
      },
      orders: orders.slice(0, 50),
    });
  } catch (error) {
    next(error);
  }
};

