# Security architecture (v2)

This document summarizes the **security model** of the Atlantic Referral Program and highlights the v2 hardenings called out in `DESIGN_DOC.MD` and `Changelog.md`.

Per `CLAUDE.MD`: **never trust client input**, treat the **database as the source of truth**, and use **ACID transactions** for critical flows like redemption.

## 1) Email normalization (v2 critical fix)

### Attack vector explanation

Many providers support email aliasing that maps multiple strings to the same inbox (Gmail `+` aliases and dot-ignoring are the canonical example). Without protection, one person can create multiple accounts and redeem unlimited trials.

Example attack:

```
user+1@gmail.com -> Account A -> Trial #1
user+2@gmail.com -> Account B -> Trial #2
john.doe@gmail.com vs johndoe@gmail.com -> both same inbox
```

### How normalization prevents it

v2 introduces a canonical form `email_normalized` that collapses provider aliases into a stable identity. A **unique constraint/index** on `email_normalized` prevents creating multiple accounts for the same inbox.

### Implementation details

- **Schema**:
  - `users.email_normalized` (UNIQUE, NOT NULL)
- **Normalization function**:
  - `normalize_email(email TEXT)` handles Gmail/Googlemail, Outlook/Hotmail, Yahoo, ProtonMail, and generic `+` stripping.
- **Trigger**:
  - `trigger_normalize_email` (BEFORE INSERT / UPDATE OF email) calls `set_normalized_email()` to keep `email_normalized` consistent with `email`.
- **Enforcement**:
  - Unique index/constraint on `users.email_normalized` ensures the database rejects duplicates.

Operational note:
- This can block “legitimate” use of `+` aliases for inbox filtering. v2 recommends a clear user-facing message explaining aliases are not supported to prevent abuse.

## 2) JWT security model

### JWT is authentication, DB is authorization

v2 clarifies a key rule:

- **JWT** proves the token was issued by us and has not been tampered with (authentication / integrity of the token).
- **PostgreSQL** remains the **source of truth** for whether the token should be honored (authorization), based on current subscription/pass state.

Why it matters (from `Changelog.md`):

```
T0: Referrer shares token
T1: Referrer subscription cancelled
T2: Recipient clicks link (JWT still valid)
T3: DB shows subscription inactive -> reject
```

### Why we can’t revoke JWTs (by default)

JWTs are self-contained and validated by signature; there is no built-in “check with issuer” step. Once issued, a JWT remains valid until `exp`, unless you add additional state (e.g., a server-side revocation list).

`DESIGN_DOC.MD` notes a possible mitigation (not implemented for MVP): a Redis blacklist of revoked tokens.

### Dual validation approach (recommended)

On redemption, validate both:

1. **JWT validity**: signature + expiration (`jwt.verify`)
2. **Database state**:
   - Pass exists and is not redeemed
   - Pass not expired (`expires_at`)
   - Referrer subscription still active and not a trial
   - Recipient eligibility (cooldowns)

This ensures “token says yes” is never sufficient without “database says yes”.

## 3) Transaction isolation

### Preventing concurrent redemption

The primary race condition is two recipients redeeming the same pass simultaneously. Without protection, both could read `is_redeemed = false` and each create a trial.

### SERIALIZABLE isolation level

`DESIGN_DOC.MD` calls out PostgreSQL `SERIALIZABLE` isolation for the redemption transaction:

```sql
BEGIN ISOLATION LEVEL SERIALIZABLE;
-- read validations + writes
COMMIT;
```

### How it works (high level)

PostgreSQL detects conflicting concurrent writes under `SERIALIZABLE` and aborts one transaction with a serialization failure. The application should roll back and retry, after which it will observe `is_redeemed = true` and return a conflict.

Practical defense-in-depth:
- Use `SERIALIZABLE` **and** a conditional update (`WHERE is_redeemed = false`) so only one transaction can “claim” the pass row.

### Retry strategy for serialization failures

When two requests hit the same pass simultaneously, PostgreSQL aborts one with error code `40001` (serialization failure). The application must handle this gracefully:

```javascript
async function redeemPassWithRetry(token, userId, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await redeemPass(token, userId);
    } catch (error) {
      // PostgreSQL serialization failure code
      if (error.code === '40001' && attempt < maxRetries) {
        // Exponential backoff: 100ms → 200ms → 400ms
        const delay = 100 * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
}
```

**Client-visible behavior**:
- If a retry succeeds → `201 Created` (client sees nothing unusual)
- If all retries exhausted → re-throw; the pass was almost certainly already redeemed on the winning request, so the caller sees `409 Conflict` with "Pass already redeemed"
- Never expose retry count or serialization error codes to the client

---

## 4) Cooldown periods

v2 changes eligibility from “one trial ever” to a balanced model:

- **12-month subscription cooldown**: recipients who ended a subscription within the last 12 months are ineligible.
- **24-month trial cooldown**: recipients who had a trial within the last 24 months are ineligible.

### Prevents gaming the system

Cooldowns are designed to stop systematic cycling (subscribe → cancel → trial → repeat) while still enabling win-back for long-lapsed users.

Implementation:
- Centralize the decision in `is_user_eligible_for_trial(p_user_id UUID)` so all application code paths get the same answer.

## 5) Input validation

### Never trust client input

Every external input (headers, body fields, tokens) must be validated. Controllers should reject missing/invalid types early; services enforce business rules.

### Prepared statements (SQL injection prevention)

All database access should use parameterized queries:

```sql
SELECT * FROM referral_passes WHERE token = $1;
```

Never interpolate token/user input into SQL strings.

### Business rule validation

Even when inputs are well-formed, business rules can fail:

- Self-redemption
- Referrer subscription inactive
- Pass expired or already redeemed
- Recipient ineligible due to cooldown rules

These should map to the documented HTTP status codes (400/401/404/409/410), with consistent error envelopes.

## 6) Security checklist for implementation

- [ ] **Email normalization**
  - [ ] `users.email_normalized` exists and is populated via trigger
  - [ ] Unique index/constraint on `email_normalized`
  - [ ] Normalization covers Gmail/Outlook/Yahoo/Proton + generic `+`

- [ ] **Token handling**
  - [ ] Always `jwt.verify` tokens (signature + expiry)
  - [ ] Validate token `type` (e.g., `referral_pass`)
  - [ ] Never log full tokens (log only prefixes if needed)

- [ ] **Authorization via DB**
  - [ ] Always check referrer subscription status during redemption
  - [ ] Always check pass state (exists, not redeemed, not expired)

- [ ] **Transactional redemption**
  - [ ] Redemption runs in a single transaction
  - [ ] Use `SERIALIZABLE` (or an equivalent robust approach) to prevent double redemption
  - [ ] Conditional update to claim a pass (`... WHERE is_redeemed = false`)
  - [ ] Retry strategy for serialization failures

- [ ] **Eligibility**
  - [ ] Use `is_user_eligible_for_trial()` (12mo + 24mo cooldowns)
  - [ ] Ensure reasons/messages are user-friendly (don’t leak sensitive details)

- [ ] **Input validation**
  - [ ] Missing authentication → 401
  - [ ] Missing/invalid token → 400
  - [ ] Pass not found → 404
  - [ ] Pass already redeemed / eligibility conflicts → 409
  - [ ] Expired token/pass → 410
  - [ ] Unexpected DB errors → 500 (no sensitive leakage)

