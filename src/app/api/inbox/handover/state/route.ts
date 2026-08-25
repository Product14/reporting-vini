/* Inbox — read a customer's SMS human-handover state (RETCONVAI-2997). UAT-ONLY.
 *
 * The inbox thread renders from conversations/V2, which does NOT carry humanTransferDetails. The handover
 * state (phase / summary / triggerReason / per-message authorType) lives ONLY on the V1 endpoint
 *   GET /conversation/customers/conversations?enterprise_id=&team_id=&customer_id=
 * (verified UAT: V1 has it, V2 does not). This proxy fetches V1 and returns the single ACTIONABLE handover
 * for the customer — prefer ACTIVE, else the most-recently-flagged PENDING — as a compact object the
 * thread footer consumes. Its conversationId is what /handover/toggle and /handover/send operate on.
 *
 *   GET /api/inbox/handover/state?team_id=&enterprise_id=&customer_id=   (requires env=uat + auth)
 *
 * NOTE: V1 rejects serviceType/page/limit (400) — send ONLY the three ids.
 */
import { requireTeamAuth, spyneTokenFrom, spyneEnvFrom } from "@/lib/reports/auth";
import { handoverEnabled } from "@/lib/inbox/handover";
import { spyneServiceGet, svcIdOk } from "@/lib/spyne/conversationApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface HTD {
  phase?: string;
  handoverSummary?: string | null;
  triggerReason?: string | null;
  aiFlaggedAt?: string | null;
  claimedByName?: string | null;
  claimedByUserId?: string | null;
}
interface V1Conv {
  conversationId?: string;
  type?: string;
  humanTransferDetails?: HTD | null;
}

const NONE = { phase: "NONE" as const };

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const teamId = (searchParams.get("team_id") || "").trim();
  if (!svcIdOk(teamId)) return Response.json({ error: "valid team_id is required" }, { status: 400 });
  // Prod never has handover → answer "no handover" (a read; benign) rather than erroring the thread load.
  if (spyneEnvFrom(request) !== "uat") return Response.json(NONE, { status: 200 });

  // Feature switch off → answer "no handover" (a read; benign) rather than erroring the thread load.
  if (!handoverEnabled()) return Response.json(NONE, { status: 200 });

  const auth = requireTeamAuth(request, teamId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const enterpriseId = (searchParams.get("enterprise_id") || "").trim();
  const customerId = (searchParams.get("customer_id") || "").trim();
  if (!svcIdOk(enterpriseId) || !customerId) return Response.json({ error: "enterprise_id and customer_id are required" }, { status: 400 });

  const qs = new URLSearchParams({ enterprise_id: enterpriseId, team_id: teamId, customer_id: customerId });
  const res = await spyneServiceGet<{ data?: { conversations?: V1Conv[] }; conversations?: V1Conv[] }>(
    `/conversation/customers/conversations?${qs}`,
    spyneTokenFrom(request),
    spyneEnvFrom(request),
  );
  if (!res.ok || !res.data) return Response.json({ ...NONE, degraded: true }, { status: 200 });

  const convs = res.data.data?.conversations ?? res.data.conversations ?? [];
  const flagged: { conversationId: string; htd: HTD }[] = [];
  for (const c of convs) {
    const htd = c.humanTransferDetails;
    if (c.conversationId && htd && (htd.phase === "PENDING" || htd.phase === "ACTIVE")) {
      flagged.push({ conversationId: c.conversationId, htd });
    }
  }

  // ACTIVE wins (a rep is already on it); otherwise the newest PENDING by aiFlaggedAt.
  const active = flagged.find((c) => c.htd.phase === "ACTIVE");
  const pendings = flagged
    .filter((c) => c.htd.phase === "PENDING")
    .sort((a, b) => String(b.htd.aiFlaggedAt || "").localeCompare(String(a.htd.aiFlaggedAt || "")));
  const picked = active ?? pendings[0];
  if (!picked) return Response.json(NONE, { status: 200 });

  return Response.json(
    {
      phase: picked.htd.phase,
      conversationId: picked.conversationId,
      handoverSummary: picked.htd.handoverSummary ?? null,
      triggerReason: picked.htd.triggerReason ?? null,
      claimedByName: picked.htd.claimedByName ?? null,
      aiFlaggedAt: picked.htd.aiFlaggedAt ?? null,
    },
    { status: 200 },
  );
}
