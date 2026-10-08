/* Which rooftops get Reports > Agent performance, next (/reports/agents-next) at the existing
 * /reports/agents URL. AGENTS_REPORT_NEXT_TEAMS is a comma list of team ids, or "all". Empty or unset is
 * off, so a deploy changes nothing until the list is set, and clearing it puts every rooftop back on the
 * old page. Server-only (read by src/proxy.ts), so it is not NEXT_PUBLIC_.
 *
 * ?agents_view=old|next on the URL overrides the list for that one request, so both pages can be
 * compared for the same rooftop. */
export function agentsNextOn(
  teamId: string,
  override: string | null = null,
  raw: string | undefined = process.env.AGENTS_REPORT_NEXT_TEAMS,
): boolean {
  if (override === "old") return false;
  if (override === "next") return true;
  const list = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!teamId || list.length === 0) return false;
  return list.includes("all") || list.includes(teamId);
}

export const AGENTS_OLD_PATH = "/reports/agents";
export const AGENTS_NEXT_PATH = "/reports/agents-next";
