/**
 * Database schema tests: CHECK constraints and structural integrity
 *
 * Spec: docs/database/schema.md
 */

const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     process.env.DB_PORT     || 5432,
  database: process.env.DB_NAME     || 'atlantic_referral_test',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

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

async function createActiveSubscription(userId) {
  const result = await pool.query(
    `INSERT INTO subscriptions (user_id, tier, status, is_trial)
     VALUES ($1, 'digital', 'active', FALSE)
     RETURNING *`,
    [userId]
  );
  return result.rows[0];
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

async function cleanDatabase() {
  await pool.query('DELETE FROM subscription_history');
  await pool.query('DELETE FROM referral_passes');
  await pool.query('DELETE FROM subscriptions');
  await pool.query('DELETE FROM users');
}

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await cleanDatabase();
  await pool.end();
});

// ===========================================================================
// subscriptions — valid_trial_dates CHECK constraint
// trial_end_date must be set iff is_trial = TRUE
// ===========================================================================

describe('subscriptions CHECK: valid_trial_dates', () => {
  it('accepts a paid subscription with no trial_end_date', async () => {
    const user = await createUser();

    await expect(
      pool.query(
        `INSERT INTO subscriptions (user_id, tier, status, is_trial, trial_end_date)
         VALUES ($1, 'digital', 'active', FALSE, NULL)`,
        [user.id]
      )
    ).resolves.toBeDefined();
  });

  it('accepts a trial subscription with trial_end_date set', async () => {
    const user = await createUser();

    await expect(
      pool.query(
        `INSERT INTO subscriptions (user_id, tier, status, is_trial, trial_end_date)
         VALUES ($1, 'digital', 'trial', TRUE, NOW() + INTERVAL '7 days')`,
        [user.id]
      )
    ).resolves.toBeDefined();
  });

  it('rejects a trial subscription missing trial_end_date', async () => {
    const user = await createUser();

    await expect(
      pool.query(
        `INSERT INTO subscriptions (user_id, tier, status, is_trial, trial_end_date)
         VALUES ($1, 'digital', 'trial', TRUE, NULL)`,
        [user.id]
      )
    ).rejects.toThrow(/valid_trial_dates/);
  });

  it('rejects a paid subscription with trial_end_date set', async () => {
    const user = await createUser();

    await expect(
      pool.query(
        `INSERT INTO subscriptions (user_id, tier, status, is_trial, trial_end_date)
         VALUES ($1, 'digital', 'active', FALSE, NOW() + INTERVAL '7 days')`,
        [user.id]
      )
    ).rejects.toThrow(/valid_trial_dates/);
  });
});

// ===========================================================================
// referral_passes — valid_redemption CHECK constraint
// Redemption fields (redeemed_by_user_id, redeemed_at) must all be set together
// ===========================================================================

describe('referral_passes CHECK: valid_redemption', () => {
  async function insertPass(overrides = {}) {
    const user = await createUser();
    const sub  = await createActiveSubscription(user.id);

    // Get a trigger-created pass to use as a base
    const passResult = await pool.query(
      'SELECT id FROM referral_passes WHERE subscription_id = $1 LIMIT 1',
      [sub.id]
    );
    const passId = passResult.rows[0].id;

    return { user, sub, passId };
  }

  it('accepts a valid unredeemed state (all redemption fields NULL)', async () => {
    const { passId } = await insertPass();

    // Default state after trigger: is_redeemed=FALSE, redeemed_by=NULL, redeemed_at=NULL
    const result = await pool.query(
      'SELECT is_redeemed, redeemed_by_user_id, redeemed_at FROM referral_passes WHERE id = $1',
      [passId]
    );

    expect(result.rows[0].is_redeemed).toBe(false);
    expect(result.rows[0].redeemed_by_user_id).toBeNull();
    expect(result.rows[0].redeemed_at).toBeNull();
  });

  it('accepts a valid redeemed state (all redemption fields set)', async () => {
    const { passId } = await insertPass();
    const redeemer   = await createUser();

    await expect(
      pool.query(
        `UPDATE referral_passes
         SET is_redeemed = TRUE, redeemed_by_user_id = $1, redeemed_at = NOW()
         WHERE id = $2`,
        [redeemer.id, passId]
      )
    ).resolves.toBeDefined();
  });

  it('rejects is_redeemed=TRUE with NULL redeemed_by_user_id', async () => {
    const { passId } = await insertPass();

    await expect(
      pool.query(
        `UPDATE referral_passes
         SET is_redeemed = TRUE, redeemed_by_user_id = NULL, redeemed_at = NOW()
         WHERE id = $1`,
        [passId]
      )
    ).rejects.toThrow(/valid_redemption/);
  });

  it('rejects is_redeemed=TRUE with NULL redeemed_at', async () => {
    const { passId } = await insertPass();
    const redeemer   = await createUser();

    await expect(
      pool.query(
        `UPDATE referral_passes
         SET is_redeemed = TRUE, redeemed_by_user_id = $1, redeemed_at = NULL
         WHERE id = $2`,
        [redeemer.id, passId]
      )
    ).rejects.toThrow(/valid_redemption/);
  });
});

// ===========================================================================
// users — uniqueness constraints
// ===========================================================================

describe('users uniqueness constraints', () => {
  it('rejects duplicate email', async () => {
    await createUser({ email: 'dupe@example.com' });

    await expect(
      pool.query(
        `INSERT INTO users (email, password_hash) VALUES ($1, $2)`,
        ['dupe@example.com', 'hash']
      )
    ).rejects.toThrow(/unique/i);
  });
});

// ===========================================================================
// Foreign key cascades
// ===========================================================================

describe('foreign key cascades', () => {
  it('deleting a user cascades to their subscriptions and passes', async () => {
    const user = await createUser();
    const sub  = await createActiveSubscription(user.id);

    // Verify passes exist
    const before = await pool.query(
      'SELECT COUNT(*) FROM referral_passes WHERE user_id = $1',
      [user.id]
    );
    expect(parseInt(before.rows[0].count)).toBe(3);

    // Delete user
    await pool.query('DELETE FROM users WHERE id = $1', [user.id]);

    // Subscription and passes should be gone
    const subCheck = await pool.query(
      'SELECT COUNT(*) FROM subscriptions WHERE id = $1',
      [sub.id]
    );
    const passCheck = await pool.query(
      'SELECT COUNT(*) FROM referral_passes WHERE user_id = $1',
      [user.id]
    );

    expect(parseInt(subCheck.rows[0].count)).toBe(0);
    expect(parseInt(passCheck.rows[0].count)).toBe(0);
  });
});
