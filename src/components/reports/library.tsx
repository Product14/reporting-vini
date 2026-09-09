"use client";

/* THE REPORT LIBRARY — a catalog of ready-made reports a dealer can open, each answering one question
 * they actually ask, each built from data already flowing through this app. No mock rows: every report
 * declares the live source it reads and hides itself when that source has nothing for the window.
 *
 * The catalog is data, not markup — one entry per report, with the question it answers, who it's for, and
 * a renderer. That shape is deliberate: the custom report builder that comes later can enumerate the same
 * entries (and their `source` metadata) instead of a second, divergent list.
 *
 * ADDING A REPORT: append one REPORTS entry. It shows up in the library, gets a card, an availability
 * gate and an export automatically. */

import React, { useEffect, useState } from "react";
import { Card, fmtInt, StepFunnel, TrendBars, Th } from "@/components/reports/kit";
import { fmtRate, fmtSecs, fmtDuration, NamedApptsTable, WarmLeadChips, RankedOutcomeTable, MetricTile, ConversationDrawer } from "@/components/reports/kitV3";
import { CallFlowCard, AppointmentLeakCard, HandoffsCard, ConversationQualityCard } from "@/components/reports/outcomes";
import type { EvalOutcomes, EvalDirection } from "@/lib/spyne/evalPipeline";
import type { AgentData, NamedAppt, WarmLeadItem } from "@/components/reports/data";
import { fetchConversations, type FetchResult, type FleetLive, type ActionItem, type ActionItemStats, type ReportMetrics, type Conversation } from "@/components/reports/liveData";
import type { InsightsPayload } from "@/app/api/reports/insights/route";
import type { DrillLead } from "@/app/api/reports/lead-drill/route";
import type { ExportSheet } from "@/components/reports/exportReport";

// ───────────────────────── context ─────────────────────────

/** Everything the library has loaded for the selected rooftop + window. Reports read what they need. */
export interface ReportCtx {
  teamId: string;
  enterpriseId: string;
  periodLabel: string;
  timezone?: string | null;
  feed: FetchResult | null;
  fleet: FleetLive;
  agents: AgentData[];
  metrics: ReportMetrics | null;
  actionStats: ActionItemStats | null;
  actionItems: ActionItem[];
  outcomes: Partial<Record<EvalDirection, EvalOutcomes>>;
  warmLeads: WarmLeadItem[];
  namedAppts: NamedAppt[];
  /** ClickHouse-only datasets (/api/reports/insights): CRM outcome, vehicles, routing, texts, coverage. */
  insights: InsightsPayload | null;
  /** Department the reader is scoped to — reports meaningful only to the other one are not offered. */
  dept?: "sales" | "service" | "all";
  /** The selected window, so a drill-down can ask the server for the same slice the report is showing. */
  window?: { bucket?: string; start?: string; end?: string };
  /* The dealer's session token, which arrives on the iframe URL. EVERY request to our own API has to
   * carry it as `Authorization: Bearer …` — requireTeamAuth has no dev bypass in production, so a fetch
   * that forgets it works locally and 401s silently for the dealer. */
  spyneToken?: string;
}

export interface ReportDef {
  id: string;
  title: string;
  /** The question a dealer would ask out loud. This is the card's subtitle — not a feature description. */
  question: string;
  category: "Appointments" | "Speed & response" | "Lead quality" | "Conversations" | "Team" | "Outbound" | "Service drive";
  /** Who reads it — helps a manager pick fast, and gives the future builder a facet to filter on. */
  who: string;
  /** Live source, shown on the report so a number can always be traced back. */
  source: string;
  /* Which sales agent this report belongs under, driving the "more reports" strip on the By-agent page.
   * Omitted = relevant to both, which is the common case (most reports are rooftop-wide). */
  agents?: ("sales_ib" | "sales_ob" | "service_ib" | "service_ob")[];
  /* Words a dealer would search that the report's own copy does not contain — "show rate", "loaner",
   * "recall", "ROI". Without these, search only finds reports you could already name. */
  keywords?: string[];
  /* Departments this report is MEANINGFUL for. Omitted = both. A vehicle-shopping report has no meaning
   * in the service drive, and offering it there is worse than not offering it: the reader assumes it is
   * about their department. */
  depts?: ("sales" | "service")[];
  /* One plain sentence telling the reader what this period's numbers actually mean — computed from the
   * data, not canned copy, so it changes with the figures. Rendered at the top of the report. */
  takeaway?: (c: ReportCtx) => string | null;
  /** False → the card renders as "no data for this window" rather than an empty report. */
  available: (c: ReportCtx) => boolean;
  render: (c: ReportCtx) => React.ReactNode;
}

// ───────────────────────── small shared primitives ─────────────────────────

/* The agents in scope. ctx.agents is ALREADY filtered to the department on the URL, so filtering again
 * to Sales — which is what these did — left every agent-shaped report permanently empty in the Service
 * space. Service runs an inbound and an outbound agent exactly as sales does, and both deserve the same
 * reports. */
const scopedAgents = (c: ReportCtx) => c.agents;
const inboundAgent = (c: ReportCtx) => c.agents.find((a) => a.dir === "Inbound");
const outboundAgent = (c: ReportCtx) => c.agents.find((a) => a.dir === "Outbound");
/* report_objections carries two kinds of row. `theme` = what customers actually pushed back on.
 * `outbound_outcome` = why an outbound lead ended (Opt Out, Not Interested, Already Purchased…). Most
 * rooftops today only have the latter, and it answers a real question, so the report falls back to it
 * rather than hiding. Rows are aggregated by label because the same label appears once per channel —
 * summing also avoids duplicate React keys downstream. */
