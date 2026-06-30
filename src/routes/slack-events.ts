import { Router, raw } from "express";
import type { Request, Response } from "express";
import type { TicketStore } from "../db/store/ticket-store.js";
import { looksLikeTicket, parseDevRevTicket } from "../integrations/devrev-parser.js";
import { verifySlackSignature } from "../integrations/slack-verify.js";

export type SlackEventsConfig = {
  signingSecret: string | null;
  /** Restrict ingestion to this channel id (optional). */
  channelId: string | null;
  /** Only treat messages from this user/bot id as DevRev tickets (optional). */
  ticketBotUserId: string | null;
  /** Ignore messages from our own bot user id (optional). */
  selfBotUserId: string | null;
};

export function slackEventsConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SlackEventsConfig {
  const trim = (value: string | undefined): string | null => {
    const v = value?.trim();
    return v ? v : null;
  };
  return {
    signingSecret: trim(env.SLACK_SIGNING_SECRET),
    channelId: trim(env.SLACK_PRODUCT_SUPPORT_CHANNEL_ID),
    ticketBotUserId: trim(env.SLACK_TICKET_BOT_USER_ID),
    selfBotUserId: trim(env.SLACK_SELF_BOT_USER_ID),
  };
}

type SlackMessage = {
  channel?: string;
  ts?: string;
  thread_ts?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  username?: string;
  attachments?: Array<{ text?: string; fallback?: string; title?: string }>;
};

type SlackEventEnvelope = {
  type?: string;
  challenge?: string;
  event?: SlackMessage & {
    type?: string;
    message?: SlackMessage;
    previous_message?: SlackMessage;
  };
};

/** Combine text from the message body and any attachments. */
function collectText(message: SlackMessage): string {
  const parts: string[] = [];
  if (message.text) parts.push(message.text);
  for (const attachment of message.attachments ?? []) {
    if (attachment.title) parts.push(attachment.title);
    if (attachment.text) parts.push(attachment.text);
    else if (attachment.fallback) parts.push(attachment.fallback);
  }
  return parts.join("\n");
}

/** Slack ts (e.g. "1738604400.000200") -> ISO timestamp. */
function tsToIso(ts: string | undefined): string {
  const seconds = ts ? Number.parseFloat(ts) : NaN;
  if (!Number.isFinite(seconds)) return new Date().toISOString();
  return new Date(seconds * 1000).toISOString();
}

export function createSlackEventsRouter(
  ticketStore: TicketStore,
  config: SlackEventsConfig,
): Router {
  const router = Router();

  router.post("/events", raw({ type: () => true }), (req: Request, res: Response) => {
    const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");

    if (!config.signingSecret) {
      console.warn("[slack-events] SLACK_SIGNING_SECRET not set; rejecting request");
      res.status(503).json({ error: "Slack ingestion not configured" });
      return;
    }

    const verification = verifySlackSignature({
      signingSecret: config.signingSecret,
      signature: req.header("x-slack-signature") ?? undefined,
      timestamp: req.header("x-slack-request-timestamp") ?? undefined,
      rawBody,
    });
    if (!verification.ok) {
      console.warn(`[slack-events] signature check failed: ${verification.reason}`);
      res.status(401).json({ error: "Invalid Slack signature" });
      return;
    }

    let envelope: SlackEventEnvelope;
    try {
      envelope = JSON.parse(rawBody.toString("utf8")) as SlackEventEnvelope;
    } catch {
      res.status(400).json({ error: "Invalid JSON body" });
      return;
    }

    if (envelope.type === "url_verification") {
      res.status(200).json({ challenge: envelope.challenge });
      return;
    }

    // Acknowledge immediately (Slack requires a response within 3 seconds),
    // then process the event asynchronously.
    res.status(200).send();
    void handleEvent(ticketStore, config, envelope).catch((error) => {
      console.error("[slack-events] failed to process event", error);
    });
  });

  return router;
}

async function handleEvent(
  ticketStore: TicketStore,
  config: SlackEventsConfig,
  envelope: SlackEventEnvelope,
): Promise<void> {
  if (envelope.type !== "event_callback" || !envelope.event) return;
  const outer = envelope.event;
  if (outer.type !== "message") return;

  // "message_changed" (e.g. DevRev "Refresh Data") nests the real message.
  const isEdit = outer.subtype === "message_changed";
  const message: SlackMessage = isEdit && outer.message ? outer.message : outer;
  const channel = outer.channel ?? message.channel;

  if (outer.subtype === "message_deleted") return;
  if (!channel) return;
  if (config.channelId && channel !== config.channelId) return;

  // Ignore our own bot to avoid loops.
  if (config.selfBotUserId && message.user === config.selfBotUserId) return;

  const ts = message.ts;
  if (!ts) return;
  const threadTs = message.thread_ts;
  const text = collectText(message);
  const author = message.username ?? message.user ?? message.bot_id ?? null;
  const authorId = message.user ?? message.bot_id ?? null;

  const isTopLevel = !threadTs || threadTs === ts;

  if (isTopLevel && looksLikeTicket(text)) {
    if (config.ticketBotUserId && authorId !== config.ticketBotUserId) return;

    const parsed = parseDevRevTicket(text);
    if (!parsed) return;

    await ticketStore.upsertTicket({
      ...parsed,
      source: "slack",
      channelId: channel,
      parentTs: ts,
      ticketCreatedAt: tsToIso(ts),
    });
    await ticketStore.addMessage({
      ticketId: parsed.ticketId,
      slackTs: ts,
      author,
      authorId,
      text,
      isParent: true,
      createdAt: tsToIso(ts),
    });
    console.log(`[slack-events] ingested ticket ${parsed.ticketId}`);
    return;
  }

  // Thread reply: attach to its ticket if we are tracking the parent.
  if (threadTs && threadTs !== ts) {
    const ticket = await ticketStore.findByThread(channel, threadTs);
    if (!ticket) return;

    await ticketStore.addMessage({
      ticketId: ticket.ticketId,
      slackTs: ts,
      author,
      authorId,
      text,
      isParent: false,
      createdAt: tsToIso(ts),
    });
    console.log(`[slack-events] reply added to ${ticket.ticketId}`);
  }
}
