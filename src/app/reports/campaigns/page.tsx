"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AGENT_OPTIONS,
  AUDIENCE_SEGMENTS,
  LaunchedCampaign,
  SUB_TYPES,
  useNewCampaign,
} from "@/context/NewCampaignContext";
import { ActiveCampaign, CalibratingBanner, EmptyState, fmtInt, ReportTopBar, Td, Th } from "@/components/reports/kit";
import { useScenario } from "@/components/reports/scenario";
import { fetchAgents, agentsForAccount, peekAgents, type FetchResult } from "@/components/reports/liveData";
import { useDateRange, useDept, reportNavQuery } from "@/components/reports/dateRange";
import { track } from "@/lib/analytics";

/* Per-campaign audience size — the ONLY genuinely-real field we have client-side for a campaign
 * launched THIS session (from the launch form's contactsCount, else the selected audience segments). */
function deriveAudience(c: LaunchedCampaign): number {
  const audienceFromSegments = c.selectedSegments.reduce(
    (sum, id) => sum + (AUDIENCE_SEGMENTS.find((s) => s.id === id)?.count ?? 0),
    0,
  );
  return c.contactsCount > 0 ? c.contactsCount : audienceFromSegments;
}

// useDateRange() reads the selected window from the URL — needs a Suspense boundary above useSearchParams.
export default function CampaignsReportPage() {
  return (
    <Suspense fallback={null}>
      <CampaignsReportView />
    </Suspense>
  );
}

