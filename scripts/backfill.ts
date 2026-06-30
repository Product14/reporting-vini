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

// Write rows in 500-row batches. When `onConflict` (the table's PK) is given, UPSERT instead of INSERT
// so an overlapping/concurrent run (or a retry) can never throw a duplicate-key — it updates in place.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function insertAll(sb: any, table: string, rows: object[], onConflict?: string) {
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
  const maxRetries = Number(process.env.SB_WRITE_RETRIES) || 4;
  for (let i = 0; i < rows.length; i += 500) {
    const slice = rows.slice(i, i + 500);
    // Retry transient transport failures ("fetch failed" — stale socket / network blip); without it a
    // long backfill aborts on one flaky request. Upserts are idempotent (PK conflict target). Plain
    // inserts (the small detail tables) are skipped on historical runs and otherwise fully delete+replace
    // each run, so a rare retry-after-lost-ACK dup is wiped on the next sync — acceptable.
    let lastMsg = "";
    let ok = false;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const { error } = onConflict
          ? await sb.from(table).upsert(slice, { onConflict })
          : await sb.from(table).insert(slice);
        if (!error) { ok = true; break; }
        lastMsg = error.message;
      } catch (e) {
        lastMsg = (e as Error).message;
      }
      if (attempt < maxRetries) await sleep(1000 * (attempt + 1));
    }
    if (!ok) throw new Error(`${table} ${onConflict ? "upsert" : "insert"} @${i}: ${lastMsg}`);
  }
}

// Primary keys for the partition-replace tables (used as upsert conflict targets).
const PK = {
  agent_daily: "activity_day,team_id,agent_type",
  agent_daily_breakdown: "activity_day,team_id,agent_type,dim,dim_value",
  agent_lead_days: "team_id,agent_type,lead_id,activity_day",
} as const;

