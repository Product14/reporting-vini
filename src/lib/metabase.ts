import crypto from "node:crypto";

/* Shared Metabase static-embedding helpers (server-only — imported by the route handlers).
 * The embedding SECRET both signs the iframe token AND authenticates the JSON data endpoint
 * (/api/embed/card/:token/query/json), so no separate API key is needed. */

export const SITE_URL = process.env.METABASE_SITE_URL;
export const SECRET = process.env.METABASE_SECRET_KEY;

// Only these questions may be signed — stops the endpoints signing arbitrary embeds.
// 12182 = the V2 "reporting dashboard" embed · 12193–12212 = the 20 Agent-Performance cards.
export const ALLOWED_QUESTIONS = new Set<number>([
  12182,
  ...Array.from({ length: 12212 - 12193 + 1 }, (_, i) => 12193 + i),
]);

// Embedding parameter slugs across all cards. Q12182 uses the upper-case set; the 12193–12212
// cards use team_id/start/end/agent_type. readParams forwards only the slugs PRESENT in the
// request, so each card receives just the subset it defines (no "unknown parameter").
export const QUESTION_PARAMS = ["TEAM_ID", "AGENT_TYPE", "CALLTYPES", "TZ", "team_id", "start", "end", "agent_type"] as const;

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

// Pull the known param slugs out of the request query — including empty strings, since the
// question requires each param to be PRESENT (an empty value reads as "all", as in-app).
export function readParams(searchParams: URLSearchParams): Record<string, string> {
  const params: Record<string, string> = {};
  for (const key of QUESTION_PARAMS) {
    const value = searchParams.get(key);
    if (value !== null) params[key] = value;
  }
  return params;
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
