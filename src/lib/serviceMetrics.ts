/* RETCONVAI-5066. OLD Service reports (Overview, Appointments, Action items), wired to Om Thakare's
 * service-metrics API so a dealer on the OLD console pages (this repo) sees the SAME numbers as the NEW
 * page (spyne-ai-agentic-dev/overview), because both now read the same backend. Sales is untouched — see
 * the flag gate at each page's call site.
 *
 * Behind NEXT_PUBLIC_SERVICE_METRICS_OLD_VIEW ('on' enables). Flag off → this module is never called.
 *
 * ONE HIDE RULE, and it is stricter than "the API returned available:true":
 *
 *   A Service number is only sourced from service-metrics here if the NEW page (ov-prod's
 *   src/components/service-overview/model.ts + service-overview.tsx) ACTUALLY RENDERS that same field,
 *   in the same shape, today. The API's response shape is not the contract — what ov-prod puts on screen
 *   is. (Coordinator correction, 28-Sep: an earlier pass of this file read `leadsReached`,
 *   `realConversations`, `talkTimeMinutes`, `smsSent` and `afterHoursLeads` off the Contact endpoint and
 *   showed them as Overview tiles. Re-reading ov-prod's model.ts: it reads `leadsReached` and `calls`
 *   ONLY as per-agent, per-direction intake rows (never summed into a rooftop total — no tile there ever
 *   shows a combined ib+ob "Leads touched"), and it does not read `realConversations`, `talkTimeMinutes`,
 *   `afterHoursLeads`, `smsSent`, `connectRate` or `optedOut` AT ALL. None of those five old tiles has a
 *   true twin, so the Contact endpoint is never called from here — see NO_TWIN_ON_OLD_OVERVIEW below,
 *   the single place that decision lives; nothing downstream re-decides it per tile.)
 *
 * A field that DOES have a twin can still be under an explicit HOLD (mirrors availability.ts's
 * HOLD_ATTRIBUTION_UNTIL_BACKFILL): the whole Opportunity endpoint stays hidden pending the attribution
 * backfill. `workedBySpyne` was under the same hold until 29-Sep, see HOLD_WORKED_BY_SPYNE.
 *
 * `metricValue()`/`rateNumerator()` are the only places a `{available, value}` row becomes a
 * number-or-null — every caller reads through them, never `metric.value` directly.
 *
 * Client-side fetch (browser → api.spyne.ai), same pattern as the new page's service-metrics-api.ts: the
 * bearer token already lives on each page (spyneToken, host-forwarded from the iframe URL). Never logs
 * the token or dealer PII.
 */

import { useEffect, useState } from "react";
import type { Bucket } from "@/components/reports/data";

/* ── fields with no twin on the OLD Overview, and why — single source of truth ─────────────────────── */
export const NO_TWIN_ON_OLD_OVERVIEW = {
  leadsReached_total: "ov-prod reads leadsReached per-agent/per-direction only; never summed into a rooftop total",
  realConversations: "ov-prod's Service Overview (model.ts) never reads this field",
  talkTimeMinutes: "ov-prod's Service Overview (model.ts) never reads this field",
  smsSent: "ov-prod's Service Overview (model.ts) never reads this field",
  afterHoursLeads: "ov-prod's Service Overview (model.ts) never reads this field",
  connectRate: "ov-prod's Service Overview (model.ts) never reads this field",
  optedOut: "ov-prod's Service Overview (model.ts) never reads this field",
  calls_combined: "ov-prod reads calls only as a per-outbound-agent dial count ('contacted'); never a rooftop calls+sms total",
} as const;
// The Contact endpoint (/service-metrics/contact) is never called anywhere in this file: every one of
// its fields is either in the table above (no twin) or, for `leadsReached`/`calls`, only rendered by
// ov-prod in a shape (per-agent, per-direction, never summed) this app's OLD Overview does not have a
// tile for. Calling it would fetch data nothing here is allowed to show.

export type ServiceMetricsDirection = "inbound" | "outbound";

/** One catalogue row from Om's API. A row that cannot be computed is `value: null` with `available:
 * false` — never a silent zero. */
export interface ServiceMetric {
  available: boolean;
  value: number | null;
  reason?: string;
  coverageFrom?: string;
}

