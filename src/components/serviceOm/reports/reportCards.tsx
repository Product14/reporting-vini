"use client";

/* Service OM Reports cards: the agent picker, the funnel and the appointment numbers, nothing else. Layout
 * follows Reports > Agent performance (agents-next, the Service view in production) with the v1.2 spec's
 * numbers: the funnel is F1–F6 instead of Callers → Qualified → Visits, and the headline is Booking rate
 * instead of Close rate. Every number comes from reportsModel.ts; nothing is computed here. */

import React from "react";
import { fmtInt } from "@/components/reports/data";
import { CountUp } from "@/components/reports/anim";
import { InfoTip } from "@/components/reports/kit";
import type { AgentReport, FunnelStage, InboundReport, OutboundReport, PeriodBooked, RateView } from "@/lib/serviceOm/reportsModel";
import { AgentAvatar, AgentStat, VisitsBooked } from "../overview/cards";

const INK = "#15161d";
const SUB = "#667085";
const PURPLE = "#5b21e6";
const BORDER = "#eceef2";

// Over 100% means a stage outran its parent (different populations): "—", never a number like 400%.
export const pct = (r: RateView | null | undefined): string => (r && r.value !== null && r.value <= 1 ? `${Math.round(r.value * 100)}%` : "—");
const nOfD = (r: RateView | null | undefined): string => (r ? `${fmtInt(r.numerator)} of ${fmtInt(r.denominator)}` : "not available");

function Shimmer({ w = 60, h = 20 }: { w?: number; h?: number }) {
  return <span className="inline-block animate-pulse rounded bg-[#eceaf6]" style={{ width: w, height: h }} />;
}

