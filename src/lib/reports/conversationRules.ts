/* Pure rules for the /api/conversations feed (the post-conversation email poller and the Calls tab).
 * Kept free of I/O so each one can be tested on its own and stays identical to the spine it mirrors. */

/* An opt-out reply is the customer LEAVING, not replying. The spine's canonical list, verbatim
 * (agentBaseFact.sql sms_by_conv `n_human_inbound_real`): a human inbound message whose WHOLE trimmed
 * body, upper-cased, is one of these does not count as engagement. Keep the two in lockstep. */
export const OPT_OUT_KEYWORDS: readonly string[] = [
  "STOP", "STOPALL", "STOP ALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT",
  "OPTOUT", "OPT OUT", "REMOVE", "NO",
];
const OPT_OUT_SET = new Set(OPT_OUT_KEYWORDS);

/** True when the message body is nothing but an opt-out keyword (case/whitespace-insensitive). */
export function isOptOutBody(body: string | null | undefined): boolean {
  return OPT_OUT_SET.has((body ?? "").trim().toUpperCase());
}

/** The keyword list as a ClickHouse IN-list, for the SQL twin of isOptOutBody. */
export function optOutSqlList(): string {
  return `(${OPT_OUT_KEYWORDS.map((k) => `'${k.replace(/'/g, "''")}'`).join(",")})`;
}

/* A REAL reply = a human-authored INBOUND message that is not just an opt-out keyword (audit A3-11: 99
 * SMS summary emails went out where the day's only reply was STOP). `authorType='human'` alone is not
 * enough: dealer staff texting from the console are also 'human', with direction 'out'. */
export function isRealReply(m: { authorType?: string | null; direction?: string | null; body?: string | null }): boolean {
  return (m.authorType ?? "").toLowerCase() === "human"
    && (m.direction ?? "").toLowerCase() === "in"
    && !isOptOutBody(m.body);
}

/* A call's direction, by the spine's rule (agentBaseFact.sql + callbackAttribution.ts), not by
 * report_inOutType — that column is blank or 'inbound' on 48% of outboundPhoneCall rows (audit A3-16).
 *   • A callback from an outbound touch is OUTBOUND whatever line it came in on: the spine credits the
 *     conversation (and any booking) to the outbound agent, so the feed must say the same.
 *   • Otherwise callDetails_callType: outboundPhoneCall → outbound; inboundPhoneCall / webCall → inbound.
 *   • An unrecognised callType falls back to report_inOutType, then inbound (the previous default). */
export function callDirection(c: {
  callType?: string | null;
  inOutType?: string | null;
  isCallbackFromOutbound?: number | string | boolean | null;
  callbackCampaignId?: string | null;
  callbackOutboundTaskId?: string | null;
}): "inbound" | "outbound" {
  const cb = c.isCallbackFromOutbound;
  if (cb === true || Number(cb) === 1 || (c.callbackCampaignId ?? "").trim() || (c.callbackOutboundTaskId ?? "").trim()) return "outbound";
  const t = (c.callType ?? "").trim().toLowerCase();
  if (t === "outboundphonecall") return "outbound";
  if (t === "inboundphonecall" || t === "webcall") return "inbound";
  return (c.inOutType ?? "").trim().toLowerCase() === "outbound" ? "outbound" : "inbound";
}

/** report.spam as served: 'Yes' / 'No', or null when the report carries no verdict. */
export function spamFlag(raw: unknown): "Yes" | "No" | null {
  const v = String(raw ?? "").trim().toLowerCase();
  return v === "yes" ? "Yes" : v === "no" ? "No" : null;
}

/* Offset paging for one channel's page: a full page means there may be more. `nextOffset` is where the
 * next page starts, null when this page came back short. */
export function pageMeta(returned: number, limit: number, offset: number): { hasMore: boolean; nextOffset: number | null } {
  const hasMore = returned >= limit;
  return { hasMore, nextOffset: hasMore ? offset + returned : null };
}
