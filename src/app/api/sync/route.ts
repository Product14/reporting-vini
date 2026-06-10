import { fetchEmbedRows } from "@/lib/metabase";
import { getSupabase, AGENT_DAILY, AGENT_DAILY_BREAKDOWN, SYNC_STATE } from "@/lib/reports/supabase";
import { aggregate } from "@/lib/reports/aggregate";
import type { RawRow } from "@/lib/reports/schema";

/* Pulls Q12227 (event-level raw data), aggregates it into agent_daily + agent_daily_breakdown, and
 * replaces the trailing window in Supabase. Triggered every few minutes by Supabase pg_cron (see
 * supabase/migrations/0001_agent_facts.sql) or any scheduler; protected by CRON_SECRET.
 *
 * Window: default last SYNC_WINDOW_DAYS days. Overrides: ?days=N, ?since=YYYY-MM-DD, ?full=1 (rebuild
 * all — use once for the initial backfill). If Q12227 gains an activity_day embedding param, set
 * METABASE_RAW_DATE_PARAM to its slug so the pull is scoped server-side instead of full-table. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const RAW_QUESTION = 12227;
const CHUNK = 500;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // never run open
  const hdr = request.headers.get("authorization") || "";
  const url = new URL(request.url);
  return hdr === `Bearer ${secret}` || url.searchParams.get("key") === secret;
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}
function minusDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
function addDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function chunkedInsert(sb: NonNullable<ReturnType<typeof getSupabase>>, table: string, rows: object[]): Promise<string | null> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await sb.from(table).insert(rows.slice(i, i + CHUNK));
    if (error) return error.message;
  }
  return null;
}

async function handle(request: Request): Promise<Response> {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const sb = getSupabase();
  if (!sb) return Response.json({ error: "Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)." }, { status: 503 });

  const url = new URL(request.url);
  const full = url.searchParams.get("full") === "1";
  const since = url.searchParams.get("since");
  const days = Number(url.searchParams.get("days")) || Number(process.env.SYNC_WINDOW_DAYS) || 3;
  const today = todayUTC();
  const windowStart = full ? "1900-01-01" : since || minusDays(today, days - 1);
  const windowEnd = addDay(today); // exclusive

  const fail = async (msg: string, status = 502) => {
    await sb.from(SYNC_STATE).update({ last_run_at: new Date().toISOString(), last_status: "error", error: msg, window_start: windowStart }).eq("id", 1);
    return Response.json({ ok: false, error: msg }, { status });
  };

  // Pull raw rows. Q12227's activity_day param is single-date equality (= {{activity_day}}), so the
  // incremental path pulls ONE day per call across the window (each ~3MB) instead of the 382MB full
  // table. Without the param (or ?full=1) it falls back to the full-table pull + client-side filter.
  const dateParam = process.env.METABASE_RAW_DATE_PARAM;
  const perDay = Boolean(dateParam && !full);
  let raw: RawRow[];
  if (perDay) {
    raw = [];
    for (let d = windowStart; d < windowEnd; d = addDay(d)) {
      const { rows, error } = await fetchEmbedRows(RAW_QUESTION, { [dateParam as string]: d });
      if (error) return fail(`Metabase pull failed for ${d}: ${error}`);
      raw.push(...(rows as RawRow[]));
    }
  } else {
    const { rows, error } = await fetchEmbedRows(RAW_QUESTION, {});
    if (error) return fail(`Metabase pull failed: ${error}`);
    raw = rows as RawRow[];
  }
  // Never wipe the window on an empty pull. A single empty day is fine (today often lags), but 0 rows
  // across the WHOLE window means the pull failed — Q12227 is never truly empty across all teams.
  if (!raw.length) return fail("Metabase pull returned 0 rows across the window — aborting before delete (pull likely failed).");

  const scoped = raw.filter((r) => String(r.activity_day || "") >= windowStart);
  const { daily, breakdown } = aggregate(scoped);

  // Replace the window: delete then insert (drops stale breakdown values that no longer appear).
  const del1 = await sb.from(AGENT_DAILY).delete().gte("activity_day", windowStart);
  if (del1.error) return fail(`delete agent_daily: ${del1.error.message}`);
  const del2 = await sb.from(AGENT_DAILY_BREAKDOWN).delete().gte("activity_day", windowStart);
  if (del2.error) return fail(`delete agent_daily_breakdown: ${del2.error.message}`);

  const e1 = await chunkedInsert(sb, AGENT_DAILY, daily);
  if (e1) return fail(`insert agent_daily: ${e1}`);
  const e2 = await chunkedInsert(sb, AGENT_DAILY_BREAKDOWN, breakdown);
  if (e2) return fail(`insert agent_daily_breakdown: ${e2}`);

  await sb.from(SYNC_STATE).update({
    last_run_at: new Date().toISOString(), last_status: "ok", rows_synced: daily.length, window_start: windowStart, error: null,
  }).eq("id", 1);

  return Response.json({
    ok: true, window_start: windowStart, window_end: windowEnd,
    raw_rows: raw.length, scoped_rows: scoped.length, daily_rows: daily.length, breakdown_rows: breakdown.length,
    mode: perDay ? "incremental-per-day" : "full-table",
  });
}

export const POST = handle;
export const GET = handle; // allow Vercel Cron (GET) as well as pg_net (POST)
