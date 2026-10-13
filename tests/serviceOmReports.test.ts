/* Service OM Reports on Om's v2: the funnel follows the user's rules, the appointment numbers are the
 * Overview's, every clickable number opens exactly the appointments it counted (rule 8), and the lower
 * sections read the v2 endpoints. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mockActionItems, mockAgents, mockAppointmentList, mockAppointments, mockCallsReport, mockCampaign, mockContact, mockFollowUp, type MockCtx } from "@/lib/serviceOm/mock";
import { buildServiceOverview, countedTypes } from "@/lib/serviceOm/overviewModel";
import { buildServiceReports, toMeetings, waterfall, type OutboundReport } from "@/lib/serviceOm/reportsModel";
import { agentCardStats } from "@/components/serviceOm/reports/OmAgentCards";
import { resolveWindow } from "@/lib/serviceOm/window";
import type { Bucket } from "@/components/reports/data";

const NOW = Date.parse("2026-10-13T18:00:00Z");
const TZ = "America/Los_Angeles";
const ROOFTOPS: MockCtx[] = [
  { teamId: "2b110492b6", nameHint: "Honda Reseda", agents: ["Sales Inbound", "Service Inbound", "Sales Outbound", "Service Outbound"], now: NOW },
  { teamId: "c885afdbe9", nameHint: "Horne Mazda", agents: ["Sales Outbound", "Service Outbound"], now: NOW },
  { teamId: "a9e37101ea", nameHint: "Bob King Mazda", agents: ["Service Inbound"], now: NOW },
];
const BUCKETS: Bucket[] = ["today", "last7", "last30", "mtd", "lifetime"];

function pages(ctx: MockCtx, bucket: Bucket) {
  const w = resolveWindow(bucket, null, TZ);
  const w7 = resolveWindow("last7", null, TZ);
  const appointments = mockAppointments(ctx, w);
  const actionItems = mockActionItems(ctx, w, { limit: 50 });
  const agents = mockAgents(ctx);
  return {
    w,
    overview: buildServiceOverview({ appointments, upcoming: mockAppointments(ctx, w, { list: "upcoming", limit: 10 }), actionItems, agents }),
    reports: buildServiceReports({
      appointments,
      campaign: mockCampaign(ctx, w),
      contactInbound: mockContact(ctx, w, "inbound"),
      contactOutbound: mockContact(ctx, w, "outbound"),
      upcoming: mockAppointments(ctx, w, { list: "upcoming", limit: 20 }),
      actionItems,
      callsReport: mockCallsReport(ctx, w),
      followUp: mockFollowUp(ctx, w, "warmLeads", 50),
      trendInbound: mockAppointments(ctx, w7, { grain: "day", direction: "inbound" }),
      trendOutbound: mockAppointments(ctx, w7, { grain: "day", direction: "outbound" }),
      agents,
    }),
  };
}

test("Overview = Reports: the appointment numbers are the By agent card, number for number", () => {
  for (const ctx of ROOFTOPS) for (const b of BUCKETS) {
    const { overview, reports } = pages(ctx, b);
    assert.deepEqual(reports.agents.map((a) => a.period.work), overview.agents.rows, `${ctx.teamId} ${b}`);
    assert.deepEqual(reports.appointments, overview.appointments);
    const sum = reports.agents.reduce((n, a) => n + (a.period.work.visitsBooked ?? 0), 0);
    assert.equal(sum + reports.appointments.unplaced, overview.appointments.total, "A1/A6: agents + unplaced = the Overview headline");
  }
});

test("A9: every clickable appointment number opens exactly its rows", () => {
  for (const ctx of ROOFTOPS) for (const b of BUCKETS) {
    const { w, reports } = pages(ctx, b);
    for (const a of reports.agents) {
      const p = a.period.work;
      const rows = (types: Array<"booked_by_spyne" | "spyne_assisted">) => mockAppointmentList(ctx, w, { basis: "booked", direction: a.direction, types }).items;
      assert.equal(rows(["booked_by_spyne"]).length, p.bookedBySpyne, `${ctx.teamId} ${b} ${a.direction} booked`);
      assert.equal(rows(["spyne_assisted"]).length, p.spyneAssisted, `${ctx.teamId} ${b} ${a.direction} assisted`);
      assert.equal(rows(["booked_by_spyne", "spyne_assisted"]).length, p.visitsBooked, `${ctx.teamId} ${b} ${a.direction} visits`);
      // The funnel's Booked link: Booked by Spyne + Spyne-assisted, made in the window.
      assert.equal(rows(["booked_by_spyne", "spyne_assisted"]).length, a.bookedAppointments, `${ctx.teamId} ${b} ${a.direction} funnel booked`);
    }
  }
});

test("The popup rows keep each appointment's status on the popup's own sections", () => {
  const { w } = pages(ROOFTOPS[0], "lifetime");
  const items = toMeetings(mockAppointmentList(ROOFTOPS[0], w, { basis: "booked", direction: "inbound", types: ["booked_by_spyne"] }).items, TZ);
  const statuses = new Set(items.map((m) => m.status));
  for (const s of statuses) assert.ok(["scheduled", "completed", "no_show", "cancelled", "status not available"].includes(s), s);
});

test("A7: every funnel pours, Booked included, on both agents, and Booked is the Overview's visits booked", () => {
  for (const ctx of ROOFTOPS) for (const b of BUCKETS) {
    const { overview, reports } = pages(ctx, b);
    for (const a of reports.agents) {
      const v = a.funnel.map((s) => s.customers);
      for (let i = 1; i < v.length; i++) if (v[i] !== null && v[i - 1] !== null) assert.ok(v[i]! <= v[i - 1]!, `${ctx.teamId} ${b} ${a.direction} ${a.funnel[i].key}`);
      assert.equal(a.funnel.at(-1)!.customers, overview.agents.rows.find((r) => r.direction === a.direction)!.visitsBooked, "Booked never compensated");
      for (const st of a.funnel) if (st.topUp) assert.equal(st.customers, a.funnel[a.funnel.indexOf(st) + 1].customers, "a top-up lifts only to the stage below");
    }
  }
});

test("waterfall(): for any numbers, the funnel never widens, Booked is untouched, top-ups are the least needed, gaps stay gaps", () => {
  let seed = 7;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let t = 0; t < 5000; t++) {
    const raw = [0, 1, 2].map(() => (rnd(7) === 0 ? null : rnd(60)));
    const A = rnd(4);
    const f = waterfall(["connected", "engaged", "booked"], raw, A);
    const v = f.map((s) => s.customers);
    assert.equal(v[2], raw[2], "Booked as given");
    for (let i = 0; i < 2; i++) {
      assert.equal(v[i] === null, raw[i] === null, "no number invented for a stage Om didn't send");
      if (v[i] !== null) {
        assert.equal(v[i], raw[i]! + A + (f[i].topUp ?? 0));
        const below = [v[i + 1], v[i + 2]].find((x) => x !== null && x !== undefined) ?? null;
        if (below !== null) assert.ok(v[i]! >= below, JSON.stringify({ raw, A, v }));
        if (f[i].topUp) assert.equal(v[i], below, "lifted exactly to the stage below, no more");
      }
    }
    for (const st of f) if (st.fromPrev?.value != null) assert.ok(st.fromPrev.value <= 1, "no rate over 100%");
  }
});

test("Funnel: outbound Reached → Engaged → Booked (calls and texts), inbound Connected → Engaged → Booked; no Qualified", () => {
  const { w, reports } = pages(ROOFTOPS[0], "last30");
  for (const a of reports.agents) {
    assert.ok(a.funnel.every((s) => s.label !== "Qualified"));
    assert.deepEqual(a.funnel.map((s) => s.label), a.direction === "outbound" ? ["Reached", "Engaged", "Booked"] : ["Connected", "Engaged", "Booked"]);
    // Inbound Engaged in customers isn't in v2's /contact, so Engaged carries wanted service (user, 13-Oct).
    // Engaged = wanted service + the agent's Spyne-assisted customers (they talked to Spyne before the store booked them).
    if (a.direction === "inbound") assert.equal(a.funnel[1].customers, mockContact(ROOFTOPS[0], w, "inbound").metrics.neededService!.inbound.value! + (a.period.work.assistedCounted ? a.period.work.spyneAssisted ?? 0 : 0) + (a.funnel[1].topUp ?? 0));
    const v = a.funnel.map((s) => s.customers ?? 0);
    assert.deepEqual([a.bookingRate!.numerator, a.bookingRate!.denominator], [v.at(-1), v[0]], "Booking rate = Booked ÷ the funnel's top (Connected / Reached)");
  }
});

test("Funnel Booked = visits booked (Booked by Spyne + Assisted by Spyne) = byDirection, on both agents", () => {
  for (const ctx of ROOFTOPS) for (const b of BUCKETS) {
    const { w, reports } = pages(ctx, b);
    const d = mockAppointments(ctx, w).metrics.byDirection!;
    for (const a of reports.agents) {
      assert.equal(a.bookedAppointments, a.period.work.visitsBooked, `${ctx.teamId} ${b} ${a.direction} appointments`);
      assert.equal(a.funnel.at(-1)!.customers, d[a.direction].bookedBySpyne! + d[a.direction].spyneAssisted!, `${ctx.teamId} ${b} ${a.direction} = byDirection`);
    }
  }
});

test("Outbound funnel: Reached and Engaged are Om's engagement pair for the period (calls and texts), plus assisted", () => {
  for (const ctx of ROOFTOPS) for (const b of BUCKETS) {
    const { w, reports } = pages(ctx, b);
    const o = reports.agents.find((a) => a.direction === "outbound") as OutboundReport | undefined;
    if (!o) continue;
    const eng = mockContact(ctx, w, "outbound").metrics.engagementRate!.outbound;
    const A = o.period.work.assistedCounted ? o.period.work.spyneAssisted ?? 0 : 0;
    assert.deepEqual(o.funnel.slice(0, 2).map((s) => s.customers), [eng.denominator + A + (o.funnel[0].topUp ?? 0), eng.numerator + A + (o.funnel[1].topUp ?? 0)]);
    assert.deepEqual(o.funnel.slice(0, 2).map((s) => s.assisted ?? 0), [A, A], "each lifted stage says how many");
    assert.ok(o.funnel[1].customers! <= o.funnel[0].customers!, "Engaged never exceeds Reached: a share of the same conversations");
    assert.equal(o.pickerCount, eng.denominator);
  }
});

test("Paragon Honda: a rooftop still working an older list keeps a real funnel when nothing was enrolled in the window", () => {
  const ctx = ROOFTOPS[0];
  const w = resolveWindow("last30", null, TZ);
  const camp = mockCampaign(ctx, w);
  const empty = { ...camp, metrics: { ...camp.metrics, funnel: { ...camp.metrics.funnel, stages: { enrolled: 0, reachable: 0, connected: 0, engaged: 0, booked: 0 } } } };
  const r = buildServiceReports({ ...pagesResponses(ctx), appointments: mockAppointments(ctx, w), campaign: empty, contactOutbound: mockContact(ctx, w, "outbound") });
  const o = r.agents.find((a) => a.direction === "outbound")!;
  const eng = mockContact(ctx, w, "outbound").metrics.engagementRate!.outbound;
  assert.ok(eng.denominator > 0);
  assert.equal(o.funnel[0].customers, eng.denominator + (o.period.work.spyneAssisted ?? 0) + (o.funnel[0].topUp ?? 0), "Reached (+ assisted), not 0 enrolled");
  assert.equal(o.funnel.at(-1)!.customers, o.period.work.visitsBooked);
});

test("Only the agents a rooftop runs", () => {
  assert.deepEqual(pages(ROOFTOPS[1], "last30").reports.agents.map((a) => a.direction), ["outbound"]);
  assert.deepEqual(pages(ROOFTOPS[2], "last30").reports.agents.map((a) => a.direction), ["inbound"]);
});

/* ── the old sections, on the Service Metrics API ── */
test("Lower sections: action items are the Overview's, number for number", () => {
  for (const ctx of ROOFTOPS) for (const b of BUCKETS) {
    const { overview, reports } = pages(ctx, b);
    assert.deepEqual(reports.actionItems, overview.actionItems);
  }
});

