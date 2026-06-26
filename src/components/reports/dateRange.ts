"use client";

/* Shared date-range state for the report tabs. The selected window (preset bucket OR a custom range)
 * lives in the URL query string — NOT page-local React state — so it SURVIVES navigation between the
 * Overview and By-agent tabs (and back/forward, refresh, and shared links). Encoding:
 *   • preset  → ?range=<bucket>   (omitted for the default "last30" to keep URLs clean)
 *   • custom  → ?start=YYYY-MM-DD&end=YYYY-MM-DD  (inclusive end, exactly as the picker reports it;
 *               the page makes it exclusive via addDay() when querying, same as before)
 */

import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Bucket } from "./data";

const BUCKETS: Bucket[] = ["today", "yesterday", "last7", "last14", "last30", "lifetime"];

export interface DateRangeState {
  bucket: Bucket;
  custom: { start: string; end: string } | null;
  setPreset: (b: Bucket) => void;
  setCustom: (r: { start: string; end: string }) => void;
}

/* The date-range portion of a query string (no leading "&"/"?"), for building cross-tab links that
 * carry the selected window. "" for the default last30 preset. */
export function dateQS(bucket: Bucket, custom: { start: string; end: string } | null): string {
  if (custom) return `start=${custom.start}&end=${custom.end}`;
  if (bucket && bucket !== "last30") return `range=${bucket}`;
  return "";
}

/* Build a ?team_id=…&<date> query string for tab/back/drill links. enterprise_id and the Spyne token
 * are NOT carried here on purpose — they're held in the ScenarioProvider context, which survives
 * client-side navigation, so only the rooftop scope + window need to ride the URL. */
export function reportNavQuery(teamId: string, bucket: Bucket, custom: { start: string; end: string } | null): string {
  const dq = dateQS(bucket, custom);
  if (teamId) return `?team_id=${teamId}${dq ? `&${dq}` : ""}`;
  return dq ? `?${dq}` : "";
}

/* Read + write the selected window via the URL. Returns memoized `bucket`/`custom` (stable references
 * across renders unless the params actually change) so they're safe to use in effect dependency lists. */
export function useDateRange(): DateRangeState {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const startP = params.get("start");
  const endP = params.get("end");
  const rangeP = params.get("range");

  const custom = useMemo(
    () => (startP && endP ? { start: startP, end: endP } : null),
    [startP, endP],
  );
  const bucket = useMemo<Bucket>(
    () => (rangeP && (BUCKETS as string[]).includes(rangeP) ? (rangeP as Bucket) : "last30"),
    [rangeP],
  );

  const write = useCallback(
    (next: { range?: Bucket; start?: string; end?: string }) => {
      const sp = new URLSearchParams(params.toString());
      sp.delete("range");
      sp.delete("start");
      sp.delete("end");
      if (next.start && next.end) {
        sp.set("start", next.start);
        sp.set("end", next.end);
      } else if (next.range && next.range !== "last30") {
        sp.set("range", next.range);
      }
      const qs = sp.toString();
      // replace (not push) so the date toggle doesn't pollute the browser history with one entry per click.
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );

  const setPreset = useCallback((b: Bucket) => write({ range: b }), [write]);
  const setCustom = useCallback((r: { start: string; end: string }) => write({ start: r.start, end: r.end }), [write]);

  return { bucket, custom, setPreset, setCustom };
}
