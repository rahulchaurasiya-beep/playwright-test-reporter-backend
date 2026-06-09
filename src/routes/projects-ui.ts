import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ArtifactStorage } from "../storage/artifact-storage.js";
import type {
  AnalyticsStore,
  IRunStore,
  ProjectStore,
  RunFilterStore,
  RunQueryStore,
} from "../db/store/index.js";
import type { UpdateProjectPayload } from "../types/project.js";
import { parseAnalyticsQuery } from "../types/analytics.js";
import { parseRunSearchQuery } from "../types/run-search.js";
function param(value: string | string[]): string {
  return Array.isArray(value) ? value[0]! : value;
}

function authUserId(req: Request): string {
  return req.userAuth!.userId;
}

function safeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}

function summarizeRun(run: Awaited<ReturnType<IRunStore["getRun"]>>) {
  if (!run) return null;

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let specCount = 0;

  for (const shard of Object.values(run.shards)) {
    for (const spec of Object.values(shard.specs)) {
      specCount += 1;
      for (const test of spec.tests) {
        if (test.status === "passed") passed += 1;
        else if (test.status === "skipped") skipped += 1;
        else failed += 1;
      }
    }
  }

  return {
    ciBuildId: run.ciBuildId,
    projectId: run.projectId,
    status: run.status,
    branch: run.git.branch,
    sha: run.git.sha,
    authorName: run.git.authorName,
    authorEmail: run.git.authorEmail,
    commitMessage: run.git.commitMessage,
    prTitle: run.ci.prTitle,
    createdAt: run.createdAt,
    endedAt: run.endedAt,
    durationMs: run.durationMs,
    tags: run.tags,
    shardCount: Object.keys(run.shards).length,
    specCount,
    passed,
    failed,
    skipped,
  };
}

export function createProjectsUiRouter(
  projectStore: ProjectStore,
  runStore: IRunStore,
  runQueryStore: RunQueryStore,
  runFilterStore: RunFilterStore,
  analyticsStore: AnalyticsStore,
  artifactStorage: ArtifactStorage,
): Router {
  const router = Router();

  router.get(
    "/projects",
    asyncRoute(async (req, res) => {
      const projects = await projectStore.listProjectsWithAnalytics(authUserId(req));
      res.json({ projects });
    }),
  );

  router.post(
    "/projects",
    asyncRoute(async (req, res) => {
      const name = typeof req.body?.name === "string" ? req.body.name : "";
      try {
        const created = await projectStore.createProject(name, authUserId(req));
        res.status(201).json({ project: created });
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : "Bad request" });
      }
    }),
  );

  router.get(
    "/projects/:projectId",
    asyncRoute(async (req, res) => {
      const projectId = param(req.params.projectId!);
      const project = await projectStore.getProjectForOwner(projectId, authUserId(req));
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }

      const analytics = (await projectStore.listProjectsWithAnalytics(authUserId(req))).find(
        (p) => p.projectId === projectId,
      );

      res.json({ project, analytics });
    }),
  );

  router.patch(
    "/projects/:projectId",
    asyncRoute(async (req, res) => {
      const projectId = param(req.params.projectId!);
      const existing = await projectStore.getProjectForOwner(projectId, authUserId(req));
      if (!existing) {
        res.status(404).json({ error: "Project not found" });
        return;
      }

      const body = req.body as UpdateProjectPayload;
      const updated = await projectStore.updateProject(projectId, body);
      if (!updated) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      res.json({ project: updated });
    }),
  );

  router.post(
    "/projects/:projectId/regenerate-key",
    asyncRoute(async (req, res) => {
      const projectId = param(req.params.projectId!);
      const existing = await projectStore.getProjectForOwner(projectId, authUserId(req));
      if (!existing) {
        res.status(404).json({ error: "Project not found" });
        return;
      }

      const result = await projectStore.regenerateApiKey(projectId);
      if (!result) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      res.json({ project: result });
    }),
  );

  router.get(
    "/projects/:projectId/analytics",
    asyncRoute(async (req, res) => {
      const projectId = param(req.params.projectId!);
      const project = await projectStore.getProjectForOwner(projectId, authUserId(req));
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }

      const { dateFrom, dateTo } = parseAnalyticsQuery(req.query as Record<string, unknown>);
      const analytics = await analyticsStore.getRunStatusAnalytics(projectId, dateFrom, dateTo);
      res.json({ analytics });
    }),
  );

  router.get(
    "/projects/:projectId/run-filters",
    asyncRoute(async (req, res) => {
      const projectId = param(req.params.projectId!);
      const project = await projectStore.getProjectForOwner(projectId, authUserId(req));
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }

      const filters = await runFilterStore.getFilterOptions(projectId);
      res.json({ filters });
    }),
  );

  router.get(
    "/projects/:projectId/runs",
    asyncRoute(async (req, res) => {
      const projectId = param(req.params.projectId!);

      const project = await projectStore.getProjectForOwner(projectId, authUserId(req));
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }

      const filters = parseRunSearchQuery({
        ...req.query,
        projectId,
        pageSize: req.query.pageSize ?? req.query.limit ?? "50",
      });

      const result = await runQueryStore.search(filters);
      res.json(result);
    }),
  );

  router.get(
    "/projects/:projectId/artifacts/:artifactId/file",
    asyncRoute(async (req, res) => {
      const projectId = param(req.params.projectId!);
      const artifactId = param(req.params.artifactId!);

      const project = await projectStore.getProjectForOwner(projectId, authUserId(req));
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }

      const file = runStore.getArtifactFile ? await runStore.getArtifactFile(artifactId) : null;
      if (!file || file.projectId !== projectId) {
        res.status(404).json({ error: "Artifact not found" });
        return;
      }

      const served = await artifactStorage.serveArtifact(res, file);
      if (served) {
        return;
      }

      if (existsSync(file.filePath)) {
        res.setHeader("Content-Type", file.contentType);
        res.setHeader("Content-Disposition", `inline; filename="${safeFilename(file.name)}"`);
        res.sendFile(resolve(file.filePath));
        return;
      }

      res.status(404).json({ error: "Artifact not found" });
    }),
  );

  router.get(
    "/projects/:projectId/runs/:ciBuildId",
    asyncRoute(async (req, res) => {
      const projectId = param(req.params.projectId!);
      const ciBuildId = param(req.params.ciBuildId!);
      const project = await projectStore.getProjectForOwner(projectId, authUserId(req));
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }

      const run = await runStore.getRun(ciBuildId);

      if (!run || run.projectId !== projectId) {
        res.status(404).json({ error: "Run not found" });
        return;
      }

      res.json({ run, summary: summarizeRun(run) });
    }),
  );

  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
  });

  return router;
}
