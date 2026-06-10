/** SQL expression for run wall-clock duration with fallback from shard/test timestamps. */
export function runDurationMsSql(runAlias = "r"): string {
  return `COALESCE(
    NULLIF(${runAlias}.duration_ms, 0),
    (
      SELECT ROUND(EXTRACT(EPOCH FROM (latest.end_at - ${runAlias}.created_at::timestamptz)) * 1000)::int
      FROM (
        SELECT GREATEST(
          COALESCE(
            (SELECT MAX(s.ended_at)::timestamptz FROM shards s WHERE s.ci_build_id = ${runAlias}.ci_build_id AND s.ended_at IS NOT NULL),
            '-infinity'::timestamptz
          ),
          COALESCE(
            (SELECT MAX(t.ended_at)::timestamptz FROM tests t WHERE t.ci_build_id = ${runAlias}.ci_build_id),
            '-infinity'::timestamptz
          ),
          ${runAlias}.ended_at::timestamptz,
          ${runAlias}.created_at::timestamptz
        ) AS end_at
      ) latest
      WHERE latest.end_at > ${runAlias}.created_at::timestamptz
        AND (
          EXISTS (SELECT 1 FROM shards s WHERE s.ci_build_id = ${runAlias}.ci_build_id)
          OR EXISTS (SELECT 1 FROM tests t WHERE t.ci_build_id = ${runAlias}.ci_build_id)
        )
    )
  )`;
}
