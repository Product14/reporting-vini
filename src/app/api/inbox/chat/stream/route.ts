/* Inbox — chatbot/receptionist handover: the live SSE feed for one chat-service session.
 *   GET /chat/sessions/:sessionId/console-stream?token=<streamToken>&since=<iso>
 * Opened by the browser as an EventSource, so it CANNOT send an Authorization header — the credential is the
 * short-lived stream token (minted via /api/inbox/chat/stream-token, scoped to (sessionId, userId) and
 * validated by chat-service on every connect). This proxy therefore does NOT run requireTeamAuth (there is
 * no bearer to check); it forwards the stream token and streams the upstream body straight through.
 *
 * Proxied as:
 *   GET /api/inbox/chat/stream?team_id=&enterprise_id=&env=&session_id=&stream_token=&since=
 *
 * The stream token rides in `stream_token`, NOT `token`: readBearer()/requireTeamAuth read `?token=` as a
 * Spyne session token, so reusing that name would make the auth layer try to decode a UUID and 403. We take
 * `stream_token` and forward it downstream as chat-service's `?token=`.
 *
 * chat-service ends the connection every ~120s by design; the browser EventSource auto-reconnects (sending
 * Last-Event-ID, which we forward for a gapless, duplicate-free replay). We pass request.signal downstream
 * so a client disconnect aborts the upstream fetch and releases the socket.
 */
import { apiBaseForEnv } from "@/lib/spyne/client";
import { spyneEnvFrom } from "@/lib/reports/auth";
import { handoverEnabled } from "@/lib/inbox/handover";
import { svcIdOk } from "@/lib/spyne/conversationApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // align with chat-service's ~120s recycle so we don't add reconnect churn

// A stream token is an opaque short-lived credential (chat-service issues a UUID). Accept a permissive but
// injection-safe charset so a format change upstream doesn't break us, and reject anything with whitespace
// or path/query metacharacters that could break out of the query it's interpolated into.
const streamTokenOk = (s: string): boolean => /^[A-Za-z0-9._~:-]{1,512}$/.test(s);

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const sessionId = (searchParams.get("session_id") || "").trim();
  const streamToken = (searchParams.get("stream_token") || "").trim();
  const since = (searchParams.get("since") || "").trim();
  if (!handoverEnabled()) return Response.json({ error: "not_available" }, { status: 404 });
  if (!svcIdOk(sessionId)) return Response.json({ error: "valid session_id is required" }, { status: 400 });
  if (!streamTokenOk(streamToken)) return Response.json({ error: "valid stream_token is required" }, { status: 400 });

  const baseUrl = apiBaseForEnv(spyneEnvFrom(request));
  const up = new URL(`${baseUrl}/chat/sessions/${encodeURIComponent(sessionId)}/console-stream`);
  up.searchParams.set("token", streamToken);
  if (since && since.length <= 64) up.searchParams.set("since", since);

  // Forward Last-Event-ID so chat-service's cursor-based replay resumes exactly where the browser left off
  // across its automatic (every ~120s) reconnects — no gap, no duplicate.
  const lastEventId = request.headers.get("last-event-id");
  const upstreamHeaders: Record<string, string> = { accept: "text/event-stream" };
  if (lastEventId) upstreamHeaders["last-event-id"] = lastEventId;

  let upstream: Response;
  try {
    upstream = await fetch(up.toString(), { headers: upstreamHeaders, cache: "no-store", signal: request.signal });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "upstream stream failed", degraded: true }, { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    // Surface the upstream status (e.g. 401 on an expired token) so the client's onerror fires; the client
    // re-mints the token proactively, so this is the rare fallback path.
    const text = await upstream.text().catch(() => "");
    return Response.json({ error: text || `upstream responded ${upstream.status}`, degraded: true }, { status: upstream.status || 502 });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Disable proxy/CDN buffering so events flush immediately instead of being held until the response ends.
      "x-accel-buffering": "no",
    },
  });
}
