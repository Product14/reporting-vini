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

/* The raw onboarded-agents list for a team (cached), or null when unavailable. Both getOnboardedSlots
 * and getOnboardedNames derive from this, so a report costs at most ONE call to the endpoint. */
async function getOnboardedAgents(teamId: string, token?: string | null): Promise<OnboardedAgent[] | null> {
  if (!teamId) return null;
  return cached(`oa:${teamId}`, async () => {
    const list = await spyneGet<OnboardedAgent[]>(`/conversation/agents/team/${encodeURIComponent(teamId)}/onboarded-agents`, token);
    return Array.isArray(list) ? list : null;
  });
}

/* The set of slot ids the dealer has onboarded (isOnboarded === true), or null when the list is
 * unavailable. Null means "don't gate" — the report shows all slots, as before. An empty set means the
 * call succeeded but nothing is onboarded (a real, gated-to-empty rooftop). */
export async function getOnboardedSlots(teamId: string, token?: string | null): Promise<Set<SlotId> | null> {
  const list = await getOnboardedAgents(teamId, token);
  if (!list) return null;
  const slots = new Set<SlotId>();
  for (const a of list) {
    if (a.isOnboarded === false) continue; // dealer hasn't turned this one on
    const s = slotOf(a);
    if (s) slots.add(s);
  }
  return slots;
}

/* The dealer's REAL agent display name per slot (from the onboarded-agents config) — replaces the mock
 * personas (Emily/Jenny/Mia/Theo) so the report shows the name the dealer actually gave each agent.
 * A slot with more than one onboarded agent (e.g. two service-outbound campaigns) joins its distinct
 * names with " & ". Null / a missing slot → caller keeps the mock persona. */
export async function getOnboardedNames(teamId: string, token?: string | null): Promise<Partial<Record<SlotId, string>> | null> {
  const list = await getOnboardedAgents(teamId, token);
  if (!list) return null;
  const perSlot = new Map<SlotId, string[]>();
  for (const a of list) {
    if (a.isOnboarded === false) continue;
    const s = slotOf(a);
    const name = (a.name || "").trim();
    if (!s || !name) continue;
    const arr = perSlot.get(s) ?? [];
    if (!arr.includes(name)) arr.push(name); // de-dupe repeated names within a slot
    perSlot.set(s, arr);
  }
  const names: Partial<Record<SlotId, string>> = {};
  for (const [s, arr] of perSlot) names[s] = arr.join(" & ");
  return names;
}
