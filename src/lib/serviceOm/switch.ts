/* Which rooftops see the Service OM pages at the URLs the console already iframes. Server-only (read by
 * src/proxy.ts), so it is not NEXT_PUBLIC_.
 *
 * ROLLOUT (user, 13-Oct-2026, after the all-rooftops prod check passed): on for every rooftop by default, so
 * the merge itself makes the new pages live. SERVICE_OM_VIEW_TEAMS, when set, overrides that:
 *   - "off" (or "none", "0", "false", "")  every rooftop back on the old pages (kill switch; redeploy to apply)
 *   - "all"                                every rooftop
 *   - "a,b,c"                              only those team ids
 * ROLLBACK without Vercel access: set DEFAULT_WHEN_UNSET below to "off" in a one-line PR, or revert the PR.
 * ?svc_view=old|om on the URL overrides everything for that one request (side-by-side checks).
 *
 * SERVICE ONLY. A request is a Service one only when the iframe URL, or the console page around it (the
 * Referer, the same fallback scenario.tsx uses), says serviceType / service_type / department = service.
 * Anything else, including no department at all, stays on the old page, so Sales can never land here. */
export const DEFAULT_WHEN_UNSET = "all";

const OFF = new Set(["off", "none", "0", "false", ""]);

export function serviceOmViewOn(
  teamId: string,
  department: string | null,
  override: string | null = null,
  raw: string | undefined = process.env.SERVICE_OM_VIEW_TEAMS,
): boolean {
  if ((department ?? "").trim().toLowerCase() !== "service") return false;
  if (override === "old") return false;
  if (override === "om") return true;
  const setting = (raw ?? DEFAULT_WHEN_UNSET).trim().toLowerCase();
  if (OFF.has(setting)) return false;
  const list = setting.split(",").map((s) => s.trim()).filter(Boolean);
  if (list.includes("all")) return true;
  return teamId !== "" && list.includes(teamId.toLowerCase());
}

/** The request's department: the iframe URL's own serviceType / service_type / department, else the console
 * page's (the Referer), since some console spaces scope Service only on the parent URL. */
export function departmentOf(sp: URLSearchParams, referer: string | null): string | null {
  const own = sp.get("serviceType") || sp.get("service_type") || sp.get("department");
  if (own) return own;
  if (!referer) return null;
  try {
    const rp = new URL(referer).searchParams;
    return rp.get("serviceType") || rp.get("service_type") || rp.get("department");
  } catch {
    return null;
  }
}

export const SERVICE_OM_OVERVIEW_PATH = "/service-om/overview";
export const SERVICE_OM_REPORTS_PATH = "/service-om/reports";
