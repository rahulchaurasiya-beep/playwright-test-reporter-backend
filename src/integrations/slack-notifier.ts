import type { RunRecord, TestRecord, TestStatus } from "../types.js";
import type { ProjectRecord } from "../types/project.js";
import { resolveWorkflowRunUrl } from "../utils/workflow-url.js";

const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
const DEFAULT_MAX_THREAD_REPLIES = 20;
const FAILED_STATUSES: TestStatus[] = ["failed", "timedOut", "interrupted"];
const FAILURE_COLOR = "#E01E5A";

type SlackPostMessageResponse = {
  ok: boolean;
  ts?: string;
  error?: string;
};

type SlackBlock = Record<string, unknown>;

type SlackNotifierConfig = {
  botToken: string | null;
  channelId: string | null;
  publicBaseUrl: string | null;
  maxThreadReplies: number;
  mentionUserIds: string[];
};

type TestSummary = {
  passed: number;
  failed: number;
  skipped: number;
  timedOut: number;
  interrupted: number;
  total: number;
};

type ProjectGroupSummary = TestSummary & {
  projectName: string;
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

function stripAnsiCodes(value: string): string {
  return value
    .replace(/\u001B\[[0-9;]*m/g, "")
    .replace(/\[[0-9;]*m/g, "");
}

function collapseWhitespace(value: string): string {
  return stripAnsiCodes(value).replace(/\s+/g, " ").trim();
}

function normalizeMultilineText(value: string): string {
  return stripAnsiCodes(value)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

function formatTestTitle(title: string[]): string {
  if (!title.length) return "Unknown test";
  return title.join(" › ");
}

function buildReporterRunUrl(publicBaseUrl: string | null, run: RunRecord): string | null {
  if (!publicBaseUrl) return null;
  const baseUrl = publicBaseUrl.replace(/\/+$/, "");
  return `${baseUrl}/projects/${encodeURIComponent(run.projectId)}/runs/${encodeURIComponent(run.ciBuildId)}/summary`;
}

function buildReporterTestUrl(
  publicBaseUrl: string | null,
  run: RunRecord,
  test: FailedTest,
): string | null {
  if (!publicBaseUrl) return null;
  const baseUrl = publicBaseUrl.replace(/\/+$/, "");
  const params = new URLSearchParams({
    path: test.specPath,
    retry: String(test.retryIndex),
  });
  return `${baseUrl}/projects/${encodeURIComponent(run.projectId)}/runs/${encodeURIComponent(run.ciBuildId)}/tests/${encodeURIComponent(test.testId)}?${params}`;
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

function emptySummary(): TestSummary {
  return {
    passed: 0,
    failed: 0,
    skipped: 0,
    timedOut: 0,
    interrupted: 0,
    total: 0,
  };
}

function summarizeLatestTests(run: RunRecord): TestSummary {
  const summary = emptySummary();

  for (const test of latestTests(run)) {
    summary.total += 1;
    if (test.status === "passed") summary.passed += 1;
    else if (test.status === "skipped") summary.skipped += 1;
    else if (test.status === "timedOut") summary.timedOut += 1;
    else if (test.status === "interrupted") summary.interrupted += 1;
    else summary.failed += 1;
  }

  summary.failed += summary.timedOut + summary.interrupted;
  return summary;
}

function summarizeByProject(run: RunRecord): ProjectGroupSummary[] {
  const groups = new Map<string, TestSummary>();

  for (const test of latestTests(run)) {
    const projectName = test.projectName?.trim() || "default";
    const summary = groups.get(projectName) ?? emptySummary();
    summary.total += 1;
    if (test.status === "passed") summary.passed += 1;
    else if (test.status === "skipped") summary.skipped += 1;
    else if (test.status === "timedOut") summary.timedOut += 1;
    else if (test.status === "interrupted") summary.interrupted += 1;
    else summary.failed += 1;
    groups.set(projectName, summary);
  }

  return Array.from(groups.entries())
    .map(([projectName, summary]) => ({
      projectName,
      ...summary,
      failed: summary.failed + summary.timedOut + summary.interrupted,
    }))
    .sort((a, b) => a.projectName.localeCompare(b.projectName));
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

function runTitle(run: RunRecord): string {
  return run.ci.prTitle || run.git.commitMessage || `Run ${run.ciBuildId}`;
}

function parseMentionUserIds(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => /^U[A-Z0-9]+$/i.test(id));
}

function formatSlackMentions(userIds: string[]): string {
  return userIds.map((id) => `<@${id}>`).join(" ");
}

function buildMentionThreadPayload(
  mentionUserIds: string[],
): { text: string; blocks: SlackBlock[] } | null {
  if (!mentionUserIds.length) return null;

  const mentions = formatSlackMentions(mentionUserIds);
  const text = `${mentions} please check the failures.`;

  return {
    text,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${mentions}\n_Please check the failures._`,
        },
      },
    ],
  };
}

function progressBar(passed: number, total: number, width = 10): string {
  if (total <= 0) return "░".repeat(width);
  const filled = Math.max(0, Math.min(width, Math.round((passed / total) * width)));
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function buildReporterProjectUrl(publicBaseUrl: string | null, projectId: string): string | null {
  if (!publicBaseUrl) return null;
  const baseUrl = publicBaseUrl.replace(/\/+$/, "");
  return `${baseUrl}/projects/${encodeURIComponent(projectId)}/runs`;
}

function buildBranchUrl(run: RunRecord): string | null {
  const branch = run.git.branch?.trim();
  if (!branch || !run.ci.repository) return null;
  return `https://github.com/${run.ci.repository}/tree/${encodeURIComponent(branch)}`;
}

function buildParentPayload(
  run: RunRecord,
  project: ProjectRecord,
  publicBaseUrl: string | null,
): { text: string; blocks: SlackBlock[]; attachments: Record<string, unknown>[] } {
  const title = runTitle(run);
  const titledWithPr =
    run.ci.prNumber && !title.includes(`#${run.ci.prNumber}`)
      ? `${title} (#${run.ci.prNumber})`
      : title;
  const summary = summarizeLatestTests(run);
  const workflowUrl = resolveWorkflowRunUrl(run.ci, run.ciBuildId);
  const reporterUrl = buildReporterRunUrl(publicBaseUrl, run);
  const projectUrl = buildReporterProjectUrl(publicBaseUrl, run.projectId);
  const branchUrl = buildBranchUrl(run);
  const branch = run.git.branch ?? "unknown";
  const shaLabel = shortSha(run.git.sha);
  const shaUrl =
    run.ci.repository && run.git.sha
      ? `https://github.com/${run.ci.repository}/commit/${run.git.sha}`
      : null;

  const projectLabel = projectUrl
    ? slackLink(projectUrl, project.name)
    : slackEscape(project.name);
  const buildIdLabel = workflowUrl
    ? slackLink(workflowUrl, run.ciBuildId)
    : `\`${slackEscape(run.ciBuildId)}\``;
  const commitLabel = shaUrl ? slackLink(shaUrl, shaLabel) : `\`${slackEscape(shaLabel)}\``;
  const branchLabel = branchUrl
    ? slackLink(branchUrl, branch)
    : `\`${slackEscape(branch)}\``;

  const headerBlock: SlackBlock = {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*${slackEscape(truncate(titledWithPr, 220))}*`,
    },
  };

  if (reporterUrl) {
    headerBlock.accessory = {
      type: "button",
      text: { type: "plain_text", text: "View in RAT", emoji: true },
      url: reporterUrl,
    };
  }

  const blocks: SlackBlock[] = [
    headerBlock,
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `*Project:* ${projectLabel} | *Build ID:* ${buildIdLabel}`,
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `*Commit:* ${commitLabel} | *Branch:* ${branchLabel} | *Author:* ${slackEscape(run.git.authorName ?? "unknown")}`,
        },
      ],
    },
  ];

  const attachmentBlocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*Failed:* ${summary.failed}`,
          `*Passed:* ${summary.passed}`,
          `*Skipped:* ${summary.skipped}`,
          `*Total:* ${summary.total}`,
          `*Duration:* ${formatDuration(run.durationMs)}`,
        ].join("   "),
      },
    },
  ];

  const commitBody = collapseWhitespace(run.git.commitMessage ?? "");
  if (commitBody) {
    attachmentBlocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: slackEscape(truncate(commitBody, 400)),
      },
    });
  }

  const actionButtons: Record<string, unknown>[] = [];
  if (reporterUrl) {
    actionButtons.push({
      type: "button",
      text: { type: "plain_text", text: "View in RAT", emoji: true },
      url: reporterUrl,
    });
  }
  if (workflowUrl) {
    actionButtons.push({
      type: "button",
      text: { type: "plain_text", text: "Open GitHub Actions Run", emoji: true },
      url: workflowUrl,
    });
  }
  if (actionButtons.length) {
    attachmentBlocks.push({
      type: "actions",
      elements: actionButtons,
    });
  }

  return {
    text: `❌ ${titledWithPr}`,
    blocks,
    attachments: [{ color: FAILURE_COLOR, blocks: attachmentBlocks }],
  };
}

