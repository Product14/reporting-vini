/* The request cap the all-rooftops check relies on: however many checks run at once, no more than
 * SERVICE_OM_MAX_REQUESTS calls reach Om's API at the same time. Uses a stand-in fetch, never the network. */
import { test } from "node:test";
import assert from "node:assert/strict";

test("no more than SERVICE_OM_MAX_REQUESTS calls are ever in flight", async () => {
  process.env.SERVICE_OM_MAX_REQUESTS = "3"; // read when api.ts loads, so set before the import
  let active = 0;
  let peak = 0;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5 + Math.random() * 15));
    active--;
    return new Response(JSON.stringify({ window: { from: "2026-10-01", to: "2026-10-13", timezone: "UTC" }, metrics: {} }), { status: 200 });
  }) as typeof fetch;

  const { apiAppointments, requestStats } = await import("@/lib/serviceOm/api");
  const ctx = { enterpriseId: "e1", teamId: "t1", spyneToken: "test" };
  const results = await Promise.all(Array.from({ length: 60 }, () => apiAppointments(ctx, { window: "30d" })));

  assert.equal(calls, 60);
  assert.ok(results.every((r) => r !== null), "every call still completes");
  assert.ok(peak <= 3, `peak in flight ${peak}`);
  assert.equal(peak, 3, "and the cap is actually used, not serialised to 1");
  assert.equal(requestStats.peak, 3);
});
