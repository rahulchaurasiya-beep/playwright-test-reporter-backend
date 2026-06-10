import type { RunRecord } from "../types.js";

type RunDurationInput = Pick<RunRecord, "createdAt" | "durationMs" | "endedAt" | "shards">;

function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Wall-clock run duration from stored value or latest shard/test activity. */
export function computeRunDurationMs(run: RunDurationInput): number | null {
  if (run.durationMs != null && run.durationMs > 0) {
    return run.durationMs;
  }

  const createdMs = parseTime(run.createdAt);
  if (createdMs == null) return null;

  let latestMs: number | null = null;

  for (const shard of Object.values(run.shards)) {
    const shardEnd = parseTime(shard.endedAt);
    if (shardEnd != null) {
      latestMs = latestMs == null ? shardEnd : Math.max(latestMs, shardEnd);
    }

    for (const spec of Object.values(shard.specs)) {
      for (const test of spec.tests) {
        const testEnd = parseTime(test.endedAt);
        if (testEnd != null) {
          latestMs = latestMs == null ? testEnd : Math.max(latestMs, testEnd);
        }
      }
    }
  }

  if (latestMs == null) {
    latestMs = parseTime(run.endedAt);
  }

  if (latestMs == null || latestMs <= createdMs) {
    return null;
  }

  return latestMs - createdMs;
}
