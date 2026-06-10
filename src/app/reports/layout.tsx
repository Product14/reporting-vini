"use client";

import React from "react";
import { ScenarioProvider } from "@/components/reports/scenario";

// Shared across /reports, /reports/agents and /reports/campaigns: one scenario context,
// scoped by the ?team_id= URL param, that survives navigation between the report tabs
// (the layout does not remount on sibling route change).
export default function ReportsLayout({ children }: { children: React.ReactNode }) {
  return <ScenarioProvider>{children}</ScenarioProvider>;
}
