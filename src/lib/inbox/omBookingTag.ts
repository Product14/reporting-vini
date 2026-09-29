/* RETCONVAI-5066. Inbox "Booked by" line on Service appointments, from Om Thakare's service-metrics API,
 * so the Inbox says the same thing about an appointment as the new Appointments page does.
 *
 * Today the Inbox writes "Booked by <agent or Vini> · <direction>" whenever an appointment carries a
 * conversation_id that matches one of the customer's conversations. Om's API tags every appointment
 * booked_by_spyne, worked_by_spyne (Spyne-assisted) or booked_by_dealer, with tool proof first and
 * handoffs excluded, so a dealer booking after a transfer is not a Spyne booking there.
 *
 * Service only, and only for rooftops listed in NEXT_PUBLIC_SERVICE_INBOX_OM_TEAMS (comma list of
 * team_ids, or "all"). Unset or empty = off, and the Inbox behaves exactly as before. Sales never reads
 * this file's output.
 *
 * Mechanics: two tag-filtered requests (`tag=booked_by_spyne`, `tag=worked_by_spyne`, `listAnchor=created`)
 * over the last LOOKBACK_DAYS, cached per rooftop for the page session, then looked up by meetingId. The
 * dealer's own bookings are never fetched (Honda DTLA: about 3,350 a month), so a meeting in neither set is
 * treated as unknown and keeps the old line, never relabelled "your team" on a guess.
 */

/** Mirrors HOLD_WORKED_BY_SPYNE in src/lib/serviceMetrics.ts. Kept local so this file has no imports and
 * lands cleanly on the vini-conversations deploy, which is older than serviceMetrics.ts. While true, a
 * Spyne-assisted appointment shows no "Booked by" line at all rather than a wrong one. */
export const HOLD_SPYNE_ASSISTED = true;

export const LOOKBACK_DAYS = 60;
const MAX_PAGES = 20; // 20 x 50 rows per tag; far above a rooftop's 60-day Spyne bookings
const CLIENT_TIMEOUT_MS = 25_000;

export type OmTag = "booked_by_spyne" | "worked_by_spyne";
export interface OmBooking {
  tag: OmTag;
  direction: "inbound" | "outbound" | null;
  channel: "call" | "text" | null;
  agentName: string | null;
}
export type OmBookingMap = Map<string, OmBooking>;

export interface OmCtx {
  enterpriseId: string;
  teamId: string;
  spyneToken?: string;
  spyneEnv?: string;
  serviceType?: "sales" | "service";
}

