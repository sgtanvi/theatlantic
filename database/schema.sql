-- =============================================================================
-- The Atlantic Referral Program — Database Schema
-- =============================================================================
-- Run with: psql atlantic_referral < database/schema.sql
-- =============================================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";


-- =============================================================================
-- ENUMS
-- =============================================================================

CREATE TYPE subscription_tier AS ENUM ('digital', 'digital_print');

CREATE TYPE subscription_status AS ENUM ('active', 'trial', 'cancelled', 'expired');


-- =============================================================================
-- TABLES
-- =============================================================================

-- -----------------------------------------------------------------------------
-- users
-- Dual email columns: `email` preserves user input, `email_normalized` prevents
-- multi-account abuse via Gmail aliases/dots and similar provider tricks.
-- `email_normalized` is populated automatically by trigger_normalize_email.
-- -----------------------------------------------------------------------------
CREATE TABLE users (
    id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    email            VARCHAR(255) NOT NULL UNIQUE,
    email_normalized VARCHAR(255) NOT NULL UNIQUE,
    password_hash    VARCHAR(255) NOT NULL,
    first_name       VARCHAR(100),
    last_name        VARCHAR(100),
    created_at       TIMESTAMP    NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMP    NOT NULL DEFAULT NOW()
);

-- Fast eligibility checks and abuse-prevention lookups on normalized email
CREATE INDEX idx_users_email_normalized ON users (email_normalized);


-- -----------------------------------------------------------------------------
-- subscriptions
-- Unified table for both trials and paid subscriptions.
-- One active subscription at a time is enforced at the application layer.
-- Trial → paid conversion is an in-place UPDATE (no data migration).
-- -----------------------------------------------------------------------------
CREATE TABLE subscriptions (
    id             UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID                NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tier           subscription_tier   NOT NULL,
    status         subscription_status NOT NULL,
    is_trial       BOOLEAN             NOT NULL DEFAULT FALSE,
    trial_end_date TIMESTAMP,
    start_date     TIMESTAMP           NOT NULL DEFAULT NOW(),
    end_date       TIMESTAMP,
    created_at     TIMESTAMP           NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMP           NOT NULL DEFAULT NOW(),

    -- trial_end_date must be set iff this is a trial subscription
    CONSTRAINT valid_trial_dates CHECK (
        (is_trial = FALSE AND trial_end_date IS NULL) OR
        (is_trial = TRUE  AND trial_end_date IS NOT NULL)
    )
);

-- Fast lookup of active subscriptions per user (used in eligibility checks)
CREATE INDEX idx_subscriptions_user_status ON subscriptions (user_id, status);

-- Expiration cron job: quickly find trials that have passed their end date
CREATE INDEX idx_subscriptions_trial_end ON subscriptions (trial_end_date)
    WHERE is_trial = TRUE;


-- -----------------------------------------------------------------------------
-- referral_passes
-- 3 passes per active (non-trial) subscription, created automatically by
-- trigger_generate_passes. Tokens start as PLACEHOLDER_ strings and must be
-- replaced with signed JWTs by the application within the same transaction.
-- `user_id` is denormalized from subscriptions for fast per-user lookups.
-- -----------------------------------------------------------------------------
CREATE TABLE referral_passes (
    id                      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_id         UUID         NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    user_id                 UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token                   VARCHAR(255) NOT NULL UNIQUE,
    is_redeemed             BOOLEAN      NOT NULL DEFAULT FALSE,
    redeemed_by_user_id     UUID         REFERENCES users(id) ON DELETE SET NULL,
    redeemed_at             TIMESTAMP,
    created_subscription_id UUID         REFERENCES subscriptions(id) ON DELETE SET NULL,
    expires_at              TIMESTAMP    NOT NULL,
    created_at              TIMESTAMP    NOT NULL DEFAULT NOW(),

    -- All three redemption fields must be set together or not at all
    CONSTRAINT valid_redemption CHECK (
        (is_redeemed = FALSE AND redeemed_by_user_id IS NULL AND redeemed_at IS NULL) OR
        (is_redeemed = TRUE  AND redeemed_by_user_id IS NOT NULL AND redeemed_at IS NOT NULL)
    )
);

