"use client";

import { Suspense, useEffect, useState } from "react";
import {
  BUCKET_LABELS,
  Card,
  DateFilter,
  EmptyState,
  fmtInt,
  ReportTopBar,
  SectionLabel,
  Td,
  Th,
} from "@/components/reports/kit";
import { ActionItemsScoreboard, fmtWhenShort } from "@/components/reports/kitV3";
import { useScenario } from "@/components/reports/scenario";
import { useDateRange, useDept, reportNavQuery, useVariant } from "@/components/reports/dateRange";
import {
  fetchActionItems,
  fetchActionItemStats,
  addDay,
  rangeFor,
  type ActionItem,
  type ActionItemStats,
  type ActionItemCloser,
} from "@/components/reports/liveData";
import { track } from "@/lib/analytics";
import { useServiceActionItemsPageOverlay } from "@/lib/serviceMetrics";

type Scope = "open" | "overdue";

export default function ActionItemsPage() {
  return (
    <Suspense fallback={null}>
      <ActionItemsView />
    </Suspense>
  );
}

function ActionItemsView() {
  const { teamId, account, spyneToken, spyneEnv, enterpriseId } = useScenario();
  const { bucket, custom, setPreset, setCustom } = useDateRange();
  const { dept } = useDept(); // top-level scope (shared header, URL-persisted)
  // variant rides along so the Old/New choice survives navigation between tabs.
  const { variant } = useVariant();
  const navQuery = reportNavQuery(teamId, bucket, custom, dept, false, variant);
  const periodLabel = custom ? `${custom.start} – ${custom.end}` : BUCKET_LABELS[bucket];
  // shared dept "all" → the action-items API's serviceType "both".
  const service: "sales" | "service" | "both" = dept === "all" ? "both" : dept;

  const [scope, setScope] = useState<Scope>("open");
  const [stats, setStats] = useState<{ stats: ActionItemStats; closers: ActionItemCloser[] } | null>(null);
  const [items, setItems] = useState<ActionItem[] | null>(null);

  // RETCONVAI-5066: read service-metrics instead of ClickHouse for Service, behind the flag. Om's
  // action-item endpoint has no `created` field — only openNow/pastSla/cleared — so the "Created" stat
  // and its tab (below) have no twin and are dropped entirely for Service; the Open/Overdue working list
  // reuses the same rooftop-wide list this app's Overview now reads (see serviceMetrics.ts).
  const serviceMetricsFlagOn = process.env.NEXT_PUBLIC_SERVICE_METRICS_OLD_VIEW === "on";
  const serviceMetricsOn = serviceMetricsFlagOn && dept === "service" && !!teamId;
  const svcRange = custom ? { start: custom.start, end: addDay(custom.end) } : rangeFor(bucket);
  const svcMetrics = useServiceActionItemsPageOverlay({
    enabled: serviceMetricsOn,
    enterpriseId,
    teamId,
    spyneToken,
    spyneEnv,
    bucket,
    custom,
    rangeStart: svcRange.start,
    rangeEndExclusive: svcRange.end,
  });

  useEffect(() => { track("report_viewed", { tab: "actions", team_id: teamId }); }, [teamId]);

  // Scoreboard (created/closed for the window + open/overdue/due-today now + who closed most). Presets
  // pass `bucket` so the SERVER resolves a store-local window (matching the Overview card, RETCONVAI-4144);
  // custom ranges pass explicit dates. The old client-side rangeFor(bucket) computed a UTC window.
  useEffect(() => {
    if (!teamId) { setStats(null); return; }
    let on = true;
    const opts = custom
      ? { start: custom.start, end: addDay(custom.end), service, spyneToken, spyneEnv }
      : { bucket, service, spyneToken, spyneEnv };
    fetchActionItemStats(teamId, opts).then((r) => { if (on) setStats(r); });
    return () => { on = false; };
  }, [teamId, bucket, custom, service, spyneToken, spyneEnv]);

  // The working list — open queue or the overdue escalation list.
  useEffect(() => {
    if (!teamId) { setItems([]); return; }
    let on = true;
    setItems(null);
    fetchActionItems(teamId, { scope, service, limit: 200, spyneToken }).then((r) => { if (on) setItems(r); });
    return () => { on = false; };
  }, [teamId, scope, service, spyneToken]);

  const now = Date.now();
  const isOverdue = (a: ActionItem) => !a.completed && a.dueAt && new Date(a.dueAt).getTime() < now;

  return (
    <div className="flex min-h-screen bg-[#fafafa]">
      <div className="flex flex-1 flex-col">
        <ReportTopBar
          title="Action items"
          subtitle="Follow-up tasks the AI logged for the team — what's open, what's overdue, and who's closing them."
          active="actions"
          teamId={teamId}
          query={navQuery}
          hideTabs
          hideDept
          right={
            teamId ? (
              <DateFilter
                bucket={bucket}
                custom={custom}
                onPreset={(b) => { setPreset(b); track("date_range_changed", { tab: "actions", range: b, team_id: teamId }); }}
                onCustom={(r) => { setCustom(r); track("date_range_changed", { tab: "actions", range: "custom", team_id: teamId }); }}
              />
            ) : undefined
          }
        />

        <main className="mx-auto w-full max-w-[1320px] flex-1 px-4 sm:px-6 lg:px-10 pt-7 pb-36 flex flex-col gap-7">
          {/* Scoreboard — Service (flag on) has no `created` field on service-metrics, only
              openNow/pastSla/cleared, so the "Created" stat and the closers breakdown are dropped
              entirely rather than shown from the old ClickHouse source (see serviceMetrics.ts). */}
          <div className="flex flex-col gap-3.5">
            <SectionLabel hint={periodLabel}>The scoreboard</SectionLabel>
            <Card title="Follow-up tasks the AI logged" sub={serviceMetricsOn ? "Open, past-SLA and cleared — live counts" : "Created & closed for the selected window · open, overdue and due-today are live counts"}>
              {serviceMetricsOn ? (
                <div className="grid grid-cols-3 gap-4">
                  <ScoreTile label="Open now" value={svcMetrics.openNow} />
                  {/* Past SLA is a count of the loaded rows' own isLate flag, same as the Overview table
                      — never a separate live metric, so there is nothing that can disagree with the rows
                      below it and no caveat is needed (checker fix, 28-Sep). */}
                  <ScoreTile label="Past SLA" value={svcMetrics.pastSla} />
                  <ScoreTile label="Cleared" value={svcMetrics.cleared} />
                </div>
              ) : stats ? (
                <ActionItemsScoreboard stats={stats.stats} closers={stats.closers} periodLabel={periodLabel} />
              ) : (
                <div className="h-[120px] animate-pulse rounded-xl bg-[#eef0f3]" />
              )}
            </Card>
          </div>

          {/* Working list */}
          <div className="flex flex-col gap-3.5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <SectionLabel hint={serviceMetricsOn ? `${svcMetrics.items?.length ?? 0} shown` : items ? `${items.length} shown` : "loading…"}>
                {scope === "overdue" ? "Overdue — needs attention" : "Open queue"}
              </SectionLabel>
              <div className="no-print flex items-center gap-2">
                <Segment value={scope} onChange={(v) => { setScope(v as Scope); track("action_item_filtered", { team_id: teamId, dept, scope: v }); }}
                  options={[{ v: "open", l: "Open" }, { v: "overdue", l: "Overdue" }]} />
              </div>
            </div>
            <Card title="" pad={false}>
              {serviceMetricsOn ? (
                (() => {
                  // Om's list is already the OPEN queue, sort=due:asc — "Overdue" here filters that same
                  // list by `isLate` client-side rather than a second server scope (there isn't one).
                  const svcRows = (svcMetrics.items ?? []).filter((it) => scope === "open" || it.isLate);
                  return svcRows.length === 0 ? (
                    <div className="px-6 py-6">
                      <EmptyState icon="✅" title={scope === "overdue" ? "Nothing overdue" : "No open action items"} body={`${account.name || "This rooftop"} has no ${scope === "overdue" ? "overdue" : "open"} action items.`} />
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[560px] border-collapse text-[12.5px]">
                        <thead>
                          <tr>
                            <Th>Customer</Th>
                            <Th>What to do</Th>
                            <Th>Due</Th>
                            <Th>Status</Th>
                          </tr>
                        </thead>
                        <tbody>
                          {svcRows.map((it, i) => (
                            <tr key={`${it.customer}-${i}`} className="border-t border-[#f0f0f0]">
                              <Td><span className="font-semibold text-[#111]">{it.customer}</span></Td>
                              <Td><span className="text-[#374151]">{it.what}</span></Td>
                              <Td><span className={it.isLate ? "font-semibold text-[#dc2626]" : "text-[#6b7280]"}>{it.due ? fmtWhenShort(it.due) : "—"}</span></Td>
                              <Td>{it.isLate ? <span className="font-semibold text-[#dc2626]">Overdue</span> : <span className="font-semibold text-[#2563eb]">Open</span>}</Td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  );
                })()
              ) : items === null ? (
                <div className="px-6 py-6"><div className="h-[160px] animate-pulse rounded-xl bg-[#eef0f3]" /></div>
              ) : items.length === 0 ? (
                <div className="px-6 py-6">
                  <EmptyState icon="✅" title={scope === "overdue" ? "Nothing overdue" : "No open action items"} body={`${account.name || "This rooftop"} has no ${scope === "overdue" ? "overdue" : "open"} action items in this department.`} />
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] border-collapse text-[12.5px]">
                    <thead>
                      <tr>
                        <Th>Customer</Th>
                        <Th>What to do</Th>
                        <Th>Dept</Th>
                        <Th>Priority</Th>
                        <Th>Due</Th>
                        <Th>Status</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((a) => {
                        const overdue = isOverdue(a);
                        return (
                          <tr key={a.id} className="border-t border-[#f0f0f0]">
                            <Td>
                              <span className="font-semibold text-[#111]">{a.customer || "—"}</span>
                              {a.phone && <a href={`tel:${a.phone}`} className="ml-2 text-[11px] tabular-nums text-[#6b7280] underline decoration-dotted underline-offset-2">{a.phone}</a>}
                            </Td>
                            <Td><span className="text-[#374151]">{a.description || prettyIntent(a.intent)}</span></Td>
                            <Td><span className="capitalize text-[#6b7280]">{a.dept}</span></Td>
                            <Td><PriorityPill priority={a.priority} /></Td>
                            <Td><span className={overdue ? "font-semibold text-[#dc2626]" : "text-[#6b7280]"}>{a.dueAt ? fmtWhenShort(a.dueAt) : "—"}</span></Td>
                            <Td>
                              {a.completed
                                ? <span className="font-semibold text-[#059669]">Closed</span>
                                : overdue
                                  ? <span className="font-semibold text-[#dc2626]">Overdue</span>
                                  : <span className="font-semibold text-[#2563eb]">Open</span>}
                            </Td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
            <p className="text-[11px] text-[#9ca3af]">
              {serviceMetricsOn
                ? "Action items are created and auto-resolved by your Vini AI."
                : <>Action items are created and auto-resolved by your Vini AI. &ldquo;Closed most&rdquo; shows the AI plus any team members your CRM assigns tasks to.</>}
            </p>
          </div>
        </main>
      </div>
    </div>
  );
}

function ScoreTile({ label, value }: { label: string; value: number | null }) {
  return (
    <div>
      <p className="text-[9.5px] font-bold uppercase tracking-wider text-[#9ca3af]">{label}</p>
      <p className="mt-0.5 text-[22px] font-extrabold tabular-nums text-[#111]">{value != null ? fmtInt(value) : "—"}</p>
    </div>
  );
}

function Segment({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { v: string; l: string }[] }) {
  return (
    <div className="inline-flex rounded-lg border border-[#e5e7eb] bg-white p-0.5">
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={`rounded-md px-2.5 py-1 text-[11.5px] font-semibold transition-colors ${value === o.v ? "bg-[#f3eaff] text-[#813fed]" : "text-[#6b7280] hover:text-[#111]"}`}
        >
          {o.l}
        </button>
      ))}
    </div>
  );
}

function PriorityPill({ priority }: { priority: string }) {
  const p = (priority || "").toUpperCase();
  const style = p === "HIGH" ? { bg: "#fdecec", fg: "#dc2626" } : p === "LOW" ? { bg: "#f3f4f6", fg: "#6b7280" } : { bg: "#fef3e6", fg: "#c2410c" };
  if (!priority) return <span className="text-[#d1d5db]">—</span>;
  return <span className="rounded-full px-2 py-0.5 text-[10.5px] font-semibold" style={{ background: style.bg, color: style.fg }}>{p.charAt(0) + p.slice(1).toLowerCase()}</span>;
}

// Sentence-case an intent code for the "what to do" fallback when there's no free-text description.
function prettyIntent(raw: string): string {
  if (!raw) return "Follow up";
  const s = raw.replace(/_/g, " ").trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
