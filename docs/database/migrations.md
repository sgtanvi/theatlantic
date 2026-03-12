# Database Migrations

Migration guide for The Atlantic Referral Program schema.

---

## v1 → v2 Migration

### Overview of changes

| Change | Type | Notes |
|--------|------|-------|
| Add `users.email_normalized` | Column + index | Nullable first, then constrained |
| Update `is_user_eligible_for_trial()` | Function | Add 12mo/24mo cooldown logic |
| Update `generate_referral_passes()` | Function | Replace `COUNT(*)` with `NOT EXISTS` |
| Add `trigger_normalize_email` | Trigger | Auto-populate `email_normalized` |

---

### Forward Migration

Run these steps in order. Each step is safe to re-run if interrupted.

```sql
-- Step 1: Add email_normalized column (nullable to allow backfill first)
ALTER TABLE users ADD COLUMN email_normalized VARCHAR(255);

-- Step 2: Create the normalization function before backfill
CREATE OR REPLACE FUNCTION normalize_email(email TEXT)
RETURNS TEXT AS $$
DECLARE
    local_part TEXT;
    domain TEXT;
BEGIN
    local_part := split_part(email, '@', 1);
    domain := split_part(email, '@', 2);
    local_part := lower(local_part);
    domain := lower(domain);

    IF domain IN ('gmail.com', 'googlemail.com') THEN
        local_part := replace(local_part, '.', '');
        local_part := split_part(local_part, '+', 1);
        domain := 'gmail.com';
    ELSIF domain IN ('outlook.com', 'hotmail.com', 'live.com') THEN
        local_part := split_part(local_part, '+', 1);
    ELSIF domain = 'yahoo.com' THEN
        local_part := split_part(local_part, '-', 1);
    ELSIF domain IN ('protonmail.com', 'proton.me', 'pm.me') THEN
        local_part := split_part(local_part, '+', 1);
    ELSE
        local_part := split_part(local_part, '+', 1);
    END IF;

    RETURN local_part || '@' || domain;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Step 3: Backfill existing rows
UPDATE users SET email_normalized = normalize_email(email);

-- Step 4: Enforce NOT NULL now that all rows are populated
ALTER TABLE users ALTER COLUMN email_normalized SET NOT NULL;

-- Step 5: Add unique index (use CONCURRENTLY to avoid locking on live table)
-- Note: CONCURRENTLY cannot run inside a transaction block; run separately.
CREATE UNIQUE INDEX CONCURRENTLY idx_users_email_normalized ON users(email_normalized);

-- After index is built, add the constraint (references the index):
ALTER TABLE users ADD CONSTRAINT users_email_normalized_key UNIQUE
    USING INDEX idx_users_email_normalized;

-- Step 6: Create trigger support function
CREATE OR REPLACE FUNCTION set_normalized_email()
RETURNS TRIGGER AS $$
BEGIN
    NEW.email_normalized := normalize_email(NEW.email);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Step 7: Create email normalization trigger
CREATE TRIGGER trigger_normalize_email
BEFORE INSERT OR UPDATE OF email ON users
FOR EACH ROW
EXECUTE FUNCTION set_normalized_email();

-- Step 8: Update is_user_eligible_for_trial with cooldown logic
CREATE OR REPLACE FUNCTION is_user_eligible_for_trial(p_user_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
    active_count INTEGER;
    recent_sub_count INTEGER;
    recent_trial_count INTEGER;
BEGIN
    -- Rule 1: Cannot have currently active subscription
    SELECT COUNT(*) INTO active_count
    FROM subscriptions
    WHERE user_id = p_user_id AND status = 'active';
    IF active_count > 0 THEN RETURN FALSE; END IF;

    -- Rule 2: Cannot have had a subscription end within the last 12 months
    SELECT COUNT(*) INTO recent_sub_count
    FROM subscriptions
    WHERE user_id = p_user_id
      AND end_date IS NOT NULL
      AND end_date > CURRENT_TIMESTAMP - INTERVAL '12 months';
    IF recent_sub_count > 0 THEN RETURN FALSE; END IF;

    -- Rule 3: Cannot have had a trial start within the last 24 months
    SELECT COUNT(*) INTO recent_trial_count
    FROM subscriptions
    WHERE user_id = p_user_id
      AND is_trial = TRUE
      AND start_date > CURRENT_TIMESTAMP - INTERVAL '24 months';
    IF recent_trial_count > 0 THEN RETURN FALSE; END IF;

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- Step 9: Update generate_referral_passes to use NOT EXISTS
CREATE OR REPLACE FUNCTION generate_referral_passes()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'active' AND NEW.is_trial = FALSE THEN
        IF NOT EXISTS (
            SELECT 1 FROM referral_passes WHERE subscription_id = NEW.id
        ) THEN
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

**Important**: Step 5 (`CREATE UNIQUE INDEX CONCURRENTLY`) must be run **outside** a transaction block. Run it as a standalone statement, then proceed to the `ALTER TABLE` constraint.

---

### Rollback Migration

Run in reverse order. Validate in staging before running in production.

```sql
-- Step 1: Drop email normalization trigger (do this first to prevent constraint conflicts)
DROP TRIGGER IF EXISTS trigger_normalize_email ON users;
DROP FUNCTION IF EXISTS set_normalized_email();

