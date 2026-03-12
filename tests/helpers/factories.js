/**
 * Test data factory functions
 *
 * Used by all integration and database tests to create consistent, reusable
 * test data. All factories insert directly via SQL and return the created row.
 *
 * See TDD_Workflow.md for usage patterns.
 */

const jwt  = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../../src/config/database');

const JWT_SECRET = process.env.JWT_SECRET || 'test_secret';

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/**
 * Insert a user row and return it.
 * The trigger_normalize_email trigger auto-populates email_normalized.
 *
 * @param {Object} overrides - Optional field overrides
 * @returns {Promise<Object>} Inserted user row
 */
async function createUser(overrides = {}) {
  const id    = overrides.id    || uuidv4();
  const email = overrides.email || `test-${id}@example.com`;

  const result = await pool.query(
    `INSERT INTO users (id, email, password_hash)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [id, email, 'hashed_password_for_testing']
  );
  return result.rows[0];
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

/**
 * Insert a subscription row and return it.
 * For active non-trial subscriptions, trigger_generate_passes fires and
 * creates 3 PLACEHOLDER_ passes — use createValidPass() to get real JWT tokens.
 *
 * @param {string} userId
 * @param {Object} overrides - Optional field overrides
 * @param {string} [overrides.tier='digital']
 * @param {string} [overrides.status='active']
 * @param {boolean} [overrides.isTrial=false]
 * @param {string} [overrides.trialEndExpr] - SQL expression for trial_end_date
 * @returns {Promise<Object>} Inserted subscription row
 */
async function createSubscription(userId, overrides = {}) {
  const isTrial      = overrides.isTrial ?? false;
  const trialEndExpr = isTrial
    ? (overrides.trialEndExpr || "NOW() + INTERVAL '7 days'")
    : 'NULL';

  // Allow callers to set historical dates via SQL expressions so cooldown
  // tests can place subscriptions precisely in the past without JS date math.
  const startExpr = overrides.startExpr || 'NOW()';
  const endExpr   = overrides.endExpr   || 'NULL';

  const result = await pool.query(
    `INSERT INTO subscriptions
       (user_id, tier, status, is_trial, trial_end_date, start_date, end_date)
     VALUES ($1, $2, $3, $4, ${trialEndExpr}, ${startExpr}, ${endExpr})
     RETURNING *`,
    [
      userId,
      overrides.tier   || 'digital',
      overrides.status || 'active',
      isTrial,
    ]
  );
  return result.rows[0];
}

// ---------------------------------------------------------------------------
// Combined helpers
// ---------------------------------------------------------------------------

/**
 * Create a user + active paid subscription together.
 *
 * @param {Object} overrides - Forwarded to createUser and createSubscription
 * @returns {Promise<{user: Object, subscription: Object}>}
 */
async function createUserWithSubscription(overrides = {}) {
  const user         = await createUser(overrides);
  const subscription = await createSubscription(user.id, overrides);
  return { user, subscription };
}

/**
 * Create a user + active subscription, replace the trigger-generated
 * PLACEHOLDER_ tokens with real signed JWTs, and return the first pass.
 *
 * This is the factory to use when a test needs a valid, redeemable token.
 *
 * @returns {Promise<Object>} First referral_pass row with a real JWT token
 */
async function createValidPass() {
  const { user, subscription } = await createUserWithSubscription();

  // Trigger has already created 3 PLACEHOLDER_ passes.
  // Replace each with a properly signed JWT (matching the JWT payload spec
  // in docs/database/schema.md).
  const passes = await pool.query(
    `SELECT id, user_id FROM referral_passes
     WHERE subscription_id = $1 AND token LIKE 'PLACEHOLDER_%'`,
    [subscription.id]
  );

  for (const pass of passes.rows) {
    const token = jwt.sign(
      { passId: pass.id, referrerId: pass.user_id, type: 'referral_pass' },
      JWT_SECRET,
      { expiresIn: '90d' }
    );
    await pool.query(
      'UPDATE referral_passes SET token = $1 WHERE id = $2',
      [token, pass.id]
    );
  }

  // Return the first pass with the real token
  const result = await pool.query(
    `SELECT * FROM referral_passes
     WHERE subscription_id = $1
     ORDER BY created_at ASC
     LIMIT 1`,
    [subscription.id]
  );
  return result.rows[0];
}

/**
 * Create a user with no subscriptions — eligible to redeem a referral pass.
 *
 * @param {Object} overrides - Forwarded to createUser
 * @returns {Promise<Object>} User row
 */
async function createEligibleUser(overrides = {}) {
  return createUser(overrides);
}

/**
 * Create a user with an active paid subscription — ineligible for a trial.
 *
 * @param {Object} overrides - Forwarded to createUser/createSubscription
 * @returns {Promise<Object>} User row
 */
async function createIneligibleUser(overrides = {}) {
  const { user } = await createUserWithSubscription(overrides);
  return user;
}

// ---------------------------------------------------------------------------
// Database lifecycle
// ---------------------------------------------------------------------------

/**
 * Delete all test data in reverse FK-safe order.
 * Call in beforeEach / afterAll to keep tests isolated.
 */
async function cleanDatabase() {
  await pool.query('DELETE FROM subscription_history');
  await pool.query('DELETE FROM referral_passes');
  await pool.query('DELETE FROM subscriptions');
  await pool.query('DELETE FROM users');
}

/**
 * Alias for cleanDatabase — use in beforeAll when the DB may have stale data.
 */
async function setupTestDatabase() {
  await cleanDatabase();
}

module.exports = {
  createUser,
  createSubscription,
  createUserWithSubscription,
  createValidPass,
  createEligibleUser,
  createIneligibleUser,
  cleanDatabase,
  setupTestDatabase,
};
