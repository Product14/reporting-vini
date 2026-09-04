-- =====================================================================================================
-- SALES INBOUND + SALES OUTBOUND — lead qualification and warm/hot tiering
-- Standalone, runnable ClickHouse extract of the canonical logic that lives in
--   src/lib/reports/agentBaseFact.sql   (qualification, spine)
--   src/lib/reports/detailQueries.ts    (warm/hot tiers, "work these now")
--   src/lib/reports/callbackAttribution.ts (callback -> outbound flip)
-- Run with ch-pack (3 blocks) or paste one block at a time into `ch`.
--
-- WINDOW: every scan is bounded by the two exprs marked /*W*/ — default rolling last 30 days
--   [today()-30, today()). Change BOTH everywhere, or the buying-intent gate stops matching the spine.
-- TEAM:   uncomment the `AND ... team/teamId = '<team_id>'` lines marked /*T*/ for one rooftop.
--
-- THE RULES ENCODED HERE (locked 2026-08-18):
--   Sales Inbound  qualified = the AI's OWN verdict.  call: endcallreports report.qualified='Yes'
--                              sms: conversations.conversationAnalytics.outcome IN allowlist
--                              chat: summary.qualified='Yes'
--                              NOT nested inside connected — never build a "share of engaged" rate on it.
--   Sales Outbound qualified = campaignLeadMappings.outcome IN the 20 qualifying dispositions
--                              AND the customer engaged this period (spoke on a call, or a human SMS
--                              reply that is not just an opt-out keyword).
--   Service (both) keeps the older intent rule (engaged AND a windowed buying-intent action item /
--                  IRA sales|service intent match) — included below only so the sales rows are not
--                  silently mixed with service ones.
--   Warm/hot tier  = OB campaignLeadMappings.outcome: 6 hot (concrete buying signal) + 3 warm
--                    (engaged / nurture). IB tier is always 'hot' (a concrete buying-intent action item).
--                    'general engagement' is deliberately NOT warm.
-- CAVEAT to state with any Sales Outbound number: campaignLeadMappings holds ONE current outcome per
--   lead, overwritten in place, no usable event date — it applies to every period the lead engaged and
--   can leak backwards. Not perfectly reproducible over time.
-- =====================================================================================================


-- =====================================================================================================
-- BLOCK A — lead x agent grain: qualified flag, channel it qualified on, warm/hot tier
-- =====================================================================================================
WITH
customer_opt_out AS (
    SELECT
        JSONExtractString(toString(doc), 'customer_id') AS customer_id,
        JSONExtractString(toString(doc), 'team_id')     AS team_id,
        ifNull(JSONExtractBool(toString(doc), 'optOut', 'call'), 0) AS opt_out_call,
        ifNull(JSONExtractBool(toString(doc), 'optOut', 'sms'),  0) AS opt_out_sms
    FROM dealer_leads_raw.customer FINAL
    WHERE _peerdb_is_deleted = 0
),

-- Real rooftops only: no test/demo/sandbox enterprises, and no resellers EXCEPT the allowlisted ones
-- (reseller_id records that a channel partner owns the relationship, not that the rooftop is a sandbox).
lead_canonical AS (
    SELECT
        l.lead_id AS lead_id,
        l.team_id AS team_id,
        argMax(l.enterprise_id, l.created_at) AS enterprise_id,
        argMax(l.service_type,  l.created_at) AS service_type,
        argMax(l.customer_id,   l.created_at) AS customer_id,
        argMax(l.source,        l.created_at) AS lead_source
    FROM dealer_leads.leads AS l FINAL
    JOIN eventila.enterprise_details ed FINAL ON l.enterprise_id = ed.enterprise_id
    LEFT JOIN eventila.enterprise_team_details etd FINAL
        ON l.enterprise_id = etd.enterprise_id AND l.team_id = etd.team_id
    WHERE l.is_deleted = 0 AND l.__deleted = 0
      AND l.service_type IN ('sales', 'service')
      AND ed.is_test_account = 0
      -- Reseller screen + allowlist. Hardcoded because this file must stay paste-runnable under
      -- `ch`/`ch-pack`; the source of truth is src/lib/reports/enterpriseScope.ts
      -- (RESELLER_ALLOWLIST) — keep the id list in step with it.
      AND (ed.reseller_id IS NULL OR ed.reseller_id = ''
           OR ed.enterprise_id IN ('62f962c8e'))  -- CallSource Auto
      AND lower(ifNull(ed.name, ''))  NOT LIKE '%test%'
      AND lower(ifNull(ed.name, ''))  NOT LIKE '%demo%'
      AND lower(ifNull(ed.name, ''))  NOT LIKE '%sandbox%'
      AND lower(ifNull(etd.team_name, '')) NOT LIKE '%test%'
      AND lower(ifNull(etd.team_name, '')) NOT LIKE '%demo%'
      -- AND l.team_id = '49a06313cf'                                                              /*T*/
    GROUP BY l.lead_id, l.team_id
),

