const { Router } = require('express');
const { authenticateUser }  = require('../middleware/auth');
const { getPasses }         = require('../controllers/referralController');

const router = Router();

// Stub for unimplemented routes — replaced one by one via TDD
const notImplemented = (req, res) => {
  res.status(501).json({
    success: false,
    error: 'Not implemented',
    message: 'This endpoint is not yet implemented',
  });
};

router.get('/passes',      authenticateUser, getPasses);
router.get('/eligibility', notImplemented);
router.post('/redeem',     notImplemented);
router.get('/stats',       notImplemented);

module.exports = router;
