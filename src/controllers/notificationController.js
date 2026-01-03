const prisma = require('../prismaClient');

// Create a pickup request notification for a shipper
exports.createPickupRequest = async (req, res, next) => {
  try {
    const { shipperId, message } = req.body;

    if (!shipperId) {
      return res.status(400).json({ message: 'Shipper ID is required' });
    }

    const shipperIdNum = Number(shipperId);
    if (!Number.isInteger(shipperIdNum) || shipperIdNum <= 0) {
      return res.status(400).json({ message: 'Invalid shipper ID' });
    }

    // Count pending parcels for this shipper
    const pendingParcels = await prisma.order.count({
      where: {
        shipperId: shipperIdNum,
        status: { in: ['CREATED', 'ASSIGNED'] },
      },
    });

    const notification = await prisma.notification.create({
      data: {
        type: 'PICKUP_REQUEST',
        shipperId: shipperIdNum,
        message: message || 'Pickup required',
        totalPendingParcels: pendingParcels,
      },
      include: {
        shipper: { select: { name: true, email: true } },
      },
    });

    res.status(201).json(notification);
  } catch (error) {
    next(error);
  }
};

// List notifications for the current user (CEO/MANAGER/SHIPPER)
exports.getNotifications = async (req, res, next) => {
  try {
    const { role, id } = req.user;

    let where = {};
    if (role === 'CEO' || role === 'MANAGER') {
      // CEO and Manager see unread pickup requests
      where = { type: 'PICKUP_REQUEST', read: false };
    } else if (role === 'SHIPPER') {
      // Shippers see their own notifications
      where = { shipperId: id };
    } else {
      return res.json([]);
    }

    const notifications = await prisma.notification.findMany({
      where,
      include: {
        shipper: { select: { name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    res.json(notifications);
  } catch (error) {
    next(error);
  }
};

// Mark a notification as read
exports.markAsRead = async (req, res, next) => {
  try {
    const { id } = req.params;

    const notifId = Number(id);
    if (!Number.isInteger(notifId) || notifId <= 0) {
      return res.status(400).json({ message: 'Invalid notification id' });
    }

    const notification = await prisma.notification.update({
      where: { id: notifId },
      data: { read: true, readAt: new Date() },
    });

    if (!notification) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    res.json(notification);
  } catch (error) {
    next(error);
  }
};

