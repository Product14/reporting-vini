"use client";

/* "Just went live" training state — shown in place of the full Overview report while a rooftop has
 * never produced any real data yet (the `comingSoon` gate / ?state=training in OverviewView).
 *
 * IMPORTANT framing (per product feedback 2026-07-23): a rooftop that just went live has handled
 * NOTHING yet, so this view must NOT borrow the live report's "here's what your AI handled" language.
 * It presents CAPABILITIES — what each agent *can* do — plus which agents are live vs not and a few
 * pointers for finding your way around the console. Real numbers replace this automatically as the
 * first calls and messages land. "Expected impact" is intentionally NOT shown here — that lives on the
 * outbound page, separately.
 *
 * Two things aren't backed by a real data source yet and are adapted rather than faked:
 *   - Per-agent feature enablement (Calls/STL/Follow-ups, Aged lead/Equity mining/Repurchase) — there's
 *     no per-team feature-flag API today. DEFAULT_FEATURES below is a representative placeholder.
 *   - Per-direction sold/onboarding status (not_sold / start_onboarding / continue_onboarding) — today
 *     the app only knows "sold" (present in account.agents) vs not. resolveDirectionStatus() derives the
 *     honest default from account.agents; the finer states are reachable via ?ib=/?ob= for review.
 *
 * Motion vocabulary is borrowed from the outbound prototype (Agent-Workflow /flows + the Studio .jsx):
 * staggered fade-up entrances on cubic-bezier(.16,1,.3,1), card hover-lift, and a nudging/shimmering CTA.
 */

import { Eyebrow, ProgressBar, SectionLabel } from "./kit";
import type { Account } from "./accounts";
import { BucketJourney, ImpactStory } from "./valueStory";
import type { FleetLive, ActionItemStats } from "./liveData";

// Early progress toward the goal line, shown in the Day-3 training state (null fields → Day-0, targets
// only). Mirrors the flow's three goals: coverage (% touched), response (secs), follow-ups (count).
export interface EarlyStats { coveragePct: number | null; responseSec: number | null; followups: number | null }

export type Direction = "Inbound" | "Outbound";
export type DirectionStatus = "not_sold" | "start_onboarding" | "continue_onboarding" | "training";
export interface FeatureFlag { key: string; label: string; enabled: boolean }

const ICONS: Record<Direction, string> = { Inbound: "📞", Outbound: "🚀" };

// The four functionalities that make up the inbound value story (Calls · Speed-to-lead · Follow-ups ·
// Appointment reminders) — these are what onboarding enables and what the live report measures per bucket.
// Outbound's analogue is its campaign set. Not-enabled → click through to Settings to turn on.
const DEFAULT_FEATURES: Record<Direction, FeatureFlag[]> = {
  Inbound: [
    { key: "afterhours", label: "After-hours calls", enabled: true },
    { key: "stl", label: "Speed-to-lead (STL)", enabled: true },
    { key: "followups", label: "Follow-ups", enabled: true },
    { key: "reminders", label: "Appointment reminders", enabled: false },
  ],
  Outbound: [
    { key: "aged", label: "Aged lead campaign", enabled: true },
    { key: "equity", label: "Equity mining", enabled: false },
    { key: "repurchase", label: "Repurchase campaign", enabled: false },
  ],
};

// CAPABILITIES — each leads with the STAKES ("why this matters"), then the relief. This is where the
// dealer sees why they'd want it, per product feedback: state the cost of not having it, then the fix.
// Each carries a CTA into the live report, where that capability's real numbers show up.
const CAPABILITIES: { icon: string; label: string; blurb: string; accent: string; cta: string }[] = [
  { icon: "⚡", label: "Respond in seconds", blurb: "Leads go cold in minutes — the AI calls & texts the second one lands, day or night.", accent: "#0ea5e9", cta: "See response times" },
  { icon: "🤖", label: "Resolve routine questions", blurb: "Repeat questions bury your team — the AI handles them so your people don't have to.", accent: "#813fed", cta: "See what's resolved" },
  { icon: "📋", label: "Never drop a follow-up", blurb: "Follow-ups slip through the cracks — the AI logs every next step for your team.", accent: "#ea760c", cta: "See follow-ups" },
  { icon: "📅", label: "Book appointments", blurb: "A missed callback is a lost visit — the AI books straight into your calendar.", accent: "#10b981", cta: "See appointments" },
  { icon: "🌙", label: "Work after-hours", blurb: "No one's there after close — the AI keeps answering and booking every lead.", accent: "#6d28d9", cta: "See after-hours wins" },
];

