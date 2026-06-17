"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AGENT_OPTIONS,
  AUDIENCE_SEGMENTS,
  LaunchedCampaign,
  SUB_TYPES,
  useNewCampaign,
} from "@/context/NewCampaignContext";
import { Bucket, BUCKET_LABELS, BucketToggle, CalibratingBanner, GlanceStat, ReportTopBar, Td, Th } from "@/components/reports/kit";
import { useScenario } from "@/components/reports/scenario";
import { track } from "@/lib/analytics";

/* Per-campaign run history. Phase 1 reads the in-memory NewCampaignContext;
 * Phase 2 swaps to GET /campaign/list (see IMPL_Reporting). */
function deriveMetrics(campaigns: LaunchedCampaign[]) {
  return campaigns.map((c) => {
    const audienceFromSegments = c.selectedSegments.reduce(
      (sum, id) => sum + (AUDIENCE_SEGMENTS.find((s) => s.id === id)?.count ?? 0),
      0,
    );
    const audience = c.contactsCount > 0 ? c.contactsCount : audienceFromSegments || 200;

    let h = 0;
    for (let i = 0; i < c.id.length; i++) h = (h * 31 + c.id.charCodeAt(i)) >>> 0;
    const rand = () => {
      h = (h * 1664525 + 1013904223) >>> 0;
      return (h % 1000) / 1000;
    };

    const dispatched = Math.round(audience * (0.55 + rand() * 0.4));
    const connected = Math.round(dispatched * (0.22 + rand() * 0.18));
    const converted = Math.round(connected * (0.18 + rand() * 0.2));
    const optedOut = Math.round(dispatched * (0.02 + rand() * 0.04));
    const errored = Math.round(dispatched * (0.01 + rand() * 0.02));

    return {
      campaign: c,
      audience,
      dispatched,
      connected,
      converted,
      optedOut,
      errored,
      connectRate: dispatched > 0 ? connected / dispatched : 0,
      convertRate: connected > 0 ? converted / connected : 0,
    };
  });
}

