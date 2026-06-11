"use client";

import { useMemo, useState } from "react";
import {
  Bucket,
  BUCKET_FACTOR,
  BUCKET_LABELS,
  BucketToggle,
  CalibratingBanner,
  Card,
  DeltaPill,
  GhostPreview,
  HealthChip,
  ProgressBar,
  RAG_STYLE,
  ReportTopBar,
  SectionLabel,
  Sparkline,
  StepList,
  fmtInt,
  fmtMoney,
  fmtMoneyFull,
} from "@/components/reports/kit";
import { useScenario, type ScenarioView } from "@/components/reports/scenario";
import {
  AT_PAR_ROWS,
  BEST_CONTACT,
  CAMPAIGN_OPPS,
  CONCERNS,
  FEATURE_UPSELLS,
  GROW_TRENDS,
  INSIGHTS,
  LENSES,
  MONTH_ON_MONTH,
  OUTBOUND_STORY,
  RECOVERED,
  REP_WORKING_DAYS_PER_YEAR,
  TRUST_GAP,
  TRUST_SIGNALS,
  WATCH_LIST,
  WIN_STORIES,
  callBifurcation,
  humanEquivalent,
  intentBreakdown,
  lensHasInbound,
  lensHasOutbound,
  lensIsInbound,
  lensTotals,
  sampleCalls,
  type Lens,
  type SampleCall,
} from "@/components/reports/v2data";
import { MetabasePanel } from "@/components/reports/MetabasePanel";
import { MetabaseData } from "@/components/reports/MetabaseData";

// Locked params forwarded to Metabase Q12182. Empty = "all"; the leaf components add TZ from the
// browser. Wire AGENT_TYPE to the active agent tab once the param's accepted values are known.
const MB_PARAMS = { TEAM_ID: "", AGENT_TYPE: "", CALLTYPES: "" };

/* ── the three chapters of the impact story ── */
type Pillar = "trust" | "caught" | "growth";
const PILLARS: { id: Pillar; icon: string; label: string; sub: string; accent: string }[] = [
  { id: "trust", icon: "🤝", label: "Trust", sub: "Can I trust it?", accent: "#6366f1" },
  { id: "caught", icon: "🎣", label: "What Vini caught", sub: "What was I losing?", accent: "#10b981" },
  { id: "growth", icon: "📈", label: "Grow", sub: "Where do I grow next?", accent: "#813fed" },
];
const PHASE2_DAY = 60; // Growth (insights + upsell) unlocks once trust is earned

export default function ImpactReportPage() {
  const { scenario, view } = useScenario();
  const [bucket, setBucket] = useState<Bucket>("last30");
  const [lens, setLens] = useState<Lens>("all");
  const [pillar, setPillar] = useState<Pillar>("trust");
  const [drill, setDrill] = useState<{ title: string; total: number; rows: SampleCall[] } | null>(null);
  const openDrill = (title: string, total: number, rows: SampleCall[]) => setDrill({ title, total, rows });
  const [liveView, setLiveView] = useState<"numbers" | "chart">("numbers");

  const live = view.hasData;
  const factor = scenario === "repeat" ? BUCKET_FACTOR[bucket] : scenario === "recently_live" ? 1.8 : 0;
  const periodLabel = scenario === "repeat" ? BUCKET_LABELS[bucket] : view.liveLabel;
  const growthUnlocked = view.daysLive >= PHASE2_DAY;

  const T = useMemo(() => lensTotals(lens), [lens]);
  const scaled = useMemo(
    () => ({
      calls: T.calls * factor,
      texts: T.smsSent * factor,
      appts: T.appointments * factor,
      revenue: T.revenue * factor,
      cost: T.cost * factor,
      afterHours: T.afterHours * factor,
      conversations: T.conversations * factor,
    }),
    [T, factor],
  );

  const active = PILLARS.find((p) => p.id === pillar)!;

  return (
    <div className="flex min-h-screen bg-[#fafafa]">
      <div className="flex flex-1 flex-col">

        <ReportTopBar
          title="Your Vini impact"
          subtitle="The plain-English story behind your numbers — can you trust it, what it caught for you, and where to grow next."
          active="impact"
          right={
            <span className="rounded-lg bg-[#f3eaff] px-3 py-1.5 text-[12px] font-semibold text-[#813fed]">
              {scenario === "repeat" ? BUCKET_LABELS[bucket] : view.liveLabel}
            </span>
          }
        />

        <main className="mx-auto w-full max-w-[1400px] flex-1 px-10 pt-7 pb-36 flex flex-col gap-7">
          {scenario === "first_time" && <SetupState kind="first_time" />}
          {scenario === "onboarding" && <SetupState kind="onboarding" view={view} />}

          {live && (
            <>
              {/* the 90-day arc this report walks through */}
              <JourneyRibbon daysLive={view.daysLive} />

              {/* per-agent tabs + report filters + chapter switcher */}
              <div className="flex flex-col gap-4">
                <AgentTabs lens={lens} onChange={setLens} />
                <FilterBar scenario={scenario} view={view} bucket={bucket} setBucket={setBucket} lens={lens} periodLabel={periodLabel} />
                <PillarNav active={pillar} onChange={setPillar} growthUnlocked={growthUnlocked} />
              </div>

              {/* live data — real Metabase question 12182: numbers (JSON) or the full chart (iframe) */}
              <div className="flex flex-col gap-3">
                <SectionLabel hint="updated in real time">Live data</SectionLabel>
                <Card
                  title="Your live reporting dashboard"
                  sub="Pulled straight from your live numbers"
                  right={
                    <div className="flex items-center gap-1 rounded-lg bg-[#f3f4f6] p-1">
                      {(["numbers", "chart"] as const).map((v) => (
                        <button
                          key={v}
                          onClick={() => setLiveView(v)}
                          className={`rounded-md px-2.5 py-1 text-[11px] font-semibold capitalize transition-all ${
                            liveView === v ? "bg-white text-[#111] shadow-sm" : "text-[#6b7280] hover:text-[#111]"
                          }`}
                        >
                          {v}
                        </button>
                      ))}
                    </div>
                  }
                >
                  {liveView === "numbers" ? (
                    <MetabaseData question={12182} params={MB_PARAMS} />
                  ) : (
                    <MetabasePanel question={12182} params={MB_PARAMS} height={620} />
                  )}
                </Card>
              </div>

              {scenario === "recently_live" && (
                <CalibratingBanner
                  title={`Live ${view.daysLive} days — these are early, honest numbers.`}
                  body="Trust and what-we-caught are real from day one. The Grow chapter fills in as history builds toward the 60-day mark."
                />
              )}

              {/* the active chapter */}
              {pillar === "trust" && <TrustPillar scaled={scaled} accent={active.accent} />}
              {pillar === "caught" && (
                <CaughtPillar lens={lens} scaled={scaled} factor={factor} bucket={bucket} view={view} scenario={scenario} accent={active.accent} openDrill={openDrill} />
              )}
              {pillar === "growth" && (
                <GrowthPillar scaled={scaled} totals={T} periodLabel={periodLabel} unlocked={growthUnlocked} monthsLive={view.monthsLive} accent={active.accent} openDrill={openDrill} />
              )}

              {/* automated reporting — delivered regardless of which chapter you're on */}
              <AutomatedReports />

              <p className="text-[11px] text-[#9ca3af] text-center">
                Sample numbers for now — once you’re live, every figure reflects your real calls and appointments, and Vini
                emails this story to your inbox each week.
              </p>
            </>
          )}
        </main>
        <DrillDrawer drill={drill} onClose={() => setDrill(null)} />
      </div>
    </div>
  );
}

