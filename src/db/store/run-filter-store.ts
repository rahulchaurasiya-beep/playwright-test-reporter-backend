import type { DbClient } from "../postgres-db-client.js";
import type { GitInfo } from "../../types.js";

export type RunFilterAuthor = {
  key: string;
  name: string | null;
  email: string | null;
  runCount: number;
};

export type RunFilterOptions = {
  authors: RunFilterAuthor[];
  branches: string[];
};

function authorKey(git: GitInfo): string | null {
  const email = git.authorEmail?.trim();
  const name = git.authorName?.trim();
  if (email) return email.toLowerCase();
  if (name) return name.toLowerCase();
  return null;
}

export class RunFilterStore {
  constructor(private readonly db: DbClient) {}

  async getFilterOptions(projectId: string): Promise<RunFilterOptions> {
    await this.syncFromRuns(projectId);

    const authors = await this.db.query<{
      author_key: string;
      author_name: string | null;
      author_email: string | null;
      run_count: number | string;
    }>(
      `SELECT author_key, author_name, author_email, run_count
       FROM project_authors
       WHERE project_id = $1
       ORDER BY last_seen_at DESC, author_name ASC`,
      [projectId],
    );

    const branches = await this.db.query<{ branch: string }>(
      `SELECT branch FROM project_branches
       WHERE project_id = $1
       ORDER BY last_seen_at DESC, branch ASC`,
      [projectId],
    );

    return {
      authors: authors.map((row) => ({
        key: row.author_key,
        name: row.author_name,
        email: row.author_email,
        runCount: Number(row.run_count),
      })),
      branches: branches.map((row) => row.branch),
    };
  }

  async recordRun(projectId: string, git: GitInfo, seenAt: string): Promise<void> {
    const key = authorKey(git);
    if (key) {
      await this.db.execute(
        `INSERT INTO project_authors (project_id, author_key, author_name, author_email, run_count, last_seen_at)
         VALUES ($1, $2, $3, $4, 1, $5)
         ON CONFLICT(project_id, author_key) DO UPDATE SET
           author_name = COALESCE(EXCLUDED.author_name, project_authors.author_name),
           author_email = COALESCE(EXCLUDED.author_email, project_authors.author_email),
           run_count = project_authors.run_count + 1,
           last_seen_at = EXCLUDED.last_seen_at`,
        [
          projectId,
          key,
          git.authorName?.trim() || null,
          git.authorEmail?.trim() || null,
          seenAt,
        ],
      );
    }

    const branch = git.branch?.trim();
    if (branch) {
      await this.db.execute(
        `INSERT INTO project_branches (project_id, branch, run_count, last_seen_at)
         VALUES ($1, $2, 1, $3)
         ON CONFLICT(project_id, branch) DO UPDATE SET
           run_count = project_branches.run_count + 1,
           last_seen_at = EXCLUDED.last_seen_at`,
        [projectId, branch, seenAt],
      );
    }
  }

  async syncFromRuns(projectId: string): Promise<void> {
    await this.db.execute(
      `INSERT INTO project_authors (project_id, author_key, author_name, author_email, run_count, last_seen_at)
       SELECT
         r.project_id,
         COALESCE(NULLIF(TRIM((r.git::jsonb)->>'authorEmail'), ''), NULLIF(TRIM((r.git::jsonb)->>'authorName'), ''), 'unknown'),
         NULLIF(TRIM((r.git::jsonb)->>'authorName'), ''),
         NULLIF(TRIM((r.git::jsonb)->>'authorEmail'), ''),
         COUNT(*)::int,
         MAX(r.created_at)
       FROM runs r
       WHERE r.project_id = $1
         AND (
           NULLIF(TRIM((r.git::jsonb)->>'authorName'), '') IS NOT NULL
           OR NULLIF(TRIM((r.git::jsonb)->>'authorEmail'), '') IS NOT NULL
         )
       GROUP BY r.project_id,
         COALESCE(NULLIF(TRIM((r.git::jsonb)->>'authorEmail'), ''), NULLIF(TRIM((r.git::jsonb)->>'authorName'), ''), 'unknown'),
         NULLIF(TRIM((r.git::jsonb)->>'authorName'), ''),
         NULLIF(TRIM((r.git::jsonb)->>'authorEmail'), '')
       ON CONFLICT (project_id, author_key) DO UPDATE SET
         author_name = EXCLUDED.author_name,
         author_email = EXCLUDED.author_email,
         run_count = EXCLUDED.run_count,
         last_seen_at = EXCLUDED.last_seen_at`,
      [projectId],
    );

    await this.db.execute(
      `INSERT INTO project_branches (project_id, branch, run_count, last_seen_at)
       SELECT r.project_id, TRIM((r.git::jsonb)->>'branch'), COUNT(*)::int, MAX(r.created_at)
       FROM runs r
       WHERE r.project_id = $1 AND NULLIF(TRIM((r.git::jsonb)->>'branch'), '') IS NOT NULL
       GROUP BY r.project_id, TRIM((r.git::jsonb)->>'branch')
       ON CONFLICT (project_id, branch) DO UPDATE SET
         run_count = EXCLUDED.run_count,
         last_seen_at = EXCLUDED.last_seen_at`,
      [projectId],
    );
  }
}
