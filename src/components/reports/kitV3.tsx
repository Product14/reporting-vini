"use client";

/* v3 reporting-tab components — the live, per-rooftop productization of the hand-built dealer
 * scorecard (value tiles with IB/OB splits, per-agent funnel cards, named appointments, named warm
 * leads, ranked outcome tables). Same visual language as kit.tsx: white rounded-2xl cards, purple
 * #813fed accent, green for booked, tiny uppercase labels, tabular numerals. NO chart library. */

import React from "react";
import { fmtInt, type IntentOutcomeRow, type NamedAppt, type OutcomeSlice, type WarmLeadItem } from "./data";
import { FunnelBars, Td, Th } from "./kit";
import { track } from "@/lib/analytics";

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
        <p className="text-[26px] font-extrabold tabular-nums leading-none" style={{ color }}>{total}</p>
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
          <p className="text-[19px] font-extrabold tabular-nums leading-tight text-[#6d28d9]">{closeRateLabel}</p>
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
            <p className="text-[15px] font-extrabold tabular-nums leading-none text-[#111]">{v}</p>
            <p className="mt-1 text-[9px] font-bold uppercase tracking-wide text-[#9ca3af]">{k}</p>
          </div>
        ))}
      </div>
    </button>
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
  "5 Booked", "3 Warm", "6 Callback", "7 Transferred", "4 Engaged",
  "9 Unclear / info", "0 Not yet worked", "1 No reach", "8 Lost / declined", "2 Opt out", "10 Other",
];
const OUTCOME_DETAIL: Record<string, string> = {
  "5 Booked": "appointment on the books",
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
export function IntentOutcomeTable({ rows }: { rows: IntentOutcomeRow[] }) {
  const total = rows.reduce((s, r) => s + r.conversations, 0) || 1;
  // Hand-off measures only populate after the 0017 re-aggregate — hide the columns while all-zero so
  // the table never shows a wall of dashes.
  const hasHandoffs = rows.some((r) => r.transferred > 0 || r.callback > 0);
  const hasBooked = rows.some((r) => r.booked > 0);
  const num = (v: number, color?: string) =>
    v > 0 ? <span className="tabular-nums font-bold" style={color ? { color } : undefined}>{fmtInt(v)}</span> : <span className="text-[#d1d5db]">–</span>;
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
              <Td align="right"><span className="tabular-nums text-[#6b7280]">{Math.round((100 * r.conversations) / total)}%</span></Td>
              <Td align="right">{num(r.resolved)}</Td>
              {hasBooked && <Td align="right">{num(r.booked, "#059669")}</Td>}
              {hasHandoffs && <Td align="right">{num(r.transferred, "#2563eb")}</Td>}
              {hasHandoffs && <Td align="right">{num(r.callback, "#6d28d9")}</Td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
