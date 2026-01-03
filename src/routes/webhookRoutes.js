const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { handleShopifyWebhook } = require('../controllers/shopifyWebhookController');

const shopifyWebhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.SHOPIFY_WEBHOOK_RATE_LIMIT_PER_MINUTE || 120),
  standardHeaders: true,
  legacyHeaders: false,
});

// Shopify webhooks require the raw request body for HMAC verification, so we
// use express.raw() here instead of the global JSON body parser.
router.post(
  '/shopify',
  shopifyWebhookLimiter,
  express.raw({ type: 'application/json' }),
  handleShopifyWebhook,
);

module.exports = router;
