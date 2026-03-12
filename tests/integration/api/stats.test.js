/**
 * Integration tests: GET /api/referral/stats
 *
 * Run: docker compose run --rm test
 *
 * Spec:
 *   docs/api/endpoints.md — GET /api/referral/stats
 */

const request = require('supertest');
const app     = require('../../../src/server');
const {
  createEligibleUser,
  createValidPass,
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
// GET /api/referral/stats
// ===========================================================================

describe('GET /api/referral/stats', () => {

  it('returns 401 when x-user-id header is missing', async () => {
    const response = await request(app).get('/api/referral/stats');

    expect(response.status).toBe(401);
    expect(response.body.success).toBe(false);
  });

  it('returns zero stats for a user with no referral passes', async () => {
    const user = await createEligibleUser();

    const response = await request(app)
      .get('/api/referral/stats')
      .set('x-user-id', user.id);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.successful_referrals).toBe(0);
    expect(response.body.data.pending_passes).toBe(0);
    expect(response.body.data.redemption_history).toEqual([]);
  });

  it('returns 3 pending passes and 0 successful referrals for a subscriber with no redemptions', async () => {
    const pass = await createValidPass();

    const response = await request(app)
      .get('/api/referral/stats')
      .set('x-user-id', pass.user_id);

    expect(response.status).toBe(200);
    expect(response.body.data.pending_passes).toBe(3);
    expect(response.body.data.successful_referrals).toBe(0);
    expect(response.body.data.redemption_history).toEqual([]);
  });

  it('returns 1 successful referral with a history entry after one redemption', async () => {
    const pass      = await createValidPass();
    const recipient = await createEligibleUser();

    await request(app)
      .post('/api/referral/redeem')
      .set('x-user-id', recipient.id)
      .send({ token: pass.token });

    const response = await request(app)
      .get('/api/referral/stats')
      .set('x-user-id', pass.user_id);

    expect(response.status).toBe(200);
    expect(response.body.data.successful_referrals).toBe(1);
    expect(response.body.data.pending_passes).toBe(2);
    expect(response.body.data.redemption_history).toHaveLength(1);
    expect(response.body.data.redemption_history[0]).toHaveProperty('redeemed_at');
    expect(response.body.data.redemption_history[0]).toHaveProperty('recipient_email');
  });

  it('response data always has all three required fields', async () => {
    const user = await createEligibleUser();

    const response = await request(app)
      .get('/api/referral/stats')
      .set('x-user-id', user.id);

    expect(response.body.data).toHaveProperty('successful_referrals');
    expect(response.body.data).toHaveProperty('pending_passes');
    expect(response.body.data).toHaveProperty('redemption_history');
  });

});
