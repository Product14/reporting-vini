import { storeDayKey, storeParts } from "@/lib/reports/storeTime";
import type {
  ActionItemResponse,
  ActionItemRow,
  AgentProfile,
  AppointmentList,
  AppointmentListQuery,
  AppointmentResponse,
  AppointmentRow,
  CallsReportResponse,
  CampaignFunnel,
  CampaignResponse,
  ContactResponse,
  DirectionBlock,
  FollowUpResponse,
  HeatCell,
  Metric,
  Rate,
  StatusOfBookings,
  Visits,
} from "./contract";
import type { ResolvedWindow } from "./window";
import { nextDay, prevDay } from "./window";

/* SAMPLE DATA ONLY — a stand-in for Om's Service Metrics API v2 while UAT is down / until prod ships.
 *
 * It answers in the API's own v2 response shapes (contract.ts, field for field from Om's doc), so the
 * pages and models cannot tell it from the real thing, and switching to the API is a source flag
 * (source.ts). Where v2 has no field (e.g. inbound Engaged), the sample has none either, so a gap shows up
 * on screen now rather than the day the real API is switched on.
 *
 * It simulates CUSTOMERS, not counts: a year of outbound campaign enrollments and inbound calls per rooftop,
 * each customer walking the spec's funnel (F1–F6), and every appointment comes out of one of those journeys.
 * The Overview, the Reports funnel, the follow-up lists and the campaign rows are all read off the same
 * customers, so the spec's sums hold by construction and the fixture doubles as a test of them:
 *   A1 Spyne appointments = Inbound + Outbound + unplaced · A2 campaigns add up to the outbound funnel ·
 *   A3 on the whole-life view the funnel's Booked equals the bookings · A4 Booked = the five statuses ·
 *   A6 agents add up · A7 stages only shrink, drop reasons add up · A8 follow-up lists = Connected − Booked.
 * Generated once per rooftop per store-local day (seeded by team id), so a refresh or a window change never
 * moves a number. Names are generic and made up, never real customers or agents; the rates are arbitrary
 * and are not dealership statistics. */

export const MOCK_TZ = "America/Los_Angeles";
export const MOCK_DEFINITION_VERSION = "appointment-v8-sample";
const AVG_RO = 200; // the API's default average repair-order value

const HISTORY_DAYS = 365;
const GRACE_DAYS = 3; // S4: a past appointment stays "status not available" this long
const MATURING_DAYS = 14; // SP5
const HOUR = 3600000;
const DAY = 86400000;

/* D1–D3 reasons, worded as in the spec. */
export const D1 = { disconnected: "Number disconnected", unanswered: "Every call unanswered, busy, declined, voicemail full or IVR", textFailed: "Every text failed or stuck queued", notAttempted: "Not attempted yet" } as const;
export const D2 = { optOutKeyword: "Replied with an opt-out keyword (text)", voicemailOnly: "Voicemail only", noReply: "Text delivered, no reply", neverSpoke: "Answered, customer never spoke", screener: "Call screener only" } as const;
export const D3 = { spokenOptOut: "Spoken opt-out", wrongNumber: "Wrong number", wrongPerson: "Wrong or unavailable person", languageBarrier: "Language barrier", hungUp: "Hung up at the greeting", tooShort: "Too short" } as const;

/** SP3: use case → campaign type, values as stored today. */
const USE_CASES: Array<{ useCase: string; type: string; weight: number }> = [
  { useCase: "Recallnotification", type: "Recall", weight: 50 },
  { useCase: "Servicespecials", type: "Service specials", weight: 20 },
  { useCase: "Dueservices", type: "Service due", weight: 15 },
  { useCase: "Declinedservices", type: "Declined service", weight: 8 },
  { useCase: "winbackServices", type: "Lapsed", weight: 7 },
];

/* The simulation's own vocabulary (B1/B2/B5 sub-types, the follow-up lists), mapped to v2's keys on output. */
type SimType = "booked_by_spyne" | "spyne_assisted";
type SubType = "outbound_call" | "outbound_sms" | "callback" | "inbound_call" | "inbound_sms_chat" | "transfer_assisted" | "request_assisted" | "intent_assisted";
type FollowUpKey = "warm" | "notNow" | "alreadyTakenCareOf" | "noLongerServiceCustomer" | "declined" | "optedOut" | "wrongPerson" | "languageBarrier" | "noClearOutcome";
type SimStatus = "upcoming" | "cancelled" | "showed" | "no_show" | "not_available";

interface MockAppt {
  id: string;
  customerId: number;
  bookedAt: number; // epoch ms
  scheduledStart: number;
  type: SimType;
  subType: SubType;
  direction: "inbound" | "outbound" | null; // null = unplaced (A1)
  channel: "call" | "text";
  campaignId: string | null; // B8
  cancelled: boolean;
  cancelledThroughSpyne: boolean; // S3
  outcome: "showed" | "no_show" | "not_available"; // once past
  vehicle: { year: string; make: string; model: string };
  services: string;
}

interface MockCampaign {
  id: string;
  name: string;
  useCase: string;
  type: string;
  startKey: string;
}

interface MockEnrollment {
  customerId: number;
  campaignId: string;
  enrolledAt: number;
  attemptAt: number; // first touch; before it the customer is "not attempted yet" (D1)
  reached: boolean;
  connected: boolean;
  engaged: boolean;
  drop?: { stage: "toReachable" | "toConnected" | "toEngaged"; reason: string };
  bookApptId?: string; // Booked by Spyne, credited to this campaign
  bookAt?: number;
  assistApptId?: string;
  assistAt?: number; // Spyne-assisted after a touch from this campaign
  inboundAfterAt?: number; // M3: booked with Vini Inbound within 14 days
  followUp?: FollowUpKey; // the list once nothing else is pending (L1)
}

interface MockCall {
  customerId: number;
  at: number;
  engaged: boolean;
  serviceNeed: boolean;
  bookedAt?: number; // Booked by Spyne on this call
  transferred: boolean;
  transferAssistAt?: number;
  rescheduledBySpyne: boolean; // B9: handled work, never a booking
  calls: number;
  viniMinutes: number;
  totalMinutes: number;
  afterHours: boolean;
}

interface MockActionItem {
  id: string;
  customerId: number;
  title: string;
  due: number;
}

interface MockRooftop {
  teamId: string;
  tz: string;
  appts: MockAppt[];
  actions: MockActionItem[];
  clearedByDay: Map<string, number>;
  names: Map<number, string>;
  agents: Array<{ id: string; name: string; direction: "inbound" | "outbound" }>;
  campaigns: MockCampaign[];
  enrollments: MockEnrollment[];
  removed: Array<{ at: number; kind: "alreadyBooked" | "optedOut" }>;
  calls: MockCall[];
}

