/* Sample rooftop for the Unanswered queue — FICTIONAL customers, for local review before the backend
 * episode service exists. Held in server memory so a "Handled elsewhere" / "No reply needed" click (or a
 * sample reply) really leaves the queue while you click around; restarting the dev server resets it.
 * Times are relative to process start, so the sample always looks current.
 */
import type {
  ClearKind,
  Department,
  Episode,
  EpisodeMessage,
  ManagerPage,
  UnansweredConfig,
  UnansweredPage,
  UnansweredQuery,
} from "./types";
import { countBuckets, ownerKeyOf, ownerRowLabel, selectEpisodes, summarizeByOwner, type ClearRecord } from "./select";

const VIEWER = { consoleUserId: "u-shane", name: "Shane Ortiz" };

const SHANE = { state: "owned" as const, name: "Shane Ortiz", consoleUserId: "u-shane" };
const JIMMY = { state: "owned" as const, name: "Jimmy Reyes", consoleUserId: "u-jimmy" };
const PRIYA = { state: "owned" as const, name: "Priya Nair", consoleUserId: "u-priya" };
const UNMAPPED_DAVE = { state: "unmapped" as const, name: "Dave Kim", consoleUserId: null };
const NO_OWNER = { state: "no_owner" as const, name: null, consoleUserId: null };
const STALE_JIMMY = { state: "stale" as const, name: "Jimmy Reyes", consoleUserId: null };

interface Seed extends Omit<Episode, "since" | "recentMessages" | "actionItems" | "escalatedAt"> {
  sinceMinAgo: number;
  escalatedMinAgo?: number;
  items?: Array<{ id: string; intent: string; title: string; dueInMin: number }>;
  messages: Array<{ minAgo: number; from: EpisodeMessage["from"]; channel?: EpisodeMessage["channel"]; text: string }>;
}

