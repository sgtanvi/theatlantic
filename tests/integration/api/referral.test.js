/**
 * Integration tests: GET /api/referral/passes
 *
 * These tests are RED until the endpoint is implemented.
 * Run: docker compose run --rm test
 *
 * Spec: docs/api/endpoints.md — GET /api/referral/passes
 * Auth: docs/api/authentication.md — x-user-id header (dev mode)
 */

const request = require('supertest');
const app     = require('../../../src/server');
const {
  createUserWithSubscription,
  createEligibleUser,
  cleanDatabase,
} = require('../../helpers/factories');

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await cleanDatabase();
  // Allow the pool to drain so Jest can exit cleanly
  const { pool } = require('../../../src/config/database');
  await pool.end();
});

// ===========================================================================
// GET /api/referral/passes
// ===========================================================================

describe('GET /api/referral/passes', () => {

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  describe('authentication', () => {
    it('returns 401 when x-user-id header is missing', async () => {
      const response = await request(app).get('/api/referral/passes');

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/unauthorized/i);
    });

    it('returns 401 when x-user-id is not a valid user', async () => {
      const response = await request(app)
        .get('/api/referral/passes')
        .set('x-user-id', '00000000-0000-0000-0000-000000000000');

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Happy path: active subscriber with passes
  // -------------------------------------------------------------------------

  describe('active subscriber', () => {
    it('returns 200 with correct response envelope', async () => {
      const { user } = await createUserWithSubscription();

      const response = await request(app)
        .get('/api/referral/passes')
        .set('x-user-id', user.id);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toBeDefined();
    });

    it('returns summary counts: total_passes=3, available_count=3, redeemed_count=0', async () => {
      const { user } = await createUserWithSubscription();

      const response = await request(app)
        .get('/api/referral/passes')
        .set('x-user-id', user.id);

      expect(response.body.data.total_passes).toBe(3);
      expect(response.body.data.available_count).toBe(3);
      expect(response.body.data.redeemed_count).toBe(0);
    });

    it('returns an array of 3 passes', async () => {
      const { user } = await createUserWithSubscription();

      const response = await request(app)
        .get('/api/referral/passes')
        .set('x-user-id', user.id);

      expect(Array.isArray(response.body.data.passes)).toBe(true);
      expect(response.body.data.passes.length).toBe(3);
    });

    it('each pass has required fields: id, token, is_redeemed, expires_at, shareable_link', async () => {
      const { user } = await createUserWithSubscription();

      const response = await request(app)
        .get('/api/referral/passes')
        .set('x-user-id', user.id);

      for (const pass of response.body.data.passes) {
        expect(pass.id).toBeDefined();
        expect(pass.token).toBeDefined();
        expect(pass.is_redeemed).toBe(false);
        expect(pass.expires_at).toBeDefined();
        expect(pass).toHaveProperty('redeemed_by');
        expect(pass).toHaveProperty('redeemed_at');
      }
    });

    it('unredeemed passes have a shareable_link', async () => {
      const { user } = await createUserWithSubscription();

      const response = await request(app)
        .get('/api/referral/passes')
        .set('x-user-id', user.id);

      for (const pass of response.body.data.passes) {
        expect(pass.shareable_link).not.toBeNull();
        expect(typeof pass.shareable_link).toBe('string');
      }
    });
  });

  // -------------------------------------------------------------------------
  // User with no subscription
  // -------------------------------------------------------------------------

  describe('user with no subscription', () => {
    it('returns 200 with empty passes array', async () => {
      const user = await createEligibleUser();

      const response = await request(app)
        .get('/api/referral/passes')
        .set('x-user-id', user.id);

      expect(response.status).toBe(200);
      expect(response.body.data.passes).toEqual([]);
      expect(response.body.data.available_count).toBe(0);
    });
  });

});
