"use client";

/* First-time welcome experience — a short, beautiful 3-step tour that greets a dealer the moment they
 * first land on the report (just went live), then dissolves to reveal it. Deliberately minimal: one
 * card, three steps, one primary action per step. The value here is the MOTION and FLOW, not the copy —
 * backdrop blur-in, card pop, per-step crossfade/slide, a growing progress rail, a floating sparkle and
 * a nudging CTA. Fully keyboard-driven (→/Enter next · ←back · Esc skip) and respects reduced-motion.
 *
 * Stateless about "seen" — the host (OverviewView) decides when to open it (first visit per rooftop via
 * localStorage, or ?tour=1 to replay) and records dismissal. */

import React from "react";
import { Portal } from "./kit";

interface Step { badge: string; title: string; body: string }

function stepsFor(accountName: string): Step[] {
  const who = accountName && accountName !== "your rooftop" ? accountName : "Your dealership";
  return [
    { badge: "🎉", title: "You're live!", body: `${who}'s AI agents are online — already calling, texting and booking appointments around the clock.` },
    { badge: "📍", title: "Everything in one place", body: "Every call, text, appointment and follow-up shows up right here as it happens — nothing to log by hand." },
    { badge: "✨", title: "We fill it in for you", body: "Real numbers replace this setup view automatically, usually within a day of going live. That's the whole setup." },
  ];
}

export function FirstTimeTour({
  open,
  accountName,
  onClose,
}: {
  open: boolean;
  accountName: string;
  onClose: () => void;
}) {
  const steps = React.useMemo(() => stepsFor(accountName), [accountName]);
  const [i, setI] = React.useState(0);
  // Reset to the first step whenever the tour (re)opens, so a replay always starts clean.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  React.useEffect(() => { if (open) setI(0); }, [open]);

  const last = i >= steps.length - 1;
  const next = React.useCallback(() => { if (last) onClose(); else setI((s) => s + 1); }, [last, onClose]);
  const back = React.useCallback(() => setI((s) => Math.max(0, s - 1)), []);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      else if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); next(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); back(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, next, back, onClose]);

  if (!open) return null;
  const s = steps[i];
  const pct = ((i + 1) / steps.length) * 100;

  return (
    <Portal>
    <div className="no-print fixed inset-0 z-[80] flex items-center justify-center p-5">
      <style>{`
        @keyframes ftFade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes ftPop { from { opacity: 0; transform: translateY(16px) scale(0.965); } to { opacity: 1; transform: translateY(0) scale(1); } }
        @keyframes ftStep { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes ftSpark { 0%,100% { transform: translateY(0) rotate(-6deg); } 50% { transform: translateY(-4px) rotate(6deg); } }
        @keyframes ftGlow { 0%,100% { box-shadow: 0 16px 34px -12px rgba(129,63,237,0.55); } 50% { box-shadow: 0 20px 46px -10px rgba(129,63,237,0.8); } }
        @keyframes ftArrow { 0%,100% { transform: translateX(0); } 50% { transform: translateX(4px); } }
        .ft-scrim { animation: ftFade .28s ease both; }
        .ft-card { animation: ftPop .5s cubic-bezier(.16,1,.3,1) both; }
        .ft-step { animation: ftStep .38s cubic-bezier(.16,1,.3,1) both; }
        .ft-badge { animation: ftGlow 2.6s ease-in-out infinite; }
        .ft-spark { animation: ftSpark 2.2s ease-in-out infinite; }
        .ft-cta:hover .ft-arrow { animation: ftArrow 1s ease-in-out infinite; }
        .ft-rail > i { transition: width .45s cubic-bezier(.16,1,.3,1); }
        .ft-dot { transition: width .35s ease, background .35s ease; }
        @media (prefers-reduced-motion: reduce) {
          .ft-scrim, .ft-card, .ft-step { animation: none; }
          .ft-badge, .ft-spark { animation: none; }
        }
      `}</style>

      {/* backdrop — blurs the report behind; click anywhere to skip */}
      <div className="ft-scrim absolute inset-0 bg-[#1c1533]/35 backdrop-blur-[3px]" onClick={onClose} aria-hidden />

      {/* card */}
      <div role="dialog" aria-modal="true" aria-label="Welcome" className="ft-card relative z-10 w-full max-w-[420px] overflow-hidden rounded-[24px] border border-[#ece6fb] bg-white shadow-[0_40px_90px_-24px_rgba(70,20,140,0.55)]">
        {/* growing progress rail */}
        <div className="ft-rail h-1 w-full bg-[#f1edfb]"><i className="block h-full rounded-r-full bg-gradient-to-r from-[#813fed] to-[#a78bfa]" style={{ width: `${pct}%` }} /></div>

        <div className="flex flex-col items-center px-8 pb-7 pt-9 text-center">
          {/* gradient badge with floating sparkle */}
          <div className="ft-badge relative mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-[#813fed] to-[#a78bfa] text-[30px]">
            <span key={i} className="ft-step">{s.badge}</span>
            <span className="ft-spark absolute -right-1.5 -top-1.5 text-[15px]">✨</span>
          </div>

          {/* step content — re-keyed so it crossfades/slides on each change */}
          <div key={i} className="ft-step">
            <h2 className="text-[22px] font-extrabold tracking-[-0.02em] text-[#111]">{s.title}</h2>
            <p className="mx-auto mt-2.5 max-w-[320px] text-[13.5px] leading-relaxed text-[#6b7280]">{s.body}</p>
          </div>

          {/* step dots */}
          <div className="mt-6 flex items-center gap-1.5">
            {steps.map((_, k) => (
              <span key={k} className="ft-dot h-1.5 rounded-full" style={{ width: k === i ? 22 : 6, background: k === i ? "#813fed" : "#dcd6f0" }} />
            ))}
          </div>

          {/* actions */}
          <button
            onClick={next}
            className="ft-cta mt-6 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#813fed] px-5 py-3 text-[14px] font-bold text-white transition-colors hover:bg-[#6d28d9]"
          >
            {last ? "Take a look around" : "Next"} <span className="ft-arrow">→</span>
          </button>
          <div className="mt-3 flex items-center justify-center gap-4 text-[12px] font-semibold">
            {i > 0 ? (
              <button onClick={back} className="text-[#9ca3af] hover:text-[#6b7280]">← Back</button>
            ) : <span />}
            {!last && <button onClick={onClose} className="text-[#9ca3af] hover:text-[#6b7280]">Skip tour</button>}
          </div>
        </div>
      </div>
    </div>
    </Portal>
  );
}