-- ── The buying-intent vocabulary (Service rule + the warm/hot IB tier) ────────────────────────────
-- 25 labels, verified against prod 2026-08-18. VOCABULARY DRIFTS: an unrecognised label reads as
-- "no buying intent", so qualified sags quietly. When the AI emits a new intent name, ADD IT HERE and
-- in agentBaseFact.sql `sms_buying_intent_actions` + detailQueries.ts BUYING_INTENT_ACTIONS.
buying_intent_actions AS (
    SELECT arrayJoin([
        'ScheduleAppointment','RescheduleAppointment','SALES_SCHEDULE_SHOWROOM_VISIT',
        'CheckVehicleAvailability','CheckVehiclePrice','InquireFinanceStatus',
        'SALES_CONNECT_TO_FINANCE','InquireTradeInValue','SALES_TRADE_IN_FOLLOW_UP',
        'ScheduleTestDrive','SALES_SCHEDULE_TEST_DRIVE','InquireLeaseOptions',
        'SALES_FOLLOW_UP_WITH_QUOTE','SERVICE_SCHEDULE_APPOINTMENT','SERVICE_SEND_ESTIMATE',
        -- added 2026-08-18: names the AI drifted to, plus legacy camelCase variants
        'SALES_SCHEDULE_APPOINTMENT','SALES_SEND_VEHICLE_INFO','SALES_FOLLOW_UP_BE_BACK',
        'SEND_VEHICLE_PHOTO','SendVehicleImages','SendVehicleDetails','SendVehicleCatalog',
        'SendVehicleInformation','SendVehicleLink','CheckVehicleCondition'
    ]) AS intent
),
-- Windowed: matching action items ALL-TIME inflates qualified (~220 vs the real 32 on one rooftop).
lead_high_intent_action AS (
    SELECT DISTINCT ai.lead_id AS lead_id, ai.team_id AS team_id
    FROM dealer_leads.actionItems AS ai FINAL
    WHERE ai.__deleted = 0
      AND ifNull(ai.intent, '') IN (SELECT intent FROM buying_intent_actions)
      AND toDate(ai.createdAt) >= addDays(today(), -30)                                            /*W*/
      AND toDate(ai.createdAt) <  today()                                                          /*W*/
      -- AND ai.team_id = '49a06313cf'                                                             /*T*/
),

-- IRA intent vocabularies — the Service qualification arm (calls often show intent with no action item).
sales_intents AS (
    SELECT arrayJoin([
        'Vehicle Availability Inquiry','Vehicle Price Inquiry','Trade in value inquiry',
        'Test drive Booking','Appointment Booking/inquiry','Finance Inquiry','Lease Inquiry',
        'Vehicle condition or history inquiry','Vehicle Feature Request','Sales appointment re-scheduled',
        'Test Drive Booking','Schedule Test Drive','Vehicle Inquiry','New Vehicle Inquiry',
        'Used Vehicle Inquiry','Pricing Inquiry','Inventory Availability Inquiry','Trade-in Inquiry',
        'Financing Inquiry'
    ]) AS intent
),
service_intents AS (
    SELECT arrayJoin([
        'Appointment Booking/inquiry','Schedule Service Appointment','Reschedule Service Appointment',
        'Service appointment scheduling attempt failed','Cancel Service Appointment','Service department',
        'Service department transfer completed','Service person/Manager Request','Talk to service department',
        'General Service Inquiry','Check Repair Status','Check pickup/Delivery Status','Check Recall Status',
        'Schedule Recall','Schedule state inspection','Service Pricing/Estimate Inquiry',
        'Service pricing or estimate inquiry','Service special or coupon inquiry',
        'Service request could not be processed','Loaner Vehicle Inquiry',
        'Roadside assistance transfer completed','Talk to roadside assistance',
        'Vehicle service/ownership history inquiry','Vehicle service/ownership history provided',
        'Warranty Coverage Inquiry'
    ]) AS intent
),

