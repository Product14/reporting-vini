/* `/reports/lead-conversations` → the Conversation rows the flow-drill and Hot & warm leads drawers render.
 * Pure, so the mapping is testable without the route. */
import type { CanonicalLeadConversations } from "@/lib/spyne/consoleReports";
import type { Conversation } from "@/components/reports/liveData";

export function leadConversationsToRows(viaApi: CanonicalLeadConversations): Conversation[] {
  /* The customer is served once per lead, not per conversation (FD-24439: the drawer read "Unknown
     caller" because both were hard-coded null). Optional: a backend without the field still sends
     neither, and null is the honest fallback rather than a fabricated name. */
  const customer = viaApi.customer?.name || null;
  const phone = viaApi.customer?.phone || null;
  return viaApi.conversations.map((c) => ({
    id: c.id,
    leadId: c.leadId,
    callId: c.callId,
    phone,
    customer,
    channel: c.channel,
    dept: "sales",
    direction: c.direction === "inbound" ? "inbound" : "outbound",
    title: c.outcome || "",
    summary: c.summary,
    durationSec: c.durationSec,
    recordingUrl: c.recordingUrl,
    outcome: c.outcome,
    /* No canonical flags for these; false is the honest default and the drawer hides them. */
    appointmentScheduled: false,
    queryResolved: false,
    hasActionItem: false,
    msgs: c.messages.length,
    /* Bubbles, oldest→newest, already ordered by the API. */
    sms: c.channel === "sms"
      ? c.messages.map((m) => ({
          authorType: m.role === "customer" ? "human" : "ai",
          body: m.text,
          status: "",
          at: m.at ?? "",
          direction: m.role === "customer" ? "in" : "out",
        }))
      : undefined,
    at: c.at,
  }));
}
