/* CRM_CORE_ENABLED — the single switch between crm-core-service and the legacy backends.
 *
 * Two migrated writes, both in the Inbox proxy layer (src/app/api/inbox/*):
 *   action item   PUT    /conversation/action-items/mark-completed
 *                 →  PUT    /crm-service/v1/action-items/mark-completed
 *   stop AI       DELETE /conversation/sequence-workflows/workflows/delete-by-lead
 *                 →  PATCH  /crm-service/v1/internal/sales/leads/:sales_lead_id/stop-ai-engagement
 *
 * crm-core is served from the SAME host these routes already call (apiBaseForEnv) and takes the
 * SAME dealer bearer token — no new credential, no new host, no CORS change. The switch lives in
 * the proxy routes (our API-client layer for the upstream), so src/components/inbox/* is untouched
 * and can't tell which backend answered.
 *
 * DEFAULT TRUE. Unset, empty, or unparseable → crm-core. Only an explicit false-ish value
 * ("false" / "0" / "off" / "no", any case) selects the legacy path, which exists purely as the
 * rollback and must keep working.
 *
 * Read in exactly ONE place — this module. Do not read process.env for this flag anywhere else.
 * Server-side only (route handlers), so it needs no NEXT_PUBLIC_ prefix and can be flipped by
 * changing the env var and redeploying — the browser bundle never sees it.
 */

const FALSEY = new Set(["false", "0", "off", "no"]);

function readCrmCoreFlag(): boolean {
  const raw = process.env.CRM_CORE_ENABLED;
  if (typeof raw !== "string" || raw.trim() === "") return true;
  return !FALSEY.has(raw.trim().toLowerCase());
}

export const CRM_CORE_ENABLED: boolean = readCrmCoreFlag();
