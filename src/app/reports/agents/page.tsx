"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  ActiveCampaign,
  AGENTS as MOCK_AGENTS,
  AgentData,
  agentById,
  Bucket,
  Meeting,
  MeetingsList,
  BUCKET_LABELS,
  CalibratingBanner,
  Card,
  ComingSoon,
  EmptyState,
  DateFilter,
  fmtInt,
  GhostPreview,
  HOUR_LABELS,
  DayTrend,
  MeetingsModal,
  ProgressBar,
  RAG_STYLE,
  ReportTopBar,
  SectionLabel,
  StepList,
  Td,
  Th,
  TrendBars,
} from "@/components/reports/kit";
import { fmtRate, fmtWhenShort, IntentOutcomeTable, RankedOutcomeTable, WarmLeadChips } from "@/components/reports/kitV3";
import { useScenario, ScenarioView } from "@/components/reports/scenario";
import { fetchAgents, fetchMeetings, fetchReportMetrics, fetchActionItems, fetchActionItemStats, fetchAllActionItems, agentsForAccount, hasAgentActivity, addDay, rangeFor, peekAgents, tzShortLabel, type FetchResult, type ReportMetrics, type ActionItem, type ActionItemStats } from "@/components/reports/liveData";
import { useDateRange, useDept, reportNavQuery } from "@/components/reports/dateRange";
import { goCrossPage } from "@/components/reports/parentNav";
import { UpsellAgent, StlUpsell } from "@/components/reports/upsell";
import { ExportMenu } from "@/components/reports/ExportMenu";
import { downloadCSV, downloadXLSX, exportFilenameStem, CANONICAL_DEFINITIONS, type ExportSheet, type PdfSection } from "@/components/reports/exportReport";
import { buildPdfReport } from "@/components/reports/printToPdf";
import { track } from "@/lib/analytics";

// Human labels for the "missed opportunities" categories pushed from ClickHouse (report_missed_opportunities).
const MISSED_LABELS: Record<string, string> = {
  voicemail: "Went to voicemail",
  no_answer: "No answer",
  abandoned: "Abandoned (silence)",
  sms_failed: "SMS failed to deliver",
};

// useSearchParams() (to read ?agent=) needs a Suspense boundary above it.
export default function AgentReportsPage() {
  return (
    <Suspense fallback={null}>
      <AgentReportsView />
    </Suspense>
  );
}