function buildSummaryThreadPayload(run: RunRecord): { text: string; blocks: SlackBlock[] } {
  const groups = summarizeByProject(run);
  const branch = run.git.branch ?? "unknown";
  const header = `*Run Failed* | \`${slackEscape(branch)}\``;

  if (!groups.length) {
    return {
      text: `Run Failed | ${branch}`,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: header } }],
    };
  }

  const lines = [
    header,
    "",
    "```",
    padSlackTableRow("Group", "Progress", "Total", "Passed", "Failed", "Skipped"),
    ...groups.map((group) =>
      padSlackTableRow(
        group.projectName,
        progressBar(group.passed, group.total),
        String(group.total),
        String(group.passed),
        String(group.failed),
        String(group.skipped),
      ),
    ),
    "```",
  ];

  return {
    text: `Run Failed | ${branch}`,
    blocks: [{ type: "section", text: { type: "mrkdwn", text: lines.join("\n") } }],
  };
}

function padSlackTableRow(
  group: string,
  progress: string,
  total: string,
  passed: string,
  failed: string,
  skipped: string,
): string {
  return [
    group.padEnd(14),
    progress.padEnd(12),
    total.padStart(5),
    passed.padStart(7),
    failed.padStart(7),
    skipped.padStart(8),
  ].join(" ");
}

