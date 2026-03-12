# Edge cases & error handling (v2)

This document is a **testing + implementation reference** for the Atlantic Referral Program. It enumerates the **14 edge cases** called out in `DESIGN_DOC.MD` (“Edge Cases & Error Handling”) and standardizes how the API should detect and respond to each.

Per `CLAUDE.MD`:

- The **database is the source of truth** for subscription/pass state and eligibility.
- **Redemption is transactional**: failures must not create partial state.
- API responses use a consistent envelope.

## Response envelope (standard)

Success:

```json
{
  "success": true,
  "data": { },
  "message": "Optional human-readable text"
}
```

Error:

```json
{
  "success": false,
  "error": "machine_readable_or_short_error",
  "message": "Human-readable explanation"
}
```

---

## 1) Pass already redeemed (409)

### Scenario description
A pass token is redeemed successfully by User A. Later, User B attempts to redeem the same token.

### Detection method (code example)

```sql
SELECT is_redeemed
FROM referral_passes
WHERE token = $1;
-- if is_redeemed = TRUE -> conflict
```

### HTTP status code
`409 Conflict`

### Response format

```json
{
  "success": false,
  "error": "Pass already redeemed",
  "message": "This pass has already been redeemed"
}
```

### Prevention/handling strategy
- Validate `is_redeemed = FALSE` before creating a trial.
- In redemption transaction, prefer an atomic update pattern:

```sql
UPDATE referral_passes
SET is_redeemed = TRUE
WHERE id = $1 AND is_redeemed = FALSE
RETURNING id;
```