export interface ServiceMetricRate {
  available: boolean;
  value: number | null;
  numerator: number;
  denominator: number;
}

export interface DirectionSplit<T> {
  inbound: T;
  outbound: T;
}

interface ServiceMetricsWindowInfo {
  from: string;
  to: string;
  timezone: string;
}

export interface AppointmentListItem {
  meetingId: string;
  customerName: string | null;
  vehicle: { year?: string; make?: string; model?: string } | null;
  services: string | null;
  scheduledStart: string | null;
}

export interface AppointmentMetricsResponse {
  window: ServiceMetricsWindowInfo;
  metrics: {
    bookedBySpyne: ServiceMetric;
    // RETCONVAI-4802/C4 — held until the attribution backfill lands (Sumit, 26-Sep). Optional: an older
    // response may not send it at all, which must read exactly like `available: false`.
    workedBySpyne?: ServiceMetric;
    bookingRate: DirectionSplit<ServiceMetricRate>;
    // Bookings made by text. Texting is Service Outbound only today (Sumit, 28-Sep), so these belong
    // to the outbound split; the new view does the same (TEXT_BOOKINGS_DIRECTION = 'outbound').
    bookedByText?: ServiceMetric;
  };
  appointments?: { items: AppointmentListItem[]; total: number; nextCursor?: string | null };
}

export interface ActionItemListItem {
  actionItemId: string;
  customerName: string | null;
  whatNeedsDoing: string;
  title?: string | null;
  due: string | null;
  isLate: boolean;
}

export interface ActionItemMetricsResponse {
  window: ServiceMetricsWindowInfo;
  metrics: {
    openNow: ServiceMetric;
    pastSla: ServiceMetric;
    cleared: ServiceMetric;
  };
  actionItems: { items: ActionItemListItem[]; total: number; nextCursor?: string | null };
}

/* Sumit, 29-Sep-2026: Worked by Spyne (AI-assisted appointments) shows on the old Overview too, matching
 * the new design. Was held from 26-Sep pending the attribution backfill (HOLD_ATTRIBUTION_UNTIL_BACKFILL
 * in the new page's availability.ts). The whole Opportunity endpoint is under the same hold on the new page
 * (RETCONVAI-5150 isn't shipped at all yet); this file never calls Opportunity, for the same reason it
 * never calls Contact — see NO_TWIN_ON_OLD_OVERVIEW. */
export const HOLD_WORKED_BY_SPYNE = false;

function coversWindow(coverageFrom: string | undefined, windowFrom: string | undefined | null): boolean {
  if (!coverageFrom || !windowFrom) return true;
  const from = Date.parse(windowFrom);
  const cov = Date.parse(coverageFrom);
  if (Number.isNaN(from) || Number.isNaN(cov)) return true;
  return from >= cov;
}

/** The one place a `ServiceMetric` becomes a number-or-null for the UI. */
export function metricValue(metric: ServiceMetric | undefined | null, windowFrom?: string | null): number | null {
  return metric && metric.available === true && typeof metric.value === "number" && coversWindow(metric.coverageFrom, windowFrom)
    ? metric.value
    : null;
}

export function rateNumerator(rate: ServiceMetricRate | undefined | null): number | null {
  return rate && rate.available && typeof rate.numerator === "number" ? rate.numerator : null;
}

/** A rate's denominator as a count. Unlike the numerator this is read even when `available` is false,
 * because Om marks a rate unavailable exactly when its denominator is 0, and 0 is a real count. */
export function rateDenominator(rate: ServiceMetricRate | undefined | null): number | null {
  return rate && typeof rate.denominator === "number" ? rate.denominator : null;
}

/** `workedBySpyne`, gated through the hold above (never just `metricValue` alone) — the one place that
 * hold is applied, so a caller can never accidentally read it unheld. */
export function workedBySpyneValue(metric: ServiceMetric | undefined | null, windowFrom?: string | null): number | null {
  if (HOLD_WORKED_BY_SPYNE) return null;
  return metricValue(metric, windowFrom);
}

