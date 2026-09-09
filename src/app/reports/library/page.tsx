"use client";

/* THE REPORT LIBRARY page — pick a report, read it, export it.
 *
 * One fetch pass loads every source the catalog can draw on (the agent feed, the ClickHouse metric
 * snapshot, action items and the conversation reviews), then each report reads what it needs from that
 * shared context. That's why opening a second report is instant: the data is already here.
 *
 * The library shows ONLY reports that have live data for the selected rooftop and window — a card that
 * would open onto an empty page is listed as unavailable instead, with the reason. */

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Card, DateFilter, ReportTopBar, SectionLabel, fmtInt } from "@/components/reports/kit";
import { useScenario } from "@/components/reports/scenario";
import { useDateRange, useDept, reportNavQuery } from "@/components/reports/dateRange";
import {
  fetchAgents,
  fetchReportMetrics,
  fetchActionItems,
  fetchActionItemStats,
  agentsForAccount,
  aggregateFleet,
  addDay,
  peekAgents,
  tzShortLabel,
  type FetchResult,
  type ReportMetrics,
  type ActionItem,
  type ActionItemStats,
} from "@/components/reports/liveData";
import { useOutcomes } from "@/components/reports/outcomes";
import { REPORTS, availableReports, type ReportCtx, type ReportDef } from "@/components/reports/library";
import { track } from "@/lib/analytics";
import type { InsightsPayload } from "@/app/api/reports/insights/route";

/* ClickHouse-only datasets for the library (CRM outcome, vehicles, transfer routing, texts, coverage).
 * Returns null on any failure — the reports that need it simply aren't offered. */
async function fetchInsights(
  teamId: string,
  win: { bucket?: string; start?: string; end?: string },
  spyneToken?: string,
): Promise<InsightsPayload | null> {
  const qs = new URLSearchParams({ team_id: teamId });
  if (win.start && win.end) { qs.set("start", win.start); qs.set("end", win.end); }
  else if (win.bucket) qs.set("bucket", win.bucket);
  try {
    const r = await fetch(`/api/reports/insights?${qs}`, { cache: "no-store", headers: spyneToken ? { Authorization: `Bearer ${spyneToken}` } : undefined });
    if (!r.ok) return null;
    return (await r.json()) as InsightsPayload;
  } catch {
    return null;
  }
}

export default function ReportLibraryPage() {
  return (
    <Suspense fallback={null}>
      <LibraryView />
    </Suspense>
  );
}

