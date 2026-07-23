"use client";

/* v3 reporting-tab components — the live, per-rooftop productization of the hand-built dealer
 * scorecard (value tiles with IB/OB splits, per-agent funnel cards, named appointments, named warm
 * leads, ranked outcome tables). Same visual language as kit.tsx: white rounded-2xl cards, purple
 * #813fed accent, green for booked, tiny uppercase labels, tabular numerals. NO chart library. */

import React from "react";
import { fmtInt, type IntentOutcomeRow, type NamedAppt, type OutcomeSlice, type WarmLeadItem } from "./data";
import type { ActionItem, ActionItemStats, ActionItemCloser, Conversation } from "./liveData";
import { FunnelBars, Td, Th } from "./kit";
import { track } from "@/lib/analytics";

/* Display label for an action-item assignee. Every rooftop we've seen auto-creates + auto-resolves via
 * the AI (assigned_to='SYSTEM'), so that reads as "Vini AI"; a small number of rooftops assign to CRM
 * user ids (opaque) — shown as "Team member". Blank → "Unassigned". */
export function closerLabel(assignedTo: string | null | undefined): string {
  const v = (assignedTo || "").trim();
  if (!v) return "Unassigned";
  if (v.toUpperCase() === "SYSTEM") return "Vini AI";
  return v.length > 24 ? `${v.slice(0, 22)}…` : v;
}

/* ── canonical rate display ─────────────────────────────────────────────────
 * Never headline a rounded "0%": when the numerator is real but the rounded % is 0, show the
 * fraction instead (canonical rule, e.g. close rate "1/32"). No denominator → "—". */
export function fmtRate(numer: number, denom: number): string {
  if (!denom || denom <= 0) return "—";
  const pct = Math.round((100 * numer) / denom);
  if (numer > 0 && pct === 0) return `${fmtInt(numer)}/${fmtInt(denom)}`;
  return `${pct}%`;
}

/* Minutes → compact duration ("38m", "12h 24m"). */
export function fmtDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

/* Seconds → compact response-time label ("42s", "3m 20s", "1h 5m"). null → "—". */
export function fmtSecs(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) { const r = s % 60; return r ? `${m}m ${r}s` : `${m}m`; }
  const h = Math.floor(m / 60), rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

/* ISO timestamp → "Jul 7 · 2:30 PM" (UTC fields — timestamps arrive store-local-ish from the source;
 * consistent with the rest of the report's labels). */
