/* D2 — AI-booked appointments are windowed by the STORE-LOCAL booking day, not the UTC date.
 * Fixture: Honda of Downtown Los Angeles (9923577d07), Service, 2026-10-07. ClickHouse holds four
 * spyne bookings at 17:33, 17:39, 18:10 and 18:40 PT on 10-07 — which are 00:33-01:40 UTC on 10-08 —
 * plus one 10-06 17:24 PT booking that is 10-07 00:24 UTC. The digest and the appointments console say
 * 4 for 10-07; the Overview's live path said 1. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { bookedInStoreWindow, countByAgent, bookedLeadsByAgent, fetchLiveAppointments } from "@/lib/reports/liveAppointments";
import type { Meeting } from "@/components/reports/data";

const LA = "America/Los_Angeles";
const DTLA_BOOKED_UTC = [
  "2026-10-08T00:33:30.000Z", // 17:33 PT 10-07
  "2026-10-08T00:39:38.000Z", // 17:39 PT 10-07
  "2026-10-08T01:10:35.000Z", // 18:10 PT 10-07
  "2026-10-08T01:40:30.000Z", // 18:40 PT 10-07
];
const PREV_EVENING_UTC = "2026-10-07T00:24:00.000Z"; // 17:24 PT on 10-06

function meeting(bookedAt: string, i: number): Meeting {
  return {
    id: `meeting_${i}`, leadId: `lead_${i}`, customer: "x", phone: null, vehicle: "", when: "", tz: null,
    status: "scheduled", serviceType: "service", assignedTo: null, intent: null, bookedAt,
    agentType: "service", direction: "inbound",
  };
}

test("Pacific evening bookings count on the store's day, not the next UTC day", () => {
  for (const ts of DTLA_BOOKED_UTC) {
    assert.equal(bookedInStoreWindow(ts, LA, "2026-10-07", "2026-10-08"), true, ts);
    assert.equal(bookedInStoreWindow(ts, LA, "2026-10-08", "2026-10-09"), false, ts);
  }
  // The 10-06 evening booking is a 10-07 UTC date but a 10-06 store day.
  assert.equal(bookedInStoreWindow(PREV_EVENING_UTC, LA, "2026-10-07", "2026-10-08"), false);
  assert.equal(bookedInStoreWindow(PREV_EVENING_UTC, LA, "2026-10-06", "2026-10-07"), true);
});

test("Honda DTLA 2026-10-07: 4 store-local bookings (the old UTC slice gave 1)", () => {
  const ms = [...DTLA_BOOKED_UTC, PREV_EVENING_UTC].map(meeting);
  assert.deepEqual(countByAgent(ms, "2026-10-07", "2026-10-08", LA).byAgent, { "Service Inbound": 4 });
  // No timezone → previous behaviour (raw UTC prefix): only the 10-06 PT booking lands on "10-07".
  assert.deepEqual(countByAgent(ms, "2026-10-07", "2026-10-08", null).byAgent, { "Service Inbound": 1 });
  assert.equal(bookedLeadsByAgent(ms, "2026-10-07", "2026-10-08", LA).leads["Service Inbound"].size, 4);
});

test("a zone east of UTC moves early-morning bookings back a day", () => {
  // 2026-10-07 20:30 UTC is 2026-10-08 02:00 in Kolkata (+05:30).
  assert.equal(bookedInStoreWindow("2026-10-07T20:30:00Z", "Asia/Kolkata", "2026-10-08", "2026-10-09"), true);
  assert.equal(bookedInStoreWindow("2026-10-07T20:30:00Z", "Asia/Kolkata", "2026-10-07", "2026-10-08"), false);
});

test("bad or missing timestamps never count; an invalid zone falls back to the UTC prefix", () => {
  assert.equal(bookedInStoreWindow(null, LA, "2026-10-07", "2026-10-08"), false);
  assert.equal(bookedInStoreWindow("", LA, "2026-10-07", "2026-10-08"), false);
  assert.equal(bookedInStoreWindow("2026-10-08T00:33:30Z", "Not/AZone", "2026-10-08", "2026-10-09"), true);
});

test("fetchLiveAppointments keeps the evening bookings and pages past the UTC day edge", async () => {
  // One page, newest booking first, as the API sorts it: a 10-08 PT booking (out of window), the four
  // DTLA evening bookings, then the 10-06 PT booking (before the window → paging stops).
  const page = [
    { id: "meeting_late", leadId: "l9", createdAt: "2026-10-08T20:00:00.000Z", status: "scheduled", serviceType: "service", source: "spyne", agentData: { agentType: "Service", callType: "inbound" } },
    ...DTLA_BOOKED_UTC.slice().reverse().map((createdAt, i) => ({
      id: i % 2 ? `meeting_${i}` : `6ac6e4da5a44cf59e3e054f${i}`, leadId: `l${i}`, createdAt, status: "scheduled",
      serviceType: "service", source: "spyne", agentData: { agentType: "Service", callType: "inbound" },
    })),
    { id: "meeting_prev", leadId: "lp", createdAt: PREV_EVENING_UTC, status: "scheduled", serviceType: "service", source: "spyne", agentData: { agentType: "Service", callType: "inbound" } },
  ];
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ data: page, pagination: { hasNextPage: true } }), { status: 200 });
  }) as typeof fetch;
  try {
    const live = await fetchLiveAppointments({ teamId: "9923577d07", enterpriseId: "7d06f7427", start: "2026-10-07", end: "2026-10-08", token: "tok", timezone: LA });
    assert.ok(live);
    assert.equal(live.meetings.length, 4);
    assert.equal(calls, 1, "the 10-06 store-day row ends paging");
    // Both id spaces are carried, and source rides along (D4 / A3-14).
    assert.ok(live.meetings.every((m) => m.source === "spyne"));
    assert.ok(live.meetings.some((m) => m.mongoId && !m.meetingId));
    assert.ok(live.meetings.some((m) => m.meetingId && !m.mongoId));
  } finally {
    globalThis.fetch = realFetch;
  }
});
