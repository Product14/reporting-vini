"use client";

import React from "react";
import { ScenarioProvider } from "@/components/reports/scenario";
import { ReportingComingSoon } from "@/components/reports/ComingSoonGate";

// Same "coming soon" gate as /overview and /reports (NEXT_PUBLIC_REPORTING_COMING_SOON), so switching a
// rooftop to these pages never shows it something the old pages would have hidden.
const REPORTING_COMING_SOON = !["0", "false", "off"].includes(
  (process.env.NEXT_PUBLIC_REPORTING_COMING_SOON ?? "").trim().toLowerCase(),
);

// The Service OM pages (Overview now, Reports next). Scope comes from the iframe URL, as on the old pages.
export default function ServiceOmLayout({ children }: { children: React.ReactNode }) {
  if (REPORTING_COMING_SOON) return <ReportingComingSoon />;
  return <ScenarioProvider>{children}</ScenarioProvider>;
}
