"use client";

/* Service OM Reports: Reports > Agent performance for Service, rebuilt on the Service Metrics API (Om's v1.2
 * spec), beside the old page. Reached through src/proxy.ts for the rooftops on SERVICE_OM_VIEW_TEAMS, or
 * directly at /service-om/reports. Service only.
 *
 * Deliberately two things: the funnel and the appointment numbers. Every number comes from
 * useServiceReports → reportsModel.ts (the appointment numbers are the Overview's own), and clicking one
 * opens exactly the appointments it counted (A9). */

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { DateFilter, ReportTopBar, SectionLabel } from "@/components/reports/kit";
import { fmtInt, type Meeting } from "@/components/reports/data";
import { fmtWhenShort } from "@/components/reports/kitV3";
import { useScenario } from "@/components/reports/scenario";
import { useDateRange, reportNavQuery } from "@/components/reports/dateRange";
import { tzShortLabel } from "@/components/reports/liveData";
import { goCrossPage } from "@/components/reports/parentNav";
import { OmAppointmentsModal } from "./OmAppointmentsModal";
import { track } from "@/lib/analytics";
import type { AppointmentListQuery } from "@/lib/serviceOm/contract";
import { loadAppointmentList, resolveOmSource, type OmSource } from "@/lib/serviceOm/source";
import { useServiceReports } from "@/lib/serviceOm/useServiceOverview";
import { countedTypes } from "@/lib/serviceOm/overviewModel";
import { toMeetings, type AgentReport, type ServiceReportsModel } from "@/lib/serviceOm/reportsModel";
import { Anims } from "../overview/cards";
import { AgentPicker, AppointmentsCard, FunnelCard, type AppointmentKind } from "./reportCards";
import { ActivityAndBreakdown, LowerSections } from "./OmSections";
import { OmAgentCards } from "./OmAgentCards";
import { OmReportLibraryPanel } from "./OmLibraryPanel";

export default function ServiceReportsPage() {
  return (
    <Suspense fallback={null}>
      <ServiceReportsView />
    </Suspense>
  );
}

interface Popup {
  title: string;
  sub: string;
  expected: number | null;
  items: Meeting[] | null; // null while loading
  failed?: boolean;
}