function extractErrorMessage(test: FailedTest): string {
  const raw = test.error?.message
    ? normalizeMultilineText(test.error.message)
    : "No error message captured";
  const withoutCallLog = raw.split(/^Call log:\s*/m)[0]?.trim() ?? raw;
  return truncate(withoutCallLog, 1200);
}

function extractErrorSnippet(test: FailedTest): string | null {
  if (!test.error?.snippet) return null;
  const cleaned = normalizeMultilineText(test.error.snippet);
  return cleaned ? truncate(cleaned, 2000) : null;
}

function buildFailedTestPayload(
  run: RunRecord,
  test: FailedTest,
  publicBaseUrl: string | null,
): { text: string; blocks: SlackBlock[]; attachments: Record<string, unknown>[] } {
  const title = formatTestTitle(test.title);
  const detailsUrl = buildReporterTestUrl(publicBaseUrl, run, test);
  const metaParts = [
    `*Group:* ${slackEscape(test.projectName)}`,
    `*Attempt ${test.retryIndex + 1} failed* | ${formatDuration(test.durationMs)}`,
  ];

  const titleBlock: SlackBlock = {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `:x: *${slackEscape(title)}*`,
    },
  };
  if (detailsUrl) {
    titleBlock.accessory = {
      type: "button",
      text: { type: "plain_text", text: "View in RAT", emoji: true },
      url: detailsUrl,
    };
  }

  const blocks: SlackBlock[] = [
    titleBlock,
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Spec:*\n\`${slackEscape(test.specPath)}\`` },
        { type: "mrkdwn", text: metaParts.join(" | ") },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `\`\`\`${slackEscape(extractErrorMessage(test))}\`\`\``,
      },
    },
  ];

  const snippet = extractErrorSnippet(test);
  if (snippet) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `\`\`\`${slackEscape(snippet)}\`\`\``,
      },
    });
  }

  return {
    text: `❌ ${title}`,
    blocks,
    attachments: [{ color: FAILURE_COLOR, blocks: [] }],
  };
}

