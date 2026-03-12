/**
 * Referral controller
 *
 * HTTP layer only: extract inputs, call the service, return the response.
 * No business logic or database queries here.
 *
 * See src/services/ReferralService.js for all logic.
 */

const ReferralService = require('../services/ReferralService');
const { ValidationError } = require('../utils/errors');

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

/**
 * GET /api/referral/eligibility
 *
 * Returns whether the authenticated user is eligible to receive a referral trial.
 * Always 200 — ineligibility is information, not an HTTP error.
 */
async function getEligibility(req, res, next) {
  try {
    const data = await ReferralService.checkEligibility(req.user.id);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/referral/redeem
 *
 * Redeems a referral pass token and creates a 7-day trial subscription.
 */
async function redeemPass(req, res, next) {
  try {
    const { token } = req.body;

    if (!token) {
      throw new ValidationError('Token is required');
    }

    const subscription = await ReferralService.redeemPass(token, req.user.id);
    res.status(201).json({
      success: true,
      message: '7-day trial activated successfully!',
      data: subscription,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/referral/stats
 *
 * Returns all-time referral stats for the authenticated user.
 */
async function getStats(req, res, next) {
  try {
    const data = await ReferralService.getStats(req.user.id);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

module.exports = { getPasses, getEligibility, redeemPass, getStats };
