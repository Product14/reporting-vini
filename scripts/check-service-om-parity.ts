/* Service OM: does the Overview match Reports on every live Service rooftop?
 *
 * The gate before the Service OM pages are committed or merged (user, 2026-10-13). For every rooftop with a
 * live Service agent and every window, it loads BOTH pages' data through the pages' own loaders
 * (src/lib/serviceOm/source.ts), builds BOTH pages' numbers with their own models (overviewModel.ts,
 * reportsModel.ts), and checks:
 *   available   the Overview's Appointments headline is a number, not "not available"
 *   headline    Overview "Appointments" = Reports' agents' visits booked + unplaced (A1, A6)
 *   agents      the same agents on both pages
 *   by agent    Booked by Spyne / Assisted by Spyne / visits booked equal, agent by agent
 *   funnel      the Reports funnel's Booked (appointments) = visits booked
 *   lists       each clickable number opens exactly that many appointments (A9), asking only for the types
 *               the number counted (no Spyne-assisted where it isn't available)
 *   trend       the 7-day trend's days add up to its own call's Booked by Spyne (doc rule 9), and on the
 *               Last 7 days window its total equals the agent's visits booked
 *   funnel      every funnel pours (no stage above the one before it); no booking rate over 100%
 *   all reports each Your agents card shows the agent report's own calls, middle stage and Booked
 * Per rooftop-window the CSV also records, for review rather than pass/fail: both funnels with any top-ups,
 * unplaced bookings, whether Spyne-assisted is available, and how long the read took.
 *   operations  Action items open / past SLA equal; the Overview's upcoming rows lead Reports' list
 * Every failure is read again once before it counts: the API sends no asOf, and a booking landing between the
 * two reads, or Om's booking classification degrading on one read, would otherwise look like a mismatch.
 *
 * "Live" = an active Service agent mapping AND at least one real (non-test) call on it in the last --days,
 * on a rooftop that is not a test account. From ClickHouse, the same tables the reports read.
 *
 * Usage (from the repo root):
 *   npx tsx scripts/check-service-om-parity.ts                                  sample data, every live rooftop
 *   SERVICE_OM_TOKEN=<token> npx tsx scripts/check-service-om-parity.ts --source=api [--env=prod|uat|stag]
 * Options:
 *   --teams=a,b            only these rooftops (still looked up in ClickHouse for enterprise and timezone)
 *   --rooftops=team:enterprise[:timezone],…   these rooftops exactly, without ClickHouse: for a rooftop that
 *                          isn't in prod's data, like Om's UAT test rooftop (678958236:12a63b492). Both agents
 *                          are assumed live.
 *   --windows=today,last7,last30,mtd   the default. Lifetime (the last 366 days, the API's limit) is left out
 *                          because it is the slowest window (big rooftops' lists run to many pages): run it on
 *                          its own afterwards with --windows=lifetime. Also accepted: yesterday, last14.
 *   --days=30              how recent a real call must be for a rooftop to count as live
 *   --concurrency=4        rooftop × window checks in flight at once
 *   --max-requests=10      HTTP requests in flight against Om's API at once, whatever --concurrency is (each
 *                          rooftop × window makes ~11 calls plus its lists). Agree the number with Om.
 *   --assisted=off         sample data only: answer the way UAT does today, Spyne-assisted not available
 *   --out=<file.csv>       default service-om-parity-<windows>.csv, so a Lifetime run keeps its own file
 *
 * Reads only. The output is counts and ids, never customer names or phones. CLICKHOUSE_* come from the
 * environment or .env.local. Exit code 1 when anything fails, so it can gate a pipeline. */

import fs from "node:fs";
import type { Bucket } from "@/components/reports/data";
import { compare, type Check } from "@/lib/serviceOm/parity";
import type { OmSource } from "@/lib/serviceOm/source";

/* ── env + args ─────────────────────────────────────────────────────────────────────────────────── */
function loadEnvLocal() {
  if (!fs.existsSync(".env.local")) return;
  for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}

const arg = (name: string, fallback: string): string => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const BUCKETS: Bucket[] = ["today", "yesterday", "last7", "last14", "last30", "mtd", "lifetime"];

/* ── rooftops ───────────────────────────────────────────────────────────────────────────────────── */
interface Rooftop {
  teamId: string;
  enterpriseId: string;
  name: string;
  timezone: string;
  inbound: boolean;
  outbound: boolean;
}

