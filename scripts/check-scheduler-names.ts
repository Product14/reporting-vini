/* Sanity check: does every rooftop with a service scheduler get its scheduler's name in the appointments
 * popup ("Status not updated in Xtime"), and the rest "in the scheduler"?
 *
 * Rooftops: every rooftop with a service-scheduler integration (any status), plus every live Service rooftop
 * (the parity script's rule: an active Service mapping with a real call in the last --days, not a test
 * account), so a live rooftop without a scheduler is checked for the fallback too.
 *
 * Expected, from ClickHouse: the provider Om's show-rate endpoint picks (show-rate-metrics.service.ts
 * schedulerProvider(): lower(providerName) of the rooftop's service-scheduler integrations, status ignored,
 * a supported one first, else the first alphabetically), run through the page's own schedulerName() and
 * notUpdatedLabel() (src/lib/serviceOm/scheduler.ts).
 * Checks per rooftop:
 *   named     a rooftop with a scheduler gets a name, never the "in the scheduler" fallback
 *   known     the name is one of ours (scheduler.ts), not a title-cased guess
 *   api       (--source=api) the page's own call, apiSchedulerProvider(), returns the expected provider
 * For review, not pass/fail: integrations still pending (named, though the scheduler may not sync yet) and
 * rooftops with more than one scheduler.
 *
 * Usage (from the repo root):
 *   npx tsx scripts/check-scheduler-names.ts                                     data check (ClickHouse only)
 *   SERVICE_OM_TOKEN=<token> npx tsx scripts/check-scheduler-names.ts --source=api   plus Om's prod endpoint
 * Options: --env=prod|uat|stag · --days=30 · --max-requests=10 · --teams=a,b (only these team ids)
 *          --out=<file.csv> (default scheduler-names-<source>.csv)
 *
 * Reads only. The output is rooftop ids, names and scheduler names, no customer data. CLICKHOUSE_* come from
 * the environment or .env.local. Exit code 1 when anything fails. */

import fs from "node:fs";
import { isKnownScheduler, notUpdatedLabel, schedulerName } from "@/lib/serviceOm/scheduler";

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

/** show-rate's own order: a supported provider first, else the first alphabetically. */
const SUPPORTED_PROVIDERS = ["mykaarma", "cdk", "pbs", "tekion"];
const pickProvider = (providers: string[]): string | null =>
  SUPPORTED_PROVIDERS.find((p) => providers.includes(p)) ?? [...providers].sort()[0] ?? null;

/* Copy of the parity script's live-rooftop rule (its SQL isn't exported: importing that script runs it). */
const sql = (days: number) => `
  WITH svc AS (
    SELECT m.teamAgentMappingId AS id, m.teamId AS team_id, m.enterpriseId AS enterprise_id
    FROM dealer_leads.teamAgentMappings AS m FINAL
    INNER JOIN (SELECT agentTypeId FROM dealer_leads.agentTypes FINAL WHERE __deleted = 0 AND agentType = 'Service') AS t
      ON t.agentTypeId = m.agentTypeId
    WHERE m.__deleted = 0 AND m.isActive = 1 AND ifNull(m.teamAgentMappingId, '') != ''
  ),
  live AS (
    SELECT s.team_id AS team_id, any(s.enterprise_id) AS enterprise_id
    FROM svc AS s
    INNER JOIN (
      SELECT teamAgentMappingId AS id FROM dealer_leads.endcallreports
      WHERE __deleted = 0 AND isActive = 1 AND (isTestCall = 0 OR isTestCall IS NULL)
        AND createdAt >= now() - INTERVAL ${Math.max(1, Math.floor(days))} DAY
        AND teamAgentMappingId IN (SELECT id FROM svc)
      GROUP BY id
    ) AS c ON c.id = s.id
    GROUP BY s.team_id
  ),
  sched AS (
    SELECT i.teamId AS team_id, any(i.enterpriseId) AS enterprise_id,
           groupUniqArray(lower(c.providerName)) AS providers,
           groupUniqArrayIf(lower(c.providerName), i.status = 'success') AS live_providers
    FROM spyne_dev.integrations AS i FINAL
    INNER JOIN spyne_dev.integrationConfigs AS c FINAL ON c.id = i.registryId
    WHERE i.__deleted = 0 AND c.__deleted = 0 AND c.providerType = 'service-scheduler'
    GROUP BY i.teamId
  ),
  teams AS (SELECT team_id FROM sched UNION DISTINCT SELECT team_id FROM live)
  SELECT t.team_id AS team_id,
         if(s.enterprise_id != '', s.enterprise_id, l.enterprise_id) AS enterprise_id,
         ifNull(d.team_name, '') AS team_name, ifNull(d.is_test_account, 0) AS is_test,
         l.team_id != '' AND ifNull(d.is_test_account, 0) = 0 AS service_live,
         s.providers AS providers, s.live_providers AS live_providers
  FROM teams AS t
  LEFT JOIN sched AS s ON s.team_id = t.team_id
  LEFT JOIN live AS l ON l.team_id = t.team_id
  LEFT JOIN (SELECT team_id, team_name, is_test_account FROM eventila.enterprise_team_details FINAL WHERE _peerdb_is_deleted = 0) AS d
    ON d.team_id = t.team_id
  ORDER BY team_name
  SETTINGS join_use_nulls = 0`;

