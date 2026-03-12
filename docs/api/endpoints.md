# REST API reference

This document is the implementation-ready REST API reference for the Atlantic Referral Program.

It is extracted from `DESIGN_DOC.MD` (“API Design” section) and cross-references:
- **Authentication**: `docs/api/authentication.md`
- **Edge cases**: `docs/architecture/edge-cases.md`
- **Error codes**: `docs/api/errors.md` (if/when added; this document includes per-endpoint error examples regardless)

## Base URL

- **Local development**: `http://localhost:<PORT>`
- **Production**: `https://<your-domain>`

All endpoints below are relative to the base URL.

## Authentication overview

Authentication strategy is documented in `docs/api/authentication.md`.

From the design:
- **Development**: `x-user-id` header (mock)
- **Production**:
  - Session cookies (recommended)
  - Or JWT in `Authorization: Bearer <token>`
  - Plus CSRF protection for cookie-based auth

Unless explicitly marked “No”, endpoints require authentication.

## Response envelope format

Success:

```json
{
  "success": true,
  "data": { ... },
  "message": "Optional human-readable text"
}
```

Error:

```json
{
  "success": false,
  "error": "error_code",
  "message": "Human-readable error"
}
```

## HTTP status codes reference

| Status | Meaning | Typical causes |
|---:|---|---|
| 200 | OK | Successful GET |
| 201 | Created | Successful POST that creates a resource |
| 400 | Bad Request | Validation errors, business rule violations |
| 401 | Unauthorized | Missing/invalid auth |
| 404 | Not Found | Resource doesn’t exist (or not accessible) |
| 409 | Conflict | Resource exists / state conflict (already redeemed, ineligible) |
| 410 | Gone | Resource existed but expired |
| 500 | Internal Server Error | Unhandled errors / DB failures |

## Endpoints overview

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/api/referral/passes` | Fetch all passes for authenticated user | Yes |
| GET | `/api/referral/passes/:passId/link` | Get shareable link for a specific pass | Yes |
| POST | `/api/referral/redeem` | Redeem a pass and create a 7-day trial subscription | Yes (recipient) |
| GET | `/api/referral/eligibility` | Check whether user can redeem a trial | Yes |
| GET | `/api/referral/stats` | Analytics for referrer (redemptions + history) | Yes |
| GET | `/health` | Health check endpoint for load balancer | No |
| POST | `/api/subscriptions` | Helper endpoint for testing: create subscription | Yes |
| GET | `/api/subscriptions/me` | Helper endpoint: get current active subscription | Yes |

---

## 1) GET `/api/referral/passes`

- **Purpose**: Fetch all passes for authenticated user
- **Authentication**: Required
- **Method/Path**: `GET /api/referral/passes`

### Request format

Headers:
- `x-user-id: <uuid>` (development)

Example request:

```http
GET /api/referral/passes HTTP/1.1
x-user-id: 550e8400-e29b-41d4-a716-446655440000
```

### Response format (success)

**Response 200 OK**:

```json
{
  "success": true,
  "data": {
    "total_passes": 3,
    "available_count": 2,
    "redeemed_count": 1,
    "passes": [
      {
        "id": "pass-uuid-1",
        "token": "eyJhbGci...",
        "is_redeemed": false,
        "redeemed_by": null,
        "redeemed_at": null,
        "expires_at": "2025-06-10T12:00:00Z",
        "shareable_link": "https://atlantic.com/referral/redeem?token=eyJ..."
      },
      {
        "id": "pass-uuid-2",
        "token": "eyJhbGci...",
        "is_redeemed": true,
        "redeemed_by": "friend@example.com",
        "redeemed_at": "2025-03-05T14:30:00Z",
        "expires_at": "2025-06-10T12:00:00Z",
        "shareable_link": null
      }
    ]
  }
}
```

### Error responses

**Response 401 Unauthorized**:

```json
{
  "success": false,
  "error": "Unauthorized",
  "message": "x-user-id header required"
}
```

### Design decisions/notes

- Include `shareable_link` pre-computed (saves client from constructing)
- Null out link if redeemed (prevents confusion)
- Include summary counts (available/redeemed) for UI badge/counter
- Could paginate but 3 passes = overkill

### Example SQL query

```sql
SELECT rp.*, u_redeemed.email AS redeemed_by_email
FROM referral_passes rp
JOIN subscriptions s ON rp.subscription_id = s.id
LEFT JOIN users u_redeemed ON rp.redeemed_by_user_id = u_redeemed.id
WHERE rp.user_id = $1 AND s.status = 'active'
ORDER BY rp.created_at DESC
```

### Use cases

- Referrer dashboard showing “2 available / 1 redeemed”
- UI renders a “copy link” button for available passes

---

## 2) GET `/api/referral/passes/:passId/link`

- **Purpose**: Get shareable link for specific pass (if user needs to re-share)
- **Authentication**: Required
- **Method/Path**: `GET /api/referral/passes/:passId/link`

### Request format

Headers:
- `x-user-id: <uuid>` (development)

Path params:
- `passId`: pass id (UUID)

Example request:

```http
GET /api/referral/passes/abc123/link HTTP/1.1
x-user-id: 550e8400...
```

### Response format (success)

**Response 200 OK**:

```json
{
  "success": true,
  "data": {
    "pass_id": "abc123",
    "shareable_link": "https://atlantic.com/referral/redeem?token=eyJ...",
    "expires_at": "2025-06-10T12:00:00Z"
  }
}
```

### Error responses

**Response 404 Not Found**:

```json
{
  "success": false,
  "error": "Pass not found or does not belong to you"
}
```

**Response 400 Bad Request** (if already redeemed):

```json
{
  "success": false,
  "error": "This pass has already been redeemed",
  "redeemed_at": "2025-03-05T14:30:00Z"
}
```

### Design decisions/notes

- The main `GET /api/referral/passes` response can include a `shareable_link`; this endpoint exists for explicit “re-share” flows.
- If the pass is already redeemed, return a 400 with `redeemed_at` to help clients show an appropriate message.

### Use cases

- Recipient never clicked the first time; referrer wants to re-share via SMS/WhatsApp

---

## 3) POST `/api/referral/redeem`

- **Purpose**: Redeem a pass and create 7-day trial subscription
- **Authentication**: Required (recipient user)
- **Method/Path**: `POST /api/referral/redeem`

### Request format

Headers:
- `x-user-id: <uuid>` (development)
- `Content-Type: application/json`

Body:
- `token` (string; referral JWT)

Example request:

```http
POST /api/referral/redeem HTTP/1.1
x-user-id: 660e8400... (NEW user)
Content-Type: application/json