export class SlackNotifier {
  constructor(private readonly config: SlackNotifierConfig) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): SlackNotifier {
    return new SlackNotifier({
      botToken: trimEnv(env.SLACK_BOT_TOKEN),
      channelId: trimEnv(env.SLACK_ALERT_CHANNEL_ID),
      publicBaseUrl: trimEnv(env.REPORTER_PUBLIC_BASE_URL),
      maxThreadReplies:
        Number.parseInt(env.SLACK_MAX_THREAD_REPLIES ?? "", 10) || DEFAULT_MAX_THREAD_REPLIES,
      mentionUserIds: parseMentionUserIds(env.SLACK_ALERT_MENTION_USER_IDS),
    });
  }

  get isConfigured(): boolean {
    return Boolean(this.config.botToken && this.config.channelId);
  }

  async notifyRunFailed(run: RunRecord, project: ProjectRecord): Promise<void> {
    if (!this.isConfigured) {
      console.warn("[slack-notifier] Missing SLACK_BOT_TOKEN or SLACK_ALERT_CHANNEL_ID; skipping notification", {
        ciBuildId: run.ciBuildId,
        hasBotToken: Boolean(this.config.botToken),
        hasChannelId: Boolean(this.config.channelId),
      });
      return;
    }

    console.log("[slack-notifier] Building failure notification payload", {
      ciBuildId: run.ciBuildId,
      projectId: project.projectId,
      channelId: this.config.channelId,
    });

    const failedTests = collectFailedTests(run);
    const parent = buildParentPayload(run, project, this.config.publicBaseUrl);
    const parentResponse = await this.postMessage(parent, undefined, "parent-alert");
    const threadTs = parentResponse.ts;
    if (!threadTs) {
      console.error("[slack-notifier] Slack parent message missing thread timestamp", {
        ciBuildId: run.ciBuildId,
        response: parentResponse,
      });
      throw new Error("Slack did not return a message timestamp for the parent alert");
    }

    console.log("[slack-notifier] Posted parent alert", {
      ciBuildId: run.ciBuildId,
      threadTs,
      failedTestCount: failedTests.length,
    });

    await this.postMessage(buildSummaryThreadPayload(run), threadTs, "summary-thread");

    const replies = failedTests.slice(0, this.config.maxThreadReplies);
    for (const [index, test] of replies.entries()) {
      await this.postMessage(
        buildFailedTestPayload(run, test, this.config.publicBaseUrl),
        threadTs,
        `failed-test-${index + 1}`,
      );
    }

    const omitted = failedTests.length - replies.length;
    if (omitted > 0) {
      const runUrl = buildReporterRunUrl(this.config.publicBaseUrl, run);
      const omittedText = `_${omitted} more failed test${omitted === 1 ? "" : "s"} not shown in Slack._`;
      const omittedBlocks: SlackBlock[] = [
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: omittedText }],
        },
      ];
      if (runUrl) {
        omittedBlocks.push({
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "View all failures in RAT", emoji: true },
              url: runUrl,
            },
          ],
        });
      }

      await this.postMessage(
        {
          text: `${omitted} more failed test${omitted === 1 ? "" : "s"} not shown.`,
          blocks: omittedBlocks,
        },
        threadTs,
        "omitted-failures",
      );
    }

    const mentionPayload = buildMentionThreadPayload(this.config.mentionUserIds);
    if (mentionPayload) {
      await this.postMessage(mentionPayload, threadTs, "mentions");
    }

    console.log("[slack-notifier] Finished posting failure notification thread", {
      ciBuildId: run.ciBuildId,
      threadTs,
      postedFailedTests: replies.length,
      omittedFailedTests: Math.max(failedTests.length - replies.length, 0),
    });
  }

  private async postMessage(
    payload: {
      text: string;
      blocks?: SlackBlock[];
      attachments?: Record<string, unknown>[];
    },
    threadTs?: string,
    step = "message",
  ): Promise<SlackPostMessageResponse> {
    const response = await fetch(SLACK_POST_MESSAGE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: this.config.channelId,
        text: payload.text,
        blocks: payload.blocks,
        attachments: payload.attachments,
        mrkdwn: true,
        unfurl_links: false,
        unfurl_media: false,
        thread_ts: threadTs,
      }),
    });

    if (!response.ok) {
      const responseText = await response.text();
      console.error("[slack-notifier] Slack HTTP request failed", {
        step,
        threadTs,
        status: response.status,
        responseText,
      });
      throw new Error(`Slack API request failed with HTTP ${response.status}`);
    }

    const body = (await response.json()) as SlackPostMessageResponse;
    if (!body.ok) {
      console.error("[slack-notifier] Slack API returned error", {
        step,
        threadTs,
        error: body.error,
        response: body,
      });
      throw new Error(`Slack API request failed: ${body.error ?? "unknown error"}`);
    }

    console.log("[slack-notifier] Slack message posted", {
      step,
      threadTs: threadTs ?? body.ts,
      messageTs: body.ts,
    });

    return body;
  }
}
