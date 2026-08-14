/* Per-event CONVERSATION feed for the post-conversation transactional email.
 *
 * Recent AI conversations for a rooftop. channel=call (default) = per-call rows from
 * dealer_leads.endcallreports; channel=sms = per-thread SMS rows from dealer_leads.smsMessages
 * (scoped via dealer_leads.conversations, with the day's message bubbles); channel=chat = website
 * chatbot threads (conversations type='chat' — the bubbles live in the SAME smsMessages table, so
 * the thread mechanics are shared; the row is enriched from the chat's conversationAnalytics /
 * report summary); channel=both = call+sms union (pre-chat callers rely on this exact meaning).
 * The poll pass asks for channel=call every few minutes (emailed instantly); the EOD pass asks for
 * channel=sms with since=local-midnight (emailed once at end of day, since the thread runs all day);
 * the chat pass polls channel=chat back to local midnight and emails per settled session.
 *
 *   /api/conversations?team_id=&serviceType=sales|service|both[&channel=call|sms|chat|both][&minutes=15][&since=ISO][&limit=50][&actionableOnly=1]
 *
 * Degrades to an empty list — never 502s the pipeline.
 */
import { runClickhouse, chEsc, hasClickhouseCreds } from "@/lib/spyne/clickhouse";
import { requireTeamAuth, spyneTokenFrom, spyneEnvFrom } from "@/lib/reports/auth";
import { getStoreTimeZone } from "@/lib/spyne/teamContext";
import { rangeFor } from "@/components/reports/liveData";
import type { Bucket } from "@/components/reports/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SERVICE = new Set(["sales", "service", "both"]);
const BUCKETS = new Set(["today", "yesterday", "last7", "last14", "last30", "mtd", "lifetime"]);
const ISO_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?)?$/;
const idOk = (s: string) => /^[A-Za-z0-9_-]{1,64}$/.test(s);

