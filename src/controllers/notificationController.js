const Notification = require('../models/Notification');
const Order = require('../models/Order');
const User = require('../models/User');

exports.createPickupRequest = async (req, res, next) => {
  try {
    const { shipperId, message } = req.body;
    
    if (!shipperId) {
      return res.status(400).json({ message: 'Shipper ID is required' });
    }

    // Count pending parcels
    const pendingParcels = await Order.countDocuments({
      shipper: shipperId,
      status: { $in: ['CREATED', 'ASSIGNED'] }
    });

    const notification = await Notification.create({
      type: 'PICKUP_REQUEST',
      shipper: shipperId,
      message: message || 'Pickup required',
      totalPendingParcels: pendingParcels
    });

    res.status(201).json(notification);
  } catch (error) {
    next(error);
  }
};

exports.getNotifications = async (req, res, next) => {
  try {
    const { role } = req.user;
    
    let query = {};
    if (role === 'CEO' || role === 'MANAGER') {
      // CEO and Manager see all pickup requests
      query = { type: 'PICKUP_REQUEST', read: false };
    } else if (role === 'SHIPPER') {
      // Shippers see their own notifications
      query = { shipper: req.user.id };
    } else {
      return res.json([]);
    }

    const notifications = await Notification.find(query)
      .populate('shipper', 'name email')
      .sort({ createdAt: -1 })
      .limit(50);

    res.json(notifications);
  } catch (error) {
    next(error);
  }
};

exports.markAsRead = async (req, res, next) => {
  try {
    const { id } = req.params;

    const notification = await Notification.findByIdAndUpdate(
      id,
      { read: true, readAt: new Date() },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    res.json(notification);
  } catch (error) {
    next(error);
  }
};

