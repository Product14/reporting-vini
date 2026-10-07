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
  fmtWhenShort,
  MetricTile,
  NamedApptsTable,
  ValueTile,
} from "@/components/reports/kitV3";
import { useScenario } from "@/components/reports/scenario";
import { useDateRange, useDept, reportNavQuery, useVariant } from "@/components/reports/dateRange";
import {
  fetchAgents,
  fetchActionItemStats,
  agentsForAccount,
  aggregateFleet,
  unattributedApptsFor,
  assistedApptsFor,
  rooftopRungsFor,
  workedByBoth,
  addDay,
  peekAgents,
  tzShortLabel,
  type FetchResult,
  type ActionItemStats,
  type ActionItemCloser,
} from "@/components/reports/liveData";
import { track } from "@/lib/analytics";
import { buildPdfReport } from "@/components/reports/printToPdf";
import { CANONICAL_DEFINITIONS, exportFilenameStem, type PdfSection } from "@/components/reports/exportReport";

/* A headline with its Inbound/Outbound bracket, naming the leads the two disagree about. The headline
   is a DISTINCT lead count when the canonical rooftop rungs are in scope; the split beside it is still
   agent-summed (no canonical per-direction rooftop figure exists), so a lead both agents worked is
   counted once in the headline and twice in the bracket. Derived from the rendered values only. */
const splitRow = (total: number, inbound: number, outbound: number): string => {
  const parts = [`Inbound ${fmtInt(inbound)}`, `Outbound ${fmtInt(outbound)}`];
  const both = workedByBoth(total, inbound, outbound);
  if (both > 0) parts.push(`worked by both ${fmtInt(both)}`);
  return `${fmtInt(total)} (${parts.join(" · ")})`;
};

/* The same caveat as a tile row — see ValueTile's `overlap`. undefined when the numbers already add up. */
const overlapRow = (total: number, inbound: number, outbound: number): string | undefined => {
  const n = workedByBoth(total, inbound, outbound);
  return n > 0 ? fmtInt(n) : undefined;
};

export default function ReportingPage() {
  return (
    <Suspense fallback={null}>
      <ReportingView />
    </Suspense>
  );
}

