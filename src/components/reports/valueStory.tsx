"use client";

/* THE VALUE STORY — the single narrative that must run through sales → onboarding → training → live
 * (product direction, 2026-07-23/24). Value is organized into THREE flows the dealer progresses through:
 *
 *   1. After-hours          — the ~1-in-3 leads that used to slip after close. The beachhead we fix first.
 *   2. During-hours overflow — the calls the human team can't pick up in the moment. Fixed next.
 *   3. All leads            — every lead, every hour. Full coverage once the dealer trusts 1 & 2.
 *
 * EACH FLOW LEADS WITH ITS PAIN — "why would a dealer buy this?" The cost of NOT having it (no one's there
 * for your after-hours leads; busy-hour callers hit voicemail and book elsewhere) is stated first, then the
 * relief. A flow that's ON shows problem → solved, with the real recovered number. A flow that's OFF shows
 * the pain it would fix + a "Turn on in Training" path — which is also the "unlock full potential" loop.
 *
 * Inside each flow the SAME four functionalities work — Calls, Speed-to-lead, Follow-ups, Appointment
 * reminders — rolling up to an INCREMENTAL impact line. Dollar value is deliberately DEFERRED (next week).
 *
 * DATA REALITY (per eng): the after-hours / overflow / all-leads SPLIT isn't in the DB yet, so only the
 * After-hours flow is populated today (from real fleet fields — afterHours is a genuine after-hours count;
 * the four tallies are whole-agent totals, flagged on the card). Overflow & All-leads render as OFF, which
 * is the true product state and also drives the exact expansion narrative the story wants. */

import React from "react";
import { fmtSecs } from "./kitV3";
import { CountUp } from "./anim";
import type { FleetLive, ActionItemStats } from "./liveData";

const C = {
  primary: "#4600f2",
  dark: "#030712",
  sub: "#626f81",
  green: "#0a6029",
  greenBg: "#e8ffee",
  amber: "#b45309",
  amberBg: "#fffbeb",
  red: "#ca1f34",
  redBg: "#fff1f0",
};

export type BucketId = "afterhours" | "overflow" | "allleads";
export interface BucketDef { id: BucketId; title: string; window: string; pain: string; gain: string }
export const VALUE_BUCKETS: BucketDef[] = [
  { id: "afterhours", title: "After hours", window: "while your floor is closed", pain: "No one's there for your after-hours leads — about 1 in 3 slips away before you reopen.", gain: "Now every after-hours lead gets answered." },
  { id: "overflow", title: "During-hours overflow", window: "when every advisor is busy", pain: "When all your advisors are on a call, the next caller hits voicemail — and books somewhere else.", gain: "Catch every busy-hour caller instead of losing them." },
  { id: "allleads", title: "All leads", window: "every lead, every hour", pain: "Even in-hours, leads sit in a queue waiting for a human to be free.", gain: "Full coverage — no lead ever waits for a human." },
];

/* THE GOAL LINE — the three targets every flow is driven to (product whiteboard): 100% coverage,
 * <60s response, relentless follow-up. In Live it shows the achieved value against the target (✓ when
 * met); in Training it shows the target we're driving toward, filling in as the first data lands. */
export function FlowGoals({ coveragePct, responseSec, followups, mode = "live" }: {
  coveragePct: number | null;
  responseSec: number | null;
  followups: number | null;
  mode?: "live" | "training";
}) {
  const training = mode === "training";
  const cells: { icon: string; label: string; goal: string; node: React.ReactNode; met: boolean }[] = [
    { icon: "🎯", label: "Coverage", goal: "100% of leads touched",
      node: coveragePct == null ? "—" : <CountUp value={coveragePct} format={(n) => `${Math.round(n)}%`} />,
      met: coveragePct != null && coveragePct >= 99 },
    { icon: "⚡", label: "Response time", goal: "under 60s, every lead",
      node: fmtSecs(responseSec), met: responseSec != null && responseSec <= 60 },
    { icon: "🔁", label: "Follow-ups", goal: "every lead worked till it converts",
      node: followups == null ? "—" : <CountUp value={followups} />, met: (followups ?? 0) > 0 },
  ];
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {cells.map((c) => (
        <div key={c.label} className="rounded-xl border border-[#f0f0f0] bg-[#fafafa] px-3.5 py-3">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-[#626f81]"><span>{c.icon}</span>{c.label}</span>
            {!training && c.met && <span className="rounded-full bg-[#e8ffee] px-1.5 py-0.5 text-[9px] font-bold text-[#0a6029]">✓ on goal</span>}
          </div>
          <p className="mt-1 text-[20px] font-extrabold tabular-nums leading-none text-[#030712]">{c.node}</p>
          <p className="mt-1 text-[10px] leading-snug text-[#9aa1ac]">{training ? "Goal: " : ""}{c.goal}</p>
        </div>
      ))}
    </div>
  );
}

