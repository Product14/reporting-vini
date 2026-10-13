"use client";

/* The old Service report's sections below the funnel, looking exactly as they do on Reports > Agent
 * performance today (markup and styles copied from src/app/reports/agents-next/page.tsx), but every number
 * read from the Service Metrics API through reportsModel.ts instead of the old feed. The old page is
 * untouched.
 *
 * What maps where (Om's v2): calls / SMS / opt-outs / connect rate ← /contact (that direction); callers,
 * wanted service, staff time saved ← /contact's split fields; during / after hours, transfers, booked after
 * hours, time of day ← /calls-report; rates ← the funnel above; Waiting on your BDC, due today ← /action-item;
 * Asked for a callback, Hot & warm leads ← /follow-up; Appointments ← the agent's visits booked; Upcoming ←
 * /appointment's upcoming list; 7-day trend ← /appointment grain=day per agent. Business / after hours is
 * inbound only (not shown for outbound). Not in v2, so not shown: highlights & missed. */

import { Card, EmptyState, MeetingsList, SectionLabel, TrendBars } from "@/components/reports/kit";
import { fmtInt } from "@/components/reports/data";
import { fmtWhenShort, WarmLeadChips } from "@/components/reports/kitV3";
import { MoreReports } from "@/components/reports/library";
import type { AgentReport, AgentSections, ServiceReportsModel } from "@/lib/serviceOm/reportsModel";

/* ── inside the funnel card, under the bars: activity row + call breakdown ── */
function ActivityStat({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: string }) {
  return (
    <div className="px-6 py-5">
      <p className="text-[10px] font-bold uppercase tracking-wider text-[#9ca3af]">{label}</p>
      <p className="mt-1.5 text-[27px] font-extrabold tabular-nums leading-none" style={{ color: accent ?? "#111" }}>{value}</p>
      {hint && <p className="mt-1.5 text-[10.5px] text-[#6b7280]">{hint}</p>}
    </div>
  );
}

