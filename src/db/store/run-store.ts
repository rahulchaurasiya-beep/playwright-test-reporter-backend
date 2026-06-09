import { statSync } from "node:fs";
import { latestTestsForSpecSql } from "../latest-tests-sql.js";
import type { DbClient } from "../postgres-db-client.js";
import type { IRunStore } from "./run-store.interface.js";
import { specKey, worstStatus } from "./utils.js";
import type {
  ArtifactRecord,
  CiInfo,
  GitInfo,
  RunRecord,
  RunStartPayload,
  ShardFinishPayload,
  ShardRecord,
  SpecRecord,
  TestEndPayload,
  TestRecord,
  TestStatus,
} from "../../types.js";

type RunRow = {
  ci_build_id: string;
  project_id: string;
  status: string;
  expected_shard_count: number | null;
  tags: string;
  git: string;
  ci: string;
  playwright_version: string;
  created_at: string;
  ended_at: string | null;
  duration_ms: number | null;
};

export class SqlRunStore implements IRunStore {
  constructor(private readonly db: DbClient) {}

  async listRuns(): Promise<RunRecord[]> {
    const rows = await this.db.query<{ ci_build_id: string }>(
      "SELECT ci_build_id FROM runs ORDER BY created_at DESC",
    );

    const runs: RunRecord[] = [];
    for (const row of rows) {
      const run = await this.getRun(row.ci_build_id);
      if (run) runs.push(run);
    }
    return runs;
  }

  async getRun(ciBuildId: string): Promise<RunRecord | null> {
    const row = await this.db.queryOne<RunRow>(
      "SELECT * FROM runs WHERE ci_build_id = $1",
      [ciBuildId],
    );

    if (!row) return null;

    const shardRows = await this.db.query<{
      shard_number: number;
      machine_id: string;
      started_at: string;
      ended_at: string | null;
      finished: number;
      summary: string | null;
    }>("SELECT * FROM shards WHERE ci_build_id = $1 ORDER BY shard_number", [ciBuildId]);

    const shards: Record<string, ShardRecord> = {};

    for (const shardRow of shardRows) {
      const key = String(shardRow.shard_number);
      const specRows = await this.db.query<{
        spec_key: string;
        spec_path: string;
        project_name: string;
        status: TestStatus;
        duration_ms: number;
        started_at: string;
      }>(
        "SELECT * FROM specs WHERE ci_build_id = $1 AND shard_number = $2 ORDER BY spec_path",
        [ciBuildId, shardRow.shard_number],
      );

      const specs: Record<string, SpecRecord> = {};

      for (const specRow of specRows) {
        const testRows = await this.db.query<{
          test_id: string;
          project_name: string;
          spec_path: string;
          title: string;
          test_order: number;
          status: TestStatus;
          duration_ms: number;
          started_at: string;
          ended_at: string;
          retry_index: number;
          machine_id: string;
          error: string | null;
        }>(
          `SELECT * FROM tests
           WHERE ci_build_id = $1 AND shard_number = $2 AND spec_key = $3
           ORDER BY test_order, retry_index`,
          [ciBuildId, shardRow.shard_number, specRow.spec_key],
        );

        const tests: TestRecord[] = [];
        for (const t of testRows) {
          const artifacts = await this.loadArtifactsForTest(
            ciBuildId,
            shardRow.shard_number,
            specRow.spec_key,
            t.test_id,
            t.retry_index,
          );

          tests.push({
            ciBuildId,
            shardNumber: shardRow.shard_number,
            machineId: t.machine_id,
            specPath: t.spec_path,
            projectName: t.project_name,
            title: JSON.parse(t.title) as string[],
            testId: t.test_id,
            order: t.test_order,
            status: t.status,
            durationMs: t.duration_ms,
            startedAt: t.started_at,
            endedAt: t.ended_at,
            retryIndex: t.retry_index,
            error: t.error ? JSON.parse(t.error) : null,
            artifacts,
          });
        }

        specs[specRow.spec_key] = {
          specPath: specRow.spec_path,
          projectName: specRow.project_name,
          status: specRow.status,
          durationMs: specRow.duration_ms,
          startedAt: specRow.started_at,
          tests,
        };
      }

      shards[key] = {
        shardNumber: shardRow.shard_number,
        machineId: shardRow.machine_id,
        startedAt: shardRow.started_at,
        endedAt: shardRow.ended_at,
        finished: shardRow.finished === 1,
        summary: shardRow.summary ? JSON.parse(shardRow.summary) : null,
        specs,
      };
    }

    return {
      ciBuildId: row.ci_build_id,
      projectId: row.project_id,
      status: row.status as RunRecord["status"],
      expectedShardCount: row.expected_shard_count,
      tags: JSON.parse(row.tags) as string[],
      git: JSON.parse(row.git) as GitInfo,
      ci: JSON.parse(row.ci) as CiInfo,
      playwrightVersion: row.playwright_version,
      createdAt: row.created_at,
      endedAt: row.ended_at,
      durationMs: row.duration_ms,
      shards,
    };
  }

