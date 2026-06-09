import type { NextFunction, Request, Response } from "express";
import { verifyUserToken } from "./utils/jwt.js";

export function createJwtAuthMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized — send Authorization: Bearer <token>" });
      return;
    }

    const token = header.slice(7);
    try {
      req.userAuth = verifyUserToken(token);
      next();
    } catch {
      res.status(401).json({ error: "Unauthorized — invalid or expired token" });
    }
  };
}

declare global {
  namespace Express {
    interface Request {
      userAuth?: {
        userId: string;
        username: string | null;
        email: string | null;
      };
    }
  }
}

export {};