/** Whether this rooftop's Service Inbox reads Om's tag. Pure; `raw` defaults to the env var. */
export function inboxOmOn(
  teamId: string,
  serviceType: string | undefined,
  raw: string | undefined = process.env.NEXT_PUBLIC_SERVICE_INBOX_OM_TEAMS,
): boolean {
  if (serviceType !== "service" || !teamId) return false;
  const list = (raw || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return false;
  return list.includes("all") || list.includes(teamId);
}

/** yyyy-mm-dd `days` before today in UTC. A day of slack either side does not matter over 60 days. */
export function lookbackRange(now = Date.now(), days = LOOKBACK_DAYS): { startDate: string; endDate: string } {
  const end = new Date(now);
  const start = new Date(now - days * 86_400_000);
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

/**
 * The line to show under a Service appointment, from Om's tag.
 *   undefined -> no Om answer for this row, caller keeps its old line
 *   null      -> Om knows the row but the line is held, show nothing
 *   string    -> show this
 */
export function omBookingLine(
  meetingId: string | undefined,
  map: OmBookingMap | null,
  held = HOLD_SPYNE_ASSISTED,
): string | null | undefined {
  if (!map || !meetingId) return undefined;
  const hit = map.get(meetingId);
  if (!hit) return undefined;
  if (hit.tag === "worked_by_spyne") return held ? null : "Spyne-assisted";
  const how =
    hit.channel === "text" ? "by text" : hit.direction === "inbound" ? "Inbound" : hit.direction === "outbound" ? "Outbound" : "";
  const who = hit.agentName ? ` (${hit.agentName})` : "";
  return `Booked by Spyne${who}${how ? ` · ${how}` : ""}`;
}

/** Folds both tag lists into one map. booked_by_spyne wins if a meetingId ever appears in both. */
export function buildOmBookingMap(
  booked: Array<Record<string, unknown>>,
  worked: Array<Record<string, unknown>>,
): OmBookingMap {
  const map: OmBookingMap = new Map();
  const put = (rows: Array<Record<string, unknown>>, tag: OmTag) => {
    for (const r of rows) {
      const id = typeof r.meetingId === "string" ? r.meetingId : "";
      if (!id || (map.has(id) && map.get(id)!.tag === "booked_by_spyne")) continue;
      const agent = r.bookedByAgent as { agentName?: string | null } | null | undefined;
      map.set(id, {
        tag,
        direction: r.direction === "inbound" || r.direction === "outbound" ? r.direction : null,
        channel: r.channel === "call" || r.channel === "text" ? r.channel : null,
        agentName: agent?.agentName || null,
      });
    }
  };
  put(worked, "worked_by_spyne");
  put(booked, "booked_by_spyne");
  return map;
}

function apiBaseForEnv(env?: string | null): string {
  if (env === "uat") return "https://uat-api.spyne.xyz";
  if (env === "stag") return "https://beta-api.spyne.xyz";
  return "https://api.spyne.ai";
}

async function fetchPage(ctx: OmCtx, params: Record<string, string>): Promise<Record<string, unknown> | null> {
  const url = new URL(`${apiBaseForEnv(ctx.spyneEnv)}/conversation/service-metrics/appointment`);
  const qp: Record<string, string> = { enterpriseId: ctx.enterpriseId, teamId: ctx.teamId, agentLine: "service", ...params };
  for (const [k, v] of Object.entries(qp)) if (v) url.searchParams.set(k, v);
  const token = ctx.spyneToken || "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      headers: { Authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    return (json?.data ?? json) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Every row for one tag, cursor-paged. Null if the first page fails, so the caller falls back. */
async function fetchTagRows(ctx: OmCtx, tag: OmTag, range: { startDate: string; endDate: string }, timezone?: string) {
  const base: Record<string, string> = {
    window: "custom", ...range, direction: "both", listAnchor: "created", tag, limit: "50", ...(timezone ? { timezone } : {}),
  };
  const rows: Array<Record<string, unknown>> = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await fetchPage(ctx, cursor ? { ...base, cursor } : base);
    if (!body) return page === 0 ? null : rows;
    const list = body.appointments as { items?: Array<Record<string, unknown>>; nextCursor?: string | null } | undefined;
    rows.push(...(list?.items ?? []));
    const next = list?.nextCursor ?? null;
    if (!next || next === cursor) break;
    cursor = next;
  }
  return rows;
}

const cache = new Map<string, Promise<OmBookingMap | null>>();

/** Cached per rooftop and day. Null on any failure, and the Inbox keeps its old line. */
export function fetchOmBookingMap(ctx: OmCtx, timezone?: string): Promise<OmBookingMap | null> {
  if (!ctx.teamId || !ctx.enterpriseId || !ctx.spyneToken) return Promise.resolve(null);
  const range = lookbackRange();
  const key = [ctx.spyneEnv ?? "", ctx.enterpriseId, ctx.teamId, range.endDate].join("|");
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = Promise.all([
    fetchTagRows(ctx, "booked_by_spyne", range, timezone),
    fetchTagRows(ctx, "worked_by_spyne", range, timezone),
  ]).then(([booked, worked]) => {
    if (!booked || !worked) {
      cache.delete(key);
      return null;
    }
    return buildOmBookingMap(booked, worked);
  });
  cache.set(key, pending);
  return pending;
}
