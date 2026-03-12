# API errors reference

This document is the implementation-ready error reference for the Atlantic Referral Program API.

Sources:
- `DESIGN_DOC.MD` (“REST Principles Applied” + “Edge Cases & Error Handling”)
- `docs/architecture/edge-cases.md` (detailed v2 edge-case handling)

Cross-references:
- API specs: `docs/api/endpoints.md`
- Edge case details: `docs/architecture/edge-cases.md`
- Implementation guide: `docs/guides/implementation.md`

---

## 1) ERROR FORMAT

All API errors return a consistent JSON envelope:

```json
{
  "success": false,
  "error": "machine_readable_or_short_error",
  "message": "Human-readable error message"
}
```

Conventions:
- **`success`**: always `false` for error responses
- **`error`**: stable string intended for programmatic handling (keep it consistent)
- **`message`**: safe, user-facing explanation (avoid leaking secrets/tokens/internal state)

> Some legacy examples in the design include extra fields (e.g., `redeemed_at`). Those are allowed when they improve UX, but should be used deliberately and consistently.

---

## 2) HTTP STATUS CODE GUIDE

| Status | When to use | Client action |
|---:|---|---|
| 400 | Request is malformed or violates a business rule that is tied to the request itself (missing/invalid fields, self-redemption, referrer inactive) | Fix the request or show user-facing guidance; retry usually won’t help unless input changes |
| 401 | Authentication missing/invalid | Re-authenticate (or provide auth header/session); retry after auth |
| 404 | Resource does not exist (or is not accessible) | Stop retrying; show “not found” UX; consider re-fetching list |
| 409 | Valid request but current state conflicts (already redeemed, already subscribed, cooldown conflicts, uniqueness conflicts) | Don’t blindly retry; fetch latest state; show reason and next steps |
| 410 | Resource used to be valid but is now expired (token/pass expiry) | Don’t retry; prompt for a new link/pass |
| 500 | Server failure (unhandled exception, DB connection failure) | Retry with backoff; show generic error; alert/monitor if persistent |

---

## 3) ERROR CATEGORIES (organized by status code)

### 401 UNAUTHORIZED

#### Missing authentication
- **Endpoints**: Any endpoint marked “Auth: Yes” in `docs/api/endpoints.md`
- **Status**: 401
- **Response**:

```json
{
  "success": false,
  "error": "Unauthorized",
  "message": "x-user-id header required for authentication"
}
```

- **Cause**: Missing auth header/session.
- **Client action**: Authenticate and retry.
- **Example scenario**: `GET /api/referral/passes` without `x-user-id`.

#### Invalid user ID
- **Endpoints**: Any authenticated endpoint
- **Status**: 401
- **Response** (example):

```json
{
  "success": false,
  "error": "Unauthorized",
  "message": "Invalid user"
}
```

- **Cause**: Provided user id does not correspond to a user.
- **Client action**: Re-authenticate; treat as session invalid.

---

### 400 BAD REQUEST

#### Missing required field
- **Endpoints**: `POST /api/referral/redeem`, `POST /api/subscriptions`
- **Status**: 400
- **Response** (example):

```json
{
  "success": false,
  "error": "Missing token",
  "message": "Token is required"
}
```

- **Cause**: Required body field absent.
- **Client action**: Fix request body; retry.
- **Example scenario**: Redeem with `{}` body.

#### Invalid token format / invalid token
- **Endpoints**: `POST /api/referral/redeem`
- **Status**: 400
- **Response** (from design):

```json
{
  "success": false,
  "error": "Invalid token",
  "message": "Invalid referral token"
}
```

- **Cause**: Malformed JWT, wrong signature, wrong token type.
- **Client action**: Stop retrying; prompt user to request a new link.
- **Example scenario**: Token string `not-a-jwt`.

#### Invalid subscription tier
- **Endpoints**: `POST /api/subscriptions` (helper endpoint)
- **Status**: 400
- **Response** (example):

