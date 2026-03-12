# Implementation guide (step-by-step)

This guide is a practical, test-first build plan for implementing the Atlantic Referral Program backend.

It is derived from:
- `TDD_Workflow.md` (roadmap + TDD build order)
- `CLAUDE.MD` (layering, transaction, validation, error-handling standards)
- `DocumentationStructure.MD` (recommended project structure)

## 1) Week-by-week roadmap (TDD build order)

### Week 1 — Database + simple reads

- **Day 1: Database layer (schema, triggers, functions)**
  - Write database-level tests first:
    - Trigger creates 3 passes for active (non-trial) subscription
    - Trigger does not create passes for trial subscriptions
    - `normalize_email()` correctness
    - `is_user_eligible_for_trial()` returns correct booleans (cooldowns)

- **Day 2: Utility functions**
  - Unit-test utilities that must match DB behavior:
    - Email normalization in application matches PostgreSQL function
    - JWT generation/verification (tamper detection, expiry)
    - Date helpers

- **Day 3: `GET /api/referral/passes`**
  - Integration tests first:
    - Requires authentication
    - Returns 3 passes for active subscriber
    - Empty/no passes for ineligible users (per spec)
    - Response formatting (`available_count`, `redeemed_count`, `shareable_link` rules)

### Week 2 — Complex features

- **Day 1: `GET /api/referral/eligibility`**
  - Test scenarios:
    - Eligible (no subscriptions)
    - Ineligible: active subscription
    - Ineligible: ended <12 months
    - Ineligible: trial <24 months
    - Eligible: ended >12 months and no recent trial

- **Day 2–3: `POST /api/referral/redeem` (transactional redemption)**
  - Implement incrementally with tests (one edge case at a time):
    - Happy path first
    - Then all 14 edge cases (see `docs/architecture/edge-cases.md`)

- **Day 4: `GET /api/referral/stats`**
  - Tests:
    - No redemptions
    - With redemptions
    - Privacy (only show recipient email, not full profile)

## 2) Feature-by-feature build guide

For each feature below:
- Start with a failing test (RED)
- Write minimal implementation (GREEN)
- Refactor while keeping tests green (REFACTOR)

### Feature: Database schema + invariants

- **What to build**
  - Tables: `users`, `subscriptions`, `referral_passes`, `subscription_history`
  - Constraints:
    - Trial date consistency (`is_trial` ↔ `trial_end_date`)
    - Redemption consistency (redeemed fields aligned)
  - Indexes for hot paths (token lookup, user pass listing)

- **Tests to write first**
  - Insert/update behavior that should succeed
  - Constraint violations that should fail (invalid states rejected)

- **Implementation order**
  - Create types/enums (if used) → tables → constraints → indexes

- **Validation checklist**
  - Schema enforces invalid states cannot exist
  - Indexes exist for expected queries

### Feature: Pass generation trigger

- **What to build**
  - Trigger on `subscriptions` that generates 3 passes when subscription becomes `active` and `is_trial = false`
  - Use `NOT EXISTS` for idempotency and performance

- **Tests to write first**
  - Active paid subscription generates exactly 3 passes
  - Trial subscription generates 0 passes
  - Re-running the activation does not duplicate passes

- **Implementation order**
  - Write `generate_referral_passes()` → create trigger → test idempotency

- **Validation checklist**
  - Trigger is idempotent
  - Passes have expiration dates and tokens
  - Tokens are real JWTs (no `PLACEHOLDER_` prefix) after subscription creation

