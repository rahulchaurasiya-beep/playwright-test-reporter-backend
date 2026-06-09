import type { TestStatus } from "../../types.js";

export const FAILED_STATUSES: TestStatus[] = ["failed", "timedOut", "interrupted"];

export function specKey(specPath: string): string {
  return specPath.replace(/[/\\]/g, "__");
}

export function worstStatus(current: TestStatus, next: TestStatus): TestStatus {
  if (FAILED_STATUSES.includes(next)) return next;
  if (FAILED_STATUSES.includes(current)) return current;
  if (current === "skipped" || next === "skipped") return "skipped";
  return "passed";
}
