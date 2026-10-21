/* Rollback switch for naming the rooftop's scheduler in the Service OM Reports appointments popup. On, past
 * appointments whose status never moved read "Status not updated in Xtime" (scheduler.ts), and the page reads
 * the scheduler's name from Om's show-rate endpoint. Off, the popup reads "Status not available" exactly as
 * before, and the page doesn't make that call.
 *
 * NEXT_PUBLIC_SERVICE_OM_SCHEDULER_LABEL, inlined at build (redeploy to apply):
 *   unset                                DEFAULT_WHEN_UNSET
 *   "off" (or "none", "0", "false", "")  every rooftop back on "Status not available"
 *   "all"                                every rooftop
 *   "a,b,c"                              only those team ids
 * ROLLBACK without Vercel access: set DEFAULT_WHEN_UNSET below to "off" in a one-line PR, or revert the PR.
 * ?sched_label=off|on on the URL overrides everything for that one page view (side-by-side checks). */
export const DEFAULT_WHEN_UNSET = "all";

const OFF = new Set(["off", "none", "0", "false", ""]);

export function schedulerLabelOn(
  teamId: string,
  override: string | null = null,
  raw: string | undefined = process.env.NEXT_PUBLIC_SERVICE_OM_SCHEDULER_LABEL,
): boolean {
  const o = (override ?? "").trim().toLowerCase();
  if (o === "off") return false;
  if (o === "on") return true;
  const setting = (raw ?? DEFAULT_WHEN_UNSET).trim().toLowerCase();
  if (OFF.has(setting)) return false;
  const list = setting.split(",").map((s) => s.trim()).filter(Boolean);
  if (list.includes("all")) return true;
  return teamId !== "" && list.includes(teamId.toLowerCase());
}