test("Lower sections: the outbound rates read the funnel above", () => {
  for (const ctx of ROOFTOPS) for (const b of BUCKETS) {
    const { w, reports } = pages(ctx, b);
    const o = reports.agents.find((a) => a.direction === "outbound");
    if (!o) continue;
    const [reached, engaged, booked] = o.funnel.map((s) => s.customers ?? 0);
    const m = mockContact(ctx, w, "outbound").metrics;
    const eng = m.engagementRate!.outbound;
    const pct = (n: number, d: number) => (d > 0 && n <= d ? `${Math.round((100 * n) / d)}%` : "—");
    const tile = (label: string) => o.sections.activity.find((t) => t.label === label)!.value;
    assert.equal(tile("Answer rate"), pct(m.callersReached!.outbound.value!, m.customersCalled!.outbound.value!), "by phone");
    assert.equal(tile("Engagement rate"), pct(engaged, reached));
    assert.equal(tile("Close rate"), pct(booked, engaged));
    const asked = mockFollowUp(ctx, w).metrics.callbackRequested!.value;
    assert.deepEqual(o.sections.breakdown.tiles.map((t) => [t.label, t.value]), [["Conversations reached", eng.denominator], ["Real conversations", eng.numerator], ["Asked for a callback", asked]], "the call breakdown keeps Om's own counts");
    assert.equal(o.sections.breakdown.hoursSplit, false, "business / after hours doesn't apply to outbound");
  }
});

