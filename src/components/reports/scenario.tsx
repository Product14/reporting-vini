"use client";

import React, { createContext, useContext, useState } from "react";
import { ACCOUNTS, type Account, type AccountStage } from "./accounts";

/* ────────────────────────────────────────────────────────────────────────────
 * The reports surface is scoped to a single dealer rooftop, identified entirely
 * by the ?team_id= URL param — the host (iframe parent) passes it in. There is no
 * in-app rooftop switching: the team is whatever the host scoped us to.
 *
 * If that team_id is in the CSM tracker we use its metadata (display name, agent
 * set, lifecycle stage); otherwise we synthesize a minimal live account so ANY
 * team_id the host passes still renders a full report. The stage drives the
 * lifecycle UI:
 *   In_Ob  → onboarding (importing, not live yet)
 *   Live   → live report
 *   Churned→ live report too (we never surface churn to the account)
 * ──────────────────────────────────────────────────────────────────────────── */

export type Scenario = "first_time" | "onboarding" | "recently_live" | "repeat";

function scenarioForStage(stage: AccountStage): Scenario {
  return stage === "In_Ob" ? "onboarding" : "repeat";
}

export interface ScenarioView {
  scenario: Scenario;
  agentLive: boolean; // has the agent started working?
  hasData: boolean; // any agent-produced data to show
  hasBaseline: boolean; // dealer's human-team history captured at onboarding
  monthsLive: number; // how many before/after months are real (0–3)
  daysLive: number;
  confidence: "none" | "low" | "high";
  importProgress: number; // 0–100 (onboarding CRM import)
  liveLabel: string; // human label for the period / status
}

export function scenarioView(s: Scenario): ScenarioView {
  switch (s) {
    case "first_time":
      return { scenario: s, agentLive: false, hasData: false, hasBaseline: false, monthsLive: 0, daysLive: 0, confidence: "none", importProgress: 0, liveLabel: "Not set up" };
    case "onboarding":
      return { scenario: s, agentLive: false, hasData: false, hasBaseline: true, monthsLive: 0, daysLive: 0, confidence: "none", importProgress: 64, liveLabel: "Goes live tomorrow" };
    case "recently_live":
      return { scenario: s, agentLive: true, hasData: true, hasBaseline: true, monthsLive: 1, daysLive: 6, confidence: "low", importProgress: 100, liveLabel: "Live 6 days" };
    case "repeat":
      return { scenario: s, agentLive: true, hasData: true, hasBaseline: true, monthsLive: 3, daysLive: 96, confidence: "high", importProgress: 100, liveLabel: "Live 96 days" };
  }
}

// No team_id in the URL → empty sentinel. Pages key off teamId === "" to render the
// "No rooftop selected" prompt instead of a report.
const NO_ACCOUNT: Account = { teamId: "", name: "", agents: [], stage: "Live" };

/* Resolve the rooftop for a given team_id. Known ids (in the CSM tracker) carry full metadata;
 * an unknown id still gets a minimal live account so any team the host scopes us to renders a
 * full report — agentsForAccount() falls back to showing all agents when agents is empty. */
function resolveAccount(teamId: string | null | undefined): Account {
  if (!teamId) return NO_ACCOUNT;
  return ACCOUNTS.find((a) => a.teamId === teamId) ?? { teamId, name: "your rooftop", agents: [], stage: "Live" };
}

interface Ctx {
  account: Account;
}
const ScenarioCtx = createContext<Ctx | null>(null);

export function ScenarioProvider({ children }: { children: React.ReactNode }) {
  // Scope is set entirely by the ?team_id= URL param the host passes in — read once on the client.
  // No in-app switching, so the value never changes after mount (the iframe reloads to rescope).
  const [account] = useState<Account>(() => {
    if (typeof window === "undefined") return NO_ACCOUNT;
    return resolveAccount(new URLSearchParams(window.location.search).get("team_id"));
  });

  return <ScenarioCtx.Provider value={{ account }}>{children}</ScenarioCtx.Provider>;
}

export function useScenario(): {
  account: Account;
  scenario: Scenario;
  teamId: string;
  view: ScenarioView;
} {
  const c = useContext(ScenarioCtx);
  const account = c?.account ?? NO_ACCOUNT;
  const scenario = scenarioForStage(account.stage);
  return {
    account,
    scenario,
    teamId: account.teamId,
    view: scenarioView(scenario),
  };
}
