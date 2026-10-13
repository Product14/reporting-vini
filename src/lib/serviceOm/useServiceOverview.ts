"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Bucket } from "@/components/reports/data";
import { MOCK_TZ } from "./mock";
import { buildServiceOverview, type ServiceOverviewModel } from "./overviewModel";
import { buildServiceReports, type ServiceReportsModel } from "./reportsModel";
import { loadOverview, loadReports, type OmSource, type SourceCtx } from "./source";
import { resolveWindow, type ResolvedWindow } from "./window";

interface Params extends SourceCtx {
  source: OmSource;
  bucket: Bucket;
  custom: { start: string; end: string } | null;
}

/* Fetches a page's responses whenever the rooftop, window or source changes, and builds its model. While a
 * new window loads, the previous model stays on screen with `loading: true` (the page shimmers the numbers
 * rather than showing a 0). The rooftop's timezone comes back on the first response and is then used for
 * the store-local days of non-preset windows. One hook for both pages, so they load the same way. */
function useOmPage<R, M extends { timezone: string | null }>(
  p: Params,
  load: (source: OmSource, ctx: SourceCtx, w: ResolvedWindow) => Promise<R>,
  build: (r: R) => M,
  empty: R,
): { model: M | null; loading: boolean; window: ResolvedWindow; refresh: () => void } {
  const { source, bucket, custom, teamId, enterpriseId, spyneToken, spyneEnv, nameHint, agents, mockAssistedOff } = p;
  const [tz, setTz] = useState<string | null>(source === "mock" ? MOCK_TZ : null);
  const [nonce, setNonce] = useState(0);
  const w = useMemo(() => resolveWindow(bucket, custom, tz), [bucket, custom, tz]);
  // The timezone is left out of the key: learning it must not refetch a preset window the API already
  // cut in rooftop time (G8).
  const key = JSON.stringify([source, teamId, enterpriseId, spyneEnv, spyneToken ? 1 : 0, mockAssistedOff ? 1 : 0, w.params.window, w.params.startDate, w.params.endDate, w.startKey, w.endKey, nonce]);
  const [state, setState] = useState<{ key: string; model: M | null }>({ key: "", model: null });

  useEffect(() => {
    let on = true;
    load(source, { teamId, enterpriseId, spyneToken, spyneEnv, nameHint, agents, mockAssistedOff }, w)
      .then((r) => {
        if (!on) return;
        const model = build(r);
        setState({ key, model });
        if (model.timezone) setTz((prev) => prev ?? model.timezone);
      })
      .catch(() => { if (on) setState({ key, model: build(empty) }); });
    return () => { on = false; };
    // `key` covers every input that changes the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { model: state.model, loading: state.key !== key, window: w, refresh };
}

const NO_OVERVIEW = { appointments: null, upcoming: null, actionItems: null, agents: null };
const NO_REPORTS = { appointments: null, campaign: null, contactInbound: null, contactOutbound: null, upcoming: null, actionItems: null, callsReport: null, followUp: null, trendInbound: null, trendOutbound: null, agents: null };

export function useServiceOverview(p: Params): { model: ServiceOverviewModel | null; loading: boolean; window: ResolvedWindow; refresh: () => void } {
  return useOmPage(p, loadOverview, buildServiceOverview, NO_OVERVIEW);
}

export function useServiceReports(p: Params): { model: ServiceReportsModel | null; loading: boolean; window: ResolvedWindow; refresh: () => void } {
  return useOmPage(p, loadReports, buildServiceReports, NO_REPORTS);
}
