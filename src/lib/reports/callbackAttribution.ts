/* Callback-from-outbound re-attribution — injected once into the conversation spine (agentBaseFact.sql).
 *
 * Business rule: an OUTBOUND campaign calls a lead; the lead later calls back and an INBOUND agent
 * picks up and (often) books. That callback is outbound-driven effort, so the conversation — and every
 * metric on it, including the appointment — must be credited to the OUTBOUND agent, not Inbound.
 *
 * Signal: the flattened dealer_leads.endcallreports columns isCallbackFromOutbound / callbackCampaignId
 * / callbackOutboundTaskId, joined to the spine by callId. (The sibling vini-daily-calls reads the same
 * fact from the raw doc JSON at callDetails.outboundCallbackContext.callbackFromOutbound; the flattened
 * columns are equivalent — verified ≈ 1:1 — far cheaper because they avoid the OOM-prone raw-doc scan,
 * and they additionally carry the originating campaignId/outboundTaskId that the raw path lacks.)
 *
 * Rather than fork agentBaseFact.sql, this injects three edits at LOAD time via anchor strings:
 *   1. a `callback_from_outbound` CTE (callId + team_id + originating campaign/task of callback calls),
 *   2. a LEFT JOIN of that CTE onto the conversation spine, and
 *   3. a direction / agent_type override that flips matched inbound rows to Outbound.
 * Anchors are asserted (throws on miss) so any drift in the upstream spine SQL fails LOUDLY instead of
 * silently skipping the fix. On re-sync the fix re-applies automatically.
 *
 * IMPORTANT: the injected CTE is floored by `{START}` (the same placeholder the spine uses) so it never
 * scans endcallreports all-time — substitute {START} AFTER applying this, exactly as for the spine body.
 * Apply this only to SQL that contains {START} (i.e. the spine); the detail queries carry their own
 * callback branch.
 */

const CTE_ANCHOR = "customer_opt_out AS (";

const CTE_BLOCK = `callback_from_outbound AS (
    -- Inbound calls the customer placed back in response to an outbound touch. Flattened signal on
    -- dealer_leads.endcallreports (joined by callId); floored by {START} to match the spine window
    -- and avoid an all-time endcallreports FINAL scan. Also carries the originating campaign/task so
    -- callback-booked appointments can be campaign-attributed downstream.
    SELECT
        ecr.callId AS callId,
        ecr.teamId AS team_id,
        toUInt8(1) AS is_callback,
        any(ecr.callbackCampaignId)     AS callback_campaign_id,
        any(ecr.callbackOutboundTaskId) AS callback_outbound_task_id
    FROM dealer_leads.endcallreports AS ecr FINAL
    WHERE ecr.__deleted = 0
      AND ecr.callId IS NOT NULL AND ecr.callId != ''
      AND toDate(ecr.createdAt) >= {START}
      AND ( ecr.isCallbackFromOutbound = 1
            OR ifNull(ecr.callbackCampaignId, '') != ''
            OR ifNull(ecr.callbackOutboundTaskId, '') != '' )
    GROUP BY ecr.callId, ecr.teamId
),

`;

const JOIN_ANCHOR = "LEFT JOIN eventila.enterprise_details ed FINAL";

const JOIN_BLOCK = `LEFT JOIN callback_from_outbound cbo
    ON cbo.callId = cs.callId AND cbo.team_id = cs.team_id
`;

const DIR_ANCHOR = `    cs.direction AS direction,
    concat(if(cs.service_type='sales','Sales ','Service '),
           if(cs.direction='inbound','Inbound','Outbound')) AS agent_type,`;

// Preserve the original semantics (inbound -> Inbound, else -> Outbound) but force Outbound whenever
// the call is a callback-from-outbound.
const DIR_REPLACEMENT = `    -- Callback-from-outbound: flip inbound callbacks to Outbound (see callbackAttribution.ts).
    if(cbo.is_callback = 1, 'outbound', cs.direction) AS direction,
    concat(if(cs.service_type='sales','Sales ','Service '),
           if(cbo.is_callback = 1, 'Outbound',
              if(cs.direction='inbound','Inbound','Outbound'))) AS agent_type,`;

/** Inject the callback→outbound re-attribution into a spine SQL body. Idempotent; throws if any anchor
 *  is missing (so an upstream SQL change is caught at load time, not silently dropped). */
export function applyCallbackOutboundAttribution(sql: string, label = "agentBaseFact.sql"): string {
  if (sql.includes("callback_from_outbound")) return sql; // already applied
  for (const [name, anchor] of [
    ["CTE", CTE_ANCHOR],
    ["JOIN", JOIN_ANCHOR],
    ["DIR", DIR_ANCHOR],
  ] as const) {
    if (!sql.includes(anchor)) {
      throw new Error(
        `[callbackAttribution] ${label}: missing ${name} anchor — upstream spine SQL changed, fix needs review`,
      );
    }
  }
  return sql
    .replace(CTE_ANCHOR, CTE_BLOCK + CTE_ANCHOR)
    .replace(JOIN_ANCHOR, JOIN_BLOCK + JOIN_ANCHOR)
    .replace(DIR_ANCHOR, DIR_REPLACEMENT);
}
