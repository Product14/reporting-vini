/* Ticket 24973: Service OM Reports > Agent performance gets the old page's Download menu back. The downloads
 * are the numbers on screen: the Summary and Funnel sheets are the page's, the Appointments sheet is the list
 * behind its visits booked, and the Action items sheet is every open item, not the page's first 50. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExportSheets, buildPdfSections } from "@/lib/serviceOm/reportsExport";
import { mockActionItems, mockAgents, mockAppointmentList, mockAppointments, mockCallsReport, mockCampaign, mockContact, mockFollowUp, type MockCtx } from "@/lib/serviceOm/mock";
import { countedTypes, overviewActionItems } from "@/lib/serviceOm/overviewModel";
import { buildServiceReports, toMeetings } from "@/lib/serviceOm/reportsModel";
import { resolveWindow } from "@/lib/serviceOm/window";

const NOW = Date.parse("2026-10-13T18:00:00Z");
const TZ = "America/Los_Angeles";
const CTX: MockCtx = { teamId: "2b110492b6", nameHint: "Honda Reseda", agents: ["Service Inbound", "Service Outbound"], now: NOW };

function page(bucket: "last7" | "last30") {
  const w = resolveWindow(bucket, null, TZ);
  const w7 = resolveWindow("last7", null, TZ);
  const model = buildServiceReports({
    appointments: mockAppointments(CTX, w),
    campaign: mockCampaign(CTX, w),
    contactInbound: mockContact(CTX, w, "inbound"),
    contactOutbound: mockContact(CTX, w, "outbound"),
    upcoming: mockAppointments(CTX, w, { list: "upcoming", limit: 20 }),
    actionItems: mockActionItems(CTX, w, { limit: 50 }),
    callsReport: mockCallsReport(CTX, w),
    followUp: mockFollowUp(CTX, w, "warmLeads", 50),
    trendInbound: mockAppointments(CTX, w7, { grain: "day", direction: "inbound" }),
    trendOutbound: mockAppointments(CTX, w7, { grain: "day", direction: "outbound" }),
    agents: mockAgents(CTX),
  });
  return { w, model };
}

test("Download: the sheets are the numbers on screen, and the lists are complete", () => {
  for (const bucket of ["last7", "last30"] as const) {
    const { w, model } = page(bucket);
    for (const a of model.agents) {
      const list = mockAppointmentList(CTX, w, { basis: "booked", direction: a.direction, types: countedTypes(a.period.work) });
      const ai = overviewActionItems(mockActionItems(CTX, w, { limit: 1000 }));
      const input = { accountName: "Honda Reseda", periodLabel: w.label, tzLabel: "PT", agent: a, model, appointments: toMeetings(list.items, model.timezone), actionItems: ai.rows };
      const sheets = buildExportSheets(input);
      const names = sheets.map((s) => s.name);
      for (const n of ["Summary", "Funnel", "Appointments", "Action items", "Definitions"]) assert.ok(names.includes(n), `${bucket} ${a.direction}: ${n} sheet`);
      assert.equal(names.includes("Warm leads"), a.direction === "outbound" && model.warmLeads.length > 0, "warm leads only where the page shows them");

      const summary = new Map(sheets.find((s) => s.name === "Summary")!.rows.map((r) => [r[0], r[1]]));
      assert.equal(summary.get(a.sections.totalLabel), a.period.work.visitsBooked ?? "—", "Summary's booked = the card");
      for (const t of a.sections.activity) assert.equal(summary.get(t.label), t.value, `activity tile ${t.label}`);
      const funnel = sheets.find((s) => s.name === "Funnel")!.rows.slice(1);
      assert.deepEqual(funnel.map((r) => r[0]), a.funnel.map((s) => s.label));
      assert.deepEqual(funnel.map((r) => r[1]), a.funnel.map((s) => s.customers ?? "—"), "Funnel sheet = the funnel");

      const appts = sheets.find((s) => s.name === "Appointments")!.rows;
      assert.equal(appts[1][1], list.items.length);
      assert.equal(list.items.length, a.period.work.visitsBooked, "A9: the list behind the number");
      assert.equal(appts[3][0], "These agree");

      const aiSheet = sheets.find((s) => s.name === "Action items")!.rows;
      assert.equal(aiSheet.length - 4, ai.rows.length, "every open item, not the first page");

      const pdf = buildPdfSections(input);
      assert.equal(pdf[0].heading, "Performance");
      assert.ok(pdf.some((s) => s.heading === "Action items") && pdf.some((s) => s.heading === "Definitions"));
    }
  }
});

test("Download: a list that couldn't load falls back, and the sheet says when counts differ", () => {
  const { model } = page("last30");
  const a = model.agents[0];
  const sheets = buildExportSheets({ accountName: "Honda Reseda", periodLabel: "Last 30 days", tzLabel: "", agent: a, model, appointments: null, actionItems: null });
  assert.ok(!sheets.some((s) => s.name === "Appointments"), "no list, no Appointments sheet (never an empty one)");
  assert.equal(sheets.find((s) => s.name === "Action items")!.rows.length - 4, model.actionItems.rows.length, "action items fall back to the page's rows");

  const short = buildExportSheets({ accountName: "x", periodLabel: "p", tzLabel: "", agent: a, model, appointments: [], actionItems: [] });
  const appts = short.find((s) => s.name === "Appointments")!.rows;
  if ((a.period.work.visitsBooked ?? 0) > 0) assert.equal(appts[3][0], "Why they differ");
});
