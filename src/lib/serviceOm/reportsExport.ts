import { fmtInt, type Meeting } from "@/components/reports/data";
import { fmtWhenShort } from "@/components/reports/kitV3";
import type { ExportSheet, PdfSection } from "@/components/reports/exportReport";
import type { ActionRow } from "./overviewModel";
import type { AgentReport, FunnelStage, ServiceReportsModel } from "./reportsModel";

/* Reports > Agent performance (Service) → the Download menu's CSV / XLSX sheets and PDF sections, as the old
 * page had them (ticket 24973). Pure, and read only from what this page shows (the model, plus the complete
 * lists behind its appointment number and its action items), so a downloaded number is always the number on
 * screen. Sheets that would be empty are left out, as on the old page. */

export interface ExportInput {
  accountName: string;
  periodLabel: string;
  tzLabel: string;
  agent: AgentReport;
  model: ServiceReportsModel;
  /** Every appointment behind the agent's visits booked (the "view" list); null when it couldn't be loaded. */
  appointments: Meeting[] | null;
  /** Every open action item; null when it couldn't be loaded (the page's own first rows are used instead). */
  actionItems: ActionRow[] | null;
}

type Row = (string | number)[];
const dash = (v: number | null | undefined): string | number => (v === null || v === undefined ? "—" : v);
const pct = (v: number | null | undefined): string => (v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`);

export function agentLabel(a: AgentReport): string {
  return a.name ?? (a.direction === "inbound" ? "Inbound agent" : "Outbound agent");
}

/* Service definitions, the rules reportsModel.ts states, in the dealer's words. */
export const SERVICE_DEFINITION_ROWS: [string, string][] = [
  ["Booked by Spyne", "Service appointments the AI agent created in your scheduler during the period."],
  ["Spyne-assisted", "Appointments your team booked for a customer the AI had already spoken to. Counted in Visits booked where available, and shown separately."],
  ["Visits booked", "Booked by Spyne + Spyne-assisted for this agent. The same number as the Overview's By agent row and the funnel's Booked."],
  ["Connected / Reached", "Inbound: customers whose call the agent answered. Outbound: conversations the agent reached by call or text."],
  ["Engaged", "Inbound: customers who wanted a service. Outbound: conversations that went two or more turns."],
  ["Funnel adjustments", "Spyne-assisted customers are added to each stage above Booked, and a stage below the one under it is topped up, so the funnel never widens on the way down. Booked is never adjusted."],
  ["Not available (—)", "The Service Metrics API did not send that figure. It is never shown as 0."],
];
const SERVICE_DEFINITIONS = SERVICE_DEFINITION_ROWS.map(([t, d]) => `${t}: ${d}`).join("\n");

function stageNote(s: FunnelStage): string {
  const parts = [];
  if (s.assisted) parts.push(`includes ${fmtInt(s.assisted)} Spyne-assisted`);
  if (s.topUp) parts.push(`topped up by ${fmtInt(s.topUp)}`);
  return parts.join("; ");
}

function summaryRows(x: ExportInput): Row[] {
  const { agent: a } = x;
  const s = a.sections;
  const w = a.period.work;
  return [
    [`${x.accountName || "Rooftop"} — ${agentLabel(a)}`],
    ["Role", `Service · ${a.direction === "inbound" ? "Inbound" : "Outbound"}`],
    ["Period", x.periodLabel],
    ...(x.tzLabel ? [["Timezone", x.tzLabel]] : []),
    [],
    ["Metric", "Value"],
    ...s.activity.map((t): Row => [t.label, t.value]),
    ...(s.breakdown.hoursSplit ? [["Calls during hours", dash(s.breakdown.during)], ["Calls after hours", dash(s.breakdown.after)]] : []),
    ...s.breakdown.tiles.map((t): Row => [t.label, dash(t.value)]),
    [],
    ["Connect rate (per call)", s.quality.answerRate],
    ["Avg handle time", s.quality.handleTime],
    [s.quality.optOutsScope === "rooftop" ? "Opt-outs (whole rooftop)" : "Opt-outs", dash(s.quality.optOuts)],
    [],
    ["Booked by Spyne", dash(w.bookedBySpyne)],
    ["Spyne-assisted", w.assistedCounted ? dash(w.spyneAssisted) : "not available"],
    [s.totalLabel, dash(w.visitsBooked)],
    ["Booking rate", a.bookingRate ? pct(a.bookingRate.value) : "—"],
  ];
}

function funnelRows(a: AgentReport): Row[] {
  return [
    ["Stage", "Count", "Conversion from prior stage", "Note"],
    ...a.funnel.map((s): Row => [s.label, dash(s.customers), s.fromPrev ? pct(s.fromPrev.value) : "", stageNote(s)]),
  ];
}

function appointmentRows(list: Meeting[], tz: string | null): Row[] {
  return list.map((m) => [
    m.customer,
    m.phone ?? "",
    m.vehicle,
    m.intent ?? "",
    m.when ? fmtWhenShort(m.when, m.tz ?? tz) : "",
    m.bookedAt ? fmtWhenShort(m.bookedAt, tz) : "",
    m.status,
    m.assisted ? "Spyne-assisted" : m.source === "spyne" ? "Booked by Spyne" : m.source === "bdc" ? "Your team" : "",
  ]);
}

export function buildExportSheets(x: ExportInput): ExportSheet[] {
  const { agent: a, model } = x;
  const s = a.sections;
  const inbound = a.direction === "inbound";
  const sheets: ExportSheet[] = [
    { name: "Summary", rows: summaryRows(x) },
    { name: "Funnel", rows: funnelRows(a) },
  ];

  if (s.trend7) {
    sheets.push({ name: "7-day trend", rows: [["Day", s.trend7.assistedIncluded ? "Visits booked" : "Booked by Spyne"], ...s.trend7.labels.map((l, i): Row => [l, s.trend7!.values[i]])] });
  }
  if (s.timeOfDay) {
    sheets.push({ name: "Time of day", rows: [["Hour", "Calls"], ...s.timeOfDay.labels.map((l, i): Row => [l, s.timeOfDay!.values[i]])] });
  }
  // Hot & warm leads are on screen for the outbound agent only (the API's follow-up lists).
  const warm = inbound ? [] : model.warmLeads;
  if (warm.length) {
    sheets.push({
      name: "Warm leads",
      rows: [["Customer", "Phone", "Tier", "Interest", "Campaign", "Last activity"], ...warm.map((w): Row => [w.customer, w.phone, w.tier, w.interest, w.campaign, w.lastActivity ? fmtWhenShort(w.lastActivity, model.timezone) : ""])],
    });
  }
  // The complete list behind the agent's visits booked, with the reconciliation the old sheet carried.
  const booked = a.period.work.visitsBooked;
  if (x.appointments) {
    sheets.push({
      name: "Appointments",
      rows: [
        ["How to read this sheet"],
        ["Appointments listed", x.appointments.length],
        [`${s.totalLabel} on the report`, dash(booked)],
        booked === null || x.appointments.length === booked
          ? ["These agree", "Both read the Service Metrics API for this agent and period."]
          : ["Why they differ", "A booking made between the two reads appears in one before the other. Re-download to refresh."],
        [],
        ["Customer", "Phone", "Vehicle", "Services", "Appointment", "Booked at", "Status", "Booked by"],
        ...appointmentRows(x.appointments, model.timezone),
      ],
    });
  }
  if (model.upcoming?.length) {
    sheets.push({ name: "Upcoming", rows: [["Customer", "Phone", "Vehicle", "Services", "Appointment", "Booked at", "Status", "Booked by"], ...appointmentRows(model.upcoming, model.timezone)] });
  }

  const ai = model.actionItems;
  const aiRows = x.actionItems ?? ai.rows;
  sheets.push({
    name: "Action items",
    rows: [
      ["Open", "Overdue", "Due today", "Waiting on your BDC"],
      [dash(ai.openNow), dash(ai.pastSla), dash(ai.dueToday), dash(ai.waitingOnBdc)],
      [],
      ["Open queue — customer", "What to do", "Due", "Overdue"],
      ...aiRows.map((r): Row => [r.customer, r.what, r.due ? fmtWhenShort(r.due, model.timezone) : "", r.isLate ? "Yes" : "No"]),
    ],
  });

  sheets.push({ name: "Definitions", rows: [["Term", "What it means"], ...SERVICE_DEFINITION_ROWS] });
  return sheets;
}

export function buildPdfSections(x: ExportInput): PdfSection[] {
  const { agent: a, model } = x;
  const s = a.sections;
  const w = a.period.work;
  const inbound = a.direction === "inbound";
  const sections: PdfSection[] = [
    {
      heading: "Performance",
      blocks: [
        { kind: "stats", stats: [
          { value: w.visitsBooked === null ? "—" : fmtInt(w.visitsBooked), label: s.totalLabel, sub: w.assistedCounted ? `${fmtInt(w.bookedBySpyne ?? 0)} by Spyne + ${fmtInt(w.spyneAssisted ?? 0)} assisted` : "Booked by Spyne" },
          { value: a.bookingRate ? pct(a.bookingRate.value) : "—", label: "Booking rate" },
          ...s.activity.slice(0, 2).map((t) => ({ value: t.value, label: t.label })),
        ] },
        { kind: "rows", rows: [
          ...s.activity.map((t): Row => [t.label, t.value]),
          ...(s.breakdown.hoursSplit ? [["Calls during hours", dash(s.breakdown.during)], ["Calls after hours", dash(s.breakdown.after)]] : []),
        ] },
      ],
    },
    {
      heading: "Funnel",
      blocks: [
        { kind: "rows", columns: ["Stage", "Count", "Conversion from prior stage", "Note"], rows: funnelRows(a).slice(1) },
        { kind: "rows", title: "Call breakdown", rows: s.breakdown.tiles.map((t): Row => [t.label, t.value === null ? "—" : fmtInt(t.value)]) },
      ],
    },
    {
      heading: "Quality",
      blocks: [{ kind: "rows", rows: [
        ["Connect rate (per call)", s.quality.answerRate],
        ["Avg handle time", s.quality.handleTime],
        [s.quality.optOutsScope === "rooftop" ? "Opt-outs (whole rooftop)" : "Opt-outs", dash(s.quality.optOuts)],
      ] }],
    },
  ];
  if (x.appointments?.length) {
    const preview = x.appointments.slice(0, 30);
    sections.push({
      heading: "Appointments",
      blocks: [
        { kind: "rows", columns: ["Customer", "Vehicle", "Appointment", "Booked by", "Status"], rows: appointmentRows(preview, model.timezone).map((r) => [r[0], r[2] || "—", r[4] || "—", r[7] || "—", r[6] || "—"]) },
        ...(x.appointments.length > preview.length ? [{ kind: "note" as const, text: `Showing ${preview.length} of ${x.appointments.length} appointments — download the CSV or XLSX for the complete list.` }] : []),
      ],
    });
  }
  const warm = inbound ? [] : model.warmLeads;
  if (warm.length) {
    const preview = warm.slice(0, 20);
    sections.push({
      heading: "Hot & warm leads",
      blocks: [
        { kind: "rows", columns: ["Customer", "Phone", "Tier", "Interest", "Last activity"], rows: preview.map((l): Row => [l.customer, l.phone || "—", l.tier, l.interest, l.lastActivity ? fmtWhenShort(l.lastActivity, model.timezone) : "—"]) },
        ...(warm.length > preview.length ? [{ kind: "note" as const, text: `Showing the ${preview.length} most urgent of ${warm.length} warm leads — download the CSV or XLSX for the rest.` }] : []),
      ],
    });
  }
  const ai = model.actionItems;
  const aiRows = (x.actionItems ?? ai.rows);
  const aiPreview = aiRows.slice(0, 30);
  sections.push({
    heading: "Action items",
    blocks: [
      { kind: "rows", rows: [["Open now", dash(ai.openNow)], ["Overdue", dash(ai.pastSla)], ["Due today", dash(ai.dueToday)], ["Waiting on your BDC", dash(ai.waitingOnBdc)]] },
      { kind: "rows", title: "Open queue", columns: ["Customer", "What to do", "Due"], rows: aiPreview.map((r): Row => [r.customer, r.what, r.due ? fmtWhenShort(r.due, model.timezone) : "—"]) },
      ...(aiRows.length > aiPreview.length ? [{ kind: "note" as const, text: `Showing ${aiPreview.length} of ${aiRows.length} open items — download the CSV or XLSX for the complete list.` }] : []),
    ],
  });
  sections.push({ heading: "Definitions", blocks: [{ kind: "note", text: SERVICE_DEFINITIONS }] });
  return sections;
}
