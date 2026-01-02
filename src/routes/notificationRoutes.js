const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const requireCommissionApproved = require('../middleware/requireCommissionApproved');

router.use(auth);
router.use(requireCommissionApproved);

router.post(
  '/pickup-request',
  requireRole('SHIPPER'),
  requireCommissionApproved,
  notificationController.createPickupRequest,
);
router.get('/', notificationController.getNotifications);
router.patch('/:id/mark-read', notificationController.markAsRead);

module.exports = router;

