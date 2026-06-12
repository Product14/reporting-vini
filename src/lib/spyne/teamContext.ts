/* Per-team enrichment resolved from the Spyne API: the rooftop's timezone and the set of agent slots
 * the dealer has actually onboarded. Both degrade to null (→ caller keeps prior behavior) when auth is
 * unconfigured or the call fails. See client.ts for the stubbed-auth note. */

import { spyneGet, cached } from "./client";
import type { AgentData } from "@/components/reports/data";

type SlotId = AgentData["id"]; // "sales_ib" | "sales_ob" | "service_ib" | "service_ob"

// ───────────────────────── working hours → timezone ─────────────────────────

interface DayHours { is_working: boolean; start_time?: string; end_time?: string }
interface WorkingHoursRow {
  teamId: string;
  enterpriseName?: string;
  teamName?: string;
  sales?: Record<string, DayHours> | "N/A";
  service?: Record<string, DayHours> | "N/A";
  timezone?: string;
}
interface WorkingHoursResp { data?: WorkingHoursRow[] }

/* The rooftop's working-hours record (timezone + per-day sales/service hours), or null. The endpoint is
 * a paginated search; we search by team_id and match exactly (search is fuzzy and may return neighbours).
 * `token` is the host-forwarded credential (prod); omit it to use the env token (local dev). */
export async function getWorkingHours(teamId: string, token?: string | null): Promise<WorkingHoursRow | null> {
  if (!teamId) return null;
  // Cache by team only — the per-team result is identical regardless of which valid token fetched it.
  return cached(`wh:${teamId}`, async () => {
    const resp = await spyneGet<WorkingHoursResp>(
      `/conversation/admin-tools/working-hours?page=1&limit=10&search=${encodeURIComponent(teamId)}`,
      token,
    );
    const row = resp?.data?.find((r) => r.teamId === teamId);
    return row ?? null;
  });
}

/** The rooftop's IANA timezone (e.g. "America/Los_Angeles"), or null when unknown. */
export async function getStoreTimeZone(teamId: string, token?: string | null): Promise<string | null> {
  const wh = await getWorkingHours(teamId, token);
  return wh?.timezone || null;
}

// ───────────────────────── onboarded agents → slot ids ─────────────────────────

interface OnboardedAgent {
  name?: string;
  agentType?: string; // "Sales" | "Service"
  agentCallType?: string; // "inbound" | "outbound"
  isOnboarded?: boolean;
}

// (agentType, agentCallType) → this report's slot id. Anything unrecognised maps to null and is ignored.
function slotOf(a: OnboardedAgent): SlotId | null {
  const t = (a.agentType || "").toLowerCase();
  const c = (a.agentCallType || "").toLowerCase();
  if (t === "sales" && c === "inbound") return "sales_ib";
  if (t === "sales" && c === "outbound") return "sales_ob";
  if (t === "service" && c === "inbound") return "service_ib";
  if (t === "service" && c === "outbound") return "service_ob";
  return null;
}

/* The set of slot ids the dealer has onboarded (isOnboarded === true), or null when the list is
 * unavailable. Null means "don't gate" — the report shows all slots, as before. An empty set means the
 * call succeeded but nothing is onboarded (a real, gated-to-empty rooftop). */
export async function getOnboardedSlots(teamId: string, token?: string | null): Promise<Set<SlotId> | null> {
  if (!teamId) return null;
  return cached(`oa:${teamId}`, async () => {
    const list = await spyneGet<OnboardedAgent[]>(`/conversation/agents/team/${encodeURIComponent(teamId)}/onboarded-agents`, token);
    if (!Array.isArray(list)) return null;
    const slots = new Set<SlotId>();
    for (const a of list) {
      if (a.isOnboarded === false) continue; // dealer hasn't turned this one on
      const s = slotOf(a);
      if (s) slots.add(s);
    }
    return slots;
  });
}
