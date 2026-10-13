"use client";

/* Service OM Overview: the Service Overview rebuilt on the Service Metrics API (Om's v1.2 spec), beside the
 * old page. Reached through src/proxy.ts for the rooftops on SERVICE_OM_VIEW_TEAMS, or directly at
 * /service-om/overview. Service only: Sales never comes here.
 *
 * Every number on this page comes from one place, useServiceOverview → overviewModel.ts. Until Om's
 * endpoints ship the source is sample data (source.ts), and the page says so on screen. */

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { DateFilter, ReportTopBar } from "@/components/reports/kit";
import { fmtInt } from "@/components/reports/data";
import { fmtWhenShort } from "@/components/reports/kitV3";
import { UnlockPotentialBanner } from "@/components/reports/valueStory";
import { useScenario } from "@/components/reports/scenario";
import { useDateRange, reportNavQuery } from "@/components/reports/dateRange";
import { goCrossPage } from "@/components/reports/parentNav";
import { tzShortLabel } from "@/components/reports/liveData";
import { buildPdfReport } from "@/components/reports/printToPdf";
import { exportFilenameStem, type PdfSection } from "@/components/reports/exportReport";
import { track } from "@/lib/analytics";
import { resolveOmSource, type OmSource } from "@/lib/serviceOm/source";
import { useServiceOverview } from "@/lib/serviceOm/useServiceOverview";
import type { ServiceOverviewModel } from "@/lib/serviceOm/overviewModel";
import { ActionItemsTable, Anims, BADGE, ByAgentCard, ServiceHero, UpcomingAppointmentsCard } from "./cards";

export default function ServiceOverviewPage() {
  return (
    <Suspense fallback={null}>
      <ServiceOverviewView />
    </Suspense>
  );
}