const liveRooftopsSql = (days: number) => `
  WITH svc AS (
    SELECT m.teamAgentMappingId AS id, m.teamId AS team_id, m.enterpriseId AS enterprise_id,
           lower(ifNull(t.agentCallType, '')) = 'outbound' AS is_ob
    FROM dealer_leads.teamAgentMappings AS m FINAL
    INNER JOIN (SELECT agentTypeId, agentCallType FROM dealer_leads.agentTypes FINAL WHERE __deleted = 0 AND agentType = 'Service') AS t
      ON t.agentTypeId = m.agentTypeId
    WHERE m.__deleted = 0 AND m.isActive = 1 AND ifNull(m.teamAgentMappingId, '') != ''
  ),
  calls AS (
    SELECT teamAgentMappingId AS id, count() AS n
    FROM dealer_leads.endcallreports
    WHERE __deleted = 0 AND isActive = 1 AND (isTestCall = 0 OR isTestCall IS NULL)
      AND createdAt >= now() - INTERVAL ${Math.max(1, Math.floor(days))} DAY
      AND teamAgentMappingId IN (SELECT id FROM svc)
    GROUP BY id
  )
  SELECT s.team_id AS team_id, any(s.enterprise_id) AS enterprise_id,
         any(d.team_name) AS team_name, any(ifNull(d.timezone, '')) AS timezone,
         sumIf(c.n, NOT s.is_ob) AS ib_calls, sumIf(c.n, s.is_ob) AS ob_calls
  FROM svc AS s
  INNER JOIN calls AS c ON c.id = s.id
  LEFT JOIN (SELECT team_id, team_name, timezone, is_test_account FROM eventila.enterprise_team_details FINAL WHERE _peerdb_is_deleted = 0) AS d
    ON d.team_id = s.team_id
  WHERE ifNull(d.is_test_account, 0) = 0
  GROUP BY s.team_id
  HAVING ib_calls + ob_calls > 0
  ORDER BY team_name`;

async function liveRooftops(days: number): Promise<Rooftop[]> {
  const { queryRows, hasClickhouseCreds } = await import("@/lib/reports/clickhouseQuery");
  if (!hasClickhouseCreds()) throw new Error("No CLICKHOUSE_* credentials (env or .env.local): can't list the live Service rooftops.");
  const rows = await queryRows<{ team_id: string; enterprise_id: string; team_name: string; timezone: string; ib_calls: number | string; ob_calls: number | string }>(liveRooftopsSql(days));
  return rows.map((r) => ({
    teamId: r.team_id,
    enterpriseId: r.enterprise_id,
    name: r.team_name || r.team_id,
    timezone: r.timezone,
    inbound: Number(r.ib_calls) > 0,
    outbound: Number(r.ob_calls) > 0,
  }));
}

/* ── one rooftop × window ───────────────────────────────────────────────────────────────────────── */
interface Result {
  rooftop: Rooftop;
  bucket: Bucket;
  status: "PASS" | "FAIL" | "ERROR";
  unplaced?: number;
  assistedAvailable?: boolean;
  inboundFunnel?: string;
  outboundFunnel?: string;
  topUps?: number;
  overviewTotal: number | null;
  reportsTotal: number | null;
  failures: Check[];
  asOfOverview: string | null;
  asOfReports: string | null;
  retried: boolean;
  ms: number;
}