```json
{
  "success": false,
  "error": "Invalid subscription tier",
  "message": "tier must be one of: digital, digital_print"
}
```

- **Cause**: Request body has unsupported `tier`.
- **Client action**: Fix input; retry.
- **Example scenario**: `{ "tier": "gold" }`.

#### Self-redemption attempt
- **Endpoints**: `POST /api/referral/redeem`
- **Status**: 400
- **Response** (from design/edge cases):

```json
{
  "success": false,
  "error": "Cannot self-redeem",
  "message": "You cannot redeem your own referral pass"
}
```

- **Cause**: Recipient user id equals referrer id encoded in token.
- **Client action**: Show message; no retry.
- **Example scenario**: Referrer clicks their own referral link while logged in.

#### Referrer subscription inactive
- **Endpoints**: `POST /api/referral/redeem`
- **Status**: 400
- **Response** (from design/edge cases):

```json
{
  "success": false,
  "error": "Referrer subscription inactive",
  "message": "Referrer no longer has an active subscription"
}
```

- **Cause**: Pass belongs to a subscription that is no longer active (or is a trial).
- **Client action**: Stop; ask referrer to renew or share a new pass when active.
- **Example scenario**: Referrer cancels after sharing, recipient redeems later.

---

### 404 NOT FOUND

#### Pass not found
- **Endpoints**: `POST /api/referral/redeem`
- **Status**: 404
- **Response** (from design):

```json
{
  "success": false,
  "error": "Pass not found",
  "message": "This referral pass does not exist"
}
```

- **Cause**: Token is valid but no `referral_passes` row matches it.
- **Client action**: Stop; prompt user to request a new link.
- **Example scenario**: Pass deleted (cascade from user deletion) or token references unknown pass.

#### Subscription not found
- **Endpoints**: `GET /api/subscriptions/me`
- **Status**: 404
- **Response** (example):

```json
{
  "success": false,
  "error": "Subscription not found",
  "message": "No active subscription"
}
```

- **Cause**: User has no active subscription.
- **Client action**: Show “no active subscription” state.
- **Example scenario**: New user checks `/api/subscriptions/me`.

---

### 409 CONFLICT

#### Pass already redeemed
- **Endpoints**: `POST /api/referral/redeem`, `GET /api/referral/passes/:passId/link` (already redeemed case)
- **Status**: 409 (redeem), 400 (link endpoint per design)
- **Response** (redeem):

```json
{
  "success": false,
  "error": "Pass already redeemed",
  "message": "This pass has already been redeemed"
}
```

- **Cause**: `referral_passes.is_redeemed = true`.
- **Client action**: Fetch passes again; show redeemed state.
- **Example scenario**: User attempts to redeem after a friend already did.

#### User already subscribed
- **Endpoints**: `POST /api/referral/redeem`
- **Status**: 409
- **Response** (example):

```json
{
  "success": false,
  "error": "Already subscribed",
  "message": "User already has an active subscription"
}
```

- **Cause**: Recipient has an active subscription.
- **Client action**: Stop; show subscription management CTA.

#### Recently subscribed (12mo cooldown)
- **Endpoints**: `POST /api/referral/redeem`
- **Status**: 409
- **Response** (from design/edge cases):

```json
{
  "success": false,
  "error": "Recently subscribed",
  "message": "User had an active subscription within the last 12 months"
}
```

- **Cause**: Eligibility function fails Rule 2 (ended within last 12 months).
- **Client action**: Stop; show when they can try again (if UX supports it).

#### Had recent trial (24mo cooldown)
- **Endpoints**: `POST /api/referral/redeem`
- **Status**: 409
- **Response** (example):

```json
{
  "success": false,
  "error": "Recent trial",
  "message": "User had a trial within the last 24 months"
}
```

- **Cause**: Eligibility function fails Rule 3 (trial within last 24 months).
- **Client action**: Stop; show subscription offers.

