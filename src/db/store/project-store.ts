import { latestProjectTestStatsSql } from "../latest-tests-sql.js";
import type { DbClient } from "../postgres-db-client.js";
import type {
  CreateProjectResult,
  ProjectIntegrations,
  ProjectRecord,
  ProjectSettings,
  ProjectWithAnalytics,
  UpdateProjectPayload,
} from "../../types/project.js";
import { generateApiKey, generateProjectId, hashApiKey, apiKeyPrefix } from "../../utils/keys.js";

type ProjectRow = {
  project_id: string;
  name: string;
  api_key_hash: string;
  api_key_prefix: string;
  api_key: string | null;
  owner_user_id: string | null;
  timeout_minutes: number;
  default_branch: string;
  failing_fast: number;
  run_title_source: string;
  integrations: string;
  created_at: string;
  updated_at: string;
};

function parseSettings(row: ProjectRow): ProjectSettings {
  return {
    timeoutMinutes: row.timeout_minutes,
    defaultBranch: row.default_branch,
    failingFast: row.failing_fast === 1,
    runTitleSource:
      row.run_title_source === "branch" || row.run_title_source === "workflow"
        ? row.run_title_source
        : "commit",
  };
}

function parseIntegrations(raw: string): ProjectIntegrations {
  try {
    return JSON.parse(raw) as ProjectIntegrations;
  } catch {
    return {};
  }
}

function mapProject(row: ProjectRow): ProjectRecord {
  return {
    projectId: row.project_id,
    name: row.name,
    apiKey: row.api_key,
    apiKeyPrefix: row.api_key_prefix,
    settings: parseSettings(row),
    integrations: parseIntegrations(row.integrations),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ProjectStore {
  constructor(private readonly db: DbClient) {}

  async createProject(name: string, ownerUserId: string): Promise<CreateProjectResult> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error("Project name is required");
    }

    const apiKey = generateApiKey();
    const now = new Date().toISOString();

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const projectId = generateProjectId();
      try {
        await this.db.execute(
          `INSERT INTO projects (
            project_id, name, api_key_hash, api_key_prefix, api_key, owner_user_id,
            timeout_minutes, default_branch, failing_fast, run_title_source,
            integrations, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, 60, 'main', 0, 'commit', '{}', $7, $7)`,
          [projectId, trimmed, hashApiKey(apiKey), apiKeyPrefix(apiKey), apiKey, ownerUserId, now],
        );

        const project = await this.getProject(projectId);
        if (!project) {
          throw new Error("Failed to load created project");
        }

        return { ...project, apiKey };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("duplicate") || message.includes("UNIQUE")) {
          continue;
        }
        throw error;
      }
    }

    throw new Error("Could not generate unique project id");
  }

  async listProjectsWithAnalytics(ownerUserId: string): Promise<ProjectWithAnalytics[]> {
    const rows = await this.db.query<ProjectRow>(
      "SELECT * FROM projects WHERE owner_user_id = $1 ORDER BY updated_at DESC",
      [ownerUserId],
    );

    const results: ProjectWithAnalytics[] = [];
    for (const row of rows) {
      results.push(await this.withAnalytics(mapProject(row)));
    }
    return results;
  }

  async getProjectForOwner(projectId: string, ownerUserId: string): Promise<ProjectRecord | null> {
    const row = await this.db.queryOne<ProjectRow>(
      "SELECT * FROM projects WHERE project_id = $1 AND owner_user_id = $2",
      [projectId, ownerUserId],
    );
    return row ? mapProject(row) : null;
  }

  async getProject(projectId: string): Promise<ProjectRecord | null> {
    const row = await this.db.queryOne<ProjectRow>(
      "SELECT * FROM projects WHERE project_id = $1",
      [projectId],
    );
    return row ? mapProject(row) : null;
  }

  async getProjectByApiKey(apiKey: string): Promise<ProjectRecord | null> {
    const row = await this.db.queryOne<ProjectRow>(
      "SELECT * FROM projects WHERE api_key_hash = $1",
      [hashApiKey(apiKey)],
    );
    return row ? mapProject(row) : null;
  }

  async authenticateReporter(
    projectId: string,
    apiKey: string,
  ): Promise<ProjectRecord | null> {
    const row = await this.db.queryOne<ProjectRow>(
      "SELECT * FROM projects WHERE project_id = $1 AND api_key_hash = $2",
      [projectId, hashApiKey(apiKey)],
    );
    return row ? mapProject(row) : null;
  }

  async updateProject(
    projectId: string,
    payload: UpdateProjectPayload,
  ): Promise<ProjectRecord | null> {
    const existing = await this.getProject(projectId);
    if (!existing) return null;

    const name = payload.name?.trim() || existing.name;
    const settings: ProjectSettings = {
      ...existing.settings,
      ...payload.settings,
    };
    const integrations = payload.integrations ?? existing.integrations;
    const updatedAt = new Date().toISOString();

    await this.db.execute(
      `UPDATE projects SET
        name = $1,
        timeout_minutes = $2,
        default_branch = $3,
        failing_fast = $4,
        run_title_source = $5,
        integrations = $6,
        updated_at = $7
      WHERE project_id = $8`,
      [
        name,
        settings.timeoutMinutes,
        settings.defaultBranch,
        settings.failingFast ? 1 : 0,
        settings.runTitleSource,
        JSON.stringify(integrations),
        updatedAt,
        projectId,
      ],
    );

    return this.getProject(projectId);
  }

  async regenerateApiKey(projectId: string): Promise<(CreateProjectResult) | null> {
    const existing = await this.getProject(projectId);
    if (!existing) return null;

    const apiKey = generateApiKey();
    const updatedAt = new Date().toISOString();

    await this.db.execute(
      `UPDATE projects SET api_key_hash = $1, api_key_prefix = $2, api_key = $3, updated_at = $4 WHERE project_id = $5`,
      [hashApiKey(apiKey), apiKeyPrefix(apiKey), apiKey, updatedAt, projectId],
    );

    const project = await this.getProject(projectId);
    if (!project) return null;
    return { ...project, apiKey };
  }

  private async withAnalytics(project: ProjectRecord): Promise<ProjectWithAnalytics> {
    const stats = await this.db.queryOne<{
      run_count: number | string;
      last_run_at: string | null;
      passed: number | string;
      failed: number | string;
      skipped: number | string;
    }>(
      latestProjectTestStatsSql(),
      [project.projectId],
    );

    const passed = Number(stats?.passed ?? 0);
    const failed = Number(stats?.failed ?? 0);
    const skipped = Number(stats?.skipped ?? 0);
    const total = passed + failed + skipped;

    return {
      ...project,
      runCount: Number(stats?.run_count ?? 0),
      lastRunAt: stats?.last_run_at ?? null,
      passed,
      failed,
      skipped,
      successRate: total > 0 ? Math.round((passed / total) * 10000) / 100 : null,
    };
  }
}
