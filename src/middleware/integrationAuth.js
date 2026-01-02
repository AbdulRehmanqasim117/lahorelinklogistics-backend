const IntegrationConfig = require('../models/IntegrationConfig');
const CommissionConfig = require('../models/CommissionConfig');

module.exports = async function integrationAuth(req, res, next) {
  try {
    let apiKey = req.header('X-LahoreLink-Integration-Key') || req.header('x-lahorelink-integration-key');
    
    // Also check query parameter (for webhooks that can't send custom headers)
    if (!apiKey && req.query.key) {
      apiKey = req.query.key;
    }
    
    if (!apiKey) {
      console.log('[integrationAuth] Missing integration key');
      return res.status(401).json({ message: 'Missing integration key' });
    }

    console.log('[integrationAuth] Checking API key:', apiKey.slice(0, 8) + '...');
    
    const config = await IntegrationConfig.findOne({ apiKey }).populate('shipper').lean();
    
    if (!config) {
      console.log('[integrationAuth] Invalid integration key');
      return res.status(401).json({ message: 'Invalid integration key' });
    }

    if (!config.enabled) {
      console.log('[integrationAuth] Integration disabled for shipper:', config.shipper?._id);
      return res.status(403).json({ message: 'Integration disabled' });
    }

    const providerParam = String(req.params.provider || '').toUpperCase();
    const providerCfg = (config.providers || []).find(p => String(p.provider || '').toUpperCase() === providerParam);
    
    if (!providerCfg || !providerCfg.enabled) {
      console.log('[integrationAuth] Provider not enabled:', providerParam, 'Config:', providerCfg);
      return res.status(403).json({ message: 'Provider disabled' });
    }

    console.log('[integrationAuth] Auth passed for provider:', providerParam, 'shipper:', config.shipper?._id);

    const shipperId = String(config.shipper?._id || config.shipper);
    const cfg = await CommissionConfig.findOne({ shipper: shipperId })
      .select('weightBrackets')
      .lean();

    const hasWeightBrackets =
      cfg && Array.isArray(cfg.weightBrackets) && cfg.weightBrackets.length > 0;

    if (!hasWeightBrackets) {
      console.log('[integrationAuth] Shipper portal inactive (weight brackets not configured), blocking integration order creation:', shipperId);
      return res.status(403).json({
        code: 'PORTAL_INACTIVE',
        message: 'Your account is under configuration. Please wait for management to set your weight brackets.'
      });
    }
    
    req.integration = { 
      shipperId: shipperId, 
      config: config,
      providerConfig: providerCfg 
    };
    next();
  } catch (e) {
    console.error('[integrationAuth] Error:', e);
    next(e);
  }
};

