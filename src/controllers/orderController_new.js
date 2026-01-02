const Order = require('../models/Order');
const CommissionConfig = require('../models/CommissionConfig');
const FinancialTransaction = require('../models/FinancialTransaction');
const RiderProfile = require('../models/RiderProfile');
const generateBookingId = require('../config/bookingId');
const generateTrackingId = require('../config/trackingId');
const QRCode = require('qrcode');

// ... [Previous controller functions remain the same] ...

/**
 * Book an integrated order (change from UNBOOKED to BOOKED)
 */
const bookOrder = async (req, res, next) => {
  try {
    const { id } = req.params;
    
    // Find the order
    const order = await Order.findById(id);
    
    // Check if order exists
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }
    
    // Check if user is the owner of the order
    if (order.shipper.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized to book this order' });
    }
    
    // Check if order is integrated and unbooked
    if (!order.isIntegrated || order.bookingState !== 'UNBOOKED') {
      return res.status(400).json({ 
        message: 'Only unbooked integrated orders can be booked' 
      });
    }
    
    // Update the booking state
    order.bookingState = 'BOOKED';
    order.statusHistory.push({
      status: order.status,
      updatedBy: req.user.id,
      note: 'Order booked by shipper'
    });
    
    const updatedOrder = await order.save();
    
    res.json(updatedOrder);
  } catch (error) {
    next(error);
  }
};

// Export all controller functions
module.exports = {
  createOrder: exports.createOrder,
  getOrders: exports.getOrders,
  getManagerOverview: exports.getManagerOverview,
  getOrderById: exports.getOrderById,
  assignRider: exports.assignRider,
  updateStatus: exports.updateStatus,
  createFinancialTransaction: exports.createFinancialTransaction,
  updateRiderFinance: exports.updateRiderFinance,
  getLabel: exports.getLabel,
  getLabels: exports.getLabels,
  printLabelsHtml: exports.printLabelsHtml,
  bookOrder  // Add the new function to exports
};
