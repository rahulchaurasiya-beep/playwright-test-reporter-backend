/** PostgreSQL schema. Uses INTEGER for boolean flags. */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runs (
  ci_build_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL,
  expected_shard_count INTEGER,
  tags TEXT NOT NULL DEFAULT '[]',
  git TEXT NOT NULL DEFAULT '{}',
  ci TEXT NOT NULL DEFAULT '{}',
  playwright_version TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER
);

CREATE TABLE IF NOT EXISTS shards (
  ci_build_id TEXT NOT NULL,
  shard_number INTEGER NOT NULL,
  machine_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  finished INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  PRIMARY KEY (ci_build_id, shard_number),
  FOREIGN KEY (ci_build_id) REFERENCES runs(ci_build_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS specs (
  ci_build_id TEXT NOT NULL,
  shard_number INTEGER NOT NULL,
  spec_key TEXT NOT NULL,
  spec_path TEXT NOT NULL,
  project_name TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  PRIMARY KEY (ci_build_id, shard_number, spec_key),
  FOREIGN KEY (ci_build_id, shard_number) REFERENCES shards(ci_build_id, shard_number) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tests (
  ci_build_id TEXT NOT NULL,
  shard_number INTEGER NOT NULL,
  spec_key TEXT NOT NULL,
  test_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  spec_path TEXT NOT NULL,
  title TEXT NOT NULL,
  test_order INTEGER NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  retry_index INTEGER NOT NULL DEFAULT 0,
  machine_id TEXT NOT NULL,
  error TEXT,
  PRIMARY KEY (ci_build_id, shard_number, spec_key, test_id, retry_index),
  FOREIGN KEY (ci_build_id, shard_number, spec_key) REFERENCES specs(ci_build_id, shard_number, spec_key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  ci_build_id TEXT NOT NULL,
  shard_number INTEGER NOT NULL,
  spec_key TEXT NOT NULL,
  test_id TEXT NOT NULL,
  retry_index INTEGER NOT NULL DEFAULT 0,
  spec_path TEXT NOT NULL,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  file_path TEXT NOT NULL,
  size_bytes INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (ci_build_id, shard_number, spec_key, test_id, retry_index)
    REFERENCES tests(ci_build_id, shard_number, spec_key, test_id, retry_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_project_id ON runs(project_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_test ON artifacts(ci_build_id, test_id, retry_index);

CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,
  api_key_prefix TEXT NOT NULL,
  api_key TEXT,
  timeout_minutes INTEGER NOT NULL DEFAULT 60,
  default_branch TEXT NOT NULL DEFAULT 'main',
  failing_fast INTEGER NOT NULL DEFAULT 0,
  run_title_source TEXT NOT NULL DEFAULT 'commit',
  integrations TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects(updated_at DESC);

CREATE TABLE IF NOT EXISTS project_authors (
  project_id TEXT NOT NULL,
  author_key TEXT NOT NULL,
  author_name TEXT,
  author_email TEXT,
  run_count INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (project_id, author_key)
);

CREATE TABLE IF NOT EXISTS project_branches (
  project_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  run_count INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (project_id, branch)
);

CREATE INDEX IF NOT EXISTS idx_project_authors_project ON project_authors(project_id);
CREATE INDEX IF NOT EXISTS idx_project_branches_project ON project_branches(project_id);

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  username TEXT UNIQUE,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
`;
