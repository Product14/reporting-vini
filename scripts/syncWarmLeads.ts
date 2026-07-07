/* One-off: populate report_warm_leads from ClickHouse using the SAME warmLeadsSql + write path the
 * backfill detail sync uses. Lets us verify/seed the "Work these now" snapshot without a full run.
 *   npx tsx scripts/syncWarmLeads.ts [team_id]
 * Env from .env.local: CLICKHOUSE_*, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. */
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { queryRows } from "../src/lib/reports/clickhouseQuery";
import { warmLeadsSql } from "../src/lib/reports/detailQueries";

function loadEnv() {
  if (!fs.existsSync(".env.local")) return;
  for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();

const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

(async () => {
  const teamId = process.argv[2]; // optional: scope the pull AND the replace to one team
  const warm = await queryRows<Record<string, unknown>>(warmLeadsSql(teamId ? { teamId } : {}));
  const rows = warm
    .map((w) => ({
      team_id: String(w.team_id ?? ""), source: (w.source as string) ?? null,
      service_type: (w.service_type as string) ?? null, lead_id: (w.lead_id as string) ?? null,
      tier: (w.tier as string) ?? null, customer_name: w.customer_name ?? null,
      phone: w.phone ?? null, campaign: w.campaign ?? null, outcome: w.outcome ?? null,
      last_activity: w.last_activity ?? null,
    }))
    .filter((r) => r.team_id && (r.customer_name || r.phone));
  console.log(`clickhouse → ${rows.length} warm-lead rows${teamId ? ` (team ${teamId})` : ""}`);
  const del = sb.from("report_warm_leads").delete();
  const { error: delErr } = await (teamId ? del.eq("team_id", teamId) : del.gte("synced_at", "1900-01-01"));
  if (delErr) throw new Error(`delete: ${delErr.message}`);
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from("report_warm_leads").insert(rows.slice(i, i + 500));
    if (error) throw new Error(`insert @${i}: ${error.message}`);
  }
  console.log(`report_warm_leads ← ${rows.length} rows written.`);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
