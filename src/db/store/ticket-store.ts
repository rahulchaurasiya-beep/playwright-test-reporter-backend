import { randomUUID } from "node:crypto";
import type { DbClient } from "../postgres-db-client.js";
import type {
  AddTicketMessageInput,
  TicketMessageRecord,
  TicketRecord,
  TicketStatus,
  TicketWithMessages,
  UpsertTicketInput,
} from "../../types/ticket.js";

type TicketRow = {
  ticket_id: string;
  source: string;
  channel_id: string;
  parent_ts: string;
  title: string | null;
  raw_body: string | null;
  created_by: string | null;
  account: string | null;
  workspace: string | null;
  owner: string | null;
  severity: string | null;
  stage: string | null;
  subtype: string | null;
  devrev_priority: string | null;
  ai_priority: string | null;
  ai_summary: string | null;
  ai_category: string | null;
  ai_suggestion: string | null;
  status: string;
  oncall_owner: string | null;
  resolved_at: string | null;
  ticket_created_at: string | null;
  created_at: string;
  updated_at: string;
};

type TicketMessageRow = {
  id: string;
  ticket_id: string;
  slack_ts: string;
  author: string | null;
  author_id: string | null;
  text: string | null;
  is_parent: number;
  created_at: string;
};

const VALID_STATUSES: TicketStatus[] = [
  "open",
  "investigating",
  "temporary_fix",
  "needs_pr",
  "waiting_qa",
  "resolved",
];

function toStatus(value: string): TicketStatus {
  return VALID_STATUSES.includes(value as TicketStatus)
    ? (value as TicketStatus)
    : "open";
}

function mapTicket(row: TicketRow): TicketRecord {
  return {
    ticketId: row.ticket_id,
    source: row.source,
    channelId: row.channel_id,
    parentTs: row.parent_ts,
    title: row.title,
    rawBody: row.raw_body,
    createdBy: row.created_by,
    account: row.account,
    workspace: row.workspace,
    owner: row.owner,
    severity: row.severity,
    stage: row.stage,
    subtype: row.subtype,
    devrevPriority: row.devrev_priority,
    aiPriority: row.ai_priority,
    aiSummary: row.ai_summary,
    aiCategory: row.ai_category,
    aiSuggestion: row.ai_suggestion,
    status: toStatus(row.status),
    oncallOwner: row.oncall_owner,
    resolvedAt: row.resolved_at,
    ticketCreatedAt: row.ticket_created_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessage(row: TicketMessageRow): TicketMessageRecord {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    slackTs: row.slack_ts,
    author: row.author,
    authorId: row.author_id,
    text: row.text,
    isParent: row.is_parent === 1,
    createdAt: row.created_at,
  };
}

export class TicketStore {
  constructor(private readonly db: DbClient) {}

  /**
   * Create a ticket from its Slack parent message, or refresh the DevRev
   * fields if it already exists (DevRev edits the message on "Refresh Data").
   */
  async upsertTicket(input: UpsertTicketInput): Promise<TicketRecord> {
    const now = new Date().toISOString();

    await this.db.execute(
      `INSERT INTO tickets (
        ticket_id, source, channel_id, parent_ts, title, raw_body, created_by,
        account, workspace, owner, severity, stage, subtype, devrev_priority,
        status, ticket_created_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
        'open', $15, $16, $16)
      ON CONFLICT (ticket_id) DO UPDATE SET
        title = EXCLUDED.title,
        raw_body = EXCLUDED.raw_body,
        created_by = COALESCE(EXCLUDED.created_by, tickets.created_by),
        account = COALESCE(EXCLUDED.account, tickets.account),
        workspace = COALESCE(EXCLUDED.workspace, tickets.workspace),
        owner = COALESCE(EXCLUDED.owner, tickets.owner),
        severity = COALESCE(EXCLUDED.severity, tickets.severity),
        stage = COALESCE(EXCLUDED.stage, tickets.stage),
        subtype = COALESCE(EXCLUDED.subtype, tickets.subtype),
        devrev_priority = COALESCE(EXCLUDED.devrev_priority, tickets.devrev_priority),
        updated_at = EXCLUDED.updated_at`,
      [
        input.ticketId,
        input.source,
        input.channelId,
        input.parentTs,
        input.title,
        input.body,
        input.createdBy,
        input.account,
        input.workspace,
        input.owner,
        input.severity,
        input.stage,
        input.subtype,
        input.priority,
        input.ticketCreatedAt,
        now,
      ],
    );

    const ticket = await this.getTicket(input.ticketId);
    if (!ticket) {
      throw new Error("Failed to load upserted ticket");
    }
    return ticket;
  }

  /** Add one Slack message to a ticket. Idempotent on slack_ts. */
  async addMessage(input: AddTicketMessageInput): Promise<void> {
    await this.db.execute(
      `INSERT INTO ticket_messages (
        id, ticket_id, slack_ts, author, author_id, text, is_parent, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (slack_ts) DO NOTHING`,
      [
        randomUUID(),
        input.ticketId,
        input.slackTs,
        input.author,
        input.authorId,
        input.text,
        input.isParent ? 1 : 0,
        input.createdAt,
      ],
    );

    await this.db.execute(
      "UPDATE tickets SET updated_at = $1 WHERE ticket_id = $2",
      [new Date().toISOString(), input.ticketId],
    );
  }

  async getTicket(ticketId: string): Promise<TicketRecord | null> {
    const row = await this.db.queryOne<TicketRow>(
      "SELECT * FROM tickets WHERE ticket_id = $1",
      [ticketId],
    );
    return row ? mapTicket(row) : null;
  }

  /** Find the ticket a Slack thread reply belongs to. */
  async findByThread(channelId: string, parentTs: string): Promise<TicketRecord | null> {
    const row = await this.db.queryOne<TicketRow>(
      "SELECT * FROM tickets WHERE channel_id = $1 AND parent_ts = $2",
      [channelId, parentTs],
    );
    return row ? mapTicket(row) : null;
  }

  async getTicketWithMessages(ticketId: string): Promise<TicketWithMessages | null> {
    const ticket = await this.getTicket(ticketId);
    if (!ticket) return null;

    const rows = await this.db.query<TicketMessageRow>(
      "SELECT * FROM ticket_messages WHERE ticket_id = $1 ORDER BY created_at ASC, slack_ts ASC",
      [ticketId],
    );
    return { ...ticket, messages: rows.map(mapMessage) };
  }

  async listTickets(options: { includeResolved?: boolean } = {}): Promise<TicketRecord[]> {
    const where = options.includeResolved ? "" : "WHERE status <> 'resolved'";
    const rows = await this.db.query<TicketRow>(
      `SELECT * FROM tickets ${where} ORDER BY updated_at DESC`,
    );
    return rows.map(mapTicket);
  }
}
