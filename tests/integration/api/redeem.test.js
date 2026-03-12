/**
 * Integration tests: POST /api/referral/redeem
 *
 * Covers all 14 edge cases from docs/architecture/edge-cases.md.
 * Run: docker compose run --rm test
 *
 * Spec:
 *   docs/api/endpoints.md — POST /api/referral/redeem
 *   docs/architecture/edge-cases.md — edge cases #1–#11 + concurrent
 */

const request = require('supertest');
const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const app     = require('../../../src/server');
const {
  createUser,
  createSubscription,
  createValidPass,
  createExpiredPass,
  createPassWithInactiveReferrer,
  createEligibleUser,
  createUserWithSubscription,
  cleanDatabase,
} = require('../../helpers/factories');

const JWT_SECRET = process.env.JWT_SECRET || 'test_secret';

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await cleanDatabase();
  const { pool } = require('../../../src/config/database');
  await pool.end();
});

// ===========================================================================
// POST /api/referral/redeem
// ===========================================================================

describe('POST /api/referral/redeem', () => {

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  it('returns 401 when x-user-id header is missing', async () => {
    const response = await request(app)
      .post('/api/referral/redeem')
      .send({ token: 'some-token' });

    expect(response.status).toBe(401);
    expect(response.body.success).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it('creates a 7-day digital trial when pass is valid and recipient is eligible', async () => {
    const pass      = await createValidPass();
    const recipient = await createEligibleUser();

    const response = await request(app)
      .post('/api/referral/redeem')
      .set('x-user-id', recipient.id)
      .send({ token: pass.token });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.message).toMatch(/trial activated/i);
    expect(response.body.data.tier).toBe('digital');
    expect(response.body.data.status).toBe('trial');
    expect(response.body.data.trial_end_date).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Input validation (400)
  // -------------------------------------------------------------------------

  it('returns 400 when token is missing from request body', async () => {
    const user = await createEligibleUser();

    const response = await request(app)
      .post('/api/referral/redeem')
      .set('x-user-id', user.id)
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
  });

  it('returns 400 when token is signed with wrong secret (tampered)', async () => {
    const user = await createEligibleUser();
    const badToken = jwt.sign(
      { passId: uuidv4(), referrerId: uuidv4(), type: 'referral_pass' },
      'wrong_secret',
      { expiresIn: '90d' }
    );

    const response = await request(app)
      .post('/api/referral/redeem')
      .set('x-user-id', user.id)
      .send({ token: badToken });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
  });

  it('returns 400 when JWT payload is missing the referral_pass type', async () => {
    const user = await createEligibleUser();
    const badToken = jwt.sign(
      { passId: uuidv4(), referrerId: uuidv4(), type: 'not_a_referral_pass' },
      JWT_SECRET,
      { expiresIn: '90d' }
    );

    const response = await request(app)
      .post('/api/referral/redeem')
      .set('x-user-id', user.id)
      .send({ token: badToken });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Token / pass expiry (410)
  // -------------------------------------------------------------------------

  it('returns 410 when JWT token is expired', async () => {
    const pass      = await createValidPass();
    const recipient = await createEligibleUser();
    // Set exp 60 seconds in the past to guarantee the token is already expired
    const expiredToken = jwt.sign(
      { passId: pass.id, referrerId: pass.user_id, type: 'referral_pass',
        exp: Math.floor(Date.now() / 1000) - 60 },
      JWT_SECRET
    );

    const response = await request(app)
      .post('/api/referral/redeem')
      .set('x-user-id', recipient.id)
      .send({ token: expiredToken });

    expect(response.status).toBe(410);
    expect(response.body.success).toBe(false);
  });

  it('returns 410 when pass expires_at is in the past (DB-level expiry)', async () => {
    const pass      = await createExpiredPass();
    const recipient = await createEligibleUser();

    const response = await request(app)
      .post('/api/referral/redeem')
      .set('x-user-id', recipient.id)
      .send({ token: pass.token });

    expect(response.status).toBe(410);
    expect(response.body.success).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Pass state errors (404, 409)
  // -------------------------------------------------------------------------

  it('returns 404 when JWT is valid but the pass does not exist in the database', async () => {
    const user  = await createEligibleUser();
    const token = jwt.sign(
      { passId: uuidv4(), referrerId: uuidv4(), type: 'referral_pass' },
      JWT_SECRET,
      { expiresIn: '90d' }
    );

    const response = await request(app)
      .post('/api/referral/redeem')
      .set('x-user-id', user.id)
      .send({ token });

    expect(response.status).toBe(404);
    expect(response.body.success).toBe(false);
  });

  it('returns 409 when pass has already been redeemed', async () => {
    const pass           = await createValidPass();
    const firstRecipient = await createEligibleUser();
    const secondRecipient = await createEligibleUser();

    // First redemption succeeds
    await request(app)
      .post('/api/referral/redeem')
      .set('x-user-id', firstRecipient.id)
      .send({ token: pass.token });

    // Second attempt on the same pass
    const response = await request(app)
      .post('/api/referral/redeem')
      .set('x-user-id', secondRecipient.id)
      .send({ token: pass.token });

    expect(response.status).toBe(409);
    expect(response.body.success).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Referrer validation (400)
  // -------------------------------------------------------------------------

  it('returns 400 when the referrer no longer has an active subscription', async () => {
    const pass      = await createPassWithInactiveReferrer();
    const recipient = await createEligibleUser();

    const response = await request(app)
      .post('/api/referral/redeem')
      .set('x-user-id', recipient.id)
      .send({ token: pass.token });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
  });

  it('returns 400 when user tries to redeem their own referral pass', async () => {
    const pass = await createValidPass();

    const response = await request(app)
      .post('/api/referral/redeem')
      .set('x-user-id', pass.user_id)
      .send({ token: pass.token });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Recipient eligibility (409)
  // -------------------------------------------------------------------------

  it('returns 409 when recipient already has an active subscription', async () => {
    const pass = await createValidPass();
    const { user: ineligibleUser } = await createUserWithSubscription();

    const response = await request(app)
      .post('/api/referral/redeem')
      .set('x-user-id', ineligibleUser.id)
      .send({ token: pass.token });

    expect(response.status).toBe(409);
    expect(response.body.success).toBe(false);
  });

  it('returns 409 when recipient had a subscription within the last 12 months', async () => {
    const pass = await createValidPass();
    const user = await createUser();
    // Subscription ended 6 months ago — within the 12-month cooldown window
    await createSubscription(user.id, {
      status:    'cancelled',
      isTrial:   false,
      startExpr: "NOW() - INTERVAL '7 months'",
      endExpr:   "NOW() - INTERVAL '6 months'",
    });

    const response = await request(app)
      .post('/api/referral/redeem')
      .set('x-user-id', user.id)
      .send({ token: pass.token });

    expect(response.status).toBe(409);
    expect(response.body.success).toBe(false);
  });

  it('returns 409 when recipient had a trial within the last 24 months', async () => {
    const pass = await createValidPass();
    const user = await createUser();
    // Trial started 18 months ago — within the 24-month cooldown window
    // end_date is 17 months ago, outside the 12-month window, so only Rule 3 fires
    await createSubscription(user.id, {
      status:       'expired',
      isTrial:      true,
      startExpr:    "NOW() - INTERVAL '18 months'",
      trialEndExpr: "NOW() - INTERVAL '17 months'",
      endExpr:      "NOW() - INTERVAL '17 months'",
    });

    const response = await request(app)
      .post('/api/referral/redeem')
      .set('x-user-id', user.id)
      .send({ token: pass.token });

    expect(response.status).toBe(409);
    expect(response.body.success).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Concurrent redemption race condition
  // -------------------------------------------------------------------------

  it('allows only one winner when two users redeem the same pass concurrently', async () => {
    const pass       = await createValidPass();
    const recipient1 = await createEligibleUser();
    const recipient2 = await createEligibleUser();

    const [r1, r2] = await Promise.all([
      request(app).post('/api/referral/redeem').set('x-user-id', recipient1.id).send({ token: pass.token }),
      request(app).post('/api/referral/redeem').set('x-user-id', recipient2.id).send({ token: pass.token }),
    ]);

    const statuses = [r1.status, r2.status].sort();
    // Exactly one 201 and one 409 (or two 409 if SERIALIZABLE aborts both — but
    // one must always win in practice with the FOR UPDATE lock)
    expect(statuses).toContain(201);
    expect(statuses).toContain(409);
  });

});