const FIRST = ["Alex", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Jamie", "Avery", "Quinn", "Drew", "Parker", "Reese", "Cameron", "Skyler", "Rowan", "Hayden", "Emerson", "Logan", "Peyton", "Dakota"];
const LAST = ["Rivera", "Chen", "Patel", "Nguyen", "Brooks", "Foster", "Hughes", "Kim", "Lopez", "Murphy", "Price", "Reed", "Shaw", "Turner", "Ward", "Bennett", "Coleman", "Diaz", "Ellis", "Grant"];
const MODELS: Record<string, string[]> = {
  Honda: ["CR-V", "Civic", "Accord", "Pilot", "Passport", "HR-V", "Odyssey"],
  Toyota: ["Camry", "RAV4", "Corolla", "Tacoma", "Highlander"],
  Ford: ["F-150", "Escape", "Explorer", "Bronco Sport"],
  Hyundai: ["Tucson", "Elantra", "Santa Fe", "Palisade"],
  Kia: ["Sorento", "Telluride", "Sportage", "Forte"],
  Mazda: ["CX-5", "CX-50", "Mazda3", "CX-90"],
  Volkswagen: ["Tiguan", "Jetta", "Atlas", "Taos"],
};
const SERVICES = ["Oil change", "Tire rotation", "Brake inspection", "Recall repair", "30k mile service", "Battery replacement", "Check engine light", "State inspection", "Alignment"];
// Generic persona-style first names for the sample agents, never a rooftop's real agent.
const AGENT_NAMES = ["Carl", "Emily", "Maya", "Owen", "Nora", "Leo", "Ava", "Max"];
const ACTION_TITLES = ["Schedule Service Appointment", "Recall Repair Follow-Up", "Call back about service estimate", "Escalate to Service Advisor", "Confirm loaner availability", "Follow up on declined service", "Return customer's call", "Check parts availability"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* ── seeded randomness ───────────────────────────────────────────────────────────────────────────── */
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function poisson(lambda: number, rng: () => number): number {
  const l = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= rng();
  } while (p > l);
  return k - 1;
}
const pick = <T,>(xs: readonly T[], rng: () => number): T => xs[Math.floor(rng() * xs.length)];
function weighted<T>(items: Array<[T, number]>, rng: () => number): T {
  const total = items.reduce((n, [, w]) => n + w, 0);
  let r = rng() * total;
  for (const [v, w] of items) {
    r -= w;
    if (r < 0) return v;
  }
  return items[items.length - 1][0];
}

/* ── store-local time ────────────────────────────────────────────────────────────────────────────── */
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function offsetMinutes(utcMs: number, tz: string): number {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    fmtCache.set(tz, f);
  }
  const parts = f.formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return (Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - utcMs) / 60000;
}
/** A store-local wall time on a store-local day, as an instant. */
function zonedToUtc(dayKey: string, h: number, m: number, tz: string): number {
  const [y, mo, d] = dayKey.split("-").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, m);
  const off = offsetMinutes(guess, tz);
  const utc = guess - off * 60000;
  const off2 = offsetMinutes(utc, tz);
  return off2 === off ? utc : guess - off2 * 60000;
}
function shiftKey(key: string, n: number): string {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const dayOf = (ms: number, tz: string) => storeDayKey(new Date(ms).toISOString(), tz);
/** A stable per-customer draw in [0, n), from its own hash, so query-time details never move a count. */
const draw = (r: { teamId: string }, customerId: number, salt: string, n: number) => hashStr(`${r.teamId}|${customerId}|${salt}`) % n;

/* ── the rooftop ─────────────────────────────────────────────────────────────────────────────────── */
const rooftops = new Map<string, MockRooftop>();

function brandFor(teamId: string, nameHint?: string): string {
  const hint = (nameHint ?? "").toLowerCase();
  const hit = Object.keys(MODELS).find((m) => hint.includes(m.toLowerCase()) || (m === "Volkswagen" && /\bvw\b/.test(hint)));
  return hit ?? Object.keys(MODELS)[hashStr(teamId) % Object.keys(MODELS).length];
}

/* Built from the store-local DAY only, never the exact time: the same random stream every call that day,
 * so a refresh or a window change can't move a number. `now` is applied when counting. */
function buildRooftop(teamId: string, nameHint: string | undefined, today: string, agents: string[] = []): MockRooftop {
  const tz = MOCK_TZ;
  const rng = mulberry32(hashStr(teamId || "sample-rooftop"));
  const brand = brandFor(teamId, nameHint);
  // Only the directions the rooftop runs (accounts.ts agent list); an unknown rooftop gets both.
  const known = agents.some((a) => /^service /i.test(a));
  const runsIn = !known || agents.some((a) => /^service inbound$/i.test(a));
  const runsOut = !known || agents.some((a) => /^service outbound$/i.test(a));
  const callersPerDay = 1 + rng() * 9;
  const campaignScale = 0.5 + rng() * 1.2;
  const showsVisible = rng() < 0.5; // S8: only some rooftops send outcomes back
  const anchor = zonedToUtc(today, 12, 0, tz);

  const appts: MockAppt[] = [];
  const names = new Map<number, string>();
  let nextCustomer = 1;
  const newCustomer = () => {
    const id = nextCustomer++;
    names.set(id, `${pick(FIRST, rng)} ${pick(LAST, rng)}`);
    return id;
  };
  const makeAppt = (customerId: number, bookedAt: number, type: MockAppt["type"], subType: SubType, direction: MockAppt["direction"], campaignId: string | null): string => {
    const id = `mock-${teamId}-${appts.length + 1}`;
    const lead = 1 + Math.floor(rng() * rng() * 21);
    const bookedDay = dayOf(bookedAt, tz);
    const cancelled = rng() < 0.08;
    const o = rng();
    appts.push({
      id,
      customerId,
      bookedAt,
      scheduledStart: zonedToUtc(shiftKey(bookedDay, lead), 7 + Math.floor(rng() * 10), [0, 15, 30, 45][Math.floor(rng() * 4)], tz),
      type,
      subType,
      direction,
      channel: subType === "outbound_sms" || subType === "inbound_sms_chat" ? "text" : "call",
      campaignId,
      cancelled,
      cancelledThroughSpyne: cancelled && rng() < 0.3,
      outcome: !showsVisible ? "not_available" : o < 0.85 ? "showed" : "no_show",
      vehicle: { year: String(2014 + Math.floor(rng() * 13)), make: brand, model: pick(MODELS[brand], rng) },
      services: pick(SERVICES, rng),
    });
    return id;
  };

  /* Outbound: campaigns every few weeks, each enrolling customers who walk F1–F6. */
  const campaigns: MockCampaign[] = [];
  const enrollments: MockEnrollment[] = [];
  const removed: MockRooftop["removed"] = [];
  const calls: MockCall[] = [];
  if (runsOut) {
    let back = Math.floor(rng() * 6);
    while (back < HISTORY_DAYS - 10) {
      const startKey = shiftKey(today, -back);
      const uc = weighted(USE_CASES.map((u) => [u, u.weight] as [typeof u, number]), rng);
      const [, m, d] = startKey.split("-").map(Number);
      const campaign: MockCampaign = { id: `mock-camp-${teamId}-${campaigns.length + 1}`, name: `${uc.type} · ${MON[m - 1]} ${d}`, useCase: uc.useCase, type: uc.type, startKey };
      campaigns.push(campaign);
      const size = Math.round((60 + rng() * 380) * campaignScale);
      const span = 1 + Math.floor(rng() * 5);
      for (let i = 0; i < size; i++) {
        const enrolledAt = zonedToUtc(shiftKey(startKey, Math.floor(rng() * span)), 8 + Math.floor(rng() * 9), Math.floor(rng() * 60), tz);
        if (rng() < 0.02) {
          removed.push({ at: enrolledAt, kind: rng() < 0.5 ? "alreadyBooked" : "optedOut" });
          continue;
        }
        const e: MockEnrollment = { customerId: newCustomer(), campaignId: campaign.id, enrolledAt, attemptAt: enrolledAt + rng() * 30 * HOUR, reached: false, connected: false, engaged: false };
        const textFirst = rng() < 0.3;
        if (rng() < 0.55) {
          e.reached = true;
          if (rng() < 0.45) {
            e.connected = true;
            if (rng() < 0.6) {
              e.engaged = true;
              const r = rng();
              if (r < 0.2) {
                // Booked by Spyne: on the touch itself, or later by text or a callback (B4: still Outbound).
                const lagDays = rng() < 0.65 ? 0 : 1 + Math.floor(rng() * 13);
                e.bookAt = e.attemptAt + lagDays * DAY + 5 * 60000;
                const subType: SubType = lagDays === 0 ? (textFirst ? "outbound_sms" : "outbound_call") : weighted<SubType>([["callback", 50], ["outbound_sms", 30], ["outbound_call", 20]], rng);
                e.bookApptId = makeAppt(e.customerId, e.bookAt, "booked_by_spyne", subType, "outbound", campaign.id);
              } else if (r < 0.28) {
                // Spyne-assisted (B5): the store booked after a transfer (24 h), a request (72 h) or, intent, 14 days.
                const kind = weighted<SubType>([["transfer_assisted", 40], ["request_assisted", 30], ["intent_assisted", 30]], rng);
                const within = kind === "transfer_assisted" ? 20 * HOUR : kind === "request_assisted" ? 70 * HOUR : 13 * DAY;
                e.assistAt = e.attemptAt + HOUR + rng() * within;
                e.assistApptId = makeAppt(e.customerId, e.assistAt, "spyne_assisted", kind, "outbound", campaign.id);
                e.followUp = "alreadyTakenCareOf"; // L2: booked another way
              } else if (r < 0.32 && runsIn) {
                // M3: called the main line within 14 days and Vini Inbound booked it (inbound, no campaign, B8).
                e.inboundAfterAt = e.attemptAt + DAY + rng() * 13 * DAY;
                makeAppt(e.customerId, e.inboundAfterAt, "booked_by_spyne", "inbound_call", "inbound", null);
                // Booked during that call: the same instant, so the call and the booking can't fall on two days.
                const minutes = 2 + rng() * 4;
                calls.push({ customerId: e.customerId, at: e.inboundAfterAt, engaged: true, serviceNeed: true, bookedAt: e.inboundAfterAt, transferred: false, rescheduledBySpyne: false, calls: 1, viniMinutes: minutes, totalMinutes: minutes, afterHours: false });
                e.followUp = "alreadyTakenCareOf";
              } else {
                e.followUp = weighted<FollowUpKey>([["warm", 35], ["notNow", 20], ["alreadyTakenCareOf", 8], ["noLongerServiceCustomer", 6], ["declined", 12], ["optedOut", 3], ["wrongPerson", 2], ["languageBarrier", 2], ["noClearOutcome", 12]], rng);
              }
            } else {
              const reason = weighted<string>([[D3.spokenOptOut, 10], [D3.wrongNumber, 14], [D3.wrongPerson, 14], [D3.languageBarrier, 6], [D3.hungUp, 30], [D3.tooShort, 26]], rng);
              e.drop = { stage: "toEngaged", reason };
              // L1: every Connected customer who didn't book lands in exactly one list.
              e.followUp = reason === D3.spokenOptOut ? "optedOut" : reason === D3.wrongNumber || reason === D3.wrongPerson ? "wrongPerson" : reason === D3.languageBarrier ? "languageBarrier" : weighted<FollowUpKey>([["noClearOutcome", 60], ["notNow", 40]], rng);
            }
          } else {
            e.drop = { stage: "toConnected", reason: weighted<string>([[D2.optOutKeyword, 6], [D2.voicemailOnly, 40], [D2.noReply, 30], [D2.neverSpoke, 18], [D2.screener, 6]], rng) };
          }
        } else {
          e.drop = { stage: "toReachable", reason: weighted<string>([[D1.disconnected, 10], [D1.unanswered, 72], [D1.textFailed, 18]], rng) };
        }
        enrollments.push(e);
      }
      back += 20 + Math.floor(rng() * 30);
    }
  }

  /* Inbound: callers every day; Engaged on inbound uses F5 (no pickup exclusion). */
  if (runsIn) {
    for (let back = HISTORY_DAYS - 1; back >= 0; back--) {
      const day = shiftKey(today, -back);
      for (let n = poisson(callersPerDay, rng); n > 0; n--) {
        const hour = 7 + Math.floor(rng() * 15);
        const at = zonedToUtc(day, hour, Math.floor(rng() * 60), tz);
        const engaged = rng() < 0.72;
        const serviceNeed = rng() < 0.68;
        const viniMinutes = 1 + rng() * 5;
        const call: MockCall = { customerId: newCustomer(), at, engaged, serviceNeed, transferred: false, rescheduledBySpyne: false, calls: rng() < 0.25 ? 2 : 1, viniMinutes, totalMinutes: viniMinutes, afterHours: hour < 8 || hour >= 18 };
        if (engaged && serviceNeed && rng() < 0.32) {
          call.bookedAt = at + 3 * 60000;
          makeAppt(call.customerId, call.bookedAt, "booked_by_spyne", rng() < 0.85 ? "inbound_call" : "inbound_sms_chat", "inbound", null);
        } else if (engaged && rng() < 0.15) {
          call.transferred = true;
          call.totalMinutes += 2 + rng() * 6;
          if (serviceNeed && rng() < 0.6) {
            // The store books while the caller is still warm: same day, so call and booking share a window.
            call.transferAssistAt = at + 5 * 60000 + rng() * 85 * 60000;
            makeAppt(call.customerId, call.transferAssistAt, "spyne_assisted", "transfer_assisted", "inbound", null);
          }
        } else if (engaged && serviceNeed && rng() < 0.06) {
          makeAppt(call.customerId, at + 10 * 60000 + rng() * 110 * 60000, "spyne_assisted", "request_assisted", "inbound", null);
        } else if (serviceNeed && rng() < 0.05) {
          call.rescheduledBySpyne = true;
        }
        calls.push(call);
      }
    }
  }

  /* Unplaced (A1): now and then a Spyne booking with no agent on record. */
  for (let back = HISTORY_DAYS - 1; back >= 0; back--) {
    if (rng() < 0.02) makeAppt(newCustomer(), zonedToUtc(shiftKey(today, -back), 10 + Math.floor(rng() * 8), Math.floor(rng() * 60), tz), "booked_by_spyne", "inbound_call", null, null);
  }

  // Open action items right now (live, not windowed), mostly past due, as on a busy rooftop.
  const actions: MockActionItem[] = [];
  const openCount = 30 + Math.floor(rng() * 420);
  for (let i = 0; i < openCount; i++) {
    const daysFromNow = rng() * 67 - 60;
    actions.push({ id: `mock-ai-${teamId}-${i + 1}`, customerId: newCustomer(), title: pick(ACTION_TITLES, rng), due: anchor + daysFromNow * DAY });
  }
  actions.sort((a, b) => a.due - b.due);
  const clearedByDay = new Map<string, number>();
  const lamCleared = 2 + rng() * 12;
  for (let back = HISTORY_DAYS - 1; back >= 0; back--) clearedByDay.set(shiftKey(today, -back), poisson(lamCleared, rng));

  // Names from their own stream, so adding them can't shift any count above.
  const nameRng = mulberry32(hashStr(`${teamId}|agents`));
  const ibName = pick(AGENT_NAMES, nameRng);
  const obName = pick(AGENT_NAMES.filter((n) => n !== ibName), nameRng);
  const agentList: MockRooftop["agents"] = [];
  if (runsIn) agentList.push({ id: `mock-agent-${teamId}-ib`, name: ibName, direction: "inbound" });
  if (runsOut) agentList.push({ id: `mock-agent-${teamId}-ob`, name: obName, direction: "outbound" });

  return { teamId, tz, appts, actions, clearedByDay, names, agents: agentList, campaigns, enrollments, removed, calls };
}

function rooftopFor(teamId: string, nameHint: string | undefined, now: number, agents?: string[]): MockRooftop {
  // Regenerate once per store-local day, so "today" moves and statuses age, but a refresh never moves.
  const today = dayOf(now, MOCK_TZ);
  const key = `${teamId}|${today}|${(agents ?? []).join(",")}`;
  let r = rooftops.get(key);
  if (!r) {
    r = buildRooftop(teamId, nameHint, today, agents);
    rooftops.set(key, r);
  }
  return r;
}

/* ── shared helpers ──────────────────────────────────────────────────────────────────────────────── */
function statusOf(a: MockAppt, now: number): SimStatus {
  if (a.cancelled) return "cancelled";
  if (a.scheduledStart > now) return "upcoming";
  if (now - a.scheduledStart < GRACE_DAYS * DAY) return "not_available";
  return a.outcome;
}
/** Prod's asOf block: when the response was built (newest-data times kept simple in the sample). */
const asOfBlock = (now: number) => ({ generatedAt: new Date(now).toISOString(), lastAppointmentAt: new Date(now).toISOString(), lastCallAt: new Date(now).toISOString(), lastRepairOrderAt: null });
const metric = (n: number): Metric => ({ available: true, value: n, reason: null });
const notAvailable = (reason: string): Metric => ({ available: false, value: null, reason });
function rate(numerator: number, denominator: number): Rate {
  return { available: denominator > 0, value: denominator > 0 ? numerator / denominator : null, numerator, denominator };
}
const ratio = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 10000) / 10000 : 0);
const inWin = (ms: number, w: ResolvedWindow, tz: string) => {
  const k = dayOf(ms, tz);
  return k >= w.startKey && k < w.endKey;
};
function windowInfo(w: ResolvedWindow, tz: string) {
  return { from: w.startKey, to: prevDay(w.endKey), timezone: tz, grain: "total" };
}
const showsVisible = (r: MockRooftop) => r.appts.some((a) => a.outcome !== "not_available");

