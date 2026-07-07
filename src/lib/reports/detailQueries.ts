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

// A "warm lead" = a campaignLeadMappings.outcome that signals real buying intent. SINGLE SOURCE OF
// TRUTH for the warm-leads count (campaigns card + outbound headline). Deliberately EXCLUDES
// 'general engagement' — a generic "they replied" signal that isn't a warm lead and would otherwise
// dominate the count (e.g. Covina Kia: 382 of 420). Booked / opt-out / no-reach / lost are their own
// buckets, not warm. Compared against lower(trimBoth(outcome)).
// Tiered for the named "Work these now" list: hot = a concrete buying signal on the record; warm =
// engaged, nurture. INVARIANT: hot ∪ warm must equal WARM_LEAD_OUTCOMES exactly, or the campaigns /
// outcomes cards drift from the warm-leads card.
const HOT_TIER_OUTCOMES = [
  "purchase intent", "vehicle inquiry", "pricing inquiry", "financing inquiry", "trade inquiry",
  "ancillary inquiry",
];
const WARM_TIER_OUTCOMES = ["customer considering", "customer open to return", "reconnect needed"];
const WARM_LEAD_OUTCOMES = [...HOT_TIER_OUTCOMES, ...WARM_TIER_OUTCOMES];
// Mirror of agentBaseFact.sql `sms_buying_intent_actions` — the canonical concrete-buying-intent
// action-item vocab (vehicle / availability / price / financing / trade-in / test-drive / booking).
// The spine's copy is the source of truth; keep in lockstep.
const BUYING_INTENT_ACTIONS = [
  "ScheduleAppointment", "RescheduleAppointment", "SALES_SCHEDULE_SHOWROOM_VISIT",
  "CheckVehicleAvailability", "CheckVehiclePrice", "InquireFinanceStatus",
  "SALES_CONNECT_TO_FINANCE", "InquireTradeInValue", "SALES_TRADE_IN_FOLLOW_UP",
  "ScheduleTestDrive", "SALES_SCHEDULE_TEST_DRIVE", "InquireLeaseOptions",
  "SALES_FOLLOW_UP_WITH_QUOTE", "SERVICE_SCHEDULE_APPOINTMENT", "SERVICE_SEND_ESTIMATE",
];
const sqlList = (xs: string[]): string => xs.map((s) => `'${esc(s)}'`).join(",");

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
    SELECT campaignId, callId, toUInt8(1) AS is_task FROM campaign_calls
    UNION ALL
    SELECT campaignId, callId, toUInt8(0) AS is_task FROM callback_calls
),
campaign_appts AS (
    -- Narrow source relaxation: a meeting booked on an OUTBOUND-TASK (campaign) call is AI-driven even
    -- when meetings.source wasn't stamped 'spyne' (some AI-outbound bookings land with a null source).
    -- Callback-attributed inbound calls still require source='spyne' to keep human/CRM (bdc) bookings out.
    SELECT ac.campaignId AS campaignId, countDistinct(m.meeting_id) AS appts
    FROM attributed_calls ac
    JOIN dealer_leads.meetings AS m FINAL
        ON m.call_id = ac.callId AND m.__deleted = 0 AND m.is_active = 1
    WHERE m.source = 'spyne' OR ac.is_task = 1
    GROUP BY ac.campaignId
),
campaign_outcomes AS (
    SELECT
        clm.campaignId AS campaignId,
        countDistinct(clm.leadId) AS enrolled,
        countDistinctIf(clm.leadId, lower(trimBoth(clm.outcome)) IN (${sqlList(WARM_LEAD_OUTCOMES)})) AS warm_leads,
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
            -- Warm = buying-signal outcomes only (shared WARM_LEAD_OUTCOMES — same list the warm-leads
            -- count uses). 'general engagement' is split into its own '4 Engaged' bucket so the card's
            -- warm segment matches the warm-leads KPI instead of being inflated by it.
            lower(trimBoth(clm.outcome)) IN (${sqlList(WARM_LEAD_OUTCOMES)}), '3 Warm',
            lower(trimBoth(clm.outcome)) = 'general engagement', '4 Engaged',
            lower(trimBoth(clm.outcome)) IN
                ('appointment','service appointment booked','meeting already scheduled',
                 'customer already self booked','walk in committed','appointment rescheduled',
                 'deposit placed'), '5 Booked',
            lower(trimBoth(clm.outcome)) = 'callback requested', '6 Callback',
            lower(trimBoth(clm.outcome)) IN
                ('human transferred','transferred to service team','human requested'), '7 Transferred',
            lower(trimBoth(clm.outcome)) IN
                ('not interested','already purchased','soft decline','customer permanently declined',
                 'customer permanently using competitor','vehicle sold or traded',
                 'customer no longer owns vehicle','customer relocated','appointment cancelled',
                 'vehicle written off','customer deceased','customer busy no callback'), '8 Lost / declined',
            lower(trimBoth(clm.outcome)) IN
                ('could not conclude','recall information shared','no slots available','operating hours',
                 'drop off details shared','location shared','price estimate shared'), '9 Unclear / info',
            '10 Other'
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
    SELECT DISTINCT l.lead_id AS lead_id, l.team_id AS team_id, l.customer_id AS customer_id,
                    l.service_type AS service_type
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
    ol.service_type                      AS service_type,
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

export interface WarmLeadsOpts {
  teamId?: string;
  startFloor?: string; // ClickHouse date expr; floors the actionItems/meetings scans. Default -45d.
}

// Named warm leads → report_warm_leads ("Work these now"). Two sources, one row per lead:
//   • OB: campaignLeadMappings outcome ∈ WARM_LEAD_OUTCOMES (the same buying-signal list the campaigns
//     card + outcomes "Warm" bucket use), tiered hot/warm by HOT_TIER_OUTCOMES.
//   • IB: a windowed concrete buying-intent action item (BUYING_INTENT_ACTIONS — the canonical
//     qualification vocab), always 'hot'. Narrower than spine-qualified (no IRA-only call matches) but
//     the operationally right "call these now" list; never summed into a KPI.
// Leads with ANY meeting in the trailing window (AI or CRM) are excluded — booked ≠ "work now".
// Bounded: actionItems + meetings floored by ${startFloor}; campaignLeadMappings is mapping-grain (same
// scan outcomesSql already does); customer joined per-lead. LIMIT 50 BY team caps table size.
export function warmLeadsSql({ teamId, startFloor = "addDays(today(), -45)" }: WarmLeadsOpts = {}): string {
  return `
WITH eligible_leads AS (
    SELECT DISTINCT l.lead_id AS lead_id, l.team_id AS team_id, l.customer_id AS customer_id,
                    l.service_type AS service_type
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
booked_leads AS (
    SELECT DISTINCT m.lead_id AS lead_id
    FROM dealer_leads.meetings AS m FINAL
    WHERE m.__deleted = 0 AND m.is_active = 1
      AND toDate(m.created_at) >= ${startFloor}
      ${teamPred("m.team_id", teamId)}
),
ob_warm AS (
    SELECT el.team_id AS team_id, 'ob' AS source, el.service_type AS service_type,
           clm.leadId AS lead_id,
           any(cm.name) AS campaign,
           any(lower(trimBoth(clm.outcome))) AS outcome,
           max(clm.updatedAt) AS last_activity
    FROM dealer_leads.campaignLeadMappings AS clm FINAL
    JOIN eligible_leads el ON el.lead_id = clm.leadId AND el.team_id = clm.teamId
    LEFT JOIN dealer_leads.campaigns AS cm FINAL ON cm.campaignId = clm.campaignId AND cm.__deleted = 0
    WHERE clm.__deleted = 0
      AND lower(trimBoth(clm.outcome)) IN (${sqlList(WARM_LEAD_OUTCOMES)})
      AND clm.leadId NOT IN (SELECT lead_id FROM booked_leads)
    GROUP BY el.team_id, el.service_type, clm.leadId
),
ib_warm AS (
    SELECT el.team_id AS team_id, 'ib' AS source, el.service_type AS service_type,
           ai.lead_id AS lead_id, '' AS campaign,
           any(ai.intent) AS outcome,
           max(ai.createdAt) AS last_activity
    FROM dealer_leads.actionItems AS ai FINAL
    JOIN eligible_leads el ON el.lead_id = ai.lead_id AND el.team_id = ai.team_id
    WHERE ai.__deleted = 0
      AND ifNull(ai.intent,'') IN (${sqlList(BUYING_INTENT_ACTIONS)})
      AND toDate(ai.createdAt) >= ${startFloor}
      AND ai.lead_id NOT IN (SELECT lead_id FROM booked_leads)
      AND ai.lead_id NOT IN (SELECT lead_id FROM ob_warm)
    GROUP BY el.team_id, el.service_type, ai.lead_id
)
SELECT
    w.team_id AS team_id,
    w.source AS source,
    w.service_type AS service_type,
    w.lead_id AS lead_id,
    if(w.source = 'ob' AND w.outcome IN (${sqlList(WARM_TIER_OUTCOMES)}), 'warm', 'hot') AS tier,
    any(cu.name) AS customer_name,
    any(cu.mobile_number) AS phone,
    w.campaign AS campaign,
    w.outcome AS outcome,
    w.last_activity AS last_activity
FROM (SELECT * FROM ob_warm UNION ALL SELECT * FROM ib_warm) AS w
JOIN eligible_leads el2 ON el2.lead_id = w.lead_id AND el2.team_id = w.team_id
LEFT JOIN dealer_leads.customer AS cu FINAL ON cu.customer_id = el2.customer_id AND cu.__deleted = 0
GROUP BY w.team_id, w.source, w.service_type, w.lead_id, w.campaign, w.outcome, w.last_activity, tier
ORDER BY team_id, tier ASC, last_activity DESC
LIMIT 50 BY team_id
SETTINGS join_use_nulls = 1`.trim();
}

export interface AppointmentsOpts {
  teamId?: string;
  startFloor?: string; // ClickHouse date expr; floors the meetings scan (booked_at). Default -120d.
}

// AI-booked appointments (meetings.source='spyne') → report_appointments (revived; see migration 0016).
// Replaces the retired live /api/meetings proxy as the source for the digest's appointment LIST + "top
// vehicles". One row per meeting, resolved with:
//   • customer name/phone  ← dealer_leads.customer (customer_id)
//   • vehicle make/model/yr ← first proposed_vins token → inventory.vinMaster, with dealerVinMapping
//     bridging the dealerVinId (UUID) form. Both inventory tables are semi-joined (vin IN (…)) to only
//     the VINs a team's meetings reference, so a run never scans all of vinMaster (1.8M) / dealerVinMapping
//     (21.8M). GROUP BY meeting_id collapses any CDC/join fan-out to one row.
// Test/demo/reseller enterprises excluded (same predicate as the other detail queries). booked_at floored
// by ${startFloor} so a full run stays bounded (covers the daily window + the 30d top-vehicles window).
export function appointmentsSql({ teamId, startFloor = "addDays(today(), -120)" }: AppointmentsOpts = {}): string {
  return `
WITH ob_enrolled AS (
    -- outbound-campaign enrollment: the canonical AI-assisted gate (a CRM meeting only counts as
    -- assisted on a lead the AI worked; enrollment + the \`worked\` AI-touch check below mirror the
    -- spine's appointment_assisted rule at snapshot grain).
    SELECT DISTINCT clm.leadId AS lead_id
    FROM dealer_leads.campaignLeadMappings AS clm FINAL
    WHERE clm.__deleted = 0
      ${teamPred("clm.teamId", teamId)}
),
meet AS (
    SELECT
        m.team_id AS team_id, m.enterprise_id AS enterprise_id, m.service_type AS service_type,
        m.lead_id AS lead_id, m.meeting_id AS meeting_id, m.customer_id AS customer_id,
        m.conversation_id AS conversation_id, m.call_id AS call_id,
        m.intent AS intent, m.meeting_start_time AS meeting_start, m.created_at AS booked_at,
        m.status AS status,
        if(ifNull(m.source,'') = 'spyne', 0, 1) AS assisted,
        JSONExtractString(ifNull(m.proposed_vins, ''), 1) AS tok
    FROM dealer_leads.meetings AS m
    JOIN eventila.enterprise_details ed FINAL ON ed.enterprise_id = m.enterprise_id
    WHERE m.__deleted = 0 AND m.is_active = 1
      AND (m.source = 'spyne' OR m.lead_id IN (SELECT lead_id FROM ob_enrolled))
      AND m.service_type IN ('sales','service')
      AND m.meeting_id IS NOT NULL AND m.meeting_id != ''
      AND toDate(m.created_at) >= ${startFloor}
      AND ed.is_test_account = 0 AND (ed.reseller_id IS NULL OR ed.reseller_id = '')
      AND lower(ifNull(ed.name,'')) NOT LIKE '%test%'
      AND lower(ifNull(ed.name,'')) NOT LIKE '%demo%'
      AND lower(ifNull(ed.name,'')) NOT LIKE '%sandbox%'
      ${teamPred("m.team_id", teamId)}
),
-- agent-worked = ≥1 AI call/SMS touch (trailing window). Keyed to only the assisted meetings' leads
-- so the conversations scan stays bounded.
worked AS (
    SELECT DISTINCT c.leadId AS lead_id
    FROM dealer_leads.conversations AS c FINAL
    WHERE c.__deleted = 0 AND ifNull(c.isTest, 0) = 0 AND c.status != 'failed'
      AND lower(c.type) IN ('sms','call')
      AND toDate(c.createdAt) >= ${startFloor}
      AND c.leadId IN (SELECT lead_id FROM meet WHERE assisted = 1)
),
-- channel of the AI booking conversation (AI-booked rows only; CRM meetings carry no direction).
conv_dir AS (
    SELECT c.conversationId AS conv_id, c.callId AS call_id,
           any(lower(c.type)) AS conv_type,
           any(lower(at.agentCallType)) AS direction
    FROM dealer_leads.conversations AS c FINAL
    LEFT JOIN dealer_leads.teamAgentMappings AS tam FINAL
        ON c.teamAgentMappingId = tam.teamAgentMappingId AND tam.__deleted = 0
    LEFT JOIN dealer_leads.agentTypes AS at FINAL
        ON tam.agentTypeId = at.agentTypeId AND at.__deleted = 0
    WHERE c.__deleted = 0
      AND (c.conversationId IN (SELECT conversation_id FROM meet WHERE assisted = 0)
           OR c.callId      IN (SELECT call_id        FROM meet WHERE assisted = 0))
    GROUP BY c.conversationId, c.callId
),
-- dealerVinId (UUID) → real VIN, bounded to only the ids these meetings reference.
dvm AS (
    SELECT dealerVinId, any(vin) AS vin
    FROM inventory.dealerVinMapping
    WHERE __deleted = 0 AND dealerVinId IN (SELECT tok FROM meet WHERE tok != '')
    GROUP BY dealerVinId
),
-- VIN → make/model/year/trim, bounded to the VINs referenced directly OR via dvm.
vm AS (
    SELECT vin, any(make) AS make, any(model) AS model, any(year) AS year, any(trimLevel) AS trim
    FROM inventory.vinMaster
    WHERE __deleted = 0 AND (vin IN (SELECT tok FROM meet WHERE tok != '') OR vin IN (SELECT vin FROM dvm))
    GROUP BY vin
)
SELECT
    meet.team_id AS team_id,
    any(meet.enterprise_id) AS enterprise_id,
    any(meet.service_type) AS service_type,
    any(meet.lead_id) AS lead_id,
    meet.meeting_id AS meeting_id,
    any(cu.name) AS customer_name,
    any(cu.mobile_number) AS phone,
    any(arrayStringConcat(arrayFilter(x -> x != '' AND x != '0', [
        toString(coalesce(vm.year, vm2.year, 0)),
        coalesce(vm.make, vm2.make, ''),
        coalesce(vm.model, vm2.model, ''),
        coalesce(vm.trim, vm2.trim, '')]), ' ')) AS vehicle,
    any(meet.intent) AS intent,
    any(meet.meeting_start) AS meeting_start,
    any(meet.booked_at) AS booked_at,
    any(meet.status) AS status,
    meet.assisted AS assisted,
    any(if(meet.assisted = 1, NULL, coalesce(cd1.direction, cd2.direction))) AS direction,
    any(if(meet.assisted = 1, NULL, coalesce(cd1.conv_type, cd2.conv_type))) AS booked_via
FROM meet
LEFT JOIN dealer_leads.customer AS cu FINAL ON cu.customer_id = meet.customer_id AND cu.__deleted = 0
LEFT JOIN vm ON vm.vin = meet.tok
LEFT JOIN dvm ON dvm.dealerVinId = meet.tok
LEFT JOIN vm AS vm2 ON vm2.vin = dvm.vin
LEFT JOIN conv_dir AS cd1 ON cd1.conv_id = meet.conversation_id
LEFT JOIN conv_dir AS cd2 ON cd2.call_id = meet.call_id
WHERE meet.assisted = 0 OR meet.lead_id IN (SELECT lead_id FROM worked)
GROUP BY meet.team_id, meet.meeting_id, meet.assisted
ORDER BY booked_at DESC
SETTINGS join_use_nulls = 1`.trim();
}
