/* Apply a SQL migration to Supabase Postgres over the pooler. Needs a real DB credential in
 * .env.local — either SUPABASE_DB_PASSWORD (preferred; host/user defaults match this project's
 * Session pooler) or a complete SUPABASE_DB_URL. Idempotent migrations are safe to re-run.
 *   npx tsx scripts/apply-migration.ts [path/to/file.sql]   (default: 0002_report_detail.sql) */
import fs from "node:fs";
import { Client, type ClientConfig } from "pg";

for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
}

const file = process.argv[2] || "supabase/migrations/0002_report_detail.sql";
const sql = fs.readFileSync(file, "utf8");
const hasPlaceholder = (s?: string) => !s || /<[^>]*>|\[[^\]]*\]/.test(s);

const pw = process.env.SUPABASE_DB_PASSWORD;
const url = process.env.SUPABASE_DB_URL;
let config: ClientConfig;
if (pw && !hasPlaceholder(pw)) {
  config = {
    host: process.env.SUPABASE_DB_HOST || "aws-1-us-west-2.pooler.supabase.com",
    port: Number(process.env.SUPABASE_DB_PORT || 5432),
    user: process.env.SUPABASE_DB_USER || "postgres.qludnojfibguobgeeujw",
    password: pw,
    database: process.env.SUPABASE_DB_NAME || "postgres",
    ssl: { rejectUnauthorized: false },
  };
} else if (url && !hasPlaceholder(url)) {
  config = { connectionString: url, ssl: { rejectUnauthorized: false } };
} else {
  console.error("No usable DB credential — set SUPABASE_DB_PASSWORD (or a complete SUPABASE_DB_URL) in .env.local.");
  process.exit(1);
}

(async () => {
  const client = new Client(config);
  await client.connect();
  await client.query(sql);
  const { rows } = await client.query(
    "select table_name from information_schema.tables where table_schema='public' and table_name in ('report_appointments','report_callbacks','report_campaigns') order by table_name",
  );
  console.log(`applied ${file}. tables present: ${rows.map((r) => r.table_name).join(", ") || "(none)"}`);
  await client.end();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
