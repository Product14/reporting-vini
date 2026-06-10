"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Bucket,
  BUCKET_LABELS,
  BucketToggle,
  Card,
  ComingSoon,
  Eyebrow,
  fmtInt,
  fmtMoney,
  fmtMoneyFull,
  GhostPreview,
  HealthChip,
  InlineBar,
  RAG_STYLE,
  ReportTopBar,
  SectionLabel,
  Sparkline,
  StepFunnel,
  StepList,
} from "@/components/reports/kit";
import { useScenario, type ScenarioView } from "@/components/reports/scenario";
import { fetchAgents, agentsForAccount, aggregateFleet, type FetchResult } from "@/components/reports/liveData";

const AGENT_COLOR: Record<string, string> = {
  sales_ib: "#6366f1",
  sales_ob: "#813fed",
  service_ib: "#10b981",
  service_ob: "#f59e0b",
};

export default function OverviewReportPage() {
  const router = useRouter();
  const [bucket, setBucket] = useState<Bucket>("last30");
  const { scenario, view, teamId, account } = useScenario();

  // cost per appointment — set on the Agents tab; read once from localStorage (same initializer
  // pattern ScenarioProvider uses to seed the rooftop), so there's no setState-in-effect.
  const [apptCost] = useState<number>(() => {
    if (typeof window === "undefined") return 150;
    const s = window.localStorage.getItem("vini.apptCost");
    return s ? Number(s) : 150;
  });

  // Live fleet for the selected rooftop, refetched per rooftop/window. null === loading.
  const [feed, setFeed] = useState<FetchResult | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!teamId) return; // no rooftop selected → leave feed as-is (UI shows the no-rooftop state)
    let on = true;
    // intentional: reset to the loading skeleton while the new rooftop/window fetches
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFeed(null);
    fetchAgents({ teamId, bucket })
      .then((res) => { if (on) setFeed(res); })
      .catch(() => { if (on) setFeed({ agents: [], hasData: false, fetchedAt: Date.now(), prior: {} }); });
    return () => { on = false; };
  }, [teamId, bucket]);
  const refresh = () => {
    if (!teamId) return;
    setFeed(null);
    fetchAgents({ teamId, bucket, force: true })
      .then(setFeed)
      .catch(() => setFeed({ agents: [], hasData: false, fetchedAt: Date.now(), prior: {} }));
  };

  // Scope to the agents this rooftop actually runs, then aggregate the live numbers.
  const agents = useMemo(() => agentsForAccount(feed?.agents ?? [], account), [feed, account]);
  const fleet = useMemo(() => aggregateFleet(agents, feed?.prior), [agents, feed]);

  const hasTeam = teamId !== "";
  const periodLabel = BUCKET_LABELS[bucket];
  const valueCreated = fleet.appointments * apptCost;
  const comingSoon = hasTeam && feed !== null && !feed.hasData; // rooftop selected, no live data yet
  const showReport = scenario !== "first_time" && scenario !== "onboarding";
  const liveReady = showReport && hasTeam && feed !== null && !comingSoon;

  const ranked = useMemo(() => [...agents].sort((a, b) => b.metrics.appointments - a.metrics.appointments), [agents]);
  const maxAppts = useMemo(() => Math.max(1, ...agents.map((a) => a.metrics.appointments)), [agents]);

  return (
    <div className="flex min-h-screen bg-[#fafafa]">
      <div className="flex flex-1 flex-col">

        <ReportTopBar
          title="Overview"
          subtitle="Your daily control-tower report — every agent, call and appointment in one place."
          active="overview"
          right={
            hasTeam ? (
              <div className="flex items-center gap-3">
                <span className="hidden text-[11px] text-[#9ca3af] md:inline">
                  {feed === null ? "Syncing…" : feed.fetchedAt ? `Synced ${relTime(feed.fetchedAt, now)}` : ""}
                </span>
                <BucketToggle bucket={bucket} onChange={setBucket} />
                <button
                  onClick={refresh}
                  disabled={feed === null}
                  aria-label="Refresh data"
                  title="Refresh"
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#e5e7eb] bg-white text-[#6b7280] transition-colors hover:bg-[#faf8ff] hover:text-[#813fed] disabled:opacity-50"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={feed === null ? "animate-spin" : ""}>
                    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                    <path d="M21 3v6h-6" />
                  </svg>
                </button>
              </div>
            ) : (
              <span className="rounded-lg bg-[#f3eaff] px-3 py-1.5 text-[12px] font-semibold text-[#813fed]">{view.liveLabel}</span>
            )
          }
        />

        <main className="mx-auto w-full max-w-[1320px] flex-1 px-10 pt-7 pb-36 flex flex-col gap-9">
          {scenario === "first_time" && <FirstTimeOverview />}
          {scenario === "onboarding" && <OnboardingOverview view={view} />}

          {showReport && !hasTeam && <NoRooftop />}
          {showReport && hasTeam && feed === null && <OverviewSkeleton />}
          {showReport && hasTeam && comingSoon && (
            <ComingSoon
              title={`Live reporting for ${account.name} is being wired up`}
              note="We don't have data flowing from this rooftop yet. The full report appears here automatically once its calls and outcomes land in the pipeline."
            />
          )}

          {liveReady && (
          <>
          {/* ─────────── 1 · Value created — the live headline ─────────── */}
          <section className="overflow-hidden rounded-[28px] border border-[#ddd0fb] bg-gradient-to-br from-[#1c1033] via-[#2a1656] to-[#3a1d6e] text-white shadow-[0_20px_60px_-24px_rgba(58,29,110,0.7)]">
            <div className="flex flex-col gap-7 px-9 pt-8 pb-7 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <p className="text-[10.5px] font-bold uppercase tracking-[0.16em] text-[#c4b5fd]">Value created · {periodLabel}</p>
                <div className="mt-3 flex items-end gap-4">
                  <span className="text-[64px] font-black leading-[0.9] tracking-[-0.03em] text-white">{fmtMoneyFull(valueCreated)}</span>
                </div>
                <p className="mt-3 max-w-[560px] text-[14px] leading-snug text-[#d6cdf0]">
                  From <b className="text-white">{fmtInt(fleet.appointments)} appointments</b> booked across your live agents, at{" "}
                  <b className="text-white">{fmtMoneyFull(apptCost)}</b> per appointment.
                </p>
              </div>
              <DeltaBadge label="appointments vs prior" delta={fleet.deltas.appointments} />
            </div>
            <div className="grid grid-cols-2 divide-x divide-white/10 border-t border-white/10 bg-black/15 sm:grid-cols-4">
              <HeroTile label="Appointments" value={fmtInt(fleet.appointments)} delta={fleet.deltas.appointments} />
              <HeroTile label="Conversations" value={fmtInt(fleet.conversations)} delta={fleet.deltas.qualified} />
              <HeroTile label="Calls handled" value={fmtInt(fleet.calls)} delta={fleet.deltas.calls} />
              <HeroTile label="After-hours captured" value={fmtInt(fleet.afterHours)} />
            </div>
          </section>

          {/* revenue / deals / cost / ROI all need the outcome store — not wired yet */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <ComingSoon title="Attributed revenue $" inline />
            <ComingSoon title="Deals & ROs closed" inline />
            <ComingSoon title="Run cost & ROI" inline />
          </div>

          {/* ─────────── 2 · Who drove it — ranked by appointments ─────────── */}
          <div className="flex flex-col gap-3.5">
            <SectionLabel hint="Click an agent for the full report">Who drove it</SectionLabel>
            <div className="flex flex-col gap-2.5">
              {ranked.map((a, i) => (
                <button
                  key={a.id}
                  onClick={() => router.push(`/reports/agents?team_id=${teamId}`)}
                  className="group flex items-center gap-4 rounded-2xl border border-[#e9e9ee] bg-white px-5 py-4 text-left shadow-sm transition-all hover:border-[#c4b5fd] hover:shadow-md"
                >
                  <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-[#f3eaff] text-[12px] font-extrabold text-[#813fed]">{i + 1}</span>
                  <span className="text-[22px] leading-none">{a.icon}</span>
                  <div className="w-[150px] flex-none">
                    <p className="text-[13.5px] font-bold text-[#111]">{a.name}</p>
                    <p className="text-[10.5px] font-medium uppercase tracking-wide text-[#9ca3af]">{a.dept} · {a.dir}</p>
                  </div>
                  <div className="hidden flex-1 items-center justify-around gap-4 md:flex">
                    <MicroStat label="Calls" value={fmtInt(a.metrics.calls)} />
                    <MicroStat label="Connect" value={`${a.metrics.connectRate}%`} />
                    <MicroStat label="Appts" value={fmtInt(a.metrics.appointments)} />
                    <MicroStat label="CSAT" value={`${a.quality.csat}`} />
                    <span className="hidden lg:inline"><Sparkline values={a.trend7} color={AGENT_COLOR[a.id]} width={70} height={26} /></span>
                  </div>
                  <div className="w-[170px] flex-none">
                    <div className="flex items-baseline justify-between">
                      <span className="text-[19px] font-extrabold tabular-nums text-[#10b981]">{fmtMoney(a.metrics.appointments * apptCost)}</span>
                      <span className="text-[10px] text-[#9ca3af]">value</span>
                    </div>
                    <div className="mt-1.5"><InlineBar pct={(a.metrics.appointments / maxAppts) * 100} color={AGENT_COLOR[a.id]} /></div>
                  </div>
                  <HealthChip status={a.health} />
                  <span className="text-[15px] font-bold text-[#d8caff] group-hover:text-[#813fed]">→</span>
                </button>
              ))}
            </div>
          </div>

          {/* ─────────── 3 · What's working · what to fix ─────────── */}
          <div className="flex flex-col gap-3.5">
            <SectionLabel hint="where revenue is won and lost">What&apos;s working · what to fix</SectionLabel>
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <Card title="Top campaigns" sub="Ranked by attributed revenue">
                <ComingSoon title="Campaign attribution" note="Per-campaign volume and conversion need a campaign-level card — not wired yet." />
              </Card>
              <Card title="Money on the table" sub="Fixes that recover revenue">
                <ComingSoon title="Missed-opportunity model" note="The recoverable-revenue estimate needs the outcome store — not wired yet." />
              </Card>
            </div>
          </div>

          {/* ─────────── 4 · The pipeline — how the machine works ─────────── */}
          <div className="flex flex-col gap-3.5">
            <SectionLabel hint={periodLabel}>The pipeline — whole dealership</SectionLabel>
            <Card title="Outreach → conversation → qualified → appointment" sub="Each step's height is its volume; the pill is its conversion from the step before">
              <StepFunnel stages={fleet.funnel} />
              <div className="mt-5 grid grid-cols-2 gap-2.5 border-t border-[#f3f4f6] pt-4 sm:grid-cols-4">
                <ContextChip label="Connect / answer" value={`${fleet.connectRate}%`} />
                <ContextChip label="After-hours captured" value={fmtInt(fleet.afterHours)} accent="#10b981" />
                <ContextChip label="Talk time" value={`${fmtInt(fleet.talkMinutes / 60)}h`} />
                <ComingSoon title="Show rate" inline />
              </div>
            </Card>
          </div>

          {/* ─────────── 5 · Can you trust it — quality, compliance & data ─────────── */}
          <div className="flex flex-col gap-3.5">
            <SectionLabel hint="audit-grade hygiene you can show">Can you trust it</SectionLabel>
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <Card title="Conversation quality" sub="Fleet-level, call-weighted across your live agents">
                <div className="grid grid-cols-3 gap-3">
                  <QualityCell label="Avg CSAT" value={`${fleet.csat} / 5`} status="green" />
                  <QualityCell label="Positive sentiment" value={`${fleet.sentiment}%`} status="green" />
                  <QualityCell label="Connect / answer" value={`${fleet.connectRate}%`} status={fleet.connectRate >= 60 ? "green" : "amber"} />
                </div>
                <div className="mt-3">
                  <ComingSoon title="Compliance posture (DNC, 10DLC, opt-outs, silent hours)" note="Audit-grade compliance reporting isn't wired to a card yet." />
                </div>
              </Card>
              <Card title="Data health" sub="Completeness of the data layer the agents run on">
                <ComingSoon title="Data-completeness scoring" note="Phone/email/equity/opt-in coverage needs a data-health card — not wired yet." />
              </Card>
            </div>
          </div>
          </>
          )}

          <p className="text-[11px] text-[#9ca3af] text-center">
            This is your daily control-tower report. Live numbers are pulled per rooftop from Metabase; sections marked
            &ldquo;coming soon&rdquo; need the outcome/event store before they can show real data.
          </p>
        </main>
      </div>
    </div>
  );
}

/* ── relative "synced X ago" label ── */
function relTime(then: number, now: number): string {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 45) return "just now";
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

/* ── no rooftop selected ── */
function NoRooftop() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[#e0e0e0] bg-[#fcfcfd] px-6 py-16 text-center">
      <span className="text-[26px] leading-none">🏢</span>
      <p className="text-[14px] font-bold text-[#111]">No rooftop selected</p>
      <p className="max-w-[460px] text-[12.5px] leading-snug text-[#6b7280]">
        Add <b>?team_id=…</b> to the URL (or pick a rooftop below) to load live reporting.
      </p>
    </div>
  );
}

/* ── shimmer skeleton while a rooftop/window loads ── */
function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-9">
      <div className="h-[220px] animate-pulse rounded-[28px] bg-[#eef0f3]" />
      <div className="flex flex-col gap-2.5">
        {[0, 1, 2, 3].map((i) => <div key={i} className="h-[72px] animate-pulse rounded-2xl bg-[#eef0f3]" />)}
      </div>
      <div className="h-[240px] animate-pulse rounded-2xl bg-[#eef0f3]" />
    </div>
  );
}