-- Token lookup during redemption (hot path)
CREATE INDEX idx_referral_passes_token ON referral_passes (token);

-- Count available/redeemed passes per user for the dashboard
CREATE INDEX idx_referral_passes_user_redeemed ON referral_passes (user_id, is_redeemed);


-- -----------------------------------------------------------------------------
-- subscription_history
-- Append-only audit log. No UPDATE or DELETE should ever touch this table.
-- -----------------------------------------------------------------------------
CREATE TABLE subscription_history (
    id              UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_id UUID                NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    user_id         UUID                NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    previous_status subscription_status,
    new_status      subscription_status NOT NULL,
    reason          VARCHAR(500),
    changed_at      TIMESTAMP           NOT NULL DEFAULT NOW()
);


-- =============================================================================
-- VIEWS
-- =============================================================================

-- Aggregates available vs redeemed pass counts per user for active paid
-- subscriptions. Simplifies dashboard queries.
CREATE VIEW user_available_passes AS
SELECT
    u.id AS user_id,
    COUNT(rp.id) FILTER (WHERE rp.is_redeemed = FALSE) AS available_passes,
    COUNT(rp.id) FILTER (WHERE rp.is_redeemed = TRUE)  AS redeemed_passes
FROM users u
JOIN subscriptions s ON u.id = s.user_id
LEFT JOIN referral_passes rp ON s.id = rp.subscription_id
WHERE s.status = 'active' AND s.is_trial = FALSE
GROUP BY u.id;


-- =============================================================================
-- FUNCTIONS
-- =============================================================================

-- -----------------------------------------------------------------------------
-- normalize_email(email TEXT)
-- Canonicalizes email addresses to a stable, provider-aware form so the system
-- can reliably detect "same inbox, different string" and block abuse.
--
-- Provider rules:
--   Gmail/Googlemail : remove dots, strip +alias, normalize domain to gmail.com
--   Outlook/Hotmail  : strip +alias
--   Yahoo            : strip -alias (Yahoo uses hyphens)
--   ProtonMail       : strip +alias
--   All others       : strip +alias
--
-- IMMUTABLE because the same input always produces the same output — this
-- enables functional indexes and better query planning.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION normalize_email(email TEXT)
RETURNS TEXT AS $$
DECLARE
    local_part TEXT;
    domain     TEXT;
BEGIN
    local_part := split_part(email, '@', 1);
    domain     := split_part(email, '@', 2);

    local_part := lower(local_part);
    domain     := lower(domain);

    IF domain IN ('gmail.com', 'googlemail.com') THEN
        -- Gmail ignores dots in the local part
        local_part := replace(local_part, '.', '');
        -- Strip +alias
        local_part := split_part(local_part, '+', 1);
        -- Treat googlemail.com as gmail.com
        domain := 'gmail.com';

    ELSIF domain IN ('outlook.com', 'hotmail.com', 'live.com') THEN
        local_part := split_part(local_part, '+', 1);

    ELSIF domain = 'yahoo.com' THEN
        -- Yahoo uses hyphens for aliases (e.g. user-alias@yahoo.com)
        local_part := split_part(local_part, '-', 1);

    ELSIF domain IN ('protonmail.com', 'proton.me', 'pm.me') THEN
        local_part := split_part(local_part, '+', 1);

    ELSE
        -- Generic: strip +alias for all other providers
        local_part := split_part(local_part, '+', 1);
    END IF;

    RETURN local_part || '@' || domain;
END;
$$ LANGUAGE plpgsql IMMUTABLE;