/** S1 for a set of bookings: booked = upcoming + cancelled + showed + no-show + not available. */
function statusOfBookings(xs: MockAppt[], now: number): StatusOfBookings {
  const s = { upcoming: 0, cancelled: 0, cancelledThroughSpyne: 0, showed: 0, noShow: 0, statusNotAvailable: 0 };
  for (const a of xs) {
    const st = statusOf(a, now);
    if (st === "upcoming") s.upcoming++;
    else if (st === "cancelled") {
      s.cancelled++;
      if (a.cancelledThroughSpyne) s.cancelledThroughSpyne++;
    } else if (st === "showed") s.showed++;
    else if (st === "no_show") s.noShow++;
    else s.statusNotAvailable++;
  }
  return { available: true, booked: xs.length, ...s, cancelledOutsideSpyne: s.cancelled - s.cancelledThroughSpyne, statusNotAvailableReason: "Past appointments the store hasn't updated yet." };
}

/** Visits: Spyne appointments whose time fell in the window and has passed. */
function visitsOf(r: MockRooftop, xs: MockAppt[], w: ResolvedWindow, now: number): Visits {
  const due = xs.filter((a) => !a.cancelled && a.scheduledStart <= now && inWin(a.scheduledStart, w, r.tz));
  const showed = due.filter((a) => statusOf(a, now) === "showed").length;
  const noShow = due.filter((a) => statusOf(a, now) === "no_show").length;
  return {
    available: true,
    due: due.length,
    showed,
    noShow,
    notKnown: due.length - showed - noShow,
    bookedBeforeWindow: due.filter((a) => dayOf(a.bookedAt, r.tz) < w.startKey).length,
    showRate: showsVisible(r) && showed + noShow > 0 ? ratio(showed, showed + noShow) : null,
    confirmedVisitRate: ratio(showed, due.length),
    outcomeSource: showsVisible(r) ? "scheduler" : "none",
  };
}

