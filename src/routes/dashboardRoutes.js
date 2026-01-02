const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboardController');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');

router.use(auth);

router.get('/manager', requireRole('MANAGER'), dashboardController.getManagerDashboard);
router.get('/ceo', requireRole('CEO'), dashboardController.getCeoDashboard);

module.exports = router;

