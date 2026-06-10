"use client";

import Link from "next/link";
import React, { useEffect, useRef, useState } from "react";
import { Bucket, BUCKET_LABELS, RAG } from "./data";

export * from "./data";

/* ── tabs ── */
export type ReportTab = "overview" | "agents" | "campaigns" | "impact";

export function ReportTabs({ active, teamId }: { active: ReportTab; teamId?: string }) {
  // keep the rooftop scope across tab navigation — the host passes it as ?team_id=
  const q = teamId ? `?team_id=${teamId}` : "";
  const tabs = [
    { id: "overview", label: "Overview", href: `/reports${q}` },
    { id: "agents", label: "By agent", href: `/reports/agents${q}` },
  ] as const;
  return (
    <div className="mx-auto max-w-[1400px] mt-4 flex items-center gap-1">
      {tabs.map((t) =>
        active === t.id ? (
          <span key={t.id} className="flex items-center px-3 py-1.5 rounded-md text-[12.5px] font-semibold bg-[#f3eaff] text-[#813fed]">
            {t.label}
          </span>
        ) : (
          <Link
            key={t.id}
            href={t.href}
            className="flex items-center px-3 py-1.5 rounded-md text-[12.5px] font-semibold text-[#6b7280] hover:text-[#111] hover:bg-[#f3f4f6] transition-colors"
          >
            {t.label}
          </Link>
        ),
      )}
    </div>
  );
}

/* ── page top bar ── */
export function ReportTopBar({
  title,
  subtitle,
  active,
  right,
  back,
  teamId,
}: {
  title: string;
  subtitle: string;
  active: ReportTab;
  right?: React.ReactNode;
  back?: string; // when set, render a back arrow linking here (e.g. the overview)
  teamId?: string; // preserved across tab + back navigation
}) {
  // sticky header that condenses once the page is scrolled
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div
      className={`sticky top-0 z-30 border-b border-[#f0f0f0] bg-white px-10 transition-[padding,box-shadow] duration-200 ${
        scrolled ? "py-2.5 shadow-[0_4px_16px_rgba(16,24,40,0.06)]" : "py-5"
      }`}
    >
      <div className="mx-auto max-w-[1400px] flex items-end justify-between gap-4">
        <div className="flex items-start gap-3">
          {back && (
            <Link
              href={back}
              aria-label="Back to overview"
              title="Back to overview"
              className="mt-0.5 flex h-9 w-9 flex-none items-center justify-center rounded-lg border border-[#e5e7eb] bg-white text-[#6b7280] transition-colors hover:bg-[#faf8ff] hover:text-[#813fed]"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </Link>
          )}
          <div>
            <span className="text-[10.5px] font-bold uppercase tracking-wider text-[#6366f1]">Reports</span>
            <h1 className={`font-bold text-[#111] tracking-[-0.2px] transition-all duration-200 ${scrolled ? "text-[17px]" : "text-[22px]"}`}>{title}</h1>
            <p className={`overflow-hidden text-[12.5px] text-[#6b7280] transition-all duration-200 ${scrolled ? "max-h-0 opacity-0" : "mt-1 max-h-10 opacity-100"}`}>{subtitle}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">{right}</div>
      </div>
      <ReportTabs active={active} teamId={teamId} />
    </div>
  );
}

/* ── time bucket toggle ── */
export function BucketToggle({ bucket, onChange }: { bucket: Bucket; onChange: (b: Bucket) => void }) {
  return (
    <div className="flex items-center gap-1 rounded-lg bg-[#f3f4f6] p-1">
      {(Object.keys(BUCKET_LABELS) as Bucket[]).map((b) => (
        <button
          key={b}
          onClick={() => onChange(b)}
          className={`px-3 py-1.5 rounded-md text-[12px] font-semibold transition-all ${
            bucket === b ? "bg-white text-[#111] shadow-sm" : "text-[#6b7280] hover:text-[#111]"
          }`}
        >
          {BUCKET_LABELS[b]}
        </button>
      ))}
    </div>
  );
}