function ServiceOverviewView() {
  const { bucket, custom, setPreset, setCustom } = useDateRange();
  const { teamId, account, spyneToken, spyneEnv, enterpriseId } = useScenario();
  const search = useSearchParams();
  const source: OmSource = resolveOmSource(search.get("om_source"));
  // `?om_assisted=off` (sample data, local dev only): answer the way UAT does today, Spyne-assisted not available.
  const mockAssistedOff = source === "mock" && process.env.NODE_ENV !== "production" && search.get("om_assisted") === "off";
  const { model, loading, window: w, refresh } = useServiceOverview({ source, bucket, custom, teamId, enterpriseId, spyneToken, spyneEnv, nameHint: account.name, agents: account.agents, mockAssistedOff });
  // Service is the only scope here; the links carry it so the console's pages open on Service too.
  const navQuery = reportNavQuery(teamId, bucket, custom, "service", true, "new");
  const hasTeam = teamId !== "";
  const [exporting, setExporting] = useState(false);

  useEffect(() => { track("report_viewed", { tab: "overview", team_id: teamId }); }, [teamId]);

  const toAppointments = () => goCrossPage("appointments", { enterpriseId, teamId, serviceType: "service" }, `/reports/appointments${navQuery}`);
  const toActionItems = () => {
    track("action_items_opened", { tab: "overview", team_id: teamId });
    goCrossPage("actions", { enterpriseId, teamId, serviceType: "service" }, `/reports/action-items${navQuery}`);
  };

  const onExportPdf = async () => {
    if (!model) return;
    setExporting(true);
    track("report_exported", { tab: "overview", team_id: teamId, format: "pdf", range: custom ? "custom" : bucket });
    try {
      await buildPdfReport(pdfSections(model, source), {
        filename: `${exportFilenameStem(account.name, w.label)}.pdf`,
        title: `${account.name || "Rooftop"} — Service Overview`,
        subtitle: `${w.label}${model.timezone ? ` · times in ${tzShortLabel(model.timezone)}` : ""}`,
      });
    } finally {
      setExporting(false);
    }
  };

  const controls = hasTeam ? (
    <div className="no-print flex min-w-0 flex-wrap items-center gap-2 sm:gap-3">
      {source === "mock" && (
        <span className="rounded-full border border-[#f5d48a] bg-[#fff8e6] px-2.5 py-1 text-[11px] font-semibold text-[#8a5a00]" title="Om's Service Metrics API isn't connected yet. Every number on this page is made up.">
          Sample data{mockAssistedOff ? " · assisted off" : ""}
        </span>
      )}
      <button
        onClick={onExportPdf}
        disabled={exporting || !model}
        title="Download this report as a PDF for the selected period"
        className="flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-[#813fed] px-3 text-[12px] font-bold text-white transition-colors hover:bg-[#6d28d9] disabled:opacity-50"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v12M7 11l5 5 5-5M5 21h14" />
        </svg>
        {exporting ? "Preparing…" : "Export PDF"}
      </button>
      <DateFilter
        bucket={bucket}
        custom={custom}
        onPreset={(b) => { setPreset(b); track("date_range_changed", { tab: "overview", range: b, team_id: teamId }); }}
        onCustom={(r) => { setCustom(r); track("date_range_changed", { tab: "overview", range: "custom", team_id: teamId }); }}
      />
      <button
        onClick={() => { track("report_refreshed", { tab: "overview", team_id: teamId }); refresh(); }}
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
          title="Overview"
          subtitle="What your AI agents delivered — appointments, conversations and hand-offs, in one report."
          active="overview"
          teamId={teamId}
          query={navQuery}
          hideTabs
          hideDept
          right={controls}
        />
        <main className="mx-auto w-full max-w-[1320px] flex-1 px-4 sm:px-6 lg:px-10 pt-7 pb-36 flex flex-col gap-9">
          {!hasTeam ? (
            <div className="rounded-2xl border border-[#e5e7eb] bg-white px-6 py-8 text-center">
              <p className="text-[14px] font-bold text-[#111]">No rooftop selected</p>
              <p className="mt-1 text-[12.5px] text-[#6b7280]">Open this report from the console, or add <code>?team_id=…</code> to the URL.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <Anims />
              <div className="lv-rise"><ServiceHero model={model} loading={loading} nav={{ onAppointments: toAppointments, onActionItems: toActionItems }} /></div>
              <div className="lv-rise" style={{ animationDelay: "70ms" }}><ByAgentCard agents={model?.agents ?? null} unplaced={model?.appointments.unplaced ?? 0} loading={loading} /></div>
              <div className="lv-rise" style={{ animationDelay: "140ms" }}><UnlockPotentialBanner liveCount={1} total={3} teamId={teamId} accountName={account.name} /></div>
              <div className="lv-rise flex" style={{ animationDelay: "210ms" }}><UpcomingAppointmentsCard upcoming={model?.upcoming ?? null} tz={model?.timezone} loading={loading} onViewAll={toAppointments} /></div>
              <div className="lv-rise" style={{ animationDelay: "280ms" }}><ActionItemsTable actionItems={model?.actionItems ?? null} loading={loading} onViewAll={toActionItems} /></div>
              <AsOfLine model={model} source={source} />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

/* G7: the time the numbers were read, and the rule version they were read under, so a reader comparing
 * this page with Reports can tell whether they are looking at the same read. */
function AsOfLine({ model, source }: { model: ServiceOverviewModel | null; source: OmSource }) {
  if (!model) return null;
  const tz = model.timezone ? ` ${tzShortLabel(model.timezone)}` : "";
  return (
    <p className="text-center text-[11px] text-[#9aa1ac]">
      {source === "mock" ? "Sample data, not from the Service Metrics API" : "Service Metrics API"}
      {model.asOf ? ` · as of ${fmtWhenShort(model.asOf, model.timezone)}${tz}` : ""}
      {model.definitionVersion ? ` · definition ${model.definitionVersion}` : ""}
    </p>
  );
}

function pdfSections(m: ServiceOverviewModel, source: OmSource): PdfSection[] {
  const a = m.appointments;
  const split = a.total === null ? "not available" : [`${fmtInt(a.inbound ?? 0)} inbound`, `${fmtInt(a.outbound ?? 0)} outbound`, ...(a.unplaced > 0 ? [`${fmtInt(a.unplaced)} unplaced`] : [])].join(" · ");
  const sections: PdfSection[] = [
    {
      heading: "What your Service AI agents handled",
      blocks: [
        {
          kind: "stats",
          stats: [
            { value: m.actionItems.openNow === null ? "—" : fmtInt(m.actionItems.openNow), label: "Action items", sub: "open now" },
            { value: a.total === null ? "—" : fmtInt(a.total), label: "Appointments", sub: split },
          ],
        },
      ],
    },
    {
      heading: "Upcoming appointments",
      blocks: [{
        kind: "rows",
        columns: ["Customer", "Vehicle", "When", "Type"],
        rows: m.upcoming.rows.map((r) => [r.customer, r.vehicle || "—", r.when ? fmtWhenShort(r.when, m.timezone) : "—", BADGE[r.kind].label]),
      }],
    },
    {
      heading: "Action items",
      blocks: [{
        kind: "rows",
        columns: ["Customer", "What to do", "Due", "Status"],
        rows: m.actionItems.rows.map((r) => [r.customer, r.what, r.due ? fmtWhenShort(r.due, m.timezone) : "—", r.isLate ? "Past SLA" : "Open"]),
      }],
    },
  ];
  if (source === "mock") sections.push({ heading: "Note", blocks: [{ kind: "note", text: "Sample data. Om's Service Metrics API is not connected yet; every number in this file is made up." }] });
  return sections;
}
