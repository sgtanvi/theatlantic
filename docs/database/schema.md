# Database Schema Reference

The Atlantic Referral Program — PostgreSQL schema for managing subscriptions, referral passes, and trial eligibility.

---

## Overview

| Table | Purpose |
|-------|---------|
| `users` | All user accounts with email normalization for abuse prevention |
| `subscriptions` | Unified table for trials and paid subscriptions |
| `referral_passes` | Individual shareable passes (3 per active subscription) |
| `subscription_history` | Append-only audit log of all subscription state changes |

---

## Tables

### `users`

**Purpose**: Store all user accounts.

| Column | Type | Constraints | Rationale |
|--------|------|-------------|-----------|
| id | UUID | PK, DEFAULT gen_random_uuid() | Better distribution than auto-increment, no info leakage |
| email | VARCHAR(255) | UNIQUE, NOT NULL | Primary login identifier (display version) |
| email_normalized | VARCHAR(255) | UNIQUE, NOT NULL | Canonicalized for abuse prevention |
| password_hash | VARCHAR(255) | NOT NULL | bcrypt hashed (never store plaintext) |
| first_name | VARCHAR(100) | | Personalization |
| last_name | VARCHAR(100) | | Personalization |
| created_at | TIMESTAMP | DEFAULT NOW() | Audit trail |
| updated_at | TIMESTAMP | DEFAULT NOW() | Audit trail |

**Indexes**:
- Primary key on `id` (clustered)
- Unique index on `email` (for display/login)
- Unique index on `email_normalized` (for eligibility checks, abuse prevention)

**Design Decisions**:
- UUID over serial: prevents enumeration attacks, better for distributed systems
- Separate name fields: allows "Hi, [first_name]" emails vs "Dear [full_name]"
- Dual email fields: `email` preserves user's input, `email_normalized` prevents abuse
- Rejected soft deletes: GDPR right-to-be-forgotten requires hard deletes

**Why `email_normalized` is critical**:

Without normalization, users can exploit Gmail's + aliasing and dot-ignoring to create infinite trials:
- `user+1@gmail.com` → Trial #1
- `user+2@gmail.com` → Trial #2
- `user.name@gmail.com` vs `username@gmail.com` → Different accounts, same inbox

All normalize to `username@gmail.com`, preventing this attack vector.

---

### `subscriptions`

**Purpose**: Track all subscription states (both trials and paid).

| Column | Type | Constraints | Rationale |
|--------|------|-------------|-----------|
| id | UUID | PK | |
| user_id | UUID | FK users(id) CASCADE | User who owns subscription |
| tier | ENUM | 'digital', 'digital_print' | Two product tiers |
| status | ENUM | 'active', 'trial', 'cancelled', 'expired' | Current state |
| is_trial | BOOLEAN | DEFAULT FALSE | Trial vs paid flag |
| trial_end_date | TIMESTAMP | NULL for paid | When trial expires |
| start_date | TIMESTAMP | DEFAULT NOW() | Subscription start |
| end_date | TIMESTAMP | NULL for active | When cancelled/expired |
| created_at | TIMESTAMP | | |
| updated_at | TIMESTAMP | | |

**CHECK Constraints**:

```sql
CONSTRAINT valid_trial_dates CHECK (
    (is_trial = FALSE AND trial_end_date IS NULL) OR
    (is_trial = TRUE AND trial_end_date IS NOT NULL)
)
```

Ensures `trial_end_date` is always set for trials and always NULL for paid subscriptions — prevents inconsistent states.

**Indexes**:
- `(user_id, status)` — Fast lookup of active subscriptions
- `(trial_end_date)` WHERE is_trial = TRUE — For expiration cron job

**Design Decisions**:

**Q: Why not separate `trials` and `subscriptions` tables?**
A: Unified model simplifies trial → paid conversion:
- No data migration between tables
- Continuous subscription history per user
- Simple update: `UPDATE subscriptions SET is_trial = FALSE, status = 'active'`

**Q: Why `status` AND `is_trial`?**
A: Orthogonal concepts:
- `status` = current state (active, cancelled, expired)
- `is_trial` = subscription type (trial vs paid)
- Allows modeling: active trial, expired trial, active paid, cancelled paid

**Q: Why allow multiple subscriptions per user?**
A: History tracking — a user might cancel and resubscribe. Trial → paid conversion updates the existing row. One active subscription at a time is enforced in the application layer.

---

### `referral_passes`

**Purpose**: Track the 3 shareable passes per active subscription.

| Column | Type | Constraints | Rationale |
|--------|------|-------------|-----------|
| id | UUID | PK | |
| subscription_id | UUID | FK subscriptions(id) CASCADE | Which subscription owns this pass |
| user_id | UUID | FK users(id) CASCADE | Denormalized for fast lookups |
| token | VARCHAR(255) | UNIQUE, NOT NULL | JWT for secure sharing |
| is_redeemed | BOOLEAN | DEFAULT FALSE | Redemption status |
| redeemed_by_user_id | UUID | FK users(id) SET NULL | Who redeemed it |
| redeemed_at | TIMESTAMP | NULL until redeemed | When redeemed |
| created_subscription_id | UUID | FK subscriptions(id) SET NULL | Trial subscription created on redemption |
| expires_at | TIMESTAMP | | Token expiration (90 days) |
| created_at | TIMESTAMP | | |

