/* Catalog of the 20 Agent-Performance reporting widgets → their Metabase card IDs.
 * `agentScoped` cards take an agent_type param; team-level cards expose only team_id/start/end.
 * Data is fetched per card through /api/metabase/data (server-signed embed). */

export type AgentType = "Sales Inbound" | "Sales Outbound" | "Service Inbound" | "Service Outbound";

export const AGENT_TYPES: AgentType[] = ["Sales Inbound", "Sales Outbound", "Service Inbound", "Service Outbound"];

export type ReportSection = "Performance" | "Conversion" | "Operations" | "Revenue" | "Quality";
export const SECTIONS: ReportSection[] = ["Performance", "Conversion", "Operations", "Revenue", "Quality"];

export interface MetabaseCard {
  id: number;
  title: string;
  section: ReportSection;
  agentScoped: boolean; // true → pass agent_type; false → team-level (no agent_type slug)
}

export const METABASE_CARDS: MetabaseCard[] = [
  // Performance
  { id: 12193, title: "Bottom line", section: "Performance", agentScoped: true },
  { id: 12194, title: "Performance table", section: "Performance", agentScoped: true },
  { id: 12195, title: "Qualified — SMS + outbound-task paths", section: "Performance", agentScoped: false },
  { id: 12196, title: "Day-by-day trend", section: "Performance", agentScoped: true },
  // Conversion
  { id: 12197, title: "Funnel stages", section: "Conversion", agentScoped: true },
  { id: 12198, title: "Qualified intents", section: "Conversion", agentScoped: true },
  { id: 12199, title: "Non-qualified intents", section: "Conversion", agentScoped: true },
  { id: 12200, title: "Resolution rate by topic", section: "Conversion", agentScoped: true },
  { id: 12201, title: "Top outcomes — inbound", section: "Conversion", agentScoped: true },
  { id: 12202, title: "Top outcomes — outbound tasks", section: "Conversion", agentScoped: false },
  // Operations
  { id: 12203, title: "Channel mix", section: "Operations", agentScoped: false },
  { id: 12204, title: "During vs after hours", section: "Operations", agentScoped: true },
  { id: 12205, title: "Time of day", section: "Operations", agentScoped: true },
  { id: 12206, title: "Multi-day SMS follow-up", section: "Operations", agentScoped: false },
  // Revenue
  { id: 12207, title: "Appointment source (direct / indirect / CRM-bdc)", section: "Revenue", agentScoped: false },
  { id: 12208, title: "STL & leads by source", section: "Revenue", agentScoped: false },
  { id: 12209, title: "Speed to lead", section: "Revenue", agentScoped: true },
  // Quality
  { id: 12210, title: "Quality health", section: "Quality", agentScoped: true },
  { id: 12211, title: "Quality score + frustrated", section: "Quality", agentScoped: true },
  { id: 12212, title: "SMS opt-outs", section: "Quality", agentScoped: false },
];