function ServiceReportsView() {
  const { bucket, custom, setPreset, setCustom } = useDateRange();
  const { teamId, account, spyneToken, spyneEnv, enterpriseId } = useScenario();
  const search = useSearchParams();
  const source: OmSource = resolveOmSource(search.get("om_source"));
  // `?om_assisted=off` (sample data, local dev only): answer the way UAT does today, Spyne-assisted not available.
  const mockAssistedOff = source === "mock" && process.env.NODE_ENV !== "production" && search.get("om_assisted") === "off";
  const ctx = { teamId, enterpriseId, spyneToken, spyneEnv, nameHint: account.name, agents: account.agents, mockAssistedOff };
  const { model, loading, window: w, refresh } = useServiceReports({ source, bucket, custom, ...ctx });
  const navQuery = reportNavQuery(teamId, bucket, custom, "service", true, "new");
  const hasTeam = teamId !== "";
  const tzLabel = model?.timezone ? tzShortLabel(model.timezone) : "";

  // Which agent is open: ?agent= from the Overview's drill-down (an id, or "inbound" / "outbound"), else the first.
  const wanted = (search.get("agent") ?? "").toLowerCase();
  const [picked, setPicked] = useState<string | null>(null);
  const agents = useMemo(() => model?.agents ?? [], [model]);
  const selected = useMemo(() => {
    if (picked && agents.some((a) => a.key === picked)) return picked;
    const byParam = agents.find((a) => a.key.toLowerCase() === wanted || (wanted && a.direction === wanted));
    return byParam?.key ?? agents[0]?.key ?? null;
  }, [agents, picked, wanted]);
  const agent = agents.find((a) => a.key === selected) ?? null;

  // Agent report ⇄ All reports, at the same URL, as on the old page (`?view=reports` opens All reports).
  const [view, setView] = useState<"agent" | "library">(search.get("view") === "reports" ? "library" : "agent");
  const [libraryReport, setLibraryReport] = useState<string | null>(null);
  const openAgent = (key: string) => { setPicked(key); setView("agent"); window.scrollTo({ top: 0, behavior: "smooth" }); };

  useEffect(() => { track("report_viewed", { tab: "agents", team_id: teamId }); }, [teamId]);

  /* The popup: open on a click, fill when the rows arrive. `expected` is the number that was clicked; if the
     rows ever disagree with it the popup says so instead of quietly showing a different count (A9). */
  const [popup, setPopup] = useState<Popup | null>(null);
  const openList = (title: string, sub: string, expected: number | null, q: AppointmentListQuery) => {
    track("appointments_drilldown_opened", { tab: "agents", team_id: teamId, agent: agent?.key });
    setPopup({ title, sub, expected, items: null });
    loadAppointmentList(source, ctx, w, q)
      .then((list) => setPopup((p) => (p && p.title === title ? { ...p, items: list ? toMeetings(list.items, model?.timezone ?? null) : [], failed: !list } : p)))
      .catch(() => setPopup((p) => (p && p.title === title ? { ...p, items: [], failed: true } : p)));
  };
  const who = (a: AgentReport) => a.name ?? (a.direction === "inbound" ? "Inbound agent" : "Outbound agent");
  // Each list asks for exactly the types its number counted: without Spyne-assisted where it isn't available.
  const onViewBooked = () => {
    if (!agent) return;
    const counted = agent.period.work.assistedCounted ? "Booked by Spyne and Spyne-assisted" : "Booked by Spyne (Spyne-assisted not available)";
    openList(`${who(agent)} · Booked`, `${counted}, ${agent.direction}, ${w.phrase}`, agent.bookedAppointments, { basis: "booked", direction: agent.direction, types: countedTypes(agent.period.work) });
  };
  const onOpenAppointments = (kind: AppointmentKind) => {
    if (!agent) return;
    const pw = agent.period.work;
    const types: Array<"booked_by_spyne" | "spyne_assisted"> = kind === "booked" ? ["booked_by_spyne"] : kind === "assisted" ? ["spyne_assisted"] : countedTypes(pw);
    const label = kind === "booked" ? "Booked by Spyne" : kind === "assisted" ? "Assisted by Spyne" : "Visits booked";
    const expected = kind === "booked" ? pw.bookedBySpyne : kind === "assisted" ? pw.spyneAssisted : pw.visitsBooked;
    openList(`${who(agent)} · ${label}`, `Appointments booked ${w.phrase}`, expected, { basis: "booked", direction: agent.direction, types });
  };

  const popupSub = popup
    ? popup.items === null
      ? popup.sub
      : popup.failed
        ? `${popup.sub} · the list could not be loaded`
        : popup.expected !== null && popup.items.length !== popup.expected
          ? `${popup.sub} · ⚠ ${fmtInt(popup.items.length)} rows for a count of ${fmtInt(popup.expected)}`
          : popup.sub
    : "";

  const controls = hasTeam ? (
    <div className="no-print flex min-w-0 flex-wrap items-center gap-2 sm:gap-3">
      {source === "mock" && (
        <span className="rounded-full border border-[#f5d48a] bg-[#fff8e6] px-2.5 py-1 text-[11px] font-semibold text-[#8a5a00]" title="Om's Service Metrics API isn't connected yet. Every number on this page is made up.">
          Sample data{mockAssistedOff ? " · assisted off" : ""}
        </span>
      )}
      <DateFilter
        bucket={bucket}
        custom={custom}
        onPreset={(b) => { setPreset(b); track("date_range_changed", { tab: "agents", range: b, team_id: teamId }); }}
        onCustom={(r) => { setCustom(r); track("date_range_changed", { tab: "agents", range: "custom", team_id: teamId }); }}
      />
      <button
        onClick={() => { track("report_refreshed", { tab: "agents", team_id: teamId }); refresh(); }}
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
  ) : null;

  return (
    <div className="flex min-h-screen bg-[#fafafa]">
      <div className="flex min-w-0 flex-1 flex-col">
        <ReportTopBar
          title="Agent performance"
          subtitle="The funnel and the appointments, by agent — Service, inbound & outbound."
          active="agents"
          teamId={teamId}
          query={navQuery}
          hideTabs
          hideDept
          right={controls}
        />
        <main className="mx-auto w-full max-w-[1320px] flex-1 px-4 sm:px-6 lg:px-10 pt-7 pb-36 flex flex-col gap-6">
          {!hasTeam ? (
            <div className="rounded-2xl border border-[#e5e7eb] bg-white px-6 py-8 text-center">
              <p className="text-[14px] font-bold text-[#111]">No rooftop selected</p>
              <p className="mt-1 text-[12.5px] text-[#6b7280]">Open this report from the console, or add <code>?team_id=…</code> to the URL.</p>
            </div>
          ) : (
            <>
              <Anims />
              <SectionLabel hint={[tzLabel ? `Times in ${tzLabel}` : "", model?.asOf ? `as of ${fmtWhenShort(model.asOf, model.timezone)}` : ""].filter(Boolean).join(" · ") || undefined}>Performance · {w.label}</SectionLabel>
              {/* Agent report ⇄ All reports (markup from the old page). */}
              <div className="no-print flex items-center gap-1 self-start rounded-xl bg-[#f1f2f5] p-1">
                {([["agent", "Agent report"], ["library", "All reports"]] as const).map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => { setView(v); setLibraryReport(null); }}
                    aria-pressed={view === v}
                    className={`rounded-lg px-4 py-1.5 text-[12.5px] font-semibold transition-colors ${view === v ? "bg-white text-[#813fed] shadow-sm" : "text-[#6b7280] hover:text-[#374151]"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {view === "library" ? (
                <OmReportLibraryPanel
                  navQuery={navQuery}
                  initialReportId={libraryReport}
                  agentCards={<OmAgentCards agents={agents} periodLabel={w.label} loading={loading || !model} onOpenAgent={openAgent} />}
                />
              ) : model && agents.length === 0 && !loading ? (
                <p className="rounded-2xl border border-[#e5e7eb] bg-white px-6 py-6 text-[12.5px] text-[#6b7280]">
                  {model.agentsReason ? `Not available: ${model.agentsReason}` : "This rooftop runs no Service agent."}
                </p>
              ) : (
                <div className="lv-rise"><AgentPicker agents={agents} selected={selected} onPick={setPicked} loading={loading} /></div>
              )}
              {view === "agent" && agent && (
                <>
                  <div className="lv-rise" style={{ animationDelay: "60ms" }}>
                    <FunnelCard agent={agent} windowPhrase={w.phrase} tzLabel={tzLabel} loading={loading} onViewBooked={onViewBooked}>
                      <ActivityAndBreakdown s={agent.sections} inbound={agent.direction === "inbound"} />
                    </FunnelCard>
                  </div>
                  <div className="lv-rise" style={{ animationDelay: "120ms" }}><AppointmentsCard period={agent.period} direction={agent.direction} windowPhrase={w.phrase} loading={loading} onOpen={onOpenAppointments} /></div>
                  {/* Below: the old report's sections, same look, on the Service Metrics API (OmSections). */}
                  {model && (
                    <LowerSections
                      agent={agent}
                      model={model}
                      periodLabel={w.label}
                      loading={loading}
                      onViewLeads={() => onOpenAppointments("visits")}
                      onViewAllActions={() => goCrossPage("actions", { enterpriseId, teamId, serviceType: "service" }, `/reports/action-items${navQuery}`)}
                      // All reports on this page: the library, with Your agents on the same numbers as above.
                      onOpenLibrary={(reportId?: string) => { setLibraryReport(reportId ?? null); setView("library"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                    />
                  )}
                </>
              )}
              <MatchLine model={model} source={source} label={w.label} />
            </>
          )}
        </main>
      </div>
      {/* Opens once the rows are in, so it never flashes "No appointments" while they load. */}
      {popup && popup.items === null && (
        <div className="fixed bottom-6 left-1/2 z-[80] -translate-x-1/2 rounded-full bg-[#15161d] px-4 py-2 text-[12px] font-medium text-white shadow-lg">Loading appointments…</div>
      )}
      <OmAppointmentsModal open={popup !== null && popup.items !== null} onClose={() => setPopup(null)} title={popup?.title ?? ""} sub={popupSub} items={popup?.items ?? []} />
    </div>
  );
}

/* The reconciliation, spelled out: this page's agents plus unplaced equal the Overview's headline for the
 * same window (A1, A6), and the read time and rule version they came from (G7, API5). */
function MatchLine({ model, source, label }: { model: ServiceReportsModel | null; source: OmSource; label: string }) {
  if (!model) return null;
  const a = model.appointments;
  const parts = model.agents.map((x) => `${x.name ?? x.direction} ${fmtInt(x.period.work.visitsBooked ?? 0)}`);
  if (a.unplaced > 0) parts.push(`unplaced ${fmtInt(a.unplaced)}`);
  return (
    <p className="text-center text-[11px] text-[#9aa1ac]">
      {a.total !== null && `Overview for ${label}: ${fmtInt(a.total)} appointments = ${parts.join(" + ")} · `}
      {source === "mock" ? "Sample data, not from the Service Metrics API" : "Service Metrics API"}
      {model.asOf ? ` · as of ${fmtWhenShort(model.asOf, model.timezone)}` : ""}
      {model.definitionVersion ? ` · definition ${model.definitionVersion}` : ""}
    </p>
  );
}
