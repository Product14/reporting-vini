/* RETCONVAI-5066. Old Service Overview, wired to Om Thakare's service-metrics API so a dealer on the
 * OLD console page (this repo) sees the SAME numbers as the NEW page (spyne-ai-agentic-dev/overview),
 * because both now read the same backend. Sales is untouched — see the flag gate in OverviewView.tsx.
 *
 * Behind NEXT_PUBLIC_SERVICE_METRICS_OLD_VIEW ('on' enables). Flag off → this module is never called.
 *
 * ONE HIDE RULE (mirrors the new page's data-layer rule, availability.ts): a number with no trustworthy
 * source HIDES. Never a 0, never "—", never "Coming soon" in its place. `metricValue()`/`rateNumerator()`
 * below are the only places that turn the API's `{available, value}` contract into "show or hide" — every
 * caller reads through them, never `metric.value` directly.
 *
 * Client-side fetch (browser → api.spyne.ai), same pattern as the new page's service-metrics-api.ts: the
 * bearer token already lives on this page (spyneToken, host-forwarded from the iframe URL), so there is
 * no need to round-trip through this app's own Next.js API routes. Never logs the token or dealer PII.
 */

import { useEffect, useState } from "react";
import type { Bucket } from "@/components/reports/data";

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

interface ContactMetricsResponse {
  window: ServiceMetricsWindowInfo;
  metrics: {
    calls: ServiceMetric;
    smsSent: ServiceMetric;
    talkTimeMinutes: ServiceMetric;
    afterHoursLeads: ServiceMetric;
    leadsReached: ServiceMetric;
    realConversations: ServiceMetric;
  };
}

interface AppointmentListItem {
  meetingId: string;
  customerName: string | null;
  vehicle: { year?: string; make?: string; model?: string } | null;
  services: string | null;
  scheduledStart: string | null;
}

interface AppointmentMetricsResponse {
  window: ServiceMetricsWindowInfo;
  metrics: {
    bookedBySpyne: ServiceMetric;
    // RETCONVAI-4802/C4 — held until the attribution backfill lands (Sumit, 26-Sep). Optional: an older
    // response may not send it at all, which must read exactly like `available: false`.
    workedBySpyne?: ServiceMetric;
    bookingRate: DirectionSplit<ServiceMetricRate>;
  };
  appointments?: { items: AppointmentListItem[]; total: number };
}

interface ActionItemListItem {
  actionItemId: string;
  customerName: string | null;
  whatNeedsDoing: string;
  title?: string | null;
  due: string | null;
  isLate: boolean;
}

interface ActionItemMetricsResponse {
  window: ServiceMetricsWindowInfo;
  metrics: {
    openNow: ServiceMetric;
    cleared: ServiceMetric;
  };
  actionItems: { items: ActionItemListItem[]; total: number };
}

/* Sumit, 26-Sep-2026: Worked by Spyne stays hidden until the attribution backfill (planned Monday).
 * Mirrors HOLD_ATTRIBUTION_UNTIL_BACKFILL in the new page's availability.ts — flip both together. */
const HOLD_WORKED_BY_SPYNE = true;

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

function fetchContact(ctx: Ctx, w: ServiceMetricsWindowParams, direction: ServiceMetricsDirection) {
  return fetchServiceMetric<ContactMetricsResponse>(ctx, "contact", { direction, window: w.window, startDate: w.startDate, endDate: w.endDate, timezone: w.timezone });
}
function fetchAppointment(ctx: Ctx, w: ServiceMetricsWindowParams) {
  return fetchServiceMetric<AppointmentMetricsResponse>(ctx, "appointment", { direction: "both", listAnchor: "both", limit: "10", window: w.window, startDate: w.startDate, endDate: w.endDate, timezone: w.timezone });
}
function fetchActionItem(ctx: Ctx, w: ServiceMetricsWindowParams) {
  return fetchServiceMetric<ActionItemMetricsResponse>(ctx, "action-item", { limit: "10", sort: "due:asc", window: w.window, startDate: w.startDate, endDate: w.endDate, timezone: w.timezone });
}