-- -----------------------------------------------------------------------------
-- is_user_eligible_for_trial(p_user_id UUID)
-- Single database-level decision point for referral trial eligibility (v2).
--
-- Rules:
--   1. No currently active subscription
--   2. No subscription ended within the last 12 months  (win-back window)
--   3. No trial started within the last 24 months       (anti-cycling)
--
-- See docs/database/functions.md for rationale and example scenarios.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION is_user_eligible_for_trial(p_user_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
    active_count       INTEGER;
    recent_sub_count   INTEGER;
    recent_trial_count INTEGER;
BEGIN
    -- Rule 1: Cannot have a currently active subscription
    SELECT COUNT(*) INTO active_count
    FROM subscriptions
    WHERE user_id = p_user_id AND status = 'active';

    IF active_count > 0 THEN
        RETURN FALSE;
    END IF;

    -- Rule 2: Cannot have had a subscription end within the last 12 months
    -- (prevents immediate churn → trial cycling)
    SELECT COUNT(*) INTO recent_sub_count
    FROM subscriptions
    WHERE user_id = p_user_id
      AND end_date IS NOT NULL
      AND end_date > CURRENT_TIMESTAMP - INTERVAL '12 months';

    IF recent_sub_count > 0 THEN
        RETURN FALSE;
    END IF;

    -- Rule 3: Cannot have had a trial start within the last 24 months
    -- (prevents long-term "free trial every 2 years" gaming)
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


-- =============================================================================
-- TRIGGER FUNCTIONS
-- =============================================================================

-- -----------------------------------------------------------------------------
-- generate_referral_passes()
-- Inserts 3 referral passes when a paid (non-trial) subscription becomes active.
-- Uses PLACEHOLDER_ tokens — the application MUST replace these with signed JWTs
-- within the same transaction before committing.
--
-- Idempotent: the NOT EXISTS guard prevents duplicate passes on repeated updates.
-- See docs/database/triggers.md for the JWT replacement pattern.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION generate_referral_passes()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'active' AND NEW.is_trial = FALSE THEN
        -- NOT EXISTS is faster than COUNT(*) — short-circuits on first match
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


-- -----------------------------------------------------------------------------
-- set_normalized_email()
-- Populates email_normalized from email on every insert/email-change.
-- Runs BEFORE write so the normalized value is available for UNIQUE checks
-- in the same statement.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_normalized_email()
RETURNS TRIGGER AS $$
BEGIN
    NEW.email_normalized := normalize_email(NEW.email);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- =============================================================================
-- TRIGGERS
-- =============================================================================

CREATE TRIGGER trigger_generate_passes
AFTER INSERT OR UPDATE OF status ON subscriptions
FOR EACH ROW
EXECUTE FUNCTION generate_referral_passes();

CREATE TRIGGER trigger_normalize_email
BEFORE INSERT OR UPDATE OF email ON users
FOR EACH ROW
EXECUTE FUNCTION set_normalized_email();


-- =============================================================================
-- SAMPLE TEST DATA
-- =============================================================================
-- Fixed UUIDs in the 00000000-0000-0000-0000-0000000000NN format for
-- predictable, readable test references.
--
-- User 1 (subscriber@test.com): active paid subscription → trigger will fire
--   and insert 3 PLACEHOLDER_ passes. Replace with real JWTs via application
--   code before running integration tests.
--
-- User 2 (newuser@test.com): no subscription → eligible for trial redemption.
-- =============================================================================

-- Users
-- email_normalized is intentionally supplied here so seed data doesn't depend
-- on the trigger firing during INSERT (some test setups bypass triggers).
INSERT INTO users (id, email, email_normalized, password_hash, first_name, last_name)
VALUES
    (
        '00000000-0000-0000-0000-000000000001',
        'subscriber@test.com',
        'subscriber@test.com',
        '$2b$10$placeholderHashForTestingOnly00001',
        'Alice',
        'Subscriber'
    ),
    (
        '00000000-0000-0000-0000-000000000002',
        'newuser@test.com',
        'newuser@test.com',
        '$2b$10$placeholderHashForTestingOnly00002',
        'Bob',
        'Newuser'
    );

-- Active paid subscription for User 1.
-- The trigger_generate_passes trigger fires on this INSERT and creates
-- 3 referral_passes rows with PLACEHOLDER_ tokens for this subscription.
INSERT INTO subscriptions (id, user_id, tier, status, is_trial)
VALUES (
    '00000000-0000-0000-0000-000000000010',
    '00000000-0000-0000-0000-000000000001',
    'digital',
    'active',
    FALSE
);

-- Seed subscription_history to reflect the initial activation
INSERT INTO subscription_history (id, subscription_id, user_id, previous_status, new_status, reason)
VALUES (
    '00000000-0000-0000-0000-000000000020',
    '00000000-0000-0000-0000-000000000010',
    '00000000-0000-0000-0000-000000000001',
    NULL,
    'active',
    'initial_activation'
);
