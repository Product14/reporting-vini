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
 *   npx tsx scripts/backfill.ts --enterprise=62f962c8e --from=2025-09-01   # SCOPED, ADDITIVE-ONLY
 *   npx tsx scripts/backfill.ts --teams=a1b2,c3d4 --from=2025-09-01        # (see below)
 *
 * SCOPED MODE (--teams / --enterprise) — the safe way to bootstrap history for rooftops that were
 * previously screened out of reporting (e.g. an enterprise newly added to
 * src/lib/reports/enterpriseScope.ts RESELLER_ALLOWLIST). It keeps the partition-replace semantics of
 * the other modes but confines EVERY write to the named teams:
 *   • the spine is filtered in ClickHouse, so only those rooftops' rows cross the wire;
 *   • the per-chunk DELETE gains `team_id IN scope`. This is the whole point. The unscoped delete has
 *     no team predicate — DELETE activity_day ∈ [a,b) hits the WHOLE FLEET — so reusing an unscoped
 *     mode to bring in one enterprise's back history would rewrite every other rooftop's rows for
 *     those days with today's spine logic, and lose the window outright if an insert then failed;
 *   • a leak assertion aborts the chunk if the spine ever returns a team outside the scope.
 * Because the delete is scoped rather than skipped, this is a true replace within the scope: stale
 * rows a spine change no longer produces are pruned, so it is safe on teams that ALREADY hold rows
 * (partial history from before a filter was added), not just on empty ones.
 * Scoped runs also behave like historical segments: no watermark advance, and no detail-snapshot
 * rebuild (report_campaigns / report_outcomes / … are fleet-wide full-replace snapshots, so rebuilding
 * them from a team-scoped pull would blank every other rooftop). The detail tables pick the new
 * rooftops up on the next normal scheduled run.
 * The scoped delete passes team ids as a PostgREST `in` filter in the query string, so keep a scope to
 * the size of an enterprise (tens), not thousands, or the URL will overflow.
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
import { campaignsSql, outcomesSql, callbacksSql, appointmentsSql, warmLeadsSql } from "../src/lib/reports/detailQueries";
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
// How far back an INCREMENTAL run re-aggregates changed days. The source tables churn updatedAt on OLD
// rows continuously (CDC re-emission — e.g. `conversations` touches ~17 distinct days back to two months
// ago every hour), so a delta-by-updatedAt that honored the full MAX_LOOKBACK re-aggregated the entire
// history every 30 min (20 chunks, 12-17 min/run — mostly redundant). Incremental now only reprocesses
// changed days within this recent window (where genuinely-new activity lands); the daily FULL reconcile
// (FULL_RECONCILE_DAYS) picks up any older changed day within ≤24h. The watermark still advances past ALL
// churn each run, so old days are never re-scanned by incremental.
const INCREMENTAL_LOOKBACK = Number(process.env.INCREMENTAL_LOOKBACK_DAYS) || 7;

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
  const teamsArg = (args.find((a) => a.startsWith("--teams=")) || "").split("=")[1];
  const enterpriseArg = (args.find((a) => a.startsWith("--enterprise=")) || "").split("=")[1];
  const fileArg = args.find((a) => !a.startsWith("--"));
  const hotDays = daysArg || Number(process.env.SYNC_WINDOW_DAYS) || 3;
  const today = todayUTC();
  const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

  /* Resolve the scope, if any: explicit team ids plus every rooftop of an enterprise. A scoped run is
   * additive-only (no delete) — see the SCOPED MODE note in the header. */
  const scopeIds = new Set<string>((teamsArg ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  if (enterpriseArg) {
    const teams = await queryRows<{ team_id: string }>(
      `SELECT DISTINCT team_id FROM eventila.enterprise_team_details FINAL
       WHERE enterprise_id = '${enterpriseArg.replace(/'/g, "''")}' AND team_id != ''`,
    );
    for (const t of teams) if (t.team_id) scopeIds.add(String(t.team_id));
    console.log(`scope: enterprise ${enterpriseArg} → ${teams.length} rooftop(s)`);
  }
  const scoped = scopeIds.size > 0;
  if (scoped) {
    if (teamsArg !== undefined && !scopeIds.size) { console.error("--teams= given but empty"); process.exit(1); }
    console.log(`SCOPED run over ${scopeIds.size} team(s) — deletes carry team_id IN scope; no watermark advance, no detail rebuild.`);
  }
  // Quoted list for the spine wrapper. Team ids are opaque ids from our own control plane, but they
  // reach here from argv, so escape rather than trust.
  const scopeSqlList = [...scopeIds].map((t) => `'${t.replace(/'/g, "''")}'`).join(", ");

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
    const spine = loadSpineSql(`toDate('${shiftDays(a, -1)}')`, `toDate('${shiftDays(b, 1)}')`, [...scopeIds]);
    // Scoped: filter in ClickHouse, not in Node — the whole point is to move only the target rooftops'
    // rows over the wire. The spine aliases its team column with a literal dot (see agentBaseFact.sql),
    // hence the backticks.
    const raw = await queryRows<RawRow>(
      scoped ? `SELECT * FROM (\n${spine}\n) WHERE \`cs.team_id\` IN (${scopeSqlList})` : spine,
    );
    if (!raw.length) { console.log(`  [${a} .. ${b})  0 spine rows — skip`); return 0; }
    // Cross-tenant isolation: a scoped run must never carry a rooftop it wasn't asked for. Upserts are
    // keyed on team_id, so a leaked row would write into another dealer's report. Abort the chunk.
    if (scoped) {
      const strays = teamsInRows(raw).filter((t) => !scopeIds.has(t));
      if (strays.length) throw new Error(`scope leak — spine returned team(s) outside scope: ${strays.join(",")}`);
    }
    // Lazily acquire store-local tz for any rooftop not yet in the persisted map (usually none). The
    // get-working-days endpoint needs NO token (see tzMap.ts), so this must NOT be gated on
    // SPYNE_API_TOKEN — the token-less sync is the NORMAL case, and gating it here left every brand-new
    // rooftop stuck on UTC bucketing: its store-local window then disagreed with UTC-bucketed activity_day,
    // so "Yesterday" bled today's data and windowed leads mis-counted (RETCONVAI-4152/4151). We forward the
    // token when present (harmless) but never require it.
    const token = process.env.SPYNE_API_TOKEN;
    const missing = teamsInRows(raw).filter((t) => !tzMap.has(t));
    if (missing.length) {
      try {
        const live = await fetchTeamTzs(missing, token);
        if (live.size) { await saveTzMap(sb, live, new Date().toISOString()); for (const [k, v] of live) tzMap.set(k, v); }
      } catch { /* keep persisted */ }
    }
    const { earliest } = await mergeStlEarliest(sb, raw, { full: false, dayOf });
    // Re-bucket whenever we have ANY tz (check the map LIVE, not the once-computed `reBucket`, so teams
    // just resolved lazily above are bucketed store-local this same chunk). tzOf → undefined for an
    // unknown team, and storeLocalDay falls back to the UTC rawDay, so this is always safe.
    const agg = aggregate(raw, { tzOf: tzMap.size ? tzOf : undefined, stlEarliest: earliest });
    const inRange = (d: { activity_day: string }) => d.activity_day >= a && d.activity_day < b;
    const daily = agg.daily.filter(inRange);
    const breakdown = agg.breakdown.filter(inRange);
    const leadDays = agg.leadDays.filter(inRange);
    // Partition-replace. The unscoped delete carries NO team predicate — correct for a reconcile that
    // recomputes every rooftop for these days, catastrophic for a scoped run, which would delete the
    // whole fleet's rows and reinsert only the scope's. A scoped run adds `team_id IN scope` so the
    // delete can only ever reach rows it is about to rewrite. See SCOPED MODE in the header.
    for (const t of ["agent_daily", "agent_daily_breakdown", "agent_lead_days"]) {
      const q = sb.from(t).delete().gte("activity_day", a).lt("activity_day", b);
      const { error } = await (scoped ? q.in("team_id", [...scopeIds]) : q);
      if (error) throw new Error(`${t} delete [${a},${b})${scoped ? " (scoped)" : ""}: ${error.message}`);
    }
    await insertAll(sb, "agent_daily", daily, PK.agent_daily);
    await insertAll(sb, "agent_daily_breakdown", breakdown, PK.agent_daily_breakdown);
    await insertAll(sb, "agent_lead_days", leadDays, PK.agent_lead_days);
    console.log(`  [${a} .. ${b})  ${raw.length} spine → ${daily.length} daily, ${breakdown.length} bd, ${leadDays.length} ld`);
    return daily.length;
  }

  // ── dev convenience: aggregate a local dump as a single window (no chunking) ──
  // Refused under a scope: this path wipes all three tables all-time and rebuilds from the dump, the
  // exact opposite of additive — combining it with --teams/--enterprise would erase the fleet.
  if (fileArg && scoped) { console.error("--teams/--enterprise cannot be combined with a file dump (that path is a full all-time replace)"); process.exit(1); }
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
  // A segment of a long backfill, or any scoped run — don't touch the watermark or the fleet-wide
  // detail snapshots. Scoped is included because those snapshots are full-replace: rebuilding them
  // from a team-scoped pull would blank every rooftop outside the scope.
  const historical = Boolean(fromArg) || scoped;
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
      // Advance the watermark past ALL churn in the full MAX_LOOKBACK window (the delta scan is a cheap
      // column read) — so old changed days are ACKNOWLEDGED and never re-scanned by the next incremental.
      newWatermark = changed > 0 && delta[0]?.new_watermark ? String(delta[0].new_watermark) : watermark;
      // …but only RE-AGGREGATE changed days within the recent INCREMENTAL_LOOKBACK window, PLUS the hot
      // window. Older changed days (constant CDC updatedAt churn) are left to the daily FULL reconcile —
      // this is what keeps a run at ~2-3 chunks (~3 min) instead of re-doing 2-4 months every 30 min.
      const incFloor = shiftDays(today, -(INCREMENTAL_LOOKBACK - 1));
      const days = new Set<string>(Array.isArray(delta[0]?.days) ? delta[0]!.days.map(String).filter((d) => d >= incFloor) : []);
      for (let d = hotFloor; d <= today; d = shiftDays(d, 1)) days.add(d);
      for (const d of [...days].sort()) {
        const last = ranges[ranges.length - 1];
        if (last && d < shiftDays(last[0], CHUNK_DAYS)) last[1] = shiftDays(d, 1);
        else ranges.push([d, shiftDays(d, 1)]);
      }
      // Hot-window chunks FIRST: the watermark only advances after every range in this run finishes
      // (see below), so an oversized historical backlog (e.g. a bulk updatedAt touch far in the past)
      // can make a single run exceed the job timeout. If oldest-first order left the hot window last,
      // a killed run would leave reports stale on the very days digests/dashboards read "today" from —
      // every subsequent run re-derives the same backlog and dies again before ever reaching it. STL
      // earliest-per-lead is a running min against persisted state (mergeStlEarliest), so it's correct
      // regardless of chunk order — only relative order WITHIN the hot vs. backlog groups matters for
      // the ≤CHUNK_DAYS merge above, which is preserved here (still oldest-first inside each group).
      ranges.sort((a, b) => {
        const aHot = a[1] > hotFloor, bHot = b[1] > hotFloor;
        if (aHot !== bHot) return aHot ? -1 : 1;
        return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
      });
      console.log(`INCREMENTAL: watermark=${watermark}, changed_rows=${changed}, ${days.size} day(s) in last ${INCREMENTAL_LOOKBACK}d → ${ranges.length} chunk(s) (≤${CHUNK_DAYS}d each, hot window first; older changed days deferred to daily FULL reconcile).`);
    }
  }

  // ── walk the chunks (hot window first); force GC between them so a long run never accumulates heap ──
  // Per-chunk try/catch is LOAD-BEARING: without it, one chunk throwing (a transient ClickHouse/Supabase
  // blip, an oversized scan) aborts the whole IIFE before the watermark write below — so the next run
  // re-derives the identical backlog and dies again, an infinite stall that freezes the aggregate (this
  // is exactly what happened 2026-07-14→15: a 94-day / 101k-row updatedAt touch produced a backlog no
  // single run could finish, and the watermark never moved). Isolating failures lets the run reach the
  // watermark write, so progress is never lost; failed days are picked up by the next run (their rows
  // still trip the delta) or the daily FULL reconcile. A partial run is flagged (last_status='partial').
  let totalDaily = 0;
  const failedChunks: string[] = [];
  const gc = (globalThis as { gc?: () => void }).gc;
  const runChunk = async (a: string, b: string) => {
    try {
      totalDaily += await syncChunk(a, b);
    } catch (e) {
      failedChunks.push(`[${a},${b})`);
      console.warn(`  ✗ chunk [${a} .. ${b}) FAILED (isolated, run continues): ${(e as Error).message}`);
    }
    if (gc) gc();
  };
  // firstStart/lastEnd span the FULL range set, order-independent (the hot-first sort above means
  // ranges[0] is no longer the oldest, so min/max — not ranges[0]/ranges[-1] — give the true span the
  // detail-snapshot floor relies on).
  const firstStart = ranges.length ? ranges.map((r) => r[0]).reduce((a, b) => (a < b ? a : b)) : today;
  const lastEnd = ranges.length ? ranges.map((r) => r[1]).reduce((a, b) => (a > b ? a : b)) : shiftDays(today, 1);

  // Process the hot window FIRST, then CHECKPOINT the watermark before the (OOM/timeout-prone) backlog.
  // A per-chunk try/catch only rescues CATCHABLE errors — it cannot save a hard process kill (OOM at the
  // 8 GB heap ceiling, or the job timeout), which is what a bulk `updatedAt` touch produces: the process
  // dies mid-backlog and the end-of-run watermark write never happens, so every subsequent run re-derives
  // the identical 94-day backlog and dies the same way — the exact 07-14→15 stall. Committing the
  // watermark right after the light hot window makes forward progress UNCONDITIONAL: even if the backlog
  // then OOMs, the watermark has advanced, so the NEXT run sees only a tiny delta (no giant backlog) and
  // completes cleanly — the stall self-heals within one cycle. Recent-day freshness is also guaranteed
  // (hot window ran + committed first). Genuinely-changed backlog days are reconciled by a later run's
  // delta or the daily FULL pass; CDC-noise touches (updatedAt bumped, data identical) need no work.
  const hotBoundary = shiftDays(today, -(hotDays - 1));
  const hotRanges = ranges.filter(([, b]) => b > hotBoundary);
  const backlogRanges = ranges.filter(([, b]) => !(b > hotBoundary));
  for (const [a, b] of hotRanges) await runChunk(a, b);
  if (!historical && newWatermark) {
    const { error } = await sb.from("sync_state")
      .update({ watermark: newWatermark, last_run_at: new Date().toISOString(), last_status: "hot-committed" })
      .eq("id", 1);
    if (error) console.warn(`  ! watermark checkpoint failed (will retry at end of run): ${error.message}`);
    else console.log(`  ✓ hot window committed — watermark checkpointed to ${newWatermark} before ${backlogRanges.length} backlog chunk(s)`);
  }
  for (const [a, b] of backlogRanges) await runChunk(a, b);

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
    // AI-booked appointment snapshot (revived report_appointments) — the digest's appt list + top vehicles.
    // FIXED 120d floor (not firstStart): this is a full delete+replace snapshot, so it must always hold the
    // last ~120 days of bookings regardless of the incremental watermark window — else an incremental run
    // whose window starts today would wipe yesterday's appointments from the snapshot.
    const appts = await queryRows<Record<string, unknown>>(appointmentsSql({}));
    const apptRows = appts
      .map((a) => ({ team_id: String(a.team_id ?? ""), enterprise_id: (a.enterprise_id as string) ?? null, service_type: (a.service_type as string) ?? null, lead_id: (a.lead_id as string) ?? null, meeting_id: (a.meeting_id as string) ?? null, customer_name: a.customer_name ?? null, phone: a.phone ?? null, vehicle: a.vehicle ?? null, intent: a.intent ?? null, meeting_start: a.meeting_start ?? null, booked_at: a.booked_at ?? null, status: a.status ?? null, assisted: num(a.assisted) > 0, direction: a.direction ?? null, booked_via: a.booked_via ?? null }))
      .filter((r) => r.team_id && r.meeting_id);
    // Named warm leads ("Work these now"). Same FIXED-floor rationale as appointments: a "now" snapshot
    // (45d), never the incremental watermark window.
    const warm = await queryRows<Record<string, unknown>>(warmLeadsSql({}));
    const warmRows = warm
      .map((w) => ({ team_id: String(w.team_id ?? ""), source: (w.source as string) ?? null, service_type: (w.service_type as string) ?? null, lead_id: (w.lead_id as string) ?? null, tier: (w.tier as string) ?? null, customer_name: w.customer_name ?? null, phone: w.phone ?? null, campaign: w.campaign ?? null, outcome: w.outcome ?? null, last_activity: w.last_activity ?? null }))
      .filter((r) => r.team_id && (r.customer_name || r.phone));
    for (const [t, rows] of [["report_campaigns", campRows], ["report_outcomes", outcomeRows], ["report_callbacks", cbRows], ["report_appointments", apptRows], ["report_warm_leads", warmRows]] as const) {
      const { error } = await sb.from(t).delete().gte("synced_at", "1900-01-01");
      if (error) throw new Error(`${t} delete: ${error.message}`);
      await insertAll(sb, t, rows);
    }
    console.log(`detail: ${campRows.length} campaigns + ${outcomeRows.length} outcomes + ${cbRows.length} callbacks + ${apptRows.length} appointments + ${warmRows.length} warm leads synced.`);
  } catch (e) {
    console.warn(`detail sync skipped: ${(e as Error).message}`);
  }

  // Advance the watermark only for live runs (full/incremental). A historical segment must not move it —
  // the incremental watermark tracks "changes processed up to now", which a backfill of old days doesn't.
  // We advance EVEN ON A PARTIAL run (some chunks failed): the alternative — holding the watermark until a
  // fully-clean run — is what caused the 07-14 stall, since a persistently-failing chunk pins the watermark
  // and every run reprocesses the whole backlog forever. Advancing stops that; failed days are flagged
  // (last_status='partial') and reconciled by the daily FULL pass. Hot-window-first ordering means a
  // failure is almost always an old backlog chunk, so recent-day freshness is unaffected.
  const partial = failedChunks.length > 0;
  const update: Record<string, unknown> = {
    last_run_at: new Date().toISOString(),
    last_status: partial ? "partial" : "ok",
    rows_synced: totalDaily, window_start: firstStart,
    error: partial ? `partial: ${failedChunks.length}/${ranges.length} chunk(s) failed: ${failedChunks.join(",")}`.slice(0, 500) : null,
  };
  if (!historical) update.watermark = newWatermark || new Date().toISOString();
  /* sync_state is the FLEET health record — /api/sync-health and anyone debugging the ETL read it. A
   * SCOPED run covers a handful of rooftops on purpose, so its status says nothing about the fleet:
   * writing "partial: 6/27 chunks failed" there after a one-enterprise backfill sends the next person
   * chasing a fleet-wide failure that never happened (observed 2026-09-02). Scoped runs therefore
   * report to the console only. Unscoped historical segments still post status — they DO cover the
   * whole fleet for their window; they just must not move the watermark. */
  if (scoped) {
    console.log(`sync_state left untouched (scoped run — fleet health record is not ours to set).`);
  } else {
    await sb.from("sync_state").update(update).eq("id", 1);
  }
  console.log(`done. ${totalDaily} daily rows across ${firstStart} .. ${lastEnd} in ${ranges.length} chunk(s)${partial ? ` — PARTIAL (${failedChunks.length} failed: ${failedChunks.join(",")})` : ""}.${scoped ? " (scoped)" : historical ? " (segment)" : ` watermark=${update.watermark}`}`);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
