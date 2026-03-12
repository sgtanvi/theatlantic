# TDD Workflow - Quick Reference

> How to build The Atlantic Referral Program using Test-Driven Development

## Why TDD for This Project?

1. **14 edge cases** to handle - easy to miss without tests
2. **Clear API spec** in docs/api/endpoints.md - perfect for TDD
3. **Complex validations** - cooldown periods, email normalization
4. **Prevents regressions** - refactor safely

---

## The Red-Green-Refactor Cycle

```
RED    → Write failing test
GREEN  → Write minimal code to pass
REFACTOR → Clean up while tests pass
REPEAT
```

---

## Daily TDD Workflow

### Morning (Start Fresh)
```bash
# 1. Pull latest
git pull origin main

# 2. Run all tests (should pass)
npm test

# 3. Start test watcher
npm test -- --watch
```

### Building a Feature (Example: Redemption Endpoint)

#### Step 1: Write Test First
```javascript
// tests/integration/api/referral.test.js
describe('POST /api/referral/redeem', () => {
  it('should create trial subscription when pass is valid', async () => {
    // Arrange
    const pass = await createValidPass();
    const user = await createEligibleUser();
    
    // Act
    const response = await request(app)
      .post('/api/referral/redeem')
      .set('x-user-id', user.id)
      .send({ token: pass.token });
    
    // Assert
    expect(response.status).toBe(201);
    expect(response.body.data.status).toBe('trial');
  });
});
```

**Run**: Tests fail (endpoint doesn't exist) - RED

#### Step 2: Minimal Implementation
```javascript
// src/routes/referral.js
router.post('/redeem', auth, controller.redeemPass);

// src/controllers/referralController.js
async function redeemPass(req, res) {
  // Hardcode for now - just make test pass
  res.status(201).json({
    success: true,
    data: { status: 'trial' }
  });
}
```

**Run**: Tests pass - GREEN

#### Step 3: Make It Real
```javascript
async function redeemPass(req, res, next) {
  try {
    const { token } = req.body;
    const subscription = await ReferralService.redeemPass(token, req.user.id);
    res.status(201).json({ success: true, data: subscription });
  } catch (error) {
    next(error);
  }
}
```

**Run**: Tests still pass - GREEN

#### Step 4: Add Edge Case Test
```javascript
it('should reject already redeemed pass', async () => {
  const pass = await createAndRedeemPass();
  
  const response = await request(app)
    .post('/api/referral/redeem')
    .set('x-user-id', anotherUser.id)
    .send({ token: pass.token });
  
  expect(response.status).toBe(409);
  expect(response.body.error).toBe('Pass already redeemed');
});
```

**Run**: Tests fail (doesn't check redemption) - RED

#### Step 5: Add Validation
```javascript
// In ReferralService.redeemPass
if (pass.is_redeemed) {
  throw new ConflictError('This pass has already been redeemed');
}
```

**Run**: Tests pass - GREEN

#### Step 6: Refactor
```javascript
// Extract validation to helper
function validatePassNotRedeemed(pass) {
  if (pass.is_redeemed) {
    throw new ConflictError('This pass has already been redeemed');
  }
}
```

**Run**: Tests still pass - GREEN

#### Step 7: Repeat for Next Edge Case
Continue until all 14 edge cases have tests

---

## Recommended Build Order (TDD)

### Week 1: Database + Simple Reads

**Day 1: Database Layer**
```bash
# Test database schema
npm test tests/database/schema.test.js

# Test triggers
npm test tests/database/triggers.test.js

# Test functions
npm test tests/database/functions.test.js
```

Tests to write:
- Trigger creates 3 passes for active subscription
- Trigger doesn't create passes for trials
- Email normalization function works
- Eligibility function returns correct booleans

**Day 2: Utility Functions**
```bash
npm test tests/unit/utils/
```

Tests to write:
- EmailService.normalize() matches PostgreSQL function
- JWT generation creates valid tokens
- JWT verification catches tampering
- Date helpers work correctly

**Day 3: GET /api/referral/passes**
```bash
npm test tests/integration/api/referral.test.js
```

Tests to write:
- Returns 3 passes for active subscriber
- Returns empty for user without subscription
- Requires authentication
- Formats response correctly

### Week 2: Complex Features

**Day 1: GET /api/referral/eligibility**

Tests for:
- Eligible user (no subscriptions)
- Ineligible: active subscription
- Ineligible: subscription ended 6 months ago (12mo cooldown)
- Ineligible: trial 18 months ago (24mo cooldown)
- Eligible: subscription ended 18 months ago (past cooldown)

**Day 2-3: POST /api/referral/redeem (The Big One)**

Build incrementally with tests:

1. Happy path (valid pass, eligible user)
2. Missing token (400)
3. Invalid token format (400)
4. Pass not found (404)
5. Already redeemed (409)
6. Pass expired (410)
7. Token expired (410)
8. Self-redemption (400)
9. Referrer inactive (400)
10. User already subscribed (409)
11. 12-month cooldown (409)
12. 24-month trial cooldown (409)
13. Email normalization prevents duplicate (409)
14. Concurrent redemption (409)

**Day 4: GET /api/referral/stats**

Tests for:
- No redemptions yet
- With redemptions
- Privacy (only shows email, not full profile)

---

## Test Data Factories

Keep in separate file for reuse:

```javascript
// tests/helpers/factories.js

async function createUser(overrides = {}) {
  const email = overrides.email || `test${Date.now()}@example.com`;
  const result = await pool.query(
    `INSERT INTO users (email, email_normalized, password_hash)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [email, normalizeEmail(email), 'hashed']
  );
  return result.rows[0];
}