// Explicit dept label from the agent-type/service-type string. Prefix-based and exhaustive: only a value
// that actually starts with "service"/"sales" maps to that dept — blank/receptionist/sms → "other"
// (the old `/service/.test ? service : sales` mislabeled all of those as sales).
function deptOf(s: string): "sales" | "service" | "other" {
  const v = (s || "").trim().toLowerCase();
  if (v.startsWith("service")) return "service";
  if (v.startsWith("sales")) return "sales";
  return "other";
}

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const teamId = searchParams.get("team_id") || "";
  if (!idOk(teamId)) return Response.json({ error: "valid team_id is required" }, { status: 400 });

  // PII endpoint (customer names / phones / call summaries) — auth is REQUIRED. A valid Spyne session
  // token scoped to this team, or the service CRON_SECRET. No credential → 401; wrong team scope → 403.
  const auth = requireTeamAuth(request, teamId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  // degraded:true is a LOUD signal — without it, a missing CLICKHOUSE_* env returns an empty 200 that
  // looks identical to "no events", so the transactional cron silently sends nothing (it did, for days).
  if (!hasClickhouseCreds()) return Response.json({ conversations: [], total: 0, degraded: true, note: "clickhouse not configured" });

  const svc = (searchParams.get("serviceType") || "both").toLowerCase();
  const service = SERVICE.has(svc) ? svc : "both";
  const minutes = Math.max(1, Math.min(10_080, Number(searchParams.get("minutes")) || 15)); // ≤7d
  const since = searchParams.get("since");
  const limit = Math.max(1, Math.min(200, Number(searchParams.get("limit")) || 50));
  const actionableOnly = searchParams.get("actionableOnly") === "1";
  // CHANNEL — 'call' (default; endcallreports, the original behaviour) | 'sms' (per-thread SMS from
  // smsMessages) | 'chat' (website-chatbot threads; same bubble store, conversations type='chat') |
  // 'both'. SMS post-conversation is emailed ONCE at end-of-day (the thread runs all day), so the
  // poll asks for channel=sms with a since=local-midnight window. SMS/chat have no agent-type, so
  // they are NOT split by sales/service (returns the team's threads regardless of serviceType).
  // 'both' stays call+sms (its pre-chat meaning) — chat is only returned when asked for explicitly,
  // so no existing caller suddenly double-reports chat threads.
  const channel = (searchParams.get("channel") || "call").toLowerCase();
  const wantCall = channel === "call" || channel === "both";
  const wantSms = channel === "sms" || channel === "both";
  const wantChat = channel === "chat";
  // Optional lead scope: when set, return THIS lead's calls/SMS (its full recent history) regardless of
  // the time window — used by the "review conversation" drill-down on named leads. Validated like team_id.
  const leadId = (searchParams.get("leadId") || "").trim();
  const leadScoped = idOk(leadId);

  // Window resolution. The report UI passes a preset `bucket` → resolve a STORE-LOCAL [start,end) window
  // server-side (rooftop tz, same as /api/reports) so the Calls tab / recent-conversations "Yesterday" is
  // the DEALER's yesterday and does NOT bleed today's calls in. Previously the tab passed only `since`
  // with NO upper bound, so every window ran to now() — a UTC "yesterday" that included today's latest
  // call (RETCONVAI-4152). Explicit since/until (and the email cron's since-only poll) still win; a
  // lead-scoped drill-down ignores the window entirely.
  const bucketRaw = searchParams.get("bucket") || "";
  const untilRaw = searchParams.get("until") || searchParams.get("end") || "";
  let winStart = since && ISO_RE.test(since) ? since : "";
  let winEnd = untilRaw && ISO_RE.test(untilRaw) ? untilRaw : "";
  if (!leadScoped && (!winStart || !winEnd) && BUCKETS.has(bucketRaw)) {
    const tz = await getStoreTimeZone(teamId, spyneTokenFrom(request), spyneEnvFrom(request));
    const w = rangeFor(bucketRaw as Bucket, tz ?? undefined);
    if (!winStart) winStart = w.start;
    if (!winEnd) winEnd = w.end;
  }
  // Lower bound = resolved window start (or the trailing `minutes` when neither since nor bucket is given,
  // preserving the transactional-email poll's behaviour). Upper bound applied ONLY when we have a window
  // end (bucket/until) — a since-only caller keeps its "since → now" semantics.
  const sinceClause = (col: string) =>
    (winStart ? `${col} >= parseDateTimeBestEffort('${chEsc(winStart)}')` : `${col} >= now() - INTERVAL ${minutes} MINUTE`) +
    (winEnd ? ` AND ${col} < parseDateTimeBestEffort('${chEsc(winEnd)}')` : "");

  type Conv = Record<string, unknown> & { at: string };
  const out: Conv[] = [];

  if (wantCall) {
    const where: string[] = [
      `e.teamId='${chEsc(teamId)}'`,
      "e.isActive=1", "e.__deleted=0", "e.isTestCall=0",
    ];
    // Lead-scoped drill-down ignores the time window (show the lead's history); otherwise bound by since/minutes.
    if (leadScoped) where.push(`e.leadId='${chEsc(leadId)}'`);
    else where.push(sinceClause("e.createdAt"));
    // Prefix match, not exact: 'sales' must also catch 'sales spanish' etc. (an exact '=' dropped those
    // valid rows). `service`/`both` are validated against the SERVICE allow-list above, so the literal is safe.
    if (service !== "both") where.push(`lower(e.callDetails_agentInfo_agentType) LIKE '${service}%'`);
    // "actionable" = the call produced an action item, scheduled an appointment, or left a query unresolved.
    if (actionableOnly) where.push("(ifNull(e.report_actionItems,'') NOT IN ('','[]','{}') OR lower(ifNull(e.report_overview_appointmentScheduled,''))='true' OR lower(ifNull(e.report_queryResolved,''))='false')");

    // Identity (lead→customer) + AI-quality joins so the per-event email carries the customer name and
    // call grade — the SAME data the digest reads, sourced once here instead of a second ClickHouse query
    // in vini-daily-calls (eventPreviewCH). Without these the sent post-conversation email had no customer.
    const sql =
      "SELECT e.id AS id, e.leadId AS leadId, e.callId AS callId," +
      " coalesce(nullIf(c.mobile_number,''), e.callDetails_mobile) AS phone, ifNull(c.name,'') AS customer," +
      " arrayElement(c.emails,1) AS email," +
      " e.callDetails_agentInfo_agentType AS agentType, ifNull(e.callDetails_agentInfo_agentName,'') AS agent," +
      " lower(ifNull(e.report_inOutType,'')) AS direction, ifNull(e.report_title,'') AS title," +
      " ifNull(e.report_summary, ifNull(e.callDetails_analysis_summary,'')) AS summary," +
      " ifNull(e.report_aiScore_totalScore, 0) AS score10," +
      " JSONExtractString(arrayElement(JSONExtractArrayRaw(assumeNotNull(ifNull(e.report_sales,'{}')),'vehicleRequested'),1),'vehicleName') AS vehicle," +
      " ifNull(dateDiff('second', parseDateTimeBestEffortOrNull(e.callDetails_startedAt), parseDateTimeBestEffortOrNull(e.callDetails_endedAt)), 0) AS durationSec," +
      " ifNull(e.callDetails_recordingUrl,'') AS recordingUrl," +
      " lower(ifNull(e.report_overview_appointmentScheduled,'')) AS apptScheduled," +
      " lower(ifNull(e.report_queryResolved,'')) AS queryResolved," +
      " ifNull(e.report_actionItems,'') AS actionItems," +
      // endedReason is how a call ACTUALLY ended — 'voicemail' is the only reliable voicemail signal
      // (duration is NOT: the agent monologues at the answering machine for 75-187s, so every voicemail
      // call looks "connected"). The post-conversation email gate and the "Left a voicemail" outcome
      // banner both key on this; without it the banner never fired and the gate had nothing to test.
      " ifNull(e.callDetails_endedReason,'') AS endedReason," +
      // Full call transcript — rendered in the post-conversation email (capped there, not here).
      " ifNull(e.callDetails_transcript,'') AS transcript," +
      " q.score AS aiScore, q.grade AS grade, q.frustrated AS frustrated," +
      " formatDateTime(e.createdAt,'%Y-%m-%dT%H:%i:%SZ') AS at" +
      " FROM dealer_leads.endcallreports e" +
      " LEFT JOIN (SELECT lead_id, any(customer_id) cid FROM dealer_leads.leads GROUP BY lead_id) l ON e.leadId=l.lead_id" +
      " LEFT JOIN (SELECT customer_id, any(name) name, any(mobile_number) mobile_number, any(emails) emails FROM dealer_leads.customer GROUP BY customer_id) c ON l.cid=c.customer_id" +
      " LEFT JOIN (SELECT callId, any(scorePercentage) score, any(overallGrade) grade, any(customerFrustrated) frustrated FROM dealer_leads.conversationQualities WHERE createdAt >= now()-INTERVAL 30 DAY GROUP BY callId) q ON e.callId=q.callId" +
      " WHERE " + where.join(" AND ") +
      ` ORDER BY e.createdAt DESC LIMIT ${limit}`;
    const rows = await runClickhouse<Record<string, string | number>>(sql);
    for (const r of rows) {
      const frustrated = Number(r.frustrated) === 1;
      const resolved = String(r.queryResolved) === "true";
      out.push({
      id: String(r.id), leadId: r.leadId ? String(r.leadId) : null, callId: r.callId ? String(r.callId) : null,
      phone: r.phone ? String(r.phone) : null, customer: r.customer ? String(r.customer) : null,
      email: r.email ? String(r.email).replace(/^"+|"+$/g, "").trim() || null : null,
      channel: "call", dept: deptOf(String(r.agentType || "")),
      agent: r.agent ? String(r.agent) : null,
      direction: r.direction === "outbound" ? "outbound" : "inbound",
      title: String(r.title || ""), summary: String(r.summary || ""),
      vehicle: r.vehicle ? String(r.vehicle) : null,
      durationSec: Number(r.durationSec) || 0,
      // NOTE: this means "the call had airtime", NOT "a human answered". Voicemail calls run 75-187s
      // (the agent talks to the machine), so they are `connected:true`. Use `endedReason` to detect
      // voicemail — never this flag.
      connected: (Number(r.durationSec) || 0) > 0,
      endedReason: r.endedReason ? String(r.endedReason) : null,
      transcript: r.transcript ? String(r.transcript) : null,
      recordingUrl: r.recordingUrl ? String(r.recordingUrl) : null,
      score: Number(r.score10) || 0,
      sentiment: frustrated ? "Negative" : "Neutral",
      outcome: resolved ? "Resolved" : "Not Resolved",
      appointmentScheduled: r.apptScheduled === "true",
      queryResolved: resolved,
      hasActionItem: !!(r.actionItems && !["", "[]", "{}"].includes(String(r.actionItems))),
      // The action items THEMSELVES, not just the boolean. report_actionItems is a JSON array of plain
      // strings ("Prepare the GLS for Victor's visit tomorrow at noon."). Only the flag was returned
      // before, so the post-conversation email could say a call needed follow-up but never show WHAT —
      // the chat branch has always returned the array, calls never did. Parsed defensively: anything
      // unexpected yields [], which renders no section rather than breaking the email.
      actionItems: ((): string[] => {
        try {
          const parsed: unknown = JSON.parse(String(r.actionItems || "[]"));
          if (!Array.isArray(parsed)) return [];
          return parsed
            .map((x) => (typeof x === "string" ? x : typeof (x as { description?: unknown })?.description === "string" ? String((x as { description: string }).description) : ""))
            .map((s) => s.trim())
            .filter(Boolean);
        } catch {
          return [];
        }
      })(),
      aiScore: r.aiScore != null && r.aiScore !== "" ? Number(r.aiScore) : null,
      grade: r.grade ? String(r.grade) : null,
      frustrated,
      at: r.at ? String(r.at) : "",
      });
    }
  }

  // Shared thread-row shape for the two smsMessages-backed channels (SMS + chat): one row per
  // conversationId with the message bubbles. smsMessages has no teamId, so both scope through
  // dealer_leads.conversations (conversationId → teamId/leadId), then lead→customer for the
  // name/phone. authorType 'human' = the customer's reply, 'ai' = the agent. `convType` MUST be
  // pinned ('sms' | 'chat') — the bubble store is shared, so an unscoped join returns BOTH and
  // chat threads leak into the SMS EOD digest mislabeled as texts (they did, until chat landed).
  const threadSql = (convType: "sms" | "chat", extraOuter = "", extraInner = "") =>
    "SELECT t.id AS id, t.leadId AS leadId, ifNull(c.name,'') AS customer," +
    " coalesce(nullIf(c.mobile_number,''), t.phone) AS phone, t.inboundMsgs AS inboundMsgs, t.msgs AS msgs, t.at AS at," +
    extraOuter +
    " t.atypes AS atypes, t.bodies AS bodies, t.statuses AS statuses, t.ats AS ats FROM (" +
    "SELECT s.conversationId AS id, any(cv.leadId) AS leadId, any(s.fromNumberE164) AS phone," +
    extraInner +
    " countIf(lower(ifNull(s.authorType,''))='human') AS inboundMsgs, count() AS msgs," +
    " formatDateTime(max(s.createdAt),'%Y-%m-%dT%H:%i:%SZ') AS at," +
    " groupArray(lower(ifNull(s.authorType,''))) AS atypes, groupArray(substring(ifNull(s.body,''),1,240)) AS bodies," +
    " groupArray(lower(ifNull(s.status,''))) AS statuses, groupArray(formatDateTime(s.createdAt,'%Y-%m-%dT%H:%i:%SZ')) AS ats" +
    " FROM dealer_leads.smsMessages s" +
    ` INNER JOIN (SELECT conversationId, any(teamId) teamId, any(leadId) leadId,` +
    ` anyIf(number, notEmpty(ifNull(number,''))) number,` +
    ` argMax(ifNull(status,''), ifNull(updatedAt, toDateTime(0))) convStatus,` +
    ` argMax(ifNull(summary,''), ifNull(updatedAt, toDateTime(0))) summaryJson,` +
    ` argMax(ifNull(conversationAnalytics,''), ifNull(updatedAt, toDateTime(0))) analyticsJson` +
    ` FROM dealer_leads.conversations WHERE type='${convType}' AND ifNull(isTest,0)=0 GROUP BY conversationId) cv ON s.conversationId=cv.conversationId` +
    ` WHERE cv.teamId='${chEsc(teamId)}' AND s.__deleted=0 AND ${leadScoped ? `cv.leadId='${chEsc(leadId)}'` : sinceClause("s.createdAt")}` +
    ` GROUP BY s.conversationId ORDER BY at DESC LIMIT ${limit}` +
    ") t" +
    " LEFT JOIN (SELECT lead_id, any(customer_id) cid FROM dealer_leads.leads GROUP BY lead_id) l ON t.leadId=l.lead_id" +
    " LEFT JOIN (SELECT customer_id, any(name) name, any(mobile_number) mobile_number FROM dealer_leads.customer GROUP BY customer_id) c ON l.cid=c.customer_id";
  const bubblesOf = (r: Record<string, unknown>) => {
    const atypes = (Array.isArray(r.atypes) ? r.atypes : []) as string[];
    const bodies = (Array.isArray(r.bodies) ? r.bodies : []) as string[];
    const statuses = (Array.isArray(r.statuses) ? r.statuses : []) as string[];
    const ats = (Array.isArray(r.ats) ? r.ats : []) as string[];
    return atypes.map((authorType, i) => ({
      authorType, body: bodies[i] || "", status: statuses[i] || "", at: ats[i] || "",
      direction: (statuses[i] || "") === "received" ? "inbound" : "outbound",
    })).sort((a, b) => (a.at || "").localeCompare(b.at || "")).slice(-12);
  };

  if (wantSms) {
    const rows = await runClickhouse<Record<string, unknown>>(threadSql("sms"));
    for (const r of rows) {
      const bubbles = bubblesOf(r);
      const inbound = Number(r.inboundMsgs) || 0;
      out.push({
        id: String(r.id || ""), leadId: (r.leadId as string) || null,
        phone: (r.phone as string) || null, customer: (r.customer as string) || null,
        channel: "sms", dept: "other",
        direction: inbound > 0 ? "inbound" : "outbound",
        title: "", summary: "",
        appointmentScheduled: false, queryResolved: false, hasActionItem: false,
        hasReply: inbound > 0, msgs: Number(r.msgs) || 0,
        sms: bubbles, smsFailed: bubbles.filter((b) => ["failed", "undelivered", "error"].includes(b.status)).length,
        at: (r.at as string) || "",
      });
    }
  }

  if (wantChat) {
    // Chat threads carry their own analysis on the conversations row — either the widget's
    // conversationAnalytics blob (chatSummary bullets, customerSentiment, outcome, dispositions,
    // dealerActionItems, appointmentDetails) or, for some rooftops, a full endcallreports-style
    // report JSON in `summary`. Both are optional and parsed defensively; the thread bubbles are
    // always there. Identity falls back lead→customer, then the conversation's own captured
    // `number` (many chats have a number but no lead row yet).
    const jparse = (s: unknown): Record<string, unknown> => {
      if (typeof s !== "string" || !s.trim()) return {};
      try { const v = JSON.parse(s); return v && typeof v === "object" ? v as Record<string, unknown> : {}; } catch { return {}; }
    };
    const joinLines = (v: unknown): string =>
      Array.isArray(v) ? v.filter((x) => x && String(x).trim()).map(String).join(" ") : typeof v === "string" ? v.trim() : "";
    const rows = await runClickhouse<Record<string, unknown>>(threadSql("chat",
      " t.number AS number, t.convStatus AS convStatus, t.summaryJson AS summaryJson, t.analyticsJson AS analyticsJson,",
      " any(cv.number) AS number, any(cv.convStatus) AS convStatus, any(cv.summaryJson) AS summaryJson, any(cv.analyticsJson) AS analyticsJson,"));
    for (const r of rows) {
      const bubbles = bubblesOf(r);
      const inbound = Number(r.inboundMsgs) || 0;
      const analytics = jparse(r.analyticsJson);
      const report = jparse(r.summaryJson);
      const overview = (report.overview && typeof report.overview === "object" ? report.overview : {}) as Record<string, unknown>;
      const sentimentRaw = (analytics.customerSentiment as Record<string, unknown> | undefined)?.sentiment
        ?? (overview.overall as Record<string, unknown> | undefined)?.sentiment;
      const summary = joinLines(report.summary) || joinLines(analytics.chatSummary);
      const outcome = String(analytics.outcome || report.Outcome || overview.callOutcome || "");
      // Booked = the widget confirmed it (status confirmed/booked/scheduled) or the report says Yes.
      // 'pending_confirmation' is NOT booked — counting it would announce appointments that never land.
      const apptStatus = String((analytics.appointmentDetails as Record<string, unknown> | undefined)?.status || "").toLowerCase();
      const appointmentScheduled = ["confirmed", "booked", "scheduled"].includes(apptStatus) ||
        String(overview.appointmentScheduled || "").toLowerCase() === "yes";
      const actionItems = [
        ...(Array.isArray(analytics.dealerActionItems) ? analytics.dealerActionItems : []),
        ...(Array.isArray(report.actionItems) ? report.actionItems : []),
      ].map(String).filter((x) => x.trim());
      out.push({
        id: String(r.id || ""), leadId: (r.leadId as string) || null,
        phone: (r.phone as string) || (r.number as string) || null, customer: (r.customer as string) || null,
        channel: "chat", dept: "other",
        // A widget chat is always customer-initiated on the dealer's own site.
        direction: "inbound",
        title: String(report.title || "") || (outcome ? outcome : ""), summary,
        sentiment: sentimentRaw ? String(sentimentRaw) : null,
        outcome, status: (r.convStatus as string) || "",
        appointmentScheduled,
        queryResolved: String(report.queryResolved || "").toLowerCase() === "yes",
        hasActionItem: actionItems.length > 0, actionItems,
        hasReply: inbound > 0, msgs: Number(r.msgs) || 0,
        sms: bubbles, smsFailed: 0,
        at: (r.at as string) || "",
      });
    }
  }

  const conversations = out.sort((a, b) => (b.at || "").localeCompare(a.at || "")).slice(0, limit);
  return Response.json({ conversations, total: conversations.length }, {
    headers: { "Cache-Control": "s-maxage=30, stale-while-revalidate=60" },
  });
}