function LibraryView() {
  const { bucket, custom, setPreset, setCustom } = useDateRange();
  const { dept, locked } = useDept();
  const { teamId, enterpriseId, account, spyneToken, spyneEnv } = useScenario();
  const params = useSearchParams();
  const [openId, setOpenId] = useState<string | null>(params.get("report"));

  const rangeOpts = custom ? { start: custom.start, end: addDay(custom.end), spyneToken, spyneEnv } : { bucket, spyneToken, spyneEnv };
  const [feed, setFeed] = useState<FetchResult | null>(() => peekAgents({ teamId, ...rangeOpts }));
  const [metrics, setMetrics] = useState<ReportMetrics | null>(null);
  const [actionStats, setActionStats] = useState<ActionItemStats | null>(null);
  const [actionItems, setActionItems] = useState<ActionItem[]>([]);
  const [insights, setInsights] = useState<InsightsPayload | null>(null);
  // Distinguishes "still fetching" from "genuinely nothing" — a deep link opened a report before the
  // ClickHouse datasets landed and it rendered the empty state, which reads as broken.
  const [insightsLoading, setInsightsLoading] = useState(true);

  useEffect(() => { track("report_viewed", { tab: "library", team_id: teamId }); }, [teamId]);

  useEffect(() => {
    if (!teamId) return;
    let on = true;
    fetchAgents({ teamId, ...rangeOpts }).then((r) => { if (on) setFeed(r); }).catch(() => {});
    return () => { on = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, bucket, custom]);

  useEffect(() => {
    if (!teamId) return;
    let on = true;
    Promise.all([
      fetchReportMetrics(teamId, spyneToken).catch(() => null),
      fetchActionItemStats(teamId, { service: dept === "all" ? "both" : dept, spyneToken }).catch(() => null),
      fetchActionItems(teamId, { scope: "open", service: dept === "all" ? "both" : dept, limit: 40, spyneToken }).catch(() => []),
      fetchInsights(teamId, custom ? { start: custom.start, end: addDay(custom.end) } : { bucket }, spyneToken).catch(() => null),
    ]).then(([m, s, i, ins]) => {
      if (!on) return;
      setMetrics(m);
      setActionStats(s?.stats ?? null);
      setActionItems(Array.isArray(i) ? i : []);
      setInsights(ins);
      setInsightsLoading(false);
    });
    return () => { on = false; };
  }, [teamId, dept, spyneToken, bucket, custom]);

  // Conversation reviews are SALES-only by construction; a Service-scoped library simply has fewer reports.
  const outcomesFeed = useOutcomes({
    teamId,
    enterpriseId,
    dirs: ["inbound", "outbound"],
    bucket: custom ? undefined : bucket,
    start: custom?.start,
    end: custom ? addDay(custom.end) : undefined,
    spyneToken,
    spyneEnv,
    enabled: !!teamId && dept !== "service",
  });

  const agents = useMemo(() => agentsForAccount(feed?.agents ?? [], account), [feed, account]);
  const scoped = useMemo(() => (dept === "all" ? agents : agents.filter((a) => a.dept.toLowerCase() === dept)), [agents, dept]);
  const fleet = useMemo(() => aggregateFleet(scoped, feed?.prior), [scoped, feed]);
  const periodLabel = custom ? `${custom.start} → ${custom.end}` : BUCKET_TEXT[bucket] ?? "Last 30 days";
  const navQuery = reportNavQuery(teamId, bucket, custom, dept, locked);

  const ctx: ReportCtx = useMemo(
    () => ({
      teamId,
      enterpriseId,
      periodLabel,
      timezone: feed?.timezone ?? null,
      feed,
      fleet,
      agents: scoped,
      metrics,
      actionStats,
      actionItems,
      outcomes: outcomesFeed.data,
      insights,
      warmLeads: (feed?.warmLeads ?? []).filter((w) => dept === "all" || w.serviceType === dept),
      namedAppts: (feed?.namedAppointments ?? []).filter((a) => dept === "all" || a.serviceType === dept),
    }),
    [teamId, enterpriseId, periodLabel, feed, fleet, scoped, metrics, actionStats, actionItems, outcomesFeed.data, dept, insights],
  );

  const ready = feed !== null;
  const live = useMemo(() => (ready ? availableReports(ctx) : []), [ready, ctx]);
  const liveIds = useMemo(() => new Set(live.map((r) => r.id)), [live]);
  const open = openId ? REPORTS.find((r) => r.id === openId) ?? null : null;
  /* The By-agent strip links in with ?from=agent&agent=<id>; that's what lets a report offer a way back
   * to the agent report instead of dumping the reader in the gallery they never came from. */
  const fromAgent = params.get("from") === "agent" ? params.get("agent") : null;
  const backToAgent = fromAgent
    ? { href: `/reports/agents${navQuery}${navQuery ? "&" : "?"}agent=${encodeURIComponent(fromAgent)}`, label: "Back to agent report" }
    : null;

  const openReport = (r: ReportDef) => {
    track("library_report_opened", { team_id: teamId, report: r.id });
    setOpenId(r.id);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className="flex min-h-screen bg-[#fafafa]">
      <div className="flex flex-1 flex-col">
        <ReportTopBar
          title="Reports"
          subtitle="Ready-made reports on your live data — pick one to open it."
          active="library"
          teamId={teamId}
          query={navQuery}
          right={<DateFilter bucket={bucket} custom={custom} onPreset={setPreset} onCustom={setCustom} />}
        />

        <main className="mx-auto w-full max-w-[1320px] flex-1 px-4 pb-28 pt-7 sm:px-6 lg:px-10">
          {!teamId ? (
            <Card title="No rooftop selected"><p className="text-[12.5px] text-[#6b7280]">Open this page from the console so it knows which store to report on.</p></Card>
          ) : open ? (
            <ReportPane
              report={open}
              ctx={ctx}
              onBack={() => setOpenId(null)}
              enabled={liveIds.has(open.id)}
              loading={!ready || insightsLoading}
              siblings={live}
              onOpen={openReport}
              backToAgent={backToAgent}
            />
          ) : (
            <Gallery ctx={ctx} live={liveIds} ready={ready} onOpen={openReport} accountName={account?.name ?? ""} navQuery={navQuery} />
          )}
        </main>
      </div>
    </div>
  );
}

const BUCKET_TEXT: Record<string, string> = {
  today: "Today", yesterday: "Yesterday", last7: "Last 7 days", last14: "Last 14 days",
  last30: "Last 30 days", mtd: "Month to date", lifetime: "All time",
};

/* The gallery. ONE flat grid with category filters rather than a stack of per-category rows: most
 * categories hold two or three reports, so grouping into separate rows left two cards floating in a
 * four-column space. Every card leads with the QUESTION it answers — a manager picks by "what do I want
 * to know", not by chart type. */
function Gallery({ ctx, live, ready, onOpen, accountName, navQuery }: { ctx: ReportCtx; live: Set<string>; ready: boolean; onOpen: (r: ReportDef) => void; accountName: string; navQuery: string }) {
  const [cat, setCat] = useState<string>("All");
  const cats = ["All", ...Array.from(new Set(REPORTS.map((r) => r.category)))];
  // Available reports first — a dealer should never have to hunt past dimmed cards to find a live one.
  const shown = REPORTS.filter((r) => cat === "All" || r.category === cat)
    .slice()
    .sort((a, b) => Number(live.has(b.id)) - Number(live.has(a.id)));

  return (
    <div className="flex flex-col gap-7">
      <AgentReportCards ctx={ctx} navQuery={navQuery} />

      <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex-1 min-w-[240px]">
          <SectionLabel hint={ready ? `${live.size} of ${REPORTS.length} ready for ${ctx.periodLabel.toLowerCase()}` : "loading your data…"}>
            Report library
          </SectionLabel>
        </div>
        {ctx.timezone && <span className="flex-none text-[11px] text-[#9ca3af]">Times in {tzShortLabel(ctx.timezone)}</span>}
      </div>

      <div className="no-print flex flex-wrap gap-1.5">
        {cats.map((k) => {
          const n = k === "All" ? REPORTS.length : REPORTS.filter((r) => r.category === k).length;
          return (
            <button
              key={k}
              type="button"
              onClick={() => setCat(k)}
              className={`rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-colors ${
                cat === k ? "bg-[#f3eaff] text-[#813fed]" : "text-[#6b7280] hover:bg-[#f4f4f6]"
              }`}
            >
              {k} <span className="font-medium text-[#9ca3af]">{n}</span>
            </button>
          );
        })}
      </div>

      <div className="grid gap-3.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(272px, 1fr))" }}>
        {shown.map((r) => {
          const on = live.has(r.id);
          return (
            <button
              key={r.id}
              type="button"
              disabled={!on}
              onClick={() => onOpen(r)}
              className={`flex h-full flex-col items-start gap-2 rounded-2xl border px-5 py-4 text-left transition-shadow ${
                on ? "border-[#e5e7eb] bg-white shadow-sm hover:border-[#d6c9f5] hover:shadow-md" : "cursor-not-allowed border-dashed border-[#e5e7eb] bg-[#fbfbfc]"
              }`}
            >
              <span className="text-[10px] font-bold uppercase tracking-wide text-[#c3b5e8]">{r.category}</span>
              <span className={`text-[13.5px] font-bold leading-tight ${on ? "text-[#111]" : "text-[#9ca3af]"}`}>{r.title}</span>
              <span className={`text-[11.5px] leading-snug ${on ? "text-[#6b7280]" : "text-[#b9bec7]"}`}>{r.question}</span>
              <span className="mt-auto flex w-full items-center justify-between gap-2 pt-2">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-[#9ca3af]">{r.who}</span>
                {on ? (
                  <span className="text-[11.5px] font-bold text-[#813fed]">Open →</span>
                ) : (
                  <span className="text-[10.5px] font-medium text-[#c3cad4]">{ready ? "No data yet" : "…"}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      <RequestForm ctx={ctx} accountName={accountName} />
      </div>
    </div>
  );
}

/* THE TWO AGENT REPORTS, at the head of the library.
 *
 * The small reports below answer one question each; an agent report is the whole story for one agent, so
 * it leads rather than sitting as a 25th card of the same size. Two cards because a sales rooftop runs
 * two agents — the inbound one answering the phone and the outbound one working the list — and a dealer
 * thinks in exactly those terms.
 *
 * Driven by the agents the rooftop ACTUALLY runs (already department-scoped upstream), so a Service-scoped
 * library shows its service agents and a rooftop running one agent shows one card, not an empty slot. */
function AgentReportCards({ ctx, navQuery }: { ctx: ReportCtx; navQuery: string }) {
  const agents = ctx.agents.slice(0, 2);
  if (!agents.length) return null;
  const sep = navQuery ? (navQuery.startsWith("?") ? "&" : "?") : "?";
  return (
    <div className="flex flex-col gap-3">
      <SectionLabel hint={ctx.periodLabel}>Your agents</SectionLabel>
      <div className="grid gap-4" style={{ gridTemplateColumns: agents.length > 1 ? "repeat(auto-fit, minmax(320px, 1fr))" : "1fr" }}>
        {agents.map((a) => {
          const name = a.report.summary.person || a.name;
          /* Canonical wordings, and every label names its OWN unit — calls, leads, appointments — because
           * these three do not nest. Sales Inbound qualified is the AI's verdict at LEAD grain across
           * calls AND texts, so it legitimately runs higher than the call count (117 vs 65 on the rooftop
           * this was built against). A row labelled "Conversations / Qualified / Appointments" reads as a
           * funnel and invites 117÷45 = 260%, which is the exact ratio the metric spec says never to
           * build on this agent. */
          const stats: { label: string; value: string }[] = [
            { label: a.headlineLabel, value: fmtInt(a.metrics.calls) },
            { label: "Qualified leads", value: fmtInt(a.metrics.qualified) },
            { label: "Appointments booked", value: fmtInt(a.metrics.appointments) },
          ];
          // Only worth explaining when the numbers look inverted; on outbound they never do.
          const smsNote = a.metrics.qualified > a.metrics.calls;
          return (
            <a
              key={a.id}
              href={`/reports/agents${navQuery}${sep}agent=${encodeURIComponent(a.id)}`}
              className="flex flex-col gap-4 rounded-2xl border border-[#e5e7eb] bg-white px-6 py-5 shadow-sm transition-shadow hover:border-[#d6c9f5] hover:shadow-md"
            >
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 flex-none items-center justify-center rounded-xl bg-[#faf8ff] text-[20px] leading-none">{a.icon}</span>
                <div className="min-w-0">
                  <p className="truncate text-[15px] font-extrabold leading-tight text-[#111]">{name}</p>
                  <p className="text-[11.5px] text-[#6b7280]">{a.dept} {a.dir} · {a.dir === "Inbound" ? "answers your phone" : "works your lead list"}</p>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                {stats.map((s) => (
                  <div key={s.label}>
                    <p className="text-[9.5px] font-bold uppercase tracking-wide text-[#9ca3af]">{s.label}</p>
                    <p className="mt-0.5 text-[20px] font-extrabold leading-none tabular-nums text-[#111]">{s.value}</p>
                  </div>
                ))}
              </div>

              {smsNote && (
                <p className="text-[10.5px] leading-snug text-[#9ca3af]">
                  Qualified counts leads {name} qualified by call or text, so it can run above the call count.
                </p>
              )}

              <span className="mt-auto text-[12px] font-bold text-[#813fed]">Open the full report →</span>
            </a>
          );
        })}
      </div>
    </div>
  );
}

/** One opened report: header with the question and its source, then the report itself. */
function ReportPane({
  report, ctx, onBack, enabled, loading, siblings, onOpen, backToAgent,
}: {
  report: ReportDef; ctx: ReportCtx; onBack: () => void; enabled: boolean; loading?: boolean;
  /* Reports with live data for this window, in catalog order — drives the switcher and prev/next. */
  siblings: ReportDef[];
  onOpen: (r: ReportDef) => void;
  /* Set when the reader arrived from a By-agent report, so the way back is the agent, not the gallery. */
  backToAgent?: { href: string; label: string } | null;
}) {
  // A takeaway that throws (odd feed shape) must not take the report down with it.
  let takeaway: string | null = null;
  try {
    takeaway = enabled ? report.takeaway?.(ctx) ?? null : null;
  } catch {
    takeaway = null;
  }
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="no-print mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            {/* Two ways back, because there are two ways in: the gallery, and an agent report. */}
            {backToAgent && (
              <a href={backToAgent.href} className="text-[11.5px] font-semibold text-[#813fed] hover:underline">
                ← {backToAgent.label}
              </a>
            )}
            <button type="button" onClick={onBack} className="text-[11.5px] font-semibold text-[#813fed] hover:underline">
              {backToAgent ? "All reports" : "← All reports"}
            </button>
          </div>
          <h1 className="text-[20px] font-extrabold leading-tight text-[#111]">{report.title}</h1>
          <p className="mt-0.5 text-[12.5px] text-[#6b7280]">{report.question}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <ReportSwitcher current={report} siblings={siblings} onOpen={onOpen} />
          <div className="text-right">
            <p className="text-[11px] font-semibold text-[#374151]">{ctx.periodLabel}</p>
            <p className="text-[10.5px] text-[#9ca3af]">{report.source}</p>
          </div>
        </div>
      </div>

      {enabled && takeaway && (
        <div className="rounded-2xl border border-[#e0d8f5] bg-[#faf8ff] px-5 py-4">
          <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-[#813fed]">What this says</p>
          <p className="mt-1 text-[13px] leading-relaxed text-[#374151]">{takeaway}</p>
        </div>
      )}

      {enabled ? (
        report.render(ctx)
      ) : loading ? (
        <div className="flex flex-col gap-3">
          <div className="h-24 animate-pulse rounded-2xl border border-[#e5e7eb] bg-white" />
          <div className="h-56 animate-pulse rounded-2xl border border-[#e5e7eb] bg-white" />
        </div>
      ) : (
        <Card title="Nothing to show for this period">
          <p className="text-[12.5px] leading-snug text-[#6b7280]">
            This report reads {report.source.toLowerCase()}, and there is no activity for {ctx.periodLabel.toLowerCase()}.
            Widen the date range, or come back once more has come in.
          </p>
        </Card>
      )}

      <PrevNext current={report} siblings={siblings} onOpen={onOpen} />

      <p className="text-[10.5px] text-[#9ca3af]">
        {fmtInt(ctx.fleet.conversations)} conversations in this period · source: {report.source}
      </p>
    </div>
  );
}

/* CUSTOM REPORT REQUEST — the dealer describes what they want and it reaches the product team.
 * A form, not a mailto: it captures the rooftop automatically, so a request always arrives with the
 * context needed to build it. Submits to /api/report-request, which logs server-side before it tries
 * any side-channel, so a request is never silently lost. */
function RequestForm({ ctx, accountName }: { ctx: ReportCtx; accountName: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState("");
  const [form, setForm] = useState({ name: "", email: "", title: "", description: "", cadence: "One-off" });

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setState("sending");
    setError("");
    try {
      const r = await fetch("/api/report-request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...form, teamId: ctx.teamId, accountName }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setError(j.error || "Something went wrong — please try again.");
        setState("error");
        return;
      }
      track("library_report_requested", { team_id: ctx.teamId });
      setState("sent");
    } catch {
      setError("Couldn't reach the server — please try again.");
      setState("error");
    }
  };

  if (state === "sent") {
    return (
      <div className="rounded-2xl border border-[#bbf7d0] bg-[#f0fdf4] px-5 py-4">
        <p className="text-[13px] font-bold text-[#15803d]">Request sent</p>
        <p className="mt-0.5 text-[11.5px] leading-snug text-[#166534]">
          Thanks — we have your request and the rooftop it applies to. We&apos;ll be in touch at {form.email}.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-dashed border-[#d8d3ea] bg-[#faf8ff] px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[13px] font-bold text-[#111]">Need a report that isn&apos;t here?</p>
          <p className="mt-0.5 text-[11.5px] leading-snug text-[#6b7280]">
            Tell us what you want to see and we&apos;ll build it. These {REPORTS.length} are just the ones we
            hear asked for most.
          </p>
        </div>
        {!open && (
          <button type="button" onClick={() => setOpen(true)} className="flex-none rounded-lg bg-[#813fed] px-4 py-2 text-[12.5px] font-semibold text-white hover:bg-[#6d2fd4]">
            Request a report
          </button>
        )}
      </div>

      {open && (
        <form onSubmit={submit} className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold text-[#374151]">Your name</span>
            <input required value={form.name} onChange={set("name")} className="rounded-lg border border-[#e5e7eb] bg-white px-3 py-2 text-[12.5px]" placeholder="Alex Morgan" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold text-[#374151]">Email</span>
            <input required type="email" value={form.email} onChange={set("email")} className="rounded-lg border border-[#e5e7eb] bg-white px-3 py-2 text-[12.5px]" placeholder="you@dealership.com" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold text-[#374151]">What should it be called?</span>
            <input value={form.title} onChange={set("title")} className="rounded-lg border border-[#e5e7eb] bg-white px-3 py-2 text-[12.5px]" placeholder="Trade-in appraisals by source" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold text-[#374151]">How often do you need it?</span>
            <select value={form.cadence} onChange={set("cadence")} className="rounded-lg border border-[#e5e7eb] bg-white px-3 py-2 text-[12.5px]">
              {["One-off", "Daily", "Weekly", "Monthly"].map((o) => <option key={o}>{o}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className="text-[11px] font-semibold text-[#374151]">What do you want to see?</span>
            <textarea
              required
              rows={3}
              value={form.description}
              onChange={set("description")}
              className="rounded-lg border border-[#e5e7eb] bg-white px-3 py-2 text-[12.5px]"
              placeholder="Which questions should it answer? What would you do differently once you could see it?"
            />
          </label>
          <div className="flex items-center gap-3 sm:col-span-2">
            <button type="submit" disabled={state === "sending"} className="rounded-lg bg-[#813fed] px-4 py-2 text-[12.5px] font-semibold text-white disabled:opacity-60">
              {state === "sending" ? "Sending…" : "Send request"}
            </button>
            <button type="button" onClick={() => setOpen(false)} className="text-[12px] font-semibold text-[#6b7280] hover:underline">Cancel</button>
            {error && <span className="text-[11.5px] font-semibold text-[#dc2626]">{error}</span>}
          </div>
        </form>
      )}
    </div>
  );
}

/* Jump straight to another report without going back to the gallery. A native <select> on purpose:
 * it is keyboard- and screen-reader-correct for free, it works on a phone, and 20-odd reports in a
 * hand-rolled menu is a scroll trap. Only reports with live data for this window are listed — offering
 * a jump to an empty report is the same trap the gallery already avoids by dimming. */
function ReportSwitcher({ current, siblings, onOpen }: { current: ReportDef; siblings: ReportDef[]; onOpen: (r: ReportDef) => void }) {
  if (siblings.length < 2) return null;
  const byCategory = siblings.reduce<Record<string, ReportDef[]>>((acc, r) => {
    (acc[r.category] ??= []).push(r);
    return acc;
  }, {});
  return (
    <label className="no-print flex items-center gap-2">
      <span className="text-[10.5px] font-semibold text-[#9ca3af]">Jump to</span>
      <select
        value={current.id}
        onChange={(e) => {
          const next = siblings.find((r) => r.id === e.target.value);
          if (next) onOpen(next);
        }}
        className="max-w-[260px] rounded-lg border border-[#e5e7eb] bg-white px-2.5 py-1.5 text-[12px] font-semibold text-[#374151]"
      >
        {Object.entries(byCategory).map(([cat, rs]) => (
          <optgroup key={cat} label={cat}>
            {rs.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

/* Read-one-then-the-next. The switcher covers "I know where I'm going"; this covers browsing, which is
 * how someone meets a library they haven't seen before. */
function PrevNext({ current, siblings, onOpen }: { current: ReportDef; siblings: ReportDef[]; onOpen: (r: ReportDef) => void }) {
  const i = siblings.findIndex((r) => r.id === current.id);
  if (i < 0 || siblings.length < 2) return null;
  const prev = i > 0 ? siblings[i - 1] : null;
  const next = i < siblings.length - 1 ? siblings[i + 1] : null;
  return (
    <div className="no-print flex flex-wrap gap-3 border-t border-[#f2f2f4] pt-4">
      {prev ? <StepButton r={prev} dir="prev" onOpen={onOpen} /> : <span className="flex-1" />}
      {next ? <StepButton r={next} dir="next" onOpen={onOpen} /> : <span className="flex-1" />}
    </div>
  );
}

/* Module scope, not defined inside PrevNext: a component created during render is a new type on every
 * pass, so React remounts it each time and the compiler refuses to memoize the tree. */
function StepButton({ r, dir, onOpen }: { r: ReportDef; dir: "prev" | "next"; onOpen: (r: ReportDef) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(r)}
      className={`flex min-w-0 flex-1 flex-col gap-0.5 rounded-xl border border-[#e5e7eb] bg-white px-4 py-3 text-left transition-shadow hover:border-[#d6c9f5] hover:shadow-md ${dir === "next" ? "items-end text-right" : ""}`}
    >
      <span className="text-[10px] font-bold uppercase tracking-wide text-[#9ca3af]">{dir === "prev" ? "← Previous" : "Next →"}</span>
      <span className="truncate text-[12.5px] font-bold text-[#111]">{r.title}</span>
    </button>
  );
}
