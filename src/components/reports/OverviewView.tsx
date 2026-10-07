"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  BUCKET_LABELS,
  Card,
  DateFilter,
  Eyebrow,
  fmtInt,
  GhostPreview,
  ReportTopBar,
  SectionLabel,
  StepList,
} from "@/components/reports/kit";
import { TrainingOverview, type Direction, type DirectionStatus } from "@/components/reports/training";
import { LiveOverview, LIVE_SECTIONS } from "@/components/reports/liveReplica";
import { OnboardingStub, type Stage } from "@/components/reports/stageFlow";
import { SAMPLE_SERVICE_FEED, SAMPLE_AISTATS, SAMPLE_WORKITEMS } from "@/components/reports/sampleData";
import {
  ActionItemList,
  ActionItemsScoreboard,
  AgentFunnelCard,
  DefinitionsFooter,
  fmtDuration,
  fmtRate,
  fmtSecs,
  fmtWhenShort,
  MetricTile,
  Modal,
  NamedApptsTable,
  
  ValueTile,
  WarmLeadChips,
  WarmLeadsModal,
} from "@/components/reports/kitV3";
import { useScenario, type ScenarioView } from "@/components/reports/scenario";
import { ReportAccessDenied } from "@/components/reports/accessState";
import { fetchAgents, fetchActionItems, fetchActionItemStats, fetchConversations, agentsForAccount, aggregateFleet, unattributedApptsFor, assistedApptsFor, rooftopRungsFor, workedByBoth, addDay, peekAgents, tzShortLabel, leadEntryStage, type FetchResult, type ActionItem, type ActionItemStats, type ActionItemCloser } from "@/components/reports/liveData";
import { useDateRange, useVariant, reportNavQuery, type Dept } from "@/components/reports/dateRange";
import { exportRoiPdf } from "@/components/reports/roiPdf";
import type { QualifiedLead } from "@/app/api/reports/qualified-leads/route";
import { useCustomize, CustomizeToggle, CustomizeSections, CustomizeModal, Hideable, type SectionDef, type CustomizeGroup } from "@/components/reports/customize";
import { useOutcomes, OutcomesSection } from "@/components/reports/outcomes";
import { goCrossPage } from "@/components/reports/parentNav";
import { track } from "@/lib/analytics";
import { useServiceOverviewOverlay } from "@/lib/serviceMetrics";

// Customizable section ids for the Overview (stable module constant → identity-stable across renders).
/* "conversations" dropped with the Recent Conversations section it ordered. */
const OVERVIEW_SECTION_IDS = ["value", "agents", "work"];
// Customize manifest for the NEW Live overview — ids/labels come straight from LiveOverview so they can
// never drift from what actually renders.
const LIVE_SECTION_IDS = LIVE_SECTIONS.map((s) => s.id);

/* The "Worked by both" row for a tile whose headline is a DISTINCT lead count over an Inbound/Outbound
   split that is still agent-summed (there is no canonical per-direction rooftop figure to fix the split
   with — the overview is fetched without a `direction`). Computed from the two values the tile actually
   renders, so it can never drift from the rows beside it. undefined — the row is simply absent — when
   they already add up, which is every rooftop with no cross-agent overlap and every scope where the
   rungs fell back to summing. */
const overlapRow = (total: number, inbound: number, outbound: number): string | undefined => {
  const n = workedByBoth(total, inbound, outbound);
  return n > 0 ? fmtInt(n) : undefined;
};

// "internal" (/reports/ root) → the By-agent drill-down lives in the SAME iframe, keep navigating there
// via router.push. "parent" (/overview/, standalone) → By-agent is a DIFFERENT parent-console iframe now,
// so the drill-down breaks out to the top-level console page instead (see parentNav.ts).
export type AgentLinkMode = "internal" | "parent";

// useDateRange() reads the selected window from the URL (?range / ?start&?end), which needs a Suspense
// boundary above useSearchParams. The window now lives in the URL so it survives tab navigation.
export default function OverviewReportPage({ agentLinkMode }: { agentLinkMode: AgentLinkMode }) {
  return (
    <Suspense fallback={null}>
      <OverviewReportView agentLinkMode={agentLinkMode} />
    </Suspense>
  );
}