function StatusChip({ tone, label }: { tone: "green" | "grey"; label: string }) {
  const map = { green: { dot: "#10b981", bg: C.greenBg, fg: C.green }, grey: { dot: "#c7ccd3", bg: "#f3f4f6", fg: "#6b7280" } }[tone];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide" style={{ background: map.bg, color: map.fg }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: map.dot }} />{label}
    </span>
  );
}

/* ── the three-flow impact story. Lives in TRAINING (the value pitch) and can also render in a live
 *    context. In training mode the OFF-flow "Turn on in Training" CTA and the after-hours "View all"
 *    are hidden (you're already in training; there's no live report to view yet). ── */
export function ImpactStory({
  fleet,
  aiStats,
  onViewAfterHours,
  onBackToTraining,
  mode = "live",
}: {
  fleet: FleetLive;
  aiStats: ActionItemStats | null;
  onViewAfterHours: () => void;
  onBackToTraining: () => void;
  mode?: "live" | "training";
}) {
  const outcome = [
    { label: "leads recovered", value: fleet.afterHours },
    { label: "real conversations", value: fleet.conversations },
    { label: "appointments", value: fleet.appointments },
  ];

  return (
    <div className="flex flex-col gap-3.5">
      <style>{`
        @keyframes vsRise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .vs-rise { animation: vsRise .5s cubic-bezier(.16,1,.3,1) both; }
        .vs-lift { transition: box-shadow .22s ease, transform .22s ease; }
        .vs-lift:hover { transform: translateY(-2px); box-shadow: 0 18px 36px -20px rgba(40,35,80,0.28); }
        @media (prefers-reduced-motion: reduce) { .vs-rise { animation: none; } }
      `}</style>

      <div className="flex items-baseline justify-between">
        <p className="text-[12px] font-bold uppercase tracking-wide text-[#030712]">📈 Your incremental impact</p>
        <p className="text-[11.5px] text-[#626f81]">Business your AI added on top of what your team already handles — one flow at a time</p>
      </div>

      {/* 1 · After hours — ON. Leads with the pain it solved, then the recovered number. */}
      <div className="vs-rise vs-lift overflow-hidden rounded-[14px] border border-[#e5e7eb] bg-white" style={{ animationDelay: "0ms" }}>
        <div className="flex items-stretch">
          <span className="w-1.5 flex-none" style={{ background: C.green }} />
          <div className="flex-1 p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-[16px] font-bold text-[#030712]">After hours</p>
                  <StatusChip tone="green" label="Running · live" />
                </div>
                {/* the pain, stated plainly — why this flow matters */}
                <p className="mt-1 text-[12px] leading-snug text-[#626f81]"><span className="font-semibold text-[#ca1f34]">The problem:</span> {VALUE_BUCKETS[0].pain}</p>
              </div>
            </div>

            <p className="mt-4 mb-2 text-[10px] font-bold uppercase tracking-wide text-[#9aa1ac]">The goal line</p>
            <FlowGoals coveragePct={fleet.answerRateInbound} responseSec={fleet.responseTimeSec} followups={aiStats?.created ?? null} mode="live" />

            {/* the incremental lift — the dealer's real question, "did my business grow?", answered as
                a plain before → after. Left = the pain baseline; right = what the AI actually added. */}
            <div className="mt-4 grid gap-2.5 sm:grid-cols-[1fr_auto_1.4fr]">
              <div className="rounded-xl border border-[#f3d9d5] bg-[#fff5f4] px-4 py-3">
                <p className="text-[10px] font-bold uppercase tracking-wide text-[#ca1f34]">Without Vini</p>
                <p className="mt-1 text-[12px] leading-snug text-[#8a6a66]">~1 in 3 after-hours leads never got a call back — gone by morning.</p>
              </div>
              <div className="hidden items-center justify-center sm:flex"><span className="text-[18px] text-[#c7ccd3]">→</span></div>
              <div className="rounded-xl border border-[#bfe6cd] bg-[#f0fdf6] px-4 py-3">
                <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: C.green }}>With Vini · now working for you</p>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                  {outcome.map((o, i) => (
                    <React.Fragment key={o.label}>
                      {i > 0 && <span className="text-[#bfe6cd]">·</span>}
                      <CountUp value={o.value} className="text-[15px] font-extrabold tabular-nums text-[#030712]" />
                      <span className="text-[11.5px] text-[#4b6b58]">{o.label}</span>
                    </React.Fragment>
                  ))}
                </div>
              </div>
            </div>
            <div className="mt-2 flex items-center justify-between gap-3">
              <p className="text-[10.5px] text-[#9aa1ac]">Whole-agent totals for now — the after-hours-only split lands with your next data sync. Dollar value arrives next.</p>
              {mode === "live" && <button onClick={onViewAfterHours} className="flex-none text-[12px] font-semibold" style={{ color: C.primary }}>View all →</button>}
            </div>
          </div>
        </div>
      </div>

      {/* 2 · Overflow — OFF. Leads with the pain, offers to turn it on (the "full potential" path). */}
      <OffFlow bucket={VALUE_BUCKETS[1]} delay={70} onBackToTraining={onBackToTraining} mode={mode} />

      {/* 3 · All leads — OFF. */}
      <OffFlow bucket={VALUE_BUCKETS[2]} delay={140} onBackToTraining={onBackToTraining} mode={mode} />
    </div>
  );
}

