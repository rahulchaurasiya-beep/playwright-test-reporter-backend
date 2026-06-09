# Playwright Reporter Backend

HTTP API that receives test results from [`playwright-rocketium-reporter`](../rocketium-playwright-reporter) and stores them in a **Currents-style** hierarchy: **Run → Shards → Specs → Tests → Artifacts**.

Designed to replace Currents.dev for Rocketium E2E runs (staging sharding, CI, local dev).

---

## High-level architecture

```mermaid
flowchart TB
  subgraph clients["Clients"]
    PW[Playwright tests]
    R[playwright-rocketium-reporter]
    UI[Future dashboard UI]
  end

  subgraph backend["playwright-reporter-backend :3000"]
    API[Express API /api/v1]
    AUTH[Bearer auth optional]
    STORE[(Run store)]
  end

  subgraph metadata["Metadata storage"]
    PG[(PostgreSQL)]
  end

  subgraph files["Binary storage"]
    UP[uploads/ ciBuildId / testId / files]
  end

  PW --> R
  R -->|JSON + multipart| API
  UI -->|GET| API
  API --> AUTH --> STORE
  STORE --> PG
  API -->|multer| UP
  STORE -.->|artifact paths| UP
```

### Data hierarchy (UI model)

```mermaid
flowchart LR
  Run --> Shard1[Shard 1]
  Run --> Shard2[Shard 2]
  Shard1 --> SpecA[spec.ts]
  SpecA --> Test1[Test]
  SpecA --> Test2[Test]
  Test1 --> Art1[Screenshot]
  Test1 --> Art2[Video]
  Test2 --> Art3[error-context.md]
```

| Level | Description | Example id |
|-------|-------------|------------|
| **Run** | One CI build / local run | `local-1780602020`, `github-12345` |
| **Shard** | Parallel machine / shard index | `shardNumber: 1..12` |
| **Spec** | One `.spec.ts` file in a shard | `e2e/.../importMedia.spec.ts` |
| **Test** | Single Playwright test case | Playwright `test.id` |
| **Artifact** | Screenshot, video, trace, etc. | `testId-screenshot-1738...` |

---

## Storage

Two layers: **metadata** (run tree) and **binaries** (files).

```mermaid
flowchart TB
  subgraph meta["Metadata — PostgreSQL"]
    P[PostgreSQL<br/>DATABASE_URL]
  end

  subgraph binary["Binaries — always on disk"]
    U[UPLOADS_DIR/<br/>ciBuildId/testId/timestamp-name]
  end

  API[Reporter API] --> meta
  API --> binary
  meta -->|file_path column| U
```

### Metadata storage

Run metadata is stored in **PostgreSQL**. Set `DATABASE_URL` or run `pnpm db:up`. JSON file storage is not supported.

**Binaries are never stored inside the DB.** The `artifacts` table (or JSON on the test) only keeps `file_path`, `content_type`, `size_bytes`, and `name`. Max upload size: **200 MB** per file.

### On-disk layout

```
playwright-reporter-backend/
├── data/                    # Legacy JSON (unused)
└── uploads/
    └── local-123/
        └── <testId>/
            ├── 1738...-screenshot.png
            ├── 1738...-video.webm
            └── 1738...-error-context.md
```

---

## Database

Schema is created on startup (`CREATE TABLE IF NOT EXISTS`). See [`src/db/schema.ts`](src/db/schema.ts).

```mermaid
erDiagram
  runs ||--o{ shards : has
  shards ||--o{ specs : has
  specs ||--o{ tests : has
  tests ||--o{ artifacts : has

  runs {
    text ci_build_id PK
    text project_id
    text status
    int expected_shard_count
    text tags
    text git
    text ci
    text created_at
  }

  shards {
    text ci_build_id PK
    int shard_number PK
    text machine_id
    int finished
    text summary
  }

  specs {
    text ci_build_id PK
    int shard_number PK
    text spec_key PK
    text spec_path
    text status
  }

  tests {
    text test_id PK
    text status
    text error
    text title
  }

  artifacts {
    text id PK
    text file_path
    text content_type
    int size_bytes
  }
```

| Table | Purpose |
|-------|---------|
| `runs` | Build-level status, git/CI info, timing |
| `shards` | Per-shard summary when finished |
| `specs` | Aggregated status per spec file |
| `tests` | Each test result + error JSON |
| `artifacts` | Pointers to files under `uploads/` |

More detail: [`docs/DATABASE.md`](docs/DATABASE.md).

---

## API routes

Base URL: `http://localhost:3000` (configurable via `PORT`).

Reporter auth (required on `/api/v1`): per-project credentials from the UI — `Authorization: Bearer <project-api-key>` and `X-Project-Id: <projectId>`.

