/* One-off diagnostic: pull Q12227 (the card, same as backfill) and characterize it WITHOUT touching
 * Supabase. Saves the raw JSON to /tmp/q12227.json for reuse, then prints: row count, column names,
 * distinct agent_type / rooftop_stage, activity_day min/max, recent-day row counts, and a per-team
 * slice for the team under investigation. Purpose: find what the dashboard edit actually changed.
 *
 *   NODE_OPTIONS=--max-old-space-size=6144 npx tsx scripts/inspect-raw.ts [team_id]
 */
import fs from "node:fs";
import crypto from "node:crypto";
import { Agent } from "undici";

const RAW_QUESTION = 12227;
const TEAM = process.argv[2] ?? "e05e67affb";

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
if (!SITE || !SECRET) { console.error("Missing METABASE_SITE_URL / METABASE_SECRET_KEY"); process.exit(1); }

const b64 = (s: string) => Buffer.from(s).toString("base64url");
function sign(payload: object): string {
  const h = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const b = b64(JSON.stringify(payload));
  const d = `${h}.${b}`;
  return `${d}.${crypto.createHmac("sha256", SECRET).update(d).digest("base64url")}`;
}

(async () => {
  const cacheFile = "/tmp/q12227.json";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rows: any[];
  if (fs.existsSync(cacheFile)) {
    console.log("reading cached", cacheFile);
    rows = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  } else {
    console.log("pulling Q12227 card live…");
    const token = sign({ resource: { question: RAW_QUESTION }, params: {}, exp: Math.round(Date.now() / 1000) + 1800 });
    const res = await fetch(`${SITE}/api/embed/card/${token}/query/json`, {
      cache: "no-store",
      dispatcher: new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 60_000 } }),
    } as RequestInit);
    const text = await res.text();
    if (!res.ok) throw new Error(`Metabase HTTP ${res.status}: ${text.slice(0, 300)}`);
    rows = JSON.parse(text);
    fs.writeFileSync(cacheFile, text);
    console.log("saved", cacheFile, `(${(text.length / 1e6).toFixed(0)} MB)`);
  }

  console.log("\n=== rows:", rows.length, "===");
  console.log("\n--- columns (keys of row 0) ---");
  console.log(Object.keys(rows[0]).join(", "));

  const distinct = (key: string) => {
    const s = new Map<string, number>();
    for (const r of rows) { const v = String(r[key]); s.set(v, (s.get(v) ?? 0) + 1); }
    return [...s.entries()].sort((a, b) => b[1] - a[1]);
  };
  console.log("\n--- agent_type distribution ---");
  for (const [v, c] of distinct("agent_type")) console.log(`  ${v}: ${c}`);
  console.log("\n--- rooftop_stage distribution ---");
  for (const [v, c] of distinct("rooftop_stage").slice(0, 10)) console.log(`  ${v}: ${c}`);

  const days = rows.map((r) => String(r["activity_day"]).slice(0, 10)).filter(Boolean).sort();
  console.log("\n--- activity_day range:", days[0], "→", days[days.length - 1], "---");
  const byDay = new Map<string, number>();
  for (const d of days) byDay.set(d, (byDay.get(d) ?? 0) + 1);
  console.log("recent days:");
  for (const d of [...byDay.keys()].sort().slice(-8)) console.log(`  ${d}: ${byDay.get(d)}`);

  const teamRows = rows.filter((r) => String(r["cs.team_id"] ?? r["team_id"]) === TEAM);
  console.log(`\n--- team ${TEAM}: ${teamRows.length} raw rows ---`);
  const tBy = new Map<string, number>();
  for (const r of teamRows) { const k = String(r["agent_type"]); tBy.set(k, (tBy.get(k) ?? 0) + 1); }
  for (const [k, c] of [...tBy.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${c}`);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
