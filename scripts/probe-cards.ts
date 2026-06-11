/* Probe the new Metabase cards (12228-12235) via signed embed to learn their schemas before wiring
 * them into the Supabase aggregate. Prints HTTP status, columns, row count, and a sample row each.
 *   NODE_OPTIONS=--max-old-space-size=4096 npx tsx scripts/probe-cards.ts */
import fs from "node:fs";
import crypto from "node:crypto";
import { Agent } from "undici";

const CARDS = [12228, 12229, 12231, 12232, 12233, 12234, 12235];

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
  for (const id of CARDS) {
    const token = sign({ resource: { question: id }, params: {}, exp: Math.round(Date.now() / 1000) + 600 });
    try {
      const res = await fetch(`${SITE}/api/embed/card/${token}/query/json`, {
        cache: "no-store",
        dispatcher: new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 30_000 } }),
      } as RequestInit);
      const text = await res.text();
      if (!res.ok) { console.log(`\n#${id}: HTTP ${res.status} — ${text.slice(0, 160)}`); continue; }
      const json = JSON.parse(text);
      if (!Array.isArray(json)) { console.log(`\n#${id}: not an array — ${text.slice(0, 160)}`); continue; }
      console.log(`\n#${id}: ${json.length} rows`);
      if (json.length) {
        console.log(`  columns: ${Object.keys(json[0]).join(", ")}`);
        console.log(`  sample : ${JSON.stringify(json[0]).slice(0, 400)}`);
      }
    } catch (e) {
      console.log(`\n#${id}: FETCH ERROR — ${(e as Error).message}`);
    }
  }
})();
