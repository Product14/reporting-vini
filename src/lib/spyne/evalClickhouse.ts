/* THE CONVERSATION-OUTCOME PANELS, READ FROM CLICKHOUSE INSTEAD OF THE EVAL API.
 *
 * Same three tables the review pipeline writes:
 *   dealer_leads.conversationEval      one row per scored conversation (call or text)
 *   dealer_leads.funnelEval            the step-by-step appointment / transfer funnel
 *   dealer_leads.conversationLeadEval  the lead's standing verdict (qualified, stage, temperature)
 *
 * WHY MOVE OFF THE API. Its dashboard endpoints accept no agentType or agentCallType — verified against
 * the backend — so the funnel and tool cohorts could only ever be built by matching CALL TYPES, and the
 * card carried a caveat saying its steps covered inbound and outbound together. On one screen that put
 * three different populations under one agent's name: Dream Nissan Lawrence, Sales Inbound, 30 days
 * showed a leak funnel of 318 / 298 / 269 / 173 / 45 / 30 / 27 while this agent's own inbound funnel is
 * 427 / 400 / 260 / 195 / 56 / 35 / 40. Reading the tables directly, every panel is scoped to the team,
 * the agent type AND the direction, so the numbers belong to the agent whose name is on the card.
 *
 * It also removes a live dependency on a token that expires: the panels went blank whenever it did.
 *
 * WINDOWED ON THE CONVERSATION'S OWN TIME, decoded from the UUIDv7 conversationId (its first 48 bits are
 * unix ms). conversationEval.createdAt is when the SCORER ran, which lags the conversation by days and
 * would drag weeks-old calls into a 7-day window.
 *
 * The aggregation itself is deliberately NOT reimplemented — rows are shaped into the same RawEval the
 * API returned and handed to the existing groupFlow / topSecondary / label helpers, so the chart, the
 * labels and the rung order cannot drift between the two sources. */
import { runClickhouse, chEsc, hasClickhouseCreds } from "@/lib/spyne/clickhouse";
import type { EvalOutcomes, EvalFunnel, EvalDirection, EvalChannelFlow } from "@/lib/spyne/evalPipeline";
import { buildFlowFromRows, funnelLabel, stepLabel, type FlowRow } from "@/lib/spyne/evalPipeline";

/** UUIDv7 → unix ms, as a ClickHouse expression over `col`. Empty/short ids yield 0 and fall out. */
const uuidV7Ms = (col: string) =>
  `reinterpretAsUInt64(reverse(unhex(replaceAll(substring(ifNull(${col},''),1,13),'-',''))))`;

