-- AGENT PERFORMANCE — CONVERSATION SPINE (canonical source of truth)
--
-- The single event-level query reporting-vini runs DIRECTLY against ClickHouse (dealer_leads),
-- replacing Metabase card 12227. One row per conversation; src/lib/reports/aggregate.ts reduces
-- these into agent_daily / agent_daily_breakdown / agent_lead_days.
--
--   • {START} / {END}  — date-window placeholders bounding toDate(createdAt) to [START, END),
--                substituted at load time. The ETL walks a long backfill in small [START,END) chunks so
--                no single scan nears the cluster memory ceiling. Appear in conversation_spine, ecr_events,
--                and the callback CTE injected by callbackAttribution.ts.
--   • cs."cs.team_id" / cs."cs.lead_id" are deliberately aliased WITH the "cs." prefix so the RawRow
--     contract (aggregate.ts, stl.ts, tzMap.ts) holds unchanged after the Metabase→ClickHouse cutover.
--   • The callback→outbound rule is injected at load time by callbackAttribution.ts (anchor-based) — do
--     NOT hand-edit the direction/agent_type block or the customer_opt_out / enterprise_details anchors
--     without updating that module's anchors (it asserts on drift).
--   • `transferred` (disposition: endedReason='transferred') is emitted for Calls-tab parity; aggregate.ts
--     prefers it over the IRA-derived had_transfer.
-- =============================================================================
-- AGENT PERFORMANCE — CONVERSATION SPINE (FINAL)
-- + speed-to-lead columns: is_speed_to_lead, speed_to_lead_response_time
-- =============================================================================
WITH

customer_opt_out AS (
    SELECT
        JSONExtractString(toString(doc), 'customer_id') AS customer_id,
        JSONExtractString(toString(doc), 'team_id') AS team_id,
        ifNull(JSONExtractBool(toString(doc), 'optOut', 'call'), 0) AS opt_out_call,
        ifNull(JSONExtractBool(toString(doc), 'optOut', 'sms'), 0) AS opt_out_sms
    FROM dealer_leads_raw.customer FINAL
    WHERE _peerdb_is_deleted = 0
),