  async startRun(payload: RunStartPayload): Promise<RunRecord> {
    await this.db.execute(
      `INSERT INTO runs (
        ci_build_id, project_id, status, expected_shard_count, tags, git, ci,
        playwright_version, created_at
      ) VALUES ($1, $2, 'running', $3, $4, $5, $6, $7, $8)
      ON CONFLICT(ci_build_id) DO NOTHING`,
      [
        payload.ciBuildId,
        payload.projectId,
        payload.expectedShardCount ?? null,
        JSON.stringify(payload.tags ?? []),
        JSON.stringify(payload.git),
        JSON.stringify(payload.ci),
        payload.playwrightVersion,
        payload.startedAt,
      ],
    );

    if (payload.expectedShardCount) {
      await this.db.execute(
        "UPDATE runs SET expected_shard_count = COALESCE(expected_shard_count, $1) WHERE ci_build_id = $2",
        [payload.expectedShardCount, payload.ciBuildId],
      );
    }

    await this.db.execute(
      `INSERT INTO shards (ci_build_id, shard_number, machine_id, started_at, finished)
       VALUES ($1, $2, $3, $4, 0)
       ON CONFLICT(ci_build_id, shard_number) DO NOTHING`,
      [payload.ciBuildId, payload.shardNumber, payload.machineId, payload.startedAt],
    );

    return (await this.getRun(payload.ciBuildId))!;
  }

