# Database Functions

This document is the **implementation reference** for the PostgreSQL functions used by the Atlantic Referral Program. Per `CLAUDE.MD`, **the database is the source of truth**: these functions centralize security- and business-critical rules so the application can call them consistently.

---

## `normalize_email(email TEXT)`

### Purpose

Canonicalize email addresses into a stable, provider-aware form so the system can reliably enforce **one trial per real inbox** (prevents multi-account abuse via aliases and provider quirks).

### Full function definition

```sql
CREATE OR REPLACE FUNCTION normalize_email(email TEXT) 
RETURNS TEXT AS $$
DECLARE
    local_part TEXT;
    domain TEXT;
BEGIN
    -- Split on @
    local_part := split_part(email, '@', 1);
    domain := split_part(email, '@', 2);
    
    -- Lowercase everything
    local_part := lower(local_part);
    domain := lower(domain);
    
    -- Gmail/Googlemail-specific normalization
    IF domain IN ('gmail.com', 'googlemail.com') THEN
        -- Remove all dots (Gmail ignores them)
        local_part := replace(local_part, '.', '');
        -- Remove everything after + (alias stripping)
        local_part := split_part(local_part, '+', 1);
        -- Normalize googlemail.com → gmail.com
        domain := 'gmail.com';
    
    -- Outlook/Hotmail normalization
    ELSIF domain IN ('outlook.com', 'hotmail.com', 'live.com') THEN
        local_part := split_part(local_part, '+', 1);
    
    -- Yahoo normalization (uses - for aliases)
    ELSIF domain = 'yahoo.com' THEN
        local_part := split_part(local_part, '-', 1);
    
    -- ProtonMail normalization
    ELSIF domain IN ('protonmail.com', 'proton.me', 'pm.me') THEN
        local_part := split_part(local_part, '+', 1);
    
    -- All other providers: just strip + aliases
    ELSE
        local_part := split_part(local_part, '+', 1);
    END IF;
    
    RETURN local_part || '@' || domain;
END;
$$ LANGUAGE plpgsql IMMUTABLE;
```

### Examples (what it handles)

| Provider | Input email | Normalized output |
|---|---|---|
| Gmail | `john.doe+atlantic@gmail.com` | `johndoe@gmail.com` |
| Gmail | `John.Doe@Googlemail.com` | `johndoe@gmail.com` |
| Outlook | `user+trial@outlook.com` | `user@outlook.com` |
| Yahoo | `user-test@yahoo.com` | `user@yahoo.com` |
| ProtonMail | `name+promo@proton.me` | `name@proton.me` |
| Other (generic `+` alias) | `person+anything@example.com` | `person@example.com` |

### Why `IMMUTABLE`

PostgreSQL can treat the function as deterministic: **the same input always produces the same output**. This matters because it enables better query planning and supports **functional indexes** (and other optimizations) on the normalized value.

### Security benefit

Email normalization is a direct abuse-prevention control:

- It closes the “infinite trials” loophole where a single inbox creates many accounts via provider aliasing (e.g. Gmail `+` aliases and dot-ignoring).
- It enables a strong uniqueness/eligibility check using `users.email_normalized` (commonly backed by a **unique constraint/index**), ensuring the system can reliably detect “same inbox, different string”.

---

## `is_user_eligible_for_trial(p_user_id UUID)` (v2)

### Purpose

Provide a single database-level decision point for whether a user can receive a referral trial, balancing:

- **Win-back**: allow lapsed subscribers to become eligible again after time has passed
- **Anti-gaming**: prevent cycling trials/subscriptions to obtain perpetual free access

### Full function definition (with cooldown logic)

```sql
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
    
    IF active_count > 0 THEN
        RETURN FALSE;
    END IF;
    
    -- Rule 2: Cannot have had active subscription in last 12 months
    -- (Win-back window: must be lapsed for 12+ months)
    SELECT COUNT(*) INTO recent_sub_count
    FROM subscriptions
    WHERE user_id = p_user_id 
      AND end_date IS NOT NULL
      AND end_date > CURRENT_TIMESTAMP - INTERVAL '12 months';
    
    IF recent_sub_count > 0 THEN
        RETURN FALSE;
    END IF;
    
    -- Rule 3: Cannot have had trial in last 24 months
    -- (Prevents gaming: subscribe, cancel, wait 12mo, get trial, repeat)
    SELECT COUNT(*) INTO recent_trial_count
    FROM subscriptions
    WHERE user_id = p_user_id
      AND is_trial = TRUE
      AND start_date > CURRENT_TIMESTAMP - INTERVAL '24 months';
    
    IF recent_trial_count > 0 THEN
        RETURN FALSE;
    END IF;
    
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;
```

### Business rules

- **Rule 1 (current state)**: If the user has an **active** subscription, they are **ineligible**.
- **Rule 2 (subscription cooldown)**: If the user had any subscription with an `end_date` in the last **12 months**, they are **ineligible**.
  - Rationale: blocks immediate churn/re-eligibility; creates a 12-month win-back window.
- **Rule 3 (trial cooldown)**: If the user had a trial with `start_date` in the last **24 months**, they are **ineligible**.
  - Rationale: prevents systematic gaming of referral trials over time.

### Example scenarios table

| User History | v1 Result | v2 Result | Rationale |
|--------------|-----------|-----------|-----------|
| Subscribed 2019-2021, lapsed 4 years | Ineligible | **Eligible** | Win-back opportunity |
| Cancelled 6 months ago | Ineligible | Ineligible | Too recent (churn risk) |
| Had trial 18 months ago | Ineligible | Ineligible | Within 24-mo trial cooldown |
| Had trial 30 months ago, never paid | Ineligible | **Eligible** | Long enough gap to retry |
| Active subscriber trying own pass | Ineligible | Ineligible | Current subscriber |

### Why it’s better than v1

- **v1 (too strict)**: rejects users with *any* historical subscription, even if they lapsed years ago (missed win-back conversion).
- **v2 (balanced)**: keeps anti-abuse protections while enabling win-back:
  - **12-month subscription cooldown**: prevents recent churn from immediately re-trialing
  - **24-month trial cooldown**: prevents long-term “free trial cycling” abuse