**CHECK Constraint**:

```sql
CONSTRAINT valid_redemption CHECK (
    (is_redeemed = FALSE AND redeemed_by_user_id IS NULL AND redeemed_at IS NULL) OR
    (is_redeemed = TRUE AND redeemed_by_user_id IS NOT NULL AND redeemed_at IS NOT NULL)
)
```

Prevents invalid states like: `is_redeemed = TRUE` but no redeemer ID.

**Indexes**:
- `(token)` — Token lookup during redemption
- `(user_id, is_redeemed)` — Count available passes per user

**Design Decisions**:

**Q: Why store individual passes instead of just a counter?**
A:
- Individual tokens (can't share one token 3 times)
- Individual expiration tracking
- Detailed audit trail (who redeemed which pass when)
- Analytics: conversion rate per pass

**Q: Why denormalize `user_id` when we have `subscription_id → user_id`?**
A: Performance optimization (~40% faster on indexed lookups):

```sql
-- Without denormalization (JOIN required)
SELECT * FROM referral_passes rp
JOIN subscriptions s ON rp.subscription_id = s.id
WHERE s.user_id = $1;

-- With denormalization (direct lookup)
SELECT * FROM referral_passes WHERE user_id = $1;
```

**Q: Why JWT tokens instead of random UUIDs?**
A:
- Tamper-proof (signed)
- Self-contained (includes pass_id, referrer_id)
- Expiration built-in
- Longer than UUID (acceptable for links)

**JWT Payload**:
```json
{
  "passId": "uuid",
  "referrerId": "uuid",
  "type": "referral_pass",
  "iat": 1234567890,
  "exp": 1234567890
}
```

**Q: Why `created_subscription_id`?**
A: Complete audit trail — links pass → trial subscription it created. Enables analytics: which referrers bring highest-converting users. Future use: referrer rewards based on trial→paid conversion.

---

### `subscription_history`

**Purpose**: Immutable audit log of all subscription state changes.

| Column | Type | Constraints | Rationale |
|--------|------|-------------|-----------|
| id | UUID | PK | |
| subscription_id | UUID | FK subscriptions(id) CASCADE | Which subscription changed |
| user_id | UUID | FK users(id) CASCADE | Who it happened to |
| previous_status | ENUM | nullable | Previous state |
| new_status | ENUM | NOT NULL | New state |
| reason | VARCHAR(500) | | Context (referral_redemption, cancellation, etc.) |
| changed_at | TIMESTAMP | DEFAULT NOW() | When |

**No UPDATE/DELETE** — Append-only table for compliance.

**Sample `reason` values**:
- `referral_redemption` — Created from pass redemption
- `trial_expired` — Auto-expired by cron job
- `manual_cancellation` — User cancelled
- `trial_to_paid_conversion` — Trial converted
- `admin_action` — Support team intervention

**Use Cases**:
- Compliance audits
- Debugging user issues ("When did my trial expire?")
- Analytics (trial → paid conversion rate)
- Fraud detection (pattern analysis)

---

## Database Functions

This schema relies on 2 PostgreSQL functions:

| Function | Purpose |
|----------|---------|
| `normalize_email(email TEXT)` | Canonicalizes email addresses to prevent multi-account abuse |
| `is_user_eligible_for_trial(p_user_id UUID)` | Checks trial eligibility with 12mo/24mo cooldown periods |

See **[docs/database/functions.md](functions.md)** for complete definitions, examples, and rationale.

---

## Database Triggers

This schema uses 2 triggers:

| Trigger | Fires on | Purpose |
|---------|----------|---------|
| `trigger_generate_passes` | AFTER INSERT/UPDATE OF status ON subscriptions | Auto-creates 3 referral passes when a paid subscription activates |
| `trigger_normalize_email` | BEFORE INSERT/UPDATE OF email ON users | Auto-populates `email_normalized` |

See **[docs/database/triggers.md](triggers.md)** for complete definitions, implementation, and the JWT token replacement strategy.

**Important — placeholder tokens**: The `trigger_generate_passes` function inserts `PLACEHOLDER_` tokens. The application must replace these with real JWTs immediately after the trigger fires, within the same transaction. See [triggers.md — JWT token replacement](triggers.md#jwt-token-replacement) for the implementation pattern.

---

## Views

### `user_available_passes`

```sql
CREATE VIEW user_available_passes AS
SELECT
    u.id AS user_id,
    COUNT(rp.id) FILTER (WHERE rp.is_redeemed = FALSE) AS available_passes,
    COUNT(rp.id) FILTER (WHERE rp.is_redeemed = TRUE) AS redeemed_passes
FROM users u
JOIN subscriptions s ON u.id = s.user_id
LEFT JOIN referral_passes rp ON s.id = rp.subscription_id
WHERE s.status = 'active' AND s.is_trial = FALSE
GROUP BY u.id;
```

**Use**: Aggregates available vs redeemed pass counts per user for active, paid subscriptions. Simplifies dashboard and reporting queries without requiring callers to write multi-table JOINs.
