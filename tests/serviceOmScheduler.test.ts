import { test } from "node:test";
import assert from "node:assert/strict";
import { isKnownScheduler, notUpdatedLabel, schedulerName } from "../src/lib/serviceOm/scheduler";
import { DEFAULT_WHEN_UNSET, schedulerLabelOn } from "../src/lib/serviceOm/schedulerLabelSwitch";
import { mockScheduler } from "../src/lib/serviceOm/mock";
import { apiSchedulerProvider } from "../src/lib/serviceOm/api";
import { loadScheduler } from "../src/lib/serviceOm/source";

test("every prod scheduler provider gets its display name", () => {
  const prod: Record<string, string> = {
    xtime: "Xtime", "xtime-cox": "Xtime", tekion: "Tekion", cdk: "CDK", dealerfx: "DealerFX",
    pbs: "PBS", updatepromise: "UpdatePromise", mykaarma: "myKaarma", evenflow: "Evenflow",
  };
  for (const [provider, name] of Object.entries(prod)) assert.equal(schedulerName(provider), name, provider);
  // show-rate sends lower(providerName); a mixed-case value still maps.
  assert.equal(schedulerName("updatePromise"), "UpdatePromise");
  assert.equal(schedulerName(" CDK "), "CDK");
});

test("an unknown provider is title-cased, none is null", () => {
  assert.equal(schedulerName("new-scheduler"), "New Scheduler");
  assert.equal(schedulerName(null), null);
  assert.equal(schedulerName(""), null);
});

test("the label names the scheduler, or says 'the scheduler'", () => {
  assert.equal(notUpdatedLabel("Xtime"), "Status not updated in Xtime");
  assert.equal(notUpdatedLabel(null), "Status not updated in the scheduler");
});

test("sample data: one scheduler per rooftop, stable across reads", () => {
  assert.equal(mockScheduler({ teamId: "t1" }), mockScheduler({ teamId: "t1" }));
  const seen = new Set(Array.from({ length: 60 }, (_, i) => mockScheduler({ teamId: `team-${i}` })));
  assert.ok(seen.size > 3);
  assert.ok(seen.has(null)); // some sample rooftops have no scheduler, so the fallback gets exercised
});

test("a provider named like an Object.prototype key is just title-cased", () => {
  assert.equal(schedulerName("constructor"), "Constructor");
  assert.equal(schedulerName("toString"), "Tostring");
  assert.equal(isKnownScheduler("constructor"), false);
});

/* ── the rollback switch ── */
test("rollback switch: on by default, off by env, per-team list, URL override", () => {
  assert.equal(schedulerLabelOn("t1", null, undefined), DEFAULT_WHEN_UNSET === "all");
  assert.equal(DEFAULT_WHEN_UNSET, "all");
  for (const off of ["off", "none", "0", "false", "", " OFF "]) assert.equal(schedulerLabelOn("t1", null, off), false, off);
  assert.equal(schedulerLabelOn("t1", null, "all"), true);
  assert.equal(schedulerLabelOn("t1", null, "t1,t2"), true);
  assert.equal(schedulerLabelOn("t3", null, "t1,t2"), false);
  assert.equal(schedulerLabelOn("", null, "t1"), false);
  assert.equal(schedulerLabelOn("t1", "off", "all"), false); // ?sched_label=off beats the env
  assert.equal(schedulerLabelOn("t1", "on", "off"), true);
  assert.equal(schedulerLabelOn("t1", "junk", "off"), false); // an unknown override is ignored
});

/* ── the page's call to Om's show-rate endpoint, with fetch stubbed (nothing leaves the machine) ── */
type Call = { url: URL; auth: string | null };
async function withFetch(responses: Array<{ status: number; body?: unknown }>, fn: () => Promise<void>): Promise<Call[]> {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), auth: new Headers(init?.headers).get("Authorization") });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
  return calls;
}
const ctx = { teamId: "team-1", enterpriseId: "ent-1", spyneToken: "test-token" };

test("show-rate call: right path and params, no agentLine (its DTO would 400), Bearer token", async () => {
  let got: string | null = "unset";
  const calls = await withFetch([{ status: 200, body: { data: { provider: "xtime", method: "status" } } }], async () => {
    got = await apiSchedulerProvider(ctx);
  });
  assert.equal(got, "xtime");
  assert.equal(calls.length, 1);
  const u = calls[0].url;
  assert.equal(u.origin + u.pathname, "https://api.spyne.ai/conversation/service-metrics/appointment/show-rate");
  assert.equal(u.searchParams.get("enterpriseId"), "ent-1");
  assert.equal(u.searchParams.get("teamId"), "team-1");
  assert.equal(u.searchParams.has("agentLine"), false);
  assert.deepEqual([...u.searchParams.keys()].sort(), ["enterpriseId", "teamId"]);
  assert.equal(calls[0].auth, "Bearer test-token");
});

test("show-rate call: a bare (unwrapped) body, a rooftop without a scheduler, a 401, a 5xx retried once", async () => {
  let got: string | null = "unset";
  await withFetch([{ status: 200, body: { provider: "tekion" } }], async () => { got = await apiSchedulerProvider(ctx); });
  assert.equal(got, "tekion");
  await withFetch([{ status: 200, body: { data: { provider: null, reason: "No service-scheduler integration for this rooftop." } } }], async () => { got = await apiSchedulerProvider(ctx); });
  assert.equal(got, null);
  let calls = await withFetch([{ status: 401 }], async () => { got = await apiSchedulerProvider(ctx); });
  assert.equal(got, null);
  assert.equal(calls.length, 1); // a 4xx isn't retried
  calls = await withFetch([{ status: 502 }, { status: 200, body: { data: { provider: "cdk" } } }], async () => { got = await apiSchedulerProvider(ctx); });
  assert.equal(got, "cdk");
  assert.equal(calls.length, 2);
});

test("show-rate call: no token or no rooftop means no request at all", async () => {
  const calls = await withFetch([{ status: 200, body: { provider: "xtime" } }], async () => {
    assert.equal(await apiSchedulerProvider({ ...ctx, spyneToken: "" }), null);
    assert.equal(await apiSchedulerProvider({ ...ctx, teamId: "" }), null);
  });
  assert.equal(calls.length, 0);
});

test("sample source: loadScheduler answers from the sample, never the network", async () => {
  const calls = await withFetch([{ status: 500 }], async () => {
    assert.equal(await loadScheduler("mock", { ...ctx, teamId: "demo-1" }), "xtime");
  });
  assert.equal(calls.length, 0);
});
