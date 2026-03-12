# Database Triggers

This document is the **implementation reference** for PostgreSQL triggers used by the Atlantic Referral Program. Per `CLAUDE.MD`, the database is the source of truth: triggers enforce rules **atomically** so application code cannot forget critical behavior.

---

## 1) `generate_referral_passes` trigger

### What it does

Automatically creates **3 referral passes** for a subscription when it becomes **active** and **not a trial**.

### When it fires

```sql
CREATE TRIGGER trigger_generate_passes
AFTER INSERT OR UPDATE OF status ON subscriptions
FOR EACH ROW
EXECUTE FUNCTION generate_referral_passes();
```

Fires:

- **AFTER INSERT** on `subscriptions`
- **AFTER UPDATE OF `status`** on `subscriptions`
- **FOR EACH ROW**

### Full function definition (v2 with `NOT EXISTS`)

```sql
CREATE OR REPLACE FUNCTION generate_referral_passes()
RETURNS TRIGGER AS $$
BEGIN
    -- Only generate passes for active, non-trial subscriptions
    IF NEW.status = 'active' AND NEW.is_trial = FALSE THEN
        -- Check if passes already exist (prevents duplicate generation)
        IF NOT EXISTS (
            SELECT 1 FROM referral_passes 
            WHERE subscription_id = NEW.id
        ) THEN
            -- Generate 3 passes
            INSERT INTO referral_passes (subscription_id, user_id, token, expires_at)
            SELECT 
                NEW.id,
                NEW.user_id,
                'PLACEHOLDER_' || gen_random_uuid()::text,
                CURRENT_TIMESTAMP + INTERVAL '90 days'
            FROM generate_series(1, 3);
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

### Why a trigger vs application code

- **Atomic with subscription creation/activation**: the passes are guaranteed to exist as part of the same database operation that activates the subscription.
- **Prevents “forgotten behavior” bugs**: application code can’t accidentally skip pass creation on a new code path.
- **Consistent across writers**: any future job/script/admin tool that inserts/updates subscriptions still gets correct pass generation.

Trade-off (accepted in the design): triggers can hide logic and make debugging harder, but the **correctness and atomicity** win here.

### Edge case handling (prevents duplicates)

The trigger-function is idempotent for a given `subscription_id` because it checks:

```sql
IF NOT EXISTS (
  SELECT 1 FROM referral_passes WHERE subscription_id = NEW.id
) THEN
  -- insert 3 passes
END IF;
```

So if the trigger fires more than once (e.g. a retry or repeated updates), it will **not generate duplicate passes**.

### JWT token replacement

The trigger inserts a `'PLACEHOLDER_'` token, not a real JWT. This is intentional: PostgreSQL triggers cannot sign JWTs because they have no access to the application secret key.

**The application must replace placeholder tokens immediately after the trigger fires**, within the same transaction:

```javascript
// src/services/SubscriptionService.js (excerpt)
const subscription = await client.query(
  `INSERT INTO subscriptions (user_id, tier, status, is_trial)
   VALUES ($1, $2, 'active', false) RETURNING *`,
  [userId, tier]
);

// Trigger has now fired and created 3 PLACEHOLDER_ passes.
// Replace them with real JWTs before committing.
const passes = await client.query(
  `SELECT id, user_id FROM referral_passes
   WHERE subscription_id = $1 AND token LIKE 'PLACEHOLDER_%'`,
  [subscription.rows[0].id]
);

for (const pass of passes.rows) {
  const jwtToken = jwt.sign(
    { passId: pass.id, referrerId: pass.user_id, type: 'referral_pass' },
    process.env.JWT_SECRET,
    { expiresIn: '90d' }
  );
  await client.query(
    'UPDATE referral_passes SET token = $1 WHERE id = $2',
    [jwtToken, pass.id]
  );
}

await client.query('COMMIT');
// Placeholder tokens are never visible outside this transaction.
```

See [JWT token payload spec](../database/schema.md#referral_passes) and [implementation guide](../guides/implementation.md) for the full context.

---

### Performance notes

This is the v2 design improvement called out in `DESIGN_DOC.MD`:

- **Uses `NOT EXISTS` instead of `COUNT(*)`**
  - Faster: can short-circuit on the first match
  - More idiomatic: expresses “does any row exist?”
  - On large tables, avoids scanning/counting more rows than needed

---

## 2) `trigger_normalize_email`

### What it does

Automatically populates `users.email_normalized` by calling `normalize_email(NEW.email)` whenever a user is created or their email is changed.

### When it fires

```sql
CREATE TRIGGER trigger_normalize_email
BEFORE INSERT OR UPDATE OF email ON users
FOR EACH ROW
EXECUTE FUNCTION set_normalized_email();
```

Fires:

- **BEFORE INSERT** on `users`
- **BEFORE UPDATE OF `email`** on `users`
- **FOR EACH ROW**

### Full function definition

```sql
CREATE OR REPLACE FUNCTION set_normalized_email()
RETURNS TRIGGER AS $$
BEGIN
    NEW.email_normalized := normalize_email(NEW.email);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

### Security benefit example

With a **unique constraint** on `users.email_normalized`, normalization prevents “same inbox, multiple accounts” attacks:

```sql
-- Without normalization: Both succeed (2 accounts, same inbox)
INSERT INTO users (email) VALUES ('user+1@gmail.com');
INSERT INTO users (email) VALUES ('user+2@gmail.com');

-- With normalization: Second fails on UNIQUE constraint
-- Both normalize to 'user@gmail.com'
ERROR: duplicate key value violates unique constraint "users_email_normalized_key"
```

### Why a trigger

- **Impossible to forget normalization**: every insert/update path is covered.
- **Guaranteed consistency**: no row can be written with `email` changed but `email_normalized` stale.
- **Keeps application code simpler and safer**: writers don’t need to remember to call `normalize_email()` on every path.