export async function fetchOutcomesFromClickhouse(args: {
  teamId: string;
  dir: EvalDirection;
  agentType: "sales" | "service";
  startISO: string;
  endISO: string;
}): Promise<EvalOutcomes | null> {
  const { teamId, dir, agentType, startISO, endISO } = args;
  if (!teamId || !hasClickhouseCreds()) return null;

  const T = chEsc(teamId);
  const A = chEsc(agentType);
  const D = chEsc(dir);
  const startMs = Date.parse(startISO);
  const endMs = Date.parse(endISO);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;

  /* One row per (channel, callType, primaryIntent, outcome) plus the scalars each panel needs. Grouping
   * in ClickHouse rather than pulling every conversation keeps this to a few hundred rows on any
   * rooftop; the tree is assembled from them in TS by the same helper the API path uses. */
  const flowSql = `
    SELECT channel,
           ifNull(callType,'') AS callType,
           ifNull(primaryIntent,'') AS primaryIntent,
           ifNull(outcomeAchieved,'None') AS outcomeAchieved,
           ifNull(interest,'') AS interest,
           count() AS n,
           countIf(outcomeGap = 1) AS gaps,
           sumIf(conversationScore, isNotNull(conversationScore)) AS scoreSum,
           countIf(isNotNull(conversationScore)) AS scoreN
    FROM dealer_leads.conversationEval
    WHERE __deleted = 0
      AND teamId = '${T}' AND agentType = '${A}' AND agentCallType = '${D}'
      AND ${uuidV7Ms("conversationId")} >= ${startMs}
      AND ${uuidV7Ms("conversationId")} <  ${endMs}
    GROUP BY channel, callType, primaryIntent, outcomeAchieved, interest`;

  /* THE FUNNEL, SCOPED BY DIRECTION — which is the whole reason this exists. funnelEval carries no
   * agentType or agentCallType of its own, so it is joined to conversationEval on conversationId to
   * inherit them. Steps are independently judged by the reviewer and are NOT guaranteed to be
   * monotonic (on the rooftop this was built against step6 exceeds step5), so each is counted on its
   * own rather than derived from the one before. */
  const evCte = `
    ev AS (
      SELECT ifNull(conversationId,'') AS cid
      FROM dealer_leads.conversationEval
      WHERE __deleted = 0
        AND teamId = '${T}' AND agentType = '${A}' AND agentCallType = '${D}'
        AND ${uuidV7Ms("conversationId")} >= ${startMs}
        AND ${uuidV7Ms("conversationId")} <  ${endMs}
        AND ifNull(conversationId,'') != ''
    )`;
  const funnelStepSql = `
    WITH ${evCte}
    SELECT f.funnelKey AS funnelKey,
           /* funnelPipeline is Tuple(key, order, passed, evidenceSource, evidenceQuote) — key is .1 and
              order is .2. Reading them the other way round labelled every step with its own index. */
           s.2 AS ord, s.1 AS stepKey, toUInt8(s.3) AS passed, s.4 AS evidence,
           count() AS n
    FROM (
      SELECT funnelKey, conversationId, arrayJoin(funnelPipeline) AS s
      FROM dealer_leads.funnelEval
      WHERE __deleted = 0 AND teamId = '${T}' AND eligible = 1
    ) AS f
    INNER JOIN ev ON ev.cid = ifNull(f.conversationId,'')
    GROUP BY funnelKey, ord, stepKey, passed, evidence`;
  const funnelTotalSql = `
    WITH ${evCte}
    SELECT f.funnelKey AS funnelKey, uniqExact(f.conversationId) AS eligible
    FROM dealer_leads.funnelEval AS f
    INNER JOIN ev ON ev.cid = ifNull(f.conversationId,'')
    WHERE f.__deleted = 0 AND f.teamId = '${T}' AND f.eligible = 1
    GROUP BY funnelKey`;

  try {
    const [flowRaw, stepRaw, totalRaw] = await Promise.all([
      runClickhouse<Record<string, string | number>>(flowSql),
      runClickhouse<Record<string, string | number>>(funnelStepSql),
      runClickhouse<Record<string, string | number>>(funnelTotalSql),
    ]);

    const rows: FlowRow[] = flowRaw.map((r) => ({
      channel: String(r.channel || ""),
      callType: String(r.callType || ""),
      primaryIntent: String(r.primaryIntent || ""),
      outcome: String(r.outcomeAchieved || "None"),
      interest: String(r.interest || ""),
      n: Number(r.n) || 0,
      gaps: Number(r.gaps) || 0,
      scoreSum: Number(r.scoreSum) || 0,
      scoreN: Number(r.scoreN) || 0,
    }));
    if (!rows.length) return null;

    const funnels = buildFunnels(stepRaw, totalRaw);
    return buildFlowFromRows({ dir, rows, funnels });
  } catch (e) {
    console.error(`[evalClickhouse] ${teamId}/${agentType}/${dir}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/* funnelEval rows → the report's funnels. A step counts when passed=1; evidenceSource='llm' marks the
 * steps the UI flags as judged rather than observed. totalEligible is the funnel's own conversation
 * count, taken from its own query rather than inferred from step 1 — a conversation can be eligible and
 * fail the first step, and reading step 1 as the total would quietly hide those. */
function buildFunnels(
  steps: Record<string, string | number>[],
  totals: Record<string, string | number>[],
): EvalFunnel[] {
  const eligibleByKey = new Map<string, number>();
  for (const t of totals) eligibleByKey.set(String(t.funnelKey || "").trim(), Number(t.eligible) || 0);

  type Acc = { order: Map<string, number>; counts: Map<string, number>; llm: Set<string> };
  const byKey = new Map<string, Acc>();
  for (const r of steps) {
    const key = String(r.funnelKey || "").trim();
    const stepKey = String(r.stepKey || "").trim();
    if (!key || !stepKey) continue;
    const m: Acc = byKey.get(key) ?? { order: new Map(), counts: new Map(), llm: new Set() };
    m.order.set(stepKey, Number(r.ord) || 0);
    // Rows arrive split by passed/evidence, so accumulate rather than assign.
    if (Number(r.passed) === 1) m.counts.set(stepKey, (m.counts.get(stepKey) ?? 0) + (Number(r.n) || 0));
    if (String(r.evidence || "") === "llm") m.llm.add(stepKey);
    byKey.set(key, m);
  }

  const out: EvalFunnel[] = [...byKey.entries()].map(([key, m]) => ({
    key,
    label: funnelLabel(key),
    totalEligible: eligibleByKey.get(key) ?? 0,
    steps: [...m.order.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([sk]) => ({ key: sk, label: stepLabel(sk), count: m.counts.get(sk) ?? 0, llm: m.llm.has(sk) })),
  }));
  // Appointment first, then Transfer, then anything else — the order the report reads in.
  const rank = (k: string) => (k === "Appointment" ? 0 : k === "Transfer" ? 1 : 2);
  return out.sort((a, b) => rank(a.key) - rank(b.key));
}

export type { EvalChannelFlow };
