"use client";

/* THE REPORT LIBRARY, as a PANEL rather than a page.
 *
 * It has to be a component because the console's Reports tab iframes /reports/agents (parentNav.ts maps
 * reports → /reports/agents). A library living at its own route is unreachable from the console without
 * a change in the parent-console repo, so the same panel is mounted inside that route and, for local
 * work, behind /reports/library too.
 *
 * One fetch pass loads every source the catalog draws on (agent feed, ClickHouse metric snapshot, action
 * items, ClickHouse insights, conversation reviews); each report reads what it needs from the shared
 * context, which is why opening a second report is instant.
 *
 * Reports without live data for the window are listed but dimmed rather than opening onto an empty page. */

"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

import { Card, DateFilter, SectionLabel, fmtInt } from "@/components/reports/kit";
import { useScenario } from "@/components/reports/scenario";
import { useDateRange, useDept } from "@/components/reports/dateRange";
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
import { REPORTS, availableReports, reportSheets, type ReportCtx, type ReportDef } from "@/components/reports/library";
import { downloadXLSX, downloadCSV, exportFilenameStem } from "@/components/reports/exportReport";
import { track } from "@/lib/analytics";
import type { InsightsPayload } from "@/app/api/reports/insights/route";
import type { Bucket } from "@/components/reports/data";

/* ClickHouse-only datasets for the library (CRM outcome, vehicles, transfer routing, texts, coverage).
 * Returns null on any failure — the reports that need it simply aren't offered. */