test("Lower sections: inbound reads /contact's split fields and /calls-report", () => {
  for (const ctx of ROOFTOPS) for (const b of BUCKETS) {
    const { w, reports } = pages(ctx, b);
    const ib = reports.agents.find((a) => a.direction === "inbound");
    if (!ib) continue;
    const c = mockContact(ctx, w, "inbound").metrics;
    const need = c.neededService!.inbound.value!;
    const callers = c.callersReached!.inbound.value!;
    const booked = ib.funnel.at(-1)!.customers!;
    const pct = (n: number, d: number) => (d > 0 && n <= d ? `${Math.round((100 * n) / d)}%` : "—");
    const A = ib.period.work.assistedCounted ? ib.period.work.spyneAssisted ?? 0 : 0;
    const [connectedF, engagedF] = [ib.funnel[0].customers!, ib.funnel[1].customers!];
    assert.deepEqual([connectedF, engagedF], [callers + A + (ib.funnel[0].topUp ?? 0), need + A + (ib.funnel[1].topUp ?? 0)], "both stages carry the Spyne-assisted customers");
    assert.equal(ib.sections.activity.find((t) => t.label === "Close rate")!.value, pct(booked, engagedF));
    assert.equal(ib.sections.activity.find((t) => t.label === "Turn rate")!.value, pct(engagedF, connectedF));
    assert.equal(ib.sections.breakdown.tiles[0].value, callers, "the call breakdown keeps Om's own Callers");
    const calls = mockCallsReport(ctx, w).inbound;
    assert.equal((ib.sections.breakdown.during ?? 0) + (ib.sections.breakdown.after ?? 0), calls.answered.value, "during + after hours = answered");
    const tile = (label: string) => ib.sections.breakdown.tiles.find((t) => t.label === label)!.value;
    assert.equal(tile("Transferred"), calls.transfers!.value);
    assert.equal(tile("Booked after hours"), calls.bookedAfterHours!.value);
  }
});