/* Oldest changed (team,day) signal since the watermark — one cheap column scan per source table. */
function deltaSql(effWm: string, cap: string): string {
  // The DISTINCT activity-days (by createdAt) whose rows changed since the watermark, capped at the
  // lookback floor. We re-aggregate only THESE days (not oldest→today contiguous) so a single edit to an
  // old row doesn't trigger a months-wide scan every run.
  const part = (tbl: string, created: string, updated: string) =>
    `SELECT toDate(${created}) AS d, ${updated} AS u
     FROM dealer_leads.${tbl} FINAL
     WHERE __deleted = 0 AND ${updated} > parseDateTimeBestEffort('${effWm}') AND toDate(${created}) >= toDate('${cap}')`;
  return `SELECT arraySort(groupUniqArray(d)) AS days, max(u) AS new_watermark, count() AS changed_rows FROM (
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
  // Explicit [from, to) range — used to bootstrap a long history in SEGMENTS (one fresh process per
  // segment) so heap never accumulates across many chunks. A historical segment does NOT advance the
  // watermark or re-sync the (current-snapshot) detail tables.
  const fromArg = (args.find((a) => a.startsWith("--from=")) || "").split("=")[1];
  const toArg = (args.find((a) => a.startsWith("--to=")) || "").split("=")[1];
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
  // NOTE: tzMap is the persisted timezone CACHE (a superset that includes test/inactive rooftops) — NOT
  // the count of rooftops in the reports. The spine drops test accounts, so agent_daily holds far fewer.
  console.log(reBucket ? `tz: ${tzMap.size} cached zones → store-local re-bucketing ON` : "tz: empty → UTC bucketing");

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
    await insertAll(sb, "agent_daily", daily, PK.agent_daily);
    await insertAll(sb, "agent_daily_breakdown", breakdown, PK.agent_daily_breakdown);
    await insertAll(sb, "agent_lead_days", leadDays, PK.agent_lead_days);
    console.log(`  [${a} .. ${b})  ${raw.length} spine → ${daily.length} daily, ${breakdown.length} bd, ${leadDays.length} ld`);
    return daily.length;
  }

  // ── dev convenience: aggregate a local dump as a single window (no chunking) ──
  if (fileArg && fs.existsSync(fileArg)) {
    const raw = JSON.parse(fs.readFileSync(fileArg, "utf8")) as RawRow[];
    const { earliest } = await mergeStlEarliest(sb, raw, { full: true, dayOf });
    const agg = aggregate(raw, { tzOf: reBucket ? tzOf : undefined, stlEarliest: earliest });
    for (const t of ["agent_daily", "agent_daily_breakdown", "agent_lead_days"]) await sb.from(t).delete().gte("activity_day", "1900-01-01");
    await insertAll(sb, "agent_daily", agg.daily, PK.agent_daily);
    await insertAll(sb, "agent_daily_breakdown", agg.breakdown, PK.agent_daily_breakdown);
    await insertAll(sb, "agent_lead_days", agg.leadDays, PK.agent_lead_days);
    console.log(`file: ${agg.daily.length} daily from ${fileArg}`);
    return;
  }

  // ── decide which day-windows to (re)compute, as a list of [a, b) chunks ──
  let newWatermark: string | null = null;
  const historical = Boolean(fromArg); // a segment of a long backfill — don't touch watermark/detail
  const ranges: Array<[string, string]> = [];
  const chunkRange = (start: string, end: string) => {
    for (let a = start; a < end; a = shiftDays(a, CHUNK_DAYS)) ranges.push([a, minDay(shiftDays(a, CHUNK_DAYS), end)]);
  };

  if (fromArg) {
    chunkRange(fromArg, toArg || shiftDays(today, 1));
    console.log(`SEGMENT reconcile ${fromArg} .. ${toArg || today} (${CHUNK_DAYS}d chunks).`);
  } else if (full || backfillDays || monthsArg) {
    const span = backfillDays || (monthsArg ? monthsArg * 30 : FULL_DAYS);
    const start = shiftDays(today, -(span - 1));
    chunkRange(start, shiftDays(today, 1));
    console.log(`${backfillDays || monthsArg ? "BACKFILL" : "FULL"} reconcile ${start} .. ${today} (${span}d, ${CHUNK_DAYS}d chunks).`);
  } else {
    const { data: state } = await sb.from("sync_state").select("watermark").eq("id", 1).maybeSingle();
    const watermark: string | null = (state as { watermark?: string } | null)?.watermark ?? null;
    const hotFloor = shiftDays(today, -(hotDays - 1));
    const cap = shiftDays(today, -(MAX_LOOKBACK - 1));
    if (!watermark) {
      chunkRange(shiftDays(today, -(FULL_DAYS - 1)), shiftDays(today, 1));
      console.log(`BOOTSTRAP (no watermark) — reconcile last ${FULL_DAYS}d (${CHUNK_DAYS}d chunks).`);
    } else {
      const effWm = watermark > `${cap}T00:00:00Z` ? watermark : `${cap}T00:00:00Z`;
      const delta = await queryRows<{ days: string[]; new_watermark: string; changed_rows: string }>(deltaSql(effWm, cap));
      const changed = num(delta[0]?.changed_rows);
      newWatermark = changed > 0 && delta[0]?.new_watermark ? String(delta[0].new_watermark) : watermark;
      // Re-aggregate the days that actually changed PLUS the hot window, merged into ≤CHUNK_DAYS windows.
      // A single edit to an old row scans just that day's window — never oldest→today contiguously.
      const days = new Set<string>(Array.isArray(delta[0]?.days) ? delta[0]!.days.map(String).filter((d) => d >= cap) : []);
      for (let d = hotFloor; d <= today; d = shiftDays(d, 1)) days.add(d);
      for (const d of [...days].sort()) {
        const last = ranges[ranges.length - 1];
        if (last && d < shiftDays(last[0], CHUNK_DAYS)) last[1] = shiftDays(d, 1);
        else ranges.push([d, shiftDays(d, 1)]);
      }
      console.log(`INCREMENTAL: watermark=${watermark}, changed_rows=${changed}, ${days.size} day(s) → ${ranges.length} chunk(s) (≤${CHUNK_DAYS}d each).`);
    }
  }

  // ── walk the chunks (oldest-first); force GC between them so a long run never accumulates heap ──
  let totalDaily = 0;
  const gc = (globalThis as { gc?: () => void }).gc;
  for (const [a, b] of ranges) {
    totalDaily += await syncChunk(a, b);
    if (gc) gc();
  }
  const firstStart = ranges.length ? ranges[0][0] : today;
  const lastEnd = ranges.length ? ranges[ranges.length - 1][1] : shiftDays(today, 1);

  // ── rooftop detail (ClickHouse-direct, full replace): campaigns / outcomes / callbacks. Cumulative
  //    snapshots (not per-day), so a single replace covers them. Skipped for historical segments (they'd
  //    just re-write the same current snapshot each segment). A failure here must NOT fail the aggregate. ──
  if (!historical) try {
    const camps = await queryRows<Record<string, unknown>>(campaignsSql({ startFloor: `toDate('${firstStart}')` }));
    const campRows = camps
      .map((c) => ({ team_id: String(c.team_id ?? ""), agent_type: (c.agent_type as string) ?? null, campaign: String(c.campaign ?? ""), use_case: c.use_case ?? null, enrolled: num(c.enrolled), appointments: num(c.appointments), warm_leads: num(c.warm_leads), opt_outs: num(c.opt_outs), no_reach: num(c.no_reach), appt_rate_pct: c.appt_rate_pct == null ? null : Number(c.appt_rate_pct) }))
      .filter((r) => r.team_id && r.campaign);
    const outs = await queryRows<Record<string, unknown>>(outcomesSql({}));
    const outcomeRows = outs
      .map((o) => ({ team_id: String(o.team_id ?? ""), agent_type: (o.agent_type as string) ?? null, outcome_bucket: String(o.outcome_bucket ?? ""), mappings: num(o.mappings) }))
      .filter((r) => r.team_id && r.outcome_bucket);
    const cbs = await queryRows<Record<string, unknown>>(callbacksSql({}));
    const cbRows = cbs
      .map((c) => ({ team_id: String(c.team_id ?? ""), service_type: (c.service_type as string) ?? null, customer_name: c.customer_name ?? null, callback_due: c.callback_due ?? null, intent: c.intent ?? null, priority: c.priority ?? null, assigned_to: c.assigned_to ?? null, requested_on: c.requested_on ?? null }))
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

  // Advance the watermark only for live runs (full/incremental). A historical segment must not move it —
  // the incremental watermark tracks "changes processed up to now", which a backfill of old days doesn't.
  const update: Record<string, unknown> = {
    last_run_at: new Date().toISOString(), last_status: "ok", rows_synced: totalDaily, window_start: firstStart, error: null,
  };
  if (!historical) update.watermark = newWatermark || new Date().toISOString();
  await sb.from("sync_state").update(update).eq("id", 1);
  console.log(`done. ${totalDaily} daily rows across ${firstStart} .. ${lastEnd} in ${ranges.length} chunk(s).${historical ? " (segment)" : ` watermark=${update.watermark}`}`);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
