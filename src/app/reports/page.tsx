"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Bucket,
  BUCKET_LABELS,
  Card,
  ComingSoon,
  DateFilter,
  Eyebrow,
  fmtInt,
  ActiveCampaign,
  GhostPreview,
  MeetingsModal,
  ReportTopBar,
  SectionLabel,
  StepFunnel,
  StepList,
} from "@/components/reports/kit";
import {
  AgentFunnelCard,
  DefinitionsFooter,
  fmtDuration,
  fmtRate,
  NamedApptsTable,
  ValueTile,
  WarmLeadChips,
} from "@/components/reports/kitV3";
import { useScenario, type ScenarioView } from "@/components/reports/scenario";
import { fetchAgents, agentsForAccount, aggregateFleet, addDay, peekAgents, tzShortLabel, type FetchResult } from "@/components/reports/liveData";
import { useDateRange, reportNavQuery } from "@/components/reports/dateRange";
import { track } from "@/lib/analytics";

// useDateRange() reads the selected window from the URL (?range / ?start&?end), which needs a Suspense
// boundary above useSearchParams. The window now lives in the URL so it survives tab navigation.
export default function OverviewReportPage() {
  return (
    <Suspense fallback={null}>
      <OverviewReportView />
    </Suspense>
  );
}

function OverviewReportView() {
  const router = useRouter();
  // Selected window comes from the URL so it persists across navigation to the By-agent tab (and back).
  const { bucket, custom, setPreset, setCustom } = useDateRange();
  const { scenario, view, teamId, account, spyneToken, enterpriseId } = useScenario();


  // custom range (inclusive end) overrides the preset bucket; end is made exclusive for the query.
  // spyneToken (host-forwarded, prod) rides along so the server can resolve timezone + onboarded agents.
  const rangeOpts = custom ? { start: custom.start, end: addDay(custom.end), spyneToken } : { bucket, spyneToken };
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

  // Scope to the agents this rooftop actually runs, then aggregate the live numbers.
  const agents = useMemo(() => agentsForAccount(feed?.agents ?? [], account), [feed, account]);
  const fleet = useMemo(() => aggregateFleet(agents, feed?.prior), [agents, feed]);

  const hasTeam = teamId !== "";
  // Carries team scope + the selected window into the tab links and the per-agent drill-down, so the
  // chosen date range survives navigation to the By-agent view.
  const navQuery = reportNavQuery(teamId, bucket, custom);
  const periodLabel = custom ? (custom.start === custom.end ? custom.start : `${custom.start} – ${custom.end}`) : BUCKET_LABELS[bucket];
  // Appointment drill-down — clicking the headline count lists the rooftop's appointments (sales +
  // service) for the shown window. Window = the server-resolved dates when we have them, else the bucket.
  const [apptModalOpen, setApptModalOpen] = useState(false);
  const openApptModal = () => { setApptModalOpen(true); track("appointments_drilldown_opened", { tab: "overview", team_id: teamId }); };
  const meetingWindow: { start?: string; end?: string; bucket?: Bucket } =
    feed?.start && feed?.end ? { start: feed.start, end: feed.end } : { bucket };
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
  // Rooftop campaigns (attached to outbound agents in build.ts; the same list per agent). Top by appointments.
  const campaigns = useMemo<ActiveCampaign[]>(() => {
    // Union across ALL outbound agents (each campaign belongs to one agent_type, so no dupes) — a rooftop
    // running both Sales-OB and Service-OB campaigns showed only the first agent's before. Top by appts.
    const all = agents.flatMap((a) => a.report.activeCampaigns ?? []);
    return [...all].sort((a, b) => b.appts - a.appts);
  }, [agents]);
  // Rooftop follow-ups: each agent carries its department's callbacks (both directions of a dept share
  // the list), so union + dedupe to one rooftop-wide "asked for a call back" queue.
  const followUps = useMemo(() => {
    const seen = new Set<string>();
    const out: { customer: string; due: string; intent: string; priority: string }[] = [];
    for (const a of agents) for (const f of a.report.followUps ?? []) {
      const k = `${f.customer}|${f.due}|${f.intent}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(f);
    }
    return out;
  }, [agents]);
  const warmLeads = feed?.warmLeads ?? [];
  const namedAppts = feed?.namedAppointments ?? [];
  const split = fleet.bySplit;

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
                {feed?.timezone ? (
                  <span className="hidden text-[11px] text-[#9ca3af] md:inline" title={`Report days & times use this rooftop's timezone (${feed.timezone})`}>
                    Times in {tzShortLabel(feed.timezone)}
                  </span>
                ) : null}
                <span className="hidden text-[11px] text-[#9ca3af] md:inline">
                  {feed === null ? "Syncing…" : feed.fetchedAt ? `Synced ${relTime(feed.fetchedAt, now)}` : ""}
                </span>
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

        <main className="mx-auto w-full max-w-[1320px] flex-1 px-10 pt-7 pb-36 flex flex-col gap-9">
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

          {/* ─────────── 1 · The value delivered — canonical headline counts, IB/OB split ─────────── */}
          <div className="flex flex-col gap-3.5">
            <SectionLabel hint={periodLabel}>The value delivered</SectionLabel>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <ValueTile
                label="Appointments — AI-booked"
                total={fmtInt(fleet.appointments)}
                inbound={fmtInt(split.inbound.appointments)}
                outbound={fmtInt(split.outbound.appointments)}
                delta={fleet.deltas.appointments}
                accent="green"
                subtext={fleet.appointmentsAssisted > 0 ? <>+{fmtInt(fleet.appointmentsAssisted)} AI-assisted (CRM)</> : <>meeting created by the AI</>}
                onClick={fleet.appointments > 0 ? openApptModal : undefined}
              />
              <ValueTile
                label="Real conversations"
                total={fmtInt(fleet.conversations)}
                inbound={fmtInt(split.inbound.conversations)}
                outbound={fmtInt(split.outbound.conversations)}
                delta={fleet.deltas.conversations}
                accent="purple"
                subtext={<>customer spoke or replied — voicemail excluded</>}
              />
              <ValueTile
                label="Qualified leads"
                total={fmtInt(fleet.qualified)}
                inbound={fmtInt(split.inbound.qualified)}
                outbound={fmtInt(split.outbound.qualified)}
                delta={fleet.deltas.qualified}
                accent="violet"
                subtext={<>concrete buying intent</>}
              />
              <ValueTile
                label="Hand-offs to team"
                total={fmtInt(fleet.handoffs)}
                inbound={fmtInt(split.inbound.handoffs)}
                outbound={fmtInt(split.outbound.handoffs)}
                delta={fleet.deltas.handoffs}
                accent="blue"
                subtext={
                  <>
                    {fmtInt(fleet.transfers)} transfers · {fmtInt(fleet.callbacks)} callbacks
                    {fleet.transfersFailed > 0 && <><br />+{fmtInt(fleet.transfersFailed)} transfers failed</>}
                  </>
                }
              />
              <ValueTile
                label="SMS sent"
                total={fmtInt(fleet.smsSent)}
                inbound={fmtInt(split.inbound.smsSent)}
                outbound={fmtInt(split.outbound.smsSent)}
                delta={fleet.deltas.sms}
                accent="orange"
                subtext={<>two-way texting</>}
              />
              <ValueTile
                label="Talk time"
                total={fmtDuration(fleet.talkMinutes)}
                inbound={fmtDuration(split.inbound.talkMinutes)}
                outbound={fmtDuration(split.outbound.talkMinutes)}
                delta={fleet.deltas.talkMinutes}
                accent="gray"
                subtext={<>zero staff minutes spent</>}
              />
            </div>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
              <ContextChip label="Calls handled" value={fmtInt(fleet.calls)} />
              <ContextChip label="After-hours captured" value={fmtInt(fleet.afterHours)} accent="#10b981" />
              <ContextChip
                label="Handled end-to-end"
                value={fleet.handledEndToEndPct != null ? `${fleet.handledEndToEndPct}%` : "—"}
                accent="#813fed"
                title="Share of real conversations the AI completed without transferring to a human — staff time your team got back."
              />
            </div>
          </div>

          {/* ─────────── 2 · The pipeline — whole dealership ─────────── */}
          <div className="flex flex-col gap-3.5">
            <SectionLabel hint={periodLabel}>The pipeline — whole dealership</SectionLabel>
            <Card title="Leads reached → Real conversations → Qualified → Appointments" sub="Each step is the unique leads that reached that stage; the pill is conversion from the step before">
              <StepFunnel stages={fleet.funnel} />
              <div className="mt-5 grid grid-cols-2 gap-2.5 border-t border-[#f3f4f6] pt-4 sm:grid-cols-4">
                <ContextChip
                  label="Turn rate"
                  value={fmtRate(fleet.qualified, fleet.conversations)}
                  accent="#6d28d9"
                  title="Qualified leads ÷ real conversations"
                />
                <ContextChip
                  label="Close rate"
                  value={fmtRate(fleet.appointments, fleet.qualified)}
                  accent="#059669"
                  title="Appointments — AI-booked ÷ qualified leads"
                />
                <ContextChip
                  label={fleet.answerRateInbound != null ? "Inbound answer rate" : "Connect rate (IB+OB)"}
                  value={`${fleet.answerRateInbound ?? fleet.connectRate}%`}
                />
                <ContextChip label="Talk time" value={fmtDuration(fleet.talkMinutes)} />
              </div>
            </Card>
          </div>

          {/* ─────────── 3 · Who drove it — per-agent funnels ─────────── */}
          <div className="flex flex-col gap-3.5">
            <SectionLabel hint="Click an agent for the full report">Who drove it</SectionLabel>
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
                    ministats={{
                      calls: a.metrics.calls,
                      sms: a.metrics.smsSent,
                      talkMinutes: a.metrics.talkMinutes,
                      handoffs: (a.report.callFlow?.transferred ?? 0) + (a.report.callFlow?.callbacks ?? 0),
                    }}
                    onClick={() => { track("agent_opened", { team_id: teamId, agent: a.id }); router.push(`/reports/agents${navQuery}${navQuery ? "&" : "?"}agent=${a.id}`); }}
                  />
                );
              })}
            </div>
          </div>

          {/* ─────────── 4 · Appointments — named ─────────── */}
          {(namedAppts.length > 0 || fleet.appointments > 0) && (
            <div className="flex flex-col gap-3.5">
              <SectionLabel hint={`${fmtInt(fleet.appointments)} AI-booked · ${fmtInt(fleet.appointmentsAssisted)} AI-assisted`}>
                Appointments — named
              </SectionLabel>
              <Card
                title="Every appointment on the books"
                sub="AI-booked = the AI created the meeting · AI-assisted = booked in your CRM on a lead the AI worked (never counted in the headline)"
                pad={namedAppts.length > 0}
              >
                {namedAppts.length > 0 ? (
                  <NamedApptsTable items={namedAppts} teamId={teamId} />
                ) : (
                  <div className="px-6 py-5">
                    <p className="text-[12.5px] text-[#6b7280]">
                      Appointment details are syncing — the counts above are correct. Click the appointments tile for the live drill-down.
                    </p>
                  </div>
                )}
              </Card>
            </div>
          )}

          {/* ─────────── 5 · Work these now — named leads for the team ─────────── */}
          {(warmLeads.length > 0 || followUps.length > 0) && (
            <div className="flex flex-col gap-3.5">
              <SectionLabel hint="reviewed, in-market, unworked — the fastest net-new appointments">Work these now</SectionLabel>
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                {warmLeads.length > 0 && (
                  <Card title="Hot & warm leads" sub="Buying intent on record, no appointment yet — call these first">
                    <WarmLeadChips items={warmLeads} teamId={teamId} />
                  </Card>
                )}
                {followUps.length > 0 && (
                  <Card title="Priority follow-ups" sub="Customers who explicitly asked for a return call">
                    <div className="flex flex-col gap-2">
                      {followUps.slice(0, 8).map((f, i) => (
                        <div key={i} className="flex items-center justify-between gap-3 border-b border-[#f5f5f5] pb-2 last:border-0 last:pb-0">
                          <div className="min-w-0">
                            <p className="truncate text-[12.5px] font-semibold text-[#111]">{f.customer}</p>
                            <p className="truncate text-[10.5px] text-[#9ca3af]">{f.intent || "Callback requested"}</p>
                          </div>
                          <p className="flex-none text-[11px] tabular-nums text-[#6b7280]">{f.due}</p>
                        </div>
                      ))}
                      {followUps.length > 8 && (
                        <p className="text-[11px] font-semibold text-[#9ca3af]">+{followUps.length - 8} more in the By-agent view</p>
                      )}
                    </div>
                  </Card>
                )}
              </div>
            </div>
          )}

          {/* ─────────── 6 · Campaign highlights ─────────── */}
          {campaigns.length > 0 && (
            <div className="flex flex-col gap-3.5">
              <SectionLabel hint="cumulative · last ~120 days">Campaign highlights</SectionLabel>
              <Card title="Top campaigns" sub="Your outbound campaigns, ranked by appointments booked — full list on the Campaigns tab">
                <div className="grid grid-cols-1 gap-x-8 gap-y-2.5 md:grid-cols-2">
                  {campaigns.slice(0, 6).map((c, i) => (
                    <div key={i} className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-[12.5px] font-semibold text-[#111]">{c.name}</p>
                        <p className="truncate text-[10.5px] text-[#9ca3af]">{c.useCase || "—"} · {fmtInt(c.enrolled)} enrolled · {fmtInt(c.warmLeads)} warm</p>
                      </div>
                      <div className="flex-none text-right">
                        <p className="text-[13px] font-bold tabular-nums text-[#10b981]">{fmtInt(c.appts)} appts</p>
                        <p className="text-[10.5px] text-[#9ca3af]">{c.apptRate}% appt rate</p>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          )}

          <DefinitionsFooter tzLabel={feed?.timezone ? tzShortLabel(feed.timezone) : undefined} />
          </>
          )}
        </main>
      </div>
      <MeetingsModal
        open={apptModalOpen}
        onClose={() => setApptModalOpen(false)}
        title={`Appointments · ${periodLabel}`}
        sub="Every booked appointment across this rooftop — sales & service"
        fetchOpts={{ teamId, enterpriseId, service: "both", scope: "window", ...meetingWindow, spyneToken }}
      />
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

function ContextChip({ label, value, accent, title }: { label: string; value: string; accent?: string; title?: string }) {
  return (
    <div className="flex items-center justify-between rounded-xl bg-[#fafafa] px-3.5 py-2.5" title={title}>
      <span className="text-[11.5px] text-[#6b7280]">{label}</span>
      <span className="text-[14px] font-bold tabular-nums" style={{ color: accent ?? "#111" }}>{value}</span>
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