export function fmtWhenShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  if (!Number.isFinite(d.getTime())) return "—";
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  let h = d.getUTCHours();
  const m = d.getUTCMinutes().toString().padStart(2, "0");
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${mon} ${d.getUTCDate()} · ${h}:${m} ${ap}`;
}

const ACCENTS = {
  purple: "#813fed",
  violet: "#6c5ce7",
  green: "#10b981",
  blue: "#2563eb",
  orange: "#ea760c",
  gray: "#9ca3af",
} as const;
export type TileAccent = keyof typeof ACCENTS;

/* ── "The value delivered" hero tile: Total + Inbound/Outbound tri-split + delta vs prior ── */
export function ValueTile({
  label,
  total,
  inbound,
  outbound,
  delta,
  subtext,
  accent = "purple",
  onClick,
}: {
  label: string;
  total: string;
  inbound?: string;
  outbound?: string;
  delta?: number | null; // null = no prior basis ("New"); undefined = don't show a delta at all
  subtext?: React.ReactNode;
  accent?: TileAccent;
  onClick?: () => void;
}) {
  const color = ACCENTS[accent];
  const body = (
    <>
      <p className="text-[10px] font-bold uppercase tracking-wider text-[#6b7280] leading-tight min-h-[26px]">{label}</p>
      <div className="flex items-baseline gap-2">
        <p className="text-[32px] font-extrabold tabular-nums leading-none" style={{ color }}>{total}</p>
        {delta === null && total !== "0" && <span className="text-[9.5px] font-semibold text-[#9ca3af]">New</span>}
        {typeof delta === "number" && (
          delta === 0
            ? <span className="text-[9.5px] font-semibold text-[#9ca3af]">0% vs prior</span>
            : <span className="text-[9.5px] font-semibold" style={{ color: delta > 0 ? "#16a34a" : "#dc2626" }}>{delta > 0 ? "▲" : "▼"} {Math.abs(delta)}%</span>
        )}
      </div>
      {(inbound !== undefined || outbound !== undefined) && (
        <div className="mt-1.5 flex flex-col gap-0.5">
          {inbound !== undefined && (
            <div className="flex items-baseline justify-between text-[10.5px] font-semibold text-[#6b7280]">
              <span>Inbound</span><span className="tabular-nums font-bold text-[#111]">{inbound}</span>
            </div>
          )}
          {outbound !== undefined && (
            <div className="flex items-baseline justify-between text-[10.5px] font-semibold text-[#6b7280]">
              <span>Outbound</span><span className="tabular-nums font-bold text-[#111]">{outbound}</span>
            </div>
          )}
        </div>
      )}
      {subtext && <div className="mt-2 border-t border-dashed border-[#e5e7eb] pt-1.5 text-[10px] leading-snug text-[#9ca3af]">{subtext}</div>}
    </>
  );
  const cls = "print-card flex flex-col rounded-2xl border border-[#e5e7eb] bg-white px-4 py-3.5 shadow-sm text-left";
  return onClick ? (
    <button onClick={onClick} className={`${cls} transition-shadow hover:shadow-md cursor-pointer`} style={{ borderTop: `3px solid ${color}` }}>
      {body}
    </button>
  ) : (
    <div className={cls} style={{ borderTop: `3px solid ${color}` }}>{body}</div>
  );
}

/* ── compact SECONDARY metric tile (operational quality row under the MAIN value tiles). Lighter than
 *    ValueTile: no IB/OB tri-split, smaller number, single-line sub. Optional accent + click-through. ── */
export function MetricTile({
  label,
  value,
  sub,
  accent = "#813fed",
  onClick,
  title,
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
  accent?: string;
  onClick?: () => void;
  title?: string;
}) {
  const body = (
    <>
      <p className="text-[9.5px] font-bold uppercase tracking-wider text-[#6b7280] leading-tight min-h-[22px]">{label}</p>
      <p className="mt-0.5 text-[26px] font-extrabold tabular-nums leading-none" style={{ color: accent }}>{value}</p>
      {sub && <p className="mt-1.5 text-[10px] leading-snug text-[#9ca3af]">{sub}</p>}
    </>
  );
  const cls = "print-card flex flex-col rounded-xl border border-[#e5e7eb] bg-white px-3.5 py-3 shadow-sm text-left";
  return onClick ? (
    <button onClick={onClick} title={title} className={`${cls} transition-shadow hover:shadow-md cursor-pointer`}>{body}</button>
  ) : (
    <div className={cls} title={title}>{body}</div>
  );
}

/* ── per-agent funnel card ("Who drove it") ── */
export function AgentFunnelCard({
  icon,
  name,
  role,
  closeRateLabel,
  closeRateSub,
  stages,
  assisted,
  ministats,
  onClick,
}: {
  icon: string;
  name: string;
  role: string;
  closeRateLabel: string; // fmtRate(appts, qualified)
  closeRateSub: string; // "1 of 23 qualified"
  stages: { label: string; value: number }[];
  assisted?: number;
  ministats: { calls: number; sms: number; talkMinutes: number; handoffs: number };
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="print-card flex flex-col rounded-2xl border border-[#e5e7eb] bg-white px-5 py-4 text-left shadow-sm transition-shadow hover:shadow-md"
    >
      <div className="mb-3 flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#f4effe] text-[18px]">{icon}</div>
        <div className="min-w-0">
          <p className="truncate text-[14.5px] font-bold text-[#111]">{name}</p>
          <p className="text-[11px] text-[#6b7280]">{role}</p>
        </div>
        <div className="ml-auto text-right">
          <p className="text-[9px] font-bold uppercase tracking-wider text-[#9ca3af]">Close rate</p>
          <p className="text-[24px] font-extrabold tabular-nums leading-tight text-[#6d28d9]">{closeRateLabel}</p>
          <p className="text-[9.5px] text-[#9ca3af]">{closeRateSub}</p>
        </div>
      </div>
      <FunnelBars stages={stages} />
      {assisted ? (
        <p className="mt-1.5 text-[10.5px] font-semibold text-[#059669]">+{assisted} AI-assisted (CRM) — booked in your CRM on leads this agent worked</p>
      ) : null}
      <div className="mt-3 grid grid-cols-4 gap-2 border-t border-dashed border-[#e5e7eb] pt-2.5">
        {([
          ["Calls", fmtInt(ministats.calls)],
          ["SMS sent", fmtInt(ministats.sms)],
          ["Talk time", fmtDuration(ministats.talkMinutes)],
          ["Hand-offs", fmtInt(ministats.handoffs)],
        ] as const).map(([k, v]) => (
          <div key={k}>
            <p className="text-[18px] font-extrabold tabular-nums leading-none text-[#111]">{v}</p>
            <p className="mt-1 text-[9px] font-bold uppercase tracking-wide text-[#9ca3af]">{k}</p>
          </div>
        ))}
      </div>
    </button>
  );
}

/* ── action-items scoreboard (Overview summary + Action items page header). created/closed are for the
 *    selected window; open/overdue/due-today are current state. `closers` = who resolved the most. ── */
export function ActionItemsScoreboard({
  stats,
  periodLabel,
  onOpenAll,
}: {
  stats: ActionItemStats;
  closers?: ActionItemCloser[]; // accepted for back-compat; the "closed most" leaderboard is no longer shown (it's ~always the AI)
  periodLabel?: string;
  onOpenAll?: () => void;
}) {
  const cells: { label: string; value: number; accent: string; hint?: string }[] = [
    { label: "Created", value: stats.created, accent: "#813fed", hint: periodLabel ? `in ${periodLabel}` : "in period" },
    { label: "Closed", value: stats.completed, accent: "#059669", hint: periodLabel ? `in ${periodLabel}` : "in period" },
    { label: "Open now", value: stats.open, accent: "#2563eb" },
    { label: "Overdue", value: stats.overdue, accent: "#dc2626" },
    { label: "Due today", value: stats.dueToday, accent: "#ea760c" },
  ];
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
        {cells.map((c) => (
          <div key={c.label} className="rounded-xl border border-[#f0f0f0] bg-[#fafafa] px-3.5 py-3">
            <p className="text-[24px] font-extrabold tabular-nums leading-none" style={{ color: c.accent }}>{fmtInt(c.value)}</p>
            <p className="mt-1 text-[9.5px] font-bold uppercase tracking-wide text-[#6b7280]">{c.label}</p>
            {c.hint && <p className="text-[9px] text-[#b0b0b0]">{c.hint}</p>}
          </div>
        ))}
      </div>
      {onOpenAll && (
        <button onClick={onOpenAll} className="self-start text-[11.5px] font-semibold text-[#813fed] hover:underline">
          View all action items →
        </button>
      )}
    </div>
  );
}

/* ── rich action-item list (same read as the Action items tab: customer, what-to-do, priority pill,
 *    dept, due w/ overdue color, status) — reusable on the Overview div + anywhere else. ── */
export function AiPriorityPill({ priority }: { priority: string }) {
  const p = (priority || "").toUpperCase();
  if (!p) return <span className="text-[#d1d5db]">—</span>;
  const s = p === "HIGH" ? { bg: "#fdecec", fg: "#dc2626" } : p === "LOW" ? { bg: "#f3f4f6", fg: "#6b7280" } : { bg: "#fef3e6", fg: "#c2410c" };
  return <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ background: s.bg, color: s.fg }}>{p.charAt(0) + p.slice(1).toLowerCase()}</span>;
}
export function prettyActionIntent(raw: string): string {
  if (!raw) return "Follow up";
  const s = raw.replace(/_/g, " ").trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
export function ActionItemList({ items, max = 6, moreHref, onMore }: { items: ActionItem[]; max?: number; moreHref?: string; onMore?: () => void }) {
  if (!items.length) return <p className="px-1 py-2 text-[12.5px] text-[#6b7280]">No open action items right now.</p>;
  const now = Date.now();
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse text-[12.5px]">
        <thead>
          <tr>
            <Th>Customer</Th>
            <Th>What to do</Th>
            <Th>Priority</Th>
            <Th>Due</Th>
            <Th>Status</Th>
          </tr>
        </thead>
        <tbody>
          {items.slice(0, max).map((a) => {
            const overdue = !a.completed && !!a.dueAt && new Date(a.dueAt).getTime() < now;
            return (
              <tr key={a.id} className="border-t border-[#f0f0f0] align-top">
                <Td>
                  <span className="font-semibold text-[#111]">{a.customer || "—"}</span>
                  {a.phone && <a href={`tel:${a.phone}`} className="ml-2 text-[11px] tabular-nums text-[#6b7280] underline decoration-dotted underline-offset-2" onClick={(e) => e.stopPropagation()}>{a.phone}</a>}
                </Td>
                <Td>
                  <span className="text-[#374151]">{a.description || prettyActionIntent(a.intent)}</span>
                  {a.dept !== "other" && <span className="ml-1.5 text-[10px] capitalize text-[#9ca3af]">· {a.dept}</span>}
                </Td>
                <Td><AiPriorityPill priority={a.priority} /></Td>
                <Td><span className={overdue ? "whitespace-nowrap font-semibold text-[#dc2626]" : "whitespace-nowrap text-[#6b7280]"}>{a.dueAt ? fmtWhenShort(a.dueAt) : "—"}</span></Td>
                <Td>
                  {a.completed
                    ? <span className="font-semibold text-[#059669]">Closed</span>
                    : overdue
                      ? <span className="font-semibold text-[#dc2626]">Overdue</span>
                      : <span className="font-semibold text-[#2563eb]">Open</span>}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {items.length > max && (onMore || moreHref) && (
        <button onClick={onMore} className="mt-2 text-[11px] font-semibold text-[#9ca3af] hover:text-[#813fed]">
          +{items.length - max} more on the Action items tab →
        </button>
      )}
    </div>
  );
}

/* ── named appointments table ── */
const STATUS_STYLE: Record<string, { label: string; color: string }> = {
  scheduled: { label: "Scheduled", color: "#2563eb" },
  completed: { label: "Completed", color: "#059669" },
  show: { label: "Showed", color: "#059669" },
  noshow: { label: "No-show", color: "#d97706" },
  no_show: { label: "No-show", color: "#d97706" },
  cancelled: { label: "Cancelled", color: "#9ca3af" },
};
export function NamedApptsTable({ items, teamId }: { items: NamedAppt[]; teamId?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse text-[12.5px]">
        <thead>
          <tr>
            <Th>Customer</Th>
            <Th>Channel</Th>
            <Th>How booked</Th>
            <Th>When</Th>
            <Th>Status</Th>
          </tr>
        </thead>
        <tbody>
          {items.map((a, i) => {
            const st = STATUS_STYLE[a.status?.toLowerCase?.() ?? ""] ?? (a.status ? { label: a.status, color: "#6b7280" } : { label: "—", color: "#9ca3af" });
            return (
              <tr
                key={`${a.customer}-${a.bookedAt}-${i}`}
                className="border-t border-[#f0f0f0]"
                onClick={() => track("named_appointment_row_clicked", { team_id: teamId ?? "", assisted: a.assisted })}
              >
                <Td>
                  <span className="font-semibold text-[#111]">{a.customer}</span>
                  {a.vehicle && <span className="ml-2 text-[11px] text-[#6b7280]">{a.vehicle}</span>}
                </Td>
                <Td>{a.channel ?? "—"}</Td>
                <Td>
                  <span className="font-medium" style={{ color: a.assisted ? "#6d28d9" : "#059669" }}>{a.how}</span>
                </Td>
                <Td>{fmtWhenShort(a.when)}</Td>
                <Td><span className="font-semibold" style={{ color: st.color }}>{st.label}</span></Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ── named warm leads ("Work these now") ── */
function WarmChip({ lead, teamId }: { lead: WarmLeadItem; teamId?: string }) {
  const hot = lead.tier === "hot";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11.5px]"
      style={hot ? { borderColor: "#eecac3", background: "#fdf0ed" } : { borderColor: "#f3ddc2", background: "#fdf3e6" }}
    >
      <b className="font-bold text-[#111]">{lead.customer}</b>
      {lead.interest && <span className="text-[#6b7280]">· {lead.interest}</span>}
      {lead.phone && (
        <a
          href={`tel:${lead.phone}`}
          className="tabular-nums font-semibold text-[#374151] underline decoration-dotted underline-offset-2"
          onClick={(e) => { e.stopPropagation(); track("warm_lead_phone_clicked", { team_id: teamId ?? "", tier: lead.tier }); }}
        >
          {lead.phone}
        </a>
      )}
    </span>
  );
}
export function WarmLeadChips({ items, teamId, maxHot = 14, maxWarm = 10 }: { items: WarmLeadItem[]; teamId?: string; maxHot?: number; maxWarm?: number }) {
  const hot = items.filter((w) => w.tier === "hot");
  const warm = items.filter((w) => w.tier === "warm");
  return (
    <div className="flex flex-col gap-3">
      {hot.length > 0 && (
        <div>
          <p className="mb-1.5 text-[10.5px] font-extrabold uppercase tracking-wide text-[#c2410c]">🔥 Hottest · concrete buying signal</p>
          <div className="flex flex-wrap gap-1.5">
            {hot.slice(0, maxHot).map((w, i) => <WarmChip key={`${w.customer}-${i}`} lead={w} teamId={teamId} />)}
            {hot.length > maxHot && <span className="self-center text-[11px] font-semibold text-[#9ca3af]">+{hot.length - maxHot} more</span>}
          </div>
        </div>
      )}
      {warm.length > 0 && (
        <div>
          <p className="mb-1.5 text-[10.5px] font-extrabold uppercase tracking-wide text-[#b45309]">🟡 Warm · engaged, nurture</p>
          <div className="flex flex-wrap gap-1.5">
            {warm.slice(0, maxWarm).map((w, i) => <WarmChip key={`${w.customer}-${i}`} lead={w} teamId={teamId} />)}
            {warm.length > maxWarm && <span className="self-center text-[11px] font-semibold text-[#9ca3af]">+{warm.length - maxWarm} more</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── ranked outbound outcomes (canonical best→least order, ties to worked leads) ── */
// Canonical display order for the outcome buckets (best outcome first). Raw sort-prefixed bucket ids
// from detailQueries.ts outcomesSql; unknown buckets sort after, by volume.
export const OUTCOME_ORDER = [
  "5 Booked", "11 Already booked (not AI)", "3 Warm", "6 Callback", "7 Transferred", "4 Engaged",
  "9 Unclear / info", "0 Not yet worked", "1 No reach", "8 Lost / declined", "2 Opt out", "10 Other",
];
const OUTCOME_DETAIL: Record<string, string> = {
  "5 Booked": "appointment on the books",
  "11 Already booked (not AI)": "customer self-booked or already scheduled — not AI-booked",
  "3 Warm": "buying intent, not yet booked — work these now",
  "6 Callback": "asked for a return call",
  "7 Transferred": "handed to your team",
  "4 Engaged": "replied, no buying intent yet",
  "9 Unclear / info": "info shared / unclear ending",
  "0 Not yet worked": "queued — not yet contacted",
  "1 No reach": "bad number / never connected",
  "8 Lost / declined": "declined or already bought — aged-list reality",
  "2 Opt out": "asked to stop contact",
};
const OUTCOME_COLOR: Record<string, string> = {
  "5 Booked": "#059669", "3 Warm": "#c2410c", "6 Callback": "#6d28d9", "7 Transferred": "#2563eb",
};
export function RankedOutcomeTable({ slices }: { slices: OutcomeSlice[] }) {
  const total = slices.reduce((s, o) => s + o.value, 0) || 1;
  const rows = [...slices].sort((a, b) => {
    const ia = a.bucket ? OUTCOME_ORDER.indexOf(a.bucket) : -1;
    const ib = b.bucket ? OUTCOME_ORDER.indexOf(b.bucket) : -1;
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return b.value - a.value;
  });
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[480px] border-collapse text-[12.5px]">
        <thead>
          <tr>
            <Th>Outcome</Th>
            <Th align="right">Leads</Th>
            <Th align="right">Share</Th>
            <Th>Detail</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.bucket ?? o.label} className="border-t border-[#f0f0f0]">
              <Td>
                <span className="font-semibold" style={{ color: (o.bucket && OUTCOME_COLOR[o.bucket]) || "#111" }}>{o.label}</span>
              </Td>
              <Td align="right"><span className="tabular-nums font-bold">{fmtInt(o.value)}</span></Td>
              <Td align="right"><span className="tabular-nums text-[#6b7280]">{Math.round((100 * o.value) / total)}%</span></Td>
              <Td><span className="text-[11.5px] text-[#6b7280]">{(o.bucket && OUTCOME_DETAIL[o.bucket]) || ""}</span></Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── inbound "what customers wanted & how it was handled" ── */
export function IntentOutcomeTable({ rows, totalConversations }: { rows: IntentOutcomeRow[]; totalConversations?: number }) {
  const rowSum = rows.reduce((s, r) => s + r.conversations, 0);
  // The tagged intents below are a SUBSET of real conversations — call-side IRA tags, top-8 only. The
  // true denominator is the funnel's "Real conversations" (totalConversations); tie the Total to it and
  // surface the untagged/other remainder as an "Other conversations" row so the column adds up. Guard the
  // grain mismatch (event counts vs distinct-lead funnel) from going negative — never below the row sum.
  const grandTotal = Math.max(totalConversations ?? 0, rowSum);
  const residual = grandTotal - rowSum;
  const denom = grandTotal || 1;
  // Hand-off measures only populate after the 0017 re-aggregate — hide the columns while all-zero so
  // the table never shows a wall of dashes.
  const hasHandoffs = rows.some((r) => r.transferred > 0 || r.callback > 0);
  const hasBooked = rows.some((r) => r.booked > 0);
  const num = (v: number, color?: string) =>
    v > 0 ? <span className="tabular-nums font-bold" style={color ? { color } : undefined}>{fmtInt(v)}</span> : <span className="text-[#d1d5db]">–</span>;
  const dash = <span className="text-[#d1d5db]">–</span>;
  // Outcome-column totals sum the tagged rows (we only know outcomes for tagged intents); the Convos total
  // ties to the funnel via grandTotal so the table reconciles with "Real conversations" above.
  const totals = rows.reduce(
    (s, r) => ({
      resolved: s.resolved + r.resolved,
      booked: s.booked + r.booked,
      transferred: s.transferred + r.transferred,
      callback: s.callback + r.callback,
    }),
    { resolved: 0, booked: 0, transferred: 0, callback: 0 },
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] border-collapse text-[12.5px]">
        <thead>
          <tr>
            <Th>What the customer wanted</Th>
            <Th align="right">Convos</Th>
            <Th align="right">Share</Th>
            <Th align="right">Resolved</Th>
            {hasBooked && <Th align="right">Booked</Th>}
            {hasHandoffs && <Th align="right">Transferred</Th>}
            {hasHandoffs && <Th align="right">Callback</Th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-t border-[#f0f0f0]">
              <Td><span className="font-medium text-[#111]">{r.label}</span></Td>
              <Td align="right"><span className="tabular-nums font-bold">{fmtInt(r.conversations)}</span></Td>
              <Td align="right"><span className="tabular-nums text-[#6b7280]">{Math.round((100 * r.conversations) / denom)}%</span></Td>
              <Td align="right">{num(r.resolved)}</Td>
              {hasBooked && <Td align="right">{num(r.booked, "#059669")}</Td>}
              {hasHandoffs && <Td align="right">{num(r.transferred, "#2563eb")}</Td>}
              {hasHandoffs && <Td align="right">{num(r.callback, "#6d28d9")}</Td>}
            </tr>
          ))}
          {residual > 0 && (
            <tr className="border-t border-[#f0f0f0]">
              <Td><span className="font-medium text-[#9ca3af]">Other conversations</span> <span className="text-[10.5px] text-[#b0b0b0]">· general / untagged</span></Td>
              <Td align="right"><span className="tabular-nums font-bold text-[#6b7280]">{fmtInt(residual)}</span></Td>
              <Td align="right"><span className="tabular-nums text-[#6b7280]">{Math.round((100 * residual) / denom)}%</span></Td>
              <Td align="right">{dash}</Td>
              {hasBooked && <Td align="right">{dash}</Td>}
              {hasHandoffs && <Td align="right">{dash}</Td>}
              {hasHandoffs && <Td align="right">{dash}</Td>}
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-[#e5e7eb] bg-[#fafafa]">
            <Td><span className="text-[11px] font-bold uppercase tracking-wide text-[#6b7280]">Total conversations</span></Td>
            <Td align="right"><span className="tabular-nums font-extrabold text-[#111]">{fmtInt(grandTotal)}</span></Td>
            <Td align="right"><span className="tabular-nums text-[#6b7280]">100%</span></Td>
            <Td align="right">{num(totals.resolved)}</Td>
            {hasBooked && <Td align="right">{num(totals.booked, "#059669")}</Td>}
            {hasHandoffs && <Td align="right">{num(totals.transferred, "#2563eb")}</Td>}
            {hasHandoffs && <Td align="right">{num(totals.callback, "#6d28d9")}</Td>}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/* ── recent conversations list + slide-in preview drawer (reusable: Overview + any dashboard) ──
 * A compact list of recent calls / SMS threads; clicking a row opens a right-hand drawer previewing
 * that conversation (summary + grade + outcomes for calls, message bubbles for SMS). Self-contained —
 * owns its own drawer state, so a host just passes the items + an optional onViewAll. */
export function RecentConversationsCard({
  items,
  loading,
  onViewAll,
  onOpen,
  teamId,
  agentNames,
  max = 8,
}: {
  items: Conversation[];
  loading?: boolean;
  onViewAll?: () => void;
  onOpen?: (c: Conversation) => void;
  teamId?: string;
  // slot ("sales|inbound" → "Emily") → the report's canonical per-agent name, so the table shows the SAME
  // agent name as the rest of the report rather than the unreliable raw call agentName.
  agentNames?: Record<string, string>;
  max?: number;
}) {
  const [sel, setSel] = React.useState<Conversation | null>(null);
  const open = (c: Conversation) => { setSel(c); onOpen?.(c); };
  return (
    <>
      <section className="rounded-2xl border border-[#e5e7eb] bg-white shadow-sm overflow-hidden">
        <div className="flex items-center justify-between border-b border-[#f0f0f0] px-6 py-4">
          <div>
            <p className="text-[14px] font-bold text-[#111]">Latest calls &amp; texts</p>
            <p className="mt-0.5 text-[11.5px] text-[#6b7280]">Click any row to preview the full conversation</p>
          </div>
          {onViewAll && (
            <button onClick={onViewAll} className="no-print rounded-lg border border-[#e5e7eb] bg-white px-3 py-1.5 text-[11.5px] font-semibold text-[#813fed] hover:bg-[#faf8ff]">
              View all →
            </button>
          )}
        </div>
        {loading ? (
          <div className="px-6 py-5"><div className="h-[220px] animate-pulse rounded-xl bg-[#eef0f3]" /></div>
        ) : items.length === 0 ? (
          <div className="px-6 py-6 text-[12.5px] text-[#6b7280]">No conversations synced for this window yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-[12.5px]">
              <thead className="bg-[#fafafa]">
                <tr>
                  <Th>Customer</Th>
                  <Th>Agent</Th>
                  <Th>Intent</Th>
                  <Th>Vehicle</Th>
                  <Th>Outcome</Th>
                  <Th>Date &amp; time</Th>
                  <Th align="right">Duration</Th>
                </tr>
              </thead>
              <tbody>
                {items.slice(0, max).map((c) => {
                  const isCall = c.channel === "call";
                  return (
                    <tr key={c.id} onClick={() => open(c)} className="cursor-pointer border-t border-[#f0f0f0] align-top hover:bg-[#faf8ff]">
                      <Td>
                        <div className="flex items-start gap-2">
                          <ChannelBadge channel={c.channel} direction={c.direction} />
                          <div className="min-w-0">
                            <p className="truncate text-[12.5px] font-semibold text-[#111]">{c.customer || "Unknown"}</p>
                            {c.phone && <p className="truncate text-[10.5px] tabular-nums text-[#6b7280]">📞 {c.phone}</p>}
                            {c.email ? <p className="truncate text-[10.5px] text-[#6b7280]">✉ {c.email}</p> : (isCall && <p className="text-[10.5px] font-semibold text-[#dc2626]">No email found</p>)}
                          </div>
                        </div>
                      </Td>
                      <Td><span className="whitespace-nowrap text-[#374151]">{agentDisplayName(c, agentNames)}</span></Td>
                      <Td><p className="max-w-[260px] truncate text-[#374151]" title={c.title || undefined}>{c.title || (isCall ? "—" : "Text conversation")}</p></Td>
                      <Td><span className="whitespace-nowrap text-[#6b7280]">{c.vehicle || "—"}</span></Td>
                      <Td><OutcomePill c={c} /></Td>
                      <Td><span className="whitespace-nowrap text-[#6b7280]">{fmtWhenShort(c.at)}</span></Td>
                      <Td align="right"><span className="whitespace-nowrap tabular-nums text-[#6b7280]">{isCall ? (c.durationSec ? fmtSecs(c.durationSec) : "—") : `${c.msgs ?? 0} msgs`}</span></Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <ConversationDrawer conv={sel} agentNames={agentNames} onClose={() => setSel(null)} />
    </>
  );
}

/* Canonical display name for a conversation's agent: prefer the report's per-slot name (dept|direction →
 * name), falling back to the raw call agentName, then a generic "Vini AI". The raw agentName is the same
 * for both directions on many rooftops, so the slot name (onboarded/persona) is the trustworthy source. */
export function agentDisplayName(c: Conversation, names?: Record<string, string>): string {
  const key = `${c.dept}|${c.direction}`;
  return names?.[key] || c.agent || "Vini AI";
}

function ChannelBadge({ channel, direction }: { channel: "call" | "sms"; direction: string }) {
  const inbound = direction === "inbound";
  const color = channel === "sms" ? "#0891b2" : inbound ? "#2563eb" : "#c2410c";
  return (
    <span className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-lg text-[13px]" style={{ background: `${color}14` }} title={`${inbound ? "Inbound" : "Outbound"} ${channel === "sms" ? "text" : "call"}`}>
      {channel === "sms" ? "💬" : inbound ? "↙" : "↗"}
    </span>
  );
}
function OutcomePill({ c }: { c: Conversation }) {
  const resolved = c.outcome === "Resolved" || c.queryResolved || c.appointmentScheduled;
  const color = resolved ? "#059669" : "#dc2626";
  const label = c.appointmentScheduled ? "Appointment" : resolved ? "Resolved" : "Not Resolved";
  return <span className="whitespace-nowrap rounded-full px-2 py-0.5 text-[10.5px] font-semibold" style={{ background: `${color}14`, color }}>{label}</span>;
}
function ConvTag({ children, color }: { children: React.ReactNode; color: string }) {
  return <span className="rounded-full px-1.5 py-0.5 text-[9px] font-semibold" style={{ background: `${color}14`, color }}>{children}</span>;
}
/* one label/value fact in the conversation drawer */
function DrawerFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[9.5px] font-bold uppercase tracking-wide text-[#9ca3af]">{label}</p>
      <p className="mt-0.5 text-[12.5px] font-semibold text-[#111]">{value}</p>
    </div>
  );
}
// report_summary sometimes arrives JSON-encoded (["…","…"]) — show the first sentence, not the brackets.
function cleanConvText(s: string): string {
  const t = (s || "").trim();
  if (!t.startsWith("[")) return t;
  try { const a = JSON.parse(t); if (Array.isArray(a) && a.length) return String(a[0]); } catch { /* not JSON */ }
  return t;
}

/* ── generic centered modal shell (reused by the appointments + warm-leads "view all") ── */
export function Modal({
  open,
  onClose,
  title,
  sub,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  sub?: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="no-print fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} aria-hidden />
      <div className={`relative z-10 flex max-h-[85vh] w-full flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ${wide ? "max-w-[880px]" : "max-w-[620px]"}`}>
        <div className="flex items-start justify-between gap-3 border-b border-[#f0f0f0] px-5 py-4">
          <div className="min-w-0">
            <p className="truncate text-[15px] font-bold text-[#111]">{title}</p>
            {sub && <p className="text-[11.5px] text-[#6b7280]">{sub}</p>}
          </div>
          <button onClick={onClose} aria-label="Close" className="flex h-8 w-8 flex-none items-center justify-center rounded-lg border border-[#e5e7eb] text-[#6b7280] hover:bg-[#f3f4f6]">✕</button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

/* Right-hand slide-in preview of one conversation. Renders null when nothing is selected. */
export function ConversationDrawer({ conv, onClose, agentNames }: { conv: Conversation | null; onClose: () => void; agentNames?: Record<string, string> }) {
  if (!conv) return null;
  const inbound = conv.direction === "inbound";
  const bubbles = conv.sms ?? [];
  return (
    <div className="no-print fixed inset-0 z-[60] flex justify-end">
      <div className="absolute inset-0 bg-black/25" onClick={onClose} aria-hidden />
      <aside className="relative z-10 flex h-full w-full max-w-[440px] flex-col overflow-y-auto bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-[#f0f0f0] px-5 py-4">
          <div className="min-w-0">
            <p className="truncate text-[15px] font-bold text-[#111]">{conv.customer || "Unknown caller"}</p>
            <p className="text-[11.5px] text-[#6b7280]">
              {inbound ? "Inbound" : "Outbound"} {conv.channel === "sms" ? "text thread" : "call"}
              {conv.phone ? <> · <a href={`tel:${conv.phone}`} className="tabular-nums underline decoration-dotted underline-offset-2">{conv.phone}</a></> : null}
            </p>
            {conv.email && <p className="truncate text-[11px] text-[#9ca3af]">✉ {conv.email}</p>}
            <p className="mt-0.5 text-[11px] text-[#9ca3af]">{fmtWhenShort(conv.at)}{conv.dept !== "other" ? ` · ${conv.dept}` : ""}{conv.channel === "call" && conv.durationSec ? ` · ${fmtSecs(conv.durationSec)}` : ""}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="flex h-8 w-8 flex-none items-center justify-center rounded-lg border border-[#e5e7eb] text-[#6b7280] hover:bg-[#f3f4f6]">✕</button>
        </div>

        {/* key details, printed out */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-b border-[#f3f4f6] px-5 py-4">
          <DrawerFact label="Agent" value={agentDisplayName(conv, agentNames)} />
          {conv.channel === "call" && conv.score != null && (
            <DrawerFact label="AI score" value={`${Number.isInteger(conv.score) ? conv.score : conv.score.toFixed(1)} / 10${conv.grade ? ` · ${conv.grade}` : ""}`} />
          )}
          <DrawerFact label="Sentiment" value={conv.frustrated ? "Frustrated" : conv.sentiment || "Neutral"} />
          <DrawerFact label="Outcome" value={conv.appointmentScheduled ? "Appointment booked" : conv.outcome || (conv.queryResolved ? "Resolved" : "Not resolved")} />
          {conv.vehicle && <DrawerFact label="Vehicle" value={conv.vehicle} />}
          {conv.title && <DrawerFact label="Intent" value={conv.title} />}
        </div>

        <div className="flex flex-wrap gap-1.5 px-5 pt-3">
          {conv.appointmentScheduled && <ConvTag color="#059669">Appointment</ConvTag>}
          {conv.queryResolved && <ConvTag color="#6d28d9">Query resolved</ConvTag>}
          {conv.hasActionItem && <ConvTag color="#ea760c">Action item</ConvTag>}
        </div>

        {conv.recordingUrl && (
          <div className="px-5 pt-3">
            <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-[#9ca3af]">Call recording</p>
            <audio controls preload="none" src={conv.recordingUrl} className="h-9 w-full">
              Your browser can’t play this recording.
            </audio>
          </div>
        )}

        {conv.channel === "sms" ? (
          <div className="flex flex-col gap-2 px-5 py-3">
            {bubbles.length === 0 ? (
              <p className="text-[12px] text-[#9ca3af]">Message preview not available.</p>
            ) : bubbles.map((b, i) => {
              const fromCustomer = b.direction === "inbound" || b.authorType === "human";
              return (
                <div key={i} className={`max-w-[85%] rounded-2xl px-3 py-2 text-[12px] leading-snug ${fromCustomer ? "self-start bg-[#f3f4f6] text-[#111]" : "self-end bg-[#f3eaff] text-[#4c1d95]"}`}>
                  <p className="mb-0.5 text-[9px] font-bold uppercase tracking-wide opacity-60">{fromCustomer ? "Customer" : "AI"}</p>
                  {b.body || "—"}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="px-5 py-4">
            <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-[#9ca3af]">AI summary</p>
            <p className="whitespace-pre-line text-[12.5px] leading-relaxed text-[#374151]">{cleanConvText(conv.summary) || "No summary available for this call."}</p>
          </div>
        )}
      </aside>
    </div>
  );
}

/* Pick which of a lead's conversations to open in the drawer. NOT simply the newest — a warm lead's
 * newest touch is often a one-sided outbound reach-out with no reply ("Hi, still shopping?"), which is
 * the LEAST informative and hides the conversation that actually flagged the lead (the customer's
 * buying-intent call/reply). Score by buying-intent evidence — an action item, a booked appointment, a
 * named vehicle, an inbound (customer-initiated) call, or an SMS thread with more than the single
 * outbound blast — and fall back to newest only when nothing carries a signal. */
function pickWarmLeadConversation(list: Conversation[]): Conversation {
  const score = (c: Conversation) =>
    (c.hasActionItem ? 8 : 0) +
    (c.appointmentScheduled ? 6 : 0) +
    (c.vehicle ? 4 : 0) +
    (c.direction === "inbound" ? 3 : 0) +
    ((c.msgs ?? 0) > 1 ? 3 : 0) +
    (c.queryResolved ? 1 : 0);
  return [...list].sort((a, b) => score(b) - score(a) || (b.at || "").localeCompare(a.at || ""))[0];
}

/* "View all" warm/hot leads with a click-through to review that lead's conversation. `loadConversation`
 * fetches the lead's calls/SMS (the host owns the API call + auth); the most buying-intent-relevant one
 * (see pickWarmLeadConversation) is shown in the drawer. */
export function WarmLeadsModal({
  open,
  onClose,
  items,
  loadConversation,
}: {
  open: boolean;
  onClose: () => void;
  items: WarmLeadItem[];
  loadConversation: (leadId: string) => Promise<Conversation[]>;
}) {
  const [conv, setConv] = React.useState<Conversation | null>(null);
  const [loadingId, setLoadingId] = React.useState<string | null>(null);
  const [emptyId, setEmptyId] = React.useState<string | null>(null);
  // Reset the drawer + per-row state whenever the modal closes, so a stale "No conversation" mark or an
  // orphaned drawer never lingers into the next open.
  React.useEffect(() => {
    if (!open) { setConv(null); setLoadingId(null); setEmptyId(null); }
  }, [open]);
  const hot = items.filter((w) => w.tier === "hot");
  const warm = items.filter((w) => w.tier === "warm");
  const openLead = async (w: WarmLeadItem) => {
    if (!w.leadId) return;
    setEmptyId(null);
    setLoadingId(w.leadId);
    try {
      const list = await loadConversation(w.leadId);
      if (list.length) setConv(pickWarmLeadConversation(list));
      else setEmptyId(w.leadId);
    } finally {
      setLoadingId(null);
    }
  };
  const Row = ({ w }: { w: WarmLeadItem }) => (
    <button
      onClick={() => openLead(w)}
      disabled={!w.leadId}
      className="flex w-full items-center justify-between gap-3 rounded border-b border-[#f5f5f5] px-1 py-2.5 text-left last:border-0 hover:bg-[#faf8ff] disabled:cursor-default disabled:hover:bg-transparent"
    >
      <div className="min-w-0">
        <p className="truncate text-[12.5px] font-semibold text-[#111]">
          {w.customer}
          {w.tier === "hot" ? <span className="ml-2 text-[10px] font-bold text-[#c2410c]">🔥 HOT</span> : null}
        </p>
        <p className="truncate text-[10.5px] text-[#9ca3af]">{w.interest || "Engaged"}{w.phone ? ` · ${w.phone}` : ""}</p>
      </div>
      <span className="flex-none text-[11px] font-semibold text-[#813fed]">
        {loadingId === w.leadId ? "Loading…" : emptyId === w.leadId ? "No conversation" : w.leadId ? "Review →" : ""}
      </span>
    </button>
  );
  return (
    <>
      <Modal open={open} onClose={onClose} title="Hot & warm leads" sub="Buying intent on record — click a lead to review its conversation" wide>
        {items.length === 0 ? (
          <p className="text-[12.5px] text-[#6b7280]">No warm leads right now.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {hot.length > 0 && (
              <div>
                <p className="mb-1 text-[10.5px] font-extrabold uppercase tracking-wide text-[#c2410c]">🔥 Hottest · concrete buying signal</p>
                {hot.map((w, i) => <Row key={`h-${i}`} w={w} />)}
              </div>
            )}
            {warm.length > 0 && (
              <div>
                <p className="mb-1 text-[10.5px] font-extrabold uppercase tracking-wide text-[#b45309]">🟡 Warm · engaged, nurture</p>
                {warm.map((w, i) => <Row key={`w-${i}`} w={w} />)}
              </div>
            )}
          </div>
        )}
      </Modal>
      <ConversationDrawer conv={conv} onClose={() => setConv(null)} />
    </>
  );
}

/* ── canonical definitions footer ── */
export function DefinitionsFooter({ tzLabel }: { tzLabel?: string }) {
  return (
    <footer className="print-card mt-2 border-t border-[#e5e7eb] pt-4 text-[11px] leading-relaxed text-[#9ca3af]">
      <p>
        <b className="text-[#6b7280]">Real conversation</b> = the customer actually spoke on a non-voicemail call, or replied to a text (voicemail excluded). ·{" "}
        <b className="text-[#6b7280]">Qualified</b> = concrete buying intent (vehicle / availability / price / financing / trade-in / test-drive / booking) — same rule for calls and SMS; a bare reply counts as Engaged, not Qualified. ·{" "}
        <b className="text-[#6b7280]">Appointments — AI-booked</b> = the AI created the meeting record; <b className="text-[#6b7280]">AI-assisted (CRM)</b> = booked in your CRM on a lead the AI worked, shown separately and never folded into the headline. ·{" "}
        <b className="text-[#6b7280]">Hand-offs</b> = completed transfers + requested callbacks; failed transfers reported separately. ·{" "}
        <b className="text-[#6b7280]">Turn rate</b> = qualified ÷ real conversations. · <b className="text-[#6b7280]">Close rate</b> = AI-booked ÷ qualified.
      </p>
      <p className="mt-1.5">
        All figures de-duplicated, window-distinct at the lead level, and consistent across the Vini console, scorecards and email reports.
        {tzLabel ? ` · Times in ${tzLabel}.` : " · Dealer-local time."}
      </p>
    </footer>
  );
}
