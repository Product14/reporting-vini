"use client";

/* Conversation-outcome panels — "where your calls went" and "where we lose the appointment".
 *
 * Fed by /api/reports/outcomes (Spyne eval pipeline, SALES only, one direction per fetch). Every panel
 * here states its own denominator: the eval pipeline SCORES conversations, and its coverage of dialled
 * calls is not 1:1 (inbound runs ~97% of calls, outbound nearer a quarter while the scorer catches up),
 * so a bare count next to the report's own call counts would read as a contradiction. Each card shows
 * "N of M calls scored" and leads with rates.
 *
 * Colour: the six outcome rungs use the canonical OutcomeLevel order (Appointment > Transfer > Callback >
 * Query Resolved > Qualified Lead > None) with a fixed hue per rung — never cycled, never re-assigned
 * when a filter drops a rung. Validated for CVD separation and contrast against the card surface; the
 * "None"/"Voicemail" slots are deliberately achromatic (they are the absence of an outcome, not a
 * category), and every segment carries a direct label or a hover read-out so identity is never
 * colour-alone. */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Card, SectionLabel, fmtInt } from "@/components/reports/kit";
import type { EvalOutcomes, EvalFunnel, EvalDirection } from "@/lib/spyne/evalPipeline";

// ───────────────────────── outcome rungs ─────────────────────────

/* Fixed rung order + hue. Order is the backend's OutcomeLevel ranking (best outcome first), so a stacked
 * bar reads left-to-right as "best → no next step". */
export const OUTCOME_RUNGS: { key: string; label: string; color: string }[] = [
  { key: "Appointment", label: "Appointment", color: "#15803d" },
  { key: "Transfer", label: "Transferred", color: "#2563eb" },
  { key: "Callback", label: "Callback", color: "#d97706" },
  { key: "Query Resolved", label: "Query resolved", color: "#7c3aed" },
  { key: "Qualified Lead", label: "Qualified lead", color: "#0891b2" },
  { key: "Voicemail", label: "Voicemail", color: "#cbd2db" },
  { key: "None", label: "No next step", color: "#adb5c0" },
];
/** Rungs present in a tally, in canonical order (never volume order — colour follows the rung). */
function rungsIn(tally: Record<string, number>): { key: string; label: string; color: string; count: number }[] {
  return OUTCOME_RUNGS.filter((r) => (tally[r.key] ?? 0) > 0).map((r) => ({ ...r, count: tally[r.key] }));
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);

// ───────────────────────── fetch ─────────────────────────

export interface OutcomesFeed {
  outcomes: EvalOutcomes | null;
  degraded: boolean;
}

/* One direction's scored sales conversations. Returns { outcomes: null, degraded: true } on any failure —
 * callers hide the panel rather than rendering an empty chart. */
export async function fetchOutcomes(args: {
  teamId: string;
  /* Optional: a By-agent deep link is often just ?team_id=&agent=. The server resolves the enterprise
   * from the session token (then ClickHouse) when it isn't on the URL — see the route. */
  enterpriseId?: string;
  dir: EvalDirection;
  bucket?: string;
  start?: string;
  end?: string;
  spyneToken?: string;
  spyneEnv?: string;
}): Promise<OutcomesFeed> {
  const { teamId, enterpriseId, dir } = args;
  if (!teamId) return { outcomes: null, degraded: true };
  const qs = new URLSearchParams({ team_id: teamId, dir });
  if (enterpriseId) qs.set("enterprise_id", enterpriseId);
  if (args.start && args.end) {
    qs.set("start", args.start);
    qs.set("end", args.end);
  } else if (args.bucket) {
    qs.set("bucket", args.bucket);
  }
  if (args.spyneEnv) qs.set("env", args.spyneEnv);
  try {
    const headers = args.spyneToken ? { Authorization: `Bearer ${args.spyneToken}` } : undefined;
    const r = await fetch(`/api/reports/outcomes?${qs}`, { cache: "no-store", headers });
    if (!r.ok) return { outcomes: null, degraded: true };
    const j = (await r.json()) as OutcomesFeed;
    return { outcomes: j?.outcomes ?? null, degraded: j?.degraded !== false };
  } catch {
    return { outcomes: null, degraded: true };
  }
}

/* Both sales directions for the selected window, fetched in parallel. `dirs` lets a caller ask for only
 * the direction it renders (the By-agent tab) instead of both (the Overview). */