export function ActivityAndBreakdown({ s, inbound }: { s: AgentSections; inbound: boolean }) {
  const during = s.breakdown.during ?? 0;
  const after = s.breakdown.after ?? 0;
  const tot = during + after;
  const dPct = tot ? Math.round((during / tot) * 100) : 0;
  return (
    <>
      <div className={`grid grid-cols-2 divide-x divide-y divide-[#f3f4f6] border-t border-[#f0f0f0] bg-[#fcfcfd] sm:grid-cols-4 sm:divide-y-0 ${s.activity.length >= 5 ? "lg:grid-cols-5" : ""}`}>
        {s.activity.map((t) => <ActivityStat key={t.label} label={t.label} value={t.value} hint={t.hint} accent={t.accent} />)}
      </div>
      <div className="border-t border-[#f0f0f0] px-6 py-5">
        <p className="mb-4 text-[11px] font-bold uppercase tracking-wider text-[#6b7280]">Call breakdown</p>
        {!s.breakdown.hoursSplit ? null : s.breakdown.during === null && s.breakdown.after === null ? (
          <p className="mb-5 text-[11.5px] text-[#9ca3af]">During / after hours not available: the Service Metrics API did not answer.</p>
        ) : (
        <div className="mb-5">
          <div className="flex h-2 overflow-hidden rounded-full bg-[#f0f0f0]" role="img" aria-label={`${during} during hours, ${after} after hours`}>
            <div style={{ width: `${dPct}%`, background: "#813fed" }} />
            <div style={{ width: `${100 - dPct}%`, background: "#d8ccf7" }} />
          </div>
          <div className="mt-2.5 flex flex-wrap gap-x-6 gap-y-1 text-[11.5px] text-[#6b7280]">
            <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: "#813fed" }} /><b className="tabular-nums text-[#111]">{s.breakdown.during === null ? "—" : fmtInt(during)}</b> during hours</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: "#d8ccf7" }} /><b className="tabular-nums text-[#111]">{s.breakdown.after === null ? "—" : fmtInt(after)}</b> after hours</span>
          </div>
        </div>
        )}
        <div className={`grid grid-cols-2 gap-2.5 sm:grid-cols-3 ${inbound ? "lg:grid-cols-5" : "lg:grid-cols-3"}`}>
          {s.breakdown.tiles.map((b) => (
            <div key={b.label} className="rounded-xl border border-[#f0f0f0] bg-[#fafafa] px-3.5 py-3">
              <div className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 flex-none rounded-full" style={{ background: b.accent }} />
                <span className="text-[23px] font-extrabold tabular-nums leading-none text-[#111]">{b.value === null ? "—" : fmtInt(b.value)}</span>
              </div>
              <span className="mt-1.5 block text-[11px] leading-tight text-[#6b7280]">{b.label}</span>
              {b.hint && <span className="mt-0.5 block text-[10px] leading-tight text-[#9ca3af]">{b.hint}</span>}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/* ── below the appointments card ── */
function QCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[#f0f0f0] px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-[#9ca3af]">{label}</p>
      <p className="mt-1 text-[21px] font-bold tabular-nums text-[#111]">{value}</p>
    </div>
  );
}

export function LowerSections({
  agent,
  model,
  periodLabel,
  loading,
  onViewLeads,
  onViewAllActions,
  onOpenLibrary,
}: {
  agent: AgentReport;
  model: ServiceReportsModel;
  periodLabel: string;
  loading: boolean;
  onViewLeads: () => void;
  onViewAllActions: () => void;
  onOpenLibrary: (reportId?: string) => void;
}) {
  const inbound = agent.direction === "inbound";
  const s = agent.sections;
  const total = agent.period.work.visitsBooked;
  const ai = model.actionItems;
  const counts: { label: string; value: number | null; accent: string }[] = [
    { label: "Open", value: ai.openNow, accent: "#2563eb" },
    { label: "Overdue", value: ai.pastSla, accent: "#dc2626" },
    { label: "Due today", value: ai.dueToday, accent: "#ea760c" },
  ];
  return (
    <>
      <SectionLabel>{inbound ? "Inbound operations" : "Outbound campaigns"}</SectionLabel>

      {/* Appointments: total booked (the agent's visits booked, same as above) + what's upcoming */}
      <Card title="Appointments" sub={`${periodLabel} · total booked and what's upcoming`} pad={false}>
        <div className="flex flex-wrap items-end gap-x-10 gap-y-3 border-b border-[#f0f0f0] px-6 py-5">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-[#9ca3af]">{s.totalLabel}</p>
            {!loading && total ? (
              <button onClick={onViewLeads} className="group/appt mt-1 block text-left" title="See the appointments behind this number">
                <span className="text-[34px] font-extrabold tabular-nums leading-none text-[#10b981] underline decoration-dotted decoration-[#10b981]/40 underline-offset-4 group-hover/appt:decoration-[#10b981]">{fmtInt(total)}</span>
                <span className="ml-2 align-middle text-[11px] font-semibold text-[#10b981]">view leads ↗</span>
              </button>
            ) : (
              <p className="mt-1 text-[34px] font-extrabold tabular-nums leading-none text-[#10b981]">{total === null ? "—" : fmtInt(total)}</p>
            )}
          </div>
        </div>
        <p className="px-6 pt-4 pb-1 text-[10px] font-bold uppercase tracking-wider text-[#9ca3af]">Upcoming{model.upcomingCount !== null ? ` · ${fmtInt(model.upcomingCount)}` : ""}</p>
        {model.upcoming === null ? (
          <div className="p-6"><EmptyState icon="📅" title="Not available" body="The Service Metrics API did not answer." /></div>
        ) : model.upcoming.length === 0 ? (
          <div className="p-6"><EmptyState icon="📅" title="No upcoming appointments" body="No booked appointments for this rooftop yet — they'll appear here as the agent books them." /></div>
        ) : (
          <div className="max-h-[360px] overflow-y-auto"><MeetingsList meetings={model.upcoming} /></div>
        )}
      </Card>

      {/* Action items */}
      <Card title="Action items" sub="Open follow-up tasks the AI logged — work these next" pad={false}>
        <div className="flex flex-col">
          <div className="flex flex-wrap gap-2 border-b border-[#f0f0f0] px-6 py-3.5">
            {counts.map((c) => (
              <span key={c.label} className="inline-flex items-baseline gap-1.5 rounded-lg border border-[#f0f0f0] bg-[#fafafa] px-2.5 py-1" title={c.value === null ? "Not available from the Service Metrics API" : undefined}>
                <b className="text-[17px] font-extrabold tabular-nums leading-none" style={{ color: c.accent }}>{c.value === null ? "—" : fmtInt(c.value)}</b>
                <span className="text-[10.5px] font-semibold uppercase tracking-wide text-[#9ca3af]">{c.label}</span>
              </span>
            ))}
          </div>
          {ai.rows.length === 0 ? (
            <div className="p-6"><EmptyState icon="✅" title="No open action items" body="No follow-up tasks open for this rooftop right now — they'll appear here as the AI logs them." /></div>
          ) : (
            <div className="max-h-[320px] divide-y divide-[#f3f4f6] overflow-y-auto">
              {ai.rows.map((a) => (
                <div key={a.id} className="flex items-center justify-between gap-3 px-6 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-semibold text-[#111]">{a.customer || "—"}</p>
                    <p className="truncate text-[11px] text-[#6b7280]">{a.what}</p>
                  </div>
                  <div className="flex-none text-right">
                    <p className={`text-[10.5px] tabular-nums ${a.isLate ? "font-semibold text-[#dc2626]" : "text-[#9ca3af]"}`}>{a.due ? fmtWhenShort(a.due) : "—"}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="border-t border-[#f0f0f0] px-6 py-3">
            <button onClick={onViewAllActions} className="text-[11.5px] font-semibold text-[#813fed] hover:underline">View all action items →</button>
          </div>
        </div>
      </Card>

      {/* Hot & warm leads ← L6 Warm leads (outbound follow-up list) */}
      {!inbound && model.warmLeads.length > 0 && (
        <Card title="Hot & warm leads — work these now" sub={`Buying intent on record, no appointment yet${model.warmLeadsTotal !== null ? ` · ${fmtInt(model.warmLeadsTotal)} warm leads, callbacks first` : ""}`}>
          <WarmLeadChips items={model.warmLeads} maxHot={10} maxWarm={8} />
        </Card>
      )}

      <SectionLabel>Quality &amp; trend</SectionLabel>
      <Card title="Conversation quality" sub="From live calls — the metrics we can measure today">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {/* N7: a per-call number, so it is not the activity row's Answer rate (customers reached ÷ called). */}
          <QCell label="Connect rate (per call)" value={s.quality.answerRate} />
          <QCell label="Avg handle time" value={s.quality.handleTime} />
          {/* Om's opt-out count has no agent on it, so unless it's the agent's own it's labelled as the rooftop's. */}
          <QCell label={s.quality.optOutsScope === "rooftop" ? "Opt-outs (whole rooftop)" : "Opt-outs"} value={s.quality.optOuts === null ? "—" : fmtInt(s.quality.optOuts)} />
        </div>
      </Card>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="Time-of-day distribution" sub="When the activity happens (business hours)">
          {s.timeOfDay ? <TrendBars values={s.timeOfDay.values} labels={s.timeOfDay.labels} height={88} /> : <p className="py-6 text-center text-[12px] text-[#9ca3af]">Not available: no calls in this window.</p>}
        </Card>
        <Card
          title="7-day trend"
          sub={!s.trend7 ? "Visits booked per day" : agent.period.work.assistedCounted && !s.trend7.assistedIncluded ? `Booked by Spyne per day (per-day Spyne-assisted isn't split by agent yet) · ${fmtInt(s.trend7.total)} in the last 7 days` : `Visits booked per day · ${fmtInt(s.trend7.total)} in the last 7 days`}
        >
          {s.trend7 ? <TrendBars values={s.trend7.values} labels={s.trend7.labels} highlightLast height={88} /> : <p className="py-6 text-center text-[12px] text-[#9ca3af]">Not available{s.trend7Reason ? `: ${s.trend7Reason}` : "."}</p>}
        </Card>
      </div>

      <MoreReports agentId={inbound ? "service_ib" : "service_ob"} onOpenLibrary={onOpenLibrary} />
    </>
  );
}
