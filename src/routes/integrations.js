const express = require('express');
const router = express.Router();
const integrationController = require('../controllers/integrationController');

// Accept JSON bodies
router.use(express.json({ limit: '1mb' }));

// POST /api/integrations/custom/orders
router.post('/custom/orders', integrationController.handleProviderOrder('custom'));

// POST /api/integrations/shopify/orders
router.post('/shopify/orders', integrationController.handleProviderOrder('shopify'));

// POST /api/integrations/woocommerce/orders
router.post('/woocommerce/orders', integrationController.handleProviderOrder('woocommerce'));

module.exports = router;
