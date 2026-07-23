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
import { fmtWhenShort } from "@/components/reports/kitV3";
import { useScenario } from "@/components/reports/scenario";
import { useDateRange, useDept, reportNavQuery } from "@/components/reports/dateRange";
import { fetchConversations, addDay, type Conversation } from "@/components/reports/liveData";
import type { Bucket } from "@/components/reports/data";
import { track } from "@/lib/analytics";

type Channel = "call" | "sms";
type Dir = "both" | "inbound" | "outbound";

export default function RecentCallsPage() {
  return (
    <Suspense fallback={null}>
      <RecentCallsView />
    </Suspense>
  );
}

function RecentCallsView() {
  const { teamId, account, spyneToken, spyneEnv } = useScenario();
  const { bucket, custom, setPreset, setCustom } = useDateRange();
  const { dept } = useDept(); // top-level scope (shared header, URL-persisted)
  const navQuery = reportNavQuery(teamId, bucket, custom, dept);
  const periodLabel = custom ? `${custom.start} – ${custom.end}` : BUCKET_LABELS[bucket];
  // custom → explicit store-local [start,end); preset → pass the bucket so the SERVER resolves a
  // store-local window (RETCONVAI-4152). The old rangeFor(bucket) computed a UTC window with no upper
  // bound, so "Yesterday" bled today's latest calls in.
  const winOpts: { since?: string; end?: string; bucket?: Bucket } = custom
    ? { since: custom.start, end: addDay(custom.end) }
    : { bucket };

  const [channel, setChannel] = useState<Channel>("call");
  const [dir, setDir] = useState<Dir>("both");
  const [rows, setRows] = useState<Conversation[] | null>(null);

  useEffect(() => { track("report_viewed", { tab: "calls", team_id: teamId }); }, [teamId]);
  useEffect(() => {
    if (!teamId) { setRows([]); return; }
    let on = true;
    setRows(null);
    fetchConversations(teamId, { channel, ...winOpts, limit: 150, spyneToken, spyneEnv }).then((r) => { if (on) setRows(r); });
    return () => { on = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, channel, bucket, custom, spyneToken, spyneEnv]);

  const filtered = useMemo(
    () => (rows ?? []).filter((r) => (dir === "both" ? true : r.direction === dir) && (dept === "all" || r.dept === dept)),
    [rows, dir, dept],
  );

  return (
    <div className="flex min-h-screen bg-[#fafafa]">
      <div className="flex flex-1 flex-col">
        <ReportTopBar
          title="Recent calls"
          subtitle="Every AI conversation — who called, what they wanted, how it ended, and the AI's grade."
          active="calls"
          teamId={teamId}
          query={navQuery}
          right={
            teamId ? (
              <DateFilter
                bucket={bucket}
                custom={custom}
                onPreset={(b) => { setPreset(b); track("date_range_changed", { tab: "calls", range: b, team_id: teamId }); }}
                onCustom={(r) => { setCustom(r); track("date_range_changed", { tab: "calls", range: "custom", team_id: teamId }); }}
              />
            ) : undefined
          }
        />

        <main className="mx-auto w-full max-w-[1320px] flex-1 px-4 sm:px-6 lg:px-10 pt-7 pb-36 flex flex-col gap-3.5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SectionLabel hint={rows ? `${filtered.length} shown · ${periodLabel}` : "loading…"}>
              {channel === "sms" ? "Recent text threads" : "Recent calls"}
            </SectionLabel>
            <div className="no-print flex items-center gap-2">
              <Segment value={channel} onChange={(v) => setChannel(v as Channel)} options={[{ v: "call", l: "Calls" }, { v: "sms", l: "SMS" }]} />
              <Segment value={dir} onChange={(v) => setDir(v as Dir)} options={[{ v: "both", l: "All" }, { v: "inbound", l: "Inbound" }, { v: "outbound", l: "Outbound" }]} />
            </div>
          </div>

          <Card title="" pad={false}>
            {rows === null ? (
              <div className="px-6 py-6"><div className="h-[200px] animate-pulse rounded-xl bg-[#eef0f3]" /></div>
            ) : filtered.length === 0 ? (
              <div className="px-6 py-6">
                <EmptyState icon="📞" title="No conversations in this view" body={`${account.name || "This rooftop"} has no ${channel === "sms" ? "text threads" : "calls"} for ${periodLabel}. Widen the date range or switch the channel.`} />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] border-collapse text-[12.5px]">
                  <thead>
                    <tr>
                      <Th>Customer</Th>
                      <Th>Direction</Th>
                      <Th>What happened</Th>
                      <Th>Outcome</Th>
                      <Th align="right">Grade</Th>
                      <Th>When</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((c) => (
                      <tr key={c.id} className="border-t border-[#f0f0f0] align-top"
                        onClick={() => track("call_row_opened", { team_id: teamId, channel })}>
                        <Td>
                          <span className="font-semibold text-[#111]">{c.customer || "Unknown caller"}</span>
                          {c.phone && <a href={`tel:${c.phone}`} className="ml-2 text-[11px] tabular-nums text-[#6b7280] underline decoration-dotted underline-offset-2" onClick={(e) => e.stopPropagation()}>{c.phone}</a>}
                          <span className="ml-2 text-[10px] capitalize text-[#9ca3af]">{c.dept !== "other" ? c.dept : ""}</span>
                        </Td>
                        <Td>
                          <span className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold" style={{ color: c.direction === "inbound" ? "#2563eb" : "#c2410c" }}>
                            {c.direction === "inbound" ? "↙ Inbound" : "↗ Outbound"}
                          </span>
                        </Td>
                        <Td>
                          <p className="max-w-[360px] truncate text-[#374151]" title={cleanText(c.summary) || c.title}>{c.title || cleanText(c.summary) || (c.channel === "sms" ? `${c.msgs ?? 0} messages` : "—")}</p>
                        </Td>
                        <Td>
                          <div className="flex flex-wrap gap-1">
                            {c.appointmentScheduled && <Tag color="#059669">Appt</Tag>}
                            {c.queryResolved && <Tag color="#6d28d9">Resolved</Tag>}
                            {c.hasActionItem && <Tag color="#ea760c">Action item</Tag>}
                            {c.frustrated && <Tag color="#dc2626">Frustrated</Tag>}
                            {!c.appointmentScheduled && !c.queryResolved && !c.hasActionItem && !c.frustrated && <span className="text-[#d1d5db]">—</span>}
                          </div>
                        </Td>
                        <Td align="right">
                          {c.grade ? <span className="font-bold tabular-nums" style={{ color: gradeColor(c.grade) }}>{c.grade}{c.aiScore != null ? ` · ${c.aiScore}%` : ""}</span> : <span className="text-[#d1d5db]">—</span>}
                        </Td>
                        <Td><span className="whitespace-nowrap text-[#6b7280]">{fmtWhenShort(c.at)}</span></Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <p className="text-[11px] text-[#9ca3af]">Grades come from the AI-quality review of each conversation. Times shown in the rooftop&apos;s local zone as they synced.</p>
        </main>
      </div>
    </div>
  );
}

function Segment({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { v: string; l: string }[] }) {
  return (
    <div className="inline-flex rounded-lg border border-[#e5e7eb] bg-white p-0.5">
      {options.map((o) => (
        <button key={o.v} onClick={() => onChange(o.v)}
          className={`rounded-md px-2.5 py-1 text-[11.5px] font-semibold transition-colors ${value === o.v ? "bg-[#f3eaff] text-[#813fed]" : "text-[#6b7280] hover:text-[#111]"}`}>
          {o.l}
        </button>
      ))}
    </div>
  );
}

function Tag({ children, color }: { children: React.ReactNode; color: string }) {
  return <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ background: `${color}14`, color }}>{children}</span>;
}

function gradeColor(grade: string): string {
  const g = grade.toUpperCase().charAt(0);
  return g === "A" ? "#059669" : g === "B" ? "#2563eb" : g === "C" ? "#c2410c" : "#dc2626";
}

// report_summary sometimes arrives as a JSON-encoded array of sentences (["…","…"]). Show the first
// sentence rather than the raw bracketed string; plain strings pass through unchanged.
function cleanText(s: string): string {
  const t = (s || "").trim();
  if (!t.startsWith("[")) return t;
  try {
    const arr = JSON.parse(t);
    if (Array.isArray(arr) && arr.length) return String(arr[0]);
  } catch { /* not JSON — fall through */ }
  return t;
}