/** The scheduler's own status words, as Om's API passes them through. A past appointment the store never
 * updated still reads "scheduled". */
const RAW_STATUS: Record<SimStatus, string> = { upcoming: "scheduled", showed: "completed", no_show: "no_show", cancelled: "cancelled", not_available: "scheduled" };
/** Om's own statusNow beside it (RETCONVAI-5282 S1–S5). */
const STATUS_NOW = { upcoming: "upcoming", showed: "showed", no_show: "no_show", cancelled: "cancelled", not_available: "status_not_available" } as const satisfies Record<SimStatus, AppointmentRow["statusNow"]>;
/** Rows as Om's list sends them: the booking agent and direction on our own bookings only (an assisted row's
 * direction is null; the list's `direction` filter still places it by its handoff). */
function toRow(r: MockRooftop, a: MockAppt, now: number): AppointmentRow {
  const ours = a.type === "booked_by_spyne";
  const agent = ours ? r.agents.find((ag) => ag.direction === a.direction) : undefined;
  return {
    meetingId: a.id,
    customerName: r.names.get(a.customerId) ?? "Customer",
    vehicle: a.vehicle,
    services: a.services,
    scheduledStart: new Date(a.scheduledStart).toISOString(),
    phone: null,
    bookedOn: new Date(a.bookedAt).toISOString(),
    tag: a.type,
    channel: ours ? a.channel : null,
    direction: ours ? a.direction : null,
    status: RAW_STATUS[statusOf(a, now)],
    statusNow: STATUS_NOW[statusOf(a, now)],
    bookedByAgent: agent ? { teamAgentMappingId: `${r.teamId}-${agent.direction}`, agentName: agent.name } : null,
    campaignId: a.campaignId ?? null,
  };
}

