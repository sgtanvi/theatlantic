/**
 * ReferralService
 *
 * All referral business logic: pass retrieval, eligibility, redemption,
 * and stats. Controllers must not query the database directly — only call
 * methods here.
 *
 * See docs/api/endpoints.md for the full API contract.
 */

const jwt  = require('jsonwebtoken');
const { pool } = require('../config/database');
const { ValidationError, NotFoundError, ConflictError, GoneError } = require('../utils/errors');

const BASE_URL  = process.env.BASE_URL  || 'http://localhost:3000';
const JWT_SECRET = process.env.JWT_SECRET || 'test_secret';

// ---------------------------------------------------------------------------
// Query constants
// ---------------------------------------------------------------------------

/**
 * Returns all passes belonging to the user's active (non-trial) subscription,
 * with the redeemer's email joined in for display.
 *
 * Spec: docs/api/endpoints.md — GET /api/referral/passes (Example SQL query)
 */
const GET_USER_PASSES_QUERY = `
  SELECT rp.*, u_redeemed.email AS redeemed_by_email
  FROM referral_passes rp
  JOIN subscriptions s ON rp.subscription_id = s.id
  LEFT JOIN users u_redeemed ON rp.redeemed_by_user_id = u_redeemed.id
  WHERE rp.user_id = $1
    AND s.status = 'active'
  ORDER BY rp.created_at DESC
`;

// ---------------------------------------------------------------------------
// Eligibility query constants — mirror the PG is_user_eligible_for_trial() rules
// ---------------------------------------------------------------------------

const CHECK_ACTIVE_SUBSCRIPTION_QUERY = `
  SELECT COUNT(*) AS count FROM subscriptions
  WHERE user_id = $1 AND status = 'active'`;

const CHECK_RECENT_SUBSCRIPTION_QUERY = `
  SELECT COUNT(*) AS count FROM subscriptions
  WHERE user_id = $1
    AND end_date IS NOT NULL
    AND end_date > CURRENT_TIMESTAMP - INTERVAL '12 months'`;

const CHECK_RECENT_TRIAL_QUERY = `
  SELECT COUNT(*) AS count FROM subscriptions
  WHERE user_id = $1
    AND is_trial = TRUE
    AND start_date > CURRENT_TIMESTAMP - INTERVAL '24 months'`;

// ---------------------------------------------------------------------------
// Redeem query constants
// ---------------------------------------------------------------------------

const GET_PASS_BY_TOKEN_QUERY = `
  SELECT rp.*, s.status AS subscription_status, s.is_trial AS subscription_is_trial
  FROM referral_passes rp
  JOIN subscriptions s ON rp.subscription_id = s.id
  WHERE rp.token = $1
  FOR UPDATE`;

const CREATE_TRIAL_SUBSCRIPTION_QUERY = `
  INSERT INTO subscriptions (user_id, tier, status, is_trial, trial_end_date, start_date)
  VALUES ($1, 'digital', 'trial', TRUE, NOW() + INTERVAL '7 days', NOW())
  RETURNING id, tier, status, trial_end_date`;

// AND guard: rowCount=0 means the race was lost to a concurrent transaction
const MARK_PASS_REDEEMED_QUERY = `
  UPDATE referral_passes
  SET is_redeemed=TRUE, redeemed_by_user_id=$1, redeemed_at=NOW(), created_subscription_id=$2
  WHERE id=$3 AND is_redeemed=FALSE
  RETURNING id`;

const INSERT_SUBSCRIPTION_HISTORY_QUERY = `
  INSERT INTO subscription_history (subscription_id, user_id, new_status, reason)
  VALUES ($1, $2, 'trial', 'referral_redemption')`;

// ---------------------------------------------------------------------------
// Stats query constant
// ---------------------------------------------------------------------------