async function fetchInsights(
  teamId: string,
  win: { bucket?: string; start?: string; end?: string },
  spyneToken?: string,
  dept?: string,
): Promise<InsightsPayload | null> {
  const qs = new URLSearchParams({ team_id: teamId });
  // Sales and Service are separate P&Ls — the scope has to reach the SQL, or a Service view shows Sales.
  if (dept === "sales" || dept === "service") qs.set("serviceType", dept);
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


/* BOOKMARKS — per rooftop, in this browser.
 *
 * localStorage rather than the account-wide layout store on purpose: a bookmark is one person saying
 * "this is the one I open every Monday", not a decision for everyone at the rooftop. Keyed by team so a
 * group's rooftops don't inherit each other's. */
const BOOKMARK_KEY = (teamId: string) => `spyne.reportBookmarks.${teamId}`;

function readBookmarks(teamId: string): string[] {
  if (!teamId || typeof window === "undefined") return [];
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(BOOKMARK_KEY(teamId)) ?? "[]");
    // A hand-edited or corrupted value must not take the library down.
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function useBookmarks(teamId: string) {
  /* Read lazily, keyed by team, rather than in an effect: localStorage is synchronous, so an effect just
   * costs a second render and trips the compiler's set-state-in-effect rule for no benefit. */
  const [state, setState] = useState<{ team: string; ids: string[] }>(() => ({ team: teamId, ids: readBookmarks(teamId) }));
  const ids = state.team === teamId ? state.ids : readBookmarks(teamId);
  const toggle = (id: string) => {
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
    try { window.localStorage.setItem(BOOKMARK_KEY(teamId), JSON.stringify(next)); } catch { /* private mode — the session still works */ }
    setState({ team: teamId, ids: next });
  };
  return { ids, toggle };
}

export function ReportLibraryPanel({ navQuery, onOpenAgent, initialReportId }: { navQuery: string; onOpenAgent?: (agentId: string) => void; initialReportId?: string | null }) {
  const { bucket, custom, setPreset, setCustom } = useDateRange();
  const { dept } = useDept();
  const { teamId, enterpriseId, account, spyneToken, spyneEnv } = useScenario();
  const params = useSearchParams();
  const [openId, setOpenId] = useState<string | null>(initialReportId ?? params.get("report"));

  const rangeOpts = custom ? { start: custom.start, end: addDay(custom.end), spyneToken, spyneEnv } : { bucket, spyneToken, spyneEnv };
  const [feed, setFeed] = useState<FetchResult | null>(() => peekAgents({ teamId, ...rangeOpts }));
  const [metrics, setMetrics] = useState<ReportMetrics | null>(null);
  const [actionStats, setActionStats] = useState<ActionItemStats | null>(null);
  const [actionItems, setActionItems] = useState<ActionItem[]>([]);
  const [insights, setInsights] = useState<InsightsPayload | null>(null);
  // Distinguishes "still fetching" from "genuinely nothing" — a deep link opened a report before the
  // ClickHouse datasets landed and it rendered the empty state, which reads as broken.
  const [insightsLoading, setInsightsLoading] = useState(true);
  const bookmarks = useBookmarks(teamId);

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
      fetchInsights(teamId, custom ? { start: custom.start, end: addDay(custom.end) } : { bucket }, spyneToken, dept).catch(() => null),
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
    serviceType: dept === "service" ? "service" : "sales",
    enabled: !!teamId,
  });

  const agents = useMemo(() => agentsForAccount(feed?.agents ?? [], account), [feed, account]);
  const scoped = useMemo(() => (dept === "all" ? agents : agents.filter((a) => a.dept.toLowerCase() === dept)), [agents, dept]);
  const fleet = useMemo(() => aggregateFleet(scoped, feed?.prior, feed?.appointmentsUnattributed), [scoped, feed]);
  const periodLabel = custom ? `${custom.start} → ${custom.end}` : BUCKET_TEXT[bucket] ?? "Last 30 days";

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
      dept: dept === "all" ? "all" : dept,
      window: custom ? { start: custom.start, end: addDay(custom.end) } : { bucket },
      spyneToken,
      warmLeads: (feed?.warmLeads ?? []).filter((w) => dept === "all" || w.serviceType === dept),
      namedAppts: (feed?.namedAppointments ?? []).filter((a) => dept === "all" || a.serviceType === dept),
    }),
    [teamId, enterpriseId, periodLabel, feed, fleet, scoped, metrics, actionStats, actionItems, outcomesFeed.data, dept, insights, bucket, custom, spyneToken],
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
    <div className="flex flex-col gap-5">
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
              bookmarks={bookmarks}
              accountName={account?.name ?? ""}
              range={{ bucket, custom, setPreset, setCustom }}
            />
          ) : (
            <Gallery ctx={ctx} live={liveIds} ready={ready} onOpen={openReport} accountName={account?.name ?? ""} navQuery={navQuery} onOpenAgent={onOpenAgent} bookmarks={bookmarks} />
          )}
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
function Gallery({ ctx, live, ready, onOpen, accountName, navQuery, onOpenAgent, bookmarks }: { ctx: ReportCtx; live: Set<string>; ready: boolean; onOpen: (r: ReportDef) => void; accountName: string; navQuery: string; onOpenAgent?: (agentId: string) => void; bookmarks: { ids: string[]; toggle: (id: string) => void } }) {
  const [cat, setCat] = useState<string>("All");
  /* Reports meaningful only to the OTHER department are removed outright, not dimmed: a dimmed card still
   * tells a service manager that "vehicles customers are asking for" is a thing their agent measures. */
  const inScope = REPORTS.filter((r) => !r.depts || !ctx.dept || ctx.dept === "all" || r.depts.includes(ctx.dept));
  const [q, setQ] = useState("");
  const cats = ["All", ...(bookmarks.ids.length ? ["Bookmarked"] : []), ...Array.from(new Set(inScope.map((r) => r.category)))];
  /* Search covers the QUESTION and the audience too, not just the title — someone looking for "show
   * rate" or "BDC" is describing what they want, not naming a report they already know. */
  /* Every TERM must appear somewhere, rather than the phrase verbatim: a dealer types "show rate", and
   * the report is called "Did the appointments show?" — a phrase match finds nothing, which is how the
   * placeholder ended up suggesting a search that returned zero. `keywords` carries the words a dealer
   * uses that the report's own copy doesn't. */
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (r: ReportDef) => {
    if (!terms.length) return true;
    const hay = `${r.title} ${r.question} ${r.category} ${r.who} ${r.source} ${(r.keywords ?? []).join(" ")}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  };
  const needle = terms.join(" ");
  // Available reports first — a dealer should never have to hunt past dimmed cards to find a live one.
  const shown = inScope
    .filter((r) => (cat === "Bookmarked" ? bookmarks.ids.includes(r.id) : cat === "All" || r.category === cat))
    .filter(matches)
    .slice()
    .sort((a, b) => Number(bookmarks.ids.includes(b.id)) - Number(bookmarks.ids.includes(a.id)) || Number(live.has(b.id)) - Number(live.has(a.id)));

  return (
    <div className="flex flex-col gap-7">
      <AgentReportCards ctx={ctx} navQuery={navQuery} onOpenAgent={onOpenAgent} />

      <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex-1 min-w-[240px]">
          <SectionLabel hint={ready ? `${live.size} of ${inScope.length} ready for ${ctx.periodLabel.toLowerCase()}` : "loading your data…"}>
            Report library
          </SectionLabel>
        </div>
        {ctx.timezone && <span className="flex-none text-[11px] text-[#9ca3af]">Times in {tzShortLabel(ctx.timezone)}</span>}
      </div>

      <div className="no-print flex flex-wrap items-center gap-2">
        <label className="relative flex-1 min-w-[220px] max-w-[360px]">
          <span className="sr-only">Search reports</span>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Search reports — try “show rate”, “loaner” or “ROI”`}
            className="w-full rounded-lg border border-[#e5e7eb] bg-white px-3 py-2 text-[12.5px] text-[#374151] placeholder:text-[#9ca3af]"
          />
        </label>
        {needle && <span className="text-[11.5px] text-[#9ca3af]">{shown.length} match{shown.length === 1 ? "" : "es"}</span>}
      </div>

      <div className="no-print flex flex-wrap gap-1.5">
        {cats.map((k) => {
          const n = k === "All" ? inScope.length : k === "Bookmarked" ? bookmarks.ids.length : inScope.filter((r) => r.category === k).length;
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
            /* The star is its own control, so the card body is a div with a click handler rather than a
               button — a button inside a button is invalid HTML and swallows the inner click. */
            <div
              key={r.id}
              className={`relative flex h-full flex-col items-start gap-2 rounded-2xl border px-5 py-4 text-left transition-shadow ${
                on ? "border-[#e5e7eb] bg-white shadow-sm hover:border-[#d6c9f5] hover:shadow-md" : "border-dashed border-[#e5e7eb] bg-[#fbfbfc]"
              } ${on ? "cursor-pointer" : "cursor-not-allowed"}`}
              onClick={on ? () => onOpen(r) : undefined}
              role={on ? "button" : undefined}
              tabIndex={on ? 0 : undefined}
              onKeyDown={on ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(r); } } : undefined}
            >
              <BookmarkStar on={bookmarks.ids.includes(r.id)} onToggle={() => bookmarks.toggle(r.id)} />
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
            </div>
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
function AgentReportCards({ ctx, navQuery, onOpenAgent }: { ctx: ReportCtx; navQuery: string; onOpenAgent?: (agentId: string) => void }) {
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
            /* Inside /reports/agents this is a view switch, not navigation — a full page load there would
             * throw away the feed we already have. Standalone, it stays a real link. */
            <CardShell
              key={a.id}
              href={onOpenAgent ? undefined : `/reports/agents${navQuery}${sep}agent=${encodeURIComponent(a.id)}`}
              onClick={onOpenAgent ? () => onOpenAgent(a.id) : undefined}
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
            </CardShell>
          );
        })}
      </div>
    </div>
  );
}

