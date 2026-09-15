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

export async function getStoreTimeZone(teamId: string, token?: string | null, env?: string | null): Promise<string | null> {
  if (!teamId) return null;
  // Cache key includes env — the SAME teamId can be queried once via a prod token/env and once via UAT
  // (e.g. a rooftop staged in both), and those two calls hit different backends that can legitimately
  // disagree; keying on teamId alone would let one silently clobber the other's cached tz.
  const live = await cached(`tz:${env ?? "prod"}:${teamId}`, () => fetchTeamTz(teamId, token, env));
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
  imageUrl?: string; // avatar URL (Spyne S3), e.g. …/converseai/agents/internal/emily.png
  [k: string]: unknown; // tolerate other fields + let the fallback scan reach them
}

// The agent's avatar URL. Primary field is `imageUrl` (confirmed from the onboarded-agents payload);
// fall back to a couple of likely aliases, then to the first value that looks like an image/Spyne-S3
// URL, so a field rename on the API side never silently drops the photo.
function imageUrlOf(a: OnboardedAgent): string | null {
  for (const k of ["imageUrl", "image", "agentImage", "avatarUrl", "avatar", "photoUrl", "profileImage"]) {
    const v = a[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  for (const v of Object.values(a)) {
    if (typeof v === "string" && /^https?:\/\//i.test(v) && /(\.(png|jpe?g|webp|gif)(\?|$)|spyne-static|amazonaws|agents\/internal)/i.test(v)) return v.trim();
  }
  return null;
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
async function getOnboardedAgents(teamId: string, token?: string | null, env?: string | null): Promise<OnboardedAgent[] | null> {
  if (!teamId) return null;
  return cached(`oa:${env ?? "prod"}:${teamId}`, async () => {
    const list = await spyneGet<OnboardedAgent[]>(`/conversation/agents/team/${encodeURIComponent(teamId)}/onboarded-agents`, token, env);
    return Array.isArray(list) ? list : null;
  });
}

/* The set of slot ids the dealer has onboarded (isOnboarded === true), or null when the list is
 * unavailable. Null means "don't gate" — the report shows all slots, as before. An empty set means the
 * call succeeded but nothing is onboarded (a real, gated-to-empty rooftop). */
export async function getOnboardedSlots(teamId: string, token?: string | null, env?: string | null): Promise<Set<SlotId> | null> {
  const list = await getOnboardedAgents(teamId, token, env);
  if (!list) return null;
  const slots = new Set<SlotId>();
  for (const a of list) {
    if (a.isOnboarded === false) continue; // dealer hasn't turned this one on
    const s = slotOf(a);
    if (s) slots.add(s);
  }
  return slots;
}

/* The mappings that land in each slot, ONBOARDED ONES FIRST — the shared basis for the dealer's real
 * agent name and avatar below.
 *
 * ★ Naming is deliberately NOT gated on isOnboarded (fixed 2026-09-15). The endpoint matches on
 * { teamId, isActive: true } and carries isOnboarded as a passthrough flag, so it returns agents the
 * dealer has configured but not yet switched on — and buildResult renders any slot with ACTIVITY in the
 * window regardless of that flag, because a live agent must never be silently dropped. Filtering the
 * flag HERE therefore left such an agent with no configured name and fell back to the mock persona:
 * Bill Wright Toyota (team ef65efcd31) named both sales agents "Avery", but its Sales Outbound mapping
 * still read isOnboarded=false while placing real calls, so the report titled it "Jenny" — a name the
 * dealer never chose. Entitlement gating is getOnboardedSlots' job; naming just reports the config.
 *
 * A slot that has at least one onboarded mapping ignores its un-onboarded ones (so switching an agent
 * on never mixes in the name of one that is still off); a slot with none falls back to them. */
function mappingsBySlot(list: OnboardedAgent[]): Map<SlotId, OnboardedAgent[]> {
  const bySlot = new Map<SlotId, OnboardedAgent[]>();
  for (const a of list) {
    const s = slotOf(a);
    if (!s) continue;
    bySlot.set(s, [...(bySlot.get(s) ?? []), a]);
  }
  for (const [s, arr] of bySlot) {
    const on = arr.filter((a) => a.isOnboarded !== false);
    bySlot.set(s, on.length ? on : arr);
  }
  return bySlot;
}

/* The dealer's REAL agent display name per slot (from the onboarded-agents config) — replaces the mock
 * personas (Emily/Jenny/Mia/Theo) so the report shows the name the dealer actually gave each agent.
 * A slot with more than one agent (e.g. two service-outbound campaigns) joins its distinct names with
 * " & ". Null / a missing slot → caller keeps the mock persona. */
export async function getOnboardedNames(teamId: string, token?: string | null, env?: string | null): Promise<Partial<Record<SlotId, string>> | null> {
  const list = await getOnboardedAgents(teamId, token, env);
  if (!list) return null;
  const names: Partial<Record<SlotId, string>> = {};
  for (const [s, arr] of mappingsBySlot(list)) {
    const distinct: string[] = [];
    for (const a of arr) {
      const name = (a.name || "").trim();
      if (name && !distinct.includes(name)) distinct.push(name); // de-dupe repeated names within a slot
    }
    if (distinct.length) names[s] = distinct.join(" & ");
  }
  return names;
}

/* The dealer's REAL agent avatar per slot (imageUrl from the onboarded-agents config) — so the report
 * shows the actual agent photo instead of the mock Emily/Jenny art. First agent with an image wins per
 * slot. Null / missing slot → caller keeps the mock avatar. */
export async function getOnboardedPhotos(teamId: string, token?: string | null, env?: string | null): Promise<Partial<Record<SlotId, string>> | null> {
  const list = await getOnboardedAgents(teamId, token, env);
  if (!list) return null;
  const photos: Partial<Record<SlotId, string>> = {};
  for (const [s, arr] of mappingsBySlot(list)) {
    const url = arr.map(imageUrlOf).find(Boolean);
    if (url) photos[s] = url;
  }
  return photos;
}
