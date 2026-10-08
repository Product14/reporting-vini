/* D4 — both ids of a meeting, sorted by shape (the feed's `id` is meeting_id on some rows, the Mongo _id
 * on others). Values are the real Honda DTLA 10-07 pair from dealer_leads.meetings. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyMeetingIds } from "@/lib/spyne/meetings";

test("classifyMeetingIds", () => {
  assert.deepEqual(classifyMeetingIds("meeting_65ba47d5d57c4047ac30fbdc289696f1"), { meetingId: "meeting_65ba47d5d57c4047ac30fbdc289696f1", mongoId: null });
  assert.deepEqual(classifyMeetingIds("6ac6e4da5a44cf59e3e054f3"), { meetingId: null, mongoId: "6ac6e4da5a44cf59e3e054f3" });
  assert.deepEqual(classifyMeetingIds("6ac6e4da5a44cf59e3e054f3", "meeting_65ba47d5d57c4047ac30fbdc289696f1"), { meetingId: "meeting_65ba47d5d57c4047ac30fbdc289696f1", mongoId: "6ac6e4da5a44cf59e3e054f3" });
  assert.deepEqual(classifyMeetingIds("", null), { meetingId: null, mongoId: null });
  assert.deepEqual(classifyMeetingIds("something-else"), { meetingId: null, mongoId: null });
});
