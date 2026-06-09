export type RunSearchFilters = {
  projectId: string;
  q?: string;
  author?: string;
  branch?: string;
  status?: string;
  completion?: string;
  prTitle?: string;
  commitMessage?: string;
  ciBuildId?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
};

export type RunListSummary = {
  ciBuildId: string;
  projectId: string;
  status: string;
  branch: string | null;
  sha: string | null;
  authorName: string | null;
  authorEmail: string | null;
  commitMessage: string | null;
  prTitle: string | null;
  createdAt: string;
  endedAt: string | null;
  durationMs: number | null;
  tags: string[];
  shardCount: number;
  specCount: number;
  passed: number;
  failed: number;
  skipped: number;
};

export type RunSearchResult = {
  runs: RunListSummary[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
};

export function parseRunSearchQuery(query: Record<string, unknown>): RunSearchFilters {
  const pick = (key: string) => {
    const value = query[key];
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };

  const page = Number.parseInt(String(query.page ?? "1"), 10);
  const pageSize = Number.parseInt(String(query.pageSize ?? "50"), 10);

  return {
    projectId: pick("projectId") ?? "",
    q: pick("q"),
    author: pick("author"),
    branch: pick("branch"),
    status: pick("status"),
    completion: pick("completion"),
    prTitle: pick("prTitle"),
    commitMessage: pick("commitMessage"),
    ciBuildId: pick("ciBuildId"),
    dateFrom: pick("dateFrom"),
    dateTo: pick("dateTo"),
    page: Number.isFinite(page) && page > 0 ? page : 1,
    pageSize: Number.isFinite(pageSize) && pageSize > 0 ? Math.min(pageSize, 50) : 50,
  };
}

export function endOfDayIso(dateOnly: string): string {
  return `${dateOnly}T23:59:59.999Z`;
}
