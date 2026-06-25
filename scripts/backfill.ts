/* Materialize the Supabase reporting aggregate DIRECTLY from ClickHouse (dealer_leads) — no Metabase.
 * Runs the conversation spine (src/lib/reports/agentBaseFact.sql, callback→outbound injected) through
 * the SAME aggregate.ts the app uses, then writes agent_daily / agent_daily_breakdown / agent_lead_days
 * plus the rooftop detail tables (report_campaigns / report_outcomes / report_callbacks).
 *
 * EVERY mode walks the target range in small [a, b) CHUNK_DAYS-day chunks (default 14), oldest-first —
 * so no single ClickHouse scan is ever large enough to approach the cluster's memory ceiling. A long
 * historical bootstrap is just many small chunks.
 *
 * Modes:
 *   npx tsx scripts/backfill.ts                  # INCREMENTAL (default): watermark-driven. Re-aggregates
 *                                                #   from the oldest (team,day) partition changed since
 *                                                #   sync_state.watermark up to today, in chunks.
 *   npx tsx scripts/backfill.ts --full            # bounded reconcile: last FULL_RECONCILE_DAYS, chunked.
 *   npx tsx scripts/backfill.ts --backfill-days=365  # historical bootstrap: last N days, chunked.
 *   npx tsx scripts/backfill.ts --months=12       # historical bootstrap: last N months (30d each), chunked.
 *   npx tsx scripts/backfill.ts --days=7          # force a fixed trailing hot window (chunked).
 *   npx tsx scripts/backfill.ts /tmp/q.json       # aggregate a local RawRow[] dump (dev; single window).
 *
 * Env (process.env or .env.local): CLICKHOUSE_HOST/PORT/USER/PASSWORD, SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY, CHUNK_DAYS (default 14), SYNC_WINDOW_DAYS (hot window, default 3),
 * FULL_RECONCILE_DAYS (default 120), MAX_LOOKBACK_DAYS (watermark pull-back cap, default 120),
 * SPYNE_API_TOKEN (optional, for store-local tz). */
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { aggregate } from "../src/lib/reports/aggregate";
import { mergeStlEarliest } from "../src/lib/reports/stlSync";
import { fetchTeamTzs, storeLocalDay, teamsInRows } from "../src/lib/reports/tzMap";
import { saveTzMap, loadTzMap } from "../src/lib/reports/tzStore";
import { queryRows } from "../src/lib/reports/clickhouseQuery";
import { loadSpineSql } from "../src/lib/reports/spineSql";
import { campaignsSql, outcomesSql, callbacksSql } from "../src/lib/reports/detailQueries";
import type { RawRow } from "../src/lib/reports/schema";

function loadEnv() {
  if (!fs.existsSync(".env.local")) return;
  for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();

const SB_URL = process.env.SUPABASE_URL!;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
for (const [k, v] of Object.entries({
  SUPABASE_URL: SB_URL,
  SUPABASE_SERVICE_ROLE_KEY: SB_KEY,
  CLICKHOUSE_HOST: process.env.CLICKHOUSE_HOST,
  CLICKHOUSE_PASSWORD: process.env.CLICKHOUSE_PASSWORD,
}))
  if (!v) { console.error(`Missing env: ${k}`); process.exit(1); }

const CHUNK_DAYS = Number(process.env.CHUNK_DAYS) || 14; // each ClickHouse scan covers this many days
const FULL_DAYS = Number(process.env.FULL_RECONCILE_DAYS) || 120;
const MAX_LOOKBACK = Number(process.env.MAX_LOOKBACK_DAYS) || 120;

const todayUTC = () => new Date().toISOString().slice(0, 10);
const shiftDays = (iso: string, d: number) => {
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + d);
  return t.toISOString().slice(0, 10);
};
const minDay = (a: string, b: string) => (a < b ? a : b);
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function insertAll(sb: any, table: string, rows: object[]) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from(table).insert(rows.slice(i, i + 500));
    if (error) throw new Error(`${table} insert @${i}: ${error.message}`);
  }
}

/* Oldest changed (team,day) signal since the watermark — one cheap column scan per source table. */
function deltaSql(effWm: string): string {
  const part = (tbl: string, created: string, updated: string) =>
    `SELECT min(toDate(${created})) AS oldest, max(${updated}) AS mx, count() AS c
     FROM dealer_leads.${tbl} FINAL WHERE __deleted = 0 AND ${updated} > parseDateTimeBestEffort('${effWm}')`;
  return `SELECT min(oldest) AS oldest_changed_day, max(mx) AS new_watermark, sum(c) AS changed_rows FROM (
    ${part("conversations", "createdAt", "updatedAt")}
    UNION ALL ${part("endcallreports", "createdAt", "updatedAt")}
    UNION ALL ${part("meetings", "created_at", "updated_at")}
    UNION ALL ${part("smsMessages", "createdAt", "updatedAt")}
  )`;
}