### Public

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Service health + storage hint |
| `GET` | `/uploads/*` | Static files (direct path access) |

### `/api/v1` (reporter writes + UI reads)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/runs` | List runs (summary fields) |
| `GET` | `/runs/:ciBuildId` | Full run tree (shards, specs, tests, artifacts) |
| `POST` | `/runs/start` | Create or join run + register shard |
| `POST` | `/runs/tests` | Report one test end (pass/fail + error) |
| `POST` | `/runs/artifacts` | Upload file (`multipart/form-data`) |
| `GET` | `/artifacts/:artifactId/file` | Stream artifact (screenshot/video) |
| `POST` | `/runs/shard/finish` | Mark shard done + update run status |

### Request flow (one shard)

```mermaid
sequenceDiagram
  participant R as Reporter
  participant API as Backend

  R->>API: POST /runs/start
  loop each test
    R->>API: POST /runs/tests
    opt failed / timedOut
      R->>API: POST /runs/artifacts (×N)
    end
  end
  R->>API: POST /runs/shard/finish
```

### Payload notes

**`POST /runs/start`** — `projectId`, `ciBuildId`, `shardNumber`, `expectedShardCount`, `machineId`, `git`, `ci`, `playwrightVersion`, `startedAt`.

**`POST /runs/tests`** — `ciBuildId`, `shardNumber`, `testId`, `specPath`, `title[]`, `status`, `durationMs`, `error` (nullable), timings, `retryIndex`.

**`POST /runs/artifacts`** — form fields: `ciBuildId`, `shardNumber`, `testId`, `specPath`, `name`, `contentType`, file field **`file`**.  
Test row must exist first (same order as reporter).

**`POST /runs/shard/finish`** — `ciBuildId`, `shardNumber`, `summary` (`passed`, `failed`, `skipped`, …).

Failure artifacts: [`docs/FAILURE_AND_ARTIFACTS.md`](docs/FAILURE_AND_ARTIFACTS.md).

---

## Quick start

### Requirements

- Node.js ≥ 20
- pnpm

### Install

```bash
pnpm install
cp .env.example .env
```

### Start the API

```bash
pnpm db:up          # Docker: postgres:16 on :5432
pnpm dev
```

### Wire automation tests

In `automation-tests-2.0/.env`:

```env
REPORTER_API_URL=http://localhost:3000
REPORTER_PROJECT_ID=9gEjLh
REPORTER_API_KEY=rptr_live_...   # from project settings in the UI
```

```bash
# automation-tests-2.0
pnpm test:local-shards
```

### Inspect a run

```bash
pnpm summary              # list runs from API
pnpm summary local-123    # print Run → Shards → Specs → Tests
```

---

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start API with hot reload (`tsx watch`) |
| `pnpm build` | Compile TypeScript |
| `pnpm start` | Run compiled `dist/index.js` |
| `pnpm type-check` | TypeScript check |
| `pnpm summary [ciBuildId]` | CLI run tree ([`scripts/print-run-summary.js`](scripts/print-run-summary.js)) |
| `pnpm db:up` | `docker compose up -d` (Postgres) |
| `pnpm db:down` | Stop Postgres container |
| `pnpm db:logs` | Follow Postgres logs |

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP port |
| `DATABASE_URL` | `postgresql://...@localhost:5432/rocketium_e2e_runs` | Postgres connection string |
| `DATA_DIR` | `./data` | Legacy data directory |
| `UPLOADS_DIR` | `./uploads` | Artifact files root |

Reporter clients use per-project `REPORTER_PROJECT_ID` + `REPORTER_API_KEY` (not a backend env var).

---

## Project layout

```
src/
├── index.ts              # Express app entry
├── routes/runs.ts        # API routes
├── auth.ts
└── db/
    ├── schema.ts         # SQL DDL
    ├── postgres-db-client.ts
    └── store/            # Data access layer (queries + mapping)
        ├── create.ts     # DB wiring
        ├── run-store.ts  # Reporter run CRUD
        ├── project-store.ts
        ├── run-query-store.ts
        ├── run-filter-store.ts
        └── analytics-store.ts
docs/
├── DATABASE.md
└── FAILURE_AND_ARTIFACTS.md
```

---

## Related repos

| Repo | Role |
|------|------|
| [`rocketium-playwright-reporter`](../rocketium-playwright-reporter) | Playwright reporter package (sends events to this API) |
| [`automation-tests-2.0`](../automation-tests-2.0) | E2E suite + `reporter.config.ts` + local shard runner |

---

## Roadmap

- [ ] Web UI (run list, drill-down, artifact viewer)
- [ ] S3-backed `uploads/` for CI
- [ ] Formal migrations (e.g. Drizzle / node-pg-migrate)
- [ ] Retention / cleanup jobs for old runs and files
