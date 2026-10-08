/* D7 — the canonical gate honours a caller's deadline: a call whose deadline fires while QUEUED leaves
 * the queue without running, one that fires while RUNNING is aborted and frees its slot, and the gate
 * keeps serving afterwards. No signal → unchanged behaviour. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchCanonicalOverview } from "@/lib/spyne/consoleReports";

const args = { enterpriseId: "e", teamId: "t", start: "2026-10-07", end: "2026-10-08" };

test("queued calls leave on the hard deadline; running calls abort; the gate is not wedged", async () => {
  // AbortSignal.timeout's timer is unref'd; a server keeps the loop alive, a bare test process does not.
  const keepAlive = setInterval(() => {}, 1000);
  const realFetch = globalThis.fetch;
  let started = 0;
  let mode: "hang" | "ok" = "hang";
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    started++;
    if (mode === "ok") return Promise.resolve(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    return new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
    });
  }) as typeof fetch;
  try {
    const slowA = new AbortController();
    // Two calls occupy both slots and hang.
    const a = fetchCanonicalOverview({ ...args, signal: slowA.signal }, "tok");
    const b = fetchCanonicalOverview({ ...args, signal: slowA.signal }, "tok");
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(started, 2);
    // A third, with a 50ms deadline, waits in the queue and must give up without ever running.
    const t0 = Date.now();
    const c = await fetchCanonicalOverview({ ...args, signal: AbortSignal.timeout(50) }, "tok");
    assert.equal(c, null);
    assert.ok(Date.now() - t0 < 1000, "returned promptly");
    assert.equal(started, 2, "the timed-out queued call never started");
    // Aborting the running pair frees both slots.
    slowA.abort();
    assert.equal(await a, null);
    assert.equal(await b, null);
    // The gate still serves.
    mode = "ok";
    const d = await fetchCanonicalOverview({ ...args }, "tok");
    assert.deepEqual(d, { ok: 1 });
  } finally {
    globalThis.fetch = realFetch;
    clearInterval(keepAlive);
  }
});

test("an already-aborted signal never reaches the upstream", async () => {
  const realFetch = globalThis.fetch;
  let started = 0;
  globalThis.fetch = (async () => { started++; return new Response("{}"); }) as typeof fetch;
  try {
    const ac = new AbortController();
    ac.abort();
    assert.equal(await fetchCanonicalOverview({ ...args, signal: ac.signal }, "tok"), null);
    assert.equal(started, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the admission deadline stops queued calls but lets running ones finish", async () => {
  const keepAlive = setInterval(() => {}, 1000);
  const realFetch = globalThis.fetch;
  let started = 0;
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    started++;
    return new Promise<Response>((res, rej) => {
      const t = setTimeout(() => res(new Response(JSON.stringify({ ok: started }), { status: 200 })), 80);
      init?.signal?.addEventListener("abort", () => { clearTimeout(t); rej(new Error("aborted")); }, { once: true });
    });
  }) as typeof fetch;
  try {
    const queueSignal = AbortSignal.timeout(30);
    const hard = AbortSignal.timeout(5_000);
    const [a, b, c] = await Promise.all([
      fetchCanonicalOverview({ ...args, signal: hard, queueSignal }, "tok"),
      fetchCanonicalOverview({ ...args, signal: hard, queueSignal }, "tok"),
      fetchCanonicalOverview({ ...args, signal: hard, queueSignal }, "tok"), // queued behind the two
    ]);
    assert.ok(a && b, "the two running calls completed after the admission deadline");
    assert.equal(c, null, "the queued call gave up");
    assert.equal(started, 2);
  } finally {
    globalThis.fetch = realFetch;
    clearInterval(keepAlive);
  }
});
