const { Router } = require('express');
const { authenticateUser }  = require('../middleware/auth');
const { getPasses, getEligibility, redeemPass, getStats } = require('../controllers/referralController');

const router = Router();

router.get('/passes',      authenticateUser, getPasses);
router.get('/eligibility', authenticateUser, getEligibility);
router.post('/redeem',     authenticateUser, redeemPass);
router.get('/stats',       authenticateUser, getStats);

module.exports = router;