test("Rule 7: the two callback numbers keep their own labels and sources", () => {
  for (const ctx of ROOFTOPS) {
    const { w, reports } = pages(ctx, "last30");
    const ib = reports.agents.find((a) => a.direction === "inbound");
    const ob = reports.agents.find((a) => a.direction === "outbound");
    if (ib) assert.equal(ib.sections.breakdown.tiles.find((t) => t.label === "Waiting on your BDC")!.value, mockActionItems(ctx, w).metrics.callbacksOpenNow!.value);
    if (ob) assert.equal(ob.sections.breakdown.tiles.find((t) => t.label === "Asked for a callback")!.value, mockFollowUp(ctx, w).metrics.callbackRequested!.value);
    assert.equal(reports.actionItems.waitingOnBdc, mockActionItems(ctx, w).metrics.callbacksOpenNow!.value);
  }
});

test("Rule 8: Hot & warm leads lists exactly the Warm leads count (up to the page's 50), callbacks first", () => {
  for (const ctx of ROOFTOPS) for (const b of BUCKETS) {
    const w = resolveWindow(b, null, TZ);
    const { reports } = pages(ctx, b);
    const f = mockFollowUp(ctx, w);
    assert.equal(reports.warmLeadsTotal, f.metrics.lists.warmLeads.value, `${ctx.teamId} ${b}`);
    assert.equal(reports.warmLeads.length, Math.min(50, f.metrics.lists.warmLeads.value), `${ctx.teamId} ${b}`);
    const hot = reports.warmLeads.map((x) => x.tier === "hot");
    assert.deepEqual(hot, [...hot].sort((x, y) => Number(y) - Number(x)), "callbacks lead");
    assert.ok(f.addsUp!.ok, "Connected − Booked = the lists' total");
  }
});

