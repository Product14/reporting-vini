/* Account-shared report LAYOUT (hide + reorder sections), stored in Supabase (report_layouts).
 *
 *   GET  /api/report-layout?team_id=&page=overview   → { layout: {order,hidden} | null }
 *   POST /api/report-layout   body { team_id, page, layout }   → { ok: true }
 *
 * ONE shared layout per (enterprise, page) — applied to every rooftop + user of that account. A "just me"
 * layout is client-side (localStorage) and never hits this route (the app has no per-user identity). Auth
 * is the same team-scoped check the other report routes use. The enterprise key is the team's VERIFIED
 * enterprise (ClickHouse, see verifiedEnterpriseForTeam) → the token's own enterprise → `team:<id>` (local
 * dev, where no enterprise is forwarded) — NOT a client-supplied enterprise_id, which would let an
 * authenticated caller read/overwrite a DIFFERENT account's layout. Degrades to a null layout when
 * Supabase is unconfigured — never blocks the page. */
import { getSupabase, REPORT_LAYOUTS } from "@/lib/reports/supabase";
import { requireTeamAuth, spyneTokenFrom } from "@/lib/reports/auth";
import { enterpriseIdFromToken } from "@/lib/spyne/meetings";
import { runClickhouse, chEsc, hasClickhouseCreds } from "@/lib/spyne/clickhouse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idOk = (s: string) => /^[A-Za-z0-9_-]{1,64}$/.test(s);
const PAGES = new Set(["overview", "agents"]);

// The team's REAL enterprise_id (ClickHouse eventila.enterprise_team_details — same source
// resolveTeams()/`/api/reports/bulk` uses), never the caller-supplied one. requireTeamAuth only
// proves the caller is scoped to `teamId`, not that they own whatever enterprise_id they pass — a
// caller could otherwise pair their own valid team_id with a DIFFERENT account's enterprise_id and
// read/overwrite that account's shared layout. Cached briefly (a team's enterprise essentially never
// changes) so this doesn't add a ClickHouse round-trip to every layout read/write.
const verifiedEntCache = new Map<string, { id: string | null; at: number }>();
const VERIFIED_ENT_TTL_MS = 5 * 60 * 1000;
async function verifiedEnterpriseForTeam(teamId: string): Promise<string | null> {
  const hit = verifiedEntCache.get(teamId);
  if (hit && Date.now() - hit.at < VERIFIED_ENT_TTL_MS) return hit.id;
  if (!hasClickhouseCreds()) return null;
  try {
    const rows = await runClickhouse<{ enterpriseId: string }>(
      `SELECT any(enterprise_id) AS enterpriseId FROM eventila.enterprise_team_details WHERE team_id = '${chEsc(teamId)}'`
    );
    const id = rows[0]?.enterpriseId ? String(rows[0].enterpriseId) : null;
    verifiedEntCache.set(teamId, { id, at: Date.now() });
    return id;
  } catch {
    return null;
  }
}

// The account key a layout is stored under: the team's VERIFIED enterprise → the token's own
// enterprise → team fallback. The client-supplied enterprise_id is intentionally NOT part of this
// chain anymore — see verifiedEnterpriseForTeam above for why trusting it was a tenant-isolation gap.
async function accountKey(request: Request, teamId: string): Promise<string> {
  const verified = await verifiedEnterpriseForTeam(teamId);
  if (verified) return verified;
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

  const key = await accountKey(request, teamId);
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

  const key = await accountKey(request, teamId);
  const { error } = await sb
    .from(REPORT_LAYOUTS)
    .upsert({ enterprise_id: key, page_key: page, layout, updated_at: new Date().toISOString() }, { onConflict: "enterprise_id,page_key" });
  if (error) return Response.json({ error: "failed to save layout" }, { status: 500 });
  return Response.json({ ok: true });
}
