import { NextResponse, type NextRequest } from "next/server";
import { agentsNextOn, AGENTS_NEXT_PATH } from "@/lib/reports/agentsNextSwitch";

/* The host iframes /reports/agents?team_id=… for its Agent performance page. For rooftops listed in
 * AGENTS_REPORT_NEXT_TEAMS that URL renders /reports/agents-next instead (a rewrite, so the iframe URL
 * and the query string are unchanged). Every other rooftop gets the old page exactly as before. */
export function proxy(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const teamId = (sp.get("team_id") || sp.get("teamId") || "").trim();
  if (!agentsNextOn(teamId, sp.get("agents_view"))) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = AGENTS_NEXT_PATH;
  return NextResponse.rewrite(url);
}

export const config = {
  matcher: "/reports/agents",
};
