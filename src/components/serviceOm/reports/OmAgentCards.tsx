"use client";

/* "Your agents" on the All reports view, in the old cards' look (copied from libraryPanel.tsx's
 * AgentReportCards) but read from the Service OM Reports model: the same numbers, on Om's Service Metrics API,
 * as the agent report and the Overview. Labels follow the funnel the agent report uses: "Qualified leads" is
 * gone (Om's v1.2 drops Qualified); the middle number is the funnel's middle stage (Engaged inbound, Reached
 * outbound); Appointments booked is the funnel's Booked (Booked by Spyne + Spyne-assisted, visits booked). */

import React from "react";
import { SectionLabel, fmtInt } from "@/components/reports/kit";
import type { AgentReport } from "@/lib/serviceOm/reportsModel";

function CardShell({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="flex flex-col gap-4 rounded-2xl border border-[#e5e7eb] bg-white px-6 py-5 text-left shadow-sm transition-shadow hover:border-[#d6c9f5] hover:shadow-md">
      {children}
    </button>
  );
}

/** The card's three numbers, each the agent report's own: the activity row's calls, the funnel's middle stage,
 * and the funnel's Booked. Null reads "—" (not available), never 0. */
export function agentCardStats(a: AgentReport): Array<{ label: string; value: string }> {
  const calls = a.sections.activity[0];
  const middle = a.funnel[1];
  const booked = a.bookedAppointments;
  return [
    { label: a.direction === "inbound" ? "Calls handled" : "Calls dispatched", value: calls?.value ?? "—" },
    { label: middle?.label ?? "Engaged", value: middle?.customers == null ? "—" : fmtInt(middle.customers) },
    { label: "Appointments booked", value: booked === null ? "—" : fmtInt(booked) },
  ];
}

export function OmAgentCards({ agents, periodLabel, loading, onOpenAgent }: { agents: AgentReport[]; periodLabel: string; loading: boolean; onOpenAgent: (key: string) => void }) {
  if (!agents.length) return null;
  return (
    <div className="flex flex-col gap-3">
      <SectionLabel hint={periodLabel}>Your agents</SectionLabel>
      <div className="grid gap-4" style={{ gridTemplateColumns: agents.length > 1 ? "repeat(auto-fit, minmax(320px, 1fr))" : "1fr" }}>
        {agents.map((a) => {
          const inbound = a.direction === "inbound";
          return (
            <CardShell key={a.key} onClick={() => onOpenAgent(a.key)}>
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 flex-none items-center justify-center rounded-xl bg-[#faf8ff] text-[20px] leading-none">{inbound ? "🛎️" : "🔧"}</span>
                <div className="min-w-0">
                  <p className="truncate text-[15px] font-extrabold leading-tight text-[#111]">{a.name ?? (inbound ? "Inbound agent" : "Outbound agent")}</p>
                  <p className="text-[11.5px] text-[#6b7280]">Service {inbound ? "Inbound · answers your phone" : "Outbound · works your lead list"}</p>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {agentCardStats(a).map((s) => (
                  <div key={s.label}>
                    <p className="text-[9.5px] font-bold uppercase tracking-wide text-[#9ca3af]">{s.label}</p>
                    {loading ? (
                      <span className="mt-1 block h-[20px] w-[48px] animate-pulse rounded bg-[#eef0f3]" />
                    ) : (
                      <p className="mt-0.5 text-[20px] font-extrabold leading-none tabular-nums text-[#111]">{s.value}</p>
                    )}
                  </div>
                ))}
              </div>
              <span className="mt-auto text-[12px] font-bold text-[#813fed]">Open the full report →</span>
            </CardShell>
          );
        })}
      </div>
    </div>
  );
}
