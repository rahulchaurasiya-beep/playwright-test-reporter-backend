# Database setup

## PostgreSQL

All run metadata is stored in PostgreSQL. JSON file storage (`data/*.json`) is **removed**.

Files (screenshots, videos) always live under `UPLOADS_DIR`; only metadata goes in the DB.

```bash
# Terminal 1 — database
pnpm db:up

# Terminal 2 — API
cp .env.example .env
pnpm dev
```

Default connection:

```
postgresql://postgres:YOUR_PASSWORD@localhost:5432/rocketium_e2e_runs
```

## Run tests against Postgres backend

In `automation-tests-2.0/.env`:

```
REPORTER_API_URL=http://localhost:3000
```

Then run Playwright tests with the reporter enabled. Data is in Postgres; artifacts in `playwright-reporter-backend/uploads/`.

## Schema

Schema is applied automatically on startup (`CREATE TABLE IF NOT EXISTS` in `src/db/schema.ts`).

`tests` and `artifacts` include `retry_index` so each Playwright retry is stored as its own row. Run/test counts in list views use the latest attempt per `test_id`.