const SEEDS: Seed[] = [
  // ── Sales, open ────────────────────────────────────────────────────────────────────────────
  {
    episodeId: "ep-s1", leadId: "lead-s1", customerId: "cust-s1", conversationId: "conv-s1", customerName: "Dana Whitfield",
    phone: "+1 (585) 555-0142", department: "sales", status: "open", sinceMinAgo: 95, waitInHoursMinutes: 95, channel: "sms",
    reason: "handoff", owner: SHANE, reopened: false,
    vehicle: "2026 Chevrolet Suburban", escalatedMinAgo: 65,
    items: [{ id: "ai-s1", intent: "SALES_FOLLOW_UP_WITH_QUOTE", title: "Give a verified price", dueInMin: -35 }],
    messages: [
      { minAgo: 110, from: "AI", text: "Hi Dana, this is Emily from the dealership. The 2026 Suburban you viewed is in stock." },
      { minAgo: 96, from: "CUSTOMER", text: "What's the best price you can do on the Suburban?" },
      { minAgo: 95, from: "AI", text: "I don't have a verified price to share. A sales consultant will confirm it shortly." },
    ],
  },
  {
    episodeId: "ep-s2", leadId: "lead-s2", customerId: "cust-s2", conversationId: "conv-s2", customerName: "Marcus Bell",
    phone: "+1 (585) 555-0187", department: "sales", status: "open", sinceMinAgo: 48, waitInHoursMinutes: 48, channel: "sms",
    reason: "human_last_reply", owner: JIMMY, reopened: false,
    vehicle: "2025 GMC Sierra 1500",
    messages: [
      { minAgo: 70, from: "HUMAN", text: "Hi Marcus, Jimmy here. The Sierra is ready for a test drive any time today." },
      { minAgo: 48, from: "CUSTOMER", text: "Ok what about my trade, a 2019 Silverado?" },
    ],
  },
  {
    episodeId: "ep-s3", leadId: "lead-s3", customerId: "cust-s3", conversationId: "conv-s3", customerName: "Lena Okafor",
    phone: "+1 (585) 555-0119", department: "sales", status: "open", sinceMinAgo: 22, waitInHoursMinutes: 22, channel: "sms",
    reason: "action_item", owner: SHANE, reopened: false,
    vehicle: "2023 Honda CR-V (used)",
    items: [{ id: "ai-s3", intent: "SALES_SCHEDULE_TEST_DRIVE", title: "Arrange a pre-purchase inspection", dueInMin: 98 }],
    messages: [
      { minAgo: 30, from: "AI", text: "The CR-V has 31,400 miles and a clean history report." },
      { minAgo: 22, from: "CUSTOMER", text: "Can I bring it to my mechanic before I buy?" },
    ],
  },
  {
    episodeId: "ep-s4", leadId: "lead-s4", customerId: "cust-s4", conversationId: "conv-s4", customerName: "Tom Herrera",
    phone: "+1 (585) 555-0164", department: "sales", status: "open", sinceMinAgo: 140, waitInHoursMinutes: 140, channel: "email",
    reason: "handoff", owner: UNMAPPED_DAVE, reopened: false,
    vehicle: "2027 Chevrolet Equinox EV", escalatedMinAgo: 110,
    messages: [
      { minAgo: 150, from: "AI", channel: "email", text: "Thanks for your interest in the Equinox EV. Can I answer any questions?" },
      { minAgo: 140, from: "CUSTOMER", channel: "email", text: "Please send me the out-the-door number." },
    ],
  },
  {
    episodeId: "ep-s5", leadId: "lead-s5", customerId: "cust-s5", conversationId: "conv-s5", customerName: "Grace Liu",
    phone: "+1 (585) 555-0108", department: "sales", status: "open", sinceMinAgo: 9, waitInHoursMinutes: 9, channel: "chat",
    reason: "handoff", owner: NO_OWNER, reopened: false,
    vehicle: "2027 Chevrolet Tahoe RST",
    messages: [
      { minAgo: 12, from: "CUSTOMER", channel: "chat", text: "Do you do financing for first-time buyers?" },
      { minAgo: 10, from: "AI", channel: "chat", text: "Our finance team can walk you through options. Want someone to reach out?" },
      { minAgo: 9, from: "CUSTOMER", channel: "chat", text: "Can someone call me about financing?" },
    ],
  },
  {
    episodeId: "ep-s6", leadId: "lead-s6", customerId: "cust-s6", conversationId: "conv-s6", customerName: "Owen Patel",
    phone: "+1 (585) 555-0153", department: "sales", status: "open", sinceMinAgo: 1500, waitInHoursMinutes: 300, channel: "sms",
    reason: "handoff", owner: PRIYA, reopened: true,
    vehicle: "2026 Buick Enclave",
    messages: [
      { minAgo: 4400, from: "CUSTOMER", text: "What would a 36-month lease look like?" },
      { minAgo: 1500, from: "CUSTOMER", text: "Is the lease offer still good this weekend?" },
    ],
  },
  {
    episodeId: "ep-s7", leadId: "lead-s7", customerId: "cust-s7", conversationId: "conv-s7", customerName: "Hannah Brooks",
    phone: "+1 (585) 555-0122", department: "sales", status: "open", sinceMinAgo: 35, waitInHoursMinutes: 35, channel: "sms",
    reason: "action_item", owner: STALE_JIMMY, reopened: false,
    vehicle: "2026 Chevrolet Trax",
    items: [{ id: "ai-s7", intent: "SALES_SCHEDULE_APPOINTMENT", title: "Confirm a Thursday appointment time", dueInMin: 60 }],
    messages: [
      { minAgo: 40, from: "AI", text: "Would Thursday work to see the Trax?" },
      { minAgo: 35, from: "CUSTOMER", text: "Yes Thursday works, what time?" },
    ],
  },
  // ── Sales, aged (past the 24 in-hours-hour cutoff, CRM replies not visible) ──────────────────
  {
    episodeId: "ep-s8", leadId: "lead-s8", customerId: "cust-s8", conversationId: "conv-s8", customerName: "Kevin Marsh",
    phone: "+1 (585) 555-0175", department: "sales", status: "aged", sinceMinAgo: 4300, waitInHoursMinutes: 1560, channel: "sms",
    reason: "handoff", owner: JIMMY, reopened: false, vehicle: "2024 Chevrolet Silverado 2500HD (used)",
    messages: [{ minAgo: 4300, from: "CUSTOMER", text: "What can it tow?" }],
  },
  {
    episodeId: "ep-s9", leadId: "lead-s9", customerId: "cust-s9", conversationId: "conv-s9", customerName: "Rosa Delgado",
    phone: "+1 (585) 555-0131", department: "sales", status: "aged", sinceMinAgo: 5800, waitInHoursMinutes: 2100, channel: "email",
    reason: "action_item", owner: NO_OWNER, reopened: false, vehicle: "2027 Chevrolet Tahoe High Country",
    items: [{ id: "ai-s9", intent: "SALES_SEND_VEHICLE_INFO", title: "Email the window sticker", dueInMin: -3000 }],
    messages: [{ minAgo: 5800, from: "CUSTOMER", channel: "email", text: "Send me the window sticker please." }],
  },
  // ── Service, open ─────────────────────────────────────────────────────────────────────────
  {
    episodeId: "ep-v1", leadId: "lead-v1", customerId: "cust-v1", conversationId: "conv-v1", customerName: "Paul Romero",
    phone: "+1 (585) 555-0177", department: "service", status: "open", sinceMinAgo: 55, waitInHoursMinutes: 55, channel: "sms",
    reason: "handoff", owner: NO_OWNER, reopened: false, vehicle: "2021 GMC Sierra 1500",
    messages: [
      { minAgo: 56, from: "CUSTOMER", text: "Is my truck ready? It's been 3 days." },
      { minAgo: 55, from: "AI", text: "I can't see repair status. I've asked your advisor to update you." },
    ],
  },
  {
    episodeId: "ep-v2", leadId: "lead-v2", customerId: "cust-v2", conversationId: "conv-v2", customerName: "Ivy Chen",
    phone: "+1 (585) 555-0140", department: "service", status: "open", sinceMinAgo: 18, waitInHoursMinutes: 18, channel: "sms",
    reason: "action_item", owner: NO_OWNER, reopened: false, vehicle: "2019 Chevrolet Equinox",
    items: [{ id: "ai-v2", intent: "SERVICE_PRICE_QUOTE", title: "Quote the brake job", dueInMin: 42 }],
    messages: [{ minAgo: 18, from: "CUSTOMER", text: "How much will the brake job be?" }],
  },
  // ── Service, aged ─────────────────────────────────────────────────────────────────────────
  {
    episodeId: "ep-v3", leadId: "lead-v3", customerId: "cust-v3", conversationId: "conv-v3", customerName: "Noel Ramsey",
    phone: "+1 (585) 555-0196", department: "service", status: "aged", sinceMinAgo: 1700, waitInHoursMinutes: 600, channel: "sms",
    reason: "handoff", owner: NO_OWNER, reopened: false, vehicle: "2022 Buick Encore GX",
    messages: [{ minAgo: 1700, from: "CUSTOMER", text: "Can I get a loaner tomorrow?" }],
  },
];