export interface MockCtx {
  teamId: string;
  nameHint?: string;
  /** The rooftop's agents from accounts.ts, e.g. "Service Outbound". */
  agents?: string[];
  now?: number;
  /** Answer the way UAT does today: Spyne-assisted not available (doc 1.1, "UAT is missing a log"). */
  assistedOff?: boolean;
}

/* ── GET /appointment (1.1) ─────────────────────────────────────────────────────────────────────── */
/** Booked counts on the booking date in the window. `list: "upcoming"` lists future, not-cancelled Spyne
 * appointments soonest first (whatever the window); `list: "created"` lists the window's bookings, filtered
 * like the API's `tag` and `direction`. Without a list, `direction` scopes the whole response to one agent and
 * `grain: "day"` adds the per-day `trend`, whose days add up to the totals (doc 1.7, rule 9). */
export function mockAppointments(
  ctx: MockCtx,
  w: ResolvedWindow,
  opts: { list?: "upcoming" | "created"; limit?: number; tags?: string[]; direction?: "inbound" | "outbound"; grain?: "day" } = {},
): AppointmentResponse {
  const resp = appointmentsFull(ctx, w, opts);
  return ctx.assistedOff ? withoutAssisted(resp) : resp;
}

function appointmentsFull(
  ctx: MockCtx,
  w: ResolvedWindow,
  opts: { list?: "upcoming" | "created"; limit?: number; tags?: string[]; direction?: "inbound" | "outbound"; grain?: "day" },
): AppointmentResponse {
  const now = ctx.now ?? Date.now();
  const r = rooftopFor(ctx.teamId, ctx.nameHint, now, ctx.agents);
  // Later today's bookings exist in the generated set but haven't happened yet.
  const all = r.appts.filter((a) => a.bookedAt <= now);
  const visible = opts.direction && !opts.list ? all.filter((a) => a.direction === opts.direction) : all;
  const inWindow = visible.filter((a) => inWin(a.bookedAt, w, r.tz));
  const booked = inWindow.filter((a) => a.type === "booked_by_spyne");
  const assisted = inWindow.filter((a) => a.type === "spyne_assisted");
  const spyne = inWindow;
  const active = spyne.filter((a) => !a.cancelled).length;
  const visits = visitsOf(r, visible, w, now);
  const dir = (d: "inbound" | "outbound"): DirectionBlock => {
    const mine = inWindow.filter((a) => a.direction === d);
    const mineBooked = mine.filter((a) => a.type === "booked_by_spyne");
    return {
      bookedBySpyne: mineBooked.length,
      spyneAssisted: mine.filter((a) => a.type === "spyne_assisted").length,
      statusOfBookings: statusOfBookings(mineBooked, now),
      visits: visitsOf(r, visible.filter((a) => a.direction === d), w, now),
    };
  };
  const upcoming = visible.filter((a) => statusOf(a, now) === "upcoming").sort((x, y) => x.scheduledStart - y.scheduledStart);
  let items: AppointmentRow[] | undefined;
  let total = 0;
  if (opts.list === "upcoming") {
    items = upcoming.slice(0, opts.limit ?? 10).map((a) => toRow(r, a, now));
    total = upcoming.length;
  } else if (opts.list === "created") {
    const xs = inWindow
      .filter((a) => (!opts.tags || opts.tags.includes(a.type)) && (!opts.direction || a.direction === opts.direction))
      .sort((x, y) => y.bookedAt - x.bookedAt);
    items = xs.map((a) => toRow(r, a, now));
    total = xs.length;
  }
  const byType = {
    transfer: assisted.filter((a) => a.subType === "transfer_assisted").length,
    request: assisted.filter((a) => a.subType === "request_assisted").length,
    intent: assisted.filter((a) => a.subType === "intent_assisted").length,
  };
  const showedVisits = visits.showed;
  let trend: AppointmentResponse["trend"] = null;
  if (opts.grain === "day") {
    trend = [];
    for (let day = w.startKey; day < w.endKey; day = nextDay(day)) {
      const mine = inWindow.filter((a) => dayOf(a.bookedAt, r.tz) === day);
      trend.push({ date: day, endDate: day, bookedBySpyne: mine.filter((a) => a.type === "booked_by_spyne").length, spyneAssisted: mine.filter((a) => a.type === "spyne_assisted").length, bookedByDealer: null, scheduled: null });
    }
  }
  return {
    teamId: ctx.teamId,
    agentLine: "service",
    window: windowInfo(w, r.tz),
    definitionVersion: MOCK_DEFINITION_VERSION,
    asOf: asOfBlock(now),
    metrics: {
      bookedBySpyne: metric(booked.length),
      spyneAssisted: { ...metric(assisted.length), byType },
      active: metric(active),
      expectedRevenue: { available: true, value: active * AVG_RO, active, avgRo: AVG_RO, avgRoSource: "default" },
      statusOfBookings: statusOfBookings(booked, now),
      visits,
      realizedRevenue: { available: true, value: showedVisits * AVG_RO, basis: "estimated", showed: showedVisits, avgRo: AVG_RO },
      byDirection: {
        inbound: dir("inbound"),
        outbound: dir("outbound"),
        unplaced: { bookedBySpyne: booked.filter((a) => a.direction === null).length, spyneAssisted: assisted.filter((a) => a.direction === null).length },
      },
      bookingCohortRevenue: {
        earnedSoFar: spyne.filter((a) => statusOf(a, now) === "showed").length * AVG_RO,
        earnedBasis: "estimated",
        stillUpcoming: spyne.filter((a) => statusOf(a, now) === "upcoming").length * AVG_RO,
        estimated: active * AVG_RO,
        lostAppointments: spyne.filter((a) => a.cancelled).length,
      },
      upcoming: metric(upcoming.length),
    },
    trend,
    appointments: items ? { items, total, nextCursor: null } : undefined,
  };
}

const ASSISTED_OFF_REASON = "Spyne-assisted needs the store's bookings for handed-over customers, and that log isn't on this environment yet.";
/** UAT's shape (doc 1.1): the metric unavailable with a reason, null per direction, no key under unplaced,
 * null in the trend. Without the log, an assisted booking can't be told from the BDC's own, so the lists
 * show it as the BDC's (upcoming) or leave it out (the Spyne bookings list). */