- Transaction isolation (see edge case #10) prevents double-redemption under concurrency.

### Why it matters (business impact)
Prevents issuing **multiple free trials** from a single pass, protecting revenue and preserving referral fairness.

---

## 2) User has active subscription (409)

### Scenario description
A recipient tries to redeem a referral pass while they already have an **active** subscription.

### Detection method (code example)

```sql
SELECT is_user_eligible_for_trial($1);
-- returns FALSE if an active subscription exists
```

### HTTP status code
`409 Conflict`

### Response format

```json
{
  "success": false,
  "error": "Already subscribed",
  "message": "User already has an active subscription"
}
```

### Prevention/handling strategy
- Centralize the rule in `is_user_eligible_for_trial(p_user_id UUID)` and call it during redemption.
- Ensure the UI can check eligibility before showing the “Redeem” action (optional helper endpoint).

### Why it matters (business impact)
Prevents giving free trials to paying customers and avoids confusing product experiences.

---

## 3) User recently subscribed <12mo (409)

### Scenario description
A recipient had any subscription (paid **or trial**) that ended within the last 12 months and attempts to redeem a new trial.

### Detection method (code example)

```sql
SELECT is_user_eligible_for_trial($1);
-- returns FALSE if any subscription has end_date within the last 12 months
```

### HTTP status code
`409 Conflict`

### Response format

```json
{
  "success": false,
  "error": "Recently subscribed",
  "message": "User had a subscription within the last 12 months"
}
```

**Note on Rule 2 scope**: The eligibility function checks `end_date IS NOT NULL AND end_date > NOW() - INTERVAL '12 months'` — this matches both ended paid subscriptions *and* expired/cancelled trials. A user whose trial expired 6 months ago is blocked by this rule, not Rule 3. Rule 3 (24-month trial cooldown) only applies to trials whose `start_date` is within 24 months, regardless of whether Rule 2 also fires.

### Prevention/handling strategy
- Enforce cooldown logic at the database function level.
- Keep cooldown values configurable in future iterations (A/B testing), but stored/implemented centrally.

### Why it matters (business impact)
Balances acquisition with revenue protection: discourages churn-to-trial cycling while still enabling long-lapsed win-back (see v2 rationale).

---

## 4) User had trial <24mo (409)

### Scenario description
A recipient previously received a trial within the last 24 months and attempts to redeem another.

### Detection method (code example)

```sql
SELECT is_user_eligible_for_trial($1);
-- returns FALSE if a trial start_date is within the last 24 months
```

### HTTP status code
`409 Conflict`

### Response format

```json
{
  "success": false,
  "error": "Recent trial",
  "message": "User had a trial within the last 24 months"
}
```

### Prevention/handling strategy
- Use the 24-month trial cooldown in `is_user_eligible_for_trial()`.
- Treat this as a “retry won’t help” condition; guide the user to subscription offers instead.

### Why it matters (business impact)
Prevents long-term “free access” gaming that would otherwise reduce paid conversions.

---

## 5) Email alias abuse (409)

### Scenario description
A malicious user creates multiple accounts that map to the same inbox via provider aliasing (e.g., Gmail `+` aliases, dots).

### Detection method (code example)

```sql
-- Trigger normalizes into users.email_normalized, backed by a UNIQUE index/constraint.
-- Second insert that normalizes to the same value fails.
INSERT INTO users (email, email_normalized)
VALUES ('user+2@gmail.com', 'user@gmail.com');

-- ERROR: duplicate key value violates unique constraint "users_email_normalized_key"
```

### HTTP status code
`409 Conflict`

### Response format

```json
{
  "success": false,
  "error": "Email already registered",
  "message": "An account with this email address already exists"
}
```

### Prevention/handling strategy
- Implement `normalize_email(email TEXT)`.
- Populate via trigger:

```sql
CREATE TRIGGER trigger_normalize_email
BEFORE INSERT OR UPDATE OF email ON users
FOR EACH ROW
EXECUTE FUNCTION set_normalized_email();
```

- Enforce uniqueness with `UNIQUE`/unique index on `users.email_normalized`.
- Handle the “legitimate +alias user” case with a clear message explaining aliases are not supported.

### Why it matters (business impact)
This closes a critical loophole that can lead to **infinite trials**, lost revenue, polluted conversion analytics, and increased support burden.

---

## 6) Self-redemption (400)

### Scenario description
A referrer attempts to redeem their own referral pass to obtain a trial (or repeat the cycle).

### Detection method (code example)

```javascript
const decoded = jwt.verify(token, JWT_SECRET); // contains referrerId
if (decoded.referrerId === recipientUserId) {
  throw new Error('Cannot self-redeem');
}
```

### HTTP status code
`400 Bad Request`

### Response format

```json
{
  "success": false,
  "error": "Cannot self-redeem",
  "message": "You cannot redeem your own referral pass"
}
```

### Prevention/handling strategy
- Compare `decoded.referrerId` with the authenticated recipient user id.
- Treat as a business-rule violation; do not leak token internals.

### Why it matters (business impact)
Prevents a “free subscription loop” (subscribe → get passes → cancel → redeem own pass → repeat).

---

## 7) Token expired (JWT) (410)

### Scenario description
The referral token (JWT) has passed its `exp` time and is no longer valid.

### Detection method (code example)

```javascript
try {
  jwt.verify(token, JWT_SECRET); // throws TokenExpiredError
} catch (err) {
  if (err.name === 'TokenExpiredError') {
    // return 410
  }
}
```

### HTTP status code
`410 Gone`

### Response format

```json
{
  "success": false,
  "error": "Token expired",
  "message": "This referral token has expired"
}
```

### Prevention/handling strategy
- Keep token lifetime bounded (design uses ~90 days).
- Still validate the referrer subscription status in the database (JWT is not authorization).

### Why it matters (business impact)
Limits the lifetime of leaked tokens and reduces the chance of old links reappearing unexpectedly.

---

## 8) Pass expired (DB field) (410)

### Scenario description
The pass row exists, but its database expiry (`expires_at`) is in the past.

### Detection method (code example)

```javascript
if (pass.expires_at && new Date(pass.expires_at) < new Date()) {
  // return 410
}
```

### HTTP status code
`410 Gone`

### Response format

```json
{
  "success": false,
  "error": "Pass expired",
  "message": "This pass has expired"
}
```

### Prevention/handling strategy
- Validate DB-level expiration during redemption even when JWT is valid.
- Use 410 to communicate “retry won’t help” vs “fix your request”.

### Why it matters (business impact)
Allows business-controlled expiration/revocation independent of JWT, and prevents redeeming stale offers.

---

## 9) Referrer subscription inactive (400)

### Scenario description
The referrer shared a pass while active, then cancelled; the recipient tries to redeem afterward.

### Detection method (code example)

```sql
SELECT s.status, s.is_trial
FROM referral_passes rp
JOIN subscriptions s ON rp.subscription_id = s.id
WHERE rp.token = $1;

-- if status != 'active' OR is_trial = TRUE -> reject
```

### HTTP status code
`400 Bad Request`

### Response format

```json
{
  "success": false,
  "error": "Referrer subscription inactive",
  "message": "Referrer no longer has an active subscription"
}
```

### Prevention/handling strategy
- Always check subscription status in the database at redemption time.
- Consider (future) a grace period design if product wants it; MVP rejects immediately.

### Why it matters (business impact)
Keeps referrals as a paid-subscriber perk and prevents ex-subscribers from distributing ongoing trials.

---

## 10) Concurrent redemption (409)

### Scenario description
Two recipients attempt to redeem the same pass at the same time, causing a race condition risk.

### Detection method (code example)

```javascript
await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
// ...
const result = await client.query(
  'UPDATE referral_passes SET is_redeemed = TRUE WHERE id = $1 AND is_redeemed = FALSE RETURNING id',
  [passId]
);
if (result.rowCount === 0) {
  throw new Error('Pass already redeemed');
}
```

### HTTP status code
`409 Conflict`

### Response format

```json
{
  "success": false,
  "error": "Pass already redeemed",
  "message": "This pass has already been redeemed"
}
```

### Prevention/handling strategy
- Use a single transaction for redemption.
- Use appropriate isolation (design calls out `SERIALIZABLE`) and/or conditional update to ensure only one redeemer succeeds.
- Retry on serialization failures and re-check `is_redeemed`.

### Why it matters (business impact)
Prevents issuing multiple trials from one pass and avoids inconsistent states under load.

---

## 11) Invalid/tampered token (400)

### Scenario description
The token is malformed, has an invalid signature, is the wrong “type”, or is otherwise tampered with.

### Detection method (code example)

```javascript
try {
  const decoded = jwt.verify(token, JWT_SECRET);
  if (decoded.type !== 'referral_pass') {
    throw new Error('Invalid token type');
  }
} catch (err) {
  // return 400
}
```

### HTTP status code
`400 Bad Request`

### Response format

```json
{
  "success": false,
  "error": "Invalid token",
  "message": "Invalid referral token"
}
```

### Prevention/handling strategy
- Verify signature and required claims.
- Never trust token claims without validating against database state.

### Why it matters (business impact)
Protects against forging, token guessing, and accidental corruption; reduces fraud and support incidents.

---

## 12) Missing authentication (401)

### Scenario description
The request is unauthenticated (missing `x-user-id` in development, or missing/invalid auth in production).

### Detection method (code example)

```javascript
const userId = req.headers['x-user-id'];
if (!userId) {
  return res.status(401).json({
    success: false,
    error: 'Unauthorized',
    message: 'x-user-id header required for authentication'
  });
}
```

### HTTP status code
`401 Unauthorized`

### Response format

```json
{
  "success": false,
  "error": "Unauthorized",
  "message": "x-user-id header required for authentication"
}
```

### Prevention/handling strategy
- Enforce authentication middleware for protected routes.
- In production, replace the development header with session cookies or `Authorization: Bearer ...`.

### Why it matters (business impact)
Stops unauthorized access to passes and prevents anonymous redemption attempts.

---

## 13) Pass doesn’t exist (404)

### Scenario description
The token is a valid JWT, but there is no matching pass row (deleted, cascaded, or never existed).

### Detection method (code example)

```sql
SELECT *
FROM referral_passes
WHERE token = $1;
-- returns 0 rows
```

### HTTP status code
`404 Not Found`

### Response format

```json
{
  "success": false,
  "error": "Pass not found",
  "message": "This referral pass does not exist"
}
```

### Prevention/handling strategy
- Lookup pass by token inside the redemption transaction.
- Avoid revealing whether a token is “almost valid”; keep the message generic enough for security.

### Why it matters (business impact)
Improves user clarity (link is invalid) and helps support/debugging while reducing information leakage.

---

## 14) Database connection failure (500)

### Scenario description
The API cannot query PostgreSQL (DB down, network partition, pool exhaustion).

### Detection method (code example)

```javascript
try {
  await pool.query('SELECT 1');
} catch (error) {
  // error middleware -> 500
}
```

### HTTP status code
`500 Internal Server Error`

### Response format

```json
{
  "success": false,
  "error": "Internal server error",
  "message": "Please try again later"
}
```

### Prevention/handling strategy
- Connection pooling and timeouts.
- Health checks and monitoring/alerting.
- Consider circuit breaking to avoid stampeding a failing DB.

### Why it matters (business impact)
Protects user experience and operational stability; reduces cascading failures during outages.