export function useOutcomes(args: {
  teamId: string;
  enterpriseId?: string;
  dirs: EvalDirection[];
  bucket?: string;
  start?: string;
  end?: string;
  spyneToken?: string;
  spyneEnv?: string;
  enabled?: boolean;
}): { data: Partial<Record<EvalDirection, EvalOutcomes>>; loading: boolean } {
  const { teamId, enterpriseId, bucket, start, end, spyneToken, spyneEnv } = args;
  const enabled = args.enabled !== false;
  const dirKey = args.dirs.join(",");
  /* State carries the request signature it belongs to, and the reader below discards a result that
   * doesn't match the CURRENT one. That's what makes switching rooftop or window safe without resetting
   * state from inside the effect — a stale payload can never be painted under a new rooftop's header. */
  const reqKey = `${enabled ? 1 : 0}|${teamId}|${enterpriseId ?? ""}|${dirKey}|${bucket ?? ""}|${start ?? ""}|${end ?? ""}`;
  const [state, setState] = useState<{ key: string; data: Partial<Record<EvalDirection, EvalOutcomes>> }>({ key: "", data: {} });
  useEffect(() => {
    if (!enabled || !teamId) return;
    let on = true;
    const dirs = dirKey.split(",").filter(Boolean) as EvalDirection[];
    Promise.all(dirs.map((dir) => fetchOutcomes({ teamId, enterpriseId, dir, bucket, start, end, spyneToken, spyneEnv })))
      .then((res) => {
        if (!on) return;
        const next: Partial<Record<EvalDirection, EvalOutcomes>> = {};
        dirs.forEach((dir, i) => {
          const o = res[i].outcomes;
          if (o) next[dir] = o;
        });
        setState({ key: reqKey, data: next });
      })
      .catch(() => { if (on) setState({ key: reqKey, data: {} }); });
    return () => { on = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqKey]);
  const fresh = state.key === reqKey;
  return { data: fresh ? state.data : {}, loading: enabled && !!teamId && !fresh };
}

// ───────────────────────── shared bits ─────────────────────────

function Legend({ tally }: { tally: Record<string, number> }) {
  const rungs = rungsIn(tally);
  if (!rungs.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5">
      {rungs.map((r) => (
        <span key={r.key} className="inline-flex items-center gap-1.5 text-[11px] text-[#374151]">
          <span className="h-2.5 w-2.5 flex-none rounded-[3px]" style={{ background: r.color }} />
          {r.label}
          <span className="font-semibold tabular-nums text-[#6b7280]">{fmtInt(r.count)}</span>
        </span>
      ))}
    </div>
  );
}

/* "N of M calls scored" — the coverage line every panel carries. `calls` is the report's own call count
 * for the same window/direction; omitted (or 0) → we show the scored count alone rather than a fake
 * denominator. Plain string so it can go straight into Card's `sub`. */
function coverageText(scored: number, calls?: number | null): string {
  if (!calls || calls <= 0) return `${fmtInt(scored)} calls reviewed in detail`;
  const covered = Math.min(100, pct(scored, calls));
  // Kept deliberately, in plain words. Without a denominator a dealer reads "155" as their whole month
  // when the real figure is 1,358 — the percentages on this page are sound either way, but the counts
  // would be off by 9×. One quiet line, no jargon.
  const caveat = covered < 80 ? " — a sample of this period" : "";
  return `Based on ${fmtInt(scored)} of ${fmtInt(calls)} calls reviewed in detail${caveat}`;
}

/** Says out loud that SMS is scored but not shown here, so the omission can't read as missing data. */
function SmsNote({ o }: { o: EvalOutcomes }) {
  if (!o.smsScored) return null;
  return (
    <p className="text-[10.5px] leading-snug text-[#9ca3af]">
      Phone calls only — {fmtInt(o.smsScored)} text conversation{o.smsScored === 1 ? "" : "s"} handled in this
      period {o.smsScored === 1 ? "is" : "are"} not counted above.
    </p>
  );
}

function ScopeNote({ o }: { o: EvalOutcomes }) {
  if (o.derivedScope === "exact") return null;
  return (
    <p className="mt-3 border-t border-[#f2f2f4] pt-2.5 text-[10.5px] leading-snug text-[#9ca3af]">
      Step figures cover your store&apos;s sales conversations on both inbound and outbound calls together.
    </p>
  );
}

// ───────────────────────── A · where the calls went ─────────────────────────

/* THE FLOW — call type → what they wanted → what happened, in two interchangeable views over the same
 * numbers: a sankey (shape of the funnel) and a table (exact figures, every row at once).
 *
 * Three things this fixes over a naive lane chart:
 *
 *  1. VOLUME IS ENCODED. A row's bar is as wide as its share of the BUSIEST row; the outcome mix lives
 *     inside that width. Normalising every bar to its own row — the obvious implementation — draws a
 *     1-call row exactly as wide as a 30-call row, so the eye reads two wildly different things as
 *     equals. Volume and mix now read at a glance, together.
 *  2. IT USES THE WHOLE CARD. Laid out in HTML at whatever width the card actually is, rather than in a
 *     fixed 880-unit SVG that left a third of the card empty on wide screens and shrank the type on
 *     narrow ones. Only the ribbon fan is SVG, sized to the measured width.
 *  3. THE RIGHT-HAND COLUMN EARNS ITS SPACE — it names the winning outcome and its share, instead of a
 *     vague "mostly …".
 */

type FlowView = "sankey" | "table";

const plural = (n: number, word: string) => `${fmtInt(n)} ${word}${n === 1 ? "" : "s"}`;

/** Card width in px, tracked live. The ResizeObserver fires on observe, so no synchronous seed is needed. */
function useMeasuredWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      if (next > 0) setW(next);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

type Tip = { x: number; y: number; label: string; color: string } | null;

/** Volume-scaled, outcome-segmented bar. Outer width = share of the busiest row; inner = the mix. */
function VolumeBar({
  tally,
  total,
  max,
  onTip,
}: {
  tally: Record<string, number>;
  total: number;
  max: number;
  onTip: (t: Tip) => void;
}) {
  const rungs = rungsIn(tally);
  // Floor at 1.5% so a single call is still visible; it stays visibly tiny next to a busy row.
  const volume = max > 0 ? Math.max(1.5, (total / max) * 100) : 0;
  return (
    <div className="h-5 w-full rounded-md bg-[#f4f5f7]">
      <div className="flex h-full overflow-hidden rounded-md" style={{ width: `${volume}%`, gap: 1 }}>
        {rungs.map((r) => (
          <div
            key={r.key}
            className="h-full min-w-[2px] first:rounded-l-md last:rounded-r-md"
            style={{ width: `${(r.count / total) * 100}%`, background: r.color }}
            onMouseMove={(e) => onTip({ x: e.clientX, y: e.clientY, label: `${r.label} · ${plural(r.count, "call")} · ${pct(r.count, total)}%`, color: r.color })}
            onMouseLeave={() => onTip(null)}
          />
        ))}
      </div>
    </div>
  );
}

/** The winning outcome for a row — replaces a vague "mostly …" with the actual number. */
function TopOutcome({ tally, total }: { tally: Record<string, number>; total: number }) {
  const top = rungsIn(tally).slice().sort((a, b) => b.count - a.count)[0];
  if (!top) return null;
  return (
    <span className="flex items-center gap-1.5 text-[11px] leading-tight">
      <span className="h-2 w-2 flex-none rounded-sm" style={{ background: top.color }} />
      <span className="truncate font-semibold text-[#374151]">{top.label}</span>
      <span className="flex-none tabular-nums text-[#9ca3af]">{pct(top.count, total)}%</span>
    </span>
  );
}

function Caret({ open }: { open: boolean }) {
  return (
    <svg width="9" height="9" viewBox="0 0 10 10" className={`flex-none text-[#813fed] transition-transform ${open ? "rotate-90" : ""}`} aria-hidden>
      <path d="M2 1 L8 5 L2 9 Z" fill="currentColor" />
    </svg>
  );
}

/* One expanded intent, fanned into a ribbon per outcome. This is the only SVG in the chart, and it is
 * sized to the measured card width so 1 unit = 1 px — no viewBox rescaling, so the labels are always the
 * size they were designed at. */
function RibbonFan({
  tally,
  total,
  onTip,
}: {
  tally: Record<string, number>;
  total: number;
  onTip: (t: Tip) => void;
}) {
  // Self-measuring: it lives in the same grid column as the collapsed bars, so it must take that
  // column's width rather than be handed the whole card's.
  const [boxRef, width] = useMeasuredWidth();
  const rungs = rungsIn(tally);
  const MIN_H = 16, GAP = 10, ROW = 34, NODE = 10, LABEL_W = 168;
  const h = Math.max(ROW, rungs.length * ROW);
  const srcX = 0;
  const dstX = Math.max(80, width - LABEL_W - NODE);
  const avail = h - (rungs.length - 1) * GAP;
  const extra = Math.max(0, avail - rungs.length * MIN_H);
  const heights = rungs.map((r) => MIN_H + (r.count / total) * extra);
  const stack = heights.reduce((a, b) => a + b, 0);
  const srcTop = (h - stack) / 2;

  return (
    <div ref={boxRef} className="w-full">
      {width > 0 && (
    <svg width="100%" height={h} viewBox={`0 0 ${Math.max(width, 200)} ${h}`} style={{ display: "block", overflow: "visible" }}>
      <rect x={srcX} y={0} width={NODE} height={h} rx={3} fill="#aeb6c2" />
      {rungs.map((r, i) => {
        const sy = srcTop + heights.slice(0, i).reduce((a, b) => a + b, 0);
        const ty = heights.slice(0, i).reduce((a, b) => a + b, 0) + i * GAP;
        const hh = heights[i];
        const xm = (srcX + NODE + dstX) / 2;
        const d = `M ${srcX + NODE} ${sy} C ${xm} ${sy}, ${xm} ${ty}, ${dstX} ${ty} L ${dstX} ${ty + hh} C ${xm} ${ty + hh}, ${xm} ${sy + hh}, ${srcX + NODE} ${sy + hh} Z`;
        return (
          <g
            key={r.key}
            onMouseMove={(e) => onTip({ x: e.clientX, y: e.clientY, label: `${r.label} · ${plural(r.count, "call")} · ${pct(r.count, total)}%`, color: r.color })}
            onMouseLeave={() => onTip(null)}
          >
            <path d={d} fill={r.color} fillOpacity={0.28} />
            <rect x={dstX} y={ty} width={NODE} height={hh} rx={3} fill={r.color} />
            <text x={dstX + NODE + 10} y={ty + hh / 2 - 1} fontSize={11.5} fontWeight={700} fill="#374151">{r.label}</text>
            <text x={dstX + NODE + 10} y={ty + hh / 2 + 12} fontSize={10.5} fill="#9ca3af">{`${fmtInt(r.count)} · ${pct(r.count, total)}%`}</text>
          </g>
        );
      })}
    </svg>
      )}
    </div>
  );
}

/** Shared row grid: label · bar · winning outcome. One definition so every row lines up exactly. */
const ROW_GRID = "grid grid-cols-[minmax(150px,240px)_1fr] items-center gap-3 sm:grid-cols-[minmax(170px,260px)_1fr_minmax(120px,168px)]";

function SankeyView({ o, onTip }: { o: EvalOutcomes; onTip: (t: Tip) => void }) {
  const [exp, setExp] = useState<Record<string, boolean>>({});
  const toggle = (k: string) => setExp((s) => ({ ...s, [k]: !s[k] }));
  // Every bar on the chart is scaled against the busiest call type, so widths compare across groups.
  const max = Math.max(1, ...o.groups.map((g) => g.total));

  return (
    <div className="flex flex-col">
      {o.groups.map((g) => {
        const open = !!exp[g.id];
        return (
          <div key={g.id} className="border-b border-[#f4f4f6] py-1 last:border-b-0">
            <button type="button" onClick={() => toggle(g.id)} className={`${ROW_GRID} w-full rounded-lg px-1 py-2 text-left hover:bg-[#fafafa]`}>
              <span className="flex min-w-0 items-center gap-2">
                <Caret open={open} />
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] font-bold text-[#111]">{g.label}</span>
                  <span className="text-[10.5px] tabular-nums text-[#9ca3af]">{plural(g.total, "call")} · {pct(g.total, o.scored)}%</span>
                </span>
              </span>
              <VolumeBar tally={g.outcomes} total={g.total} max={max} onTip={onTip} />
              <span className="hidden sm:flex"><TopOutcome tally={g.outcomes} total={g.total} /></span>
            </button>

            {open && (
              <div className="ml-3 border-l-2 border-[#ece9f6] pl-3">
                {g.primaries.map((p) => {
                  const pk = `${g.id}/${p.id}`;
                  const pOpen = !!exp[pk];
                  return (
                    <div key={pk}>
                      <button type="button" onClick={() => toggle(pk)} className={`${ROW_GRID} w-full rounded-lg px-1 py-1.5 text-left hover:bg-[#fafafa]`}>
                        <span className="flex min-w-0 items-center gap-2">
                          <Caret open={pOpen} />
                          <span className="min-w-0">
                            <span className="block truncate text-[11.5px] font-semibold text-[#374151]">{p.label}</span>
                            <span className="text-[10px] tabular-nums text-[#9ca3af]">{plural(p.total, "call")}</span>
                          </span>
                        </span>
                        {pOpen ? <span /> : <VolumeBar tally={p.outcomes} total={p.total} max={max} onTip={onTip} />}
                        {!pOpen && <span className="hidden sm:flex"><TopOutcome tally={p.outcomes} total={p.total} /></span>}
                      </button>
                      {pOpen && (
                        <div className={`${ROW_GRID} px-1 pb-3`}>
                          <span />
                          <div className="min-w-0 sm:col-span-2">
                            <RibbonFan tally={p.outcomes} total={p.total} onTip={onTip} />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* The same numbers as a table — every row visible at once, exact counts, no interaction needed. This is
 * also the accessible read of the chart: the segment colours are backed by a column of figures. */
function TableView({ o }: { o: EvalOutcomes }) {
  const rungs = OUTCOME_RUNGS.filter((r) => (o.outcomes[r.key] ?? 0) > 0);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse">
        <thead>
          <tr className="border-b border-[#e9eaee]">
            <th className="py-2 pr-3 text-left text-[10px] font-bold uppercase tracking-wide text-[#9ca3af]">What they wanted</th>
            <th className="px-2 py-2 text-right text-[10px] font-bold uppercase tracking-wide text-[#9ca3af]">Calls</th>
            <th className="px-2 py-2 text-right text-[10px] font-bold uppercase tracking-wide text-[#9ca3af]">Share</th>
            {rungs.map((r) => (
              <th key={r.key} className="px-2 py-2 text-right text-[10px] font-bold uppercase tracking-wide text-[#9ca3af]">
                <span className="inline-flex items-center gap-1">
                  <span className="h-2 w-2 rounded-sm" style={{ background: r.color }} />
                  {r.label}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {o.groups.map((g) => (
            <React.Fragment key={g.id}>
              <tr className="border-b border-[#f4f4f6] bg-[#fbfbfc]">
                <td className="py-2 pr-3 text-[12px] font-bold text-[#111]">{g.label}</td>
                <td className="px-2 py-2 text-right text-[12px] font-bold tabular-nums text-[#111]">{fmtInt(g.total)}</td>
                <td className="px-2 py-2 text-right text-[11.5px] tabular-nums text-[#6b7280]">{pct(g.total, o.scored)}%</td>
                {rungs.map((r) => (
                  <td key={r.key} className="px-2 py-2 text-right text-[12px] font-semibold tabular-nums" style={{ color: g.outcomes[r.key] ? r.color : "#d4d7dd" }}>
                    {g.outcomes[r.key] ? fmtInt(g.outcomes[r.key]) : "–"}
                  </td>
                ))}
              </tr>
              {g.primaries.map((p) => (
                <tr key={`${g.id}/${p.id}`} className="border-b border-[#f7f7f9]">
                  <td className="py-1.5 pl-4 pr-3 text-[11.5px] text-[#4b5563]">{p.label}</td>
                  <td className="px-2 py-1.5 text-right text-[11.5px] tabular-nums text-[#374151]">{fmtInt(p.total)}</td>
                  <td className="px-2 py-1.5 text-right text-[11px] tabular-nums text-[#9ca3af]">{pct(p.total, o.scored)}%</td>
                  {rungs.map((r) => (
                    <td key={r.key} className="px-2 py-1.5 text-right text-[11.5px] tabular-nums" style={{ color: p.outcomes[r.key] ? r.color : "#dfe2e7" }}>
                      {p.outcomes[r.key] ? fmtInt(p.outcomes[r.key]) : "–"}
                    </td>
                  ))}
                </tr>
              ))}
            </React.Fragment>
          ))}
          <tr className="border-t-2 border-[#e9eaee]">
            <td className="py-2 pr-3 text-[11.5px] font-bold text-[#374151]">Conversations</td>
            <td className="px-2 py-2 text-right text-[12px] font-extrabold tabular-nums text-[#111]">{fmtInt(o.engaged)}</td>
            <td className="px-2 py-2 text-right text-[11.5px] tabular-nums text-[#6b7280]">{pct(o.engaged, o.scored)}%</td>
            {rungs.map((r) => (
              <td key={r.key} className="px-2 py-2 text-right text-[12px] font-extrabold tabular-nums" style={{ color: r.color }}>
                {fmtInt(o.outcomes[r.key] ?? 0)}
              </td>
            ))}
          </tr>
          {o.ghost > 0 && (
            <tr>
              <td className="py-2 pr-3 text-[11.5px] text-[#9ca3af]">Never connected</td>
              <td className="px-2 py-2 text-right text-[12px] font-semibold tabular-nums text-[#9ca3af]">{fmtInt(o.ghost)}</td>
              <td className="px-2 py-2 text-right text-[11.5px] tabular-nums text-[#9ca3af]">{pct(o.ghost, o.scored)}%</td>
              <td className="px-2 py-2 text-right text-[11px] text-[#c3cad4]" colSpan={rungs.length}>hung up · quiet · voicemail</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/* The ghost row beneath the flow: scored conversations where nothing was ever established. Called out
 * rather than drawn as a lane — on an outbound rooftop it is ~90% of the volume and would flatten every
 * real lane to a sliver. */
function GhostNote({ o }: { o: EvalOutcomes }) {
  if (!o.ghost) return null;
  return (
    <div className="mt-2.5 flex items-center gap-2.5 border-t border-[#f2f2f4] pt-3">
      <span className="h-2.5 w-2.5 flex-none rounded-[3px] bg-[#c3cad4]" />
      <span className="text-[12.5px] font-bold text-[#6b7280]">Never connected</span>
      <span className="text-[11px] leading-snug text-[#9ca3af]">
        hung up, went quiet or reached voicemail before a conversation started — kept out of the figures above.
      </span>
      <span className="ml-auto flex-none text-[14px] font-extrabold text-[#9ca3af] tabular-nums">
        {fmtInt(o.ghost)} · {pct(o.ghost, o.scored)}%
      </span>
    </div>
  );
}

/** "Where your calls went" — call type → intent → outcome, for one direction. */
export function CallFlowCard({
  o,
  calls,
  title,
  sub,
}: {
  o: EvalOutcomes;
  calls?: number | null;
  title?: string;
  sub?: string;
}) {
  const dirLabel = o.dir === "inbound" ? "Inbound" : "Outbound";
  const [view, setView] = useState<FlowView>("sankey");
  const [tip, setTip] = useState<Tip>(null);

  if (!o.scored) {
    return (
      <Card title={title ?? `Where your ${dirLabel.toLowerCase()} calls went`} sub="no calls reviewed for this period yet">
        <p className="text-[12px] text-[#6b7280]">
          We haven&apos;t reviewed any {dirLabel.toLowerCase()} sales conversations for this period yet. This
          fills in shortly — the rest of the report is unaffected.
        </p>
      </Card>
    );
  }

  return (
    <Card
      title={title ?? `Where your ${dirLabel.toLowerCase()} calls went`}
      sub={sub ?? "What each caller wanted, and what came of it"}
      right={
        /* Same numbers, two readings: the chart for shape, the table for exact figures. The table is
           also the non-visual read of the chart — every colour is backed by a column of counts. */
        <div className="no-print flex flex-none rounded-lg bg-[#f1f2f5] p-0.5" role="group" aria-label="View">
          {([["sankey", "Chart"], ["table", "Table"]] as [FlowView, string][]).map(([v, label]) => (
            <button
              key={v}
              type="button"
              onClick={() => { setView(v); setTip(null); }}
              aria-pressed={view === v}
              className={`rounded-md px-3 py-1 text-[11.5px] font-semibold transition-colors ${
                view === v ? "bg-white text-[#813fed] shadow-sm" : "text-[#6b7280] hover:text-[#374151]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <Legend tally={o.outcomes} />
          <span className="text-[10.5px] text-[#9ca3af]">{coverageText(o.scored, calls)}</span>
        </div>

        {o.groups.length === 0 ? (
          <p className="py-3 text-[12px] text-[#6b7280]">
            Every call this period ended before a conversation started — see the line below.
          </p>
        ) : view === "sankey" ? (
          <>
            <SankeyView o={o} onTip={setTip} />
            <p className="text-[10.5px] text-[#9ca3af]">Bar width is call volume · click any row to open it</p>
          </>
        ) : (
          <TableView o={o} />
        )}

        <GhostNote o={o} />
        <SmsNote o={o} />

        {o.secondary.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 border-t border-[#f2f2f4] pt-3">
            <span className="text-[10px] font-bold uppercase tracking-wide text-[#9ca3af]">Also came up</span>
            {o.secondary.map((s) => (
              <span key={s.id} className="rounded-full border border-[#e5e7eb] px-2.5 py-0.5 text-[11px] font-medium text-[#374151]">
                {s.label} <span className="font-bold text-[#9ca3af] tabular-nums">{s.count}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      {tip && (
        <div
          className="pointer-events-none fixed z-50 whitespace-nowrap rounded-md bg-[#111827] px-2.5 py-1.5 text-[11px] font-semibold text-white shadow-lg"
          style={{ left: tip.x + 12, top: tip.y + 12 }}
        >
          <span className="mr-1.5 inline-block h-2 w-2 rounded-sm align-middle" style={{ background: tip.color }} />
          {tip.label}
        </div>
      )}
    </Card>
  );
}

// ───────────────────────── B · where the appointment is lost ─────────────────────────

/* One funnel's drop-off. A step the eval never emitted for this rooftop (0 passes while a LATER step
 * passed) is a checkpoint that isn't firing, not a real zero — it renders "not measured" and conversion
 * is computed across the measured steps, skipping it. Without that, one un-emitted checkpoint reads as
 * "we lose 100% here" and buries the real leak. */
function FunnelBars({ f, showLeak }: { f: EvalFunnel; showLeak?: boolean }) {
  const rows = useMemo(() => {
    const steps = f.steps.map((s, i) => ({
      ...s,
      unmeasured: s.count === 0 && f.steps.slice(i + 1).some((later) => later.count > 0),
    }));
    // Step-to-step conversion over the MEASURED steps only: each measured step is compared with the last
    // measured one before it, so an un-emitted checkpoint doesn't zero out the chain behind it.
    const conv: (number | null)[] = steps.map(() => null);
    const prevOf: (number | null)[] = steps.map(() => null); // index of the step each one converts from
    let lastMeasured = -1;
    steps.forEach((s, i) => {
      if (s.unmeasured) return;
      if (lastMeasured >= 0 && steps[lastMeasured].count > 0) {
        conv[i] = s.count / steps[lastMeasured].count;
        prevOf[i] = lastMeasured;
      }
      lastMeasured = i;
    });
    /* The leak is where the most CONVERSATIONS fall out, not where the percentage is worst. Ranking by
     * rate alone crowns the tail of the funnel — a 1 → 0 step is "0% of previous" and would be reported
     * as the biggest drop over a 50 → 11 step that actually lost 39 people. Ties (equal volume) go to
     * the worse rate. */
    let leakIdx = -1;
    let mostDropped = 0;
    let worst = 2;
    conv.forEach((c, i) => {
      const from = prevOf[i];
      if (c === null || from === null) return;
      const dropped = steps[from].count - steps[i].count;
      if (dropped > mostDropped || (dropped === mostDropped && dropped > 0 && c < worst)) {
        mostDropped = dropped;
        worst = c;
        leakIdx = i;
      }
    });
    const leakPrevIdx = leakIdx >= 0 ? prevOf[leakIdx] : null;
    return { steps, conv, leakIdx, worst, leakPrev: leakPrevIdx !== null ? steps[leakPrevIdx] : null };
  }, [f]);

  const base = rows.steps[0]?.count || 1;

  return (
    <div className="flex flex-col gap-1.5">
      {rows.steps.map((s, i) => {
        const c = rows.conv[i];
        // A genuine zero draws NO bar — a minimum-width stub would read as "a few got here". The 3% floor
        // exists only so a small non-zero count is still visible.
        const width = s.unmeasured || s.count === 0 ? 0 : Math.max(3, (s.count / base) * 100);
        const isLast = i === rows.steps.length - 1;
        const isLeak = i === rows.leakIdx;
        return (
          <div key={s.key} className="grid grid-cols-[minmax(96px,140px)_1fr] items-center gap-2.5">
            {/* No evidence-source badge: which steps are AI-judged vs system-measured is an internal
                distinction, and this page is read by the dealer. */}
            <span className="text-[11.5px] font-semibold text-[#374151]">{s.label}</span>
            {s.unmeasured ? (
              <div className="flex h-6 items-center rounded-md bg-[#f8f8fa] px-2.5 text-[10.5px] font-semibold text-[#c3c8d1]">not measured</div>
            ) : (
              <div className="relative h-6 overflow-hidden rounded-md bg-[#f1f2f5]">
                {/* Rendered only when there IS a bar — a zero-width div still shows its horizontal
                    padding as a coloured sliver, which reads as a small non-zero value. */}
                {width > 0 && (
                  <div
                    className="flex h-full items-center rounded-md px-2"
                    style={{ width: `${width}%`, background: isLast ? "#15803d" : "#813fed" }}
                  >
                    {width >= 13 && <span className="text-[11px] font-bold text-white tabular-nums">{fmtInt(s.count)}</span>}
                  </div>
                )}
                {width < 13 && (
                  <span className="absolute top-1/2 -translate-y-1/2 text-[11px] font-bold text-[#374151] tabular-nums" style={{ left: `calc(${width}% + 8px)` }}>
                    {fmtInt(s.count)}
                  </span>
                )}
                {c !== null && (
                  <span
                    className={`absolute right-2 top-1/2 -translate-y-1/2 rounded-md border px-1.5 py-px text-[10px] font-bold tabular-nums ${
                      isLeak ? "border-transparent bg-[#dc2626] text-white" : "border-[#e5e7eb] bg-white text-[#6b7280]"
                    }`}
                  >
                    {Math.round(c * 100)}% of previous
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}

      {showLeak && rows.leakIdx > 0 && rows.leakPrev && (
        <div className="mt-2 flex items-start gap-2.5 rounded-xl border border-[#fecaca] bg-[#fef2f2] px-3.5 py-3">
          <span className="mt-px flex h-5 w-5 flex-none items-center justify-center rounded-full bg-[#dc2626] text-[12px] font-bold text-white">!</span>
          <div>
            <p className="text-[12px] font-bold text-[#991b1b]">
              Biggest drop: {rows.leakPrev.label} → {rows.steps[rows.leakIdx].label}
            </p>
            <p className="mt-0.5 text-[11.5px] leading-snug text-[#7f1d1d]">
              Only {Math.round(rows.worst * 100)}% of &ldquo;{rows.leakPrev.label}&rdquo; conversations reached
              &ldquo;{rows.steps[rows.leakIdx].label}&rdquo; — {fmtInt(rows.leakPrev.count - rows.steps[rows.leakIdx].count)} fell
              off here. This is the best place to improve.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/* "Where appointments are won and lost" — the path from a sales conversation to a booked appointment,
 * with the biggest drop-off called out. Dealer-facing: no evidence-source badges, and the copy names the
 * step in the showroom's terms rather than the pipeline's. */
export function AppointmentLeakCard({ o }: { o: EvalOutcomes }) {
  const appt = o.funnels.find((f) => f.key === "Appointment");
  if (!appt || !appt.totalEligible) return null;
  return (
    <Card
      title="Where appointments are won and lost"
      sub={`${fmtInt(o.funnelBase)} conversations with sales intent · each step as a share of the one before`}
    >
      <FunnelBars f={appt} showLeak />
      <ScopeNote o={o} />
    </Card>
  );
}

// ───────────────────────── KPI strip ─────────────────────────

/** Transfer attempts vs. connections, read off the Transfer funnel's last two measured steps. */
function transferCounts(o: EvalOutcomes): { called: number; connected: number } {
  const steps = o.funnels.find((f) => f.key === "Transfer")?.steps ?? [];
  return {
    called: steps.find((s) => s.key.includes("ToolCalled"))?.count ?? 0,
    connected: steps.find((s) => s.key.includes("Connected"))?.count ?? 0,
  };
}

/* The at-a-glance row above the panels, in the dealer's terms: how many real conversations happened and
 * what came out of them. "Appointments booked" is the funnel's terminal step — a CRM record actually
 * written, not a claim that one was agreed. */
/* Deliberately takes no total-call count. Every figure here comes from the REVIEWED calls, so pairing
 * them with the period's full call total ("21 real conversations from 1,358 calls") would read as a
 * catastrophic connect rate when the true ratio is ~9× better — the sample is stated once, on the flow
 * card directly below, where the two numbers belong to the same population. */
export function OutcomeKpis({ o }: { o: EvalOutcomes }) {
  const appt = o.funnels.find((f) => f.key === "Appointment");
  const booked = appt?.steps[appt.steps.length - 1]?.count ?? 0;
  const { called, connected } = transferCounts(o);

  const cards: { label: string; value: string; sub: string; color?: string }[] = [
    { label: "Real conversations", value: fmtInt(o.engaged), sub: `of ${fmtInt(o.scored)} calls reviewed`, color: "#111" },
    { label: "Buying intent", value: fmtInt(o.qualified), sub: `${pct(o.qualified, o.engaged)}% of conversations`, color: "#0891b2" },
    { label: "Appointments booked", value: fmtInt(booked), sub: "confirmed in your CRM", color: "#15803d" },
    { label: "Sent to your team", value: fmtInt(connected), sub: called ? `${fmtInt(connected)} of ${fmtInt(called)} connected` : "no transfers needed", color: "#2563eb" },
    { label: "Callbacks requested", value: fmtInt(o.outcomes["Callback"] ?? 0), sub: "customer asked for a call back", color: "#d97706" },
    { label: "Didn't connect", value: fmtInt(o.ghost), sub: `${pct(o.ghost, o.scored)}% hung up or no answer` },
  ];

  return (
    <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
      {cards.map((c) => (
        <div key={c.label} className="rounded-xl border border-[#e5e7eb] bg-white px-3.5 py-3">
          <p className="text-[9.5px] font-bold uppercase tracking-wide text-[#9ca3af]">{c.label}</p>
          <p className="mt-0.5 text-[22px] font-extrabold leading-none tabular-nums" style={{ color: c.color ?? "#111" }}>{c.value}</p>
          <p className="mt-1 text-[10.5px] leading-snug text-[#6b7280]">{c.sub}</p>
        </div>
      ))}
    </div>
  );
}

// ───────────────────────── C · hand-offs to the team ─────────────────────────

/* What happened when a customer asked for a person. The dealer cares about two things: how often it was
 * asked for, and whether the customer actually reached someone — so the transfer path is shown as a plain
 * three-step story with the connect rate called out.
 *
 * The tool-execution panel that used to live here (per-tool fire/fail counts, raw names like
 * communication_transfer_call_v3, error types) is INTERNAL plumbing and is deliberately not on this page.
 * The one number a dealer can act on — attempts that never reached a person — is surfaced below. */
export function HandoffsCard({ o }: { o: EvalOutcomes }) {
  const { called, connected } = transferCounts(o);
  const callbacks = o.outcomes["Callback"] ?? 0;
  if (!called && !callbacks) return null;
  const missed = Math.max(0, called - connected);
  const rate = called ? Math.round((connected / called) * 100) : null;

  return (
    <Card
      title="When a customer asked for your team"
      sub="Transfers to a person, and the call-backs your team still owes"
    >
      <div className="grid gap-6 lg:grid-cols-[1.15fr_1fr]">
        <div className="flex flex-col gap-2.5">
          {[
            { label: "Asked for a person", n: called, color: "#813fed" },
            { label: "Reached someone", n: connected, color: "#15803d" },
          ].map((row) => (
            <div key={row.label} className="grid grid-cols-[minmax(120px,150px)_1fr] items-center gap-2.5">
              <span className="text-[11.5px] font-semibold text-[#374151]">{row.label}</span>
              <div className="relative h-6 overflow-hidden rounded-md bg-[#f1f2f5]">
                {row.n > 0 && (
                  <div className="flex h-full items-center rounded-md px-2" style={{ width: `${called ? Math.max(4, (row.n / called) * 100) : 0}%`, background: row.color }}>
                    <span className="text-[11px] font-bold text-white tabular-nums">{fmtInt(row.n)}</span>
                  </div>
                )}
              </div>
            </div>
          ))}
          {missed > 0 && (
            <p className="mt-1 text-[11.5px] leading-snug text-[#7f1d1d]">
              <b>{fmtInt(missed)} {missed === 1 ? "customer" : "customers"} asked for someone and never got through.</b>{" "}
              Usually nobody picked up on the other end — worth checking who is covering that line.
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4 self-start lg:border-l lg:border-[#f2f2f4] lg:pl-6">
          <QualStat
            label="Connected"
            value={rate == null ? "—" : `${rate}%`}
            sub={called ? `${fmtInt(connected)} of ${fmtInt(called)} reached a person` : "no transfers needed"}
            accent={rate != null && rate >= 80 ? "#15803d" : rate != null && rate >= 60 ? "#d97706" : "#dc2626"}
          />
          <QualStat label="Call-backs owed" value={fmtInt(callbacks)} sub="customer asked to be called back" accent="#d97706" />
        </div>
      </div>
    </Card>
  );
}

// ───────────────────────── D · conversation quality ─────────────────────────

const INTEREST_ROWS: { key: string; label: string; color: string }[] = [
  { key: "strong_buying", label: "Strong buying", color: "#15803d" },
  { key: "interested", label: "Interested", color: "#0891b2" },
  { key: "soft_considering", label: "Considering", color: "#d97706" },
  { key: "not_interested", label: "Not interested", color: "#adb5c0" },
  { key: "no_vehicle_discussed", label: "No vehicle discussed", color: "#cbd2db" },
];

/* Interest mix + the headline quality numbers for the scored cohort. Titled "How the conversations
 * scored" — NOT "Conversation quality", which is already the title of the By-agent quality card further
 * down that page (two cards with the same heading read as a duplicate). */
export function ConversationQualityCard({ o, calls }: { o: EvalOutcomes; calls?: number | null }) {
  if (!o.scored) return null;
  const maxN = Math.max(1, ...INTEREST_ROWS.map((r) => o.interest[r.key] ?? 0));
  return (
    <Card title="How interested your customers were" sub={coverageText(o.scored, calls)}>
      <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <div>
          <p className="mb-2.5 text-[11px] font-bold uppercase tracking-wide text-[#9ca3af]">Buying interest</p>
          <div className="flex flex-col gap-2">
            {INTEREST_ROWS.filter((r) => (o.interest[r.key] ?? 0) > 0).map((r) => {
              const n = o.interest[r.key] ?? 0;
              return (
                <div key={r.key} className="grid grid-cols-[minmax(110px,150px)_1fr_44px] items-center gap-2.5">
                  <span className="text-[11.5px] font-medium text-[#374151]">{r.label}</span>
                  <span className="h-3.5 overflow-hidden rounded-md bg-[#f1f2f5]">
                    <span className="block h-full rounded-md" style={{ width: `${(n / maxN) * 100}%`, background: r.color }} />
                  </span>
                  <span className="text-right text-[11.5px] font-bold text-[#374151] tabular-nums">{fmtInt(n)}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 self-start lg:border-l lg:border-[#f2f2f4] lg:pl-6">
          {/* Rates are of REAL conversations, not every reviewed call — the ones that never connected
              could not have shown buying intent, so including them just scales every rate down.
              "Missed better outcome" is deliberately not shown: it reads as self-criticism to a dealer. */}
          <QualStat label="Buying intent" value={`${pct(o.qualified, o.engaged)}%`} sub={`${fmtInt(o.qualified)} of ${fmtInt(o.engaged)} conversations`} accent="#15803d" />
          <QualStat label="Ready to move" value={fmtInt((o.interest["strong_buying"] ?? 0) + (o.interest["interested"] ?? 0))} sub="interested or ready to buy" accent="#0891b2" />
        </div>
      </div>
    </Card>
  );
}

function QualStat({ label, value, sub, accent }: { label: string; value: string; sub: string; accent: string }) {
  return (
    <div>
      <p className="text-[9.5px] font-bold uppercase tracking-wide text-[#9ca3af]">{label}</p>
      <p className="mt-0.5 text-[22px] font-extrabold leading-none tabular-nums" style={{ color: accent }}>{value}</p>
      <p className="mt-1 text-[10.5px] leading-snug text-[#6b7280]">{sub}</p>
    </div>
  );
}

// ───────────────────────── Overview section ─────────────────────────

/* The Overview's outcomes block: one flow card per direction the rooftop actually scored, plus the
 * appointment-leak funnel. Sales-only by construction (the route never asks for service). */
export function OutcomesSection({
  data,
  loading,
  callsByDir,
}: {
  data: Partial<Record<EvalDirection, EvalOutcomes>>;
  loading: boolean;
  callsByDir?: Partial<Record<EvalDirection, number>>;
}) {
  const dirs = (["inbound", "outbound"] as EvalDirection[]).filter((d) => data[d] && data[d]!.scored > 0);
  if (loading && !dirs.length) {
    return (
      <div className="flex flex-col gap-3.5">
        <SectionLabel hint="scoring your conversations…">Where your calls went</SectionLabel>
        <div className="h-40 animate-pulse rounded-2xl border border-[#e5e7eb] bg-white" />
      </div>
    );
  }
  if (!dirs.length) return null;
  // The leak funnel is the same sales-intent cohort for both directions (see ScopeNote) — render it once,
  // from whichever direction has the larger funnel base, instead of twice with the same numbers.
  const leakFrom = dirs.map((d) => data[d]!).sort((a, b) => b.funnelBase - a.funnelBase)[0];
  return (
    <div className="flex flex-col gap-3.5">
      <SectionLabel hint="what each caller wanted, and what the AI did about it">Where your calls went</SectionLabel>
      <div className="flex flex-col gap-4">
        {dirs.map((d) => (
          <CallFlowCard key={d} o={data[d]!} calls={callsByDir?.[d]} />
        ))}
        <AppointmentLeakCard o={leakFrom} />
      </div>
    </div>
  );
}
