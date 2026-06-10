/* Pull Q12227 and (re)materialize the Supabase reporting aggregate, using the SAME aggregate.ts the
 * app uses. This is the robust full-table path: it streams with undici's timeouts disabled (the route
 * can't reliably pull 382MB on serverless). Run by the GitHub Actions cron AND for manual backfills.
 *
 *   npx tsx scripts/backfill.ts            # fetch live and rebuild everything
 *   npx tsx scripts/backfill.ts /tmp/q.json # aggregate a local dump instead (dev convenience)
 *
 * Env (process.env, or auto-loaded from .env.local if present): METABASE_SITE_URL, METABASE_SECRET_KEY,
 * SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. NODE_OPTIONS=--max-old-space-size=6144 recommended. */
import fs from "node:fs";
import crypto from "node:crypto";
import { Agent } from "undici";
import { createClient } from "@supabase/supabase-js";
import { aggregate } from "../src/lib/reports/aggregate";
import type { RawRow } from "../src/lib/reports/schema";

const RAW_QUESTION = 12227;

// Load .env.local into process.env if present (local dev); in CI the env is already set.
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
for (const [k, v] of Object.entries({ METABASE_SITE_URL: SITE, METABASE_SECRET_KEY: SECRET, SUPABASE_URL: SB_URL, SUPABASE_SERVICE_ROLE_KEY: SB_KEY }))
  if (!v) { console.error(`Missing env: ${k}`); process.exit(1); }

const b64 = (s: string) => Buffer.from(s).toString("base64url");
function sign(payload: object): string {
  const h = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const b = b64(JSON.stringify(payload));
  const d = `${h}.${b}`;
  return `${d}.${crypto.createHmac("sha256", SECRET).update(d).digest("base64url")}`;
}

async function pullRaw(): Promise<RawRow[]> {
  const token = sign({ resource: { question: RAW_QUESTION }, params: {}, exp: Math.round(Date.now() / 1000) + 1800 });
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function insertAll(sb: any, table: string, rows: object[]) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from(table).insert(rows.slice(i, i + 500));
    if (error) throw new Error(`${table} insert @${i}: ${error.message}`);
  }
  console.log(`  ${table}: ${rows.length} inserted`);
}

(async () => {
  const fileArg = process.argv[2];
  const raw = fileArg && fs.existsSync(fileArg)
    ? (console.log("reading", fileArg), JSON.parse(fs.readFileSync(fileArg, "utf8")) as RawRow[])
    : (console.log("pulling Q12227 live…"), await pullRaw());
  console.log("raw rows:", raw.length);
  if (!raw.length) throw new Error("0 raw rows — refusing to wipe the aggregate");

  const { daily, breakdown } = aggregate(raw);
  console.log("daily:", daily.length, " breakdown:", breakdown.length);

  const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
  for (const t of ["agent_daily", "agent_daily_breakdown"]) {
    const { error } = await sb.from(t).delete().gte("activity_day", "1900-01-01");
    if (error) throw new Error(`${t} delete: ${error.message}`);
  }
  await insertAll(sb, "agent_daily", daily);
  await insertAll(sb, "agent_daily_breakdown", breakdown);
  await sb.from("sync_state").update({
    last_run_at: new Date().toISOString(), last_status: "ok", rows_synced: daily.length, window_start: "1900-01-01", error: null,
  }).eq("id", 1);
  console.log(`done. ${daily.length} daily + ${breakdown.length} breakdown rows.`);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
