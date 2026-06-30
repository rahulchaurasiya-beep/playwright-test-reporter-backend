import type { ParsedDevRevTicket } from "../types/ticket.js";

const TICKET_ID_RE = /\[(TKT-\d+)\]/i;

/** Undo Slack mrkdwn escaping and strip simple decorations. */
function slackUnescape(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    // <https://url|label> -> label, <https://url> -> url
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<([^>]+)>/g, "$1");
}

function clean(value: string | undefined | null): string | null {
  if (!value) return null;
  const trimmed = slackUnescape(value).replace(/[*_`]/g, "").trim();
  return trimmed.length ? trimmed : null;
}

/** Read a `Label: value` field from the DevRev message body. */
function field(text: string, label: string): string | null {
  const re = new RegExp(`${label}\\s*:\\s*\\*?\\s*([^\\n]+)`, "i");
  const match = text.match(re);
  return match ? clean(match[1]) : null;
}

export function extractTicketId(text: string): string | null {
  const match = text.match(TICKET_ID_RE);
  return match ? match[1]!.toUpperCase() : null;
}

/** True when a Slack message looks like a DevRev ticket parent message. */
export function looksLikeTicket(text: string): boolean {
  return TICKET_ID_RE.test(text);
}

/**
 * Parse the DevRev ticket message that is posted into Slack.
 * Returns null when no ticket id is present.
 */
export function parseDevRevTicket(rawText: string): ParsedDevRevTicket | null {
  const text = rawText ?? "";
  const ticketId = extractTicketId(text);
  if (!ticketId) return null;

  const idLine = text.split(/\r?\n/).find((line) => TICKET_ID_RE.test(line)) ?? "";
  const titleAfterId = idLine.replace(TICKET_ID_RE, "").trim();
  const title = clean(titleAfterId);

  const subtype = field(text, "Subtype");
  const owner = field(text, "Owner");
  const severity = field(text, "Severity");
  const stage = field(text, "Stage");
  const account = field(text, "Account");
  const workspace = field(text, "Workspace");
  const priority = field(text, "Priority");
  const createdBy = field(text, "Created by");

  const body = extractBody(text);

  return {
    ticketId,
    title,
    body,
    createdBy,
    account,
    workspace,
    owner,
    severity,
    stage,
    subtype,
    priority,
  };
}

const FIELD_LABELS = [
  "Subtype",
  "Owner",
  "Severity",
  "Stage",
  "Needs Response",
  "Account",
  "Workspace",
  "Automated Test",
  "Priority",
  "Last Refreshed",
];

/** Best-effort: the description text between the `On:` line and the field block. */
function extractBody(text: string): string | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*On\s*:/i.test(line));
  const bodyLines: string[] = [];

  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    const isField = FIELD_LABELS.some((label) =>
      new RegExp(`^\\s*\\*?${label}\\s*:`, "i").test(line),
    );
    if (isField) break;
    bodyLines.push(line);
  }

  const body = clean(bodyLines.join("\n"));
  return body;
}