const START = Date.now();
const iso = (minFromStart: number) => new Date(START + minFromStart * 60_000).toISOString();

function build(s: Seed): Episode {
  const { sinceMinAgo, escalatedMinAgo, items, messages, ...rest } = s;
  return {
    ...rest,
    since: iso(-sinceMinAgo),
    escalatedAt: escalatedMinAgo == null ? null : iso(-escalatedMinAgo),
    actionItems: (items ?? []).map((i) => ({ id: i.id, intent: i.intent, title: i.title, due_at: iso(i.dueInMin), overdue: i.dueInMin < 0 })),
    recentMessages: messages.map((m) => ({ at: iso(-m.minAgo), from: m.from, channel: m.channel ?? "sms", text: m.text })),
  };
}

// Module state = the sample rooftop for this server process.
let episodes: Episode[] = SEEDS.map(build);
const clears: ClearRecord[] = [
  { episodeId: "ep-old-1", department: "sales", ownerKey: "u-jimmy", ownerLabel: "Jimmy Reyes", ownerState: "owned", kind: "handled_elsewhere", actor: "Jimmy Reyes", at: iso(-200) },
  { episodeId: "ep-old-2", department: "sales", ownerKey: "u-shane", ownerLabel: "Shane Ortiz", ownerState: "owned", kind: "console_reply", actor: "Shane Ortiz", at: iso(-180) },
  { episodeId: "ep-old-3", department: "sales", ownerKey: "u-shane", ownerLabel: "Shane Ortiz", ownerState: "owned", kind: "console_reply", actor: "Shane Ortiz", at: iso(-90) },
  { episodeId: "ep-old-4", department: "sales", ownerKey: "u-priya", ownerLabel: "Priya Nair", ownerState: "owned", kind: "no_reply_needed", actor: "Priya Nair", at: iso(-60) },
];

