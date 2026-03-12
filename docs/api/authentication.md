# Authentication (implementation guide)

This guide describes how to implement authentication for the Atlantic Referral Program in a way that matches the architecture and security standards in `CLAUDE.MD`.

The design supports a **development-friendly mock auth** and two production-grade approaches.

## 1) Development approach (`x-user-id` header mock)

### Why this for development

During early development and testing, the goal is to validate referral logic (passes, eligibility, redemption) without building a full auth system.

Using a header-based mock:
- Removes dependency on session infrastructure
- Makes integration testing easy (set a header, act as a user)
- Keeps the API design realistic (every protected endpoint still requires auth)

### How it works

- Client sends `x-user-id: <uuid>` on requests.
- Middleware:
  - Validates the header exists
  - Looks up the user in the database
  - Attaches the user to `req.user`

### Example code (middleware)

```javascript
// Example: src/middleware/authenticateUser.js
const authenticateUser = async (req, res, next) => {
  const userId = req.headers['x-user-id'];

  if (!userId) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'x-user-id header required for authentication'
    });
  }

  try {
    // Example lookup (use prepared statements via your DB library)
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Invalid user'
      });
    }

    req.user = result.rows[0];
    return next();
  } catch (error) {
    return next(error);
  }
};

module.exports = authenticateUser;
```

## 2) Production recommendations

`DESIGN_DOC.MD` recommends:
- **Session cookies** (recommended)
- **JWT in `Authorization: Bearer <token>`** (alternative)
- **CSRF protection** when using cookies

### Session cookies (recommended)

Why sessions are a good default:
- Tokens are not exposed to JavaScript when using `HttpOnly` cookies
- Logout is straightforward (invalidate session server-side)
- Rotation/refresh is handled with session lifecycle rather than complex JWT refresh flows

Recommended cookie settings:
- `HttpOnly: true`
- `Secure: true` (in production)
- `SameSite: Strict` (or `Lax` if strict breaks legitimate flows)
- Short-ish TTL + rolling renewal (implementation choice)

### JWT in Authorization header (alternative)

Use when:
- You have a stateless auth requirement
- You’re building a pure API for multiple clients

Trade-offs:
- JWTs are hard to revoke prior to expiration (see `DESIGN_DOC.MD` security note)
- Rotation/refresh must be designed carefully
- Tokens must be stored safely on the client

### CSRF protection for cookies

If cookies authenticate requests, browsers will attach them automatically, which introduces CSRF risk.

Mitigations:
- `SameSite` cookies (first line of defense)
- CSRF tokens for state-changing endpoints (`POST /api/referral/redeem`, etc.)
- Consider requiring a custom header (e.g. `X-CSRF-Token`) validated server-side

## 3) Implementation examples

### Auth middleware (production shape)

In production, swap the development `x-user-id` logic for one of:
- Session validation (cookie → session store → user)
- Bearer JWT validation (`Authorization` header → verify → user lookup)

Example: bearer JWT middleware skeleton:

```javascript
const authenticateBearerJwt = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'Authorization header required'
    });
  }

  const token = header.slice('Bearer '.length);

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // Recommended: always fetch user from DB (DB = authorization)
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [decoded.userId]);
    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Unauthorized', message: 'Invalid user' });
    }
    req.user = result.rows[0];
    return next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'Invalid or expired token'
    });
  }
};
```

### Session management (example outline)

Session-based auth requires:
- A session store (in-memory for dev, Redis/Postgres for production)
- Login endpoint that creates a session and sets the cookie
- Middleware that maps cookie → session → user

Key behaviors:
- Session ID stored only in cookie (HttpOnly)
- Session record references `user_id`
- Session expiry enforced server-side

### Logout flow

Logout should be explicit and server-enforced:
- Delete/invalidate the session server-side
- Clear the session cookie in the response

Example response envelope:

```json
{
  "success": true,
  "message": "Logged out"
}
```

## 4) Security considerations

### Never log passwords (or full tokens)

From `CLAUDE.MD` security practices:
- Do not log plaintext passwords.
- Do not log full JWTs/referral tokens. If necessary, log a short prefix only.

### Secure cookie settings

For session cookies:
- `HttpOnly` prevents access from client-side JavaScript
- `Secure` ensures cookies are only sent over HTTPS
- `SameSite` reduces CSRF risk

### Token rotation

If you use bearer JWTs:
- Keep access tokens short-lived
- Use refresh tokens with rotation (store refresh tokens securely; revoke on reuse)
- Consider a server-side allowlist/denylist if immediate revocation is a requirement

## Practical checklist

- [ ] All protected endpoints require auth middleware
- [ ] Development uses `x-user-id` header with DB lookup
- [ ] Production uses either sessions (recommended) or bearer JWTs
- [ ] Cookie auth includes CSRF mitigation (`SameSite` + CSRF token strategy)
- [ ] No sensitive logs (passwords, full tokens)
- [ ] All DB queries use prepared statements

