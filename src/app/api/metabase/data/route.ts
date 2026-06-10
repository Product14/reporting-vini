import { SITE_URL, SECRET, embedToken, isAllowed, readParams } from "@/lib/metabase";

// Returns a Metabase question's ROWS as JSON (not an iframe) so they can render in our own
// widgets. Uses the static-embed JSON endpoint, authenticated by the same signed token.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (!SITE_URL || !SECRET) {
    return Response.json(
      { error: "Metabase is not configured — set METABASE_SITE_URL and METABASE_SECRET_KEY in .env.local and restart the dev server." },
      { status: 503 },
    );
  }

  const { searchParams } = new URL(request.url);
  const question = Number(searchParams.get("question"));
  if (!isAllowed(question)) {
    return Response.json({ error: `Question "${searchParams.get("question")}" is not allowlisted for embedding.` }, { status: 400 });
  }

  const token = embedToken(question, readParams(searchParams));
  const url = `${SITE_URL}/api/embed/card/${token}/query/json`;

  try {
    const res = await fetch(url, { cache: "no-store" });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }

    // Metabase returns 200 with an {error} body on a failed query (e.g. params not enabled).
    if (!res.ok || (body && typeof body === "object" && !Array.isArray(body) && "error" in (body as object))) {
      const message =
        (body as { error?: string })?.error ||
        (typeof body === "string" ? body.slice(0, 240) : `Metabase HTTP ${res.status}`);
      return Response.json({ error: message }, { status: 502 });
    }

    const rows = Array.isArray(body) ? (body as Record<string, unknown>[]) : [];
    const cols = rows.length ? Object.keys(rows[0]) : [];
    return Response.json({ cols, rows });
  } catch (e) {
    return Response.json({ error: `Couldn't reach Metabase: ${(e as Error).message}` }, { status: 502 });
  }
}
