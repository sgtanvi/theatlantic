# Getting Started

Local development setup for the Atlantic Referral Program backend.

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (includes Docker Compose)
- Node.js 20+ (only needed if running outside Docker)
- Git

## Quick Start (Docker — recommended)

```bash
# 1. Clone the repo
git clone https://github.com/sgtanvi/theatlantic.git
cd theatlantic

# 2. Start the database
docker compose up -d postgres

# 3. Run the API server
docker compose up app
# Server available at http://localhost:3000
```

## Run Tests

```bash
# Run the full test suite (database + unit + integration)
docker compose run --rm test

# Watch mode (re-runs on file change) — requires local Node
npm test -- --watch
```

All 87 tests should pass on a clean clone.

## Environment Variables

Configured via `docker-compose.yml` — no `.env` file needed for local development.

| Variable | Default (dev) | Description |
|---|---|---|
| `DB_HOST` | `postgres` | PostgreSQL hostname (Docker service name) |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_NAME` | `atlantic_referral` | Database name |
| `DB_USER` | `postgres` | Database user |
| `DB_PASSWORD` | `postgres` | Database password |
| `JWT_SECRET` | `dev_secret_change_in_prod` | Secret for signing referral pass JWTs |
| `NODE_ENV` | `development` | Environment flag |
| `PORT` | `3000` | API server port |

> **Production**: set `JWT_SECRET` to a strong random value and never commit it.

## npm Scripts

```bash
npm run dev       # Start server with hot-reload (nodemon)
npm start         # Start server (no hot-reload)
npm test          # Run Jest test suite
npm test -- --watch     # Watch mode
npm test -- --coverage  # Coverage report
```

## Database Setup

The Docker Compose Postgres container auto-runs `database/schema.sql` on first start.
If you need to reset the database:

```bash
# Tear down and recreate (drops all data)
docker compose down -v
docker compose up -d postgres
```

## Project Structure

See [`DocumentationStructure.MD`](../DocumentationStructure.MD) in the docs folder for the full
directory layout. Key directories:

```
src/
├── config/       # DB pool, environment
├── middleware/   # Auth (x-user-id header), error handler
├── services/     # Business logic (ReferralService)
├── controllers/  # HTTP handlers
└── routes/       # Express route wiring

tests/
├── database/     # PostgreSQL trigger + function tests
├── unit/         # Pure function tests (email normalization)
├── integration/  # End-to-end HTTP tests (supertest)
└── helpers/      # Test factories (createUser, createValidPass, …)
```

## Next Steps

- **[Implementation Guide](implementation.md)** — TDD build order and code patterns
- **[Testing Guide](testing.md)** — Test strategy and writing new tests
- **[API Endpoints](../api/endpoints.md)** — Full REST API reference
- **[Database Schema](../database/schema.md)** — Table definitions and constraints
