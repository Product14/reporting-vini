"use client";

import React from "react";
import { ScenarioProvider } from "@/components/reports/scenario";
import { ReportingComingSoon } from "@/components/reports/ComingSoonGate";

// ── TEMP gate ───────────────────────────────────────────────────────────────
// While the live numbers are being validated, the whole reporting surface shows a
// "Coming soon" screen instead of the real report. ON by default; flip OFF in an
// environment to see the real reports for validation:
//   NEXT_PUBLIC_REPORTING_COMING_SOON=0   (e.g. .env.local, or a Vercel preview)
// To retire the gate for good: delete this flag + the conditional below + the
// ReportingComingSoon component, leaving the plain <ScenarioProvider> return.
const REPORTING_COMING_SOON = !["0", "false", "off"].includes(
  (process.env.NEXT_PUBLIC_REPORTING_COMING_SOON ?? "").trim().toLowerCase(),
);

// Shared across /reports, /reports/agents and /reports/campaigns: one scenario context,
// scoped by the ?team_id= URL param, that survives navigation between the report tabs
// (the layout does not remount on sibling route change).
export default function ReportsLayout({ children }: { children: React.ReactNode }) {
  if (REPORTING_COMING_SOON) return <ReportingComingSoon />;
  return <ScenarioProvider>{children}</ScenarioProvider>;
}
