/**
 * ReferralService
 *
 * All referral business logic: pass retrieval, eligibility, redemption,
 * and stats. Controllers must not query the database directly — only call
 * methods here.
 *
 * See docs/api/endpoints.md for the full API contract.
 */

const { pool } = require('../config/database');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

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

module.exports = { getUserPasses };
