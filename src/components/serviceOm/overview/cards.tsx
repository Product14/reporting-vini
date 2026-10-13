"use client";

/* The Service OM Overview's cards. COPIED from components/reports/liveReplica.tsx (ServiceMetricsHeroTiles,
 * LiveUpcomingApptsCard, LiveActionItemsTableService and their helpers) so the old Overview stays exactly
 * as it is: nothing here is imported back by the old page, and editing this file cannot move it.
 * Same look and spacing as the original; what changed is the input (overviewModel.ts) and:
 *   - a number still loading shimmers, and one the API could not give says "not available", never 0 (G5);
 *   - the Appointments tile's split always adds up to its headline (an "unplaced" part when there is one);
 *   - the upcoming list tags each row the way /appointment does: AI-booked, Spyne-assisted, or the BDC's own. */

import React from "react";
import Image from "next/image";
import { fmtInt } from "@/components/reports/data";
import { fmtWhenShort } from "@/components/reports/kitV3";
import { CountUp } from "@/components/reports/anim";
import { hour12, parseReportTs, storeDayKey, storeParts } from "@/lib/reports/storeTime";
import type { ServiceOverviewModel, UpcomingRow } from "@/lib/serviceOm/overviewModel";

const C = {
  primary: "#4600f2",
  dark: "#030712",
  sub: "#626f81",
  border: "#e5e7eb",
  green: "#0a6029",
  greenBg: "#e8ffee",
  red: "#ca1f34",
  redBg: "#ffecec",
  blue: "#2f7bff",
  blueBg: "#e9f4ff",
  greyBg: "#efefef",
  violet: "#6d28d9",
  violetBg: "#f3eaff",
};
const AVATAR_COLORS = ["#006ca7", "#23ab70", "#a74600", "#a70064", "#0600a7", "#6d726b"];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}
function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % AVATAR_COLORS.length;
  return AVATAR_COLORS[h];
}