/* ════════════════════════ shared chrome ════════════════════════ */

function Eyebrow({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <p className="text-[10.5px] font-bold uppercase tracking-[0.12em]" style={{ color }}>
      {children}
    </p>
  );
}

// Question-first: the dealer's question is the headline; the numbers answer it on the arrow line.
function PillarHero({ icon, chapter, question, answer, accent, tint }: { icon: string; chapter: string; question: string; answer: React.ReactNode; accent: string; tint: string }) {
  return (
    <section className="rounded-3xl border bg-white shadow-sm overflow-hidden" style={{ borderColor: `${accent}33` }}>
      <div className="px-7 py-6" style={{ background: `linear-gradient(110deg, ${tint}, #ffffff 70%)` }}>
        <div className="flex items-center gap-2.5">
          <span className="text-[20px] leading-none">{icon}</span>
          <Eyebrow color={accent}>{chapter}</Eyebrow>
        </div>
        <h2 className="mt-2 text-[25px] font-extrabold leading-tight tracking-[-0.02em] text-[#111] max-w-[820px]">{question}</h2>
        <p className="mt-2.5 flex items-start gap-2 text-[14px] leading-snug text-[#374151] max-w-[820px]">
          <span className="mt-[3px] flex-none text-[13px] font-bold" style={{ color: accent }}>→</span>
          <span>{answer}</span>
        </p>
      </div>
    </section>
  );
}

/* The 0 → 90 day arc, with a "you are here" marker. */
function JourneyRibbon({ daysLive }: { daysLive: number }) {
  const pct = Math.min(100, (daysLive / 90) * 100);
  const ticks = [0, 30, 60, 90];
  return (
    <section className="rounded-2xl border border-[#ece6fb] bg-white px-7 py-5 shadow-sm">
      <div className="flex items-center justify-between">
        <Eyebrow color="#813fed">Your 90-day journey</Eyebrow>
        <span className="rounded-full bg-[#f3eaff] px-2.5 py-1 text-[11px] font-bold text-[#813fed]">Day {daysLive}</span>
      </div>
      <div className="relative mt-6 mb-2">
        {/* phase bands */}
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-[#f3f4f6]">
          <div className="h-2" style={{ width: "66.6%", background: "linear-gradient(90deg,#a5b4fc,#6ee7b7)" }} />
          <div className="h-2 flex-1" style={{ background: "linear-gradient(90deg,#c4b5fd,#813fed)" }} />
        </div>
        {/* you-are-here marker */}
        <div className="absolute -top-1 h-4 w-4 -translate-x-1/2 rounded-full border-[3px] border-white bg-[#813fed] shadow" style={{ left: `${pct}%` }} />
        {/* ticks — anchored to their true day-position on the bar */}
        <div className="absolute inset-x-0 top-3 h-3">
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute text-[9.5px] font-semibold tabular-nums text-[#9ca3af]"
              style={{ left: `${(t / 90) * 100}%`, transform: "translateX(-50%)" }}
            >
              Day {t}
            </span>
          ))}
        </div>
      </div>
      <div className="mt-7 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="flex items-start gap-2.5 rounded-xl bg-[#f6fbf8] px-4 py-2.5">
          <span className="mt-px text-[13px]">🤝</span>
          <p className="text-[11.5px] leading-snug text-[#374151]">
            <b className="text-[#065f46]">Days 0–60</b> — earn your trust and surface every lead that used to slip through.
          </p>
        </div>
        <div className="flex items-start gap-2.5 rounded-xl bg-[#f6f1ff] px-4 py-2.5">
          <span className="mt-px text-[13px]">📈</span>
          <p className="text-[11.5px] leading-snug text-[#374151]">
            <b className="text-[#813fed]">Days 60–90</b> — spot what’s costing you cars and fix it, plus what to switch on next.
          </p>
        </div>
      </div>
    </section>
  );
}

