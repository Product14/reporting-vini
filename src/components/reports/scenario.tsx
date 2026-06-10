"use client";

import React, { createContext, useContext, useMemo, useState } from "react";
import { ACCOUNTS, DEFAULT_ACCOUNT, type Account, type AccountStage } from "./accounts";

/* ────────────────────────────────────────────────────────────────────────────
 * The reports surface is scoped to a real dealer account (from the CSM tracker).
 * The bottom "control center" is a real account picker: choosing a rooftop sets
 * the team_id the live data queries, and its stage drives the lifecycle UI.
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

interface Ctx {
  account: Account;
  setAccount: (a: Account) => void;
}
const ScenarioCtx = createContext<Ctx | null>(null);

export function ScenarioProvider({ children }: { children: React.ReactNode }) {
  // Initialize from ?team_id= so a shared / reloaded URL restores the rooftop (read once, on the client).
  const [account, setAccountState] = useState<Account>(() => {
    if (typeof window === "undefined") return DEFAULT_ACCOUNT;
    const id = new URLSearchParams(window.location.search).get("team_id");
    const found = id ? ACCOUNTS.find((a) => a.teamId === id) : undefined;
    return found ?? DEFAULT_ACCOUNT;
  });

  // Selecting a rooftop updates state AND reflects it in the URL (shareable, no navigation).
  const setAccount = (a: Account) => {
    setAccountState(a);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("team_id", a.teamId);
      window.history.replaceState(null, "", url.toString());
    }
  };

  return <ScenarioCtx.Provider value={{ account, setAccount }}>{children}</ScenarioCtx.Provider>;
}

export function useScenario(): {
  account: Account;
  setAccount: (a: Account) => void;
  scenario: Scenario;
  teamId: string;
  view: ScenarioView;
} {
  const c = useContext(ScenarioCtx);
  const account = c?.account ?? DEFAULT_ACCOUNT;
  const scenario = scenarioForStage(account.stage);
  return {
    account,
    setAccount: c?.setAccount ?? (() => {}),
    scenario,
    teamId: account.teamId,
    view: scenarioView(scenario),
  };
}

/* ── the bottom control center — a real account picker (CSM tracker, sheet-driven) ── */
export function ScenarioControlCenter() {
  const { account, setAccount } = useScenario();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const filtered = useMemo(
    () => (q ? ACCOUNTS.filter((a) => a.name.toLowerCase().includes(q.toLowerCase())) : ACCOUNTS),
    [q],
  );
  return (
    <div className="fixed bottom-5 left-[calc(50%+32px)] z-50 -translate-x-1/2 px-3">
      {open && (
        <div className="absolute bottom-full left-1/2 mb-2 w-[340px] -translate-x-1/2 overflow-hidden rounded-2xl border border-[#e5e7eb] bg-white shadow-[0_10px_40px_rgba(16,24,40,0.22)]">
          <div className="border-b border-[#f0f0f0] p-2">
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search rooftops…"
              className="w-full rounded-lg bg-[#f3f4f6] px-3 py-2 text-[12.5px] text-[#111] outline-none placeholder:text-[#9ca3af] focus:bg-white focus:ring-2 focus:ring-[#d8caff]"
            />
          </div>
          <div className="max-h-[320px] overflow-y-auto py-1">
            {filtered.map((a) => {
              const on = a.teamId === account.teamId;
              return (
                <button
                  key={a.teamId}
                  onClick={() => { setAccount(a); setOpen(false); setQ(""); }}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-[#faf8ff] ${on ? "bg-[#f3eaff]" : ""}`}
                >
                  <span className="flex min-w-0 flex-col leading-tight">
                    <span className={`truncate text-[12.5px] font-semibold ${on ? "text-[#813fed]" : "text-[#111]"}`}>{a.name}</span>
                    <span className="truncate text-[10px] text-[#9ca3af]">{a.agents.join(" · ")}</span>
                  </span>
                  {a.stage === "In_Ob" && (
                    <span className="flex-none rounded-full bg-[#fef3c7] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-[#92400e]">Onboarding</span>
                  )}
                </button>
              );
            })}
            {filtered.length === 0 && <p className="px-3 py-5 text-center text-[12px] text-[#9ca3af]">No rooftop matches.</p>}
          </div>
        </div>
      )}
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-2xl border border-[#e5e7eb] bg-white/95 px-4 py-2.5 shadow-[0_10px_40px_rgba(16,24,40,0.18)] backdrop-blur-md transition-colors hover:bg-white"
      >
        <span className="hidden text-[9px] font-bold uppercase tracking-[0.12em] text-[#9ca3af] sm:inline">Viewing</span>
        <span className="text-[13px] leading-none">🏢</span>
        <span className="max-w-[220px] truncate text-[13px] font-bold text-[#111]">{account.name}</span>
        <span className="text-[11px] text-[#9ca3af]">▾</span>
      </button>
    </div>
  );
}
