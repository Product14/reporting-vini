/* Pull Q12227 and materialize the Supabase reporting aggregate, using the SAME aggregate.ts the app
 * uses. Two modes:
 *
 *   npx tsx scripts/backfill.ts                 # INCREMENTAL (default): per-day pulls over the last
 *                                               # SYNC_WINDOW_DAYS days (~3MB/day), replace that window
 *   npx tsx scripts/backfill.ts --full          # FULL: one 382MB pull, rebuild the whole table
 *   npx tsx scripts/backfill.ts --days=7         # incremental over a custom trailing window
 *   npx tsx scripts/backfill.ts /tmp/q.json      # aggregate a local full dump (dev convenience)
 *
 * The GitHub Actions cron runs the default (incremental) — cheap enough to run often. Use --full once
 * for the initial backfill or a periodic reconcile. Env (process.env or auto-loaded from .env.local):
 * METABASE_SITE_URL, METABASE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * METABASE_RAW_DATE_PARAM (default "activity_day"), SYNC_WINDOW_DAYS (default 3). */
import fs from "node:fs";
import crypto from "node:crypto";
import { Agent } from "undici";
import { createClient } from "@supabase/supabase-js";
import { aggregate } from "../src/lib/reports/aggregate";
import { mergeStlEarliest, reconcileHistoricalStl } from "../src/lib/reports/stlSync";
import { fetchTzMap, storeLocalDay } from "../src/lib/reports/tzMap";
import type { RawRow } from "../src/lib/reports/schema";

const RAW_QUESTION = 12227;

function loadEnv() {
  if (!fs.existsSync(".env.local")) return;
  for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();

const SITE = process.env.METABASE_SITE_URL!;
const SECRET = process.env.METABASE_SECRET_KEY!;
const SB_URL = process.env.SUPABASE_URL!;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const DATE_PARAM = process.env.METABASE_RAW_DATE_PARAM || "activity_day";
for (const [k, v] of Object.entries({ METABASE_SITE_URL: SITE, METABASE_SECRET_KEY: SECRET, SUPABASE_URL: SB_URL, SUPABASE_SERVICE_ROLE_KEY: SB_KEY }))
  if (!v) { console.error(`Missing env: ${k}`); process.exit(1); }

const b64 = (s: string) => Buffer.from(s).toString("base64url");
function sign(payload: object): string {
  const h = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const b = b64(JSON.stringify(payload));
  const d = `${h}.${b}`;
  return `${d}.${crypto.createHmac("sha256", SECRET).update(d).digest("base64url")}`;
}
const todayUTC = () => new Date().toISOString().slice(0, 10);
const shiftDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function fetchRows(params: Record<string, string>): Promise<RawRow[]> {
  const token = sign({ resource: { question: RAW_QUESTION }, params, exp: Math.round(Date.now() / 1000) + 1800 });
  const res = await fetch(`${SITE}/api/embed/card/${token}/query/json`, {
    cache: "no-store",
    dispatcher: new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 60_000 } }),
  } as RequestInit);
  const text = await res.text();
  if (!res.ok) throw new Error(`Metabase HTTP ${res.status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text);
  if (!Array.isArray(json)) throw new Error(`Expected array, got: ${text.slice(0, 200)}`);
  return json as RawRow[];
}

// Pull any embeddable card (the rooftop-level detail cards are pre-aggregated; no date param).
async function fetchCard(id: number, params: Record<string, string> = {}): Promise<Record<string, unknown>[]> {
  // These cards' params (team_id/agent_type/…) are EDITABLE → pass via URL; locking them in the token errors.
  const token = sign({ resource: { question: id }, params: {}, exp: Math.round(Date.now() / 1000) + 1800 });
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${SITE}/api/embed/card/${token}/query/json${qs ? `?${qs}` : ""}`, {
    cache: "no-store",
    dispatcher: new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 60_000 } }),
  } as RequestInit);
  const text = await res.text();
  if (!res.ok) throw new Error(`card ${id} HTTP ${res.status}: ${text.slice(0, 120)}`);
  const json = JSON.parse(text);
  if (!Array.isArray(json)) throw new Error(`card ${id} not an array`);
  return json as Record<string, unknown>[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function insertAll(sb: any, table: string, rows: object[]) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from(table).insert(rows.slice(i, i + 500));
    if (error) throw new Error(`${table} insert @${i}: ${error.message}`);
  }
  console.log(`  ${table}: ${rows.length} inserted`);
}

