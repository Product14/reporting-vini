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
 * Server-only — never import into a Client Component. Credential resolution lives in
 * lib/clickhouseCreds.ts, shared with the other ClickHouse client (lib/spyne/clickhouse.ts) so the
 * two never drift apart.
 */
import { Agent } from "undici";
import { hasClickhouseCreds, resolveClickhouseCreds } from "@/lib/clickhouseCreds";

export { hasClickhouseCreds };

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

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** Run a read-only ClickHouse query and parse JSONEachRow into rows. Throws on a non-2xx response or
 *  transport error (the caller decides whether to abort the sync). Concurrency-capped.
 *
 *  Transport errors ("fetch failed" — a stale keep-alive socket, a dropped connection, a transient
 *  network blip) and 5xx responses are retried with backoff (CH_QUERY_RETRIES, default 4). A long ETL
 *  run over many chunks would otherwise abort on a single flaky request; reads are idempotent so retry
 *  is always safe. A non-2xx 4xx (bad SQL / auth) is NOT retried — it won't get better. */
export async function queryRows<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const creds = resolveClickhouseCreds();
  if (!creds) {
    throw new Error("ClickHouse is not configured (CLICKHOUSE_HOST / CLICKHOUSE_PASSWORD).");
  }
  const { host, port, authHeader: auth } = creds;
  const maxRetries = Number(process.env.CH_QUERY_RETRIES) || 4;

  await acquire();
  try {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const r = await fetch(`https://${host}:${port}/`, {
          method: "POST",
          headers: { Authorization: auth, "Content-Type": "text/plain" },
          body: sql + "\nFORMAT JSONEachRow",
          cache: "no-store",
          // @ts-expect-error — undici-specific dispatcher option, valid at runtime under Node.
          dispatcher: longPull,
        });
        const text = await r.text();
        if (!r.ok) {
          // 5xx is transient (overload / restart) → retry; 4xx is a real error → fail fast.
          if (r.status >= 500 && attempt < maxRetries) { lastErr = new Error(`ClickHouse ${r.status}`); await sleep(1000 * (attempt + 1)); continue; }
          throw new Error(`ClickHouse ${r.status}: ${text.slice(0, 300)}`);
        }
        return text.trim() ? text.trim().split("\n").map((l) => JSON.parse(l) as T) : [];
      } catch (e) {
        // Transport-level failure (fetch failed / socket hang up). Retry with backoff; rethrow when spent.
        lastErr = e;
        if (attempt >= maxRetries) break;
        await sleep(1000 * (attempt + 1));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  } finally {
    release();
  }
}
