/* SMS human handover (RETCONVAI-2997) — the single switch for the whole feature.
 *
 * The feature is LIVE on prod. It was gated per-environment while the backend was UAT-only; going GA
 * replaced those checks with allowlists spread across the UI, the client data layer and the proxy routes.
 * This collapses them into one place, and keeps a way to turn the feature OFF: /handover/send puts a REAL
 * SMS in front of a customer, so there has to be a lever that stops it without a revert + redeploy.
 *
 *   NEXT_PUBLIC_INBOX_HANDOVER=off
 *
 * hides every handover control, short-circuits the client fetchers and makes the proxies refuse.
 * NEXT_PUBLIC_ so the one variable governs the browser bundle and the route handlers alike; anything
 * else (unset included) means enabled.
 */
export function handoverEnabled(): boolean {
  const v = (process.env.NEXT_PUBLIC_INBOX_HANDOVER ?? "").trim().toLowerCase();
  return v !== "off" && v !== "0" && v !== "false" && v !== "disabled";
}
