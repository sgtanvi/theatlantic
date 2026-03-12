# Deployment guide (production)

This document is a production deployment runbook for the Atlantic Referral Program backend (Node.js + Express + PostgreSQL).

It is based on production considerations in `DESIGN_DOC.MD` and the performance/security standards in `CLAUDE.MD`.

## 1) Environment setup

### Required environment variables

At minimum, production deployments should provide:

- **JWT / auth**
  - `JWT_SECRET` (required; never hardcode)
- **Database**
  - `DB_HOST`
  - `DB_PORT`
  - `DB_NAME`
  - `DB_USER`
  - `DB_PASSWORD`
- **Runtime**
  - `NODE_ENV=production`
  - `PORT`

Recommended:
- A startup environment validation function (see `CLAUDE.MD`) that fails fast if required variables are missing.

### Database setup in production

Recommendations:
- Use a managed PostgreSQL offering when possible.
- Enable automated backups and point-in-time recovery.
- Ensure the database role used by the app has:
  - Read/write on application tables
  - Permission to execute required functions
  - Migration privileges only for the migration job (prefer a separate role)

### SSL/TLS certificates

Requirements:
- **HTTPS-only** for the API.
- Terminate TLS at a load balancer/reverse proxy (common) or in the app server.
- Enforce modern TLS and automatic renewal (e.g., ACME) if managing certificates yourself.

If connecting to PostgreSQL over the network:
- Require TLS to the DB where supported.

## 2) Database migration strategy

### Running migrations safely

General principles:
- Run migrations in **staging first**, then production.
- Prefer **small, reversible steps**.
- Make schema changes compatible with both “old” and “new” app versions during rollout.

Practical sequence:
- Deploy migration scripts
- Run migrations as a separate step/job (not on every app boot)
- Deploy the new application version after the database is ready

For v1 → v2 specifically, see `docs/database/migrations.md`.

### Rollback procedures

Rollback should be planned as two coordinated actions:

- **Application rollback**: deploy previous version of the app
- **Database rollback**: only if necessary; dropping columns/indexes can be destructive

Safer rollback approach:
- Prefer “soft rollbacks” (disable new behavior) when possible:
  - Drop triggers first
  - Remove constraints/indexes
  - Leave columns in place (if harmless) to preserve data

### Zero-downtime deployments

Guidelines for minimizing downtime:
- Avoid long blocking locks:
  - Create indexes concurrently when needed (with the operational trade-offs noted in `docs/database/migrations.md`)
- Add columns as nullable first, backfill, then enforce constraints.
- Ensure old and new code can run during a rolling deploy:
  - Avoid relying on a column before it exists
  - Avoid removing a column while old code might still reference it

## 3) Monitoring and logging

### What to log

Log events that help diagnose issues without leaking sensitive data.

Recommended fields:
- Request id / trace id
- Endpoint + method
- User id (if authenticated)
- Error type/status code
- Timing (latency)

Security rules (from `CLAUDE.MD`):
- Never log passwords.
- Never log full tokens (JWTs/referral tokens). If needed, log a short prefix only.

### What to monitor

Application:
- Error rate by route/status code
- Latency (p50/p95/p99) for redemption endpoints
- Rate limiting events (if enabled)

Database:
- Connection pool usage (active/idle/waiting)
- Query latency (slow query logs)
- Deadlocks/serialization failures (important for `SERIALIZABLE` redemption)

Health:
- `/health` endpoint for load balancer checks (`DESIGN_DOC.MD` recommends this)

### Alert thresholds (starting point)

Tune thresholds to your baseline, but reasonable starters:
- p95 latency for `POST /api/referral/redeem` above 1s for 10+ minutes
- 5xx rate above 1% for 5+ minutes
- DB connection pool exhaustion or sustained wait queue
- Spike in 409 conflicts beyond expected (could indicate abuse or a bug)

## 4) Scaling considerations

### Connection pooling

Use a PostgreSQL connection pool (from `CLAUDE.MD`):
- Set `max`, `idleTimeoutMillis`, `connectionTimeoutMillis`
- Use `pool.query()` for one-offs
- Use `pool.connect()` only for transactions (redemption flow)

### Read replicas

Read replicas can help if:
- Pass listing and stats become read-heavy
- You want to isolate OLTP writes from analytics reads

Constraints:
- Redemption must read/write against the primary (strong consistency).
- Replica lag can create confusing UI if reads are routed incorrectly.

### Caching strategy

Use caching selectively:
- Cache read-only or low-risk reads (e.g., “passes list” per referrer) with short TTLs.
- Avoid caching anything that can change due to redemption unless you have strong invalidation.

If you need token revocation or more advanced controls:
- A Redis store can support denylisting JWTs (not implemented in MVP per `DESIGN_DOC.MD`).

## 5) Security checklist

- [ ] Environment variables are stored securely (no secrets in repo)
- [ ] `JWT_SECRET` is set and rotated via secure process
- [ ] HTTPS-only (redirect HTTP → HTTPS)
- [ ] Cookies (if used) are `HttpOnly`, `Secure`, and `SameSite`
- [ ] CSRF mitigation enabled for cookie-authenticated endpoints
- [ ] Rate limiting enabled for redemption (recommended in `DESIGN_DOC.MD`)
- [ ] CORS is configured to only allow trusted origins
- [ ] Database credentials use least privilege
- [ ] Logs contain no sensitive data (passwords, full tokens)

## 6) Deployment checklist

Pre-deploy:
- [ ] Run full test suite and ensure green
- [ ] Verify required env vars present in production
- [ ] Confirm DB backups and restore procedure
- [ ] Run migrations in staging; validate with smoke tests

Deploy:
- [ ] Deploy migration job/scripts
- [ ] Run production migrations during a low-traffic window (when possible)
- [ ] Deploy application (rolling deploy)

Post-deploy verification:
- [ ] `/health` returns OK
- [ ] `GET /api/referral/passes` works for a known test user
- [ ] Redemption happy path works in staging/prod smoke test
- [ ] Monitor error rates, latency, DB pool saturation for 30–60 minutes

