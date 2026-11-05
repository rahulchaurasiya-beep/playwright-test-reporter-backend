import type { ArtifactStorage } from "../storage/artifact-storage.js";
import type { ArtifactRecord, RunRecord, TestRecord, TestStatus } from "../types.js";
import type { ProjectRecord } from "../types/project.js";
import { resolveWorkflowRunUrl } from "../utils/workflow-url.js";

const SLACK_API_BASE_URL = "https://slack.com/api";
const DEFAULT_MAX_THREAD_REPLIES = 20;
const MAX_SCREENSHOTS_PER_TEST = 2;
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const FAILED_COLOR = "#E01E5A";
const FAILED_STATUSES: TestStatus[] = ["failed", "timedOut", "interrupted"];

type SlackApiResponse = {
  ok: boolean;
  ts?: string;
  error?: string;
};

type SlackUploadUrlResponse = SlackApiResponse & {
  upload_url?: string;
  file_id?: string;
};

type SlackBlock = Record<string, unknown>;

type SlackMessage = {
  text: string;
  attachments?: Array<{ color: string; blocks: SlackBlock[] }>;
};

type SlackNotifierConfig = {
  botToken: string | null;
  channelId: string | null;
  publicBaseUrl: string | null;
  maxThreadReplies: number;
};

type TestSummary = {
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  total: number;
};

type FailedTest = TestRecord & {
  shardNumber: number;
};