/* An OFF flow — the dealer isn't running this yet. Lead with the cost of not having it. In LIVE it offers
 * the path to turn it on (back to Training); in TRAINING the CTA is dropped (the agent cards above own
 * enablement) so it reads as a pure "here's what else you could switch on" pitch. */
function OffFlow({ bucket, delay, onBackToTraining, mode }: { bucket: BucketDef; delay: number; onBackToTraining: () => void; mode: "live" | "training" }) {
  return (
    <div className="vs-rise overflow-hidden rounded-[14px] border border-dashed border-[#e0e0e0] bg-[#fcfcfd]" style={{ animationDelay: `${delay}ms` }}>
      <div className="flex items-stretch">
        <span className="w-1.5 flex-none bg-[#e5e7eb]" />
        <div className="flex flex-1 flex-wrap items-center justify-between gap-4 p-5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="text-[16px] font-bold text-[#030712]">{bucket.title}</p>
              <StatusChip tone="grey" label="Off — not enabled" />
            </div>
            <p className="mt-1 max-w-[560px] text-[12.5px] leading-snug text-[#374151]">
              <span className="font-semibold text-[#ca1f34]">What you&apos;re losing:</span> {bucket.pain}
            </p>
            <p className="mt-1 text-[11.5px] font-semibold text-[#059669]">→ {bucket.gain}</p>
          </div>
          {mode === "live" && <button onClick={onBackToTraining} className="flex-none rounded-lg px-4 py-2 text-[12.5px] font-bold text-white" style={{ background: C.primary }}>Turn on in Training →</button>}
        </div>
      </div>
    </div>
  );
}

/* The headline "unlock full potential" banner — shown in Live above the impact story. Names how many of
 * the three flows are live and drives the dealer back to Training to switch the rest on. */
export function UnlockPotentialBanner({ liveCount = 1, total = 3, onBackToTraining }: { liveCount?: number; total?: number; onBackToTraining: () => void }) {
  return (
    <div className="vs-rise flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-[#d8caff] px-5 py-4" style={{ background: "linear-gradient(100deg,#f6f1ff,#fdf1f6)" }}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-full text-[14px]" style={{ background: "#efe9ff" }}>🔓</span>
        <div>
          <p className="text-[13.5px] font-bold text-[#030712]">You&apos;re running {liveCount} of {total} flows — your agent can do more.</p>
          <p className="text-[11.5px] leading-snug text-[#626f81]">You&apos;re live on After-hours. Turn on Overflow and All-Leads to unlock your agent&apos;s full potential — no lead lost, any hour.</p>
        </div>
      </div>
      <button onClick={onBackToTraining} className="flex-none rounded-lg px-4 py-2 text-[12.5px] font-bold text-white" style={{ background: C.primary }}>Back to Training to enable →</button>
    </div>
  );
}

/* ── the flow progression, used in TRAINING as the rollout "milestones" (after-hours → overflow → all
 *    leads). Shows the dealer where they are; `activeIndex` = the flow they're currently on. ── */
export function BucketJourney({ activeIndex = 0, accent = "#813fed" }: { activeIndex?: number; accent?: string }) {
  return (
    <div className="flex items-start">
      {VALUE_BUCKETS.map((b, i) => {
        const done = i < activeIndex;
        const active = i === activeIndex;
        return (
          <div key={b.id} className="flex flex-1 items-start last:flex-none">
            <div className="flex flex-col items-center gap-1.5 text-center" style={{ width: 92 }}>
              <span
                className="flex h-7 w-7 flex-none items-center justify-center rounded-full text-[11px] font-bold"
                style={done ? { background: accent, color: "#fff" } : active ? { background: `${accent}1a`, color: accent, boxShadow: `0 0 0 2px ${accent}` } : { background: "#f3f4f6", color: "#9ca3af" }}
              >
                {done ? "✓" : i + 1}
              </span>
              <span className={`text-[10.5px] leading-tight ${done || active ? "font-semibold text-[#111]" : "text-[#9ca3af]"}`}>{b.title}</span>
              {active && <span className="rounded-full bg-[#f3eaff] px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-wide text-[#813fed]">You&apos;re here</span>}
            </div>
            {i < VALUE_BUCKETS.length - 1 && <div className="mt-3.5 h-0.5 flex-1" style={{ background: done ? accent : "#f0f0f0" }} />}
          </div>
        );
      })}
    </div>
  );
}
