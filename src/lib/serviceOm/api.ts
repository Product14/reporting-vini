import type { ActionItemResponse, AppointmentList, AppointmentListQuery, AppointmentResponse, AppointmentRow, CallsReportResponse, CampaignResponse, ContactResponse, FollowUpResponse, WindowParams } from "./contract";

/* The REAL source: Om's Service Metrics API v2 (Confluence 1193934864), called from the browser with the
 * console session token the console forwards on the iframe URL (`auth_key`), as `Authorization: Bearer`.
 * Kept apart from serviceMetrics.ts on purpose: the old pages import that file.
 *
 * Every call a page makes carries the same window, timezone and agentLine (the doc's rule 2).
 * Never throws: a failed call is null, and the model turns null into "not available", never 0 (rule 1). */

export interface ApiCtx {
  enterpriseId: string;
  teamId: string;
  spyneToken: string;
  spyneEnv?: string;
}

const TIMEOUT_MS = 25_000;

/* A cap on requests in flight against Om's API, for the all-rooftops check: SERVICE_OM_MAX_REQUESTS (read
 * by scripts only; it is never in the browser bundle, so the pages' own few calls run uncapped as before).
 * A finished request hands its slot straight to the next waiter, so the cap is never exceeded. */
const MAX_IN_FLIGHT = Number(process.env.SERVICE_OM_MAX_REQUESTS ?? 0);
let inFlight = 0;
const waiting: Array<() => void> = [];
async function inSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (!MAX_IN_FLIGHT) return fn();
  if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((r) => waiting.push(r));
  else inFlight++;
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else inFlight--;
  }
}
/** Requests in flight right now and the most there have been, so a run can prove it kept to the cap. */
export const requestStats = { peak: 0, total: 0 };

function apiBaseForEnv(env?: string | null): string {
  if (env === "uat") return "https://uat-api.spyne.xyz";
  if (env === "stag") return "https://beta-api.spyne.xyz";
  return "https://api.spyne.ai";
}

function windowQuery(w: WindowParams): Record<string, string | undefined> {
  return { window: w.window, startDate: w.startDate, endDate: w.endDate, timezone: w.timezone };
}

/** One retry on a 5xx or network failure, then null. */
async function getMetric<T>(ctx: ApiCtx, path: string, params: Record<string, string | undefined>): Promise<T | null> {
  if (!ctx.enterpriseId || !ctx.teamId || !ctx.spyneToken) return null;
  const url = new URL(`${apiBaseForEnv(ctx.spyneEnv)}/conversation/service-metrics/${path}`);
  const qp: Record<string, string | undefined> = { enterpriseId: ctx.enterpriseId, teamId: ctx.teamId, agentLine: "service", ...params };
  for (const [k, v] of Object.entries(qp)) if (v != null && v !== "") url.searchParams.set(k, v);
  const auth = ctx.spyneToken.startsWith("Bearer ") ? ctx.spyneToken : `Bearer ${ctx.spyneToken}`;

  const attempt = (): Promise<{ ok: true; data: T } | { ok: false; retryable: boolean }> => inSlot(async () => {
    requestStats.total++;
    requestStats.peak = Math.max(requestStats.peak, MAX_IN_FLIGHT ? inFlight : 0);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url.toString(), { headers: { Authorization: auth, Accept: "application/json" }, signal: controller.signal });
      if (!res.ok) return { ok: false, retryable: res.status >= 500 };
      const json = await res.json();
      return { ok: true, data: (json?.data ?? json) as T };
    } catch {
      return { ok: false, retryable: true };
    } finally {
      clearTimeout(timer);
    }
  });
  const first = await attempt();
  if (first.ok) return first.data;
  if (!first.retryable) return null;
  const second = await attempt();
  return second.ok ? second.data : null;
}

/* ── the endpoints (sections 1.1–1.6 of the doc) ── */

/** 1.1 Bookings, Spyne-assisted, status, visits, byDirection (Carl / Emily / unplaced), upcoming count.
 * limit=1: the response always carries a list too (listAnchor defaults to both), and the page doesn't read
 * it here, so ask for the smallest one (the live Overview does the same). */
export function apiAppointments(ctx: ApiCtx, w: WindowParams): Promise<AppointmentResponse | null> {
  return getMetric<AppointmentResponse>(ctx, "appointment", { ...windowQuery(w), limit: "1" });
}

/** 1.1 The upcoming list, soonest first: each row tagged Booked by Spyne, Assisted or BDC. */
export function apiUpcoming(ctx: ApiCtx, w: WindowParams, limit = 10): Promise<AppointmentResponse | null> {
  return getMetric<AppointmentResponse>(ctx, "appointment", { ...windowQuery(w), listAnchor: "upcoming", listOnly: "true", limit: String(limit) });
}

