/* D3 — channelSplit always comes from the real counts, never from the cloned MOCK_AGENTS. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildResult, channelSplitOf } from "@/lib/reports/build";
import type { AgentDailyRow } from "@/lib/reports/schema";

function row(agent_type: string, over: Partial<AgentDailyRow>): AgentDailyRow {
  return {
    activity_day: "2026-10-07", team_id: "3d3deabc98", agent_type, enterprise_name: "e", rooftop_name: "r", rooftop_stage: "live",
    calls: 0, sms_threads: 0, chats: 0, conv_count: 0, connected: 0, reached_person: 0, qualified: 0, appointments: 0,
    appointments_assisted: 0, sms_sent: 0, sms_replied: 0, after_hours: 0, talk_seconds: 0, transfers: 0, transfers_failed: 0,
    callbacks: 0, query_resolved: 0, opt_outs: 0, leads_attempted: 0, quality_score_sum: 0, quality_basis: 0, new_leads: 0,
    stl_within5: 0, stl_within1: 0, stl_seconds_sum: 0, stl_count: 0, stl_afterhours_within5: 0, stl_within5_appts: 0,
    ...over,
  };
}

test("channelSplitOf is the counts, verbatim", () => {
  assert.deepEqual(channelSplitOf(0, 0), { voice: 0, sms: 0 });
  assert.deepEqual(channelSplitOf(34, 3), { voice: 34, sms: 3 });
});

test("an agent with rows but no calls and no SMS (a chat-only day) reads 0/0, not the mock 88/12", () => {
  const result = buildResult({
    daily: [
      row("Service Inbound", { chats: 3, conv_count: 3, leads_attempted: 2 }), // the Dream Nissan Midwest 10-07 shape
      row("Sales Inbound", { calls: 5, sms_threads: 2, conv_count: 7, leads_attempted: 6 }),
    ],
    breakdown: [],
    priorDaily: [],
  });
  const by = Object.fromEntries(result.agents.map((a) => [a.name, a]));
  assert.deepEqual(by["Service Inbound"].channelSplit, { voice: 0, sms: 0 });
  assert.deepEqual(by["Sales Inbound"].channelSplit, { voice: 5, sms: 2 });
  for (const a of result.agents) {
    for (const mock of [{ voice: 90, sms: 10 }, { voice: 62, sms: 38 }, { voice: 88, sms: 12 }, { voice: 55, sms: 45 }]) {
      assert.notDeepEqual(a.channelSplit, mock, `${a.name} carries a mock split`);
    }
  }
});
