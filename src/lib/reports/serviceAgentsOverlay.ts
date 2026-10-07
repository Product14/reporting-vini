import type { AgentData } from "@/components/reports/data";
import type { ServiceAgentNumbers, ServiceAgentsOverlay } from "@/lib/serviceMetrics";

/* Which rooftops read Om's API on Reports > Agents for Service. A comma list of team ids, or "all".
 * Empty or unset is off, so a deploy changes nothing until the list is set (launch-checks, test
 * rooftops first). Sales never reads it. */
export function serviceReportsOmOn(teamId: string, raw: string | undefined = process.env.NEXT_PUBLIC_SERVICE_REPORTS_OM_TEAMS): boolean {
  const list = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!teamId || list.length === 0) return false;
  return list.includes("all") || list.includes(teamId);
}

const pick = (api: number | null, current: number) => (api === null ? current : api);

/** Pure. A Service agent's headline numbers from Om's API; anything the API could not answer keeps
 * its current value, so a failed call never blanks the report. Sales agents come back untouched. */
export function applyServiceAgentNumbers(agent: AgentData, n: ServiceAgentNumbers | null): AgentData {
  if (agent.dept !== "Service" || !n) return agent;
  const inbound = agent.dir === "Inbound";
  const m = agent.metrics;
  const entry = inbound ? n.reached : n.calls;
  const metrics = {
    ...m,
    calls: pick(n.calls, m.calls),
    smsSent: pick(n.smsSent, m.smsSent),
    talkMinutes: pick(n.talkMinutes, m.talkMinutes),
    conversations: pick(n.conversations, m.conversations),
    qualified: pick(n.wantedService, m.qualified),
    appointments: pick(n.booked, m.appointments),
  };
  const lf = agent.leadFunnel;
  const leadFunnel = lf
    ? {
        ...lf,
        contacted: inbound ? pick(n.reached, lf.contacted) : lf.contacted,
        dialed: inbound ? lf.dialed : pick(n.calls, lf.dialed),
        connected: pick(n.conversations, lf.connected),
        qualified: pick(n.wantedService, lf.qualified),
        appt: pick(n.booked, lf.appt),
        // The route's booked-customers numerator belongs to the route's qualified count. Once Om's API
        // supplies the denominator (wanted service — inbound only today), close rate is Om's booked ÷
        // wanted service, so drop it; while qualified stays ours, so does the numerator.
        bookedLeads: n.wantedService === null ? lf.bookedLeads : undefined,
      }
    : lf;
  const report = entry === null ? agent.report : { ...agent.report, leadsAttempted: entry };
  return { ...agent, metrics, leadFunnel, report };
}

export function applyServiceAgentsOverlay(agents: AgentData[], ov: ServiceAgentsOverlay): AgentData[] {
  if (!ov.inbound && !ov.outbound) return agents;
  return agents.map((ag) => applyServiceAgentNumbers(ag, ag.dir === "Inbound" ? ov.inbound : ov.outbound));
}
