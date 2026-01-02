const express = require('express');
const router = express.Router();
const integrationController = require('../controllers/integrationController');
const integrationAuth = require('../middleware/integrationAuth');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const requireCommissionApproved = require('../middleware/requireCommissionApproved');

// External systems (API key based)
router.post('/:provider/orders', integrationAuth, integrationController.createFromProvider);

// Shipper-managed config (JWT)
router.get(
  '/shipper/me',
  auth,
  requireRole('SHIPPER'),
  requireCommissionApproved,
  integrationController.getMyIntegration,
);
router.put(
  '/shipper/me',
  auth,
  requireRole('SHIPPER'),
  requireCommissionApproved,
  integrationController.updateMyIntegration,
);
router.post(
  '/shipper/me/regenerate-key',
  auth,
  requireRole('SHIPPER'),
  requireCommissionApproved,
  integrationController.regenerateKey,
);

module.exports = router;

