# Architecture overview

This document explains the Atlantic Referral Program architecture in plain language, with enough detail for engineers to implement and operate it.

## 1) High-level system design

### What the system does (referral flow)

Active subscribers get **3 shareable referral passes**. Each pass can be redeemed once and grants a **7-day free digital trial** to a new (eligible) user.

At a high level:

- A paid subscriber becomes eligible to share (subscription is **active** and **not a trial**).
- The database automatically creates **3 passes** for that subscription.
- The subscriber shares a link that contains a secure token.
- A recipient clicks the link, signs in/creates an account, and redeems the pass.
- Redemption creates a trial subscription and marks the pass as redeemed — **atomically**.

### User journeys (referrer, recipient, business)

- **Referrer (active subscriber)**:
  - Sees available passes.
  - Shares a pass link with friends.
  - Can check which passes were redeemed (and by whom, at least by email).

- **Recipient (friend/new user)**:
  - Opens a referral link.
  - If eligible, redeems the pass and gets a 7‑day trial.
  - If not eligible (recent subscription/trial, pass expired, etc.), sees a clear reason.

- **Business (The Atlantic)**:
  - Increases acquisition via referrals while limiting abuse.
  - Maintains auditability (who redeemed, when, which subscription was created).
  - Protects revenue by preventing infinite trial loops (email alias abuse, trial cycling).

### Architecture diagram (text/ASCII)

```
            (1) Subscription becomes active (paid)
Referrer  ----------------------------------------------+
 user_id                                                |
                                                        v
                                                 PostgreSQL
                                              +------------+
                                              | subscriptions|
                                              +------------+
                                                     |
                                                     | AFTER INSERT / UPDATE status
                                                     v
                                              +-----------------+
                                              | trigger_generate |
                                              | passes           |
                                              +-----------------+
                                                     |
                                                     v
                                              +----------------+
                                              | referral_passes |
                                              +----------------+
                                                     |
                 (2) GET passes + shareable link      |
API (Express) <---------------------------------------+
   |
   | (3) Recipient POST /redeem (token)
   v
Service layer (business rules + transaction orchestration)
   |
   | BEGIN; validate; create trial; update pass; history; COMMIT;
   v
PostgreSQL (ACID transaction is the enforcement point)
```

## 2) Core principles

### Database as source of truth

Business-critical enforcement happens in PostgreSQL:

- **Triggers** generate referral passes automatically.
- **Functions** centralize eligibility decisions.
- **Constraints/indexes** enforce valid states (e.g., redeemed pass fields must match) and prevent abuse (e.g., normalized email uniqueness).

This reduces the chance that a new code path “forgets” a rule.

### ACID transactions

Pass redemption is a multi-step operation (validate + create trial + mark pass redeemed). The system uses a database transaction so it’s all-or-nothing:

- Either the trial is created **and** the pass is redeemed, or neither happens.
- This prevents partial states (e.g., trial created but pass still available).

### Security first

The v2 design emphasizes abuse prevention and correct authorization:

- **Email normalization** prevents “same inbox, many accounts” trial abuse.
- **Cooldown windows** enable win-back but prevent trial cycling.
- **JWT tokens** are treated as **authentication/transport**, while the database remains the **authorization** source of truth (subscription/pass state).

## 3) Component breakdown

### Database layer responsibilities

- Store canonical state for users, subscriptions, passes, and audit history.
- Enforce invariants with constraints (e.g., valid redemption state).
- Generate passes automatically when subscriptions become active.
- Centralize eligibility logic in functions (e.g., cooldown rules).
- Maintain normalized email values consistently via trigger.

### Service layer responsibilities

- Implement business workflows by orchestrating database operations.
- Perform multi-step validations in a predictable order.
- Wrap critical flows (especially redemption) in transactions and choose isolation appropriately.
- Map database outcomes into domain-level success/errors for the API layer.

### API layer responsibilities

- Authentication and request validation (e.g., token present, types are correct).
- Define stable endpoints and response envelopes.
- Delegate business decisions to services (no business logic in controllers).

## 4) Key flows

### Pass generation (automatic via trigger)

When a subscription becomes **active** and **not a trial**, PostgreSQL runs a trigger function that inserts **3 referral passes** (idempotently).

Key properties:

- Automatic: the application doesn’t have to remember to generate passes.
- Idempotent: the trigger checks for existing passes so it won’t create duplicates.
- Optimized: v2 uses `NOT EXISTS` (rather than `COUNT(*)`) for better performance.

### Pass sharing (get shareable link)

The referrer retrieves passes via the API (e.g., `GET /api/referral/passes`). The response can include a pre-computed `shareable_link` that embeds the pass token:

- If a pass is **already redeemed**, the link is **nulled** to avoid confusion.
- There’s also a dedicated endpoint to fetch the link for a particular pass (useful for re-sharing).

### Pass redemption (11-step transaction)

Redeeming a pass is designed as a single transaction:

1. Verify JWT token (signature + expiration)
2. Lookup pass by token
3. Validate pass exists
4. Validate not already redeemed
5. Validate not expired (`expires_at`)
6. Validate referrer subscription still active
7. Validate not self-redemption
8. Validate recipient eligible (cooldowns, no active subscription, etc.)
9. Create trial subscription (7 days)
10. Mark pass redeemed (redeemer + timestamp + created subscription id)
11. Insert `subscription_history` record

If any step fails, the transaction rolls back.

## 5) Scale considerations

This system is intentionally database-centric; the following choices help it scale predictably:

- **Indexes for hot paths**:
  - Pass lookup by `token`
  - Pass listing by `(user_id, is_redeemed)`
  - Fast subscription checks by `(user_id, status)`
  - Unique index on `users.email_normalized` (abuse prevention and faster lookups)

- **Trigger performance**:
  - Using `NOT EXISTS` in pass generation short-circuits early on large tables.
  - Trigger logic is intentionally small and idempotent.

- **Transaction throughput**:
  - Redemption is the most critical path; it should run with appropriate isolation (v2 calls out `SERIALIZABLE`) to prevent double redemption.
  - Keep the transaction tight: do only the reads/writes needed for validation + state changes.

- **Operational safety**:
  - Prefer running load tests on redemption endpoints; they exercise most constraints and checks.
  - Monitor rates of conflict/serialization errors; retries should be handled cleanly.

- **Future growth** (common next steps):
  - Rate limiting for redemption attempts (protect against token guessing / abuse).
  - Background job for trial expiration (based on `trial_end_date`).
  - Analytics-friendly materialized views if reporting load grows.

