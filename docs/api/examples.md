# API examples (curl workflows)

This document provides end-to-end request/response examples for the Atlantic Referral Program API, suitable for **manual testing** and as a reference for implementation.

Per `CLAUDE.MD` and `DESIGN_DOC.MD`:
- Use a consistent response envelope (`success`, `data`, `message` / `error`).
- In development, authenticate with the `x-user-id` header (mock auth).

> See [endpoints.md](endpoints.md) for the complete API reference and [errors.md](errors.md) for the full error code catalogue. The examples below are based on those specs.

## Conventions used below

- **API base URL**: set `API_BASE` (examples assume `http://localhost:3000`)
- **Auth (development)**: `x-user-id: <uuid>`
- **JSON**: requests use `Content-Type: application/json`

Example shell setup:

```bash
export API_BASE="http://localhost:3000"
export REFERRER_USER_ID="550e8400-e29b-41d4-a716-446655440000"
export RECIPIENT_USER_ID="660e8400-e29b-41d4-a716-446655440000"
```

---

## 1) Complete redemption flow (happy path)

This is the full workflow: **Get passes → Share link → Redeem → Verify**.

### Step 1 — Referrer gets passes

```bash
curl -sS \
  -H "x-user-id: $REFERRER_USER_ID" \
  "$API_BASE/api/referral/passes"
```

Expected response shape (example):

```json
{
  "success": true,
  "data": {
    "total_passes": 3,
    "available_count": 3,
    "redeemed_count": 0,
    "passes": [
      {
        "id": "pass-uuid-1",
        "token": "eyJhbGci...",
        "is_redeemed": false,
        "expires_at": "2025-06-10T12:00:00Z",
        "shareable_link": "https://atlantic.com/referral/redeem?token=eyJ..."
      }
    ]
  }
}
```

### Step 2 — Referrer shares the link (out-of-band)

- Copy the `shareable_link` from the response.
- The recipient ultimately redeems by sending the `token` inside that link to the API.

### Step 3 — Recipient redeems the pass

Choose one available pass token from Step 1:

```bash
export PASS_TOKEN="eyJhbGci..."
```

Redeem:

```bash
curl -sS \
  -X POST \
  -H "x-user-id: $RECIPIENT_USER_ID" \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"$PASS_TOKEN\"}" \
  "$API_BASE/api/referral/redeem"
```

Expected response shape (example):

```json
{
  "success": true,
  "message": "7-day trial activated successfully!",
  "data": {
    "subscription_id": "sub-uuid",
    "tier": "digital",
    "trial_end_date": "2025-03-18T12:00:00Z",
    "status": "trial"
  }
}
```

### Step 4 — Verify pass is now redeemed (referrer view)

```bash
curl -sS \
  -H "x-user-id: $REFERRER_USER_ID" \
  "$API_BASE/api/referral/passes"
```

Expected:
- The redeemed pass has `is_redeemed: true`
- `shareable_link` is `null` for redeemed passes (prevents re-sharing confusion)

---

## 2) Error scenarios (curl examples)

Below are common error cases that should map to consistent status codes and response envelopes.

### Missing token (400)

```bash
curl -sS \
  -X POST \
  -H "x-user-id: $RECIPIENT_USER_ID" \
  -H "Content-Type: application/json" \
  -d "{}" \
  "$API_BASE/api/referral/redeem"
```

Expected (example):

```json
{
  "success": false,
  "error": "Missing token",
  "message": "Token is required"
}
```

### Invalid/tampered token (400)

```bash
curl -sS \
  -X POST \
  -H "x-user-id: $RECIPIENT_USER_ID" \
  -H "Content-Type: application/json" \
  -d '{"token":"not-a-jwt"}' \
  "$API_BASE/api/referral/redeem"
```

Expected (example):

```json
{
  "success": false,
  "error": "Invalid token",
  "message": "Invalid referral token"
}
```

### Pass already redeemed (409)

Redeem the same `PASS_TOKEN` twice:

```bash
curl -sS -X POST -H "x-user-id: $RECIPIENT_USER_ID" -H "Content-Type: application/json" \
  -d "{\"token\":\"$PASS_TOKEN\"}" \
  "$API_BASE/api/referral/redeem"

curl -sS -X POST -H "x-user-id: $RECIPIENT_USER_ID" -H "Content-Type: application/json" \
  -d "{\"token\":\"$PASS_TOKEN\"}" \
  "$API_BASE/api/referral/redeem"
```

Expected second response (example):

```json
{
  "success": false,
  "error": "Pass already redeemed",
  "message": "This pass has already been redeemed"
}
```

### Self-redemption (400)

Use the referrer as the redeemer:

