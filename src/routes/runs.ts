import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { existsSync, mkdirSync } from "node:fs";
import multer from "multer";
import { join, resolve } from "node:path";
import type { ArtifactStorage } from "../storage/artifact-storage.js";
import type {
  RunStartPayload,
  ShardFinishPayload,
  TestEndPayload,
} from "../types.js";
import type { IRunStore, RunFilterStore } from "../db/store/index.js";

const MAX_ARTIFACT_BYTES = 200 * 1024 * 1024; // 200 MB (videos)

function safeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function param(value: string | string[]): string {
  return Array.isArray(value) ? value[0]! : value;
}

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}

function authProjectId(req: Request): string {
  return req.projectAuth!.projectId;
}

async function runBelongsToAuthProject(
  store: IRunStore,
  req: Request,
  ciBuildId: string,
): Promise<boolean> {
  const run = await store.getRun(ciBuildId);
  return run?.projectId === authProjectId(req);
}

export function createRunsRouter(
  store: IRunStore,
  artifactStorage: ArtifactStorage,
  uploadsDir: string,
  runFilterStore?: RunFilterStore,
): Router {
  const router = Router();
  const tempDir = join(uploadsDir, ".tmp");

  const upload = multer({
    limits: { fileSize: MAX_ARTIFACT_BYTES },
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        mkdirSync(tempDir, { recursive: true });
        cb(null, tempDir);
      },
      filename: (_req, file, cb) => {
        cb(null, artifactStorage.buildFilename(file.originalname));
      },
    }),
  });

  router.get(
    "/runs",
    asyncRoute(async (req, res) => {
      const projectId = authProjectId(req);
      const runs = (await store.listRuns())
        .filter((run) => run.projectId === projectId)
        .map((run) => ({
        ciBuildId: run.ciBuildId,
        projectId: run.projectId,
        status: run.status,
        branch: run.git.branch,
        authorName: run.git.authorName,
        authorEmail: run.git.authorEmail,
        sha: run.git.sha,
        commitMessage: run.git.commitMessage,
        createdAt: run.createdAt,
        endedAt: run.endedAt,
        durationMs: run.durationMs,
        tags: run.tags,
        shardCount: Object.keys(run.shards).length,
        finishedShardCount: Object.values(run.shards).filter((s) => s.finished).length,
      }));
      res.json({ runs });
    }),
  );

  router.get(
    "/runs/:ciBuildId",
    asyncRoute(async (req, res) => {
      const ciBuildId = param(req.params.ciBuildId!);
      const run = await store.getRun(ciBuildId);
      if (!run || run.projectId !== authProjectId(req)) {
        res.status(404).json({ error: "Run not found" });
        return;
      }
      res.json({ run });
    }),
  );

  router.get(
    "/artifacts/:artifactId/file",
    asyncRoute(async (req, res) => {
      const artifactId = param(req.params.artifactId!);
      const file = store.getArtifactFile ? await store.getArtifactFile(artifactId) : null;
      if (!file || file.projectId !== authProjectId(req)) {
        res.status(404).json({ error: "Artifact not found" });
        return;
      }

      const served = await artifactStorage.serveArtifact(res, file);
      if (served) {
        return;
      }

      // Legacy rows stored as local paths before S3 migration
      if (existsSync(file.filePath)) {
        res.setHeader("Content-Type", file.contentType);
        res.setHeader("Content-Disposition", `inline; filename="${safeFilename(file.name)}"`);
        res.sendFile(resolve(file.filePath));
        return;
      }

      res.status(404).json({ error: "Artifact not found" });
    }),
  );

  router.post(
    "/runs/start",
    asyncRoute(async (req, res) => {
      const payload = req.body as RunStartPayload;
      if (!payload?.ciBuildId || !payload?.projectId) {
        res.status(400).json({
          error: "Invalid run start payload",
          received: Object.keys(req.body ?? {}),
          missing: {
            ciBuildId: !payload?.ciBuildId,
            projectId: !payload?.projectId,
          },
        });
        return;
      }

      if (payload.projectId !== authProjectId(req)) {
        res.status(403).json({ error: "Project ID does not match authenticated project" });
        return;
      }

      if (!payload.startedAt) {
        payload.startedAt = new Date().toISOString();
      }

      const run = await store.startRun(payload);
      if (runFilterStore) {
        await runFilterStore.recordRun(payload.projectId, payload.git, payload.startedAt);
      }
      res.status(201).json({ ok: true, ciBuildId: run.ciBuildId, status: run.status });
    }),
  );

  router.post(
    "/runs/tests",
    asyncRoute(async (req, res) => {
      const payload = req.body as TestEndPayload;
      if (!payload?.ciBuildId || !payload?.testId) {
        res.status(400).json({ error: "Invalid test payload" });
        return;
      }

      if (!(await runBelongsToAuthProject(store, req, payload.ciBuildId))) {
        res.status(404).json({ error: "Run not found" });
        return;
      }

      try {
        const run = await store.reportTest(payload);
        res.status(201).json({ ok: true, ciBuildId: run.ciBuildId, status: run.status });
      } catch (error) {
        res.status(404).json({ error: error instanceof Error ? error.message : "Not found" });
      }
    }),
  );

  router.post("/runs/artifacts", upload.single("file"), (req, res, next) => {
    void (async () => {
      const body = req.body as Record<string, string>;
      const file = req.file;

      if (!body.ciBuildId || !body.testId || !file) {
        res.status(400).json({ error: "Missing artifact fields or file" });
        return;
      }

      if (!(await runBelongsToAuthProject(store, req, body.ciBuildId))) {
        res.status(404).json({ error: "Run not found" });
        return;
      }

      try {
        const { storageRef, sizeBytes } = await artifactStorage.persistUploadedFile({
          ciBuildId: body.ciBuildId,
          testId: body.testId,
          filename: file.filename,
          tempPath: file.path,
          contentType: body.contentType || file.mimetype || "application/octet-stream",
          sizeBytes: file.size,
        });

        const retryIndex = Number.parseInt(body.retryIndex ?? "0", 10);

        const run = await store.addArtifact(
          {
            ciBuildId: body.ciBuildId,
            shardNumber: Number.parseInt(body.shardNumber, 10),
            testId: body.testId,
            retryIndex: Number.isNaN(retryIndex) ? 0 : retryIndex,
            specPath: body.specPath,
            name: body.name,
            contentType: body.contentType,
          },
          storageRef,
          sizeBytes,
        );

        const test = Object.values(run.shards)
          .flatMap((s) => Object.values(s.specs))
          .flatMap((sp) => sp.tests)
          .find(
            (t) => t.testId === body.testId && t.retryIndex === (Number.isNaN(retryIndex) ? 0 : retryIndex),
          );

        const uploaded = test?.artifacts.at(-1);

        res.status(201).json({
          ok: true,
          ciBuildId: run.ciBuildId,
          artifactId: uploaded?.id,
          url: uploaded ? `/api/v1/artifacts/${uploaded.id}/file` : null,
        });
      } catch (error) {
        res.status(404).json({ error: error instanceof Error ? error.message : "Not found" });
      }
    })().catch(next);
  });

  router.post(
    "/runs/shard/finish",
    asyncRoute(async (req, res) => {
      const payload = req.body as ShardFinishPayload;
      if (!payload?.ciBuildId || payload.shardNumber === undefined) {
        res.status(400).json({ error: "Invalid shard finish payload" });
        return;
      }

      if (!(await runBelongsToAuthProject(store, req, payload.ciBuildId))) {
        res.status(404).json({ error: "Run not found" });
        return;
      }

      try {
        const run = await store.finishShard(payload);
        res.status(200).json({
          ok: true,
          ciBuildId: run.ciBuildId,
          status: run.status,
          finishedShards: Object.values(run.shards).filter((s) => s.finished).length,
        });
      } catch (error) {
        res.status(404).json({ error: error instanceof Error ? error.message : "Not found" });
      }
    }),
  );

  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : "Internal error";
    console.error(err);
    res.status(500).json({ error: message });
  });

  return router;
}
