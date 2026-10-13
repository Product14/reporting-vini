/* QA against Om's own shapes: the pages' REAL API path (api.ts → source.ts → models) run on the UAT sample
 * responses printed in Om's v2 doc (tests/fixtures/omDocSamples.ts), with a stand-in fetch. Checks the
 * requests against the doc's parameter list (section 7) and what every component would show. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { omDocFetch } from "./fixtures/omDocSamples";

const seen: URL[] = [];
globalThis.fetch = omDocFetch(seen);

async function load() {
  const { loadOverview, loadReports, loadAppointmentList } = await import("@/lib/serviceOm/source");
  const { buildServiceOverview, countedTypes } = await import("@/lib/serviceOm/overviewModel");
  const { buildServiceReports } = await import("@/lib/serviceOm/reportsModel");
  const { resolveWindow } = await import("@/lib/serviceOm/window");
  const ctx = { teamId: "678958236", enterpriseId: "12a63b492", spyneToken: "qa", spyneEnv: "uat" };
  const w = resolveWindow("last30", null, null);
  seen.length = 0;
  const ov = buildServiceOverview(await loadOverview("api", ctx, w));
  const rp = buildServiceReports(await loadReports("api", ctx, w));
  const lists: Record<string, number | null> = {};
  for (const a of rp.agents) lists[a.direction] = (await loadAppointmentList("api", ctx, w, { basis: "booked", direction: a.direction, types: countedTypes(a.period.work) }))?.items.length ?? null;
  return { ov, rp, lists, requests: [...seen] };
}

test("requests follow the doc's parameter list (section 7) and rule 2", async () => {
  const { requests } = await load();
  assert.equal(requests.length, 14, "no /campaign: the outbound funnel is the period's activity");
  for (const u of requests) {
    const p = u.searchParams;
    assert.equal(p.get("enterpriseId"), "12a63b492");
    assert.equal(p.get("teamId"), "678958236");
    assert.equal(p.get("agentLine"), "service");
    assert.equal(p.get("window"), p.get("grain") === "day" ? "7d" : "30d", u.search);
    assert.ok(Number(p.get("limit") ?? 1) <= 50, "limit 1–50");
  }
  const at = (path: string, has: Record<string, string>) => requests.filter((u) => u.pathname.endsWith(`/${path}`) && Object.entries(has).every(([k, v]) => u.searchParams.get(k) === v));
  assert.equal(at("appointment", { listAnchor: "upcoming", listOnly: "true" }).length, 2, "the upcoming list, Overview and Reports");
  assert.equal(at("appointment", { grain: "day", direction: "inbound" }).length, 1);
  assert.equal(at("appointment", { grain: "day", direction: "outbound" }).length, 1);
  assert.equal(at("appointment", { listAnchor: "created", listOnly: "true", tag: "booked_by_spyne" }).length, 2, "assisted not available: the lists ask for Booked by Spyne only");
  assert.equal(at("contact", { direction: "inbound" }).length, 1);
  assert.equal(at("contact", { direction: "outbound" }).length, 1);
  assert.equal(at("action-item", { due: "open" }).length, 2);
  assert.equal(at("follow-up", { list: "warmLeads" }).length, 1);
  assert.equal(at("calls-report", {}).length, 1);
  assert.equal(at("campaign", {}).length, 0);
  assert.ok(requests.every((u) => !u.searchParams.has("campaignId")), "rooftop-wide");
});

test("Overview on the doc's UAT sample", async () => {
  const { ov } = await load();
  const a = ov.appointments;
  assert.deepEqual([a.total, a.bookedBySpyne, a.spyneAssisted, a.inbound, a.outbound, a.unplaced], [21, 21, null, 3, 0, 18], "rule 5: 3 + 0 + 18 = 21");
  assert.equal(a.assistedReason, "<why it can't be shown here>", "rule 1: the reason, not a 0");
  assert.deepEqual(ov.agents.rows.map((r) => [r.direction, r.bookedBySpyne, r.spyneAssisted, r.visitsBooked]), [["inbound", 3, null, 3], ["outbound", 0, null, 0]]);
  assert.equal(ov.upcoming.count, 18);
  assert.deepEqual(ov.upcoming.rows.map((r) => r.kind), ["booked", "dealer"], "the BDC's own booking keeps its tag");
  assert.deepEqual([ov.actionItems.openNow, ov.actionItems.pastSla, ov.actionItems.dueToday, ov.actionItems.waitingOnBdc], [421, 419, 2, 22]);
  assert.equal(ov.timezone, "Asia/Kolkata");
  assert.ok(ov.asOf && Math.abs(Date.parse(ov.asOf) - Date.now()) < 60_000, "no asOf from the API: the page's own read time");
});

test("Reports on the doc's UAT sample", async () => {
  const { rp, lists } = await load();
  const ib = rp.agents.find((x) => x.direction === "inbound")!;
  const ob = rp.agents.find((x) => x.direction === "outbound")!;
  // Carl
  assert.deepEqual(ib.funnel.map((s) => [s.label, s.customers]), [["Connected", 4], ["Engaged", 3], ["Booked", 3]]);
  assert.equal(ib.pickerCount, 4);
  assert.equal(ib.bookingRate!.value, 0.75);
  const tile = (x: { sections: { activity: Array<{ label: string; value: string }> } }, label: string) => x.sections.activity.find((t) => t.label === label)!.value;
  assert.equal(tile(ib, "Calls"), "112", "no /contact calls in the doc's sample: /calls-report answered");
  assert.equal(tile(ib, "Turn rate"), "75%");
  assert.equal(tile(ib, "Close rate"), "100%");
  assert.deepEqual([ib.sections.breakdown.during, ib.sections.breakdown.after], [108, 4]);
  assert.deepEqual(ib.sections.breakdown.tiles.map((t) => [t.label, t.value]), [["Callers", 4], ["Wanted service", 3], ["Transferred", 7], ["Booked after hours", 1], ["Waiting on your BDC", 22]]);
  assert.equal(ib.sections.quality.handleTime, "1m 06s", "122.43 staff-time minutes ÷ 112 answered calls");
  assert.equal(ib.sections.quality.answerRate, "50%", "heatmap 3 connected ÷ 6 calls");
  assert.equal(ib.sections.timeOfDay!.values[7], 6, "2pm");
  assert.equal(ib.sections.trend7!.total, 2);
  assert.equal(ib.sections.trend7!.assistedIncluded, false);
  assert.equal(lists.inbound, ib.period.work.visitsBooked, "rule 8: Carl's Booked list = 3 rows");
  // Emily
  // The doc's /contact sample trims engagementRate, so Reached and Engaged read "—", never 0.
  assert.deepEqual(ob.funnel.map((s) => [s.label, s.customers]), [["Reached", null], ["Engaged", null], ["Booked", 0]]);
  assert.equal(tile(ob, "Calls dispatched"), "2", "no /contact calls in the doc's sample: the outbound heatmap");
  assert.equal(ob.sections.breakdown.hoursSplit, false);
  assert.deepEqual(ob.sections.breakdown.tiles.map((t) => [t.label, t.value]), [["Conversations reached", null], ["Real conversations", null], ["Asked for a callback", 0]]);
  assert.equal(lists.outbound, 0);
  // Shared
  assert.equal(rp.upcomingCount, 18);
  assert.ok(rp.upcoming!.every((m) => m.status === "scheduled"));
  assert.deepEqual([rp.warmLeadsTotal, rp.warmLeads.length, rp.warmLeads[0].interest], [1, 1, "No Slots Available"]);
  assert.equal(rp.appointments.total, rp.agents.reduce((n, x) => n + (x.period.work.visitsBooked ?? 0), 0) + rp.appointments.unplaced);
});

test("still '—' on the doc's sample (fields it doesn't print): SMS on both agents, inbound opt-outs", async () => {
  const { rp } = await load();
  for (const a of rp.agents) assert.equal(a.sections.activity.find((t) => t.label === "Total SMS")!.value, "—");
  assert.equal(rp.agents.find((x) => x.direction === "inbound")!.sections.quality.optOuts, null);
});