function withoutAssisted(resp: AppointmentResponse): AppointmentResponse {
  const m = resp.metrics;
  const d = m.byDirection;
  return {
    ...resp,
    metrics: {
      ...m,
      spyneAssisted: { available: false, value: null, reason: ASSISTED_OFF_REASON, byType: null },
      byDirection: d && {
        inbound: { ...d.inbound, spyneAssisted: null },
        outbound: { ...d.outbound, spyneAssisted: null },
        unplaced: { bookedBySpyne: d.unplaced?.bookedBySpyne ?? null },
      },
    },
    trend: resp.trend?.map((t) => ({ ...t, spyneAssisted: null })) ?? resp.trend,
    appointments: resp.appointments && {
      ...resp.appointments,
      items: resp.appointments.items.map((it) => (it.tag === "spyne_assisted" ? { ...it, tag: "booked_by_dealer" } : it)),
    },
  };
}

/** The rows behind a number (rule 8): the same /appointment list the page asks for. */
export function mockAppointmentList(ctx: MockCtx, w: ResolvedWindow, q: AppointmentListQuery): AppointmentList {
  const resp = mockAppointments(ctx, w, { list: "created", direction: q.direction });
  // The `tag` filter runs on the rows' tags as the API sends them (with assisted off, there are none).
  const items = (resp.appointments?.items ?? []).filter((it) => (q.types as string[]).includes(it.tag ?? ""));
  return { items, total: items.length };
}

/* ── GET /action-item (1.3) ─────────────────────────────────────────────────────────────────────── */
const CALLBACK_TITLES = new Set(["Return customer's call", "Call back about service estimate"]);
/** Open, past SLA, due today and callbacks waiting are live counts; the rows are the open ones, due first. */
export function mockActionItems(ctx: MockCtx, w: ResolvedWindow, opts: { limit?: number } = {}): ActionItemResponse {
  const now = ctx.now ?? Date.now();
  const r = rooftopFor(ctx.teamId, ctx.nameHint, now, ctx.agents);
  const today = dayOf(now, r.tz);
  let cleared = 0;
  for (const [k, n] of r.clearedByDay) if (k >= w.startKey && k < w.endKey) cleared += n;
  const items: ActionItemRow[] = r.actions.slice(0, opts.limit ?? 10).map((a) => ({
    actionItemId: a.id,
    customerName: r.names.get(a.customerId) ?? "Customer",
    whatNeedsDoing: a.title,
    title: a.title,
    due: new Date(a.due).toISOString(),
    isLate: a.due < now,
  }));
  return {
    window: windowInfo(w, r.tz),
    definitionVersion: MOCK_DEFINITION_VERSION,
    asOf: asOfBlock(now),
    metrics: {
      openNow: metric(r.actions.length),
      pastSla: metric(r.actions.filter((a) => a.due < now).length),
      dueToday: metric(r.actions.filter((a) => a.due >= now && dayOf(a.due, r.tz) === today).length),
      callbacksOpenNow: metric(r.actions.filter((a) => CALLBACK_TITLES.has(a.title)).length),
      cleared: metric(cleared),
    },
    actionItems: { items, total: r.actions.length, nextCursor: null },
  };
}

/* ── GET /contact (1.2) ─────────────────────────────────────────────────────────────────────────── */
/** v2's per-direction fields in every response, plus today's fields scoped to the `direction` asked for. */
export function mockContact(ctx: MockCtx, w: ResolvedWindow, direction: "inbound" | "outbound"): ContactResponse {
  const now = ctx.now ?? Date.now();
  const r = rooftopFor(ctx.teamId, ctx.nameHint, now, ctx.agents);
  // Inbound: the window's callers, by call date. A small share of calls ring out unanswered.
  const calls = r.calls.filter((c) => c.at <= now && inWin(c.at, w, r.tz));
  const answered = calls.filter((c) => draw(r, c.customerId, "missed", 25) !== 0);
  const ids = (xs: typeof calls) => new Set(xs.map((c) => c.customerId)).size;
  const ibCalled = ids(calls);
  const ibReached = ids(answered);
  const ibNeed = ids(answered.filter((c) => c.serviceNeed));
  const ibMinutes = answered.reduce((n, c) => n + c.viniMinutes, 0);
  // Outbound: customers first attempted in the window.
  const touched = r.enrollments.filter((e) => e.attemptAt <= now && inWin(e.attemptAt, w, r.tz));
  const obCalled = touched.length;
  const obReached = touched.filter((e) => e.connected).length;
  const obEngaged = touched.filter((e) => e.engaged).length;
  const obMinutes = touched.reduce((n, e) => n + (e.connected ? 1 + draw(r, e.customerId, "talk", 5) : e.reached ? 0.3 : 0), 0);
  const obDials = touched.reduce((n, e) => n + 1 + draw(r, e.customerId, "dials", 3), 0);
  const ibDials = calls.reduce((n, c) => n + c.calls, 0);
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const scoped = direction === "inbound"
    ? {
        calls: metric(ibDials),
        connectedCalls: metric(answered.reduce((n, c) => n + c.calls, 0)),
        // Confirmation and follow-up texts after a call that went somewhere.
        smsSent: metric(answered.filter((c) => c.engaged).reduce((n, c) => n + 1 + draw(r, c.customerId, "ibsms", 2), 0)),
        talkTimeMinutes: metric(Math.round(calls.reduce((n, c) => n + c.totalMinutes, 0))),
        leadsReached: metric(ibReached),
        realConversations: metric(answered.filter((c) => c.engaged).length),
      }
    : {
        calls: metric(obDials),
        connectedCalls: metric(touched.filter((e) => e.reached).length),
        smsSent: metric(touched.reduce((n, e) => n + draw(r, e.customerId, "sms", 2) + (e.connected ? draw(r, e.customerId, "sms2", 2) : 0), 0)),
        talkTimeMinutes: metric(Math.round(obMinutes * 1.1)),
        leadsReached: metric(obReached),
        realConversations: metric(obEngaged),
      };
  // contact-v4: connectRate is always split, whatever `direction` asked; optedOut is the whole rooftop's.
  const shared = {
    connectRate: { inbound: rate(answered.reduce((n, c) => n + c.calls, 0), ibDials), outbound: rate(touched.filter((e) => e.reached).length, obDials) },
    engagementRate: { inbound: rate(answered.filter((c) => c.engaged).length, answered.length), outbound: rate(obEngaged, obReached) },
    optedOut: metric(ids(calls.filter((c) => draw(r, c.customerId, "optout", 60) === 0)) + touched.filter((e) => e.followUp === "optedOut" || e.drop?.reason === D2.optOutKeyword).length),
  };
  return {
    window: windowInfo(w, r.tz),
    definitionVersion: MOCK_DEFINITION_VERSION,
    asOf: asOfBlock(now),
    metrics: {
      staffTimeSavedMinutes: { available: true, value: round2(ibMinutes + obMinutes), inbound: round2(ibMinutes), outbound: round2(obMinutes) },
      customersCalled: { inbound: metric(ibCalled), outbound: metric(obCalled) },
      callersReached: { inbound: metric(ibReached), outbound: metric(obReached) },
      neededService: { inbound: metric(ibNeed), outbound: metric(obEngaged) },
      wantedSomethingElse: { inbound: metric(ibReached - ibNeed), outbound: metric(obReached - obEngaged) },
      ...scoped,
      ...shared,
    },
  };
}

