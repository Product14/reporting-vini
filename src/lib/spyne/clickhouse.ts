/* Minimal read-only ClickHouse client for reporting-vini's per-event feeds.
 *
 * reporting-vini is the single source of truth for the digest emails. Most data comes from the
 * Supabase aggregate + the Spyne product API, but two per-event feeds — recent conversations and
 * action items — only exist row-level in production ClickHouse (dealer_leads). So those two API
 * routes (/api/conversations, /api/action-items) read CH directly through this client.
 *
 * Server-only. HTTPS + Basic auth + JSONEachRow, same connection vini-daily-calls already uses.
 * Degrades to [] (never throws) when creds are absent or a query fails, so a feed hiccup never 502s
 * the email pipeline. Env: CLICKHOUSE_HOST, CLICKHOUSE_PORT (default 8443), CLICKHOUSE_USER, CLICKHOUSE_PASSWORD.
 */

export function hasClickhouseCreds(): boolean {
  return Boolean(process.env.CLICKHOUSE_HOST && process.env.CLICKHOUSE_PASSWORD);
}

/** Escape a value for an inline SQL string literal (we only ever inline ids/dates we control + validate). */
export function chEsc(v: string): string {
  return String(v ?? "").replace(/'/g, "''").replace(/\\/g, "\\\\");
}

export async function runClickhouse<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  if (!hasClickhouseCreds()) return [];
  const host = process.env.CLICKHOUSE_HOST;
  const port = process.env.CLICKHOUSE_PORT || "8443";
  const user = process.env.CLICKHOUSE_USER || "default";
  const pass = process.env.CLICKHOUSE_PASSWORD || "";
  const auth = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  try {
    const r = await fetch(`https://${host}:${port}/`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "text/plain" },
      body: sql + "\nFORMAT JSONEachRow",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const text = await r.text();
    if (!r.ok) {
      console.error(`[clickhouse] ${r.status}: ${text.slice(0, 200)}`);
      return [];
    }
    return text.trim() ? text.trim().split("\n").map((l) => JSON.parse(l) as T) : [];
  } catch (e) {
    console.error(`[clickhouse] query failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}
