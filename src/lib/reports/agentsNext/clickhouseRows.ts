/* The ClickHouse runner behind the Service cards' source numbers (campaignFunnel.ts, serviceInbound.ts).
 *
 * Its own runner rather than lib/spyne/clickhouse.ts's runClickhouse: these queries take up to ~10s on a
 * busy rooftop (Horne Mazda's engaged pass measured 9.5s), which is exactly runClickhouse's deadline, so
 * this one allows 30s, inside the routes' maxDuration of 60.
 *
 * RETRIES. A dropped connection ("fetch failed") or a 5xx is retried twice with a short pause: one blip
 * used to return null, and the card then fell back to the aggregate's numbers on another definition
 * (seen 2026-10-08 on Paragon Honda's Service Inbound). A query that hit the 30s deadline is not retried;
 * repeating it would only hold the page longer. Returns the rows, or null when every attempt failed. */

import { resolveClickhouseCreds } from "@/lib/clickhouseCreds";

const QUERY_TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [300, 900];

export async function queryRows<T>(sql: string, tag: string): Promise<T[] | null> {
  const creds = resolveClickhouseCreds();
  if (!creds) return null;
  for (let attempt = 0; ; attempt++) {
    let retryable = false;
    try {
      const r = await fetch(`https://${creds.host}:${creds.port}/`, {
        method: "POST",
        headers: { Authorization: creds.authHeader, "Content-Type": "text/plain" },
        body: `${sql}\nFORMAT JSONEachRow`,
        cache: "no-store",
        signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
      });
      const text = (await r.text()).trim();
      if (r.ok) return text ? text.split("\n").map((l) => JSON.parse(l) as T) : [];
      console.error(`[${tag}] ClickHouse ${r.status} (attempt ${attempt + 1}): ${text.slice(0, 200)}`);
      retryable = r.status >= 500;
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      console.error(`[${tag}] query failed (attempt ${attempt + 1}): ${e instanceof Error ? e.message : String(e)}`);
      retryable = !timedOut;
    }
    if (!retryable || attempt >= RETRY_DELAYS_MS.length) return null;
    await new Promise((res) => setTimeout(res, RETRY_DELAYS_MS[attempt]));
  }
}