```bash
curl -sS \
  -X POST \
  -H "x-user-id: $REFERRER_USER_ID" \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"$PASS_TOKEN\"}" \
  "$API_BASE/api/referral/redeem"
```

Expected (example):

```json
{
  "success": false,
  "error": "Cannot self-redeem",
  "message": "You cannot redeem your own referral pass"
}
```

### User ineligible (409) — each reason

Eligibility is centralized in `is_user_eligible_for_trial(p_user_id UUID)` (v2 cooldown rules). You can test these by setting up recipient history appropriately and then redeeming.

#### Ineligible: active subscription

Expected (example):

```json
{
  "success": false,
  "error": "Already subscribed",
  "message": "User already has an active subscription"
}
```

#### Ineligible: cancelled <12 months ago

Expected (example):

```json
{
  "success": false,
  "error": "Recently subscribed",
  "message": "User had an active subscription within the last 12 months"
}
```

#### Ineligible: had trial <24 months ago

Expected (example):

```json
{
  "success": false,
  "error": "Recent trial",
  "message": "User had a trial within the last 24 months"
}
```

---

## 3) Common workflows

### Create subscription → get passes (referrer onboarding)

The design includes a helper endpoint for testing subscriptions:

```bash
curl -sS \
  -X POST \
  -H "x-user-id: $REFERRER_USER_ID" \
  -H "Content-Type: application/json" \
  -d '{"tier":"digital"}' \
  "$API_BASE/api/subscriptions"
```

Then fetch passes (trigger should auto-generate 3):

```bash
curl -sS \
  -H "x-user-id: $REFERRER_USER_ID" \
  "$API_BASE/api/referral/passes"
```

### Check eligibility → redeem (recipient UX)

```bash
curl -sS \
  -H "x-user-id: $RECIPIENT_USER_ID" \
  "$API_BASE/api/referral/eligibility"
```

If eligible, redeem as shown in the happy path.

### View referral stats (referrer dashboard)

```bash
curl -sS \
  -H "x-user-id: $REFERRER_USER_ID" \
  "$API_BASE/api/referral/stats"
```

Expected response shape (example):

```json
{
  "success": true,
  "data": {
    "successful_referrals": 2,
    "pending_passes": 1,
    "redemption_history": [
      { "redeemed_at": "2025-03-05T14:30:00Z", "recipient_email": "friend1@example.com" }
    ]
  }
}
```

---

## 4) Testing with curl commands

### Setting up test users

User creation endpoints are not specified in the current design doc. For manual testing, it’s common to seed users directly in the database and then use their UUIDs via `x-user-id`.

Example (SQL sketch; adapt to your schema constraints and password hashing):

```sql
-- Create a referrer (paid subscriber)
INSERT INTO users (id, email, email_normalized, password_hash)
VALUES (
  '550e8400-e29b-41d4-a716-446655440000',
  'referrer@example.com',
  'referrer@example.com',
  'bcrypt_hash_here'
);

-- Create a recipient (new user)
INSERT INTO users (id, email, email_normalized, password_hash)
VALUES (
  '660e8400-e29b-41d4-a716-446655440000',
  'recipient@example.com',
  'recipient@example.com',
  'bcrypt_hash_here'
);
```

### Full test suite in bash (template)

This is a lightweight script you can adapt for local testing.

```bash
#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:3000}"
REFERRER_USER_ID="${REFERRER_USER_ID:-550e8400-e29b-41d4-a716-446655440000}"
RECIPIENT_USER_ID="${RECIPIENT_USER_ID:-660e8400-e29b-41d4-a716-446655440000}"

echo "Creating subscription for referrer (helper endpoint)..."
curl -sS -X POST \
  -H "x-user-id: $REFERRER_USER_ID" \
  -H "Content-Type: application/json" \
  -d '{"tier":"digital"}' \
  "$API_BASE/api/subscriptions" >/dev/null

echo "Fetching passes..."
PASSES_JSON="$(curl -sS -H "x-user-id: $REFERRER_USER_ID" "$API_BASE/api/referral/passes")"
echo "$PASSES_JSON"

echo "NOTE: Extract a token from the JSON output above and export PASS_TOKEN."
echo "Redeeming..."
if [[ -z "${PASS_TOKEN:-}" ]]; then
  echo "PASS_TOKEN is required (export PASS_TOKEN=...)" >&2
  exit 1
fi

curl -sS -X POST \
  -H "x-user-id: $RECIPIENT_USER_ID" \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"$PASS_TOKEN\"}" \
  "$API_BASE/api/referral/redeem"

echo "Verifying pass is redeemed..."
curl -sS -H "x-user-id: $REFERRER_USER_ID" "$API_BASE/api/referral/passes"
```