function objectionRows(c: ReportCtx): { rows: { label: string; count: number }[]; kind: "theme" | "outcome" | null } {
  const all = c.metrics?.objections ?? [];
  for (const kind of ["theme", "outbound_outcome"] as const) {
    const byLabel = new Map<string, number>();
    for (const o of all) if (o.kind === kind && o.count > 0) byLabel.set(o.label, (byLabel.get(o.label) ?? 0) + o.count);
    if (byLabel.size) {
      return {
        rows: [...byLabel.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
        kind: kind === "theme" ? "theme" : "outcome",
      };
    }
  }
  return { rows: [], kind: null };
}
const apptTotals = (c: ReportCtx) =>
  (c.metrics?.appt_status ?? []).reduce(
    (acc, r) => ({
      booked: acc.booked + r.booked, showed: acc.showed + r.showed,
      no_show: acc.no_show + r.no_show, cancelled: acc.cancelled + r.cancelled, upcoming: acc.upcoming + r.upcoming,
    }),
    { booked: 0, showed: 0, no_show: 0, cancelled: 0, upcoming: 0 },
  );

/* HOW A CALL ENDED → whether a person was needed.
 *
 * `NEVER_CONNECTED` are the reasons where nobody was ever on the line, so they belong in neither the
 * numerator nor the denominator of a handling rate — counting an unanswered dial as "not handled" would
 * make an outbound rooftop look broken when it is simply dialling.
 * `HANDED_OFF` is the canonical completed-transfer pair used everywhere else in this app. Everything
 * else that connected is a call the AI carried to the end itself. */
const NEVER_CONNECTED = new Set(["voicemail", "voicemail_full", "no_answer", "customer_declined", "number_not_found", "busy", "machine_ivr", "(unknown)"]);
const HANDED_OFF = new Set(["transferred", "assistant-forwarded-call"]);

function handlingTotals(c: ReportCtx): {
  connected: number; solo: number; transferred: number; transferFailed: number; unreached: number; minutesSaved: number;
} | null {
  const rows = c.insights?.handling;
  if (!rows?.length) return null;
  let connected = 0, solo = 0, transferred = 0, transferFailed = 0, unreached = 0, minutesSaved = 0;
  for (const r of rows) {
    const reason = (r.reason || "").trim();
    if (NEVER_CONNECTED.has(reason)) { unreached += r.calls; continue; }
    connected += r.calls;
    if (HANDED_OFF.has(reason)) { transferred += r.calls; continue; }
    if (reason === "transfer_failed") { transferFailed += r.calls; continue; }
    solo += r.calls;
    // Minutes are claimed ONLY for calls a person never joined — see the note on the card.
    minutesSaved += r.minutes;
  }
  return connected ? { connected, solo, transferred, transferFailed, unreached, minutesSaved } : null;
}

/* Intents that are a request to be put through, not a question. Their "resolution" is really a transfer
 * outcome (covered by the hand-offs report), so folding them into a question-resolution rate drags it
 * down and measures the wrong thing. */
const ROUTING_INTENT = /talk to|speak (to|with)|live agent|human|reach |transfer|no intent|^others$/i;

function resolutionSplit(c: ReportCtx): { rows: { intent: string; raised: number; resolved: number }[]; raised: number; resolved: number } | null {
  const rows = (c.insights?.resolution ?? []).filter((r) => r.raised > 0 && !ROUTING_INTENT.test(r.intent));
  if (!rows.length) return null;
  return {
    rows: rows.sort((a, b) => b.raised - a.raised),
    raised: rows.reduce((s, r) => s + r.raised, 0),
    resolved: rows.reduce((s, r) => s + r.resolved, 0),
  };
}

/** Minutes as a phrase a manager reads without converting: "3h 20m", "45 min". */
function fmtHours(mins: number): string {
  if (mins < 60) return `${Math.round(mins)} min`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}


/* DEMAND vs STOCK. Both sides are keyed by make + base model (see the API's modelKey), so a demand row
 * for "Sportage Hybrid" lands on the "Sportage" stock row instead of falsely reading as out of stock.
 * Models present on only ONE side are kept — stock with no interest and interest with no stock are both
 * things a dealer wants to see — sorted by demand first, then by units. */
function demandVsStock(c: ReportCtx): { make: string; model: string; leads: number; units: number }[] {
  const demand = c.insights?.vehicles ?? [];
  const stock = c.insights?.stock ?? [];
  if (!demand.length && !stock.length) return [];
  const byKey = new Map<string, { make: string; model: string; leads: number; units: number }>();
  for (const d of demand) {
    /* Demand can carry SEVERAL rows per key — "Sportage" and "Sportage Hybrid" both fold to SPORTAGE.
     * They must be summed; overwriting drops one variant's leads entirely, which is the exact case this
     * report exists to handle. The shorter label wins so the row reads as the base model, matching how
     * stock names it. */
    const hit = byKey.get(d.key);
    if (hit) {
      hit.leads += d.leads;
      if (d.model.length < hit.model.length) hit.model = d.model;
    } else {
      byKey.set(d.key, { make: d.make, model: d.model, leads: d.leads, units: 0 });
    }
  }
  for (const s of stock) {
    const hit = byKey.get(s.key);
    if (hit) hit.units += s.units;
    else byKey.set(s.key, { make: s.make, model: s.model, leads: 0, units: s.units });
  }
  return [...byKey.values()].sort((a, b) => b.leads - a.leads || b.units - a.units);
}

/** Dials-per-lead rolled up: totals plus the heavily-chased tail. */
function effortTotals(c: ReportCtx): { leads: number; dials: number; avg: number; heavy: number } | null {
  const rows = c.insights?.effort;
  if (!rows?.length) return null;
  const leads = rows.reduce((s, r) => s + r.leads, 0);
  const dials = rows.reduce((s, r) => s + r.leads * r.attempts, 0);
  const heavy = rows.filter((r) => r.attempts >= 6).reduce((s, r) => s + r.leads, 0);
  return leads ? { leads, dials, avg: dials / leads, heavy } : null;
}


/* SERVICE-DESK TOOLS. Names come back as `service_create_appointment_v2`; the version suffix and the
 * prefix are implementation detail, so lookups are by the middle. Returns null when the rooftop has never
 * used that capability, which is different from using it and failing — the reports rely on that
 * distinction to decide whether to offer themselves at all. */
function svcRows(c: ReportCtx): { tool: string; ok: number; failed: number }[] {
  return c.insights?.serviceTools ?? [];
}
function svcTool(c: ReportCtx, name: string): { tool: string; ok: number; failed: number } | null {
  const hit = svcRows(c).find((t) => t.tool.includes(name));
  return hit && hit.ok + hit.failed > 0 ? hit : null;
}
/** Tool id → what the CUSTOMER was trying to do. A fixed-ops director should never read a function name. */
const SVC_LABELS: Record<string, string> = {
  create_appointment: "Book a service appointment",
  reschedule_appointment: "Move an existing appointment",
  cancel_appointment: "Cancel an appointment",
  list_available_time_slots: "See open times",
  list_existing_appointments: "Check an appointment they already had",
  list_available_services: "Ask what services you offer",
  list_transportation_options: "Ask about a loaner or shuttle",
  check_vehicle_eligibility: "Check recall or warranty cover",
  lookup_customer: "Be found in your records",
  list_repair_orders: "Ask about a repair order",
};
function svcLabel(tool: string): string {
  const key = Object.keys(SVC_LABELS).find((k) => tool.includes(k));
  return key ? SVC_LABELS[key] : tool.replace(/^service_/, "").replace(/_v\d+$/, "").replace(/_/g, " ");
}


/* Lead rows rolled up to TYPE, each carrying its own sources. The CRM writes the type inconsistently
 * ("INTERNET" and "Internet", "Walk-in" and "WALK_IN"), so the SQL normalises it and this just groups. */
export type LeadStageKey = "appt" | "qualifiedOnly" | "reachedOnly" | "notReached";

/* The three stages a CONTACTED lead can be in, best first — mutually exclusive, so they stack. The funnel
 * columns (contact/reached/qualified/appts) NEST and cannot be stacked without double counting.
 *
 * ★ "Never reached" IS DELIBERATELY NOT HERE. This card answers "of the people we actually got hold of,
 * where did each source get to" — dialling a number and hitting voicemail says nothing about the source's
 * quality, and on most rooftops it is 70-80% of every row, which flattened all three real stages into
 * slivers and made every source look identical. notReached is still computed (it is what defines the
 * contacted population, engagedOf below) and still has a drill bucket; it is just never a segment. */
export const LEAD_STAGES: { key: LeadStageKey; label: string; color: string; drill: string }[] = [
  { key: "appt", label: "Appointment", color: "#15803d", drill: "appt" },
  { key: "qualifiedOnly", label: "Qualified, no appointment", color: "#0891b2", drill: "qualified" },
  { key: "reachedOnly", label: "Reached, not qualified", color: "#2563eb", drill: "reached" },
];

/** Leads we actually reached = everything the three stages above cover. The card's denominator. */
export const engagedOf = (r: { appt: number; qualifiedOnly: number; reachedOnly: number }) =>
  r.appt + r.qualifiedOnly + r.reachedOnly;

export interface LeadRowStats {
  contact: number; reached: number; evaluated: number; qualified: number; appts: number; actionItems: number;
  appt: number; qualifiedOnly: number; reachedOnly: number; notReached: number;
}
export interface LeadTypeRow extends LeadRowStats {
  type: string;
  sources: (LeadRowStats & { source: string })[];
}
function leadTypeRollup(c: ReportCtx): LeadTypeRow[] {
  const rows = c.insights?.leadSources ?? [];
  const byType = new Map<string, LeadTypeRow>();
  for (const r of rows) {
    const hit = byType.get(r.type) ?? {
      type: r.type, contact: 0, reached: 0, evaluated: 0, qualified: 0, appts: 0, actionItems: 0,
      appt: 0, qualifiedOnly: 0, reachedOnly: 0, notReached: 0, sources: [],
    };
    hit.contact += r.contact; hit.reached += r.reached; hit.evaluated += r.evaluated;
    hit.qualified += r.qualified; hit.appts += r.appts; hit.actionItems += r.actionItems;
    hit.appt += r.appt; hit.qualifiedOnly += r.qualifiedOnly; hit.reachedOnly += r.reachedOnly; hit.notReached += r.notReached;
    hit.sources.push(r);
    byType.set(r.type, hit);
  }
  // Contacted-lead order, and a type/source nobody was reached at is dropped rather than drawn empty.
  return [...byType.values()]
    .map((t) => ({ ...t, sources: t.sources.filter((s) => engagedOf(s) > 0).sort((a, b) => engagedOf(b) - engagedOf(a)) }))
    .filter((t) => engagedOf(t) > 0)
    .sort((a, b) => engagedOf(b) - engagedOf(a));
}

/* The table, drawn the way the conversation flow is: one row per lead type, a stacked bar showing where
 * those leads actually got to, and the winning stage named on the right. Bar WIDTH is the type's share of
 * all leads worked, so a 600-lead type and a 2-lead type never look alike; the segments inside it are
 * that type's own split. Expanding a type reveals its sources drawn the same way.
 *
 * Every segment is clickable and opens the leads behind it — a count you cannot open is a count you
 * cannot act on. */
function LeadSourceTable({
  types, total, onDrill,
}: {
  types: LeadTypeRow[];
  total: number;
  onDrill: (d: { type: string; source?: string; stage: (typeof LEAD_STAGES)[number] }) => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const max = Math.max(1, ...types.map(engagedOf));

  // Width = share of the busiest type's CONTACTED leads; segments = that row's own split of its contacted.
  const Bar = ({ row, type, source }: { row: LeadRowStats; type: string; source?: string }) => {
    const base = engagedOf(row);
    if (!base) return <div className="h-5 w-full rounded-md bg-[#f4f5f7]" />;
    return (
      <div className="h-5 w-full rounded-md bg-[#f4f5f7]">
        <div className="flex h-full overflow-hidden rounded-md" style={{ width: `${Math.max(1.5, (base / max) * 100)}%`, gap: 1 }}>
          {LEAD_STAGES.filter((st) => row[st.key] > 0).map((st) => (
            <button
              key={st.key}
              type="button"
              title={`${st.label} · ${fmtInt(row[st.key])} of ${fmtInt(base)} contacted · click to see them`}
              onClick={() => onDrill({ type, source, stage: st })}
              className="h-full min-w-[3px] first:rounded-l-md last:rounded-r-md hover:opacity-80"
              style={{ width: `${(row[st.key] / base) * 100}%`, background: st.color }}
            />
          ))}
        </div>
      </div>
    );
  };

  const Winner = ({ row }: { row: LeadRowStats }) => {
    const top = LEAD_STAGES.filter((st) => row[st.key] > 0).sort((a, b) => row[b.key] - row[a.key])[0];
    if (!top) return null;
    return (
      <span className="flex items-center gap-1.5 text-[11px] leading-tight">
        <span className="h-2 w-2 flex-none rounded-sm" style={{ background: top.color }} />
        <span className="truncate font-semibold text-[#374151]">{top.label}</span>
        <span className="flex-none tabular-nums text-[#9ca3af]">{pct(row[top.key], engagedOf(row))}%</span>
      </span>
    );
  };

  const GRID = "grid grid-cols-[minmax(150px,230px)_1fr] items-center gap-3 sm:grid-cols-[minmax(170px,250px)_1fr_minmax(140px,190px)]";

  return (
    <div className="px-5 py-4">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {LEAD_STAGES.map((st) => (
          <span key={st.key} className="inline-flex items-center gap-1.5 text-[11px] text-[#374151]">
            <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: st.color }} />
            {st.label}
          </span>
        ))}
      </div>

      {types.map((t) => (
        <div key={t.type} className="border-b border-[#f4f4f6] py-1 last:border-b-0">
          {/* A DIV holding its own toggle button — the Bar's segments are buttons, and a button inside a
              button is invalid markup that React warns about and browsers silently un-nest, which was
              swallowing the segment clicks this table exists for. Same shape as the conversation flow. */}
          <div className={`${GRID} w-full rounded-lg px-1 py-2 hover:bg-[#fafafa]`}>
            <button
              type="button"
              onClick={() => setOpen((s) => ({ ...s, [t.type]: !s[t.type] }))}
              aria-expanded={!!open[t.type]}
              className="flex min-w-0 items-center gap-2 text-left"
            >
              <span className={`flex-none text-[9px] text-[#813fed] transition-transform ${open[t.type] ? "rotate-90" : ""}`}>▶</span>
              <span className="min-w-0">
                <span className="block truncate text-[12.5px] font-bold text-[#111]">{t.type.replace(/_/g, " ")}</span>
                <span className="text-[10.5px] tabular-nums text-[#9ca3af]">{fmtInt(engagedOf(t))} contacted · {pct(engagedOf(t), total)}% · {t.sources.length} source{t.sources.length === 1 ? "" : "s"}</span>
              </span>
            </button>
            <Bar row={t} type={t.type} />
            <span className="hidden sm:flex"><Winner row={t} /></span>
          </div>

          {open[t.type] && (
            <div className="ml-3 border-l-2 border-[#ece9f6] pl-3">
              {t.sources.map((r) => (
                <div key={r.source} className={`${GRID} px-1 py-1.5`}>
                  <span className="min-w-0 pl-4">
                    <span className="block truncate text-[11.5px] font-semibold text-[#374151]">{r.source}</span>
                    <span className="text-[10px] tabular-nums text-[#9ca3af]">{fmtInt(engagedOf(r))} contacted</span>
                  </span>
                  <Bar row={r} type={t.type} source={r.source} />
                  <span className="hidden sm:flex"><Winner row={r} /></span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      <p className="mt-3 text-[10.5px] text-[#9ca3af]">
        Leads we reached · bar width is how many · click any segment to see the customers behind it. Leads
        we never got hold of are left out — they say nothing about where the lead came from.
      </p>
    </div>
  );
}


/* REPORT COPY IN THE READER'S OWN DEPARTMENT — the audience line and the "source" line.
 *
 * Most of these reports were written for the sales floor first, so they name a sales manager as the
 * audience and describe their data as "every sales call". The same report in a Service context is read
 * by different people — a service manager or a fixed-ops director — over service calls, and a card
 * headed SALES MANAGER on the Service tab is both wrong and the first thing a dealer notices. Reports
 * that are service-only already name their own audience and pass through untouched, because "service"
 * does not match "sales".
 *
 * Deliberately only rewrites the sales/service word: BDC, receptionist, trainer, marketing, GM and
 * owner are real roles in a service drive too and are left exactly as written. */
export function audienceFor(text: string, dept?: "sales" | "service" | "all"): string {
  if (dept !== "service") return text;
  return text.replace(/\bSales\b/g, "Service").replace(/\bsales\b/g, "service");
}

const anyOutcome = (c: ReportCtx) => c.outcomes.inbound ?? c.outcomes.outbound ?? null;
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);

/** A row of headline numbers. Keeps every report opening the same way. */
function Stats({ items }: { items: { label: string; value: string; sub?: string; accent?: string }[] }) {
  return (
    <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
      {items.map((s) => (
        <div key={s.label} className="rounded-xl border border-[#e5e7eb] bg-white px-3.5 py-3">
          <p className="text-[9.5px] font-bold uppercase tracking-wide text-[#9ca3af]">{s.label}</p>
          <p className="mt-0.5 text-[22px] font-extrabold leading-none tabular-nums" style={{ color: s.accent ?? "#111" }}>{s.value}</p>
          {s.sub && <p className="mt-1 text-[10.5px] leading-snug text-[#6b7280]">{s.sub}</p>}
        </div>
      ))}
    </div>
  );
}

/** Compact data table — the shape most of these reports want. */
function Table({ head, rows }: { head: { label: string; align?: "left" | "right" }[]; rows: React.ReactNode[][] }) {
  if (!rows.length) return <p className="px-6 py-5 text-[12px] text-[#9ca3af]">Nothing recorded for this period.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px]">
        <thead className="bg-[#fafafa]">
          <tr>{head.map((h) => <Th key={h.label} align={h.align ?? "left"}>{h.label}</Th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-[#f4f4f6]">
              {r.map((cell, j) => (
                <td key={j} className={`px-4 py-2.5 text-[12.5px] ${head[j]?.align === "right" ? "text-right tabular-nums" : "text-left"} text-[#374151]`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Horizontal ranked bars — one measure across categories. */
function RankBars({ rows, accent = "#813fed" }: { rows: { label: string; value: number; note?: string }[]; accent?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <p className="text-[12px] text-[#9ca3af]">Nothing recorded for this period.</p>;
  return (
    <div className="flex flex-col gap-2">
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-[minmax(120px,190px)_1fr_auto] items-center gap-3">
          <span className="truncate text-[12px] font-medium text-[#374151]">{r.label}</span>
          <span className="h-4 overflow-hidden rounded-md bg-[#f1f2f5]">
            <span className="block h-full rounded-md" style={{ width: `${Math.max(2, (r.value / max) * 100)}%`, background: accent }} />
          </span>
          <span className="text-right text-[12px] font-bold tabular-nums text-[#111]">
            {fmtInt(r.value)}
            {r.note && <span className="ml-1.5 font-medium text-[#9ca3af]">{r.note}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] leading-snug text-[#9ca3af]">{children}</p>;
}

// ───────────────────────── the catalog ─────────────────────────

export const REPORTS: ReportDef[] = [
  // 1 ─────────────────────────────────────────────────────────────────────────
  {
    id: "appointments",
    title: "Appointment performance",
    question: "How many appointments did the AI book, and who is coming in?",
    category: "Appointments",
    who: "Sales manager · GM",
    source: "Appointments the AI booked, and the lead funnel behind them",
    available: (c) => c.fleet.appointments > 0 || c.namedAppts.length > 0,
    render: (c) => {
      const byAgent = scopedAgents(c).map((a) => ({ label: `${a.report.summary.person || a.name} · ${a.dir}`, value: a.metrics.appointments }));
      return (
        <div className="flex flex-col gap-4">
          <Stats
            items={[
              { label: "Booked by the AI", value: fmtInt(c.fleet.appointments), sub: "confirmed in your CRM", accent: "#15803d" },
              { label: "Also booked after an AI touch", value: fmtInt(c.fleet.appointmentsAssisted), sub: "your team closed these" },
              { label: "Qualified leads", value: fmtInt(c.fleet.qualified), sub: "showed buying intent" },
              { label: "Close rate", value: fmtRate(c.fleet.appointments, c.fleet.qualified), sub: "appointments ÷ qualified leads", accent: "#813fed" },
            ]}
          />
          <Card title="Who booked them" sub="Appointments by agent">
            <RankBars rows={byAgent} accent="#15803d" />
          </Card>
          <Card title="Booked appointments" sub={`${c.namedAppts.length} named customers · ${c.periodLabel}`} pad={false}>
            <NamedApptsTable items={c.namedAppts} teamId={c.teamId} />
          </Card>
        </div>
      );
    },
  },

  // 2 ─────────────────────────────────────────────────────────────────────────
  {
    id: "speed-to-lead",
    depts: ["sales"],
    keywords: ["response time","first touch","lead response","speed"],
    title: "Speed to lead",
    question: "How fast is a new lead getting its first touch — and does speed win appointments?",
    category: "Speed & response",
    who: "Sales manager · BDC",
    source: "First-response times on new CRM leads (Sales Inbound)",
    available: (c) => !!inboundAgent(c)?.report.speedToLead,
    render: (c) => {
      const stl = inboundAgent(c)!.report.speedToLead!;
      const f = stl.openFunnel;
      return (
        <div className="flex flex-col gap-4">
          <Stats
            items={[
              { label: "Average first touch", value: stl.avg, sub: "from lead arriving to first contact", accent: "#813fed" },
              { label: "Within 5 minutes", value: `${stl.pctWithin5}%`, sub: `${fmtInt(stl.instantlyTouched)} of ${fmtInt(stl.crmLeadsNew)} new leads` },
              { label: "Booked from an instant touch", value: `${stl.instantApptRate}%`, sub: `${fmtInt(stl.instantAppts)} appointments`, accent: "#15803d" },
              { label: "Caught after hours", value: fmtInt(stl.afterHoursInstant), sub: "answered outside opening hours", accent: "#0891b2" },
            ]}
          />
          {f && (
            <Card title="Does responding instantly pay?" sub="Instant first touch vs. a later follow-up, same period">
              <div className="grid gap-5 sm:grid-cols-2">
                {[
                  { t: "Answered instantly", leads: f.stlLeadsHandled, appts: f.stlAppts, rate: f.stlRate, color: "#15803d" },
                  { t: "Followed up later", leads: f.followupLeadsHandled, appts: f.followupAppts, rate: f.followupRate, color: "#9ca3af" },
                ].map((b) => (
                  <div key={b.t} className="rounded-xl border border-[#e5e7eb] px-4 py-3.5">
                    <p className="text-[11.5px] font-bold text-[#374151]">{b.t}</p>
                    <p className="mt-1 text-[26px] font-extrabold leading-none tabular-nums" style={{ color: b.color }}>{b.rate}%</p>
                    <p className="mt-1 text-[11px] text-[#6b7280]">{fmtInt(b.appts)} appointments from {fmtInt(b.leads)} leads</p>
                  </div>
                ))}
              </div>
              <Note>{stl.note}</Note>
            </Card>
          )}
          <Card title="Missed calls returned" sub="Inbound calls that went unanswered and were called back">
            <Stats items={[{ label: "Called back", value: fmtInt(stl.missedCalledBack), sub: "recovered by the AI" }, { label: "Leads touched", value: `${stl.pctTouched}%`, sub: "of new CRM leads" }]} />
          </Card>
        </div>
      );
    },
  },

  // 3 ─────────────────────────────────────────────────────────────────────────
  {
    id: "lead-sources",
    keywords: ["marketing","source","channel","roi by source","lead type","internet","walk in","provider"],
    title: "Leads by type and source",
    question: "Where do our leads come from, and which ones actually go anywhere?",
    category: "Lead quality",
    who: "GM · marketing · BDC manager",
    source: "Your CRM's own lead type and source, followed through to appointments",
    available: (c) => (c.insights?.leadSources?.length ?? 0) > 0,
    takeaway: (c) => {
      // Every figure here is of leads we CONTACTED — the population the card draws.
      const t = leadTypeRollup(c);
      const total = t.reduce((s, x) => s + engagedOf(x), 0);
      const top = t[0];
      const best = t.filter((x) => engagedOf(x) >= 10).sort((a, b) => b.qualified / engagedOf(b) - a.qualified / engagedOf(a))[0];
      const bestBit = best && best.qualified ? ` ${best.type} leads qualify at the highest rate — ${pct(best.qualified, engagedOf(best))}%.` : "";
      return `${fmtInt(total)} leads were actually reached this period. ${top.type} is the biggest group at ${pct(engagedOf(top), total)}%.${bestBit}`;
    },
    render: (c) => {
      const types = leadTypeRollup(c);
      const total = types.reduce((s, x) => s + engagedOf(x), 0);
      const attempted = types.reduce((s, x) => s + x.contact, 0);
      const sum = (k: "reached" | "evaluated" | "qualified" | "appts" | "actionItems") => types.reduce((s, x) => s + x[k], 0);
      return (
        <div className="flex flex-col gap-4">
          <Stats
            items={[
              { label: "Leads contacted", value: fmtInt(total), sub: `of ${fmtInt(attempted)} worked · ${types.length} lead types` },
              { label: "Qualified", value: fmtInt(sum("qualified")), sub: `${pct(sum("qualified"), total)}% of those contacted`, accent: "#0891b2" },
              { label: "Appointments", value: fmtInt(sum("appts")), sub: `${pct(sum("appts"), total)}% of those contacted`, accent: "#15803d" },
              // Scoped to the leads on this card, NOT the rooftop — the action-items page counts every open
              // item and will read higher. Labelled so the two are not mistaken for the same number.
              { label: "Open action items", value: fmtInt(sum("actionItems")), sub: "on the leads contacted here" },
            ]}
          />
          <Card
            title="Lead type and source"
            sub="Where the leads from each type and source actually got to · click a type to open its sources"
            pad={false}
          >
            <LeadStageExplorer types={types} total={total} ctx={c} />
          </Card>
          <Note>
            This is the breakdown for leads we actually got hold of. Leads we tried and never reached are
            excluded — they are a dialling outcome, not a signal about where the lead came from. Counts
            leads with at least one conversation in this period, not leads created in it, so a lead that
            came in last month and was worked today belongs here. Qualified, appointments and open action
            items describe where the lead stands NOW, so they are not confined to this period and will not
            tie exactly to the period figures elsewhere.
          </Note>
        </div>
      );
    },
  },

  // 4 ─────────────────────────────────────────────────────────────────────────
  {
    id: "what-customers-wanted",
    title: "What customers asked for",
    question: "What are people actually calling about, and what came of it?",
    category: "Conversations",
    who: "GM · sales manager",
    source: "Every reviewed sales call, grouped by what the customer wanted",
    available: (c) => !!anyOutcome(c),
    render: (c) => (
      <div className="flex flex-col gap-4">
        {(["inbound", "outbound"] as EvalDirection[]).map((d) => {
          const o = c.outcomes[d];
          if (!o || !o.scored) return null;
          const agent = scopedAgents(c).find((a) => a.dir.toLowerCase() === d);
          return (
            <CallFlowCard
              key={d}
              o={o}
              calls={agent?.metrics.calls}
              title={`${d === "inbound" ? "Inbound" : "Outbound"} calls`}
              drill={{
                teamId: c.teamId,
                serviceType: c.dept && c.dept !== "all" ? c.dept : undefined,
                start: c.window?.start,
                end: c.window?.end,
                bucket: c.window?.bucket,
                spyneToken: c.spyneToken,
              }}
            />
          );
        })}
      </div>
    ),
  },

  // 5 ─────────────────────────────────────────────────────────────────────────
  {
    id: "appointment-leak",
    title: "Where appointments are lost",
    question: "Of the people who wanted to buy, where did we stop short of booking?",
    category: "Appointments",
    who: "Sales manager",
    source: "Step-by-step review of every sales conversation",
    available: (c) => !!anyOutcome(c)?.funnels.some((f) => f.key === "Appointment" && f.totalEligible > 0),
    render: (c) => {
      const o = (["inbound", "outbound"] as EvalDirection[]).map((d) => c.outcomes[d]).filter(Boolean).sort((a, b) => b!.funnelBase - a!.funnelBase)[0]!;
      return (
        <div className="flex flex-col gap-4">
          <AppointmentLeakCard o={o} />
          <ConversationQualityCard o={o} />
        </div>
      );
    },
  },

  // 6 ─────────────────────────────────────────────────────────────────────────
  {
    id: "handoffs",
    keywords: ["transfer","escalation","live agent","receptionist"],
    title: "Hand-offs to your team",
    question: "When a customer asked for a person, did they actually reach one?",
    category: "Team",
    who: "Sales manager · receptionist",
    source: "Transfer attempts and connections, plus call-backs requested",
    available: (c) => !!anyOutcome(c) || c.fleet.handoffs > 0,
    render: (c) => {
      const o = anyOutcome(c);
      const failed = c.fleet.transfersFailed;
      return (
        <div className="flex flex-col gap-4">
          <Stats
            items={[
              { label: "Hand-offs to your team", value: fmtInt(c.fleet.handoffs), sub: `${fmtInt(c.fleet.transfers)} transfers · ${fmtInt(c.fleet.callbacks)} call-backs` },
              { label: "Transfers completed", value: fmtInt(c.fleet.transfers), sub: "customer reached a person", accent: "#15803d" },
              { label: "Transfers that failed", value: fmtInt(failed), sub: "nobody picked up", accent: failed > 0 ? "#dc2626" : undefined },
              { label: "Call-backs owed", value: fmtInt(c.fleet.callbacks), sub: "customer asked to be called", accent: "#d97706" },
            ]}
          />
          {o && <HandoffsCard o={o} />}
          {(c.metrics?.calls_by_reason?.length ?? 0) > 0 && (
            <Card title="Why people called" sub="Reasons behind this period's calls">
              <RankBars rows={c.metrics!.calls_by_reason.slice(0, 10).map((r) => ({ label: r.reason, value: r.calls }))} accent="#2563eb" />
            </Card>
          )}
        </div>
      );
    },
  },

  // 7 ─────────────────────────────────────────────────────────────────────────
  {
    id: "missed-opportunities",
    keywords: ["hot leads","warm leads","follow up","opportunity","unworked"],
    title: "Money on the table",
    question: "Which interested customers have not been booked yet?",
    category: "Lead quality",
    who: "Sales manager · BDC",
    source: "Leads with buying intent and no appointment, plus outbound demand that slipped",
    available: (c) => c.warmLeads.length > 0 || (c.metrics?.missed?.length ?? 0) > 0,
    render: (c) => {
      const hot = c.warmLeads.filter((w) => w.tier === "hot");
      return (
        <div className="flex flex-col gap-4">
          <Stats
            items={[
              { label: "Hot leads waiting", value: fmtInt(hot.length), sub: "buying intent, no appointment", accent: "#dc2626" },
              { label: "Warm leads", value: fmtInt(c.warmLeads.length - hot.length), sub: "worth a follow-up", accent: "#d97706" },
              { label: "Qualified this period", value: fmtInt(c.fleet.qualified) },
              { label: "Booked", value: fmtInt(c.fleet.appointments), sub: fmtRate(c.fleet.appointments, c.fleet.qualified) + " of qualified", accent: "#15803d" },
            ]}
          />
          {c.warmLeads.length > 0 && (
            <Card title="Work these now" sub="Buying intent on record, no appointment yet">
              <WarmLeadChips items={c.warmLeads} teamId={c.teamId} maxHot={14} maxWarm={10} />
            </Card>
          )}
          {(c.metrics?.missed?.length ?? 0) > 0 && (
            <Card title="Demand that slipped" sub="Where outbound attempts fell away">
              <RankBars rows={c.metrics!.missed.map((m) => ({ label: `${m.category} · ${m.channel}`, value: m.count }))} accent="#dc2626" />
            </Card>
          )}
        </div>
      );
    },
  },

  // 8 ─────────────────────────────────────────────────────────────────────────
  {
    id: "follow-ups",
    keywords: ["action items","tasks","compliance","overdue"],
    title: "Follow-up compliance",
    question: "Is the team closing the follow-ups the AI logged?",
    category: "Team",
    who: "Sales manager",
    source: "Action items created by the AI and their current state",
    available: (c) => !!c.actionStats,
    render: (c) => {
      const s = c.actionStats!;
      // `overdue` isn't a field on the item — it's derived: a due date in the past on an unfinished item.
      const isOverdue = (i: ActionItem) => !i.completed && !!i.dueAt && Date.parse(i.dueAt) < Date.now();
      const overdue = c.actionItems.filter(isOverdue);
      return (
        <div className="flex flex-col gap-4">
          <Stats
            items={[
              { label: "Created", value: fmtInt(s.created), sub: "this period" },
              { label: "Closed", value: fmtInt(s.completed), sub: `${pct(s.completed, s.created || 1)}% of created`, accent: "#15803d" },
              { label: "Still open", value: fmtInt(s.open), accent: s.open > 0 ? "#d97706" : undefined },
              { label: "Overdue", value: fmtInt(s.overdue), sub: "past their due date", accent: s.overdue > 0 ? "#dc2626" : undefined },
            ]}
          />
          <Card title="Open follow-ups" sub={`${overdue.length} overdue · oldest first`} pad={false}>
            <Table
              head={[{ label: "Customer" }, { label: "What's needed" }, { label: "Due", align: "right" }]}
              rows={[...c.actionItems]
                .sort((a, b) => Number(isOverdue(b)) - Number(isOverdue(a)) || (a.dueAt || "").localeCompare(b.dueAt || ""))
                .slice(0, 20)
                .map((i) => [
                  <span key="c" className="font-semibold text-[#111]">{i.customer || i.leadId || "—"}</span>,
                  i.description || i.intent,
                  <span key="d" style={{ color: isOverdue(i) ? "#dc2626" : "#6b7280" }}>
                    {i.dueAt ? new Date(i.dueAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—"}
                  </span>,
                ])}
            />
          </Card>
        </div>
      );
    },
  },

  // 9 ─────────────────────────────────────────────────────────────────────────
  {
    id: "after-hours",
    keywords: ["evenings","weekends","out of hours","closed"],
    title: "After-hours capture",
    question: "What would we have missed if nobody answered outside opening hours?",
    category: "Speed & response",
    who: "GM · owner",
    source: "Conversations handled outside this store's working hours",
    available: (c) => c.fleet.afterHours > 0,
    render: (c) => {
      const ib = inboundAgent(c);
      const stl = ib?.report.speedToLead;
      return (
        <div className="flex flex-col gap-4">
          <Stats
            items={[
              { label: "Handled after hours", value: fmtInt(c.fleet.afterHours), sub: "conversations outside opening hours", accent: "#0891b2" },
              { label: "Share of all conversations", value: `${pct(c.fleet.afterHours, c.fleet.conversations || 1)}%` },
              ...(stl ? [{ label: "New leads caught instantly", value: fmtInt(stl.afterHoursInstant), sub: "answered on arrival, after hours" }] : []),
              { label: "Staff time spent", value: "0 min", sub: "no one had to be on shift", accent: "#15803d" },
            ]}
          />
          {ib && (
            <Card title="When the calls come in" sub="Activity by hour of day">
              <TrendBars values={ib.hourly} labels={HOURS} height={96} />
              <Note>Bars outside your opening hours are conversations that would otherwise have gone to voicemail.</Note>
            </Card>
          )}
        </div>
      );
    },
  },

  // 10 ────────────────────────────────────────────────────────────────────────
  {
    id: "outbound-campaigns",
    keywords: ["campaign","bdc","dialer","outreach"],
    title: "Outbound campaign performance",
    question: "Which outbound campaigns are producing appointments?",
    category: "Outbound",
    who: "BDC manager",
    source: "Active outbound campaigns and how every worked lead ended",
    available: (c) => (outboundAgent(c)?.report.activeCampaigns?.length ?? 0) > 0 || (outboundAgent(c)?.report.outcomes?.length ?? 0) > 0,
    render: (c) => {
      const ob = outboundAgent(c)!;
      const camps = ob.report.activeCampaigns ?? [];
      const slices = ob.report.outcomes ?? [];
      return (
        <div className="flex flex-col gap-4">
          <Stats
            items={[
              { label: "Leads dialled", value: fmtInt(ob.metrics.calls) },
              { label: "Real conversations", value: fmtInt(ob.metrics.conversations), sub: `${pct(ob.metrics.conversations, ob.metrics.calls || 1)}% connected` },
              { label: "Qualified", value: fmtInt(ob.metrics.qualified), accent: "#0891b2" },
              { label: "Appointments", value: fmtInt(ob.metrics.appointments), accent: "#15803d" },
            ]}
          />
          {camps.length > 0 && (
            <Card title="Active campaigns" sub="Enrolled → appointments booked" pad={false}>
              <Table
                head={[{ label: "Campaign" }, { label: "Enrolled", align: "right" }, { label: "Appointments", align: "right" }, { label: "Rate", align: "right" }, { label: "Warm leads", align: "right" }, { label: "Opt-outs", align: "right" }]}
                rows={[...camps].sort((a, b) => b.enrolled - a.enrolled).map((k) => [
                  <span key="n" className="font-semibold text-[#111]">{k.name}</span>,
                  fmtInt(k.enrolled),
                  <b key="a" style={{ color: k.appts ? "#15803d" : "#9ca3af" }}>{fmtInt(k.appts)}</b>,
                  `${k.apptRate}%`,
                  fmtInt(k.warmLeads),
                  <span key="o" style={{ color: k.optOuts ? "#dc2626" : "#9ca3af" }}>{fmtInt(k.optOuts)}</span>,
                ])}
              />
            </Card>
          )}
          {slices.length > 0 && (
            <Card title="Where every worked lead stands" sub="Best outcome first">
              <RankedOutcomeTable slices={slices} />
            </Card>
          )}
        </div>
      );
    },
  },

  // 11 ────────────────────────────────────────────────────────────────────────
  {
    id: "agent-scorecard",
    keywords: ["compare","scorecard","performance","versus"],
    title: "Agent scorecard",
    question: "How do the inbound and outbound agents compare?",
    category: "Team",
    who: "GM · sales manager",
    source: "Per-agent funnel from leads worked through to appointments",
    available: (c) => scopedAgents(c).length > 0,
    render: (c) => (
      <div className="flex flex-col gap-4">
        <Card title="Side by side" sub={c.periodLabel} pad={false}>
          <Table
            head={[{ label: "Agent" }, { label: "Leads", align: "right" }, { label: "Conversations", align: "right" }, { label: "Qualified", align: "right" }, { label: "Appointments", align: "right" }, { label: "Close rate", align: "right" }, { label: "Talk time", align: "right" }]}
            rows={scopedAgents(c).map((a) => [
              <span key="n" className="font-semibold text-[#111]">{a.report.summary.person || a.name} <span className="font-normal text-[#9ca3af]">· {a.dir}</span></span>,
              fmtInt(a.leadFunnel?.contacted ?? a.report.leadsAttempted),
              fmtInt(a.metrics.conversations),
              fmtInt(a.metrics.qualified),
              <b key="a" style={{ color: a.metrics.appointments ? "#15803d" : "#9ca3af" }}>{fmtInt(a.metrics.appointments)}</b>,
              fmtRate(a.metrics.appointments, a.metrics.qualified),
              fmtDuration(a.metrics.talkMinutes),
            ])}
          />
        </Card>
        {scopedAgents(c).map((a) => (
          <Card key={a.id} title={`${a.report.summary.person || a.name} · ${a.dir}`} sub="Lead → conversation → qualified → appointment">
            <StepFunnel
              stages={[
                { label: a.dir === "Inbound" ? "Leads reached" : "Leads dialled", value: a.leadFunnel?.contacted ?? a.report.leadsAttempted },
                { label: "Real conversations", value: a.metrics.conversations },
                { label: "Qualified", value: a.metrics.qualified },
                { label: "Appointments", value: a.metrics.appointments },
              ]}
            />
          </Card>
        ))}
      </div>
    ),
  },

  // 12 ────────────────────────────────────────────────────────────────────────
  {
    id: "activity-trend",
    title: "Daily activity",
    question: "Is activity trending up or down, and which days are strongest?",
    category: "Conversations",
    who: "Sales manager",
    source: "Day-by-day leads touched, qualified and booked",
    available: (c) => (scopedAgents(c)[0]?.report.dayOnDay?.length ?? 0) > 0,
    render: (c) => (
      <div className="flex flex-col gap-4">
        <Stats
          items={[
            { label: "Conversations", value: fmtInt(c.fleet.conversations), sub: c.periodLabel },
            { label: "Calls & texts", value: fmtInt(c.fleet.calls + c.fleet.smsThreads), sub: `${fmtInt(c.fleet.calls)} calls · ${fmtInt(c.fleet.smsThreads)} texts` },
            { label: "Talk time", value: fmtDuration(c.fleet.talkMinutes), sub: "handled by the AI" },
            { label: "Response time", value: c.fleet.responseTimeSec != null ? fmtSecs(c.fleet.responseTimeSec) : "—", sub: "average first reply" },
          ]}
        />
        {scopedAgents(c).map((a) => (
          <Card key={a.id} title={`${a.report.summary.person || a.name} · ${a.dir}`} sub="Touched → qualified → appointments, per day">
            <TrendBars values={a.trend7} labels={["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]} highlightLast height={92} />
          </Card>
        ))}
      </div>
    ),
  },

  // 13 ────────────────────────────────────────────────────────────────────────
  {
    id: "sold",
    keywords: ["roi","return","revenue","closed","units","sales won"],
    depts: ["sales"],
    title: "Did it turn into cars?",
    question: "Of the leads the AI worked, how many have actually sold?",
    category: "Lead quality",
    who: "GM · owner",
    source: "Every lead the AI called, matched to its status in your CRM",
    available: (c) => !!c.insights?.soldTotals && c.insights.soldTotals.touched > 0,
    takeaway: (c) => {
      const t = c.insights!.soldTotals!;
      if (!t.sold) return `The AI worked ${fmtInt(t.touched)} leads this period. None are marked sold in the CRM yet — ${fmtInt(t.active)} are still active, so this number typically fills in over the following weeks.`;
      return `${fmtInt(t.sold)} of the ${fmtInt(t.touched)} leads the AI worked are now marked sold in your CRM — ${pct(t.sold, t.touched)}%. Another ${fmtInt(t.active)} are still live.`;
    },
    render: (c) => {
      const t = c.insights!.soldTotals!;
      const rows = (c.insights!.sold ?? []).filter((r) => r.leads > 0).slice(0, 12);
      return (
        <div className="flex flex-col gap-4">
          <Stats
            items={[
              { label: "Leads the AI worked", value: fmtInt(t.touched), sub: "called at least once this period" },
              { label: "Now sold", value: fmtInt(t.sold), sub: `${pct(t.sold, t.touched)}% of leads worked`, accent: "#15803d" },
              { label: "Still active", value: fmtInt(t.active), sub: "in play — keep working these", accent: "#0891b2" },
              { label: "Closed out", value: fmtInt(t.lost), sub: "duplicate, bad or no intent", accent: "#9ca3af" },
            ]}
          />
          <Card title="Where every worked lead stands today" sub="Current status in your CRM, biggest group first">
            <RankBars rows={rows.map((r) => ({ label: r.label, value: r.leads }))} accent="#813fed" />
            <Note>
              Status is read live from your CRM, so a lead the AI called last month and your team sold last
              week counts here. Sales take time — expect this to keep filling in after the period closes.
            </Note>
          </Card>
        </div>
      );
    },
  },

  // 14 ────────────────────────────────────────────────────────────────────────
  {
    id: "vehicles",
    keywords: ["models","makes","inventory demand","voi","interest"],
    depts: ["sales"],
    title: "Vehicles customers are asking for",
    question: "Which makes and models are the leads we spoke to actually shopping?",
    category: "Lead quality",
    who: "GM · inventory manager",
    source: "Vehicle-of-interest records on the leads the AI called",
    available: (c) => (c.insights?.vehicles?.length ?? 0) > 0,
    takeaway: (c) => {
      const v = c.insights!.vehicles!;
      const top = v[0];
      const total = v.reduce((s, x) => s + x.leads, 0);
      return `${top.make} ${top.model} is the most-wanted vehicle among the leads the AI spoke to — ${fmtInt(top.leads)} of ${fmtInt(total)} recorded interests (${pct(top.leads, total)}%). The top three account for ${pct(v.slice(0, 3).reduce((s, x) => s + x.leads, 0), total)}%.`;
    },
    render: (c) => {
      const v = c.insights!.vehicles!;
      const total = v.reduce((s, x) => s + x.leads, 0);
      const known = v.reduce((s, x) => s + x.newCount + x.usedCount, 0);
      const newN = v.reduce((s, x) => s + x.newCount, 0);
      return (
        <div className="flex flex-col gap-4">
          <Stats
            items={[
              { label: "Vehicles of interest", value: fmtInt(total), sub: `${v.length} distinct models` },
              { label: "Most wanted", value: `${v[0].make} ${v[0].model}`, sub: `${fmtInt(v[0].leads)} interested leads`, accent: "#813fed" },
              ...(known > 0
                ? [{ label: "New vs used", value: `${pct(newN, known)}% new`, sub: `where recorded (${fmtInt(known)} of ${fmtInt(total)})` }]
                : []),
            ]}
          />
          <Card title="Demand by model" sub="Leads that named this vehicle — stock against this list" pad={false}>
            <Table
              head={[{ label: "Vehicle" }, { label: "Interested leads", align: "right" }, { label: "Share", align: "right" }, { label: "Years", align: "right" }, { label: "New / used", align: "right" }]}
              rows={v.map((x) => [
                <span key="v" className="font-semibold text-[#111]">{x.make} {x.model}</span>,
                <b key="l">{fmtInt(x.leads)}</b>,
                `${pct(x.leads, total)}%`,
                x.years || "—",
                x.newCount + x.usedCount > 0 ? `${fmtInt(x.newCount)} / ${fmtInt(x.usedCount)}` : "—",
              ])}
            />
          </Card>
          <Note>
            Taken from the vehicle-of-interest record your CRM holds against each lead. New/used is only
            recorded on some of them, so that column covers the ones where it is known.
          </Note>
        </div>
      );
    },
  },

  // 15 ────────────────────────────────────────────────────────────────────────
  {
    id: "transfer-routing",
    title: "Where transfers go",
    question: "When the AI puts a customer through, which department picks up?",
    category: "Team",
    who: "Sales manager · receptionist",
    source: "Every transfer the AI placed, by department and destination",
    available: (c) => (c.insights?.routing?.length ?? 0) > 0,
    takeaway: (c) => {
      const r = c.insights!.routing!;
      const total = r.reduce((s, x) => s + x.transfers, 0);
      const top = r[0];
      return `${fmtInt(total)} transfers were placed. Most went to ${top.department} (${pct(top.transfers, total)}%). If a department here looks busier than you expect, that is where your phone load actually is.`;
    },
    render: (c) => {
      const r = c.insights!.routing!;
      const total = r.reduce((s, x) => s + x.transfers, 0);
      const byDept = Object.entries(
        r.reduce<Record<string, number>>((acc, x) => ({ ...acc, [x.department]: (acc[x.department] ?? 0) + x.transfers }), {}),
      ).sort((a, b) => b[1] - a[1]);
      return (
        <div className="flex flex-col gap-4">
          <Stats
            items={[
              { label: "Transfers placed", value: fmtInt(total), sub: c.periodLabel },
              { label: "Departments involved", value: fmtInt(byDept.length) },
              { label: "Busiest", value: byDept[0][0], sub: `${pct(byDept[0][1], total)}% of transfers`, accent: "#2563eb" },
            ]}
          />
          <Card title="By department" sub="Where the calls were sent">
            <RankBars rows={byDept.map(([d, n]) => ({ label: d, value: n }))} accent="#2563eb" />
          </Card>
          <Card title="Detail" sub="Department and how the destination was addressed" pad={false}>
            <Table
              head={[{ label: "Department" }, { label: "Destination type" }, { label: "Transfers", align: "right" }, { label: "Share", align: "right" }]}
              rows={r.map((x) => [
                <span key="d" className="font-semibold text-[#111]">{x.department}</span>,
                x.destinationType,
                fmtInt(x.transfers),
                `${pct(x.transfers, total)}%`,
              ])}
            />
          </Card>
        </div>
      );
    },
  },

  // 16 ────────────────────────────────────────────────────────────────────────
  {
    id: "texts",
    keywords: ["sms","text","messaging","reply rate"],
    title: "Text message performance",
    question: "Are customers replying to our texts?",
    category: "Conversations",
    who: "BDC manager",
    source: "Text conversations handled by the AI and the replies they drew",
    available: (c) => (c.insights?.sms?.threads ?? 0) > 0,
    takeaway: (c) => {
      const s = c.insights!.sms!;
      return `${fmtInt(s.repliedThreads)} of ${fmtInt(s.threads)} text conversations got a reply — ${pct(s.repliedThreads, s.threads)}%. ${fmtInt(s.outbound)} messages went out and ${fmtInt(s.inbound)} came back.`;
    },
    render: (c) => {
      const s = c.insights!.sms!;
      return (
        <div className="flex flex-col gap-4">
          <Stats
            items={[
              { label: "Conversations", value: fmtInt(s.threads), sub: "text threads handled" },
              { label: "Replied", value: `${pct(s.repliedThreads, s.threads)}%`, sub: `${fmtInt(s.repliedThreads)} customers wrote back`, accent: "#15803d" },
              { label: "Messages sent", value: fmtInt(s.outbound) },
              { label: "Messages received", value: fmtInt(s.inbound), accent: "#0891b2" },
            ]}
          />
          <Card title="Reply rate" sub="Threads that drew at least one customer reply">
            <RankBars
              rows={[
                { label: "Replied", value: s.repliedThreads },
                { label: "No reply", value: Math.max(0, s.threads - s.repliedThreads) },
              ]}
              accent="#0891b2"
            />
            <Note>
              A reply means a real person wrote back — the strongest signal a text campaign is landing.
              Threads with no reply are worth a different opening message or a call instead.
            </Note>
          </Card>
        </div>
      );
    },
  },

  // 17 ────────────────────────────────────────────────────────────────────────
  {
    id: "coverage",
    keywords: ["staffing","busiest","peak","cover","roster","hours"],
    title: "When the calls come in",
    question: "What hours and days is the phone actually busy?",
    category: "Speed & response",
    who: "GM · sales manager",
    source: "Inbound calls by hour and weekday, in your store's timezone",
    available: (c) => (c.insights?.hours?.length ?? 0) > 0,
    takeaway: (c) => {
      const h = c.insights!.hours!;
      const total = h.reduce((s, x) => s + x.calls, 0);
      const byHour = new Map<number, number>();
      h.forEach((x) => byHour.set(x.hour, (byHour.get(x.hour) ?? 0) + x.calls));
      const peak = [...byHour.entries()].sort((a, b) => b[1] - a[1])[0];
      const early = h.filter((x) => x.hour < 8 || x.hour >= 19).reduce((s, x) => s + x.calls, 0);
      return `Your busiest hour is ${hourLabel(peak[0])}. ${fmtInt(early)} of ${fmtInt(total)} calls (${pct(early, total)}%) landed before 8am or after 7pm — outside a typical shift.`;
    },
    render: (c) => {
      const h = c.insights!.hours!;
      const byHour = new Map<number, number>();
      h.forEach((x) => byHour.set(x.hour, (byHour.get(x.hour) ?? 0) + x.calls));
      const hours = Array.from({ length: 24 }, (_, i) => byHour.get(i) ?? 0);
      const max = Math.max(1, ...h.map((x) => x.calls));
      const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
      const cell = (d: number, hr: number) => h.find((x) => x.weekday === d + 1 && x.hour === hr)?.calls ?? 0;
      return (
        <div className="flex flex-col gap-4">
          <Card title="Calls by hour of day" sub="All weekdays combined">
            <TrendBars values={hours.slice(6, 21)} labels={Array.from({ length: 15 }, (_, i) => hourLabel(i + 6))} height={100} />
          </Card>
          <Card title="Hour by weekday" sub="Darker means busier — plan cover around the dark blocks">
            <div className="overflow-x-auto">
              <table className="min-w-[560px] border-separate" style={{ borderSpacing: 2 }}>
                <thead>
                  <tr>
                    <th />
                    {Array.from({ length: 15 }, (_, i) => (
                      <th key={i} className="pb-1 text-[9px] font-semibold text-[#9ca3af]">{i + 6}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {days.map((d, di) => (
                    <tr key={d}>
                      <td className="pr-2 text-right text-[10.5px] font-semibold text-[#6b7280]">{d}</td>
                      {Array.from({ length: 15 }, (_, i) => {
                        const n = cell(di, i + 6);
                        return (
                          <td key={i} title={`${d} ${hourLabel(i + 6)} · ${n} calls`}
                              className="h-6 w-6 rounded text-center text-[9px] font-bold"
                              style={{ background: n ? `rgba(129,63,237,${0.12 + 0.78 * (n / max)})` : "#f4f5f7", color: n / max > 0.55 ? "#fff" : "#6b7280" }}>
                            {n || ""}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Note>Hours shown in your store&apos;s local time. Use this to line staffing up with the real call pattern.</Note>
          </Card>
        </div>
      );
    },
  },

  // 18 ────────────────────────────────────────────────────────────────────────
  {
    id: "objections",
    keywords: ["opt out","not interested","rejection","pushback"],
    title: "Why leads don't convert",
    question: "What do customers push back on, and why do leads end?",
    category: "Conversations",
    who: "Sales manager · trainer",
    source: "Objections raised by customers during calls",
    // report_objections holds two kinds of row: `theme` (what customers actually pushed back on) and
    // `outbound_outcome` (dispositions). Only the themes are objections.
    available: (c) => objectionRows(c).rows.length > 0,
    takeaway: (c) => {
      const { rows, kind } = objectionRows(c);
      const total = rows.reduce((s, x) => s + x.count, 0);
      const top = rows[0];
      return kind === "theme"
        ? `"${top.label}" is what your customers push back on most — ${fmtInt(top.count)} of ${fmtInt(total)} recorded (${pct(top.count, total)}%). Worth building an answer into your team's script.`
        : `"${top.label}" is the most common reason a lead ended — ${fmtInt(top.count)} of ${fmtInt(total)} (${pct(top.count, total)}%). The reasons below are where outreach stops converting.`;
    },
    render: (c) => {
      const { rows, kind } = objectionRows(c);
      const total = rows.reduce((s, x) => s + x.count, 0);
      const theme = kind === "theme";
      return (
        <div className="flex flex-col gap-4">
          <Stats
            items={[
              { label: theme ? "Objections recorded" : "Leads ended", value: fmtInt(total) },
              { label: "Distinct reasons", value: fmtInt(rows.length) },
              { label: "Most common", value: rows[0].label, accent: "#d97706" },
            ]}
          />
          <Card
            title={theme ? "What customers push back on" : "Why leads ended"}
            sub={theme ? "Times raised across this period's calls" : "Recorded outcome on outbound leads that stopped"}
          >
            <RankBars rows={rows.map((x) => ({ label: x.label, value: x.count, note: `${pct(x.count, total)}%` }))} accent="#d97706" />
            <Note>
              {theme
                ? "Each of these is a coaching opportunity — the top one or two are where a better answer moves the most deals."
                : "Opt-outs and wrong numbers point at list quality; \u201cnot interested\u201d and \u201calready purchased\u201d point at timing. Both are fixable before the next campaign."}
            </Note>
          </Card>
        </div>
      );
    },
  },

  // 19 ────────────────────────────────────────────────────────────────────────
  {
    id: "appt-status",
    keywords: ["show rate","no show","noshow","kept","turned up","attendance"],
    title: "Did the appointments show?",
    question: "Of the appointments booked, how many actually turned up?",
    category: "Appointments",
    who: "Sales manager",
    source: "Appointment records and their current status",
    available: (c) => apptTotals(c).booked > 0,
    takeaway: (c) => {
      const t = apptTotals(c);
      const settled = t.showed + t.no_show;
      if (!settled) return `${fmtInt(t.booked)} appointments were booked and ${fmtInt(t.upcoming)} are still to come, so show rate fills in as those dates pass.`;
      return `${fmtInt(t.showed)} of the ${fmtInt(settled)} appointments whose date has passed actually showed — ${pct(t.showed, settled)}%. ${fmtInt(t.no_show)} did not turn up${t.cancelled ? ` and ${fmtInt(t.cancelled)} cancelled ahead of time` : ""}.`;
    },
    render: (c) => {
      const t = apptTotals(c);
      const settled = t.showed + t.no_show;
      const rows = (c.metrics?.appt_status ?? []).filter((r) => r.booked > 0);
      return (
        <div className="flex flex-col gap-4">
          <Stats
            items={[
              { label: "Booked", value: fmtInt(t.booked), sub: c.periodLabel },
              { label: "Showed up", value: fmtInt(t.showed), sub: settled ? `${pct(t.showed, settled)}% of those due` : "none due yet", accent: "#15803d" },
              { label: "No-shows", value: fmtInt(t.no_show), accent: t.no_show > 0 ? "#dc2626" : undefined },
              { label: "Still to come", value: fmtInt(t.upcoming), sub: "dates in the future", accent: "#0891b2" },
            ]}
          />
          <Card title="Outcome of every booking" sub="Cancellations are counted separately from no-shows">
            <RankBars
              rows={[
                { label: "Showed up", value: t.showed },
                { label: "No-show", value: t.no_show },
                { label: "Cancelled", value: t.cancelled },
                { label: "Still upcoming", value: t.upcoming },
              ].filter((r) => r.value > 0)}
              accent="#15803d"
            />
          </Card>
          {rows.length > 1 && (
            <Card title="By how it was booked" sub="Phone call vs text" pad={false}>
              <Table
                head={[{ label: "Booked via" }, { label: "Booked", align: "right" }, { label: "Showed", align: "right" }, { label: "No-show", align: "right" }, { label: "Show rate", align: "right" }]}
                rows={rows.map((r) => [
                  <span key="v" className="font-semibold text-[#111]">{r.booked_via || "—"}</span>,
                  fmtInt(r.booked),
                  fmtInt(r.showed),
                  fmtInt(r.no_show),
                  r.showed + r.no_show ? `${pct(r.showed, r.showed + r.no_show)}%` : "—",
                ])}
              />
            </Card>
          )}
        </div>
      );
    },
  },

  // 20 ────────────────────────────────────────────────────────────────────────
  {
    id: "best-calls",
    title: "Best conversations",
    question: "Which calls went really well — worth listening to?",
    category: "Conversations",
    who: "Sales manager · trainer",
    source: "The period's standout booked calls",
    available: (c) => (c.metrics?.highlights?.length ?? 0) > 0,
    takeaway: (c) => `${fmtInt(c.metrics!.highlights!.length)} calls stood out this period — these are the ones worth playing back to the team.`,
    render: (c) => (
      <Card title="Worth a listen" sub="Standout calls that ended in a booking" pad={false}>
        <Table
          head={[{ label: "What happened" }, { label: "Direction" }, { label: "When", align: "right" }]}
          rows={c.metrics!.highlights!.slice(0, 25).map((h) => [
            <span key="t" className="text-[#374151]">{h.title || "—"}</span>,
            <span key="d" className="text-[#9ca3af]">{h.direction || "—"}</span>,
            h.occurred_on ?? "",
          ])}
        />
      </Card>
    ),
  },

  // 21 ────────────────────────────────────────────────────────────────────────
  {
    id: "end-to-end",
    keywords: ["containment","deflection","minutes saved","self serve","resolution"],
    title: "Handled without your team",
    question: "How many calls did the AI finish on its own — and how much phone time did that save?",
    category: "Team",
    who: "GM · owner",
    source: "Every sales call, by how it ended and how long it ran",
    available: (c) => handlingTotals(c) !== null,
    takeaway: (c) => {
      const h = handlingTotals(c)!;
      if (!h.connected) return "No connected sales calls in this period yet.";
      return `${fmtInt(h.solo)} of ${fmtInt(h.connected)} connected calls (${pct(h.solo, h.connected)}%) were finished by the AI without anyone on your team picking up — ${fmtHours(h.minutesSaved)} of phone time your staff did not spend. The other ${fmtInt(h.transferred)} reached a person.`;
    },
    render: (c) => {
      const h = handlingTotals(c)!;
      const shiftDays = h.minutesSaved / 480; // an 8-hour shift
      return (
        <div className="flex flex-col gap-4">
          <Stats
            items={[
              { label: "Handled end to end", value: `${pct(h.solo, h.connected)}%`, sub: `${fmtInt(h.solo)} of ${fmtInt(h.connected)} connected calls`, accent: "#15803d" },
              { label: "Phone time saved", value: fmtHours(h.minutesSaved), sub: shiftDays >= 0.5 ? `about ${shiftDays.toFixed(1)} full shifts` : "of staff time on the phone", accent: "#813fed" },
              { label: "Needed a person", value: fmtInt(h.transferred), sub: `${pct(h.transferred, h.connected)}% were put through`, accent: "#2563eb" },
              { label: "Never connected", value: fmtInt(h.unreached), sub: "voicemail, no answer or declined" },
            ]}
          />

          <Card title="What happened on every call" sub="Connected calls only — the ones where someone was actually on the line">
            <RankBars
              rows={[
                { label: "AI finished the call", value: h.solo, note: `${pct(h.solo, h.connected)}%` },
                { label: "Put through to a person", value: h.transferred, note: `${pct(h.transferred, h.connected)}%` },
                ...(h.transferFailed ? [{ label: "Transfer didn't connect", value: h.transferFailed }] : []),
              ]}
              accent="#15803d"
            />
            <Note>
              &ldquo;Handled end to end&rdquo; means the call ended without being transferred to your team. Time
              saved is the talk time on those calls — the minutes someone at the store would otherwise have
              been on the phone. Calls that reached a person are excluded entirely, even though the AI did
              the intake first, so this figure is deliberately on the low side.
            </Note>
          </Card>

          {resolutionSplit(c) && (
            <Card title="Did customers get their answer?" sub="Questions raised on calls, and how many were resolved">
              <div className="mb-3">
                <Stats
                  items={[
                    { label: "Question resolution rate", value: `${pct(resolutionSplit(c)!.resolved, resolutionSplit(c)!.raised)}%`, sub: `${fmtInt(resolutionSplit(c)!.resolved)} of ${fmtInt(resolutionSplit(c)!.raised)} questions answered`, accent: "#0891b2" },
                    { label: "Questions asked", value: fmtInt(resolutionSplit(c)!.raised), sub: "excludes plain requests to reach a person" },
                  ]}
                />
              </div>
              <Table
                head={[{ label: "What they asked about" }, { label: "Times asked", align: "right" }, { label: "Answered", align: "right" }, { label: "Rate", align: "right" }]}
                rows={resolutionSplit(c)!.rows.map((r) => [
                  <span key="i" className="font-semibold text-[#111]">{r.intent}</span>,
                  fmtInt(r.raised),
                  <b key="r" style={{ color: r.resolved ? "#15803d" : "#9ca3af" }}>{fmtInt(r.resolved)}</b>,
                  <span key="p" style={{ color: r.raised >= 3 && r.resolved / r.raised < 0.34 ? "#dc2626" : "#374151" }}>
                    {pct(r.resolved, r.raised)}%
                  </span>,
                ])}
              />
              <Note>
                A low rate on a question your customers ask often is the most useful line here — it is
                usually a missing answer the AI can be taught, not a lost customer.
              </Note>
            </Card>
          )}
        </div>
      );
    },
  },

  // 23 ────────────────────────────────────────────────────────────────────────
  {
    id: "demand-vs-stock",
    keywords: ["inventory","stock","supply","order","allocation"],
    depts: ["sales"],
    title: "Demand vs what's on the lot",
    question: "Are we stocked for what customers are actually asking us about?",
    category: "Lead quality",
    who: "GM · inventory manager",
    source: "Vehicle interest on the leads the AI called, against units listed for sale",
    agents: ["sales_ib", "sales_ob"],
    available: (c) => demandVsStock(c).length > 0,
    takeaway: (c) => {
      const rows = demandVsStock(c);
      const short = rows.filter((r) => r.units > 0 && r.leads / r.units >= 2).sort((a, b) => b.leads / b.units - a.leads / a.units)[0];
      const cold = rows.filter((r) => r.units >= 10 && r.leads === 0).sort((a, b) => b.units - a.units)[0];
      const parts: string[] = [];
      if (short) parts.push(`${short.make} ${short.model} is your tightest fit — ${fmtInt(short.leads)} interested leads against ${fmtInt(short.units)} in stock.`);
      if (cold) parts.push(`${fmtInt(cold.units)} ${cold.make} ${cold.model} are listed with no recorded interest this period.`);
      return parts.join(" ") || `${fmtInt(rows.length)} models matched between customer interest and your listed stock.`;
    },
    render: (c) => {
      const rows = demandVsStock(c);
      const matched = rows.filter((r) => r.units > 0 && r.leads > 0);
      const tight = rows.filter((r) => r.units > 0 && r.leads / r.units >= 2);
      const noInterest = rows.filter((r) => r.units >= 5 && r.leads === 0);
      return (
        <div className="flex flex-col gap-4">
          <Stats
            items={[
              { label: "Models customers asked about", value: fmtInt(rows.filter((r) => r.leads > 0).length) },
              { label: "Units listed", value: fmtInt(rows.reduce((s, r) => s + r.units, 0)), sub: "currently on your website" },
              { label: "Running tight", value: fmtInt(tight.length), sub: "2+ interested leads per unit", accent: tight.length ? "#dc2626" : undefined },
              { label: "Sitting quiet", value: fmtInt(noInterest.length), sub: "5+ in stock, nobody asked", accent: noInterest.length ? "#d97706" : undefined },
            ]}
          />

          <Card title="Interest against stock, model by model" sub="Leads per unit is the number to scan — high means demand is outrunning supply" pad={false}>
            <Table
              head={[{ label: "Vehicle" }, { label: "Interested leads", align: "right" }, { label: "In stock", align: "right" }, { label: "Leads per unit", align: "right" }, { label: "", align: "right" }]}
              rows={rows.slice(0, 20).map((r) => {
                const ratio = r.units ? r.leads / r.units : null;
                const flag = ratio !== null && ratio >= 2 ? "Stock up" : r.units >= 5 && r.leads === 0 ? "Needs promotion" : r.units === 0 && r.leads > 0 ? "None listed" : "";
                return [
                  <span key="v" className="font-semibold text-[#111]">{r.make} {r.model}</span>,
                  fmtInt(r.leads),
                  r.units ? fmtInt(r.units) : <span key="u" className="text-[#9ca3af]">none</span>,
                  ratio === null ? "—" : ratio.toFixed(1),
                  flag ? (
                    <span key="f" className="rounded-full px-2 py-0.5 text-[10.5px] font-bold"
                          style={{ background: flag === "Stock up" || flag === "None listed" ? "#fef2f2" : "#fffbeb", color: flag === "Stock up" || flag === "None listed" ? "#dc2626" : "#b45309" }}>
                      {flag}
                    </span>
                  ) : "",
                ];
              })}
            />
          </Card>

          <Note>
            Interest comes from the vehicle recorded against each lead the AI called; stock is what is
            listed for sale on your site right now. Hybrid versions are counted with their base model
            because stock is recorded that way. Matched on {fmtInt(matched.length)} models.
          </Note>
        </div>
      );
    },
  },

  // 24 ────────────────────────────────────────────────────────────────────────
  {
    id: "contact-effort",
    keywords: ["dials","attempts","cadence","pressure","call frequency"],
    title: "How hard we chase a lead",
    question: "How many calls does it take to reach someone — and are we calling anyone too often?",
    category: "Outbound",
    who: "BDC manager",
    source: "Outbound dials per lead across the period",
    agents: ["sales_ob", "service_ob"],
    available: (c) => (c.insights?.effort?.length ?? 0) > 0,
    takeaway: (c) => {
      const e = effortTotals(c)!;
      return `${fmtInt(e.leads)} leads were dialled ${fmtInt(e.dials)} times — ${e.avg.toFixed(1)} calls each on average. ${fmtInt(e.heavy)} leads (${pct(e.heavy, e.leads)}%) were called 6 or more times.`;
    },
    render: (c) => {
      const e = effortTotals(c)!;
      const rows = c.insights!.effort!;
      const bucket = (lo: number, hi: number) => rows.filter((r) => r.attempts >= lo && r.attempts <= hi).reduce((s, r) => s + r.leads, 0);
      return (
        <div className="flex flex-col gap-4">
          <Stats
            items={[
              { label: "Leads dialled", value: fmtInt(e.leads) },
              { label: "Calls placed", value: fmtInt(e.dials) },
              { label: "Calls per lead", value: e.avg.toFixed(1), sub: "on average", accent: "#813fed" },
              { label: "Called 6+ times", value: fmtInt(e.heavy), sub: `${pct(e.heavy, e.leads)}% of leads`, accent: e.heavy / e.leads > 0.25 ? "#dc2626" : undefined },
            ]}
          />
          <Card title="How many times each lead was called" sub="A long tail on the right is worth a look — those customers are hearing from you a lot">
            <RankBars
              rows={[
                { label: "Once", value: bucket(1, 1) },
                { label: "2–3 times", value: bucket(2, 3) },
                { label: "4–5 times", value: bucket(4, 5) },
                { label: "6–9 times", value: bucket(6, 9) },
                { label: "10 or more", value: bucket(10, 999) },
              ].filter((r) => r.value > 0)}
              accent="#813fed"
            />
            <Note>
              Counts outbound calls only, per lead, for this period. Repeated attempts are how outbound
              works — but a large group at the far end usually means the cadence is running past the point
              where anyone is going to pick up.
            </Note>
          </Card>
        </div>
      );
    },
  },

  // 24 ─── SERVICE ────────────────────────────────────────────────────────────
  {
    id: "service-bookings",
    keywords: ["service appointment","book","scheduler","ro","repair order"],
    title: "Service appointments the AI booked",
    question: "How much of the service schedule is the AI filling on its own?",
    category: "Service drive",
    who: "Service manager · fixed ops director",
    source: "Appointments the AI created, rescheduled and cancelled in your scheduler",
    depts: ["service"],
    available: (c) => svcTool(c, "create_appointment") !== null,
    takeaway: (c) => {
      const made = svcTool(c, "create_appointment")!;
      const resched = svcTool(c, "reschedule_appointment");
      const cancelled = svcTool(c, "cancel_appointment");
      const extra = resched || cancelled
        ? ` It also handled ${fmtInt((resched?.ok ?? 0) + (cancelled?.ok ?? 0))} changes to existing appointments without anyone at the desk picking up.`
        : "";
      return `${fmtInt(made.ok)} service appointments were booked straight into your scheduler by the AI.${extra}`;
    },
    render: (c) => {
      const made = svcTool(c, "create_appointment")!;
      const resched = svcTool(c, "reschedule_appointment");
      const cancelled = svcTool(c, "cancel_appointment");
      const slots = svcTool(c, "list_available_time_slots");
      return (
        <div className="flex flex-col gap-4">
          <Stats
            items={[
              { label: "Appointments booked", value: fmtInt(made.ok), sub: "written into your scheduler", accent: "#15803d" },
              { label: "Rescheduled", value: fmtInt(resched?.ok ?? 0), sub: "moved without a call to the desk" },
              { label: "Cancelled", value: fmtInt(cancelled?.ok ?? 0), sub: "freed the slot for someone else" },
              ...(made.failed
                ? [{ label: "Booking failures", value: fmtInt(made.failed), sub: `${pct(made.failed, made.ok + made.failed)}% of attempts`, accent: "#dc2626" }]
                : []),
            ]}
          />
          <Card title="The booking path" sub="Every step the AI takes to put a car on your schedule">
            <RankBars
              rows={[
                ...(slots ? [{ label: "Looked up open slots", value: slots.ok + slots.failed }] : []),
                { label: "Booked the appointment", value: made.ok },
                ...(resched ? [{ label: "Rescheduled one", value: resched.ok }] : []),
                ...(cancelled ? [{ label: "Cancelled one", value: cancelled.ok }] : []),
              ].filter((r) => r.value > 0)}
              accent="#15803d"
            />
            <Note>
              Every one of these is a call your advisors did not have to take, at the times of day the
              phones are busiest. Failures are counted separately below in Where the desk is letting
              customers down.
            </Note>
          </Card>
        </div>
      );
    },
  },

  // 25 ────────────────────────────────────────────────────────────────────────
  {
    id: "service-friction",
    keywords: ["errors","failures","broken","scheduler","friction"],
    title: "Where the desk is letting customers down",
    question: "Which service requests are failing when a customer tries to self-serve?",
    category: "Service drive",
    who: "Service manager · fixed ops director",
    source: "Success and failure of every service action the AI attempted",
    depts: ["service"],
    available: (c) => svcRows(c).some((t) => t.failed > 0),
    takeaway: (c) => {
      const worst = svcRows(c)
        .filter((t) => t.ok + t.failed >= 10)
        .sort((a, b) => b.failed / (b.ok + b.failed) - a.failed / (a.ok + a.failed))[0];
      if (!worst) return "Nothing is failing often enough this period to be worth chasing.";
      const total = worst.ok + worst.failed;
      return `${svcLabel(worst.tool)} fails ${pct(worst.failed, total)}% of the time — ${fmtInt(worst.failed)} of ${fmtInt(total)} attempts. Every one of those is a customer who wanted to sort something themselves and ended up needing your desk.`;
    },
    render: (c) => {
      const rows = svcRows(c)
        .filter((t) => t.ok + t.failed > 0)
        .map((t) => ({ ...t, total: t.ok + t.failed, rate: t.failed / (t.ok + t.failed) }))
        .sort((a, b) => b.rate - a.rate || b.total - a.total);
      const failing = rows.filter((r) => r.failed > 0);
      return (
        <div className="flex flex-col gap-4">
          <Stats
            items={[
              { label: "Actions attempted", value: fmtInt(rows.reduce((s, r) => s + r.total, 0)), sub: c.periodLabel },
              { label: "Failed", value: fmtInt(rows.reduce((s, r) => s + r.failed, 0)), accent: "#dc2626" },
              { label: "Requests with failures", value: fmtInt(failing.length), sub: `of ${fmtInt(rows.length)} types` },
            ]}
          />
          <Card title="Failure rate by request" sub="Worst first — anything above a few percent is worth a look" pad={false}>
            <Table
              head={[{ label: "What the customer wanted" }, { label: "Attempts", align: "right" }, { label: "Failed", align: "right" }, { label: "Failure rate", align: "right" }]}
              rows={rows.map((r) => [
                <span key="t" className="font-semibold text-[#111]">{svcLabel(r.tool)}</span>,
                fmtInt(r.total),
                <span key="f" style={{ color: r.failed ? "#dc2626" : "#9ca3af" }}>{fmtInt(r.failed)}</span>,
                <span key="r" className="font-semibold" style={{ color: r.rate >= 0.25 ? "#dc2626" : r.rate >= 0.1 ? "#d97706" : "#374151" }}>
                  {pct(r.failed, r.total)}%
                </span>,
              ])}
            />
          </Card>
          <Note>
            A high failure rate here is almost never the customer&apos;s fault — it is usually the
            scheduler refusing a lookup or an appointment record the AI cannot see. Worth raising with
            your Spyne team with this list in hand.
          </Note>
        </div>
      );
    },
  },

  // 26 ────────────────────────────────────────────────────────────────────────
  {
    id: "service-transport",
    keywords: ["loaner","shuttle","courtesy car","ride","transportation"],
    title: "Loaner and shuttle demand",
    question: "How many service customers need a ride, and are we set up for it?",
    category: "Service drive",
    who: "Service manager",
    source: "Transportation options the AI looked up for customers",
    depts: ["service"],
    available: (c) => (svcTool(c, "list_transportation_options")?.ok ?? 0) > 0,
    takeaway: (c) => {
      const t = svcTool(c, "list_transportation_options")!;
      const booked = svcTool(c, "create_appointment")?.ok ?? 0;
      /* Deliberately NOT a percentage. The two are different populations — a customer can ask about a
       * ride without booking, and did here — so the share ran to 102%, which reads as a broken number.
       * Two counts side by side make the same point and cannot exceed anything. */
      const vs = booked ? ` — against ${fmtInt(booked)} appointments booked in the same period.` : ".";
      return `${fmtInt(t.ok)} service customers asked what you could do about getting them around while their car is in${vs}`;
    },
    render: (c) => {
      const t = svcTool(c, "list_transportation_options")!;
      const booked = svcTool(c, "create_appointment")?.ok ?? 0;
      return (
        <div className="flex flex-col gap-4">
          <Stats
            items={[
              { label: "Asked about a ride", value: fmtInt(t.ok), sub: "loaner, shuttle or pick-up", accent: "#0891b2" },
              ...(booked ? [{ label: "Appointments booked", value: fmtInt(booked), sub: "same period, for comparison" }] : []),
            ]}
          />
          <Card title="Why this number matters">
            <Note>
              Transportation is the most common reason a customer defers service they have already agreed
              to. A high number here is demand you are being asked to meet — if your loaner fleet or
              shuttle window cannot cover it, that is where the deferred work is going.
            </Note>
          </Card>
        </div>
      );
    },
  },

  // 27 ────────────────────────────────────────────────────────────────────────
  {
    id: "service-recall",
    keywords: ["recall","warranty","campaign","eligibility"],
    title: "Recall and warranty checks",
    question: "How much open recall and warranty work are we finding on the phone?",
    category: "Service drive",
    who: "Service manager · fixed ops director",
    source: "Vehicle eligibility checks the AI ran during service calls",
    depts: ["service"],
    available: (c) => (svcTool(c, "check_vehicle_eligibility")?.ok ?? 0) > 0,
    takeaway: (c) => {
      const e = svcTool(c, "check_vehicle_eligibility")!;
      const booked = svcTool(c, "create_appointment")?.ok ?? 0;
      return `The AI checked ${fmtInt(e.ok)} vehicles for open recall or warranty cover while it had the customer on the phone${booked ? `, against ${fmtInt(booked)} appointments booked` : ""}.`;
    },
    render: (c) => {
      const e = svcTool(c, "check_vehicle_eligibility")!;
      const lookups = svcTool(c, "lookup_customer");
      const booked = svcTool(c, "create_appointment")?.ok ?? 0;
      return (
        <div className="flex flex-col gap-4">
          <Stats
            items={[
              { label: "Vehicles checked", value: fmtInt(e.ok), sub: "recall and warranty eligibility", accent: "#813fed" },
              ...(lookups ? [{ label: "Customers looked up", value: fmtInt(lookups.ok), sub: "matched to your records" }] : []),
              ...(booked ? [{ label: "Appointments booked", value: fmtInt(booked), accent: "#15803d" }] : []),
            ]}
          />
          <Card title="Why this number matters">
            <Note>
              Recall work is warranty-paid and it brings a customer into the drive who may not otherwise
              have come. Every check here happened while you already had them on the phone — the cheapest
              moment there is to find the work.
            </Note>
          </Card>
        </div>
      );
    },
  },
];

const hourLabel = (h: number) => (h === 0 ? "12am" : h < 12 ? `${h}am` : h === 12 ? "12pm" : `${h - 12}pm`);

const HOURS = ["8a", "9a", "10a", "11a", "12p", "1p", "2p", "3p", "4p", "5p", "6p", "7p"];

/** Reports that have live data for this rooftop + window, in catalog order. */
export function availableReports(c: ReportCtx): ReportDef[] {
  return REPORTS.filter((r) => {
    if (r.depts && c.dept && c.dept !== "all" && !r.depts.includes(c.dept)) return false;
    try {
      return r.available(c);
    } catch {
      return false; // a malformed feed must never take the whole library down
    }
  });
}

export const REPORT_CATEGORIES = ["Appointments", "Speed & response", "Lead quality", "Conversations", "Team", "Outbound", "Service drive"] as const;

export { Stats as ReportStats, Table as ReportTable, RankBars as ReportRankBars, MetricTile };

/* ── By-agent → report library bridge ─────────────────────────────────────────────────────────────
 * The agent report answers "how is this agent doing"; the library answers everything around it. Rather
 * than duplicate reports onto the agent page, the page offers the ones that bear on the agent you're
 * looking at and links straight into them.
 *
 * Availability is NOT evaluated here: the agent page doesn't load the library's data sources (that would
 * mean four extra fetches on every agent view), so the strip lists what's relevant and the library shows
 * the real state on arrival. */
export function reportsForAgent(agentId: string): ReportDef[] {
  const id = agentId as "sales_ib" | "sales_ob";
  const relevant = REPORTS.filter((r) => !r.agents || r.agents.includes(id));
  /* Reports that name this agent explicitly come FIRST. Catalog order alone put the six oldest entries
   * at the front of the strip regardless of which agent you were looking at — an outbound agent led with
   * inbound speed-to-lead. Beyond that, the direction's own category is preferred. */
  const preferred = id === "sales_ob" ? "Outbound" : "Speed & response";
  const rank = (r: ReportDef) => (r.agents?.includes(id) ? 0 : r.category === preferred ? 1 : 2);
  return relevant.slice().sort((a, b) => rank(a) - rank(b));
}

/** Deep link into one library report, carrying the rooftop + window already on screen. */
export function libraryHref(reportId: string, navQuery: string, fromAgent?: string): string {
  const sep = navQuery ? (navQuery.startsWith("?") ? "&" : "?") : "?";
  const from = fromAgent ? `&from=agent&agent=${encodeURIComponent(fromAgent)}` : "";
  return `/reports/library${navQuery}${sep}report=${encodeURIComponent(reportId)}${from}`;
}

/* The strip itself. Six is deliberate: enough to feel like a library, few enough to scan without
 * turning the bottom of the agent report into a second navigation problem. */
export function MoreReports({ agentId, onOpenLibrary, max = 6 }: { agentId: string; onOpenLibrary?: (reportId?: string) => void; max?: number }) {
  const picks = reportsForAgent(agentId).slice(0, max);
  if (!picks.length) return null;
  return (
    <Card
      title="More reports on this data"
      sub="Same period, same rooftop — open any of these for the detail behind the numbers above"
      right={
        <button
          type="button"
          onClick={() => onOpenLibrary?.()}
          className="no-print flex-none rounded-lg border border-[#e5e7eb] bg-white px-3 py-1.5 text-[11.5px] font-semibold text-[#813fed] hover:bg-[#faf8ff]"
        >
          All reports →
        </button>
      }
    >
      <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
        {picks.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => onOpenLibrary?.(r.id)}
            className="flex h-full flex-col gap-1 rounded-xl border border-[#e5e7eb] bg-white px-4 py-3 text-left transition-shadow hover:border-[#d6c9f5] hover:shadow-md"
          >
            <span className="text-[10px] font-bold uppercase tracking-wide text-[#c3b5e8]">{r.category}</span>
            <span className="text-[12.5px] font-bold leading-tight text-[#111]">{r.title}</span>
            <span className="text-[11px] leading-snug text-[#6b7280]">{r.question}</span>
          </button>
        ))}
      </div>
    </Card>
  );
}

// ───────────────────────── export ─────────────────────────

/* ONE report → the sheets behind it, for XLSX/CSV download.
 *
 * Deliberately a single switch rather than a `sheets()` on each definition: the export is the part most
 * likely to silently rot (a report changes, its export doesn't), and having every one in a single file
 * makes a missing or stale case obvious at a glance. A report with no case falls through to its headline
 * numbers rather than downloading an empty workbook.
 *
 * Every sheet's first row is its header row, per ExportSheet. */
export function reportSheets(report: ReportDef, c: ReportCtx): ExportSheet[] {
  const meta: ExportSheet = {
    name: "About",
    rows: [
      ["Report", report.title],
      ["Question", report.question],
      ["Period", c.periodLabel],
      ["Source", report.source],
      ["Generated", new Date().toISOString().slice(0, 16).replace("T", " ")],
    ],
  };
  const sheets: ExportSheet[] = [];

  switch (report.id) {
    case "appointments":
      sheets.push({ name: "Summary", rows: [["Measure", "Value"],
        ["Booked by the AI", c.fleet.appointments], ["Also booked after an AI touch", c.fleet.appointmentsAssisted],
        ["Qualified leads", c.fleet.qualified]] });
      sheets.push({ name: "By agent", rows: [["Agent", "Direction", "Appointments"],
        ...scopedAgents(c).map((a) => [a.report.summary.person || a.name, a.dir, a.metrics.appointments])] });
      sheets.push({ name: "Appointments", rows: [["Customer", "Vehicle", "When", "Booked at"],
        ...c.namedAppts.map((m) => [m.customer, m.vehicle ?? "", m.when ?? "", m.bookedAt ?? ""])] });
      break;

    case "speed-to-lead": {
      const stl = inboundAgent(c)?.report.speedToLead;
      if (stl) sheets.push({ name: "Speed to lead", rows: [["Measure", "Value"],
        ["Average first touch", stl.avg], ["Within 5 minutes %", stl.pctWithin5],
        ["New CRM leads", stl.crmLeadsNew], ["Touched instantly", stl.instantlyTouched],
        ["Booked from instant touch", stl.instantAppts], ["Instant booking rate %", stl.instantApptRate],
        ["Caught after hours", stl.afterHoursInstant], ["Missed calls returned", stl.missedCalledBack],
        ["Leads touched %", stl.pctTouched]] });
      break;
    }

    case "lead-sources":
      sheets.push({ name: "By type and source", rows: [["Lead type", "Source", "Leads worked", "Reached", "Qualified", "Appointments", "Open action items"],
        ...leadTypeRollup(c).flatMap((t) => [
          [t.type, "(all sources)", t.contact, t.reached, t.qualified, t.appts, t.actionItems],
          ...t.sources.map((r) => [t.type, r.source, r.contact, r.reached, r.qualified, r.appts, r.actionItems]),
        ])] });
      break;

    case "what-customers-wanted":
      for (const dir of ["inbound", "outbound"] as EvalDirection[]) {
        const o = c.outcomes[dir];
        if (!o?.scored) continue;
        sheets.push({ name: `${dir} flow`, rows: [["Call type", "What they wanted", "Calls", ...OUTCOME_KEYS],
          ...o.groups.flatMap((g) => [
            [g.label, "(all)", g.total, ...OUTCOME_KEYS.map((k) => g.outcomes[k] ?? 0)],
            ...g.primaries.map((p) => [g.label, p.label, p.total, ...OUTCOME_KEYS.map((k) => p.outcomes[k] ?? 0)]),
          ]),
          ["Never connected", "", o.ghost, ...OUTCOME_KEYS.map(() => 0)]] });
      }
      break;

    case "appointment-leak": {
      const o = (["inbound", "outbound"] as EvalDirection[]).map((d) => c.outcomes[d]).filter(Boolean).sort((a, b) => b!.funnelBase - a!.funnelBase)[0];
      const f = o?.funnels.find((x) => x.key === "Appointment");
      if (f) sheets.push({ name: "Appointment funnel", rows: [["Step", "Conversations"], ...f.steps.map((s) => [s.label, s.count])] });
      break;
    }

    case "handoffs":
      sheets.push({ name: "Hand-offs", rows: [["Measure", "Value"],
        ["Hand-offs to team", c.fleet.handoffs], ["Transfers completed", c.fleet.transfers],
        ["Transfers failed", c.fleet.transfersFailed], ["Call-backs requested", c.fleet.callbacks]] });
      if (c.metrics?.calls_by_reason?.length)
        sheets.push({ name: "Why people called", rows: [["Reason", "Calls", "Booked"],
          ...c.metrics.calls_by_reason.map((r) => [r.reason, r.calls, r.booked])] });
      break;

    case "missed-opportunities":
      sheets.push({ name: "Leads to work", rows: [["Customer", "Tier", "What they want", "Phone", "Campaign", "Last activity"],
        ...c.warmLeads.map((w) => [w.customer, w.tier, w.interest, w.phone, w.campaign, w.lastActivity ?? ""])] });
      if (c.metrics?.missed?.length)
        sheets.push({ name: "Demand that slipped", rows: [["Category", "Channel", "Count"],
          ...c.metrics.missed.map((m) => [m.category, m.channel, m.count])] });
      break;

    case "follow-ups": {
      const s = c.actionStats;
      if (s) sheets.push({ name: "Summary", rows: [["Measure", "Value"],
        ["Created", s.created], ["Closed", s.completed], ["Open", s.open], ["Overdue", s.overdue], ["Due today", s.dueToday]] });
      sheets.push({ name: "Open items", rows: [["Customer", "What's needed", "Due", "Assigned to"],
        ...c.actionItems.map((i) => [i.customer ?? i.leadId ?? "", i.description || i.intent, i.dueAt ?? "", i.assignedTo ?? ""])] });
      break;
    }

    case "after-hours": {
      const ib = inboundAgent(c);
      sheets.push({ name: "After hours", rows: [["Measure", "Value"],
        ["Handled after hours", c.fleet.afterHours], ["All conversations", c.fleet.conversations]] });
      if (ib) sheets.push({ name: "By hour", rows: [["Hour", "Activity"], ...ib.hourly.map((v, i) => [HOURS[i] ?? String(i), v])] });
      break;
    }

    case "outbound-campaigns": {
      const ob = outboundAgent(c);
      sheets.push({ name: "Campaigns", rows: [["Campaign", "Enrolled", "Appointments", "Rate %", "Warm leads", "Opt-outs"],
        ...(ob?.report.activeCampaigns ?? []).map((k) => [k.name, k.enrolled, k.appts, k.apptRate, k.warmLeads, k.optOuts])] });
      if (ob?.report.outcomes?.length)
        sheets.push({ name: "Outcomes", rows: [["Outcome", "Leads"], ...ob.report.outcomes.map((o) => [o.label, o.value])] });
      break;
    }

    case "agent-scorecard":
      sheets.push({ name: "Agents", rows: [["Agent", "Direction", "Leads", "Conversations", "Qualified", "Appointments", "Talk minutes"],
        ...scopedAgents(c).map((a) => [a.report.summary.person || a.name, a.dir,
          a.leadFunnel?.contacted ?? a.report.leadsAttempted, a.metrics.conversations, a.metrics.qualified,
          a.metrics.appointments, a.metrics.talkMinutes])] });
      break;

    case "activity-trend":
      sheets.push({ name: "Day by day", rows: [["Agent", "Day", "Value"],
        ...scopedAgents(c).flatMap((a) => a.trend7.map((v, i) => [a.report.summary.person || a.name, WEEKDAYS[i] ?? String(i), v]))] });
      break;

    case "sold": {
      const t = c.insights?.soldTotals;
      if (t) sheets.push({ name: "Summary", rows: [["Measure", "Leads"],
        ["Worked by the AI", t.touched], ["Now sold", t.sold], ["Still active", t.active], ["Closed out", t.lost]] });
      sheets.push({ name: "By CRM status", rows: [["Status", "Leads"], ...(c.insights?.sold ?? []).map((r) => [r.label, r.leads])] });
      break;
    }

    case "vehicles":
      sheets.push({ name: "Vehicles wanted", rows: [["Make", "Model", "Interested leads", "New", "Used", "Years"],
        ...(c.insights?.vehicles ?? []).map((v) => [v.make, v.model, v.leads, v.newCount, v.usedCount, v.years])] });
      break;

    case "transfer-routing":
      sheets.push({ name: "Transfer routing", rows: [["Department", "Destination type", "Transfers"],
        ...(c.insights?.routing ?? []).map((r) => [r.department, r.destinationType, r.transfers])] });
      break;

    case "texts": {
      const s = c.insights?.sms;
      if (s) sheets.push({ name: "Texts", rows: [["Measure", "Value"],
        ["Conversations", s.threads], ["Replied", s.repliedThreads], ["Messages sent", s.outbound], ["Messages received", s.inbound]] });
      break;
    }

    case "coverage":
      sheets.push({ name: "Calls by hour", rows: [["Weekday", "Hour", "Calls"],
        ...(c.insights?.hours ?? []).map((h) => [WEEKDAYS[h.weekday - 1] ?? String(h.weekday), hourLabel(h.hour), h.calls])] });
      break;

    case "objections":
      sheets.push({ name: "Reasons", rows: [["Reason", "Count"], ...objectionRows(c).rows.map((r) => [r.label, r.count])] });
      break;

    case "appt-status": {
      const t = apptTotals(c);
      sheets.push({ name: "Summary", rows: [["Measure", "Appointments"],
        ["Booked", t.booked], ["Showed", t.showed], ["No-show", t.no_show], ["Cancelled", t.cancelled], ["Upcoming", t.upcoming]] });
      sheets.push({ name: "By channel", rows: [["Booked via", "Booked", "Showed", "No-show"],
        ...(c.metrics?.appt_status ?? []).map((r) => [r.booked_via ?? "", r.booked, r.showed, r.no_show])] });
      break;
    }

    case "best-calls":
      sheets.push({ name: "Best calls", rows: [["What happened", "Direction", "When"],
        ...(c.metrics?.highlights ?? []).map((h) => [h.title ?? "", h.direction ?? "", h.occurred_on ?? ""])] });
      break;

    case "end-to-end": {
      const h = handlingTotals(c);
      if (h) sheets.push({ name: "Handling", rows: [["Measure", "Value"],
        ["Connected calls", h.connected], ["Handled end to end", h.solo], ["Needed a person", h.transferred],
        ["Transfer didn't connect", h.transferFailed], ["Never connected", h.unreached], ["Minutes saved", h.minutesSaved]] });
      const r = resolutionSplit(c);
      if (r) sheets.push({ name: "Question resolution", rows: [["Question", "Times asked", "Answered"],
        ...r.rows.map((x) => [x.intent, x.raised, x.resolved])] });
      break;
    }

    case "demand-vs-stock":
      sheets.push({ name: "Demand vs stock", rows: [["Make", "Model", "Interested leads", "In stock", "Leads per unit"],
        ...demandVsStock(c).map((r) => [r.make, r.model, r.leads, r.units, r.units ? +(r.leads / r.units).toFixed(2) : ""])] });
      break;

    case "contact-effort":
      sheets.push({ name: "Dials per lead", rows: [["Calls placed to the lead", "Leads"],
        ...(c.insights?.effort ?? []).map((e) => [e.attempts, e.leads])] });
      break;

    case "service-bookings":
    case "service-transport":
    case "service-recall":
    case "service-friction":
      sheets.push({ name: "Service desk", rows: [["What the customer wanted", "Succeeded", "Failed", "Failure rate %"],
        ...svcRows(c).map((t) => [svcLabel(t.tool), t.ok, t.failed, pct(t.failed, t.ok + t.failed)])] });
      break;
  }

  // Never hand back an empty workbook — the headline numbers are always better than nothing.
  if (!sheets.length) {
    sheets.push({ name: "Summary", rows: [["Measure", "Value"],
      ["Conversations", c.fleet.conversations], ["Qualified leads", c.fleet.qualified],
      ["Appointments", c.fleet.appointments], ["Hand-offs", c.fleet.handoffs]] });
  }
  return [meta, ...sheets];
}

/** Outcome columns, in the canonical rung order, for the flow export. */
const OUTCOME_KEYS = ["Appointment", "Transfer", "Callback", "Query Resolved", "Qualified Lead", "None"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/* THE DRILL-DOWN. Clicking a segment asks the server for the leads behind exactly that cell, then a lead
 * opens its own conversations — recording and transcript — through the existing lead-scoped conversation
 * path and the drawer the Calls tab already uses. Nothing here re-implements playback.
 *
 * The whole point: a number on a report should be openable. "43 reached but never qualified" is an
 * argument; the 43 conversations behind it are evidence, and that is where a manager actually coaches. */
export function LeadStageExplorer({ types, total, ctx }: { types: LeadTypeRow[]; total: number; ctx: ReportCtx }) {
  const [drill, setDrill] = useState<{ type: string; source?: string; stage: (typeof LEAD_STAGES)[number] } | null>(null);
  return (
    <>
      <LeadSourceTable types={types} total={total} onDrill={setDrill} />
      {drill && <LeadDrillPanel drill={drill} ctx={ctx} onClose={() => setDrill(null)} />}
    </>
  );
}

function LeadDrillPanel({
  drill, ctx, onClose,
}: {
  drill: { type: string; source?: string; stage: (typeof LEAD_STAGES)[number] };
  ctx: ReportCtx;
  onClose: () => void;
}) {
  /* Keyed by the request, not reset inside the effect: a synchronous setState in an effect costs an
   * extra render and defeats the compiler's memoization. A stale payload can never paint because the
   * reader below only accepts one whose key matches. */
  const [state, setState] = useState<{ key: string; leads: DrillLead[] | null }>({ key: "", leads: null });
  const [conv, setConv] = useState<Conversation | null>(null);
  const [busyLead, setBusyLead] = useState<string | null>(null);

  const key = `${drill.type}|${drill.source ?? ""}|${drill.stage.drill}`;
  const leads = state.key === key ? state.leads : null;
  useEffect(() => {
    let on = true;
    const qs = new URLSearchParams({
      team_id: ctx.teamId,
      bucket_stage: drill.stage.drill,
      type: drill.type,
      ...(drill.source ? { source: drill.source } : {}),
      ...(ctx.dept && ctx.dept !== "all" ? { serviceType: ctx.dept } : {}),
      ...(ctx.window?.start && ctx.window?.end ? { start: ctx.window.start, end: ctx.window.end } : { bucket: ctx.window?.bucket ?? "last30" }),
    });
    fetch(`/api/reports/lead-drill?${qs}`, { cache: "no-store", headers: ctx.spyneToken ? { Authorization: `Bearer ${ctx.spyneToken}` } : undefined })
      .then((r) => (r.ok ? r.json() : { leads: [] }))
      .then((j: { leads?: DrillLead[] }) => { if (on) setState({ key, leads: Array.isArray(j.leads) ? j.leads : [] }); })
      .catch(() => { if (on) setState({ key, leads: [] }); });
    return () => { on = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  /* One lead's calls, then straight into the drawer. Opening the newest is what a reviewer wants nine
   * times in ten; the drawer itself carries the recording and transcript. */
  const openLead = async (l: DrillLead) => {
    setBusyLead(l.leadId);
    try {
      const rows = await fetchConversations(ctx.teamId, { leadId: l.leadId, channel: "both", limit: 20 });
      if (rows.length) setConv(rows[0]);
    } finally {
      setBusyLead(null);
    }
  };

  return (
    <>
      <div className="border-t border-[#f0f0f0] bg-[#fbfbfc] px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[12.5px] font-bold text-[#111]">
            <span className="mr-2 inline-block h-2.5 w-2.5 rounded-[3px] align-middle" style={{ background: drill.stage.color }} />
            {drill.stage.label} · {drill.type.replace(/_/g, " ")}
            {drill.source ? ` · ${drill.source}` : ""}
          </p>
          <button type="button" onClick={onClose} className="text-[11.5px] font-semibold text-[#813fed] hover:underline">Close</button>
        </div>

        {leads === null ? (
          <p className="mt-3 text-[12px] text-[#9ca3af]">Finding the customers…</p>
        ) : !leads.length ? (
          <p className="mt-3 text-[12px] text-[#6b7280]">No customers to show for this one.</p>
        ) : (
          <>
            <p className="mt-1 text-[11px] text-[#9ca3af]">{fmtInt(leads.length)} customer{leads.length === 1 ? "" : "s"} · click one to open the conversation</p>
            <div className="mt-2 grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
              {leads.map((l) => (
                <button
                  key={l.leadId}
                  type="button"
                  onClick={() => openLead(l)}
                  disabled={busyLead === l.leadId}
                  className="flex flex-col items-start gap-0.5 rounded-xl border border-[#e5e7eb] bg-white px-3.5 py-2.5 text-left hover:border-[#d6c9f5] hover:shadow-sm disabled:opacity-60"
                >
                  <span className="truncate text-[12.5px] font-semibold text-[#111]">{l.customer || "Unknown customer"}</span>
                  <span className="text-[11px] tabular-nums text-[#6b7280]">{l.phone || "no number"}</span>
                  <span className="text-[10.5px] text-[#9ca3af]">
                    {busyLead === l.leadId ? "Opening…" : `${fmtInt(l.calls)} call${l.calls === 1 ? "" : "s"} · ${l.lastCallAt.slice(0, 10)}`}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <ConversationDrawer conv={conv} onClose={() => setConv(null)} />
    </>
  );
}

/* THE SAME LEADS VIEW, standalone, for the By-agent report.
 *
 * The agent page carries no ReportCtx, and the old card there rendered leadsBySource — a flat
 * source/interacted/total/booked table with no stage split and no way to open a number. This fetches the
 * same dataset the library report uses and draws it identically, so the two can never diverge into two
 * different answers to one question.
 *
 * DIRECTION-scoped, unlike the library's: an agent report is one agent, and an "Inbound operations" card
 * showing outbound leads would be wrong. */
export function LeadsByTypeCard({
  teamId, dept, direction, window: win, periodLabel, spyneToken,
}: {
  teamId: string;
  dept: "sales" | "service";
  direction: "inbound" | "outbound";
  window: { bucket?: string; start?: string; end?: string };
  periodLabel: string;
  /** Forwarded to our API as a Bearer header — without it this card is empty for every real dealer. */
  spyneToken?: string;
}) {
  const [rows, setRows] = useState<InsightsPayload["leadSources"] | null>(null);
  const [failed, setFailed] = useState(false);
  const key = `${teamId}|${dept}|${direction}|${win.bucket ?? ""}|${win.start ?? ""}|${win.end ?? ""}|${spyneToken ? 1 : 0}`;
  const [state, setState] = useState<{ key: string; done: boolean }>({ key: "", done: false });

  useEffect(() => {
    if (!teamId) return;
    let on = true;
    const qs = new URLSearchParams({ team_id: teamId, serviceType: dept, direction });
    if (win.start && win.end) { qs.set("start", win.start); qs.set("end", win.end); }
    else if (win.bucket) qs.set("bucket", win.bucket);
    fetch(`/api/reports/insights?${qs}`, { cache: "no-store", headers: spyneToken ? { Authorization: `Bearer ${spyneToken}` } : undefined })
      .then(async (r) => { if (!r.ok) throw new Error(String(r.status)); return r.json() as Promise<InsightsPayload>; })
      .then((j) => { if (on) { setRows(j?.leadSources ?? []); setFailed(false); setState({ key, done: true }); } })
      .catch(() => { if (on) { setRows([]); setFailed(true); setState({ key, done: true }); } });
    return () => { on = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const fresh = state.key === key && state.done;
  const ctx = { teamId, dept, window: win, spyneToken, insights: { leadSources: rows } } as unknown as ReportCtx;
  const types = fresh && rows?.length ? leadTypeRollup(ctx) : [];
  const total = types.reduce((s, t) => s + engagedOf(t), 0);

  /* Never return null. This card sits in a grid column, so vanishing leaves a hole the width of two
   * columns next to a lone neighbour — which is exactly how a silent 401 looked in production. An
   * empty state and a failure state are also different things and say so. */
  return (
    <Card
      title="Leads by type and source"
      sub={`${periodLabel} · where this agent's leads actually got to · click a segment to open the customers`}
      pad={false}
    >
      {!fresh ? (
        <div className="px-5 py-6"><div className="h-24 animate-pulse rounded-xl bg-[#f4f5f7]" /></div>
      ) : failed ? (
        <p className="px-5 py-6 text-[12.5px] leading-snug text-[#6b7280]">
          Couldn&apos;t load lead sources just now. The rest of the report is unaffected — refresh to try again.
        </p>
      ) : !types.length ? (
        <p className="px-5 py-6 text-[12.5px] leading-snug text-[#6b7280]">
          No leads with a {direction} conversation in this period. Widen the date range to see more.
        </p>
      ) : (
        <LeadStageExplorer types={types} total={total} ctx={ctx} />
      )}
    </Card>
  );
}
