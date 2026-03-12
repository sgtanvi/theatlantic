# Project Context: The Atlantic Referral Program

> This file provides context for Claude/AI assistants working on this codebase

## Project Overview

**What**: Backend referral system where active subscribers get 3 shareable passes, each granting a 7-day free digital trial to new users.

**Stack**: Node.js + Express + PostgreSQL + JWT

**Status**: Design complete (v2), implementation in progress

**Documentation**: See `/docs` folder for complete specs

---

## Architecture Principles

### 1. Database is Source of Truth
- All business logic enforcement starts at the database level
- Triggers auto-generate passes (can't forget in application code)
- Functions centralize complex logic (eligibility checks)
- CHECK constraints prevent invalid states

### 2. ACID Transactions for Critical Flows
- Pass redemption uses PostgreSQL transactions
- All-or-nothing: trial created AND pass marked redeemed
- Rollback on ANY validation failure

### 3. Security First
- Email normalization prevents infinite trial abuse
- JWT tokens are authentication, database is authorization
- Never trust client input - validate everything
- Cooldown periods prevent gaming (12mo subscription + 24mo trial)

---

## Coding Standards

### File Organization

```
src/
├── config/         # Database, JWT, environment - pure configuration
├── models/         # Data access layer - just queries, no business logic
├── services/       # Business logic - all validations and complex operations
├── controllers/    # HTTP layer - just request/response handling
├── middleware/     # Cross-cutting concerns - auth, validation, errors
├── routes/         # Route definitions - just wiring
└── utils/          # Pure functions - no dependencies
```

**Rule**: Each layer should only talk to the layer below it
- Controllers -> Services -> Models -> Database
- Never: Controllers -> Models (skipping services)

---

### Code Style

#### General
- **ES6+ features**: Use `const`/`let`, arrow functions, async/await
- **No callbacks**: Always use Promises or async/await
- **Destructuring**: Extract what you need: `const { token } = req.body`
- **Early returns**: Guard clauses at the top, happy path at bottom

#### Naming Conventions
```javascript
// Functions: verb + noun
async function getUserPasses(userId) {}
async function redeemPass(token, recipientUserId) {}

// Variables: descriptive, not abbreviated
const trialEndDate = new Date();  // GOOD
const ted = new Date();            // BAD

// Constants: SCREAMING_SNAKE_CASE for true constants
const TRIAL_DURATION_DAYS = 7;
const MAX_PASSES_PER_SUBSCRIPTION = 3;

// Database fields: snake_case (match PostgreSQL)
// JavaScript fields: camelCase
const dbResult = await query('SELECT trial_end_date FROM subscriptions');
const trialEndDate = dbResult.rows[0].trial_end_date;
```

#### Comments
```javascript
// BAD: Don't state the obvious
const userId = req.user.id; // Get user ID

// GOOD: Explain WHY, not WHAT
// Check eligibility before creating trial to prevent abuse
const eligible = await checkEligibility(userId);

// GOOD: Document complex business logic
// Cooldown periods: 12mo subscription (prevent recent churn)
//                  + 24mo trial (prevent cycling abuse)
if (lastSubscriptionEndDate > twelveMonthsAgo) {
  throw new Error('User had subscription within 12 months');
}

// GOOD: Link to design docs for complex sections
// See docs/architecture/edge-cases.md #5 for email normalization rationale
const normalizedEmail = normalizeEmail(email);
```

---

## Database Interaction

### Query Patterns

#### Use Prepared Statements (Always)
```javascript
// GOOD: SQL injection safe
const result = await pool.query(
  'SELECT * FROM users WHERE email = $1',
  [userEmail]
);

// BAD: SQL injection vulnerable
const result = await pool.query(
  `SELECT * FROM users WHERE email = '${userEmail}'`
);
```

#### Transaction Pattern
```javascript
// Standard transaction pattern for multi-step operations
async function redeemPass(token, userId) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // All database operations here
    const pass = await client.query('SELECT ...');
    const subscription = await client.query('INSERT ...');
    await client.query('UPDATE ...');
    
    await client.query('COMMIT');
    return subscription;
    
  } catch (error) {
    await client.query('ROLLBACK');
    throw error; // Re-throw to let error handler deal with it
    
  } finally {
    client.release(); // ALWAYS release the client
  }
}
```

#### Query Organization
```javascript
// Extract complex queries to constants at top of file
const GET_USER_PASSES_QUERY = `
  SELECT rp.*, u.email as redeemed_by_email
  FROM referral_passes rp
  JOIN subscriptions s ON rp.subscription_id = s.id
  LEFT JOIN users u ON rp.redeemed_by_user_id = u.id
  WHERE rp.user_id = $1 AND s.status = 'active'
  ORDER BY rp.created_at DESC
`;

async function getUserPasses(userId) {
  const result = await pool.query(GET_USER_PASSES_QUERY, [userId]);
  return result.rows;
}
```

---

## Error Handling

### Custom Error Classes
```javascript
// src/utils/errors.js
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
    this.error = 'Validation error';
  }
}

class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
    this.status = 409;
    this.error = 'Conflict';
  }
}

class GoneError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GoneError';
    this.status = 410;
    this.error = 'Gone';
  }
}
```

### Service Layer Error Throwing
```javascript
// Services throw semantic errors
async function redeemPass(token, userId) {
  const pass = await getPassByToken(token);
  
  if (!pass) {
    throw new NotFoundError('Pass not found');
  }
  
  if (pass.is_redeemed) {
    throw new ConflictError('This pass has already been redeemed');
  }
  
  if (pass.expires_at < new Date()) {
    throw new GoneError('This pass has expired');
  }
  
  // Continue with redemption...
}
```

### Controller Layer Error Handling
```javascript
// Controllers catch and pass to error middleware
async function redeemPass(req, res, next) {
  try {
    const { token } = req.body;
    
    if (!token) {
      throw new ValidationError('Token is required');
    }
    
    const subscription = await ReferralService.redeemPass(token, req.user.id);
    
    res.status(201).json({
      success: true,
      message: '7-day trial activated successfully!',
      data: subscription
    });
    
  } catch (error) {
    next(error); // Pass to error middleware
  }
}
```

### Error Middleware
```javascript
// src/middleware/errorHandler.js
function errorHandler(err, req, res, next) {
  console.error('Error:', err);
  
  const statusCode = err.status || 500;
  const error = err.error || 'Internal server error';
  
  // Don't leak stack traces in production
  const message = process.env.NODE_ENV === 'development'
    ? err.message
    : (statusCode === 500 ? 'An unexpected error occurred' : err.message);
  
  res.status(statusCode).json({
    success: false,
    error,
    message
  });
}

module.exports = errorHandler;
```

---

## Validation

### Input Validation Pattern
```javascript
// Validate at controller entry point
async function redeemPass(req, res, next) {
  try {
    const { token } = req.body;
    
    // Validate required fields
    if (!token) {
      throw new ValidationError('Token is required');
    }
    
    if (typeof token !== 'string') {
      throw new ValidationError('Token must be a string');
    }
    
    // Delegate to service
    const subscription = await ReferralService.redeemPass(token, req.user.id);
    res.status(201).json({ success: true, data: subscription });
    
  } catch (error) {
    next(error);
  }
}
```

### Business Logic Validation
```javascript
// Validate business rules in service layer
async function redeemPass(token, recipientUserId) {
  const decoded = verifyJWT(token);
  const pass = await getPassByToken(token);
  
  // Business rule validations
  if (pass.user_id === recipientUserId) {
    throw new ValidationError('You cannot redeem your own referral pass');
  }
  
  if (pass.subscription_status !== 'active') {
    throw new ValidationError('Referrer no longer has an active subscription');
  }
  
  const eligible = await checkEligibility(recipientUserId);
  if (!eligible.eligible) {
    throw new ConflictError(eligible.reason);
  }
  
  // Proceed with redemption...
}
```

---

## Response Formatting

### Consistent Envelope
```javascript
// All responses use this format
const successResponse = {
  success: true,
  data: { ... },
  message: 'Optional human-readable message'
};

const errorResponse = {
  success: false,
  error: 'machine_readable_error_code',
  message: 'Human-readable error message'
};
```

### Data Transformation
```javascript
// Transform database rows to API response format
function formatPass(dbPass) {
  return {
    id: dbPass.id,
    token: dbPass.token,
    is_redeemed: dbPass.is_redeemed,
    redeemed_by: dbPass.redeemed_by_email || null,
    redeemed_at: dbPass.redeemed_at,
    expires_at: dbPass.expires_at,
    shareable_link: dbPass.is_redeemed 
      ? null 
      : generateShareableLink(dbPass.token)
  };
}

async function getUserPasses(userId) {
  const rows = await query(GET_USER_PASSES_QUERY, [userId]);
  
  const passes = rows.map(formatPass);
  const available = passes.filter(p => !p.is_redeemed);
  const redeemed = passes.filter(p => p.is_redeemed);
  
  return {
    total_passes: 3,
    available_count: available.length,
    redeemed_count: redeemed.length,
    passes
  };
}
```

---

## Development Workflow

### TDD (Test-Driven Development) - Recommended Approach

**We build tests FIRST, then implementation.**

#### Why TDD for This Project?

1. **Complex business rules** - 14 edge cases, multiple validations
2. **Clear specifications** - docs/api/endpoints.md defines exact behavior
3. **Prevents regressions** - Refactoring won't break edge cases
4. **Forces good design** - If hard to test, design needs improvement

#### Red-Green-Refactor Cycle

```
1. RED: Write failing test
2. GREEN: Write minimal code to pass test
3. REFACTOR: Clean up while keeping tests green
4. REPEAT
```

---

### TDD Example: Building POST /api/referral/redeem

#### Step 1: Write Test First (RED)

```javascript
// tests/integration/api/referral.test.js
describe('POST /api/referral/redeem', () => {
  it('should create trial subscription when pass is valid', async () => {
    // Arrange
    const referrer = await createUserWithSubscription();
    const pass = await getFirstAvailablePass(referrer.id);
    const recipient = await createUser({ email: 'newuser@test.com' });
    
    // Act
    const response = await request(app)
      .post('/api/referral/redeem')
      .set('x-user-id', recipient.id)
      .send({ token: pass.token });
    
    // Assert
    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.data.status).toBe('trial');
    expect(response.body.data.tier).toBe('digital');
    
    // Verify in database
    const subscription = await getSubscription(recipient.id);
    expect(subscription.is_trial).toBe(true);
    expect(subscription.trial_end_date).toBeDefined();
  });
});
```

Run test: `npm test` → FAILS (route doesn't exist yet)

#### Step 2: Implement Minimal Code (GREEN)

```javascript
// src/routes/referral.js
router.post('/redeem', auth, controller.redeemPass);

// src/controllers/referralController.js
async function redeemPass(req, res, next) {
  try {
    const { token } = req.body;
    const subscription = await ReferralService.redeemPass(token, req.user.id);
    res.status(201).json({ success: true, data: subscription });
  } catch (error) {
    next(error);
  }
}

// src/services/ReferralService.js
async function redeemPass(token, recipientUserId) {
  // Minimal implementation to pass test
  const trialEndDate = new Date();
  trialEndDate.setDate(trialEndDate.getDate() + 7);
  
  const subscription = await pool.query(
    `INSERT INTO subscriptions (user_id, tier, status, is_trial, trial_end_date)
     VALUES ($1, 'digital', 'trial', true, $2)
     RETURNING *`,
    [recipientUserId, trialEndDate]
  );
  
  return subscription.rows[0];
}
```

Run test: `npm test` → PASSES (but incomplete)

#### Step 3: Add Edge Case Test (RED)

```javascript
it('should reject if pass already redeemed', async () => {
  const referrer = await createUserWithSubscription();
  const pass = await getFirstAvailablePass(referrer.id);
  
  // First redemption
  await redeemPass(pass.token, user1.id);
  
  // Second redemption attempt
  const response = await request(app)
    .post('/api/referral/redeem')
    .set('x-user-id', user2.id)
    .send({ token: pass.token });
  
  expect(response.status).toBe(409);
  expect(response.body.error).toBe('Pass already redeemed');
});
```

Run test: `npm test` → FAILS (doesn't check if redeemed)

#### Step 4: Add Validation (GREEN)

```javascript
async function redeemPass(token, recipientUserId) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Get pass
    const passResult = await client.query(
      'SELECT * FROM referral_passes WHERE token = $1',
      [token]
    );
    
    if (passResult.rows.length === 0) {
      throw new NotFoundError('Pass not found');
    }
    
    const pass = passResult.rows[0];
    
    // NEW: Check if already redeemed
    if (pass.is_redeemed) {
      throw new ConflictError('This pass has already been redeemed');
    }
    
    // Create trial
    const subscription = await client.query(/*...*/);
    
    // Mark pass as redeemed
    await client.query(
      `UPDATE referral_passes 
       SET is_redeemed = true, redeemed_by_user_id = $1, redeemed_at = NOW()
       WHERE id = $2`,
      [recipientUserId, pass.id]
    );
    
    await client.query('COMMIT');
    return subscription.rows[0];
    
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
```

Run test: `npm test` → PASSES

#### Step 5: Repeat for All 14 Edge Cases

Continue this cycle for each edge case from docs/architecture/edge-cases.md:
1. Write test that fails
2. Add validation to pass test
3. Refactor if needed
4. Move to next edge case

---

### TDD Build Order (Recommended)

#### Week 1: Foundation
```
Day 1: Database schema + database tests
  - Test triggers fire correctly
  - Test constraints prevent invalid data
  - Test email normalization function

Day 2: Unit tests for utilities
  - EmailService.normalize() tests
  - JWT generation/verification tests
  - Date helper tests

Day 3: GET /api/referral/passes (read-only, simpler)
  - Test happy path
  - Test with no passes
  - Test authentication required
```

#### Week 2: Core Features
```
Day 1: GET /api/referral/eligibility
  - Test eligible user
  - Test active subscription (ineligible)
  - Test 12mo cooldown
  - Test 24mo trial cooldown

Day 2-3: POST /api/referral/redeem (complex)
  - Test happy path first
  - Add edge cases one by one:
    1. Missing token
    2. Invalid token
    3. Pass not found
    4. Already redeemed
    5. Expired
    6. Self-redemption
    7. Referrer inactive
    8. User already subscribed
    9. 12mo cooldown
    10. 24mo trial cooldown
    11. Email normalization

Day 4: GET /api/referral/stats
  - Test with no redemptions
  - Test with redemptions
  - Test privacy (only show email)
```

---

### Test Structure by Layer

#### 1. Database Tests (tests/database/)
Test PostgreSQL functions and triggers directly

```javascript
// tests/database/triggers.test.js
describe('generate_referral_passes trigger', () => {
  it('should create 3 passes when subscription becomes active', async () => {
    const user = await createUser();
    
    await pool.query(
      `INSERT INTO subscriptions (user_id, tier, status, is_trial)
       VALUES ($1, 'digital', 'active', false)`,
      [user.id]
    );
    
    const passes = await pool.query(
      'SELECT * FROM referral_passes WHERE user_id = $1',
      [user.id]
    );
    
    expect(passes.rows.length).toBe(3);
  });
  
  it('should NOT create passes for trial subscriptions', async () => {
    const user = await createUser();
    
    await pool.query(
      `INSERT INTO subscriptions (user_id, tier, status, is_trial)
       VALUES ($1, 'digital', 'trial', true)`,
      [user.id]
    );
    
    const passes = await pool.query(
      'SELECT * FROM referral_passes WHERE user_id = $1',
      [user.id]
    );
    
    expect(passes.rows.length).toBe(0);
  });
});

// tests/database/functions.test.js
describe('normalize_email function', () => {
  it('should normalize Gmail +alias', async () => {
    const result = await pool.query(
      `SELECT normalize_email('user+test@gmail.com') as normalized`
    );
    expect(result.rows[0].normalized).toBe('user@gmail.com');
  });
  
  it('should remove Gmail dots', async () => {
    const result = await pool.query(
      `SELECT normalize_email('john.doe@gmail.com') as normalized`
    );
    expect(result.rows[0].normalized).toBe('johndoe@gmail.com');
  });
});
```

#### 2. Unit Tests (tests/unit/)
Test individual functions in isolation

```javascript
// tests/unit/services/EmailService.test.js
describe('EmailService.normalize', () => {
  it('should match PostgreSQL normalize_email behavior', async () => {
    const testCases = [
      ['user+1@gmail.com', 'user@gmail.com'],
      ['john.doe@gmail.com', 'johndoe@gmail.com'],
      ['test+alias@outlook.com', 'test@outlook.com'],
      ['user-test@yahoo.com', 'user@yahoo.com'],
    ];
    
    for (const [input, expected] of testCases) {
      expect(EmailService.normalize(input)).toBe(expected);
    }
  });
});

// tests/unit/utils/jwt.test.js
describe('JWT utilities', () => {
  it('should generate valid token', () => {
    const token = generatePassToken('pass-123', 'user-456');
    const decoded = jwt.verify(token, JWT_SECRET);
    
    expect(decoded.passId).toBe('pass-123');
    expect(decoded.referrerId).toBe('user-456');
    expect(decoded.type).toBe('referral_pass');
  });
  
  it('should reject expired token', () => {
    const token = generatePassToken('pass-123', 'user-456', { expiresIn: '0s' });
    
    expect(() => {
      jwt.verify(token, JWT_SECRET);
    }).toThrow('jwt expired');
  });
});
```

#### 3. Integration Tests (tests/integration/)
Test HTTP API end-to-end

```javascript
// tests/integration/api/referral.test.js
describe('Referral API Integration', () => {
  let app;
  let referrer;
  let recipient;
  
  beforeAll(async () => {
    app = require('../../src/server');
    await setupTestDatabase();
  });
  
  beforeEach(async () => {
    await cleanDatabase();
    referrer = await createUserWithSubscription();
    recipient = await createUser();
  });
  
  describe('POST /api/referral/redeem', () => {
    it('should complete full redemption flow', async () => {
      // Get pass
      const passResponse = await request(app)
        .get('/api/referral/passes')
        .set('x-user-id', referrer.id);
      
      const token = passResponse.body.data.passes[0].token;
      
      // Redeem pass
      const redeemResponse = await request(app)
        .post('/api/referral/redeem')
        .set('x-user-id', recipient.id)
        .send({ token });
      
      expect(redeemResponse.status).toBe(201);
      
      // Verify pass marked as redeemed
      const updatedPassResponse = await request(app)
        .get('/api/referral/passes')
        .set('x-user-id', referrer.id);
      
      const redeemedPass = updatedPassResponse.body.data.passes
        .find(p => p.token === token);
      
      expect(redeemedPass.is_redeemed).toBe(true);
      expect(redeemedPass.redeemed_by).toBe(recipient.email);
    });
  });
});
```

---

### Testing Guidelines



### Test File Naming
```
src/services/ReferralService.js
-> tests/unit/services/ReferralService.test.js

src/controllers/referralController.js
-> tests/integration/api/referral.test.js
```

### Test Structure
```javascript
describe('ReferralService.redeemPass', () => {
  // Setup
  beforeEach(async () => {
    await setupTestDatabase();
  });
  
  afterEach(async () => {
    await cleanupTestDatabase();
  });
  
  // Happy path first
  it('should create trial subscription when pass is valid', async () => {
    const token = await createValidPass();
    const result = await ReferralService.redeemPass(token, newUserId);
    
    expect(result.status).toBe('trial');
    expect(result.is_trial).toBe(true);
  });
  
  // Then edge cases (grouped by error type)
  describe('validation errors (400)', () => {
    it('should reject invalid token format', async () => {
      await expect(
        ReferralService.redeemPass('invalid', newUserId)
      ).rejects.toThrow('Invalid referral token');
    });
    
    it('should reject self-redemption', async () => {
      const token = await createPassForUser(userId);
      await expect(
        ReferralService.redeemPass(token, userId)
      ).rejects.toThrow('Cannot redeem your own referral pass');
    });
  });
  
  describe('conflict errors (409)', () => {
    it('should reject already redeemed pass', async () => {
      const token = await createAndRedeemPass();
      await expect(
        ReferralService.redeemPass(token, anotherUserId)
      ).rejects.toThrow('Pass already redeemed');
    });
  });
});
```

### Test Data
```javascript
// Use factory functions for test data
function createTestUser(overrides = {}) {
  return {
    id: uuidv4(),
    email: 'test@example.com',
    email_normalized: 'test@example.com',
    password_hash: 'hashed_password',
    ...overrides
  };
}

function createTestSubscription(userId, overrides = {}) {
  return {
    id: uuidv4(),
    user_id: userId,
    tier: 'digital',
    status: 'active',
    is_trial: false,
    ...overrides
  };
}
```

---

## Security Practices

### Never Log Sensitive Data
```javascript
// BAD: Logs password
console.log('User login:', { email, password });

// GOOD: Sanitize before logging
console.log('User login:', { email, passwordLength: password.length });

// GOOD: Use placeholder for tokens
console.log('Redeeming pass:', { token: token.substring(0, 10) + '...' });
```

### Environment Variables
```javascript
// BAD: Hardcoded secrets
const JWT_SECRET = 'my-secret-key';

// GOOD: From environment
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required');
}

// GOOD: Validate on startup
function validateEnvironment() {
  const required = ['JWT_SECRET', 'DB_PASSWORD', 'DB_HOST'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}
```

### Rate Limiting (Future)
```javascript
// When implementing rate limiting
const rateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 requests per window
  message: 'Too many redemption attempts, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

app.post('/api/referral/redeem', rateLimiter, redeemPass);
```

---

## Performance Considerations

### Database Connection Pooling
```javascript
// config/database.js
const pool = new Pool({
  max: 20,                      // Maximum pool size
  idleTimeoutMillis: 30000,     // Close idle clients after 30s
  connectionTimeoutMillis: 2000, // Fail fast if can't connect
});

// Always use pool.query() for one-off queries
// Only use pool.connect() for transactions
```

### Query Optimization
```javascript
// BAD: N+1 query problem
async function getPassesWithDetails(userId) {
  const passes = await query('SELECT * FROM referral_passes WHERE user_id = $1', [userId]);
  
  for (const pass of passes) {
    const user = await query('SELECT email FROM users WHERE id = $1', [pass.redeemed_by_user_id]);
    pass.redeemed_by_email = user.email;
  }
  
  return passes;
}

// GOOD: Single query with JOIN
async function getPassesWithDetails(userId) {
  const result = await query(`
    SELECT rp.*, u.email as redeemed_by_email
    FROM referral_passes rp
    LEFT JOIN users u ON rp.redeemed_by_user_id = u.id
    WHERE rp.user_id = $1
  `, [userId]);
  
  return result.rows;
}
```

### Avoid Over-Fetching
```javascript
// BAD: Fetching entire row when only need one field
const user = await query('SELECT * FROM users WHERE id = $1', [userId]);
const email = user.email;

// GOOD: Select only what you need
const result = await query('SELECT email FROM users WHERE id = $1', [userId]);
const email = result.rows[0].email;
```

---

## Documentation Standards

### Function JSDoc
```javascript
/**
 * Redeem a referral pass and create a trial subscription
 * 
 * @param {string} token - JWT referral token
 * @param {string} recipientUserId - UUID of user redeeming the pass
 * @returns {Promise<Object>} Created trial subscription
 * @throws {ValidationError} If token is invalid or self-redemption
 * @throws {ConflictError} If pass already redeemed or user ineligible
 * @throws {GoneError} If pass or token expired
 * 
 * See docs/api/endpoints.md POST /api/referral/redeem for full spec
 */
async function redeemPass(token, recipientUserId) {
  // Implementation...
}
```

### README in Each Folder
```
src/services/README.md

# Services Layer

Contains all business logic and orchestration.

## Responsibilities
- Validate business rules
- Coordinate between models
- Throw semantic errors
- Return formatted data

## Guidelines
- Services should not know about HTTP (no req/res)
- Services should not know about database structure (use models)
- All database operations in transactions if multi-step

## Files
- ReferralService.js - Pass generation, redemption, stats
- SubscriptionService.js - Subscription management
- EmailService.js - Email normalization
```

---

## Git Commit Messages

### Format
```
<type>: <subject>

<body>

<footer>
```

### Types
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation only
- `refactor`: Code change that neither fixes a bug nor adds a feature
- `test`: Adding or updating tests
- `chore`: Changes to build process or auxiliary tools

### Examples
```
feat: implement pass redemption endpoint

- Add POST /api/referral/redeem route
- Implement 11-step validation in ReferralService
- Handle all error cases per docs/api/errors.md

Closes #12

---

fix: prevent concurrent pass redemption

Use SERIALIZABLE transaction isolation level to prevent race
condition where two users could redeem the same pass simultaneously.

See docs/architecture/edge-cases.md #10

---

refactor: extract email normalization to utility

Move email normalization logic from service to utils/email.js
for better reusability and testing.

No functional changes.
```

---

## Critical Edge Cases (Reference)

When implementing, pay special attention to these from docs/architecture/edge-cases.md:

1. **Pass already redeemed** (409) - Transaction isolation handles race condition
2. **Email normalization** (409) - Prevents Gmail +alias abuse
3. **Cooldown periods** (409) - 12mo subscription + 24mo trial
4. **Self-redemption** (400) - Compare JWT referrerId to recipientUserId
5. **Referrer inactive** (400) - Check subscription status on redemption
6. **Token expiration** (410) - Dual expiration: JWT + database field
7. **Concurrent redemption** (409) - SERIALIZABLE isolation level

---

## Common Patterns

### Async/Await Error Handling
```javascript
// Pattern 1: Try-catch in controller
async function controllerFunction(req, res, next) {
  try {
    const result = await serviceCall();
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
}

// Pattern 2: Let errors bubble (if error middleware configured)
async function serviceFunction() {
  const data = await database.query();
  
  if (!data) {
    throw new NotFoundError('Resource not found');
  }
  
  return data; // No try-catch needed - error middleware handles it
}
```

### Conditional Logic
```javascript
// Use early returns for readability
async function checkEligibility(userId) {
  const activeCount = await getActiveSubscriptionCount(userId);
  if (activeCount > 0) {
    return { eligible: false, reason: 'User already has an active subscription' };
  }
  
  const recentSubCount = await getRecentSubscriptionCount(userId);
  if (recentSubCount > 0) {
    return { eligible: false, reason: 'User had subscription within 12 months' };
  }
  
  const recentTrialCount = await getRecentTrialCount(userId);
  if (recentTrialCount > 0) {
    return { eligible: false, reason: 'User had trial within 24 months' };
  }
  
  return { eligible: true, reason: null };
}
```

### Date Handling
```javascript
// Use Date objects, not strings
const trialEndDate = new Date();
trialEndDate.setDate(trialEndDate.getDate() + 7);

// Store as ISO string for database
await query(
  'INSERT INTO subscriptions (trial_end_date) VALUES ($1)',
  [trialEndDate.toISOString()]
);

// Compare dates properly
if (new Date(pass.expires_at) < new Date()) {
  throw new GoneError('Pass has expired');
}
```

---

## When in Doubt

1. **Check the docs**: `/docs` folder has authoritative specs
2. **Follow the pattern**: Look at existing code in similar files
3. **Ask for clarification**: Better to ask than assume
4. **Keep it simple**: Don't over-engineer
5. **Test as you go**: Don't wait until the end

---

## Reference Documentation

- **API Spec**: `docs/api/endpoints.md`
- **Error Codes**: `docs/api/errors.md`
- **Edge Cases**: `docs/architecture/edge-cases.md`
- **Database Schema**: `docs/database/schema.md`
- **Project Structure**: `PROJECT_STRUCTURE.md`

---

## Quick Command Reference

```bash
# Start development server
npm run dev

# Run tests (do this OFTEN during TDD)
npm test

# Run tests in watch mode (best for TDD)
npm test -- --watch

# Run specific test file
npm test -- tests/unit/services/ReferralService.test.js

# Run with coverage
npm test -- --coverage

# Database operations
npm run db:setup     # Create database and run schema
npm run db:seed      # Load sample data
npm run db:migrate   # Run migrations
npm run db:test      # Run database-level tests

# Check code style
npm run lint

# Format code
npm run format
```

---

## TDD Prompt Templates for AI

### Starting a New Feature

```
I'm building [feature] using TDD.

First, write the test for the happy path in tests/[type]/[feature].test.js

Test should:
- Follow CLAUDE.md test structure
- Use arrange-act-assert pattern
- Have descriptive test name
- Use test data factories from CLAUDE.md

Don't write implementation yet - just the test.
```

### After Test is Written

```
Here's my failing test: [paste test]

Now write the MINIMAL implementation to make it pass.

Follow:
- CLAUDE.md error handling patterns
- CLAUDE.md database transaction pattern (if needed)
- docs/api/endpoints.md spec

Keep it simple - just enough to pass the test.
```

### Adding Edge Case

```
The happy path test passes. Now add a test for this edge case:
[describe edge case from docs/architecture/edge-cases.md]

Then update the implementation to handle it.

Follow CLAUDE.md error classes for the right HTTP status code.
```

---

**Last Updated**: v2.0 - March 2026 (TDD workflow added)
**Maintained By**: Engineering team
**Questions**: See `/docs` or ask in #engineering-help