test("Time of day sums /calls-report's heatmap into 7am → 6pm", () => {
  for (const ctx of ROOFTOPS) {
    const { w, reports } = pages(ctx, "last30");
    const cr = mockCallsReport(ctx, w);
    for (const a of reports.agents) {
      const heat = (a.direction === "inbound" ? cr.inbound.heatmap : cr.outbound?.heatmap) ?? [];
      const inHours = heat.filter((c) => c.hour >= 7 && c.hour <= 18).reduce((n, c) => n + c.calls, 0);
      const t = a.sections.timeOfDay!;
      assert.equal(t.values.length, 12);
      assert.equal(t.values.reduce((n, v) => n + v, 0), inHours);
    }
  }
});

test("7-day trend: grain=day per agent, 7 days that add up to the agent's last-7-days visits booked (rule 9)", () => {
  for (const ctx of ROOFTOPS) for (const b of BUCKETS) {
    const { reports } = pages(ctx, b);
    const week = pages(ctx, "last7").overview.agents.rows;
    for (const a of reports.agents) {
      const t = a.sections.trend7!;
      assert.equal(t.values.length, 7);
      assert.equal(t.labels.length, 7);
      assert.equal(t.total, week.find((r) => r.direction === a.direction)!.visitsBooked, `${ctx.teamId} ${b} ${a.direction}`);
    }
  }
  const w7 = resolveWindow("last7", null, TZ);
  for (const direction of ["inbound", "outbound"] as const) {
    const r = mockAppointments(ROOFTOPS[0], w7, { grain: "day", direction });
    assert.equal(r.trend!.reduce((n, d) => n + d.bookedBySpyne!, 0), r.metrics.bookedBySpyne.value, "the days add up to the same call's total");
  }
});

test("Spyne-assisted not available (UAT today): every number drops to Booked by Spyne, and still matches", () => {
  for (const base of ROOFTOPS) for (const b of BUCKETS) {
    const ctx = { ...base, assistedOff: true };
    const { w, overview, reports } = pages(ctx, b);
    const booked = mockAppointments(base, w).metrics.bookedBySpyne.value;
    assert.equal(overview.appointments.total, booked, `${ctx.teamId} ${b}: headline is Booked by Spyne`);
    assert.equal(overview.appointments.spyneAssisted, null, "null, never 0");
    assert.ok(overview.appointments.assistedReason);
    assert.deepEqual(reports.agents.map((a) => a.period.work), overview.agents.rows);
    for (const a of reports.agents) {
      const p = a.period.work;
      assert.equal(p.assistedCounted, false);
      assert.equal(p.spyneAssisted, null);
      assert.equal(p.visitsBooked, p.bookedBySpyne);
      assert.equal(a.funnel.at(-1)!.customers, p.bookedBySpyne, "funnel Booked = Booked by Spyne");
      assert.deepEqual(countedTypes(p), ["booked_by_spyne"]);
      assert.equal(mockAppointmentList(ctx, w, { basis: "booked", direction: a.direction, types: countedTypes(p) }).items.length, p.visitsBooked, "the list opens exactly the count");
      assert.equal(a.sections.trend7!.total, pages(ctx, "last7").overview.agents.rows.find((r) => r.direction === a.direction)!.visitsBooked);
    }
    const sum = reports.agents.reduce((n, a) => n + (a.period.work.visitsBooked ?? 0), 0);
    assert.equal(sum + reports.appointments.unplaced, overview.appointments.total);
    assert.ok(overview.upcoming.rows.every((r) => r.kind !== "assisted"), "no row can claim assisted without the log");
  }
});

test("Lower sections: due today and the upcoming count are the Overview's", () => {
  for (const ctx of ROOFTOPS) for (const b of BUCKETS) {
    const { overview, reports } = pages(ctx, b);
    assert.equal(reports.actionItems.dueToday, overview.actionItems.dueToday);
    assert.equal(reports.upcomingCount, overview.upcoming.count);
  }
});