**JWT replacement**: The trigger inserts placeholder tokens. `SubscriptionService.createSubscription()` must immediately overwrite them with signed JWTs in the same transaction. See [triggers.md — JWT token replacement](../database/triggers.md#jwt-token-replacement).

### Feature: Eligibility function (cooldowns)

- **What to build**
  - `is_user_eligible_for_trial(p_user_id UUID)` with:
    - Active subscription check
    - 12-month subscription cooldown
    - 24-month trial cooldown

- **Tests to write first**
  - Each eligibility scenario returns expected boolean

- **Implementation order**
  - Implement function → add tests that cover time windows → adjust queries

- **Validation checklist**
  - Time-window comparisons are correct
  - Function is the single source of truth used by services

### Feature: `GET /api/referral/passes`

- **What to build**
  - Controller + service + model/query
  - Response includes counts and precomputed `shareable_link`

- **Tests to write first**
  - Requires auth
  - Correct counts + formatting
  - Redeemed passes return `shareable_link: null`

- **Implementation order**
  - Route → controller (thin) → service (logic) → model (queries)

- **Validation checklist**
  - No controller-to-model shortcuts (controllers call services only)

### Feature: `POST /api/referral/redeem` (critical transactional flow)

- **What to build**
  - A single DB transaction that:
    - Validates token + pass state + eligibility
    - Creates trial subscription
    - Marks pass redeemed
    - Inserts `subscription_history`

- **Tests to write first**
  - Happy path: returns 201 and creates trial + redeems pass
  - Then edge cases in `docs/architecture/edge-cases.md`

- **Implementation order**
  - Start minimal (happy path) then add validations one by one
  - Use the transaction template from `CLAUDE.MD`
  - Prefer `SERIALIZABLE` + conditional update to prevent concurrent redemption

- **Validation checklist**
  - No partial state on failures
  - Correct status codes (400/401/404/409/410) and consistent envelopes

## 3) File-by-file guide (where code should live)

This follows the layering rules in `CLAUDE.MD` and the recommended structure in `DocumentationStructure.MD`.

### Database schema
- **Files**: `database/schema.sql`, `database/migrations/*`, `docs/database/*`
- **What belongs here**:
  - Tables, constraints, indexes
  - Functions: `normalize_email`, `is_user_eligible_for_trial`
  - Triggers: pass generation, email normalization

### Config / utilities
- **`src/config/`**
  - Database connection/pool
  - JWT secret management
  - Environment validation
- **`src/utils/`**
  - Pure helpers (email normalization mirror, JWT helpers, validators)

### Models (data access layer)
- **`src/models/`**
  - Only SQL queries + row mapping
  - No business rules (no “is eligible” decisions here)

### Services (business logic)
- **`src/services/`**
  - Orchestrate multi-step operations
  - Call models, enforce validations, manage transactions
  - Throw semantic errors (validation/conflict/gone/not-found)

### Controllers (HTTP layer)
- **`src/controllers/`**
  - Parse/validate request fields
  - Call services
  - Return response envelope
  - Pass errors to error middleware

### Routes
- **`src/routes/`**
  - Wire endpoints to controller functions
  - Apply middleware (auth, validation, rate limiting later)

### Middleware
- **`src/middleware/`**
  - Auth middleware (`x-user-id` in dev; sessions/JWT in prod)
  - Validation middleware (shape/type checks)
  - Central error handler (consistent envelopes, no sensitive leakage)

## 4) Common pitfalls (and how to avoid them)

- **Pitfall: skipping tests “to move faster”**
  - **Avoid**: write the smallest failing test first, then the smallest fix.

- **Pitfall: controllers doing business logic**
  - **Avoid**: controllers only handle HTTP; services handle rules and orchestration.

- **Pitfall: partial redemption states**
  - **Avoid**: keep all redemption writes inside a single transaction and roll back on any validation failure.

- **Pitfall: trusting JWT alone**
  - **Avoid**: JWT authenticates the token; the DB authorizes based on live subscription/pass state.

- **Pitfall: inconsistent error shapes**
  - **Avoid**: use one error envelope everywhere; keep messages user-safe.

- **Pitfall: time-window bugs**
  - **Avoid**: test cooldown boundaries explicitly (e.g., exactly 12 months, 11 months 29 days).

## 5) “When you’re stuck” checklist

- [ ] Re-read the relevant spec doc:
  - [ ] `docs/architecture/edge-cases.md`
  - [ ] `docs/database/schema.md`, `docs/database/functions.md`, `docs/database/triggers.md`
- [ ] Reduce scope: write **one** failing test for the next smallest behavior.
- [ ] Confirm the layer boundary:
  - Controller → Service → Model → DB (no skipping)
- [ ] Add debug output safely:
  - Never log passwords or full tokens
- [ ] Verify transaction boundaries:
  - Ensure `BEGIN/COMMIT/ROLLBACK` is correct and the client is always released
- [ ] If concurrency-related:
  - Reproduce with two parallel requests, then add isolation/conditional-update protections

