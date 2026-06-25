/* Materialize the Supabase reporting aggregate DIRECTLY from ClickHouse (dealer_leads) — no Metabase.
 * Runs the conversation spine (src/lib/reports/agentBaseFact.sql, callback→outbound injected) through
 * the SAME aggregate.ts the app uses, then writes agent_daily / agent_daily_breakdown / agent_lead_days
 * plus the rooftop detail tables (report_campaigns / report_outcomes / report_callbacks).
 *
 * Modes:
 *   npx tsx scripts/backfill.ts            # INCREMENTAL (default): watermark-driven. Reads sync_state.
 *                                          #   watermark, asks ClickHouse which (team,day) partitions
 *                                          #   changed since (updatedAt), and re-aggregates from the
 *                                          #   oldest changed day (capped) — "last changes synced, not
 *                                          #   synced again". Always refreshes at least the hot window.
 *   npx tsx scripts/backfill.ts --full     # bounded full reconcile: rebuild the last FULL_RECONCILE_DAYS.
 *   npx tsx scripts/backfill.ts --days=7    # force a fixed trailing hot window.
 *   npx tsx scripts/backfill.ts /tmp/q.json # aggregate a local RawRow[] dump (dev convenience).
 *
 * The GitHub Action (sync-reports.yml) runs the incremental every 30m and a --full nightly. Env
 * (process.env or .env.local): CLICKHOUSE_HOST/PORT/USER/PASSWORD, SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY, SYNC_WINDOW_DAYS (hot window, default 3), FULL_RECONCILE_DAYS (default 120),
 * MAX_LOOKBACK_DAYS (watermark pull-back cap, default 120), SPYNE_API_TOKEN (optional, for store-local tz). */
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { aggregate } from "../src/lib/reports/aggregate";
import { mergeStlEarliest, reconcileHistoricalStl } from "../src/lib/reports/stlSync";
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

const FULL_DAYS = Number(process.env.FULL_RECONCILE_DAYS) || 120; // bounded full window — never an all-time scan
const MAX_LOOKBACK = Number(process.env.MAX_LOOKBACK_DAYS) || 120; // cap how far a watermark delta pulls back

const todayUTC = () => new Date().toISOString().slice(0, 10);
const shiftDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function insertAll(sb: any, table: string, rows: object[]) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from(table).insert(rows.slice(i, i + 500));
    if (error) throw new Error(`${table} insert @${i}: ${error.message}`);
  }
  console.log(`  ${table}: ${rows.length} inserted`);
}

