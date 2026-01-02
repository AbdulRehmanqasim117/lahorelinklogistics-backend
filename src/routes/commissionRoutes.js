const express = require('express');
const router = express.Router();
const commissionController = require('../controllers/commissionController');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');

// CEO and Manager
router.use(auth, requireRole('CEO', 'MANAGER'));

router.get('/', commissionController.getConfigs);
router.post('/', commissionController.upsertConfig);
router.get('/rider', commissionController.getRiderConfigs);
router.post('/rider', commissionController.upsertRiderConfig);
router.get('/:shipperId', commissionController.getConfigByShipper);
router.put('/:shipperId', commissionController.putConfigByShipper);

module.exports = router;