// ── Overlay shape the Overview reads. Every field is null when there is no trustworthy twin on the
// new page (or the fetch failed) — callers must treat null as "hide this tile/card", never as 0.
export interface ServiceMetricsOverlay {
  loading: boolean;
  leads: { total: number; inbound: number | null; outbound: number | null } | null;
  conversations: { total: number; inbound: number | null; outbound: number | null } | null;
  appointments: { total: number; inbound: number | null; outbound: number | null; assisted: number | null } | null;
  callsTexts: { calls: number; sms: number } | null;
  talkMinutes: number | null;
  afterHours: number | null;
  namedAppointments: Array<{ customer: string; vehicle?: string; when: string | null }> | null;
  actionItems: { openNow: number; cleared: number; items: Array<{ customer: string; what: string; due: string | null; isLate: boolean }> } | null;
}

const EMPTY: ServiceMetricsOverlay = {
  loading: false,
  leads: null,
  conversations: null,
  appointments: null,
  callsTexts: null,
  talkMinutes: null,
  afterHours: null,
  namedAppointments: null,
  actionItems: null,
};

/** Fetch the four service-metrics reads and shape them into the Overview's overlay. Never throws —
 * a failed/partial fetch resolves with the fields it could not back left `null` (hidden). */
export async function loadServiceMetricsOverlay(ctx: Ctx, w: ServiceMetricsWindowParams): Promise<ServiceMetricsOverlay> {
  const [ib, ob, appt, ai] = await Promise.all([
    fetchContact(ctx, w, "inbound"),
    fetchContact(ctx, w, "outbound"),
    fetchAppointment(ctx, w),
    fetchActionItem(ctx, w),
  ]);

  const windowFrom = ib?.window.from ?? ob?.window.from ?? appt?.window.from ?? null;

  const sumOrNull = (a: number | null, b: number | null): number | null => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));

  const ibLeads = metricValue(ib?.metrics.leadsReached, windowFrom);
  const obLeads = metricValue(ob?.metrics.leadsReached, windowFrom);
  const leadsTotal = sumOrNull(ibLeads, obLeads);

  const ibConv = metricValue(ib?.metrics.realConversations, windowFrom);
  const obConv = metricValue(ob?.metrics.realConversations, windowFrom);
  const convTotal = sumOrNull(ibConv, obConv);

  const booked = metricValue(appt?.metrics.bookedBySpyne, windowFrom);
  const workedRaw = HOLD_WORKED_BY_SPYNE ? null : metricValue(appt?.metrics.workedBySpyne, windowFrom);
  const bookInbound = rateNumerator(appt?.metrics.bookingRate.inbound);
  const bookOutbound = rateNumerator(appt?.metrics.bookingRate.outbound);

  const ibCalls = metricValue(ib?.metrics.calls, windowFrom);
  const obCalls = metricValue(ob?.metrics.calls, windowFrom);
  const callsTotal = sumOrNull(ibCalls, obCalls);
  const ibSms = metricValue(ib?.metrics.smsSent, windowFrom);
  const obSms = metricValue(ob?.metrics.smsSent, windowFrom);
  const smsTotal = sumOrNull(ibSms, obSms);

  const ibTalk = metricValue(ib?.metrics.talkTimeMinutes, windowFrom);
  const obTalk = metricValue(ob?.metrics.talkTimeMinutes, windowFrom);
  const talkTotal = sumOrNull(ibTalk, obTalk);

  const ibAfter = metricValue(ib?.metrics.afterHoursLeads, windowFrom);
  const obAfter = metricValue(ob?.metrics.afterHoursLeads, windowFrom);
  const afterTotal = sumOrNull(ibAfter, obAfter);

  const openNow = metricValue(ai?.metrics.openNow, windowFrom);
  const cleared = metricValue(ai?.metrics.cleared, windowFrom);

  return {
    loading: false,
    leads: leadsTotal !== null ? { total: leadsTotal, inbound: ibLeads, outbound: obLeads } : null,
    conversations: convTotal !== null ? { total: convTotal, inbound: ibConv, outbound: obConv } : null,
    appointments: booked !== null ? { total: booked, inbound: bookInbound, outbound: bookOutbound, assisted: workedRaw } : null,
    callsTexts: callsTotal !== null && smsTotal !== null ? { calls: callsTotal, sms: smsTotal } : null,
    talkMinutes: talkTotal,
    afterHours: afterTotal,
    namedAppointments: appt?.appointments?.items?.length
      ? appt.appointments.items.map((it) => ({
          customer: it.customerName || "Customer",
          vehicle: it.vehicle ? [it.vehicle.year, it.vehicle.make, it.vehicle.model].filter(Boolean).join(" ") : undefined,
          when: it.scheduledStart,
        }))
      : null,
    actionItems: openNow !== null || cleared !== null
      ? {
          openNow: openNow ?? 0,
          cleared: cleared ?? 0,
          items: (ai?.actionItems?.items ?? []).map((it) => ({
            customer: it.customerName || "Customer",
            what: it.title || it.whatNeedsDoing,
            due: it.due,
            isLate: it.isLate,
          })),
        }
      : null,
  };
}