(async () => {
  const args = process.argv.slice(2);
  const full = args.includes("--full");
  const daysArg = Number((args.find((a) => a.startsWith("--days=")) || "").split("=")[1]);
  const backfillDays = Number((args.find((a) => a.startsWith("--backfill-days=")) || "").split("=")[1]);
  const monthsArg = Number((args.find((a) => a.startsWith("--months=")) || "").split("=")[1]);
  const fileArg = args.find((a) => !a.startsWith("--"));
  const hotDays = daysArg || Number(process.env.SYNC_WINDOW_DAYS) || 3;
  const today = todayUTC();
  const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

  // Resolve store timezones from the persisted map ONCE (it covers every rooftop the sync has seen, so a
  // long backfill reuses it instead of re-hitting the Spyne API). New rooftops are refreshed live, lazily,
  // per chunk (see syncChunk) — only the ids actually missing, so it stays cheap.
  const tzMap = await loadTzMap(sb);
  const reBucket = tzMap.size > 0;
  const tzOf = (teamId: string) => tzMap.get(teamId);
  const dayOf = (team: string, ts: string, rawDay: string) => storeLocalDay(ts, tzOf(team), rawDay);
  console.log(reBucket ? `tz: ${tzMap.size} rooftops → store-local re-bucketing ON` : "tz: empty → UTC bucketing");

  // Process ONE [a, b) chunk: scan the spine over [a-1, b+1) (±1 day pad so store-local re-bucketing at
  // the boundary is complete), aggregate, and replace exactly the rows whose final activity_day ∈ [a, b).
  // STL merges (full=false) so earliest-speed-to-lead-per-lead accumulates correctly across chunks
  // (we walk oldest-first). Returns daily rows written.
  async function syncChunk(a: string, b: string): Promise<number> {
    const raw = await queryRows<RawRow>(loadSpineSql(`toDate('${shiftDays(a, -1)}')`, `toDate('${shiftDays(b, 1)}')`));
    if (!raw.length) { console.log(`  [${a} .. ${b})  0 spine rows — skip`); return 0; }
    // Lazily acquire store-local tz for any rooftop not yet in the persisted map (usually none).
    const token = process.env.SPYNE_API_TOKEN;
    if (token) {
      const missing = teamsInRows(raw).filter((t) => !tzMap.has(t));
      if (missing.length) {
        try {
          const live = await fetchTeamTzs(missing, token);
          if (live.size) { await saveTzMap(sb, live, new Date().toISOString()); for (const [k, v] of live) tzMap.set(k, v); }
        } catch { /* keep persisted */ }
      }
    }
    const { earliest } = await mergeStlEarliest(sb, raw, { full: false, dayOf });
    const agg = aggregate(raw, { tzOf: reBucket ? tzOf : undefined, stlEarliest: earliest });
    const inRange = (d: { activity_day: string }) => d.activity_day >= a && d.activity_day < b;
    const daily = agg.daily.filter(inRange);
    const breakdown = agg.breakdown.filter(inRange);
    const leadDays = agg.leadDays.filter(inRange);
    for (const t of ["agent_daily", "agent_daily_breakdown", "agent_lead_days"]) {
      const { error } = await sb.from(t).delete().gte("activity_day", a).lt("activity_day", b);
      if (error) throw new Error(`${t} delete [${a},${b}): ${error.message}`);
    }
    await insertAll(sb, "agent_daily", daily);
    await insertAll(sb, "agent_daily_breakdown", breakdown);
    await insertAll(sb, "agent_lead_days", leadDays);
    console.log(`  [${a} .. ${b})  ${raw.length} spine → ${daily.length} daily, ${breakdown.length} bd, ${leadDays.length} ld`);
    return daily.length;
  }

  // ── dev convenience: aggregate a local dump as a single window (no chunking) ──
  if (fileArg && fs.existsSync(fileArg)) {
    const raw = JSON.parse(fs.readFileSync(fileArg, "utf8")) as RawRow[];
    const { earliest } = await mergeStlEarliest(sb, raw, { full: true, dayOf });
    const agg = aggregate(raw, { tzOf: reBucket ? tzOf : undefined, stlEarliest: earliest });
    for (const t of ["agent_daily", "agent_daily_breakdown", "agent_lead_days"]) await sb.from(t).delete().gte("activity_day", "1900-01-01");
    await insertAll(sb, "agent_daily", agg.daily);
    await insertAll(sb, "agent_daily_breakdown", agg.breakdown);
    await insertAll(sb, "agent_lead_days", agg.leadDays);
    console.log(`file: ${agg.daily.length} daily from ${fileArg}`);
    return;
  }

  // ── decide the [rangeStart, rangeEnd) to (re)compute ──
  const rangeEnd = shiftDays(today, 1); // exclusive, through today
  let rangeStart: string;
  let newWatermark: string | null = null;

  if (full || backfillDays || monthsArg) {
    const span = backfillDays || (monthsArg ? monthsArg * 30 : FULL_DAYS);
    rangeStart = shiftDays(today, -(span - 1));
    console.log(`${backfillDays || monthsArg ? "BACKFILL" : "FULL"} reconcile ${rangeStart} .. ${today} (${span}d, ${CHUNK_DAYS}d chunks).`);
  } else {
    const { data: state } = await sb.from("sync_state").select("watermark").eq("id", 1).maybeSingle();
    const watermark: string | null = (state as { watermark?: string } | null)?.watermark ?? null;
    const hotFloor = shiftDays(today, -(hotDays - 1));
    const cap = shiftDays(today, -(MAX_LOOKBACK - 1));
    if (!watermark) {
      rangeStart = shiftDays(today, -(FULL_DAYS - 1));
      console.log(`BOOTSTRAP (no watermark) — reconcile from ${rangeStart} (${FULL_DAYS}d, ${CHUNK_DAYS}d chunks).`);
    } else {
      const effWm = watermark > `${cap}T00:00:00Z` ? watermark : `${cap}T00:00:00Z`;
      const delta = await queryRows<{ oldest_changed_day: string; new_watermark: string; changed_rows: string }>(deltaSql(effWm));
      const changed = num(delta[0]?.changed_rows);
      const oldest = changed > 0 ? String(delta[0]?.oldest_changed_day || "") : "";
      newWatermark = changed > 0 && delta[0]?.new_watermark ? String(delta[0].new_watermark) : watermark;
      rangeStart = oldest && oldest < hotFloor ? (oldest < cap ? cap : oldest) : hotFloor;
      console.log(`INCREMENTAL: watermark=${watermark}, changed_rows=${changed}, oldest=${oldest || "—"} → ${rangeStart} .. ${today} (${CHUNK_DAYS}d chunks).`);
    }
  }

  // ── walk the range in oldest-first chunks ──
  let totalDaily = 0;
  for (let a = rangeStart; a < rangeEnd; a = shiftDays(a, CHUNK_DAYS)) {
    const b = minDay(shiftDays(a, CHUNK_DAYS), rangeEnd);
    totalDaily += await syncChunk(a, b);
  }

  // ── rooftop detail (ClickHouse-direct, full replace, runs once): campaigns / outcomes / callbacks.
  //    Cumulative snapshots (not per-day), so a single replace covers them. A failure here must NOT fail
  //    the aggregate above. ──
  try {
    const camps = await queryRows<Record<string, unknown>>(campaignsSql({ startFloor: `toDate('${rangeStart}')` }));
    const campRows = camps
      .map((c) => ({ team_id: String(c.team_id ?? ""), agent_type: (c.agent_type as string) ?? null, campaign: String(c.campaign ?? ""), use_case: c.use_case ?? null, enrolled: num(c.enrolled), appointments: num(c.appointments), warm_leads: num(c.warm_leads), opt_outs: num(c.opt_outs), no_reach: num(c.no_reach), appt_rate_pct: c.appt_rate_pct == null ? null : Number(c.appt_rate_pct) }))
      .filter((r) => r.team_id && r.campaign);
    const outs = await queryRows<Record<string, unknown>>(outcomesSql({}));
    const outcomeRows = outs
      .map((o) => ({ team_id: String(o.team_id ?? ""), agent_type: (o.agent_type as string) ?? null, outcome_bucket: String(o.outcome_bucket ?? ""), mappings: num(o.mappings) }))
      .filter((r) => r.team_id && r.outcome_bucket);
    const cbs = await queryRows<Record<string, unknown>>(callbacksSql({}));
    const cbRows = cbs
      .map((c) => ({ team_id: String(c.team_id ?? ""), customer_name: c.customer_name ?? null, callback_due: c.callback_due ?? null, intent: c.intent ?? null, priority: c.priority ?? null, assigned_to: c.assigned_to ?? null, requested_on: c.requested_on ?? null }))
      .filter((r) => r.team_id);
    for (const [t, rows] of [["report_campaigns", campRows], ["report_outcomes", outcomeRows], ["report_callbacks", cbRows]] as const) {
      const { error } = await sb.from(t).delete().gte("synced_at", "1900-01-01");
      if (error) throw new Error(`${t} delete: ${error.message}`);
      await insertAll(sb, t, rows);
    }
    console.log(`detail: ${campRows.length} campaigns + ${outcomeRows.length} outcomes + ${cbRows.length} callbacks synced.`);
  } catch (e) {
    console.warn(`detail sync skipped: ${(e as Error).message}`);
  }

  const wm = newWatermark || new Date().toISOString();
  await sb.from("sync_state").update({
    last_run_at: new Date().toISOString(), last_status: "ok", rows_synced: totalDaily, window_start: rangeStart, watermark: wm, error: null,
  }).eq("id", 1);
  console.log(`done. ${totalDaily} daily rows across ${rangeStart} .. ${today}. watermark=${wm}`);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
