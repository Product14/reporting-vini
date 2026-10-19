/* Unanswered queue switches (PRD R8: view flag per rooftop per department; A14: off, unreadable or rolled
 * back → no view and no badge within a minute).
 *
 *   UNANSWERED_SALES_TEAM_IDS    comma list of team ids, or "*"   (unset = no rooftop). Default per PRD: on at day one.
 *   UNANSWERED_SERVICE_TEAM_IDS  same, for Service — off until the rooftop is confirmed to run Vini Service
 *   UNANSWERED_SOURCE            "live" = the episode team-list API; anything else = sample
 *
 * SERVER-SIDE ONLY, read on every request: the API answers { enabled: false } for an off rooftop and the
 * screen re-asks every 30 s, so turning a flag off hides the view and badge within a minute without a
 * redeploy (a NEXT_PUBLIC_ build-time flag could not do that).
 */
import type { Department } from "./types";

const list = (v: string | undefined) =>
  (v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

export function unansweredEnabledFor(
  teamId: string | null | undefined,
  department: Department,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!teamId) return false;
  const ids = list(department === "service" ? env.UNANSWERED_SERVICE_TEAM_IDS : env.UNANSWERED_SALES_TEAM_IDS);
  return ids.includes("*") || ids.includes(teamId.toLowerCase());
}

export function unansweredSourceIsLive(env: Record<string, string | undefined> = process.env): boolean {
  return (env.UNANSWERED_SOURCE ?? "").trim().toLowerCase() === "live";
}

/** Upstream paths the backend will serve (PRD R13 team list with unansweredOnly; R7 manager view; R2 clears). */
export const UNANSWERED_UPSTREAM = {
  list: "/conversation/customers/conversations/team",
  clear: "/conversation/unanswered/episodes/clear",
  manager: "/conversation/unanswered/manager",
} as const;
