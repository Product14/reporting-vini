import crypto from "node:crypto";

/* Shared Metabase static-embedding helpers (server-only). The embedding SECRET authenticates the
 * static-embed JSON endpoint (/api/embed/card/:token/query/json). Used by /api/sync (the Q12227
 * pull) via fetchEmbedRows. */

export const SITE_URL = process.env.METABASE_SITE_URL;
export const SECRET = process.env.METABASE_SECRET_KEY;

// Only these questions may be signed — stops the endpoints signing arbitrary embeds.
// (The 12193–12212 Agent-Performance cards were dropped: the reports tab reads /api/reports now,
// so nothing requests them anymore.)
export const ALLOWED_QUESTIONS = new Set<number>([
  12182, // "reporting dashboard" embed — only the (currently unlinked) v2/Impact tab uses it
  12227, // "raw-data-dashboard" event-level query the Supabase sync aggregates
  12232, 12233, 12234, // rooftop-level detail cards: best campaign / upcoming appts / callbacks
]);

function base64url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

// Standard HS256 JWT — byte-for-byte equal to jsonwebtoken.sign, no dependency to install.
export function signHS256(payload: Record<string, unknown>, secret: string): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const signature = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${signature}`;
}

// A signed, 10-minute embed token for a question with locked params.
export function embedToken(question: number, params: Record<string, string>): string {
  return signHS256(
    { resource: { question }, params, exp: Math.round(Date.now() / 1000) + 10 * 60 },
    SECRET as string,
  );
}

export function isAllowed(question: number): boolean {
  return Number.isFinite(question) && ALLOWED_QUESTIONS.has(question);
}

export interface EmbedRowsResult {
  rows: Record<string, unknown>[];
  error?: string;
}

/* The Q12227 full pull is ~382MB AND Metabase can take minutes to emit the first byte while it runs
 * the underlying query — both exceed undici's default 300s header/body timeouts, which truncates the
 * response (→ a silent parse failure). Use a dispatcher with those timeouts disabled. Loaded lazily
 * so a bundler that can't resolve `undici` just falls back to the default fetch. */
let dispatcherPromise: Promise<unknown> | undefined;
async function longPullDispatcher(): Promise<unknown> {
  if (dispatcherPromise === undefined) {
    dispatcherPromise = import("undici")
      .then(({ Agent }) => new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 60_000 } }))
      .catch(() => null);
  }
  return dispatcherPromise;
}

/* Server-side: fetch a question's ROWS via the static-embed JSON endpoint. Used by /api/sync (the
 * Q12227 raw-data pull). `params` are LOCKED into the signed token. Returns { rows, error? } — never
 * throws. NOTE: the response has no row cap, so an unfiltered Q12227 pull must budget memory. */
export async function fetchEmbedRows(question: number, params: Record<string, string> = {}): Promise<EmbedRowsResult> {
  if (!SITE_URL || !SECRET) return { rows: [], error: "Metabase is not configured (METABASE_SITE_URL / METABASE_SECRET_KEY)." };
  if (!isAllowed(question)) return { rows: [], error: `Question ${question} is not allowlisted.` };
  const token = embedToken(question, params);
  try {
    const dispatcher = await longPullDispatcher();
    const res = await fetch(`${SITE_URL}/api/embed/card/${token}/query/json`, {
      cache: "no-store",
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit);
    const text = await res.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch {
      // A parse failure on a 200 usually means a truncated/oversized body (the full Q12227 pull is
      // ~382MB and can exceed fetch's body timeout). Surface it as an error, never as empty rows.
      return { rows: [], error: `Metabase response was not valid JSON (${text.length} bytes — likely truncated; add an activity_day embedding param to scope the pull).` };
    }
    if (!res.ok || (body && typeof body === "object" && !Array.isArray(body) && "error" in (body as object))) {
      const message = (body as { error?: string })?.error || (typeof body === "string" ? body.slice(0, 240) : `Metabase HTTP ${res.status}`);
      return { rows: [], error: message };
    }
    return { rows: Array.isArray(body) ? (body as Record<string, unknown>[]) : [] };
  } catch (e) {
    return { rows: [], error: `Couldn't reach Metabase: ${(e as Error).message}` };
  }
}
