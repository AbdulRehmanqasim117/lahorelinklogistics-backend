const express = require('express');
const router = express.Router();

const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const requireCommissionApproved = require('../middleware/requireCommissionApproved');
const shipperFinanceController = require('../controllers/shipperFinanceController');

router.use(auth, requireRole('SHIPPER'), requireCommissionApproved);

router.get('/summary', shipperFinanceController.getMyFinanceSummary);
router.get('/ledger', shipperFinanceController.getMyFinanceLedger);

module.exports = router;