(async () => {
  const args = process.argv.slice(2);
  const full = args.includes("--full");
  const daysArg = Number((args.find((a) => a.startsWith("--days=")) || "").split("=")[1]);
  const fileArg = args.find((a) => !a.startsWith("--"));
  const days = daysArg || Number(process.env.SYNC_WINDOW_DAYS) || 3;
  const today = todayUTC();

  // Resolve store timezones up front. Non-empty → re-bucket activity_day by store-local day.
  const tzMap = await fetchTzMap();
  const reBucket = tzMap.size > 0;
  const tzOf = (teamId: string) => tzMap.get(teamId);
  const dayOf = (team: string, activityTs: string, rawDay: string) => storeLocalDay(activityTs, tzOf(team), rawDay);
  if (reBucket) console.log(`tz: ${tzMap.size} rooftops mapped → store-local re-bucketing ON`);
  else console.log("tz: SPYNE_API_TOKEN unset or fetch failed → UTC bucketing (no re-bucket)");

  // windowStart = where we delete-and-replace from (matched on the FINAL, possibly re-bucketed,
  // activity_day). Full/file rebuilds replace everything.
  let windowStart = "1900-01-01";
  let raw: RawRow[];

  if (fileArg && fs.existsSync(fileArg)) {
    console.log("reading", fileArg);
    raw = JSON.parse(fs.readFileSync(fileArg, "utf8")) as RawRow[];
  } else if (full) {
    console.log("FULL pull (382MB)…");
    raw = await fetchRows({});
  } else {
    windowStart = shiftDays(today, -(days - 1));
    // When re-bucketing, a store-local day draws from events whose UTC activity_day is ±1 — pull one
    // extra UTC day back so the store-local windowStart is fully covered (the future edge is the usual
    // "today lags" tail). The output filter below trims anything that re-buckets before windowStart.
    const pullStart = reBucket ? shiftDays(windowStart, -1) : windowStart;
    console.log(`INCREMENTAL pull, ${pullStart}..${today} (param "${DATE_PARAM}", replace from ${windowStart})…`);
    raw = [];
    for (let d = pullStart; d <= today; d = shiftDays(d, 1)) {
      const dayRows = await fetchRows({ [DATE_PARAM]: d });
      console.log(`  ${d}: ${dayRows.length} rows`);
      raw.push(...dayRows);
    }
  }

  console.log("raw rows:", raw.length);
  if (!raw.length) throw new Error("0 raw rows across the window — refusing to wipe the aggregate");

  const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

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
  console.log("daily:", daily.length, " breakdown:", breakdown.length);

  for (const t of ["agent_daily", "agent_daily_breakdown"]) {
    const { error } = await sb.from(t).delete().gte("activity_day", windowStart);
    if (error) throw new Error(`${t} delete: ${error.message}`);
  }
  await insertAll(sb, "agent_daily", daily);
  await insertAll(sb, "agent_daily_breakdown", breakdown);

  // ── rooftop-level detail: appointments (12233) + callbacks (12234) + campaigns (12232) → detail
  //    tables. 12233/12234 carry a rooftop NAME (mapped to team_id via the map Q12227 carries);
  //    12232 now carries team_id directly. Best-effort: a failure here (e.g. migration 0002 not
  //    applied yet) must NOT fail the main aggregate sync above. ──
  try {
    const rooftopToTeam = new Map<string, string>();
    for (const r of raw) {
      const name = String(r.rooftop_name || "").trim();
      const team = String(r["cs.team_id"] || "");
      if (name && team && !rooftopToTeam.has(name)) rooftopToTeam.set(name, team);
    }
    const mapTeam = (rooftop: unknown) => rooftopToTeam.get(String(rooftop || "").trim());
    const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

    const appts = await fetchCard(12233);
    const apptRows = appts
      .map((a) => ({ team_id: mapTeam(a.rooftop), customer_name: a.customer_name ?? null, appointment_time: a.appointment_time ?? null, vehicle: a.vehicle ?? null, status: a.status ?? null, assigned_to: a.assigned_to ?? null, booked_at: a.booked_at ?? null }))
      .filter((r) => r.team_id);
    const cbs = await fetchCard(12234);
    const cbRows = cbs
      .map((c) => ({ team_id: mapTeam(c.rooftop), customer_name: c.customer_name ?? null, callback_due: c.callback_due ?? null, intent: c.intent ?? null, priority: c.priority ?? null, assigned_to: c.assigned_to ?? null, requested_on: c.requested_on ?? null }))
      .filter((r) => r.team_id);
    // 12232 has no sales/service column, but filters by agent_type → pull per outbound agent and TAG it,
    // so build.ts can show sales campaigns under Sales OB and service campaigns under Service OB.
    let camps: Record<string, unknown>[] = [];
    const campRows: object[] = [];
    for (const at of ["Sales Outbound", "Service Outbound"]) {
      const rows = await fetchCard(12232, { agent_type: at });
      camps = camps.concat(rows);
      for (const c of rows) {
        const team = String(c.team_id ?? ""), campaign = String(c.campaign ?? "");
        if (team && campaign) campRows.push({ team_id: team, agent_type: at, campaign, use_case: c.use_case ?? null, enrolled: n(c.enrolled), appointments: n(c.appointments), warm_leads: n(c.warm_leads), opt_outs: n(c.opt_outs), no_reach: n(c.no_reach), appt_rate_pct: c.appt_rate_pct ?? null });
      }
    }

    for (const [t, rows] of [["report_appointments", apptRows], ["report_callbacks", cbRows], ["report_campaigns", campRows]] as const) {
      const { error: delErr } = await sb.from(t).delete().gte("synced_at", "1900-01-01");
      if (delErr) throw new Error(`${t} delete: ${delErr.message}`);
      await insertAll(sb, t, rows);
    }
    console.log(`detail: ${apptRows.length}/${appts.length} appointments + ${cbRows.length}/${cbs.length} callbacks + ${campRows.length}/${camps.length} campaigns synced.`);
  } catch (e) {
    console.warn(`detail sync skipped: ${(e as Error).message} — has migration 0002 been applied?`);
  }

  await sb.from("sync_state").update({
    last_run_at: new Date().toISOString(), last_status: "ok", rows_synced: daily.length, window_start: windowStart, error: null,
  }).eq("id", 1);
  console.log(`done (${full || fileArg ? "full" : "incremental"}). ${daily.length} daily + ${breakdown.length} breakdown rows from ${windowStart}.`);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