export default function CampaignsReportPage() {
  const router = useRouter();
  const { launchedCampaigns } = useNewCampaign();
  const { scenario, view, teamId } = useScenario();
  const [bucket, setBucket] = useState<Bucket>("yesterday");
  const [filterSubType, setFilterSubType] = useState<string>("all");
  const periodLabel = scenario === "repeat" ? BUCKET_LABELS[bucket] : view.liveLabel;
  // Engagement: fires once per opened campaigns report (the rooftop is resolved by mount).
  useEffect(() => { track("report_viewed", { tab: "campaigns", team_id: teamId }); }, [teamId]);

  const rows = useMemo(() => deriveMetrics(launchedCampaigns), [launchedCampaigns]);
  const filteredRows = useMemo(
    () => (filterSubType === "all" ? rows : rows.filter((r) => r.campaign.subType === filterSubType)),
    [rows, filterSubType],
  );

  const totals = useMemo(
    () =>
      filteredRows.reduce(
        (acc, r) => ({
          dispatched: acc.dispatched + r.dispatched,
          connected: acc.connected + r.connected,
          converted: acc.converted + r.converted,
          optedOut: acc.optedOut + r.optedOut,
          errored: acc.errored + r.errored,
        }),
        { dispatched: 0, connected: 0, converted: 0, optedOut: 0, errored: 0 },
      ),
    [filteredRows],
  );

  const connectRate = totals.dispatched > 0 ? totals.connected / totals.dispatched : 0;
  const convertRate = totals.connected > 0 ? totals.converted / totals.connected : 0;

  return (
    <div className="flex min-h-screen bg-[#fafafa]">
      <div className="flex flex-1 flex-col">

        <ReportTopBar
          title="Campaigns"
          subtitle="Per-campaign run history — what ran, what worked, who picked up."
          active="campaigns"
          right={
            scenario === "repeat" ? (
              <BucketToggle bucket={bucket} onChange={(b) => { setBucket(b); track("date_range_changed", { tab: "campaigns", range: b, team_id: teamId }); }} />
            ) : (
              <span className="rounded-lg bg-[#f3eaff] px-3 py-1.5 text-[12px] font-semibold text-[#813fed]">{view.liveLabel}</span>
            )
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
              body="Connect and convert rates here are based on a small sample and will firm up over the next few weeks."
            />
          )}
          {/* at a glance */}
          <section className="rounded-2xl border border-[#e5e7eb] bg-white shadow-sm overflow-hidden">
            <div className="border-b border-[#f0f0f0] px-6 py-4 bg-gradient-to-r from-[#faf8ff] to-white">
              <p className="text-[10.5px] font-bold uppercase tracking-wider text-[#813fed]">At a glance</p>
              <p className="text-[15px] font-bold text-[#111] mt-0.5">{periodLabel}</p>
            </div>
            <div className="grid grid-cols-2 divide-x divide-y divide-[#f3f4f6] sm:grid-cols-3 lg:grid-cols-5 lg:divide-y-0">
              <GlanceStat label="Calls dispatched" value={totals.dispatched.toLocaleString()} delta={totals.dispatched > 0 ? `+${Math.round(totals.dispatched * 0.08)}` : undefined} />
              <GlanceStat label="Connect rate" value={`${Math.round(connectRate * 100)}%`} delta={connectRate > 0 ? "+1.2%" : undefined} />
              <GlanceStat label="Conversions" value={totals.converted.toLocaleString()} sub={`${Math.round(convertRate * 100)}% of connects`} accent="#10b981" />
              <GlanceStat label="Opt-outs" value={totals.optedOut.toLocaleString()} accent="#6b7280" />
              <GlanceStat label="Errored / failed" value={totals.errored.toLocaleString()} accent={totals.errored > 0 ? "#dc2626" : "#6b7280"} />
            </div>
            {launchedCampaigns.length === 0 && (
              <div className="border-t border-[#f0f0f0] px-6 py-4 bg-[#fffbeb] flex items-center gap-3">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#92400e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <p className="text-[12px] text-[#92400e]">
                  No campaigns launched in this session yet. Numbers above populate as soon as you launch one — see the
                  Overview tab for fleet-level reporting.
                </p>
              </div>
            )}
          </section>

          {/* campaigns table */}
          <section className="rounded-2xl border border-[#e5e7eb] bg-white shadow-sm overflow-hidden">
            <div className="flex items-center justify-between border-b border-[#f0f0f0] px-6 py-4">
              <div className="flex items-center gap-3">
                <p className="text-[14px] font-bold text-[#111]">Campaigns</p>
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

            {filteredRows.length === 0 ? (
              <div className="px-6 py-16 text-center flex flex-col items-center gap-2">
                <p className="text-[14px] font-semibold text-[#111]">No campaigns yet</p>
                <p className="text-[12.5px] text-[#6b7280] max-w-[340px]">
                  Campaigns launched in the main app will show up here with live progress and outcome counts.
                </p>
              </div>
            ) : (
              <table className="w-full">
                <thead className="bg-[#fafafa]">
                  <tr>
                    <Th>Campaign</Th>
                    <Th>Use case</Th>
                    <Th>Status</Th>
                    <Th align="right">Dispatched</Th>
                    <Th align="right">Connect rate</Th>
                    <Th align="right">Conversions</Th>
                    <Th align="right">Errored</Th>
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
                        <Td align="right"><span className="text-[12.5px] font-semibold text-[#111] tabular-nums">{r.dispatched.toLocaleString()}</span></Td>
                        <Td align="right"><span className="text-[12.5px] font-semibold text-[#111] tabular-nums">{Math.round(r.connectRate * 100)}%</span></Td>
                        <Td align="right">
                          <div className="flex items-baseline justify-end gap-1.5">
                            <span className="text-[12.5px] font-semibold text-[#10b981] tabular-nums">{r.converted.toLocaleString()}</span>
                            <span className="text-[10px] text-[#9ca3af] tabular-nums">({Math.round(r.convertRate * 100)}%)</span>
                          </div>
                        </Td>
                        <Td align="right">
                          <span className={`text-[12.5px] font-semibold tabular-nums ${r.errored > 0 ? "text-[#dc2626]" : "text-[#9ca3af]"}`}>
                            {r.errored.toLocaleString()}
                          </span>
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
            )}
          </section>
        </main>
      </div>
    </div>
  );
}
