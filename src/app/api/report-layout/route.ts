/* Account-shared report LAYOUT (hide + reorder sections), stored in Supabase (report_layouts).
 *
 *   GET  /api/report-layout?team_id=&enterprise_id=&page=overview   → { layout: {order,hidden} | null }
 *   POST /api/report-layout   body { team_id, enterprise_id, page, layout }   → { ok: true }
 *
 * ONE shared layout per (enterprise, page) — applied to every rooftop + user of that account. A "just me"
 * layout is client-side (localStorage) and never hits this route (the app has no per-user identity). Auth
 * is the same team-scoped check the other report routes use. Enterprise key falls back to the token's
 * enterprise, then to `team:<id>` (local dev, where no enterprise is forwarded). Degrades to a null layout
 * when Supabase is unconfigured — never blocks the page. */
import { getSupabase, REPORT_LAYOUTS } from "@/lib/reports/supabase";
import { requireTeamAuth, spyneTokenFrom } from "@/lib/reports/auth";
import { enterpriseIdFromToken } from "@/lib/spyne/meetings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idOk = (s: string) => /^[A-Za-z0-9_-]{1,64}$/.test(s);
const PAGES = new Set(["overview", "agents"]);

// The account key a layout is stored under: explicit enterprise_id → token's enterprise → team fallback.
function accountKey(request: Request, teamId: string, enterpriseParam: string): string {
  if (enterpriseParam && idOk(enterpriseParam)) return enterpriseParam;
  const fromTok = enterpriseIdFromToken(spyneTokenFrom(request));
  if (fromTok) return fromTok;
  return `team:${teamId}`;
}

function cleanLayout(v: unknown): { order: string[]; hidden: string[] } | null {
  if (!v || typeof v !== "object") return null;
  const o = v as { order?: unknown; hidden?: unknown };
  const strs = (a: unknown) => (Array.isArray(a) ? a.filter((x): x is string => typeof x === "string").slice(0, 200) : []);
  return { order: strs(o.order), hidden: strs(o.hidden) };
}

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const teamId = searchParams.get("team_id") || "";
  const page = (searchParams.get("page") || "").toLowerCase();
  if (!idOk(teamId)) return Response.json({ error: "valid team_id is required" }, { status: 400 });
  if (!PAGES.has(page)) return Response.json({ error: "valid page is required" }, { status: 400 });

  const auth = requireTeamAuth(request, teamId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const sb = getSupabase();
  if (!sb) return Response.json({ layout: null, degraded: true });

  const key = accountKey(request, teamId, searchParams.get("enterprise_id") || "");
  const { data, error } = await sb.from(REPORT_LAYOUTS).select("layout").eq("enterprise_id", key).eq("page_key", page).maybeSingle();
  if (error) return Response.json({ layout: null, degraded: true });
  return Response.json({ layout: (data?.layout as { order: string[]; hidden: string[] } | undefined) ?? null }, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { team_id?: string; enterprise_id?: string; page?: string; layout?: unknown } | null;
  const teamId = String(body?.team_id || "");
  const page = String(body?.page || "").toLowerCase();
  if (!idOk(teamId)) return Response.json({ error: "valid team_id is required" }, { status: 400 });
  if (!PAGES.has(page)) return Response.json({ error: "valid page is required" }, { status: 400 });

  const auth = requireTeamAuth(request, teamId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const layout = cleanLayout(body?.layout);
  if (!layout) return Response.json({ error: "valid layout is required" }, { status: 400 });

  const sb = getSupabase();
  if (!sb) return Response.json({ error: "storage not configured" }, { status: 503 });

  const key = accountKey(request, teamId, String(body?.enterprise_id || ""));
  const { error } = await sb
    .from(REPORT_LAYOUTS)
    .upsert({ enterprise_id: key, page_key: page, layout, updated_at: new Date().toISOString() }, { onConflict: "enterprise_id,page_key" });
  if (error) return Response.json({ error: "failed to save layout" }, { status: 500 });
  return Response.json({ ok: true });
}
