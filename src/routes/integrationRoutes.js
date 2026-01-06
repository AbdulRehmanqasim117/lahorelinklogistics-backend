const express = require('express');
const router = express.Router();
const integrationController = require('../controllers/integrationController');
const integrationAuth = require('../middleware/integrationAuth');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const requireCommissionApproved = require('../middleware/requireCommissionApproved');
const shopifyIntegrationController = require('../controllers/shopifyIntegrationController');

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

// Shopify: connect store (shopDomain, access token, scopes)
router.post(
  '/shopify/connect',
  auth,
  requireRole('SHIPPER'),
  requireCommissionApproved,
  shopifyIntegrationController.connectStore,
);

router.get(
  '/shopify/store',
  auth,
  requireRole('SHIPPER'),
  requireCommissionApproved,
  shopifyIntegrationController.getConnectedStore,
);

// Shopify integrated orders (JWT, shipper-facing)
router.get(
  '/shopify/orders',
  auth,
  requireRole('SHIPPER'),
  requireCommissionApproved,
  shopifyIntegrationController.listShipperIntegratedOrders,
);

router.post(
  '/shopify/orders/:integratedOrderId/book',
  auth,
  requireRole('SHIPPER'),
  requireCommissionApproved,
  shopifyIntegrationController.bookIntegratedOrder,
);

router.post(
  '/shopify/orders/:integratedOrderId/unbook',
  auth,
  requireRole('SHIPPER'),
  requireCommissionApproved,
  shopifyIntegrationController.unbookIntegratedOrder,
);

module.exports = router;

