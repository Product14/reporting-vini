/* Unanswered queue switches (PRD R8: view flag per rooftop per department; A14: off, unreadable or rolled
 * back → no view and no badge within a minute).
 *
 *   UNANSWERED_SOURCE            "live" = conversational-ai-backend's episode API; anything else = sample
 *   UNANSWERED_SALES_TEAM_IDS    SAMPLE MODE ONLY: comma list of team ids, or "*", that see the sample
 *   UNANSWERED_SERVICE_TEAM_IDS  same, for Service
 *
 * Live: the per-rooftop, per-department view flag is the backend's `unanswered_settings.viewEnabled` (R8),
 * read on every request; the API answers { enabled: false } for an off or unreadable rooftop and the screen
 * re-asks every 30 s, so turning it off hides the view and badge within a minute with no redeploy (A14).
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

/** conversational-ai-backend's Unanswered routes (src/unanswered/unanswered.controller.ts). */
export const UNANSWERED_UPSTREAM = {
  list: "/conversation/unanswered/episodes",
  clear: "/conversation/unanswered/episodes/clear",
  manager: "/conversation/unanswered/manager",
  preferences: "/conversation/unanswered/preferences",
} as const;