function trimEnv(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function slackEscape(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function formatDuration(durationMs: number | null | undefined): string {
  if (!durationMs || durationMs < 0) return "0s";
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function formatSeconds(durationMs: number | null | undefined): string {
  if (!durationMs || durationMs < 0) return "0s";
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "unknown";
}

function slackLink(url: string | null, label: string): string | null {
  if (!url) return null;
  return `<${url.replace(/[|>]/g, "")}|${slackEscape(label)}>`;
}

function baseUrl(publicBaseUrl: string | null): string | null {
  return publicBaseUrl ? publicBaseUrl.replace(/\/+$/, "") : null;
}

function buildReporterRunUrl(publicBaseUrl: string | null, run: RunRecord): string | null {
  const root = baseUrl(publicBaseUrl);
  if (!root) return null;
  return `${root}/projects/${encodeURIComponent(run.projectId)}/runs/${encodeURIComponent(run.ciBuildId)}/summary`;
}

function buildReporterTestUrl(publicBaseUrl: string | null, run: RunRecord, testId: string): string | null {
  const root = baseUrl(publicBaseUrl);
  if (!root) return null;
  return `${root}/projects/${encodeURIComponent(run.projectId)}/runs/${encodeURIComponent(run.ciBuildId)}/tests/${encodeURIComponent(testId)}`;
}

function runTitle(run: RunRecord): string {
  const title = run.ci.prTitle || run.git.commitMessage?.split("\n")[0] || `Run ${run.ciBuildId}`;
  const prSuffix = run.ci.prNumber && !title.includes(`#${run.ci.prNumber}`) ? ` (#${run.ci.prNumber})` : "";
  return truncate(`${title}${prSuffix}`, 150);
}

function latestTests(run: RunRecord): TestRecord[] {
  const byTestId = new Map<string, TestRecord>();

  for (const shard of Object.values(run.shards)) {
    for (const spec of Object.values(shard.specs)) {
      for (const test of spec.tests) {
        const existing = byTestId.get(test.testId);
        if (!existing || test.retryIndex > existing.retryIndex) {
          byTestId.set(test.testId, test);
        }
      }
    }
  }

  return Array.from(byTestId.values());
}

function summarize(tests: TestRecord[]): TestSummary {
  const summary: TestSummary = { passed: 0, failed: 0, skipped: 0, flaky: 0, total: 0 };

  for (const test of tests) {
    summary.total += 1;
    if (test.status === "passed") {
      summary.passed += 1;
      if (test.retryIndex > 0) summary.flaky += 1;
    } else if (test.status === "skipped") {
      summary.skipped += 1;
    } else {
      summary.failed += 1;
    }
  }

  return summary;
}

function summarizeByGroup(run: RunRecord): Array<{ group: string; summary: TestSummary }> {
  const groups = new Map<string, TestRecord[]>();
  for (const test of latestTests(run)) {
    const tests = groups.get(test.projectName) ?? [];
    tests.push(test);
    groups.set(test.projectName, tests);
  }

  return Array.from(groups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, tests]) => ({ group, summary: summarize(tests) }));
}

function collectFailedTests(run: RunRecord): FailedTest[] {
  const latestByTestId = new Map<string, FailedTest>();

  for (const shard of Object.values(run.shards)) {
    for (const spec of Object.values(shard.specs)) {
      for (const test of spec.tests) {
        const existing = latestByTestId.get(test.testId);
        const current = { ...test, shardNumber: shard.shardNumber };
        if (!existing || current.retryIndex > existing.retryIndex) {
          latestByTestId.set(test.testId, current);
        }
      }
    }
  }

  return Array.from(latestByTestId.values())
    .filter((test) => FAILED_STATUSES.includes(test.status))
    .sort((a, b) => a.specPath.localeCompare(b.specPath) || a.order - b.order);
}

function displaySpecPath(specPath: string): string {
  const normalized = specPath.replace(/\\/g, "/");
  const e2eIndex = normalized.lastIndexOf("/e2e/");
  return e2eIndex >= 0 ? normalized.slice(e2eIndex + "/e2e/".length) : normalized;
}

function testTitle(test: TestRecord): string {
  // titlePath() is [root, project, file, ...describes, test]; keep describes + test.
  const meaningful = test.title.filter(
    (part) => part && part !== test.projectName && !/\.(spec|test)\.[cm]?[jt]sx?$/.test(part),
  );
  return meaningful.length ? meaningful.join(" › ") : test.testId;
}

function screenshotsFor(test: TestRecord): ArtifactRecord[] {
  return test.artifacts
    .filter((artifact) => artifact.contentType.startsWith("image/"))
    .filter((artifact) => !artifact.sizeBytes || artifact.sizeBytes <= MAX_SCREENSHOT_BYTES)
    .slice(0, MAX_SCREENSHOTS_PER_TEST);
}

function mrkdwnSection(text: string): SlackBlock {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function rawCell(text: string): SlackBlock {
  return { type: "raw_text", text };
}

function richCell(elements: SlackBlock[]): SlackBlock {
  return { type: "rich_text", elements: [{ type: "rich_text_section", elements }] };
}

function emojiHeaderCell(emoji: string, label: string): SlackBlock {
  return richCell([
    { type: "emoji", name: emoji },
    { type: "text", text: ` ${label}`, style: { bold: true } },
  ]);
}

function boldCell(label: string): SlackBlock {
  return richCell([{ type: "text", text: label, style: { bold: true } }]);
}

function buildSummaryTable(run: RunRecord, reporterUrl: string | null): SlackBlock {
  const header = [
    boldCell("Group"),
    boldCell("Progress"),
    boldCell("Total"),
    emojiHeaderCell("large_green_circle", "Passed"),
    emojiHeaderCell("red_circle", "Failed"),
    emojiHeaderCell("white_circle", "Skipped"),
    emojiHeaderCell("large_purple_circle", "Flaky"),
  ];

  const rows = summarizeByGroup(run).map(({ group, summary }) => {
    const failed = summary.failed > 0;
    return [
      reporterUrl ? richCell([{ type: "link", text: group, url: reporterUrl }]) : rawCell(group),
      richCell([
        { type: "emoji", name: failed ? "x" : "white_check_mark" },
        { type: "text", text: failed ? " Failed" : " Passed" },
      ]),
      rawCell(String(summary.total)),
      rawCell(String(summary.passed)),
      rawCell(String(summary.failed)),
      rawCell(String(summary.skipped)),
      rawCell(String(summary.flaky)),
    ];
  });

  return {
    type: "table",
    column_settings: [{ is_wrapped: true }, { align: "left" }, ...Array(5).fill({ align: "right" })],
    rows: [header, ...rows],
  };
}

function linkButton(text: string, url: string, actionId: string, primary = false): SlackBlock {
  return {
    type: "button",
    text: { type: "plain_text", text, emoji: true },
    url,
    action_id: actionId,
    ...(primary ? { style: "primary" } : {}),
  };
}

function buildParentMessage(
  run: RunRecord,
  project: ProjectRecord,
  publicBaseUrl: string | null,
): SlackMessage {
  const title = runTitle(run);
  const workflowUrl = resolveWorkflowRunUrl(run.ci, run.ciBuildId);
  const reporterUrl = buildReporterRunUrl(publicBaseUrl, run);
  const repo = run.ci.repository;
  const sha = run.git.sha;
  const branch = run.git.branch ?? "unknown";

  const shaText = repo && sha
    ? slackLink(`https://github.com/${repo}/commit/${sha}`, shortSha(sha))
    : `\`${slackEscape(shortSha(sha))}\``;
  const branchText = repo && run.git.branch
    ? slackLink(`https://github.com/${repo}/tree/${encodeURIComponent(run.git.branch)}`, branch)
    : `\`${slackEscape(branch)}\``;
  const projectText = slackLink(reporterUrl, project.name) ?? `*${slackEscape(project.name)}*`;

  const blocks: SlackBlock[] = [
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: ["Run Notifications Thread", slackLink(workflowUrl, "GitHub Actions")]
            .filter(Boolean)
            .join(" | "),
        },
      ],
    },
    mrkdwnSection(
      [
        `*Project:* ${projectText} | *Build ID:* ${slackEscape(run.ciBuildId)}`,
        `*Commit:* ${shaText} | *Branch:* ${branchText} | *Author:* ${slackEscape(run.git.authorName ?? "unknown")}`,
        `*Duration:* ${formatDuration(run.durationMs)}`,
      ].join("\n"),
    ),
  ];

  if (run.git.commitMessage) {
    blocks.push(mrkdwnSection(`\`\`\`${slackEscape(truncate(run.git.commitMessage.trim(), 400))}\`\`\``));
  }

  const buttons = [
    reporterUrl ? linkButton("View in Reporter :arrow_right:", reporterUrl, "view_in_reporter", true) : null,
    workflowUrl ? linkButton("View in GitHub Actions", workflowUrl, "view_in_github_actions") : null,
  ].filter((button): button is SlackBlock => Boolean(button));
  if (buttons.length) {
    blocks.push({ type: "actions", elements: buttons });
  }

  blocks.push(buildSummaryTable(run, reporterUrl));

  return {
    text: `:x: ${slackEscape(title)}`,
    attachments: [{ color: FAILED_COLOR, blocks }],
  };
}