function CampaignsReportView() {
  const router = useRouter();
  const { launchedCampaigns } = useNewCampaign();
  const { scenario, view, teamId, account, spyneToken } = useScenario();
  // The window rides in the URL only so tab navigation keeps it — campaign run metrics themselves are a
  // CUMULATIVE (~120d) snapshot from report_campaigns and are NOT windowed by the date filter.
  const { bucket, custom } = useDateRange();
  const { dept } = useDept(); // top-level scope (shared header, URL-persisted)
  const navQuery = reportNavQuery(teamId, bucket, custom, dept);
  const [filterSubType, setFilterSubType] = useState<string>("all");
  // Engagement: fires once per opened campaigns report (the rooftop is resolved by mount).
  useEffect(() => { track("report_viewed", { tab: "campaigns", team_id: teamId }); }, [teamId]);

  // Live rooftop feed — the campaigns list rides on the same /api/reports payload the other tabs use
  // (report_campaigns attached per outbound agent). Window doesn't matter for this table; use the
  // default bucket so the cache is shared with the Overview.
  const [feed, setFeed] = useState<FetchResult | null>(() => peekAgents({ teamId, bucket: "last30", spyneToken }));
  useEffect(() => {
    if (!teamId) return;
    let on = true;
    const cached = peekAgents({ teamId, bucket: "last30", spyneToken });
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFeed(cached);
    fetchAgents({ teamId, bucket: "last30", spyneToken })
      .then((res) => { if (on) setFeed(res); })
      .catch(() => { if (on && !cached) setFeed(null); });
    return () => { on = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, spyneToken]);

  // Union of every outbound agent's campaigns (each campaign belongs to one agent_type → no dupes),
  // ranked by appointments — the canonical "what's working" order.
  const liveCampaigns = useMemo<(ActiveCampaign & { dept: string })[]>(() => {
    const agents = agentsForAccount(feed?.agents ?? [], account);
    return agents
      .filter((a) => a.dir === "Outbound" && (dept === "all" || a.dept.toLowerCase() === dept))
      .flatMap((a) => (a.report.activeCampaigns ?? []).map((c) => ({ ...c, dept: a.dept })))
      .sort((a, b) => b.appts - a.appts || b.warmLeads - a.warmLeads);
  }, [feed, account, dept]);
  const totals = useMemo(() => liveCampaigns.reduce(
    (t, c) => ({ enrolled: t.enrolled + c.enrolled, appts: t.appts + c.appts, warm: t.warm + c.warmLeads }),
    { enrolled: 0, appts: 0, warm: 0 },
  ), [liveCampaigns]);

  // Session-local launches (the launch form) — metadata only, no fabricated run metrics.
  const rows = useMemo(
    () => launchedCampaigns.map((c) => ({ campaign: c, audience: deriveAudience(c) })),
    [launchedCampaigns],
  );
  const filteredRows = useMemo(
    () => (filterSubType === "all" ? rows : rows.filter((r) => r.campaign.subType === filterSubType)),
    [rows, filterSubType],
  );

  return (
    <div className="flex min-h-screen bg-[#fafafa]">
      <div className="flex flex-1 flex-col">

        <ReportTopBar
          title="Campaigns"
          subtitle="Every outbound campaign — enrolled leads, appointments, warm leads and opt-outs."
          active="campaigns"
          teamId={teamId}
          query={navQuery}
          right={
            <span className="no-print rounded-lg bg-[#f3f4f6] px-3 py-1.5 text-[11.5px] font-semibold text-[#6b7280]" title="Campaign outcomes accumulate over a campaign's life — they aren't sliced by the report date filter.">
              Cumulative · last ~120 days
            </span>
          }
        />

        <main className="mx-auto w-full max-w-[1400px] flex-1 px-10 pt-6 pb-36 flex flex-col gap-6">
          {!view.agentLive && (
            <CalibratingBanner
              title="No campaigns yet — your agents aren’t live."
              body="Finish onboarding and go live; every campaign you launch then shows up here with live progress and outcomes."
            />
          )}
          {scenario === "recently_live" && (
            <CalibratingBanner
              title="Early days — only your first campaigns have run."
              body="Appointment and warm-lead rates here are based on a small sample and will firm up over the next few weeks."
            />
          )}

          {/* ── live per-campaign performance (report_campaigns via /api/reports) ── */}
          <section className="print-card rounded-2xl border border-[#e5e7eb] bg-white shadow-sm overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#f0f0f0] px-6 py-4 bg-gradient-to-r from-[#faf8ff] to-white">
              <div>
                <p className="text-[14px] font-bold text-[#111]">Campaign performance</p>
                <p className="text-[11.5px] text-[#6b7280] mt-0.5">Ranked by appointments booked · campaigns with ≥20 enrolled leads</p>
              </div>
              {liveCampaigns.length > 0 && (
                <div className="flex gap-6">
                  {([
                    ["Campaigns", fmtInt(liveCampaigns.length)],
                    ["Enrolled", fmtInt(totals.enrolled)],
                    ["Appointments", fmtInt(totals.appts)],
                    ["Warm leads", fmtInt(totals.warm)],
                  ] as const).map(([k, v]) => (
                    <div key={k} className="text-right">
                      <p className="text-[17px] font-extrabold tabular-nums leading-none text-[#111]">{v}</p>
                      <p className="mt-0.5 text-[9.5px] font-bold uppercase tracking-wide text-[#9ca3af]">{k}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {liveCampaigns.length === 0 ? (
              <div className="px-6 py-6">
                <EmptyState icon="📣" title="No campaigns have run yet" body="Once this rooftop runs outbound campaigns, each one shows up here with enrolled leads, appointments, warm leads and opt-outs." />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px]">
                  <thead className="bg-[#fafafa]">
                    <tr>
                      <Th>Campaign</Th>
                      <Th align="right">Enrolled</Th>
                      <Th align="right">Appointments</Th>
                      <Th align="right">Appt rate</Th>
                      <Th align="right">Warm</Th>
                      <Th align="right">Opt-outs</Th>
                      <Th align="right">No reach</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {liveCampaigns.map((c, i) => (
                      <tr key={`${c.name}-${i}`} className="border-t border-[#f0f0f0] hover:bg-[#faf8ff] transition-colors">
                        <Td>
                          <p className="text-[12.5px] font-semibold text-[#111]">{c.name}</p>
                          <p className="text-[10.5px] text-[#9ca3af]">{c.useCase || "—"} · {c.dept}</p>
                        </Td>
                        <Td align="right"><span className="text-[12.5px] tabular-nums text-[#111]">{fmtInt(c.enrolled)}</span></Td>
                        <Td align="right"><span className="text-[12.5px] font-bold tabular-nums text-[#10b981]">{fmtInt(c.appts)}</span></Td>
                        <Td align="right"><span className="text-[12.5px] tabular-nums text-[#374151]">{c.apptRate}%</span></Td>
                        <Td align="right"><span className="text-[12.5px] font-semibold tabular-nums text-[#c2410c]">{fmtInt(c.warmLeads)}</span></Td>
                        <Td align="right"><span className="text-[12.5px] tabular-nums text-[#6b7280]">{fmtInt(c.optOuts)}</span></Td>
                        <Td align="right"><span className="text-[12.5px] tabular-nums text-[#6b7280]">{fmtInt(c.noReach)}</span></Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ── campaigns launched from this console session (launch metadata; run outcomes above) ── */}
          {rows.length > 0 && (
            <section className="rounded-2xl border border-[#e5e7eb] bg-white shadow-sm overflow-hidden">
              <div className="flex items-center justify-between border-b border-[#f0f0f0] px-6 py-4">
                <div className="flex items-center gap-3">
                  <p className="text-[14px] font-bold text-[#111]">Launched from this console</p>
                  <span className="text-[11px] text-[#9ca3af]">{filteredRows.length} of {rows.length}</span>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-[11px] text-[#6b7280]">Sub-type</label>
                  <select
                    value={filterSubType}
                    onChange={(e) => { setFilterSubType(e.target.value); track("campaigns_filtered", { team_id: teamId, subtype: e.target.value }); }}
                    className="rounded-lg border border-[#e5e7eb] bg-white px-2.5 py-1.5 text-[12px] text-[#111] focus:border-[#813fed] focus:outline-none"
                  >
                    <option value="all">All</option>
                    {[...SUB_TYPES.sales, ...SUB_TYPES.service].map((s) => (
                      <option key={s.value} value={s.value}>{s.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <table className="w-full">
                <thead className="bg-[#fafafa]">
                  <tr>
                    <Th>Campaign</Th>
                    <Th>Use case</Th>
                    <Th>Status</Th>
                    <Th align="right">Audience</Th>
                    <Th>Started</Th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((r) => {
                    const agent = AGENT_OPTIONS.find((ag) => ag.id === r.campaign.agentId);
                    const subTypeLabel =
                      r.campaign.category && r.campaign.subType
                        ? SUB_TYPES[r.campaign.category]?.find((s) => s.value === r.campaign.subType)?.label
                        : r.campaign.subType;
                    return (
                      <tr
                        key={r.campaign.id}
                        onClick={() => { track("campaign_opened", { team_id: teamId, campaign_id: r.campaign.id }); router.push(`/campaign/${r.campaign.id}`); }}
                        className="border-t border-[#f0f0f0] hover:bg-[#faf8ff] cursor-pointer transition-colors"
                      >
                        <Td>
                          <div className="flex flex-col">
                            <span className="text-[13px] font-semibold text-[#111] leading-tight">{r.campaign.name || "Untitled campaign"}</span>
                            <span className="text-[11px] text-[#9ca3af]">Agent: {agent?.name ?? "—"}</span>
                          </div>
                        </Td>
                        <Td><span className="text-[12px] text-[#374151]">{subTypeLabel || "—"}</span></Td>
                        <Td>
                          <span className="inline-flex items-center gap-1.5 rounded-full bg-[#dcfce7] px-2 py-0.5 text-[10.5px] font-semibold text-[#065f46]">
                            <span className="h-1.5 w-1.5 rounded-full bg-[#10b981] animate-pulse" />
                            {r.campaign.status}
                          </span>
                        </Td>
                        <Td align="right">
                          <span className="text-[12.5px] font-semibold text-[#111] tabular-nums">{r.audience > 0 ? fmtInt(r.audience) : "—"}</span>
                        </Td>
                        <Td>
                          <span className="text-[12px] text-[#6b7280]">
                            {new Date(r.campaign.launchedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
