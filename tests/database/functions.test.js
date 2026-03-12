/**
 * Database function tests: normalize_email() and is_user_eligible_for_trial()
 *
 * These tests execute the PostgreSQL functions directly and verify they match
 * the specs in docs/database/functions.md and docs/architecture/edge-cases.md.
 *
 * Requires a running PostgreSQL instance with the schema loaded:
 *   psql atlantic_referral < database/schema.sql
 */

const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

// ---------------------------------------------------------------------------
// Database connection
// ---------------------------------------------------------------------------

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     process.env.DB_PORT     || 5432,
  database: process.env.DB_NAME     || 'atlantic_referral_test',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

// ---------------------------------------------------------------------------
// Test data factories
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

/**
 * Insert a subscription row directly (bypasses the generate_referral_passes
 * trigger effect on passes, which we don't need for eligibility tests).
 *
 * `start_date` and `end_date` accept raw SQL expressions (e.g. interval
 * arithmetic) passed as override strings so callers can set historical dates
 * without needing JavaScript Date math to match PostgreSQL's clock exactly.
 */
async function createSubscription(userId, overrides = {}) {
  const id         = overrides.id         || uuidv4();
  const tier       = overrides.tier       || 'digital';
  const status     = overrides.status     || 'active';
  const isTrial    = overrides.isTrial    ?? false;

  // trial_end_date is required when is_trial = TRUE (CHECK constraint)
  // Default: 7 days from now for trials, NULL for paid
  const trialEndExpr = isTrial
    ? (overrides.trialEndExpr || "NOW() + INTERVAL '7 days'")
    : 'NULL';

  const startExpr = overrides.startExpr || 'NOW()';
  const endExpr   = overrides.endExpr   || 'NULL';

  const result = await pool.query(
    `INSERT INTO subscriptions
       (id, user_id, tier, status, is_trial, trial_end_date, start_date, end_date)
     VALUES (
       $1, $2, $3, $4, $5,
       ${trialEndExpr},
       ${startExpr},
       ${endExpr}
     )
     RETURNING *`,
    [id, userId, tier, status, isTrial]
  );
  return result.rows[0];
}

// ---------------------------------------------------------------------------
// Database setup / teardown
// ---------------------------------------------------------------------------

async function cleanDatabase() {
  // Delete in FK-safe order; CASCADE handles child rows but explicit order
  // is clearer and avoids relying on CASCADE for test cleanup.
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
// normalize_email()
// Spec: docs/database/functions.md
// ===========================================================================

describe('normalize_email()', () => {
  async function normalize(email) {
    const result = await pool.query(
      'SELECT normalize_email($1) AS normalized',
      [email]
    );
    return result.rows[0].normalized;
  }

  // -------------------------------------------------------------------------
  // Gmail
  // -------------------------------------------------------------------------

  describe('Gmail', () => {
    it('strips +alias', async () => {
      expect(await normalize('user+1@gmail.com')).toBe('user@gmail.com');
    });

    it('removes dots from local part', async () => {
      expect(await normalize('john.doe@gmail.com')).toBe('johndoe@gmail.com');
    });

    it('lowercases the address and strips +alias', async () => {
      // Covers: uppercase local part + uppercase domain + +alias
      expect(await normalize('User+Test@Gmail.com')).toBe('user@gmail.com');
    });

    it('normalizes googlemail.com domain to gmail.com', async () => {
      expect(await normalize('John.Doe@Googlemail.com')).toBe('johndoe@gmail.com');
    });
  });

  // -------------------------------------------------------------------------
  // Outlook / Hotmail / Live
  // -------------------------------------------------------------------------

  describe('Outlook', () => {
    it('strips +alias', async () => {
      expect(await normalize('user+alias@outlook.com')).toBe('user@outlook.com');
    });
  });

  // -------------------------------------------------------------------------
  // Yahoo
  // -------------------------------------------------------------------------

  describe('Yahoo', () => {
    it('strips -alias (Yahoo uses hyphens)', async () => {
      expect(await normalize('user-test@yahoo.com')).toBe('user@yahoo.com');
    });
  });

  // -------------------------------------------------------------------------
  // ProtonMail
  // -------------------------------------------------------------------------

  describe('ProtonMail', () => {
    it('strips +alias on protonmail.com', async () => {
      expect(await normalize('user+alias@protonmail.com')).toBe('user@protonmail.com');
    });
  });
});

// ===========================================================================
// is_user_eligible_for_trial()
// Spec: docs/database/functions.md + docs/architecture/edge-cases.md
// ===========================================================================

describe('is_user_eligible_for_trial()', () => {
  async function checkEligibility(userId) {
    const result = await pool.query(
      'SELECT is_user_eligible_for_trial($1) AS eligible',
      [userId]
    );
    return result.rows[0].eligible;
  }

  // -------------------------------------------------------------------------
  // Eligible cases
  // -------------------------------------------------------------------------

  describe('eligible users', () => {
    it('returns TRUE for a user with no subscription history', async () => {
      const user = await createUser();

      expect(await checkEligibility(user.id)).toBe(true);
    });

    it('returns TRUE when subscription ended more than 12 months ago', async () => {
      // Edge case #3: subscription cooldown is 12 months. 18 months is past it.
      const user = await createUser();
      await createSubscription(user.id, {
        status:   'cancelled',
        isTrial:  false,
        endExpr:  "NOW() - INTERVAL '18 months'",
      });

      expect(await checkEligibility(user.id)).toBe(true);
    });

    it('returns TRUE when trial started more than 24 months ago', async () => {
      // Edge case #4: trial cooldown is 24 months. 30 months is past it.
      const user = await createUser();
      await createSubscription(user.id, {
        status:       'expired',
        isTrial:      true,
        startExpr:    "NOW() - INTERVAL '30 months'",
        trialEndExpr: "NOW() - INTERVAL '29 months'",
        endExpr:      "NOW() - INTERVAL '29 months'",
      });

      expect(await checkEligibility(user.id)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Ineligible — Rule 1: active subscription (edge case #2)
  // -------------------------------------------------------------------------

  describe('Rule 1: currently active subscription', () => {
    it('returns FALSE for a user with an active subscription', async () => {
      const user = await createUser();
      await createSubscription(user.id, { status: 'active', isTrial: false });

      expect(await checkEligibility(user.id)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Ineligible — Rule 2: subscription ended within 12 months (edge case #3)
  // -------------------------------------------------------------------------

  describe('Rule 2: subscription ended within last 12 months', () => {
    it('returns FALSE when subscription ended 6 months ago', async () => {
      const user = await createUser();
      await createSubscription(user.id, {
        status:  'cancelled',
        isTrial: false,
        endExpr: "NOW() - INTERVAL '6 months'",
      });

      expect(await checkEligibility(user.id)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Ineligible — Rule 3: trial within last 24 months (edge case #4)
  // -------------------------------------------------------------------------

  describe('Rule 3: trial started within last 24 months', () => {
    it('returns FALSE when trial started 18 months ago', async () => {
      // The trial has since ended (end_date set) so Rule 2 also does not apply
      // (end_date > 12 months ago). Only Rule 3 fires here.
      const user = await createUser();
      await createSubscription(user.id, {
        status:       'expired',
        isTrial:      true,
        startExpr:    "NOW() - INTERVAL '18 months'",
        trialEndExpr: "NOW() - INTERVAL '17 months'",
        endExpr:      "NOW() - INTERVAL '17 months'",
      });

      expect(await checkEligibility(user.id)).toBe(false);
    });
  });
});