/* ── date filter: presets (incl. Lifetime) + a custom range ── */
export const DATE_PRESETS: { id: Bucket; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yest" },
  { id: "last7", label: "7d" },
  { id: "last14", label: "14d" },
  { id: "last30", label: "30d" },
  { id: "lifetime", label: "All" },
];
export function DateFilter({
  bucket,
  custom,
  onPreset,
  onCustom,
}: {
  bucket: Bucket;
  custom: { start: string; end: string } | null;
  onPreset: (b: Bucket) => void;
  onCustom: (r: { start: string; end: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [s, setS] = useState(custom?.start ?? "2026-05-10");
  const [e, setE] = useState(custom?.end ?? "2026-06-08");
  return (
    <div className="relative flex items-center gap-1 rounded-lg bg-[#f3f4f6] p-1">
      {DATE_PRESETS.map((p) => {
        const on = !custom && bucket === p.id;
        return (
          <button
            key={p.id}
            onClick={() => onPreset(p.id)}
            className={`rounded-md px-2.5 py-1.5 text-[12px] font-semibold transition-all ${on ? "bg-white text-[#111] shadow-sm" : "text-[#6b7280] hover:text-[#111]"}`}
          >
            {p.label}
          </button>
        );
      })}
      <button
        onClick={() => setOpen((o) => !o)}
        className={`rounded-md px-2.5 py-1.5 text-[12px] font-semibold transition-all ${custom ? "bg-white text-[#111] shadow-sm" : "text-[#6b7280] hover:text-[#111]"}`}
      >
        {custom ? `${custom.start.slice(5)}–${custom.end.slice(5)}` : "Custom"}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-2 flex flex-col gap-2.5 rounded-xl border border-[#e5e7eb] bg-white p-3 shadow-[0_10px_30px_rgba(16,24,40,0.15)]">
          <div className="flex items-end gap-2">
            <label className="flex flex-col gap-1 text-[9.5px] font-bold uppercase tracking-wide text-[#9ca3af]">
              From
              <input type="date" value={s} max={e} onChange={(ev) => setS(ev.target.value)} className="rounded-md border border-[#e5e7eb] px-2 py-1 text-[12px] text-[#111]" />
            </label>
            <label className="flex flex-col gap-1 text-[9.5px] font-bold uppercase tracking-wide text-[#9ca3af]">
              To
              <input type="date" value={e} min={s} onChange={(ev) => setE(ev.target.value)} className="rounded-md border border-[#e5e7eb] px-2 py-1 text-[12px] text-[#111]" />
            </label>
          </div>
          <button
            onClick={() => { if (s && e) { onCustom({ start: s, end: e < s ? s : e }); setOpen(false); } }}
            className="rounded-lg bg-[#813fed] px-3 py-1.5 text-[12px] font-bold text-white transition-colors hover:bg-[#6d28d9]"
          >
            Apply range
          </button>
        </div>
      )}
    </div>
  );
}

/* ── RAG ── */
export const RAG_STYLE: Record<RAG, { dot: string; chipBg: string; chipText: string; label: string }> = {
  green: { dot: "#16a34a", chipBg: "#dcfce7", chipText: "#065f46", label: "On target" },
  amber: { dot: "#f59e0b", chipBg: "#fef3c7", chipText: "#92400e", label: "Watch" },
  red: { dot: "#dc2626", chipBg: "#fee2e2", chipText: "#991b1b", label: "At risk" },
};

export function HealthChip({ status, text }: { status: RAG; text?: string }) {
  const s = RAG_STYLE[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold"
      style={{ background: s.chipBg, color: s.chipText }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.dot }} />
      {text ?? s.label}
    </span>
  );
}

/* ── eyebrow (uppercase tracked accent label — shared across all report tabs) ── */
export function Eyebrow({ children, color = "#813fed" }: { children: React.ReactNode; color?: string }) {
  return (
    <p className="text-[10.5px] font-bold uppercase tracking-[0.12em]" style={{ color }}>
      {children}
    </p>
  );
}

/* ── question-first hero band (the dealer's question is the headline; numbers answer it) ── */
export function QuestionHero({
  eyebrow,
  question,
  answer,
  accent = "#813fed",
  tint = "#f6f1ff",
  right,
  children,
}: {
  eyebrow: string;
  question: React.ReactNode;
  answer?: React.ReactNode;
  accent?: string;
  tint?: string;
  right?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <section className="rounded-3xl border bg-white shadow-sm overflow-hidden" style={{ borderColor: `${accent}33` }}>
      <div className="px-7 pt-6 pb-5" style={{ background: `linear-gradient(110deg, ${tint}, #ffffff 72%)` }}>
        <div className="flex items-start justify-between gap-4">
          <Eyebrow color={accent}>{eyebrow}</Eyebrow>
          {right}
        </div>
        <h2 className="mt-2 text-[23px] font-extrabold leading-tight tracking-[-0.02em] text-[#111] max-w-[880px]">{question}</h2>
        {answer && (
          <p className="mt-2.5 flex items-start gap-2 text-[14px] leading-snug text-[#374151] max-w-[880px]">
            <span className="mt-[3px] flex-none text-[13px] font-bold" style={{ color: accent }}>→</span>
            <span>{answer}</span>
          </p>
        )}
      </div>
      {children}
    </section>
  );
}

/* ── tiny stat with sparkline + delta (hero sub-metrics) ── */
export function TrendStat({
  label,
  value,
  delta,
  sub,
  accent,
  invert,
  trend,
}: {
  label: string;
  value: string;
  delta?: number;
  sub?: string;
  accent?: string;
  invert?: boolean;
  trend?: number[];
}) {
  const isGood = delta === undefined ? true : invert ? delta < 0 : delta > 0;
  const up = (delta ?? 0) > 0;
  return (
    <div className="flex flex-col gap-1.5 px-6 py-5">
      <p className="text-[10.5px] font-bold uppercase tracking-[0.08em] text-[#9ca3af]">{label}</p>
      <div className="flex items-end justify-between gap-2">
        <p className="text-[33px] font-extrabold tabular-nums leading-none tracking-[-0.02em]" style={{ color: accent ?? "#111" }}>
          {value}
        </p>
        {trend && trend.length > 1 && <span className="mb-0.5"><Sparkline values={trend} color={accent ?? "#813fed"} width={62} height={26} /></span>}
      </div>
      <div className="flex items-center gap-2">
        {delta !== undefined && (
          <span className="text-[10.5px] font-semibold" style={{ color: delta === 0 ? "#9ca3af" : isGood ? "#16a34a" : "#dc2626" }}>
            {delta === 0 ? "0%" : `${up ? "▲" : "▼"} ${Math.abs(delta)}%`} vs prior
          </span>
        )}
        {sub && <span className="text-[11.5px] text-[#6b7280]">{sub}</span>}
      </div>
    </div>
  );
}

/* ── inline horizontal share bar (sits inside a table cell) ── */
export function InlineBar({ pct, color = "#813fed" }: { pct: number; color?: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#f3f4f6]">
      <div className="h-1.5 rounded-full" style={{ width: `${Math.max(3, Math.min(100, pct))}%`, background: color }} />
    </div>
  );
}

/* ── section card ── */
export function Card({
  title,
  sub,
  right,
  children,
  pad = true,
}: {
  title?: string;
  sub?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  pad?: boolean;
}) {
  return (
    <section className="rounded-2xl border border-[#e5e7eb] bg-white shadow-sm overflow-hidden">
      {title && (
        <div className="flex items-center justify-between border-b border-[#f0f0f0] px-6 py-4">
          <div>
            <p className="text-[14px] font-bold text-[#111]">{title}</p>
            {sub && <p className="text-[11.5px] text-[#6b7280] mt-0.5">{sub}</p>}
          </div>
          {right}
        </div>
      )}
      <div className={pad ? "px-6 py-5" : ""}>{children}</div>
    </section>
  );
}

/* ── KPI cell ── */
export function GlanceStat({
  label,
  value,
  sub,
  delta,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  delta?: string;
  accent?: string;
}) {
  return (
    <div className="px-5 py-4 flex flex-col gap-0.5">
      <p className="text-[10px] font-bold uppercase tracking-wider text-[#9ca3af]">{label}</p>
      <p className="text-[22px] font-bold tabular-nums" style={{ color: accent ?? "#111" }}>
        {value}
      </p>
      {sub && <p className="text-[11px] text-[#6b7280]">{sub}</p>}
      {delta && (
        <p className="text-[11px] font-semibold" style={{ color: delta.startsWith("-") ? "#dc2626" : "#16a34a" }}>
          {delta} vs prior
        </p>
      )}
    </div>
  );
}

/* ── big headline metric (Overview ROI band) ── */
export function HeadlineStat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="px-6 py-5 flex flex-col gap-1">
      <p className="text-[10.5px] font-bold uppercase tracking-wider text-[#9ca3af]">{label}</p>
      <p className="text-[30px] font-extrabold tabular-nums leading-none" style={{ color: accent ?? "#111" }}>
        {value}
      </p>
      {sub && <p className="text-[11.5px] text-[#6b7280]">{sub}</p>}
    </div>
  );
}