function AgentReportsView() {
  const searchParams = useSearchParams();
  const paramAgent = searchParams.get("agent"); // the agent the overview "who drove it" link picked
  // Selected window comes from the URL so it persists when arriving from the Overview tab (and back).
  const { bucket, custom, setPreset, setCustom } = useDateRange();
  const { dept } = useDept(); // top-level scope (shared header, URL-persisted) — scopes the agent pills
  // open on the agent passed in; the picker on the page then drives selection locally.
  // An invalid/absent id is corrected by the validity effect below once agents load.
  const [activeId, setActiveId] = useState<string>(paramAgent || "sales_ib");
  // True once the user has clicked a pill — stops the activity-based default below from overriding an
  // explicit choice (e.g. deliberately opening a quiet agent).
  const userPickedRef = useRef(false);
  // when set, the rooftop doesn't run this agent → show the upsell pitch instead of a report
  const [upsellId, setUpsellId] = useState<string | null>(null);
  // when set, the appointment-count drill-down modal is open (lists the leads behind the number)
  const [apptModal, setApptModal] = useState<{ service: "sales" | "service"; agentType: string; title: string; sub: string } | null>(null);
  // Resolved up-front (before the effects/handlers below that reference teamId for analytics).
  const { scenario, view, teamId, account, spyneToken, enterpriseId } = useScenario();

  // custom range (inclusive end) overrides the preset bucket; end is made exclusive for Metabase.
  // spyneToken (host-forwarded, prod) rides along so the server can resolve timezone + onboarded agents.
  const rangeOpts = custom ? { start: custom.start, end: addDay(custom.end), spyneToken } : { bucket, spyneToken };
  // Live agents for the selected rooftop, overlaid from Metabase. Seed from the client cache so
  // navigating back paints instantly instead of flashing a skeleton; null === nothing cached (cold).
  const [feed, setFeed] = useState<FetchResult | null>(() => peekAgents({ teamId, ...rangeOpts }));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000); // tick the "synced X ago" label
    return () => clearInterval(t);
  }, []);
  // Engagement: fires once per opened agent report (the rooftop is resolved by mount).
  useEffect(() => { track("report_viewed", { tab: "agents", team_id: teamId }); }, [teamId]);
  useEffect(() => {
    if (!teamId) { setFeed(null); return; } // no rooftop selected → no data
    let on = true;
    // show cached data immediately (stale-while-revalidate); only blank to the skeleton when cold
    const cached = peekAgents({ teamId, ...rangeOpts });
    setFeed(cached);
    fetchAgents({ teamId, ...rangeOpts })
      .then((res) => { if (on) setFeed(res); })
      .catch(() => { if (!on) return; track("report_load_failed", { tab: "agents", team_id: teamId }); if (!cached) setFeed({ agents: [], hasData: false, fetchedAt: Date.now(), prior: {} }); });
    return () => { on = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, bucket, custom]);
  // Coming-soon metrics (transfer success, calls-by-reason, highlights/missed) from /api/reports/metrics
  // — a rooftop-level snapshot pushed from ClickHouse, separate from the Q12227 feed. Each widget falls
  // back to its "coming soon" placeholder when this is null/empty, so a missing push never breaks render.
  const [metrics, setMetrics] = useState<ReportMetrics | null>(null);
  useEffect(() => {
    let on = true;
    Promise.resolve(teamId ? fetchReportMetrics(teamId, spyneToken) : null)
      .then((mx) => { if (on) setMetrics(mx); })
      .catch(() => { if (on) setMetrics(null); });
    return () => { on = false; };
  }, [teamId, spyneToken]);
  // Self-heal a degraded fetch (fetchAgents already retried 3× in-line): re-hit the server ONCE more
  // shortly after so the report fills in on its own. Depends on the degraded BOOLEAN (not fetchedAt) so a
  // still-degraded retry can't re-trigger it — never a perpetual poll. 401s aren't degraded → never fires.
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
    track("report_refreshed", { tab: "agents", team_id: teamId });
    setFeed(null);
    fetchAgents({ teamId, ...rangeOpts, force: true })
      .then(setFeed)
      .catch(() => { track("report_load_failed", { tab: "agents", team_id: teamId }); setFeed({ agents: [], hasData: false, fetchedAt: Date.now(), prior: {} }); });
  };
  // Scope the live feed (and the no-crash mock skeleton) to the agents this rooftop actually runs.
  const AGENTS = useMemo(() => agentsForAccount(feed?.agents ?? [], account), [feed, account]);
  const hasTeam = teamId !== "";
  // Carries team scope + the selected window into the tab links and the back arrow, so the window
  // survives navigation back to the Overview tab.
  const navQuery = reportNavQuery(teamId, bucket, custom, dept);
  // Gated on lifetime "ever live", NOT the selected window — a live rooftop with an empty window (e.g.
  // "Today" before its first synced call) renders the report with zeros instead of the on-its-way gate.
  // Falls back to hasData when everLive is absent (mock/error response) → prior window-scoped behavior.
  // A degraded fetch (transient outage / cold-start timeout) is NOT "never live" — hold the syncing
  // state and let the re-arm effect retry, rather than flip to the on-its-way gate.
  const degraded = feed?.degraded === true;
  const comingSoon = hasTeam && feed !== null && !degraded && !(feed.everLive ?? feed.hasData); // rooftop selected, never live yet
  const skeleton = useMemo(() => agentsForAccount(MOCK_AGENTS, account), [account]);
  // A live rooftop whose feed has RESOLVED but carries no agents for the selected window. We must NOT
  // fall back to the mock skeleton's numbers here (that rendered a fake "168 leads attempted" report for
  // a real dealer) — this drives the empty/zero state instead. The skeleton is used ONLY for the
  // pre-load / never-selected state below (so `a` is always a valid object and the JSX can't crash).
  const feedEmpty = hasTeam && feed !== null && AGENTS.length === 0;
  // Use real agents when present; otherwise the skeleton is a crash-safety placeholder only — when a live
  // feed has resolved empty (feedEmpty), the render gates below show the empty state, never the skeleton's
  // mock metrics/pills.
  // Scope the agent pills to the top-level dept when one is chosen; fall back to the full set if this
  // rooftop runs no agent in that dept, so `visibleAgents` is never empty (agentById → agents[0]).
  const visibleAgents = useMemo(() => {
    const base = AGENTS.length ? AGENTS : skeleton;
    if (dept === "all") return base;
    const scoped = base.filter((ag) => ag.dept.toLowerCase() === dept);
    return scoped.length ? scoped : base;
  }, [AGENTS, skeleton, dept]);
  const a = useMemo(() => agentById(activeId, visibleAgents), [activeId, visibleAgents]);
  // keep the selected agent valid when the rooftop (and thus its agent set) changes, and default to an
  // agent that actually has activity in this window so the page never lands on an empty agent while the
  // rooftop is busy elsewhere (the "overview shows activity but by-agent doesn't" trap).
  useEffect(() => {
    if (!visibleAgents.length) return;
    // dropped/invalid selection → fall back to the first agent
    if (!visibleAgents.some((ag) => ag.id === activeId)) { setActiveId(visibleAgents[0].id); return; }
    // Activity-based default: only when the user hasn't picked a pill and no explicit ?agent= was passed.
    // If the current agent is empty for this window but another has activity, open the most-active one.
    if (userPickedRef.current || paramAgent) return;
    const current = agentById(activeId, visibleAgents);
    if (hasAgentActivity(current)) return;
    const score = (x: AgentData) => x.metrics.calls + x.metrics.smsSent + x.metrics.appointments + (x.leadFunnel?.contacted ?? x.report?.leadsAttempted ?? 0);
    const best = visibleAgents.filter(hasAgentActivity).reduce<AgentData | null>((b, x) => (!b || score(x) > score(b) ? x : b), null);
    if (best && best.id !== activeId) setActiveId(best.id);
  }, [visibleAgents, activeId, paramAgent]);
  // agents this rooftop does NOT run — pitched as an upsell rather than hidden
  const upsellAgents = useMemo(() => {
    const liveIds = new Set(visibleAgents.map((x) => x.id));
    return MOCK_AGENTS.filter((x) => !liveIds.has(x.id));
  }, [visibleAgents]);
  const upsell = useMemo(() => (upsellId ? upsellAgents.find((x) => x.id === upsellId) ?? null : null), [upsellId, upsellAgents]);
  // drop a stale upsell selection if the rooftop changes and now runs that agent
  useEffect(() => {
    if (upsellId && !upsellAgents.some((x) => x.id === upsellId)) setUpsellId(null);
  }, [upsellAgents, upsellId]);
  const m = a.metrics;
  const r = a.report;
  const inbound = a.dir === "Inbound";
  const live = view.hasData; // recently_live + repeat render the real report

  // Highlights & missed are rooftop-level but direction-specific: wins are the AI's best booked calls in
  // THIS agent's direction (report_highlights carries direction); "missed" (went-to-voicemail / no-answer /
  // sms-failed) are OUTBOUND dial outcomes with no direction column — nonsensical on an inbound agent, so
  // they're shown only on outbound agents.
  const agentDir = inbound ? "inbound" : "outbound";
  // Match the agent's direction, but KEEP highlights whose direction is null/blank (some rooftops don't
  // populate it) so real wins never silently vanish from the card.
  const agentHighlights = metrics ? metrics.highlights.filter((h) => { const d = (h.direction || "").toLowerCase(); return d ? d === agentDir : true; }) : [];
  const showMissed = !inbound && !!metrics && metrics.missed.length > 0;

  // Live data is already a window total for the selected bucket (liveData re-queries per bucket),
  // so it must not be re-scaled — factor=1 when live, 0 in the pre-live ghost states.
  const factor = live ? 1 : 0;
  const scale = (n: number) => Math.round(n * factor);
  const periodLabel = custom ? (custom.start === custom.end ? custom.start : `${custom.start} – ${custom.end}`) : scenario === "repeat" ? BUCKET_LABELS[bucket] : view.liveLabel;
  // Store-local window for the action-items scoreboard (created/closed within it); end is exclusive.
  const win = useMemo(() => (custom ? { start: custom.start, end: addDay(custom.end) } : rangeFor(bucket)), [bucket, custom]);
  // Window for the appointment drill-down — the same range the report shows (the server-resolved
  // store-local dates when we have them, else the bucket name). The modal lists the meetings behind a count.
  const meetingWindow: { start?: string; end?: string; bucket?: Bucket } =
    feed?.start && feed?.end ? { start: feed.start, end: feed.end } : { bucket };
  const openApptDrill = () => {
    track("appointments_drilldown_opened", { tab: "agents", team_id: teamId, agent: a.id });
    setApptModal({
      service: a.id.startsWith("service") ? "service" : "sales",
      agentType: a.id,
      title: `Appointments · ${periodLabel}`,
      sub: `${r.summary.person} · ${a.name} — the leads behind this number`,
    });
  };
  // No activity to show for this agent in the selected window — covers both a quiet agent on an
  // otherwise-busy window AND a fully-empty window on a live rooftop (e.g. "Today" before any calls
  // sync). Either way show the NoActivity widen-prompt rather than a wall of zeros. (comingSoon is
  // already handled above, so reaching here means the rooftop has been live.)
  // Empty when EITHER the resolved live feed carries no agents at all (feedEmpty — never fall back to the
  // mock skeleton's numbers) OR the selected agent had NO activity of any kind in the window. We gate on
  // overall activity (leads, conversations, qualified, appts, SMS — not just CALLS): an inbound agent can
  // have a busy SMS/lead day with zero calls, and a calls-only check wrongly hid it as "no activity"
  // while the overview counted its leads. Both render the NoActivity widen-prompt rather than zeros.
  const agentEmpty = hasTeam && feed !== null && (feedEmpty || (live && !hasAgentActivity(a)));
  // Unique-lead stage values (same basis everywhere on the page); event-count fallback when
  // leadFunnel is absent (mock/no-backend).
  const leadConnected = a.leadFunnel?.connected ?? m.conversations;
  const leadQualified = a.leadFunnel?.qualified ?? m.qualified;
  // Warm leads (outbound) — total across the agent's active campaigns (campaignLeadMappings outcomes
  // that signal intent/engagement, summed in report_campaigns). Rooftop-wide, like the campaigns table,
  // so it is NOT window-scaled. Shown as a headline activity stat + above the campaigns table.
  const warmLeadsTotal = !inbound ? (r.activeCampaigns ?? []).reduce((s, c) => s + (c.warmLeads || 0), 0) : 0;

  // Shared between the JSX (PerfFunnel / outcome tiles / transfer-quality QCell) and the CSV/XLSX export
  // below, so the exported numbers always match what's on screen. Every stage is a window-DISTINCT lead
  // count (from leadFunnel) so the funnel stays monotonic (contacted ≥ connected ≥ qualified ≥
  // appointments) and never double-counts a lead touched on multiple days. Falls back to event counts
  // only if leadFunnel is absent. Canonical wordings: "Leads reached" (IB) / "Leads dialed" (OB) ·
  // "Real conversations" · "Qualified leads" · "Appointments — AI-booked".
  const funnelStages = [
    { label: inbound ? "Leads reached" : "Leads dialed", value: scale(r.leadsAttempted) },
    { label: "Real conversations", value: scale(a.leadFunnel?.connected ?? m.conversations) },
    { label: "Qualified leads", value: scale(a.leadFunnel?.qualified ?? m.qualified) },
    { label: "Appointments — AI-booked", value: scale(m.appointments) },
  ];
  const outcomeTiles = [
    { label: "Real conversations", value: scale(leadConnected), accent: "#2563eb" },
    { label: "Qualified leads", value: scale(leadQualified), accent: "#813fed" },
    ...(inbound
      ? [
          { label: "Transferred", value: scale(r.callFlow.transferred), accent: "#059669" },
          ...((r.callFlow.transfersFailed ?? 0) > 0 ? [{ label: "Transfers failed", value: scale(r.callFlow.transfersFailed ?? 0), accent: "#dc2626" }] : []),
          { label: "Callbacks", value: scale(r.callFlow.callbacks ?? 0), accent: "#ea760c" },
        ]
      : []),
  ];
  // Never blend Sales+Service — pick the transfer-quality row matching this agent's own service type.
  const tqSvc = a.id.startsWith("service") ? "service" : "sales";
  const tq = metrics?.transfer_quality.find((t) => t.service_type === tqSvc);
  const showTransferQuality = tq?.success_rate != null && a.quality.fourthLabel.toLowerCase().includes("transfer");

  const buildExportSheets = (): ExportSheet[] => {
    const tzLabel = feed?.timezone ? tzShortLabel(feed.timezone) : "";
    const during = scale(Math.max(0, m.calls - m.afterHours));
    const after = scale(m.afterHours);
    const summary: ExportSheet = {
      name: "Summary",
      rows: [
        [`${account.name || "Rooftop"} — ${r.summary.person || a.name}`],
        ["Role", `${a.dept} · ${a.dir}`],
        ["Period", periodLabel],
        ...(tzLabel ? [["Timezone", tzLabel]] : []),
        [],
        ["Metric", "Value"],
        ["Close rate", fmtRate(scale(m.appointments), scale(leadQualified))],
        ["Turn rate", fmtRate(scale(leadQualified), scale(leadConnected))],
        [inbound ? "Total calls" : "Calls dispatched", scale(m.calls)],
        ["Talk time (minutes)", scale(m.talkMinutes)],
        ["Total SMS", scale(m.smsSent)],
        [inbound ? "" : "Warm leads (campaigns)", inbound ? "" : warmLeadsTotal],
        ["Calls during hours", during],
        ["Calls after hours", after],
        [],
        ...outcomeTiles.map((t) => [t.label, t.value]),
        [],
        [a.quality.primaryLabel, `${a.quality.primary}%`],
        ["Avg handle time", a.quality.handleTime],
        ["Opt-outs", scale(m.optOuts)],
        ...(showTransferQuality && tq ? [[a.quality.fourthLabel, fmtRate(tq.transfers_ok, tq.transfers_ok + tq.transfers_failed)]] : []),
        [],
        ["Total AI-booked appointments", scale(m.appointments)],
        ...(scale(m.appointmentsAssisted ?? 0) > 0 ? [["AI-assisted (CRM)", scale(m.appointmentsAssisted ?? 0)]] : []),
      ],
    };

    const funnel: ExportSheet = {
      name: "Funnel",
      rows: [
        ["Stage", "Leads (distinct)", "Conversion from prior stage"],
        ...funnelStages.map((s, i) => {
          const prev = i > 0 ? funnelStages[i - 1].value : null;
          const conv = prev && prev > 0 ? `${Math.round((100 * s.value) / prev)}%` : "";
          return [s.label, s.value, conv];
        }),
      ],
    };

    const dayOnDay: ExportSheet = {
      name: "Day-on-day",
      rows: [
        ["Day", "Touched", "Qualified", "Appointments"],
        ...r.dayOnDay.map((d) => [d.day, scale(d.touched), scale(d.qualified), scale(d.appts)]),
      ],
    };

    const sheets = [summary, funnel, dayOnDay];

    if (r.leadsBySource?.length) {
      sheets.push({
        name: "Leads by source",
        rows: [
          ["Source", "Interacted", "Total leads", "Appts booked"],
          ...r.leadsBySource.map((s) => [s.source, scale(s.engaged), scale(s.total), scale(s.appts)]),
        ],
      });
    }

    if (!inbound && r.activeCampaigns?.length) {
      sheets.push({
        name: "Campaigns",
        rows: [
          ["Campaign", "Use case", "Enrolled", "Appts", "Appt rate", "Warm leads", "Opt-outs"],
          ...r.activeCampaigns.map((c) => [c.name, c.useCase, c.enrolled, c.appts, `${c.apptRate}%`, c.warmLeads, c.optOuts]),
        ],
      });
    }

    if (!inbound && r.outcomes?.length) {
      sheets.push({
        name: "Outbound outcomes",
        rows: [["Outcome", "Count"], ...r.outcomes.map((o) => [o.label, o.value])],
      });
    }

    if (r.warmLeads?.length) {
      sheets.push({
        name: "Warm leads",
        rows: [
          ["Customer", "Phone", "Tier", "Interest", "Campaign", "Last activity", "Service type"],
          ...r.warmLeads.map((w) => [w.customer, w.phone, w.tier, w.interest, w.campaign, w.lastActivity ?? "", w.serviceType]),
        ],
      });
    }

    if (agentHighlights.length > 0 || showMissed) {
      sheets.push({
        name: "Highlights & missed",
        rows: [
          ["Wins — best booked calls"],
          ["Title", "Occurred on"],
          ...agentHighlights.map((h) => [h.title ?? "", h.occurred_on ?? ""]),
          ...(showMissed
            ? [
                [],
                ["Missed — outbound demand that slipped"],
                ["Category", "Channel", "Count"],
                ...metrics!.missed.map((mm) => [MISSED_LABELS[mm.category] ?? mm.category, mm.channel, mm.count]),
              ]
            : []),
        ],
      });
    }

    // The full appointment list behind "Total AI-booked" — same source (report.namedAppointments) as
    // the headline count above, so the export always ties out to what's on screen. Not the modal's live
    // Spyne re-fetch (that's for the drill-down's freshness, a different concern from "export what the
    // report is showing").
    if (r.namedAppointments?.length) {
      sheets.push({
        name: "Appointments",
        rows: [
          ["Customer", "Phone", "Channel", "Vehicle", "When", "Booked at", "Status", "How", "AI-assisted (CRM)", "Service type"],
          ...r.namedAppointments.map((ap) => [
            ap.customer, ap.phone, ap.channel ?? "", ap.vehicle, ap.when ?? "", ap.bookedAt ?? "", ap.status, ap.how, ap.assisted ? "Yes" : "No", ap.serviceType,
          ]),
        ],
      });
    }

    if (inbound && r.intentOutcomes?.length) {
      sheets.push({
        name: "Conversations & outcomes",
        rows: [
          ["What the customer wanted", "Conversations", "Resolved", "Booked", "Transferred", "Callback"],
          ...r.intentOutcomes.map((row) => [row.label, row.conversations, row.resolved, row.booked, row.transferred, row.callback]),
        ],
      });
    }

    if (a.id === "sales_ib" && r.speedToLead?.medianUnderMin) {
      const stl = r.speedToLead;
      sheets.push({
        name: "Speed to lead",
        rows: [
          ["Metric", "Value"],
          ["Avg first response", stl.avg],
          ["New CRM leads", stl.crmLeadsNew],
          ["% contacted within 5 min", `${stl.pctWithin5}%`],
          ["Touched instantly", stl.instantlyTouched],
          ["Touched instantly, after-hours", stl.afterHoursInstant],
          ["Instant-touch appointments", stl.instantAppts],
          ["Instant-touch → appointment rate", `${stl.instantApptRate}%`],
          ...(stl.openFunnel
            ? [
                [],
                ["Path", "Leads handled", "Appointments", "Booked rate"],
                ["Speed-to-lead", stl.openFunnel.stlLeadsHandled, stl.openFunnel.stlAppts, `${stl.openFunnel.stlRate}%`],
                ["Follow-up", stl.openFunnel.followupLeadsHandled, stl.openFunnel.followupAppts, `${stl.openFunnel.followupRate}%`],
              ]
            : []),
        ],
      });
    }

    sheets.push({ name: "Definitions", rows: [[CANONICAL_DEFINITIONS]] });
    return sheets;
  };

  // Action items live in their own domain (dealer_leads.actionItems via /api/action-items), fetched
  // fresh here rather than lifted into shared state — this is the only sheet that needs a network
  // round-trip at export time; everything else in buildExportSheets is already-loaded report data.
  const buildActionItemsSheet = async (): Promise<ExportSheet> => {
    const service = a.dept === "Service" ? "service" : "sales";
    const [stats, items] = await Promise.all([
      fetchActionItemStats(teamId, { start: win.start, end: win.end, service, spyneToken }),
      fetchAllActionItems(teamId, { scope: "open", service, spyneToken }),
    ]);
    return {
      name: "Action items",
      rows: [
        ["Created", "Completed", "Open", "Overdue", "Due today"],
        stats ? [stats.stats.created, stats.stats.completed, stats.stats.open, stats.stats.overdue, stats.stats.dueToday] : ["—", "—", "—", "—", "—"],
        [],
        ["Open queue — customer", "What to do", "Priority", "Due", "Completed"],
        ...items.map((it) => [it.customer ?? "", it.description || it.intent, it.priority, it.dueAt ?? "", it.completed ? "Yes" : "No"]),
      ],
    };
  };

  const handleExport = async (format: "csv" | "xlsx") => {
    track("report_exported", { tab: "agents", team_id: teamId, format });
    const filename = `${exportFilenameStem(`${account.name} - ${r.summary.person || a.name}`, periodLabel)}.${format}`;
    const sheets = buildExportSheets();
    sheets.push(await buildActionItemsSheet());
    if (format === "csv") downloadCSV(filename, sheets);
    else downloadXLSX(filename, sheets);
  };

  const buildPdfSections = (): PdfSection[] => {
    const during = scale(Math.max(0, m.calls - m.afterHours));
    const after = scale(m.afterHours);
    const sections: PdfSection[] = [
      {
        heading: "Performance",
        blocks: [
          {
            kind: "rows",
            rows: [
              ["Close rate", fmtRate(scale(m.appointments), scale(leadQualified))],
              ["Turn rate", fmtRate(scale(leadQualified), scale(leadConnected))],
              [inbound ? "Total calls" : "Calls dispatched", `${scale(m.calls)} (${scale(m.talkMinutes)} min talk)`],
              ["Total SMS", scale(m.smsSent)],
              ...(!inbound ? [["Warm leads (campaigns)", warmLeadsTotal]] : []),
              ["Calls during hours", during],
              ["Calls after hours", after],
            ],
          },
        ],
      },
      {
        heading: "Lead-to-appointment funnel",
        blocks: [{ kind: "rows", columns: ["Stage", "Leads (distinct)", "Conversion from prior stage"], rows: funnelStages.map((s, i) => {
          const prev = i > 0 ? funnelStages[i - 1].value : null;
          const conv = prev && prev > 0 ? `${Math.round((100 * s.value) / prev)}%` : "—";
          return [s.label, fmtInt(s.value), conv];
        }) }, { kind: "rows", title: "Call breakdown", rows: outcomeTiles.map((t) => [t.label, fmtInt(t.value)]) }],
      },
      {
        heading: "Quality",
        blocks: [{
          kind: "rows",
          rows: [
            [a.quality.primaryLabel, `${a.quality.primary}%`],
            ["Avg handle time", a.quality.handleTime],
            ["Opt-outs", scale(m.optOuts)],
            ...(showTransferQuality && tq ? [[a.quality.fourthLabel, fmtRate(tq.transfers_ok, tq.transfers_ok + tq.transfers_failed)]] : []),
          ],
        }],
      },
      {
        heading: "Day-on-day",
        blocks: [{ kind: "rows", columns: ["Day", "Touched", "Qualified", "Appointments"], rows: r.dayOnDay.map((d) => [d.day, scale(d.touched), scale(d.qualified), scale(d.appts)]) }],
      },
    ];

    if (inbound && r.intentOutcomes?.length) {
      sections.push({
        heading: "What customers wanted",
        blocks: [{ kind: "rows", columns: ["Topic", "Conversations", "Resolved", "Booked", "Transferred", "Callback"], rows: r.intentOutcomes.map((row) => [row.label, row.conversations, row.resolved, row.booked, row.transferred, row.callback]) }],
      });
    }

    if (r.leadsBySource?.length) {
      sections.push({
        heading: "Leads by source",
        blocks: [{ kind: "rows", columns: ["Source", "Interacted", "Total leads", "Appts booked"], rows: r.leadsBySource.map((s) => [s.source, scale(s.engaged), scale(s.total), scale(s.appts)]) }],
      });
    }

    if (a.id === "sales_ib" && r.speedToLead?.medianUnderMin) {
      const stl = r.speedToLead;
      sections.push({
        heading: "Speed to lead",
        blocks: [
          {
            kind: "rows",
            rows: [
              ["Avg first response", stl.avg],
              ["New CRM leads", stl.crmLeadsNew],
              ["% contacted within 5 min", `${stl.pctWithin5}%`],
              ["Touched instantly", stl.instantlyTouched],
              ["Instant-touch appointments", stl.instantAppts],
              ["Instant-touch-to-appointment rate", `${stl.instantApptRate}%`],
            ],
          },
          ...(stl.openFunnel
            ? [{ kind: "rows" as const, title: "By path", columns: ["Path", "Leads handled", "Appointments", "Booked rate"], rows: [
                ["Speed-to-lead", stl.openFunnel.stlLeadsHandled, stl.openFunnel.stlAppts, `${stl.openFunnel.stlRate}%`],
                ["Follow-up", stl.openFunnel.followupLeadsHandled, stl.openFunnel.followupAppts, `${stl.openFunnel.followupRate}%`],
              ] }]
            : []),
        ],
      });
    }

    if (!inbound && r.activeCampaigns?.length) {
      sections.push({
        heading: "Active campaigns",
        blocks: [{ kind: "rows", columns: ["Campaign", "Use case", "Enrolled", "Appts", "Appt rate", "Warm leads", "Opt-outs"], rows: r.activeCampaigns.map((c) => [c.name, c.useCase, c.enrolled, c.appts, `${c.apptRate}%`, c.warmLeads, c.optOuts]) }],
      });
    }

    if (!inbound && r.outcomes?.length) {
      sections.push({
        heading: "Outbound outcomes",
        blocks: [{ kind: "rows", columns: ["Outcome", "Count"], rows: r.outcomes.map((o) => [o.label, o.value]) }],
      });
    }

    if (r.namedAppointments?.length) {
      const preview = r.namedAppointments.slice(0, 30);
      sections.push({
        heading: "Appointments",
        blocks: [
          { kind: "rows", columns: ["Customer", "Vehicle", "When", "How booked", "Status"], rows: preview.map((ap) => [ap.customer, ap.vehicle || "—", ap.when ? fmtWhenShort(ap.when) : "—", ap.how, ap.status || "—"]) },
          ...(r.namedAppointments.length > preview.length
            ? [{ kind: "note" as const, text: `Showing the ${preview.length} most recent of ${r.namedAppointments.length} appointments — download the CSV or XLSX for the complete list.` }]
            : []),
        ],
      });
    }

    if (r.warmLeads?.length) {
      const preview = r.warmLeads.slice(0, 20);
      sections.push({
        heading: "Hot & warm leads",
        blocks: [
          { kind: "rows", columns: ["Customer", "Phone", "Tier", "Interest", "Last activity"], rows: preview.map((w) => [w.customer, w.phone, w.tier, w.interest, w.lastActivity ?? "—"]) },
          ...(r.warmLeads.length > preview.length
            ? [{ kind: "note" as const, text: `Showing the ${preview.length} most urgent of ${r.warmLeads.length} warm leads — download the CSV or XLSX for the rest.` }]
            : []),
        ],
      });
    }

    if (agentHighlights.length > 0 || showMissed) {
      sections.push({
        heading: "Highlights & missed opportunities",
        blocks: [
          ...(agentHighlights.length ? [{ kind: "rows" as const, title: "Wins — best booked calls", columns: ["Title", "Occurred on"], rows: agentHighlights.slice(0, 15).map((h) => [h.title ?? "", h.occurred_on ?? ""]) }] : []),
          ...(showMissed ? [{ kind: "rows" as const, title: "Missed — outbound demand that slipped", columns: ["Category", "Channel", "Count"], rows: metrics!.missed.map((mm) => [MISSED_LABELS[mm.category] ?? mm.category, mm.channel, mm.count]) }] : []),
        ],
      });
    }

    return sections;
  };

  const buildActionItemsPdfSection = async (): Promise<PdfSection> => {
    const service = a.dept === "Service" ? "service" : "sales";
    const [stats, items] = await Promise.all([
      fetchActionItemStats(teamId, { start: win.start, end: win.end, service, spyneToken }),
      fetchAllActionItems(teamId, { scope: "open", service, spyneToken }),
    ]);
    const preview = items.slice(0, 30);
    return {
      heading: "Action items",
      blocks: [
        {
          kind: "rows",
          rows: stats
            ? [["Created", fmtInt(stats.stats.created)], ["Completed", fmtInt(stats.stats.completed)], ["Open now", fmtInt(stats.stats.open)], ["Overdue", fmtInt(stats.stats.overdue)], ["Due today", fmtInt(stats.stats.dueToday)]]
            : [["Created", "—"], ["Completed", "—"], ["Open now", "—"], ["Overdue", "—"], ["Due today", "—"]],
        },
        { kind: "rows", title: "Open queue", columns: ["Customer", "What to do", "Priority", "Due"], rows: preview.map((it) => [it.customer ?? "—", it.description || it.intent, it.priority, it.dueAt ?? "—"]) },
        ...(items.length > preview.length
          ? [{ kind: "note" as const, text: `Showing the ${preview.length} most recent of ${items.length} open items — download the CSV or XLSX for the complete list.` }]
          : []),
      ],
    };
  };

  const handlePrint = async () => {
    track("report_exported", { tab: "agents", team_id: teamId, format: "print" });
    const sections = buildPdfSections();
    sections.push(await buildActionItemsPdfSection());
    sections.push({ heading: "Definitions", blocks: [{ kind: "note", text: CANONICAL_DEFINITIONS }] });
    await buildPdfReport(sections, {
      filename: `${exportFilenameStem(`${account.name} - ${r.summary.person || a.name}`, periodLabel)}.pdf`,
      title: `${account.name || "Rooftop"} — ${r.summary.person || a.name}`,
      subtitle: `${r.summary.person || a.name} · ${a.dept} · ${a.dir} · ${periodLabel}${feed?.timezone ? ` · times in ${tzShortLabel(feed.timezone)}` : ""}`,
    });
  };

  return (
    <div className="flex min-h-screen bg-[#fafafa]">
      <div className="flex flex-1 flex-col">

        <ReportTopBar
          title="Agent performance"
          subtitle="ROI, pipeline and quality by agent — Sales & Service, inbound & outbound."
          active="agents"
          teamId={teamId}
          query={navQuery}
          back={`/reports${navQuery}`}
          right={
            hasTeam ? (
              <div className="no-print flex items-center gap-3">
                <DateFilter
                  bucket={bucket}
                  custom={custom}
                  onPreset={(b) => { setPreset(b); track("date_range_changed", { tab: "agents", range: b, team_id: teamId }); }}
                  onCustom={(r) => { setCustom(r); track("date_range_changed", { tab: "agents", range: "custom", team_id: teamId }); }}
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
                <ExportMenu onPrint={handlePrint} onCSV={() => handleExport("csv")} onXLSX={() => handleExport("xlsx")} />
              </div>
            ) : (
              <span className="rounded-lg bg-[#f3eaff] px-3 py-1.5 text-[12px] font-semibold text-[#813fed]">{view.liveLabel}</span>
            )
          }
        />

        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 sm:px-6 lg:px-10 pt-6 pb-36 flex flex-col gap-6">
          {scenario === "first_time" && <FirstTimeAgents agent={a} />}

          {scenario !== "first_time" && live && !hasTeam && (
            <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[#e0e0e0] bg-[#fcfcfd] px-6 py-16 text-center">
              <span className="text-[26px] leading-none">🏢</span>
              <p className="text-[14px] font-bold text-[#111]">We couldn’t tell which dealership to show</p>
              <p className="max-w-[460px] text-[12.5px] leading-snug text-[#6b7280]">
                Open your report from your dashboard so it loads the right dealership. If you reached this page another
                way, your administrator can point you to the correct link.
              </p>
            </div>
          )}

          {scenario !== "first_time" && live && hasTeam && (feed === null || degraded) && <ReportSkeleton />}

          {scenario !== "first_time" && live && hasTeam && comingSoon && <RooftopComingSoon name={account.name} />}

          {/* Live, resolved rooftop whose feed carries no agents/activity for the window — show the empty
              state, NOT the mock skeleton's switcher pills + fake report (the P1-3 bug). */}
          {scenario !== "first_time" && live && hasTeam && feed !== null && !degraded && !comingSoon && feedEmpty && (
            <NoActivity name={account.name || "this rooftop"} onWiden={() => { setPreset("last30"); track("empty_window_widened", { team_id: teamId, agent: activeId }); }} />
          )}

          {scenario !== "first_time" && (!live || (hasTeam && feed !== null && !comingSoon && !feedEmpty)) && (
          <>
          {/* agent switcher — full-width row of equal pills; the selected one drives the report below */}
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            {visibleAgents.map((ag) => {
              const selected = ag.id === activeId && !upsell;
              return (
                <button
                  key={ag.id}
                  onClick={() => { userPickedRef.current = true; setActiveId(ag.id); setUpsellId(null); track("agent_switched", { team_id: teamId, agent: ag.id }); }}
                  className={`flex items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-all ${
                    selected
                      ? "border-[#813fed] bg-[#faf8ff] shadow-[0_0_0_3px_rgba(129,63,237,0.12)]"
                      : "border-[#e5e7eb] bg-white hover:border-[#c4b5fd] hover:bg-[#faf8ff]"
                  }`}
                >
                  <span className={`flex h-9 w-9 flex-none items-center justify-center rounded-lg text-[18px] leading-none ${selected ? "bg-white shadow-sm" : "bg-[#f6f1ff]"}`}>
                    {ag.icon}
                  </span>
                  <span className="flex flex-col">
                    <span className={`text-[13px] font-bold leading-tight ${selected ? "text-[#111]" : "text-[#374151]"}`}>{ag.name}</span>
                    <span className="mt-0.5 text-[11px] leading-none text-[#6b7280]">
                      <b className="tabular-nums text-[#111]">{view.agentLive ? fmtInt(ag.report.leadsAttempted * factor) : "—"}</b> leads attempted
                    </span>
                  </span>
                </button>
              );
            })}
            {upsellAgents.map((ag) => {
              const selected = upsell?.id === ag.id;
              return (
                <button
                  key={ag.id}
                  onClick={() => { setUpsellId(ag.id); track("agent_upsell_viewed", { team_id: teamId, agent: ag.id }); }}
                  className={`flex items-center gap-3 rounded-xl border border-dashed px-3.5 py-2.5 text-left transition-all ${
                    selected
                      ? "border-[#813fed] bg-[#faf8ff] shadow-[0_0_0_3px_rgba(129,63,237,0.12)]"
                      : "border-[#dcd3f5] bg-[#fcfcfd] hover:border-[#c4b5fd] hover:bg-[#faf8ff]"
                  }`}
                >
                  <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-[#f3eaff] text-[18px] leading-none opacity-70">{ag.icon}</span>
                  <span className="flex flex-col">
                    <span className="text-[13px] font-bold leading-tight text-[#6b7280]">{ag.name}</span>
                    <span className="mt-0.5 text-[11px] font-semibold leading-none text-[#813fed]">+ Add · see what it does</span>
                  </span>
                </button>
              );
            })}
          </div>

          {upsell && (
            <UpsellAgent
              agent={upsell}
              accountName={account.name}
              teamId={teamId}
              peerCalls={live ? visibleAgents.reduce((s, x) => s + x.metrics.calls, 0) : undefined}
            />
          )}

          {!upsell && (
          <>
          {scenario === "onboarding" && <OnboardingAgents agent={a} view={view} />}

          {live && agentEmpty && (
            <NoActivity name={a.name} onWiden={() => { setPreset("last30"); track("empty_window_widened", { team_id: teamId, agent: a.id }); }} />
          )}

          {live && !agentEmpty && (
          <>
          {scenario === "recently_live" && (
            <CalibratingBanner
              title={`${r.summary.person} has been live ${view.daysLive} days — these are early numbers.`}
              body="Coverage and speed are real from day one; booking rates and trends keep firming up as volume grows."
            />
          )}

          <div className="flex items-center justify-between gap-3">
            <SectionLabel hint={periodLabel}>Performance</SectionLabel>
            {hasTeam && (
              <span className="no-print flex-none text-[11px] text-[#9ca3af]" title={feed?.timezone ? `Report days & times use this rooftop's timezone (${feed.timezone})` : undefined}>
                {feed?.timezone ? `Times in ${tzShortLabel(feed.timezone)}` : ""}
                {feed?.timezone && (feed === null || feed?.fetchedAt) ? " · " : ""}
                {feed === null ? "Syncing…" : feed?.fetchedAt ? `Synced ${relTime(feed.fetchedAt, now)}` : ""}
              </span>
            )}
          </div>

          {/* Performance — outcome funnel (primary) → activity (secondary) → call breakdown (tertiary) */}
          <div className="overflow-hidden rounded-2xl border border-[#e5e7eb] bg-white shadow-sm">
            {/* header — agent identity (persona · name · health · period) + booking rate */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#f0f0f0] bg-gradient-to-r from-[#faf8ff] to-white px-6 py-4">
              <div className="flex items-center gap-2.5">
                <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-white text-[17px] leading-none shadow-sm">{a.icon}</span>
                <div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p className="text-[14px] font-bold leading-tight text-[#111]">{r.summary.person}</p>
                    <span className="text-[12px] font-medium text-[#9ca3af]">{a.name}</span>
                  </div>
                  <p className="mt-0.5 text-[11px] leading-tight text-[#9ca3af]">Lead → appointment funnel · {periodLabel}</p>
                </div>
              </div>
              <div className="flex items-center gap-2.5 rounded-xl bg-white px-4 py-2 shadow-sm ring-1 ring-[#ece6fb]">
                <div className="text-right leading-tight">
                  {/* canonical wording: appts ÷ qualified is the "Close rate" (was "Booking rate").
                      Fraction (never a rounded "0%") when the numerator is real but rounds to zero. */}
                  <p className="text-[9px] font-bold uppercase tracking-wider text-[#9ca3af]">Close rate</p>
                </div>
                <p className="text-[32px] font-extrabold tabular-nums leading-none text-[#813fed]">{fmtRate(scale(m.appointments), scale(leadQualified))}</p>
              </div>
            </div>

            {/* primary: the lead → qualified → appointment funnel */}
            <div className="px-6 py-6">
              <PerfFunnel
                stages={funnelStages}
                appointmentsDrill={live && scale(m.appointments) > 0 ? openApptDrill : undefined}
              />
            </div>

            {/* secondary: activity — key volume + rates. Outbound adds a Warm leads total (rooftop-wide). */}
            <div className="grid grid-cols-2 divide-x divide-y divide-[#f3f4f6] border-t border-[#f0f0f0] bg-[#fcfcfd] sm:grid-cols-4 sm:divide-y-0">
              <ActivityStat label={inbound ? "Total calls" : "Calls dispatched"} value={fmtInt(scale(m.calls))} hint={`${fmtInt(scale(m.talkMinutes))} mins talk`} />
              <ActivityStat label="Total SMS" value={fmtInt(scale(m.smsSent))} />
              <ActivityStat label="Turn rate" value={fmtRate(scale(leadQualified), scale(leadConnected))} hint="qualified ÷ conversations" accent="#813fed" />
              {inbound
                ? <ActivityStat label="Close rate" value={fmtRate(scale(m.appointments), scale(leadQualified))} hint="AI-booked ÷ qualified" accent="#059669" />
                : <ActivityStat label="Warm leads" value={fmtInt(warmLeadsTotal)} hint="buying intent across campaigns" accent="#059669" />}
            </div>

            {/* tertiary: call breakdown — coverage split + outcome tiles, only what live volume gives us */}
            <div className="border-t border-[#f0f0f0] px-6 py-5">
              <p className="mb-4 text-[11px] font-bold uppercase tracking-wider text-[#6b7280]">Call breakdown</p>

              {/* coverage: during vs after hours as a share bar */}
              {(() => {
                const during = scale(Math.max(0, m.calls - m.afterHours));
                const after = scale(m.afterHours);
                const tot = during + after;
                const dPct = tot ? Math.round((during / tot) * 100) : 0;
                return (
                  <div className="mb-5">
                    <div className="flex h-2 overflow-hidden rounded-full bg-[#f0f0f0]" role="img" aria-label={`${during} calls during hours, ${after} after hours`}>
                      <div style={{ width: `${dPct}%`, background: "#813fed" }} />
                      <div style={{ width: `${100 - dPct}%`, background: "#d8ccf7" }} />
                    </div>
                    <div className="mt-2.5 flex flex-wrap gap-x-6 gap-y-1 text-[11.5px] text-[#6b7280]">
                      <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: "#813fed" }} /><b className="tabular-nums text-[#111]">{fmtInt(during)}</b> during hours</span>
                      <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: "#d8ccf7" }} /><b className="tabular-nums text-[#111]">{fmtInt(after)}</b> after hours</span>
                    </div>
                  </div>
                );
              })()}

              {/* outcomes — Conversations/Qualified are UNIQUE LEADS (same basis as the funnel above), so
                  each label reads one consistent number across the page. Transferred/Callbacks are an
                  inbound concept — outbound agents don't show them; failed transfers stay SEPARATE. */}
              <div className={`grid grid-cols-2 gap-2.5 sm:grid-cols-3 ${inbound ? "lg:grid-cols-5" : "lg:grid-cols-2"}`}>
                {outcomeTiles.map((b) => (
                  <div key={b.label} className="rounded-xl border border-[#f0f0f0] bg-[#fafafa] px-3.5 py-3">
                    <div className="flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 flex-none rounded-full" style={{ background: b.accent }} />
                      <span className="text-[23px] font-extrabold tabular-nums leading-none text-[#111]">{fmtInt(b.value)}</span>
                    </div>
                    <span className="mt-1.5 block text-[11px] leading-tight text-[#6b7280]">{b.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* day-on-day chart (full width) */}
          <Card title="Day-on-day" sub="Touched → Qualified → Appointments, per day">
            <DayTrend points={r.dayOnDay} />
          </Card>

          {/* ── conversations & outcomes ── */}
          {inbound && (r.intentOutcomes?.length ?? 0) > 0 && (
            <>
              <SectionLabel hint="call conversations · totals tie to the funnel">Conversations &amp; outcomes</SectionLabel>
              <Card
                title="What customers wanted & how it was handled"
                sub="Per intent, across real conversations (distinct leads who engaged — lower than total calls, which counts every dial): resolved by the agent, and the hand-offs"
              >
                <IntentOutcomeTable rows={r.intentOutcomes!} totalConversations={leadConnected} />
              </Card>
            </>
          )}

          <SectionLabel>{inbound ? "Inbound operations" : "Outbound campaigns"}</SectionLabel>

          {/* ── Leads by source (inbound + outbound) + speed-to-lead (SALES inbound only) ── */}
          {r.leadsBySource && (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
              <div className={a.id === "sales_ib" ? "lg:col-span-2" : "lg:col-span-3"}>
                <Card title="Leads by source" sub={`${periodLabel} · interacted → total → booked`} pad={false}>
                  <table className="w-full">
                    <thead className="bg-[#fafafa]">
                      <tr>
                        <Th align="left">Source</Th>
                        <Th align="right">Interacted</Th>
                        <Th align="right">Total leads</Th>
                        <Th align="right">Appts booked</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.leadsBySource.map((s) => (
                        <tr key={s.source} className="border-t border-[#f0f0f0] hover:bg-[#faf8ff] transition-colors">
                          <Td align="left"><span className="text-[12.5px] font-semibold text-[#111]">{s.source}</span></Td>
                          <Td align="right"><span className="text-[12.5px] tabular-nums text-[#374151]">{fmtInt(scale(s.engaged))}</span></Td>
                          <Td align="right"><span className="text-[12.5px] tabular-nums font-semibold text-[#111]">{fmtInt(scale(s.total))}</span></Td>
                          <Td align="right"><span className="text-[12.5px] tabular-nums font-semibold text-[#10b981]">{fmtInt(scale(s.appts))}</span></Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              </div>
              {a.id === "sales_ib" && (
                <Card title="Speed to lead" sub="How fast new CRM leads get a first touch">
                  {r.speedToLead && r.speedToLead.medianUnderMin ? (
                    <div className="flex flex-col gap-4">
                      <div>
                        <p className="text-[30px] font-extrabold tabular-nums text-[#813fed] leading-none">{r.speedToLead.avg}</p>
                        <p className="text-[11.5px] text-[#6b7280] mt-1">{r.speedToLead.pctWithin5}% of new leads contacted within 5 min</p>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <SummaryStat label="Leads touched instantly" value={fmtInt(scale(r.speedToLead.instantlyTouched))} accent="#10b981" />
                        <SummaryStat label="After-hours touched instantly" value={fmtInt(scale(r.speedToLead.afterHoursInstant))} />
                        <SummaryStat label="Appointments booked" value={fmtInt(scale(r.speedToLead.instantAppts))} accent="#813fed" />
                        <SummaryStat label="Instant → appointment" value={`${r.speedToLead.instantApptRate}%`} />
                      </div>
                      <StlOpenFunnel data={r.speedToLead.openFunnel} />
                    </div>
                  ) : (
                    <StlUpsell accountName={account.name} teamId={teamId} stl={r.speedToLead} />
                  )}
                </Card>
              )}
            </div>
          )}

          {/* ── Appointments (ONE card: total booked + what's upcoming) — shown ABOVE action items ── */}
          <Card title="Appointments" sub={`${periodLabel} · total booked and what's upcoming`} pad={false}>
            <div className="flex flex-wrap items-end gap-x-10 gap-y-3 border-b border-[#f0f0f0] px-6 py-5">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-[#9ca3af]">Total AI-booked</p>
                {live && scale(m.appointments) > 0 ? (
                  <button onClick={openApptDrill} className="group/appt mt-1 block text-left" title="See the appointments behind this number">
                    <span className="text-[34px] font-extrabold tabular-nums leading-none text-[#10b981] underline decoration-dotted decoration-[#10b981]/40 underline-offset-4 group-hover/appt:decoration-[#10b981]">{fmtInt(scale(m.appointments))}</span>
                    <span className="ml-2 align-middle text-[11px] font-semibold text-[#10b981]">view leads ↗</span>
                  </button>
                ) : (
                  <p className="mt-1 text-[34px] font-extrabold tabular-nums leading-none text-[#10b981]">{fmtInt(scale(m.appointments))}</p>
                )}
              </div>
              {scale(m.appointmentsAssisted ?? 0) > 0 && (
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-[#9ca3af]">AI-assisted (CRM)</p>
                  <p className="mt-1 text-[25px] font-bold tabular-nums leading-none text-[#9ca3af]">+{fmtInt(scale(m.appointmentsAssisted ?? 0))}</p>
                </div>
              )}
            </div>
            <p className="px-6 pt-4 pb-1 text-[10px] font-bold uppercase tracking-wider text-[#9ca3af]">Upcoming</p>
            <UpcomingAppointments teamId={teamId} enterpriseId={enterpriseId} spyneToken={spyneToken} service={a.dept === "Service" ? "service" : "sales"} />
          </Card>

          {/* ── Action items — BELOW appointments ── */}
          <Card title="Action items" sub="Open follow-up tasks the AI logged — work these next" pad={false}>
            <AgentActionItems
              teamId={teamId}
              service={a.dept === "Service" ? "service" : "sales"}
              spyneToken={spyneToken}
              start={win.start}
              end={win.end}
              onViewAll={() => goCrossPage("actions", { enterpriseId, teamId, serviceType: a.dept === "Service" ? "service" : "sales" }, `/reports/action-items${navQuery}`)}
            />
          </Card>

          {/* ── Outbound-only: active campaigns + no-interaction ── */}
          {!inbound && (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <Card title="Active campaigns" sub="What this agent is working on right now" pad={false}>
                  {r.activeCampaigns?.length ? (
                    <>
                      <div className="flex items-baseline gap-2 border-b border-[#f0f0f0] px-6 py-3">
                        <span className="text-[23px] font-extrabold tabular-nums text-[#813fed]">{fmtInt(warmLeadsTotal)}</span>
                        <span className="text-[11.5px] text-[#6b7280]">warm leads engaged across {r.activeCampaigns.length} campaign{r.activeCampaigns.length === 1 ? "" : "s"}</span>
                      </div>
                      <CampaignsTable items={r.activeCampaigns} />
                    </>
                  ) : (
                    <EmptyState icon="📣" title="No active campaigns" body="This rooftop isn't running any outbound campaigns yet." />
                  )}
                </Card>
              </div>
              <Card title="Outbound outcomes" sub="Where every worked lead stands — best outcome first">
                {r.outcomes?.length ? (
                  <OutcomesTableTracked slices={r.outcomes} teamId={teamId} agent={a.id} />
                ) : (
                  <EmptyState icon="📊" title="No outbound activity yet" body="The outbound outcome breakdown appears once this rooftop starts outbound calling." />
                )}
              </Card>
            </div>
          )}

          {/* ── Hot & warm leads for THIS agent (named appointments are consolidated into the single
                 "Appointments" card above — total + upcoming, one card, not two) ── */}
          {(r.warmLeads?.length ?? 0) > 0 && (
            <Card title="Hot & warm leads — work these now" sub="Buying intent on record, no appointment yet">
              <WarmLeadChips items={r.warmLeads!} teamId={teamId} maxHot={10} maxWarm={8} />
            </Card>
          )}

          {/* multi-day reply effectiveness */}
          {r.multiDayReply.length > 0 && (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <Card title="Multi-day reply effectiveness" sub="When replies land, relative to the first touch">
                <TrendBars values={r.multiDayReply.map((d) => d.pct)} labels={r.multiDayReply.map((d) => d.day)} height={96} />
                <p className="mt-3 text-[11px] text-[#6b7280]">
                  {r.multiDayReply[0].pct}% of replies arrive the same day — the rest justify the multi-day cadence.
                </p>
              </Card>
            </div>
          )}

          <SectionLabel>Quality &amp; trend</SectionLabel>

          {/* quality health — only the live-backed cells; nothing fabricated, no placeholders */}
          <Card title="Conversation quality" sub="From live calls — the metrics we can measure today">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <QCell label={a.quality.primaryLabel} value={`${a.quality.primary}%`} />
              <QCell label="Avg handle time" value={a.quality.handleTime} />
              <QCell label="Opt-outs" value={fmtInt(scale(m.optOuts))} />
              {showTransferQuality && tq && (
                <QCell
                  label={a.quality.fourthLabel}
                  value={fmtRate(tq.transfers_ok, tq.transfers_ok + tq.transfers_failed)}
                  status={tq.success_rate! >= 0.8 ? "green" : tq.success_rate! >= 0.6 ? "amber" : "red"}
                />
              )}
            </div>
          </Card>

          {/* hourly + 7-day trend */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card title="Time-of-day distribution" sub="When the activity happens (business hours)">
              <TrendBars values={a.hourly} labels={HOUR_LABELS} height={88} />
            </Card>
            <Card title="7-day trend" sub={a.headlineLabel}>
              <TrendBars values={a.trend7} labels={["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]} highlightLast height={88} />
            </Card>
          </div>

          {/* highlights & missed — rooftop-level, from ClickHouse via /api/reports/metrics; renders
              only when the snapshot has rows (no placeholder). */}
          {(agentHighlights.length > 0 || showMissed) && (
          <Card title="Highlights & missed opportunities" sub="Standout moments worth a closer look" pad={false}>
              <div className={showMissed ? "grid grid-cols-1 sm:grid-cols-2" : "grid grid-cols-1"}>
                <div className={`px-6 py-5 ${showMissed ? "sm:border-r sm:border-[#f0f0f0]" : ""}`}>
                  <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-[#059669]">Wins · best booked {inbound ? "inbound" : "outbound"} calls</p>
                  {agentHighlights.length ? (
                    <ul className="mt-3 space-y-2.5">
                      {agentHighlights.slice(0, 5).map((h, i) => (
                        <li key={i} className="flex items-start justify-between gap-3 text-[12.5px] leading-snug">
                          <span className="text-[#374151]">{h.title || "—"}</span>
                          <span className="shrink-0 tabular-nums text-[11px] text-[#9ca3af]">{h.occurred_on ?? ""}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-3 text-[12px] text-[#9ca3af]">No standout booked calls in this window.</p>
                  )}
                </div>
                {showMissed && (
                  <div className="px-6 py-5">
                    <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-[#b45309]">Missed · outbound demand that slipped</p>
                    <ul className="mt-3 space-y-2.5">
                      {metrics!.missed.map((mm, i) => (
                        <li key={i} className="flex items-center justify-between text-[12.5px]">
                          <span className="text-[#374151]">
                            {MISSED_LABELS[mm.category] ?? mm.category} <span className="text-[#9ca3af]">· {mm.channel}</span>
                          </span>
                          <b className="tabular-nums text-[#111]">{fmtInt(mm.count)}</b>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
          </Card>
          )}

          </>
          )}
          </>
          )}
          </>
          )}
        </main>
      </div>
      <MeetingsModal
        open={apptModal !== null}
        onClose={() => setApptModal(null)}
        title={apptModal?.title ?? "Appointments"}
        sub={apptModal?.sub}
        fetchOpts={{ teamId, enterpriseId, service: apptModal?.service ?? "both", agentType: apptModal?.agentType, scope: "window", ...meetingWindow, spyneToken }}
      />
    </div>
  );
}

/* ── Performance helpers ── */
/* Lead → qualified → appointment funnel: narrowing proportional bars with the step-to-step conversion
 * rate, so the drop-off reads at a glance. */
function PerfFunnel({ stages, appointmentsDrill }: { stages: { label: string; value: number }[]; appointmentsDrill?: () => void }) {
  const max = Math.max(1, stages[0]?.value ?? 1);
  return (
    <div className="flex flex-col gap-2.5">
      {stages.map((s, i) => {
        const pct = Math.max(2, (s.value / max) * 100);
        const prev = i > 0 ? stages[i - 1].value : null;
        const conv = prev && prev > 0 ? Math.round((s.value / prev) * 100) : null;
        const isLast = i === stages.length - 1;
        // The appointments stage (last) drills into the leads behind the number.
        const drillable = isLast && !!appointmentsDrill;
        return (
          <div key={s.label} className="flex items-center gap-3 sm:gap-4">
            {/* number + label */}
            <div className="w-[120px] flex-none sm:w-[150px]">
              {drillable ? (
                <button onClick={appointmentsDrill} className="group/appt block text-left" title="See the appointments behind this number">
                  <p className="text-[27px] font-extrabold tabular-nums leading-none text-[#10b981] underline decoration-dotted decoration-[#10b981]/40 underline-offset-4 group-hover/appt:decoration-[#10b981] sm:text-[30px]">
                    {fmtInt(s.value)}
                  </p>
                  <p className="mt-1 text-[11px] font-semibold leading-tight text-[#10b981]">{s.label} · view leads ↗</p>
                </button>
              ) : (
                <>
                  <p className={`text-[27px] font-extrabold tabular-nums leading-none sm:text-[30px] ${isLast ? "text-[#10b981]" : "text-[#111]"}`}>
                    {fmtInt(s.value)}
                  </p>
                  <p className="mt-1 text-[11px] leading-tight text-[#6b7280]">{s.label}</p>
                </>
              )}
            </div>
            {/* step conversion (from the stage above) */}
            <div className="w-[40px] flex-none text-right sm:w-[46px]">
              {conv !== null && (
                <span className="rounded-full bg-[#f3eaff] px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-[#813fed]" title="conversion from the previous step">
                  {conv}%
                </span>
              )}
            </div>
            {/* proportional bar */}
            <div className="flex flex-1 items-center">
              <div
                className="h-8 rounded-lg transition-all"
                style={{
                  width: `${pct}%`,
                  minWidth: 10,
                  background: isLast ? "linear-gradient(90deg,#10b981,#059669)" : "linear-gradient(90deg,#813fed,#6366f1)",
                  opacity: 1 - i * 0.06,
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ActivityStat({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: string }) {
  return (
    <div className="px-6 py-5">
      <p className="text-[10px] font-bold uppercase tracking-wider text-[#9ca3af]">{label}</p>
      <p className="mt-1.5 text-[27px] font-extrabold tabular-nums leading-none" style={{ color: accent ?? "#111" }}>{value}</p>
      {hint && <p className="mt-1.5 text-[10.5px] text-[#6b7280]">{hint}</p>}
    </div>
  );
}

/* ── live-data toolbar helpers ── */
function relTime(then: number, now: number): string {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 45) return "just now";
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

/* ── shimmer skeleton while a rooftop/window loads ── */
function ReportSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <div key={i} className="h-24 animate-pulse rounded-2xl bg-[#eef0f3]" />)}
      </div>
      <div className="h-[120px] animate-pulse rounded-2xl bg-[#eef0f3]" />
      <div className="h-[272px] animate-pulse rounded-2xl bg-[#eef0f3]" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="h-[220px] animate-pulse rounded-2xl bg-[#eef0f3]" />
        <div className="h-[220px] animate-pulse rounded-2xl bg-[#eef0f3]" />
      </div>
    </div>
  );
}

/* ── empty state: rooftop has data, but none in the selected window ── */
function NoActivity({ name, onWiden }: { name: string; onWiden: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[#e0e0e0] bg-[#fcfcfd] px-6 py-16 text-center">
      <span className="text-[26px] leading-none">📭</span>
      <p className="text-[14px] font-bold text-[#111]">No activity for {name} in this window</p>
      <p className="max-w-[420px] text-[12.5px] leading-snug text-[#6b7280]">There were no calls in the selected date range. Try a wider window.</p>
      <button onClick={onWiden} className="mt-2 rounded-lg border border-[#e5e7eb] bg-white px-3 py-1.5 text-[12px] font-semibold text-[#813fed] hover:bg-[#faf8ff]">
        View last 30 days
      </button>
    </div>
  );
}

/* ── Rooftop selected, but Metabase has no data flowing for it yet ── */
function RooftopComingSoon({ name }: { name: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-3xl border border-[#ece6fb] bg-gradient-to-br from-[#f6f1ff] to-white px-6 py-20 text-center shadow-sm">
      <span className="text-[34px] leading-none">🛠️</span>
      <p className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-[#813fed]">Coming soon</p>
      <p className="text-[20px] font-extrabold tracking-[-0.02em] text-[#111]">{name}&apos;s report is on its way</p>
      <p className="max-w-[480px] text-[13px] leading-snug text-[#6b7280]">
        As soon as your agents start handling calls and messages, your full report fills in here automatically —
        usually within a day of going live. There&apos;s nothing for you to set up.
      </p>
    </div>
  );
}

/* ── First-time experience — nothing set up yet ── */
function FirstTimeAgents({ agent }: { agent: AgentData }) {
  const person = agent.report.summary.person;
  return (
    <>
      <section className="rounded-3xl border border-[#ece6fb] bg-gradient-to-br from-[#f6f1ff] to-white px-8 py-9 shadow-sm">
        <p className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-[#813fed]">Welcome</p>
        <h2 className="mt-1.5 text-[26px] font-extrabold tracking-[-0.02em] text-[#111]">Let’s get your first AI agent live</h2>
        <p className="mt-2 max-w-[580px] text-[13.5px] leading-snug text-[#6b7280]">
          Connect your CRM and capture your baseline — then {person} starts touching every lead instantly, around the
          clock. Your report fills in from the first call.
        </p>
        <div className="mt-7 grid gap-8 md:grid-cols-2">
          <StepList
            steps={[
              { label: "Connect your CRM", active: true },
              { label: "Capture your 90-day baseline" },
              { label: `Configure ${person}` },
              { label: "Go live" },
            ]}
          />
          <div className="flex items-end">
            <button className="rounded-xl bg-[#813fed] px-5 py-2.5 text-[13px] font-bold text-white transition-colors hover:bg-[#6d28d9]">
              Start setup →
            </button>
          </div>
        </div>
      </section>
      <SectionLabel>What your report will look like</SectionLabel>
      <GhostPreview
        title="Your report appears here once an agent is live"
        body="Three pitches vs industry, the dollars created, your before/after, and the full call-and-intent flow — all live."
      />
    </>
  );
}

/* ── Onboarding — importing history, agent not yet live ── */
function OnboardingAgents({ agent, view }: { agent: AgentData; view: ScenarioView }) {
  const r = agent.report;
  const person = r.summary.person;
  return (
    <>
      <Card title={`Setting up ${person}`} sub="We’re importing your CRM history and configuring the agent.">
        <div className="flex flex-col gap-5">
          <div>
            <div className="mb-1.5 flex items-center justify-between text-[12px]">
              <span className="text-[#6b7280]">Importing your last 90 days from the CRM</span>
              <b className="tabular-nums text-[#111]">{view.importProgress}%</b>
            </div>
            <ProgressBar pct={view.importProgress} />
          </div>
          <StepList
            steps={[
              { label: "Connect your CRM", done: true },
              { label: "Import 90-day history", active: true },
              { label: `Configure ${person}`, done: true },
              { label: "Go live" },
            ]}
          />
          <div className="rounded-xl bg-[#f0fdf6] px-4 py-3 text-[12px] text-[#065f46]">
            <b>{view.liveLabel}.</b> Your live numbers start filling in the moment {person} works its first lead.
          </div>
        </div>
      </Card>

      <SectionLabel hint="captured from your CRM at onboarding">Your starting point — today, without {person}</SectionLabel>
      <ComingSoon title="Your 90-day baseline" note={`Your pre-${person} numbers populate here as soon as the CRM import finishes.`} />

      <SectionLabel>Your live report (preview)</SectionLabel>
      <GhostPreview
        title={`${person}’s report unlocks at go-live`}
        body="Calls, appointments, the call-and-intent flow and your before/after all populate here once the agent starts working leads."
      />
    </>
  );
}

function SummaryStat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-xl border border-[#f0f0f0] px-3 py-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-[#9ca3af]">{label}</p>
      <p className="mt-0.5 text-[18px] font-bold tabular-nums" style={{ color: accent ?? "#111" }}>{value}</p>
    </div>
  );
}

/* Open-funnel split for Sales Inbound: appointments booked / leads handled, per acquisition path.
 * Renders nothing when the data isn't populated — no placeholder. */
function StlOpenFunnel({ data }: { data?: { stlLeadsHandled: number; stlAppts: number; stlRate: number; followupLeadsHandled: number; followupAppts: number; followupRate: number } }) {
  if (!data) return null;
  return (
    <div className="border-t border-[#f0f0f3] pt-4">
      <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-[#9ca3af]">Leads handled → appointments booked <span className="font-semibold normal-case text-[#c4c4cc]">· all-time</span></p>
      <div className="grid grid-cols-2 gap-3">
        <SummaryStat label="Via speed-to-lead" value={`${fmtInt(data.stlAppts)} / ${fmtInt(data.stlLeadsHandled)}`} accent="#813fed" />
        <SummaryStat label="Via follow-ups" value={`${fmtInt(data.followupAppts)} / ${fmtInt(data.followupLeadsHandled)}`} accent="#10b981" />
        <SummaryStat label="STL booked rate" value={`${data.stlRate}%`} />
        <SummaryStat label="Follow-up booked rate" value={`${data.followupRate}%`} />
      </div>
    </div>
  );
}

/* Ranked outbound-outcomes table + a once-per-mount "viewed" event (depth signal). */
function OutcomesTableTracked({ slices, teamId, agent }: { slices: NonNullable<AgentData["report"]["outcomes"]>; teamId: string; agent: string }) {
  useEffect(() => { track("outcome_table_viewed", { team_id: teamId, agent }); }, [teamId, agent]);
  return <RankedOutcomeTable slices={slices} />;
}

function QCell({ label, value, status }: { label: string; value: string; status?: "green" | "amber" | "red" }) {
  return (
    <div className="rounded-xl border border-[#f0f0f0] px-4 py-3">
      <div className="flex items-center gap-1.5">
        {status && <span className="h-2 w-2 rounded-full" style={{ background: RAG_STYLE[status].dot }} />}
        <p className="text-[11px] font-semibold uppercase tracking-wider text-[#9ca3af]">{label}</p>
      </div>
      <p className="mt-1 text-[21px] font-bold tabular-nums text-[#111]">{value}</p>
    </div>
  );
}

/* ── Upcoming appointments (live ← Spyne leads/dealer/v3/meetings) ──
 * Scoped to the agent's DEPARTMENT (sales meetings on Sales agents, service on Service) so a service
 * rooftop's bookings don't leak onto the Sales cards. From now forward. Self-fetches so the card stays
 * live regardless of the Q12227 aggregate; degrades to the empty state on no-data / error. */
function UpcomingAppointments({ teamId, enterpriseId, spyneToken, service }: { teamId: string; enterpriseId: string; spyneToken: string; service: "sales" | "service" }) {
  const [state, setState] = useState<{ loading: boolean; meetings: Meeting[] }>({ loading: true, meetings: [] });
  useEffect(() => {
    let on = true;
    // reset to the loading state whenever the rooftop/token changes, then refetch (stale-while-revalidate
    // isn't worth it here — upcoming bookings are small and change rarely)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!teamId) { setState({ loading: false, meetings: [] }); return; }
    setState({ loading: true, meetings: [] });
    fetchMeetings({ teamId, enterpriseId, service, scope: "upcoming", spyneToken })
      .then((r) => { if (on) setState({ loading: false, meetings: r.meetings }); })
      .catch(() => { if (on) setState({ loading: false, meetings: [] }); });
    return () => { on = false; };
  }, [teamId, enterpriseId, spyneToken, service]);

  if (state.loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-[#e5e7eb] border-t-[#813fed]" role="status" aria-label="Loading" />
      </div>
    );
  }
  if (!state.meetings.length) {
    return <div className="p-6"><EmptyState icon="📅" title="No upcoming appointments" body="No booked appointments for this rooftop yet — they'll appear here as the agent books them." /></div>;
  }
  return <div className="max-h-[360px] overflow-y-auto"><MeetingsList meetings={state.meetings} /></div>;
}

/* ── Action items (live ← /api/action-items) — open follow-up tasks the AI logged, scoped to the agent's
 * department. Replaces the old "priority follow-ups / callbacks" card. Shows live open/overdue/due-today
 * counts for the window plus the open queue; degrades to an empty state on no-data / error. */
function AgentActionItems({
  teamId, service, spyneToken, start, end, onViewAll,
}: {
  teamId: string; service: "sales" | "service"; spyneToken: string; start: string; end: string; onViewAll: () => void;
}) {
  const [stats, setStats] = useState<ActionItemStats | null>(null);
  const [items, setItems] = useState<ActionItem[] | null>(null);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let on = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!teamId) { setStats(null); return; }
    fetchActionItemStats(teamId, { start, end, service, spyneToken }).then((r) => { if (on) setStats(r?.stats ?? null); });
    return () => { on = false; };
  }, [teamId, service, spyneToken, start, end]);

  useEffect(() => {
    let on = true;
    // reset to the loading state on a rooftop/dept change, then refetch the open queue
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!teamId) { setItems([]); return; }
    setItems(null);
    fetchActionItems(teamId, { scope: "open", service, limit: 100, spyneToken }).then((r) => { if (on) setItems(r); });
    return () => { on = false; };
  }, [teamId, service, spyneToken]);

  const isOverdue = (a: ActionItem) => !a.completed && !!a.dueAt && new Date(a.dueAt).getTime() < now;
  const counts: { label: string; value?: number; accent: string }[] = [
    { label: "Open", value: stats?.open, accent: "#2563eb" },
    { label: "Overdue", value: stats?.overdue, accent: "#dc2626" },
    { label: "Due today", value: stats?.dueToday, accent: "#ea760c" },
  ];

  return (
    <div className="flex flex-col">
      {/* live counts for the selected window */}
      <div className="flex flex-wrap gap-2 border-b border-[#f0f0f0] px-6 py-3.5">
        {counts.map((c) => (
          <span key={c.label} className="inline-flex items-baseline gap-1.5 rounded-lg border border-[#f0f0f0] bg-[#fafafa] px-2.5 py-1">
            <b className="text-[17px] font-extrabold tabular-nums leading-none" style={{ color: c.accent }}>{stats ? fmtInt(c.value ?? 0) : "—"}</b>
            <span className="text-[10.5px] font-semibold uppercase tracking-wide text-[#9ca3af]">{c.label}</span>
          </span>
        ))}
      </div>

      {/* open queue */}
      {items === null ? (
        <div className="flex items-center justify-center py-12">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-[#e5e7eb] border-t-[#813fed]" role="status" aria-label="Loading" />
        </div>
      ) : items.length === 0 ? (
        <div className="p-6"><EmptyState icon="✅" title="No open action items" body="No follow-up tasks open for this rooftop right now — they'll appear here as the AI logs them." /></div>
      ) : (
        <div className="max-h-[320px] divide-y divide-[#f3f4f6] overflow-y-auto">
          {items.map((a) => {
            const overdue = isOverdue(a);
            return (
              <div key={a.id} className="flex items-center justify-between gap-3 px-6 py-3">
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-semibold text-[#111]">{a.customer || "—"}</p>
                  <p className="truncate text-[11px] text-[#6b7280]">{a.description || prettyIntent(a.intent)}</p>
                </div>
                <div className="flex-none text-right">
                  <PriorityPill priority={a.priority} />
                  <p className={`mt-0.5 text-[10.5px] tabular-nums ${overdue ? "font-semibold text-[#dc2626]" : "text-[#9ca3af]"}`}>
                    {a.dueAt ? fmtWhenShort(a.dueAt) : "—"}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* jump to the full action-items tab */}
      <div className="border-t border-[#f0f0f0] px-6 py-3">
        <button onClick={onViewAll} className="text-[11.5px] font-semibold text-[#813fed] hover:underline">View all action items →</button>
      </div>
    </div>
  );
}

// Sentence-case an intent code for the "what to do" line when there's no free-text description.
function prettyIntent(raw: string): string {
  if (!raw) return "Follow up";
  const s = raw.replace(/_/g, " ").trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function PriorityPill({ priority }: { priority: string }) {
  const v = (priority || "").toUpperCase();
  const c = v.startsWith("H") ? { bg: "#fee2e2", fg: "#991b1b" } : v.startsWith("M") ? { bg: "#fef3c7", fg: "#92400e" } : { bg: "#f3f4f6", fg: "#6b7280" };
  return <span className="rounded-full px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wide" style={{ background: c.bg, color: c.fg }}>{priority || "—"}</span>;
}

/* ── Best campaigns (Supabase ← card 12232) ── */
function CampaignsTable({ items }: { items: ActiveCampaign[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead className="border-b border-[#f0f0f0]">
          <tr>
            <Th>Campaign</Th>
            <Th align="right">Enrolled</Th>
            <Th align="right">Appts</Th>
            <Th align="right">Appt rate</Th>
            <Th align="right">Warm</Th>
            <Th align="right">Opt-outs</Th>
          </tr>
        </thead>
        <tbody>
          {items.map((c, i) => (
            <tr key={i} className="border-b border-[#f7f7f9] last:border-0">
              <Td>
                <p className="text-[12.5px] font-semibold text-[#111]">{c.name}</p>
                <p className="text-[10.5px] text-[#9ca3af]">{c.useCase}</p>
              </Td>
              <Td align="right"><span className="text-[12.5px] tabular-nums text-[#111]">{fmtInt(c.enrolled)}</span></Td>
              <Td align="right"><span className="text-[12.5px] tabular-nums text-[#111]">{fmtInt(c.appts)}</span></Td>
              <Td align="right"><span className="text-[12.5px] font-semibold tabular-nums text-[#10b981]">{c.apptRate}%</span></Td>
              <Td align="right"><span className="text-[12.5px] tabular-nums text-[#6b7280]">{fmtInt(c.warmLeads)}</span></Td>
              <Td align="right"><span className="text-[12.5px] tabular-nums text-[#6b7280]">{fmtInt(c.optOuts)}</span></Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
