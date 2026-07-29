"use client";

/* The dealer journey as ONE connected flow — Onboarding → Training → Live — so the story sales sold is
 * the story the dashboard tells (product direction: the flow is what prevents churn). This file owns the
 * stage stepper (the spine) and the Onboarding go-live checklist stub that makes the journey whole.
 *
 * Onboarding here is a light, honest stub — the real setup wizard lives elsewhere; this is enough to show
 * where Training/Live come from and to carry the same value language forward. */

import React from "react";

export type Stage = "onboarding" | "training" | "live";
const ORDER: Stage[] = ["onboarding", "training", "live"];
const LABELS: Record<Stage, string> = { onboarding: "Onboarding", training: "Training", live: "Live" };

/* ── stage stepper — the top-level spine. Past stages show a check; the current is filled; you can jump. ── */
export function StageStepper({ stage, onJump }: { stage: Stage; onJump: (s: Stage) => void }) {
  const idx = ORDER.indexOf(stage);
  return (
    <div className="no-print flex items-center gap-1.5">
      {ORDER.map((s, i) => {
        const done = i < idx;
        const active = i === idx;
        return (
          <React.Fragment key={s}>
            <button
              onClick={() => onJump(s)}
              className="group flex items-center gap-2 rounded-full px-3 py-1.5 transition-colors"
              style={active ? { background: "#f3eaff" } : undefined}
            >
              <span
                className="flex h-5 w-5 flex-none items-center justify-center rounded-full text-[10px] font-bold"
                style={done ? { background: "#10b981", color: "#fff" } : active ? { background: "#813fed", color: "#fff" } : { background: "#e9e7ef", color: "#9ca3af" }}
              >
                {done ? "✓" : i + 1}
              </span>
              <span className={`text-[12.5px] font-semibold ${active ? "text-[#813fed]" : done ? "text-[#111]" : "text-[#9ca3af] group-hover:text-[#6b7280]"}`}>{LABELS[s]}</span>
            </button>
            {i < ORDER.length - 1 && <span className="h-px w-6 flex-none" style={{ background: i < idx ? "#10b981" : "#e5e7eb" }} />}
          </React.Fragment>
        );
      })}
    </div>
  );
}

/* ── Onboarding stub — the go-live checklist. Same value props Vini sells, a progress ring, and the
 *    "Take it live" hand-off into Training. Deliberately not the full wizard. ── */
const VALUE_PROPS = [
  { icon: "⚡", t: "Never miss a lead", d: "answers 24/7, even after close" },
  { icon: "📅", t: "Books appointments", d: "straight into your CRM" },
  { icon: "🎯", t: "3× ROI", d: "the 90-day goal" },
  { icon: "🧑‍🔧", t: "Frees your team", d: "handles routine questions" },
];
const STEPS = [
  { t: "Rooftop details", d: "Store name, address, brands", done: true },
  { t: "CRM & scheduler connection", d: "Sync your CRM and calendar", done: true },
  { t: "Agent persona & greeting", d: "Name, voice, and opening line", active: true },
  { t: "Phone & call routing", d: "Number, transfers, and overflow rules", min: "20 min" },
  { t: "Business & after-hours coverage", d: "Hours and after-hours handling", min: "24 min" },
  { t: "Review & go live", d: "Final check, then launch", min: "28 min" },
];