// No join to subscriptions — stats span all-time history, not just active subscription.
// COALESCE handles the null from json_agg FILTER when no redeemed passes exist.
// COUNT() returns bigint strings from the pg driver — use parseInt() on the way out.
const GET_STATS_QUERY = `
  SELECT
    COUNT(*) FILTER (WHERE is_redeemed = TRUE)  AS successful_referrals,
    COUNT(*) FILTER (WHERE is_redeemed = FALSE) AS pending_passes,
    COALESCE(
      json_agg(
        json_build_object('redeemed_at', rp.redeemed_at, 'recipient_email', u.email)
        ORDER BY rp.redeemed_at DESC
      ) FILTER (WHERE is_redeemed = TRUE),
      '[]'::json
    ) AS redemption_history
  FROM referral_passes rp
  LEFT JOIN users u ON rp.redeemed_by_user_id = u.id
  WHERE rp.user_id = $1`;

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/**
 * Transform a referral_passes DB row into the API response shape.
 *
 * @param {Object} row - Raw database row with redeemed_by_email joined in
 * @returns {Object} Formatted pass for API consumers
 */
function formatPass(row) {
  return {
    id:           row.id,
    token:        row.token,
    is_redeemed:  row.is_redeemed,
    redeemed_by:  row.redeemed_by_email || null,
    redeemed_at:  row.redeemed_at       || null,
    expires_at:   row.expires_at,
    // Null out the link once redeemed — sharing a used pass would confuse recipients
    shareable_link: row.is_redeemed
      ? null
      : `${BASE_URL}/referral/redeem?token=${row.token}`,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch all referral passes for a user and return them in the API envelope
 * format defined in docs/api/endpoints.md.
 *
 * @param {string} userId - UUID of the authenticated user
 * @returns {Promise<Object>} { total_passes, available_count, redeemed_count, passes }
 */
async function getUserPasses(userId) {
  const result = await pool.query(GET_USER_PASSES_QUERY, [userId]);

  const passes    = result.rows.map(formatPass);
  const available = passes.filter(p => !p.is_redeemed);
  const redeemed  = passes.filter(p =>  p.is_redeemed);

  return {
    total_passes:    passes.length,
    available_count: available.length,
    redeemed_count:  redeemed.length,
    passes,
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Run the three eligibility sub-queries using the provided query function.
 * Accepts a queryFn so it works both standalone (pool.query) and inside a
 * SERIALIZABLE transaction (client.query) — the latter ensures the eligibility
 * checks participate in the same snapshot as the rest of the redemption flow.
 *
 * @param {Function} queryFn - pool.query or client.query bound to a client
 * @param {string}   userId
 * @returns {Promise<{eligible: boolean, reason: string|null}>}
 */
async function runEligibilityChecks(queryFn, userId) {
  // Rule 1: no active subscription
  const activeResult = await queryFn(CHECK_ACTIVE_SUBSCRIPTION_QUERY, [userId]);
  if (parseInt(activeResult.rows[0].count, 10) > 0) {
    return { eligible: false, reason: 'User already has an active subscription' };
  }

  // Rule 2: no subscription ended within last 12 months (win-back window)
  const recentSubResult = await queryFn(CHECK_RECENT_SUBSCRIPTION_QUERY, [userId]);
  if (parseInt(recentSubResult.rows[0].count, 10) > 0) {
    return { eligible: false, reason: 'User had a subscription within the last 12 months' };
  }

  // Rule 3: no trial started within last 24 months (anti-cycling)
  const recentTrialResult = await queryFn(CHECK_RECENT_TRIAL_QUERY, [userId]);
  if (parseInt(recentTrialResult.rows[0].count, 10) > 0) {
    return { eligible: false, reason: 'User had a trial within the last 24 months' };
  }

  return { eligible: true, reason: null };
}

/**
 * Verify a referral pass JWT and return the decoded payload.
 * Throws before any DB work happens.
 *
 * @param {string} token
 * @returns {{ passId: string, referrerId: string, type: string }}
 * @throws {GoneError}       Token expired
 * @throws {ValidationError} Token invalid or wrong type
 */
function verifyPassToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'referral_pass') {
      throw new ValidationError('Invalid referral token');
    }
    return decoded;
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      throw new GoneError('Referral token has expired');
    }
    if (error instanceof ValidationError || error instanceof GoneError) throw error;
    throw new ValidationError('Invalid referral token');
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether a user is eligible to receive a referral trial.
 * Always resolves (never throws) — ineligibility is information, not an error.
 *
 * @param {string} userId
 * @returns {Promise<{eligible: boolean, reason: string|null}>}
 */
async function checkEligibility(userId) {
  return runEligibilityChecks(pool.query.bind(pool), userId);
}

/**
 * Redeem a referral pass and create a 7-day trial subscription.
 * Runs inside a SERIALIZABLE transaction with FOR UPDATE row lock to handle
 * concurrent redemption attempts safely.
 *
 * @param {string} token          - JWT referral token from the request body
 * @param {string} recipientUserId - UUID of the authenticated user redeeming
 * @returns {Promise<Object>} Created trial subscription row
 * @throws {GoneError}       JWT expired or pass expires_at in the past
 * @throws {ValidationError} Invalid token, self-redemption, or inactive referrer
 * @throws {NotFoundError}   Pass not found in DB
 * @throws {ConflictError}   Pass already redeemed or recipient ineligible
 *
 * See docs/api/endpoints.md POST /api/referral/redeem for full spec.
 * See docs/architecture/edge-cases.md for the 14 edge cases covered here.
 */
async function redeemPass(token, recipientUserId) {
  // Pre-transaction: verify JWT signature and expiry (no DB needed)
  const decoded = verifyPassToken(token);

  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');

    // 1. Fetch pass with row lock to block concurrent redemptions
    const passResult = await client.query(GET_PASS_BY_TOKEN_QUERY, [token]);
    if (passResult.rows.length === 0) {
      throw new NotFoundError('Referral pass not found');
    }
    const pass = passResult.rows[0];

    // 2. Check if already redeemed
    if (pass.is_redeemed) {
      throw new ConflictError('This pass has already been redeemed');
    }

    // 3. Check database-level expiry (separate from JWT expiry)
    if (new Date(pass.expires_at) < new Date()) {
      throw new GoneError('This referral pass has expired');
    }

    // 4. Referrer's subscription must be active and non-trial
    if (pass.subscription_status !== 'active' || pass.subscription_is_trial) {
      throw new ValidationError('Referrer no longer has an active subscription');
    }

    // 5. Self-redemption guard
    if (pass.user_id === recipientUserId) {
      throw new ValidationError('You cannot redeem your own referral pass');
    }

    // 6. Recipient eligibility (runs in the SERIALIZABLE snapshot)
    const eligibility = await runEligibilityChecks(client.query.bind(client), recipientUserId);
    if (!eligibility.eligible) {
      throw new ConflictError(eligibility.reason);
    }

    // 7. Create the trial subscription
    const subResult = await client.query(CREATE_TRIAL_SUBSCRIPTION_QUERY, [recipientUserId]);
    const subscription = subResult.rows[0];

    // 8. Mark pass as redeemed — the AND is_redeemed=FALSE guard catches any
    //    race that somehow slipped past the FOR UPDATE lock
    const markResult = await client.query(MARK_PASS_REDEEMED_QUERY, [
      recipientUserId,
      subscription.id,
      pass.id,
    ]);
    if (markResult.rowCount === 0) {
      throw new ConflictError('This pass has already been redeemed');
    }

    // 9. Audit log
    await client.query(INSERT_SUBSCRIPTION_HISTORY_QUERY, [subscription.id, recipientUserId]);

    await client.query('COMMIT');
    return subscription;

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Return all-time referral stats for a user.
 *
 * @param {string} userId
 * @returns {Promise<{successful_referrals: number, pending_passes: number, redemption_history: Array}>}
 */
async function getStats(userId) {
  const result = await pool.query(GET_STATS_QUERY, [userId]);
  const row = result.rows[0];
  return {
    successful_referrals: parseInt(row.successful_referrals, 10),
    pending_passes:       parseInt(row.pending_passes, 10),
    redemption_history:   row.redemption_history,
  };
}

module.exports = { getUserPasses, checkEligibility, redeemPass, getStats };