/* ── funnel bars ── */
export function FunnelBars({ stages }: { stages: { label: string; value: number }[] }) {
  const max = stages[0]?.value ?? 1;
  return (
    <div className="flex flex-col gap-3">
      {stages.map((s, i) => {
        const width = max > 0 ? Math.max(6, (s.value / max) * 100) : 100;
        const prev = i > 0 ? stages[i - 1].value : null;
        const conv = prev && prev > 0 ? Math.round((s.value / prev) * 100) : null;
        return (
          <div key={s.label} className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-[12px]">
              <span className="font-semibold text-[#374151]">{s.label}</span>
              <span className="tabular-nums font-bold text-[#111]">
                {Math.round(s.value).toLocaleString()}
                {conv !== null && <span className="ml-2 text-[10.5px] font-medium text-[#9ca3af]">↓ {conv}%</span>}
              </span>
            </div>
            <div className="h-2.5 w-full rounded-full bg-[#f3f4f6]">
              <div className="h-2.5 rounded-full" style={{ width: `${width}%`, background: "linear-gradient(90deg,#813fed,#6366f1)" }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── horizontal stepped funnel (columns descend left→right; drop-off annotated between) ── */
export function StepFunnel({
  stages,
  height = 168,
}: {
  stages: { label: string; value: number }[];
  height?: number;
}) {
  const max = stages[0]?.value ?? 1;
  return (
    <div className="flex items-stretch gap-1.5" style={{ minHeight: height + 56 }}>
      {stages.map((s, i) => {
        const h = max > 0 ? Math.max(10, (s.value / max) * 100) : 100;
        const prev = i > 0 ? stages[i - 1].value : null;
        const conv = prev && prev > 0 ? Math.round((s.value / prev) * 100) : null;
        const isLast = i === stages.length - 1;
        return (
          <div key={s.label} className="flex flex-1 flex-col">
            {/* bar zone */}
            <div className="relative flex items-end" style={{ height }}>
              <div
                className="w-full rounded-t-lg transition-all"
                style={{
                  height: `${h}%`,
                  background: isLast
                    ? "linear-gradient(180deg,#10b981,#059669)"
                    : `linear-gradient(180deg,#813fed,#6366f1)`,
                  opacity: 1 - i * 0.07,
                }}
              />
              {conv !== null && (
                <span className="absolute -top-0.5 left-1/2 -translate-x-1/2 -translate-y-full rounded-full bg-[#f3f4f6] px-2 py-0.5 text-[9.5px] font-bold tabular-nums text-[#6b7280]">
                  {conv}%
                </span>
              )}
            </div>
            {/* label zone */}
            <div className="mt-2 border-t-2 pt-2" style={{ borderColor: isLast ? "#10b981" : "#d8caff" }}>
              <p className="text-[17px] font-extrabold tabular-nums leading-none text-[#111]">{Math.round(s.value).toLocaleString()}</p>
              <p className="mt-1 text-[10.5px] font-medium leading-tight text-[#6b7280]">{s.label}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── horizontal stacked split bar + legend ── */
export function SplitBar({ segments }: { segments: { label: string; value: number; color: string }[] }) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-3 w-full overflow-hidden rounded-full">
        {segments.map((s) => (
          <div key={s.label} style={{ width: `${(s.value / total) * 100}%`, background: s.color }} title={`${s.label}: ${s.value}`} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {segments.map((s) => (
          <div key={s.label} className="flex items-center gap-1.5 text-[11.5px] text-[#374151]">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
            {s.label}
            <span className="font-semibold tabular-nums text-[#111]">{Math.round(s.value).toLocaleString()}</span>
            <span className="text-[#9ca3af]">({Math.round((s.value / total) * 100)}%)</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── vertical trend / distribution bars ── */
export function TrendBars({
  values,
  labels,
  highlightLast = false,
  height = 64,
}: {
  values: number[];
  labels?: string[];
  highlightLast?: boolean;
  height?: number;
}) {
  const max = Math.max(...values, 1);
  return (
    <div className="flex items-end gap-1.5" style={{ height }}>
      {values.map((v, i) => {
        const isLast = highlightLast && i === values.length - 1;
        return (
          <div key={i} className="flex flex-1 flex-col items-center justify-end gap-1" style={{ height: "100%" }}>
            <div
              className="w-full rounded-t-[3px]"
              style={{
                height: `${Math.max(4, (v / max) * 100)}%`,
                background: isLast ? "#813fed" : "#d8caff",
              }}
              title={String(v)}
            />
            {labels && <span className="text-[9px] text-[#9ca3af]">{labels[i]}</span>}
          </div>
        );
      })}
    </div>
  );
}

/* ── table primitives ── */
export function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th className={`px-4 py-2.5 text-[10px] font-bold uppercase tracking-wider text-[#6b7280] ${align === "right" ? "text-right" : "text-left"}`}>
      {children}
    </th>
  );
}
export function Td({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return <td className={`px-4 py-3 ${align === "right" ? "text-right" : "text-left"}`}>{children}</td>;
}

/* ── section eyebrow (band label between sections) ── */
export function SectionLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <h2 className="text-[12px] font-bold uppercase tracking-[0.08em] text-[#9ca3af]">{children}</h2>
      {hint && <span className="text-[11.5px] text-[#9ca3af]">{hint}</span>}
    </div>
  );
}

/* ── tiny inline sparkline ── */
export function Sparkline({
  values,
  color = "#813fed",
  width = 72,
  height = 24,
}: {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
}) {
  if (values.length < 2) return null;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = height - 2 - ((v - min) / span) * (height - 4);
    return [x, y] as const;
  });
  const d = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg width={width} height={height} className="overflow-visible">
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lx} cy={ly} r={2} fill={color} />
    </svg>
  );
}

/* ── hero stat (big bottom-line metric with delta) ── */
export function BigStat({
  label,
  value,
  delta,
  sub,
  accent,
}: {
  label: string;
  value: string;
  delta?: number;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5 px-6 py-5">
      <p className="text-[10.5px] font-bold uppercase tracking-[0.08em] text-[#9ca3af]">{label}</p>
      <p className="text-[34px] font-extrabold tabular-nums leading-none tracking-[-0.02em]" style={{ color: accent ?? "#111" }}>
        {value}
      </p>
      <div className="flex items-center gap-2">
        {delta !== undefined && <DeltaPill delta={delta} />}
        {sub && <span className="text-[11.5px] text-[#6b7280]">{sub}</span>}
      </div>
    </div>
  );
}

/* ── delta pill (↑/↓ vs prior period) ── */
export function DeltaPill({ delta }: { delta: number }) {
  if (delta === 0) return <span className="text-[10.5px] font-semibold text-[#9ca3af]">0% vs prior</span>;
  const up = delta > 0;
  return (
    <span className="text-[10.5px] font-semibold" style={{ color: up ? "#16a34a" : "#dc2626" }}>
      {up ? "▲" : "▼"} {Math.abs(delta)}% vs prior
    </span>
  );
}

/* ── headline KPI tile (with delta) ── */
export function KpiTile({
  label,
  value,
  delta,
  accent,
  hint,
}: {
  label: string;
  value: string;
  delta?: number;
  accent?: string;
  hint?: string;
}) {
  return (
    <div className="rounded-2xl border border-[#e5e7eb] bg-white shadow-sm px-5 py-4 flex flex-col gap-1">
      <p className="text-[10px] font-bold uppercase tracking-wider text-[#9ca3af]">{label}</p>
      <p className="text-[24px] font-extrabold tabular-nums leading-none" style={{ color: accent ?? "#111" }}>{value}</p>
      {hint && <p className="text-[10.5px] text-[#6b7280]">{hint}</p>}
      {delta !== undefined && <DeltaPill delta={delta} />}
    </div>
  );
}

/* ── day-on-day line+area chart — truly full-width (measured), clean even at low values ── */
export function DayTrend({
  points,
}: {
  points: { day: string; touched: number; qualified: number; appts: number }[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setW(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = 264;
  const padL = 36;
  const padR = 18;
  const padT = 16;
  const padB = 30;
  const n = points.length;
  const series = [
    { key: "touched" as const, label: "Touched", color: "#6366f1" },
    { key: "qualified" as const, label: "Qualified", color: "#10b981" },
    { key: "appts" as const, label: "Appointments", color: "#813fed" },
  ];
  const rawMax = Math.max(...points.flatMap((p) => [p.touched, p.qualified, p.appts]), 1);
  // give low values headroom; round larger maxima to a clean axis number
  const niceMax =
    rawMax <= 6
      ? rawMax + 1
      : (() => {
          const pow = Math.pow(10, Math.floor(Math.log10(rawMax)));
          const norm = rawMax / pow;
          return (norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * pow;
        })();
  const innerW = Math.max(1, w - padL - padR);
  const x = (i: number) => padL + (n <= 1 ? innerW / 2 : (i * innerW) / (n - 1));
  const y = (v: number) => padT + (1 - v / niceMax) * (H - padT - padB);
  const line = (key: "touched" | "qualified" | "appts") =>
    points.map((p, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(p[key]).toFixed(1)}`).join(" ");
  const area =
    n >= 2
      ? points.map((p, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(p.touched).toFixed(1)}`).join(" ") +
        ` L ${x(n - 1).toFixed(1)} ${y(0).toFixed(1)} L ${x(0).toFixed(1)} ${y(0).toFixed(1)} Z`
      : "";
  const gridVals = [0, niceMax / 2, niceMax];
  // legend + tooltip reflect the hovered day, falling back to the latest day
  const active = hover ?? n - 1;
  const ap = points[active];
  // keep the floating tooltip inside the card (which clips overflow): clamp its centre
  const tipX = Math.min(Math.max(x(active), 80), Math.max(80, w - 80));

  return (
    <div ref={ref} className="relative w-full">
      <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-1.5">
        {series.map((s) => (
          <span key={s.key} className="flex items-baseline gap-1.5 text-[12px]">
            <span className="h-2.5 w-2.5 translate-y-[1px] rounded-full" style={{ background: s.color }} />
            <span className="text-[#6b7280]">{s.label}</span>
            <b className="text-[15px] tabular-nums text-[#111]">{Math.round(ap?.[s.key] ?? 0).toLocaleString()}</b>
          </span>
        ))}
        <span className="ml-auto text-[10.5px] text-[#9ca3af]">{hover === null ? `last ${n} day${n === 1 ? "" : "s"}` : ap?.day}</span>
      </div>
      <div style={{ height: H }}>
        {w > 0 && n > 0 && (
          <svg width={w} height={H} className="overflow-visible">
            <defs>
              <linearGradient id="dt-area" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#6366f1" stopOpacity={0.13} />
                <stop offset="100%" stopColor="#6366f1" stopOpacity={0} />
              </linearGradient>
            </defs>
            {gridVals.map((g) => (
              <g key={g}>
                <line x1={padL} x2={w - padR} y1={y(g)} y2={y(g)} stroke="#f0f0f0" strokeWidth={1} />
                <text x={padL - 8} y={y(g) + 3.5} textAnchor="end" style={{ fontSize: 10, fill: "#9ca3af" }}>
                  {g >= 1000 ? `${(g / 1000).toFixed(g % 1000 ? 1 : 0)}k` : Math.round(g)}
                </text>
              </g>
            ))}
            {area && <path d={area} fill="url(#dt-area)" />}
            {/* crosshair for the hovered day */}
            {hover !== null && (
              <line x1={x(active)} x2={x(active)} y1={padT} y2={H - padB} stroke="#d8caff" strokeWidth={1.5} strokeDasharray="3 3" />
            )}
            {series.map((s) => (
              <g key={s.key}>
                <path d={line(s.key)} fill="none" stroke={s.color} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
                {points.map((p, i) => (
                  <circle key={i} cx={x(i)} cy={y(p[s.key])} r={hover === i ? 5 : 3.5} fill="#fff" stroke={s.color} strokeWidth={2} />
                ))}
              </g>
            ))}
            {points.map((p, i) => (
              <text key={i} x={x(i)} y={H - 9} textAnchor="middle" style={{ fontSize: 10.5, fontWeight: hover === i ? 700 : 400, fill: hover === i ? "#111" : "#9ca3af" }}>
                {p.day}
              </text>
            ))}
            {/* invisible hover bands — one per day — drive the crosshair + tooltip */}
            {points.map((p, i) => {
              const left = i === 0 ? 0 : (x(i - 1) + x(i)) / 2;
              const right = i === n - 1 ? w : (x(i) + x(i + 1)) / 2;
              return (
                <rect
                  key={i}
                  x={left}
                  y={0}
                  width={Math.max(0, right - left)}
                  height={H}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                />
              );
            })}
          </svg>
        )}
      </div>
      {/* floating tooltip for the hovered day */}
      {hover !== null && ap && w > 0 && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-xl border border-[#ece6fb] bg-white px-3 py-2.5 shadow-[0_8px_24px_rgba(16,24,40,0.14)]"
          style={{ left: tipX, top: 44 }}
        >
          <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-[#9ca3af]">{ap.day}</p>
          <div className="flex flex-col gap-1">
            {series.map((s) => (
              <div key={s.key} className="flex items-center gap-2 text-[11.5px]">
                <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                <span className="text-[#6b7280]">{s.label}</span>
                <b className="ml-auto tabular-nums text-[#111]">{Math.round(ap[s.key]).toLocaleString()}</b>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── day-on-day multi-line chart — interactive (hover crosshair + tooltip) ── */
export function MultiLineChart({
  points,
}: {
  points: { day: string; touched: number; qualified: number; appts: number }[];
}) {
  const W = 720;
  const H = 240;
  const padL = 36;
  const padR = 18;
  const padT = 16;
  const padB = 28;
  const n = points.length;
  const [hover, setHover] = React.useState<number | null>(null);

  const rawMax = Math.max(...points.flatMap((p) => [p.touched, p.qualified, p.appts]), 1);
  const pow = Math.pow(10, Math.floor(Math.log10(rawMax)));
  const step = pow / 2;
  const niceMax = Math.ceil(rawMax / step) * step;

  const x = (i: number) => padL + (i * (W - padL - padR)) / Math.max(1, n - 1);
  const y = (v: number) => padT + (1 - v / niceMax) * (H - padT - padB);
  const series = [
    { key: "touched" as const, color: "#6366f1", label: "Touched" },
    { key: "qualified" as const, color: "#10b981", label: "Qualified" },
    { key: "appts" as const, color: "#813fed", label: "Appointments" },
  ];
  type SKey = "touched" | "qualified" | "appts";
  const smooth = (key: SKey) => {
    // catmull-rom → cubic bézier for a soft, "nice" line
    const pts = points.map((p, i) => [x(i), y(p[key])] as const);
    if (pts.length < 2) return "";
    let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] ?? pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] ?? p2;
      const c1x = p1[0] + (p2[0] - p0[0]) / 6;
      const c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6;
      const c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
    }
    return d;
  };
  const areaD = smooth("touched") + ` L ${x(n - 1).toFixed(1)} ${y(0)} L ${x(0).toFixed(1)} ${y(0)} Z`;
  const active = hover ?? n - 1;
  const ap = points[active];
  const gridVals = [0, niceMax / 2, niceMax];

  return (
    <div className="relative">
      {/* legend reflects the hovered day (or the latest) */}
      <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-1.5">
        {series.map((s) => (
          <span key={s.key} className="flex items-baseline gap-1.5 text-[11.5px]">
            <span className="h-2.5 w-2.5 translate-y-[1px] rounded-full" style={{ background: s.color }} />
            <span className="text-[#6b7280]">{s.label}</span>
            <b className="tabular-nums text-[#111]">{Math.round(ap[s.key]).toLocaleString()}</b>
          </span>
        ))}
        <span className="ml-auto text-[10.5px] font-semibold text-[#9ca3af]">{hover === null ? "last 7 days" : ap.day}</span>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 240 }}>
        <defs>
          <linearGradient id="ddArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#6366f1" stopOpacity={0.16} />
            <stop offset="100%" stopColor="#6366f1" stopOpacity={0} />
          </linearGradient>
        </defs>

        {gridVals.map((g) => (
          <g key={g}>
            <line x1={padL} x2={W - padR} y1={y(g)} y2={y(g)} stroke="#f1f1f4" strokeWidth={1} />
            <text x={padL - 7} y={y(g) + 3} textAnchor="end" className="fill-[#b8b8c0]" style={{ fontSize: 9.5 }}>
              {g >= 1000 ? `${(g / 1000).toFixed(g % 1000 ? 1 : 0)}k` : g}
            </text>
          </g>
        ))}

        <path d={areaD} fill="url(#ddArea)" />
        {series.map((s) => (
          <path key={s.key} d={smooth(s.key)} fill="none" stroke={s.color} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
        ))}

        {/* crosshair + highlighted points for the active day */}
        <line x1={x(active)} x2={x(active)} y1={padT} y2={H - padB} stroke="#d8caff" strokeWidth={1.5} strokeDasharray="3 3" />
        {series.map((s) => (
          <circle key={s.key} cx={x(active)} cy={y(ap[s.key])} r={hover === null ? 3 : 4.5} fill="#fff" stroke={s.color} strokeWidth={2.5} />
        ))}

        {/* x labels */}
        {points.map((p, i) => (
          <text key={i} x={x(i)} y={H - 9} textAnchor="middle" className={i === active ? "fill-[#111] font-bold" : "fill-[#9ca3af]"} style={{ fontSize: 9.5 }}>
            {p.day}
          </text>
        ))}

        {/* invisible hover bands */}
        {points.map((p, i) => {
          const left = i === 0 ? 0 : (x(i - 1) + x(i)) / 2;
          const right = i === n - 1 ? W : (x(i) + x(i + 1)) / 2;
          return (
            <rect
              key={i}
              x={left}
              y={0}
              width={right - left}
              height={H}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
          );
        })}
      </svg>

      {/* floating tooltip */}
      {hover !== null && (
        <div
          className="pointer-events-none absolute top-9 z-10 -translate-x-1/2 rounded-xl border border-[#ece6fb] bg-white px-3 py-2.5 shadow-[0_8px_24px_rgba(16,24,40,0.14)]"
          style={{ left: `${(x(active) / W) * 100}%` }}
        >
          <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-[#9ca3af]">{ap.day}</p>
          <div className="flex flex-col gap-1">
            {series.map((s) => (
              <div key={s.key} className="flex items-center gap-2 text-[11.5px]">
                <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                <span className="text-[#6b7280]">{s.label}</span>
                <b className="ml-auto tabular-nums text-[#111]">{Math.round(ap[s.key]).toLocaleString()}</b>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── donut (no-interaction / reach breakdown) ── */
export function Donut({
  center,
  centerSub,
  segments,
}: {
  center: string;
  centerSub?: string;
  segments: { label: string; value: number; color: string }[];
}) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const R = 52;
  const C = 2 * Math.PI * R;
  // Precompute each segment's start offset (cumulative) so we never mutate during render.
  const arcs = segments.map((s, i) => {
    const len = (s.value / total) * C;
    const start = segments.slice(0, i).reduce((acc, x) => acc + (x.value / total) * C, 0);
    return { ...s, len, start };
  });
  return (
    <div className="flex items-center gap-5">
      <svg viewBox="0 0 140 140" style={{ width: 132, height: 132 }} className="flex-none">
        <g transform="rotate(-90 70 70)">
          {arcs.map((s) => (
            <circle key={s.label} cx={70} cy={70} r={R} fill="none" stroke={s.color} strokeWidth={16} strokeDasharray={`${s.len} ${C - s.len}`} strokeDashoffset={-s.start} />
          ))}
        </g>
        <text x={70} y={66} textAnchor="middle" className="fill-[#111]" style={{ fontSize: 24, fontWeight: 800 }}>{center}</text>
        {centerSub && <text x={70} y={84} textAnchor="middle" className="fill-[#9ca3af]" style={{ fontSize: 9, fontWeight: 600 }}>{centerSub}</text>}
      </svg>
      <div className="flex flex-col gap-2">
        {segments.map((s) => (
          <div key={s.label} className="flex items-center gap-2 text-[12px]">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
            <span className="text-[#374151]">{s.label}</span>
            <span className="ml-auto font-semibold tabular-nums text-[#111]">{Math.round(s.value).toLocaleString()}</span>
            <span className="text-[#9ca3af] tabular-nums">{Math.round((s.value / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── query resolution rate bars (resolved / total) ── */
export function QueryBars({ topics }: { topics: { label: string; resolved: number; total: number }[] }) {
  return (
    <div className="flex flex-col gap-3.5">
      {topics.map((t) => {
        const pct = t.total > 0 ? Math.round((t.resolved / t.total) * 100) : 0;
        return (
          <div key={t.label} className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-[12px]">
              <span className="text-[#374151]">{t.label}</span>
              <span className="tabular-nums text-[#111]">
                <b>{pct}%</b> <span className="text-[#9ca3af]">({t.resolved}/{t.total})</span>
              </span>
            </div>
            <div className="h-2 w-full rounded-full bg-[#f3f4f6]">
              <div className="h-2 rounded-full" style={{ width: `${pct}%`, background: pct >= 70 ? "#10b981" : pct >= 50 ? "#f59e0b" : "#dc2626" }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── call flow (total → answered/missed → transferred/lost, AI-handled share) ── */
export function CallFlowDiagram({
  flow,
  totalLabel,
}: {
  flow: { total: number; answered: number; missed: number; transferred: number; lost: number; handledByAI: number };
  totalLabel: string;
}) {
  const aiPct = flow.total > 0 ? Math.round((flow.handledByAI / flow.total) * 100) : 0;
  const node = (label: string, value: number, color: string, sub?: string) => (
    <div className="rounded-xl border px-3 py-2 bg-white" style={{ borderColor: `${color}40` }}>
      <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color }}>{label}</p>
      <p className="text-[16px] font-bold tabular-nums text-[#111]">{value.toLocaleString()}</p>
      {sub && <p className="text-[10px] text-[#9ca3af]">{sub}</p>}
    </div>
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="flex-none rounded-xl bg-[#f3eaff] px-3 py-2">
          <p className="text-[10px] font-bold uppercase tracking-wider text-[#813fed]">{totalLabel}</p>
          <p className="text-[20px] font-extrabold tabular-nums text-[#111]">{flow.total.toLocaleString()}</p>
        </div>
        <span className="text-[#cbd5e1]">→</span>
        <div className="grid flex-1 grid-cols-2 gap-2">
          {node("Answered", flow.answered, "#10b981")}
          {node("Missed", flow.missed, "#dc2626")}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {node("Transferred", flow.transferred, "#813fed")}
        {node("Lost", flow.lost, "#f59e0b")}
        {node("Handled by AI", flow.handledByAI, "#6366f1", `${aiPct}% of total`)}
      </div>
    </div>
  );
}

/* ── Sankey flow diagram (Contacts → Connected → Qualified → Booked …) ── */
export interface SankeyNode {
  id: string;
  label: string;
  color: string;
}
export interface SankeyLink {
  from: string;
  to: string;
  value: number;
}
export function Sankey({
  columns,
  links,
  height = 300,
  fmt = (n: number) => Math.round(n).toLocaleString(),
}: {
  columns: SankeyNode[][];
  links: SankeyLink[];
  height?: number;
  fmt?: (n: number) => string;
}) {
  const W = 760;
  const marginL = 84;
  const marginR = 104;
  const padY = 16;
  const nodeW = 13;
  const gap = 14;
  const numCols = columns.length;
  const plotW = W - marginL - marginR;

  const all = columns.flat();
  const nodeColor: Record<string, string> = {};
  all.forEach((n) => (nodeColor[n.id] = n.color));

  // node value = max(total in, total out)
  const valueOf: Record<string, number> = {};
  all.forEach((n) => {
    const out = links.filter((l) => l.from === n.id).reduce((s, l) => s + l.value, 0);
    const inc = links.filter((l) => l.to === n.id).reduce((s, l) => s + l.value, 0);
    valueOf[n.id] = Math.max(out, inc, 0);
  });

  // global px-per-value so every column fits the height
  let unit = Infinity;
  columns.forEach((col) => {
    const total = col.reduce((s, n) => s + valueOf[n.id], 0) || 1;
    const avail = height - 2 * padY - Math.max(0, col.length - 1) * gap;
    unit = Math.min(unit, avail / total);
  });
  if (!isFinite(unit)) unit = 1;

  // geometry — computed in plain loops (no mutation inside render)
  const geo: Record<string, { x: number; y0: number; cx: number; outC: number; inC: number }> = {};
  columns.forEach((col, ci) => {
    const colPx = col.reduce((s, n) => s + valueOf[n.id] * unit, 0) + Math.max(0, col.length - 1) * gap;
    const x = marginL + (numCols === 1 ? 0 : (ci * (plotW - nodeW)) / (numCols - 1));
    let cursor = (height - colPx) / 2;
    col.forEach((n) => {
      const h = valueOf[n.id] * unit;
      geo[n.id] = { x, y0: cursor, cx: ci, outC: cursor, inC: cursor };
      cursor += h + gap;
    });
  });

  // ribbons — accumulate offsets in a loop, then render pure descriptors
  const ribbons: { d: string; color: string; key: number }[] = [];
  links.forEach((l, i) => {
    const s = geo[l.from];
    const t = geo[l.to];
    if (!s || !t) return;
    const thick = Math.max(0.5, l.value * unit);
    const sy = s.outC;
    const ty = t.inC;
    s.outC += thick;
    t.inC += thick;
    const xs = s.x + nodeW;
    const xt = t.x;
    const xm = (xs + xt) / 2;
    const d = `M ${xs} ${sy} C ${xm} ${sy}, ${xm} ${ty}, ${xt} ${ty} L ${xt} ${ty + thick} C ${xm} ${ty + thick}, ${xm} ${sy + thick}, ${xs} ${sy + thick} Z`;
    ribbons.push({ d, color: nodeColor[l.from], key: i });
  });

  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="w-full" style={{ height }}>
      {ribbons.map((r) => (
        <path key={r.key} d={r.d} fill={r.color} fillOpacity={0.22} />
      ))}
      {all.map((n) => {
        const g = geo[n.id];
        const h = valueOf[n.id] * unit;
        const isFirst = g.cx === 0;
        const isLast = g.cx === numCols - 1;
        const midY = g.y0 + h / 2;
        return (
          <g key={n.id}>
            <rect x={g.x} y={g.y0} width={nodeW} height={Math.max(2, h)} rx={3} fill={n.color} />
            {isFirst ? (
              <text x={g.x - 8} y={midY} textAnchor="end" dominantBaseline="middle" className="fill-[#374151]" style={{ fontSize: 11, fontWeight: 600 }}>
                <tspan>{n.label}</tspan>
                <tspan x={g.x - 8} dy={13} className="fill-[#9ca3af]" style={{ fontSize: 10 }}>{fmt(valueOf[n.id])}</tspan>
              </text>
            ) : isLast ? (
              <text x={g.x + nodeW + 8} y={midY} textAnchor="start" dominantBaseline="middle" className="fill-[#374151]" style={{ fontSize: 11, fontWeight: 600 }}>
                <tspan>{n.label}</tspan>
                <tspan x={g.x + nodeW + 8} dy={13} className="fill-[#9ca3af]" style={{ fontSize: 10 }}>{fmt(valueOf[n.id])}</tspan>
              </text>
            ) : (
              <text x={g.x + nodeW / 2} y={g.y0 - 6} textAnchor="middle" className="fill-[#374151]" style={{ fontSize: 10.5, fontWeight: 600 }}>
                {n.label} <tspan className="fill-[#9ca3af]">{fmt(valueOf[n.id])}</tspan>
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/* ── benchmark story box (our number vs industry average) ── */
export function BenchmarkBox({
  label,
  ours,
  theirs,
  caption,
  multiplier,
  accent,
}: {
  label: string;
  ours: string;
  theirs: string;
  caption: string;
  multiplier?: string;
  accent: string;
}) {
  return (
    <div className="rounded-2xl border border-[#e5e7eb] bg-white shadow-sm p-5 flex flex-col gap-2.5">
      <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-[#9ca3af]">{label}</p>
      <div className="flex items-end gap-2.5">
        <span className="text-[40px] font-extrabold leading-none tabular-nums tracking-[-0.02em]" style={{ color: accent }}>{ours}</span>
        {multiplier && (
          <span className="mb-1 rounded-full px-2.5 py-1 text-[10.5px] font-bold" style={{ background: `${accent}14`, color: accent }}>{multiplier}</span>
        )}
      </div>
      <p className="text-[12.5px] leading-snug text-[#374151]">{caption}</p>
      <div className="mt-auto flex items-center justify-between border-t border-[#f3f4f6] pt-2.5 text-[11.5px]">
        <span className="text-[#9ca3af]">Industry average</span>
        <span className="font-semibold tabular-nums text-[#6b7280]">{theirs}</span>
      </div>
    </div>
  );
}

/* ── before/after compare table (Your team → month 1/2/3 → Now) ── */
export function CompareTable({
  columns,
  rows,
}: {
  columns: string[]; // [Your team, M1, M2, Now]
  rows: { metric: string; values: string[]; better: "up" | "down" }[];
}) {
  const last = columns.length - 1;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate" style={{ borderSpacing: 0 }}>
        <thead>
          <tr>
            <th className="px-5 py-3 text-left text-[10.5px] font-bold uppercase tracking-wider text-[#9ca3af]">Metric</th>
            {columns.map((c, i) => {
              const isBaseline = i === 0;
              const isLast = i === last;
              return (
                <th
                  key={c}
                  className={`px-5 py-3 text-right text-[11px] font-bold ${
                    isBaseline ? "text-[#9ca3af]" : isLast ? "text-[#059669]" : "text-[#a78bfa]"
                  } ${isLast ? "rounded-t-xl bg-[#f0fdf6]" : ""}`}
                >
                  <span className="inline-flex items-center gap-1.5">
                    {isLast && <span className="h-1.5 w-1.5 rounded-full bg-[#10b981]" />}
                    {c}
                  </span>
                </th>
              );
            })}
            <th className="w-10" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => {
            const isLastRow = ri === rows.length - 1;
            return (
              <tr key={r.metric} className="group">
                <td className="border-t border-[#f0f0f0] px-5 py-3 text-[12.5px] font-semibold text-[#111] group-hover:bg-[#fafafa]">
                  {r.metric}
                </td>
                {r.values.map((v, i) => {
                  const isBaseline = i === 0;
                  const isLast = i === last;
                  return (
                    <td
                      key={i}
                      className={`border-t border-[#f0f0f0] px-5 py-3 text-right text-[13px] tabular-nums ${
                        isBaseline ? "text-[#9ca3af]" : isLast ? "font-extrabold text-[#059669]" : "text-[#6b7280]"
                      } ${isLast ? `bg-[#f0fdf6] ${isLastRow ? "rounded-b-xl" : ""}` : "group-hover:bg-[#fafafa]"}`}
                    >
                      {v}
                    </td>
                  );
                })}
                <td className="border-t border-[#f0f0f0] pl-2 pr-4 text-right group-hover:bg-[#fafafa]">
                  <span className="text-[14px] font-bold text-[#10b981]" title="improved">
                    {r.better === "up" ? "↗" : "↘"}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="px-5 pt-3 text-[11px] text-[#9ca3af]">
        First column is your setup before Vini · the highlighted column is where you are now.
      </p>
    </div>
  );
}

/* ── progress bar (onboarding import, etc.) ── */
export function ProgressBar({ pct, color = "#813fed" }: { pct: number; color?: string }) {
  return (
    <div className="h-2.5 w-full overflow-hidden rounded-full bg-[#f0f0f0]">
      <div className="h-2.5 rounded-full transition-all" style={{ width: `${Math.max(3, Math.min(100, pct))}%`, background: color }} />
    </div>
  );
}

/* ── "still calibrating / early data" banner ── */
export function CalibratingBanner({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-[#fde68a] bg-[#fffbeb] px-5 py-3.5">
      <span className="text-[18px] leading-none">🌱</span>
      <div>
        <p className="text-[12.5px] font-bold text-[#92400e]">{title}</p>
        <p className="text-[11.5px] leading-snug text-[#a16207]">{body}</p>
      </div>
    </div>
  );
}

/* ── low-sample / low-confidence chip ── */
export function ConfidenceChip({ level }: { level: "none" | "low" | "high" }) {
  if (level === "high") return null;
  const map = {
    low: { bg: "#fef3c7", fg: "#92400e", label: "Low sample" },
    none: { bg: "#f3f4f6", fg: "#6b7280", label: "No data yet" },
  } as const;
  const s = map[level];
  return <span className="rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: s.bg, color: s.fg }}>{s.label}</span>;
}

/* ── generic empty state (no data for this card) ── */
export function EmptyState({ icon, title, body, cta }: { icon: string; title: string; body: string; cta?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[#e0e0e0] bg-[#fcfcfd] px-6 py-10 text-center">
      <span className="text-[26px] leading-none">{icon}</span>
      <p className="text-[13.5px] font-bold text-[#111]">{title}</p>
      <p className="max-w-[440px] text-[12px] leading-snug text-[#6b7280]">{body}</p>
      {cta && (
        <button className="mt-2 rounded-lg bg-[#813fed] px-4 py-2 text-[12px] font-semibold text-white transition-colors hover:bg-[#6d28d9]">
          {cta}
        </button>
      )}
    </div>
  );
}

/* ── locked/ghost preview of content that isn't available yet ── */
export function GhostPreview({ title, body }: { title: string; body: string }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-[#e5e7eb] bg-white">
      <div className="pointer-events-none select-none p-6 opacity-60 blur-[3px]" aria-hidden>
        <div className="grid grid-cols-3 gap-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-24 rounded-xl bg-gradient-to-br from-[#f3f4f6] to-[#eaecef]" />
          ))}
        </div>
        <div className="mt-4 h-40 rounded-xl bg-gradient-to-br from-[#f3f4f6] to-[#eaecef]" />
        <div className="mt-4 grid grid-cols-2 gap-4">
          <div className="h-28 rounded-xl bg-[#f3f4f6]" />
          <div className="h-28 rounded-xl bg-[#f3f4f6]" />
        </div>
      </div>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-white/45 px-6 text-center">
        <span className="text-[22px] leading-none">🔒</span>
        <p className="text-[13.5px] font-bold text-[#111]">{title}</p>
        <p className="max-w-[460px] text-[12px] leading-snug text-[#6b7280]">{body}</p>
      </div>
    </div>
  );
}

/* ── "coming soon" placeholder — shown wherever a section has no live data source yet, so the
 * report never renders fabricated numbers. `inline` = compact chip for a single tile/stat. ── */
export function ComingSoon({ title, note, inline }: { title: string; note?: string; inline?: boolean }) {
  if (inline) {
    return (
      <div className="flex flex-col gap-0.5 rounded-xl border border-dashed border-[#e0d8f5] bg-[#faf8ff] px-3.5 py-2.5">
        <span className="inline-flex w-fit items-center gap-1 rounded-full bg-[#f3eaff] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[#813fed]">
          <span className="h-1 w-1 rounded-full bg-[#813fed]" /> Coming soon
        </span>
        <span className="mt-0.5 text-[11.5px] font-semibold text-[#6b7280]">{title}</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[#e0d8f5] bg-[#faf8ff] px-6 py-10 text-center">
      <span className="inline-flex items-center gap-1.5 rounded-full bg-[#f3eaff] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-[#813fed]">
        <span className="h-1.5 w-1.5 rounded-full bg-[#813fed]" /> Coming soon
      </span>
      <p className="text-[13px] font-bold text-[#111]">{title}</p>
      {note && <p className="max-w-[420px] text-[11.5px] leading-snug text-[#9ca3af]">{note}</p>}
    </div>
  );
}

/* ── setup step checklist ── */
export function StepList({ steps }: { steps: { label: string; done?: boolean; active?: boolean }[] }) {
  return (
    <ol className="flex flex-col gap-2.5">
      {steps.map((s, i) => (
        <li key={i} className="flex items-center gap-3">
          <span
            className={`flex h-6 w-6 flex-none items-center justify-center rounded-full text-[11px] font-bold ${
              s.done ? "bg-[#10b981] text-white" : s.active ? "bg-[#813fed] text-white" : "bg-[#f3f4f6] text-[#9ca3af]"
            }`}
          >
            {s.done ? "✓" : i + 1}
          </span>
          <span className={`text-[13px] ${s.done ? "text-[#9ca3af] line-through decoration-[#d1d5db]" : s.active ? "font-bold text-[#111]" : "text-[#6b7280]"}`}>
            {s.label}
          </span>
          {s.active && <span className="ml-auto rounded-full bg-[#f3eaff] px-2 py-0.5 text-[10px] font-bold text-[#813fed]">In progress</span>}
        </li>
      ))}
    </ol>
  );
}

/* ── highlight / action-item row ── */
export function HighlightRow({ kind, text, value }: { kind: "win" | "miss"; text: string; value?: string }) {
  return (
    <div className="flex items-start gap-3 px-6 py-3.5">
      <span
        className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full text-[11px] font-bold"
        style={{ background: kind === "win" ? "#dcfce7" : "#fef3c7", color: kind === "win" ? "#065f46" : "#92400e" }}
      >
        {kind === "win" ? "✓" : "!"}
      </span>
      <p className="text-[12.5px] text-[#374151] flex-1">{text}</p>
      {value && <span className="text-[12.5px] font-bold tabular-nums text-[#111] flex-none">{value}</span>}
    </div>
  );
}
