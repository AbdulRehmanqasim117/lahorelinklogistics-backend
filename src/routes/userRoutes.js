const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');

router.get('/me', auth, userController.getMe);

// CEO only endpoints
router.get('/', auth, requireRole('CEO'), userController.getUsers);
router.post('/', auth, requireRole('CEO'), userController.createUser);
router.patch('/:id/status', auth, requireRole('CEO', 'MANAGER'), userController.updateUserStatus);
router.post('/:id/reset-password', auth, requireRole('CEO', 'MANAGER'), userController.resetPassword);

// CEO or MANAGER: list riders
router.get('/riders', auth, requireRole('CEO', 'MANAGER'), userController.getRiders);

// CEO only: list managers
router.get('/managers', auth, requireRole('CEO'), userController.getManagers);

// CEO or MANAGER: list riders with assigned active order counts
router.get(
  '/riders/assigned-counts',
  auth,
  requireRole('CEO', 'MANAGER'),
  userController.getRidersAssignedCounts,
);

// CEO or MANAGER: list shippers
router.get('/shippers', auth, requireRole('CEO', 'MANAGER'), userController.getShippers);

// CEO or MANAGER: approve/pending shipper commission
router.patch(
  '/shippers/:id/commission',
  auth,
  requireRole('CEO', 'MANAGER'),
  userController.setShipperCommissionApproval,
);

module.exports = router;