{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

### Response format (success)

**Response 201 Created**:

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

### Error responses

From the design:

| Status | Error | Condition |
|---:|---|---|
| 400 | Missing token | No token in body |
| 400 | Invalid token | Malformed JWT, wrong signature |
| 400 | Cannot self-redeem | Referrer trying to use own pass |
| 400 | Referrer subscription inactive | Referrer cancelled subscription |
| 404 | Pass not found | Token valid but pass doesn't exist in DB |
| 409 | Pass already redeemed | Someone else already used it |
| 409 | Already subscribed | User has active subscription |
| 409 | Previously subscribed | User had subscription before (even if expired) |
| 410 | Pass expired | `expires_at` date passed |
| 410 | Token expired | JWT `exp` claim passed |

For the complete edge-case breakdown (including concurrency, cooldowns, email alias abuse), see `docs/architecture/edge-cases.md`.

### Transaction flow (must be atomic)

```javascript
BEGIN TRANSACTION

1. Verify JWT token (signature, expiration)
2. Lookup pass by token
3. Validate: pass exists
4. Validate: not already redeemed
5. Validate: not expired (DB field)
6. Validate: referrer subscription still active
7. Validate: not self-redemption
8. Validate: recipient eligible (no active/past subscriptions)
9. Create trial subscription (tier='digital', is_trial=true, trial_end_date=NOW()+7 days)
10. Update pass (is_redeemed=true, redeemed_by_user_id, redeemed_at, created_subscription_id)
11. Insert subscription_history record

COMMIT
```

**If ANY step fails → ROLLBACK**

### Design decisions/notes

- **Why transaction?**
  - Prevents partial states: trial created but pass not marked redeemed
  - ACID guarantees: two users can't redeem same pass (serializable isolation)

### Concurrency handling

PostgreSQL `SERIALIZABLE` isolation level:
- User A starts transaction, checks `is_redeemed = false`
- User B starts transaction, checks `is_redeemed = false` (stale read)
- User A commits (updates `is_redeemed = true`)
- User B tries to commit → **serialization failure**, retries, sees `is_redeemed = true`, fails validation

---

## 4) GET `/api/referral/eligibility`

- **Purpose**: Check if user can redeem a trial (before showing redemption UI)
- **Authentication**: Required
- **Method/Path**: `GET /api/referral/eligibility`

### Request format

Example request:

```http
GET /api/referral/eligibility HTTP/1.1
x-user-id: 770e8400...
```

### Response format (success)

**Response 200 OK (eligible)**:

```json
{
  "success": true,
  "data": {
    "eligible": true,
    "reason": null
  }
}
```

**Response 200 OK (ineligible)**:

```json
{
  "success": true,
  "data": {
    "eligible": false,
    "reason": "User already has an active subscription"
  }
}
```

**Possible reasons**:
- `"User already has an active subscription"`
- `"User has previously had a subscription"`

> Note: v2 eligibility uses cooldown windows (12-month subscription, 24-month trial). See `docs/architecture/edge-cases.md` for detailed eligibility edge cases and expected statuses in redemption.

### Use cases

Frontend can call this before showing "Redeem" button:

```javascript
const { eligible, reason } = await checkEligibility();
if (!eligible) {
  showError(reason);
} else {
  showRedeemButton();
}
```

---

## 5) GET `/api/referral/stats`

- **Purpose**: Analytics for referrer (how many people redeemed your passes)
- **Authentication**: Required
- **Method/Path**: `GET /api/referral/stats`

### Request format

```http
GET /api/referral/stats HTTP/1.1
x-user-id: 550e8400...
```

### Response format (success)

**Response 200 OK**:

```json
{
  "success": true,
  "data": {
    "successful_referrals": 2,
    "pending_passes": 1,
    "redemption_history": [
      {
        "redeemed_at": "2025-03-05T14:30:00Z",
        "recipient_email": "friend1@example.com"
      },
      {
        "redeemed_at": "2025-03-08T10:15:00Z",
        "recipient_email": "friend2@example.com"
      }
    ]
  }
}
```

### Design decisions/notes

- **Privacy consideration**: Only show recipient email to referrer (not full profile). Alternatively, hash or redact: `"fri***@example.com"`.

### Example SQL query

```sql
SELECT 
    COUNT(*) FILTER (WHERE is_redeemed = TRUE) as successful_referrals,
    COUNT(*) FILTER (WHERE is_redeemed = FALSE) as pending_passes,
    json_agg(
        json_build_object('redeemed_at', redeemed_at, 'recipient_email', u.email)
    ) FILTER (WHERE is_redeemed = TRUE) as redemption_history
FROM referral_passes rp
LEFT JOIN users u ON rp.redeemed_by_user_id = u.id
WHERE rp.user_id = $1
```

### Use cases

Gamification dashboard showing "You've helped 2 friends discover The Atlantic!"

---

## 6) GET `/health`

- **Purpose**: Health check endpoint for load balancer
- **Authentication**: Not required
- **Method/Path**: `GET /health`

### Request format

```http
GET /health HTTP/1.1
```

### Response format (success)

**Response 200 OK** (example):

```json
{
  "success": true,
  "data": {
    "status": "ok"
  }
}
```

### Error responses

**Response 503 Service Unavailable** (database down):

```json
{
  "success": false,
  "error": "Service unavailable",
  "message": "Database unavailable"
}
```

### Design decisions/notes

- `DESIGN_DOC.MD` calls out a health check endpoint as a production mitigation for database failures and load balancer checks.
- In production, consider including dependency checks (DB connectivity) and a request id, but avoid leaking sensitive internal details.

### Use cases

- Load balancer / uptime monitoring checks (should be fast and unauthenticated)

---

## 7) POST `/api/subscriptions` (helper endpoint for testing)

- **Purpose**: Create subscription (simulate user subscribing)
- **Authentication**: Required
- **Method/Path**: `POST /api/subscriptions`

### Request format

Body:

```json
{
  "tier": "digital" | "digital_print"
}
```

### Response format (success)

**Response 201**:

```json
{
  "success": true,
  "message": "Subscription created successfully",
  "data": {
    "id": "sub-uuid",
    "tier": "digital",
    "status": "active",
    "is_trial": false
  }
}
```

### Design decisions/notes

- **What happens**: Trigger auto-generates 3 passes.

### Use cases

- Local/dev testing: quickly create an “active subscriber” without integrating billing

---

## 8) GET `/api/subscriptions/me` (helper endpoint)

- **Purpose**: Get current user's active subscription
- **Authentication**: Required
- **Method/Path**: `GET /api/subscriptions/me`

### Response format (success)

**Response 200**:

```json
{
  "success": true,
  "data": {
    "id": "sub-uuid",
    "tier": "digital_print",
    "status": "active",
    "is_trial": false,
    "start_date": "2024-01-15T...",
    "end_date": null
  }
}
```

### Error responses

**Response 404**: No active subscription

### Use cases

- Debugging: confirm a user is considered an active subscriber

---

## Rate limiting (not implemented in v2)

Rate limiting is recommended (especially on redemption) to reduce abuse:
- brute-force token guessing
- high-rate redemption attempts

`DESIGN_DOC.MD` suggests an MVP policy such as **5 redemption attempts per 15 minutes**.

## CORS

If this API is called from browsers:
- Restrict `Access-Control-Allow-Origin` to known frontend origins.
- Restrict methods/headers to what’s needed.
- If using cookie auth, configure CORS carefully (`credentials: true`) and require CSRF protections (see `docs/api/authentication.md`).