async function createSubscription(userId, overrides = {}) {
  const result = await pool.query(
    `INSERT INTO subscriptions (user_id, tier, status, is_trial)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [
      userId,
      overrides.tier || 'digital',
      overrides.status || 'active',
      overrides.is_trial || false
    ]
  );
  return result.rows[0];
}

async function createUserWithSubscription(overrides = {}) {
  const user = await createUser(overrides);
  const subscription = await createSubscription(user.id, overrides);
  return { user, subscription };
}

async function createValidPass() {
  const { user, subscription } = await createUserWithSubscription();
  
  // Get auto-generated passes
  const passes = await pool.query(
    'SELECT * FROM referral_passes WHERE user_id = $1 LIMIT 1',
    [user.id]
  );
  
  return passes.rows[0];
}

async function createEligibleUser() {
  // User with no subscriptions = eligible
  return await createUser();
}

async function createIneligibleUser() {
  // User with active subscription = ineligible
  const { user } = await createUserWithSubscription();
  return user;
}
```

---

## AI Prompting for TDD

### Prompt 1: Write Test
```
I'm building POST /api/referral/redeem using TDD.

Write a test for the happy path where:
- User has valid referral token
- User is eligible (no active subscription)
- Creates trial subscription

Use test factories from tests/helpers/factories.js
Follow CLAUDE.md test structure (arrange-act-assert)

Just the test - no implementation yet.
```

### Prompt 2: Make It Pass
```
Here's my failing test:
[paste test]

Write minimal implementation to make it pass.

Follow:
- CLAUDE.md transaction pattern
- CLAUDE.md error handling
- docs/api/endpoints.md response format

Keep it simple for now.
```

### Prompt 3: Add Edge Case
```
Happy path test passes. Now add test for:
"Pass already redeemed" edge case (HTTP 409)

Then update implementation to handle it.

Reference:
- docs/architecture/edge-cases.md #1
- docs/api/errors.md for response format
```

### Prompt 4: Refactor
```
All tests pass but code is messy. Refactor while keeping tests green.

Extract repeated validation logic to helper functions.
Follow CLAUDE.md patterns for clean code.

Tests must still pass after refactor.
```

---

## Common TDD Pitfalls (Avoid These)

### 1. Writing Too Much Code Before Testing
**Bad**: Build entire feature, then write tests
**Good**: One test, minimal code, next test

### 2. Testing Implementation Instead of Behavior
**Bad**:
```javascript
it('should call pool.query with correct params', () => {
  // Testing how it works
});
```

**Good**:
```javascript
it('should return user passes', async () => {
  // Testing what it does
});
```

### 3. Not Running Tests Frequently
**Bad**: Write 10 tests, then run
**Good**: Write 1 test, run, write code, run, repeat

### 4. Tests That Depend on Each Other
**Bad**:
```javascript
it('test 1', () => { globalState.user = createUser(); });
it('test 2', () => { // uses globalState.user });
```

**Good**:
```javascript
it('test 1', () => { const user = createUser(); });
it('test 2', () => { const user = createUser(); });
```

### 5. Skipping RED Step
**Bad**: Write code, then write test that passes immediately
**Good**: Write test that fails, then make it pass

---

## Test Coverage Goals

```bash
npm test -- --coverage
```

**Targets**:
- Statements: 80%+
- Branches: 75%+ (all edge cases)
- Functions: 80%+
- Lines: 80%+

**Critical 100% coverage**:
- ReferralService.redeemPass()
- Eligibility checking logic
- Email normalization

**Okay <80% coverage**:
- Error middleware (hard to test all paths)
- Database connection setup
- Server startup code

---

## Daily Checklist

- [ ] Pull latest code
- [ ] Run full test suite (should pass)
- [ ] Start test watcher
- [ ] Write test for next feature
- [ ] See it fail (RED)
- [ ] Write minimal code
- [ ] See it pass (GREEN)
- [ ] Refactor if needed
- [ ] Commit with test
- [ ] Repeat

---

## When NOT to TDD

**Skip TDD for**:
- Spike/prototype code (exploring)
- Throwaway scripts
- Configuration files

**Always TDD for**:
- Business logic (services)
- API endpoints
- Data validation
- Edge cases

---

## Resources

- **CLAUDE.md**: Complete testing guidelines
- **docs/api/endpoints.md**: Expected behavior
- **docs/architecture/edge-cases.md**: All 14 test scenarios
- **docs/api/errors.md**: Expected error responses

---

**Remember**: Tests are not extra work - they ARE the work. Writing tests first actually saves time by preventing bugs and making refactoring safe.