// Light "finding your way around" pointers — accurate to THIS console, not a full walkthrough.
const CONSOLE_TIPS: { icon: string; text: React.ReactNode }[] = [
  { icon: "💬", text: <>Every call &amp; text shows up under <b className="text-[#111]">Recent conversations</b>.</> },
  { icon: "✅", text: <>Follow-ups the AI logs for your team land in <b className="text-[#111]">Action items</b>.</> },
  { icon: "🗓", text: <>Change the window anytime from the <b className="text-[#111]">date filter</b>, top-right.</> },
];

/* Honest default: sold (present in account.agents) → this direction is part of the same just-went-live
 * rooftop, so it's "training" like the rest. Not sold → nothing to show but an explore prompt. An
 * explicit override (?ib=/?ob=) always wins, for reviewing the other two states. */
export function resolveDirectionStatus(account: Account, direction: Direction, override?: DirectionStatus): DirectionStatus {
  if (override) return override;
  return account.agents.some((a) => a.includes(direction)) ? "training" : "not_sold";
}

/* ── scoped motion (borrowed from the outbound prototype) ── */
function TrainingAnims() {
  return (
    <style>{`
      @keyframes trFadeUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes trPopIn { from { opacity: 0; transform: translateY(8px) scale(0.99); } to { opacity: 1; transform: translateY(0) scale(1); } }
      @keyframes trCtaArrow { 0%,100% { transform: translateX(0); } 50% { transform: translateX(3px); } }
      .tr-pop { animation: trPopIn .5s cubic-bezier(.16,1,.3,1) both; }
      .tr-rise { animation: trFadeUp .5s cubic-bezier(.16,1,.3,1) both; }
      .tr-lift { transition: box-shadow .22s ease, transform .22s ease; }
      .tr-lift:hover { transform: translateY(-2px); box-shadow: 0 18px 36px -20px rgba(40,35,80,0.35); }
      .tr-lift:hover .tr-ico { transform: scale(1.08); }
      .tr-ico { transition: transform .22s ease; }
      .tr-cta:hover .tr-arrow { animation: trCtaArrow 1s ease-in-out infinite; }
      @media (prefers-reduced-motion: reduce) {
        .tr-pop, .tr-rise { animation: none; }
        .tr-cta:hover .tr-arrow { animation: none; }
      }
    `}</style>
  );
}

function CapabilityTile({ icon, label, blurb, accent, delay, cta }: { icon: string; label: string; blurb: string; accent: string; delay: number; cta?: string }) {
  // In training the agent hasn't produced results yet, so the CTA is shown LOCKED (not clickable) — it
  // unlocks once the rooftop goes live and this capability's numbers exist to link to.
  return (
    <div className="tr-rise print-card flex flex-1 basis-0 min-w-[180px] flex-col gap-2 rounded-2xl border border-[#e5e7eb] bg-white px-4 py-3.5 shadow-sm" style={{ borderTop: `3px solid ${accent}`, animationDelay: `${delay}ms` }}>
      <div className="flex items-center gap-2.5">
        <div className="tr-ico flex h-8 w-8 flex-none items-center justify-center rounded-lg text-[15px]" style={{ background: `${accent}14` }}>{icon}</div>
        <p className="text-[12.5px] font-bold leading-tight text-[#111]">{label}</p>
      </div>
      <p className="text-[11px] leading-snug text-[#6b7280]">{blurb}</p>
      {cta && (
        <span className="mt-auto inline-flex items-center gap-1 pt-1.5 text-[11px] font-semibold text-[#b6bcc6]" title="Unlocks once your agent goes live">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="4" y="11" width="16" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
          {cta}
        </span>
      )}
    </div>
  );
}

