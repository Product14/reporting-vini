/* Shared ClickHouse credential resolution — used by BOTH ClickHouse clients in this codebase
 * (lib/spyne/clickhouse.ts for short per-event reads, lib/reports/clickhouseQuery.ts for the long-pull
 * ETL scan). They used to each define their own copy of hasClickhouseCreds() + host/port/user/password
 * resolution (including the same silent CLICKHOUSE_USER="default" fallback) with nothing keeping the
 * two in sync — a future change to one (e.g. requiring a specific read-only user, or a different port
 * default) wouldn't propagate to the other. One source of truth instead.
 *
 * Env: CLICKHOUSE_HOST, CLICKHOUSE_PORT (default 8443), CLICKHOUSE_USER (default "default"),
 * CLICKHOUSE_PASSWORD. */

export function hasClickhouseCreds(): boolean {
  return Boolean(process.env.CLICKHOUSE_HOST && process.env.CLICKHOUSE_PASSWORD);
}

export interface ClickhouseCreds {
  host: string;
  port: string;
  user: string;
  pass: string;
  /** Pre-built `Authorization: Basic …` header value. */
  authHeader: string;
}

/** Resolve the connection creds, or null when CLICKHOUSE_HOST/CLICKHOUSE_PASSWORD aren't set. */
export function resolveClickhouseCreds(): ClickhouseCreds | null {
  if (!hasClickhouseCreds()) return null;
  const host = process.env.CLICKHOUSE_HOST as string;
  const port = process.env.CLICKHOUSE_PORT || "8443";
  const user = process.env.CLICKHOUSE_USER || "default";
  const pass = process.env.CLICKHOUSE_PASSWORD || "";
  const authHeader = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  return { host, port, user, pass, authHeader };
}
