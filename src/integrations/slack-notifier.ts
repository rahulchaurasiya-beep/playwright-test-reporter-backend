import type { RunRecord, TestRecord, TestStatus } from "../types.js";
import type { ProjectRecord } from "../types/project.js";
import { resolveWorkflowRunUrl } from "../utils/workflow-url.js";

const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
const DEFAULT_MAX_THREAD_REPLIES = 20;
const FAILED_STATUSES: TestStatus[] = ["failed", "timedOut", "interrupted"];

type SlackPostMessageResponse = {
  ok: boolean;
  ts?: string;
  error?: string;
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

function formatDuration(durationMs: number | null | undefined): string {
  if (!durationMs || durationMs < 0) return "0s";
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "unknown";
}

function slackLink(url: string | null, label: string): string | null {
  if (!url) return null;
  return `<${url.replace(/[|>]/g, "")}|${slackEscape(label)}>`;
}

function buildReporterRunUrl(publicBaseUrl: string | null, run: RunRecord): string | null {
  if (!publicBaseUrl) return null;
  const baseUrl = publicBaseUrl.replace(/\/+$/, "");
  return `${baseUrl}/projects/${encodeURIComponent(run.projectId)}/runs/${encodeURIComponent(run.ciBuildId)}/summary`;
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

function summarizeLatestTests(run: RunRecord): TestSummary {
  const summary: TestSummary = {
    passed: 0,
    failed: 0,
    skipped: 0,
    total: 0,
  };

  for (const test of latestTests(run)) {
    summary.total += 1;
    if (test.status === "passed") summary.passed += 1;
    else if (test.status === "skipped") summary.skipped += 1;
    else summary.failed += 1;
  }

  return summary;
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

function buildParentMessage(
  run: RunRecord,
  project: ProjectRecord,
  publicBaseUrl: string | null,
): string {
  const summary = summarizeLatestTests(run);
  const workflowUrl = resolveWorkflowRunUrl(run.ci, run.ciBuildId);
  const reporterUrl = buildReporterRunUrl(publicBaseUrl, run);
  const links = [
    slackLink(workflowUrl, "View in GitHub Actions"),
    slackLink(reporterUrl, "View in Reporter"),
  ].filter((link): link is string => Boolean(link));
  const title = run.ci.prTitle || run.git.commitMessage || `Run ${run.ciBuildId}`;
  const shaLabel = shortSha(run.git.sha);
  const shaLink = run.ci.repository && run.git.sha
    ? slackLink(`https://github.com/${run.ci.repository}/commit/${run.git.sha}`, shaLabel)
    : null;

  return [
    `:x: *${slackEscape(truncate(title, 180))}*`,
    `Project: *${slackEscape(project.name)}* | Build ID: \`${slackEscape(run.ciBuildId)}\``,
    `Commit: ${shaLink ?? `\`${slackEscape(shaLabel)}\``} | Branch: \`${slackEscape(run.git.branch ?? "unknown")}\` | Author: ${slackEscape(run.git.authorName ?? "unknown")}`,
    `Failed: *${summary.failed}* | Passed: ${summary.passed} | Skipped: ${summary.skipped} | Total: ${summary.total} | Duration: ${formatDuration(run.durationMs)}`,
    links.length ? links.join(" | ") : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function formatFailedTestReply(test: FailedTest): string {
  const title = test.title.length ? test.title.join(" › ") : test.testId;
  const errorMessage = test.error?.message ? truncate(test.error.message, 1200) : "No error message captured";
  const snippet = test.error?.snippet ? `\n\`\`\`${truncate(test.error.snippet, 1500)}\`\`\`` : "";

  return [
    `*${slackEscape(title)}*`,
    `Spec: \`${slackEscape(test.specPath)}\``,
    `Project: ${slackEscape(test.projectName)} | Status: \`${slackEscape(test.status)}\` | Attempt: ${test.retryIndex + 1} | Duration: ${formatDuration(test.durationMs)}`,
    `Error: ${slackEscape(errorMessage)}${snippet}`,
  ].join("\n");
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

  async notifyRunFailed(run: RunRecord, project: ProjectRecord): Promise<void> {
    if (!this.isConfigured) {
      console.warn("[slack-notifier] Missing SLACK_BOT_TOKEN or SLACK_ALERT_CHANNEL_ID; skipping notification");
      return;
    }

    const failedTests = collectFailedTests(run);
    const parent = await this.postMessage(buildParentMessage(run, project, this.config.publicBaseUrl));
    const threadTs = parent.ts;
    if (!threadTs) {
      throw new Error("Slack did not return a message timestamp for the parent alert");
    }

    const replies = failedTests.slice(0, this.config.maxThreadReplies);
    for (const test of replies) {
      await this.postMessage(formatFailedTestReply(test), threadTs);
    }

    const omitted = failedTests.length - replies.length;
    if (omitted > 0) {
      await this.postMessage(`_${omitted} more failed test${omitted === 1 ? "" : "s"} not shown._`, threadTs);
    }
  }

  private async postMessage(text: string, threadTs?: string): Promise<SlackPostMessageResponse> {
    const response = await fetch(SLACK_POST_MESSAGE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: this.config.channelId,
        text,
        mrkdwn: true,
        thread_ts: threadTs,
      }),
    });

    if (!response.ok) {
      throw new Error(`Slack API request failed with HTTP ${response.status}`);
    }

    const body = await response.json() as SlackPostMessageResponse;
    if (!body.ok) {
      throw new Error(`Slack API request failed: ${body.error ?? "unknown error"}`);
    }

    return body;
  }
}
