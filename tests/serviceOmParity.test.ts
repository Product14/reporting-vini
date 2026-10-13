/* The all-rooftops check's comparison: it passes when the pages agree, and it catches each kind of
 * disagreement it exists to find (a pass on sample data would mean nothing otherwise). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mockActionItems, mockAgents, mockAppointments, mockCallsReport, mockCampaign, mockContact, mockFollowUp } from "@/lib/serviceOm/mock";
import { buildServiceOverview, type ServiceOverviewModel } from "@/lib/serviceOm/overviewModel";
import { buildServiceReports, type ServiceReportsModel } from "@/lib/serviceOm/reportsModel";
import { compare } from "@/lib/serviceOm/parity";
import { resolveWindow } from "@/lib/serviceOm/window";

const NOW = Date.parse("2026-10-13T18:00:00Z");
const TZ = "America/Los_Angeles";
const ctx = { teamId: "2b110492b6", nameHint: "Honda Reseda", agents: ["Service Inbound", "Service Outbound"], now: NOW };

function pair(): { ov: ServiceOverviewModel; rp: ServiceReportsModel } {
  const w = resolveWindow("last30", null, TZ);
  const appointments = mockAppointments(ctx, w);
  const actionItems = mockActionItems(ctx, w, { limit: 50 });
  return {
    ov: buildServiceOverview({ appointments, upcoming: mockAppointments(ctx, w, { list: "upcoming", limit: 10 }), actionItems: mockActionItems(ctx, w, { limit: 10 }), agents: mockAgents(ctx) }),
    rp: buildServiceReports({
      appointments,
      campaign: mockCampaign(ctx, w),
      contactInbound: mockContact(ctx, w, "inbound"),
      contactOutbound: mockContact(ctx, w, "outbound"),
      upcoming: mockAppointments(ctx, w, { list: "upcoming", limit: 20 }),
      actionItems,
      callsReport: mockCallsReport(ctx, w),
      followUp: mockFollowUp(ctx, w),
      agents: mockAgents(ctx),
    }),
  };
}
const failed = (ov: ServiceOverviewModel, rp: ServiceReportsModel) => compare(ov, rp).filter((c) => !c.ok).map((c) => c.name);

test("agreeing pages pass every check", () => {
  const { ov, rp } = pair();
  assert.deepEqual(failed(ov, rp), []);
});

test("a per-agent number off by one is caught, with the headline", () => {
  const { ov, rp } = pair();
  const a = rp.agents[0];
  a.period = { ...a.period, work: { ...a.period.work, visitsBooked: (a.period.work.visitsBooked ?? 0) + 1 } };
  const f = failed(ov, rp);
  assert.ok(f.includes("headline"), f.join());
  assert.ok(f.includes(`${a.direction} visits booked`), f.join());
});

test("a funnel Booked that drifts from visits booked is caught", () => {
  const { ov, rp } = pair();
  const a = rp.agents[0];
  (a as { bookedAppointments: number | null }).bookedAppointments = (a.bookedAppointments ?? 0) + 2;
  assert.ok(failed(ov, rp).includes(`${a.direction} funnel booked`));
});

test("an agent missing on Reports is caught", () => {
  const { ov, rp } = pair();
  rp.agents = rp.agents.slice(1);
  const f = failed(ov, rp);
  assert.ok(f.includes("agents") && f.includes("headline"), f.join());
});

test("action items and upcoming rows that differ are caught", () => {
  const { ov, rp } = pair();
  rp.actionItems = { ...rp.actionItems, openNow: (rp.actionItems.openNow ?? 0) + 1, dueToday: (rp.actionItems.dueToday ?? 0) + 1 };
  rp.upcoming = (rp.upcoming ?? []).slice().reverse();
  rp.upcomingCount = (rp.upcomingCount ?? 0) + 1;
  const f = failed(ov, rp);
  for (const name of ["action items open", "action items due today", "upcoming rows", "upcoming count"]) assert.ok(f.includes(name), `${name}: ${f.join()}`);
});

test("an Overview headline the API couldn't give is a failure, not a pass", () => {
  const { ov, rp } = pair();
  ov.appointments = { ...ov.appointments, total: null, reason: "The Service Metrics API did not answer." };
  assert.ok(failed(ov, rp).includes("available"));
});
