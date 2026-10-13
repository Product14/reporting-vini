/* Service OM Overview: the sample source keeps Om's v2 sums, the model reads both the v2 shape and today's
 * API shape, and the switch only ever routes Service. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mockActionItems, mockAppointments } from "@/lib/serviceOm/mock";
import { buildServiceOverview, overviewAppointments } from "@/lib/serviceOm/overviewModel";
import { resolveWindow } from "@/lib/serviceOm/window";
import { resolveOmSource } from "@/lib/serviceOm/source";
import { departmentOf, serviceOmViewOn } from "@/lib/serviceOm/switch";
import type { AppointmentResponse } from "@/lib/serviceOm/contract";

const NOW = Date.parse("2026-10-13T18:00:00Z");
const TZ = "America/Los_Angeles";
const ctx = { teamId: "2b110492b6", nameHint: "Honda Reseda", now: NOW };

test("sample data: v2's sums hold (rule 5, S1), and a shorter window never counts more", () => {
  const w30 = resolveWindow("last30", null, TZ);
  const w7 = resolveWindow("last7", null, TZ);
  const r30 = mockAppointments(ctx, w30);
  const r7 = mockAppointments(ctx, w7);
  for (const r of [r30, r7]) {
    const m = r.metrics;
    const d = m.byDirection!;
    const parts = [d.inbound, d.outbound, d.unplaced!];
    assert.equal(parts.reduce((n, x) => n + x.bookedBySpyne!, 0), m.bookedBySpyne.value, "rule 5: inbound + outbound + unplaced = Booked by Spyne");
    assert.equal(parts.reduce((n, x) => n + x.spyneAssisted!, 0), m.spyneAssisted!.value, "and the same for Spyne-assisted");
    const s = m.statusOfBookings!;
    assert.equal(s.upcoming + s.cancelled + s.showed + s.noShow + s.statusNotAvailable, m.bookedBySpyne.value, "S1: statuses add up to Booked");
    const t = m.spyneAssisted!.byType!;
    assert.equal(t.transfer! + t.request! + t.intent!, m.spyneAssisted!.value, "Spyne-assisted by type adds up");
    const v = m.visits!;
    assert.equal(v.showed + v.noShow + v.notKnown, v.due, "visits add up");
  }
  assert.ok(r7.metrics.bookedBySpyne.value! <= r30.metrics.bookedBySpyne.value!);
});

test("sample data is stable for a rooftop and differs between rooftops", () => {
  const w = resolveWindow("last30", null, TZ);
  assert.deepEqual(mockAppointments(ctx, w).metrics, mockAppointments(ctx, w).metrics);
  // The whole block, not one count: two rooftops can share a single total by chance.
  assert.notDeepEqual(mockAppointments({ ...ctx, teamId: "c885afdbe9" }, w).metrics, mockAppointments(ctx, w).metrics);
});

test("model on the v2 shape: headline is Booked by Spyne + Spyne-assisted and the split adds up to it", () => {
  const w = resolveWindow("last30", null, TZ);
  const appointments = mockAppointments(ctx, w);
  const m = buildServiceOverview({
    appointments,
    upcoming: mockAppointments(ctx, w, { list: "upcoming", limit: 10 }),
    actionItems: mockActionItems(ctx, w, { limit: 10 }),
  });
  const a = m.appointments;
  assert.equal(a.basis, "v2");
  assert.equal(a.total, appointments.metrics.bookedBySpyne.value! + appointments.metrics.spyneAssisted!.value!);
  assert.equal((a.inbound ?? 0) + (a.outbound ?? 0) + a.unplaced, a.total);
  assert.equal(m.upcoming.count, appointments.metrics.upcoming!.value, "the upcoming count is /appointment's own");
  assert.ok(m.upcoming.rows.every((r) => r.when !== null && Date.parse(r.when) > NOW), "upcoming rows are in the future");
  const ai = m.actionItems;
  assert.ok(ai.openNow !== null && ai.pastSla !== null && ai.pastSla <= ai.openNow);
  assert.ok(ai.dueToday !== null && ai.waitingOnBdc !== null, "v2's due today and callbacks waiting are read");
});

test("Spyne-assisted not available: headline is Booked by Spyne, says why, and the parts still add up (rule 1)", () => {
  const w = resolveWindow("last30", null, TZ);
  const r = mockAppointments(ctx, w);
  const d = r.metrics.byDirection!;
  const noAssisted: AppointmentResponse = {
    ...r,
    metrics: {
      ...r.metrics,
      spyneAssisted: { available: false, value: null, reason: "Handoff log not on this environment." },
      byDirection: { inbound: { ...d.inbound, spyneAssisted: null }, outbound: { ...d.outbound, spyneAssisted: null }, unplaced: { ...d.unplaced!, spyneAssisted: null } },
    },
  };
  const m = buildServiceOverview({ appointments: noAssisted, upcoming: null, actionItems: null });
  assert.equal(m.appointments.total, r.metrics.bookedBySpyne.value);
  assert.equal(m.appointments.spyneAssisted, null, "null, never 0");
  assert.equal(m.appointments.assistedReason, "Handoff log not on this environment.");
  assert.equal(m.agents.rows.reduce((n, x) => n + (x.visitsBooked ?? 0), 0) + m.appointments.unplaced, m.appointments.total);
  assert.ok(m.agents.rows.every((x) => x.spyneAssisted === null && x.assistedReason && !x.assistedCounted));
});

test("upcoming rows keep /appointment's tag: AI-booked, Spyne-assisted, the BDC's own", () => {
  const w = resolveWindow("last30", null, TZ);
  const list = mockAppointments(ctx, w, { list: "upcoming", limit: 3 });
  const items = list.appointments!.items;
  const tagged: AppointmentResponse = { ...list, appointments: { ...list.appointments!, items: [{ ...items[0], tag: "booked_by_spyne" }, { ...items[1], tag: "spyne_assisted" }, { ...items[2], tag: "booked_by_dealer" }] } };
  const m = buildServiceOverview({ appointments: null, upcoming: tagged, actionItems: null });
  assert.deepEqual(m.upcoming.rows.map((x) => x.kind), ["booked", "assisted", "dealer"]);
});

test("names and photos come from the onboarded agents, not Om's API", () => {
  const w = resolveWindow("last30", null, TZ);
  const m = buildServiceOverview({ appointments: mockAppointments(ctx, w), upcoming: null, actionItems: null, agents: [{ direction: "inbound", name: "Carl", imageUrl: "https://example.test/carl.png" }] });
  const ib = m.agents.rows.find((x) => x.direction === "inbound")!;
  assert.equal(ib.name, "Carl");
  assert.equal(ib.imageUrl, "https://example.test/carl.png");
});

test("model on today's API shape: the old Overview's split, Spyne-assisted beside it", () => {
  const legacy: AppointmentResponse = {
    window: { from: "2026-09-14", to: "2026-10-13", timezone: TZ },
    metrics: {
      bookedBySpyne: { available: true, value: 41 },
      workedBySpyne: { available: true, value: 3 },
      bookingRate: {
        inbound: { available: true, value: 0.2, numerator: 6, denominator: 30 },
        outbound: { available: true, value: 0.1, numerator: 30, denominator: 300 },
      },
      bookedByText: { available: true, value: 4 },
    },
  };
  const a = overviewAppointments(legacy);
  assert.equal(a.basis, "legacy");
  assert.equal(a.total, 41);
  assert.equal(a.inbound, 6);
  assert.equal(a.outbound, 34); // outbound calls + text, as the old page
  assert.equal(a.unplaced, 1); // the booking the old split left out, now shown
  assert.equal(a.spyneAssisted, 3);
});

test("a call that failed reads not available, never 0 (G5)", () => {
  const m = buildServiceOverview({ appointments: null, upcoming: null, actionItems: null });
  assert.equal(m.appointments.total, null);
  assert.equal(m.actionItems.openNow, null);
  assert.equal(m.upcoming.count, null);
  assert.ok(m.appointments.reason);
});

test("switch: on by default for Service, a kill switch, a team list, the URL override; never Sales", () => {
  assert.equal(serviceOmViewOn("2b110492b6", "service", null, undefined), true, "unset: on (the merge makes it live)");
  for (const off of ["off", "OFF", "none", "0", "false", ""]) assert.equal(serviceOmViewOn("2b110492b6", "service", null, off), false, `kill switch "${off}"`);
  assert.equal(serviceOmViewOn("2b110492b6", "service", null, "all"), true);
  assert.equal(serviceOmViewOn("2b110492b6", "service", null, "2b110492b6,abc"), true);
  assert.equal(serviceOmViewOn("c885afdbe9", "service", null, "2b110492b6,abc"), false, "a list limits it to those rooftops");
  assert.equal(serviceOmViewOn("2b110492b6", "sales", "om", undefined), false, "Sales never, not even with the override");
  assert.equal(serviceOmViewOn("2b110492b6", null, null, undefined), false, "no department means old");
  assert.equal(serviceOmViewOn("2b110492b6", "service", "old", undefined), false, "?svc_view=old");
  assert.equal(serviceOmViewOn("2b110492b6", "service", "om", "off"), true, "?svc_view=om beats the kill switch for one request");
});

test("department: the iframe URL's own, else the console page around it (Referer)", () => {
  const sp = (q: string) => new URLSearchParams(q);
  assert.equal(departmentOf(sp("team_id=x&serviceType=service"), null), "service");
  assert.equal(departmentOf(sp("team_id=x&service_type=sales"), "https://console.spyne.ai/converse-ai?serviceType=service"), "sales", "the iframe's own wins");
  assert.equal(departmentOf(sp("team_id=x"), "https://console.spyne.ai/converse-ai?tab=reports&serviceType=service"), "service");
  assert.equal(departmentOf(sp("team_id=x"), "https://console.spyne.ai/"), null, "no query on the parent: no department, old page");
  assert.equal(departmentOf(sp("team_id=x"), "not a url"), null);
});

test("source: a production build never shows sample data unless the env asks for it", () => {
  assert.equal(resolveOmSource("mock", undefined, true), "api", "URL override is ignored in production");
  assert.equal(resolveOmSource(null, undefined, true), "api");
  assert.equal(resolveOmSource(null, "mock", true), "mock");
  assert.equal(resolveOmSource(null, undefined, false), "mock");
  assert.equal(resolveOmSource("api", "mock", false), "api");
});

test("sample data: live counts don't move with the window or the minute", () => {
  const later = { ...ctx, now: NOW + 7 * 60000 };
  const a = mockActionItems(ctx, resolveWindow("last30", null, TZ));
  const b = mockActionItems(later, resolveWindow("last7", null, TZ));
  assert.equal(a.metrics.openNow.value, b.metrics.openNow.value);
  const u1 = mockAppointments(ctx, resolveWindow("last30", null, TZ)).metrics.upcoming!.value;
  const u2 = mockAppointments(ctx, resolveWindow("last7", null, TZ)).metrics.upcoming!.value;
  assert.equal(u1, u2, "Upcoming now is not window-bound");
});

test("sample data only books the directions a rooftop runs", () => {
  const w = resolveWindow("last30", null, TZ);
  const obOnly = mockAppointments({ teamId: "c885afdbe9", agents: ["Sales Outbound", "Service Outbound"], now: NOW }, w).metrics.byDirection!;
  assert.equal(obOnly.inbound.bookedBySpyne! + obOnly.inbound.spyneAssisted!, 0);
  const ibOnly = mockAppointments({ teamId: "a9e37101ea", agents: ["Service Inbound"], now: NOW }, w).metrics.byDirection!;
  assert.equal(ibOnly.outbound.bookedBySpyne! + ibOnly.outbound.spyneAssisted!, 0);
});

test("By agent: agents + unplaced = the Appointments headline (A1, A6)", () => {
  const w = resolveWindow("last30", null, TZ);
  for (const c of [ctx, { teamId: "c885afdbe9", agents: ["Sales Outbound", "Service Outbound"], now: NOW }]) {
    const m = buildServiceOverview({ appointments: mockAppointments(c, w), upcoming: null, actionItems: null });
    const sum = m.agents.rows.reduce((n, a) => n + (a.visitsBooked ?? 0), 0);
    assert.equal(sum + m.appointments.unplaced, m.appointments.total);
    for (const a of m.agents.rows) assert.equal(a.visitsBooked, (a.bookedBySpyne ?? 0) + (a.spyneAssisted ?? 0));
    assert.deepEqual(m.agents.rows.map((a) => a.direction), [...m.agents.rows.map((a) => a.direction)].sort(), "inbound first");
  }
});

test("By agent on today's API: booked per side, Spyne-assisted says why it's missing", () => {
  const legacy: AppointmentResponse = {
    window: { from: "2026-09-14", to: "2026-10-13", timezone: TZ },
    metrics: {
      bookedBySpyne: { available: true, value: 41 },
      workedBySpyne: { available: true, value: 3 },
      bookingRate: {
        inbound: { available: true, value: 0.2, numerator: 6, denominator: 30 },
        outbound: { available: true, value: 0.1, numerator: 30, denominator: 300 },
      },
      bookedByText: { available: true, value: 4 },
    },
  };
  const m = buildServiceOverview({ appointments: legacy, upcoming: null, actionItems: null });
  assert.deepEqual(m.agents.rows.map((a) => [a.direction, a.bookedBySpyne, a.spyneAssisted, a.visitsBooked]), [["inbound", 6, null, 6], ["outbound", 34, null, 34]]);
  assert.ok(m.agents.rows.every((a) => a.assistedReason));
});

test("assisted bookings Om can't place under an agent go to unplaced, so the headline still adds up", () => {
  const resp: AppointmentResponse = {
    window: { from: "2026-09-14", to: "2026-10-13", timezone: TZ },
    metrics: {
      bookedBySpyne: { available: true, value: 10 },
      spyneAssisted: { available: true, value: 5, byType: { transfer: 4, request: 1, intent: null } },
      // Om's shape: unplaced carries Booked by Spyne only; 2 of the 5 assisted have no handoff channel.
      byDirection: { inbound: { bookedBySpyne: 4, spyneAssisted: 2 }, outbound: { bookedBySpyne: 3, spyneAssisted: 1 }, unplaced: { bookedBySpyne: 3 } },
    },
  };
  const m = buildServiceOverview({ appointments: resp, upcoming: null, actionItems: null });
  assert.equal(m.appointments.total, 15);
  assert.deepEqual([m.appointments.inbound, m.appointments.outbound, m.appointments.unplaced], [6, 4, 5], "3 unplaced booked + 2 unplaced assisted");
  assert.equal(m.agents.rows.reduce((n, a) => n + (a.visitsBooked ?? 0), 0) + m.appointments.unplaced, m.appointments.total);
});

test("a direction block Om marks unavailable reads as not available, never 0", () => {
  const resp: AppointmentResponse = {
    window: { from: "2026-09-14", to: "2026-10-13", timezone: TZ },
    metrics: {
      bookedBySpyne: { available: true, value: 4 },
      spyneAssisted: { available: false, value: null, reason: "no log" },
      byDirection: { inbound: { available: true, bookedBySpyne: 4, spyneAssisted: null }, outbound: { available: false, reason: "No outbound agent is mapped.", bookedBySpyne: 0, spyneAssisted: null }, unplaced: { bookedBySpyne: 0 } },
    },
  };
  const m = buildServiceOverview({ appointments: resp, upcoming: null, actionItems: null, agents: [{ direction: "inbound", name: "Carl", imageUrl: null }, { direction: "outbound", name: "Emily", imageUrl: null }] });
  const ob = m.agents.rows.find((a) => a.direction === "outbound")!;
  assert.deepEqual([ob.bookedBySpyne, ob.visitsBooked], [null, null]);
  assert.equal(ob.assistedReason, "No outbound agent is mapped.");
});

test("prod's asOf is a block: the pages read generatedAt (an object here once crashed the footer)", () => {
  const w = resolveWindow("last30", null, TZ);
  const appointments = { ...mockAppointments(ctx, w), asOf: { generatedAt: "2026-10-13T20:01:02.000Z", lastAppointmentAt: "2026-10-13T19:00:00.000Z", lastCallAt: "2026-10-13T19:30:00.000Z", lastRepairOrderAt: null } };
  assert.equal(buildServiceOverview({ appointments, upcoming: null, actionItems: null }).asOf, "2026-10-13T20:01:02.000Z");
  assert.equal(buildServiceOverview({ appointments: { ...appointments, asOf: "2026-10-13T20:00:00.000Z" }, upcoming: null, actionItems: null }).asOf, "2026-10-13T20:00:00.000Z", "an older plain string still reads");
  assert.equal(buildServiceOverview({ appointments: { ...appointments, asOf: undefined }, upcoming: null, actionItems: null, readAt: "2026-10-13T20:05:00.000Z" }).asOf, "2026-10-13T20:05:00.000Z", "none: the page's own read time");
});
