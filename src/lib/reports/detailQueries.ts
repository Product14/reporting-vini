/* Rooftop-level detail queries, ClickHouse-direct (replacing Metabase cards 12232 / 12231).
 *
 * These feed the per-rooftop detail tables the GET API attaches to each report:
 *   • campaignsSql → report_campaigns   (was card 12232 — "best campaigns")
 *   • outcomesSql  → report_outcomes     (was card 12231 — outbound disposition mix, bucketed)
 *   • callbacksSql → report_callbacks    (was card 12234 — "priority follow-ups": open callback action items)
 *
 * Both emit `agent_type` ('Sales Outbound' | 'Service Outbound') directly (derived from the campaign /
 * lead service_type) so the sync no longer has to pull once per agent_type and tag — one query, all
 * rooftops. Each query takes an optional single-team filter for per-rooftop chunking, and campaignsSql
 * takes a `${startFloor}` (e.g. addDays(today(), -120)) that bounds BOTH meeting-attribution paths so a
 * full run never scans endcallreports/meetings all-time (the 57.6 GiB OOM ceiling).
 *
 * Callback attribution: campaignsSql adds a UNION-ALL branch crediting callback-booked appointments to
 * their originating campaign (endcallreports.callbackCampaignId); countDistinct(meeting_id) dedupes a
 * meeting reachable via both an outbound task and a callback. outcomesSql needs NO callback change — it
 * is lead/mapping grain (buckets campaignLeadMappings.outcome per lead), never call-direction.
 */

