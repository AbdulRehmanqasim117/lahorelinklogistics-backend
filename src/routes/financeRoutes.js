const express = require('express');
const router = express.Router();
const financeController = require('../controllers/financeController');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');

// Rider self-summary (accessible to RIDER)
router.get('/summary/rider/me', auth, requireRole('RIDER'), financeController.getMyRiderSummary);
router.get('/summary/shipper/me', auth, requireRole('SHIPPER'), financeController.getMyShipperSummary);

// Manager/CEO only
router.use(auth, requireRole('CEO', 'MANAGER'));

router.get('/summary/shipper', financeController.getShipperSummary);
router.get('/summary/rider', financeController.getRiderSummary);
router.get('/company/summary', financeController.getCompanyFinanceSummary);
router.get('/company/ledger', financeController.getCompanyLedger);
router.post('/company/close-month', financeController.closeCurrentFinanceMonth);
router.patch('/transactions/:id/settle', financeController.settleTransaction);
// Allow authenticated; controller enforces role-based access to specific transaction
router.get('/transactions/order/:orderId', auth, financeController.getTransactionByOrder);

module.exports = router;