/* ── GET /campaign (1.4), rooftop-wide: every campaign in the window ─────────────────────────────── */
/** The customers enrolled in the window (SP5), the funnel's population. One rule for the funnel and its lists. */
function cohortOf(r: MockRooftop, w: ResolvedWindow, now: number): MockEnrollment[] {
  return r.enrollments.filter((e) => e.enrolledAt <= now && inWin(e.enrolledAt, w, r.tz));
}
const D1_KEYS: Record<string, string> = { [D1.disconnected]: "number_disconnected", [D1.unanswered]: "calls_unanswered", [D1.textFailed]: "texts_failed", [D1.notAttempted]: "not_attempted_yet" };
const D2_KEYS: Record<string, string> = { [D2.optOutKeyword]: "opted_out_by_text", [D2.voicemailOnly]: "voicemail_only", [D2.noReply]: "text_delivered_no_reply", [D2.neverSpoke]: "answered_never_spoke", [D2.screener]: "call_screener_only" };
const D3_KEYS: Record<string, string> = { [D3.spokenOptOut]: "spoken_opt_out", [D3.wrongNumber]: "wrong_number", [D3.wrongPerson]: "wrong_or_unavailable_person", [D3.languageBarrier]: "language_barrier", [D3.hungUp]: "hung_up_at_greeting", [D3.tooShort]: "too_short" };
const LIST_KEYS: Record<FollowUpKey, string> = { warm: "warmLeads", notNow: "notNow", alreadyTakenCareOf: "alreadyTakenCareOf", noLongerServiceCustomer: "noLongerServiceCustomer", declined: "declined", optedOut: "optedOut", wrongPerson: "wrongPerson", languageBarrier: "languageBarrier", noClearOutcome: "noClearOutcome" };
const LIST_META: Record<string, { label: string; bucket: string }> = {
  warmLeads: { label: "Warm leads", bucket: "Needs your team" },
  notNow: { label: "Not now", bucket: "Waiting on customer" },
  alreadyTakenCareOf: { label: "Already taken care of", bucket: "Handled by your team" },
  noLongerServiceCustomer: { label: "No longer a service customer", bucket: "Declined" },
  declined: { label: "Declined", bucket: "Declined" },
  optedOut: { label: "Opted out", bucket: "Do not contact" },
  wrongPerson: { label: "Wrong or unavailable person", bucket: "Do not contact" },
  languageBarrier: { label: "Language barrier", bucket: "Dropped" },
  noClearOutcome: { label: "No clear outcome", bucket: "Dropped" },
};

type Stage = 0 | 1 | 2 | 3 | 4;
interface CohortRow { e: MockEnrollment; stage: Stage; reason?: string; list?: string }
/** Where each enrolled customer stands now: the furthest stage, the reason they stopped, and their list (L1). */
function walk(r: MockRooftop, cohort: MockEnrollment[], now: number): CohortRow[] {
  return cohort.map((e): CohortRow => {
    let stage: Stage;
    let reason: string | undefined;
    if (e.attemptAt > now) [stage, reason] = [0, D1.notAttempted];
    else if (!e.reached) [stage, reason] = [0, e.drop?.reason];
    else if (!e.connected) [stage, reason] = [1, e.drop?.reason];
    else if (!e.engaged) [stage, reason] = [2, e.drop?.reason];
    else if (e.bookAt !== undefined && e.bookAt <= now) stage = 4;
    else stage = 3;
    if (stage < 2 || stage === 4) return { e, stage, reason };
    // Someone still in play (a booking or a handoff that hasn't happened yet) sits in Warm leads until it does.
    const pending = (e.bookAt !== undefined && e.bookAt > now) || (e.assistAt !== undefined && e.assistAt > now) || (e.inboundAfterAt !== undefined && e.inboundAfterAt > now);
    return { e, stage, reason, list: pending ? "warmLeads" : LIST_KEYS[e.followUp ?? "noClearOutcome"] };
  });
}

function funnelOf(r: MockRooftop, rows: CohortRow[], removed: number, w: ResolvedWindow, now: number): CampaignFunnel {
  const at = (s: number) => rows.filter((x) => x.stage >= s).length;
  const stages = { enrolled: rows.length, reachable: at(1), connected: at(2), engaged: at(3), booked: at(4) };
  const tally = (stage: Stage, keys: Record<string, string>) => {
    const out: Record<string, number> = Object.fromEntries(Object.values(keys).map((k) => [k, 0]));
    for (const x of rows) if (x.stage === stage && x.reason && keys[x.reason]) out[keys[x.reason]]++;
    return out;
  };
  const d4: Record<string, number> = {};
  for (const x of rows) if (x.list) d4[x.list] = (d4[x.list] ?? 0) + 1;
  const bookedAppts = rows.filter((x) => x.stage === 4).length;
  const assisted = rows.filter((x) => x.e.assistAt !== undefined && x.e.assistAt <= now).length;
  const active = rows.filter((x) => x.stage === 4 && !r.appts.find((a) => a.id === x.e.bookApptId)?.cancelled).length;
  return {
    enrollments: rows.length,
    removedBeforeAttempt: removed,
    stages,
    rates: {
      bookingRate: ratio(stages.booked, stages.engaged),
      bookedOfConnected: ratio(stages.booked, stages.connected),
      yield: ratio(stages.booked, stages.enrolled),
      reachable: ratio(stages.reachable, stages.enrolled),
      connected: ratio(stages.connected, stages.reachable),
      engaged: ratio(stages.engaged, stages.connected),
    },
    bookedAppointments: bookedAppts,
    active,
    expectedRevenue: active * AVG_RO,
    avgRo: AVG_RO,
    beside: { spyneAssisted: assisted, bookedWithViniInboundAfter: rows.filter((x) => x.e.inboundAfterAt !== undefined && x.e.inboundAfterAt <= now).length },
    drops: { D1: tally(0, D1_KEYS), D2: tally(1, D2_KEYS), D3: tally(2, D3_KEYS), D4: d4 },
    stillMaturing: rows.some((x) => now - x.e.enrolledAt < MATURING_DAYS * DAY) && w.startKey > "2020-01-01",
    optedOut: { afterConnecting: d4.optedOut ?? 0, beforeConnecting: rows.filter((x) => x.stage === 1 && x.reason === D2.optOutKeyword).length },
  };
}

export function mockCampaign(ctx: MockCtx, w: ResolvedWindow): CampaignResponse {
  const now = ctx.now ?? Date.now();
  const r = rooftopFor(ctx.teamId, ctx.nameHint, now, ctx.agents);
  const rows = walk(r, cohortOf(r, w, now), now);
  const removed = r.removed.filter((x) => x.at <= now && inWin(x.at, w, r.tz)).length;
  return {
    view: "rooftop",
    window: windowInfo(w, r.tz),
    definitionVersion: MOCK_DEFINITION_VERSION,
    asOf: asOfBlock(now),
    metrics: { funnel: funnelOf(r, rows, removed, w, now) },
    byCampaign: r.campaigns
      .map((c) => ({ c, mine: rows.filter((x) => x.e.campaignId === c.id) }))
      .filter(({ mine }) => mine.length > 0)
      .sort((a, b) => (a.c.startKey < b.c.startKey ? 1 : -1))
      .map(({ c, mine }) => ({ campaignId: c.id, name: c.name, status: "active", campaignType: c.type, funnel: funnelOf(r, mine, 0, w, now) })),
  };
}

