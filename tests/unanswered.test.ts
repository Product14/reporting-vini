/* Unanswered queue (PRD FD-24641) — list query, badge, Mine, clears, manager summary. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { countBuckets, formatWait, selectEpisodes, summarizeByOwner } from "@/lib/unanswered/select";
import { resetSample, sampleClear, sampleManagerPage, sampleUnansweredPage } from "@/lib/unanswered/sample";
import { unansweredEnabledFor } from "@/lib/unanswered/flag";
import type { Episode } from "@/lib/unanswered/types";

const ep = (p: Partial<Episode>): Episode => ({
  episodeId: "e", leadId: "l", customerId: "c", conversationId: null, customerName: "n", phone: null,
  department: "sales", status: "open", since: "2026-10-19T10:00:00.000Z", waitInHoursMinutes: 10, channel: "sms",
  reason: "handoff", owner: { state: "no_owner", name: null, consoleUserId: null }, escalatedAt: null,
  reopened: false, vehicle: null, actionItems: [], recentMessages: [], ...p,
});

test("R13: one department and bucket at a time, oldest wait first by default", () => {
  const all = [
    ep({ episodeId: "new", since: "2026-10-19T11:00:00.000Z" }),
    ep({ episodeId: "old", since: "2026-10-19T09:00:00.000Z" }),
    ep({ episodeId: "svc", department: "service" }),
    ep({ episodeId: "aged", status: "aged" }),
  ];
  const q = { department: "sales" as const, bucket: "open" as const, scope: "team" as const };
  assert.deepEqual(selectEpisodes(all, { ...q, sort: "oldest" }, null).map((e) => e.episodeId), ["old", "new"]);
  assert.deepEqual(selectEpisodes(all, { ...q, sort: "newest" }, null).map((e) => e.episodeId), ["new", "old"]);
  assert.deepEqual(selectEpisodes(all, { ...q, sort: "oldest", bucket: "aged" }, null).map((e) => e.episodeId), ["aged"]);
});

test("R3: the badge counts open episodes only; aged are off it", () => {
  const all = [ep({}), ep({ status: "aged" }), ep({ department: "service" })];
  assert.deepEqual(countBuckets(all, "sales"), { open: 1, aged: 1 });
  assert.deepEqual(countBuckets(all, "service"), { open: 1, aged: 0 });
});

test("R4: Mine = episodes whose CRM owner maps to me; never unmapped or no-owner ones", () => {
  const all = [
    ep({ episodeId: "mine", owner: { state: "owned", name: "Me", consoleUserId: "u1" } }),
    ep({ episodeId: "other", owner: { state: "owned", name: "Them", consoleUserId: "u2" } }),
    ep({ episodeId: "unmapped", owner: { state: "unmapped", name: "Dave", consoleUserId: null } }),
  ];
  const q = { department: "sales" as const, bucket: "open" as const, sort: "oldest" as const, scope: "mine" as const };
  assert.deepEqual(selectEpisodes(all, q, "u1").map((e) => e.episodeId), ["mine"]);
  assert.deepEqual(selectEpisodes(all, q, null), []);
});

test("R7: manager summary per owner, unowned rows last, clicks and replies attributed", () => {
  const all = [
    ep({ episodeId: "a", waitInHoursMinutes: 40, owner: { state: "owned", name: "Shane", consoleUserId: "u1" } }),
    ep({ episodeId: "b", waitInHoursMinutes: 90, owner: { state: "owned", name: "Shane", consoleUserId: "u1" } }),
    ep({ episodeId: "c", status: "aged", waitInHoursMinutes: 2000, owner: { state: "no_owner", name: null, consoleUserId: null } }),
  ];
  const rows = summarizeByOwner(
    all,
    [
      { episodeId: "x", department: "sales", ownerKey: "u1", ownerLabel: "Shane", ownerState: "owned", kind: "handled_elsewhere", actor: "Shane", at: "2026-10-19T08:00:00.000Z" },
      { episodeId: "y", department: "sales", ownerKey: "u1", ownerLabel: "Shane", ownerState: "owned", kind: "console_reply", actor: "Shane", at: "2026-10-19T08:30:00.000Z" },
    ],
    "sales",
  );
  assert.equal(rows[0].ownerLabel, "Shane");
  assert.equal(rows[0].open, 2);
  assert.equal(rows[0].oldestOpenMinutes, 90);
  assert.equal(rows[0].clicks.length, 1);
  assert.equal(rows[0].repliesByMember, 1);
  assert.equal(rows[1].ownerLabel, "No owner");
  assert.equal(rows[1].aged, 1);
});

test("waits read in working-hours units", () => {
  assert.equal(formatWait(9), "9m");
  assert.equal(formatWait(95), "1h 35m");
  assert.equal(formatWait(1560), "1d 2h");
});

test("sample: Mine falls back to Team where the owner source isn't connected (service)", () => {
  resetSample();
  const svc = sampleUnansweredPage({ department: "service", bucket: "open", sort: "oldest", scope: "mine" });
  assert.equal(svc.config.mineAvailable, false);
  assert.equal(svc.episodes.length, svc.openCount);
  assert.equal(svc.config.escalationConfigured, false);
});

test("sample: a click clear removes the episode and shows in the manager view with its actor", () => {
  resetSample();
  const before = sampleUnansweredPage({ department: "sales", bucket: "open", sort: "oldest", scope: "team" });
  const target = before.episodes[0];
  assert.equal(sampleClear(target.episodeId, "handled_elsewhere"), true);
  assert.equal(sampleClear(target.episodeId, "handled_elsewhere"), false, "a second clear is a no-op");
  const after = sampleUnansweredPage({ department: "sales", bucket: "open", sort: "oldest", scope: "team" });
  assert.equal(after.openCount, before.openCount - 1);
  assert.ok(!after.episodes.some((e) => e.episodeId === target.episodeId));
  const mgr = sampleManagerPage("sales");
  const clicks = mgr.owners.flatMap((o) => o.clicks).filter((c) => c.kind === "handled_elsewhere");
  assert.ok(clicks.some((c) => c.actor === "Shane Ortiz"));
  resetSample();
});

test("R8: view flag per rooftop per department, server-side, off by default", () => {
  assert.equal(unansweredEnabledFor("t1", "sales", {}), false);
  assert.equal(unansweredEnabledFor("t1", "sales", { UNANSWERED_SALES_TEAM_IDS: "t0, T1" }), true);
  assert.equal(unansweredEnabledFor("t1", "service", { UNANSWERED_SALES_TEAM_IDS: "*" }), false, "service stays off until its own flag");
  assert.equal(unansweredEnabledFor("t9", "service", { UNANSWERED_SERVICE_TEAM_IDS: "*" }), true);
  assert.equal(unansweredEnabledFor(null, "sales", { UNANSWERED_SALES_TEAM_IDS: "*" }), false);
  // A browser-visible (NEXT_PUBLIC_) variable is NOT the flag: rollback must not need a rebuild (A14).
  assert.equal(unansweredEnabledFor("t1", "sales", { NEXT_PUBLIC_UNANSWERED_SALES_TEAM_IDS: "*" }), false);
});

test("R7: the manager page names who works the unowned queue", () => {
  resetSample();
  assert.equal(sampleManagerPage("sales").unownedQueueOwner, "Sales/BDC manager");
  assert.equal(sampleManagerPage("service").unownedQueueOwner, "Service manager");
  assert.equal(sampleUnansweredPage({ department: "sales", bucket: "open", sort: "oldest", scope: "team" }).enabled, true);
});