  async reportTest(payload: TestEndPayload): Promise<RunRecord> {
    const run = await this.getRun(payload.ciBuildId);
    if (!run) {
      throw new Error(`Run not found: ${payload.ciBuildId}`);
    }

    const key = specKey(payload.specPath);

    await this.db.execute(
      `INSERT INTO shards (ci_build_id, shard_number, machine_id, started_at, finished)
       VALUES ($1, $2, $3, $4, 0)
       ON CONFLICT(ci_build_id, shard_number) DO NOTHING`,
      [payload.ciBuildId, payload.shardNumber, payload.machineId, payload.startedAt],
    );

    const existingSpec = await this.db.queryOne<{ status: TestStatus }>(
      "SELECT status FROM specs WHERE ci_build_id = $1 AND shard_number = $2 AND spec_key = $3",
      [payload.ciBuildId, payload.shardNumber, key],
    );

    if (!existingSpec) {
      await this.db.execute(
        `INSERT INTO specs (ci_build_id, shard_number, spec_key, spec_path, project_name, status, duration_ms, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, 0, $7)`,
        [
          payload.ciBuildId,
          payload.shardNumber,
          key,
          payload.specPath,
          payload.projectName,
          payload.status,
          payload.startedAt,
        ],
      );
    }

    await this.db.execute(
      `INSERT INTO tests (
        ci_build_id, shard_number, spec_key, test_id, project_name, spec_path, title,
        test_order, status, duration_ms, started_at, ended_at, retry_index, machine_id, error
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT(ci_build_id, shard_number, spec_key, test_id, retry_index) DO UPDATE SET
        status = $9,
        duration_ms = $10,
        ended_at = $12,
        error = $15`,
      [
        payload.ciBuildId,
        payload.shardNumber,
        key,
        payload.testId,
        payload.projectName,
        payload.specPath,
        JSON.stringify(payload.title),
        payload.order,
        payload.status,
        payload.durationMs,
        payload.startedAt,
        payload.endedAt,
        payload.retryIndex,
        payload.machineId,
        payload.error ? JSON.stringify(payload.error) : null,
      ],
    );

    const tests = await this.db.query<{
      status: TestStatus;
      duration_ms: number;
      started_at: string;
    }>(latestTestsForSpecSql(), [
      payload.ciBuildId,
      payload.shardNumber,
      key,
    ]);

    const specStatus = tests.reduce(
      (s, t) => worstStatus(s, t.status),
      "passed" as TestStatus,
    );
    const specDuration = tests.reduce((sum, t) => sum + t.duration_ms, 0);
    const specStarted = tests[0]?.started_at ?? payload.startedAt;

    await this.db.execute(
      "UPDATE specs SET status = $1, duration_ms = $2, started_at = $3 WHERE ci_build_id = $4 AND shard_number = $5 AND spec_key = $6",
      [specStatus, specDuration, specStarted, payload.ciBuildId, payload.shardNumber, key],
    );

    return (await this.getRun(payload.ciBuildId))!;
  }