// Per-agent tabs (All + the four agents). The whole report scopes to the selected agent.
function AgentTabs({ lens, onChange }: { lens: Lens; onChange: (l: Lens) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {LENSES.map((l) => {
        const on = l.id === lens;
        return (
          <button
            key={l.id}
            onClick={() => onChange(l.id)}
            aria-pressed={on}
            className={`flex items-center gap-2 rounded-xl border px-3.5 py-2 text-left transition-all ${
              on ? "border-[#813fed] bg-[#f6f1ff] shadow-sm" : "border-[#e5e7eb] bg-white hover:border-[#c4b5fd] hover:shadow-sm"
            }`}
          >
            <span className="text-[15px] leading-none">{l.icon}</span>
            <span className="flex flex-col leading-tight">
              <span className={`text-[12.5px] font-bold ${on ? "text-[#813fed]" : "text-[#111]"}`}>{l.label}</span>
              <span className="text-[9.5px] font-medium uppercase tracking-wide text-[#9ca3af]">{l.sub}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* Report filter bar — time window + inbound/outbound lens, with a plain-English summary.
 * Deeper filters (by agent, source, campaign) wire up with the live-data path (see spec). */
function FilterBar({
  scenario,
  view,
  bucket,
  setBucket,
  lens,
  periodLabel,
}: {
  scenario: string;
  view: ScenarioView;
  bucket: Bucket;
  setBucket: (b: Bucket) => void;
  lens: Lens;
  periodLabel: string;
}) {
  const agentLabel = LENSES.find((l) => l.id === lens)!.label;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-2xl border border-[#e5e7eb] bg-white px-4 py-3 shadow-sm">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-[#9ca3af]">Date</span>
        {scenario === "repeat" ? (
          <BucketToggle bucket={bucket} onChange={setBucket} />
        ) : (
          <span className="rounded-lg bg-[#f3eaff] px-3 py-1.5 text-[12px] font-semibold text-[#813fed]">{view.liveLabel}</span>
        )}
      </div>
      <span className="ml-auto hidden items-center gap-1.5 text-[11px] text-[#9ca3af] md:inline-flex">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
        </svg>
        Showing {agentLabel} · {periodLabel}
      </span>
    </div>
  );
}

function PillarNav({ active, onChange, growthUnlocked }: { active: Pillar; onChange: (p: Pillar) => void; growthUnlocked: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {PILLARS.map((p, i) => {
        const on = active === p.id;
        const locked = p.id === "growth" && !growthUnlocked;
        return (
          <button
            key={p.id}
            onClick={() => onChange(p.id)}
            className={`group relative flex items-center gap-3 rounded-2xl border px-4 py-3.5 text-left transition-all ${
              on ? "shadow-[0_0_0_3px_rgba(0,0,0,0.04)]" : "border-[#e5e7eb] bg-white hover:border-[#c4b5fd] hover:shadow-sm"
            }`}
            style={on ? { borderColor: p.accent, background: `${p.accent}0d` } : undefined}
          >
            <span
              className="flex h-9 w-9 flex-none items-center justify-center rounded-xl text-[16px]"
              style={{ background: on ? p.accent : "#f3f4f6", filter: on ? "none" : "grayscale(0.2)" }}
            >
              <span style={{ opacity: on ? 1 : 0.85 }}>{p.icon}</span>
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="text-[9px] font-bold tabular-nums" style={{ color: on ? p.accent : "#9ca3af" }}>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="text-[13.5px] font-bold text-[#111]">{p.label}</span>
                {locked && (
                  <span className="ml-auto rounded-full bg-[#f3f4f6] px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-wide text-[#9ca3af]">
                    Day 60
                  </span>
                )}
              </div>
              <p className="truncate text-[11px] text-[#6b7280]">{p.sub}</p>
            </div>
          </button>
        );
      })}
    </div>
  );
}

/* ════════════════════════ 1 · TRUST ════════════════════════ */

function TrustPillar({ scaled, accent }: { scaled: { conversations: number }; accent: string }) {
  return (
    <div className="flex flex-col gap-6">
      <PillarHero
        icon="🤝"
        chapter="Chapter 1 · Trust"
        accent={accent}
        tint="#eef0ff"
        question="Can I trust Vini with my customers?"
        answer={<>Yes — it covers <b className="text-[#111]">everything coming in</b>, including the nights, overflow and follow-ups no one had the hours for, customers feel heard, and your CRM is exactly as you left it.</>}
      />

      {/* the core "is it as good as my human" answer */}
      <Card title="What your team couldn’t get to — now covered" sub="Vini doesn’t replace your people; it fills the coverage they never had the hours for.">
        <AtParTable />
      </Card>

      {/* trust signals grid */}
      <SectionLabel hint="scored on every conversation">Can I trust it on every call?</SectionLabel>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {TRUST_SIGNALS.map((s) => (
          <div key={s.title} className="flex flex-col gap-2 rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-sm">
            <div className="flex items-start justify-between">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#f7f7fb] text-[17px]">{s.icon}</span>
              <Sparkline values={s.trend} color={RAG_STYLE[s.status].dot} width={62} height={24} />
            </div>
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-[#9ca3af]">{s.title}</p>
              <div className="flex items-baseline gap-2">
                <p className="text-[22px] font-extrabold tabular-nums leading-tight text-[#111]">{s.value}</p>
                {s.delta !== 0 && (
                  <span className="text-[10.5px] font-semibold" style={{ color: s.delta > 0 ? "#16a34a" : "#dc2626" }}>
                    {s.delta > 0 ? "▲" : "▼"} {Math.abs(s.delta)}%
                  </span>
                )}
              </div>
            </div>
            <p className="text-[12px] leading-snug text-[#374151]">{s.caption}</p>
            <p className="mt-auto border-t border-[#f3f4f6] pt-2 text-[11px] font-medium text-[#6b7280]">{s.proof}</p>
          </div>
        ))}
      </div>

      {/* CRM-safe + concerns resolved + the honest gap */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card title="Every concern, closed out" sub="Trust is also about how fast we fix things">
          <div className="flex items-end gap-4">
            <div>
              <p className="text-[40px] font-extrabold tabular-nums leading-none text-[#10b981]">{CONCERNS.resolved}/{CONCERNS.raised}</p>
              <p className="mt-1.5 text-[12px] text-[#6b7280]">issues you raised — all resolved</p>
            </div>
            <span className="mb-1 rounded-full bg-[#dcfce7] px-2.5 py-1 text-[11px] font-bold text-[#065f46]">
              {"<"} {CONCERNS.medianHours}h median
            </span>
          </div>
          <p className="mt-4 border-t border-[#f3f4f6] pt-3 text-[11.5px] leading-snug text-[#6b7280]">
            When you flag a bad call, it gets reviewed and fixed — and the agent gets better the same week.
          </p>
        </Card>

        <Card title="We don’t touch your system" sub="Vini writes back to your CRM — it never breaks it">
          <div className="grid grid-cols-2 gap-3">
            <SafeStat label="CRM updates written" value="4,820" />
            <SafeStat label="Notes logged" value="3,140" />
            <SafeStat label="Sync failures" value="0" accent="#10b981" />
            <SafeStat label="Conversations remembered" value={fmtInt(scaled.conversations)} />
          </div>
        </Card>

        {/* honest about what we can't show yet */}
        <div className="relative overflow-hidden rounded-2xl border border-dashed border-[#d8caff] bg-[#faf8ff] p-5">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-[#813fed] shadow-sm">
            🔒 Coming soon
          </span>
          <p className="mt-3 text-[13px] font-bold text-[#111]">{TRUST_GAP.title}</p>
          <p className="mt-1.5 text-[12px] leading-snug text-[#6b7280]">{TRUST_GAP.body}</p>
        </div>
      </div>

      {/* edge handling: where Vini isn't winning yet — shown honestly, each with its fix */}
      <Card
        title="Being straight with you"
        sub="Where Vini isn’t winning yet — and what we’re doing about it"
        right={<HealthChip status="amber" text="On our radar" />}
        pad={false}
      >
        <div className="flex flex-col divide-y divide-[#f3f4f6]">
          {WATCH_LIST.map((w) => (
            <div key={w.item} className="flex items-start gap-3 px-6 py-3.5">
              <span className="mt-1 h-2 w-2 flex-none rounded-full" style={{ background: RAG_STYLE[w.status].dot }} />
              <div className="flex-1 min-w-0">
                <p className="text-[12.5px] font-semibold text-[#111]">
                  {w.item} <span className="font-bold tabular-nums" style={{ color: RAG_STYLE[w.status].dot }}>· {w.value}</span>
                </p>
                <p className="text-[11.5px] text-[#6b7280]">{w.detail}</p>
              </div>
              <span className="flex-none rounded-full bg-[#f3eaff] px-2.5 py-1 text-[10.5px] font-semibold text-[#813fed]">{w.action}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function AtParTable() {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate" style={{ borderSpacing: 0 }}>
        <thead>
          <tr>
            <th className="px-4 py-2.5 text-left text-[10.5px] font-bold uppercase tracking-wider text-[#9ca3af]">What it covers</th>
            <th className="px-4 py-2.5 text-right text-[10.5px] font-bold uppercase tracking-wider text-[#9ca3af]">Before Vini</th>
            <th className="px-4 py-2.5 text-right text-[10.5px] font-bold uppercase tracking-wider text-[#813fed]">With Vini</th>
            <th className="px-4 py-2.5 text-right text-[10.5px] font-bold uppercase tracking-wider text-[#9ca3af]" />
          </tr>
        </thead>
        <tbody>
          {AT_PAR_ROWS.map((r) => (
            <tr key={r.metric} className="group">
              <td className="border-t border-[#f0f0f0] px-4 py-3 text-[12.5px] font-semibold text-[#111] group-hover:bg-[#fafafa]">{r.metric}</td>
              <td className="border-t border-[#f0f0f0] px-4 py-3 text-right text-[12.5px] tabular-nums text-[#9ca3af] group-hover:bg-[#fafafa]">{r.human}</td>
              <td className="border-t border-[#f0f0f0] px-4 py-3 text-right text-[13px] font-extrabold tabular-nums text-[#111] group-hover:bg-[#fafafa]">{r.vini}</td>
              <td className="border-t border-[#f0f0f0] px-4 py-3 text-right group-hover:bg-[#fafafa]">
                {r.verdict === "better" ? (
                  <HealthChip status="green" text="Now covered" />
                ) : r.verdict === "below" ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-[#f3eaff] px-2 py-0.5 text-[10px] font-semibold text-[#813fed]">
                    → Your team
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-[#f3f4f6] px-2 py-0.5 text-[10px] font-semibold text-[#6b7280]">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#9ca3af]" />
                    Maintained
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SafeStat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-xl border border-[#f0f0f0] px-3.5 py-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-[#9ca3af]">{label}</p>
      <p className="mt-0.5 text-[17px] font-bold tabular-nums" style={{ color: accent ?? "#111" }}>{value}</p>
    </div>
  );
}

/* ════════════════════ 2 · WHAT VINI CAUGHT ════════════════════ */

function CaughtPillar({
  lens,
  scaled,
  factor,
  bucket,
  view,
  scenario,
  accent,
  openDrill,
}: {
  lens: Lens;
  scaled: { calls: number; texts: number; afterHours: number };
  factor: number;
  bucket: Bucket;
  view: ScenarioView;
  scenario: string;
  accent: string;
  openDrill: (title: string, total: number, rows: SampleCall[]) => void;
}) {
  const touches = scaled.calls + scaled.texts;
  const effort = humanEffort(touches);
  const spanLabel =
    scenario === "repeat"
      ? { today: "today", yesterday: "in a day", last7: "in 7 days", last14: "in 14 days", last30: "in 30 days", lifetime: "all time" }[bucket]
      : `in ${view.daysLive} days`;
  const isInbound = lensIsInbound(lens);

  // which "recovered" rows belong to this lens (by the selected agent's direction)
  const inboundKeys = ["After-hours leads", "Overflow calls", "Slow first response"];
  const outboundKeys = ["Dead leads in your CRM", "Follow-up persistence", "Slow first response"];
  const recovered = RECOVERED.filter((r) =>
    lens === "all" ? true : (isInbound ? inboundKeys : outboundKeys).includes(r.title),
  );
  const showOutboundStory = lensHasOutbound(lens);

  return (
    <div className="flex flex-col gap-6">
      <PillarHero
        icon="🎣"
        chapter="Chapter 2 · What Vini caught"
        accent={accent}
        tint="#eafaf1"
        question="What was I losing before Vini?"
        answer={<>After-hours calls, overflow, the dead leads sitting in your CRM and the follow-ups a rep never got to — <b className="text-[#111]">now caught, every one</b>.</>}
      />

      {/* the volume math — lens-aware: dialing-years for outbound, round-the-clock coverage for inbound */}
      <SectionLabel hint={spanLabel}>How much did Vini actually do?</SectionLabel>
      <section className="rounded-3xl border border-[#cdeede] bg-gradient-to-br from-[#f0fdf6] via-[#f7fdfa] to-white shadow-sm px-7 py-7">
        {isInbound ? (
          <>
            <div className="flex flex-wrap items-end gap-x-10 gap-y-5">
              <div>
                <p className="text-[46px] font-extrabold leading-none tabular-nums tracking-[-0.02em] text-[#059669]">{fmtInt(scaled.calls)}</p>
                <p className="mt-2 text-[13px] text-[#374151]">
                  calls answered {spanLabel} — <b className="text-[#111]">zero missed</b>, including{" "}
                  <b className="text-[#111]">{fmtInt(scaled.afterHours)}</b> after-hours that used to hit voicemail.
                </p>
              </div>
              <div className="max-w-[380px] rounded-2xl border border-[#cdeede] bg-white/70 px-5 py-4">
                <p className="text-[12px] text-[#6b7280]">Your front desk</p>
                <p className="text-[15px] font-bold leading-snug text-[#111]">takes one call at a time and clocks out at six.</p>
                <p className="mt-1 text-[12px] text-[#6b7280]">Vini answered every call at once, around the clock.</p>
              </div>
            </div>
            <p className="mt-4 text-[11px] text-[#9ca3af]">
              A receptionist handles one line at a time and goes home at close. Vini doesn’t — no busy signal, no voicemail.
            </p>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-x-10 gap-y-5">
              <div>
                <p className="text-[46px] font-extrabold leading-none tabular-nums tracking-[-0.02em] text-[#059669]">{fmtInt(touches)}</p>
                <p className="mt-2 text-[13px] text-[#374151]">
                  outreach attempts {spanLabel} — <b className="text-[#111]">{fmtInt(scaled.calls)}</b> calls and{" "}
                  <b className="text-[#111]">{fmtInt(scaled.texts)}</b> texts.
                </p>
              </div>
              <div className="rounded-2xl border border-[#cdeede] bg-white/70 px-5 py-4">
                <p className="text-[12px] text-[#6b7280]">That’s roughly</p>
                <p className="text-[26px] font-extrabold tabular-nums leading-tight text-[#111]">{effort}</p>
                <p className="text-[12px] text-[#6b7280]">of one rep’s dialing — done {spanLabel}.</p>
              </div>
            </div>
            <p className="mt-4 text-[11px] text-[#9ca3af]">
              Assumes a rep makes ~60 effective attempts a day. Vini never takes a lunch, a weekend, or a sick day.
            </p>
          </>
        )}
      </section>

      {/* call bifurcation: during vs after hours, with appointments in each (clickable) */}
      {lensHasInbound(lens) &&
        (() => {
          const b = callBifurcation(lens);
          const dCalls = Math.round(b.duringCalls * factor);
          const aCalls = Math.round(b.afterCalls * factor);
          const dAppts = Math.round(b.duringAppts * factor);
          const aAppts = Math.round(b.afterAppts * factor);
          return (
            <>
              <SectionLabel hint="when the calls came in">During hours vs after hours</SectionLabel>
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                <BifCard
                  icon="☀️"
                  label="During hours"
                  sub="Your team's open hours"
                  calls={dCalls}
                  appts={dAppts}
                  accent="#6366f1"
                  onAppts={() => openDrill("During-hours appointments", dAppts, sampleCalls("dh-appt", Math.min(dAppts, 8), { afterHours: false }))}
                />
                <BifCard
                  icon="🌙"
                  label="After hours"
                  sub="Nights, weekends & holidays"
                  calls={aCalls}
                  appts={aAppts}
                  accent="#10b981"
                  onAppts={() => openDrill("After-hours appointments", aAppts, sampleCalls("ah-appt", Math.min(aAppts, 8), { afterHours: true }))}
                />
              </div>
            </>
          );
        })()}

      {/* intent breakdown — what the calls were about (each count clickable to names + recordings) */}
      <SectionLabel hint="this period">What were the calls about?</SectionLabel>
      <Card title="Call intents" sub="Every call by what the customer wanted — click a number for the names & recordings">
        {(() => {
          const intents = intentBreakdown(lens).map((s) => ({ ...s, value: Math.round(s.value * factor) }));
          const max = Math.max(...intents.map((i) => i.value), 1);
          const total = intents.reduce((s, i) => s + i.value, 0) || 1;
          return (
            <div className="flex flex-col gap-3.5">
              {intents.map((s) => (
                <div key={s.label} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between text-[12px]">
                    <span className="text-[#374151]">{s.label}</span>
                    <span className="tabular-nums text-[#111]">
                      <ClickableCount onClick={() => openDrill(`${s.label} · calls`, s.value, sampleCalls(s.drill, Math.min(s.value, 8), { intent: s.label }))}>
                        {fmtInt(s.value)}
                      </ClickableCount>
                      <span className="ml-2 text-[#9ca3af]">{Math.round((s.value / total) * 100)}%</span>
                    </span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-[#f3f4f6]">
                    <div className="h-2 rounded-full" style={{ width: `${(s.value / max) * 100}%`, background: s.color }} />
                  </div>
                </div>
              ))}
            </div>
          );
        })()}
      </Card>

      {/* what used to leak */}
      <SectionLabel hint="before Vini → now">What was slipping away before?</SectionLabel>
      <div className="flex flex-col gap-3">
        {recovered.map((r) => (
          <div key={r.title} className="flex flex-col gap-3 rounded-2xl border border-[#e5e7eb] bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:gap-5">
            <div className="flex flex-none items-center gap-3 sm:w-[210px]">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#f0fdf6] text-[18px]">{r.icon}</span>
              <p className="text-[13.5px] font-bold text-[#111]">{r.title}</p>
            </div>
            <div className="flex flex-1 items-center gap-3">
              <div className="flex-1 rounded-lg bg-[#fafafa] px-3 py-2">
                <p className="text-[9.5px] font-bold uppercase tracking-wide text-[#9ca3af]">Before</p>
                <p className="text-[12px] text-[#6b7280]">{r.before}</p>
              </div>
              <span className="text-[#10b981]">→</span>
              <div className="flex-1 rounded-lg bg-[#f0fdf6] px-3 py-2">
                <p className="text-[9.5px] font-bold uppercase tracking-wide text-[#059669]">Now</p>
                <p className="text-[12px] font-medium text-[#111]">{r.after}</p>
              </div>
            </div>
            <div className="flex-none text-right sm:w-[130px]">
              <p className="text-[22px] font-extrabold tabular-nums leading-none text-[#10b981]">{r.recovered}</p>
              <p className="text-[10.5px] text-[#9ca3af]">{r.recoveredLabel}</p>
            </div>
          </div>
        ))}
      </div>

      {/* outbound-only story */}
      {showOutboundStory && (
        <>
          <SectionLabel hint="outbound">Is my team calling the right leads?</SectionLabel>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <Card title="We narrowed it down for you" sub="Your team would dial the whole list">
              <div className="flex items-center justify-around py-1 text-center">
                <div>
                  <p className="text-[30px] font-extrabold tabular-nums leading-none text-[#9ca3af]">{fmtInt(OUTBOUND_STORY.listSize)}</p>
                  <p className="mt-1 text-[11px] text-[#6b7280]">raw leads</p>
                </div>
                <span className="text-[20px] text-[#10b981]">→</span>
                <div>
                  <p className="text-[30px] font-extrabold tabular-nums leading-none text-[#10b981]">{OUTBOUND_STORY.qualified}</p>
                  <p className="mt-1 text-[11px] text-[#6b7280]">worth calling</p>
                </div>
              </div>
              <p className="mt-3 border-t border-[#f3f4f6] pt-3 text-[11.5px] leading-snug text-[#6b7280]">
                Vini worked the full list and handed your team only the {OUTBOUND_STORY.qualified} ready to talk.
              </p>
            </Card>
            <Card title="Connect rate, lifted" sub="Persistent, multi-day pursuit">
              <div className="flex items-end gap-3">
                <p className="text-[40px] font-extrabold tabular-nums leading-none text-[#813fed]">{OUTBOUND_STORY.connectAfter}%</p>
                <span className="mb-1.5"><DeltaPill delta={OUTBOUND_STORY.connectAfter - OUTBOUND_STORY.connectBefore} /></span>
              </div>
              <p className="mt-1 text-[12px] text-[#6b7280]">up from {OUTBOUND_STORY.connectBefore}% when reps chased manually.</p>
              <div className="mt-4 flex items-center justify-between rounded-lg bg-[#f0fdf6] px-3 py-2 text-[11.5px]">
                <span className="text-[#374151]">Extra appointments from leads Vini followed up</span>
                <b className="tabular-nums text-[#059669]">{OUTBOUND_STORY.influencedAppts}</b>
              </div>
            </Card>
            <Card title="Lighter BDC workload" sub="Open action items per rep">
              <div className="flex items-end gap-3">
                <p className="text-[40px] font-extrabold tabular-nums leading-none text-[#10b981]">{OUTBOUND_STORY.workloadAfter}</p>
                <span className="mb-2 text-[10.5px] font-semibold text-[#16a34a]">
                  ▼ {Math.round(((OUTBOUND_STORY.workloadBefore - OUTBOUND_STORY.workloadAfter) / OUTBOUND_STORY.workloadBefore) * 100)}% vs manual
                </span>
              </div>
              <p className="mt-1 text-[12px] text-[#6b7280]">down from {OUTBOUND_STORY.workloadBefore} — Vini absorbs the grind.</p>
              <p className="mt-4 border-t border-[#f3f4f6] pt-3 text-[11.5px] leading-snug text-[#6b7280]">
                Your reps spend their day on the {OUTBOUND_STORY.qualified} hot leads, not the 1,000 cold ones.
              </p>
            </Card>
          </div>
        </>
      )}

      {/* top wins — day-by-day stories */}
      <SectionLabel hint="real conversations this period">What would I have missed?</SectionLabel>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {WIN_STORIES.map((w) => (
          <div key={w.customer} className="flex flex-col overflow-hidden rounded-2xl border border-[#e5e7eb] bg-white shadow-sm">
            <div className="flex items-center justify-between gap-2 bg-gradient-to-r from-[#f0fdf6] to-white px-5 py-3">
              <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-bold text-[#059669] shadow-sm">{w.tag}</span>
              <HealthChip status="green" text={w.outcome} />
            </div>
            <div className="px-5 py-4">
              <p className="text-[13.5px] font-bold text-[#111]">{w.customer}</p>
              <p className="text-[11.5px] text-[#9ca3af]">{w.vehicle}</p>
              <ol className="mt-3 flex flex-col gap-2.5">
                {w.steps.map((s, i) => (
                  <li key={i} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <span className="h-2 w-2 flex-none rounded-full" style={{ background: i === w.steps.length - 1 ? "#10b981" : "#c4b5fd" }} />
                      {i < w.steps.length - 1 && <span className="mt-0.5 w-px flex-1 bg-[#eee]" />}
                    </div>
                    <div className="-mt-1 pb-0.5">
                      <p className="text-[10px] font-bold uppercase tracking-wide text-[#9ca3af]">{s.day}</p>
                      <p className="text-[12px] leading-snug text-[#374151]">{s.text}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
            <p className="mt-auto border-t border-[#f3f4f6] bg-[#fcfcfd] px-5 py-3 text-[11px] italic leading-snug text-[#6b7280]">{w.footnote}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// "~8.0 years" / "~6 months" / "~120 rep-days" depending on scale
function humanEffort(touches: number): string {
  const { repDays, repYears } = humanEquivalent(touches);
  if (repYears >= 1) return `~${repYears.toFixed(1)} years`;
  const months = repDays / (REP_WORKING_DAYS_PER_YEAR / 12);
  if (months >= 1.5) return `~${Math.round(months)} months`;
  return `~${fmtInt(repDays)} rep-days`;
}

/* ════════════════════════ 3 · GROW ════════════════════════ */

function GrowthPillar({
  scaled,
  totals,
  periodLabel,
  unlocked,
  monthsLive,
  accent,
  openDrill,
}: {
  scaled: { revenue: number; cost: number; appts: number };
  totals: { roi: number; cpa: number };
  periodLabel: string;
  unlocked: boolean;
  monthsLive: number;
  accent: string;
  openDrill: (title: string, total: number, rows: SampleCall[]) => void;
}) {
  const maxRev = Math.max(...MONTH_ON_MONTH.map((m) => m.revenue));
  // Recently-live shows only the early-computable insight; the full list unlocks with history.
  const shownInsights = unlocked ? INSIGHTS : INSIGHTS.slice(1, 2);
  return (
    <div className="flex flex-col gap-6">
      <PillarHero
        icon="📈"
        chapter="Chapter 3 · Grow"
        accent={accent}
        tint="#f3edff"
        question="Where do I grow from here?"
        answer={<>Your own numbers, turned into a plan to sell more cars — <b className="text-[#111]">what’s working, what’s costing you, and what to switch on next</b>.</>}
      />

      {!unlocked && (
        <CalibratingBanner
          title="A preview — this section fills in around Day 60."
          body="These insights need a few weeks of your real data before they’re reliable. Here’s exactly what you’ll see for your store."
        />
      )}

      {/* appointments → ROI → CPA (each with its own trend) */}
      <SectionLabel hint={periodLabel}>Is Vini paying for itself?</SectionLabel>
      <section className="rounded-3xl border border-[#ece6fb] bg-white shadow-sm overflow-hidden">
        <div className="flex items-center justify-between bg-gradient-to-r from-[#f6f1ff] via-[#faf8ff] to-white px-7 py-4">
          <Eyebrow color="#813fed">The dollars · {periodLabel}</Eyebrow>
          <span className="text-[11px] text-[#9ca3af]">revenue Vini drove ÷ what it costs to run</span>
        </div>
        <div className="grid grid-cols-1 divide-y divide-[#f3f4f6] sm:grid-cols-3 sm:divide-y-0 sm:divide-x">
          <GrowHero
            label="Appointments booked"
            value={fmtInt(scaled.appts)}
            sub="booked by Vini"
            trend={GROW_TRENDS.appts}
            accent="#10b981"
            onClick={() => openDrill("Appointments booked by Vini", Math.round(scaled.appts), sampleCalls("grow-appt", Math.min(Math.round(scaled.appts), 8), { intent: "Appointment booked" }))}
          />
          <GrowHero label="Return on spend" value={`${totals.roi.toFixed(1)}×`} sub={`${fmtMoneyFull(scaled.revenue)} on ${fmtMoneyFull(scaled.cost)}`} trend={GROW_TRENDS.roi} accent="#813fed" />
          <GrowHero label="Cost per appointment" value={fmtMoney(totals.cpa)} sub="vs about $190 the old way" trend={GROW_TRENDS.cpa} accent="#10b981" />
        </div>
      </section>

      {/* month-on-month — months beyond what's actually live are ghosted (stage-aware) */}
      <Card title="Is it getting better each month?" sub="Month-on-month — the trend to put in front of ownership">
        <div className="flex items-end justify-around gap-6 pt-2" style={{ height: 180 }}>
          {MONTH_ON_MONTH.map((m, i) => {
            const ghost = i >= monthsLive;
            return (
              <div key={m.month} className="flex flex-1 flex-col items-center justify-end gap-2" style={{ height: "100%" }}>
                <span className={`text-[12px] font-bold tabular-nums ${ghost ? "text-[#cbd5e1]" : "text-[#111]"}`}>{ghost ? "—" : fmtMoney(m.revenue)}</span>
                <div
                  className="w-full max-w-[90px] rounded-t-lg"
                  style={{
                    height: `${(m.revenue / maxRev) * 100}%`,
                    background: ghost
                      ? "repeating-linear-gradient(45deg,#f3f4f6,#f3f4f6 6px,#fafafa 6px,#fafafa 12px)"
                      : i === monthsLive - 1
                        ? "linear-gradient(180deg,#813fed,#6366f1)"
                        : "#d8caff",
                  }}
                />
                <div className="text-center">
                  <p className={`text-[11.5px] font-semibold ${ghost ? "text-[#cbd5e1]" : "text-[#374151]"}`}>{m.month}</p>
                  <p className="text-[10.5px] text-[#9ca3af]">{ghost ? "to come" : `${m.appts} appts`}</p>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* insights — found automatically (fewer until there's enough history) */}
      <SectionLabel hint="the why behind your numbers, found for you">What’s costing me cars — and how do I fix it?</SectionLabel>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {shownInsights.map((ins, i) => (
          <InsightCard key={i} insight={ins} />
        ))}
      </div>
      {!unlocked && (
        <p className="-mt-1 text-[12px] text-[#6b7280]">
          <b className="text-[#111]">More insights unlock around Day 60.</b> As your history builds, Vini surfaces the full list of what’s costing you cars — with the fix for each.
        </p>
      )}

      {/* best time / channel */}
      <Card title="When and how should I reach my leads?" sub="Learned from what actually converted">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex items-center gap-3 rounded-xl bg-[#f6f1ff] px-4 py-3">
            <span className="text-[20px]">🕗</span>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-[#9ca3af]">Best time</p>
              <p className="text-[15px] font-bold text-[#111]">{BEST_CONTACT.time}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-xl bg-[#f0fdf6] px-4 py-3">
            <span className="text-[20px]">📨</span>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-[#9ca3af]">Best channel</p>
              <p className="text-[15px] font-bold text-[#111]">{BEST_CONTACT.channel}</p>
            </div>
          </div>
        </div>
        <p className="mt-3 text-[11.5px] text-[#6b7280]">{BEST_CONTACT.note}</p>
      </Card>

      {/* feature upsell */}
      <SectionLabel hint="capabilities to switch on">What should I switch on next?</SectionLabel>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURE_UPSELLS.map((f) => (
          <div key={f.name} className="flex flex-col gap-2.5 rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-sm transition-all hover:border-[#c4b5fd] hover:shadow-md">
            <div className="flex items-center justify-between">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#f3eaff] text-[18px]">{f.icon}</span>
              {f.status === "soon" && <span className="rounded-full bg-[#fef3c7] px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-[#92400e]">Soon</span>}
            </div>
            <p className="text-[14px] font-bold text-[#111]">{f.name}</p>
            <p className="text-[12px] leading-snug text-[#374151]">{f.pitch}</p>
            <p className="text-[11px] italic text-[#6b7280]">{f.proof}</p>
            <button className="mt-auto rounded-lg border border-[#813fed] bg-white px-3 py-2 text-[12px] font-bold text-[#813fed] transition-colors hover:bg-[#813fed] hover:text-white">
              {f.cta} →
            </button>
          </div>
        ))}
      </div>

      {/* campaign opportunities — established only (needs a few weeks of history) */}
      {unlocked && (
        <>
          <SectionLabel hint="money sitting in your data right now">What’s worth launching now?</SectionLabel>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {CAMPAIGN_OPPS.map((c) => (
          <div key={c.name} className="flex flex-col overflow-hidden rounded-2xl border border-[#cdeede] bg-white shadow-sm">
            <div className="flex items-center gap-2.5 bg-gradient-to-r from-[#f0fdf6] to-white px-5 py-3.5">
              <span className="text-[18px]">{c.icon}</span>
              <p className="text-[13.5px] font-bold text-[#111]">{c.name}</p>
            </div>
            <div className="px-5 py-4">
              <p className="text-[12px] text-[#6b7280]">{c.audience}</p>
              <div className="mt-3 flex items-end gap-2">
                <span className="text-[13px] font-semibold tabular-nums text-[#9ca3af]">{c.spend}</span>
                <span className="text-[#10b981]">→</span>
                <span className="text-[24px] font-extrabold tabular-nums leading-none text-[#059669]">{c.expected}</span>
                <span className="mb-0.5 rounded-full bg-[#dcfce7] px-2 py-0.5 text-[10.5px] font-bold text-[#065f46]">{c.multiple}</span>
              </div>
              <p className="mt-3 text-[11.5px] leading-snug text-[#6b7280]">{c.blurb}</p>
            </div>
            <button className="mt-auto border-t border-[#cdeede] bg-[#f6fbf8] px-5 py-2.5 text-[12px] font-bold text-[#059669] transition-colors hover:bg-[#10b981] hover:text-white">
              Launch campaign →
            </button>
          </div>
        ))}
          </div>
        </>
      )}
    </div>
  );
}

function GrowHero({ label, value, sub, accent, trend, onClick }: { label: string; value: string; sub: string; accent?: string; trend?: number[]; onClick?: () => void }) {
  return (
    <div className="flex flex-col gap-1.5 px-6 py-5">
      <p className="text-[10.5px] font-bold uppercase tracking-[0.08em] text-[#9ca3af]">{label}</p>
      <div className="flex items-end justify-between gap-2">
        {onClick ? (
          <button
            onClick={onClick}
            className="text-[34px] font-extrabold tabular-nums leading-none tracking-[-0.02em] underline decoration-dotted underline-offset-4 hover:decoration-solid"
            style={{ color: accent ?? "#111" }}
          >
            {value}
          </button>
        ) : (
          <p className="text-[34px] font-extrabold tabular-nums leading-none tracking-[-0.02em]" style={{ color: accent ?? "#111" }}>{value}</p>
        )}
        {trend && <span className="mb-0.5"><Sparkline values={trend} color={accent ?? "#813fed"} width={64} height={26} /></span>}
      </div>
      <span className="text-[11.5px] text-[#6b7280]">{sub}</span>
    </div>
  );
}

function InsightCard({ insight }: { insight: (typeof INSIGHTS)[number] }) {
  const tone = {
    opportunity: { dot: "#10b981", bg: "#f0fdf6", label: "Opportunity", chip: "#065f46", chipBg: "#dcfce7" },
    fix: { dot: "#f59e0b", bg: "#fffbeb", label: "Quick fix", chip: "#92400e", chipBg: "#fef3c7" },
    watch: { dot: "#6366f1", bg: "#f6f1ff", label: "Worth a look", chip: "#3730a3", chipBg: "#e0e7ff" },
  }[insight.kind];
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide" style={{ background: tone.chipBg, color: tone.chip }}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: tone.dot }} />
          {tone.label}
        </span>
        <span className="text-[12px] font-extrabold text-[#059669]">{insight.impact}</span>
      </div>
      <p className="text-[13.5px] font-bold leading-snug text-[#111]">{insight.finding}</p>
      <div className="flex flex-col gap-2 rounded-xl px-3.5 py-3" style={{ background: tone.bg }}>
        <div className="flex gap-2">
          <span className="text-[10px] font-bold uppercase tracking-wide text-[#9ca3af] flex-none w-[64px] pt-0.5">Likely cause</span>
          <p className="text-[12px] leading-snug text-[#374151]">{insight.cause}</p>
        </div>
        <div className="flex gap-2">
          <span className="text-[10px] font-bold uppercase tracking-wide text-[#9ca3af] flex-none w-[64px] pt-0.5">Do this</span>
          <p className="text-[12px] font-medium leading-snug text-[#111]">{insight.fix}</p>
        </div>
      </div>
      <button className="self-start rounded-lg bg-[#813fed] px-3.5 py-2 text-[12px] font-bold text-white transition-colors hover:bg-[#6d28d9]">
        {insight.cta} →
      </button>
    </div>
  );
}

/* ════════════════ drill-down · activity · automated reporting ════════════════ */

// A number you can click to see the customers + call recordings behind it.
function ClickableCount({ children, onClick, color = "#813fed" }: { children: React.ReactNode; onClick: () => void; color?: string }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-0.5 font-bold underline decoration-dotted underline-offset-2 transition-all hover:decoration-solid"
      style={{ color }}
    >
      {children}
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M7 17 17 7M9 7h8v8" />
      </svg>
    </button>
  );
}

// Right-side drawer: the customer names + call recordings behind a clicked count.
function DrillDrawer({ drill, onClose }: { drill: { title: string; total: number; rows: SampleCall[] } | null; onClose: () => void }) {
  if (!drill) return null;
  return (
    <div className="fixed inset-0 z-[60] flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} aria-hidden />
      <div className="relative flex h-full w-full max-w-[460px] flex-col bg-white shadow-[0_0_60px_rgba(0,0,0,0.25)]">
        <div className="flex items-start justify-between border-b border-[#f0f0f0] px-6 py-4">
          <div>
            <p className="text-[10.5px] font-bold uppercase tracking-wider text-[#813fed]">Customer detail</p>
            <p className="text-[16px] font-bold text-[#111]">{drill.title}</p>
            <p className="mt-0.5 text-[11.5px] text-[#9ca3af]">Showing {drill.rows.length} of {fmtInt(drill.total)}</p>
          </div>
          <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-lg text-[#9ca3af] hover:bg-[#f3f4f6] hover:text-[#111]" aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          <div className="flex flex-col divide-y divide-[#f3f4f6]">
            {drill.rows.map((c, i) => (
              <div key={i} className="flex items-center gap-3 px-6 py-3.5">
                <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-[#f3eaff] text-[11px] font-bold text-[#813fed]">
                  {c.name.split(" ").map((p) => p[0]).join("")}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] font-semibold text-[#111]">{c.name}</p>
                  <p className="truncate text-[11px] text-[#6b7280]">{c.vehicle} · {c.when}</p>
                </div>
                <a
                  href="#"
                  onClick={(e) => e.preventDefault()}
                  className="flex flex-none items-center gap-1.5 rounded-lg border border-[#e5e7eb] px-2.5 py-1.5 text-[11px] font-semibold text-[#813fed] hover:bg-[#faf8ff]"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                  {c.durationLabel}
                </a>
              </div>
            ))}
          </div>
          <p className="px-6 py-4 text-[11px] text-[#9ca3af]">Recordings open in the call player — wires to the live conversation store next.</p>
        </div>
      </div>
    </div>
  );
}

// Automated reporting affordance — daily AM digest + monthly report, with recipients.
function AutomatedReports() {
  return (
    <section className="overflow-hidden rounded-2xl border border-[#ece6fb] bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-[#f0f0f0] bg-gradient-to-r from-[#f6f1ff] to-white px-6 py-4">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white text-[17px] shadow-sm">📬</span>
          <div>
            <Eyebrow color="#813fed">Your reports, automated</Eyebrow>
            <p className="text-[14px] font-bold text-[#111]">Delivered to your inbox — no logging in required</p>
          </div>
        </div>
        <button className="rounded-lg border border-[#e5e7eb] bg-white px-3 py-1.5 text-[12px] font-semibold text-[#374151] hover:bg-gray-50">Manage</button>
      </div>
      <div className="grid grid-cols-1 divide-y divide-[#f3f4f6] sm:grid-cols-2 sm:divide-y-0 sm:divide-x">
        <div className="px-6 py-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[15px]">🌅</span>
            <p className="text-[13px] font-bold text-[#111]">Daily digest</p>
            <span className="rounded-full bg-[#dcfce7] px-2 py-0.5 text-[10px] font-bold text-[#065f46]">Every morning · 7 AM</span>
          </div>
          <p className="mt-2 text-[12px] leading-snug text-[#6b7280]">Last night’s calls, after-hours bookings, and the call-backs and action items waiting for your team.</p>
        </div>
        <div className="px-6 py-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[15px]">📊</span>
            <p className="text-[13px] font-bold text-[#111]">Monthly report</p>
            <span className="rounded-full bg-[#f3eaff] px-2 py-0.5 text-[10px] font-bold text-[#813fed]">1st of each month</span>
          </div>
          <p className="mt-2 text-[12px] leading-snug text-[#6b7280]">The full picture — trust, what Vini caught, ROI and the month-on-month trend, ready for your owner review.</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-[#f0f0f0] px-6 py-3">
        <span className="text-[10px] font-bold uppercase tracking-wider text-[#9ca3af]">Recipients</span>
        {["gm@dealership.com", "bdc-lead@dealership.com"].map((r) => (
          <span key={r} className="rounded-full bg-[#f3f4f6] px-2.5 py-1 text-[11px] font-medium text-[#374151]">{r}</span>
        ))}
        <button className="rounded-full border border-dashed border-[#c4b5fd] px-2.5 py-1 text-[11px] font-semibold text-[#813fed] hover:bg-[#faf8ff]">+ Add</button>
      </div>
    </section>
  );
}

// One side of the during-hours / after-hours split — calls + a clickable appointment count.
function BifCard({ icon, label, sub, calls, appts, accent, onAppts }: { icon: string; label: string; sub: string; calls: number; appts: number; accent: string; onAppts: () => void }) {
  return (
    <div className="rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-sm">
      <div className="flex items-center gap-2">
        <span className="text-[16px]">{icon}</span>
        <div>
          <p className="text-[13px] font-bold text-[#111]">{label}</p>
          <p className="text-[10.5px] text-[#9ca3af]">{sub}</p>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-[#fafafa] px-3.5 py-3">
          <p className="text-[10px] font-bold uppercase tracking-wider text-[#9ca3af]">Calls</p>
          <p className="text-[24px] font-extrabold tabular-nums leading-none text-[#111]">{fmtInt(calls)}</p>
        </div>
        <div className="rounded-xl px-3.5 py-3" style={{ background: `${accent}12` }}>
          <p className="text-[10px] font-bold uppercase tracking-wider text-[#9ca3af]">Appointments</p>
          <p className="text-[24px] font-extrabold tabular-nums leading-none">
            <ClickableCount onClick={onAppts} color={accent}>{fmtInt(appts)}</ClickableCount>
          </p>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════ setup / pre-live states ════════════════════ */

function SetupState({ kind, view }: { kind: "first_time" | "onboarding"; view?: ScenarioView }) {
  if (kind === "first_time") {
    return (
      <>
        <section className="rounded-3xl border border-[#ece6fb] bg-gradient-to-br from-[#f6f1ff] to-white px-8 py-9 shadow-sm">
          <Eyebrow color="#813fed">Your impact story</Eyebrow>
          <h2 className="mt-1.5 text-[26px] font-extrabold tracking-[-0.02em] text-[#111]">The 90-day story starts the day you go live</h2>
          <p className="mt-2 max-w-[620px] text-[13.5px] leading-snug text-[#6b7280]">
            This page becomes your plain-English scorecard — proof you can trust the AI, the revenue it caught
            that used to slip away, and the handful of things worth switching on next.
          </p>
          <div className="mt-7 grid gap-8 md:grid-cols-2">
            <StepList
              steps={[
                { label: "Connect your CRM", active: true },
                { label: "Capture your 90-day baseline" },
                { label: "Launch your first agent" },
                { label: "Watch the trust story build" },
              ]}
            />
            <div className="flex items-end">
              <button className="rounded-xl bg-[#813fed] px-5 py-2.5 text-[13px] font-bold text-white transition-colors hover:bg-[#6d28d9]">Connect CRM →</button>
            </div>
          </div>
        </section>
        <SectionLabel>What your impact report will show</SectionLabel>
        <GhostPreview
          title="Trust · What Vini caught · Grow"
          body="The coverage your team couldn’t get to, the after-hours and dead leads it recovered, and your automatic plan to book more — all once you’re live."
        />
      </>
    );
  }
  return (
    <>
      <Card title="Getting your impact story ready" sub="Importing history and bringing your agents online.">
        <div className="flex flex-col gap-5">
          <div>
            <div className="mb-1.5 flex items-center justify-between text-[12px]">
              <span className="text-[#6b7280]">Importing your last 90 days across all sources</span>
              <b className="tabular-nums text-[#111]">{view?.importProgress ?? 0}%</b>
            </div>
            <ProgressBar pct={view?.importProgress ?? 0} />
          </div>
          <StepList
            steps={[
              { label: "Connect CRM & data sources", done: true },
              { label: "Import 90-day history", active: true },
              { label: "Configure your agents", done: true },
              { label: "Go live" },
            ]}
          />
          <div className="rounded-xl bg-[#f0fdf6] px-4 py-3 text-[12px] text-[#065f46]">
            <b>{view?.liveLabel}.</b> Your trust chapter starts filling in the moment your first agent works a lead.
          </div>
        </div>
      </Card>
      <SectionLabel>Your impact report (preview)</SectionLabel>
      <GhostPreview
        title="Trust unlocks at go-live · Grow unlocks ~Day 60"
        body="The story builds in order: first proof you can trust it, then the revenue it caught, then the insights and upsells that grow the account."
      />
    </>
  );
}
