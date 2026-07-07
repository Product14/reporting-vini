"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import {
  BUCKET_LABELS,
  Card,
  DateFilter,
  EmptyState,
  fmtInt,
  MeetingsModal,
  ReportTopBar,
  SectionLabel,
  type Bucket,
} from "@/components/reports/kit";
import { NamedApptsTable } from "@/components/reports/kitV3";
import { useScenario } from "@/components/reports/scenario";
import { useDateRange, useDept, reportNavQuery } from "@/components/reports/dateRange";
import { fetchAgents, agentsForAccount, aggregateFleet, addDay, peekAgents, type FetchResult } from "@/components/reports/liveData";
import type { NamedAppt } from "@/components/reports/data";
import { track } from "@/lib/analytics";

type Filter = "all" | "booked" | "assisted";

export default function AppointmentsPage() {
  return (
    <Suspense fallback={null}>
      <AppointmentsView />
    </Suspense>
  );
}

function AppointmentsView() {
  const { teamId, account, spyneToken, enterpriseId } = useScenario();
  const { bucket, custom, setPreset, setCustom } = useDateRange();
  const { dept } = useDept(); // top-level scope (shared header, URL-persisted)
  const navQuery = reportNavQuery(teamId, bucket, custom, dept);
  const periodLabel = custom ? `${custom.start} – ${custom.end}` : BUCKET_LABELS[bucket];
  const rangeOpts = custom ? { start: custom.start, end: addDay(custom.end), spyneToken } : { bucket, spyneToken };

  const [feed, setFeed] = useState<FetchResult | null>(() => peekAgents({ teamId, ...rangeOpts }));
  const [filter, setFilter] = useState<Filter>("all");
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => { track("report_viewed", { tab: "appointments", team_id: teamId }); }, [teamId]);
  useEffect(() => {
    if (!teamId) return;
    let on = true;
    setFeed(peekAgents({ teamId, ...rangeOpts }));
    fetchAgents({ teamId, ...rangeOpts }).then((r) => { if (on) setFeed(r); }).catch(() => {});
    return () => { on = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, bucket, custom]);

  const agents = useMemo(() => {
    const all = agentsForAccount(feed?.agents ?? [], account);
    return dept === "all" ? all : all.filter((a) => a.dept.toLowerCase() === dept);
  }, [feed, account, dept]);
  const fleet = useMemo(() => aggregateFleet(agents, feed?.prior), [agents, feed]);
  const appts = useMemo(() => (feed?.namedAppointments ?? []).filter((a) => dept === "all" || a.serviceType === dept), [feed, dept]);
  const filtered = useMemo<NamedAppt[]>(
    () => appts.filter((a) => (filter === "all" ? true : filter === "assisted" ? a.assisted : !a.assisted)),
    [appts, filter],
  );
  const meetingWindow: { start?: string; end?: string; bucket?: Bucket } =
    feed?.start && feed?.end ? { start: feed.start, end: feed.end } : { bucket };

  return (
    <div className="flex min-h-screen bg-[#fafafa]">
      <div className="flex flex-1 flex-col">
        <ReportTopBar
          title="Appointments"
          subtitle="Every appointment on the books — AI-booked and AI-assisted, by channel and status."
          active="appointments"
          teamId={teamId}
          query={navQuery}
          right={
            teamId ? (
              <DateFilter
                bucket={bucket}
                custom={custom}
                onPreset={(b) => { setPreset(b); track("date_range_changed", { tab: "appointments", range: b, team_id: teamId }); }}
                onCustom={(r) => { setCustom(r); track("date_range_changed", { tab: "appointments", range: "custom", team_id: teamId }); }}
              />
            ) : undefined
          }
        />

        <main className="mx-auto w-full max-w-[1320px] flex-1 px-10 pt-7 pb-36 flex flex-col gap-7">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatTile label="AI-booked" value={fmtInt(fleet.appointments)} sub="the AI created the meeting" accent="#059669" onClick={fleet.appointments > 0 ? () => { setModalOpen(true); track("appointments_drilldown_opened", { tab: "appointments", team_id: teamId }); } : undefined} />
            <StatTile label="AI-assisted (CRM)" value={fmtInt(fleet.appointmentsAssisted)} sub="booked in your CRM on an AI-worked lead" accent="#6d28d9" />
            <StatTile label="Close rate" value={fleet.qualified > 0 ? `${Math.round((100 * fleet.appointments) / fleet.qualified)}%` : "—"} sub="AI-booked ÷ qualified leads" accent="#2563eb" />
          </div>

          <div className="flex flex-col gap-3.5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <SectionLabel hint={`${periodLabel} · ${fmtInt(appts.length)} on the books`}>Every appointment — named</SectionLabel>
              <div className="no-print flex items-center gap-2">
                {(["all", "booked", "assisted"] as Filter[]).map((f) => (
                  <button key={f} onClick={() => setFilter(f)}
                    className={`rounded-md px-2.5 py-1 text-[11.5px] font-semibold transition-colors ${filter === f ? "bg-[#f3eaff] text-[#813fed]" : "text-[#6b7280] hover:text-[#111]"}`}>
                    {f === "all" ? "All" : f === "booked" ? "AI-booked" : "AI-assisted"}
                  </button>
                ))}
              </div>
            </div>
            <Card
              title="On the books"
              sub="AI-booked = the AI created the meeting · AI-assisted = booked in your CRM on a lead the AI worked (never counted in the headline)"
              pad={filtered.length === 0}
              right={fleet.appointments > 0 ? (
                <button onClick={() => { setModalOpen(true); track("appointments_drilldown_opened", { tab: "appointments", team_id: teamId }); }}
                  className="no-print rounded-lg border border-[#e5e7eb] bg-white px-3 py-1.5 text-[11.5px] font-semibold text-[#813fed] hover:bg-[#faf8ff]">
                  Live drill-down →
                </button>
              ) : undefined}
            >
              {filtered.length > 0 ? (
                <NamedApptsTable items={filtered} teamId={teamId} />
              ) : (
                <EmptyState icon="📅" title="No appointments in this view" body={`${account.name || "This rooftop"} has no ${filter === "assisted" ? "AI-assisted" : filter === "booked" ? "AI-booked" : ""} appointments for ${periodLabel}. Try widening the date range or the filter.`} />
              )}
            </Card>
          </div>
        </main>
      </div>
      <MeetingsModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={`Appointments · ${periodLabel}`}
        sub="Every booked appointment across this rooftop — sales & service"
        fetchOpts={{ teamId, enterpriseId, service: dept === "all" ? "both" : dept, scope: "window", ...meetingWindow, spyneToken }}
      />
    </div>
  );
}

function StatTile({ label, value, sub, accent, onClick }: { label: string; value: string; sub: string; accent: string; onClick?: () => void }) {
  const body = (
    <>
      <p className="text-[10px] font-bold uppercase tracking-wider text-[#6b7280]">{label}</p>
      <p className="mt-1 text-[26px] font-extrabold tabular-nums leading-none" style={{ color: accent }}>{value}</p>
      <p className="mt-1.5 text-[10.5px] leading-snug text-[#9ca3af]">{sub}</p>
    </>
  );
  const cls = "print-card flex flex-col rounded-2xl border border-[#e5e7eb] bg-white px-4 py-3.5 shadow-sm text-left";
  return onClick ? (
    <button onClick={onClick} className={`${cls} transition-shadow hover:shadow-md cursor-pointer`} style={{ borderTop: `3px solid ${accent}` }}>{body}</button>
  ) : (
    <div className={cls} style={{ borderTop: `3px solid ${accent}` }}>{body}</div>
  );
}