-- ── Callback-from-outbound: the lead calls BACK after an outbound touch and an inbound agent picks up.
-- That is outbound-driven effort, so the conversation (and everything on it) is credited to Outbound.
callback_from_outbound AS (
    SELECT ecr.callId AS callId, ecr.teamId AS team_id, toUInt8(1) AS is_callback
    FROM dealer_leads.endcallreports AS ecr FINAL
    WHERE ecr.__deleted = 0
      AND ifNull(ecr.callId, '') != ''
      AND toDate(ecr.createdAt) >= addDays(today(), -30)                                           /*W*/
      AND toDate(ecr.createdAt) <  today()                                                         /*W*/
      AND ( ecr.isCallbackFromOutbound = 1
            OR ifNull(ecr.callbackCampaignId, '') != ''
            OR ifNull(ecr.callbackOutboundTaskId, '') != '' )
    GROUP BY ecr.callId, ecr.teamId
),

-- ── Conversation spine: one row per conversation (call | sms | chat), direction from the agent config.
-- NOTE: endcallreports.callDetails_agentInfo_agentName is "Emily Carter" for BOTH directions — the
-- Emily(inbound)/Jenny(outbound) split is a campaign/config label, never the call's agentName.
conversation_spine AS (
    SELECT
        c.conversationId             AS conversationId,
        c.callId                     AS callId,
        lower(c.type)                AS conv_type,
        c.leadId                     AS lead_id,
        c.teamId                     AS team_id,
        lc.service_type              AS service_type,
        any(lower(at.agentCallType)) AS raw_direction,
        toDate(c.createdAt)          AS activity_day
    FROM dealer_leads.conversations AS c FINAL
    JOIN lead_canonical lc ON lc.lead_id = c.leadId AND lc.team_id = c.teamId
    LEFT JOIN dealer_leads.teamAgentMappings AS tam FINAL
        ON c.teamAgentMappingId = tam.teamAgentMappingId AND tam.__deleted = 0
    LEFT JOIN dealer_leads.agentTypes AS at FINAL
        ON tam.agentTypeId = at.agentTypeId AND at.__deleted = 0
    WHERE c.__deleted = 0 AND ifNull(c.isTest, 0) = 0 AND c.status != 'failed'
      AND lower(c.type) IN ('sms', 'call', 'chat')
      AND ifNull(c.leadId, '') != ''
      AND toDate(c.createdAt) >= addDays(today(), -30)                                             /*W*/
      AND toDate(c.createdAt) <  today()                                                           /*W*/
      AND lower(at.agentCallType) IN ('inbound', 'outbound')
    GROUP BY c.conversationId, c.callId, c.type, c.leadId, c.teamId, lc.service_type, toDate(c.createdAt)
),

-- ── CALLS ────────────────────────────────────────────────────────────────────────────────────────
ecr_events AS (
    SELECT
        ecr.callId AS callId,
        ecr.teamId AS team_id,
        -- CONNECTED / "real conversation": never a voicemail or answering machine, AND the customer
        -- actually spoke (a role='user' turn). report.connected alone is the dialer's line-reached flag —
        -- it fires on voicemail too and was inflating outbound "connected" ~2x.
        if(lower(ifNull(ecr.callDetails_endedReason, '')) NOT LIKE '%voicemail%'
           AND lower(ifNull(ecr.callDetails_endedReason, '')) NOT LIKE '%machine%'
           AND arrayExists(x -> JSONExtractString(x, 'role') = 'user',
                           JSONExtractArrayRaw(ifNull(ecr.callDetails_messages, '[]'))),
           1, 0) AS is_connected,
        -- ★ SALES INBOUND gate — the AI's own verdict. report.connected is deliberately NOT read
        -- (the key is present on 0 of 451,526 rows).
        if(JSONExtractString(ifNull(ecr.report, '{}'), 'qualified') = 'Yes', 1, 0) AS report_qualified,
        -- SERVICE gate (the older intent rule): engaged AND (buying-intent action item OR IRA intent match),
        -- not opted out.
        if(ifNull(co.opt_out_call, 0) = 0 AND ifNull(co.opt_out_sms, 0) = 0
           AND lower(ifNull(ecr.callDetails_endedReason, '')) NOT LIKE '%voicemail%'
           AND lower(ifNull(ecr.callDetails_endedReason, '')) NOT LIKE '%machine%'
           AND arrayExists(x -> JSONExtractString(x, 'role') = 'user',
                           JSONExtractArrayRaw(ifNull(ecr.callDetails_messages, '[]')))
           AND ( hia.lead_id IS NOT NULL
                 OR ( ira.sourceId IS NOT NULL
                      AND ( (lower(ecr.callDetails_agentInfo_agentType) = 'sales'
                             AND trimBoth(coalesce(JSONExtractString(ira.qualification_block,'primary_intent'),''))
                                 IN (SELECT intent FROM sales_intents))
                         OR (lower(ecr.callDetails_agentInfo_agentType) = 'service'
                             AND trimBoth(coalesce(JSONExtractString(ira.qualification_block,'primary_intent'),''))
                                 IN (SELECT intent FROM service_intents)) ) ) ),
           1, 0) AS intent_qualified_call
    FROM dealer_leads.endcallreports AS ecr FINAL
    JOIN lead_canonical lc ON lc.lead_id = ecr.leadId AND lc.team_id = ecr.teamId
    LEFT JOIN customer_opt_out co ON co.customer_id = lc.customer_id AND co.team_id = lc.team_id
    LEFT JOIN lead_high_intent_action hia ON hia.lead_id = lc.lead_id AND hia.team_id = lc.team_id
    LEFT JOIN dealer_leads.intentResolutionAnalysis AS ira FINAL
        ON ira.sourceId = ecr.callId AND ira.sourceType = 'call' AND ira.isActive = 1
    WHERE ecr.__deleted = 0 AND ecr.isTestCall = false
      AND JSONExtractString(ecr.report, 'spam') = 'No'
      AND lower(ecr.callDetails_agentInfo_agentType) IN ('sales', 'service')
      AND ecr.callDetails_callType IN ('webCall', 'inboundPhoneCall', 'outboundPhoneCall')
      AND toDate(ecr.createdAt) >= addDays(today(), -30)                                           /*W*/
      AND toDate(ecr.createdAt) <  today()                                                         /*W*/
),
ecr_by_call AS (
    SELECT callId, team_id,
           max(is_connected)           AS is_connected,
           max(report_qualified)       AS report_qualified,
           max(intent_qualified_call)  AS intent_qualified_call
    FROM ecr_events GROUP BY callId, team_id
),

