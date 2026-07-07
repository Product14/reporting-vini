/* Cross-page navigation to the PARENT console.
 *
 * This app is embedded as an iframe inside the Spyne console (console.spyne.ai/converse-ai/…). The
 * parent already owns the Appointments / Calls / Conversations / Action items / Customers / Campaigns
 * pages, so in-app links to those must take the user to the PARENT's live page (top-level navigation),
 * NOT to this iframe's internal /reports/* route. Overview + By-agent are this iframe's OWN views and
 * keep navigating internally.
 *
 * On localhost (dev) there's no parent frame, so we navigate the internal route instead so the full app
 * stays reachable. enterprise_id + team_id (and serviceType for action items) are carried through. */

const BASE = "https://console.spyne.ai/converse-ai";

export type ParentPage =
  | "overview"
  | "agents"
  | "appointments"
  | "calls"
  | "conversations"
  | "actions"
  | "customers"
  | "campaigns";

const PATH: Record<ParentPage, string> = {
  overview: "",
  agents: "/agents",
  appointments: "/appointments",
  calls: "/calls",
  conversations: "/conversations",
  actions: "/action-items",
  customers: "/customers",
  campaigns: "/campaign", // NOTE: parent route is singular
};

export interface ParentCtx {
  enterpriseId?: string;
  teamId?: string;
  serviceType?: string; // e.g. action items → &serviceType=sales
}

export function parentUrl(page: ParentPage, ctx: ParentCtx): string {
  const q = new URLSearchParams();
  if (ctx.enterpriseId) q.set("enterprise_id", ctx.enterpriseId);
  if (ctx.teamId) q.set("team_id", ctx.teamId);
  if (ctx.serviceType) q.set("serviceType", ctx.serviceType);
  const qs = q.toString();
  return `${BASE}${PATH[page]}${qs ? `?${qs}` : ""}`;
}

function isLocalHost(): boolean {
  if (typeof window === "undefined") return false;
  const h = window.location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" || h === "";
}

/* Navigate to a parent-owned page. Prod (embedded) → break OUT of the iframe to the parent console URL;
 * localhost (dev) → the internal fallback route so the page is still reachable while developing. */
export function goCrossPage(page: ParentPage, ctx: ParentCtx, internalPath: string): void {
  if (typeof window === "undefined") return;
  if (isLocalHost()) {
    window.location.href = internalPath;
    return;
  }
  const url = parentUrl(page, ctx);
  try {
    (window.top ?? window)!.location.href = url; // top-level nav is allowed on user activation, even cross-origin
  } catch {
    window.location.href = url;
  }
}
