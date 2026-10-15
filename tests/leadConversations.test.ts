/* FD-24439 — the lead drawer read "Unknown caller": the lead-conversations mapping hard-coded customer/phone null. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { leadConversationsToRows } from "@/lib/reports/leadConversations";
import type { CanonicalLeadConversations } from "@/lib/spyne/consoleReports";

const conversations: CanonicalLeadConversations["conversations"] = [
  { id: "c1", callId: "k1", leadId: "L1", channel: "call", direction: "inbound", at: "2026-10-15T14:00:00Z", durationSec: 90, summary: "s", outcome: "Interested", recordingUrl: null, messages: [] },
  { id: "c2", callId: null, leadId: "L1", channel: "sms", direction: null, at: "2026-10-15T15:00:00Z", durationSec: 0, summary: "", outcome: "", recordingUrl: null,
    messages: [{ role: "agent", text: "Hi", at: null }, { role: "customer", text: "Hello", at: "2026-10-15T15:01:00Z" }] },
];

test("every row carries the lead's name and phone when the backend serves them", () => {
  const rows = leadConversationsToRows({ conversations, customer: { name: "Test Lead", phone: "+15550000000" }, degraded: false });
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.customer, "Test Lead");
    assert.equal(r.phone, "+15550000000");
  }
});

test("an older backend without `customer` (or a null/blank one) maps to null, not a made-up name", () => {
  for (const customer of [undefined, null, { name: "", phone: "" }]) {
    const rows = leadConversationsToRows({ conversations, customer, degraded: false });
    for (const r of rows) {
      assert.equal(r.customer, null);
      assert.equal(r.phone, null);
    }
  }
});

test("the rest of the mapping is unchanged", () => {
  const [call, sms] = leadConversationsToRows({ conversations, degraded: false });
  assert.equal(call.direction, "inbound");
  assert.equal(call.title, "Interested");
  assert.equal(call.sms, undefined);
  assert.equal(sms.direction, "outbound");
  assert.equal(sms.msgs, 2);
  assert.deepEqual(sms.sms?.map((m) => [m.authorType, m.direction, m.at]), [["ai", "out", ""], ["human", "in", "2026-10-15T15:01:00Z"]]);
});
