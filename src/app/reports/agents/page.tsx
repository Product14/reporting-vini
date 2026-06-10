"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  AGENTS as MOCK_AGENTS,
  AgentData,
  agentById,
  Bucket,
  BUCKET_LABELS,
  CalibratingBanner,
  Card,
  ComingSoon,
  ConfidenceChip,
  DateFilter,
  DeltaPill,
  fmtInt,
  fmtMoneyFull,
  GhostPreview,
  HealthChip,
  HOUR_LABELS,
  DayTrend,
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
import { fetchAgents, agentsForAccount, addDay, peekAgents, type FetchResult } from "@/components/reports/liveData";
import { UpsellAgent } from "@/components/reports/upsell";

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

  useEffect(() => {
    const stored = typeof window !== "undefined" ? window.localStorage.getItem("vini.apptCost") : null;
    if (stored) setApptCost(Number(stored));
    else setCostModalOpen(true); // first visit — ask once
  }, []);
  const saveApptCost = (v: number) => {
    setApptCost(v);
    if (typeof window !== "undefined") window.localStorage.setItem("vini.apptCost", String(v));
    setCostModalOpen(false);
  };
  const { scenario, view, teamId, account } = useScenario();
  // custom range (inclusive end) overrides the preset bucket; end is made exclusive for Metabase.
  const rangeOpts = custom ? { start: custom.start, end: addDay(custom.end) } : { bucket };
  // Live agents for the selected rooftop, overlaid from Metabase. Seed from the client cache so
  // navigating back paints instantly instead of flashing a skeleton; null === nothing cached (cold).
  const [feed, setFeed] = useState<FetchResult | null>(() => peekAgents({ teamId, ...rangeOpts }));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000); // tick the "synced X ago" label
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!teamId) { setFeed(null); return; } // no rooftop selected → no data
    let on = true;
    // show cached data immediately (stale-while-revalidate); only blank to the skeleton when cold
    const cached = peekAgents({ teamId, ...rangeOpts });
    setFeed(cached);
    fetchAgents({ teamId, ...rangeOpts })
      .then((res) => { if (on) setFeed(res); })
      .catch(() => { if (on && !cached) setFeed({ agents: [], hasData: false, fetchedAt: Date.now(), prior: {} }); });
    return () => { on = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, bucket, custom]);
  const refresh = () => {
    if (!teamId) return;
    setFeed(null);
    fetchAgents({ teamId, ...rangeOpts, force: true })
      .then(setFeed)
      .catch(() => setFeed({ agents: [], hasData: false, fetchedAt: Date.now(), prior: {} }));
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
  const inbound = a.dir === "Inbound";
  const hasStory = !!(r.benchmarks && r.compare); // story-first treatment for every agent that has it
  const live = view.hasData; // recently_live + repeat render the real report

  // Live data from Metabase is already a window total for the selected bucket (liveData re-queries
  // per bucket), so it must not be re-scaled — factor=1 when live, 0 in the pre-live ghost states.
  const factor = live ? 1 : 0;
  const scale = (n: number) => Math.round(n * factor);
  const periodLabel = custom ? `${custom.start} – ${custom.end}` : scenario === "repeat" ? BUCKET_LABELS[bucket] : view.liveLabel;
  const agentEmpty = live && hasTeam && !!feed?.hasData && Math.round(scale(m.calls)) === 0;
  // turn rate is derivable from live volume (qualified / connected), so it stays live
  const turnRate = m.conversations > 0 ? Math.round((m.qualified / m.conversations) * 100) : 0;

  // Call & intent flow (Sankey) — derived from real metrics so the flow conserves end-to-end.
  const sankey = useMemo(() => {
    const total = scale(m.calls);
    const connected = Math.min(total, scale(m.conversations));
    const missed = Math.max(0, total - connected);
    const qualified = Math.min(connected, scale(m.qualified));
    const notQualified = Math.max(0, connected - qualified);
    const booked = Math.min(qualified, scale(m.appointments));
    const nurture = Math.max(0, qualified - booked);
    const columns = [
      [{ id: "total", label: inbound ? "Calls handled" : "Dispatched", color: "#813fed" }],
      [
        { id: "connected", label: "Connected", color: "#6366f1" },
        { id: "missed", label: inbound ? "Missed" : "No answer", color: "#dc2626" },
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
      { from: "total", to: "missed", value: missed },
      { from: "connected", to: "qualified", value: qualified },
      { from: "connected", to: "notq", value: notQualified },
      { from: "qualified", to: "booked", value: booked },
      { from: "qualified", to: "nurture", value: nurture },
      { from: "notq", to: "lost", value: notQualified },
    ];
    return { columns, links };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.id, factor, inbound]);

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
                <SyncStatus fetchedAt={feed?.fetchedAt ?? null} loading={feed === null} now={now} onRefresh={refresh} />
                <DateFilter
                  bucket={bucket}
                  custom={custom}
                  onPreset={(b) => { setBucket(b); setCustom(null); }}
                  onCustom={(r) => setCustom(r)}
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
              <p className="text-[14px] font-bold text-[#111]">No rooftop selected</p>
              <p className="max-w-[460px] text-[12.5px] leading-snug text-[#6b7280]">
                Add <b>?team_id=…</b> to the URL to load a rooftop&apos;s live reporting. Without a rooftop, there&apos;s no data to show.
              </p>
            </div>
          )}

          {scenario !== "first_time" && live && hasTeam && feed === null && <ReportSkeleton />}

          {scenario !== "first_time" && live && hasTeam && comingSoon && <RooftopComingSoon name={account.name} />}

          {scenario !== "first_time" && (!live || (hasTeam && feed !== null && !comingSoon)) && (
          <>
          {/* agent selector — live agents this rooftop runs, plus "add" cards for the rest */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {visibleAgents.map((ag) => {
              const selected = ag.id === activeId && !upsell;
              return (
                <button
                  key={ag.id}
                  onClick={() => { setActiveId(ag.id); setUpsellId(null); }}
                  className={`text-left rounded-2xl border bg-white p-4 transition-all ${
                    selected
                      ? "border-[#813fed] shadow-[0_0_0_3px_rgba(129,63,237,0.12)]"
                      : "border-[#e5e7eb] hover:border-[#c4b5fd] hover:shadow-sm"
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <span className="text-[20px] leading-none">{ag.icon}</span>
                    <HealthChip status={ag.health} />
                  </div>
                  <p className="mt-2 text-[13.5px] font-bold text-[#111] leading-tight">{ag.name}</p>
                  <p className="text-[10.5px] font-semibold uppercase tracking-wider text-[#9ca3af]">
                    {ag.dept} · {ag.dir}
                  </p>
                  <div className="mt-3">
                    <p className="text-[20px] font-bold tabular-nums text-[#111]">{view.agentLive ? fmtInt(ag.metrics.calls * factor) : "—"}</p>
                    <p className="text-[10.5px] text-[#6b7280]">{ag.headlineLabel}</p>
                  </div>
                </button>
              );
            })}
            {upsellAgents.map((ag) => {
              const selected = upsell?.id === ag.id;
              return (
                <button
                  key={ag.id}
                  onClick={() => setUpsellId(ag.id)}
                  className={`text-left rounded-2xl border border-dashed bg-[#fcfcfd] p-4 transition-all ${
                    selected
                      ? "border-[#813fed] shadow-[0_0_0_3px_rgba(129,63,237,0.12)]"
                      : "border-[#dcd3f5] hover:border-[#c4b5fd] hover:bg-[#faf8ff]"
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <span className="text-[20px] leading-none opacity-60">{ag.icon}</span>
                    <span className="inline-flex items-center gap-1 rounded-full bg-[#f3eaff] px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[#813fed]">+ Add</span>
                  </div>
                  <p className="mt-2 text-[13.5px] font-bold text-[#6b7280] leading-tight">{ag.name}</p>
                  <p className="text-[10.5px] font-semibold uppercase tracking-wider text-[#9ca3af]">
                    {ag.dept} · {ag.dir}
                  </p>
                  <div className="mt-3">
                    <p className="text-[12.5px] font-bold text-[#813fed]">See what it could do →</p>
                    <p className="text-[10.5px] text-[#9ca3af]">Not active yet</p>
                  </div>
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
          {/* detail identity strip */}
          <section className="flex items-center gap-3 rounded-2xl border border-[#e5e7eb] bg-gradient-to-r from-[#faf8ff] to-white px-6 py-3.5 shadow-sm">
            <span className="text-[20px] leading-none">{a.icon}</span>
            <p className="flex-1 text-[15px] font-bold text-[#111]">
              {a.name} <span className="text-[12px] font-medium text-[#9ca3af]">· {r.summary.person} · {a.dept} {a.dir}</span>
            </p>
            <span className="text-[11px] font-medium text-[#9ca3af]">{periodLabel}</span>
            <HealthChip status={a.health} />
          </section>

          {scenario === "onboarding" && <OnboardingAgents agent={a} view={view} />}

          {live && agentEmpty && (
            <NoActivity name={a.name} onWiden={() => { setBucket("last30"); setCustom(null); }} />
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
                <div className="flex flex-wrap items-center justify-between gap-x-10 gap-y-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-[#059669]">
                        Value created · {periodLabel}
                      </p>
                      {scenario !== "repeat" && <ConfidenceChip level={view.confidence} />}
                    </div>
                    <p className="mt-1 text-[42px] font-extrabold tabular-nums leading-none text-[#059669]">
                      {fmtMoneyFull(scale(m.appointments) * apptCost)}
                    </p>
                    <p className="mt-2 text-[12px] text-[#6b7280]">
                      <b className="text-[#111]">{fmtInt(scale(m.appointments))}</b> appointments ×{" "}
                      <b className="text-[#111]">{fmtMoneyFull(apptCost)}</b> per appointment{" "}
                      <button
                        onClick={() => setCostModalOpen(true)}
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
              </section>

              <button
                onClick={() => setShowDetail((v) => !v)}
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
            {/* primary: lead → qualified → appointment */}
            <div className="flex flex-col gap-4 px-6 py-6 sm:flex-row sm:items-center sm:gap-2">
              <PerfStage label="Leads attempted" value={fmtInt(scale(r.leadsAttempted))} delta={r.deltas.leadsAttempted} />
              <PerfArrow pct={r.leadsAttempted > 0 ? Math.round((m.qualified / r.leadsAttempted) * 100) : 0} />
              <PerfStage label="Leads qualified" value={fmtInt(scale(m.qualified))} delta={r.deltas.leadsQualified} />
              <PerfArrow pct={m.qualified > 0 ? Math.round((m.appointments / m.qualified) * 100) : 0} />
              <PerfStage label="Appointments" value={fmtInt(scale(m.appointments))} delta={r.deltas.appointments} primary />
              <div className="sm:ml-auto sm:pl-2">
                <div className="rounded-2xl bg-[#f6f1ff] px-5 py-3 text-center">
                  <p className="text-[9.5px] font-bold uppercase tracking-wider text-[#9ca3af]">ABR · appts / leads</p>
                  <p className="text-[26px] font-extrabold tabular-nums leading-none text-[#813fed]">{r.abr}%</p>
                  <span className="mt-0.5 inline-block"><DeltaPill delta={r.deltas.abr} /></span>
                </div>
              </div>
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
              <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
                {[
                  { label: "During hours", value: Math.max(0, m.calls - m.afterHours) },
                  { label: "After hours", value: m.afterHours },
                  { label: "Connected", value: m.conversations },
                  { label: "Qualified", value: m.qualified },
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

          <SectionLabel hint={`${r.qualifiedPct}% qualified · ${a.quality.sentiment}% positive sentiment`}>Conversations &amp; outcomes</SectionLabel>

          {/* call & intent flow — Sankey centerpiece */}
          <Card
            title="Call & intent flow"
            sub={`How ${inbound ? "calls" : "dials"} move: contact → connect → qualify → booked. Ribbon width = volume.`}
          >
            <Sankey columns={sankey.columns} links={sankey.links} height={300} fmt={(n) => fmtInt(n)} />
          </Card>

          {/* query resolution + top objections */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card title="Query resolution rate" sub="Share of each topic the agent resolved without a human">
              <QueryBars topics={r.queries} />
            </Card>
            <Card title="Top objections" sub="What the agent heard most">
              <ComingSoon title="Objection classification" note="Tagging objections from transcripts isn't wired to a card yet." />
            </Card>
          </div>

          <SectionLabel>{inbound ? "Inbound operations" : "Outbound campaigns"}</SectionLabel>

          {/* ── Inbound-only: leads by source + speed to lead ── */}
          {inbound && r.leadsBySource && r.speedToLead && (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
              <div className="lg:col-span-2">
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
              <Card title="Speed to lead" sub="How fast new CRM leads get a first touch">
                <div className="flex flex-col gap-4">
                  <div>
                    <p className="text-[30px] font-extrabold tabular-nums text-[#813fed] leading-none">{r.speedToLead.avg}</p>
                    <p className="text-[11.5px] text-[#6b7280] mt-1">{r.speedToLead.pctWithin5}% of new leads contacted within 5 min</p>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <SummaryStat label="New CRM leads" value={fmtInt(scale(r.speedToLead.crmLeadsNew))} />
                    <SummaryStat label="Instantly touched" value={fmtInt(scale(r.speedToLead.instantlyTouched))} accent="#10b981" />
                  </div>
                </div>
              </Card>
            </div>
          )}

          {/* ── Inbound-only: upcoming appointments + priority follow-ups (need the action-item store) ── */}
          {inbound && (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <Card title="Upcoming appointments" sub="Conversation → action item → appointment" pad={false}>
                <ComingSoon title="Booked appointments feed" note="The per-customer appointment list comes from the action-item store — not wired to a card yet." />
              </Card>
              <Card title="Priority follow-ups" sub="Callbacks the agent flagged" pad={false}>
                <ComingSoon title="Flagged callbacks feed" note="Agent-flagged callbacks come from the action-item store — not wired to a card yet." />
              </Card>
            </div>
          )}

          {/* ── Outbound-only: active campaigns + no-interaction ── */}
          {!inbound && (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <Card title="Best use cases — active campaigns" sub="Campaigns this agent is currently running" pad={false}>
                  <ComingSoon title="Campaign attribution" note="Per-campaign volume and conversion need a campaign-level card — not wired yet." />
                </Card>
              </div>
              <Card title="No interaction" sub="Why we couldn't reach them">
                <ComingSoon title="No-reach reasons" note="Disconnected / no-reply breakdown isn't wired to a card yet." />
              </Card>
            </div>
          )}

          {/* multi-day reply effectiveness + channel mix */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card title="Multi-day reply effectiveness" sub="When replies land, relative to the first touch">
              <TrendBars values={r.multiDayReply.map((d) => d.pct)} labels={r.multiDayReply.map((d) => d.day)} height={96} />
              <p className="mt-3 text-[11px] text-[#6b7280]">
                {r.multiDayReply[0].pct}% of replies arrive the same day — the rest justify the multi-day cadence.
              </p>
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
          <Card title="Quality health" sub="Green / amber / red — watched in production monitoring">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <QCell label={a.quality.primaryLabel} value={`${a.quality.primary}%`} status={a.quality.primaryStatus} />
              <QCell label="Avg handle time" value={a.quality.handleTime} status={a.quality.handleStatus} />
              <QCell label="CSAT" value={`${a.quality.csat} / 5`} status={a.quality.csatStatus} />
              <ComingSoon title={a.quality.fourthLabel} inline />
              <QCell label="Positive sentiment" value={`${a.quality.sentiment}%`} status="green" />
              <QCell label="Opt-outs" value={fmtInt(scale(m.optOuts))} status="green" />
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
          <Card title="Highlights & missed opportunities" sub="The action items this agent surfaces" pad={false}>
            <div className="px-6 py-5">
              <ComingSoon title="Surfaced action items" note="Win/miss highlights are generated from the action-item store — not wired to a card yet." />
            </div>
          </Card>

          {/* activity (inbound — calls by reason; outbound campaigns covered above) */}
          {inbound && (
            <Card title={a.activityTitle} sub={periodLabel} pad={false}>
              <div className="px-6 py-5">
                <ComingSoon title="Calls by reason" note="Per-reason handled / qualified / appointment splits aren't wired to a card yet." />
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
function PerfStage({ label, value, delta, primary }: { label: string; value: string; delta: number; primary?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[10px] font-bold uppercase tracking-wider text-[#9ca3af]">{label}</p>
      <p
        className={`font-extrabold tabular-nums leading-none ${primary ? "text-[34px] text-[#10b981]" : "text-[28px] text-[#111]"}`}
      >
        {value}
      </p>
      <DeltaPill delta={delta} />
    </div>
  );
}

function PerfArrow({ pct }: { pct: number }) {
  return (
    <div className="flex flex-none items-center gap-1.5 self-start px-1 pt-5 sm:flex-col sm:items-center sm:gap-1 sm:self-center sm:pt-0">
      <span className="hidden text-[15px] text-[#d8caff] sm:block">→</span>
      <span className="text-[12px] text-[#d8caff] sm:hidden">↓</span>
      <span className="rounded-full bg-[#f3f4f6] px-2 py-0.5 text-[10px] font-bold tabular-nums text-[#6b7280]">{pct}%</span>
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
      <p className="text-[20px] font-extrabold tracking-[-0.02em] text-[#111]">Live reporting for {name} is being wired up</p>
      <p className="max-w-[480px] text-[13px] leading-snug text-[#6b7280]">
        We don&apos;t have data flowing from this rooftop yet. The moment its calls and outcomes land in the reporting
        pipeline, the full report appears here automatically — nothing to set up on your end.
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

function QCell({ label, value, status }: { label: string; value: string; status: "green" | "amber" | "red" }) {
  return (
    <div className="rounded-xl border border-[#f0f0f0] px-4 py-3">
      <div className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full" style={{ background: RAG_STYLE[status].dot }} />
        <p className="text-[11px] font-semibold uppercase tracking-wider text-[#9ca3af]">{label}</p>
      </div>
      <p className="mt-1 text-[18px] font-bold tabular-nums text-[#111]">{value}</p>
    </div>
  );
}
