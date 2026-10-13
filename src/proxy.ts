import { NextResponse, type NextRequest } from "next/server";
import { agentsNextOn, AGENTS_NEXT_PATH } from "@/lib/reports/agentsNextSwitch";
import { departmentOf, serviceOmViewOn, SERVICE_OM_OVERVIEW_PATH, SERVICE_OM_REPORTS_PATH } from "@/lib/serviceOm/switch";

/* The host iframes /reports/agents?team_id=… for its Agent performance page. For rooftops listed in
 * AGENTS_REPORT_NEXT_TEAMS that URL renders /reports/agents-next instead (a rewrite, so the iframe URL
 * and the query string are unchanged). Every other rooftop gets the old page exactly as before.
 *
 * The host iframes /overview/?team_id=… for its Overview. A SERVICE request renders /service-om/overview
 * instead, the same way, and /reports/agents renders /service-om/reports (ahead of the agents-next rule):
 * on for every rooftop unless SERVICE_OM_VIEW_TEAMS says otherwise (see serviceOm/switch.ts for the rollout
 * and the kill switch). Sales get the old pages exactly as before. */
export function proxy(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const teamId = (sp.get("team_id") || sp.get("teamId") || "").trim();
  const path = request.nextUrl.pathname.replace(/\/+$/, "");
  const department = departmentOf(sp, request.headers.get("referer"));
  const serviceOm = serviceOmViewOn(teamId, department, sp.get("svc_view"));
  if (path === "/overview") {
    if (!serviceOm) return NextResponse.next();
    const url = request.nextUrl.clone();
    url.pathname = SERVICE_OM_OVERVIEW_PATH;
    return NextResponse.rewrite(url);
  }
  if (serviceOm) {
    const url = request.nextUrl.clone();
    url.pathname = SERVICE_OM_REPORTS_PATH;
    return NextResponse.rewrite(url);
  }
  if (!agentsNextOn(teamId, sp.get("agents_view"))) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = AGENTS_NEXT_PATH;
  return NextResponse.rewrite(url);
}

export const config = {
  matcher: ["/reports/agents", "/overview", "/overview/"],
};