/* ── hero sub-tile (dark band) ── */
function HeroTile({ label, value, delta, invert }: { label: string; value: string; delta?: number; invert?: boolean }) {
  const has = delta !== undefined;
  const d = delta ?? 0;
  const isGood = invert ? d < 0 : d > 0;
  const up = d > 0;
  return (
    <div className="px-6 py-4">
      <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#a99fce]">{label}</p>
      <p className="mt-1 text-[22px] font-extrabold tabular-nums leading-none text-white">{value}</p>
      {has && (
        <span className="mt-1.5 inline-block text-[10.5px] font-semibold" style={{ color: d === 0 ? "#a99fce" : isGood ? "#5eead4" : "#fca5a5" }}>
          {d === 0 ? "0%" : `${up ? "▲" : "▼"} ${Math.abs(d)}%`} vs prior
        </span>
      )}
    </div>
  );
}

function DeltaBadge({ label, delta }: { label: string; delta: number }) {
  const up = delta >= 0;
  return (
    <div className="rounded-2xl border border-white/15 bg-white/10 px-4 py-3 text-right backdrop-blur-sm">
      <p className="text-[20px] font-extrabold tabular-nums leading-none" style={{ color: up ? "#5eead4" : "#fca5a5" }}>{up ? "▲" : "▼"} {Math.abs(delta)}%</p>
      <p className="mt-1 text-[10.5px] text-[#c4b5fd]">{label}</p>
    </div>
  );
}

function MicroStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center">
      <p className="text-[13.5px] font-bold tabular-nums text-[#111]">{value}</p>
      <p className="text-[9.5px] font-medium uppercase tracking-wide text-[#9ca3af]">{label}</p>
    </div>
  );
}

function ContextChip({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="flex items-center justify-between rounded-xl bg-[#fafafa] px-3.5 py-2.5">
      <span className="text-[11.5px] text-[#6b7280]">{label}</span>
      <span className="text-[14px] font-bold tabular-nums" style={{ color: accent ?? "#111" }}>{value}</span>
    </div>
  );
}

function QualityCell({ label, value, status }: { label: string; value: string; status: "green" | "amber" | "red" }) {
  return (
    <div className="rounded-xl border border-[#f0f0f0] px-3.5 py-3">
      <div className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full" style={{ background: RAG_STYLE[status].dot }} />
        <p className="text-[10px] font-semibold uppercase tracking-wider text-[#9ca3af]">{label}</p>
      </div>
      <p className="mt-1 text-[17px] font-bold tabular-nums text-[#111]">{value}</p>
    </div>
  );
}

/* ── First-time experience — no agents live yet ── */
function FirstTimeOverview() {
  return (
    <>
      <section className="rounded-3xl border border-[#ece6fb] bg-gradient-to-br from-[#f6f1ff] to-white px-8 py-9 shadow-sm">
        <Eyebrow>Welcome to your control tower</Eyebrow>
        <h2 className="mt-1.5 text-[26px] font-extrabold tracking-[-0.02em] text-[#111]">No agents live yet</h2>
        <p className="mt-2 max-w-[600px] text-[13.5px] leading-snug text-[#6b7280]">
          This is where every call, appointment and dollar shows up once your AI agents are running. Connect your CRM and
          launch your first agent to start the clock.
        </p>
        <div className="mt-7 grid gap-8 md:grid-cols-2">
          <StepList
            steps={[
              { label: "Connect your CRM", active: true },
              { label: "Capture your 90-day baseline" },
              { label: "Launch your first agent" },
              { label: "Watch the dollars land here" },
            ]}
          />
          <div className="flex items-end">
            <button className="rounded-xl bg-[#813fed] px-5 py-2.5 text-[13px] font-bold text-white transition-colors hover:bg-[#6d28d9]">
              Connect CRM →
            </button>
          </div>
        </div>
      </section>
      <SectionLabel>What your daily report will look like</SectionLabel>
      <GhostPreview
        title="Your control-tower report appears here"
        body="Value created, the whole-dealership pipeline, agent leaderboard and quality — once you’re live."
      />
    </>
  );
}

/* ── Onboarding — importing history, agents not yet live ── */
function OnboardingOverview({ view }: { view: ScenarioView }) {
  return (
    <>
      <Card title="Getting your dealership set up" sub="Importing history and bringing your agents online.">
        <div className="flex flex-col gap-5">
          <div>
            <div className="mb-1.5 flex items-center justify-between text-[12px]">
              <span className="text-[#6b7280]">Importing your last 90 days across all sources</span>
              <b className="tabular-nums text-[#111]">{view.importProgress}%</b>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-[#f0f0f0]">
              <div className="h-2.5 rounded-full bg-[#813fed]" style={{ width: `${view.importProgress}%` }} />
            </div>
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
            <b>{view.liveLabel}.</b> The morning report starts landing in your inbox the day after your agents go live.
          </div>
        </div>
      </Card>
      <SectionLabel>Your daily report (preview)</SectionLabel>
      <GhostPreview
        title="Value, pipeline and quality unlock at go-live"
        body="Once your agents start working leads, this fills with the whole-dealership funnel, the agent leaderboard and live quality."
      />
    </>
  );
}