-- Step 2: Restore is_user_eligible_for_trial to v1 (one trial ever)
CREATE OR REPLACE FUNCTION is_user_eligible_for_trial(p_user_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
    active_count INTEGER;
    any_past_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO active_count
    FROM subscriptions WHERE user_id = p_user_id AND status = 'active';
    IF active_count > 0 THEN RETURN FALSE; END IF;

    -- v1: reject any user with any historical subscription
    SELECT COUNT(*) INTO any_past_count
    FROM subscriptions WHERE user_id = p_user_id;
    IF any_past_count > 0 THEN RETURN FALSE; END IF;

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- Step 3: Restore generate_referral_passes to COUNT(*) version (v1)
CREATE OR REPLACE FUNCTION generate_referral_passes()
RETURNS TRIGGER AS $$
DECLARE
    pass_count INTEGER;
BEGIN
    IF NEW.status = 'active' AND NEW.is_trial = FALSE THEN
        SELECT COUNT(*) INTO pass_count
        FROM referral_passes WHERE subscription_id = NEW.id;
        IF pass_count = 0 THEN
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

-- Step 4: Drop unique constraint and index
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_normalized_key;
DROP INDEX IF EXISTS idx_users_email_normalized;

-- Step 5: Drop email_normalized column
-- WARNING: This permanently removes data. Ensure a backup exists first.
ALTER TABLE users DROP COLUMN IF EXISTS email_normalized;

-- Step 6: Drop normalize_email function (after column is removed)
DROP FUNCTION IF EXISTS normalize_email(TEXT);
```

**Caution**: Dropping `email_normalized` is irreversible. If any duplicate accounts were blocked by the unique constraint during v2, those attempts are just gone — there is no data to restore.

---

### Post-Migration Validation

Run these checks after the forward migration to confirm correctness:

```sql
-- 1. Verify normalize_email function works
SELECT normalize_email('john.doe+atlantic@gmail.com');
-- Expected: johndoe@gmail.com

SELECT normalize_email('user+trial@outlook.com');
-- Expected: user@outlook.com

-- 2. Verify unique constraint blocks alias abuse
-- (Run in a transaction you'll roll back)
BEGIN;
INSERT INTO users (email, password_hash) VALUES ('test+1@gmail.com', 'x');
INSERT INTO users (email, password_hash) VALUES ('test+2@gmail.com', 'x');
-- Expected: ERROR on second insert (duplicate normalized form)
ROLLBACK;

-- 3. Verify eligibility cooldowns
-- User with subscription ended 6 months ago should be ineligible
SELECT is_user_eligible_for_trial('<uuid-of-such-user>');
-- Expected: false

-- 4. Verify trigger idempotency
-- NOT EXISTS should prevent duplicate passes on repeated activation
SELECT COUNT(*) FROM referral_passes WHERE subscription_id = '<active-sub-id>';
-- Expected: 3 (not 6 or more)

-- 5. Verify trigger is installed
SELECT tgname, tgtype FROM pg_trigger WHERE tgname = 'trigger_normalize_email';
-- Expected: 1 row
```

---

### Testing Checklist

- [ ] Email normalization: `normalize_email('user+1@gmail.com')` → `user@gmail.com`
- [ ] Unique constraint: inserting `user+1@gmail.com` and `user+2@gmail.com` fails on second
- [ ] Covers Gmail, Googlemail, Outlook, Hotmail, Yahoo, ProtonMail, and generic `+` stripping
- [ ] Eligibility — cancelled 6 months ago: ineligible (12mo cooldown)
- [ ] Eligibility — cancelled 18 months ago, no trial in 24mo: eligible (win-back)
- [ ] Eligibility — trial 18 months ago: ineligible (24mo trial cooldown)
- [ ] Eligibility — trial 30 months ago: eligible
- [ ] Pass generation: exactly 3 passes created on activation
- [ ] Pass generation: no duplicates when trigger fires twice (idempotent)
- [ ] All existing tests pass after migration
