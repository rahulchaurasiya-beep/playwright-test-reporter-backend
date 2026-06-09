import type { DbClient } from "../postgres-db-client.js";
import type { DailyRunAnalytics, ProjectRunAnalytics } from "../../types/analytics.js";
import { endOfDayIso } from "../../types/run-search.js";

type DailyRow = {
  day: string;
  total: number | string;
  passed: number | string;
  failed: number | string;
};

function mapDailyRow(row: DailyRow): DailyRunAnalytics {
  const passed = Number(row.passed);
  const failed = Number(row.failed);
  const total = Number(row.total);
  return {
    date: row.day,
    passed,
    failed,
    total,
    passRate: total > 0 ? Math.round((passed / total) * 10000) / 100 : null,
  };
}

function computeTrendline(daily: DailyRunAnalytics[]): number | null {
  const points = daily
    .filter((row) => row.passRate !== null)
    .map((row, index) => ({ x: index, y: row.passRate as number }));

  if (points.length < 2) return null;

  const n = points.length;
  const sumX = points.reduce((acc, point) => acc + point.x, 0);
  const sumY = points.reduce((acc, point) => acc + point.y, 0);
  const sumXY = points.reduce((acc, point) => acc + point.x * point.y, 0);
  const sumX2 = points.reduce((acc, point) => acc + point.x * point.x, 0);
  const denominator = n * sumX2 - sumX * sumX;

  if (denominator === 0) return null;

  const slope = (n * sumXY - sumX * sumY) / denominator;
  return Math.round(slope * 100) / 100;
}

export class AnalyticsStore {
  constructor(private readonly db: DbClient) {}

  async getRunStatusAnalytics(
    projectId: string,
    dateFrom: string,
    dateTo: string,
  ): Promise<ProjectRunAnalytics> {
    const fromIso = `${dateFrom}T00:00:00.000Z`;
    const toIso = endOfDayIso(dateTo);

    const rows = await this.db.query<DailyRow>(
      `SELECT
        to_char((r.created_at::timestamptz AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
        COUNT(*)::int AS total,
        SUM(CASE WHEN r.status = 'passed' THEN 1 ELSE 0 END)::int AS passed,
        SUM(CASE WHEN r.status <> 'passed' THEN 1 ELSE 0 END)::int AS failed
      FROM runs r
      WHERE r.project_id = $1
        AND r.created_at >= $2
        AND r.created_at <= $3
      GROUP BY (r.created_at::timestamptz AT TIME ZONE 'UTC')::date
      ORDER BY day ASC`,
      [projectId, fromIso, toIso],
    );

    const daily = rows.map(mapDailyRow);
    const overallRuns = daily.reduce((acc, row) => acc + row.total, 0);
    const passed = daily.reduce((acc, row) => acc + row.passed, 0);
    const failed = daily.reduce((acc, row) => acc + row.failed, 0);
    const avgPassRate =
      overallRuns > 0 ? Math.round((passed / overallRuns) * 10000) / 100 : null;

    return {
      dateFrom,
      dateTo,
      overallRuns,
      failed,
      passed,
      avgPassRate,
      trendline: computeTrendline(daily),
      daily,
    };
  }
}
