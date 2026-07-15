"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import {
  Card,
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
import { fetchCustomers, type Customer } from "@/components/reports/liveData";
import { track } from "@/lib/analytics";

type Bucket = "all" | "active" | "sold" | "service" | "lost";
const BUCKETS: { v: Bucket; l: string }[] = [
  { v: "all", l: "All" },
  { v: "active", l: "Active" },
  { v: "sold", l: "Sold" },
  { v: "service", l: "Service" },
  { v: "lost", l: "Lost / bad" },
];

export default function CustomersPage() {
  return (
    <Suspense fallback={null}>
      <CustomersView />
    </Suspense>
  );
}

function CustomersView() {
  const { teamId, account, spyneToken } = useScenario();
  const { bucket: dateBucket, custom } = useDateRange();
  const { dept } = useDept();
  const navQuery = reportNavQuery(teamId, dateBucket, custom, dept);

  const [bucket, setBucket] = useState<Bucket>("all");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Customer[] | null>(null);

  useEffect(() => { track("report_viewed", { tab: "customers", team_id: teamId }); }, [teamId]);
  useEffect(() => {
    if (!teamId) { setRows([]); return; }
    let on = true;
    setRows(null);
    fetchCustomers(teamId, { bucket, limit: 200, spyneToken }).then((r) => { if (on) setRows(r); });
    return () => { on = false; };
  }, [teamId, bucket, spyneToken]);

  // Client-side name search over the fetched book (server already scoped by bucket).
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (rows ?? []).filter((c) => !needle || c.customer.toLowerCase().includes(needle));
  }, [rows, q]);
  const soldCount = useMemo(() => (rows ?? []).filter((c) => c.sold).length, [rows]);

  return (
    <div className="flex min-h-screen bg-[#fafafa]">
      <div className="flex flex-1 flex-col">
        <ReportTopBar
          title="Customers"
          subtitle="Your lead book — who the AI is working, their CRM status, and who's sold."
          active="customers"
          teamId={teamId}
          query={navQuery}
        />

        <main className="mx-auto w-full max-w-[1320px] flex-1 px-4 sm:px-6 lg:px-10 pt-7 pb-36 flex flex-col gap-3.5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SectionLabel hint={rows ? `${fmtInt(filtered.length)} shown · ${fmtInt(soldCount)} sold` : "loading…"}>
              The lead book
            </SectionLabel>
            <div className="no-print flex flex-wrap items-center gap-2">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search name…"
                className="rounded-lg border border-[#e5e7eb] bg-white px-3 py-1.5 text-[12px] text-[#111] focus:border-[#813fed] focus:outline-none"
              />
              <div className="inline-flex flex-wrap rounded-lg border border-[#e5e7eb] bg-white p-0.5">
                {BUCKETS.map((b) => (
                  <button key={b.v} onClick={() => { setBucket(b.v); track("customers_filtered", { team_id: teamId, bucket: b.v }); }}
                    className={`rounded-md px-2.5 py-1 text-[11.5px] font-semibold transition-colors ${bucket === b.v ? "bg-[#f3eaff] text-[#813fed]" : "text-[#6b7280] hover:text-[#111]"}`}>
                    {b.l}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <Card title="" pad={false}>
            {rows === null ? (
              <div className="px-6 py-6"><div className="h-[220px] animate-pulse rounded-xl bg-[#eef0f3]" /></div>
            ) : filtered.length === 0 ? (
              <div className="px-6 py-6">
                <EmptyState icon="🧑‍🤝‍🧑" title="No customers in this view" body={`${account.name || "This rooftop"} has no ${bucket === "all" ? "" : bucket} leads matching your search.`} />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] border-collapse text-[12.5px]">
                  <thead>
                    <tr>
                      <Th>Customer</Th>
                      <Th>Phone</Th>
                      <Th>Source</Th>
                      <Th>Status</Th>
                      <Th>Last activity</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((c, i) => (
                      <tr key={c.leadId ?? `${c.customer}-${i}`} className="border-t border-[#f0f0f0]"
                        onClick={() => track("customer_row_opened", { team_id: teamId, bucket })}>
                        <Td><span className="font-semibold text-[#111]">{c.customer}</span></Td>
                        <Td>{c.phone ? <a href={`tel:${c.phone}`} className="tabular-nums text-[#374151] underline decoration-dotted underline-offset-2" onClick={(e) => e.stopPropagation()}>{c.phone}</a> : <span className="text-[#d1d5db]">—</span>}</Td>
                        <Td><span className="text-[#6b7280]">{c.source || "—"}</span></Td>
                        <Td><StatusPill bucket={c.statusBucket} status={c.status} /></Td>
                        <Td><span className="whitespace-nowrap text-[#6b7280]">{c.lastActivity ? fmtWhenShort(c.lastActivity) : "—"}</span></Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <p className="text-[11px] text-[#9ca3af]">Status and source come from your CRM. &ldquo;Sold&rdquo; = leads now marked SOLD_DELIVERED.</p>
        </main>
      </div>
    </div>
  );
}

const STATUS_STYLE: Record<string, { label: string; color: string }> = {
  sold: { label: "Sold", color: "#059669" },
  active: { label: "Active", color: "#2563eb" },
  service: { label: "Service", color: "#6d28d9" },
  lost: { label: "Lost / bad", color: "#9ca3af" },
  other: { label: "Other", color: "#6b7280" },
};
function StatusPill({ bucket, status }: { bucket: Customer["statusBucket"]; status: string }) {
  const st = STATUS_STYLE[bucket] ?? STATUS_STYLE.other;
  return (
    <span className="rounded-full px-2 py-0.5 text-[10.5px] font-semibold" style={{ background: `${st.color}14`, color: st.color }} title={status || undefined}>
      {st.label}
    </span>
  );
}