test("All time is the last 366 days, the API's longest window (doc v6)", () => {
  const w = resolveWindow("lifetime", null, TZ);
  assert.equal(w.params.window, "custom");
  const days = (Date.parse(`${w.params.endDate}T12:00:00Z`) - Date.parse(`${w.params.startDate}T12:00:00Z`)) / 86400000 + 1;
  assert.equal(days, 366);
});

test("7-day trend leaves out a per-day Spyne-assisted that isn't this agent's (UAT before Om's next deploy)", () => {
  const ctx = ROOFTOPS[0];
  const w7 = resolveWindow("last7", null, TZ);
  const ib = mockAppointments(ctx, w7, { grain: "day", direction: "inbound" });
  // Per-day assisted that ignores `direction`: the whole rooftop's, so its days don't add up to Carl's assisted.
  const rooftop = mockAppointments(ctx, w7, { grain: "day" });
  const skewed = { ...ib, trend: ib.trend!.map((d, i) => ({ ...d, spyneAssisted: rooftop.trend![i].spyneAssisted })) };
  const base = pages(ctx, "last7");
  const r = buildServiceReports({ ...pagesResponses(ctx), trendInbound: skewed });
  const t = r.agents.find((a) => a.direction === "inbound")!.sections.trend7!;
  const carl = base.overview.agents.rows.find((x) => x.direction === "inbound")!;
  if (rooftop.metrics.spyneAssisted!.value !== ib.metrics.byDirection!.inbound.spyneAssisted) {
    assert.equal(t.assistedIncluded, false);
    assert.equal(t.total, carl.bookedBySpyne, "Booked by Spyne only");
  }
  const ok = base.reports.agents.find((a) => a.direction === "inbound")!.sections.trend7!;
  assert.equal(ok.assistedIncluded, true, "the sample's own per-agent assisted adds up, so it's in");
});

function pagesResponses(ctx: MockCtx) {
  const w = resolveWindow("last7", null, TZ);
  return {
    appointments: mockAppointments(ctx, w),
    campaign: mockCampaign(ctx, w),
    contactInbound: mockContact(ctx, w, "inbound"),
    contactOutbound: mockContact(ctx, w, "outbound"),
    upcoming: mockAppointments(ctx, w, { list: "upcoming", limit: 20 }),
    actionItems: mockActionItems(ctx, w, { limit: 50 }),
    callsReport: mockCallsReport(ctx, w),
    followUp: mockFollowUp(ctx, w),
    trendOutbound: mockAppointments(ctx, w, { grain: "day", direction: "outbound" }),
    agents: mockAgents(ctx),
  };
}

test("contact-v4 shapes: connect rate from this agent's side of the split, handle time = talk minutes ÷ connected calls", () => {
  const { w, reports } = pages(ROOFTOPS[0], "last30");
  for (const a of reports.agents) {
    const c = mockContact(ROOFTOPS[0], w, a.direction).metrics;
    const rate = (c.connectRate as { inbound: { numerator: number; denominator: number }; outbound: { numerator: number; denominator: number } })[a.direction];
    assert.equal(a.sections.quality.answerRate, `${Math.round((100 * rate.numerator) / rate.denominator)}%`);
    const secs = Math.round((c.talkTimeMinutes!.value! * 60) / c.connectedCalls!.value!);
    assert.equal(a.sections.quality.handleTime, `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`);
  }
});

test("opt-outs: Om's count is the whole rooftop's, so it says so unless the agent has its own", () => {
  const { reports } = pages(ROOFTOPS[0], "last30");
  const ib = reports.agents.find((a) => a.direction === "inbound")!;
  assert.equal(ib.sections.quality.optOutsScope, "rooftop");
  assert.equal(ib.sections.quality.optOuts, mockContact(ROOFTOPS[0], resolveWindow("last30", null, TZ), "inbound").metrics.optedOut!.value);
  // Not the campaign funnel's count either: it follows customers enrolled in the window (0 at Paragon Honda).
  const ob = reports.agents.find((a) => a.direction === "outbound")!;
  assert.equal(ob.sections.quality.optOutsScope, "rooftop");
  assert.equal(ob.sections.quality.optOuts, ib.sections.quality.optOuts);
});

