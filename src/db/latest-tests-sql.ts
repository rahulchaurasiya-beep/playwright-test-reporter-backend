export function latestTestsForSpecSql(): string {
  return `SELECT DISTINCT ON (t.test_id) t.status, t.duration_ms, t.started_at
          FROM tests t
          WHERE t.ci_build_id = $1 AND t.shard_number = $2 AND t.spec_key = $3
          ORDER BY t.test_id, t.retry_index DESC`;
}

export function latestTestCountSql(status: "passed" | "skipped" | "failed"): string {
  const failedFilter = "IN ('failed', 'timedOut', 'interrupted')";
  const statusFilter =
    status === "passed"
      ? "= 'passed'"
      : status === "skipped"
        ? "= 'skipped'"
        : failedFilter;

  return `(SELECT COUNT(*)::int FROM (
    SELECT DISTINCT ON (t.test_id) t.status
    FROM tests t
    WHERE t.ci_build_id = r.ci_build_id
    ORDER BY t.test_id, t.retry_index DESC
  ) latest WHERE latest.status ${statusFilter})`;
}

export function latestProjectTestStatsSql(): string {
  return `SELECT
    COUNT(DISTINCT r.ci_build_id)::int AS run_count,
    MAX(r.created_at) AS last_run_at,
    COALESCE(SUM(CASE WHEN latest.status = 'passed' THEN 1 ELSE 0 END), 0)::int AS passed,
    COALESCE(SUM(CASE WHEN latest.status IN ('failed', 'timedOut', 'interrupted') THEN 1 ELSE 0 END), 0)::int AS failed,
    COALESCE(SUM(CASE WHEN latest.status = 'skipped' THEN 1 ELSE 0 END), 0)::int AS skipped
  FROM runs r
  LEFT JOIN (
    SELECT DISTINCT ON (t.ci_build_id, t.test_id) t.ci_build_id, t.status
    FROM tests t
    ORDER BY t.ci_build_id, t.test_id, t.retry_index DESC
  ) latest ON latest.ci_build_id = r.ci_build_id
  WHERE r.project_id = $1`;
}
