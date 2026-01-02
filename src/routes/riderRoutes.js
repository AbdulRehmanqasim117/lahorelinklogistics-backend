const express = require('express');
const router = express.Router();
const riderController = require('../controllers/riderController');
const riderFinanceController = require('../controllers/riderFinanceController');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const requireRiderCommissionConfigured = require('../middleware/requireRiderCommissionConfigured');

router.use(auth);

// Rider self-finance (only their own assigned orders)
router.get(
  '/finance/me',
  requireRole('RIDER'),
  requireRiderCommissionConfigured,
  riderFinanceController.getMyFinance,
);

// DISABLED: Rider self-assign via QR scanner (CEO-controlled assignment only)
// router.post('/scan-assign', requireRole('RIDER'), riderController.scanAssign);

// Manager/CEO rider finance tools
router.get('/finance', requireRole('CEO', 'MANAGER'), riderController.getRidersWithFinance);
router.get('/:id/settlements', requireRole('CEO', 'MANAGER'), riderFinanceController.getRiderSettlementsAdmin);
router.patch('/:id/service-charges-status', requireRole('CEO', 'MANAGER'), riderController.updateServiceChargeStatus);
router.get('/:id/daily-report', requireRole('CEO', 'MANAGER'), riderController.getDailyReport);

module.exports = router;

