/**
 * Integration tests: GET /api/referral/eligibility
 *
 * These tests are RED until the endpoint is implemented.
 * Run: docker compose run --rm test
 *
 * Spec:
 *   docs/api/endpoints.md — GET /api/referral/eligibility
 *   docs/architecture/edge-cases.md — #2 (active sub), #3 (12mo), #4 (24mo)
 *   docs/database/functions.md — is_user_eligible_for_trial() rules
 */

const request = require('supertest');
const app     = require('../../../src/server');
const {
  createUser,
  createSubscription,
  createEligibleUser,
  createIneligibleUser,
  cleanDatabase,
} = require('../../helpers/factories');

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await cleanDatabase();
  const { pool } = require('../../../src/config/database');
  await pool.end();
});

// ===========================================================================
// GET /api/referral/eligibility
// ===========================================================================

describe('GET /api/referral/eligibility', () => {

  // -------------------------------------------------------------------------
  // Authentication (same pattern as /passes — guard clause first)
  // -------------------------------------------------------------------------

  describe('authentication', () => {
    it('returns 401 when x-user-id header is missing', async () => {
      const response = await request(app).get('/api/referral/eligibility');

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Eligible users
  // -------------------------------------------------------------------------

  describe('eligible users', () => {
    it('returns eligible=true and reason=null for a user with no subscription history', async () => {
      // Edge case baseline: brand new user is always eligible
      const user = await createEligibleUser();

      const response = await request(app)
        .get('/api/referral/eligibility')
        .set('x-user-id', user.id);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.eligible).toBe(true);
      expect(response.body.data.reason).toBeNull();
    });

    it('returns eligible=true when subscription ended more than 12 months ago', async () => {
      // Edge case #3 boundary: 18 months is past the 12-month subscription cooldown
      const user = await createUser();
      await createSubscription(user.id, {
        status:   'cancelled',
        isTrial:  false,
        startExpr: "NOW() - INTERVAL '19 months'",
        endExpr:   "NOW() - INTERVAL '18 months'",
      });

      const response = await request(app)
        .get('/api/referral/eligibility')
        .set('x-user-id', user.id);

      expect(response.status).toBe(200);
      expect(response.body.data.eligible).toBe(true);
      expect(response.body.data.reason).toBeNull();
    });

    it('returns eligible=true when trial started more than 24 months ago', async () => {
      // Edge case #4 boundary: 30 months is past the 24-month trial cooldown
      const user = await createUser();
      await createSubscription(user.id, {
        status:       'expired',
        isTrial:      true,
        startExpr:    "NOW() - INTERVAL '30 months'",
        trialEndExpr: "NOW() - INTERVAL '29 months'",
        endExpr:      "NOW() - INTERVAL '29 months'",
      });

      const response = await request(app)
        .get('/api/referral/eligibility')
        .set('x-user-id', user.id);

      expect(response.status).toBe(200);
      expect(response.body.data.eligible).toBe(true);
      expect(response.body.data.reason).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Ineligible: Rule 1 — active subscription (edge case #2)
  // -------------------------------------------------------------------------

  describe('ineligible: active subscription', () => {
    it('returns eligible=false with reason when user has active subscription', async () => {
      // Edge case #2: active subscriber cannot receive another trial
      const user = await createIneligibleUser();

      const response = await request(app)
        .get('/api/referral/eligibility')
        .set('x-user-id', user.id);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.eligible).toBe(false);
      expect(typeof response.body.data.reason).toBe('string');
      expect(response.body.data.reason).toMatch(/active subscription/i);
    });
  });

  // -------------------------------------------------------------------------
  // Ineligible: Rule 2 — subscription ended within 12 months (edge case #3)
  // -------------------------------------------------------------------------

  describe('ineligible: subscription ended within 12 months', () => {
    it('returns eligible=false when subscription ended 6 months ago', async () => {
      // Edge case #3: 6 months ago is within the 12-month subscription cooldown
      const user = await createUser();
      await createSubscription(user.id, {
        status:   'cancelled',
        isTrial:  false,
        startExpr: "NOW() - INTERVAL '7 months'",
        endExpr:   "NOW() - INTERVAL '6 months'",
      });

      const response = await request(app)
        .get('/api/referral/eligibility')
        .set('x-user-id', user.id);

      expect(response.status).toBe(200);
      expect(response.body.data.eligible).toBe(false);
      expect(typeof response.body.data.reason).toBe('string');
    });
  });

  // -------------------------------------------------------------------------
  // Ineligible: Rule 3 — trial started within 24 months (edge case #4)
  // -------------------------------------------------------------------------

  describe('ineligible: trial within 24 months', () => {
    it('returns eligible=false when trial started 18 months ago', async () => {
      // Edge case #4: 18 months ago is within the 24-month trial cooldown.
      // end_date is 17 months ago — outside the 12-month subscription window
      // so only Rule 3 fires, not Rule 2.
      const user = await createUser();
      await createSubscription(user.id, {
        status:       'expired',
        isTrial:      true,
        startExpr:    "NOW() - INTERVAL '18 months'",
        trialEndExpr: "NOW() - INTERVAL '17 months'",
        endExpr:      "NOW() - INTERVAL '17 months'",
      });

      const response = await request(app)
        .get('/api/referral/eligibility')
        .set('x-user-id', user.id);

      expect(response.status).toBe(200);
      expect(response.body.data.eligible).toBe(false);
      expect(typeof response.body.data.reason).toBe('string');
    });
  });

  // -------------------------------------------------------------------------
  // Response shape
  // -------------------------------------------------------------------------

  describe('response shape', () => {
    it('always returns success=true (eligibility is not an error)', async () => {
      // Even for ineligible users the HTTP status is 200 — eligibility is
      // information, not an error condition. The caller uses eligible=false
      // to decide whether to show the "Redeem" button.
      const user = await createIneligibleUser();

      const response = await request(app)
        .get('/api/referral/eligibility')
        .set('x-user-id', user.id);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('response data always has eligible and reason fields', async () => {
      const user = await createEligibleUser();

      const response = await request(app)
        .get('/api/referral/eligibility')
        .set('x-user-id', user.id);

      expect(response.body.data).toHaveProperty('eligible');
      expect(response.body.data).toHaveProperty('reason');
    });
  });

});