/** 1.3 Open / past SLA / due today / callbacks waiting, and the open rows (`due=open`). */
export function apiActionItems(ctx: ApiCtx, w: WindowParams, limit = 10): Promise<ActionItemResponse | null> {
  return getMetric<ActionItemResponse>(ctx, "action-item", { ...windowQuery(w), due: "open", limit: String(limit) });
}

/** 1.7 One agent's bookings per day (grain=day, direction): the 7-day trend. Its days add up to its own totals. */
export function apiAppointmentTrend(ctx: ApiCtx, w: WindowParams, direction: "inbound" | "outbound"): Promise<AppointmentResponse | null> {
  return getMetric<AppointmentResponse>(ctx, "appointment", { ...windowQuery(w), grain: "day", direction, limit: "1" });
}

/** 1.4 The rooftop's outbound funnel (every campaign in the window) plus one row per campaign. */
export function apiCampaign(ctx: ApiCtx, w: WindowParams): Promise<CampaignResponse | null> {
  return getMetric<CampaignResponse>(ctx, "campaign", windowQuery(w));
}

/** 1.2 Calls, SMS, staff time saved, reached / called / needed service per direction. Today's per-direction
 * fields (calls, smsSent, optedOut, connectRate) follow the `direction` asked for. */
export function apiContact(ctx: ApiCtx, w: WindowParams, direction: "inbound" | "outbound"): Promise<ContactResponse | null> {
  return getMetric<ContactResponse>(ctx, "contact", { ...windowQuery(w), direction, limit: "1" });
}

/** 1.5 The follow-up lists, callbacks asked for, and the warm leads' rows (callbacks first). */
export function apiFollowUp(ctx: ApiCtx, w: WindowParams, list = "warmLeads", limit = 50): Promise<FollowUpResponse | null> {
  return getMetric<FollowUpResponse>(ctx, "follow-up", { ...windowQuery(w), list, limit: String(limit) });
}

/** 1.6 Inbound calls answered (business hours / after hours), transfers, reasons, and both heatmaps. */
export function apiCallsReport(ctx: ApiCtx, w: WindowParams): Promise<CallsReportResponse | null> {
  return getMetric<CallsReportResponse>(ctx, "calls-report", windowQuery(w));
}

const MAX_LIST_PAGES = 40; // a safety ceiling against a runaway cursor, not an expected size

/** Cursor-pages a list to the end, so the rows always match the number (rule 8). A later page failing keeps
 * what loaded; a cursor echoed back stops the loop. */
async function allRows(page: (cursor?: string) => Promise<{ items: AppointmentRow[]; total: number; nextCursor?: string | null } | null | undefined>): Promise<AppointmentList | null> {
  const first = await page();
  if (!first) return null;
  const items = [...first.items];
  let cursor = first.nextCursor ?? null;
  for (let n = 1; cursor && n < MAX_LIST_PAGES; n++) {
    const next = await page(cursor);
    if (!next) break;
    items.push(...next.items);
    if (next.nextCursor && next.nextCursor === cursor) break;
    cursor = next.nextCursor ?? null;
  }
  return { items, total: first.total };
}

/** The appointments behind a number: one agent's bookings in the window (listAnchor=created, the same rule as
 * Booked by Spyne), of the types it counted. `direction` filters server-side with the same rule as
 * byDirection (Om's code: a booking by its own call or text, an assisted one by its handoff's channel), so the
 * rows' own `direction` isn't re-checked: it is null on assisted rows by design. With two types and no `tag`,
 * the rows' tag keeps out the BDC's own bookings. `worked_by_spyne` is the older name for assisted. */
export async function apiAppointmentList(ctx: ApiCtx, w: WindowParams, q: AppointmentListQuery): Promise<AppointmentList | null> {
  const tag = q.types.length === 1 ? q.types[0] : undefined;
  const list = await allRows(async (cursor) => (await getMetric<AppointmentResponse>(ctx, "appointment", { ...windowQuery(w), listAnchor: "created", listOnly: "true", direction: q.direction, tag, limit: "50", cursor }))?.appointments);
  if (!list) return null;
  const tagOf = (t: string | null | undefined) => (t === "worked_by_spyne" ? "spyne_assisted" : t);
  const items = list.items.filter((it) => !it.tag || (q.types as string[]).includes(tagOf(it.tag) ?? ""));
  return { items, total: items.length };
}
