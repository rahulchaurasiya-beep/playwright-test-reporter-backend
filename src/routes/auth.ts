import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { createJwtAuthMiddleware } from "../auth-jwt.js";
import type { UserStore } from "../db/store/user-store.js";
import type { LoginPayload, SignupPayload } from "../types/user.js";
import { signUserToken } from "../utils/jwt.js";

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}

function readSignupPayload(body: unknown): SignupPayload {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return {
    username: typeof record.username === "string" ? record.username : undefined,
    email: typeof record.email === "string" ? record.email : undefined,
    password: typeof record.password === "string" ? record.password : "",
  };
}

function readLoginPayload(body: unknown): LoginPayload {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return {
    username: typeof record.username === "string" ? record.username : undefined,
    email: typeof record.email === "string" ? record.email : undefined,
    password: typeof record.password === "string" ? record.password : "",
  };
}

export function createAuthRouter(userStore: UserStore): Router {
  const router = Router();
  const requireAuth = createJwtAuthMiddleware();

  router.post(
    "/signup",
    asyncRoute(async (req, res) => {
      try {
        const payload = readSignupPayload(req.body);
        const user = await userStore.createUser(payload);
        const token = signUserToken({
          userId: user.userId,
          username: user.username,
          email: user.email,
        });

        res.status(201).json({
          token,
          user: userStore.toPublicUser(user),
        });
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : "Bad request" });
      }
    }),
  );

  router.post(
    "/login",
    asyncRoute(async (req, res) => {
      try {
        const payload = readLoginPayload(req.body);
        const user = await userStore.authenticate(payload);
        if (!user) {
          res.status(401).json({ error: "Invalid username, email, or password" });
          return;
        }

        const token = signUserToken({
          userId: user.userId,
          username: user.username,
          email: user.email,
        });

        res.json({
          token,
          user: userStore.toPublicUser(user),
        });
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : "Bad request" });
      }
    }),
  );

  router.get(
    "/me",
    requireAuth,
    asyncRoute(async (req, res) => {
      const user = await userStore.getUserById(req.userAuth!.userId);
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      res.json({ user: userStore.toPublicUser(user) });
    }),
  );

  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
  });

  return router;
}