export function Anims() {
  return (
    <style>{`
      @keyframes lvFadeUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
      .lv-rise { animation: lvFadeUp .5s cubic-bezier(.16,1,.3,1) both; }
      @media (prefers-reduced-motion: reduce) { .lv-rise { animation: none; } }
    `}</style>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning 👋" : h < 18 ? "Good afternoon 👋" : "Good evening 👋";
}

/* ══════════ Hero ══════════ */
export interface HeroNav {
  onAppointments?: () => void;
  onActionItems?: () => void;
}

function apptLines(a: ServiceOverviewModel["appointments"]): string[] {
  if (a.total === null) return [a.reason ? `Not available: ${a.reason}` : "Not available"];
  const parts = [`${fmtInt(a.inbound ?? 0)} inbound`, `${fmtInt(a.outbound ?? 0)} outbound`];
  if (a.unplaced > 0) parts.push(`${fmtInt(a.unplaced)} unplaced`);
  if (a.basis === "legacy") {
    // Today's API: the headline is Booked by Spyne only, so Spyne-assisted sits beside it, as on the old page.
    if (a.spyneAssisted) parts.push(`+${fmtInt(a.spyneAssisted)} Spyne-assisted`);
    return [parts.join(" · ")];
  }
  const lines = [parts.join(" · ")];
  // Short, as on the old tile (user, 13-Oct); why assisted is missing is in the tile's tooltip.
  if (a.spyneAssisted === null) lines.push(`${fmtInt(a.bookedBySpyne ?? 0)} booked by Spyne · — Spyne-assisted`);
  else lines.push(`${fmtInt(a.bookedBySpyne ?? 0)} booked by Spyne · ${fmtInt(a.spyneAssisted)} Spyne-assisted`);
  return lines;
}

export function ServiceHero({ model, loading, nav }: { model: ServiceOverviewModel | null; loading: boolean; nav?: HeroNav }) {
  const ai = model?.actionItems;
  const appt = model?.appointments;
  const busy = loading || !model;
  type Tile = { icon: string; chipBg: string; value: number | null; label: string; lines: string[]; onClick?: () => void; title?: string };
  const tiles: Tile[] = [
    {
      icon: "/live-overview/icon-actionitems.svg",
      chipBg: "#e7f6ec",
      value: ai?.openNow ?? null,
      label: "Action Items",
      lines: ai && ai.openNow === null ? [ai.reason ? `Not available: ${ai.reason}` : "Not available"] : ["open now"],
      onClick: nav?.onActionItems,
    },
    {
      icon: "/live-overview/icon-appointments.svg",
      chipBg: "#e8f0ff",
      value: appt?.total ?? null,
      label: "Appointments",
      lines: appt ? apptLines(appt) : [""],
      onClick: nav?.onAppointments,
      title: appt?.spyneAssisted === null && appt.assistedReason ? `Spyne-assisted not available: ${appt.assistedReason}` : undefined,
    },
  ];
  return (
    <section
      className="flex flex-col items-center justify-center gap-6 rounded-lg border border-[#e5e7eb] px-4 py-6 sm:px-10"
      style={{ backgroundImage: "linear-gradient(90deg, rgba(91,109,246,0.1) 1.27%, rgba(127,106,242,0.1) 23.38%, rgba(182,81,215,0.1) 66.65%, rgba(232,62,84,0.1) 85.82%, rgba(237,137,57,0.1) 112.66%), linear-gradient(90deg, #fff, #fff)" }}
    >
      <div className="flex flex-col items-center gap-1.5">
        <Image src="/live-overview/icon-sparkle.svg" alt="" width={18} height={18} />
        <p className="text-[14px] text-[#030712]">{greeting()}</p>
        <p className="text-center text-[18px] font-bold tracking-[-0.01em] text-[#030712] sm:text-[22px]">Here’s what your Service AI agents handled</p>
      </div>
      <div className="flex w-full flex-wrap items-stretch overflow-hidden rounded-xl border border-[#e5e7eb] bg-white">
        {tiles.map((t, i) => {
          const cell = (
            <>
              <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg" style={{ background: t.chipBg }}>
                <Image src={t.icon} alt="" width={18} height={18} />
              </span>
              <div className="flex flex-col gap-1">
                {busy ? (
                  <span className="block h-[22px] w-[150px] animate-pulse rounded bg-[#e6e8ec]" />
                ) : (
                  <p className="flex items-center gap-1 text-[18px] font-bold leading-[22px] text-[#030712]">
                    {t.value === null ? "—" : <CountUp value={t.value} />} {t.label}
                    {t.onClick && <span className="text-[14px] text-[#b4a1e8] transition-transform group-hover:translate-x-0.5">→</span>}
                  </p>
                )}
                {busy ? (
                  <span className="block h-[14px] w-[120px] animate-pulse rounded bg-[#eef0f3]" />
                ) : (
                  t.lines.map((l, j) => <p key={j} className="text-[12px] text-[#626f81]">{l}</p>)
                )}
              </div>
            </>
          );
          const base = `flex flex-1 basis-[210px] items-start gap-3 px-6 py-5 ${i > 0 ? "border-l border-[#e5e7eb]" : ""}`;
          return t.onClick && !busy
            ? <button key={t.label} onClick={t.onClick} title={t.title} className={`group ${base} text-left transition-colors hover:bg-[#faf8ff]`}>{cell}</button>
            : <div key={t.label} title={t.title} className={base}>{cell}</div>;
        })}
      </div>
    </section>
  );
}

/* ══════════ Upcoming appointments ══════════ */
const DOW_UC = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
const MON_UC = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
function apptDayHeading(iso: string, tz?: string | null): string {
  const p = storeParts(iso, tz);
  return p ? `${DOW_UC[p.dow]}, ${MON_UC[p.mon]} ${p.day}` : "";
}
function apptTime(iso: string, tz?: string | null): string {
  const p = storeParts(iso, tz);
  if (!p) return "—";
  const { h, ap } = hour12(p.h24);
  return `${String(h).padStart(2, "0")}:${String(p.min).padStart(2, "0")} ${ap}`;
}
const APPT_ROWS_SHOWN = 5;

export function UpcomingAppointmentsCard({ upcoming, tz, loading, onViewAll }: { upcoming: ServiceOverviewModel["upcoming"] | null; tz?: string | null; loading: boolean; onViewAll: () => void }) {
  const groups = React.useMemo(() => {
    // Rows arrive upcoming already (the API's list); sorted on the instant and grouped by store-local day.
    const rows = (upcoming?.rows ?? [])
      .map((a) => ({ a, key: a.when ? storeDayKey(a.when, tz) : "", at: parseReportTs(a.when)?.getTime() ?? Number.POSITIVE_INFINITY }))
      .sort((x, y) => x.at - y.at);
    const out: { key: string; label: string; rows: UpcomingRow[] }[] = [];
    for (const { a, key } of rows) {
      const last = out[out.length - 1];
      if (last && last.key === key) last.rows.push(a);
      else out.push({ key, label: a.when ? apptDayHeading(a.when, tz) : "", rows: [a] });
    }
    let budget = APPT_ROWS_SHOWN;
    const shown: typeof out = [];
    for (const g of out) {
      if (budget <= 0) break;
      shown.push({ ...g, rows: g.rows.slice(0, budget) });
      budget -= Math.min(budget, g.rows.length);
    }
    return shown;
  }, [upcoming, tz]);
  const total = upcoming?.count ?? null;

  return (
    <div className="flex min-h-[460px] flex-1 basis-0 flex-col justify-between rounded-[10px] border border-[#e5e7eb] bg-white">
      <div className="flex w-full flex-col">
        <div className="flex w-full flex-col gap-1 border-b border-[#e5e7eb] px-5 py-[15px]">
          <p className="text-[15px] font-bold text-[#030712]">Upcoming appointments</p>
          <p className="text-[12.5px] text-[#626f81]">Next on the books, soonest first</p>
        </div>
        {loading && !upcoming ? (
          <div className="flex flex-col gap-3 px-5 py-5">
            {[0, 1, 2].map((i) => <span key={i} className="block h-[38px] w-full animate-pulse rounded bg-[#f1f2f4]" />)}
          </div>
        ) : upcoming?.reason ? (
          <p className="px-5 py-6 text-[12.5px] text-[#626f81]">Not available: {upcoming.reason}</p>
        ) : groups.length === 0 ? (
          <p className="px-5 py-6 text-[12.5px] text-[#626f81]">No upcoming appointments on the books. Ones your AI books from here will appear at the top.</p>
        ) : (
          groups.map((g) => (
            <React.Fragment key={g.key}>
              <div className="w-full bg-[#f7f8fa] px-5 py-2">
                <p className="text-[11px] font-bold uppercase tracking-wide text-[#6b7280]">{g.label}</p>
              </div>
              {g.rows.map((a) => (
                <div key={a.id} className="flex w-full items-center gap-4 border-b border-[#f0f1f4] px-5 py-3">
                  <p className="w-[74px] flex-none text-[12.5px] font-medium text-[#535353]">{a.when ? apptTime(a.when, tz) : "—"}</p>
                  <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full text-[11.5px] font-bold text-white" style={{ background: avatarColor(a.customer) }} aria-hidden>
                    {initials(a.customer)}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <p className="truncate text-[13.5px] font-semibold text-[#030712]">{a.customer}</p>
                    <p className="truncate text-[12px] text-[#626f81]">{a.vehicle || a.services || "appointment"}</p>
                  </div>
                  <span className="flex-none rounded-full px-2.5 py-1 text-[11px] font-semibold" style={BADGE[a.kind].style}>
                    {BADGE[a.kind].label}
                  </span>
                </div>
              ))}
            </React.Fragment>
          ))
        )}
      </div>
      <div className="flex w-full items-center justify-between border-t border-[#e5e7eb] px-5 py-[15px]">
        <p className="text-[12px] text-[#626f81]">{total === null ? "" : `${fmtInt(total)} upcoming`}</p>
        <button onClick={onViewAll} className="text-[12px] font-medium" style={{ color: C.primary }}>View all →</button>
      </div>
    </div>
  );
}

/** The three appointment types (B1), as the upcoming list tags them. */
export const BADGE: Record<UpcomingRow["kind"], { label: string; style: React.CSSProperties }> = {
  booked: { label: "AI-booked", style: { background: C.greenBg, color: C.green } },
  assisted: { label: "Spyne-assisted", style: { background: C.violetBg, color: C.violet } },
  dealer: { label: "BDC", style: { background: C.greyBg, color: C.sub } },
};

/* ══════════ Action items ══════════ */
function TableTabs({ tabs, active, onPick }: { tabs: { key: string; label: string; count?: number }[]; active: string; onPick: (k: string) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      {tabs.map((t) => {
        const on = t.key === active;
        return (
          <button
            key={t.key}
            onClick={() => onPick(t.key)}
            className="rounded-full px-3 py-1 text-[12px] font-medium transition-colors"
            style={on ? { background: C.primary, color: "#fff" } : { background: C.greyBg, color: C.sub }}
          >
            {t.label}{t.count != null ? ` (${fmtInt(t.count)})` : ""}
          </button>
        );
      })}
    </div>
  );
}

const ACTION_ROWS_SHOWN = 5;

export function ActionItemsTable({ actionItems, loading, onViewAll }: { actionItems: ServiceOverviewModel["actionItems"] | null; loading: boolean; onViewAll: () => void }) {
  const [tab, setTab] = React.useState<"open" | "pastSla">("open");
  const all = actionItems?.rows ?? [];
  // The tab counts are the API's live metrics; the rows are its first page, so a tab can list fewer rows
  // than its count (same "live count + short sample" the old page and the new design use).
  const rows = (tab === "pastSla" ? all.filter((r) => r.isLate) : all).slice(0, ACTION_ROWS_SHOWN);
  const tabs = [
    { key: "open", label: "Open", count: actionItems?.openNow ?? undefined },
    { key: "pastSla", label: "Past SLA", count: actionItems?.pastSla ?? undefined },
  ];
  return (
    <div className="flex w-full flex-col items-start gap-[15px] rounded-[10px] border border-[#e5e7eb] bg-white">
      <div className="flex min-h-[60px] w-full flex-wrap items-center justify-between gap-3 border-b border-[#e5e7eb] px-5 py-[15px]">
        <p className="text-[14px] font-semibold uppercase text-[#030712]">📝 Action items</p>
        <TableTabs tabs={tabs} active={tab} onPick={(k) => setTab(k as "open" | "pastSla")} />
      </div>
      {loading && !actionItems ? (
        <div className="flex w-full flex-col gap-3 px-5 pb-5">
          {[0, 1, 2].map((i) => <span key={i} className="block h-[36px] w-full animate-pulse rounded bg-[#f1f2f4]" />)}
        </div>
      ) : actionItems?.reason && actionItems.openNow === null ? (
        <p className="px-5 pb-5 text-[12.5px] text-[#626f81]">Not available: {actionItems.reason}</p>
      ) : rows.length === 0 ? (
        <p className="px-5 pb-5 text-[12.5px] text-[#626f81]">No action items in this view.</p>
      ) : (
        <div className="w-full overflow-x-auto px-[15px]">
          <table className="w-full min-w-[640px] border-collapse text-[14px]">
            <thead>
              <tr className="text-left text-[#626f81]">
                <th className="border-b border-[#e5e7eb] p-[15px] font-medium">Customer</th>
                <th className="border-b border-[#e5e7eb] p-[15px] font-medium">What to do?</th>
                <th className="border-b border-[#e5e7eb] p-[15px] font-medium">Due Date</th>
                <th className="border-b border-[#e5e7eb] p-[15px] text-center font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td className="border-b border-[#e5e7eb] p-[15px]">
                    <div className="flex items-center gap-2">
                      <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full text-[11px] font-medium text-white" style={{ background: avatarColor(a.customer) }}>{initials(a.customer)}</span>
                      <span className="whitespace-nowrap text-[#030712]">{a.customer}</span>
                    </div>
                  </td>
                  <td className="max-w-[320px] border-b border-[#e5e7eb] p-[15px] text-[#030712]">{a.what}</td>
                  <td className="whitespace-nowrap border-b border-[#e5e7eb] p-[15px] text-[#030712]">{a.due ? fmtWhenShort(a.due).split(" · ")[0] : ""}</td>
                  <td className="border-b border-[#e5e7eb] p-[15px] text-center">
                    <span className="whitespace-nowrap rounded px-[15px] py-1 text-[12px] font-medium" style={a.isLate ? { background: C.redBg, color: C.red } : { background: C.blueBg, color: C.blue }}>{a.isLate ? "Past SLA" : "Open"}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex w-full items-center justify-between border-t border-[#e5e7eb] px-5 py-[15px]">
        <p className="text-[12px] text-[#626f81]">{actionItems?.openNow != null ? `${fmtInt(actionItems.openNow)} open now${actionItems.dueToday != null ? ` · ${fmtInt(actionItems.dueToday)} due today` : ""}` : ""}</p>
        <button onClick={onViewAll} className="text-[12px] font-medium" style={{ color: C.primary }}>View All Action Items →</button>
      </div>
    </div>
  );
}

/* ══════════ By agent ══════════
 * Per agent: Booked by Spyne, Assisted by Spyne and the visits that adds up to (a visit = one appointment,
 * G3). Layout from Sumit's new-design card (overview repo, agent-work-card.tsx) as redrawn in the
 * "By agent · Booked and assisted by Spyne" design. The stats row beside each agent's name (reached you,
 * wanted service…) needs the /contact numbers and is left out until they're on the page. */
const AGENT_INK = "#15161d";
const AGENT_SUB = "#667085";
const AGENT_NUM = "#3b12c9";

export function AgentAvatar({ name, imageUrl }: { name: string | null; imageUrl: string | null }) {
  const size = 46;
  return imageUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={imageUrl} alt={name ?? ""} className="flex-none rounded-full bg-[#f1f2f5] object-cover object-top ring-[3px] ring-white shadow-[0_0_0_1px_#eceef2]" style={{ width: size, height: size }} />
  ) : (
    <span className="flex flex-none items-center justify-center rounded-full bg-[#f1f0fb] text-[16px] font-bold text-[#5b21e6] ring-[3px] ring-white shadow-[0_0_0_1px_#eceef2]" style={{ width: size, height: size }} aria-hidden>
      {(name?.trim().charAt(0) || "?").toUpperCase()}
    </span>
  );
}

/** With `onClick` (Reports) the card opens the rows behind its number; without it (Overview) it's static. */
export function AgentStat({ value, label, sub, outlined, loading, onClick, title }: { value: number | null; label: string; sub: string; outlined?: boolean; loading: boolean; onClick?: () => void; title?: string }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      onClick={onClick}
      title={title}
      className={`group flex min-h-[104px] flex-col justify-center gap-1 rounded-[14px] px-5 py-4 text-left ${outlined ? "border border-[#ebe7f8] bg-[#faf9ff]" : "bg-[#f3f0ff]"} ${onClick ? "transition-shadow hover:shadow-[0_0_0_2px_#d9ccfb]" : ""}`}
    >
      {loading ? (
        <span className="block h-[30px] w-[64px] animate-pulse rounded bg-[#e4dffa]" />
      ) : (
        <p className="text-[30px] font-extrabold leading-none tracking-[-0.03em] tabular-nums" style={{ color: AGENT_NUM }}>
          {value === null ? "—" : <CountUp value={value} />}
        </p>
      )}
      <p className="mt-1.5 text-[14.5px] font-semibold" style={{ color: AGENT_INK }}>{label}{onClick && <span className="ml-1 text-[#b4a1e8] transition-transform group-hover:translate-x-0.5">→</span>}</p>
      <p className="text-[13px]" style={{ color: AGENT_SUB }}>{sub}</p>
    </Tag>
  );
}

export function VisitsBooked({ value, loading, onClick }: { value: number | null; loading: boolean; onClick?: () => void }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag onClick={onClick} className={`flex min-h-[104px] flex-col items-center justify-center gap-1 rounded-[14px] bg-gradient-to-br from-[#5b21e6] to-[#7c4dff] px-5 py-4 text-white shadow-[0_14px_28px_-14px_rgba(91,33,230,0.6)] ${onClick ? "transition-transform hover:-translate-y-0.5" : ""}`}>
      {loading ? (
        <span className="block h-[34px] w-[72px] animate-pulse rounded bg-white/30" />
      ) : (
        <p className="text-[36px] font-extrabold leading-none tracking-[-0.03em] tabular-nums">{value === null ? "—" : <CountUp value={value} />}</p>
      )}
      <p className="text-[14px] font-semibold">visits booked{onClick ? " →" : ""}</p>
    </Tag>
  );
}

export function ByAgentCard({ agents, unplaced, loading }: { agents: ServiceOverviewModel["agents"] | null; unplaced: number; loading: boolean }) {
  const rows = agents?.rows ?? [];
  const busy = loading && !agents;
  if (!busy && rows.length === 0 && !agents?.reason) return null; // a rooftop with no Service agent: nothing to break down
  return (
    <section className="w-full rounded-[16px] border border-[#eceef2] bg-white shadow-[0_1px_3px_-1px_rgba(21,22,29,0.07)]">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-[#f1f2f5] px-5 py-4 sm:px-6">
        <p className="text-[17px] font-bold tracking-[-0.02em]" style={{ color: AGENT_INK }}>By agent</p>
        <p className="text-[13.5px]" style={{ color: AGENT_SUB }}>Booked and assisted by Spyne</p>
      </div>
      {agents?.reason && rows.length === 0 ? (
        <p className="px-6 py-5 text-[12.5px]" style={{ color: AGENT_SUB }}>Not available: {agents.reason}</p>
      ) : busy ? (
        <div className="flex flex-col gap-3 px-6 py-5">
          {[0, 1].map((i) => <span key={i} className="block h-[150px] w-full animate-pulse rounded-[14px] bg-[#f5f4fb]" />)}
        </div>
      ) : (
        rows.map((a, i) => {
          const inbound = a.direction === "inbound";
          const who = a.name ?? (inbound ? "Your inbound agent" : "Your outbound agent");
          return (
            <div key={a.key} className={`flex flex-col gap-4 px-5 py-5 sm:px-6 ${i > 0 ? "border-t border-[#f1f2f5]" : ""}`}>
              <div className="flex items-center gap-3.5">
                <AgentAvatar name={a.name} imageUrl={a.imageUrl} />
                <div className="flex flex-col">
                  <p className="text-[16.5px] font-bold tracking-[-0.02em]" style={{ color: AGENT_INK }}>{inbound ? "Inbound agent" : "Outbound agent"}</p>
                  {a.name && <p className="text-[13.5px]" style={{ color: AGENT_SUB }}>{a.name}</p>}
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_0.58fr]">
                <AgentStat loading={loading} value={a.bookedBySpyne} label="Booked by Spyne" sub={inbound ? `${who} booked it on the call` : `${who} booked it on a campaign`} />
                <AgentStat loading={loading} outlined value={a.spyneAssisted} label="Assisted by Spyne" sub={a.spyneAssisted === null ? "Not available at this rooftop" : "Your team booked after a handoff"} title={a.spyneAssisted === null ? a.assistedReason : undefined} />
                <VisitsBooked loading={loading} value={a.visitsBooked} />
              </div>
            </div>
          );
        })
      )}
      {!busy && unplaced > 0 && rows.length > 0 && (
        <p className="border-t border-[#f1f2f5] px-6 py-3 text-[12px]" style={{ color: AGENT_SUB }}>
          Plus {fmtInt(unplaced)} {unplaced === 1 ? "appointment" : "appointments"} Spyne booked that {unplaced === 1 ? "isn't" : "aren't"} tied to either agent, counted in the Appointments total above.
        </p>
      )}
    </section>
  );
}