-- ── SMS ──────────────────────────────────────────────────────────────────────────────────────────
sms_by_conv AS (
    SELECT
        c.conversationId AS conversationId,
        c.teamId         AS team_id,
        sum(if(lower(sm.authorType) = 'human' AND lower(sm.direction) = 'in', 1, 0)) AS n_human_inbound,
        -- A reply whose whole body is an opt-out keyword is the customer LEAVING, not replying. Used only
        -- by the Sales Outbound engagement gate; n_human_inbound above keeps its existing meaning.
        sum(if(lower(sm.authorType) = 'human' AND lower(sm.direction) = 'in'
               AND upper(trimBoth(ifNull(sm.body, ''))) NOT IN
                   ('STOP','STOPALL','STOP ALL','UNSUBSCRIBE','CANCEL','END','QUIT',
                    'OPTOUT','OPT OUT','REMOVE','NO'), 1, 0)) AS n_human_inbound_real,
        -- SERVICE rule: a human reply AND a concrete buying-intent action item on the lead, not opted out.
        -- A bare reply is "Engaged", NOT Qualified (any-reply=qualified inflated outbound 297 -> 32).
        max(if(lower(sm.authorType) = 'human' AND lower(sm.direction) = 'in'
               AND ifNull(co.opt_out_call, 0) = 0 AND ifNull(co.opt_out_sms, 0) = 0
               AND hia.lead_id IS NOT NULL, 1, 0)) AS intent_qualified_sms,
        -- ★ SALES INBOUND SMS gate — conversationAnalytics.outcome allowlist (the AI's per-thread verdict).
        -- Everything absent is a real outcome that is NOT qualification (Opt Out, Not Interested, Already
        -- Purchased, Reconnect Needed, Human Requested, Wrong Number, Language Barrier, Operating Hours,
        -- Decision Maker Unavailable...). 'Appointment' never occurs on SMS — dead entry, kept for fidelity.
        -- ⚠️ This field shares value NAMES with campaignLeadMappings.outcome but is a DIFFERENT vocabulary.
        max(has(['Purchase Intent','Pricing Inquiry','Appointment','Financing Inquiry','Trade Inquiry',
                 'Deposit Placed','Ancillary Inquiry','Purchase Closed','Vehicle Inquiry',
                 'General Engagement'],
                JSONExtractString(ifNull(c.conversationAnalytics, '{}'), 'outcome'))) AS sms_outcome_qualified
    FROM dealer_leads.smsMessages AS sm FINAL
    JOIN dealer_leads.conversations AS c FINAL
        ON sm.conversationId = c.conversationId
       AND c.__deleted = 0 AND ifNull(c.isTest, 0) = 0
       AND c.status != 'failed' AND lower(c.type) = 'sms'
    JOIN lead_canonical lc ON lc.lead_id = c.leadId AND lc.team_id = c.teamId
    LEFT JOIN customer_opt_out co ON co.customer_id = lc.customer_id AND co.team_id = lc.team_id
    LEFT JOIN lead_high_intent_action hia ON hia.lead_id = lc.lead_id AND hia.team_id = lc.team_id
    WHERE sm.__deleted = 0
      AND c.conversationId IN (SELECT conversationId FROM conversation_spine)
    GROUP BY c.conversationId, c.teamId
),

-- ── WEB CHAT ─────────────────────────────────────────────────────────────────────────────────────
chat_by_conv AS (
    SELECT
        c.conversationId AS conversationId,
        c.teamId         AS team_id,
        -- ENGAGED = the visitor actually exchanged messages and the AI's verdict has landed. Chat's
        -- equivalent of "not voicemail and the customer spoke". Spam excluded, as on calls.
        max(if(ifNull(c.isEmpty, 0) = 0
               AND lower(ifNull(c.status, '')) NOT IN ('not_started', 'failed')
               AND ifNull(c.summary, '') != ''
               AND lower(JSONExtractString(ifNull(c.summary, ''), 'spam')) != 'yes', 1, 0)) AS chat_engaged,
        max(if(JSONExtractString(ifNull(c.summary, ''), 'qualified') = 'Yes'
               AND lower(JSONExtractString(ifNull(c.summary, ''), 'spam')) != 'yes', 1, 0)) AS chat_qualified
    FROM dealer_leads.conversations AS c FINAL
    WHERE c.__deleted = 0 AND lower(c.type) = 'chat'
      AND toDate(c.createdAt) >= addDays(today(), -30)                                             /*W*/
      AND toDate(c.createdAt) <  today()                                                           /*W*/
      AND c.conversationId IN (SELECT conversationId FROM conversation_spine)
    GROUP BY c.conversationId, c.teamId
),

-- ── SALES OUTBOUND: the campaign-outcome rule ────────────────────────────────────────────────────
-- 20 qualifying dispositions = 6 hot + 3 warm buying signals, PLUS already-progressed dispositions
-- (booked / self-booked / deposit / walk-in committed) PLUS human hand-offs. Superset of the 9-value
-- hot/warm tiering below, which is the narrower "work these now" list.
-- ⚠️ No usable event date on this field (see the caveat in the file header).
ob_qualifying_outcomes AS (
    SELECT arrayJoin([
        'purchase intent','vehicle inquiry','pricing inquiry','financing inquiry',
        'trade inquiry','ancillary inquiry',
        'customer considering','customer open to return','reconnect needed',
        'appointment','service appointment booked','meeting already scheduled',
        'customer already self booked','walk in committed','appointment rescheduled',
        'deposit placed',
        'callback requested','human requested','human transferred','transferred to service team'
    ]) AS outcome
),
-- The 9-value hot/warm tiering. 'general engagement' is deliberately EXCLUDED — a generic "they replied"
-- signal that would otherwise dominate (Covina Kia: 382 of 420).
hot_tier_outcomes  AS (SELECT arrayJoin(['purchase intent','vehicle inquiry','pricing inquiry',
                                         'financing inquiry','trade inquiry','ancillary inquiry']) AS outcome),
warm_tier_outcomes AS (SELECT arrayJoin(['customer considering','customer open to return',
                                         'reconnect needed']) AS outcome),
ob_campaign_outcome AS (
    SELECT lead_id, outcome,
           if(outcome IN (SELECT outcome FROM ob_qualifying_outcomes), 1, 0) AS oc_q,
           multiIf(outcome IN (SELECT outcome FROM hot_tier_outcomes),  'hot',
                   outcome IN (SELECT outcome FROM warm_tier_outcomes), 'warm',
                   '') AS ob_tier
    FROM (
        SELECT clm.leadId AS lead_id,
               -- most recent outcome wins; one current value per lead, overwritten in place.
               argMax(lower(trimBoth(ifNull(clm.outcome, ''))), clm.updatedAt) AS outcome
        FROM dealer_leads.campaignLeadMappings AS clm FINAL
        WHERE clm.__deleted = 0
          -- COST GUARD: the outcome has no usable date, so this scan cannot be date-bounded. Bound it to
          -- the leads this run touches instead — without it a full run pays a whole FINAL scan per chunk.
          AND clm.leadId IN (SELECT lead_id FROM conversation_spine)
        GROUP BY clm.leadId
    )
),

-- ── Conversation grain, agent_type resolved, every rule applied ──────────────────────────────────
conv_fact AS (
    SELECT
        cs.team_id      AS team_id,
        cs.lead_id      AS lead_id,
        cs.conv_type    AS conv_type,
        cs.activity_day AS activity_day,
        -- Callback-from-outbound flips an inbound conversation to Outbound BEFORE the rules are applied,
        -- so a lead that called the outbound line back is judged by the OUTBOUND rule.
        concat(if(cs.service_type = 'sales', 'Sales ', 'Service '),
               if(ifNull(cbo.is_callback, 0) = 1, 'Outbound',
                  if(cs.raw_direction = 'inbound', 'Inbound', 'Outbound'))) AS agent_type,
        greatest(ifNull(ec.is_connected, 0), ifNull(cb.chat_engaged, 0)) AS connected,
        if(ifNull(sb.n_human_inbound, 0) > 0, 1, 0) AS sms_replied,
        greatest(ifNull(ec.is_connected, 0), ifNull(cb.chat_engaged, 0),
                 if(ifNull(sb.n_human_inbound, 0) > 0, 1, 0)) AS reached_person,
        ifNull(oco.ob_tier, '') AS ob_tier,
        ifNull(oco.outcome, '') AS campaign_outcome,

        -- ★ QUALIFIED — one branch per agent, per channel.
        multiIf(agent_type = 'Sales Outbound',
                  if(ifNull(oco.oc_q, 0) = 1 AND ifNull(ec.is_connected, 0) = 1, 1, 0),
                agent_type = 'Sales Inbound',
                  ifNull(ec.report_qualified, 0),
                ifNull(ec.intent_qualified_call, 0))  AS qualified_via_call,
        multiIf(agent_type = 'Sales Outbound',
                  if(ifNull(oco.oc_q, 0) = 1 AND ifNull(sb.n_human_inbound_real, 0) > 0, 1, 0),
                agent_type = 'Sales Inbound',
                  ifNull(sb.sms_outcome_qualified, 0),
                ifNull(sb.intent_qualified_sms, 0))   AS qualified_via_sms,
        multiIf(agent_type = 'Sales Outbound',
                  if(ifNull(oco.oc_q, 0) = 1 AND ifNull(cb.chat_engaged, 0) = 1, 1, 0),
                agent_type = 'Sales Inbound',
                  ifNull(cb.chat_qualified, 0),
                if(ifNull(cb.chat_engaged, 0) = 1 AND hia.lead_id IS NOT NULL, 1, 0)) AS qualified_via_chat,
        greatest(qualified_via_call, qualified_via_sms, qualified_via_chat) AS qualified
    FROM conversation_spine AS cs
    LEFT JOIN callback_from_outbound cbo ON cbo.callId = cs.callId AND cbo.team_id = cs.team_id
    LEFT JOIN ecr_by_call  ec  ON ec.callId  = cs.callId         AND ec.team_id  = cs.team_id
    LEFT JOIN sms_by_conv  sb  ON sb.conversationId = cs.conversationId AND sb.team_id = cs.team_id
    LEFT JOIN chat_by_conv cb  ON cb.conversationId = cs.conversationId AND cb.team_id = cs.team_id
    LEFT JOIN ob_campaign_outcome oco ON oco.lead_id = cs.lead_id
    LEFT JOIN lead_high_intent_action hia ON hia.lead_id = cs.lead_id AND hia.team_id = cs.team_id
    WHERE cs.service_type = 'sales'          -- Sales Inbound + Sales Outbound only; drop this line for all 4 agents
)
SELECT
    f.team_id                                    AS team_id,
    coalesce(nullIf(etd.dealer_name, ''), etd.team_name) AS rooftop,
    f.agent_type                                 AS agent_type,
    f.lead_id                                    AS lead_id,
    max(f.reached_person)                        AS reached_person,
    max(f.connected)                             AS connected,          -- real conversation (call/chat)
    max(f.sms_replied)                           AS sms_replied,        -- "Engaged" (bare reply)
    max(f.qualified)                             AS qualified,
    max(f.qualified_via_call)                    AS qualified_via_call,
    max(f.qualified_via_sms)                     AS qualified_via_sms,
    max(f.qualified_via_chat)                    AS qualified_via_chat,
    -- warm/hot tier: OB from the campaign outcome, IB from a concrete buying-intent action item.
    multiIf(any(f.ob_tier) != '', any(f.ob_tier),
            max(if(hia2.lead_id IS NOT NULL, 1, 0)) = 1, 'hot',
            '')                                  AS tier,
    any(f.campaign_outcome)                      AS campaign_outcome,
    min(f.activity_day)                          AS first_touch_day,
    max(f.activity_day)                          AS last_touch_day
FROM conv_fact AS f
LEFT JOIN eventila.enterprise_team_details etd FINAL ON etd.team_id = f.team_id
LEFT JOIN lead_high_intent_action hia2 ON hia2.lead_id = f.lead_id AND hia2.team_id = f.team_id
GROUP BY f.team_id, rooftop, f.agent_type, f.lead_id
ORDER BY team_id, agent_type, qualified DESC, last_touch_day DESC
SETTINGS join_use_nulls = 1;


-- =====================================================================================================
-- BLOCK B — rooftop x agent rollup of BLOCK A (the funnel numbers, canonical wordings)
-- Wrap BLOCK A (everything from `WITH` to the SETTINGS line, minus the ORDER BY) as `lead_fact` and:
-- =====================================================================================================
-- SELECT
--     team_id, rooftop, agent_type,
--     count()                                   AS leads_touched,      -- "Leads reached"/"Leads dialed"
--     countIf(reached_person = 1)               AS real_conversations,
--     countIf(qualified = 1)                    AS qualified_leads,
--     countIf(tier = 'hot')                     AS hot_leads,
--     countIf(tier = 'warm')                    AS warm_leads,
--     round(countIf(qualified = 1) / nullIf(countIf(reached_person = 1), 0), 3) AS turn_rate
-- FROM lead_fact
-- GROUP BY team_id, rooftop, agent_type
-- ORDER BY team_id, agent_type;
-- ⚠️ Do NOT build turn rate on Sales Inbound CALLS: report.qualified is a model verdict, not a transcript
--    test, so qualified is not nested inside connected (3.2% of qualified leads never engaged) and the
--    rate can exceed 100%. Report it for Sales Outbound; for Sales Inbound show the counts.


-- =====================================================================================================
-- BLOCK C — "Work these now": the named hot/warm lead list (detailQueries.ts warmLeadsSql)
-- Tier source: OB = campaignLeadMappings.outcome (hot 6 / warm 3); IB = a windowed concrete
-- buying-intent action item, always 'hot'. A lead with ANY real meeting in the window is excluded —
-- booked is not "work now". Every lead must ALSO have really engaged (voicemail-only / silent-chat
-- leads were showing as hot: RETCONVAI-4145/4146/4147).
-- =====================================================================================================
WITH
eligible_leads AS (
    SELECT DISTINCT l.lead_id AS lead_id, l.team_id AS team_id, l.customer_id AS customer_id,
                    l.service_type AS service_type
    FROM dealer_leads.leads AS l FINAL
    JOIN eventila.enterprise_details ed FINAL ON l.enterprise_id = ed.enterprise_id
    WHERE l.is_deleted = 0 AND l.__deleted = 0
      AND l.service_type = 'sales'                        -- sales only; use IN ('sales','service') for both
      AND ed.is_test_account = 0
      -- Reseller screen + allowlist. Hardcoded because this file must stay paste-runnable under
      -- `ch`/`ch-pack`; the source of truth is src/lib/reports/enterpriseScope.ts
      -- (RESELLER_ALLOWLIST) — keep the id list in step with it.
      AND (ed.reseller_id IS NULL OR ed.reseller_id = ''
           OR ed.enterprise_id IN ('62f962c8e'))  -- CallSource Auto
      AND lower(ifNull(ed.name, '')) NOT LIKE '%test%'
      AND lower(ifNull(ed.name, '')) NOT LIKE '%demo%'
      AND lower(ifNull(ed.name, '')) NOT LIKE '%sandbox%'
      -- AND l.team_id = '49a06313cf'                                                              /*T*/
),
booked_leads AS (
    SELECT DISTINCT m.lead_id AS lead_id
    FROM dealer_leads.meetings AS m FINAL
    WHERE m.__deleted = 0 AND m.is_active = 1
      -- meta.source='warm_transfer' rows are the customer's EXISTING/past appointments pulled in around a
      -- transfer — records we did not create. They must not count as a booking, here or anywhere.
      AND lower(JSONExtractString(ifNull(m.meta, ''), 'source')) != 'warm_transfer'
      AND toDate(m.created_at) >= addDays(today(), -45)                                            /*W*/
      -- AND m.team_id = '49a06313cf'                                                              /*T*/
),
engaged_leads AS (
    -- Canonical "real conversation": a non-voicemail/machine call the customer SPOKE on, or a human
    -- inbound SMS reply. report.connected is NOT used (the dialer sets it on voicemail-reached calls).
    SELECT DISTINCT lead_id FROM (
        SELECT ecr.leadId AS lead_id
        FROM dealer_leads.endcallreports AS ecr FINAL
        WHERE ecr.__deleted = 0 AND ecr.isActive = 1 AND ecr.isTestCall = 0
          AND lower(ifNull(ecr.callDetails_endedReason, '')) NOT LIKE '%voicemail%'
          AND lower(ifNull(ecr.callDetails_endedReason, '')) NOT LIKE '%machine%'
          AND arrayExists(x -> JSONExtractString(x, 'role') = 'user',
                          JSONExtractArrayRaw(ifNull(ecr.callDetails_messages, '[]')))
          AND toDate(ecr.createdAt) >= addDays(today(), -45)                                       /*W*/
        UNION ALL
        SELECT c.leadId AS lead_id
        FROM dealer_leads.smsMessages AS sm FINAL
        JOIN dealer_leads.conversations AS c FINAL
          ON c.conversationId = sm.conversationId
         AND c.__deleted = 0 AND ifNull(c.isTest, 0) = 0 AND c.status != 'failed' AND lower(c.type) = 'sms'
        WHERE sm.__deleted = 0
          AND lower(ifNull(sm.authorType, '')) = 'human' AND lower(ifNull(sm.direction, '')) = 'in'
          AND toDate(sm.createdAt) >= addDays(today(), -45)                                        /*W*/
    )
),
warm_lead_outcomes AS (
    SELECT arrayJoin(['purchase intent','vehicle inquiry','pricing inquiry','financing inquiry',
                      'trade inquiry','ancillary inquiry',                       -- hot tier
                      'customer considering','customer open to return','reconnect needed'  -- warm tier
    ]) AS outcome
),
warm_tier_outcomes AS (
    SELECT arrayJoin(['customer considering','customer open to return','reconnect needed']) AS outcome
),
buying_intent_actions AS (
    SELECT arrayJoin([
        'ScheduleAppointment','RescheduleAppointment','SALES_SCHEDULE_SHOWROOM_VISIT',
        'CheckVehicleAvailability','CheckVehiclePrice','InquireFinanceStatus',
        'SALES_CONNECT_TO_FINANCE','InquireTradeInValue','SALES_TRADE_IN_FOLLOW_UP',
        'ScheduleTestDrive','SALES_SCHEDULE_TEST_DRIVE','InquireLeaseOptions',
        'SALES_FOLLOW_UP_WITH_QUOTE','SERVICE_SCHEDULE_APPOINTMENT','SERVICE_SEND_ESTIMATE',
        'SALES_SCHEDULE_APPOINTMENT','SALES_SEND_VEHICLE_INFO','SALES_FOLLOW_UP_BE_BACK',
        'SEND_VEHICLE_PHOTO','SendVehicleImages','SendVehicleDetails','SendVehicleCatalog',
        'SendVehicleInformation','SendVehicleLink','CheckVehicleCondition'
    ]) AS intent
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
      AND lower(trimBoth(clm.outcome)) IN (SELECT outcome FROM warm_lead_outcomes)
      AND clm.leadId NOT IN (SELECT lead_id FROM booked_leads)
      AND clm.leadId IN (SELECT lead_id FROM engaged_leads)
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
      AND ifNull(ai.intent, '') IN (SELECT intent FROM buying_intent_actions)
      AND toDate(ai.createdAt) >= addDays(today(), -45)                                            /*W*/
      AND ai.lead_id NOT IN (SELECT lead_id FROM booked_leads)
      AND ai.lead_id NOT IN (SELECT lead_id FROM ob_warm)
      AND ai.lead_id IN (SELECT lead_id FROM engaged_leads)
    GROUP BY el.team_id, el.service_type, ai.lead_id
)
SELECT
    w.team_id AS team_id,
    w.source  AS source,                    -- 'ob' = campaign outcome, 'ib' = buying-intent action item
    w.lead_id AS lead_id,
    if(w.source = 'ob' AND w.outcome IN (SELECT outcome FROM warm_tier_outcomes), 'warm', 'hot') AS tier,
    any(cu.name)          AS customer_name,
    any(cu.mobile_number) AS phone,
    w.campaign            AS campaign,
    w.outcome             AS outcome,
    w.last_activity       AS last_activity
FROM (SELECT * FROM ob_warm UNION ALL SELECT * FROM ib_warm) AS w
JOIN eligible_leads el2 ON el2.lead_id = w.lead_id AND el2.team_id = w.team_id
LEFT JOIN dealer_leads.customer AS cu FINAL ON cu.customer_id = el2.customer_id AND cu.__deleted = 0
GROUP BY w.team_id, w.source, w.lead_id, w.campaign, w.outcome, w.last_activity, tier
ORDER BY team_id, tier ASC, last_activity DESC
LIMIT 50 BY team_id
SETTINGS join_use_nulls = 1;