#### Email already registered
- **Endpoints**: Account creation / user signup (not specified in API v2 docs)
- **Status**: 409
- **Response** (from design):

```json
{
  "success": false,
  "error": "Email already registered",
  "message": "An account with this email address already exists"
}
```

- **Cause**: `users.email_normalized` uniqueness blocks alias abuse.
- **Client action**: Prompt login; explain aliases are not supported.

#### Subscription already exists
- **Endpoints**: `POST /api/subscriptions` (helper endpoint)
- **Status**: 409
- **Response** (example):

```json
{
  "success": false,
  "error": "Subscription already exists",
  "message": "User already has an active subscription"
}
```

- **Cause**: Attempt to create an active subscription when one already exists.
- **Client action**: Fetch `/api/subscriptions/me` and show existing subscription.

#### Concurrent redemption
- **Endpoints**: `POST /api/referral/redeem`
- **Status**: 409
- **Response** (example; often maps to “already redeemed”):

```json
{
  "success": false,
  "error": "Pass already redeemed",
  "message": "This pass has already been redeemed"
}
```

- **Cause**: Another transaction redeemed the pass first (or a serialization retry observes the redeemed state).
- **Client action**: Fetch latest pass list; do not automatically retry indefinitely.

---

### 410 GONE

#### Pass expired (database)
- **Endpoints**: `POST /api/referral/redeem`
- **Status**: 410
- **Response** (from design):

```json
{
  "success": false,
  "error": "Pass expired",
  "message": "This pass has expired"
}
```

- **Cause**: `referral_passes.expires_at` is in the past.
- **Client action**: Request a new pass/link from referrer.

#### Token expired (JWT)
- **Endpoints**: `POST /api/referral/redeem`
- **Status**: 410
- **Response** (example):

```json
{
  "success": false,
  "error": "Token expired",
  "message": "This referral token has expired"
}
```

- **Cause**: JWT `exp` has passed; `jwt.verify` throws `TokenExpiredError`.
- **Client action**: Request a new link.

---

### 500 INTERNAL SERVER ERROR

#### Unhandled exception
- **Endpoints**: Any
- **Status**: 500
- **Response** (example):

```json
{
  "success": false,
  "error": "Internal server error",
  "message": "Please try again later"
}
```

- **Cause**: Unexpected server error.
- **Client action**: Retry with backoff; show generic error.

#### Database connection failure
- **Endpoints**: Any DB-backed endpoint (most of them)
- **Status**: 500 (or 503 if you choose to differentiate availability)
- **Response** (from design):

```json
{
  "success": false,
  "error": "Internal server error",
  "message": "Please try again later"
}
```

- **Cause**: PostgreSQL down, network partition, or connection pool exhaustion.
- **Client action**: Retry with backoff; surface “service temporarily unavailable.”

---

## 4) Error handling best practices

### Client-side handling example (JavaScript)

```javascript
async function apiFetch(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => null);

  if (response.ok) return body;

  // Standardized error handling
  const error = body?.error || 'Unknown error';
  const message = body?.message || 'Request failed';

  if (response.status === 401) {
    // Redirect to login or re-authenticate
    throw new Error('Unauthorized: please sign in again');
  }

  if (response.status === 409 || response.status === 410) {
    // Conflicts/expired: typically user-action required
    throw new Error(message);
  }

  // Default
  throw new Error(message);
}
```

### Server-side error middleware example (Express)

This matches the `CLAUDE.MD` pattern: do not leak stacks in production.

```javascript
function errorHandler(err, req, res, next) {
  console.error('Error:', {
    name: err.name,
    message: err.message,
    status: err.status
  });

  const statusCode = err.status || 500;
  const error = err.error || 'Internal server error';

  const message = process.env.NODE_ENV === 'development'
    ? err.message
    : (statusCode === 500 ? 'Please try again later' : err.message);

  res.status(statusCode).json({
    success: false,
    error,
    message
  });
}
```