/* Which (team,day) partitions changed since the watermark. One column scan per source table (cheap —
 * updatedAt filter), returning the oldest changed conversation/ecr/meeting/sms day + the new max
 * updatedAt + a changed-row count. `effWm` is floored at now()-MAX_LOOKBACK so a stale watermark can't
 * trigger an unbounded pull-back. */
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
  const fileArg = args.find((a) => !a.startsWith("--"));
  const hotDays = daysArg || Number(process.env.SYNC_WINDOW_DAYS) || 3;
  const today = todayUTC();
  const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

  // windowStart = the activity_day floor we delete-and-replace from (matched on the FINAL, possibly
  // re-bucketed, activity_day). Detail tables are full-replaced regardless.
  let windowStart = "1900-01-01";
  let raw: RawRow[];
  let newWatermark: string | null = null;

  if (fileArg && fs.existsSync(fileArg)) {
    console.log("reading", fileArg);
    raw = JSON.parse(fs.readFileSync(fileArg, "utf8")) as RawRow[];
  } else {
    let scanFloor: string;
    if (full) {
      scanFloor = shiftDays(today, -(FULL_DAYS - 1));
      console.log(`FULL reconcile from ${scanFloor} (bounded ${FULL_DAYS}d).`);
    } else {
      const { data: state } = await sb.from("sync_state").select("watermark").eq("id", 1).maybeSingle();
      const watermark: string | null = (state as { watermark?: string } | null)?.watermark ?? null;
      const hotFloor = shiftDays(today, -(hotDays - 1));
      const cap = shiftDays(today, -(MAX_LOOKBACK - 1));
      if (!watermark) {
        scanFloor = shiftDays(today, -(FULL_DAYS - 1));
        console.log(`BOOTSTRAP (no watermark) — reconcile from ${scanFloor} (bounded ${FULL_DAYS}d).`);
      } else {
        // Floor the delta scan at the lookback cap so a stale watermark can't pull back unbounded.
        const effWm = watermark > `${cap}T00:00:00Z` ? watermark : `${cap}T00:00:00Z`;
        const delta = await queryRows<{ oldest_changed_day: string; new_watermark: string; changed_rows: string }>(deltaSql(effWm));
        const changed = n(delta[0]?.changed_rows);
        const oldest = changed > 0 ? String(delta[0]?.oldest_changed_day || "") : "";
        newWatermark = delta[0]?.new_watermark && n(delta[0]?.changed_rows) > 0 ? String(delta[0].new_watermark) : watermark;
        // Re-aggregate from the oldest changed day (capped), but always cover at least the hot window.
        scanFloor = oldest && oldest < hotFloor ? (oldest < cap ? cap : oldest) : hotFloor;
        console.log(`INCREMENTAL: watermark=${watermark}, changed_rows=${changed}, oldest_changed_day=${oldest || "—"} → scan from ${scanFloor}.`);
      }
    }
    windowStart = scanFloor;
    // Re-bucketing a store-local day draws from events whose UTC day is ±1, so floor the SCAN one extra
    // UTC day back; the output filter (>= windowStart) trims anything earlier.
    const pullFloor = shiftDays(scanFloor, -1);
    console.log(`spine scan floored at ${pullFloor}…`);
    raw = await queryRows<RawRow>(loadSpineSql(`toDate('${pullFloor}')`));
    console.log(`spine: ${raw.length} rows`);
  }
  if (!raw.length) throw new Error("0 spine rows across the window — refusing to wipe the aggregate (pull likely failed).");

  // Resolve store timezones for exactly the teams in this pull, persist, then layer over the cache.
  const live = await fetchTeamTzs(teamsInRows(raw), process.env.SPYNE_API_TOKEN || null);
  await saveTzMap(sb, live, new Date().toISOString());
  const tzMap = await loadTzMap(sb);
  for (const [k, v] of live) tzMap.set(k, v);
  const reBucket = tzMap.size > 0;
  const tzOf = (teamId: string) => tzMap.get(teamId);
  const dayOf = (team: string, activityTs: string, rawDay: string) => storeLocalDay(activityTs, tzOf(team), rawDay);
  if (reBucket) console.log(`tz: ${live.size} live + ${tzMap.size} total rooftops → store-local re-bucketing ON`);
  else console.log("tz: get-working-days unreachable and empty team_tz → UTC bucketing (no re-bucket)");

  let stlEarliest;
  try {
    const { earliest } = await mergeStlEarliest(sb, raw, {
      full: full || Boolean(fileArg) || windowStart <= "1900-01-01",
      dayOf,
    });
    stlEarliest = earliest;
    if (!full && !fileArg && windowStart > "1900-01-01") {
      const teamIds = [...new Set(raw.map((r) => String(r["cs.team_id"] ?? "").trim()).filter(Boolean))];
      const patched = await reconcileHistoricalStl(sb, teamIds, earliest, windowStart);
      if (patched) console.log(`STL historical patch: ${patched} agent_daily rows before ${windowStart}`);
    }
  } catch (e) {
    throw new Error(`STL merge failed: ${(e as Error).message}`);
  }

  // Aggregate ALL pulled rows (re-bucket by store-local day when tzMap is set), then keep only the
  // replace window by the FINAL activity_day.
  const agg = aggregate(raw, { tzOf: reBucket ? tzOf : undefined, stlEarliest });
  const daily = agg.daily.filter((r) => r.activity_day >= windowStart);
  const breakdown = agg.breakdown.filter((r) => r.activity_day >= windowStart);
  const leadDays = agg.leadDays.filter((r) => r.activity_day >= windowStart);
  console.log("daily:", daily.length, " breakdown:", breakdown.length, " lead_days:", leadDays.length);

  for (const t of ["agent_daily", "agent_daily_breakdown", "agent_lead_days"]) {
    const { error } = await sb.from(t).delete().gte("activity_day", windowStart);
    if (error) throw new Error(`${t} delete: ${error.message}`);
  }
  await insertAll(sb, "agent_daily", daily);
  await insertAll(sb, "agent_daily_breakdown", breakdown);
  await insertAll(sb, "agent_lead_days", leadDays);

  // ── rooftop detail (ClickHouse-direct, full replace): campaigns / outcomes / callbacks. Each query
  //    emits agent_type/team_id directly and is floored against the OOM ceiling. A failure here must NOT
  //    fail the main aggregate above. report_appointments (old card 12233) is intentionally gone — the
  //    UI lists upcoming appointments from the live /api/meetings proxy. ──
  try {
    const camps = await queryRows<Record<string, unknown>>(campaignsSql({ startFloor: `addDays(today(), -${FULL_DAYS})` }));
    const campRows = camps
      .map((c) => ({ team_id: String(c.team_id ?? ""), agent_type: (c.agent_type as string) ?? null, campaign: String(c.campaign ?? ""), use_case: c.use_case ?? null, enrolled: n(c.enrolled), appointments: n(c.appointments), warm_leads: n(c.warm_leads), opt_outs: n(c.opt_outs), no_reach: n(c.no_reach), appt_rate_pct: c.appt_rate_pct == null ? null : Number(c.appt_rate_pct) }))
      .filter((r) => r.team_id && r.campaign);

    const outs = await queryRows<Record<string, unknown>>(outcomesSql({}));
    const outcomeRows = outs
      .map((o) => ({ team_id: String(o.team_id ?? ""), agent_type: (o.agent_type as string) ?? null, outcome_bucket: String(o.outcome_bucket ?? ""), mappings: n(o.mappings) }))
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
    last_run_at: new Date().toISOString(), last_status: "ok", rows_synced: daily.length, window_start: windowStart, watermark: wm, error: null,
  }).eq("id", 1);
  console.log(`done (${full ? "full" : fileArg ? "file" : "incremental"}). ${daily.length} daily + ${breakdown.length} breakdown + ${leadDays.length} lead-days from ${windowStart}. watermark=${wm}`);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
