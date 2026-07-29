/* Server-only proxy for Spyne's CONVERSATION + PERSONA services (the "V2" Inbox APIs).
 *
 * These live on the SAME hosts the rest of the app already resolves per-request from ?env= (see
 * apiBaseForEnv): the conversation service under `/conversation/*` and persona under `/persona/*`.
 * The browser never talks to them directly — CORS aside, the security model (requireTeamAuth) is that
 * every PII read is proxied through a Next route that authorizes the caller and forwards the dealer's
 * Spyne session token downstream. This helper is the single fetch used by all /api/inbox/* routes.
 *
 * Unlike spyneGet (client.ts) which swallows the upstream status into a null, this PRESERVES the status
 * and body so the proxy routes can forward a real 4xx/5xx to the browser instead of masking it as empty.
 */
import { apiBaseForEnv, resolveToken } from "./client";

export interface ProxyResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
}

/* GET a JSON path from the conversation/persona service for THIS request's env + token.
 * `path` is the full path incl. leading slash and query string (e.g. "/conversation/leads/v2/...?x=y").
 * Returns { ok, status, data } — never throws; a transport failure surfaces as status 502. */
export async function spyneServiceGet<T>(
  path: string,
  token: string | null,
  env: string | null,
): Promise<ProxyResult<T>> {
  const auth = resolveToken(token);
  const base = apiBaseForEnv(env);
  try {
    const r = await fetch(`${base}${path}`, {
      headers: {
        accept: "application/json, text/plain, */*",
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      },
      cache: "no-store",
    });
    const text = await r.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!r.ok) {
      let msg = `upstream responded ${r.status}`;
      if (data && typeof data === "object" && "message" in data) {
        const m = (data as { message?: unknown }).message;
        if (typeof m === "string" && m) msg = m;
      }
      return { ok: false, status: r.status, data: null, error: msg };
    }
    return { ok: true, status: r.status, data: data as T };
  } catch (e) {
    return { ok: false, status: 502, data: null, error: e instanceof Error ? e.message : "upstream fetch failed" };
  }
}

/* POST/PATCH a JSON body to the conversation service (used by the message-feedback route). Same env +
 * token resolution and status-preserving behaviour as spyneServiceGet. */
export async function spyneServiceSend<T>(
  path: string,
  token: string | null,
  env: string | null,
  method: "POST" | "PATCH" | "DELETE" | "PUT",
  body: unknown,
): Promise<ProxyResult<T>> {
  const auth = resolveToken(token);
  const base = apiBaseForEnv(env);
  try {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const text = await r.text();
    let data: unknown = null;
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }
    if (!r.ok) {
      let msg = `upstream responded ${r.status}`;
      if (data && typeof data === "object" && "message" in data) {
        const m = (data as { message?: unknown }).message;
        if (typeof m === "string" && m) msg = m;
      }
      return { ok: false, status: r.status, data: null, error: msg };
    }
    return { ok: true, status: r.status, data: data as T };
  } catch (e) {
    return { ok: false, status: 502, data: null, error: e instanceof Error ? e.message : "upstream fetch failed" };
  }
}

// Shared id validator for path/query ids we forward downstream (customer_id, callId, enterprise_id, …).
// Permissive enough for Spyne's prefixed ids ("cust_…", "lead_…", "call_…") but rejects anything that
// could break out of the path/query it's interpolated into.
export const svcIdOk = (s: string): boolean => /^[A-Za-z0-9_-]{1,128}$/.test(s);
