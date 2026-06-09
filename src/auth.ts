import type { NextFunction, Request, Response } from "express";

/** Legacy single-key auth — prefer createReporterAuthMiddleware */
export function createAuthMiddleware(apiKey: string | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!apiKey) {
      next();
      return;
    }

    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ") || header.slice(7) !== apiKey) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    next();
  };
}