interface Row {
  team_id: string;
  enterprise_id: string;
  team_name: string;
  is_test: number | string;
  service_live: number | string | boolean;
  providers: string[];
  live_providers: string[];
}

/* Why a call came back null: the page's apiSchedulerProvider() turns every failure into null (the popup then
 * says "in the scheduler"), so a failing rooftop is read once more here, raw, for its HTTP status. */
function apiBase(env: string): string {
  if (env === "uat") return "https://uat-api.spyne.xyz";
  if (env === "stag") return "https://beta-api.spyne.xyz";
  return "https://api.spyne.ai";
}
async function whyNull(teamId: string, enterpriseId: string, token: string, env: string): Promise<string> {
  const url = new URL(`${apiBase(env)}/conversation/service-metrics/appointment/show-rate`);
  url.searchParams.set("enterpriseId", enterpriseId);
  url.searchParams.set("teamId", teamId);
  try {
    const res = await fetch(url, { headers: { Authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(25_000) });
    const text = await res.text();
    if (!res.ok) return `HTTP ${res.status}: ${text.replace(/\s+/g, " ").slice(0, 120)}`;
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(text); } catch { return `HTTP ${res.status}, not JSON`; }
    const data = (body.data ?? body) as Record<string, unknown>;
    if (!("provider" in data)) return `HTTP ${res.status}, no provider field (keys: ${Object.keys(data).slice(0, 8).join(", ")})`;
    return `HTTP ${res.status}, provider=${JSON.stringify(data.provider)}${data.reason ? `, reason: ${String(data.reason).slice(0, 80)}` : ""}`;
  } catch (e) {
    return `request failed: ${(e as Error).message}`;
  }
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function main() {
  loadEnvLocal();
  const source = arg("source", "data") === "api" ? "api" : "data";
  const maxRequests = Math.max(1, Number(arg("max-requests", "10")));
  process.env.SERVICE_OM_MAX_REQUESTS ??= String(maxRequests); // read by api.ts when it loads
  const token = process.env.SERVICE_OM_TOKEN ?? "";
  if (source === "api" && !token) throw new Error("--source=api needs SERVICE_OM_TOKEN (a prod token that can read every rooftop).");
  if (source === "api" && /^<.*>$|\s/.test(token.replace(/^Bearer /, ""))) throw new Error("SERVICE_OM_TOKEN looks like the placeholder: put your real prod console token in its place.");
  const env = arg("env", "");
  const outFile = arg("out", `scheduler-names-${source}.csv`);

  const { queryRows, hasClickhouseCreds } = await import("@/lib/reports/clickhouseQuery");
  if (!hasClickhouseCreds()) throw new Error("No CLICKHOUSE_* credentials (env or .env.local).");
  const only = arg("teams", "").split(",").map((t) => t.trim()).filter(Boolean);
  const rows = (await queryRows<Row>(sql(Number(arg("days", "30"))))).filter((r) => !only.length || only.includes(r.team_id));
  const api = source === "api" ? await import("@/lib/serviceOm/api") : null;

  const results = await pool(rows, source === "api" ? maxRequests : 1, async (r) => {
    const providers = (r.providers ?? []).filter(Boolean);
    const expected = pickProvider(providers);
    const name = schedulerName(expected);
    const label = notUpdatedLabel(name);
    const failures: string[] = [];
    if (providers.length && !name) failures.push("named: has a scheduler but shows the fallback");
    if (expected && !isKnownScheduler(expected)) failures.push(`known: "${expected}" isn't in scheduler.ts (shows "${name}")`);
    let apiProvider: string | null | undefined;
    let ms: number | undefined;
    if (api) {
      const t0 = Date.now();
      apiProvider = await api.apiSchedulerProvider({ teamId: r.team_id, enterpriseId: r.enterprise_id, spyneToken: token, spyneEnv: env });
      ms = Date.now() - t0;
      if ((apiProvider ?? null) !== expected) {
        const why = apiProvider ? "" : ` (${await whyNull(r.team_id, r.enterprise_id, token, env)})`;
        failures.push(`api: endpoint gave "${apiProvider ?? "null"}", expected "${expected ?? "null"}"${why}`);
      }
    }
    const live = (r.live_providers ?? []).filter(Boolean);
    const review = [
      providers.length && !live.length ? "pending only: named, but no integration is live yet" : "",
      providers.length > 1 ? `several schedulers: ${providers.sort().join(" + ")}` : "",
    ].filter(Boolean);
    return { r, providers, expected, name, label, apiProvider, ms, failures, review };
  });

  const header = ["team_id", "enterprise_id", "rooftop", "service_live", "test_account", "providers", "live_providers", "expected_provider", "label", ...(api ? ["api_provider", "api_ms"] : []), "status", "failures", "review"];
  const lines = [header.join(",")].concat(results.map((x) => [
    x.r.team_id, x.r.enterprise_id, x.r.team_name, Number(x.r.service_live) === 1, Number(x.r.is_test) === 1,
    x.providers.join(" + "), (x.r.live_providers ?? []).filter(Boolean).join(" + "), x.expected, x.label,
    ...(api ? [x.apiProvider ?? "null", x.ms] : []),
    x.failures.length ? "FAIL" : "PASS", x.failures.join(" | "), x.review.join(" | "),
  ].map(csvCell).join(",")));
  fs.writeFileSync(outFile, lines.join("\n") + "\n");

  const withSched = results.filter((x) => x.providers.length);
  const liveSvc = results.filter((x) => Number(x.r.service_live) === 1);
  const fail = results.filter((x) => x.failures.length);
  console.log(`Scheduler names · source=${source}${env ? ` env=${env}` : ""} · ${results.length} rooftops: ${withSched.length} with a scheduler, ${liveSvc.length} live on Service (${liveSvc.filter((x) => x.providers.length).length} of them with a scheduler)`);
  const byName = new Map<string, number>();
  for (const x of withSched) byName.set(`${x.expected} → ${x.name}`, (byName.get(`${x.expected} → ${x.name}`) ?? 0) + 1);
  console.log(`Names shown: ${[...byName.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} (${n})`).join(" · ")}`);
  console.log(`Fallback "in the scheduler": ${results.length - withSched.length} rooftops without a scheduler (${liveSvc.filter((x) => !x.providers.length).length} of them live on Service)`);
  console.log(`\n${results.length - fail.length}/${results.length} pass · ${fail.length} fail`);
  const statuses = new Map<string, number>();
  for (const x of fail) for (const f of x.failures) { const m = f.match(/\((HTTP \d+|request failed)/); if (m) statuses.set(m[1], (statuses.get(m[1]) ?? 0) + 1); }
  if (statuses.size) console.log(`Why the endpoint gave null: ${[...statuses.entries()].map(([k, n]) => `${k} ×${n}`).join(" · ")}`);
  for (const x of fail.slice(0, 40)) console.log(`  FAIL ${x.r.team_name || x.r.team_id} (${x.r.team_id}) · ${x.failures.join(" | ")}`);
  const review = results.filter((x) => x.review.length);
  if (review.length) console.log(`For review (${review.length}):`);
  for (const x of review) console.log(`  ${x.r.team_name || x.r.team_id} (${x.r.team_id})${Number(x.r.service_live) === 1 ? " · live on Service" : ""} · ${x.review.join(" | ")} · shows "${x.label}"`);
  if (api) console.log(`API: slowest show-rate read ${Math.max(0, ...results.map((x) => x.ms ?? 0))} ms`);
  console.log(`Full table: ${outFile}`);
  process.exitCode = fail.length ? 1 : 0;
}

main().catch((e) => {
  console.error(String(e));
  process.exitCode = 1;
});
