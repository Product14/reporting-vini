"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  ActiveCampaign,
  AGENTS as MOCK_AGENTS,
  AgentData,
  agentById,
  Bucket,
  FollowUp,
  Meeting,
  MeetingsList,
  BUCKET_LABELS,
  CalibratingBanner,
  Card,
  ComingSoon,
  EmptyState,
  ConfidenceChip,
  DateFilter,
  DeltaPill,
  fmtInt,
  fmtMoneyFull,
  GhostPreview,
  HOUR_LABELS,
  DayTrend,
  MeetingsModal,
  ProgressBar,
  QueryBars,
  RAG_STYLE,
  ReportTopBar,
  Sankey,
  SectionLabel,
  SplitBar,
  StepList,
  Td,
  Th,
  TrendBars,
} from "@/components/reports/kit";
import { useScenario, ScenarioView } from "@/components/reports/scenario";
import { fetchAgents, fetchMeetings, agentsForAccount, addDay, peekAgents, tzShortLabel, appointmentValue, type FetchResult } from "@/components/reports/liveData";
import { UpsellAgent, StlUpsell } from "@/components/reports/upsell";
import { track } from "@/lib/analytics";

// Palette for the outbound-outcomes SplitBar — outcomes are ranked by volume, so colors are positional.
const OUTCOME_COLORS = ["#6366f1", "#813fed", "#10b981", "#f59e0b", "#0ea5e9", "#94a3b8", "#ef4444", "#14b8a6"];

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
  const [bucket, setBucket] = useState<Bucket>("last30");
  const [custom, setCustom] = useState<{ start: string; end: string } | null>(null);
  // open on the agent passed in; the picker on the page then drives selection locally.
  // An invalid/absent id is corrected by the validity effect below once agents load.
  const [activeId, setActiveId] = useState<string>(paramAgent || "sales_ib");
  // cost per appointment — asked once (stored locally), then editable via a hyperlink
  const [apptCost, setApptCost] = useState<number>(150);
  const [costModalOpen, setCostModalOpen] = useState<boolean>(false);
  const [showDetail, setShowDetail] = useState<boolean>(true);
  // when set, the rooftop doesn't run this agent → show the upsell pitch instead of a report
  const [upsellId, setUpsellId] = useState<string | null>(null);
  // when set, the appointment-count drill-down modal is open (lists the leads behind the number)
  const [apptModal, setApptModal] = useState<{ service: "sales" | "service"; agentType: string; title: string; sub: string } | null>(null);
  // Resolved up-front (before the effects/handlers below that reference teamId for analytics).
  const { scenario, view, teamId, account, spyneToken, enterpriseId } = useScenario();

  useEffect(() => {
    const stored = typeof window !== "undefined" ? window.localStorage.getItem("vini.apptCost") : null;
    if (stored) setApptCost(Number(stored));
    else { setCostModalOpen(true); track("cost_per_appt_prompted", { team_id: teamId }); } // first visit — ask once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const saveApptCost = (v: number) => {
    setApptCost(v);
    if (typeof window !== "undefined") window.localStorage.setItem("vini.apptCost", String(v));
    setCostModalOpen(false);
    track("cost_per_appt_set", { team_id: teamId, cost: v });
  };
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
  const comingSoon = hasTeam && feed !== null && !feed.hasData; // rooftop selected, but no live data yet
  const skeleton = useMemo(() => agentsForAccount(MOCK_AGENTS, account), [account]);
  const visibleAgents = AGENTS.length ? AGENTS : skeleton;
  const a = useMemo(() => agentById(activeId, visibleAgents), [activeId, visibleAgents]);
  // keep the selected agent valid when the rooftop (and thus its agent set) changes
  useEffect(() => {
    if (visibleAgents.length && !visibleAgents.some((ag) => ag.id === activeId)) setActiveId(visibleAgents[0].id);
  }, [visibleAgents, activeId]);
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
  // Only show a $ "value created" when real revenue beats run cost. Both are zeroed today (no Q12227
  // source) → false → show appointments delivered instead of a break-even $ that reads as "no ROI".
  const showDollarValue = m.cost > 0 && m.revenue / m.cost > 1;
  const inbound = a.dir === "Inbound";
  const hasStory = !!(r.benchmarks && r.compare); // story-first treatment for every agent that has it
  const live = view.hasData; // recently_live + repeat render the real report

  // Live data from Metabase is already a window total for the selected bucket (liveData re-queries
  // per bucket), so it must not be re-scaled — factor=1 when live, 0 in the pre-live ghost states.
  const factor = live ? 1 : 0;
  const scale = (n: number) => Math.round(n * factor);
  const periodLabel = custom ? `${custom.start} – ${custom.end}` : scenario === "repeat" ? BUCKET_LABELS[bucket] : view.liveLabel;
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
  // only offer the drill-down when there's a non-zero count to drill into
  const canDrill = live && scale(m.appointments) > 0;
  const agentEmpty = live && hasTeam && !!feed?.hasData && Math.round(scale(m.calls)) === 0;
  // "Turn rate" = qualified / connected. Use the CENTRAL value (build.ts report.qualifiedPct, computed
  // on the unique-lead basis) rather than recomputing inline — keeps it identical to the funnel's
  // qualified→connected step and de-duplicated (was an inline qualified-events / connected-events ratio).
  const turnRate = r.qualifiedPct;

  // Lead journey (Sankey) — UNIQUE LEADS at each stage (same basis as the funnel above), so "Connected"
  // and "Qualified" mean the same thing everywhere on the page. Falls back to event metrics when
  // leadFunnel is absent (mock/no-backend). Flow conserves end-to-end via min/max.
  const sankey = useMemo(() => {
    const total = scale(a.leadFunnel?.contacted ?? r.leadsAttempted);
    const connected = Math.min(total, scale(a.leadFunnel?.connected ?? m.conversations));
    const noConvo = Math.max(0, total - connected);
    const qualified = Math.min(connected, scale(a.leadFunnel?.qualified ?? m.qualified));
    const notQualified = Math.max(0, connected - qualified);
    const booked = Math.min(qualified, scale(a.leadFunnel?.appt ?? m.appointments));
    const nurture = Math.max(0, qualified - booked);
    const columns = [
      [{ id: "total", label: inbound ? "Leads attempted" : "Leads dialed", color: "#813fed" }],
      [
        { id: "connected", label: "Connected", color: "#6366f1" },
        { id: "missed", label: "No conversation", color: "#dc2626" },
      ],
      [
        { id: "qualified", label: "Qualified", color: "#10b981" },
        { id: "notq", label: "Not qualified", color: "#9ca3af" },
      ],
      [
        { id: "booked", label: "Booked", color: "#10b981" },
        { id: "nurture", label: "Nurture", color: "#f59e0b" },
        { id: "lost", label: "Lost / no intent", color: "#9ca3af" },
      ],
    ];
    const links = [
      { from: "total", to: "connected", value: connected },
      { from: "total", to: "missed", value: noConvo },
      { from: "connected", to: "qualified", value: qualified },
      { from: "connected", to: "notq", value: notQualified },
      { from: "qualified", to: "booked", value: booked },
      { from: "qualified", to: "nurture", value: nurture },
      { from: "notq", to: "lost", value: notQualified },
    ];
    return { columns, links };
    // depend on `a` (not a.id) so the flow recomputes when the feed refreshes with new lead counts
  }, [a, factor, inbound]);

  return (
    <div className="flex min-h-screen bg-[#fafafa]">
      <div className="flex flex-1 flex-col">

        <ReportTopBar
          title="Agent performance"
          subtitle="ROI, pipeline and quality by agent — Sales & Service, inbound & outbound."
          active="agents"
          teamId={teamId}
          back={`/reports${teamId ? `?team_id=${teamId}` : ""}`}
          right={
            hasTeam ? (
              <div className="flex items-center gap-3">
                {feed?.timezone ? (
                  <span className="hidden text-[11px] text-[#9ca3af] md:inline" title={`Report days & times use this rooftop's timezone (${feed.timezone})`}>
                    Times in {tzShortLabel(feed.timezone)}
                  </span>
                ) : null}
                <SyncStatus fetchedAt={feed?.fetchedAt ?? null} loading={feed === null} now={now} onRefresh={refresh} />
                <DateFilter
                  bucket={bucket}
                  custom={custom}
                  onPreset={(b) => { setBucket(b); setCustom(null); track("date_range_changed", { tab: "agents", range: b, team_id: teamId }); }}
                  onCustom={(r) => { setCustom(r); track("date_range_changed", { tab: "agents", range: "custom", team_id: teamId }); }}
                />
              </div>
            ) : (
              <span className="rounded-lg bg-[#f3eaff] px-3 py-1.5 text-[12px] font-semibold text-[#813fed]">{view.liveLabel}</span>
            )
          }
        />

        <main className="mx-auto w-full max-w-[1400px] flex-1 px-10 pt-6 pb-36 flex flex-col gap-6">
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

          {scenario !== "first_time" && live && hasTeam && feed === null && <ReportSkeleton />}

          {scenario !== "first_time" && live && hasTeam && comingSoon && <RooftopComingSoon name={account.name} />}

          {scenario !== "first_time" && (!live || (hasTeam && feed !== null && !comingSoon)) && (
          <>
          {/* agent switcher — full-width row of equal pills; the selected one drives the report below */}
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            {visibleAgents.map((ag) => {
              const selected = ag.id === activeId && !upsell;
              return (
                <button
                  key={ag.id}
                  onClick={() => { setActiveId(ag.id); setUpsellId(null); track("agent_switched", { team_id: teamId, agent: ag.id }); }}
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
            <NoActivity name={a.name} onWiden={() => { setBucket("last30"); setCustom(null); track("empty_window_widened", { team_id: teamId, agent: a.id }); }} />
          )}

          {live && !agentEmpty && (
          <>
          {scenario === "recently_live" && (
            <CalibratingBanner
              title={`${r.summary.person} has been live ${view.daysLive} days — these are early numbers.`}
              body="Coverage and speed are real from day one; booking rates and trends keep firming up as volume grows."
            />
          )}

          {/* ── value created (live) → industry benchmarks & before/after (no card yet) ── */}
          {hasStory && (
            <>
              {/* value created — cost per appointment is set once in a modal, editable here */}
              <section className="rounded-3xl border border-[#cdeede] bg-gradient-to-r from-[#f0fdf6] to-white shadow-sm px-7 py-6">
                {showDollarValue ? (
                  <div className="flex flex-wrap items-center justify-between gap-x-10 gap-y-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-[#059669]">
                          Value created · {periodLabel}
                        </p>
                        {scenario !== "repeat" && <ConfidenceChip level={view.confidence} />}
                      </div>
                      <p className="mt-1 text-[42px] font-extrabold tabular-nums leading-none text-[#059669]">
                        {fmtMoneyFull(appointmentValue(scale(m.appointments), apptCost))}
                      </p>
                      <p className="mt-2 text-[12px] text-[#6b7280]">
                        {canDrill ? (
                          <button
                            onClick={openApptDrill}
                            className="font-bold text-[#059669] underline decoration-dotted underline-offset-2 hover:decoration-solid"
                            title="See the appointments behind this number"
                          >
                            {fmtInt(scale(m.appointments))} appointments
                          </button>
                        ) : (
                          <b className="text-[#111]">{fmtInt(scale(m.appointments))} appointments</b>
                        )}{" "}
                        ×{" "}
                        <b className="text-[#111]">{fmtMoneyFull(apptCost)}</b> per appointment{" "}
                        <button
                          onClick={() => { setCostModalOpen(true); track("cost_per_appt_edit_opened", { team_id: teamId }); }}
                          className="ml-1 font-semibold text-[#059669] underline decoration-dotted underline-offset-2 hover:decoration-solid"
                        >
                          Edit
                        </button>
                      </p>
                    </div>
                    <div className="rounded-2xl border border-[#cdeede] bg-white/70 px-5 py-3.5 text-right">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-[#9ca3af]">Your cost / appointment</p>
                      <p className="mt-0.5 text-[22px] font-extrabold tabular-nums text-[#111]">{fmtMoneyFull(apptCost)}</p>
                    </div>
                  </div>
                ) : (
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-[#059669]">
                        Appointments booked · {periodLabel}
                      </p>
                      {scenario !== "repeat" && <ConfidenceChip level={view.confidence} />}
                    </div>
                    {canDrill ? (
                      <button
                        onClick={openApptDrill}
                        className="group/appt mt-1 block text-left"
                        title="See the appointments behind this number"
                      >
                        <span className="text-[42px] font-extrabold tabular-nums leading-none text-[#059669] underline decoration-dotted decoration-[#059669]/40 underline-offset-[6px] group-hover/appt:decoration-[#059669]">
                          {fmtInt(scale(m.appointments))}
                        </span>
                        <span className="ml-2 align-middle text-[11px] font-semibold text-[#059669]">view leads ↗</span>
                      </button>
                    ) : (
                      <p className="mt-1 text-[42px] font-extrabold tabular-nums leading-none text-[#059669]">{fmtInt(scale(m.appointments))}</p>
                    )}
                    <p className="mt-2 max-w-[520px] text-[12px] text-[#6b7280]">
                      From <b className="text-[#111]">{fmtInt(scale(a.leadFunnel?.connected ?? m.conversations))}</b> conversations · <b className="text-[#111]">{fmtInt(scale(a.leadFunnel?.qualified ?? m.qualified))}</b> qualified. Dollar value appears once revenue tracking is on.
                    </p>
                  </div>
                )}
              </section>

              <button
                onClick={() => { const next = !showDetail; setShowDetail(next); track("agent_detail_toggled", { team_id: teamId, agent: a.id, shown: next }); }}
                className="mx-auto mt-1 rounded-lg border border-[#e5e7eb] bg-white px-4 py-2 text-[12px] font-semibold text-[#6b7280] hover:bg-[#faf8ff] hover:text-[#813fed] transition-colors"
              >
                {showDetail ? "Hide detailed metrics ▴" : "Show detailed metrics ▾"}
              </button>
            </>
          )}

          {(!hasStory || showDetail) && (
          <>
          <SectionLabel hint={periodLabel}>Performance</SectionLabel>

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
                  <p className="text-[9px] font-bold uppercase tracking-wider text-[#9ca3af]">Booking rate</p>
                  <DeltaPill delta={r.deltas.abr} />
                </div>
                <p className="text-[28px] font-extrabold tabular-nums leading-none text-[#813fed]">{r.abr}%</p>
              </div>
            </div>

            {/* primary: the lead → qualified → appointment funnel */}
            <div className="px-6 py-6">
              <PerfFunnel
                stages={[
                  // Every stage is a window-DISTINCT lead count (from leadFunnel) so the funnel stays
                  // monotonic (contacted ≥ connected ≥ qualified ≥ appointments) and never double-counts a
                  // lead touched on multiple days. Falls back to event counts only if leadFunnel is absent.
                  { label: inbound ? "Leads attempted" : "Leads dialed", value: scale(r.leadsAttempted), delta: r.deltas.leadsAttempted },
                  { label: "Conversations", value: scale(a.leadFunnel?.connected ?? m.conversations) },
                  { label: "Leads qualified", value: scale(a.leadFunnel?.qualified ?? m.qualified), delta: r.deltas.leadsQualified },
                  { label: "Appointments booked", value: scale(m.appointments), delta: r.deltas.appointments },
                ]}
                appointmentsDrill={live && scale(m.appointments) > 0 ? openApptDrill : undefined}
              />
            </div>

            {/* secondary: activity */}
            <div className="grid grid-cols-3 divide-x divide-[#f3f4f6] border-t border-[#f0f0f0] bg-[#fcfcfd]">
              <ActivityStat label={inbound ? "Total calls" : "Calls dispatched"} value={fmtInt(scale(m.calls))} hint={`${fmtInt(scale(m.talkMinutes))} mins talk`} delta={r.deltas.totalCalls} />
              <ActivityStat label="Total SMS" value={fmtInt(scale(m.smsSent))} delta={r.deltas.totalSms} />
              <ActivityStat label="Turn rate" value={`${turnRate}%`} hint="qualified / connected" />
            </div>

            {/* tertiary: call breakdown — only the buckets we can derive from live volume */}
            <div className="border-t border-[#f0f0f0] px-6 py-4">
              <p className="mb-3 text-[10px] font-bold uppercase tracking-wider text-[#9ca3af]">Call breakdown</p>
              <div className={`grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 ${inbound ? "lg:grid-cols-6" : "lg:grid-cols-4"}`}>
                {[
                  { label: "During hours", value: Math.max(0, m.calls - m.afterHours) },
                  { label: "After hours", value: m.afterHours },
                  // Connected/Qualified are UNIQUE LEADS (same basis as the funnel + Sankey) so each label
                  // reads one consistent number across the page; the other tiles stay call-activity counts.
                  { label: "Connected", value: a.leadFunnel?.connected ?? m.conversations },
                  { label: "Qualified", value: a.leadFunnel?.qualified ?? m.qualified },
                  // Transferred / Callbacks are an inbound concept — outbound agents (Sales/Service OB) don't show them.
                  ...(inbound
                    ? [
                        { label: "Transferred", value: r.callFlow.transferred },
                        { label: "Callbacks", value: r.callFlow.callbacks ?? 0 },
                      ]
                    : []),
                ].map((b) => (
                  <div key={b.label} className="flex flex-col">
                    <span className="text-[18px] font-bold tabular-nums leading-none text-[#111]">{fmtInt(scale(b.value))}</span>
                    <span className="mt-1 text-[11px] text-[#6b7280]">{b.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* day-on-day chart (full width) */}
          <Card title="Day-on-day" sub="Touched → Qualified → Appointments, per day">
            <DayTrend points={r.dayOnDay} />
          </Card>

          <SectionLabel hint={`${r.qualifiedPct}% qualified`}>Conversations &amp; outcomes</SectionLabel>

          {/* lead journey — Sankey centerpiece (unique leads, same basis as the funnel) */}
          <Card
            title="Lead journey"
            sub="How unique leads move: reached → connected → qualified → booked. Ribbon width = leads."
          >
            <Sankey columns={sankey.columns} links={sankey.links} height={300} fmt={(n) => fmtInt(n)} />
          </Card>

          {/* query resolution + top objections */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card title="Query resolution rate" sub="Share of each topic the agent resolved without a human">
              {r.queries.length ? (
                <QueryBars topics={r.queries} />
              ) : (
                <ComingSoon title="Resolution by topic" note="How often the agent resolves each topic without a human — appears once there's tagged conversation activity in the window." />
              )}
            </Card>
            <Card title="Top objections" sub="What the agent heard most">
              <ComingSoon title="Objections, ranked by how often they come up" note="The concerns customers raise most on calls — price, timing, trade-in value — so your team can prepare for them and sharpen its talk tracks." />
            </Card>
          </div>

          <SectionLabel>{inbound ? "Inbound operations" : "Outbound campaigns"}</SectionLabel>

          {/* ── Inbound-only: leads by source (+ speed-to-lead for SALES inbound only) ── */}
          {inbound && r.leadsBySource && (
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
                          <Td align="right"><span className="text-[12.5px] tabular-nums text-[#374151]">{fmtInt(scale(s.interacted))}</span></Td>
                          <Td align="right"><span className="text-[12.5px] tabular-nums font-semibold text-[#111]">{fmtInt(scale(s.total))}</span></Td>
                          <Td align="right"><span className="text-[12.5px] tabular-nums font-semibold text-[#10b981]">{fmtInt(scale(s.appts))}</span></Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              </div>
              {(a.id === "sales_ib" || a.id === "service_ib") && (
                <Card title="Speed to lead" sub="How fast new CRM leads get a first touch">
                  {a.id === "service_ib" ? (
                    // STL is live for Sales Inbound only right now (card 12341 is Sales-IB scoped); show
                    // a coming-soon state for Service Inbound until a service-side funnel exists.
                    <EmptyState icon="⏱️" title="Coming soon" body="Speed-to-lead tracking isn't live for the service inbound agent yet — it'll appear here once enabled." />
                  ) : r.speedToLead && r.speedToLead.medianUnderMin ? (
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

          {/* ── Upcoming appointments + priority follow-ups (rooftop-wide → shown on every agent) ── */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <Card title="Upcoming appointments" sub="Every booking the agent set, with customer and vehicle" pad={false}>
                <UpcomingAppointments teamId={teamId} enterpriseId={enterpriseId} spyneToken={spyneToken} />
              </Card>
              <Card title="Priority follow-ups" sub="Callbacks the agent flagged" pad={false}>
                {r.followUps?.length ? (
                  <CallbacksList items={r.followUps} />
                ) : (
                  <EmptyState icon="📞" title="No callbacks flagged" body="No follow-ups flagged for this rooftop right now — they'll appear here when the agent flags one." />
                )}
              </Card>
            </div>

          {/* ── Outbound-only: active campaigns + no-interaction ── */}
          {!inbound && (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <Card title="Active campaigns" sub="What this agent is working on right now" pad={false}>
                  {r.activeCampaigns?.length ? (
                    <CampaignsTable items={r.activeCampaigns} />
                  ) : (
                    <EmptyState icon="📣" title="No active campaigns" body="This rooftop isn't running any outbound campaigns yet." />
                  )}
                </Card>
              </div>
              <Card title="Outbound outcomes" sub="How outbound conversations ended">
                {r.outcomes?.length ? (
                  <SplitBar
                    segments={r.outcomes.map((o, i) => ({ label: o.label, value: o.value, color: OUTCOME_COLORS[i % OUTCOME_COLORS.length] }))}
                  />
                ) : (
                  <EmptyState icon="📊" title="No outbound activity yet" body="The outbound outcome breakdown appears once this rooftop starts outbound calling." />
                )}
              </Card>
            </div>
          )}

          {/* multi-day reply effectiveness + channel mix */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card title="Multi-day reply effectiveness" sub="When replies land, relative to the first touch">
              {r.multiDayReply.length ? (
                <>
                  <TrendBars values={r.multiDayReply.map((d) => d.pct)} labels={r.multiDayReply.map((d) => d.day)} height={96} />
                  <p className="mt-3 text-[11px] text-[#6b7280]">
                    {r.multiDayReply[0].pct}% of replies arrive the same day — the rest justify the multi-day cadence.
                  </p>
                </>
              ) : (
                <ComingSoon title="Reply timing" note="When replies land relative to the first touch — appears once this agent has SMS reply activity in the window." />
              )}
            </Card>
            <Card title="Channel mix" sub="Share of contacts by channel">
              <SplitBar
                segments={[
                  { label: "Voice", value: a.channelSplit.voice, color: "#6366f1" },
                  { label: "SMS", value: a.channelSplit.sms, color: "#10b981" },
                ]}
              />
              <p className="mt-4 text-[11.5px] text-[#6b7280]">
                SMS sent: <b className="text-[#111]">{fmtInt(scale(m.smsSent))}</b> · talk time:{" "}
                <b className="text-[#111]">{fmtInt((m.talkMinutes * factor) / 60)}h</b>
                {m.afterHours > 0 && (
                  <>
                    {" "}· after-hours captured: <b className="text-[#111]">{fmtInt(scale(m.afterHours))}</b>
                  </>
                )}
              </p>
            </Card>
          </div>

          <SectionLabel>Quality &amp; trend</SectionLabel>

          {/* quality health — full width (the flow funnel lives in the Sankey above) */}
          <Card title="Conversation quality" sub="From live calls — the metrics we can measure today">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <QCell label={a.quality.primaryLabel} value={`${a.quality.primary}%`} />
              <QCell label="Avg handle time" value={a.quality.handleTime} />
              <QCell label="Opt-outs" value={fmtInt(scale(m.optOuts))} />
              <ComingSoon title="CSAT" inline />
              <ComingSoon title="Positive sentiment" inline />
              <ComingSoon title={a.quality.fourthLabel} inline />
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

          {/* highlights */}
          <Card title="Highlights & missed opportunities" sub="Standout moments worth a closer look" pad={false}>
            <div className="px-6 py-5">
              <ComingSoon title="Your wins — and the ones that got away" note="The best moments the agent caught, plus the deals worth a second look, gathered in one place so you can act on them quickly." />
            </div>
          </Card>

          {/* activity (inbound — calls by reason; outbound campaigns covered above) */}
          {inbound && (
            <Card title={a.activityTitle} sub={periodLabel} pad={false}>
              <div className="px-6 py-5">
                <ComingSoon title="Why customers are calling" note="A breakdown of call reasons — and how often each one turns into a booking — so you can staff and script for what matters most." />
              </div>
            </Card>
          )}
          </>
          )}
          </>
          )}
          </>
          )}
          </>
          )}
        </main>
      </div>
      {costModalOpen && <CostModal initial={apptCost} onSave={saveApptCost} />}
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

/* ── cost-per-appointment — asked once, then editable via the value-created band ── */
function CostModal({ initial, onSave }: { initial: number; onSave: (v: number) => void }) {
  const [v, setV] = useState(initial);
  const presets = [100, 150, 200, 300];
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={() => onSave(v)} aria-hidden />
      <div className="relative w-full max-w-[440px] rounded-3xl border border-[#ece6fb] bg-white p-7 shadow-[0_24px_70px_rgba(16,24,40,0.3)]">
        <p className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-[#813fed]">One quick setup</p>
        <h3 className="mt-1.5 text-[21px] font-extrabold tracking-[-0.02em] text-[#111]">What&apos;s your cost per appointment?</h3>
        <p className="mt-2 text-[12.5px] leading-snug text-[#6b7280]">
          We use this to turn every booked appointment into a dollar value across your reports. Use your average gross per
          showroom or service appointment — you can change it anytime.
        </p>

        <div className="mt-6 flex items-end justify-between">
          <span className="text-[10px] font-bold uppercase tracking-wider text-[#9ca3af]">Cost / appointment</span>
          <span className="text-[40px] font-extrabold tabular-nums leading-none text-[#059669]">${v.toLocaleString()}</span>
        </div>
        <input
          type="range"
          min={50}
          max={600}
          step={25}
          value={v}
          onChange={(e) => setV(Number(e.target.value))}
          className="mt-3 w-full accent-[#059669]"
          aria-label="Cost per appointment"
        />
        <div className="flex justify-between text-[10px] text-[#9ca3af]">
          <span>$50</span>
          <span>$600</span>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {presets.map((p) => (
            <button
              key={p}
              onClick={() => setV(p)}
              className={`rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-colors ${
                v === p ? "border-[#059669] bg-[#f0fdf6] text-[#059669]" : "border-[#e5e7eb] text-[#6b7280] hover:border-[#cdeede]"
              }`}
            >
              ${p}
            </button>
          ))}
        </div>

        <button
          onClick={() => onSave(v)}
          className="mt-6 w-full rounded-xl bg-[#813fed] py-2.5 text-[13.5px] font-bold text-white transition-colors hover:bg-[#6d28d9]"
        >
          Save &amp; see my value
        </button>
      </div>
    </div>
  );
}

/* ── Performance helpers ── */
/* Lead → qualified → appointment funnel: narrowing proportional bars with per-stage deltas and the
 * step-to-step conversion rate, so the drop-off reads at a glance. */
function PerfFunnel({ stages, appointmentsDrill }: { stages: { label: string; value: number; delta?: number }[]; appointmentsDrill?: () => void }) {
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
                  <p className="text-[24px] font-extrabold tabular-nums leading-none text-[#10b981] underline decoration-dotted decoration-[#10b981]/40 underline-offset-4 group-hover/appt:decoration-[#10b981] sm:text-[26px]">
                    {fmtInt(s.value)}
                  </p>
                  <p className="mt-1 text-[11px] font-semibold leading-tight text-[#10b981]">{s.label} · view leads ↗</p>
                </button>
              ) : (
                <>
                  <p className={`text-[24px] font-extrabold tabular-nums leading-none sm:text-[26px] ${isLast ? "text-[#10b981]" : "text-[#111]"}`}>
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
            {/* period-over-period delta (omitted for stages without a prior-window basis, e.g. Conversations) */}
            <div className="w-[92px] flex-none text-right sm:w-[104px]">
              {s.delta !== undefined && <DeltaPill delta={s.delta} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ActivityStat({ label, value, hint, delta }: { label: string; value: string; hint?: string; delta?: number }) {
  return (
    <div className="px-6 py-4">
      <p className="text-[10px] font-bold uppercase tracking-wider text-[#9ca3af]">{label}</p>
      <p className="mt-1 text-[20px] font-bold tabular-nums leading-none text-[#111]">{value}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
        {delta !== undefined && <DeltaPill delta={delta} />}
        {hint && <span className="text-[10.5px] text-[#6b7280]">{hint}</span>}
      </div>
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

/* ── last-synced label + refresh button ── */
function SyncStatus({ fetchedAt, loading, now, onRefresh }: { fetchedAt: number | null; loading: boolean; now: number; onRefresh: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="hidden text-[11px] text-[#9ca3af] md:inline">
        {loading ? "Syncing…" : fetchedAt ? `Synced ${relTime(fetchedAt, now)}` : ""}
      </span>
      <button
        onClick={onRefresh}
        disabled={loading}
        aria-label="Refresh data"
        title="Refresh"
        className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#e5e7eb] bg-white text-[#6b7280] transition-colors hover:bg-[#faf8ff] hover:text-[#813fed] disabled:opacity-50"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={loading ? "animate-spin" : ""}>
          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          <path d="M21 3v6h-6" />
        </svg>
      </button>
    </div>
  );
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
      <p className="mt-0.5 text-[16px] font-bold tabular-nums" style={{ color: accent ?? "#111" }}>{value}</p>
    </div>
  );
}

/* Open-funnel split for Sales Inbound (card 12341 via report_open_funnel): appointments booked / leads
 * handled, per acquisition path. `data` absent (no ETL row yet) → coming-soon. */
function StlOpenFunnel({ data }: { data?: { stlLeadsHandled: number; stlAppts: number; stlRate: number; followupLeadsHandled: number; followupAppts: number; followupRate: number } }) {
  return (
    <div className="border-t border-[#f0f0f3] pt-4">
      <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-[#9ca3af]">Leads handled → appointments booked <span className="font-semibold normal-case text-[#c4c4cc]">· all-time</span></p>
      {data ? (
        <div className="grid grid-cols-2 gap-3">
          <SummaryStat label="Via speed-to-lead" value={`${fmtInt(data.stlAppts)} / ${fmtInt(data.stlLeadsHandled)}`} accent="#813fed" />
          <SummaryStat label="Via follow-ups" value={`${fmtInt(data.followupAppts)} / ${fmtInt(data.followupLeadsHandled)}`} accent="#10b981" />
          <SummaryStat label="STL booked rate" value={`${data.stlRate}%`} />
          <SummaryStat label="Follow-up booked rate" value={`${data.followupRate}%`} />
        </div>
      ) : (
        <p className="text-[11.5px] text-[#9ca3af]">Coming soon — appointments split by speed-to-lead vs follow-up.</p>
      )}
    </div>
  );
}

function QCell({ label, value, status }: { label: string; value: string; status?: "green" | "amber" | "red" }) {
  return (
    <div className="rounded-xl border border-[#f0f0f0] px-4 py-3">
      <div className="flex items-center gap-1.5">
        {status && <span className="h-2 w-2 rounded-full" style={{ background: RAG_STYLE[status].dot }} />}
        <p className="text-[11px] font-semibold uppercase tracking-wider text-[#9ca3af]">{label}</p>
      </div>
      <p className="mt-1 text-[18px] font-bold tabular-nums text-[#111]">{value}</p>
    </div>
  );
}

/* ── Upcoming appointments (live ← Spyne leads/dealer/v3/meetings) ──
 * Rooftop-wide (sales + service), from now forward. Self-fetches so the card stays live regardless of
 * the Q12227 aggregate; degrades to the empty state on no-data / error. */
function UpcomingAppointments({ teamId, enterpriseId, spyneToken }: { teamId: string; enterpriseId: string; spyneToken: string }) {
  const [state, setState] = useState<{ loading: boolean; meetings: Meeting[] }>({ loading: true, meetings: [] });
  useEffect(() => {
    let on = true;
    // reset to the loading state whenever the rooftop/token changes, then refetch (stale-while-revalidate
    // isn't worth it here — upcoming bookings are small and change rarely)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!teamId) { setState({ loading: false, meetings: [] }); return; }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ loading: true, meetings: [] });
    fetchMeetings({ teamId, enterpriseId, service: "both", scope: "upcoming", spyneToken })
      .then((r) => { if (on) setState({ loading: false, meetings: r.meetings }); })
      .catch(() => { if (on) setState({ loading: false, meetings: [] }); });
    return () => { on = false; };
  }, [teamId, enterpriseId, spyneToken]);

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

/* ── Priority follow-ups / callbacks (Supabase ← card 12234) ── */
function CallbacksList({ items }: { items: FollowUp[] }) {
  return (
    <div className="max-h-[320px] divide-y divide-[#f3f4f6] overflow-y-auto">
      {items.map((f, i) => (
        <div key={i} className="flex items-center justify-between gap-3 px-6 py-3">
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold text-[#111]">{f.customer || "—"}</p>
            <p className="truncate text-[11px] text-[#6b7280]">{f.intent}</p>
          </div>
          <div className="flex-none text-right">
            <PriorityPill priority={f.priority} />
            <p className="mt-0.5 text-[10.5px] text-[#9ca3af]">{f.due}</p>
          </div>
        </div>
      ))}
    </div>
  );
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
