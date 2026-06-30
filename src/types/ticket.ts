export type TicketStatus =
  | "open"
  | "investigating"
  | "temporary_fix"
  | "needs_pr"
  | "waiting_qa"
  | "resolved";

/** Fields parsed from the DevRev ticket message posted in Slack. */
export type ParsedDevRevTicket = {
  ticketId: string;
  title: string | null;
  body: string | null;
  createdBy: string | null;
  account: string | null;
  workspace: string | null;
  owner: string | null;
  severity: string | null;
  stage: string | null;
  subtype: string | null;
  priority: string | null;
};

/** Input used to create/update a ticket from its Slack parent message. */
export type UpsertTicketInput = ParsedDevRevTicket & {
  source: string;
  channelId: string;
  parentTs: string;
  ticketCreatedAt: string | null;
};

export type AddTicketMessageInput = {
  ticketId: string;
  slackTs: string;
  author: string | null;
  authorId: string | null;
  text: string | null;
  isParent: boolean;
  createdAt: string;
};

export type TicketRecord = {
  ticketId: string;
  source: string;
  channelId: string;
  parentTs: string;
  title: string | null;
  rawBody: string | null;
  createdBy: string | null;
  account: string | null;
  workspace: string | null;
  owner: string | null;
  severity: string | null;
  stage: string | null;
  subtype: string | null;
  devrevPriority: string | null;
  aiPriority: string | null;
  aiSummary: string | null;
  aiCategory: string | null;
  aiSuggestion: string | null;
  status: TicketStatus;
  oncallOwner: string | null;
  resolvedAt: string | null;
  ticketCreatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TicketMessageRecord = {
  id: string;
  ticketId: string;
  slackTs: string;
  author: string | null;
  authorId: string | null;
  text: string | null;
  isParent: boolean;
  createdAt: string;
};

export type TicketWithMessages = TicketRecord & {
  messages: TicketMessageRecord[];
};