/* ══════════ agent picker ══════════ */
export function AgentPicker({ agents, selected, onPick, loading }: { agents: AgentReport[]; selected: string | null; onPick: (key: string) => void; loading: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {agents.map((a) => {
        const on = a.key === selected;
        const unit = a.direction === "inbound" ? (a.pickerCount === 1 ? "caller" : "callers") : "reached";
        return (
          <button
            key={a.key}
            onClick={() => onPick(a.key)}
            className="flex items-center gap-3 rounded-[14px] border bg-white px-4 py-3 text-left transition-shadow"
            style={on ? { borderColor: "#b9a4f7", boxShadow: "0 0 0 3px #efe9ff" } : { borderColor: BORDER }}
          >
            <AgentAvatar name={a.name} imageUrl={a.imageUrl} />
            <span className="flex min-w-0 flex-col">
              <span className="text-[14.5px] font-bold" style={{ color: INK }}>Service {a.direction === "inbound" ? "Inbound" : "Outbound"}{a.name ? <span className="font-medium" style={{ color: SUB }}> · {a.name}</span> : null}</span>
              <span className="text-[12.5px]" style={{ color: SUB }}>{loading ? <Shimmer w={70} h={12} /> : `${a.pickerCount === null ? "—" : fmtInt(a.pickerCount)} ${unit}`}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ══════════ funnel ══════════ */
const STAGE_COLORS = ["#6d3df0", "#7c55f3", "#8f6ff5", "#a48af7"];
const BOOKED_COLOR = "linear-gradient(90deg, #1f9d62, #23ab70)";
const ASSISTED_COLOR = "repeating-linear-gradient(135deg, #8fd9b4 0 5px, #c9eedb 5px 10px)";
const BOOKED_INK = "#0f7a4c";

/* The Booked row's two parts, straight from the agent's own appointment numbers (reportsModel.ts adds them up
 * to the stage's number): Booked by Spyne is the solid part of the bar, Spyne-assisted the hatched part. */
interface BookedSplit { bySpyne: number; assisted: number }

function FunnelBars({ stages, loading, booked, split }: { stages: FunnelStage[]; loading: boolean; booked?: React.ReactNode; split?: BookedSplit }) {
  const top = stages[0]?.customers ?? 0;
  return (
    <div className="flex flex-col gap-3">
      {stages.map((s, i) => {
        const isBooked = s.key === "booked";
        const width = s.customers !== null && top > 0 ? Math.min(100, Math.max(1.5, (s.customers / top) * 100)) : s.customers ? 100 : 0;
        // Only the Booked row is split, and only once loaded; every other row reads as before.
        const parts = isBooked && !loading ? split : undefined;
        return (
          <div key={s.key} className="grid grid-cols-[112px_1fr] items-center gap-4 sm:grid-cols-[150px_1fr]">
            <div className="flex flex-col">
              {loading ? <Shimmer w={56} h={26} /> : parts ? (
                <div className="flex flex-wrap items-baseline gap-x-1.5">
                  <p className="text-[26px] font-extrabold leading-none tracking-[-0.03em] tabular-nums" style={{ color: BOOKED_INK }}>
                    <CountUp value={parts.bySpyne} />
                  </p>
                  <p className="text-[12.5px] font-semibold" style={{ color: BOOKED_INK }}>Booked by Spyne<InfoTip metric="bookedBySpyne" /></p>
                </div>
              ) : (
                <p className="text-[26px] font-extrabold leading-none tracking-[-0.03em] tabular-nums" style={{ color: isBooked ? BOOKED_INK : INK }}>
                  {s.customers === null ? "—" : <CountUp value={s.customers} />}
                </p>
              )}
              {!parts && <p className="mt-1 text-[12.5px] font-medium" style={{ color: isBooked ? BOOKED_INK : SUB }}>{s.label}</p>}
              {s.assisted || s.topUp ? (
                <p className="text-[10.5px]" style={{ color: SUB }}>
                  {/* Spyne-assisted explains itself in its (i); the native title stays on the top-up, which has no glossary entry. */}
                  {s.assisted ? <>incl. {fmtInt(s.assisted)} Spyne-assisted<InfoTip metric="spyneAssisted" /></> : null}
                  {s.assisted && s.topUp ? " · " : null}
                  {s.topUp ? <span title="Added so every booking below sits inside this stage: bookings from contacts outside this period.">+{fmtInt(s.topUp)} to cover all bookings</span> : null}
                </p>
              ) : null}
              {isBooked && booked}
            </div>
            <div className="flex items-center gap-2.5">
              <div className="h-[30px] flex-1 overflow-hidden rounded-[8px] bg-[#f5f4fa]">
                {!loading && s.customers !== null && (parts && parts.assisted > 0 ? (
                  <div className="flex h-full overflow-hidden rounded-[8px] transition-[width] duration-700" style={{ width: `${width}%` }}>
                    <div className="h-full" style={{ flex: `${parts.bySpyne} 1 0`, background: BOOKED_COLOR }} />
                    <div className="h-full" style={{ flex: `${parts.assisted} 1 0`, background: ASSISTED_COLOR }} />
                  </div>
                ) : (
                  <div className="h-full rounded-[8px] transition-[width] duration-700" style={{ width: `${width}%`, background: isBooked ? BOOKED_COLOR : STAGE_COLORS[Math.min(i, STAGE_COLORS.length - 1)] }} />
                ))}
              </div>
              <span className="w-[52px] flex-none text-right text-[11.5px] font-semibold" style={{ color: i === 0 ? "transparent" : "#6d4ad0" }} title={s.fromPrev ? `${nOfD(s.fromPrev)} from the stage before (R2)` : undefined}>
                {i === 0 ? "·" : pct(s.fromPrev)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function HeadlineRate({ rate, formula }: { rate: RateView | null; formula: string }) {
  return (
    <div className="flex flex-none items-center gap-2.5 rounded-[12px] border border-[#e6defc] bg-[#faf8ff] px-3.5 py-2" title={`${formula}: ${nOfD(rate)}`}>
      <span className="text-[10px] font-bold uppercase tracking-[0.08em]" style={{ color: "#8b7bc6" }}>Booking rate</span>
      <span className="text-[24px] font-extrabold leading-none tracking-[-0.03em]" style={{ color: PURPLE }}>{pct(rate)}</span>
    </div>
  );
}

export function FunnelCard({ agent, windowPhrase, tzLabel, loading, onViewBooked, children }: { agent: AgentReport; windowPhrase: string; tzLabel: string; loading: boolean; onViewBooked: () => void; children?: React.ReactNode }) {
  const inbound = agent.direction === "inbound";
  const o = agent as OutboundReport;
  const basis = inbound
    ? `Callers to your line ${windowPhrase}${tzLabel ? ` (${tzLabel})` : ""}`
    : `Conversations reached by call or text ${windowPhrase}${tzLabel ? ` (${tzLabel})` : ""} · Booked = bookings made ${windowPhrase}`;
  const bookedAppts = inbound ? (agent as InboundReport).bookedAppointments : o.bookedAppointments;
  const work = agent.period.work;
  const assisted = work.assistedCounted ? work.spyneAssisted ?? 0 : 0;
  // No Booked by Spyne number, no split: the row falls back to the single Booked bar.
  const split = work.bookedBySpyne !== null ? { bySpyne: work.bookedBySpyne, assisted } : undefined;
  return (
    <section className="w-full rounded-[16px] border bg-white shadow-[0_1px_3px_-1px_rgba(21,22,29,0.07)]" style={{ borderColor: BORDER }}>
      <div className="flex flex-wrap items-center gap-3 border-b border-[#f1f2f5] px-5 py-4 sm:px-6">
        <AgentAvatar name={agent.name} imageUrl={agent.imageUrl} />
        {/* min width: on a phone the rate badge wraps under the name instead of squeezing it to one word a line */}
        <div className="flex min-w-[220px] flex-1 flex-col">
          <p className="text-[16px] font-bold tracking-[-0.02em]" style={{ color: INK }}>
            {agent.name ?? (inbound ? "Inbound agent" : "Outbound agent")} <span className="text-[13px] font-medium" style={{ color: SUB }}>Service {inbound ? "Inbound" : "Outbound"}</span>
          </p>
          <p className="text-[12px]" style={{ color: SUB }}>{basis}</p>
        </div>
        <HeadlineRate rate={agent.bookingRate} formula={`${agent.period.work.assistedCounted ? "Booked (by Spyne + assisted)" : "Booked by Spyne (Spyne-assisted not available)"} ÷ ${inbound ? "connected" : "reached"}`} />
      </div>
      <div className="flex flex-col gap-4 px-5 py-5 sm:px-6">
        {agent.reason && <p className="text-[12.5px]" style={{ color: SUB }}>Not available: {agent.reason}</p>}
        <FunnelBars
          stages={agent.funnel}
          loading={loading}
          split={split}
          booked={
            !loading && bookedAppts !== null ? (
              <div className="mt-0.5 flex flex-col items-start text-[11px]" style={{ color: SUB }}>
                {work.assistedCounted
                  ? assisted > 0 && <p className="text-[12.5px] font-medium" style={{ color: INK }}><span className="font-bold tabular-nums" style={{ color: BOOKED_INK }}>+{fmtInt(assisted)}</span> assisted by Spyne</p>
                  : <span title={work.assistedReason}>assisted not available</span>}
                <button onClick={onViewBooked} className="font-semibold text-[#5b21e6] hover:underline">{fmtInt(bookedAppts)} appointments · view →</button>
              </div>
            ) : null
          }
        />
      </div>
      {/* Under the bars, as on the old report: the activity row and the call breakdown (OmSections). */}
      {!loading && children}
    </section>
  );
}

/* ══════════ appointments (= the Overview's By agent numbers) ══════════ */
export type AppointmentKind = "booked" | "assisted" | "visits";

export function AppointmentsCard({ period, direction, windowPhrase, loading, onOpen }: { period: PeriodBooked; direction: "inbound" | "outbound"; windowPhrase: string; loading: boolean; onOpen: (kind: AppointmentKind) => void }) {
  const w = period.work;
  const who = w.name ?? (direction === "inbound" ? "Your inbound agent" : "Your outbound agent");
  return (
    <section className="w-full rounded-[16px] border bg-white shadow-[0_1px_3px_-1px_rgba(21,22,29,0.07)]" style={{ borderColor: BORDER }}>
      <div className="flex flex-col gap-0.5 border-b border-[#f1f2f5] px-5 py-4 sm:px-6">
        <p className="text-[15.5px] font-bold tracking-[-0.01em]" style={{ color: INK }}>Appointments booked {windowPhrase}</p>
        <p className="text-[12.5px]" style={{ color: SUB }}>Same numbers as the Overview&apos;s By agent card. Click a number for the appointments behind it.</p>
      </div>
      <div className="grid grid-cols-1 gap-3 px-5 py-5 sm:grid-cols-[1fr_1fr_0.58fr] sm:px-6">
        <AgentStat loading={loading} value={w.bookedBySpyne} label="Booked by Spyne" sub={direction === "inbound" ? `${who} booked it on the call` : `${who} booked it on a campaign`} onClick={w.bookedBySpyne !== null ? () => onOpen("booked") : undefined} />
        <AgentStat loading={loading} outlined value={w.spyneAssisted} label="Assisted by Spyne" sub={w.spyneAssisted === null ? "Not available at this rooftop" : "Your team booked after a handoff"} title={w.spyneAssisted === null ? w.assistedReason : undefined} onClick={w.spyneAssisted !== null ? () => onOpen("assisted") : undefined} />
        <VisitsBooked loading={loading} value={w.visitsBooked} onClick={w.visitsBooked !== null ? () => onOpen("visits") : undefined} />
      </div>
    </section>
  );
}