async function checkOne(source: OmSource, r: Rooftop, bucket: Bucket, token: string, env: string, assistedOff: boolean): Promise<Result> {
  const t0 = Date.now();
  const { loadOverview, loadReports, loadAppointmentList } = await import("@/lib/serviceOm/source");
  const { buildServiceOverview, countedTypes } = await import("@/lib/serviceOm/overviewModel");
  const { buildServiceReports } = await import("@/lib/serviceOm/reportsModel");
  const { resolveWindow } = await import("@/lib/serviceOm/window");
  const { MOCK_TZ } = await import("@/lib/serviceOm/mock");
  // The window the page ends on: the rooftop's own days (sample data runs in its own timezone, like the page).
  const w = resolveWindow(bucket, null, source === "mock" ? MOCK_TZ : r.timezone || null);
  const agents = [r.inbound ? "Service Inbound" : null, r.outbound ? "Service Outbound" : null].filter((x): x is string => !!x);
  const ctx = { teamId: r.teamId, enterpriseId: r.enterpriseId, spyneToken: token, spyneEnv: env, nameHint: r.name, agents, mockAssistedOff: assistedOff };

  const read = async () => {
    const [ovResp, rpResp] = await Promise.all([loadOverview(source, ctx, w), loadReports(source, ctx, w)]);
    return { ov: buildServiceOverview(ovResp), rp: buildServiceReports(rpResp), rpResp };
  };
  try {
    let { ov, rp, rpResp } = await read();
    let checks = compare(ov, rp);
    let retried = false;
    if (checks.some((c) => !c.ok)) {
      retried = true;
      ({ ov, rp, rpResp } = await read());
      checks = compare(ov, rp);
    }
    // Rule 9: a grain=day call's days add up to its own totals.
    for (const [direction, t] of [["inbound", rpResp.trendInbound], ["outbound", rpResp.trendOutbound]] as const) {
      if (!t || !rp.agents.some((a) => a.direction === direction)) continue;
      const days = (t.trend ?? []).reduce((n, d) => n + (d.bookedBySpyne ?? 0), 0);
      const total = t.metrics?.bookedBySpyne?.available ? t.metrics.bookedBySpyne.value : null;
      checks.push({ name: `${direction} trend days = its total`, ok: total !== null && days === total, detail: `days ${days}, total ${show(total)}` });
    }
    if (bucket === "last7") {
      for (const a of rp.agents) {
        const t = a.sections.trend7;
        // Without its assisted (UAT today), the trend is Booked by Spyne only, and so is the number it must equal.
        const expected = t && a.period.work.assistedCounted && !t.assistedIncluded ? a.period.work.bookedBySpyne : a.period.work.visitsBooked;
        checks.push({ name: `${a.direction} 7-day trend = visits booked`, ok: t !== null && t.total === expected, detail: `trend ${show(t?.total)}, expected ${show(expected)}` });
      }
    }
    // A9: the rows behind every clickable appointment number (the funnel's Booked opens the visits list).
    for (const a of rp.agents) {
      const pw = a.period.work;
      const lists: Array<[string, Array<"booked_by_spyne" | "spyne_assisted">, number | null]> = [
        ["booked by Spyne", ["booked_by_spyne"], pw.bookedBySpyne],
        ["assisted by Spyne", ["spyne_assisted"], pw.spyneAssisted],
        ["visits booked", countedTypes(pw), pw.visitsBooked],
      ];
      for (const [label, types, expected] of lists) {
        if (expected === null) continue;
        let list = await loadAppointmentList(source, ctx, w, { basis: "booked", direction: a.direction, types });
        let n = list ? list.items.length : null;
        let count: number | null = expected;
        if (n !== count) {
          // A booking can land between the count and the list (live data): read both again once before it counts.
          const again = buildServiceReports(await loadReports(source, ctx, w)).agents.find((x) => x.direction === a.direction)?.period.work;
          count = again ? (label === "booked by Spyne" ? again.bookedBySpyne : label === "assisted by Spyne" ? again.spyneAssisted : again.visitsBooked) : count;
          list = await loadAppointmentList(source, ctx, w, { basis: "booked", direction: a.direction, types });
          n = list ? list.items.length : null;
        }
        checks.push({ name: `${a.direction} ${label} list`, ok: n === count, detail: `number ${count}, list ${show(n)} rows` });
      }
    }
    // All reports: the Your agents cards read the agent report's own numbers.
    const { agentCardStats } = await import("@/components/serviceOm/reports/OmAgentCards");
    const { fmtInt } = await import("@/components/reports/data");
    for (const a of rp.agents) {
      const [calls, middle, booked] = agentCardStats(a);
      const want = [a.sections.activity[0]?.value ?? "—", a.funnel[1]?.customers == null ? "—" : fmtInt(a.funnel[1].customers), a.bookedAppointments === null ? "—" : fmtInt(a.bookedAppointments)];
      const got = [calls.value, middle.value, booked.value];
      checks.push({ name: `${a.direction} all-reports card`, ok: got.join("|") === want.join("|"), detail: `card ${got.join(" / ")}, report ${want.join(" / ")}` });
      const ovRow = ov.agents.rows.find((x) => x.direction === a.direction);
      checks.push({ name: `${a.direction} card booked = overview`, ok: booked.value === (ovRow?.visitsBooked == null ? "—" : fmtInt(ovRow.visitsBooked)), detail: `card ${booked.value}, overview ${show(ovRow?.visitsBooked)}` });
      const br = a.bookingRate?.value;
      checks.push({ name: `${a.direction} booking rate ≤ 100%`, ok: br === null || br === undefined || br <= 1, detail: `${show(a.bookingRate?.numerator)} ÷ ${show(a.bookingRate?.denominator)}` });
    }
    const funnelText = (d: "inbound" | "outbound") => {
      const a = rp.agents.find((x) => x.direction === d);
      return a ? a.funnel.map((st) => `${show(st.customers)}${st.topUp ? `(+${st.topUp})` : ""}`).join(">") : "";
    };
    const failures = checks.filter((c) => !c.ok);
    return {
      rooftop: r,
      bucket,
      status: failures.length ? "FAIL" : "PASS",
      unplaced: rp.appointments.unplaced,
      assistedAvailable: rp.appointments.spyneAssisted !== null,
      inboundFunnel: funnelText("inbound"),
      outboundFunnel: funnelText("outbound"),
      topUps: rp.agents.reduce((n, a) => n + a.funnel.reduce((m, st) => m + (st.topUp ?? 0), 0), 0),
      overviewTotal: ov.appointments.total,
      reportsTotal: rp.agents.reduce((n, a) => n + (a.period.work.visitsBooked ?? 0), 0) + rp.appointments.unplaced,
      failures,
      asOfOverview: ov.asOf,
      asOfReports: rp.asOf,
      retried,
      ms: Date.now() - t0,
    };
  } catch (e) {
    return { rooftop: r, bucket, status: "ERROR", overviewTotal: null, reportsTotal: null, failures: [{ name: "error", ok: false, detail: String(e).slice(0, 200) }], asOfOverview: null, asOfReports: null, retried: false, ms: Date.now() - t0 };
  }
}

