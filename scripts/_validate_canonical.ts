/* READ-ONLY canonical validation harness. Runs the EXACT spine (agentBaseFact.sql, callback→outbound
 * injected + window substituted) against ClickHouse and rolls up per-agent window-distinct metrics —
 * WITHOUT writing to Supabase. Lets us verify/iterate the metric logic with zero prod backfills.
 *   npx tsx scripts/_validate_canonical.ts <team_id> <start YYYY-MM-DD> <end YYYY-MM-DD>
 *   (default: Covina 49a06313cf, 2026-06-01..2026-07-01) */
import fs from "node:fs";
import { loadSpineSql } from "../src/lib/reports/spineSql";
import { queryRows } from "../src/lib/reports/clickhouseQuery";

if (fs.existsSync(".env.local")) {
  for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}

const team = process.argv[2] || "49a06313cf";
const start = process.argv[3] || "2026-06-01";
const end = process.argv[4] || "2026-07-01";

const spine = loadSpineSql(`toDate('${start}')`, `toDate('${end}')`);

// Plain projection + filter (NO aggregates) — avoids nesting the spine's internal aggregates.
const q = `
SELECT "cs.lead_id" AS lead_id, agent_type, connected, sms_replied, qualified,
       qualified_via_call, qualified_via_sms, appointment_booked, appointment_assisted
FROM ( ${spine} )
WHERE "cs.team_id" = '${team}' AND agent_type LIKE 'Sales%'
`;

(async () => {
  console.log(`\nCanonical validation (READ-ONLY spine, no Supabase write)`);
  console.log(`team=${team}  window=[${start}, ${end})\n`);
  const rows = await queryRows(q);
  // window-distinct lead rollup per agent_type (mirrors aggregate.ts lead-day logic)
  const agg: Record<string, Record<string, Set<string>>> = {};
  const N = (v: any) => Number(v) || 0;
  for (const r of rows as any[]) {
    const at = r.agent_type, lead = r.lead_id;
    const a = (agg[at] ??= { leads: new Set(), connected: new Set(), qualified: new Set(),
      qvcall: new Set(), qvsms: new Set(), booked: new Set(), assisted: new Set() });
    a.leads.add(lead);
    if (N(r.connected) > 0 || N(r.sms_replied) > 0) a.connected.add(lead);
    if (N(r.qualified) > 0) a.qualified.add(lead);
    if (N(r.qualified_via_call) > 0) a.qvcall.add(lead);
    if (N(r.qualified_via_sms) > 0) a.qvsms.add(lead);
    if (N(r.appointment_booked) > 0) a.booked.add(lead);
    if (N(r.appointment_assisted) > 0) a.assisted.add(lead);
  }
  for (const at of Object.keys(agg).sort()) {
    const a = agg[at];
    console.log(
      `${at.padEnd(15)} | leads ${String(a.leads.size).padStart(4)}` +
      ` | connected ${String(a.connected.size).padStart(4)}` +
      ` | qualified ${String(a.qualified.size).padStart(4)} (call ${a.qvcall.size} / sms ${a.qvsms.size})` +
      ` | appt AI-booked ${a.booked.size} · assisted ${a.assisted.size}`,
    );
  }
  console.log("");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