// env → API base URL, same map the rest of this app uses server-side (src/lib/spyne/client.ts) —
// duplicated here (not imported) because this call is client-side and that file is server-only.
function apiBaseForEnv(env?: string | null): string {
  if (env === "uat") return "https://uat-api.spyne.xyz";
  if (env === "stag") return "https://beta-api.spyne.xyz";
  return "https://api.spyne.ai";
}

export interface ServiceMetricsWindowParams {
  window: "today" | "7d" | "30d" | "mtd" | "custom";
  startDate?: string;
  endDate?: string;
  timezone?: string;
}

interface Ctx {
  enterpriseId: string;
  teamId: string;
  spyneToken: string;
  spyneEnv?: string;
}

const CLIENT_TIMEOUT_MS = 25_000;

/* One retry on a 5xx/network failure, then null — a slow or down endpoint must not blank the rest of
 * the report (same contract as the new page's fetchServiceMetric). Never throws. */
async function fetchServiceMetric<T>(ctx: Ctx, path: string, params: Record<string, string | undefined>): Promise<T | null> {
  if (!ctx.enterpriseId || !ctx.teamId || !ctx.spyneToken) return null;
  const base = apiBaseForEnv(ctx.spyneEnv);
  const url = new URL(`${base}/conversation/service-metrics/${path}`);
  const qp: Record<string, string | undefined> = { enterpriseId: ctx.enterpriseId, teamId: ctx.teamId, agentLine: "service", ...params };
  for (const [k, v] of Object.entries(qp)) if (v != null && v !== "") url.searchParams.set(k, v);

  const attempt = async (): Promise<{ ok: true; data: T } | { ok: false; retryable: boolean }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
    try {
      const res = await fetch(url.toString(), {
        headers: { Authorization: ctx.spyneToken.startsWith("Bearer ") ? ctx.spyneToken : `Bearer ${ctx.spyneToken}`, Accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) return { ok: false, retryable: res.status >= 500 };
      const json = await res.json();
      return { ok: true, data: (json?.data ?? json) as T };
    } catch {
      return { ok: false, retryable: true };
    } finally {
      clearTimeout(timer);
    }
  };

  const first = await attempt();
  if (first.ok) return first.data;
  if (!first.retryable) return null;
  const second = await attempt();
  return second.ok ? second.data : null;
}

/* ── param builders — pure, exported so tests can assert the exact query without a network call ─────── */

/** Rooftop-wide (`direction=both`), `listAnchor=upcoming` — matches ov-prod's Overview EXACTLY
 * (service-metrics-api.ts's `fetchAppointmentMetrics`: "the Upcoming card's rows"). Never `both` here;
 * the OLD Overview's "Appointments" card is the same upcoming-only card. */
export function appointmentParamsForOverview(w: ServiceMetricsWindowParams): Record<string, string | undefined> {
  return { direction: "both", listAnchor: "upcoming", limit: "10", window: w.window, startDate: w.startDate, endDate: w.endDate, timezone: w.timezone };
}

/** The Appointments PAGE ("every appointment on the books") wants past + future, so `listAnchor=both` —
 * per the brief, default BOTH, limit up to 50 per page, fully cursor-paginated (see
 * `fetchAppointmentAllPages`) so a rooftop with more than one page's worth still gets the full count. */
export function appointmentParamsForAppointmentsPage(w: ServiceMetricsWindowParams, limit = 50): Record<string, string | undefined> {
  return { direction: "both", listAnchor: "both", limit: String(limit), window: w.window, startDate: w.startDate, endDate: w.endDate, timezone: w.timezone };
}

export function actionItemParams(w: ServiceMetricsWindowParams, limit = 10): Record<string, string | undefined> {
  return { limit: String(limit), sort: "due:asc", window: w.window, startDate: w.startDate, endDate: w.endDate, timezone: w.timezone };
}

function fetchAppointment(ctx: Ctx, params: Record<string, string | undefined>) {
  return fetchServiceMetric<AppointmentMetricsResponse>(ctx, "appointment", params);
}
function fetchActionItem(ctx: Ctx, params: Record<string, string | undefined>) {
  return fetchServiceMetric<ActionItemMetricsResponse>(ctx, "action-item", params);
}

/* Om's list is window-matched on scheduledStart OR createdAt, so a window's response can carry far more
 * rows than fit on one page — the caller has to page until done rather than stop at page 1, or a
 * rooftop with more than one page of appointments undercounts against the new page (ov-prod's
 * api-appointments.ts pages the exact same way, same cap). 100 is a safety ceiling against a runaway
 * backlog, not an expected volume. */
const MAX_LIST_PAGES = 100;

/** Cursor-paginate GET /appointment fully, exactly like ov-prod's `fetchAppointmentMetrics`: the first
 * page's `metrics` block is the rooftop total for the window and does not change page to page, so only
 * `appointments.items` accumulate across pages. A later page failing (network/5xx) is NOT the whole list
 * failing — what loaded so far is returned rather than discarded. A backend bug that echoes the same
 * cursor back forever stops the loop the moment it repeats, rather than spinning to MAX_LIST_PAGES. */
async function fetchAppointmentAllPages(ctx: Ctx, params: Record<string, string | undefined>): Promise<AppointmentMetricsResponse | null> {
  const first = await fetchAppointment(ctx, params);
  if (!first) return null;

  const items = [...(first.appointments?.items ?? [])];
  let cursor = first.appointments?.nextCursor ?? null;
  let pages = 1;
  while (cursor && pages < MAX_LIST_PAGES) {
    const page = await fetchAppointment(ctx, { ...params, cursor });
    if (!page) break; // a later page failing is not the whole list failing — keep what loaded
    items.push(...(page.appointments?.items ?? []));
    const nextCursor = page.appointments?.nextCursor ?? null;
    if (nextCursor && nextCursor === cursor) break; // guard against a backend bug echoing the same cursor
    cursor = nextCursor;
    pages += 1;
  }

  return { ...first, appointments: first.appointments ? { ...first.appointments, items } : undefined };
}

/* Action Items PAGE ceiling — separate from MAX_LIST_PAGES's per-request page cap. The API rejects
 * `limit` above 50 (400 "limit must not be greater than 50"), so this page has to cursor-paginate at
 * limit=50 just to stay under that ceiling, then stop accumulating once it has enough rows to keep the
 * page light — 200 is the same "full count without an unbounded fetch" cap the appointments list uses,
 * just expressed as a row count instead of a page count. */
const MAX_ACTION_ITEM_ROWS = 200;

/** Cursor-paginate GET /action-item at the API's real limit (50), same pattern as
 * `fetchAppointmentAllPages`: the first page's `metrics` block is the window total and does not change
 * page to page, only `actionItems.items` accumulate. Stops once `MAX_ACTION_ITEM_ROWS` rows are loaded, on
 * a repeated cursor (backend bug guard), or on `MAX_LIST_PAGES`. A later page failing keeps whatever
 * loaded so far rather than discarding it. */
async function fetchActionItemAllPages(ctx: Ctx, params: Record<string, string | undefined>): Promise<ActionItemMetricsResponse | null> {
  const first = await fetchActionItem(ctx, params);
  if (!first) return null;

  const items = [...(first.actionItems?.items ?? [])];
  let cursor = first.actionItems?.nextCursor ?? null;
  let pages = 1;
  while (cursor && pages < MAX_LIST_PAGES && items.length < MAX_ACTION_ITEM_ROWS) {
    const page = await fetchActionItem(ctx, { ...params, cursor });
    if (!page) break; // a later page failing is not the whole list failing — keep what loaded
    items.push(...(page.actionItems?.items ?? []));
    const nextCursor = page.actionItems?.nextCursor ?? null;
    if (nextCursor && nextCursor === cursor) break; // guard against a backend bug echoing the same cursor
    cursor = nextCursor;
    pages += 1;
  }

  const capped = items.slice(0, MAX_ACTION_ITEM_ROWS);
  return {
    ...first,
    actionItems: first.actionItems ? { ...first.actionItems, items: capped } : { items: capped, total: capped.length },
  };
}

/* ── mapping helpers, shared by every page ─────────────────────────────────────────────────────────── */

function mapAppointmentItems(appt: AppointmentMetricsResponse | null): Array<{ customer: string; vehicle?: string; when: string | null }> {
  return (appt?.appointments?.items ?? []).map((it) => ({
    customer: it.customerName || "Customer",
    vehicle: it.vehicle ? [it.vehicle.year, it.vehicle.make, it.vehicle.model].filter(Boolean).join(" ") || undefined : undefined,
    when: it.scheduledStart,
  }));
}

function mapActionItemItems(ai: ActionItemMetricsResponse | null): Array<{ customer: string; what: string; due: string | null; isLate: boolean }> {
  return (ai?.actionItems?.items ?? []).map((it) => ({
    customer: it.customerName || "Customer",
    what: it.title || it.whatNeedsDoing,
    due: it.due,
    isLate: it.isLate,
  }));
}

/* ── OVERVIEW ──────────────────────────────────────────────────────────────────────────────────────── */

// Every field here has a real twin on ov-prod today. Nothing about Contact (leads, conversations,
// calls & texts, talk time, after-hours) belongs on this type — see NO_TWIN_ON_OLD_OVERVIEW.
export interface ServiceOverviewOverlay {
  loading: boolean;
  appointments: { total: number; inbound: number | null; outbound: number | null; assisted: number | null } | null;
  namedAppointments: Array<{ customer: string; vehicle?: string; when: string | null }> | null;
  // openNow for the hero tile's own count, plus pastSla so the Overview's Action Items table can badge
  // its "Past SLA" tab with the real metric instead of a sampled-row count (coordinator correction,
  // 28-Sep: the new page's dueBandHeadlineCount reads the live `pastSla` metric for its Overdue band
  // header, never a client row count — vini-action-items-queue.tsx ~547-556 — so this overlay carries the
  // same field through). `pastSla` is `null` when the metric is unavailable or stale — never a guess.
  actionItems: { openNow: number; pastSla: number | null; items: Array<{ customer: string; what: string; due: string | null; isLate: boolean }> } | null;
}

const OVERVIEW_EMPTY: ServiceOverviewOverlay = { loading: false, appointments: null, namedAppointments: null, actionItems: null };

export async function loadServiceOverviewOverlay(ctx: Ctx, w: ServiceMetricsWindowParams): Promise<ServiceOverviewOverlay> {
  const [appt, ai] = await Promise.all([
    fetchAppointment(ctx, appointmentParamsForOverview(w)),
    fetchActionItem(ctx, actionItemParams(w)),
  ]);
  const windowFrom = appt?.window.from ?? ai?.window.from ?? null;

  const booked = metricValue(appt?.metrics.bookedBySpyne, windowFrom);
  const worked = workedBySpyneValue(appt?.metrics.workedBySpyne, windowFrom);
  const bookInbound = rateNumerator(appt?.metrics.bookingRate.inbound);
  // Outbound = outbound call bookings + text bookings, so inbound + outbound adds up to the headline
  // (Honda DTLA 30d, 28-Sep: 88 = 87 inbound + 1 by text, which read "0 outbound" before). A text
  // booking still counts when the outbound call rate is unavailable (no outbound calls).
  const outboundCalls = rateNumerator(appt?.metrics.bookingRate.outbound);
  const bookedText = metricValue(appt?.metrics.bookedByText, windowFrom);
  const bookOutbound = outboundCalls === null && (bookedText ?? 0) === 0 ? outboundCalls : (outboundCalls ?? 0) + (bookedText ?? 0);
  const openNow = metricValue(ai?.metrics.openNow, windowFrom);
  const pastSla = metricValue(ai?.metrics.pastSla, windowFrom);

  return {
    loading: false,
    appointments: booked !== null ? { total: booked, inbound: bookInbound, outbound: bookOutbound, assisted: worked } : null,
    namedAppointments: (appt?.appointments?.items?.length ?? 0) > 0 ? mapAppointmentItems(appt) : null,
    actionItems: openNow !== null ? { openNow, pastSla, items: mapActionItemItems(ai) } : null,
  };
}

/** Pure — extracted for testability (checker fix, 28-Sep, /reports/agents ~246). A page can be opened
 * with a top-level `dept` of "all" (unlike Overview, which is host-locked to one department) while the
 * AGENT actually shown/selected is Service — that combination must still gate, because the numbers on
 * screen are Service data regardless of what the page-level dept scope says. Shared here rather than
 * inlined per call site so every page uses the identical rule. */
export function shouldUseServiceMetrics(params: { flagOn: boolean; deptIsService: boolean; agentIsService: boolean; hasTeam: boolean }): boolean {
  return params.flagOn && (params.deptIsService || params.agentIsService) && params.hasTeam;
}

/* Map this app's Bucket (+ optional custom range) onto the service-metrics API's own window vocabulary
 * (today | 7d | 30d | mtd | custom). A bucket the API has no exact preset for (yesterday, last14,
 * lifetime) goes as an explicit custom start/end instead of approximating to the nearest preset — same
 * principle as the new page sending QTD as explicit dates because the API has no quarter preset. */
export function serviceMetricsWindowFor(bucket: Bucket, custom: { start: string; end: string } | null, rangeStart?: string, rangeEndExclusive?: string, timezone?: string): ServiceMetricsWindowParams {
  if (custom) return { window: "custom", startDate: custom.start, endDate: custom.end, timezone };
  switch (bucket) {
    case "today": return { window: "today", timezone };
    case "last7": return { window: "7d", timezone };
    case "last30": return { window: "30d", timezone };
    case "mtd": return { window: "mtd", timezone };
    default:
      // yesterday / last14 / lifetime — no matching preset; fall back to the resolved [start, end) window
      // this page already computed (rangeFor()), sent as explicit dates.
      // The API's custom endDate is INCLUSIVE (window.util.ts endOf('day')), rangeFor()'s end is exclusive.
      // Sending it as is made "Yesterday" count yesterday + today (overnight audit, 30-Sep).
      return { window: "custom", startDate: rangeStart, endDate: rangeEndExclusive ? inclusiveEnd(rangeEndExclusive) : rangeEndExclusive, timezone };
  }
}

/** "2026-09-30" (exclusive) -> "2026-09-29" (inclusive). */
export function inclusiveEnd(exclusiveIso: string): string {
  const d = new Date(`${exclusiveIso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

interface OverlayHookParams {
  enabled: boolean;
  enterpriseId: string;
  teamId: string;
  spyneToken: string;
  spyneEnv?: string;
  bucket: Bucket;
  custom: { start: string; end: string } | null;
  rangeStart?: string;
  rangeEndExclusive?: string;
  timezone?: string;
}

/** Generic "fetch whenever the scope/window changes" state machine, shared by all three hooks below.
 * `loading` is derived by comparing the request signature to the signature of the last RESOLVED fetch,
 * so nothing calls setState synchronously inside the effect body (only the async `.then`/`.catch` do —
 * the pattern this repo's react-hooks/set-state-in-effect lint rule requires). */
function useOverlay<T>(params: OverlayHookParams, empty: T, load: (ctx: Ctx, w: ServiceMetricsWindowParams) => Promise<T>): T & { loading: boolean } {
  const { enabled, enterpriseId, teamId, spyneToken, spyneEnv, bucket, custom, rangeStart, rangeEndExclusive, timezone } = params;
  const canFetch = enabled && !!teamId && !!enterpriseId && !!spyneToken;
  const key = canFetch ? JSON.stringify([enterpriseId, teamId, spyneEnv ?? "", bucket, custom, rangeStart ?? "", rangeEndExclusive ?? "", timezone ?? ""]) : "";
  const [state, setState] = useState<{ key: string; data: T }>({ key: "", data: empty });

  useEffect(() => {
    if (!canFetch) return;
    let on = true;
    const w = serviceMetricsWindowFor(bucket, custom, rangeStart, rangeEndExclusive, timezone);
    load({ enterpriseId, teamId, spyneToken, spyneEnv }, w)
      .then((res) => { if (on) setState({ key, data: res }); })
      .catch(() => { if (on) setState({ key, data: empty }); });
    return () => { on = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canFetch, key, enterpriseId, teamId, spyneToken, spyneEnv, bucket, custom, rangeStart, rangeEndExclusive, timezone]);

  if (!canFetch) return { ...empty, loading: false };
  return { ...state.data, loading: state.key !== key };
}

/** Fetches the Overview overlay whenever `enabled` and the scope/window change. Disabled (Sales, the
 * flag off, or scope not resolved yet) always returns the empty shape and fetches nothing. */
export function useServiceOverviewOverlay(params: OverlayHookParams): ServiceOverviewOverlay {
  return useOverlay(params, OVERVIEW_EMPTY, loadServiceOverviewOverlay);
}

/* ── APPOINTMENTS PAGE ─────────────────────────────────────────────────────────────────────────────── */

export interface ServiceAppointmentsPageOverlay {
  loading: boolean;
  bookedBySpyne: number | null; // no twin for "AI-assisted (CRM)" (held) or "Close rate" (Classification) — hide those tiles
  items: Array<{ customer: string; vehicle?: string; when: string | null }> | null;
}

const APPOINTMENTS_PAGE_EMPTY: ServiceAppointmentsPageOverlay = { loading: false, bookedBySpyne: null, items: null };

export async function loadServiceAppointmentsPageOverlay(ctx: Ctx, w: ServiceMetricsWindowParams): Promise<ServiceAppointmentsPageOverlay> {
  const appt = await fetchAppointmentAllPages(ctx, appointmentParamsForAppointmentsPage(w));
  const windowFrom = appt?.window.from ?? null;
  return {
    loading: false,
    bookedBySpyne: metricValue(appt?.metrics.bookedBySpyne, windowFrom),
    items: (appt?.appointments?.items?.length ?? 0) > 0 ? mapAppointmentItems(appt) : null,
  };
}

export function useServiceAppointmentsPageOverlay(params: OverlayHookParams): ServiceAppointmentsPageOverlay {
  return useOverlay(params, APPOINTMENTS_PAGE_EMPTY, loadServiceAppointmentsPageOverlay);
}

/* ── ACTION ITEMS PAGE ─────────────────────────────────────────────────────────────────────────────── */

export interface ServiceActionItemsPageOverlay {
  loading: boolean;
  // No `created` — Om's endpoint has no such field (only openNow/pastSla/cleared), so the "Created"
  // scoreboard stat and tab this app shows for Sales has no Service twin and is dropped entirely.
  openNow: number | null;
  cleared: number | null;
  // Correction, 28-Sep: the earlier comment here ("never read metrics.pastSla, derive from isLate rows")
  // was wrong. ov-prod's own Overdue band (vini-action-items-queue.tsx's `dueBandHeadlineCount`,
  // ~547-556) reads the live `pastSla` metric for its headline count and shows nothing (never a row
  // count) when that metric isn't live — it does NOT derive the count from loaded rows. This scoreboard
  // stat matches that: the real metric via `metricValue`, `null` (never a guess) when unavailable. The
  // rows listed under the "Past SLA" tab stay a client-side `isLate` sample regardless — see
  // buildServiceActionItemsTabs in liveReplica.tsx.
  pastSla: number | null;
  items: Array<{ customer: string; what: string; due: string | null; isLate: boolean }> | null;
}

const ACTION_ITEMS_PAGE_EMPTY: ServiceActionItemsPageOverlay = { loading: false, openNow: null, cleared: null, pastSla: null, items: null };

export async function loadServiceActionItemsPageOverlay(ctx: Ctx, w: ServiceMetricsWindowParams): Promise<ServiceActionItemsPageOverlay> {
  // limit=50 — the API 400s above that ("limit must not be greater than 50") — cursor-paginated up to
  // MAX_ACTION_ITEM_ROWS so the page still gets the full count without an unbounded fetch.
  const ai = await fetchActionItemAllPages(ctx, actionItemParams(w, 50));
  const windowFrom = ai?.window.from ?? null;
  const items = (ai?.actionItems?.items?.length ?? 0) > 0 ? mapActionItemItems(ai) : null;
  return {
    loading: false,
    openNow: metricValue(ai?.metrics.openNow, windowFrom),
    cleared: metricValue(ai?.metrics.cleared, windowFrom),
    pastSla: metricValue(ai?.metrics.pastSla, windowFrom),
    items,
  };
}

export function useServiceActionItemsPageOverlay(params: OverlayHookParams): ServiceActionItemsPageOverlay {
  return useOverlay(params, ACTION_ITEMS_PAGE_EMPTY, loadServiceActionItemsPageOverlay);
}

/* ── REPORTS > AGENTS, SERVICE (29-Sep) ────────────────────────────────────────────────────────────
 * Sumit, 29-Sep: every Service number reads Om's API, old page or new, so Reports matches Overview.
 * The full report stays (library, downloads, every card). Only the Service agents' headline numbers
 * are replaced, at the AgentData the page and its exports both read, so screen and download agree.
 * Two decisions, Sumit 29-Sep: "Qualified leads" becomes "Wanted service" (contact.neededService),
 * and direction is Om's rule, the direction of the call that booked. */

interface ContactMetricsResponse {
  window: ServiceMetricsWindowInfo;
  metrics: {
    calls?: ServiceMetric;
    smsSent?: ServiceMetric;
    talkTimeMinutes?: ServiceMetric;
    leadsReached?: ServiceMetric;
    realConversations?: ServiceMetric;
    neededService?: DirectionSplit<ServiceMetric>;
    // Om, 29-Sep: real conversations over conversations reached (calls connected + SMS threads
    // replied), per direction. Same unit on both sides, so it never goes over 100%.
    engagementRate?: DirectionSplit<ServiceMetricRate>;
  };
}

export interface ServiceAgentNumbers {
  reached: number | null; // distinct customers (phone-deduped), not conversations
  conversationsReached: number | null; // the funnel's entry: engagementRate's denominator
  conversations: number | null;
  wantedService: number | null;
  calls: number | null;
  smsSent: number | null;
  talkMinutes: number | null;
  booked: number | null;
}

export interface ServiceAgentsOverlay {
  loading: boolean;
  inbound: ServiceAgentNumbers | null;
  outbound: ServiceAgentNumbers | null;
}

const AGENTS_EMPTY: ServiceAgentsOverlay = { loading: false, inbound: null, outbound: null };

function windowParams(w: ServiceMetricsWindowParams): Record<string, string | undefined> {
  return { window: w.window, startDate: w.startDate, endDate: w.endDate, timezone: w.timezone };
}

function contactNumbers(c: ContactMetricsResponse | null, dir: ServiceMetricsDirection, booked: number | null): ServiceAgentNumbers | null {
  if (!c) return null;
  const from = c.window?.from ?? null;
  return {
    reached: metricValue(c.metrics.leadsReached, from),
    conversationsReached: rateDenominator(c.metrics.engagementRate?.[dir]),
    conversations: metricValue(c.metrics.realConversations, from),
    wantedService: metricValue(c.metrics.neededService?.[dir], from),
    calls: metricValue(c.metrics.calls, from),
    smsSent: metricValue(c.metrics.smsSent, from),
    talkMinutes: metricValue(c.metrics.talkTimeMinutes, from),
    booked,
  };
}

export async function loadServiceAgentsOverlay(ctx: Ctx, w: ServiceMetricsWindowParams): Promise<ServiceAgentsOverlay> {
  const [cin, cout, appt] = await Promise.all([
    fetchServiceMetric<ContactMetricsResponse>(ctx, "contact", { ...windowParams(w), direction: "inbound" }),
    fetchServiceMetric<ContactMetricsResponse>(ctx, "contact", { ...windowParams(w), direction: "outbound" }),
    fetchAppointment(ctx, { ...windowParams(w), direction: "both", limit: "1" }),
  ]);
  // Same split as the Overview hero: inbound = inbound call bookings; outbound = outbound call
  // bookings + text bookings (texting is Service Outbound only today).
  const windowFrom = appt?.window.from ?? null;
  const bookInbound = rateNumerator(appt?.metrics.bookingRate?.inbound);
  const outboundCalls = rateNumerator(appt?.metrics.bookingRate?.outbound);
  const bookedText = metricValue(appt?.metrics.bookedByText, windowFrom);
  const bookOutbound = outboundCalls === null && (bookedText ?? 0) === 0 ? outboundCalls : (outboundCalls ?? 0) + (bookedText ?? 0);
  return {
    loading: false,
    inbound: contactNumbers(cin, "inbound", bookInbound),
    outbound: contactNumbers(cout, "outbound", bookOutbound),
  };
}

export function useServiceAgentsOverlay(params: OverlayHookParams): ServiceAgentsOverlay {
  return useOverlay(params, AGENTS_EMPTY, loadServiceAgentsOverlay);
}