const CONFIG: Record<Department, Omit<UnansweredConfig, "viewerIsManager" | "viewerConsoleUserId">> = {
  // Sales: the VinSolutions owner read is treated as connected in the sample so "Mine" can be reviewed.
  sales: { mineAvailable: true, escalationConfigured: true, textsAllowed: true, agedLabel: "Possibly answered in CRM" },
  // Service: no scheduler/DMS read and hours unset → no Mine, no escalation, mark only (PRD R4–R6, A26).
  service: { mineAvailable: false, escalationConfigured: false, textsAllowed: false, agedLabel: "Possibly answered in scheduler or by phone" },
};

export function sampleUnansweredPage(q: UnansweredQuery, now = new Date()): UnansweredPage {
  const { open, aged } = countBuckets(episodes, q.department);
  const cfg = CONFIG[q.department];
  const scope = q.scope === "mine" && !cfg.mineAvailable ? "team" : q.scope;
  return {
    enabled: true,
    source: "sample",
    department: q.department,
    openCount: open,
    agedCount: aged,
    episodes: selectEpisodes(episodes, { ...q, scope }, VIEWER.consoleUserId),
    config: { ...cfg, viewerIsManager: true, viewerConsoleUserId: VIEWER.consoleUserId },
    generated_at: now.toISOString(),
  };
}

/** A click clear (R2): actor and time stored; the episode leaves the queue. */
export function sampleClear(episodeId: string, kind: ClearKind | "console_reply"): boolean {
  const e = episodes.find((x) => x.episodeId === episodeId);
  if (!e) return false;
  episodes = episodes.filter((x) => x.episodeId !== episodeId);
  clears.push({ episodeId, department: e.department, ownerKey: ownerKeyOf(e), ownerLabel: ownerRowLabel(e), ownerState: e.owner.state, kind, actor: VIEWER.name, at: new Date().toISOString() });
  return true;
}

export function sampleManagerPage(department: Department): ManagerPage {
  return {
    source: "sample",
    department,
    escalationConfigured: CONFIG[department].escalationConfigured,
    unownedQueueOwner: department === "service" ? "Service manager" : "Sales/BDC manager",
    owners: summarizeByOwner(episodes, clears, department),
    texts:
      department === "sales"
        ? [
            { at: iso(-65), recipient: "Shane Ortiz (manager)", status: "sent", episodes: 1, error: null },
            { at: iso(-110), recipient: "Shane Ortiz (manager)", status: "sent", episodes: 2, error: null },
            { at: iso(-30), recipient: "BDC manager", status: "failed", episodes: 1, error: "Carrier rejected: invalid number" },
            { at: iso(-5), recipient: "Shane Ortiz (manager)", status: "deferred", episodes: 1, error: null },
          ]
        : [],
  };
}

/** Test hook: restore the sample to its seeded state. */
export function resetSample(): void {
  episodes = SEEDS.map(build);
}