export function OnboardingStub({ onGoLive }: { onGoLive: () => void }) {
  const doneCount = STEPS.filter((s) => s.done).length;
  const pct = Math.round((doneCount / STEPS.length) * 100);
  return (
    <div className="flex flex-col gap-6">
      <style>{`
        @keyframes sfRise { from { opacity:0; transform:translateY(10px);} to {opacity:1; transform:translateY(0);} }
        .sf-rise { animation: sfRise .5s cubic-bezier(.16,1,.3,1) both; }
        .sf-cta:hover .sf-arrow { transform: translateX(3px); }
        .sf-arrow { transition: transform .2s ease; }
        @media (prefers-reduced-motion: reduce){ .sf-rise{ animation:none; } }
      `}</style>

      {/* agent + value props */}
      <section className="sf-rise flex flex-col gap-5 rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm sm:flex-row sm:items-center">
        <div className="flex h-20 w-20 flex-none items-center justify-center rounded-2xl bg-gradient-to-br from-[#813fed] to-[#a78bfa] text-[34px] font-extrabold text-white">V</div>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-bold uppercase tracking-wider text-[#9ca3af]">Sales · Inbound + Outbound</p>
          <p className="text-[22px] font-extrabold tracking-[-0.02em] text-[#111]">Vini</p>
          <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 lg:grid-cols-4">
            {VALUE_PROPS.map((v) => (
              <div key={v.t} className="flex items-start gap-2">
                <span className="flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-[#f4effe] text-[13px]">{v.icon}</span>
                <div className="min-w-0">
                  <p className="text-[12px] font-bold text-[#111]">{v.t}</p>
                  <p className="text-[10.5px] leading-snug text-[#6b7280]">{v.d}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* progress banner */}
      <section className="sf-rise flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-[#141021] px-6 py-5 text-white" style={{ animationDelay: "60ms" }}>
        <div className="flex items-center gap-4">
          <div className="relative flex h-14 w-14 flex-none items-center justify-center rounded-full" style={{ background: `conic-gradient(#813fed ${pct}%, #2c2640 ${pct}%)` }}>
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[#141021] text-[13px] font-bold">{pct}%</span>
          </div>
          <div>
            <p className="text-[16px] font-bold">You&apos;re {pct}% of the way there</p>
            <p className="text-[12px] text-[#a9a3c2]">{doneCount} of {STEPS.length} steps done · about 15 minutes of setup left</p>
          </div>
        </div>
        <button onClick={onGoLive} className="sf-cta flex items-center gap-2 rounded-xl bg-white px-5 py-2.5 text-[13px] font-bold text-[#111]">Continue setup <span className="sf-arrow">→</span></button>
      </section>

      {/* checklist */}
      <section className="sf-rise overflow-hidden rounded-2xl border border-[#e5e7eb] bg-white shadow-sm" style={{ animationDelay: "120ms" }}>
        {STEPS.map((s, i) => {
          const active = "active" in s && s.active;
          return (
            <div key={s.t} className={`flex items-center gap-4 border-b border-[#f3f4f6] px-6 py-4 last:border-0 ${active ? "bg-[#141021] text-white" : ""}`}>
              <span
                className="flex h-6 w-6 flex-none items-center justify-center rounded-full text-[11px] font-bold"
                style={s.done ? { background: "#10b981", color: "#fff" } : active ? { background: "#813fed", color: "#fff" } : { background: "#f3f4f6", color: "#9ca3af" }}
              >
                {s.done ? "✓" : i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className={`text-[13.5px] font-bold ${active ? "text-white" : "text-[#111]"}`}>{s.t}</p>
                <p className={`text-[11.5px] ${active ? "text-[#a9a3c2]" : "text-[#6b7280]"}`}>{s.d}</p>
              </div>
              <span className={`flex-none text-[11.5px] font-semibold ${s.done ? "text-[#059669]" : active ? "text-[#c9a8ff]" : "text-[#9ca3af]"}`}>
                {s.done ? "Done" : active ? "In progress" : s.min}
              </span>
            </div>
          );
        })}
      </section>

      <div className="sf-rise flex justify-end" style={{ animationDelay: "180ms" }}>
        <button onClick={onGoLive} className="sf-cta flex items-center gap-2 rounded-xl bg-[#813fed] px-6 py-3 text-[14px] font-bold text-white transition-colors hover:bg-[#6d28d9]">Take Vini live <span className="sf-arrow">→</span></button>
      </div>
    </div>
  );
}
