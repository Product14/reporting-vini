"use client";

import React from "react";
import { ScenarioProvider } from "@/components/reports/scenario";

/* Shared layout for the console-v2 pages (Customers / Action Items / Appointments / Campaigns) that sit
 * alongside the Inbox. Resolves scope (team/enterprise/env/token) from the iframe URL via
 * ScenarioProvider — same as /inbox, and NOT behind the /reports "coming soon" gate. */
export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return <ScenarioProvider>{children}</ScenarioProvider>;
}
