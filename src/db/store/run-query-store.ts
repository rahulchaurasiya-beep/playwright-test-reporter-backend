import { latestTestCountSql } from "../latest-tests-sql.js";
import type { DbClient } from "../postgres-db-client.js";
import type { CiInfo, GitInfo } from "../../types.js";
import type { RunListSummary, RunSearchFilters, RunSearchResult } from "../../types/run-search.js";
import { endOfDayIso } from "../../types/run-search.js";

type SearchRow = {
  ci_build_id: string;
  project_id: string;
  status: string;
  tags: string;
  git: string;
  ci: string;
  created_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  shard_count: number | string;
  spec_count: number | string;
  passed: number | string;
  failed: number | string;
  skipped: number | string;
};

function likePattern(value: string): string {
  return `%${value.replace(/[%_\\]/g, "\\$&")}%`;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function mapRow(row: SearchRow): RunListSummary {
  const git = parseJson<GitInfo>(row.git, {
    branch: null,
    sha: null,
    authorName: null,
    authorEmail: null,
    commitMessage: null,
    remoteOrigin: null,
  });
  const ci = parseJson<CiInfo>(row.ci, {
    ciBuildId: row.ci_build_id,
    workflowRunId: null,
    workflowRunUrl: null,
    repository: null,
    prTitle: null,
    prNumber: null,
  });

  return {
    ciBuildId: row.ci_build_id,
    projectId: row.project_id,
    status: row.status,
    branch: git.branch,
    sha: git.sha,
    authorName: git.authorName,
    authorEmail: git.authorEmail,
    commitMessage: git.commitMessage,
    prTitle: ci.prTitle,
    createdAt: row.created_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    tags: parseJson<string[]>(row.tags, []),
    shardCount: Number(row.shard_count),
    specCount: Number(row.spec_count),
    passed: Number(row.passed),
    failed: Number(row.failed),
    skipped: Number(row.skipped),
  };
}

export class RunQueryStore {
  constructor(private readonly db: DbClient) {}

  async search(input: RunSearchFilters): Promise<RunSearchResult> {
    const page = input.page ?? 1;
    const pageSize = Math.min(input.pageSize ?? 50, 50);
    const offset = (page - 1) * pageSize;

    const dateFrom = input.dateFrom ? `${input.dateFrom}T00:00:00.000Z` : null;
    const dateTo = input.dateTo ? endOfDayIso(input.dateTo) : null;
    const combinedQuery = input.q ? likePattern(input.q) : null;

    const params = [
      input.projectId,
      input.status ?? null,
      combinedQuery,
      !input.q && input.ciBuildId ? likePattern(input.ciBuildId) : null,
      !input.q && input.commitMessage ? likePattern(input.commitMessage) : null,
      !input.q && input.prTitle ? likePattern(input.prTitle) : null,
      input.author ? input.author.toLowerCase() : null,
      input.branch ?? null,
      input.completion ?? null,
      dateFrom,
      dateTo,
    ];

    const whereClause = `r.project_id = $1
      AND ($2::text IS NULL OR r.status = $2)
      AND ($3::text IS NULL OR (
        r.ci_build_id ILIKE $3
        OR (r.git::jsonb)->>'commitMessage' ILIKE $3
        OR (r.ci::jsonb)->>'prTitle' ILIKE $3
      ))
      AND ($4::text IS NULL OR r.ci_build_id ILIKE $4)
      AND ($5::text IS NULL OR (r.git::jsonb)->>'commitMessage' ILIKE $5)
      AND ($6::text IS NULL OR (r.ci::jsonb)->>'prTitle' ILIKE $6)
      AND ($7::text IS NULL OR LOWER(COALESCE(NULLIF((r.git::jsonb)->>'authorEmail', ''), (r.git::jsonb)->>'authorName')) = $7)
      AND ($8::text IS NULL OR (r.git::jsonb)->>'branch' = $8)
      AND (
        $9::text IS NULL
        OR ($9 = 'completed' AND r.ended_at IS NOT NULL AND r.status <> 'running')
        OR ($9 = 'in_progress' AND (r.status = 'running' OR r.ended_at IS NULL))
      )
      AND ($10::text IS NULL OR r.created_at >= $10)
      AND ($11::text IS NULL OR r.created_at <= $11)`;

    const countRow = await this.db.queryOne<{ total: number | string }>(
      `SELECT COUNT(*) AS total FROM runs r WHERE ${whereClause}`,
      params,
    );
    const total = Number(countRow?.total ?? 0);
    const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);

    const listSql = `SELECT
      r.ci_build_id,
      r.project_id,
      r.status,
      r.tags,
      r.git,
      r.ci,
      r.created_at,
      r.ended_at,
      r.duration_ms,
      (SELECT COUNT(*)::int FROM shards s WHERE s.ci_build_id = r.ci_build_id) AS shard_count,
      (SELECT COUNT(*)::int FROM specs sp WHERE sp.ci_build_id = r.ci_build_id) AS spec_count,
      ${latestTestCountSql("passed")} AS passed,
      ${latestTestCountSql("skipped")} AS skipped,
      ${latestTestCountSql("failed")} AS failed
    FROM runs r
    WHERE ${whereClause}
    ORDER BY r.created_at DESC
    LIMIT $12 OFFSET $13`;

    const rows = await this.db.query<SearchRow>(listSql, [...params, pageSize, offset]);

    return {
      runs: rows.map(mapRow),
      pagination: { page, pageSize, total, totalPages },
    };
  }
}
