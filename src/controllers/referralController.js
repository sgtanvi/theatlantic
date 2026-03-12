/**
 * Referral controller
 *
 * HTTP layer only: extract inputs, call the service, return the response.
 * No business logic or database queries here.
 *
 * See src/services/ReferralService.js for all logic.
 */

const ReferralService = require('../services/ReferralService');

/**
 * GET /api/referral/passes
 *
 * Returns all referral passes for the authenticated user.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function getPasses(req, res, next) {
  try {
    const data = await ReferralService.getUserPasses(req.user.id);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

module.exports = { getPasses };