function FeatureRow({ label, enabled }: { label: string; enabled: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[#f5f5f5] py-2 last:border-0">
      <span className="text-[12px] font-medium text-[#374151]">{label}</span>
      {enabled ? (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[#f0fdf6] px-2 py-0.5 text-[10px] font-bold text-[#059669]">
          <span className="h-1.5 w-1.5 rounded-full bg-[#10b981]" /> Enabled
        </span>
      ) : (
        <button className="inline-flex items-center gap-1 text-[10.5px] font-bold text-[#813fed] hover:underline" title="Turn this on in Settings">
          Enable in Settings →
        </button>
      )}
    </div>
  );
}

/* ── live-status pill: green (live/training) · grey (not active) · amber (onboarding) ── */
function StatusPill({ status }: { status: DirectionStatus }) {
  const map: Record<DirectionStatus, { dot: string; bg: string; fg: string; label: string }> = {
    training: { dot: "#10b981", bg: "#f0fdf6", fg: "#059669", label: "Live · Training" },
    continue_onboarding: { dot: "#f59e0b", bg: "#fffbeb", fg: "#b45309", label: "Onboarding" },
    start_onboarding: { dot: "#f59e0b", bg: "#fffbeb", fg: "#b45309", label: "Ready to onboard" },
    not_sold: { dot: "#d1d5db", bg: "#f3f4f6", fg: "#6b7280", label: "Not active" },
  };
  const s = map[status];
  return (
    <span className="inline-flex flex-none items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide" style={{ background: s.bg, color: s.fg }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.dot }} />
      {s.label}
    </span>
  );
}

/* ── the "training" rendering of an agent widget: capabilities are set up, but performance is still
 *    calibrating. Day 0 = no data yet (enablement + rollout only); Day 3 = early real numbers "starting
 *    to fill in" as the first activity lands (the reference's In-training state). ── */
function AgentTrainingCard({ direction, features, delay, earlyStats }: { direction: Direction; features: FeatureFlag[]; delay: number; earlyStats?: EarlyStats | null }) {
  const inbound = direction === "Inbound";
  const filling = inbound && !!earlyStats && ((earlyStats.followups ?? 0) > 0 || earlyStats.coveragePct != null || earlyStats.responseSec != null);
  return (
    <div className="tr-pop tr-lift print-card flex flex-col rounded-2xl border border-[#e5e7eb] bg-white px-5 py-4 shadow-sm" style={{ animationDelay: `${delay}ms` }}>
      <div className="mb-3 flex items-center gap-3">
        <div className="tr-ico flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-[#f4effe] text-[18px]">{ICONS[direction]}</div>
        <div className="min-w-0">
          <p className="truncate text-[14.5px] font-bold text-[#111]">{direction} agent</p>
          <p className="text-[11px] text-[#6b7280]">{inbound ? "Answers & responds to inbound leads" : "Works your aged & warm leads"}</p>
        </div>
        <span className="ml-auto"><StatusPill status="training" /></span>
      </div>

      <p className="mb-0.5 text-[9.5px] font-bold uppercase tracking-wide text-[#9ca3af]">Set up on this agent</p>
      <div className="mb-4">
        {features.map((f) => <FeatureRow key={f.key} label={f.label} enabled={f.enabled} />)}
      </div>

      {/* Rollout progression — the real "milestones": after-hours first, then overflow, then all leads.
          (Inbound only; outbound's story is its campaign set, shown on the outbound page.) */}
      {inbound && (
        <>
          <p className="mb-2.5 text-[9.5px] font-bold uppercase tracking-wide text-[#9ca3af]">Your rollout</p>
          <BucketJourney activeIndex={0} />
        </>
      )}

      <p className="mt-3.5 border-t border-dashed border-[#e5e7eb] pt-2.5 text-[10.5px] leading-snug text-[#9ca3af]">
        {filling
          ? "Real numbers, still calibrating — your full performance report unlocks as training completes."
          : "No activity yet — this card fills in with real numbers as soon as the first calls and messages land."}
      </p>
    </div>
  );
}

/* ── the "not live" rendering of an agent widget — explore / start onboarding / continue onboarding.
 *    The CTA hands off into the Onboarding stage (the value + setup story) via onAction. ── */
function AgentNotLiveCard({ direction, status, importProgress = 40, delay, onAction }: { direction: Direction; status: Exclude<DirectionStatus, "training">; importProgress?: number; delay: number; onAction?: () => void }) {
  const copy = {
    not_sold: {
      title: `See what the ${direction} agent can do`,
      body: direction === "Outbound"
        ? "Work aged leads, mine equity and run repurchase campaigns automatically — around the clock, without adding headcount."
        : "Answer every call and text the moment it comes in, day or night, without adding headcount.",
      cta: `Explore the ${direction} agent`,
    },
    start_onboarding: {
      title: `Turn on your ${direction} agent`,
      body: `You're set up for this — onboarding takes about a day. Import your CRM and the ${direction.toLowerCase()} agent starts working leads right after.`,
      cta: "Start onboarding",
    },
    continue_onboarding: {
      title: `Getting your ${direction} agent ready`,
      body: "Importing history and configuring the agent — this finishes automatically, no action needed.",
      cta: "Continue onboarding",
    },
  }[status];

  return (
    <div className="tr-pop print-card flex flex-col items-center justify-center gap-2.5 rounded-2xl border border-dashed border-[#e0e0e0] bg-[#fcfcfd] px-6 py-8 text-center" style={{ animationDelay: `${delay}ms` }}>
      <div className="flex w-full items-center justify-between">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#f4effe] text-[18px]">{ICONS[direction]}</div>
        <StatusPill status={status} />
      </div>
      <p className="mt-1 text-[13.5px] font-bold text-[#111]">{copy.title}</p>
      <p className="max-w-[320px] text-[11.5px] leading-snug text-[#6b7280]">{copy.body}</p>
      {status === "continue_onboarding" && (
        <div className="mt-1 w-full max-w-[220px]">
          <ProgressBar pct={importProgress} />
          <p className="mt-1 text-[10px] font-semibold text-[#9ca3af]">{importProgress}% imported</p>
        </div>
      )}
      <button onClick={onAction} className="tr-cta mt-2 inline-flex items-center gap-1.5 rounded-lg bg-[#813fed] px-4 py-2 text-[12px] font-semibold text-white transition-colors hover:bg-[#6d28d9]">
        {copy.cta} <span className="tr-arrow">→</span>
      </button>
    </div>
  );
}

export function TrainingOverview({ account, overrides, earlyStats, onGoLive, onOnboard, fleet, aiStats }: { account: Account; overrides?: Partial<Record<Direction, DirectionStatus>>; earlyStats?: EarlyStats | null; onGoLive?: () => void; onOnboard?: () => void; fleet?: FleetLive; aiStats?: ActionItemStats | null }) {
  const directions: Direction[] = ["Inbound", "Outbound"];
  return (
    <div className="flex flex-col gap-9">
      <TrainingAnims />

      {/* HERO — capabilities, NOT delivered metrics */}
      <section className="tr-pop print-card rounded-3xl border border-[#ece6fb] bg-gradient-to-br from-[#f6f1ff] to-white px-8 py-9 shadow-sm">
        <Eyebrow>Now live · Training mode</Eyebrow>
        <h2 className="mt-1.5 text-[22px] font-extrabold tracking-[-0.02em] text-[#111]">{account.name}&apos;s AI agents are online</h2>
        <p className="mt-2 max-w-[660px] text-[13px] leading-snug text-[#6b7280]">
          Here&apos;s what your agents <b className="text-[#374151]">can do</b> for you. Real numbers replace this automatically as the first calls and messages come in — usually within a day of going live.
        </p>
        <p className="mt-6 mb-3 text-[10px] font-bold uppercase tracking-wider text-[#9ca3af]">What your agents can do</p>
        <div className="flex flex-wrap items-stretch gap-3">
          {CAPABILITIES.map((c, i) => <CapabilityTile key={c.label} {...c} delay={80 + i * 70} />)}
        </div>
      </section>

      {/* YOUR AGENTS — which are live vs not */}
      <div className="flex flex-col gap-3.5">
        <SectionLabel hint="live or not — turn more on anytime">Your agents</SectionLabel>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {directions.map((d, i) => {
            const status = resolveDirectionStatus(account, d, overrides?.[d]);
            return status === "training" ? (
              <AgentTrainingCard key={d} direction={d} features={DEFAULT_FEATURES[d]} delay={120 + i * 90} earlyStats={earlyStats} />
            ) : (
              <AgentNotLiveCard key={d} direction={d} status={status} delay={120 + i * 90} onAction={onOnboard} />
            );
          })}
        </div>
        <div className="tr-rise flex items-start gap-3 rounded-2xl border border-[#e5e7eb] bg-white px-4 py-3.5 shadow-sm" style={{ animationDelay: "200ms" }}>
          <span className="flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-[#f4effe] text-[14px]">⏳</span>
          <p className="text-[11.5px] leading-snug text-[#6b7280]"><b className="text-[#111]">What to expect during training.</b> Like a new hire, your agent gets sharper over about four weeks. Your full performance report unlocks when training completes — until then, these cards fill in with the first real activity.</p>
        </div>
      </div>

      {/* THE VALUE STORY — the three flows (after-hours running + goal line, overflow & all-leads to come).
          Moved here from Live: this is the pitch the dealer sees while calibrating. */}
      {fleet && (
        <div className="tr-rise" style={{ animationDelay: "220ms" }}>
          <ImpactStory fleet={fleet} aiStats={aiStats ?? null} onViewAfterHours={() => {}} onBackToTraining={() => {}} mode="training" />
        </div>
      )}

      {/* HOW TO USE YOUR CONSOLE — light pointers */}
      <div className="flex flex-col gap-3.5">
        <SectionLabel>Finding your way around</SectionLabel>
        <div className="tr-rise grid grid-cols-1 gap-3 sm:grid-cols-3" style={{ animationDelay: "220ms" }}>
          {CONSOLE_TIPS.map((t, i) => (
            <div key={i} className="tr-lift flex items-start gap-3 rounded-2xl border border-[#e5e7eb] bg-white px-4 py-3.5 shadow-sm">
              <span className="flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-[#f4effe] text-[14px]">{t.icon}</span>
              <p className="text-[11.5px] leading-snug text-[#6b7280]">{t.text}</p>
            </div>
          ))}
        </div>
      </div>

      {/* hand-off into Live — the training→live transition in the flow */}
      {onGoLive && (
        <div className="tr-rise flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#d8caff] px-5 py-4" style={{ animationDelay: "260ms", background: "linear-gradient(100deg,#f6f1ff,#fdf1f6)" }}>
          <div>
            <p className="text-[13px] font-bold text-[#111]">Your report goes live as the numbers land.</p>
            <p className="text-[11.5px] text-[#6b7280]">Peek at the live view to see where your metrics will show up.</p>
          </div>
          <button onClick={onGoLive} className="tr-cta flex-none rounded-lg bg-[#813fed] px-4 py-2 text-[12.5px] font-bold text-white transition-colors hover:bg-[#6d28d9]">See it live <span className="tr-arrow">→</span></button>
        </div>
      )}
    </div>
  );
}
