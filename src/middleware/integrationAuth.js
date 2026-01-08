const prisma = require('../prismaClient');
const { normalizeCommissionRule } = require('../utils/serviceChargeCalculator');

module.exports = async function integrationAuth(req, res, next) {
  try {
    let apiKey =
      req.header('X-LahoreLink-Integration-Key') ||
      req.header('x-lahorelink-integration-key');

    // Also check query parameter (for webhooks that can't send custom headers)
    if (!apiKey && req.query.key) {
      apiKey = req.query.key;
    }

    if (!apiKey) {
      console.log('[integrationAuth] Missing integration key');
      return res.status(401).json({ message: 'Missing integration key' });
    }

    console.log('[integrationAuth] Checking API key:', apiKey.slice(0, 8) + '...');

    const config = await prisma.integrationConfig.findUnique({
      where: { apiKey },
      include: { shipper: true },
    });

    if (!config) {
      console.log('[integrationAuth] Invalid integration key');
      return res.status(401).json({ message: 'Invalid integration key' });
    }

    if (!config.enabled) {
      console.log('[integrationAuth] Integration disabled for shipper:', config.shipperId);
      return res.status(403).json({ message: 'Integration disabled' });
    }

    const providerParam = String(req.params.provider || '').toUpperCase();
    const providers = Array.isArray(config.providers) ? config.providers : [];
    const providerCfg = providers.find(
      (p) => String(p.provider || '').toUpperCase() === providerParam,
    );

    if (!providerCfg || !providerCfg.enabled) {
      console.log(
        '[integrationAuth] Provider not enabled:',
        providerParam,
        'Config:',
        providerCfg,
      );
      return res.status(403).json({ message: 'Provider disabled' });
    }

    console.log(
      '[integrationAuth] Auth passed for provider:',
      providerParam,
      'shipper:',
      config.shipperId,
    );

    const commissionCfg = await prisma.commissionConfig.findUnique({
      where: { shipperId: config.shipperId },
      include: { weightBrackets: true },
    });

    const hasRule = !!normalizeCommissionRule(commissionCfg || null);

    if (!hasRule) {
      console.log(
        '[integrationAuth] Shipper portal inactive (commission rule not configured), blocking integration order creation:',
        config.shipperId,
      );
      return res.status(403).json({
        code: 'PORTAL_INACTIVE',
        message:
          'Your account is under configuration. Please wait for management to set your commission rule.',
      });
    }

    req.integration = {
      shipperId: config.shipperId,
      config: {
        shipperId: config.shipperId,
        apiKey: config.apiKey,
        enabled: config.enabled,
        providers,
      },
      providerConfig: providerCfg,
    };

    next();
  } catch (e) {
    console.error('[integrationAuth] Error:', e);
    next(e);
  }
};

