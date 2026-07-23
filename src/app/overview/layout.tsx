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

// Standalone Overview route — the parent console now iframes this directly (no sibling tabs sharing
// this scenario context), mirroring /reports/layout.tsx.
export default function OverviewLayout({ children }: { children: React.ReactNode }) {
  if (REPORTING_COMING_SOON) return <ReportingComingSoon />;
  return <ScenarioProvider>{children}</ScenarioProvider>;
}
