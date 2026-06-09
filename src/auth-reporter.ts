import type { NextFunction, Request, Response } from "express";
import type { ProjectStore } from "./db/store/index.js";

function readProjectIdHeader(req: Request): string | undefined {
  const raw = req.headers["x-project-id"];
  if (typeof raw === "string") return raw.trim() || undefined;
  if (Array.isArray(raw)) return raw[0]?.trim() || undefined;
  return undefined;
}

export function createReporterAuthMiddleware(projectStore: ProjectStore) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      res.status(401).json({
        error: "Unauthorized — send Authorization: Bearer <project-api-key> and X-Project-Id",
      });
      return;
    }

    const apiKey = header.slice(7);
    const projectId = readProjectIdHeader(req);

    const project = projectId
      ? await projectStore.authenticateReporter(projectId, apiKey)
      : await projectStore.getProjectByApiKey(apiKey);

    if (!project) {
      res.status(401).json({ error: "Unauthorized — invalid project ID or API key" });
      return;
    }

    req.projectAuth = { projectId: project.projectId };
    next();
  };
}

declare global {
  namespace Express {
    interface Request {
      projectAuth?: { projectId: string };
    }
  }
}

export {};
