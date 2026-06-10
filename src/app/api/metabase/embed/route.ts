import { SITE_URL, SECRET, embedToken, isAllowed, readParams } from "@/lib/metabase";

// Signs a Metabase static-embed iframe token server-side so the secret never reaches the browser.
export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // signs per request — never cache

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
  const url = `${SITE_URL}/embed/question/${token}#bordered=false&titled=true`;
  return Response.json({ url, expiresInSec: 600 });
}