const esc = (v: string): string => String(v ?? "").replace(/'/g, "''").replace(/\\/g, "\\\\");

/** `AND <col> = '<team>'` or '' (all teams). */
const teamPred = (col: string, teamId?: string): string =>
  teamId ? `AND ${col} = '${esc(teamId)}'` : "";

export interface CampaignsOpts {
  teamId?: string;
  startFloor?: string; // ClickHouse date expr, e.g. "addDays(today(), -120)". Default floors meeting/callback scans.
}

export function campaignsSql({ teamId, startFloor = "addDays(today(), -120)" }: CampaignsOpts = {}): string {
  return `
WITH campaign_meta AS (
    SELECT c.campaignId AS campaignId,
           any(c.name) AS campaign_name, any(c.campaignUseCase) AS use_case,
           any(lower(c.campaignType)) AS campaign_type,
           any(c.teamId) AS team_id, any(c.enterpriseId) AS enterprise_id
    FROM dealer_leads.campaigns AS c FINAL
    WHERE c.__deleted = 0
      AND lower(c.campaignType) IN ('sales','service')
      ${teamPred("c.teamId", teamId)}
    GROUP BY c.campaignId
),
-- Outbound-task attribution: campaign -> outbound call -> meeting.
campaign_calls AS (
    SELECT ot.campaignId AS campaignId, ot.callId AS callId
    FROM dealer_leads.outboundTasks AS ot FINAL
    WHERE ot.__deleted = 0 AND ot.callId IS NOT NULL AND ot.callId != ''
      ${teamPred("ot.teamId", teamId)}
),
-- Callback attribution: an inbound callback carries its originating campaign on the ECR; the meeting
-- booked on that inbound callId belongs to the campaign too. Floored so a full run never scans all-time.
callback_calls AS (
    SELECT ecr.callbackCampaignId AS campaignId, ecr.callId AS callId
    FROM dealer_leads.endcallreports AS ecr FINAL
    WHERE ecr.__deleted = 0
      AND ecr.callId IS NOT NULL AND ecr.callId != ''
      AND ifNull(ecr.callbackCampaignId,'') != ''
      AND toDate(ecr.createdAt) >= ${startFloor}
      ${teamPred("ecr.teamId", teamId)}
),
attributed_calls AS (
    SELECT campaignId, callId FROM campaign_calls
    UNION ALL
    SELECT campaignId, callId FROM callback_calls
),
campaign_appts AS (
    SELECT ac.campaignId AS campaignId, countDistinct(m.meeting_id) AS appts
    FROM attributed_calls ac
    JOIN dealer_leads.meetings AS m FINAL
        ON m.call_id = ac.callId AND m.__deleted = 0 AND m.is_active = 1 AND m.source = 'spyne'
    GROUP BY ac.campaignId
),
campaign_outcomes AS (
    SELECT
        clm.campaignId AS campaignId,
        countDistinct(clm.leadId) AS enrolled,
        countDistinctIf(clm.leadId, lower(clm.outcome) IN (
            'general engagement','purchase intent','vehicle inquiry','pricing inquiry',
            'financing inquiry','trade inquiry','customer considering','customer open to return',
            'reconnect needed'
        )) AS warm_leads,
        countDistinctIf(clm.leadId, lower(clm.outcome) = 'opt out') AS opt_outs,
        countDistinctIf(clm.leadId, lower(clm.outcome) IN (
            'not connected','wrong number','decision maker unavailable','number disconnected'
        )) AS no_reach
    FROM dealer_leads.campaignLeadMappings AS clm FINAL
    WHERE clm.__deleted = 0
      ${teamPred("clm.teamId", teamId)}
    GROUP BY clm.campaignId
)
SELECT
    cm.team_id AS team_id,
    concat(if(cm.campaign_type='sales','Sales ','Service '),'Outbound') AS agent_type,
    cm.campaign_name AS campaign,
    cm.use_case AS use_case,
    co.enrolled AS enrolled,
    ifNull(ca.appts, 0) AS appointments,
    co.warm_leads AS warm_leads,
    co.opt_outs AS opt_outs,
    co.no_reach AS no_reach,
    round(100.0 * ifNull(ca.appts,0) / nullIf(co.enrolled,0), 1) AS appt_rate_pct
FROM campaign_meta cm
JOIN campaign_outcomes co ON co.campaignId = cm.campaignId
LEFT JOIN campaign_appts ca ON ca.campaignId = cm.campaignId
WHERE co.enrolled >= 20
ORDER BY team_id, appointments DESC, warm_leads DESC
SETTINGS join_use_nulls = 1`.trim();
}

export interface OutcomesOpts {
  teamId?: string;
}

export function outcomesSql({ teamId }: OutcomesOpts = {}): string {
  return `
WITH ob_leads AS (
    SELECT DISTINCT l.lead_id AS lead_id, l.team_id AS team_id, l.service_type AS service_type
    FROM dealer_leads.leads AS l FINAL
    JOIN eventila.enterprise_details ed FINAL ON l.enterprise_id = ed.enterprise_id
    WHERE l.is_deleted = 0 AND l.__deleted = 0
      AND l.service_type IN ('sales','service')
      AND ed.is_test_account = 0 AND (ed.reseller_id IS NULL OR ed.reseller_id = '')
      AND lower(ifNull(ed.name,'')) NOT LIKE '%test%'
      AND lower(ifNull(ed.name,'')) NOT LIKE '%demo%'
      AND lower(ifNull(ed.name,'')) NOT LIKE '%sandbox%'
      ${teamPred("l.team_id", teamId)}
),
bucketed AS (
    SELECT
        ol.team_id AS team_id,
        concat(if(ol.service_type='sales','Sales ','Service '),'Outbound') AS agent_type,
        multiIf(
            coalesce(nullIf(lower(trimBoth(clm.outcome)),''),'') = '', '0 Not yet worked',
            lower(trimBoth(clm.outcome)) IN
                ('not connected','wrong number','decision maker unavailable','number disconnected',
                 'language barrier'), '1 No reach',
            lower(trimBoth(clm.outcome)) = 'opt out', '2 Opt out',
            lower(trimBoth(clm.outcome)) IN
                ('general engagement','purchase intent','vehicle inquiry','pricing inquiry',
                 'financing inquiry','trade inquiry','customer considering','customer open to return',
                 'reconnect needed','ancillary inquiry'), '3 Warm / engaged',
            lower(trimBoth(clm.outcome)) IN
                ('appointment','service appointment booked','meeting already scheduled',
                 'customer already self booked','walk in committed','appointment rescheduled',
                 'deposit placed'), '4 Booked',
            lower(trimBoth(clm.outcome)) = 'callback requested', '5 Callback',
            lower(trimBoth(clm.outcome)) IN
                ('human transferred','transferred to service team','human requested'), '6 Transferred',
            lower(trimBoth(clm.outcome)) IN
                ('not interested','already purchased','soft decline','customer permanently declined',
                 'customer permanently using competitor','vehicle sold or traded',
                 'customer no longer owns vehicle','customer relocated','appointment cancelled',
                 'vehicle written off','customer deceased','customer busy no callback'), '7 Lost / declined',
            lower(trimBoth(clm.outcome)) IN
                ('could not conclude','recall information shared','no slots available','operating hours',
                 'drop off details shared','location shared','price estimate shared'), '8 Unclear / info',
            '9 Other'
        ) AS outcome_bucket
    FROM dealer_leads.campaignLeadMappings AS clm FINAL
    JOIN ob_leads ol ON ol.lead_id = clm.leadId
    WHERE clm.__deleted = 0
)
SELECT
    team_id AS team_id,
    agent_type AS agent_type,
    outcome_bucket AS outcome_bucket,
    count() AS mappings
FROM bucketed
GROUP BY team_id, agent_type, outcome_bucket
ORDER BY team_id, agent_type, outcome_bucket
SETTINGS join_use_nulls = 1`.trim();
}

export interface CallbacksOpts {
  teamId?: string;
  startFloor?: string; // ClickHouse date expr; floors the actionItems scan (open callbacks are recent).
}

// "Priority follow-ups" — open callback action items on campaign-enrolled leads (was card 12234).
// Verified: customer.name exists; the callback intent vocab is REQUEST_CALLBACK / RequestCallback /
// SERVICE_PARTS_CALLBACK (all matched by the case-insensitive 'callback' position test). Emits team_id
// (not the rooftop name) so it maps straight onto CallbackRow with no rooftop→team lookup.
export function callbacksSql({ teamId, startFloor = "addDays(today(), -90)" }: CallbacksOpts = {}): string {
  return `
WITH ob_leads AS (
    SELECT DISTINCT l.lead_id AS lead_id, l.team_id AS team_id, l.customer_id AS customer_id
    FROM dealer_leads.leads AS l FINAL
    JOIN eventila.enterprise_details ed FINAL ON l.enterprise_id = ed.enterprise_id
    JOIN (SELECT DISTINCT leadId AS lead_id FROM dealer_leads.campaignLeadMappings FINAL WHERE __deleted = 0) clm
        ON clm.lead_id = l.lead_id
    WHERE l.is_deleted = 0 AND l.__deleted = 0
      AND l.service_type IN ('sales','service')
      AND ed.is_test_account = 0 AND (ed.reseller_id IS NULL OR ed.reseller_id = '')
      AND lower(ifNull(ed.name,'')) NOT LIKE '%test%'
      AND lower(ifNull(ed.name,'')) NOT LIKE '%demo%'
      AND lower(ifNull(ed.name,'')) NOT LIKE '%sandbox%'
      ${teamPred("l.team_id", teamId)}
)
SELECT
    ol.team_id                           AS team_id,
    cu.name                              AS customer_name,
    ai.due_date                          AS callback_due,
    ai.intent                            AS intent,
    ai.priority                          AS priority,
    ai.assigned_to                       AS assigned_to,
    ai.createdAt                         AS requested_on
FROM dealer_leads.actionItems AS ai FINAL
JOIN ob_leads ol ON ol.lead_id = ai.lead_id AND ol.team_id = ai.team_id
LEFT JOIN dealer_leads.customer AS cu FINAL
    ON cu.customer_id = ol.customer_id AND cu.__deleted = 0
WHERE ai.__deleted = 0
  AND ifNull(ai.is_active, 0) = 1
  AND ifNull(ai.is_completed, 0) = 0
  AND positionCaseInsensitive(ifNull(ai.intent,''), 'callback') > 0
  AND toDate(ai.createdAt) >= ${startFloor}
ORDER BY ai.due_date ASC
SETTINGS join_use_nulls = 1`.trim();
}