/* ── run ────────────────────────────────────────────────────────────────────────────────────────── */
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>, onDone: (done: number) => void): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
        onDone(++done);
      }
    }),
  );
  return out;
}

const show = (v: unknown) => (v === null || v === undefined ? "n/a" : String(v));
const csvCell = (v: unknown) => {
  const s = show(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function main() {
  loadEnvLocal();
  const source = (arg("source", "mock") === "api" ? "api" : "mock") as OmSource;
  if (source === "mock") process.env.SERVICE_OM_MOCK_LATENCY_MS ??= "0";
  const maxRequests = Number(arg("max-requests", "10"));
  process.env.SERVICE_OM_MAX_REQUESTS ??= String(Math.max(1, maxRequests)); // read by api.ts when it loads
  const token = process.env.SERVICE_OM_TOKEN ?? "";
  if (source === "api" && !token) throw new Error("--source=api needs SERVICE_OM_TOKEN (a token that can read every rooftop).");
  const env = arg("env", "");
  const days = Number(arg("days", "30"));
  const asked = arg("windows", "today,last7,last30,mtd").split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = asked.filter((b) => !(BUCKETS as string[]).includes(b));
  if (unknown.length) throw new Error(`Unknown window(s): ${unknown.join(", ")}. Use: ${BUCKETS.join(", ")}.`);
  const windows = asked as Bucket[];
  const concurrency = Number(arg("concurrency", "4"));
  const outFile = arg("out", `service-om-parity-${windows.join("-")}.csv`);
  const assistedOff = source === "mock" && arg("assisted", "on") === "off";
  const only = arg("teams", "").split(",").map((s) => s.trim()).filter(Boolean);

  const explicit: Rooftop[] = arg("rooftops", "").split(",").map((s) => s.trim()).filter(Boolean).map((spec) => {
    const [teamId, enterpriseId, timezone = ""] = spec.split(":");
    if (!teamId || !enterpriseId) throw new Error(`--rooftops wants team:enterprise[:timezone], got "${spec}".`);
    return { teamId, enterpriseId, name: teamId, timezone, inbound: true, outbound: true };
  });
  const all = explicit.length ? explicit : await liveRooftops(days);
  const rooftops = only.length ? all.filter((r) => only.includes(r.teamId)) : all;
  const missing = only.filter((t) => !all.some((r) => r.teamId === t));
  console.log(`Service OM parity · source=${source}${env ? ` env=${env}` : ""} · ${rooftops.length} ${explicit.length ? "named" : "live Service"} rooftops (inbound ${rooftops.filter((r) => r.inbound).length}, outbound ${rooftops.filter((r) => r.outbound).length}) · windows ${windows.join(", ")} · ${concurrency} at a time${source === "api" ? ` · at most ${process.env.SERVICE_OM_MAX_REQUESTS} API requests in flight` : ""}`);
  if (missing.length) console.log(`Not live Service rooftops (skipped): ${missing.join(", ")}`);
  if (assistedOff) console.log("Spyne-assisted OFF, as on UAT today.");
  if (source === "mock") console.log("SAMPLE DATA: this proves the check and the pages' wiring, not Om's numbers. Re-run with --source=api once the endpoint is live.");

  const tasks = rooftops.flatMap((r) => windows.map((b) => ({ r, b })));
  const started = Date.now();
  const results = await pool(tasks, concurrency, ({ r, b }) => checkOne(source, r, b, token, env, assistedOff), (done) => {
    if (done % 25 === 0 || done === tasks.length) process.stdout.write(`  ${done}/${tasks.length} checked\n`);
  });

  const header = ["team_id", "rooftop", "window", "inbound", "outbound", "status", "overview_appointments", "reports_agents_plus_unplaced", "unplaced", "assisted_available", "inbound_funnel", "outbound_funnel", "top_ups", "failures", "as_of_overview", "as_of_reports", "retried", "ms"];
  const lines = [header.join(",")].concat(
    results.map((x) => [x.rooftop.teamId, x.rooftop.name, x.bucket, x.rooftop.inbound, x.rooftop.outbound, x.status, x.overviewTotal, x.reportsTotal, x.unplaced, x.assistedAvailable, x.inboundFunnel, x.outboundFunnel, x.topUps, x.failures.map((f) => `${f.name}: ${f.detail}`).join(" | "), x.asOfOverview, x.asOfReports, x.retried, x.ms].map(csvCell).join(",")),
  );
  fs.writeFileSync(outFile, lines.join("\n") + "\n");

  const pass = results.filter((x) => x.status === "PASS").length;
  const fail = results.filter((x) => x.status === "FAIL");
  const err = results.filter((x) => x.status === "ERROR");
  const roofFail = new Set([...fail, ...err].map((x) => x.rooftop.teamId));
  console.log(`\n${pass}/${results.length} rooftop-windows pass · ${fail.length} fail · ${err.length} error · ${roofFail.size}/${rooftops.length} rooftops with a problem · ${Math.round((Date.now() - started) / 1000)} s`);
  const byCheck = new Map<string, number>();
  for (const x of [...fail, ...err]) for (const f of x.failures) byCheck.set(f.name, (byCheck.get(f.name) ?? 0) + 1);
  if (byCheck.size) console.log(`Failures by check: ${[...byCheck.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" · ")}`);
  const ok = results.filter((x) => x.status !== "ERROR");
  console.log(`For review: ${ok.filter((x) => (x.topUps ?? 0) > 0).length} rooftop-windows needed a funnel top-up · Spyne-assisted unavailable on ${new Set(ok.filter((x) => x.assistedAvailable === false).map((x) => x.rooftop.teamId)).size} rooftops · slowest read ${Math.max(0, ...results.map((x) => x.ms))} ms`);
  for (const x of [...fail, ...err].slice(0, 40)) console.log(`  ${x.status} ${x.rooftop.name} (${x.rooftop.teamId}) · ${x.bucket} · ${x.failures.map((f) => `${f.name}: ${f.detail}`).join(" | ")}`);
  if (fail.length + err.length > 40) console.log(`  … ${fail.length + err.length - 40} more in ${outFile}`);
  if (source === "api") {
    const { requestStats } = await import("@/lib/serviceOm/api");
    console.log(`API requests: ${requestStats.total} made, at most ${requestStats.peak} in flight (cap ${process.env.SERVICE_OM_MAX_REQUESTS}).`);
  }
  console.log(`Full table: ${outFile}`);
  process.exitCode = fail.length + err.length ? 1 : 0;
}

main().catch((e) => {
  console.error(String(e));
  process.exitCode = 1;
});