lead_canonical AS (
    SELECT
        l.lead_id      AS lead_id,
        l.team_id      AS team_id,
        argMax(l.enterprise_id, l.created_at) AS enterprise_id,
        argMax(l.service_type, l.created_at) AS service_type,
        argMax(l.customer_id, l.created_at)  AS customer_id,
        argMax(coalesce(l.external_created_at, l.created_at), l.created_at) AS lead_created_at,
        -- ★ STL: raw external lead timestamp for response-time calc
        argMax(l.external_created_at, l.created_at) AS lead_external_created_at,
        argMax(l.source, l.created_at) AS lead_source
    FROM dealer_leads.leads AS l FINAL
    JOIN eventila.enterprise_details ed FINAL ON l.enterprise_id = ed.enterprise_id
    LEFT JOIN eventila.enterprise_team_details etd FINAL
        ON l.enterprise_id = etd.enterprise_id AND l.team_id = etd.team_id
    WHERE l.is_deleted = 0 AND l.__deleted = 0
      AND l.service_type IN ('sales', 'service')
      AND ed.is_test_account = 0
      AND (ed.reseller_id IS NULL OR ed.reseller_id = '')
      AND lower(ifNull(ed.name, '')) NOT LIKE '%pevej%'
      AND lower(ifNull(ed.name, '')) NOT LIKE '%testing%'
      AND lower(ifNull(ed.name, '')) NOT LIKE '%test %'
      AND lower(ifNull(ed.name, '')) NOT LIKE '% test%'
      AND lower(ifNull(ed.name, '')) NOT LIKE '%demo%'
      AND lower(ifNull(ed.name, '')) NOT LIKE '%sandbox%'
      AND lower(ifNull(ed.name, '')) NOT LIKE '%spyne motors%'
      AND lower(ifNull(ed.name, '')) NOT LIKE '%spyne flip%'
      AND lower(ifNull(ed.name, '')) NOT LIKE '%khandelwal%'
      AND lower(ifNull(ed.name, '')) NOT LIKE '%used inventory%'
      AND lower(ifNull(ed.name, '')) NOT LIKE '%team 1%'
      AND lower(ifNull(ed.name, '')) NOT LIKE '%team1%'
      AND lower(ifNull(etd.team_name, '')) NOT LIKE '%test %'
      AND lower(ifNull(etd.team_name, '')) NOT LIKE '% test%'
      AND lower(ifNull(etd.team_name, '')) NOT LIKE '%team 1%'
      AND lower(ifNull(etd.team_name, '')) NOT LIKE '%team1%'
      AND lower(ifNull(etd.team_name, '')) NOT LIKE '%demo%'
      AND lower(ifNull(etd.dealer_name, '')) NOT LIKE '%test %'
      AND lower(ifNull(etd.dealer_name, '')) NOT LIKE '% test%'
      AND lower(ifNull(etd.dealer_name, '')) NOT LIKE '%demo%'
    GROUP BY l.lead_id, l.team_id
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

sales_intents AS (
    SELECT arrayJoin([
        -- canonical: CONCRETE buying-intent intents, using the ACTUAL IRA vocabulary in prod
        -- (data uses 'Vehicle Availability Inquiry' / 'Vehicle Price Inquiry' / 'Trade in value inquiry'
        --  / 'Test drive Booking' / 'Finance Inquiry' — the old list used non-matching strings, so
        --  inbound buying-intent calls never matched → IB qualified undercounted to ~4). Routing intents
        -- ('Talk to sales department', 'Sales person/Manager Request', transfers) are NOT buying → excluded.
        'Vehicle Availability Inquiry','Vehicle Price Inquiry','Trade in value inquiry',
        'Test drive Booking','Appointment Booking/inquiry','Finance Inquiry','Lease Inquiry',
        'Vehicle condition or history inquiry','Vehicle Feature Request','Sales appointment re-scheduled',
        -- legacy / other-dealer variants (kept for safety; harmless if unused):
        'Test Drive Booking','Schedule Test Drive','Vehicle Inquiry','New Vehicle Inquiry',
        'Used Vehicle Inquiry','Pricing Inquiry','Inventory Availability Inquiry','Trade-in Inquiry','Financing Inquiry'
    ]) AS intent
),

appointment_intent_set AS (
    SELECT arrayJoin([
        'Appointment Booking/inquiry',
        'Schedule Service Appointment',
        'Reschedule Service Appointment',
        'Service appointment scheduling attempt failed',
        'Schedule Recall'
    ]) AS intent
),

-- canonical (LOCKED 2026-06-30): SMS "Qualified" requires CONCRETE BUYING INTENT, same bar as the call
-- side — NOT any reply. intentResolutionAnalysis only exists for sourceType='call' (no SMS IRA rows in
-- prod), and smsMessages carries no intent field, so the only buying-intent signal available at the SMS
-- grain is a high-intent action item logged on the lead (dealer_leads.actionItems.intent). A bare reply
-- with no such signal = "Engaged", not Qualified (this is what drives outbound 32 vs the inflated 297).
-- These are the concrete buying-intent action-item intents (vehicle / availability / price / financing /
-- trade-in / test-drive / booking). Callback/voicemail/manager-ask/etc. are deliberately excluded.
-- ⚠️ LOCKSTEP: this list is DUPLICATED in src/lib/reports/detailQueries.ts `BUYING_INTENT_ACTIONS`
-- (warm-leads / "work now"). This SQL copy is the source of truth — edit BOTH together, or the spine's
-- SMS-qualified and the detail queries silently diverge.
-- ★ VOCABULARY DRIFT (fixed 2026-08-18): the original 15 labels below silently decayed as the AI's
-- intent naming changed. Most glaring: SERVICE_SCHEDULE_APPOINTMENT was present but its SALES twin
-- SALES_SCHEDULE_APPOINTMENT was NOT — and that label only starts appearing 2026-07-02 (493 leads by
-- 2026-08-18). SEND_VEHICLE_PHOTO starts 2026-07-31 (75). Because an unrecognised label reads as "no
-- buying intent", qualified FELL over July while real qualification did not: fleet-wide the 10 added
-- labels lift the gate by 33-39 leads/wk in early June, rising to 163-299/wk from July.
-- VERIFIED against prod 2026-08-18: all 25 labels are real values of dealer_leads.actionItems.intent.
-- The SendVehicle* camelCase forms are legacy (1-15 leads each, June only) — kept so history reads
-- consistently. When the AI emits a new intent name, ADD IT HERE or the metric quietly sags again.
sms_buying_intent_actions AS (
    SELECT arrayJoin([
        -- the original 15
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

-- canonical: distinct leads that have logged a concrete buying-intent action item. Used as the SMS
-- qualification gate. NOTE(canonical): actionItems is lead-scoped (no conversationId / no channel),
-- so this credits buying intent at the LEAD level, not the individual SMS conversation — the closest
-- available proxy. A tighter SMS-conversation-level intent signal would need a new upstream field.
lead_high_intent_action AS (
    SELECT DISTINCT ai.lead_id AS lead_id, ai.team_id AS team_id
    FROM dealer_leads.actionItems AS ai FINAL
    WHERE ai.__deleted = 0
      AND ifNull(ai.intent, '') IN (SELECT intent FROM sms_buying_intent_actions)
      -- canonical: window the buying-intent gate to the reporting window. Without this it matched
      -- ALL-TIME action items, inflating outbound qualified (≈220 vs the real 32).
      AND ai.createdAt >= {START} AND ai.createdAt < {END}
),

agent_stage_override AS (
    SELECT team_id, service_type, direction, stage
    FROM (
        SELECT
            CAST(NULL AS Nullable(String)) AS team_id,
            CAST(NULL AS Nullable(String)) AS service_type,
            CAST(NULL AS Nullable(String)) AS direction,
            CAST(NULL AS Nullable(String)) AS stage
        WHERE 0
    )
),

-- ── WEB CHAT — the third AI channel ──────────────────────────────────────────────────────────────
-- Web chat lives in dealer_leads.conversations as type='chat' (22.8k rows / 296 teams all-time) with its
-- own IRA-style `summary` JSON — the same keys a call report carries (useCase, inOutType, qualified,
-- spam, queryResolved, overview.appointmentScheduled). It was excluded from the spine entirely, so chat
-- sessions, chat qualification and — most visibly — appointments the AI booked INSIDE a chat were absent
-- from every agent number. Two upstream gaps make chat harder to attach than call/SMS:
--   1. a chat-booked meeting row carries NEITHER conversation_id NOR call_id, so both of
--      appt_attribution's anchors miss it. Paragon Honda (team 5895de05b) 2026-08: 4 of its 7 AI-booked
--      sales appointments were dropped this way — the console read 3 while the Appointments calendar
--      (which lists meetings directly) correctly showed 7.
--   2. many teams' chat conversations carry a NULL leadId — Paragon's have since Jan-2026 (45/45
--      populated Aug-2025, 0/35 Aug-2026; an upstream regression worth its own fix) — so there is no
--      lead to join lead_canonical on and the row cannot enter a lead-grained funnel.
--
-- chat_booking_link repairs both from the one fact that IS reliable: the booking happens DURING the chat.
-- It matches an anchorless source='spyne' meeting to the same team's chat whose live span brackets the
-- booking timestamp and whose own summary says it scheduled an appointment; nearest chat wins. Verified
-- on prod 2026-08-21: all 16 anchorless spyne meetings in the trailing 60d matched exactly one such chat
-- (3 had several candidate chats — the appointmentScheduled='Yes' + nearest-start rule picked the right
-- one every time), and all 16 were sales.
chat_booking_link AS (
    SELECT
        meeting_id,
        team_id,
        argMin(conversationId, gap) AS conversationId,
        argMin(lead_id, gap)        AS lead_id
    FROM (
        SELECT
            m.meeting_id     AS meeting_id,
            m.team_id        AS team_id,
            m.lead_id        AS lead_id,
            c.conversationId AS conversationId,
            abs(dateDiff('second', c.createdAt, m.created_at)) AS gap
        FROM (
            -- anchorless AI-booked meetings: no conversation_id AND no call_id to attribute them by.
            -- One day of slack either side of the window so a chat straddling midnight still links; the
            -- chat (the attribution anchor) is what the window is actually pinned on, below.
            SELECT meeting_id, team_id, lead_id, created_at
            FROM dealer_leads.meetings FINAL
            WHERE is_active = 1 AND __deleted = 0 AND source = 'spyne'
              AND lower(JSONExtractString(ifNull(meta, ''), 'source')) != 'warm_transfer'
              AND (conversation_id IS NULL OR conversation_id = '')
              AND (call_id IS NULL OR call_id = '')
              AND lead_id IS NOT NULL AND lead_id != ''
              AND toDate(created_at) >= {START} - 1 AND toDate(created_at) < {END} + 1
        ) AS m
        JOIN (
            SELECT conversationId, teamId, createdAt, updatedAt
            FROM dealer_leads.conversations FINAL
            WHERE __deleted = 0 AND ifNull(isTest, 0) = 0 AND lower(type) = 'chat'
              AND JSONExtractString(ifNull(summary, ''), 'overview', 'appointmentScheduled') = 'Yes'
              AND toDate(createdAt) >= {START} AND toDate(createdAt) < {END}
        ) AS c
            ON c.teamId = m.team_id
        WHERE c.createdAt <= m.created_at
          AND m.created_at <= c.updatedAt + INTERVAL 5 MINUTE
    )
    GROUP BY meeting_id, team_id
),

-- conversationId → the lead a chat booked for. Recovers the lead of a NULL-leadId chat (gap 2 above) so
-- the chat can join lead_canonical like any other conversation. Only chats that produced a booking are
-- recoverable this way: a NULL-leadId chat that booked nothing still cannot enter a lead-grained funnel,
-- which is why the upstream leadId regression needs fixing rather than working around forever.
chat_conv_lead AS (
    SELECT conversationId, team_id, any(lead_id) AS lead_id
    FROM chat_booking_link
    GROUP BY conversationId, team_id
),

-- Conversation rows feeding the spine, with the chat lead-id recovery applied. Split out of
-- conversation_spine so the recovered lead can be used as a plain column in the lead_canonical join
-- (chaining an expression across two joins is fragile in ClickHouse).
conv_src AS (
    SELECT
        c.conversationId     AS conversationId,
        c.callId             AS callId,
        lower(c.type)        AS conv_type,
        coalesce(nullIf(c.leadId, ''), ccl.lead_id) AS lead_id,
        c.teamId             AS team_id,
        c.enterpriseId       AS enterprise_id,
        c.createdAt          AS createdAt,
        c.teamAgentMappingId AS teamAgentMappingId,
        c.metadata           AS metadata,
        c.outboundTaskId     AS outboundTaskId,
        c.followupId         AS followupId
    FROM dealer_leads.conversations AS c FINAL
    LEFT JOIN chat_conv_lead AS ccl
        ON ccl.conversationId = c.conversationId AND ccl.team_id = c.teamId
    WHERE ifNull(c.isTest, 0) = 0 AND c.__deleted = 0
      AND c.status != 'failed'
      -- 'chat' joins 'sms' and 'call' as a first-class channel (see chat_booking_link above)
      AND lower(c.type) IN ('sms', 'call', 'chat')
      -- keep the original leadId pruning for call/SMS (it keeps this scan small); only chat is allowed
      -- through without one, because chat is the channel whose leadId can be recovered below.
      AND (ifNull(c.leadId, '') != '' OR lower(c.type) = 'chat')
      AND toDate(c.createdAt) >= {START} AND toDate(c.createdAt) < {END}
),

conversation_spine AS (
    SELECT
        c.conversationId                  AS conversationId,
        c.callId                          AS callId,
        c.conv_type                       AS conv_type,
        c.lead_id                         AS lead_id,
        c.team_id                         AS team_id,
        c.enterprise_id                   AS enterprise_id,
        lc.service_type                   AS service_type,
        any(lower(at.agentCallType))      AS direction,
        toDate(c.createdAt)               AS activity_day,
        any(c.createdAt)                  AS activity_ts,
        any(lc.lead_created_at)           AS lead_created_at,
        any(lc.lead_external_created_at)  AS lead_external_created_at,
        any(lc.lead_source)               AS lead_source,
        -- ★ STL: fields needed to classify speed-to-lead SMS
        any(c.metadata)                   AS metadata,
        any(c.outboundTaskId)             AS outbound_task_id,
        any(c.followupId)                 AS followup_id
    FROM conv_src AS c
    JOIN lead_canonical lc
        ON lc.lead_id = c.lead_id AND lc.team_id = c.team_id
    LEFT JOIN dealer_leads.teamAgentMappings AS tam FINAL
        ON c.teamAgentMappingId = tam.teamAgentMappingId AND tam.__deleted = 0
    LEFT JOIN dealer_leads.agentTypes AS at FINAL
        ON tam.agentTypeId = at.agentTypeId AND at.__deleted = 0
    WHERE c.lead_id IS NOT NULL AND c.lead_id != ''
      -- chat maps to an agentType exactly like a call does (prod 90d: agentCallType='inbound' on 836 of
      -- 947 chats, agentType 'Sales'), so the existing direction gate carries it unchanged.
      AND lower(at.agentCallType) IN ('inbound', 'outbound')
    GROUP BY
        c.conversationId, c.callId, c.conv_type,
        c.lead_id, c.team_id, c.enterprise_id, lc.service_type, toDate(c.createdAt)
),

ecr_events AS (
    SELECT
        ecr.callId AS callId,
        ecr.teamId AS team_id,
        -- canonical (LOCKED 2026-06-30): call-qualified uses the SAME buying-intent bar as SMS —
        -- ENGAGED (non-voicemail live call where the customer spoke) AND the lead has a windowed
        -- concrete buying-intent action item (lead_high_intent_action, hia.lead_id IS NOT NULL).
        -- Dropped the old IRA-intent-match OR loose "any user message" fallback (a different, looser
        -- rule than SMS — it under-counted inbound to 2 and could over-count elsewhere). Opt-out and
        -- spam exclusions retained (spam is filtered in the WHERE clause; opt-outs gated here).
        if(
            ifNull(co.opt_out_call, 0) = 0
            AND ifNull(co.opt_out_sms, 0) = 0
            AND lower(ifNull(ecr.callDetails_endedReason, '')) NOT LIKE '%voicemail%'
            AND lower(ifNull(ecr.callDetails_endedReason, '')) NOT LIKE '%machine%'
            -- ENGAGED: customer actually spoke on the call
            AND arrayExists(
                x -> JSONExtractString(x, 'role') = 'user',
                JSONExtractArrayRaw(ifNull(ecr.callDetails_messages, '[]'))
            )
            -- canonical buying-intent signal = a windowed action item OR an IRA buying-intent match
            -- (calls often show intent via IRA without a logged action item — required for inbound).
            AND (
                hia.lead_id IS NOT NULL
                OR (
                    ira.sourceId IS NOT NULL
                    AND (
                        (lower(ecr.callDetails_agentInfo_agentType) = 'sales'
                         AND trimBoth(coalesce(JSONExtractString(ira.qualification_block, 'primary_intent'), ''))
                             IN (SELECT intent FROM sales_intents))
                        OR (lower(ecr.callDetails_agentInfo_agentType) = 'service'
                         AND trimBoth(coalesce(JSONExtractString(ira.qualification_block, 'primary_intent'), ''))
                             IN (SELECT intent FROM service_intents))
                    )
                )
            ),
            1, 0
        ) AS is_qualifying_call,
        -- ★ SALES INBOUND qualified signal (locked 2026-08-18, source: Product14/vini-success
        -- products/sales-inbound/queries/features.sql). The AI's OWN verdict on the call, rather than an
        -- IRA primary_intent match. Used only for Sales Inbound in the final SELECT.
        -- NOTE: report.connected is deliberately not read — vini-success measured the key present on 0 of
        -- 451,526 rows. Prod 30d (sales): 'Yes' on 22,474 calls / 10,371 leads, 'No' on 65,145, '' on 245.
        if(JSONExtractString(ifNull(ecr.report, '{}'), 'qualified') = 'Yes', 1, 0) AS is_report_qualified,
        if(
            ira.sourceId IS NOT NULL
            AND trimBoth(coalesce(JSONExtractString(ira.qualification_block, 'primary_intent'), ''))
                IN (SELECT intent FROM appointment_intent_set),
            1, 0
        ) AS has_appt_intent,
        if(
            ira.sourceId IS NOT NULL
            AND positionCaseInsensitive(ifNull(ira.resolution_block, ''), 'transfer completed') > 0,
            1, 0
        ) AS has_transfer,
        if(
            ira.sourceId IS NOT NULL
            AND (
                positionCaseInsensitive(ifNull(ira.resolution_block, ''), 'callback scheduled') > 0
                OR positionCaseInsensitive(ifNull(ira.resolution_block, ''), 'callback arranged') > 0
            ),
            1, 0
        ) AS has_callback,
        if(
            ira.sourceId IS NOT NULL
            AND arrayExists(
                x -> trimBoth(JSONExtractString(x, 'intent_label'))
                       = trimBoth(coalesce(JSONExtractString(ira.qualification_block, 'primary_intent'), ''))
                     AND JSONExtractBool(x, 'resolved'),
                JSONExtractArrayRaw(ifNull(ira.resolution_block, ''), 'intents')
            ),
            1, 0
        ) AS is_query_resolved,
        if(
            -- canonical: a real conversation is NEVER a voicemail/IVR — require non-voicemail FIRST,
            -- even when report.connected='Yes' (the outbound dialer sets that flag on voicemail-reached
            -- calls too, which was inflating outbound "connected" ~2x).
            lower(ifNull(ecr.callDetails_endedReason, '')) NOT LIKE '%voicemail%'
            AND lower(ifNull(ecr.callDetails_endedReason, '')) NOT LIKE '%machine%'
            -- canonical: a REAL conversation means the customer actually spoke — require a user message.
            -- report.connected='Yes' alone is the dialer's line-reached flag (set on voicemail/no-answer),
            -- so it is NOT sufficient on its own.
            AND arrayExists(
                x -> JSONExtractString(x, 'role') = 'user',
                JSONExtractArrayRaw(ifNull(ecr.callDetails_messages, '[]'))
            ),
            1, 0
        ) AS is_connected,
        trimBoth(coalesce(JSONExtractString(ira.qualification_block, 'primary_intent'), '')) AS primary_intent,
        -- canonical: talk_seconds is CONNECTED-only — voicemails AND answering-machine calls have a
        -- positive duration but are not a real conversation, so gate on BOTH (matching is_connected's
        -- voicemail+machine exclusion above). Prevents that duration leaking into talk time / AHT
        -- (and, historically, into any talk_seconds>0 connected proxy).
        if(
            lower(ifNull(ecr.callDetails_endedReason, '')) NOT LIKE '%voicemail%'
            AND lower(ifNull(ecr.callDetails_endedReason, '')) NOT LIKE '%machine%',
            greatest(0, dateDiff('second',
                parseDateTimeBestEffortOrNull(ecr.callDetails_startedAt),
                parseDateTimeBestEffortOrNull(ecr.callDetails_endedAt))),
            0
        ) AS talk_seconds,
        -- ★ CANONICAL transfer (locked 2026-07-01): completed disposition hand-off to a human =
        --   endedReason ∈ {'transferred','assistant-forwarded-call'}. Matches the Calls tab AND counts
        --   AI→human forwards (previously excluded). aggregate.ts uses this, NOT the IRA has_transfer
        --   flag ('transfer completed'), which undercounts ~⅓.
        if(lower(ifNull(ecr.callDetails_endedReason, '')) IN ('transferred','assistant-forwarded-call'), 1, 0) AS is_transferred,
        -- ★ failed transfer — reported SEPARATELY, never folded into is_transferred.
        if(lower(ifNull(ecr.callDetails_endedReason, '')) = 'transfer_failed', 1, 0) AS is_transfer_failed
    FROM dealer_leads.endcallreports AS ecr FINAL
    JOIN lead_canonical lc ON lc.lead_id = ecr.leadId AND lc.team_id = ecr.teamId
    LEFT JOIN customer_opt_out co ON co.customer_id = lc.customer_id AND co.team_id = lc.team_id
    -- canonical: windowed buying-intent gate for call qualification (SAME as SMS side, see
    -- lead_high_intent_action). hia.lead_id IS NOT NULL ⇒ lead logged a concrete buying-intent action.
    LEFT JOIN lead_high_intent_action hia ON hia.lead_id = lc.lead_id AND hia.team_id = lc.team_id
    LEFT JOIN dealer_leads.intentResolutionAnalysis AS ira FINAL
        ON ira.sourceId = ecr.callId AND ira.sourceType = 'call' AND ira.isActive = 1
    WHERE ecr.__deleted = 0 AND ecr.isTestCall = false
      AND JSONExtractString(ecr.report, 'spam') = 'No'
      AND lower(ecr.callDetails_agentInfo_agentType) IN ('sales', 'service')
      AND ecr.callDetails_callType IN ('webCall', 'inboundPhoneCall', 'outboundPhoneCall')
      AND toDate(ecr.createdAt) >= {START} AND toDate(ecr.createdAt) < {END}
),

ecr_by_call AS (
    SELECT
        callId,
        team_id,
        max(is_qualifying_call) AS qualified_via_call,
        max(is_report_qualified) AS report_qualified,   -- Sales Inbound gate (see ecr_events)
        max(has_appt_intent)    AS had_appt_intent,
        max(has_transfer)       AS had_transfer,
        max(has_callback)       AS had_callback,
        max(is_query_resolved)  AS is_query_resolved,
        max(is_connected)       AS is_connected,
        any(primary_intent)     AS primary_intent,
        max(talk_seconds)       AS talk_seconds,
        max(is_transferred)     AS transferred,
        max(is_transfer_failed) AS transfer_failed
    FROM ecr_events
    GROUP BY callId, team_id
),

sms_by_conv AS (
    SELECT
        c.conversationId AS conversationId,
        c.teamId         AS team_id,
        count()          AS n_sms_messages,
        sum(if(lower(sm.authorType) = 'human' AND lower(sm.direction) = 'in', 1, 0)) AS n_human_inbound,
        -- A human inbound reply whose whole body is an opt-out keyword is NOT engagement — "STOP" is the
        -- customer leaving, not replying. Used ONLY by the Sales-Outbound campaign-outcome qualified gate
        -- (see ob_campaign_outcome) so it can match the funnel query's `reply_real`. n_human_inbound above
        -- deliberately still counts them, so reached_person / sms_replied keep their existing meaning.
        sum(if(lower(sm.authorType) = 'human' AND lower(sm.direction) = 'in'
               AND upper(trimBoth(ifNull(sm.body, ''))) NOT IN
                   ('STOP','STOPALL','STOP ALL','UNSUBSCRIBE','CANCEL','END','QUIT',
                    'OPTOUT','OPT OUT','REMOVE','NO'), 1, 0)) AS n_human_inbound_real,
        sum(if(lower(sm.direction) = 'out', 1, 0)) AS n_sms_outbound,
        -- canonical (LOCKED): SMS qualified = human inbound reply AND a concrete buying-intent signal
        -- on the lead (NOT opted-out). A bare reply with no buying intent is "Engaged", not Qualified —
        -- this replaces the old "any human reply = qualified" rule that inflated outbound (≈297 → 32).
        -- hia.lead_id IS NOT NULL is the buying-intent gate (lead has a high-intent action item).
        max(if(lower(sm.authorType) = 'human' AND lower(sm.direction) = 'in'
               AND ifNull(co.opt_out_call, 0) = 0
               AND ifNull(co.opt_out_sms, 0) = 0
               AND hia.lead_id IS NOT NULL, 1, 0)) AS qualified_via_sms,
        -- ★ SALES INBOUND SMS qualified signal (locked 2026-08-18, source: Product14/vini-success
        -- products/sales-inbound/queries/features.sql). conversationAnalytics.outcome is a per-conversation
        -- AI verdict on the SMS thread; this allowlist is the intent-bearing subset. Everything absent is a
        -- real outcome that is NOT qualification (Opt Out, Not Interested, Already Purchased, Reconnect
        -- Needed, Human Requested, Wrong Number, Language Barrier, Operating Hours, Decision Maker
        -- Unavailable, and others). vini-success measured it over 2026-07-15..08-13: the outcome exists on
        -- EXACTLY the engaged conversations (13,345 empty-outcome conversations had 0 engaged) and is
        -- perfectly nested inside engaged (0 violations in 14,980 SMS conversations).
        -- Prod 60d check: 9 of these 10 values occur ('Appointment' never appears on SMS — dead entry,
        -- kept for fidelity with the source). Used only for Sales Inbound in the final SELECT.
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
    -- canonical: buying-intent gate for SMS qualification (see lead_high_intent_action CTE above).
    LEFT JOIN lead_high_intent_action hia ON hia.lead_id = lc.lead_id AND hia.team_id = lc.team_id
    WHERE sm.__deleted = 0
      AND c.conversationId IN (SELECT conversationId FROM conversation_spine)
    GROUP BY c.conversationId, c.teamId
),

-- ★ WEB CHAT verdicts, one row per chat conversation (the chat analogue of ecr_by_call / sms_by_conv).
-- Every signal here is the AI's own read of the chat, taken from the same `summary` JSON a call report
-- uses — there is no IRA row and no transcript-side signal for chat.
chat_by_conv AS (
    SELECT
        c.conversationId AS conversationId,
        c.teamId         AS team_id,
        -- ENGAGED: the visitor actually exchanged messages. The chat lifecycle has exactly three states
        -- in prod (90d) and they are perfectly correlated with content:
        --   not_started (64)  isEmpty=1, no summary  — widget opened, nobody typed  → NOT engaged
        --   in_progress (350) isEmpty=0, no summary  — live exchange (2-12 messages) → engaged
        --   completed   (534) isEmpty=0, summary set — finished, AI verdict available → engaged
        -- so this is chat's equivalent of "not voicemail and the customer spoke". Spam chats are excluded
        -- here, exactly as spam calls are dropped in ecr_events.
        -- A summary is REQUIRED, which follows the rule calls already use: is_connected comes from the
        -- call's endcallreports row, so a call whose report has not landed is a touch but not yet a real
        -- conversation. Chat's summary is written at completion, so an in_progress chat is likewise a
        -- touch (it counts in Leads reached) and becomes a real conversation when its verdict lands.
        -- This also keeps the channel internally consistent — every chat counted in the turn-rate
        -- denominator is one that CAN qualify. It matters: fleet-wide over 30d, all 262 chats that carry
        -- a leadId sit in_progress with no summary (18 teams), so counting them as conversations would
        -- have added ~254 conversation-leads with ZERO possible qualifications and quietly dented turn
        -- rate everywhere. Both halves of that are upstream bugs (chats stuck in_progress — 3d3deabc98 is
        -- 44/44 over 30d; and the NULL leadId on the teams whose chats DO complete) and fixing either one
        -- makes this channel count more, with no change needed here.
        max(if(ifNull(c.isEmpty, 0) = 0
               AND lower(ifNull(c.status, '')) NOT IN ('not_started', 'failed')
               AND ifNull(c.summary, '') != ''
               AND lower(JSONExtractString(ifNull(c.summary, ''), 'spam')) != 'yes', 1, 0)) AS chat_engaged,
        -- ★ The AI's OWN qualification verdict on the chat. This is the same signal the locked Sales
        -- Inbound rule reads off a call (report.qualified): the chat summary carries an identical
        -- `qualified` key. Used for Sales Inbound in the final SELECT; the other agents apply their own
        -- rule to it there, exactly as they do for calls and SMS.
        max(if(JSONExtractString(ifNull(c.summary, ''), 'qualified') = 'Yes'
               AND lower(JSONExtractString(ifNull(c.summary, ''), 'spam')) != 'yes', 1, 0)) AS chat_qualified,
        max(if(JSONExtractString(ifNull(c.summary, ''), 'queryResolved') = 'Yes', 1, 0)) AS chat_query_resolved
    FROM dealer_leads.conversations AS c FINAL
    WHERE c.__deleted = 0 AND lower(c.type) = 'chat'
      AND toDate(c.createdAt) >= {START} AND toDate(c.createdAt) < {END}
      AND c.conversationId IN (SELECT conversationId FROM conversation_spine)
    GROUP BY c.conversationId, c.teamId
),

lead_optout AS (
    SELECT
        lc.lead_id AS lead_id,
        lc.team_id AS team_id,
        max(ifNull(co.opt_out_sms, 0))  AS opt_out_sms,
        max(ifNull(co.opt_out_call, 0)) AS opt_out_call
    FROM lead_canonical lc
    LEFT JOIN customer_opt_out co
        ON co.customer_id = lc.customer_id AND co.team_id = lc.team_id
    GROUP BY lc.lead_id, lc.team_id
),

quality_by_call AS (
    SELECT
        cq.sourceId AS callId,
        any(cq.scorePercentage) AS score_percentage
    FROM dealer_leads.conversationQualities AS cq
    WHERE cq.scorePercentage IS NOT NULL
    GROUP BY cq.sourceId
),

conv_hours AS (
    SELECT
        conversationId,
        team_id,
        after_hours
    FROM (
        SELECT
            cs.conversationId AS conversationId,
            cs.team_id        AS team_id,
            ifNull(etd.working_days, '') AS wd,
            parseDateTimeBestEffortOrNull(toString(cs.activity_ts)) AS ts,
            multiIf(
                etd.timezone = 'America/New_York',              toTimeZone(ts, 'America/New_York'),
                etd.timezone = 'Europe/London',                 toTimeZone(ts, 'Europe/London'),
                etd.timezone = 'America/Chicago',               toTimeZone(ts, 'America/Chicago'),
                etd.timezone = 'Europe/Berlin',                 toTimeZone(ts, 'Europe/Berlin'),
                etd.timezone = 'Europe/Rome',                   toTimeZone(ts, 'Europe/Rome'),
                etd.timezone = 'America/Los_Angeles',           toTimeZone(ts, 'America/Los_Angeles'),
                etd.timezone = 'America/Winnipeg',              toTimeZone(ts, 'America/Winnipeg'),
                etd.timezone = 'Australia/Sydney',              toTimeZone(ts, 'Australia/Sydney'),
                etd.timezone = 'Europe/Lisbon',                 toTimeZone(ts, 'Europe/Lisbon'),
                etd.timezone = 'Asia/Dubai',                    toTimeZone(ts, 'Asia/Dubai'),
                etd.timezone = 'America/Toronto',               toTimeZone(ts, 'America/Toronto'),
                etd.timezone = 'Asia/Calcutta',                 toTimeZone(ts, 'Asia/Calcutta'),
                etd.timezone = 'America/Phoenix',               toTimeZone(ts, 'America/Phoenix'),
                etd.timezone = 'Asia/Kolkata',                  toTimeZone(ts, 'Asia/Kolkata'),
                etd.timezone = 'Europe/Paris',                  toTimeZone(ts, 'Europe/Paris'),
                etd.timezone = 'America/Cancun',                toTimeZone(ts, 'America/Cancun'),
                etd.timezone = 'America/Edmonton',              toTimeZone(ts, 'America/Edmonton'),
                etd.timezone = 'America/Detroit',               toTimeZone(ts, 'America/Detroit'),
                etd.timezone = 'America/Kentucky/Monticello',   toTimeZone(ts, 'America/Kentucky/Monticello'),
                etd.timezone = 'Africa/Abidjan',                toTimeZone(ts, 'Africa/Abidjan'),
                etd.timezone = 'Africa/Algiers',                toTimeZone(ts, 'Africa/Algiers'),
                etd.timezone = 'Pacific/Honolulu',              toTimeZone(ts, 'Pacific/Honolulu'),
                etd.timezone = 'America/North_Dakota/Center',   toTimeZone(ts, 'America/North_Dakota/Center'),
                etd.timezone = 'America/Denver',                toTimeZone(ts, 'America/Denver'),
                etd.timezone = 'Atlantic/South_Georgia',        toTimeZone(ts, 'Atlantic/South_Georgia'),
                etd.timezone = 'Pacific/Apia',                  toTimeZone(ts, 'Pacific/Apia'),
                etd.timezone = 'America/Bahia_Banderas',        toTimeZone(ts, 'America/Bahia_Banderas'),
                etd.timezone = 'America/Cayman',                toTimeZone(ts, 'America/Cayman'),
                etd.timezone = 'Asia/Singapore',                toTimeZone(ts, 'Asia/Singapore'),
                etd.timezone = 'Asia/Seoul',                    toTimeZone(ts, 'Asia/Seoul'),
                etd.timezone = 'Pacific/Guam',                  toTimeZone(ts, 'Pacific/Guam'),
                etd.timezone = 'Europe/Helsinki',               toTimeZone(ts, 'Europe/Helsinki'),
                etd.timezone = 'America/Mexico_City',           toTimeZone(ts, 'America/Mexico_City'),
                etd.timezone = 'Europe/Copenhagen',             toTimeZone(ts, 'Europe/Copenhagen'),
                etd.timezone = 'Europe/Sofia',                  toTimeZone(ts, 'Europe/Sofia'),
                etd.timezone = 'Europe/Zagreb',                 toTimeZone(ts, 'Europe/Zagreb'),
                etd.timezone = 'America/Indiana/Vincennes',     toTimeZone(ts, 'America/Indiana/Vincennes'),
                etd.timezone = 'Europe/Prague',                 toTimeZone(ts, 'Europe/Prague'),
                etd.timezone = 'America/Indiana/Tell_City',     toTimeZone(ts, 'America/Indiana/Tell_City'),
                etd.timezone = 'America/Costa_Rica',            toTimeZone(ts, 'America/Costa_Rica'),
                etd.timezone = 'America/Vancouver',             toTimeZone(ts, 'America/Vancouver'),
                etd.timezone = 'Europe/Dublin',                 toTimeZone(ts, 'Europe/Dublin'),
                etd.timezone = 'America/Sao_Paulo',             toTimeZone(ts, 'America/Sao_Paulo'),
                etd.timezone = 'Asia/Qatar',                    toTimeZone(ts, 'Asia/Qatar'),
                etd.timezone = 'Africa/Maseru',                 toTimeZone(ts, 'Africa/Maseru'),
                etd.timezone = 'America/Indiana/Winamac',       toTimeZone(ts, 'America/Indiana/Winamac'),
                etd.timezone = 'America/Kentucky/Louisville',   toTimeZone(ts, 'America/Kentucky/Louisville'),
                etd.timezone = 'Pacific/Auckland',              toTimeZone(ts, 'Pacific/Auckland'),
                toTimeZone(ts, 'UTC')
            ) AS local_dt,
            lower(dateName('weekday', local_dt)) AS dn,
            toHour(local_dt) * 60 + toMinute(local_dt) AS cur_min,
            multiIf(
                dn = 'monday',    JSONExtractRaw(wd, 'monday'),
                dn = 'tuesday',   JSONExtractRaw(wd, 'tuesday'),
                dn = 'wednesday', JSONExtractRaw(wd, 'wednesday'),
                dn = 'thursday',  JSONExtractRaw(wd, 'thursday'),
                dn = 'friday',    JSONExtractRaw(wd, 'friday'),
                dn = 'saturday',  JSONExtractRaw(wd, 'saturday'),
                dn = 'sunday',    JSONExtractRaw(wd, 'sunday'),
                ''
            ) AS day_cfg,
            JSONExtractBool(day_cfg, 'is_working') AS is_working,
            toInt32OrZero(splitByChar(':', JSONExtractString(day_cfg, 'start_time'))[1]) * 60
              + toInt32OrZero(splitByChar(':', JSONExtractString(day_cfg, 'start_time'))[2]) AS start_min,
            toInt32OrZero(splitByChar(':', JSONExtractString(day_cfg, 'end_time'))[1]) * 60
              + toInt32OrZero(splitByChar(':', JSONExtractString(day_cfg, 'end_time'))[2]) AS end_min,
            if(wd = '', NULL,
               if(is_working AND cur_min >= start_min AND cur_min < end_min, 0, 1)) AS after_hours
        FROM conversation_spine cs
        LEFT JOIN eventila.enterprise_team_details etd FINAL
            ON cs.enterprise_id = etd.enterprise_id AND cs.team_id = etd.team_id
    )
),

-- canonical: outbound-campaign-enrolled leads (campaignLeadMappings membership). Used to scope the
-- AI-assisted (CRM) secondary to genuine outbound-worked leads, matching the spec's "outbound-campaign
-- lead" wording, so a stray CRM/walk-in booking on a never-worked lead is never credited as AI-assisted.
outbound_campaign_leads AS (
    SELECT DISTINCT clm.leadId AS lead_id
    FROM dealer_leads.campaignLeadMappings AS clm FINAL
    WHERE clm.__deleted = 0
),

-- ★ SALES OUTBOUND QUALIFIED — CAMPAIGN-OUTCOME RULE (locked 2026-08-18) ★
-- For SALES OUTBOUND ONLY, qualified is the campaign DISPOSITION the agent recorded on the lead, gated on
-- the customer actually having engaged that period. Sales Inbound and both Service agents keep the
-- intent-based rule (IRA primary_intent on calls / buying-intent action item on SMS) — the "same rule both
-- channels" invariant is DELIBERATELY broken here, for outbound only.
--
-- WHY: the intent-based rule decayed badly on outbound. Fleet-wide weekly Sales Outbound qualified under
-- the old rule vs this one: they agree through mid-June (136/128, 254/237, 312/310) then diverge hard as
-- the AI's intent naming drifted — 205/387 (w/c 07-06), 165/385 (w/c 08-03), i.e. the console was
-- reporting roughly HALF the real qualified pool from July onward. The outcome field kept working because
-- it is written by the dialer, not inferred from an intent label.
--
-- ⚠️ CAVEAT (state it with the number): campaignLeadMappings holds ONE CURRENT outcome per lead,
-- overwritten in place, and updatedAt churns under CDC — so there is NO usable event date. Each lead's
-- current outcome therefore applies to every period it engaged in, and can leak BACKWARDS into periods
-- before the intent was actually expressed. The engagement gate stops idle periods counting, which bounds
-- but does not eliminate this. It also means the number is not perfectly reproducible over time: a
-- re-run months later sees whatever the outcome has since become. Fixing it properly needs event history
-- (outboundTaskAuditLogs, 14.7M rows). Source: vini-daily-calls/src/abr-trends/
-- vini_sales_outbound_funnel_weekly.sql caveat B.
-- The 20 dispositions that count as qualified. Superset of WARM_LEAD_OUTCOMES in detailQueries.ts (which
-- is the narrower hot/warm "work these now" tiering, 9 values) — this list additionally counts dispositions
-- where the lead has already progressed PAST discussion (booked, self-booked, deposit, walk-in committed)
-- or been handed to a human, all of which are qualified by any reading.
-- NOTE: declared BEFORE ob_campaign_outcome because a WITH clause may only reference earlier CTEs.
ob_qualifying_outcomes AS (
    SELECT arrayJoin([
        -- buying-signal tier (== HOT_TIER_OUTCOMES)
        'purchase intent','vehicle inquiry','pricing inquiry','financing inquiry',
        'trade inquiry','ancillary inquiry',
        -- engaged/nurture tier (== WARM_TIER_OUTCOMES)
        'customer considering','customer open to return','reconnect needed',
        -- already progressed past discussion
        'appointment','service appointment booked','meeting already scheduled',
        'customer already self booked','walk in committed','appointment rescheduled',
        'deposit placed',
        -- handed to a human
        'callback requested','human requested','human transferred','transferred to service team'
    ]) AS outcome
),
ob_campaign_outcome AS (
    SELECT lead_id, outcome,
           if(outcome IN (SELECT outcome FROM ob_qualifying_outcomes), 1, 0) AS oc_q
    FROM (
        SELECT
            clm.leadId AS lead_id,
            -- most recent outcome wins; see the caveat above about updatedAt under CDC.
            argMax(lower(trimBoth(ifNull(clm.outcome, ''))), clm.updatedAt) AS outcome
        FROM dealer_leads.campaignLeadMappings AS clm FINAL
        WHERE clm.__deleted = 0
          -- COST: the outcome has no usable date (see caveat above), so this scan CANNOT be
          -- date-bounded. Instead bound it to the leads this run actually touches — the only rows the
          -- join below can ever use. Without this, the ETL (which walks its range in 3-day chunks) pays
          -- a full campaignLeadMappings FINAL scan ~40x per reconcile: the 120d full run went from
          -- 28min to 42min when this CTE was added, and the daily 04:17 full reconcile has only ~1min
          -- of margin before the 05:00 hourly cancels it (concurrency: cancel-in-progress). Results are
          -- identical — verified per-team against the un-bounded version.
          AND clm.leadId IN (SELECT lead_id FROM conversation_spine)
        GROUP BY clm.leadId
    )
),

-- canonical: agent-worked = call, SMS or web chat. Per lead, the representative spine conversation a lead-level
-- AI-assisted (CRM) meeting attaches to. We prefer an OUTBOUND conversation (outbound-campaign assist =
-- outbound, mirroring the call-back→OB rule), else the latest spine conversation — so the assist lands on
-- the right agent row even when the booking was worked over SMS with no AI call on the meeting record.
lead_assist_conv AS (
    SELECT
        lead_id,
        team_id,
        -- pri: outbound (2) beats inbound (1); within that, the latest conversation wins.
        argMax(conversationId, (if(direction = 'outbound', 2, 1), activity_ts)) AS conv_id
    FROM conversation_spine
    GROUP BY lead_id, team_id
),

-- canonical (LOCKED 2026-06-30): Appointments are TWO distinct metrics, never folded together.
--   • AI-booked (PRIMARY / headline) = the AI created the meeting record (meetings.source='spyne').
--   • AI-assisted (CRM, SECONDARY)   = meeting booked in the CRM (source!='spyne') on a lead the agent
--                                      WORKED. canonical: agent-worked = call, SMS or web chat — ANY
--                                      AI sales touch in-window (present in the conversation spine) AND is
--                                      outbound-campaign enrolled. NOT call-only. Shown smaller; never
--                                      added into the headline.
-- Each meeting is classified once: source='spyne' → booked; else (CRM) → assisted, attached to the lead's
-- representative spine conversation. is_assisted carries the split downstream (two separate counters).
--
-- canonical (2026-08-18): EXCLUDE meta.source='warm_transfer' from BOTH halves. `meetings.source` says who
-- OWNS a booking; `meta.source` says HOW the row came to exist — 'warm_transfer' rows are the customer's
-- EXISTING appointments pulled in around a transfer, records nobody just booked (their start times are
-- often the customer's own PAST visits). source='spyne' alone is NOT proof the AI booked it. Caught on
-- Honda of Downtown Los Angeles 2026-08-14: 7 "New appointment" emails for ONE customer in 6 seconds, all
-- 7 warm_transfer (start times Jul-2024 → Jan-2026). Mirrors the event-email gate in vini-daily-calls
-- (server/roi-cron/eventRunner.cjs) and notWarmTransfer() in detailQueries.ts. Prod all-time has exactly
-- three meta.source values — '' , 'warm_transfer' (4,975 / 48 teams), 'callback' (1,050) — so one equality
-- test covers it; 'callback' rows are deliberately left alone.
appt_attribution AS (
    SELECT
        meeting_id,
        team_id,
        lead_id,
        is_assisted,
        argMax(conv_id, pri) AS conversationId
    FROM (
        -- PRIMARY: AI-booked — meeting record created by the agent (source='spyne'), matched by conv id.
        SELECT m.meeting_id AS meeting_id, m.team_id AS team_id, m.lead_id AS lead_id,
               m.conversation_id AS conv_id, 2 AS pri, 0 AS is_assisted
        FROM dealer_leads.meetings AS m FINAL
        WHERE m.is_active = 1 AND m.__deleted = 0 AND m.source = 'spyne'
          AND lower(JSONExtractString(ifNull(m.meta, ''), 'source')) != 'warm_transfer'
          AND m.conversation_id IS NOT NULL AND m.conversation_id != ''
        UNION ALL
        -- PRIMARY: AI-booked — same source='spyne' meetings matched via call_id (when conv id absent).
        SELECT m.meeting_id AS meeting_id, m.team_id AS team_id, m.lead_id AS lead_id,
               c.conversationId AS conv_id, 1 AS pri, 0 AS is_assisted
        FROM dealer_leads.meetings AS m FINAL
        JOIN dealer_leads.conversations AS c FINAL
            ON c.callId = m.call_id AND c.__deleted = 0
        WHERE m.is_active = 1 AND m.__deleted = 0 AND m.source = 'spyne'
          AND lower(JSONExtractString(ifNull(m.meta, ''), 'source')) != 'warm_transfer'
          AND m.call_id IS NOT NULL AND m.call_id != ''
        UNION ALL
        -- PRIMARY: AI-booked — booked INSIDE A WEB CHAT. These meeting rows carry neither a
        -- conversation_id nor a call_id, so both anchors above miss them and without this branch the
        -- booking is counted NOWHERE (Paragon Honda 2026-08: 4 of 7 sales appointments). chat_booking_link
        -- resolves the chat that was live when the booking landed; see its definition for the match rule.
        SELECT cbl.meeting_id AS meeting_id, cbl.team_id AS team_id, cbl.lead_id AS lead_id,
               cbl.conversationId AS conv_id, 2 AS pri, 0 AS is_assisted
        FROM chat_booking_link AS cbl
        UNION ALL
        -- SECONDARY: AI-assisted (CRM). canonical: agent-worked = call, SMS or chat. Attribute the CRM meeting
        -- by LEAD_ID to the lead's representative spine conversation (lead_assist_conv) — this captures
        -- SMS-only worked leads whose meeting record carries no call_id/conversation_id (the bug where a
        -- call-only join silently dropped them). Gated to outbound-campaign leads with an in-window spine
        -- touch (call or SMS), so only genuine AI-worked outbound leads count.
        SELECT m.meeting_id AS meeting_id, m.team_id AS team_id, m.lead_id AS lead_id,
               lac.conv_id AS conv_id, 1 AS pri, 1 AS is_assisted
        FROM dealer_leads.meetings AS m FINAL
        JOIN lead_assist_conv lac
            ON lac.lead_id = m.lead_id AND lac.team_id = m.team_id
        WHERE m.is_active = 1 AND m.__deleted = 0
          AND ifNull(m.source, '') != 'spyne'
          AND lower(JSONExtractString(ifNull(m.meta, ''), 'source')) != 'warm_transfer'
          AND m.lead_id IN (SELECT lead_id FROM outbound_campaign_leads)
          -- canonical: bound the BOOKING to the report window (like AI-booked meetings attach to in-window
          -- conversations), so a windowed view credits only assists booked in that window.
          AND toDate(m.created_at) >= {START} AND toDate(m.created_at) < {END}
    )
    WHERE conv_id IS NOT NULL AND conv_id != ''
    -- one row per (meeting, is_assisted). The booked (source='spyne') and assisted (source!='spyne')
    -- halves are mutually exclusive by source, so a meeting can never land in both — no double count.
    GROUP BY meeting_id, team_id, lead_id, is_assisted
),

appt_by_conv_dedup AS (
    SELECT
        conversationId,
        team_id,
        -- canonical: AI-booked (headline) and AI-assisted (CRM, secondary) counted SEPARATELY.
        -- Lead-level dedup (uniqExactIf by lead_id) — a lead with multiple CRM bookings counts ONCE.
        uniqExactIf(lead_id, is_assisted = 0) AS n_appts,
        uniqExactIf(lead_id, is_assisted = 1) AS n_appts_assisted
    FROM appt_attribution
    GROUP BY conversationId, team_id
)

SELECT
    cs.conversationId AS conversationId,
    cs.callId AS callId,
    cs.conv_type AS conv_type,
    cs.lead_id AS "cs.lead_id",
    cs.team_id AS "cs.team_id",
    cs.enterprise_id AS enterprise_id,
    ed.name AS enterprise_name,
    coalesce(nullIf(etd.dealer_name, ''), etd.team_name) AS rooftop_name,
    coalesce(aso.stage, etd.stage) AS rooftop_stage,
    cs.service_type AS service_type,
    cs.direction AS direction,
    concat(if(cs.service_type='sales','Sales ','Service '),
           if(cs.direction='inbound','Inbound','Outbound')) AS agent_type,
    cs.activity_day AS activity_day,
    cs.activity_ts AS activity_ts,
    cs.lead_created_at AS lead_created_at,
    cs.lead_source AS lead_source,

    1                                       AS touched,
    if(cs.conv_type='call', 1, 0)           AS is_call,
    if(cs.conv_type='sms',  1, 0)           AS is_sms,
    -- ★ web chat — the third channel. is_call + is_sms + is_chat = 1 for every spine row.
    if(cs.conv_type='chat', 1, 0)           AS is_chat,

    ifNull(sb.n_sms_messages, 0)            AS n_sms_messages,
    ifNull(sb.n_human_inbound, 0)           AS n_human_inbound,
    ifNull(sb.n_sms_outbound, 0)            AS n_sms_outbound,

    -- ★ SALES OUTBOUND uses the campaign-outcome rule (ob_campaign_outcome); Sales Inbound and both
    -- Service agents keep the intent-based rule. `agent_type` is referenced (not cs.direction) so the
    -- callback→outbound flip injected by callbackAttribution.ts is honoured: a lead that called back the
    -- outbound line is Sales Outbound and must be judged by the outbound rule.
    -- The two channel columns carry the whole switch, so `qualified` below stays a plain greatest():
    --   greatest(oc_q AND spoke, oc_q AND reply_real)  ==  oc_q AND (spoke OR reply_real)
    -- which is exactly the funnel query's `eng=1 AND oc_q=1`.
    -- Sales Inbound: the AI's own report.qualified verdict (source: vini-success). ⚠️ This is NOT gated on
    -- connected, so qualified is NOT nested inside connected for Sales Inbound — vini-success measured
    -- 10.7% of qualified call conversations (156 of 1,451) with no captured role='user' turn, because
    -- report.qualified is a model verdict while connected is a transcript test. Do not build a
    -- "share of connected" chart on Sales Inbound calls; turn rate can exceed 100%.
    multiIf(
       agent_type = 'Sales Outbound',
         if(ifNull(oco.oc_q, 0) = 1 AND ifNull(ec.is_connected, 0) = 1, 1, 0),
       agent_type = 'Sales Inbound',
         ifNull(ec.report_qualified, 0),
       ifNull(ec.qualified_via_call, 0))    AS qualified_via_call,
    -- n_human_inbound_real, not n_human_inbound: a reply that is only "STOP" is the customer leaving.
    multiIf(
       agent_type = 'Sales Outbound',
         if(ifNull(oco.oc_q, 0) = 1 AND ifNull(sb.n_human_inbound_real, 0) > 0, 1, 0),
       agent_type = 'Sales Inbound',
         ifNull(sb.sms_outcome_qualified, 0),
       ifNull(sb.qualified_via_sms, 0))     AS qualified_via_sms,
    -- ★ WEB CHAT qualified. Each agent applies its OWN canonical rule to the chat, mirroring how the two
    -- columns above treat calls and SMS:
    --   • Sales Inbound  → the AI's own verdict (chat summary `qualified`), the chat twin of
    --                      report.qualified. Like that rule it is NOT nested inside engaged.
    --   • Sales Outbound → campaign-outcome rule AND the customer engaged in the chat.
    --   • Service (both) → the intent rule: engaged AND a windowed buying-intent action item on the lead
    --                      (chat carries no IRA row, so the lead-level gate is the available signal).
    -- Non-chat rows have no chat_by_conv match, so every branch collapses to 0 for them.
    multiIf(
       agent_type = 'Sales Outbound',
         if(ifNull(oco.oc_q, 0) = 1 AND ifNull(cb.chat_engaged, 0) = 1, 1, 0),
       agent_type = 'Sales Inbound',
         ifNull(cb.chat_qualified, 0),
       if(ifNull(cb.chat_engaged, 0) = 1 AND hia_lead.lead_id IS NOT NULL, 1, 0)) AS qualified_via_chat,
    greatest(qualified_via_call, qualified_via_sms, qualified_via_chat) AS qualified,

    if(ifNull(ad.n_appts, 0) > 0, 1, 0)     AS appointment_booked,
    ifNull(ad.n_appts, 0)                    AS appointments_count,
    -- canonical: AI-assisted (CRM) appointments — SECONDARY metric, kept separate from the headline.
    if(ifNull(ad.n_appts_assisted, 0) > 0, 1, 0) AS appointment_assisted,
    ifNull(ad.n_appts_assisted, 0)           AS appointments_assisted_count,

    -- canonical "Real conversation": the customer actually engaged. Call side = is_connected (voicemail
    -- excluded); chat side = chat_engaged (the visitor typed; empty widget opens excluded). chat_engaged is
    -- NULL on call/SMS rows, so this is additive-only for the new channel.
    greatest(ifNull(ec.is_connected, 0), ifNull(cb.chat_engaged, 0)) AS connected,
    if(ifNull(sb.n_human_inbound, 0) > 0, 1, 0) AS sms_replied,
    greatest(ifNull(ec.is_connected, 0), ifNull(cb.chat_engaged, 0),
             if(ifNull(sb.n_human_inbound, 0) > 0, 1, 0)) AS reached_person,

    -- primary_intent stays call-only on purpose: the chat's overview.customerIntent is free text
    -- ("Appointment for Purchase Discussion") while this column feeds the controlled-vocabulary IRA
    -- intent breakdown. Mixing them would fill "what customers wanted" with singleton labels. TODO:
    -- map chat intents onto the IRA vocabulary, then include them here.
    ec.primary_intent                       AS primary_intent,
    greatest(ifNull(ec.is_query_resolved, 0), ifNull(cb.chat_query_resolved, 0)) AS query_resolved,
    ifNull(ec.had_appt_intent, 0)           AS had_appt_intent,
    ifNull(ec.had_transfer, 0)              AS had_transfer,
    ifNull(ec.transferred, 0)               AS transferred,
    ifNull(ec.transfer_failed, 0)           AS transfer_failed,
    ifNull(ec.had_callback, 0)              AS had_callback,
    ifNull(ec.talk_seconds, 0)              AS talk_seconds,
    q.score_percentage                      AS quality_score,

    ifNull(lo.opt_out_sms, 0)               AS opted_out_sms,
    ifNull(lo.opt_out_call, 0)              AS opted_out_call,
    ch.after_hours                          AS after_hours,

    -- ★ STL: speed-to-lead flag (0/1)
    if(
        cs.conv_type = 'sms'
        AND JSONExtractString(ifNull(cs.metadata, '{}'), 'smsFlowJourneySource') = 'speed_to_lead'
        AND nullIf(cs.outbound_task_id, '') IS NULL
        AND nullIf(cs.followup_id, '') IS NULL,
        1, 0
    ) AS is_speed_to_lead,

    -- ★ STL: seconds from lead.external_created_at -> conversation.createdAt
    if(
        cs.conv_type = 'sms'
        AND JSONExtractString(ifNull(cs.metadata, '{}'), 'smsFlowJourneySource') = 'speed_to_lead'
        AND nullIf(cs.outbound_task_id, '') IS NULL
        AND nullIf(cs.followup_id, '') IS NULL
        AND cs.lead_external_created_at IS NOT NULL,
        greatest(0, dateDiff(
            'second',
            parseDateTimeBestEffortOrNull(toString(cs.lead_external_created_at)),
            parseDateTimeBestEffortOrNull(toString(cs.activity_ts))
        )),
        NULL
    ) AS speed_to_lead_response_time

FROM conversation_spine cs
LEFT JOIN eventila.enterprise_details ed FINAL
    ON cs.enterprise_id = ed.enterprise_id
LEFT JOIN eventila.enterprise_team_details etd FINAL
    ON cs.enterprise_id = etd.enterprise_id AND cs.team_id = etd.team_id
LEFT JOIN agent_stage_override aso
    ON aso.team_id = cs.team_id
   AND aso.service_type = cs.service_type
   AND aso.direction = cs.direction
LEFT JOIN ecr_by_call ec
    ON ec.callId = cs.callId AND ec.team_id = cs.team_id
LEFT JOIN sms_by_conv sb
    ON sb.conversationId = cs.conversationId AND sb.team_id = cs.team_id
-- ★ web-chat verdicts (engaged / qualified / query resolved) — see chat_by_conv
LEFT JOIN chat_by_conv cb
    ON cb.conversationId = cs.conversationId AND cb.team_id = cs.team_id
-- buying-intent gate at LEAD level, reused by the Service branch of qualified_via_chat (chat has no IRA
-- row of its own). Same CTE the SMS rule joins through lead_canonical.
LEFT JOIN lead_high_intent_action hia_lead
    ON hia_lead.lead_id = cs.lead_id AND hia_lead.team_id = cs.team_id
LEFT JOIN lead_optout lo
    ON lo.lead_id = cs.lead_id AND lo.team_id = cs.team_id
LEFT JOIN quality_by_call q
    ON q.callId = cs.callId
LEFT JOIN conv_hours ch
    ON ch.conversationId = cs.conversationId AND ch.team_id = cs.team_id
LEFT JOIN appt_by_conv_dedup ad
    ON ad.conversationId = cs.conversationId AND ad.team_id = cs.team_id
-- Sales-Outbound qualified gate. Keyed on lead_id only: campaignLeadMappings has no team column, and
-- lead_id is globally unique, so this cannot pull another rooftop's row.
LEFT JOIN ob_campaign_outcome oco
    ON oco.lead_id = cs.lead_id
WHERE 1 = 1
ORDER BY cs.activity_ts DESC, cs.team_id, cs.conv_type