export { EMPTY as EMPTY_SERVICE_METRICS_OVERLAY };

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
      return { window: "custom", startDate: rangeStart, endDate: rangeEndExclusive, timezone };
  }
}

/** Fetches the overlay whenever `enabled` and the scope/window change. Returns `EMPTY` (all null,
 * `loading: true`) while a fetch is in flight or before the first one starts, so callers never have to
 * special-case `undefined`. Disabled (`enabled: false`, e.g. Sales, or the flag off) always returns
 * `EMPTY` with `loading: false` and fetches nothing. */
export function useServiceMetricsOverlay(params: {
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
}): ServiceMetricsOverlay {
  const { enabled, enterpriseId, teamId, spyneToken, spyneEnv, bucket, custom, rangeStart, rangeEndExclusive, timezone } = params;
  // Derived, not stored: disabled (Sales, the flag off, or scope not resolved yet) always reads as EMPTY
  // with no state update needed.
  const canFetch = enabled && !!teamId && !!enterpriseId && !!spyneToken;
  // Request signature — changes whenever anything the fetch depends on changes. `loading` is derived by
  // comparing it to the signature of the last RESOLVED fetch (`state.key`), so nothing has to set a
  // "loading" flag synchronously inside the effect below; only the async `.then`/`.catch` ever call
  // `setState`, which is the pattern this repo's own lint rule (react-hooks/set-state-in-effect) requires.
  const key = canFetch ? JSON.stringify([enterpriseId, teamId, spyneEnv ?? "", bucket, custom, rangeStart ?? "", rangeEndExclusive ?? "", timezone ?? ""]) : "";
  const [state, setState] = useState<{ key: string; data: ServiceMetricsOverlay }>({ key: "", data: EMPTY });

  useEffect(() => {
    if (!canFetch) return;
    let on = true;
    const w = serviceMetricsWindowFor(bucket, custom, rangeStart, rangeEndExclusive, timezone);
    loadServiceMetricsOverlay({ enterpriseId, teamId, spyneToken, spyneEnv }, w)
      .then((res) => { if (on) setState({ key, data: res }); })
      .catch(() => { if (on) setState({ key, data: EMPTY }); });
    return () => { on = false; };
  }, [canFetch, key, enterpriseId, teamId, spyneToken, spyneEnv, bucket, custom, rangeStart, rangeEndExclusive, timezone]);

  if (!canFetch) return EMPTY;
  return { ...state.data, loading: state.key !== key };
}