  async addArtifact(
    meta: {
      ciBuildId: string;
      shardNumber: number;
      testId: string;
      retryIndex: number;
      specPath: string;
      name: string;
      contentType: string;
    },
    filePath: string,
    sizeBytes?: number,
  ): Promise<RunRecord> {
    const run = await this.getRun(meta.ciBuildId);
    if (!run) {
      throw new Error(`Run not found: ${meta.ciBuildId}`);
    }

    const key = specKey(meta.specPath);
    const test = await this.db.queryOne(
      "SELECT 1 AS ok FROM tests WHERE ci_build_id = $1 AND shard_number = $2 AND spec_key = $3 AND test_id = $4 AND retry_index = $5",
      [meta.ciBuildId, meta.shardNumber, key, meta.testId, meta.retryIndex],
    );

    if (!test) {
      throw new Error(
        `Test not found: ${meta.testId} (report test before uploading artifacts)`,
      );
    }

    const id = `${meta.testId}-r${meta.retryIndex}-${meta.name}-${Date.now()}`;
    const createdAt = new Date().toISOString();
    let size = sizeBytes;
    if (size === undefined) {
      try {
        size = statSync(filePath).size;
      } catch {
        size = undefined;
      }
    }

    await this.db.execute(
      `INSERT INTO artifacts (
        id, ci_build_id, shard_number, spec_key, test_id, retry_index, spec_path, name, content_type, file_path, size_bytes, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        meta.ciBuildId,
        meta.shardNumber,
        key,
        meta.testId,
        meta.retryIndex,
        meta.specPath,
        meta.name,
        meta.contentType,
        filePath,
        size ?? null,
        createdAt,
      ],
    );

    return (await this.getRun(meta.ciBuildId))!;
  }

  async finishShard(payload: ShardFinishPayload): Promise<RunRecord> {
    const run = await this.getRun(payload.ciBuildId);
    if (!run) {
      throw new Error(`Run not found: ${payload.ciBuildId}`);
    }

    const updated = await this.db.execute(
      `UPDATE shards SET finished = 1, ended_at = $1, summary = $2
       WHERE ci_build_id = $3 AND shard_number = $4`,
      [payload.endedAt, JSON.stringify(payload.summary), payload.ciBuildId, payload.shardNumber],
    );

    if (updated.rowCount === 0) {
      throw new Error(`Shard not found: ${payload.shardNumber}`);
    }

    if (
      payload.summary.failed > 0 ||
      payload.summary.timedOut > 0 ||
      payload.summary.interrupted > 0
    ) {
      await this.db.execute("UPDATE runs SET status = 'failed' WHERE ci_build_id = $1", [
        payload.ciBuildId,
      ]);
    }

    const finishedRow = await this.db.queryOne<{ c: number | string }>(
      "SELECT COUNT(*) AS c FROM shards WHERE ci_build_id = $1 AND finished = 1",
      [payload.ciBuildId],
    );
    const finishedCount = Number(finishedRow?.c ?? 0);

    const expectedRow = await this.db.queryOne<{ expected_shard_count: number | null }>(
      "SELECT expected_shard_count FROM runs WHERE ci_build_id = $1",
      [payload.ciBuildId],
    );
    const expected = expectedRow?.expected_shard_count ?? finishedCount;

    if (finishedCount >= expected) {
      const start = new Date(run.createdAt).getTime();
      const end = new Date(payload.endedAt).getTime();
      const statusRow = await this.db.queryOne<{ status: string }>(
        "SELECT status FROM runs WHERE ci_build_id = $1",
        [payload.ciBuildId],
      );

      await this.db.execute(
        "UPDATE runs SET ended_at = $1, duration_ms = $2, status = $3 WHERE ci_build_id = $4",
        [
          payload.endedAt,
          end - start,
          statusRow?.status === "failed" ? "failed" : "passed",
          payload.ciBuildId,
        ],
      );
    }

    return (await this.getRun(payload.ciBuildId))!;
  }

  private async loadArtifactsForTest(
    ciBuildId: string,
    shardNumber: number,
    specKey: string,
    testId: string,
    retryIndex: number,
  ): Promise<ArtifactRecord[]> {
    type ArtifactRow = {
      id: string;
      test_id: string;
      spec_path: string;
      shard_number: number;
      name: string;
      content_type: string;
      file_path: string;
      size_bytes: number | null;
      created_at: string;
    };

    const mapRows = (rows: ArtifactRow[]): ArtifactRecord[] =>
      rows.map((a) => ({
        id: a.id,
        testId: a.test_id,
        specPath: a.spec_path,
        shardNumber: a.shard_number,
        name: a.name,
        contentType: a.content_type,
        filePath: a.file_path,
        sizeBytes: a.size_bytes,
        createdAt: a.created_at,
      }));

    const query = async (retry: number): Promise<ArtifactRow[]> =>
      this.db.query<ArtifactRow>(
        `SELECT * FROM artifacts
         WHERE ci_build_id = $1 AND shard_number = $2 AND spec_key = $3 AND test_id = $4 AND retry_index = $5
         ORDER BY created_at`,
        [ciBuildId, shardNumber, specKey, testId, retry],
      );

    let rows = await query(retryIndex);

    // Pre-retry migrations stored every artifact at retry_index = 0.
    if (rows.length === 0 && retryIndex !== 0) {
      rows = await query(0);
    }

    return mapRows(rows);
  }

  async getArtifactFile(
    artifactId: string,
  ): Promise<{ filePath: string; contentType: string; name: string; projectId: string } | null> {
    const row = await this.db.queryOne<{
      file_path: string;
      content_type: string;
      name: string;
      project_id: string;
    }>(
      `SELECT a.file_path, a.content_type, a.name, r.project_id
       FROM artifacts a
       JOIN runs r ON r.ci_build_id = a.ci_build_id
       WHERE a.id = $1`,
      [artifactId],
    );

    if (!row) return null;

    return {
      filePath: row.file_path,
      contentType: row.content_type,
      name: row.name,
      projectId: row.project_id,
    };
  }
}
