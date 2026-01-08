const express = require('express');
const router = express.Router();
const setupController = require('../controllers/setupController');

// One-time initial CEO setup (no auth, guarded by env flag + setup key header)
router.post('/ceo', setupController.createInitialCeo);

module.exports = router;