function OverviewReportView({ agentLinkMode }: { agentLinkMode: AgentLinkMode }) {
  const router = useRouter();
  // Selected window comes from the URL so it persists across navigation to the By-agent tab (and back).
  const { bucket, custom, setPreset, setCustom } = useDateRange();
  const { scenario, view, teamId, account, spyneToken, spyneEnv, enterpriseId, serviceType } = useScenario();

  // ?sample=1 → fully self-contained SAMPLE mode: every fetch is skipped and the built-in service demo
  // data is fed in (no backend, no auth, no env). Declared up here so the fetch effects can short-circuit.
  const previewParams = useSearchParams();
  const sampleMode = previewParams.get("sample") != null;

  // custom range (inclusive end) overrides the preset bucket; end is made exclusive for the query.
  // spyneToken (host-forwarded, prod) rides along so the server can resolve timezone + onboarded agents;
  // spyneEnv picks which Spyne backend (uat/stag/prod) those calls hit.
  const rangeOpts = custom ? { start: custom.start, end: addDay(custom.end), spyneToken, spyneEnv } : { bucket, spyneToken, spyneEnv };
  // Live fleet for the selected rooftop. Seed from the client cache so navigating back paints
  // instantly instead of flashing a skeleton; null === nothing cached yet (cold load).
  const [feed, setFeed] = useState<FetchResult | null>(() => peekAgents({ teamId, ...rangeOpts }));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);
  // Engagement: the rooftop has resolved by the time this page mounts (the layout's
  // ScenarioProvider holds children behind a loader until then), so this fires once
  // per opened report with the real team_id. team_id "" → "(unscoped)" in track().
  useEffect(() => { track("report_viewed", { tab: "overview", team_id: teamId }); }, [teamId]);
  useEffect(() => {
    if (sampleMode || !teamId) return; // sample mode / no rooftop → leave feed as-is
    let on = true;
    // show cached data immediately (stale-while-revalidate); only blank to the skeleton when cold
    const cached = peekAgents({ teamId, ...rangeOpts });
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFeed(cached);
    fetchAgents({ teamId, ...rangeOpts })
      .then((res) => { if (on) setFeed(res); })
      .catch(() => { if (!on) return; track("report_load_failed", { tab: "overview", team_id: teamId }); if (!cached) setFeed({ agents: [], hasData: false, fetchedAt: Date.now(), prior: {} }); });
    return () => { on = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, bucket, custom]);
  // Self-heal: if the fetch degraded (fetchAgents already retried 3× in-line), quietly re-hit the server
  // ONCE more a moment later so the report fills in on its own instead of leaving the user to refresh.
  // Depends on the degraded BOOLEAN (not fetchedAt): a still-degraded retry keeps it true → the effect
  // does NOT re-run, so this can never become a perpetual poll. Auth failures aren't degraded, so a 401
  // never triggers it.
  useEffect(() => {
    if (!teamId || feed?.degraded !== true) return;
    let on = true;
    const t = setTimeout(() => {
      fetchAgents({ teamId, ...rangeOpts, force: true }).then((res) => { if (on) setFeed(res); }).catch(() => {});
    }, 4000);
    return () => { on = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, bucket, custom, feed?.degraded]);
  const refresh = () => {
    if (!teamId) return;
    track("report_refreshed", { tab: "overview", team_id: teamId });
    setFeed(null);
    fetchAgents({ teamId, ...rangeOpts, force: true })
      .then(setFeed)
      .catch(() => { track("report_load_failed", { tab: "overview", team_id: teamId }); setFeed({ agents: [], hasData: false, fetchedAt: Date.now(), prior: {} }); });
  };

  // Department switcher (All / Sales / Service) — scopes the WHOLE report: agents (fleet + IB/OB split),
  // named appointments, warm leads, action items and recent conversations. "all" → both departments.
  // Department is a HARD scope from the iframe URL (serviceType / service_type / department), exactly like
  // the appointments + action-items consoles: no in-app "all"/switcher, defaults to sales when absent.
  // The caller passes the scope on the URL and the view (and its sales/service skin) follows.
  const dept = serviceType as Dept; // "sales" | "service" (never "all")
  const locked = true;
  const svc = dept === "all" ? "both" : dept;

  // Action-item scoreboard (created/closed for the window + open/overdue/due-today now + who-closed-most).
  // Fetched separately from /api/action-items (direct ClickHouse), keyed on the server-resolved window so
  // it matches the report's dates. null until loaded / on error → the tile + section show "—".
  const [aiStats, setAiStats] = useState<{ stats: ActionItemStats; closers: ActionItemCloser[] } | null>(null);
  useEffect(() => {
    // Wait for the server-resolved window (feed.start/end) before fetching, so the tile never flashes a
    // count for the wrong (server-default) window on cold load.
    if (sampleMode) return;
    if (!teamId || !feed?.start || !feed?.end) { setAiStats(null); return; }
    let on = true;
    fetchActionItemStats(teamId, { start: feed.start, end: feed.end, service: svc, spyneToken, spyneEnv }).then((r) => { if (on) setAiStats(r); });
    return () => { on = false; };
  }, [teamId, feed?.start, feed?.end, svc, spyneToken, spyneEnv]);

  // Open action items → the "Work these now" queue (overdue / soonest-due first). Separate from the
  // scoreboard counts above; a small named list the team can action directly.
  const [openItems, setOpenItems] = useState<ActionItem[]>([]);
  useEffect(() => {
    if (sampleMode || !teamId) { if (!sampleMode) setOpenItems([]); return; }
    let on = true;
    fetchActionItems(teamId, { scope: "open", service: svc, limit: 40, spyneToken }).then((r) => { if (on) setOpenItems(r); });
    return () => { on = false; };
  }, [teamId, svc, spyneToken]);
  // Items with a due date, soonest first (so overdue surfaces at the top); undated ones drop off the queue.
  const workItems = useMemo(
    () => openItems.filter((i) => i.dueAt).sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime()),
    [openItems],
  );
  // CREATED items in the window (incl. completed) — backs the new Overview action-items table so its
  // "Created (N)" tab actually shows rows (the open-only list above is empty when a rooftop has drained
  // its open items to zero, which made "Created" read a count with no rows). Its Open/Overdue/Due-Today
  // tabs filter this list client-side via the `completed` flag.
  const [createdItems, setCreatedItems] = useState<ActionItem[]>([]);
  useEffect(() => {
    if (sampleMode || !teamId || !feed?.start || !feed?.end) return;
    let on = true;
    fetchActionItems(teamId, { scope: "created", start: feed.start, end: feed.end, service: svc, limit: 50, spyneToken })
      .then((r) => { if (on) setCreatedItems(r); })
      .catch(() => {});
    return () => { on = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, feed?.start, feed?.end, svc, spyneToken]);
  // recent-created first for the table preview
  const createdWork = useMemo(
    () => [...createdItems].sort((a, b) => new Date(b.at || b.dueAt || 0).getTime() - new Date(a.at || a.dueAt || 0).getTime()),
    [createdItems],
  );

  /* The Recent-conversations fetch went with the section it fed. Every page load was paying a
     12-row conversation query for a card that could only ever print "Unresolved". The per-LEAD
     fetch used by the Hot & warm leads drawer is a different call and stays. */

  // SAMPLE mode: feed the built-in service demo data and skip every network fetch above (all guarded on
  // sampleMode). Placed after every useState so the setters are in scope.
  useEffect(() => {
    if (!sampleMode) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFeed(SAMPLE_SERVICE_FEED); setAiStats(SAMPLE_AISTATS); setOpenItems(SAMPLE_WORKITEMS); setCreatedItems(SAMPLE_WORKITEMS);
  }, [sampleMode]);

  // Scope to the agents this rooftop runs, then to the selected department, then aggregate.
  const allAgents = useMemo(() => agentsForAccount(feed?.agents ?? [], account), [feed, account]);
  const agents = useMemo(() => (dept === "all" ? allAgents : allAgents.filter((a) => a.dept.toLowerCase() === dept)), [allAgents, dept]);
  /* `afterHours` is overridden with the ROOFTOP lead count when the canonical API served one.
   * aggregateFleet sums each agent's after-hours CALLS, which answers "when is the phone ringing";
   * the "Captured after-hours" tile asks "how many CUSTOMERS did we catch while the floor was shut"
   * — a different question, and a lead-grain answer that is distinct rather than a sum of agents.
   *
   * GATE TIGHTENED (was `dept !== "service"`): the same rooftopRungsFor() scope check the three
   * distinct rungs now use. The old gate let a dept="all" view take the figure, but the canonical
   * overview is fetched SALES-ONLY (route.ts) — so on a rooftop that also runs Service it put a
   * sales-only customer count on a tile covering both departments. Same question, same answer, one
   * rule. Called out rather than folded in: this changes what that tile shows on "All" for a
   * Service-running rooftop (back to the agent-summed after-hours CALLS, today's Service behaviour). */
  const fleet = useMemo(() => {
    const rungs = rooftopRungsFor(feed, dept, agents);
    const f = aggregateFleet(agents, feed?.prior, unattributedApptsFor(feed, dept), assistedApptsFor(feed, dept), rungs);
    const rooftopAfterHours = feed?.capturedAfterHours;
    return rungs && typeof rooftopAfterHours === "number"
      ? { ...f, afterHours: rooftopAfterHours }
      : f;
  }, [agents, feed, dept]);
  /* "Qualified, not yet booked" — the canonical count, in scope only. Feeds the hero tile and the ROI
   * PDF, both of which print that exact phrase. undefined when the gate is closed or the API did not
   * serve it; both consumers have their own documented behaviour for that case. */
  const qualifiedNotBooked = useMemo(() => rooftopRungsFor(feed, dept, agents)?.hotLeads, [feed, dept, agents]);

  const hasTeam = teamId !== "" || sampleMode;

  // RETCONVAI-5066: OLD Service Overview reads service-metrics instead of the ClickHouse-backed `fleet`
  // above, so the numbers match the NEW page exactly. Flag off (default) or Sales → untouched, `fleet`
  // stays the only source. A tile/card with no trustworthy service-metrics twin reads null and hides —
  // see serviceMetrics.ts and the method note in OLD-VIEW-BRIEF.md.
  const serviceMetricsFlagOn = process.env.NEXT_PUBLIC_SERVICE_METRICS_OLD_VIEW === "on";
  const serviceMetricsOn = serviceMetricsFlagOn && dept === "service" && hasTeam && !sampleMode;
  const svcMetrics = useServiceOverviewOverlay({
    enabled: serviceMetricsOn,
    enterpriseId,
    teamId,
    spyneToken,
    spyneEnv,
    bucket,
    custom,
    rangeStart: feed?.start,
    rangeEndExclusive: feed?.end,
    timezone: feed?.timezone ?? undefined,
  });
  // Carries team scope + the selected window into the tab links and the per-agent drill-down, so the
  // chosen date range survives navigation to the By-agent view.
  /* Staged rollout switch (header toggle) — decides which Overview layout this render produces.
     FORCED TO "old" ON A SERVICE REPORT. The switcher is hidden there (see ReportTopBar), but the value
     rides the URL and reportNavQuery carries it across tabs, so a reader who flips to New on Sales and
     then lands on Service would otherwise arrive with ?view=new still set and get a layout that was never
     designed or checked for Service. Pinning it here makes Service immune to the param however it arrives,
     rather than relying on the control being out of sight. */
  const { variant: urlVariant } = useVariant();
  const variant = dept === "service" ? "old" : urlVariant;
  const navQuery = reportNavQuery(teamId, bucket, custom, dept, locked, variant);
  const periodLabel = custom ? (custom.start === custom.end ? custom.start : `${custom.start} – ${custom.end}`) : BUCKET_LABELS[bucket];
  // Appointment drill-down — clicking the headline count opens a modal listing the rooftop's appointments
  // for the shown window, served from the report's OWN internal data (report_appointments), never Spyne.
  const [apptModalOpen, setApptModalOpen] = useState(false);
  const openApptModal = () => { setApptModalOpen(true); track("appointments_drilldown_opened", { tab: "overview", team_id: teamId }); };
  const [warmModalOpen, setWarmModalOpen] = useState(false);
  // "Coming soon" is gated on whether the rooftop has EVER produced data (lifetime) — NOT on the
  // selected window. A live account whose window happens to be empty (e.g. "Today" before the day's
  // first call syncs) renders the real report with zeros + an inline note, not the on-its-way gate.
  // Falls back to hasData when everLive is absent (mock/error response) → prior window-scoped behavior.
  // A degraded fetch (transient outage / cold-start timeout) is NOT "never live" — keep the UI in the
  // syncing state and let the re-arm effect below retry, rather than flip to the "coming soon" gate.
  const degraded = feed?.degraded === true;
  // A DENIED read (401/403) is a session problem, not a rooftop without data — and it looks identical to
  // "never live" (no agents, no everLive, not degraded). Excluded from every gate below so it can't be
  // reported as coming-soon, retried forever as a stale-empty blip, or rendered as a report of zeros.
  const unauthorized = feed?.unauthorized === true;
  // "Ever live" sticky: once a rooftop has returned real data in THIS browser, it can never legitimately
  // become "never live" again. A later clean-but-empty read is therefore a transient blip, not a genuine
  // coming-soon — so we suppress the gate and self-heal (below) instead of making the dealer reload.
  const feedIsLive = feed !== null && (feed.everLive === true || feed.hasData === true || feed.agents.length > 0);
  const [wasLive, setWasLive] = useState(false);
  useEffect(() => {
    let seen = false;
    if (teamId) { try { seen = localStorage.getItem(`vini_live_${teamId}`) === "1"; } catch { /* storage blocked */ } }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWasLive(seen);
  }, [teamId]);
  useEffect(() => {
    if (!teamId || !feedIsLive) return;
    try { localStorage.setItem(`vini_live_${teamId}`, "1"); } catch { /* storage blocked */ }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWasLive(true);
  }, [teamId, feedIsLive]);
  // A clean-but-empty read for a rooftop we KNOW was live → treat it like a transient blip, not the gate.
  const staleEmpty = hasTeam && wasLive && feed !== null && !degraded && !unauthorized && !feedIsLive;
  const comingSoon = hasTeam && feed !== null && !degraded && !unauthorized && !(feed.everLive ?? feed.hasData) && !staleEmpty;
  // Self-heal a stale-empty read: quietly re-fetch (bounded, ~5 tries) until real data lands, so the
  // report fills in on its own instead of stranding a known-live rooftop on the syncing state. Depends on
  // `feed` so each re-fetch re-arms; the counter caps it so it can never poll forever.
  const staleHealsRef = useRef(0);
  useEffect(() => {
    if (!staleEmpty) { staleHealsRef.current = 0; return; }
    if (staleHealsRef.current >= 5) return;
    let on = true;
    const t = setTimeout(() => {
      staleHealsRef.current += 1;
      fetchAgents({ teamId, ...rangeOpts, force: true }).then((res) => { if (on) setFeed(res); }).catch(() => {});
    }, 1500);
    return () => { on = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, bucket, custom, staleEmpty, feed]);
  // Preview-only override for reviewing the "just went live" training design AND the exact-replica Live
  // design side by side, without waiting for a real comingSoon rooftop — e.g. ?state=training or
  // ?state=live, plus (training only) forcing one direction's status via ?ib=/?ob= (not_sold |
  // start_onboarding | continue_onboarding | training) since there's no real per-direction onboarding-
  // status field yet. Never engages unless explicitly passed on the URL OR the rooftop really has no
  // data yet (the real comingSoon gate, which still defaults to the training treatment).
  const previewState = previewParams.get("state");
  const previewActive = previewState === "onboarding" || previewState === "training" || previewState === "live";
  const showReport = scenario !== "first_time" && scenario !== "onboarding";
  // A genuinely-live rooftop: has a team, its data has loaded, it's past onboarding. This is the real
  // production audience — they now get the new stepper/Live experience by default. ?classic=1 is the
  // safe rollback: it forces the legacy overview for this session without a redeploy.
  const classic = previewParams.get("classic") != null;
  const liveTeam = showReport && hasTeam && feed !== null && !degraded && !unauthorized && !comingSoon && !staleEmpty;
  // The new experience (Onboarding → Training → Live) drives previews (comingSoon / ?state= / ?sample=)
  // AND real live rooftops. ?classic=1 opts a real live team back to the old MetricTile overview — it
  // never disables an explicit preview/sample, only the live-team auto-enable.
  const showPreview = comingSoon || previewActive || sampleMode || (liveTeam && !classic);
  // The dealer journey as one flow: Onboarding → Training → Live. ?state= picks the entry stage; the
  // stepper + in-view CTAs move between them (manualStage wins once the user navigates). comingSoon
  // (a genuine just-went-live rooftop with no data) enters at Training; ?sample= defaults to Live.
  const [manualStage, setManualStage] = useState<Stage | null>(null);
  // Entry stage: Live is the only surfaced experience — every real rooftop (live or just-went-live)
  // lands on Live. Onboarding/Training remain reachable ONLY via an explicit ?state= for internal
  // design review; there's no in-UI navigation to them anymore.
  const stage: Stage = manualStage ?? (
    previewState === "onboarding" ? "onboarding"
    : previewState === "training" ? "training"
    : "live"
  );
  // Onboarding & Training aren't reports — strip the report chrome (tabs, Sales/Service scope, date
  // filter, and the "what your AI delivered" subtitle). Only Live is a report.
  const setupChrome = showPreview && stage !== "live";
  const directionOverrides = useMemo(() => {
    const valid = new Set<DirectionStatus>(["not_sold", "start_onboarding", "continue_onboarding", "training"]);
    const parse = (v: string | null): DirectionStatus | undefined => (v && valid.has(v as DirectionStatus) ? (v as DirectionStatus) : undefined);
    return { Inbound: parse(previewParams.get("ib")), Outbound: parse(previewParams.get("ob")) } as Partial<Record<Direction, DirectionStatus>>;
  }, [previewParams]);
  // Training has two states as the first activity lands: Day 0 (nothing yet) and Day 3 ("starting to fill
  // in" — early real numbers + progressing). ?day=3 forces the filling-in state for review; ?day=0 (or
  // absent) shows the empty state. Real early numbers come from the fleet (small on a genuine day-3 rooftop).
  const trainingEarly = previewParams.get("day") === "3"
    ? { coveragePct: fleet.answerRateInbound, responseSec: fleet.responseTimeSec, followups: aiStats?.stats.created ?? null }
    : null;
  // Legacy overview path: a real live rooftop that has explicitly opted out via ?classic=1.
  const liveReady = liveTeam && classic;

  // Live rooftop, but the selected window has no activity yet → gentle inline note above the report.
  const emptyWindow = liveReady && feed !== null && !feed.hasData;

  const ranked = useMemo(() => [...agents].sort((a, b) => b.metrics.appointments - a.metrics.appointments), [agents]);
  // Named lists, scoped to the selected department (both carry serviceType).
  const warmLeads = useMemo(() => (feed?.warmLeads ?? []).filter((w) => dept === "all" || w.serviceType === dept), [feed, dept]);
  const namedAppts = useMemo(() => (feed?.namedAppointments ?? []).filter((a) => dept === "all" || a.serviceType === dept), [feed, dept]);
  const split = fleet.bySplit;
  // slot ("sales|inbound" → the AI's real name) so the recent-conversations table shows the SAME agent
  // name as the rest of the report (onboarded/persona), not the unreliable raw per-call agentName.
  const agentNames = useMemo(
    () => Object.fromEntries(allAgents.map((a) => [`${a.dept.toLowerCase()}|${a.dir.toLowerCase()}`, a.report.summary.person || a.name])),
    [allAgents],
  );

  // Agent drill-down — clicking an agent card takes the user to the parent console's Reporting tab
  // (top-level nav), NEVER renders the By-agent view inside the Overview. Whenever this app runs inside
  // the console iframe (embedded), OR the route is wired as the parent Overview, break OUT to the parent
  // Reports page. Only a truly standalone app (direct/localhost, no parent frame) navigates the in-app
  // route so the By-agent view stays reachable in dev.
  const openAgent = (agentId: string) => {
    track("agent_opened", { team_id: teamId, agent: agentId });
    const internalPath = `/reports/agents${navQuery}${navQuery ? "&" : "?"}agent=${agentId}`;
    const embedded = typeof window !== "undefined" && window.top !== window.self;
    if (embedded || agentLinkMode === "parent") {
      goCrossPage("reports", { enterpriseId, teamId, serviceType: dept !== "all" ? dept : undefined, agent: agentId }, internalPath);
    } else {
      router.push(internalPath);
    }
  };

  // Customizable layout — the customer can hide/reorder these sections (persisted per rooftop). The
  // manifest drives the Customize modal: sections (reorderable + hideable) + the individual tiles/cards.
  // `ctrl` drives the legacy (?classic=1) layout; `liveCtrl` drives the new Live overview. Separate
  // localStorage keys so the two layouts never clobber each other.
  /* Conversation-outcome evals (Spyne eval pipeline) — SALES only, so a Service-scoped report never asks
   * for them and the section drops out of the Live layout. Both directions in one hook; each renders only
   * if it actually has scored conversations. Independent of the main feed: a slow/absent eval API leaves
   * the rest of the Overview untouched. */
  const outcomesFeed = useOutcomes({
    teamId,
    enterpriseId,
    dirs: ["inbound", "outbound"],
    bucket: custom ? undefined : bucket,
    start: custom?.start,
    end: custom ? addDay(custom.end) : undefined,
    spyneToken,
    spyneEnv,
    enabled: !sampleMode && dept !== "service" && hasTeam,
  });
  // Only claim the layout slot once there's something to show (or while the first fetch is in flight) —
  // otherwise a rooftop with no scored conversations would leave an empty animated row in the Live stack.
  const outcomesReady = outcomesFeed.loading || Object.values(outcomesFeed.data).some((o) => (o?.scored ?? 0) > 0);

  const ctrl = useCustomize("overview", { teamId, enterpriseId, spyneToken }, OVERVIEW_SECTION_IDS);
  const liveCtrl = useCustomize("overview-live", { teamId, enterpriseId, spyneToken }, LIVE_SECTION_IDS);
  const liveGroups: CustomizeGroup[] = LIVE_SECTIONS.map((s) => ({ id: s.id, label: s.label }));
  const customizeGroups: CustomizeGroup[] = [
    { id: "value", label: "The value delivered", items: [
      { id: "tile.leads", label: "Leads touched" },
      { id: "tile.conversations", label: "Real conversations" },
      { id: "tile.qualified", label: "Qualified leads" },
      { id: "tile.appts", label: "Appointments — AI-booked" },
      { id: "tile.handoffs", label: "Hand-offs to team" },
      { id: "tile.response", label: "Response time" },
      { id: "tile.actions", label: "Customers with follow-ups" },
      { id: "tile.callstexts", label: "Calls & texts" },
      { id: "tile.talk", label: "Talk time" },
      { id: "tile.afterhours", label: "After-hours captured" },
    ] },
    { id: "agents", label: "Who drove it" },
    { id: "work", label: "Work these now", items: [
      { id: "card.warm", label: "Hot & warm leads" },
      { id: "card.appts", label: "Appointments" },
      { id: "card.actions", label: "Action items" },
    ] },
    { id: "conversations", label: "Recent conversations" },
  ];
  const sections: SectionDef[] = [
    {
      id: "value",
      label: "The value delivered",
      node: (
        <div className="flex flex-col gap-3.5">
          <SectionLabel hint={periodLabel}>The value delivered</SectionLabel>
          {/* MAIN — the outcome story, IB/OB split + period deltas */}
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
            {/* Leads touched — NO TWIN. ov-prod reads leadsReached per-agent/per-direction only; it never
                sums inbound+outbound into one rooftop total, which is what this tile needs. See
                serviceMetrics.ts's NO_TWIN_ON_OLD_OVERVIEW (single source for this decision — not
                re-decided here). Hidden on Service once the flag is on. */}
            {!serviceMetricsOn && (
              <Hideable id="tile.leads" ctrl={ctrl}><ValueTile label="Leads touched" total={fmtInt(fleet.leads)} inbound={fmtInt(split.inbound.leads)} outbound={fmtInt(split.outbound.leads)} overlap={overlapRow(fleet.leads, split.inbound.leads, split.outbound.leads)} delta={fleet.deltas.leads} accent="blue" subtext={<>reached or dialed by the AI</>} /></Hideable>
            )}
            {/* Real conversations — NO TWIN. ov-prod's Service Overview never reads realConversations at
                all (see NO_TWIN_ON_OLD_OVERVIEW). Hidden on Service once the flag is on. */}
            {!serviceMetricsOn && (
              <Hideable id="tile.conversations" ctrl={ctrl}><ValueTile label="Real conversations" total={fmtInt(fleet.conversations)} inbound={fmtInt(split.inbound.conversations)} outbound={fmtInt(split.outbound.conversations)} overlap={overlapRow(fleet.conversations, split.inbound.conversations, split.outbound.conversations)} delta={fleet.deltas.conversations} accent="purple" subtext={<>customer spoke or replied — voicemail excluded</>} /></Hideable>
            )}
            {/* Qualified leads — no service-metrics twin (Classification stays available:false pending
                RETCONVAI-5010). Hidden rather than shown from the old ClickHouse source once the flag is on,
                so this page never shows a number the new page can't back. */}
            {!serviceMetricsOn && (
              <Hideable id="tile.qualified" ctrl={ctrl}><ValueTile label="Qualified leads" total={fmtInt(fleet.qualified)} inbound={fmtInt(split.inbound.qualified)} outbound={fmtInt(split.outbound.qualified)} overlap={overlapRow(fleet.qualified, split.inbound.qualified, split.outbound.qualified)} delta={fleet.deltas.qualified} accent="violet" subtext={<>concrete buying intent</>} /></Hideable>
            )}
            <Hideable id="tile.appts" ctrl={ctrl}>
              {serviceMetricsOn ? (
                svcMetrics.appointments && <ValueTile label="Appointments — AI-booked" total={fmtInt(svcMetrics.appointments.total)} inbound={svcMetrics.appointments.inbound != null ? fmtInt(svcMetrics.appointments.inbound) : undefined} outbound={svcMetrics.appointments.outbound != null ? fmtInt(svcMetrics.appointments.outbound) : undefined} accent="green" subtext={svcMetrics.appointments.assisted != null && svcMetrics.appointments.assisted > 0 ? <>+{fmtInt(svcMetrics.appointments.assisted)} AI-assisted (CRM)</> : <>meeting created by the AI</>} onClick={svcMetrics.appointments.total > 0 ? openApptModal : undefined} />
              ) : (
                <ValueTile label="Appointments — AI-booked" total={fmtInt(fleet.appointments)} inbound={fmtInt(split.inbound.appointments)} outbound={fmtInt(split.outbound.appointments)} unassigned={fleet.appointmentsNoAgent > 0 ? fmtInt(fleet.appointmentsNoAgent) : undefined} delta={fleet.deltas.appointments} accent="green" subtext={fleet.appointmentsAssisted > 0 ? <>+{fmtInt(fleet.appointmentsAssisted)} AI-assisted (CRM)</> : <>meeting created by the AI</>} onClick={fleet.appointments > 0 ? openApptModal : undefined} />
              )}
            </Hideable>
          </div>
          {/* SECONDARY — operational quality, one compact row */}
          <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
            {/* Hand-offs to team — no service-metrics twin (no transfer/callback field on any of the four
                endpoints this page reads). Hidden when the flag is on. */}
            {!serviceMetricsOn && (
              <Hideable id="tile.handoffs" ctrl={ctrl}><MetricTile label="Hand-offs to team" value={fmtInt(fleet.handoffs)} accent="#2563eb" sub={<>{fmtInt(fleet.transfers)} transfers · {fmtInt(fleet.callbacks)} callbacks</>} title="Completed transfers + requested callbacks. Failed transfers are reported separately." /></Hideable>
            )}
            {/* Response time is a Sales construct (speed-to-lead, Sales Inbound STL) — never shown on
                Service, flag or no flag. */}
            {!serviceMetricsOn && fleet.responseTimeSec != null && (
              <Hideable id="tile.response" ctrl={ctrl}><MetricTile label="Response time" value={fmtSecs(fleet.responseTimeSec)} accent="#0ea5e9" sub={<>avg first response · speed-to-lead</>} title="Average time from a new lead arriving to the AI's first touch (speed-to-lead, Sales Inbound)." /></Hideable>
            )}
            {/* Customers with follow-ups — the headline number (created-in-window) has no service-metrics
                twin; action-item only carries openNow/cleared, not created. Hidden rather than show a
                different number under the same label. */}
            {!serviceMetricsOn && (
              <Hideable id="tile.actions" ctrl={ctrl}><MetricTile label="Customers with follow-ups" value={aiStats ? fmtInt(aiStats.stats.created) : "—"} accent="#ea760c" sub={aiStats ? <>{fmtInt(aiStats.stats.completed)} cleared · {fmtInt(aiStats.stats.open)} still waiting</> : <>syncing…</>} onClick={() => goCrossPage("actions", { enterpriseId, teamId, serviceType: dept !== "all" ? dept : undefined }, `/reports/action-items${navQuery}`)} title="Customers the AI logged a follow-up for this period — someone with several counts once. Click for the full list." /></Hideable>
            )}
            {/* Calls & texts — NO TWIN. ov-prod reads `calls` only as a per-outbound-agent dial count
                ("contacted"); it never renders a rooftop calls+sms total, and smsSent isn't read at all.
                Web chat is folded in as a third channel on rooftops that run it — irrelevant here, this
                whole tile is hidden on Service once the flag is on (NO_TWIN_ON_OLD_OVERVIEW). */}
            {!serviceMetricsOn && (
              <Hideable id="tile.callstexts" ctrl={ctrl}><MetricTile label={(fleet.chats ?? 0) > 0 ? "Calls, texts & chats" : "Calls & texts"} value={fmtInt(fleet.calls + fleet.smsThreads + (fleet.chats ?? 0))} accent="#14b8a6" sub={<>{fmtInt(fleet.calls)} calls · {fmtInt(fleet.smsThreads)} texts{(fleet.chats ?? 0) > 0 ? <> · {fmtInt(fleet.chats)} web chats</> : null}</>} title="AI conversations handled across voice, SMS and web chat — voice calls + SMS threads + chat sessions (conversations, not individual messages)." /></Hideable>
            )}
            {/* Talk time — NO TWIN. ov-prod's Service Overview never reads talkTimeMinutes. Hidden on
                Service once the flag is on. */}
            {!serviceMetricsOn && (
              <Hideable id="tile.talk" ctrl={ctrl}><MetricTile label="Talk time" value={fmtDuration(fleet.talkMinutes)} accent="#6b7280" sub={<>zero staff minutes spent</>} /></Hideable>
            )}
            {/* After-hours captured — NO TWIN. ov-prod's Service Overview never reads afterHoursLeads.
                Hidden on Service once the flag is on. */}
            {!serviceMetricsOn && (
              <Hideable id="tile.afterhours" ctrl={ctrl}><MetricTile label="After-hours captured" value={fmtInt(fleet.afterHours)} accent="#10b981" sub={<>engaged outside working hours</>} /></Hideable>
            )}
          </div>
        </div>
      ),
    },
    {
      id: "agents",
      label: "Who drove it",
      node: (
        <div className="flex flex-col gap-3.5">
          <div className="flex items-center justify-between gap-3">
            <SectionLabel hint="Click an agent for the full report">Who drove it</SectionLabel>
            {hasTeam && (
              <span className="no-print flex-none text-[11px] text-[#9ca3af]" title={feed?.timezone ? `Report days & times use this rooftop's timezone (${feed.timezone})` : undefined}>
                {feed?.timezone ? `Times in ${tzShortLabel(feed.timezone)}` : ""}
                {feed?.timezone && (feed === null || feed?.fetchedAt) ? " · " : ""}
                {feed === null
                  ? "Syncing…"
                  /* The AGGREGATE's own age, not this page's. fetchedAt is always "just now" and said so
                     over data the ETL had not rebuilt for hours — see syncedAt in liveData. */
                  : feed?.syncedAt
                    ? `Synced ${relTime(Date.parse(feed.syncedAt), now)}`
                    : feed?.fetchedAt ? `Synced ${relTime(feed.fetchedAt, now)}` : ""}
              </span>
            )}
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {ranked.map((a) => {
              const lf = a.leadFunnel;
              const qualifiedLeads = lf?.qualified ?? a.metrics.qualified;
              return (
                <AgentFunnelCard
                  key={a.id}
                  icon={a.icon}
                  name={a.report.summary.person || a.name}
                  role={`${a.dept} · ${a.dir}`}
                  closeRateLabel={fmtRate(a.metrics.appointments, qualifiedLeads)}
                  closeRateSub={`${fmtInt(a.metrics.appointments)} of ${fmtInt(qualifiedLeads)} qualified`}
                  stages={[
                    leadEntryStage(a.dir, lf, a.report.leadsAttempted),
                    { label: "Real conversations", value: lf?.connected ?? a.metrics.conversations },
                    { label: "Qualified leads", value: qualifiedLeads },
                    { label: "Appointments — AI-booked", value: a.metrics.appointments },
                  ]}
                  assisted={a.metrics.appointmentsAssisted}
                  ministats={{ calls: a.metrics.calls, sms: a.metrics.smsSent, talkMinutes: a.metrics.talkMinutes, handoffs: (a.report.callFlow?.transferred ?? 0) + (a.report.callFlow?.callbacks ?? 0) }}
                  onClick={() => openAgent(a.id)}
                />
              );
            })}
          </div>
        </div>
      ),
    },
    {
      id: "work",
      label: "Work these now",
      node: (() => {
        // Behind the flag on Service: the named lists this section draws on (warmLeads, namedAppts,
        // aiStats) are the OLD ClickHouse source. Swap to the service-metrics twins so the "View all"
        // links match the same numbers the tiles above now show. Hot & warm leads has no twin (a Sales
        // construct, per the brief) and stays hidden.
        const svcAppts = serviceMetricsOn ? (svcMetrics.namedAppointments ?? []) : null;
        const svcActions = serviceMetricsOn ? svcMetrics.actionItems : null;
        const showWarmCard = !serviceMetricsOn && warmLeads.length > 0;
        const showApptsCard = serviceMetricsOn ? !!(svcAppts && svcAppts.length > 0) : namedAppts.length > 0;
        const showActionsCard = serviceMetricsOn ? !!svcActions && svcActions.openNow > 0 : !!(aiStats && (aiStats.stats.created > 0 || aiStats.stats.open > 0));
        if (!showWarmCard && !showApptsCard && !showActionsCard) return false;
        return (
        <div className="flex flex-col gap-3.5">
          <SectionLabel hint="reviewed, in-market, unworked — the fastest net-new appointments">Work these now</SectionLabel>
          <div className="grid gap-6" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
            {showWarmCard && (
              <Hideable id="card.warm" ctrl={ctrl}>
                <Card title="Hot & warm leads" sub="Buying intent on record, no appointment yet — call these first" right={<button onClick={() => setWarmModalOpen(true)} className="no-print rounded-lg border border-[#e5e7eb] bg-white px-3 py-1.5 text-[11.5px] font-semibold text-[#813fed] hover:bg-[#faf8ff]">View all →</button>}>
                  <WarmLeadChips items={warmLeads} teamId={teamId} maxHot={6} maxWarm={5} />
                </Card>
              </Hideable>
            )}
            {showApptsCard && (
              <Hideable id="card.appts" ctrl={ctrl}>
              <Card title="Appointments" sub={serviceMetricsOn ? "Upcoming — on the books" : "On the books — AI-booked & AI-assisted"} right={<button onClick={() => goCrossPage("appointments", { enterpriseId, teamId }, `/reports/appointments${navQuery}`)} className="no-print rounded-lg border border-[#e5e7eb] bg-white px-3 py-1.5 text-[11.5px] font-semibold text-[#813fed] hover:bg-[#faf8ff]">View all →</button>}>
                <div className="flex flex-col gap-2">
                  {serviceMetricsOn
                    ? (svcAppts ?? []).slice(0, 6).map((a, i) => (
                        <div key={`${a.customer}-${i}`} className="flex items-center justify-between gap-3 border-b border-[#f5f5f5] pb-2 last:border-0 last:pb-0">
                          <div className="min-w-0">
                            <p className="truncate text-[12.5px] font-semibold text-[#111]">{a.customer}{a.vehicle ? <span className="ml-2 text-[10.5px] font-normal text-[#9ca3af]">{a.vehicle}</span> : null}</p>
                          </div>
                          <p className="flex-none text-[11px] tabular-nums text-[#6b7280]">{a.when ? fmtWhenShort(a.when, feed?.timezone) : ""}</p>
                        </div>
                      ))
                    : namedAppts.slice(0, 6).map((a, i) => (
                        <div key={`${a.customer}-${i}`} className="flex items-center justify-between gap-3 border-b border-[#f5f5f5] pb-2 last:border-0 last:pb-0">
                          <div className="min-w-0">
                            <p className="truncate text-[12.5px] font-semibold text-[#111]">{a.customer}{a.vehicle ? <span className="ml-2 text-[10.5px] font-normal text-[#9ca3af]">{a.vehicle}</span> : null}</p>
                            <p className="truncate text-[10.5px] font-medium" style={{ color: a.assisted ? "#6d28d9" : "#059669" }}>{a.how}</p>
                          </div>
                          <p className="flex-none text-[11px] tabular-nums text-[#6b7280]">{fmtWhenShort(a.when, feed?.timezone)}</p>
                        </div>
                      ))}
                  {!serviceMetricsOn && namedAppts.length > 6 && <p className="text-[11px] font-semibold text-[#9ca3af]">+{namedAppts.length - 6} more on the Appointments tab</p>}
                </div>
              </Card>
              </Hideable>
            )}
          </div>
          {showActionsCard && (
            <Hideable id="card.actions" ctrl={ctrl}>
            <Card title="Action items" sub={serviceMetricsOn ? "Waiting on your team — live count" : "Created & closed this window · open, overdue and due-today are live counts"} right={<button onClick={() => { track("action_items_opened", { tab: "overview", team_id: teamId }); goCrossPage("actions", { enterpriseId, teamId, serviceType: dept !== "all" ? dept : undefined }, `/reports/action-items${navQuery}`); }} className="no-print rounded-lg border border-[#e5e7eb] bg-white px-3 py-1.5 text-[11.5px] font-semibold text-[#813fed] hover:bg-[#faf8ff]">View all →</button>}>
              {serviceMetricsOn ? (
                <>
                  {/* openNow only — ov-prod's Overview ("Waiting on your team") never shows `cleared`, only
                      this live count + the waiting-tasks list (see serviceMetrics.ts). */}
                  <div className="flex gap-6">
                    <div><p className="text-[9.5px] font-bold uppercase tracking-wider text-[#9ca3af]">Open now</p><p className="mt-0.5 text-[20px] font-extrabold tabular-nums text-[#111]">{fmtInt(svcActions!.openNow)}</p></div>
                  </div>
                  {svcActions!.items.length > 0 && (
                    <div className="mt-4 border-t border-[#f3f4f6] pt-3">
                      <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-[#9ca3af]">Overdue / due soon — work these next</p>
                      <div className="flex flex-col gap-2">
                        {svcActions!.items.slice(0, 6).map((it, i) => (
                          <div key={`${it.customer}-${i}`} className="flex items-center justify-between gap-3 border-b border-[#f5f5f5] pb-2 last:border-0 last:pb-0">
                            <div className="min-w-0">
                              <p className="truncate text-[12.5px] font-semibold text-[#111]">{it.customer}</p>
                              <p className="truncate text-[10.5px] text-[#6b7280]">{it.what}</p>
                            </div>
                            <p className={`flex-none text-[11px] tabular-nums ${it.isLate ? "text-[#dc2626]" : "text-[#6b7280]"}`}>{it.due ? fmtWhenShort(it.due, feed?.timezone) : ""}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <ActionItemsScoreboard stats={aiStats!.stats} periodLabel={periodLabel} />
                  {workItems.length > 0 && (
                    <div className="mt-4 border-t border-[#f3f4f6] pt-3">
                      <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-[#9ca3af]">Overdue / due soon — work these next</p>
                      <ActionItemList items={workItems} max={6} onMore={() => { track("action_items_opened", { tab: "overview", team_id: teamId }); goCrossPage("actions", { enterpriseId, teamId, serviceType: dept !== "all" ? dept : undefined }, `/reports/action-items${navQuery}`); }} />
                    </div>
                  )}
                </>
              )}
            </Card>
            </Hideable>
          )}
        </div>
        );
      })(),
    },
    /* "Recent Conversations" REMOVED (Ishan, 2026-09-28). The card could only ever print
       "Unresolved": the SMS branch hardcoded queryResolved:false, so every text row fell through to
       that label and the dealer was told 100% of conversations needed attention. The data behind it
       is not there either — 1,950 SMS conversations on the sample day, 23 with an outcome, 0 with
       queryResolved, 0 with a summary. Every tab count was the fetch limit rather than a total, and
       the "Intent" column rendered the agent's name on SMS rows. */
    /* Merge note (PR #28, service-metrics overlay): that branch added a `serviceMetricsOn ? false : …`
       guard to this same section, because the new service endpoints (contact / appointment /
       action-item / opportunity) have no transcript or conversation-list read to swap in. Moot here —
       the section and RecentConversationsCard are gone on this branch for the reason above, so there
       is nothing left to guard. */
  ];

  /* EXPORT PDF — the ROI report a CSM sends a dealer, built from exactly what this page is showing:
     same window, same department, same figures. The one thing the page does NOT already hold is the
     NAMED "qualified but not booked" list, so that is fetched on click rather than on every render —
     it is a PII read nobody needs until they ask for the document. */
  const [exporting, setExporting] = useState(false);
  const onExportPdf = async () => {
    if (exporting || !feed) return;
    setExporting(true);
    track("report_exported", { tab: "overview", team_id: teamId, format: "pdf", range: custom ? "custom" : bucket });
    try {
      const qs = new URLSearchParams({ team_id: teamId, serviceType: dept === "all" ? "both" : dept });
      // Send the window the way the page resolved it, so the export cannot drift from the tiles by a day.
      if (feed.start && feed.end) { qs.set("start", feed.start); qs.set("end", feed.end); }
      else if (custom) { qs.set("start", custom.start); qs.set("end", addDay(custom.end)); }
      else qs.set("bucket", bucket);
      if (spyneToken) qs.set("auth_key", spyneToken);
      if (spyneEnv) qs.set("env", spyneEnv);

      /* "QUALIFIED, NOT YET BOOKED" — AND NOTHING ELSE UNDER THAT LABEL.
         This used to be seeded from `fleet.qualified`, which is ALL qualified leads: on any failed
         fetch the PDF printed every lead who had ALREADY BOOKED as still-unbooked pipeline, beside the
         bookings themselves in the next stat column, with an empty named list at the back — a document
         that contradicts itself in a CSM's hand. That is a DIFFERENT metric, not a stale one, so there
         is no fallback to it. Order: the endpoint's own total, then the canonical count already on the
         feed (same definition, scope-checked), then null — and roiPdf drops the stat and both
         sentences rather than print a number under a label it does not mean. A missing number in a
         dealer-facing document is recoverable; a confident wrong one is not. */
      let qualified: QualifiedLead[] = [];
      let qualifiedTotal: number | null = qualifiedNotBooked ?? null;
      try {
        const r = await fetch(`/api/reports/qualified-leads?${qs}`);
        if (r.ok) {
          const j = await r.json();
          qualified = Array.isArray(j.leads) ? j.leads : [];
          if (typeof j.total === "number") qualifiedTotal = j.total;
        }
      } catch { /* the document is still worth having without the third list — see below */ }

      await exportRoiPdf({
        accountName: account.name, periodLabel, dept, fleet,
        namedAppts, qualified, qualifiedTotal,
        tzLabel: feed.timezone ? tzShortLabel(feed.timezone) : undefined,
        // The IANA zone itself — tzLabel ("PDT") is prose, Intl needs the zone. Without this the PDF
        // printed a Pacific 8:30 PM appointment as "Oct 6 · 3:30 AM".
        tz: feed.timezone ?? null,
      });
    } finally {
      setExporting(false);
    }
  };

  // Date filter + Customize + refresh — the only report controls kept in the live flow. In the preview
  // Live stage these render INSIDE the hero (below "…what your sales AI handled"), so the top bar is
  // dropped entirely; on the production report they stay in the top bar.
  const liveControls = hasTeam ? (
    <div className="no-print flex min-w-0 flex-wrap items-center gap-2 sm:gap-3">
      <button
        onClick={onExportPdf}
        disabled={exporting || feed === null}
        title="Download this report as a PDF for the selected period"
        className="flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-[#813fed] px-3 text-[12px] font-bold text-white transition-colors hover:bg-[#6d28d9] disabled:opacity-50"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v12M7 11l5 5 5-5M5 21h14" />
        </svg>
        {exporting ? "Preparing…" : "Export PDF"}
      </button>
      {liveReady && <CustomizeToggle ctrl={ctrl} />}
      {showPreview && stage === "live" && <CustomizeToggle ctrl={liveCtrl} />}
      <DateFilter
        bucket={bucket}
        custom={custom}
        onPreset={(b) => { setPreset(b); track("date_range_changed", { tab: "overview", range: b, team_id: teamId }); }}
        onCustom={(r) => { setCustom(r); track("date_range_changed", { tab: "overview", range: "custom", team_id: teamId }); }}
      />
      <button
        onClick={refresh}
        disabled={feed === null}
        aria-label="Refresh data"
        title="Refresh"
        className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#e5e7eb] bg-white text-[#6b7280] transition-colors hover:bg-[#faf8ff] hover:text-[#813fed] disabled:opacity-50"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={feed === null ? "animate-spin" : ""}>
          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          <path d="M21 3v6h-6" />
        </svg>
      </button>
    </div>
  ) : null;
  // Live is a real report and shows the standard "Overview" top bar (title + date filter + Sales/Service
  // scope). Only the internal-review Onboarding/Training preview stages own their own header, so the top
  // bar is dropped just for those.
  const hideTopBar = showPreview && stage !== "live";

  return (
    <div className="flex min-h-screen bg-[#fafafa]">
      <div className="flex min-w-0 flex-1 flex-col">

        {!hideTopBar && (
        <ReportTopBar
          title="Overview"
          subtitle={
            setupChrome
              ? (stage === "onboarding" ? "Let's get your AI agents live." : "Your agents are live and calibrating — your full report fills in as the first data lands.")
              : "What your AI agents delivered — appointments, conversations and hand-offs, in one report."
          }
          active="overview"
          teamId={teamId}
          query={navQuery}
          hideTabs={showPreview}
          hideDept
          hideTitle={false}
          right={
            setupChrome ? null : hasTeam ? (
              liveControls
            ) : (
              <span className="rounded-lg bg-[#f3eaff] px-3 py-1.5 text-[12px] font-semibold text-[#813fed]">{view.liveLabel}</span>
            )
          }
        />
        )}

        <main className="mx-auto w-full max-w-[1320px] flex-1 px-4 sm:px-6 lg:px-10 pt-7 pb-36 flex flex-col gap-9">
          {scenario === "first_time" && <FirstTimeOverview />}
          {scenario === "onboarding" && <OnboardingOverview view={view} />}

          {showReport && !hasTeam && <NoRooftop />}
          {/* Denied read — above the skeleton/preview gates, since a denial resolves the feed but leaves it
              empty, and every gate below would read that as "nothing to show yet". */}
          {showReport && hasTeam && unauthorized && (
            <ReportAccessDenied tab="overview" teamId={teamId} name={account.name} status={feed?.authStatus} />
          )}
          {showReport && hasTeam && !unauthorized && (feed === null || degraded || staleEmpty) && <OverviewSkeleton />}
          {showReport && hasTeam && feed !== null && !degraded && !unauthorized && showPreview && (
            <div className="flex flex-col gap-4">
              {stage === "onboarding" ? (
                <OnboardingStub onGoLive={() => { setManualStage("training"); window.scrollTo({ top: 0, behavior: "smooth" }); }} />
              ) : stage === "training" ? (
                <TrainingOverview account={account} overrides={directionOverrides} earlyStats={trainingEarly} fleet={fleet} aiStats={aiStats?.stats ?? null} serviceMetricsOn={serviceMetricsOn} onGoLive={() => { setManualStage("live"); window.scrollTo({ top: 0, behavior: "smooth" }); }} onOnboard={() => { setManualStage("onboarding"); window.scrollTo({ top: 0, behavior: "smooth" }); }} />
              ) : (
                <LiveOverview
                  account={account}
                  fleet={fleet}
                  /* null feed = still fetching. The canonical endpoints are multi-second warehouse
                     queries, so the gap is visible; a shimmer is honest where a 0 is not. */
                  loading={feed === null}
                  agents={ranked}
                  serviceMode={dept === "service"}
                  variant={variant}
                  serviceMetricsOverlay={serviceMetricsOn ? svcMetrics : null}
                  qualifiedNotBooked={qualifiedNotBooked}
                  warmLeads={warmLeads}
                  namedAppts={namedAppts}
                  /* The rooftop's zone for every appointment time, day heading, day grouping and the
                     "upcoming" cutoff inside the cards. null (no Spyne token / tz lookup failed) → the
                     cards render in UTC exactly as they did before. */
                  tz={feed?.timezone ?? null}
                  aiStats={aiStats}
                  workItems={createdWork}
                  onOpenAgent={openAgent}
                  onViewAppointments={() => goCrossPage("appointments", { enterpriseId, teamId, serviceType: dept !== "all" ? dept : undefined }, `/reports/appointments${navQuery}`)}
                  onOpenWarmModal={() => setWarmModalOpen(true)}
                  onViewActionItems={() => goCrossPage("actions", { enterpriseId, teamId, serviceType: dept !== "all" ? dept : undefined }, `/reports/action-items${navQuery}`)}
                  onViewConversations={() => goCrossPage("conversations", { enterpriseId, teamId }, `/reports/calls${navQuery}`)}
                  onBackToTraining={() => { setManualStage("training"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                  outcomes={
                    dept === "service" || !outcomesReady ? null : (
                      <OutcomesSection
                        data={outcomesFeed.data}
                        loading={outcomesFeed.loading}
                        callsByDir={{ inbound: split.inbound.calls, outbound: split.outbound.calls }}
                      />
                    )
                  }
                  ctrl={liveCtrl}
                />
              )}
            </div>
          )}

          {liveReady && (
          <>
          {emptyWindow && (
            <div className="flex items-start gap-3 rounded-2xl border border-[#e0d8f5] bg-[#faf8ff] px-5 py-4">
              <span className="mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-full bg-[#f3eaff] text-[13px]">📭</span>
              <div>
                <p className="text-[13px] font-bold text-[#111]">No activity has synced for {custom ? "this date range" : `“${BUCKET_LABELS[bucket]}”`} yet</p>
                <p className="mt-0.5 text-[11.5px] leading-snug text-[#6b7280]">
                  {account.name}&apos;s agents are live — activity appears here as calls and messages come in (today can trail the console by a few minutes while results sync). Widen the date range to see recent activity.
                </p>
              </div>
            </div>
          )}

          {/* Customizable layout — hide / reorder sections (Customize control lives in the header). */}
          <CustomizeSections ctrl={ctrl} sections={sections} />

          <DefinitionsFooter tzLabel={feed?.timezone ? tzShortLabel(feed.timezone) : undefined} />
          </>
          )}
        </main>
      </div>
      {/* Internal-data modal — shows the report's own appointments (report_appointments), NOT the live
          Spyne API, so the modal always matches the numbers above. */}
      <Modal
        open={apptModalOpen}
        onClose={() => setApptModalOpen(false)}
        title={`Appointments · ${periodLabel}`}
        sub="AI-booked & AI-assisted — straight from your report data, so it always matches the tiles above"
        wide
      >
        {serviceMetricsOn ? (
          (svcMetrics.namedAppointments?.length ?? 0) > 0 ? (
            <div className="flex flex-col gap-2">
              {svcMetrics.namedAppointments!.map((a, i) => (
                <div key={`${a.customer}-${i}`} className="flex items-center justify-between gap-3 border-b border-[#f0f0f0] pb-2 last:border-0 last:pb-0">
                  <div className="min-w-0">
                    <span className="font-semibold text-[#111]">{a.customer}</span>
                    {a.vehicle && <span className="ml-2 text-[11px] text-[#6b7280]">{a.vehicle}</span>}
                  </div>
                  <span className="flex-none text-[11px] tabular-nums text-[#6b7280]">{a.when ? fmtWhenShort(a.when, feed?.timezone) : ""}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[12.5px] text-[#6b7280]">No appointment details for {periodLabel} yet — the counts above are correct; the named list syncs shortly.</p>
          )
        ) : namedAppts.length > 0 ? (
          <NamedApptsTable items={namedAppts} teamId={teamId} tz={feed?.timezone} />
        ) : (
          <p className="text-[12.5px] text-[#6b7280]">No appointment details for {periodLabel} yet — the counts above are correct; the named list syncs shortly.</p>
        )}
      </Modal>
      {/* Warm-leads "view all" — click a lead to review its conversation (calls + SMS) in the drawer.
          No service-metrics twin (Classification unavailable), and Hot Leads has no trigger left once the
          flag is on for Service (its card is hidden) — so this isn't just unreachable, it's not mounted
          at all, and real ClickHouse warmLeads never even reaches it as a prop. */}
      {!serviceMetricsOn && (
        <WarmLeadsModal
          open={warmModalOpen}
          onClose={() => setWarmModalOpen(false)}
          items={warmLeads}
          agentNames={agentNames}
          loadConversation={(leadId) => fetchConversations(teamId, { leadId, channel: "both", limit: 10, spyneToken, spyneEnv })}
        />
      )}
      {/* Customize layout — hide/reorder sections (opened from the header). Two modals: `ctrl` for the
          legacy layout, `liveCtrl` for the new Live overview. Each renders only when ITS editing is on. */}
      <CustomizeModal ctrl={ctrl} groups={customizeGroups} accountLabel={account.name} />
      <CustomizeModal ctrl={liveCtrl} groups={liveGroups} accountLabel={account.name} />
    </div>
  );
}


/* ── relative "synced X ago" label ── */
function relTime(then: number, now: number): string {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 45) return "just now";
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

/* ── no rooftop selected ── */
function NoRooftop() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[#e0e0e0] bg-[#fcfcfd] px-6 py-16 text-center">
      <span className="text-[26px] leading-none">🏢</span>
      <p className="text-[14px] font-bold text-[#111]">We couldn’t tell which dealership to show</p>
      <p className="max-w-[460px] text-[12.5px] leading-snug text-[#6b7280]">
        Open your report from your dashboard so it loads the right dealership. If you reached this page another way,
        your administrator can point you to the correct link.
      </p>
    </div>
  );
}

/* ── shimmer skeleton while a rooftop/window loads ── */
function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-9">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="h-[130px] animate-pulse rounded-2xl bg-[#eef0f3]" />)}
      </div>
      <div className="h-[240px] animate-pulse rounded-2xl bg-[#eef0f3]" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {[0, 1].map((i) => <div key={i} className="h-[260px] animate-pulse rounded-2xl bg-[#eef0f3]" />)}
      </div>
    </div>
  );
}


/* ── First-time experience — no agents live yet ── */
function FirstTimeOverview() {
  return (
    <>
      <section className="rounded-3xl border border-[#ece6fb] bg-gradient-to-br from-[#f6f1ff] to-white px-8 py-9 shadow-sm">
        <Eyebrow>Welcome to your control tower</Eyebrow>
        <h2 className="mt-1.5 text-[26px] font-extrabold tracking-[-0.02em] text-[#111]">No agents live yet</h2>
        <p className="mt-2 max-w-[600px] text-[13.5px] leading-snug text-[#6b7280]">
          This is where every call, appointment and hand-off shows up once your AI agents are running. Connect your CRM and
          launch your first agent to start the clock.
        </p>
        <div className="mt-7 grid gap-8 md:grid-cols-2">
          <StepList
            steps={[
              { label: "Connect your CRM", active: true },
              { label: "Capture your 90-day baseline" },
              { label: "Launch your first agent" },
              { label: "Watch the results land here" },
            ]}
          />
          <div className="flex items-end">
            <button className="rounded-xl bg-[#813fed] px-5 py-2.5 text-[13px] font-bold text-white transition-colors hover:bg-[#6d28d9]">
              Connect CRM →
            </button>
          </div>
        </div>
      </section>
      <SectionLabel>What your daily report will look like</SectionLabel>
      <GhostPreview
        title="Your scorecard appears here"
        body="Appointments, real conversations, hand-offs, the whole-dealership pipeline, per-agent funnels and the named leads to work — once you’re live."
      />
    </>
  );
}

/* ── Onboarding — importing history, agents not yet live ── */
function OnboardingOverview({ view }: { view: ScenarioView }) {
  return (
    <>
      <Card title="Getting your dealership set up" sub="Importing history and bringing your agents online.">
        <div className="flex flex-col gap-5">
          <div>
            <div className="mb-1.5 flex items-center justify-between text-[12px]">
              <span className="text-[#6b7280]">Importing your last 90 days across all sources</span>
              <b className="tabular-nums text-[#111]">{view.importProgress}%</b>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-[#f0f0f0]">
              <div className="h-2.5 rounded-full bg-[#813fed]" style={{ width: `${view.importProgress}%` }} />
            </div>
          </div>
          <StepList
            steps={[
              { label: "Connect CRM & data sources", done: true },
              { label: "Import 90-day history", active: true },
              { label: "Configure your agents", done: true },
              { label: "Go live" },
            ]}
          />
          <div className="rounded-xl bg-[#f0fdf6] px-4 py-3 text-[12px] text-[#065f46]">
            <b>{view.liveLabel}.</b> The morning report starts landing in your inbox the day after your agents go live.
          </div>
        </div>
      </Card>
      <SectionLabel>Your daily report (preview)</SectionLabel>
      <GhostPreview
        title="Your scorecard unlocks at go-live"
        body="Once your agents start working leads, this fills with the whole-dealership funnel, per-agent performance and the named leads to work."
      />
    </>
  );
}
