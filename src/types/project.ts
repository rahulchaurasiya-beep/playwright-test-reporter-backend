export type ProjectIntegrations = {
  slack?: {
    enabled: boolean;
    webhookUrl: string;
  };
};

export type ProjectSettings = {
  timeoutMinutes: number;
  defaultBranch: string;
  failingFast: boolean;
  runTitleSource: "commit" | "branch" | "workflow";
};

export type ProjectRecord = {
  projectId: string;
  name: string;
  apiKey: string | null;
  apiKeyPrefix: string;
  settings: ProjectSettings;
  integrations: ProjectIntegrations;
  createdAt: string;
  updatedAt: string;
};

export type ProjectWithAnalytics = ProjectRecord & {
  runCount: number;
  lastRunAt: string | null;
  passed: number;
  failed: number;
  skipped: number;
  successRate: number | null;
};

export type CreateProjectResult = ProjectRecord & {
  apiKey: string;
};

export type UpdateProjectPayload = {
  name?: string;
  settings?: Partial<ProjectSettings>;
  integrations?: ProjectIntegrations;
};