/* ── GET /follow-up (1.5) ───────────────────────────────────────────────────────────────────────── */
const WARM_OUTCOMES = ["Callback Requested", "Customer Considering", "Customer Open To Return", "No Slots Available", "Recall Information Shared", "Transferred To Service Team", "Human Requested"];
/** The lists for the customers enrolled in the window (L1, A8), and the rows of the one asked for. */
export function mockFollowUp(ctx: MockCtx, w: ResolvedWindow, list = "warmLeads", limit = 50): FollowUpResponse {
  const now = ctx.now ?? Date.now();
  const r = rooftopFor(ctx.teamId, ctx.nameHint, now, ctx.agents);
  const camp = new Map(r.campaigns.map((c) => [c.id, c.name]));
  const rows = walk(r, cohortOf(r, w, now), now);
  const outcome = (x: CohortRow) => WARM_OUTCOMES[draw(r, x.e.customerId, "outcome", WARM_OUTCOMES.length)];
  const lists = Object.fromEntries(Object.entries(LIST_META).map(([k, meta]) => [k, { ...meta, value: rows.filter((x) => x.list === k).length }]));
  const connected = rows.filter((x) => x.stage >= 2).length;
  const booked = rows.filter((x) => x.stage === 4).length;
  const listsTotal = Object.values(lists).reduce((n, l) => n + l.value, 0);
  // Warm leads come callbacks first (the doc), then the most recent touch.
  const members = rows
    .filter((x) => x.list === list)
    .sort((a, b) => Number(outcome(b) === "Callback Requested") - Number(outcome(a) === "Callback Requested") || b.e.attemptAt - a.e.attemptAt);
  return {
    view: "rooftop",
    window: windowInfo(w, r.tz),
    asOf: asOfBlock(now),
    metrics: {
      connected: metric(connected),
      booked: metric(booked),
      callbackRequested: metric(rows.filter((x) => x.list === "warmLeads" && outcome(x) === "Callback Requested").length),
      lists,
      optedOutBeforeConnecting: metric(rows.filter((x) => x.stage === 1 && x.reason === D2.optOutKeyword).length),
    },
    addsUp: { connectedMinusBooked: connected - booked, listsTotal, ok: connected - booked === listsTotal },
    customers: {
      list,
      items: members.slice(0, limit).map((x) => ({ customerName: r.names.get(x.e.customerId) ?? "Customer", phone: null, outcome: outcome(x), campaignName: camp.get(x.e.campaignId) ?? null, touchedAt: new Date(x.e.attemptAt).toISOString() })),
      total: members.length,
      nextCursor: null,
    },
  };
}

/* ── GET /calls-report (1.6) ────────────────────────────────────────────────────────────────────── */
const OPEN_HOUR = 8;
const CLOSE_HOUR = 18;
const REASONS = ["Schedule Service Appointment", "Reschedule or cancel", "Service status update", "Pricing or estimate", "Recall question"];
export function mockCallsReport(ctx: MockCtx, w: ResolvedWindow): CallsReportResponse {
  const now = ctx.now ?? Date.now();
  const r = rooftopFor(ctx.teamId, ctx.nameHint, now, ctx.agents);
  const calls = r.calls.filter((c) => c.at <= now && inWin(c.at, w, r.tz));
  const answered = calls.filter((c) => draw(r, c.customerId, "missed", 25) !== 0);
  const local = (ms: number) => storeParts(new Date(ms).toISOString(), r.tz);
  const after = (ms: number) => {
    const p = local(ms);
    return !p || p.h24 < OPEN_HOUR || p.h24 >= CLOSE_HOUR;
  };
  const heat = (cells: Array<{ at: number; calls: number; connected: number }>): HeatCell[] => {
    const m = new Map<string, HeatCell>();
    for (const c of cells) {
      const p = local(c.at);
      if (!p) continue;
      const key = `${p.dow}|${p.h24}`;
      const cell = m.get(key) ?? { weekday: p.dow, hour: p.h24, calls: 0, connected: 0 };
      cell.calls += c.calls;
      cell.connected += c.connected;
      m.set(key, cell);
    }
    return [...m.values()].sort((a, b) => a.weekday - b.weekday || a.hour - b.hour);
  };
  const reasonOf = (c: (typeof calls)[number]) => (c.serviceNeed ? REASONS[0] : REASONS[1 + draw(r, c.customerId, "reason", REASONS.length - 1)]);
  const touched = r.enrollments.filter((e) => e.attemptAt <= now && inWin(e.attemptAt, w, r.tz));
  return {
    window: windowInfo(w, r.tz),
    asOf: asOfBlock(now),
    inbound: {
      answered: { ...metric(answered.length), businessHours: answered.filter((c) => !after(c.at)).length, afterHours: answered.filter((c) => after(c.at)).length },
      bookedAfterHours: metric(answered.filter((c) => after(c.at) && c.bookedAt !== undefined && c.bookedAt <= now).length),
      transfers: { ...metric(answered.filter((c) => c.transferred).length), pickedUp: answered.filter((c) => c.transferred && c.transferAssistAt !== undefined).length, notPickedUp: answered.filter((c) => c.transferred && c.transferAssistAt === undefined).length },
      reasons: {
        available: true,
        rows: REASONS.map((reason) => {
          const mine = answered.filter((c) => reasonOf(c) === reason);
          return { reason, calls: mine.length, handledByVini: mine.filter((c) => !c.transferred).length, sentToTeam: mine.filter((c) => c.transferred).length, booked: mine.filter((c) => c.bookedAt !== undefined && c.bookedAt <= now).length };
        }).filter((row) => row.calls > 0),
      },
      heatmap: heat(calls.map((c) => ({ at: c.at, calls: c.calls, connected: draw(r, c.customerId, "missed", 25) !== 0 ? c.calls : 0 }))),
    },
    outbound: {
      heatmap: heat(touched.map((e) => ({ at: e.attemptAt, calls: 1 + draw(r, e.customerId, "dials", 3), connected: e.reached ? 1 : 0 }))),
    },
  };
}

/* ── onboarded agents (names and photos; not Om's API) ──────────────────────────────────────────── */
export function mockAgents(ctx: MockCtx): AgentProfile[] {
  const r = rooftopFor(ctx.teamId, ctx.nameHint, ctx.now ?? Date.now(), ctx.agents);
  return r.agents.map((a) => ({ direction: a.direction, name: a.name, imageUrl: null }));
}

/* Unused by the pages today, kept so a test can prove "not available" reads as a reason, never a 0. */
export const MOCK_NOT_AVAILABLE = notAvailable("Not available in the sample.");
