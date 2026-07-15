"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
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
import { useDateRange, useDept, reportNavQuery } from "@/components/reports/dateRange";
import {
  fetchActionItems,
  fetchActionItemStats,
  rangeFor,
  addDay,
  type ActionItem,
  type ActionItemStats,
  type ActionItemCloser,
} from "@/components/reports/liveData";
import { track } from "@/lib/analytics";

type Scope = "open" | "overdue";

export default function ActionItemsPage() {
  return (
    <Suspense fallback={null}>
      <ActionItemsView />
    </Suspense>
  );
}

function ActionItemsView() {
  const { teamId, account, spyneToken } = useScenario();
  const { bucket, custom, setPreset, setCustom } = useDateRange();
  const { dept } = useDept(); // top-level scope (shared header, URL-persisted)
  const navQuery = reportNavQuery(teamId, bucket, custom, dept);
  const periodLabel = custom ? `${custom.start} – ${custom.end}` : BUCKET_LABELS[bucket];
  const win = useMemo(() => (custom ? { start: custom.start, end: addDay(custom.end) } : rangeFor(bucket)), [bucket, custom]);
  // shared dept "all" → the action-items API's serviceType "both".
  const service = dept === "all" ? "both" : dept;

  const [scope, setScope] = useState<Scope>("open");
  const [stats, setStats] = useState<{ stats: ActionItemStats; closers: ActionItemCloser[] } | null>(null);
  const [items, setItems] = useState<ActionItem[] | null>(null);

  useEffect(() => { track("report_viewed", { tab: "actions", team_id: teamId }); }, [teamId]);

  // Scoreboard (created/closed for the window + open/overdue/due-today now + who closed most).
  useEffect(() => {
    if (!teamId) { setStats(null); return; }
    let on = true;
    fetchActionItemStats(teamId, { start: win.start, end: win.end, service, spyneToken }).then((r) => { if (on) setStats(r); });
    return () => { on = false; };
  }, [teamId, win.start, win.end, service, spyneToken]);

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
          {/* Scoreboard */}
          <div className="flex flex-col gap-3.5">
            <SectionLabel hint={periodLabel}>The scoreboard</SectionLabel>
            <Card title="Follow-up tasks the AI logged" sub="Created & closed for the selected window · open, overdue and due-today are live counts">
              {stats ? (
                <ActionItemsScoreboard stats={stats.stats} closers={stats.closers} periodLabel={periodLabel} />
              ) : (
                <div className="h-[120px] animate-pulse rounded-xl bg-[#eef0f3]" />
              )}
            </Card>
          </div>

          {/* Working list */}
          <div className="flex flex-col gap-3.5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <SectionLabel hint={items ? `${items.length} shown` : "loading…"}>
                {scope === "overdue" ? "Overdue — needs attention" : "Open queue"}
              </SectionLabel>
              <div className="no-print flex items-center gap-2">
                <Segment value={scope} onChange={(v) => { setScope(v as Scope); track("action_item_filtered", { team_id: teamId, dept, scope: v }); }}
                  options={[{ v: "open", l: "Open" }, { v: "overdue", l: "Overdue" }]} />
              </div>
            </div>
            <Card title="" pad={false}>
              {items === null ? (
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
              Action items are created and auto-resolved by your Vini AI. &ldquo;Closed most&rdquo; shows the AI plus any team members your CRM assigns tasks to.
            </p>
          </div>
        </main>
      </div>
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
