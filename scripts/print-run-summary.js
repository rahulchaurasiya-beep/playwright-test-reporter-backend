#!/usr/bin/env node
/**
 * Print run tree (Run → Shards → Specs → Tests) from the reporter API.
 *
 * Usage:
 *   pnpm summary              # list runs
 *   pnpm summary local-123    # print one run
 */

const ciBuildId = process.argv.slice(2).find((a) => a && !a.startsWith("#"));
const apiUrl = (process.env.REPORTER_API_URL ?? "http://localhost:3000").replace(/\/$/, "");
const apiKey = process.env.REPORTER_API_KEY?.trim();

function apiHeaders() {
  const headers = { Accept: "application/json" };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

async function listRuns() {
  const res = await fetch(`${apiUrl}/api/v1/runs`, { headers: apiHeaders() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${text}`);
  }

  const body = JSON.parse(text);
  const runs = body?.runs ?? [];

  if (runs.length === 0) {
    console.log(`No runs in database yet (${apiUrl}).`);
    console.log("Run tests with reporter + backend first.");
    return;
  }

  console.log(`Available runs (${apiUrl}):`);
  for (const run of runs) {
    console.log(`  ${run.ciBuildId}  status=${run.status}  created=${run.createdAt ?? "—"}`);
  }
  console.log("\nPrint one run:");
  console.log("  pnpm summary <ciBuildId>");
  console.log("Example:");
  console.log(`  pnpm summary ${runs[0].ciBuildId}`);
}

async function loadFromApi(id) {
  const res = await fetch(`${apiUrl}/api/v1/runs/${encodeURIComponent(id)}`, {
    headers: apiHeaders(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${text}`);
  }
  const body = JSON.parse(text);
  if (!body?.run) {
    throw new Error("API response missing run object");
  }
  return body.run;
}

function printRun(run) {
  if (!run?.ciBuildId) {
    throw new Error("Invalid run data (missing ciBuildId)");
  }

  console.log("\nRun");
  console.log(`  ciBuildId:     ${run.ciBuildId}`);
  console.log(`  projectId:     ${run.projectId}`);
  console.log(`  status:        ${run.status}`);
  console.log(`  branch:        ${run.git?.branch ?? "—"}`);
  console.log(`  sha:           ${run.git?.sha ?? "—"}`);
  console.log(`  authorName:    ${run.git?.authorName ?? "—"}`);
  console.log(`  authorEmail:   ${run.git?.authorEmail ?? "—"}`);
  console.log(`  commitMessage: ${run.git?.commitMessage ?? "—"}`);
  console.log(`  prTitle:       ${run.ci?.prTitle ?? "—"}`);
  console.log(`  createdAt:     ${run.createdAt}`);
  console.log(`  endedAt:       ${run.endedAt ?? "—"}`);
  console.log(`  durationMs:    ${run.durationMs ?? "—"}`);

  const shards = Object.values(run.shards || {}).sort(
    (a, b) => a.shardNumber - b.shardNumber,
  );

  for (const shard of shards) {
    console.log(`\n  Shard[${shard.shardNumber}]`);
    console.log(`    startedAt: ${shard.startedAt}`);
    console.log(`    endedAt:   ${shard.endedAt ?? "—"}`);
    console.log(`    finished:  ${shard.finished}`);
    if (shard.summary) {
      console.log(
        `    summary:   passed=${shard.summary.passed} failed=${shard.summary.failed} total=${shard.summary.total}`,
      );
    }

    for (const spec of Object.values(shard.specs || {})) {
      const shortPath = spec.specPath.replace(/.*\/e2e\//, "e2e/");
      console.log(`\n    Spec: ${shortPath}`);
      console.log(`      projectName: ${spec.projectName}`);
      console.log(`      status:      ${spec.status}`);
      console.log(`      durationMs:  ${spec.durationMs}`);
      console.log(`      startedAt:   ${spec.startedAt}`);

      for (const test of spec.tests || []) {
        console.log(`\n      Test: ${test.title.join(" › ")}`);
        console.log(`        status:     ${test.status}`);
        console.log(`        durationMs: ${test.durationMs}`);
        console.log(`        startedAt:  ${test.startedAt}`);
        console.log(`        endedAt:    ${test.endedAt}`);
        if (test.error?.message) {
          console.log(`        error:      ${test.error.message.slice(0, 120)}`);
        }
        for (const art of test.artifacts || []) {
          console.log(`        artifact:   ${art.name} (${art.contentType})`);
        }
      }
    }
  }
  console.log("");
}

async function main() {
  if (!ciBuildId) {
    await listRuns();
    return;
  }

  const run = await loadFromApi(ciBuildId);
  console.log(`(loaded from ${apiUrl})`);
  printRun(run);
}

main().catch((err) => {
  console.error(err.message ?? err);
  console.error("\nTip: ensure backend is running (pnpm db:up && pnpm dev).");
  process.exit(1);
});
