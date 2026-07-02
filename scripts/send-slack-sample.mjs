import { loadEnvFile } from "node:process";
import { SlackNotifier } from "../dist/integrations/slack-notifier.js";

loadEnvFile(".env");

const now = new Date().toISOString();
const run = {
  ciBuildId: "28495647736",
  projectId: "HXaCtM",
  status: "failed",
  expectedShardCount: 29,
  tags: ["staging"],
  git: {
    branch: "feat/temp-branch",
    sha: "b65540fec519f06bbb655c1c98f8003a2d7d7988",
    authorName: "Bolli Hari",
    authorEmail: "bolli.hari@rocketium.com",
    commitMessage: "add-new-project-id",
    remoteOrigin: null,
  },
  ci: {
    ciBuildId: "28495647736",
    workflowRunId: "28495647736",
    workflowRunUrl: "https://github.com/rocketium/automation-tests-2.0/actions/runs/28495647736",
    repository: "rocketium/automation-tests-2.0",
    prTitle: "add-new-project-id",
    prNumber: 214,
  },
  playwrightVersion: "1.59.1",
  createdAt: now,
  endedAt: now,
  durationMs: 1_055_000,
  shards: {
    1: {
      shardNumber: 1,
      machineId: "gha-runner",
      startedAt: now,
      endedAt: now,
      finished: true,
      summary: { passed: 352, failed: 4, skipped: 11, timedOut: 0, interrupted: 0, total: 367 },
      specs: {
        assetPreview: {
          specPath:
            "e2e/AI-STUDIO-OUTSIDE-EDITOR/assetPreview/assetPreviewFolder/assetPreview.spec.ts",
          projectName: "staging-e2e",
          status: "failed",
          durationMs: 36_000,
          startedAt: now,
          tests: [
            {
              ciBuildId: "28495647736",
              shardNumber: 1,
              machineId: "gha-runner",
              specPath:
                "e2e/AI-STUDIO-OUTSIDE-EDITOR/assetPreview/assetPreviewFolder/assetPreview.spec.ts",
              projectName: "staging-e2e",
              title: ["Asset Preview", "Search and filter in asset preview"],
              testId: "sample-test-1",
              order: 1,
              status: "failed",
              durationMs: 36_000,
              startedAt: now,
              endedAt: now,
              retryIndex: 0,
              error: {
                message:
                  "Error: expect(locator).toHaveScreenshot(expected) failed\n\nLocator: locator('[data-cy=\"creative-preview-and-download-content\"]')\nExpected: Asset-Preview-Search-and-filter-in-asset-preview-3.png\nTimeout: 5000ms\n\n  3571 pixels (ratio 0.02 of all image pixels) are different.",
                stack: null,
                snippet: [
                  "  247 |   await expect(",
                  "  248 |     sharedPage.locator('[data-cy=\"creative-preview-and-download-content\"]'),",
                  "> 249 |   ).toHaveScreenshot(",
                  "      |     ^",
                  "  250 |     \"Asset-Preview-Search-and-filter-in-asset-preview-3.png\",",
                  "  251 |   );",
                  "  252 |   await sharedPage.waitForTimeout(1000);",
                ].join("\n"),
              },
              artifacts: [],
            },
          ],
        },
        createProject: {
          specPath:
            "e2e/AI-STUDIO-OUTSIDE-EDITOR/CreateProjectAI-studio/createProjectgoogle.spec.ts",
          projectName: "staging-e2e",
          status: "failed",
          durationMs: 441_000,
          startedAt: now,
          tests: [
            {
              ciBuildId: "28495647736",
              shardNumber: 1,
              machineId: "gha-runner",
              specPath:
                "e2e/AI-STUDIO-OUTSIDE-EDITOR/CreateProjectAI-studio/createProjectgoogle.spec.ts",
              projectName: "staging-e2e",
              title: ["Create Project", "Create a new project"],
              testId: "sample-test-2",
              order: 1,
              status: "failed",
              durationMs: 441_000,
              startedAt: now,
              endedAt: now,
              retryIndex: 0,
              error: {
                message:
                  'Error: expect(locator).toBeVisible() failed\nLocator: locator(\'[data-cy="projects"]\')\nExpected: visible\nTimeout: 10000ms',
                stack: null,
                snippet:
                  'await expect(sharedPage.locator(\'[data-cy="projects"]\')).toBeVisible({ timeout: 10000 });',
              },
              artifacts: [],
            },
          ],
        },
      },
    },
  },
};

const project = {
  projectId: "HXaCtM",
  name: "testing",
  apiKey: null,
  apiKeyPrefix: "rptr_live",
  settings: {
    timeoutMinutes: 60,
    defaultBranch: "main",
    failingFast: false,
    runTitleSource: "commit",
  },
  integrations: { slack: { enabled: true, webhookUrl: "" } },
  createdAt: now,
  updatedAt: now,
};

await SlackNotifier.fromEnv().notifyRunFailed(run, project);
console.log("Sample Currents-style Slack alert sent");