function buildFailedTestReply(
  test: FailedTest,
  run: RunRecord,
  publicBaseUrl: string | null,
): SlackMessage {
  const title = testTitle(test);
  const runLink = slackLink(buildReporterRunUrl(publicBaseUrl, run), runTitle(run)) ?? slackEscape(runTitle(run));
  const detailsLink = slackLink(buildReporterTestUrl(publicBaseUrl, run, test.testId), "Details");
  const rawError = test.error?.message ? stripAnsi(test.error.message) : "No error message captured";

  const attemptLine = [
    `Attempt ${test.retryIndex + 1} ${test.status === "timedOut" ? "timed out" : test.status}`,
    formatSeconds(test.durationMs),
    detailsLink,
  ]
    .filter(Boolean)
    .join("  |  ");

  const blocks: SlackBlock[] = [
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `Test Results Update | ${runLink}` }],
    },
    mrkdwnSection(`:x: *${slackEscape(truncate(title, 280))}*`),
    mrkdwnSection(
      [
        `*Spec:* ${slackEscape(displaySpecPath(test.specPath))}`,
        `*Group:* ${slackEscape(test.projectName)}`,
        "",
        attemptLine,
      ].join("\n"),
    ),
    mrkdwnSection(`\`\`\`${slackEscape(truncate(rawError, 1500))}\`\`\``),
  ];

  return {
    text: `:x: ${slackEscape(truncate(title, 200))}`,
    attachments: [{ color: FAILED_COLOR, blocks }],
  };
}

function plainFallback(message: SlackMessage): SlackMessage {
  return { text: message.text };
}

