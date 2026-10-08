/* D5 — opt-out reply detection, call direction (callback → outbound flip), spam flag, paging. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isOptOutBody, isRealReply, optOutSqlList, OPT_OUT_KEYWORDS, callDirection, spamFlag, pageMeta } from "@/lib/reports/conversationRules";
import { readFileSync } from "node:fs";

test("opt-out keywords are not replies, whatever the case or padding", () => {
  for (const b of ["STOP", "stop", " Stop ", "STOP ALL", "unsubscribe", "Cancel", "END", "quit", "opt out", "NO", "remove"]) {
    assert.equal(isOptOutBody(b), true, b);
  }
  for (const b of ["Stop by tomorrow?", "no thanks, maybe next week", "Yes", "What time?", "", "stopp"]) {
    assert.equal(isOptOutBody(b), false, b);
  }
});

test("a real reply is human, inbound, and not just an opt-out", () => {
  assert.equal(isRealReply({ authorType: "human", direction: "in", body: "Is the Civic still there?" }), true);
  assert.equal(isRealReply({ authorType: "human", direction: "in", body: "STOP" }), false);
  assert.equal(isRealReply({ authorType: "human", direction: "out", body: "Hi, this is Mike from the store" }), false, "dealer staff text");
  assert.equal(isRealReply({ authorType: "ai", direction: "out", body: "Hello!" }), false);
});

test("the SQL keyword list is the spine's list, verbatim", () => {
  const spine = readFileSync(new URL("../src/lib/reports/agentBaseFact.sql", import.meta.url), "utf8");
  const m = spine.match(/NOT IN\s*\(([^)]*'STOP'[^)]*)\)/);
  assert.ok(m, "spine opt-out list not found");
  const spineList = [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
  assert.deepEqual([...OPT_OUT_KEYWORDS], spineList);
  assert.equal(optOutSqlList(), `(${spineList.map((k) => `'${k}'`).join(",")})`);
});

test("direction comes from callType, and a callback from an outbound touch is outbound", () => {
  assert.equal(callDirection({ callType: "outboundPhoneCall", inOutType: "" }), "outbound", "blank report_inOutType (48% of outbound rows)");
  assert.equal(callDirection({ callType: "outboundPhoneCall", inOutType: "inbound" }), "outbound");
  assert.equal(callDirection({ callType: "inboundPhoneCall", inOutType: "" }), "inbound");
  assert.equal(callDirection({ callType: "webCall" }), "inbound");
  // The flip: the customer calls the outbound line back → credited to outbound, like the spine.
  assert.equal(callDirection({ callType: "inboundPhoneCall", isCallbackFromOutbound: 1 }), "outbound");
  assert.equal(callDirection({ callType: "inboundPhoneCall", isCallbackFromOutbound: "1" }), "outbound");
  assert.equal(callDirection({ callType: "inboundPhoneCall", isCallbackFromOutbound: 0, callbackCampaignId: "camp_1" }), "outbound");
  assert.equal(callDirection({ callType: "inboundPhoneCall", callbackOutboundTaskId: "task_9" }), "outbound");
  // Unknown callType → report_inOutType, then inbound.
  assert.equal(callDirection({ callType: "", inOutType: "outbound" }), "outbound");
  assert.equal(callDirection({}), "inbound");
});

test("spam flag and page meta", () => {
  assert.equal(spamFlag("Yes"), "Yes");
  assert.equal(spamFlag("no"), "No");
  assert.equal(spamFlag(""), null);
  assert.equal(spamFlag(null), null);
  assert.deepEqual(pageMeta(50, 50, 0), { hasMore: true, nextOffset: 50 });
  assert.deepEqual(pageMeta(50, 50, 100), { hasMore: true, nextOffset: 150 });
  assert.deepEqual(pageMeta(12, 50, 50), { hasMore: false, nextOffset: null });
});
