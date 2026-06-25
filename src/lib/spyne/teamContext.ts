/* Per-team enrichment resolved from the Spyne API: the rooftop's timezone and the set of agent slots
 * the dealer has actually onboarded. Both degrade to null (→ caller keeps prior behavior) when auth is
 * unconfigured or the call fails. See client.ts for the stubbed-auth note. */

import { spyneGet, cached } from "./client";
import { getSupabase } from "@/lib/reports/supabase";
import { fetchTeamTz } from "@/lib/reports/tzMap";
import { loadTeamTz, saveTzMap } from "@/lib/reports/tzStore";
import type { AgentData } from "@/components/reports/data";

type SlotId = AgentData["id"]; // "sales_ib" | "sales_ob" | "service_ib" | "service_ob"

// ───────────────────────── working hours → timezone ─────────────────────────

/* The rooftop's IANA timezone (e.g. "America/Los_Angeles"), or null when unknown.
 *
 * Resolution order:
 *   1. LIVE get-working-days (customer-scoped, keyed by teamId) — works in prod with the dealer's own
 *      forwarded token, and needs no admin credential, so it resolves ANY rooftop incl. brand-new ones.
 *      On success we also upsert team_tz, so the token-less sync picks up new rooftops without a backfill.
 *   2. Persisted team_tz — fallback when the live call can't be reached (endpoint down / network blip).
 * Both degrade to null → caller keeps prior behavior (UTC window). */
// team_ids whose tz we've already persisted this process lifetime. A rooftop's tz almost never changes,
// so re-upserting team_tz on every /api/reports call was a large slice of the project's write volume.
// We self-heal at most once per team per warm instance; the 5-min sync re-persists everyone from live
// data anyway, so a genuinely changed tz is still picked up promptly.
const tzPersisted = new Set<string>();

export async function getStoreTimeZone(teamId: string, token?: string | null): Promise<string | null> {
  if (!teamId) return null;
  const live = await cached(`tz:${teamId}`, () => fetchTeamTz(teamId, token));
  if (live) {
    if (!tzPersisted.has(teamId)) {
      const sb = getSupabase();
      if (sb) {
        await saveTzMap(sb, new Map([[teamId, live]]), new Date().toISOString()); // self-heal team_tz for the sync
        tzPersisted.add(teamId);
      }
    }
    return live;
  }
  const sb = getSupabase();
  return sb ? loadTeamTz(sb, teamId) : null;
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