export class SlackNotifier {
  constructor(private readonly config: SlackNotifierConfig) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): SlackNotifier {
    return new SlackNotifier({
      botToken: trimEnv(env.SLACK_BOT_TOKEN),
      channelId: trimEnv(env.SLACK_ALERT_CHANNEL_ID),
      publicBaseUrl: trimEnv(env.REPORTER_PUBLIC_BASE_URL),
      maxThreadReplies: Number.parseInt(env.SLACK_MAX_THREAD_REPLIES ?? "", 10) || DEFAULT_MAX_THREAD_REPLIES,
    });
  }

  get isConfigured(): boolean {
    return Boolean(this.config.botToken && this.config.channelId);
  }

  async notifyRunFailed(
    run: RunRecord,
    project: ProjectRecord,
    artifactStorage?: ArtifactStorage,
  ): Promise<void> {
    if (!this.isConfigured) {
      console.warn("[slack-notifier] Missing SLACK_BOT_TOKEN or SLACK_ALERT_CHANNEL_ID; skipping notification");
      return;
    }

    const failedTests = collectFailedTests(run);
    const parent = await this.postRichMessage(buildParentMessage(run, project, this.config.publicBaseUrl));
    const threadTs = parent.ts;
    if (!threadTs) {
      throw new Error("Slack did not return a message timestamp for the parent alert");
    }

    const replies = failedTests.slice(0, this.config.maxThreadReplies);
    for (const test of replies) {
      await this.postRichMessage(buildFailedTestReply(test, run, this.config.publicBaseUrl), threadTs);
      if (artifactStorage) {
        await this.uploadScreenshots(test, artifactStorage, threadTs);
      }
    }

    const omitted = failedTests.length - replies.length;
    if (omitted > 0) {
      await this.postMessage(
        { text: `_${omitted} more failed test${omitted === 1 ? "" : "s"} not shown._` },
        threadTs,
      );
    }
  }

  private async uploadScreenshots(
    test: FailedTest,
    artifactStorage: ArtifactStorage,
    threadTs: string,
  ): Promise<void> {
    for (const screenshot of screenshotsFor(test)) {
      try {
        const bytes = await artifactStorage.readArtifact(screenshot);
        if (!bytes) continue;
        await this.uploadFileToThread(bytes, screenshot, testTitle(test), threadTs);
      } catch (error) {
        // Screenshots are best-effort; a missing files:write scope must not drop the alert.
        console.warn(
          `[slack-notifier] Failed to upload screenshot ${screenshot.id}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  private async uploadFileToThread(
    bytes: Buffer,
    artifact: ArtifactRecord,
    title: string,
    threadTs: string,
  ): Promise<void> {
    const extension = artifact.contentType.split("/")[1]?.split("+")[0] ?? "png";
    const filename = artifact.name.includes(".") ? artifact.name : `${artifact.name}.${extension}`;

    const urlResponse = await this.callForm<SlackUploadUrlResponse>("files.getUploadURLExternal", {
      filename,
      length: String(bytes.length),
    });
    if (!urlResponse.upload_url || !urlResponse.file_id) {
      throw new Error("Slack did not return an upload URL");
    }

    const upload = await fetch(urlResponse.upload_url, {
      method: "POST",
      body: new Uint8Array(bytes),
    });
    if (!upload.ok) {
      throw new Error(`Slack file upload failed with HTTP ${upload.status}`);
    }

    await this.callJson("files.completeUploadExternal", {
      files: [{ id: urlResponse.file_id, title: truncate(`Screenshot: ${title}`, 250) }],
      channel_id: this.config.channelId,
      thread_ts: threadTs,
    });
  }

  private async postRichMessage(message: SlackMessage, threadTs?: string): Promise<SlackApiResponse> {
    try {
      return await this.postMessage(message, threadTs);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (!/invalid_(blocks|attachments)/.test(reason)) throw error;
      console.warn(`[slack-notifier] Rich layout rejected (${reason}); sending plain text instead`);
      return this.postMessage(plainFallback(message), threadTs);
    }
  }

  private postMessage(message: SlackMessage, threadTs?: string): Promise<SlackApiResponse> {
    return this.callJson("chat.postMessage", {
      channel: this.config.channelId,
      text: message.text,
      attachments: message.attachments,
      mrkdwn: true,
      unfurl_links: false,
      thread_ts: threadTs,
    });
  }

  private async callJson<T extends SlackApiResponse>(method: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${SLACK_API_BASE_URL}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
    return this.parseResponse<T>(method, response);
  }

  private async callForm<T extends SlackApiResponse>(method: string, params: Record<string, string>): Promise<T> {
    const response = await fetch(`${SLACK_API_BASE_URL}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.botToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params),
    });
    return this.parseResponse<T>(method, response);
  }

  private async parseResponse<T extends SlackApiResponse>(method: string, response: Response): Promise<T> {
    if (!response.ok) {
      throw new Error(`Slack API ${method} failed with HTTP ${response.status}`);
    }

    const body = await response.json() as T;
    if (!body.ok) {
      throw new Error(`Slack API ${method} failed: ${body.error ?? "unknown error"}`);
    }

    return body;
  }
}