test("popup statuses: the scheduler's raw words, and a past 'scheduled' is status not available", () => {
  const now = Date.parse("2026-10-13T18:00:00Z");
  const row = (status: string | null, start: string) => ({ meetingId: status ?? "none", customerName: null, vehicle: null, services: null, scheduledStart: start, status });
  const got = toMeetings([row("scheduled", "2026-10-20T10:00:00Z"), row("scheduled", "2026-10-01T10:00:00Z"), row(null, "2026-10-01T10:00:00Z"), row("noshow", "2026-10-01T10:00:00Z"), row("cancellation_requested", "2026-10-20T10:00:00Z"), row("completed", "2026-10-01T10:00:00Z"), row("tentative", "2026-10-20T10:00:00Z")], TZ, now).map((m) => m.status);
  assert.deepEqual(got, ["scheduled", "status not available", "status not available", "no_show", "cancelled", "completed", "tentative"]);
});

test("All reports' Your agents cards are the agent report's own numbers: calls, the funnel's Engaged and Booked", () => {
  for (const ctx of ROOFTOPS) for (const b of BUCKETS) {
    const { overview, reports } = pages(ctx, b);
    for (const a of reports.agents) {
      const [calls, middle, booked] = agentCardStats(a);
      assert.equal(calls.label, a.direction === "inbound" ? "Calls handled" : "Calls dispatched");
      assert.equal(calls.value, a.sections.activity[0].value);
      assert.equal(middle.label, "Engaged", "the funnel's middle stage; Qualified leads is gone (N6)");
      assert.equal(middle.value, a.funnel[1].customers!.toLocaleString("en-US"));
      const visits = overview.agents.rows.find((r) => r.direction === a.direction)!.visitsBooked!;
      assert.equal(booked.value, visits.toLocaleString("en-US"), `${ctx.teamId} ${b} ${a.direction}: = the Overview's By agent and the funnel's Booked`);
    }
  }
});

test("a quiet day: Om's 0-of-0 engagement rate reads as a funnel of zeros, and a text booking still pours", () => {
  const ctx = ROOFTOPS[0];
  const w = resolveWindow("today", null, TZ);
  const c = mockContact(ctx, w, "outbound");
  const quiet = { ...c, metrics: { ...c.metrics, leadsReached: { available: true, value: 0 }, engagementRate: { inbound: c.metrics.engagementRate!.inbound, outbound: { available: false, value: null, numerator: 0, denominator: 0 } } } } as typeof c;
  const o = buildServiceReports({ ...pagesResponses(ctx), appointments: mockAppointments(ctx, w), contactOutbound: quiet }).agents.find((a) => a.direction === "outbound")!;
  const booked = o.funnel[2].customers!;
  assert.deepEqual(o.funnel.map((s) => s.customers), [booked, booked, booked], "zeros, lifted to cover any booking; never '—'");
  const locked = { ...quiet, metrics: { ...quiet.metrics, leadsReached: { available: false, value: null, reason: "No service agent is mapped." } } } as typeof c;
  const l = buildServiceReports({ ...pagesResponses(ctx), appointments: mockAppointments(ctx, w), contactOutbound: locked }).agents.find((a) => a.direction === "outbound")!;
  assert.deepEqual(l.funnel.slice(0, 2).map((s) => s.customers), [null, null], "a line Om can't count stays not available");
});

test("popup pills: every row says who booked it, and the split matches the agent's numbers", async () => {
  const { bookedBy } = await import("@/components/serviceOm/reports/OmAppointmentsModal");
  const row = (tag: string) => ({ meetingId: tag, customerName: null, vehicle: null, services: null, scheduledStart: "2026-10-20T10:00:00Z", status: "scheduled", tag });
  assert.deepEqual(toMeetings([row("booked_by_spyne"), row("spyne_assisted"), row("worked_by_spyne"), row("booked_by_dealer")], TZ).map(bookedBy), ["spyne", "assisted", "assisted", null]);
  for (const ctx of ROOFTOPS) {
    const { w, reports } = pages(ctx, "last30");
    for (const a of reports.agents) {
      const items = toMeetings(mockAppointmentList(ctx, w, { basis: "booked", direction: a.direction, types: ["booked_by_spyne", "spyne_assisted"] }).items, TZ);
      assert.equal(items.filter((m) => bookedBy(m) === "spyne").length, a.period.work.bookedBySpyne);
      assert.equal(items.filter((m) => bookedBy(m) === "assisted").length, a.period.work.spyneAssisted);
    }
  }
});
