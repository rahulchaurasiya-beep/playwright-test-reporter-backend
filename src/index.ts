import cors from "cors";
import express from "express";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { createReporterAuthMiddleware } from "./auth-reporter.js";
import { createJwtAuthMiddleware } from "./auth-jwt.js";
import {
  AnalyticsStore,
  ProjectStore,
  RunFilterStore,
  RunQueryStore,
  UserStore,
  createRunStore,
} from "./db/store/index.js";
import { createAuthRouter } from "./routes/auth.js";
import { createProjectsUiRouter } from "./routes/projects-ui.js";
import { createRunsRouter } from "./routes/runs.js";
import { createArtifactStorageFromEnv } from "./storage/artifact-storage.js";

const rootDir = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const envPath = join(rootDir, ".env");
if (existsSync(envPath)) {
  loadEnvFile(envPath);
}
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const dataDir = process.env.DATA_DIR ?? join(rootDir, "data");
const uploadsDir = process.env.UPLOADS_DIR ?? join(rootDir, "uploads");
mkdirSync(dataDir, { recursive: true });
mkdirSync(uploadsDir, { recursive: true });

const { store, db } = await createRunStore();
const projectStore = new ProjectStore(db);
const userStore = new UserStore(db);
const runQueryStore = new RunQueryStore(db);
const runFilterStore = new RunFilterStore(db);
const analyticsStore = new AnalyticsStore(db);
const artifactStorage = createArtifactStorageFromEnv(uploadsDir);
const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use("/uploads", express.static(uploadsDir));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "playwright-reporter-backend",
    storage: "postgres",
    artifactStorage: artifactStorage.mode,
  });
});

app.use("/api/auth", createAuthRouter(userStore));

app.use(
  "/api/ui",
  createJwtAuthMiddleware(),
  createProjectsUiRouter(
    projectStore,
    store,
    runQueryStore,
    runFilterStore,
    analyticsStore,
    artifactStorage,
  ),
);

app.use(
  "/api/v1",
  createReporterAuthMiddleware(projectStore),
  createRunsRouter(store, artifactStorage, uploadsDir, runFilterStore),
);

const server = app.listen(port, () => {
  console.log(`Reporter backend listening on http://localhost:${port}`);
  console.log("  Metadata storage: postgres");
  console.log(`  Artifact storage: ${artifactStorage.mode}`);
  console.log(`  UI API:  http://localhost:${port}/api/ui/projects`);
  console.log(`  Reporter: http://localhost:${port}/api/v1/runs/*`);
  if (artifactStorage.mode === "local") {
    console.log(`  Uploads: ${uploadsDir}`);
  }
});

async function shutdown(): Promise<void> {
  server.close();
  await store.close?.();
  await db?.close();
}

process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));
