/**
 * Database trigger tests: trigger_generate_passes and trigger_normalize_email
 *
 * Spec: docs/database/triggers.md
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

async function createSubscription(userId, overrides = {}) {
  const isTrial      = overrides.isTrial ?? false;
  const trialEndExpr = isTrial
    ? (overrides.trialEndExpr || "NOW() + INTERVAL '7 days'")
    : 'NULL';

  const result = await pool.query(
    `INSERT INTO subscriptions (user_id, tier, status, is_trial, trial_end_date)
     VALUES ($1, $2, $3, $4, ${trialEndExpr})
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
// trigger_generate_passes
// Fires AFTER INSERT OR UPDATE OF status ON subscriptions
// ===========================================================================

describe('trigger_generate_passes', () => {
  describe('on INSERT', () => {
    it('creates exactly 3 passes for an active paid subscription', async () => {
      const user = await createUser();
      const sub  = await createSubscription(user.id, { status: 'active', isTrial: false });

      const result = await pool.query(
        'SELECT * FROM referral_passes WHERE subscription_id = $1',
        [sub.id]
      );

      expect(result.rows.length).toBe(3);
    });

    it('does NOT create passes for a trial subscription', async () => {
      const user = await createUser();
      const sub  = await createSubscription(user.id, { status: 'trial', isTrial: true });

      const result = await pool.query(
        'SELECT * FROM referral_passes WHERE subscription_id = $1',
        [sub.id]
      );

      expect(result.rows.length).toBe(0);
    });

    it('does NOT create passes for a cancelled subscription', async () => {
      // cancelled subs are not active, should not get passes
      const user = await createUser();
      const sub  = await createSubscription(user.id, { status: 'cancelled', isTrial: false });

      const result = await pool.query(
        'SELECT * FROM referral_passes WHERE subscription_id = $1',
        [sub.id]
      );

      expect(result.rows.length).toBe(0);
    });

    it('passes are linked to correct subscription_id and user_id', async () => {
      const user = await createUser();
      const sub  = await createSubscription(user.id, { status: 'active', isTrial: false });

      const result = await pool.query(
        'SELECT * FROM referral_passes WHERE subscription_id = $1',
        [sub.id]
      );

      for (const pass of result.rows) {
        expect(pass.subscription_id).toBe(sub.id);
        expect(pass.user_id).toBe(user.id);
      }
    });

    it('passes start with PLACEHOLDER_ tokens', async () => {
      const user = await createUser();
      const sub  = await createSubscription(user.id, { status: 'active', isTrial: false });

      const result = await pool.query(
        'SELECT token FROM referral_passes WHERE subscription_id = $1',
        [sub.id]
      );

      for (const row of result.rows) {
        expect(row.token).toMatch(/^PLACEHOLDER_/);
      }
    });

    it('passes have expires_at set 90 days in the future', async () => {
      const user = await createUser();
      const sub  = await createSubscription(user.id, { status: 'active', isTrial: false });

      const result = await pool.query(
        'SELECT expires_at FROM referral_passes WHERE subscription_id = $1',
        [sub.id]
      );

      const now    = new Date();
      const in88d  = new Date(now.getTime() + 88 * 24 * 60 * 60 * 1000);
      const in92d  = new Date(now.getTime() + 92 * 24 * 60 * 60 * 1000);

      for (const row of result.rows) {
        const expiresAt = new Date(row.expires_at);
        expect(expiresAt.getTime()).toBeGreaterThan(in88d.getTime());
        expect(expiresAt.getTime()).toBeLessThan(in92d.getTime());
      }
    });

    it('passes start as not redeemed', async () => {
      const user = await createUser();
      const sub  = await createSubscription(user.id, { status: 'active', isTrial: false });

      const result = await pool.query(
        'SELECT is_redeemed FROM referral_passes WHERE subscription_id = $1',
        [sub.id]
      );

      for (const row of result.rows) {
        expect(row.is_redeemed).toBe(false);
      }
    });
  });

  describe('on UPDATE OF status', () => {
    it('creates 3 passes when a trial is converted to active paid', async () => {
      // Insert as trial (no passes created)
      const user = await createUser();
      const sub  = await createSubscription(user.id, { status: 'trial', isTrial: true });

      let passes = await pool.query(
        'SELECT * FROM referral_passes WHERE subscription_id = $1',
        [sub.id]
      );
      expect(passes.rows.length).toBe(0);

      // Convert to active paid
      await pool.query(
        `UPDATE subscriptions
         SET status = 'active', is_trial = FALSE, trial_end_date = NULL
         WHERE id = $1`,
        [sub.id]
      );

      passes = await pool.query(
        'SELECT * FROM referral_passes WHERE subscription_id = $1',
        [sub.id]
      );
      expect(passes.rows.length).toBe(3);
    });

    it('does NOT create duplicate passes when status is updated again', async () => {
      // Trigger is idempotent: NOT EXISTS guard prevents duplicates
      const user = await createUser();
      const sub  = await createSubscription(user.id, { status: 'active', isTrial: false });

      // Trigger a second status update that still resolves to active
      await pool.query(
        `UPDATE subscriptions SET status = 'active' WHERE id = $1`,
        [sub.id]
      );

      const result = await pool.query(
        'SELECT * FROM referral_passes WHERE subscription_id = $1',
        [sub.id]
      );

      expect(result.rows.length).toBe(3); // still only 3, not 6
    });
  });
});

// ===========================================================================
// trigger_normalize_email
// Fires BEFORE INSERT OR UPDATE OF email ON users
// ===========================================================================

describe('trigger_normalize_email', () => {
  it('populates email_normalized on INSERT', async () => {
    const result = await pool.query(
      `INSERT INTO users (email, password_hash)
       VALUES ($1, $2)
       RETURNING email_normalized`,
      ['user+alias@gmail.com', 'hash']
    );

    expect(result.rows[0].email_normalized).toBe('user@gmail.com');
  });

  it('updates email_normalized when email is changed', async () => {
    const user = await createUser({ email: 'original@example.com' });

    await pool.query(
      'UPDATE users SET email = $1 WHERE id = $2',
      ['new+alias@gmail.com', user.id]
    );

    const result = await pool.query(
      'SELECT email_normalized FROM users WHERE id = $1',
      [user.id]
    );

    expect(result.rows[0].email_normalized).toBe('new@gmail.com');
  });

  it('rejects a second user with the same normalized email', async () => {
    // Both normalize to user@gmail.com — second INSERT must fail on UNIQUE constraint
    await pool.query(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2)`,
      ['user@gmail.com', 'hash']
    );

    await expect(
      pool.query(
        `INSERT INTO users (email, password_hash) VALUES ($1, $2)`,
        ['user+trial@gmail.com', 'hash']
      )
    ).rejects.toThrow(/unique/i);
  });
});
