export type DailyRunAnalytics = {
  date: string;
  failed: number;
  passed: number;
  total: number;
  passRate: number | null;
};

export type ProjectRunAnalytics = {
  dateFrom: string;
  dateTo: string;
  overallRuns: number;
  failed: number;
  passed: number;
  avgPassRate: number | null;
  trendline: number | null;
  daily: DailyRunAnalytics[];
};

export function defaultAnalyticsRange(): { dateFrom: string; dateTo: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30);
  return {
    dateFrom: from.toISOString().slice(0, 10),
    dateTo: to.toISOString().slice(0, 10),
  };
}

export function parseAnalyticsQuery(query: Record<string, unknown>): { dateFrom: string; dateTo: string } {
  const pick = (key: string) => {
    const value = query[key];
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : undefined;
  };

  const defaults = defaultAnalyticsRange();
  const dateFrom = pick("dateFrom") ?? defaults.dateFrom;
  const dateTo = pick("dateTo") ?? defaults.dateTo;

  if (dateFrom > dateTo) {
    return { dateFrom: dateTo, dateTo: dateFrom };
  }

  return { dateFrom, dateTo };
}
