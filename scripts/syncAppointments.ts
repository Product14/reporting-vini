/* One-off: populate report_appointments from ClickHouse using the SAME appointmentsSql + write path the
 * backfill detail sync uses. Lets us verify/seed the snapshot without a full aggregate run.
 *   npx tsx scripts/syncAppointments.ts
 * Env from .env.local: CLICKHOUSE_*, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. */
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { queryRows } from "../src/lib/reports/clickhouseQuery";
import { appointmentsSql } from "../src/lib/reports/detailQueries";

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
  const appts = await queryRows<Record<string, unknown>>(appointmentsSql({}));
  const rows = appts
    .map((a) => ({
      team_id: String(a.team_id ?? ""), enterprise_id: (a.enterprise_id as string) ?? null,
      service_type: (a.service_type as string) ?? null, lead_id: (a.lead_id as string) ?? null,
      meeting_id: (a.meeting_id as string) ?? null, customer_name: a.customer_name ?? null,
      phone: a.phone ?? null, vehicle: a.vehicle ?? null, intent: a.intent ?? null,
      meeting_start: a.meeting_start ?? null, booked_at: a.booked_at ?? null,
      status: a.status ?? null, assisted: Number(a.assisted ?? 0) > 0,
      direction: a.direction ?? null, booked_via: a.booked_via ?? null,
    }))
    .filter((r) => r.team_id && r.meeting_id);
  console.log(`clickhouse → ${rows.length} appointment rows`);
  const { error: delErr } = await sb.from("report_appointments").delete().gte("synced_at", "1900-01-01");
  if (delErr) throw new Error(`delete: ${delErr.message}`);
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from("report_appointments").insert(rows.slice(i, i + 500));
    if (error) throw new Error(`insert @${i}: ${error.message}`);
  }
  console.log(`report_appointments ← ${rows.length} rows written.`);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
