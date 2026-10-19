import type { AppointmentRow } from "./contract";

/* Rollback switch for reading Om's statusNow on the Service OM Reports page (the appointments popup, the
 * Upcoming list and the download). On, a past appointment whose repair order came in reads "Showed" even when
 * the scheduler still says scheduled. Off, the page drops statusNow from Om's rows, so every status comes from
 * the scheduler's raw status exactly as before.
 *
 * NEXT_PUBLIC_SERVICE_OM_STATUS_NOW, inlined at build (redeploy to apply):
 *   unset                                DEFAULT_WHEN_UNSET
 *   "off" (or "none", "0", "false", "")  every rooftop back on the scheduler's raw status
 *   "all"                                every rooftop
 *   "a,b,c"                              only those team ids
 * ROLLBACK without Vercel access: set DEFAULT_WHEN_UNSET below to "off" in a one-line PR, or revert the PR.
 * ?status_now=off|on on the URL overrides everything for that one page view (side-by-side checks). */
export const DEFAULT_WHEN_UNSET = "all";

const OFF = new Set(["off", "none", "0", "false", ""]);

export function statusNowOn(
  teamId: string,
  override: string | null = null,
  raw: string | undefined = process.env.NEXT_PUBLIC_SERVICE_OM_STATUS_NOW,
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

/** Om's rows without statusNow: what the page reads with the switch off. */
export function withoutStatusNow(rows: AppointmentRow[]): AppointmentRow[] {
  return rows.map((r) => {
    const copy = { ...r };
    delete copy.statusNow;
    return copy;
  });
}
