/* Inbox — same-origin audio streaming shim for the waveform player (Listen).
 *
 * NOT a business API: holds NO token, calls NO Spyne API, knows nothing about env/enterprise/team. It
 * exists only because the S3 recording host returns no Access-Control-Allow-Origin header, so WaveSurfer
 * (which fetches the bytes to DRAW the waveform) is blocked by CORS reading S3 directly. The browser
 * already got the presigned recordingUrl from the (CORS-enabled) conversations/call APIs; this pipes the
 * bytes same-origin, forwarding Range so the player can seek.
 *
 *   GET /api/inbox/call-recording?url=<presigned S3 url>
 *
 * SSRF guard: only streams from Spyne's recording hosts (*.amazonaws.com over https).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_HOST = /(^|\.)amazonaws\.com$/i;

export async function GET(req: Request): Promise<Response> {
  const raw = new URL(req.url).searchParams.get("url");
  if (!raw) return new Response("missing_url", { status: 400 });

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return new Response("bad_url", { status: 400 });
  }
  if (target.protocol !== "https:" || !ALLOWED_HOST.test(target.hostname)) {
    return new Response("host_not_allowed", { status: 403 });
  }

  // Stream the audio, forwarding Range so the player can seek. Same-origin → no CORS on the client.
  const range = req.headers.get("range");
  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), { headers: range ? { Range: range } : {}, cache: "no-store" });
  } catch (e) {
    return new Response(`recording_unreachable: ${e instanceof Error ? e.message : String(e)}`, { status: 502 });
  }

  const headers = new Headers();
  headers.set("Content-Type", upstream.headers.get("Content-Type") || "audio/mpeg");
  headers.set("Accept-Ranges", "bytes");
  const cl = upstream.headers.get("Content-Length");
  if (cl) headers.set("Content-Length", cl);
  const cr = upstream.headers.get("Content-Range");
  if (cr) headers.set("Content-Range", cr);
  headers.set("Cache-Control", "private, max-age=300");
  return new Response(upstream.body, { status: upstream.status, headers });
}
