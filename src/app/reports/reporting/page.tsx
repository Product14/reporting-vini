"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import {
  BUCKET_LABELS,
  Card,
  DateFilter,
  fmtInt,
  ReportTopBar,
  SectionLabel,
  StepFunnel,
} from "@/components/reports/kit";
import {
  ActionItemsScoreboard,
  DefinitionsFooter,
  fmtDuration,
  fmtRate,
  fmtSecs,
  MetricTile,
  NamedApptsTable,
  ValueTile,
} from "@/components/reports/kitV3";
import { useScenario } from "@/components/reports/scenario";
import { useDateRange, useDept, reportNavQuery } from "@/components/reports/dateRange";
import {
  fetchAgents,
  fetchActionItemStats,
  agentsForAccount,
  aggregateFleet,
  addDay,
  peekAgents,
  tzShortLabel,
  type FetchResult,
  type ActionItemStats,
  type ActionItemCloser,
} from "@/components/reports/liveData";
import { track } from "@/lib/analytics";

export default function ReportingPage() {
  return (
    <Suspense fallback={null}>
      <ReportingView />
    </Suspense>
  );
}

function ReportingView() {
  const { teamId, account, spyneToken } = useScenario();
  const { bucket, custom, setPreset, setCustom } = useDateRange();
  const { dept } = useDept();
  const svc = dept === "all" ? "both" : dept; // shared dept scope → action-items serviceType
  const navQuery = reportNavQuery(teamId, bucket, custom, dept);
  const periodLabel = custom ? `${custom.start} – ${custom.end}` : BUCKET_LABELS[bucket];
  const rangeOpts = custom ? { start: custom.start, end: addDay(custom.end), spyneToken } : { bucket, spyneToken };

  const [feed, setFeed] = useState<FetchResult | null>(() => peekAgents({ teamId, ...rangeOpts }));
  const [aiStats, setAiStats] = useState<{ stats: ActionItemStats; closers: ActionItemCloser[] } | null>(null);

  useEffect(() => { track("report_viewed", { tab: "reporting", team_id: teamId }); }, [teamId]);
  useEffect(() => {
    if (!teamId) return;
    let on = true;
    setFeed(peekAgents({ teamId, ...rangeOpts }));
    fetchAgents({ teamId, ...rangeOpts }).then((r) => { if (on) setFeed(r); }).catch(() => {});
    return () => { on = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, bucket, custom]);
  useEffect(() => {
    if (!teamId) { setAiStats(null); return; }
    let on = true;
    fetchActionItemStats(teamId, { start: feed?.start, end: feed?.end, service: svc, spyneToken }).then((r) => { if (on) setAiStats(r); });
    return () => { on = false; };
  }, [teamId, feed?.start, feed?.end, svc, spyneToken]);

  // Scope to the rooftop's agents, then to the selected department (the shared header switcher).
  const allAgents = useMemo(() => agentsForAccount(feed?.agents ?? [], account), [feed, account]);
  const agents = useMemo(() => (dept === "all" ? allAgents : allAgents.filter((a) => a.dept.toLowerCase() === dept)), [allAgents, dept]);
  const fleet = useMemo(() => aggregateFleet(agents, feed?.prior), [agents, feed]);
  const split = fleet.bySplit;
  const namedAppts = useMemo(() => (feed?.namedAppointments ?? []).filter((a) => dept === "all" || a.serviceType === dept), [feed, dept]);

  return (
    <div className="flex min-h-screen bg-white">
      <div className="flex flex-1 flex-col">
        <ReportTopBar
          title="Reporting"
          subtitle="A one-page scorecard for this rooftop — print it or save as PDF to share."
          active="reporting"
          teamId={teamId}
          query={navQuery}
          right={
            teamId ? (
              <div className="no-print flex items-center gap-3">
                <DateFilter
                  bucket={bucket}
                  custom={custom}
                  onPreset={(b) => { setPreset(b); track("date_range_changed", { tab: "reporting", range: b, team_id: teamId }); }}
                  onCustom={(r) => { setCustom(r); track("date_range_changed", { tab: "reporting", range: "custom", team_id: teamId }); }}
                />
                <button
                  onClick={() => window.print()}
                  className="rounded-lg bg-[#813fed] px-3.5 py-2 text-[12px] font-bold text-white transition-colors hover:bg-[#6d28d9]"
                >
                  Print / Save as PDF
                </button>
              </div>
            ) : undefined
          }
        />

        <main className="mx-auto w-full max-w-[1100px] flex-1 px-4 sm:px-6 lg:px-10 pt-7 pb-36 flex flex-col gap-8">
          {/* Print header — only shows in the printed/PDF output */}
          <div className="hidden print:block">
            <p className="text-[20px] font-extrabold text-[#111]">{account.name || "Rooftop"} — Vini AI scorecard</p>
            <p className="text-[12px] text-[#6b7280]">{periodLabel}{feed?.timezone ? ` · times in ${tzShortLabel(feed.timezone)}` : ""}</p>
          </div>

          {/* Headline outcomes */}
          <div className="flex flex-col gap-3.5">
            <SectionLabel hint={periodLabel}>The value delivered</SectionLabel>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <ValueTile label="Appointments — AI-booked" total={fmtInt(fleet.appointments)} inbound={fmtInt(split.inbound.appointments)} outbound={fmtInt(split.outbound.appointments)} accent="green" subtext={fleet.appointmentsAssisted > 0 ? <>+{fmtInt(fleet.appointmentsAssisted)} AI-assisted (CRM)</> : <>meeting created by the AI</>} />
              <ValueTile label="Real conversations" total={fmtInt(fleet.conversations)} inbound={fmtInt(split.inbound.conversations)} outbound={fmtInt(split.outbound.conversations)} accent="purple" subtext={<>spoke or replied — voicemail excluded</>} />
              <ValueTile label="Qualified leads" total={fmtInt(fleet.qualified)} inbound={fmtInt(split.inbound.qualified)} outbound={fmtInt(split.outbound.qualified)} accent="violet" subtext={<>concrete buying intent</>} />
              <ValueTile label="Hand-offs to team" total={fmtInt(fleet.handoffs)} inbound={fmtInt(split.inbound.handoffs)} outbound={fmtInt(split.outbound.handoffs)} accent="blue" subtext={<>{fmtInt(fleet.transfers)} transfers · {fmtInt(fleet.callbacks)} callbacks</>} />
            </div>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
              <MetricTile label="Query resolution" value={fmtRate(fleet.queryResolved, fleet.queryConversations)} accent="#6c5ce7" sub={<>{fmtInt(fleet.queryResolved)} of {fmtInt(fleet.queryConversations)} inbound convos</>} />
              {fleet.responseTimeSec != null && <MetricTile label="Response time" value={fmtSecs(fleet.responseTimeSec)} accent="#2563eb" sub={<>avg first response</>} />}
              <MetricTile label="Action items" value={aiStats ? fmtInt(aiStats.stats.created) : "—"} accent="#ea760c" sub={aiStats ? <>{fmtInt(aiStats.stats.completed)} closed · {fmtInt(aiStats.stats.open)} open</> : <>—</>} />
              <MetricTile label="SMS sent" value={fmtInt(fleet.smsSent)} accent="#0891b2" sub={<>IB {fmtInt(split.inbound.smsSent)} · OB {fmtInt(split.outbound.smsSent)}</>} />
              <MetricTile label="Talk time" value={fmtDuration(fleet.talkMinutes)} accent="#6b7280" sub={<>zero staff minutes</>} />
            </div>
          </div>

          {/* Pipeline */}
          <div className="flex flex-col gap-3.5">
            <SectionLabel hint={periodLabel}>The pipeline</SectionLabel>
            <Card title="Leads reached → Real conversations → Qualified → Appointments" sub="Each step is unique leads; the pill is conversion from the step before">
              <StepFunnel stages={fleet.funnel} />
            </Card>
          </div>

          {/* Action items */}
          {aiStats && (aiStats.stats.created > 0 || aiStats.stats.open > 0) && (
            <div className="flex flex-col gap-3.5">
              <SectionLabel hint={`${fmtInt(aiStats.stats.open)} open · ${fmtInt(aiStats.stats.overdue)} overdue`}>Action items</SectionLabel>
              <Card title="Follow-up tasks the AI logged" sub="Created & closed for the period · open / overdue / due-today are live">
                <ActionItemsScoreboard stats={aiStats.stats} closers={aiStats.closers} periodLabel={periodLabel} />
              </Card>
            </div>
          )}

          {/* Appointments */}
          {namedAppts.length > 0 && (
            <div className="flex flex-col gap-3.5">
              <SectionLabel hint={`${fmtInt(namedAppts.length)} on the books`}>Appointments — named</SectionLabel>
              <Card title="On the books" sub="AI-booked = the AI created the meeting · AI-assisted = booked in your CRM on an AI-worked lead" pad={false}>
                <NamedApptsTable items={namedAppts.slice(0, 20)} teamId={teamId} />
              </Card>
            </div>
          )}

          <DefinitionsFooter tzLabel={feed?.timezone ? tzShortLabel(feed.timezone) : undefined} />
        </main>
      </div>
    </div>
  );
}
