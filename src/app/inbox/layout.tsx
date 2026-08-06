"use client";

import React from "react";
import { ScenarioProvider } from "@/components/reports/scenario";

/* The Inbox is a standalone embedded surface (its own parent-console nav item iframes this route with
 * ?team_id=&enterprise_id=&env=&auth_key=). It reuses ScenarioProvider to resolve that scope from the
 * URL — same as the reports pages — but deliberately does NOT sit under the /reports "coming soon"
 * gate: the Inbox is a live conversation console, not part of the metrics-report validation surface. */
export default function InboxLayout({ children }: { children: React.ReactNode }) {
  return <ScenarioProvider>{children}</ScenarioProvider>;
}
