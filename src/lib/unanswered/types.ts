/* Unanswered queue (PRD FD-24641, "Unanswered queue on Conversations") — the contract between the
 * Conversations screen and its data source.
 *
 * An EPISODE is one customer waiting on a human reply: one per lead + department (PRD R1, R12). Only a
 * human clears it — a console reply, CRM activity by a store user, or a click ("Handled elsewhere" /
 * "No reply needed") — never opening the thread and never a Vini send (R2). `isUnread`, Unread and
 * Needs Attention are untouched (R8).
 *
 * The screen renders what it is given. Today the source is a fictional sample (./sample.ts); the backend
 * episode service + team-list query (R12, R13 in conversational-ai-backend) will serve the same shape.
 */

export type Department = "sales" | "service";

/** open = on the badge; aged = past the aging cutoff where CRM replies can't be seen (R3). */
export type EpisodeBucket = "open" | "aged";

export type EpisodeChannel = "sms" | "email" | "chat" | "call";

/** Why the conversation is human-owed (R1). */
export type EpisodeReason = "handoff" | "action_item" | "human_last_reply" | "missed_call";

/** Owner state for "Mine" (R4). Never Spyne's round-robin assignee. */
export type OwnerState = "owned" | "no_owner" | "unmapped" | "stale";

export interface EpisodeOwner {
  state: OwnerState;
  name: string | null; // CRM salesperson / advisor name when known
  consoleUserId: string | null; // set only when the CRM owner maps to a console member
}

export interface EpisodeMessage {
  at: string; // ISO
  from: "CUSTOMER" | "AI" | "HUMAN";
  channel: EpisodeChannel;
  text: string;
}

export interface EpisodeActionItem {
  id: string;
  intent: string;
  title: string;
  due_at: string | null;
  overdue: boolean;
}

export interface Episode {
  episodeId: string;
  leadId: string;
  customerId: string;
  conversationId: string | null;
  customerName: string;
  phone: string | null;
  department: Department;
  status: EpisodeBucket;
  since: string; // when the wait opened (ISO)
  /** Wait so far, counted only inside the department's working hours (R5's in-hours clock). */
  waitInHoursMinutes: number;
  channel: EpisodeChannel;
  reason: EpisodeReason;
  owner: EpisodeOwner;
  escalatedAt: string | null;
  reopened: boolean;
  vehicle: string | null;
  actionItems: EpisodeActionItem[];
  recentMessages: EpisodeMessage[]; // newest last, a handful only
}

export interface UnansweredConfig {
  /** "Mine" is offered only once this rooftop + department has a connected owner source (R4). */
  mineAvailable: boolean;
  /** False when N, recipients, hours or timezone are unset: no escalation, and the manager view says so (R5, A26). */
  escalationConfigured: boolean;
  /** Whether escalation texts may go for this department (R6); otherwise episodes are "mark only". */
  textsAllowed: boolean;
  /** Label for aged episodes (R3, per department). */
  agedLabel: string;
  /** Viewer is on the manager list (R7). */
  viewerIsManager: boolean;
  viewerConsoleUserId: string | null;
}

export interface UnansweredPage {
  /** View flag for this rooftop + department (R8). False → no view, no badge; episodes is empty. */
  enabled: boolean;
  /** "sample" = built-in fictional rooftop; "live" = the episode team-list query. */
  source: "sample" | "live";
  department: Department;
  /** Badge = open episodes for the department (equals the open-bucket query total, R13). */
  openCount: number;
  agedCount: number;
  episodes: Episode[]; // the requested bucket, sorted as requested
  config: UnansweredConfig;
  generated_at: string;
}

export interface ManagerOwnerRow {
  ownerKey: string; // consoleUserId, or "no_owner" | "unmapped" | "stale"
  ownerLabel: string;
  kind: OwnerState;
  open: number;
  aged: number;
  oldestOpenMinutes: number | null;
  oldestAgedMinutes: number | null;
  clicks: Array<{ at: string; actor: string; kind: ClearKind }>;
  repliesByMember: number;
}

export interface ManagerTextRow {
  at: string;
  recipient: string;
  status: "sent" | "deferred" | "failed";
  episodes: number;
  error: string | null;
}

export interface ManagerPage {
  source: "sample" | "live";
  department: Department;
  escalationConfigured: boolean;
  /** Who works the No owner / Unmapped / Stale rows (R7; default: sales/BDC or service manager). */
  unownedQueueOwner: string;
  owners: ManagerOwnerRow[];
  texts: ManagerTextRow[];
}

/** The two human clicks that clear an episode without a console reply (R2). */
export type ClearKind = "handled_elsewhere" | "no_reply_needed";

export interface UnansweredQuery {
  department: Department;
  bucket: EpisodeBucket;
  sort: "oldest" | "newest";
  scope: "team" | "mine";
}
