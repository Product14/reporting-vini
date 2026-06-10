"use client";

import { useEffect, useState } from "react";

type DataResp = { cols: string[]; rows: Record<string, unknown>[] };

function browserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return v.toLocaleString();
  return String(v);
}

/* Pulls a Metabase question's real rows (via /api/metabase/data) and renders them in our own
 * styling — KPI tiles for a single summary row, a table for a breakdown. Schema-agnostic, so it
 * works whatever columns the question returns. */
export function MetabaseData({ question, params }: { question: number; params?: Record<string, string> }) {
  const [data, setData] = useState<DataResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const paramsKey = params ? JSON.stringify(params) : "";

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const merged = { ...(params ?? {}), TZ: params?.TZ || browserTz() };
    const qs = new URLSearchParams({ question: String(question), ...merged });
    fetch(`/api/metabase/data?${qs.toString()}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        return d as DataResp;
      })
      .then((d) => {
        if (alive) {
          setData(d);
          setError(null);
        }
      })
      .catch((e) => alive && setError(String(e?.message ?? e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question, paramsKey]);

  if (loading && !data && !error) {
    return (
      <div className="flex items-center justify-center py-16">
        <span className="flex items-center gap-2 text-[12px] text-[#9ca3af]">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-[#d8caff] border-t-[#813fed]" />
          Pulling live numbers from Metabase…
        </span>
      </div>
    );
  }

  if (error) {
    const paramIssue = /required parameter|unknown parameter|not allowed/i.test(error);
    const runIssue = /error occurred while running/i.test(error);
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-[#fde68a] bg-[#fffbeb] px-6 py-10 text-center">
        <p className="text-[13px] font-bold text-[#92400e]">Metabase returned an error</p>
        <p className="max-w-[560px] text-[12px] text-[#a16207]">{error}</p>
        {paramIssue && (
          <p className="mt-1 max-w-[560px] text-[11.5px] leading-snug text-[#6b7280]">
            This question’s filters (<b>TEAM_ID · AGENT_TYPE · CALLTYPES · TZ</b>) aren’t enabled for embedding yet. In
            Metabase open question 12182 → <b>Sharing → Embed</b>, set each of those four parameters to <b>Locked</b>,
            then <b>Publish</b>.
          </p>
        )}
        {runIssue && (
          <p className="mt-1 max-w-[560px] text-[11.5px] leading-snug text-[#6b7280]">
            The filters are enabled, but the query errors under embedding (the real reason is masked here). This is almost
            always a <b>referenced question or SQL snippet that isn’t published for embedding</b>, or a field-filter
            parameter type. The actual error shows in <b>Metabase → Admin → Troubleshooting → Logs</b>.
          </p>
        )}
      </div>
    );
  }

  if (!data || !data.rows.length) {
    return <div className="py-12 text-center text-[12px] text-[#9ca3af]">No rows returned for this filter.</div>;
  }

  // Single summary row → KPI tiles. Breakdown → table.
  if (data.rows.length === 1) {
    const row = data.rows[0];
    return (
      <div>
        <div className="mb-3 flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-[#10b981]" />
          <span className="text-[11px] font-semibold text-[#065f46]">Live from Metabase · {data.cols.length} metrics</span>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {data.cols.map((c) => (
            <div key={c} className="rounded-xl border border-[#f0f0f0] bg-white px-4 py-3">
              <p className="truncate text-[10px] font-bold uppercase tracking-wider text-[#9ca3af]" title={c}>{c}</p>
              <p className="mt-0.5 text-[20px] font-extrabold tabular-nums text-[#111]">{fmtVal(row[c])}</p>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-[#10b981]" />
        <span className="text-[11px] font-semibold text-[#065f46]">Live from Metabase · {data.rows.length} rows</span>
      </div>
      <div className="max-h-[460px] overflow-auto rounded-xl border border-[#f0f0f0]">
        <table className="w-full">
          <thead className="sticky top-0 bg-[#fafafa]">
            <tr>
              {data.cols.map((c) => (
                <th key={c} className="px-4 py-2.5 text-left text-[10px] font-bold uppercase tracking-wider text-[#6b7280] whitespace-nowrap">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, i) => (
              <tr key={i} className="border-t border-[#f0f0f0] hover:bg-[#faf8ff]">
                {data.cols.map((c) => (
                  <td key={c} className="px-4 py-2.5 text-[12px] tabular-nums text-[#374151] whitespace-nowrap">{fmtVal(row[c])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