function ReportingView() {
  const { teamId, account, spyneToken, spyneEnv } = useScenario();
  const { bucket, custom, setPreset, setCustom } = useDateRange();
  const { dept } = useDept();
  const svc = dept === "all" ? "both" : dept; // shared dept scope → action-items serviceType
  // variant rides along so the Old/New choice survives navigation between tabs.
  const { variant } = useVariant();
  const navQuery = reportNavQuery(teamId, bucket, custom, dept, false, variant);
  const periodLabel = custom ? `${custom.start} – ${custom.end}` : BUCKET_LABELS[bucket];
  const rangeOpts = custom ? { start: custom.start, end: addDay(custom.end), spyneToken, spyneEnv } : { bucket, spyneToken, spyneEnv };

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
    fetchActionItemStats(teamId, { start: feed?.start, end: feed?.end, service: svc, spyneToken, spyneEnv }).then((r) => { if (on) setAiStats(r); });
    return () => { on = false; };
  }, [teamId, feed?.start, feed?.end, svc, spyneToken, spyneEnv]);

  // Scope to the rooftop's agents, then to the selected department (the shared header switcher).
  const allAgents = useMemo(() => agentsForAccount(feed?.agents ?? [], account), [feed, account]);
  const agents = useMemo(() => (dept === "all" ? allAgents : allAgents.filter((a) => a.dept.toLowerCase() === dept)), [allAgents, dept]);
  // rooftopRungsFor gets the SAME list and dept as aggregateFleet — it is what decides whether the
  // rooftop's distinct counts may stand in for the agent sum at all. See liveData.ts.
  const fleet = useMemo(() => aggregateFleet(agents, feed?.prior, unattributedApptsFor(feed, dept), assistedApptsFor(feed, dept), rooftopRungsFor(feed, dept, agents)), [agents, feed, dept]);
  const split = fleet.bySplit;
  const namedAppts = useMemo(() => (feed?.namedAppointments ?? []).filter((a) => dept === "all" || a.serviceType === dept), [feed, dept]);

  const handlePrint = async () => {
    track("report_exported", { tab: "reporting", team_id: teamId, format: "print" });
    const tzLabel = feed?.timezone ? tzShortLabel(feed.timezone) : "";
    const sections: PdfSection[] = [
      {
        heading: "The value delivered",
        blocks: [
          {
            kind: "rows",
            rows: [
              // The bracketed split must account for the whole headline — a booking that belongs to no
              // agent has no direction, so it is named rather than left to look like an arithmetic error.
              ["Appointments — AI-booked", (() => {
                const noAgent = fleet.appointments - split.inbound.appointments - split.outbound.appointments;
                const parts = [`Inbound ${fmtInt(split.inbound.appointments)}`, `Outbound ${fmtInt(split.outbound.appointments)}`];
                if (noAgent > 0) parts.push(`no agent ${fmtInt(noAgent)}`);
                return `${fmtInt(fleet.appointments)} (${parts.join(" · ")})`;
              })()],
              ...(fleet.appointmentsAssisted > 0 ? [["  AI-assisted (CRM)", fmtInt(fleet.appointmentsAssisted)]] : []),
              /* Same rule as the appointments row above, for the other way a bracket fails to add up:
                 the headline is a DISTINCT lead count and the split is still agent-summed, so a lead
                 both agents worked is once in the total and twice in the bracket. Named rather than
                 left to read as an arithmetic error (253 over Inbound+Outbound = 270, team 3d3deabc98). */
              ["Real conversations", splitRow(fleet.conversations, split.inbound.conversations, split.outbound.conversations)],
              ["Qualified leads", splitRow(fleet.qualified, split.inbound.qualified, split.outbound.qualified)],
              ["Hand-offs to team", `${fmtInt(fleet.handoffs)} (${fmtInt(fleet.transfers)} transfers · ${fmtInt(fleet.callbacks)} callbacks)`],
              ["Query resolution rate", fmtRate(fleet.queryResolved, fleet.queryConversations)],
              ...(fleet.responseTimeSec != null ? [["Response time (avg first response)", fmtSecs(fleet.responseTimeSec)]] : []),
              ["SMS sent", `${fmtInt(fleet.smsSent)} (Inbound ${fmtInt(split.inbound.smsSent)} · Outbound ${fmtInt(split.outbound.smsSent)})`],
              ["Talk time", fmtDuration(fleet.talkMinutes)],
            ],
          },
        ],
      },
      {
        heading: "The pipeline",
        blocks: [{ kind: "rows", columns: ["Stage", "Leads (distinct)", "Conversion from prior stage"], rows: fleet.funnel.map((s, i) => {
          const prev = i > 0 ? fleet.funnel[i - 1].value : null;
          const conv = prev && prev > 0 ? `${Math.round((100 * s.value) / prev)}%` : "—";
          return [s.label, fmtInt(s.value), conv];
        }) }],
      },
    ];

    if (aiStats && (aiStats.stats.created > 0 || aiStats.stats.open > 0)) {
      sections.push({
        heading: "Action items",
        blocks: [
          {
            kind: "rows",
            rows: [
              ["Created", fmtInt(aiStats.stats.created)],
              ["Completed", fmtInt(aiStats.stats.completed)],
              ["Open now", fmtInt(aiStats.stats.open)],
              ["Overdue", fmtInt(aiStats.stats.overdue)],
              ["Due today", fmtInt(aiStats.stats.dueToday)],
            ],
          },
          ...(aiStats.closers.length ? [{ kind: "rows" as const, title: "Closed by", columns: ["Team member", "Closed"], rows: aiStats.closers.map((c) => [c.assignedTo, fmtInt(c.closed)]) }] : []),
        ],
      });
    }

    if (namedAppts.length > 0) {
      const preview = namedAppts.slice(0, 30);
      sections.push({
        heading: "Appointments — named",
        blocks: [
          {
            kind: "rows",
            columns: ["Customer", "Vehicle", "When", "How booked", "Status"],
            rows: preview.map((ap) => [ap.customer, ap.vehicle || "—", ap.when ? fmtWhenShort(ap.when, feed?.timezone) : "—", ap.how, ap.status || "—"]),
          },
          ...(namedAppts.length > preview.length
            ? [{ kind: "note" as const, text: `Showing the ${preview.length} most recent of ${namedAppts.length} appointments — download the CSV or XLSX for the complete list.` }]
            : []),
        ],
      });
    }

    sections.push({ heading: "Definitions", blocks: [{ kind: "note", text: CANONICAL_DEFINITIONS }] });

    await buildPdfReport(sections, {
      filename: `${exportFilenameStem(account.name, periodLabel)}.pdf`,
      title: `${account.name || "Rooftop"} — Vini AI Scorecard`,
      subtitle: `${periodLabel}${tzLabel ? ` · times in ${tzLabel}` : ""}`,
    });
  };

  return (
    <div className="flex min-h-screen bg-white">
      <div className="flex min-w-0 flex-1 flex-col">
        <ReportTopBar
          title="Reporting"
          subtitle="A one-page scorecard for this rooftop — print it or save as PDF to share."
          active="reporting"
          teamId={teamId}
          query={navQuery}
          right={
            teamId ? (
              <div className="no-print flex min-w-0 flex-wrap items-center gap-2 sm:gap-3">
                <DateFilter
                  bucket={bucket}
                  custom={custom}
                  onPreset={(b) => { setPreset(b); track("date_range_changed", { tab: "reporting", range: b, team_id: teamId }); }}
                  onCustom={(r) => { setCustom(r); track("date_range_changed", { tab: "reporting", range: "custom", team_id: teamId }); }}
                />
                <button
                  onClick={handlePrint}
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
              <ValueTile label="Real conversations" total={fmtInt(fleet.conversations)} inbound={fmtInt(split.inbound.conversations)} outbound={fmtInt(split.outbound.conversations)} overlap={overlapRow(fleet.conversations, split.inbound.conversations, split.outbound.conversations)} accent="purple" subtext={<>spoke or replied — voicemail excluded</>} />
              <ValueTile label="Qualified leads" total={fmtInt(fleet.qualified)} inbound={fmtInt(split.inbound.qualified)} outbound={fmtInt(split.outbound.qualified)} overlap={overlapRow(fleet.qualified, split.inbound.qualified, split.outbound.qualified)} accent="violet" subtext={<>concrete buying intent</>} />
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
              <Card title="On the books" sub="AI-booked = the AI created the meeting · AI-assisted = you booked it, on a lead the AI had already spoken to" pad={false}>
                <NamedApptsTable items={namedAppts.slice(0, 20)} teamId={teamId} tz={feed?.timezone} />
              </Card>
            </div>
          )}

          <DefinitionsFooter tzLabel={feed?.timezone ? tzShortLabel(feed.timezone) : undefined} />
        </main>
      </div>
    </div>
  );
}
