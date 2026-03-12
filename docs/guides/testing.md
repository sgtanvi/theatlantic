# Testing strategy (TDD)

This document describes the testing strategy for implementing the Atlantic Referral Program backend using TDD, aligned with `CLAUDE.MD` and `TDD_Workflow.md`.

## 1) Testing philosophy (TDD approach)

We use the Red–Green–Refactor loop:

- **RED**: write a test that fails (feature/edge case not implemented yet)
- **GREEN**: implement the smallest change to make it pass
- **REFACTOR**: clean up code while keeping tests green

Why this matters for this project:
- There are **14 edge cases** that are easy to miss without tests.
- The redemption flow has multi-step validation and must be transaction-safe.
- Refactoring should be safe (tests prevent regressions).

## 2) Test types (what to test)

### Database tests (`tests/database/`)

Test PostgreSQL behavior directly, because the DB is the source of truth.

What to test:
- **Triggers**
  - `generate_referral_passes` generates 3 passes for an active, non-trial subscription
  - Does not generate passes for trial subscriptions
  - Idempotency (does not generate duplicates)
- **Functions**
  - `normalize_email()` provider rules (Gmail dot/+ stripping, Outlook, Yahoo, Proton)
  - `is_user_eligible_for_trial()` cooldown logic (12mo subscription, 24mo trial)
- **Constraints**
  - Redemption state constraints prevent invalid combinations
  - Trial date constraints enforce `trial_end_date` consistency

### Unit tests (`tests/unit/`)

Test pure logic in isolation.

What to test:
- Email normalization in the application matches the database function behavior
- JWT utilities:
  - token generation produces expected claims
  - signature verification fails for tampering
  - expiry is enforced
- Date helpers (trial end date arithmetic, boundary conditions)

### Integration tests (`tests/integration/`)

Test the HTTP API end-to-end: routing → middleware → controllers → services → database.

What to test:
- Auth required for protected endpoints
- `GET /api/referral/passes` response formatting and counts
- `GET /api/referral/eligibility` scenarios (eligible/ineligible reasons)
- `POST /api/referral/redeem`:
  - happy path
  - all edge cases with correct status codes and error envelopes
- `GET /api/referral/stats`:
  - empty history
  - with redemptions
  - privacy expectations (email-only)

## 3) Test structure examples (from `CLAUDE.MD`)

### By layer

- **Database tests**: `tests/database/*`
- **Unit tests**: `tests/unit/*`
- **Integration tests**: `tests/integration/*`

### Naming convention

```
src/services/ReferralService.js
-> tests/unit/services/ReferralService.test.js

src/controllers/referralController.js
-> tests/integration/api/referral.test.js
```

### Arrange–Act–Assert and grouping

- Happy path first
- Then edge cases grouped by status class (400 vs 409 vs 410)
- Tests should not depend on each other (no shared global mutable state)

## 4) Test data factories pattern

Use a shared factory module to create test fixtures consistently and reduce duplication.

Recommended approach (from `TDD_Workflow.md`):
- `tests/helpers/factories.js` with helpers like:
  - `createUser()`
  - `createSubscription()`
  - `createUserWithSubscription()`
  - `createValidPass()`

Guidelines:
- Accept `overrides` to make special-case records easy to create
- Prefer unique emails (e.g., `Date.now()` suffix) to avoid collisions
- Keep factories focused on data creation (not assertions)

## 5) Coverage goals (and how to achieve them)

Run coverage:

```bash
npm test -- --coverage
```

Targets (from `TDD_Workflow.md`):
- Statements: **80%+**
- Branches: **75%+** (edge cases)
- Functions: **80%+**
- Lines: **80%+**

Critical areas to target near-100% coverage:
- Redemption business logic (`ReferralService.redeemPass`)
- Eligibility rules
- Email normalization behavior

How to achieve coverage:
- Add one test per edge case path (especially branches)
- Use parameterized tests for cooldown boundaries and normalization inputs
- Prefer testing behavior over internal implementation details

## 6) Running tests

Run the whole suite:

```bash
npm test
```

Watch mode (best for TDD):

```bash
npm test -- --watch
```

Run a specific file:

```bash
npm test -- tests/unit/services/ReferralService.test.js
```

Database test examples:

```bash
npm test tests/database/schema.test.js
npm test tests/database/triggers.test.js
npm test tests/database/functions.test.js
```

## 7) Debugging failing tests

Checklist:

- **Confirm the test is actually failing for the intended reason**
  - If it passes immediately, you may have skipped the RED step.
- **Reduce the problem**
  - Run one test file, then one test case.
- **Verify the layer boundary**
  - Controller → Service → Model → DB (no shortcuts).
- **Transactions**
  - If a test flakes, look for missing `ROLLBACK`/`client.release()` or missing isolation/conditional updates.
- **Time-based rules**
  - Test boundary conditions explicitly (exactly 12 months vs 11 months 29 days).
- **Data leakage between tests**
  - Ensure DB cleanup runs in `beforeEach` / `afterEach`.
  - Ensure factories do not reuse conflicting unique fields.

If you’re still stuck:
- Re-read `docs/architecture/edge-cases.md` for the expected status code and response.
- Re-run with extra logging, but never log sensitive data (passwords, full tokens).

