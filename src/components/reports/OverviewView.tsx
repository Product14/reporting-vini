"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  BUCKET_LABELS,
  Card,
  ComingSoon,
  DateFilter,
  Eyebrow,
  fmtInt,
  GhostPreview,
  ReportTopBar,
  SectionLabel,
  StepList,
} from "@/components/reports/kit";
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
  RecentConversationsCard,
  ValueTile,
  WarmLeadChips,
  WarmLeadsModal,
} from "@/components/reports/kitV3";
import { useScenario, type ScenarioView } from "@/components/reports/scenario";
import { fetchAgents, fetchActionItems, fetchActionItemStats, fetchConversations, agentsForAccount, aggregateFleet, addDay, peekAgents, tzShortLabel, type FetchResult, type ActionItem, type ActionItemStats, type ActionItemCloser, type Conversation } from "@/components/reports/liveData";
import { useDateRange, useDept, reportNavQuery } from "@/components/reports/dateRange";
import { useCustomize, CustomizeToggle, CustomizeSections, CustomizeModal, Hideable, type SectionDef, type CustomizeGroup } from "@/components/reports/customize";
import { goCrossPage } from "@/components/reports/parentNav";
import { track } from "@/lib/analytics";

// Customizable section ids for the Overview (stable module constant → identity-stable across renders).
const OVERVIEW_SECTION_IDS = ["value", "agents", "work", "conversations"];

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
  const { scenario, view, teamId, account, spyneToken, spyneEnv, enterpriseId } = useScenario();


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
    if (!teamId) return; // no rooftop selected → leave feed as-is (UI shows the no-rooftop state)
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
  const { dept, locked } = useDept(); // top-level scope (shared header, URL-persisted)
  const svc = dept === "all" ? "both" : dept;

  // Action-item scoreboard (created/closed for the window + open/overdue/due-today now + who-closed-most).
  // Fetched separately from /api/action-items (direct ClickHouse), keyed on the server-resolved window so
  // it matches the report's dates. null until loaded / on error → the tile + section show "—".
  const [aiStats, setAiStats] = useState<{ stats: ActionItemStats; closers: ActionItemCloser[] } | null>(null);
  useEffect(() => {
    // Wait for the server-resolved window (feed.start/end) before fetching, so the tile never flashes a
    // count for the wrong (server-default) window on cold load.
    if (!teamId || !feed?.start || !feed?.end) { setAiStats(null); return; }
    let on = true;
    fetchActionItemStats(teamId, { start: feed.start, end: feed.end, service: svc, spyneToken, spyneEnv }).then((r) => { if (on) setAiStats(r); });
    return () => { on = false; };
  }, [teamId, feed?.start, feed?.end, svc, spyneToken, spyneEnv]);

  // Open action items → the "Work these now" queue (overdue / soonest-due first). Separate from the
  // scoreboard counts above; a small named list the team can action directly.
  const [openItems, setOpenItems] = useState<ActionItem[]>([]);
  useEffect(() => {
    if (!teamId) { setOpenItems([]); return; }
    let on = true;
    fetchActionItems(teamId, { scope: "open", service: svc, limit: 40, spyneToken }).then((r) => { if (on) setOpenItems(r); });
    return () => { on = false; };
  }, [teamId, svc, spyneToken]);
  // Items with a due date, soonest first (so overdue surfaces at the top); undated ones drop off the queue.
  const workItems = useMemo(
    () => openItems.filter((i) => i.dueAt).sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime()),
    [openItems],
  );

  // Recent conversations (calls + SMS) for the Overview preview list + drawer, scoped to dept + window.
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  useEffect(() => {
    if (!teamId) { setConversations([]); return; }
    let on = true;
    setConversations(null);
    // Bound BOTH ends of the window (server-resolved store-local feed.start/end) so "Yesterday" shows
    // yesterday's conversations, not everything since yesterday-through-now (RETCONVAI-4152).
    fetchConversations(teamId, { channel: "both", service: svc, since: feed?.start, end: feed?.end, limit: 12, spyneToken, spyneEnv }).then((r) => { if (on) setConversations(r); });
    return () => { on = false; };
  }, [teamId, svc, feed?.start, feed?.end, spyneToken, spyneEnv]);

  // Scope to the agents this rooftop runs, then to the selected department, then aggregate.
  const allAgents = useMemo(() => agentsForAccount(feed?.agents ?? [], account), [feed, account]);
  const agents = useMemo(() => (dept === "all" ? allAgents : allAgents.filter((a) => a.dept.toLowerCase() === dept)), [allAgents, dept]);
  const fleet = useMemo(() => aggregateFleet(agents, feed?.prior), [agents, feed]);

  const hasTeam = teamId !== "";
  // Carries team scope + the selected window into the tab links and the per-agent drill-down, so the
  // chosen date range survives navigation to the By-agent view.
  const navQuery = reportNavQuery(teamId, bucket, custom, dept, locked);
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
  const comingSoon = hasTeam && feed !== null && !degraded && !(feed.everLive ?? feed.hasData);
  const showReport = scenario !== "first_time" && scenario !== "onboarding";
  const liveReady = showReport && hasTeam && feed !== null && !degraded && !comingSoon;
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

  // Agent drill-down — internal (/reports/ root: By-agent lives in the same iframe) navigates the app's
  // own route; parent (/overview/, standalone) breaks out to the parent console's Reports page instead,
  // since that view is now a different iframe entirely.
  const openAgent = (agentId: string) => {
    track("agent_opened", { team_id: teamId, agent: agentId });
    const internalPath = `/reports/agents${navQuery}${navQuery ? "&" : "?"}agent=${agentId}`;
    if (agentLinkMode === "internal") {
      router.push(internalPath);
    } else {
      goCrossPage("reports", { enterpriseId, teamId, serviceType: dept !== "all" ? dept : undefined, agent: agentId }, internalPath);
    }
  };

  // Customizable layout — the customer can hide/reorder these sections (persisted per rooftop). The
  // manifest drives the Customize modal: sections (reorderable + hideable) + the individual tiles/cards.
  const ctrl = useCustomize("overview", { teamId, enterpriseId, spyneToken }, OVERVIEW_SECTION_IDS);
  const customizeGroups: CustomizeGroup[] = [
    { id: "value", label: "The value delivered", items: [
      { id: "tile.leads", label: "Leads touched" },
      { id: "tile.conversations", label: "Real conversations" },
      { id: "tile.qualified", label: "Qualified leads" },
      { id: "tile.appts", label: "Appointments — AI-booked" },
      { id: "tile.handoffs", label: "Hand-offs to team" },
      { id: "tile.response", label: "Response time" },
      { id: "tile.actions", label: "Action items created" },
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
            <Hideable id="tile.leads" ctrl={ctrl}><ValueTile label="Leads touched" total={fmtInt(fleet.leads)} inbound={fmtInt(split.inbound.leads)} outbound={fmtInt(split.outbound.leads)} delta={fleet.deltas.leads} accent="blue" subtext={<>reached or dialed by the AI</>} /></Hideable>
            <Hideable id="tile.conversations" ctrl={ctrl}><ValueTile label="Real conversations" total={fmtInt(fleet.conversations)} inbound={fmtInt(split.inbound.conversations)} outbound={fmtInt(split.outbound.conversations)} delta={fleet.deltas.conversations} accent="purple" subtext={<>customer spoke or replied — voicemail excluded</>} /></Hideable>
            <Hideable id="tile.qualified" ctrl={ctrl}><ValueTile label="Qualified leads" total={fmtInt(fleet.qualified)} inbound={fmtInt(split.inbound.qualified)} outbound={fmtInt(split.outbound.qualified)} delta={fleet.deltas.qualified} accent="violet" subtext={<>concrete buying intent</>} /></Hideable>
            <Hideable id="tile.appts" ctrl={ctrl}><ValueTile label="Appointments — AI-booked" total={fmtInt(fleet.appointments)} inbound={fmtInt(split.inbound.appointments)} outbound={fmtInt(split.outbound.appointments)} delta={fleet.deltas.appointments} accent="green" subtext={fleet.appointmentsAssisted > 0 ? <>+{fmtInt(fleet.appointmentsAssisted)} AI-assisted (CRM)</> : <>meeting created by the AI</>} onClick={fleet.appointments > 0 ? openApptModal : undefined} /></Hideable>
          </div>
          {/* SECONDARY — operational quality, one compact row */}
          <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
            <Hideable id="tile.handoffs" ctrl={ctrl}><MetricTile label="Hand-offs to team" value={fmtInt(fleet.handoffs)} accent="#2563eb" sub={<>{fmtInt(fleet.transfers)} transfers · {fmtInt(fleet.callbacks)} callbacks</>} title="Completed transfers + requested callbacks. Failed transfers are reported separately." /></Hideable>
            {fleet.responseTimeSec != null && (
              <Hideable id="tile.response" ctrl={ctrl}><MetricTile label="Response time" value={fmtSecs(fleet.responseTimeSec)} accent="#0ea5e9" sub={<>avg first response · speed-to-lead</>} title="Average time from a new lead arriving to the AI's first touch (speed-to-lead, Sales Inbound)." /></Hideable>
            )}
            <Hideable id="tile.actions" ctrl={ctrl}><MetricTile label="Action items created" value={aiStats ? fmtInt(aiStats.stats.created) : "—"} accent="#ea760c" sub={aiStats ? <>{fmtInt(aiStats.stats.completed)} closed · {fmtInt(aiStats.stats.open)} open</> : <>syncing…</>} onClick={() => goCrossPage("actions", { enterpriseId, teamId, serviceType: dept !== "all" ? dept : undefined }, `/reports/action-items${navQuery}`)} title="Follow-up tasks the AI logged for the team this period. Click for the full list." /></Hideable>
            <Hideable id="tile.callstexts" ctrl={ctrl}><MetricTile label="Calls & texts" value={fmtInt(fleet.calls + fleet.smsThreads)} accent="#14b8a6" sub={<>{fmtInt(fleet.calls)} calls · {fmtInt(fleet.smsThreads)} texts</>} title="AI conversations handled across voice and SMS — voice calls + SMS threads (conversations, not individual messages)." /></Hideable>
            <Hideable id="tile.talk" ctrl={ctrl}><MetricTile label="Talk time" value={fmtDuration(fleet.talkMinutes)} accent="#6b7280" sub={<>zero staff minutes spent</>} /></Hideable>
            <Hideable id="tile.afterhours" ctrl={ctrl}><MetricTile label="After-hours captured" value={fmtInt(fleet.afterHours)} accent="#10b981" sub={<>engaged outside working hours</>} /></Hideable>
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
                {feed === null ? "Syncing…" : feed?.fetchedAt ? `Synced ${relTime(feed.fetchedAt, now)}` : ""}
              </span>
            )}
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {ranked.map((a) => {
              const lf = a.leadFunnel;
              const inboundDir = a.dir === "Inbound";
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
                    { label: inboundDir ? "Leads reached" : "Leads dialed", value: lf?.contacted ?? a.report.leadsAttempted },
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
      node: (warmLeads.length > 0 || namedAppts.length > 0 || (aiStats && (aiStats.stats.created > 0 || aiStats.stats.open > 0))) ? (
        <div className="flex flex-col gap-3.5">
          <SectionLabel hint="reviewed, in-market, unworked — the fastest net-new appointments">Work these now</SectionLabel>
          <div className="grid gap-6" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
            {warmLeads.length > 0 && (
              <Hideable id="card.warm" ctrl={ctrl}>
                <Card title="Hot & warm leads" sub="Buying intent on record, no appointment yet — call these first" right={<button onClick={() => setWarmModalOpen(true)} className="no-print rounded-lg border border-[#e5e7eb] bg-white px-3 py-1.5 text-[11.5px] font-semibold text-[#813fed] hover:bg-[#faf8ff]">View all →</button>}>
                  <WarmLeadChips items={warmLeads} teamId={teamId} maxHot={6} maxWarm={5} />
                </Card>
              </Hideable>
            )}
            {namedAppts.length > 0 && (
              <Hideable id="card.appts" ctrl={ctrl}>
              <Card title="Appointments" sub="On the books — AI-booked & AI-assisted" right={<button onClick={() => goCrossPage("appointments", { enterpriseId, teamId }, `/reports/appointments${navQuery}`)} className="no-print rounded-lg border border-[#e5e7eb] bg-white px-3 py-1.5 text-[11.5px] font-semibold text-[#813fed] hover:bg-[#faf8ff]">View all →</button>}>
                <div className="flex flex-col gap-2">
                  {namedAppts.slice(0, 6).map((a, i) => (
                    <div key={`${a.customer}-${i}`} className="flex items-center justify-between gap-3 border-b border-[#f5f5f5] pb-2 last:border-0 last:pb-0">
                      <div className="min-w-0">
                        <p className="truncate text-[12.5px] font-semibold text-[#111]">{a.customer}{a.vehicle ? <span className="ml-2 text-[10.5px] font-normal text-[#9ca3af]">{a.vehicle}</span> : null}</p>
                        <p className="truncate text-[10.5px] font-medium" style={{ color: a.assisted ? "#6d28d9" : "#059669" }}>{a.how}</p>
                      </div>
                      <p className="flex-none text-[11px] tabular-nums text-[#6b7280]">{fmtWhenShort(a.when)}</p>
                    </div>
                  ))}
                  {namedAppts.length > 6 && <p className="text-[11px] font-semibold text-[#9ca3af]">+{namedAppts.length - 6} more on the Appointments tab</p>}
                </div>
              </Card>
              </Hideable>
            )}
          </div>
          {aiStats && (aiStats.stats.created > 0 || aiStats.stats.open > 0) && (
            <Hideable id="card.actions" ctrl={ctrl}>
            <Card title="Action items" sub="Created & closed this window · open, overdue and due-today are live counts" right={<button onClick={() => { track("action_items_opened", { tab: "overview", team_id: teamId }); goCrossPage("actions", { enterpriseId, teamId, serviceType: dept !== "all" ? dept : undefined }, `/reports/action-items${navQuery}`); }} className="no-print rounded-lg border border-[#e5e7eb] bg-white px-3 py-1.5 text-[11.5px] font-semibold text-[#813fed] hover:bg-[#faf8ff]">View all →</button>}>
              <ActionItemsScoreboard stats={aiStats.stats} periodLabel={periodLabel} />
              {workItems.length > 0 && (
                <div className="mt-4 border-t border-[#f3f4f6] pt-3">
                  <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-[#9ca3af]">Overdue / due soon — work these next</p>
                  <ActionItemList items={workItems} max={6} onMore={() => { track("action_items_opened", { tab: "overview", team_id: teamId }); goCrossPage("actions", { enterpriseId, teamId, serviceType: dept !== "all" ? dept : undefined }, `/reports/action-items${navQuery}`); }} />
                </div>
              )}
            </Card>
            </Hideable>
          )}
        </div>
      ) : false,
    },
    {
      id: "conversations",
      label: "Recent conversations",
      node: (
        <div className="flex flex-col gap-3.5">
          <SectionLabel hint={conversations ? `${conversations.length} recent · calls & texts` : "loading…"}>Recent conversations</SectionLabel>
          <RecentConversationsCard items={conversations ?? []} loading={conversations === null} agentNames={agentNames} onViewAll={() => { track("report_tab_clicked", { from: "overview", to: "calls", team_id: teamId }); goCrossPage("conversations", { enterpriseId, teamId }, `/reports/calls${navQuery}`); }} onOpen={(c) => track("call_row_opened", { team_id: teamId, channel: c.channel })} teamId={teamId} />
        </div>
      ),
    },
  ];

  return (
    <div className="flex min-h-screen bg-[#fafafa]">
      <div className="flex flex-1 flex-col">

        <ReportTopBar
          title="Overview"
          subtitle="What your AI agents delivered — appointments, conversations and hand-offs, in one report."
          active="overview"
          teamId={teamId}
          query={navQuery}
          right={
            hasTeam ? (
              <div className="no-print flex items-center gap-3">
                {liveReady && <CustomizeToggle ctrl={ctrl} />}
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
            ) : (
              <span className="rounded-lg bg-[#f3eaff] px-3 py-1.5 text-[12px] font-semibold text-[#813fed]">{view.liveLabel}</span>
            )
          }
        />

        <main className="mx-auto w-full max-w-[1320px] flex-1 px-4 sm:px-6 lg:px-10 pt-7 pb-36 flex flex-col gap-9">
          {scenario === "first_time" && <FirstTimeOverview />}
          {scenario === "onboarding" && <OnboardingOverview view={view} />}

          {showReport && !hasTeam && <NoRooftop />}
          {showReport && hasTeam && (feed === null || degraded) && <OverviewSkeleton />}
          {showReport && hasTeam && comingSoon && (
            <ComingSoon
              title={`${account.name}'s report is on its way`}
              note="Your full report fills in here automatically as soon as your agents start handling calls and messages — usually within a day of going live. Nothing to set up on your end."
            />
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
        {namedAppts.length > 0 ? (
          <NamedApptsTable items={namedAppts} teamId={teamId} />
        ) : (
          <p className="text-[12.5px] text-[#6b7280]">No appointment details for {periodLabel} yet — the counts above are correct; the named list syncs shortly.</p>
        )}
      </Modal>
      {/* Warm-leads "view all" — click a lead to review its conversation (calls + SMS) in the drawer. */}
      <WarmLeadsModal
        open={warmModalOpen}
        onClose={() => setWarmModalOpen(false)}
        items={warmLeads}
        loadConversation={(leadId) => fetchConversations(teamId, { leadId, channel: "both", service: svc, limit: 10, spyneToken, spyneEnv })}
      />
      {/* Customize layout — hide/reorder sections + hide individual cards/tiles (opened from the header). */}
      <CustomizeModal ctrl={ctrl} groups={customizeGroups} accountLabel={account.name} />
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