/** One opened report: header with the question and its source, then the report itself. */
function ReportPane({
  report, ctx, onBack, enabled, loading, siblings, onOpen, backToAgent, bookmarks, accountName, range,
}: {
  report: ReportDef; ctx: ReportCtx; onBack: () => void; enabled: boolean; loading?: boolean;
  bookmarks: { ids: string[]; toggle: (id: string) => void }; accountName: string;
  /* The period lives with the report, not only in the page chrome above it. A reader deep in a long
   * report should not have to scroll back to the top bar to ask the same question about a different
   * window — and on the standalone route there is no top bar at all. Same URL-backed state, so the two
   * controls can never disagree. */
  range: {
    bucket: Bucket;
    custom: { start: string; end: string } | null;
    setPreset: (b: Bucket) => void;
    setCustom: (r: { start: string; end: string }) => void;
  };
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
      {/* Header: the report identifies itself on the LEFT and every control sits in ONE toolbar row on
          the right. Previously the right-hand side stacked three separately-aligned rows — actions, then
          the date range, then a long source caption — which gave the header a ragged right edge and no
          clear order of importance. The source line moved left, under the question it describes, where
          it reads as prose instead of a third floating column. */}
      <div className="flex flex-col gap-3">
        <div className="no-print flex flex-wrap items-center gap-x-3 gap-y-1">
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

        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-[20px] font-extrabold leading-tight text-[#111]">{report.title}</h1>
            <p className="mt-1 text-[13px] leading-snug text-[#6b7280]">{report.question}</p>
            <p className="mt-1.5 text-[11px] leading-snug text-[#9ca3af]">{report.source}</p>
          </div>

          {/* One row, one height, one radius — a toolbar rather than three stacked clusters. */}
          <div className="no-print flex flex-none flex-wrap items-center justify-end gap-2">
            <DateFilter bucket={range.bucket} custom={range.custom} onPreset={range.setPreset} onCustom={range.setCustom} />
            <span aria-hidden className="hidden h-6 w-px bg-[#e5e7eb] sm:block" />
            <BookmarkStar inline on={bookmarks.ids.includes(report.id)} onToggle={() => bookmarks.toggle(report.id)} />
            <DownloadButton report={report} ctx={ctx} accountName={accountName} disabled={!enabled} />
            <ReportSwitcher current={report} siblings={siblings} onOpen={onOpen} />
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
            Tell us what you want to see and we&apos;ll build it. These are just the ones we
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
    /* The "Jump to" caption is gone: it doubled the control's width for a word the select already
       implies, and it was the widest thing in the header. The purpose now lives in the accessible name
       and the tooltip instead of taking layout space. */
    <label className="no-print flex items-center">
      <span className="sr-only">Jump to another report</span>
      <select
        title="Jump to another report"
        value={current.id}
        onChange={(e) => {
          const next = siblings.find((r) => r.id === e.target.value);
          if (next) onOpen(next);
        }}
        className="h-[34px] max-w-[230px] rounded-lg border border-[#e5e7eb] bg-white px-2.5 text-[12.5px] font-semibold text-[#374151] hover:bg-[#faf8ff]"
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

/** One card body, rendered as a link when it navigates and a button when it only switches view. */
function CardShell({ href, onClick, children }: { href?: string; onClick?: () => void; children: React.ReactNode }) {
  const cls = "flex flex-col gap-4 rounded-2xl border border-[#e5e7eb] bg-white px-6 py-5 text-left shadow-sm transition-shadow hover:border-[#d6c9f5] hover:shadow-md";
  return href ? <a href={href} className={cls}>{children}</a> : <button type="button" onClick={onClick} className={cls}>{children}</button>;
}

/* Bookmark toggle. Absolutely positioned on a gallery card (so it sits clear of the card's own click
 * target) and inline in the report header. */
function BookmarkStar({ on, onToggle, inline }: { on: boolean; onToggle: () => void; inline?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? "Remove bookmark" : "Bookmark this report"}
      title={on ? "Remove bookmark" : "Bookmark this report"}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      className={`no-print flex flex-none items-center justify-center rounded-lg border transition-colors ${
        inline ? "h-[34px] w-[34px]" : "absolute right-3 top-3 h-7 w-7"
      } ${on ? "border-[#e6d9ff] bg-[#faf8ff] text-[#813fed]" : inline ? "border-[#e5e7eb] bg-white text-[#c3cad4] hover:text-[#9ca3af]" : "border-transparent text-[#c3cad4] hover:border-[#e5e7eb] hover:text-[#9ca3af]"}`}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
        <path d="M12 3.5l2.6 5.3 5.9.85-4.25 4.15 1 5.85L12 16.9l-5.25 2.75 1-5.85L3.5 9.65l5.9-.85z" />
      </svg>
    </button>
  );
}

/* Download this report's own data — the numbers on screen, as sheets, not a screenshot. XLSX by default
 * because it is what a manager forwards; CSV for anyone piping it somewhere. */
function DownloadButton({ report, ctx, accountName, disabled }: { report: ReportDef; ctx: ReportCtx; accountName: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (disabled) return null;

  const run = async (fmt: "xlsx" | "csv") => {
    setOpen(false);
    setBusy(true);
    try {
      const sheets = reportSheets(report, ctx);
      const stem = `${exportFilenameStem(accountName, ctx.periodLabel)} - ${report.title}`.replace(/[/\\?%*:|"<>]/g, "-");
      if (fmt === "xlsx") await downloadXLSX(`${stem}.xlsx`, sheets);
      else downloadCSV(`${stem}.csv`, sheets);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        className="flex h-[34px] items-center gap-1.5 rounded-lg border border-[#e5e7eb] bg-white px-3 text-[12.5px] font-semibold text-[#374151] hover:bg-[#faf8ff] disabled:opacity-60"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 3v12" /><path d="M7 12l5 5 5-5" /><path d="M4 20h16" />
        </svg>
        {busy ? "Preparing…" : "Download"}
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-36 overflow-hidden rounded-lg border border-[#e5e7eb] bg-white shadow-lg">
          {(["xlsx", "csv"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => run(f)}
              className="block w-full px-3 py-2 text-left text-[12px] font-semibold text-[#374151] hover:bg-[#faf8ff]"
            >
              {f === "xlsx" ? "Excel (.xlsx)" : "CSV (.csv)"}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
