/* Long-pull, read-only ClickHouse client for the reporting ETL — the conversation-spine scan plus the
 * campaign/outcome detail queries that materialize the Supabase aggregate.
 *
 * Distinct from src/lib/spyne/clickhouse.ts: that client's 10s AbortSignal suits the small per-event
 * feed reads (recent conversations / action items), but is far too short for the spine scan, which is
 * memory-heavy and can take ~50–66s to emit its first byte on a cold full window.
 *
 *  - HTTPS + Basic auth + `FORMAT JSONEachRow`, the same connection the rest of the stack uses.
 *  - No request timeout (undici dispatcher headersTimeout/bodyTimeout = 0): ClickHouse may stall for
 *    minutes before the first byte on a full scan.
 *  - Global concurrency cap (CH_MAX_CONCURRENCY, default 4): base_fact scans sit near the cluster's
 *    57.6 GiB ceiling; too many concurrent scans trip Code 241 (MEMORY_LIMIT_EXCEEDED). Excess queries
 *    queue and run as slots free.
 *
 * Server-only — never import into a Client Component. Env: CLICKHOUSE_HOST, CLICKHOUSE_PORT
 * (default 8443), CLICKHOUSE_USER (default "default"), CLICKHOUSE_PASSWORD.
 */
import { Agent } from "undici";

export function hasClickhouseCreds(): boolean {
  return Boolean(process.env.CLICKHOUSE_HOST && process.env.CLICKHOUSE_PASSWORD);
}

// No-timeout dispatcher: a cold full spine scan can take minutes before the first byte. Reused across
// calls so we don't leak a socket pool per query.
const longPull = new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 60_000 } });

// Global concurrency cap across ALL reporting ClickHouse queries. Tune via CH_MAX_CONCURRENCY.
const CH_MAX = Number(process.env.CH_MAX_CONCURRENCY) || 4;
let active = 0;
const waiters: Array<() => void> = [];
function acquire(): Promise<void> {
  if (active < CH_MAX) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}
function release(): void {
  const next = waiters.shift();
  if (next) next(); // hand the slot straight to the next waiter
  else active--;
}

/** Run a read-only ClickHouse query and parse JSONEachRow into rows. Throws on a non-2xx response or
 *  transport error (the caller decides whether to abort the sync). Concurrency-capped. */
export async function queryRows<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  if (!hasClickhouseCreds()) {
    throw new Error("ClickHouse is not configured (CLICKHOUSE_HOST / CLICKHOUSE_PASSWORD).");
  }
  await acquire();
  try {
    const host = process.env.CLICKHOUSE_HOST;
    const port = process.env.CLICKHOUSE_PORT || "8443";
    const user = process.env.CLICKHOUSE_USER || "default";
    const pass = process.env.CLICKHOUSE_PASSWORD || "";
    const auth = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
    const r = await fetch(`https://${host}:${port}/`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "text/plain" },
      body: sql + "\nFORMAT JSONEachRow",
      cache: "no-store",
      // @ts-expect-error — undici-specific dispatcher option, valid at runtime under Node.
      dispatcher: longPull,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`ClickHouse ${r.status}: ${text.slice(0, 300)}`);
    return text.trim() ? text.trim().split("\n").map((l) => JSON.parse(l) as T) : [];
  } finally {
    release();
  }
}