### Validation helper examples

Prefer early returns/guard clauses (controllers validate shape; services validate business rules):

```javascript
function requireString(value, fieldName) {
  if (!value) throw new ValidationError(`${fieldName} is required`);
  if (typeof value !== 'string') throw new ValidationError(`${fieldName} must be a string`);
}
```

---

## 5) Error scenarios by endpoint

### Endpoint → errors matrix

| Endpoint | 400 | 401 | 404 | 409 | 410 | 500 |
|---|---|---|---|---|---|---|
| GET `/api/referral/passes` |  | Missing auth/invalid user |  |  |  | DB failure |
| GET `/api/referral/passes/:passId/link` | Already redeemed (design uses 400) | Missing auth/invalid user | Pass not found/doesn’t belong |  |  | DB failure |
| POST `/api/referral/redeem` | Missing token, invalid token, self-redemption, referrer inactive | Missing auth/invalid user | Pass not found | Already redeemed, eligibility conflicts, concurrent redemption | Token expired, pass expired | DB failure |
| GET `/api/referral/eligibility` |  | Missing auth/invalid user |  |  |  | DB failure |
| GET `/api/referral/stats` |  | Missing auth/invalid user |  |  |  | DB failure |
| GET `/health` |  |  |  |  |  | (Recommend 503 if DB down) |
| POST `/api/subscriptions` | Missing/invalid tier | Missing auth/invalid user |  | Subscription exists |  | DB failure |
| GET `/api/subscriptions/me` |  | Missing auth/invalid user | No active subscription |  |  | DB failure |

### POST `/api/referral/redeem` — 12 possible errors (order of checking)

This list is intended to guide implementation and tests. It excludes the outer authentication middleware (401), which should run before reaching the controller.

1. **400 Missing token** (no token in body)
2. **400 Invalid token** (malformed/tampered/wrong signature/type)
3. **410 Token expired (JWT)** (`exp` passed)
4. **404 Pass not found** (token valid, no DB row)
5. **409 Pass already redeemed**
6. **410 Pass expired (DB)** (`expires_at` passed)
7. **400 Referrer subscription inactive**
8. **400 Self-redemption**
9. **409 User already subscribed** (active subscription)
10. **409 Recently subscribed** (12-month cooldown)
11. **409 Recent trial** (24-month cooldown)
12. **409 Concurrent redemption** (serialization/claim failure observed as conflict)

For full edge-case rationale, see `docs/architecture/edge-cases.md`.

---

## 6) Testing error scenarios

### curl examples (minimal)

Assuming development auth (`x-user-id`) and local base URL:

```bash
export API_BASE="http://localhost:3000"
export USER_ID="660e8400-e29b-41d4-a716-446655440000"
```

**401 Missing auth**:

```bash
curl -sS "$API_BASE/api/referral/passes"
```

**400 Missing token**:

```bash
curl -sS -X POST \
  -H "x-user-id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d '{}' \
  "$API_BASE/api/referral/redeem"
```

**400 Invalid token**:

```bash
curl -sS -X POST \
  -H "x-user-id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d '{"token":"not-a-jwt"}' \
  "$API_BASE/api/referral/redeem"
```

**404 Pass not found** (requires a valid JWT that doesn’t map to a DB row; typically generated in tests):
- Create a valid JWT for a non-existent pass id, then call redeem.

**409 Already redeemed / concurrent redemption**:
- Redeem a token once, then redeem again, or run two redeems simultaneously (see concurrency test in `docs/architecture/edge-cases.md`).

**410 Expired**:
- Use a token with `exp` in the past, or a pass with `expires_at` in the past.

### How to test error handling (recommended)

- Prefer automated tests (integration + database) for the error matrix:
  - See `docs/guides/testing.md`
  - Use edge cases from `docs/architecture/edge-cases.md`
- Validate both:
  - status code
  - error envelope (`success=false`, `error`, `message`)

