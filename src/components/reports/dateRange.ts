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

const BUCKETS: Bucket[] = ["today", "yesterday", "last7", "last14", "last30", "mtd", "lifetime"];

/* Department scope — sales / service / all. Like the date window, it lives in the URL (?dept=…, omitted
 * for the default "all") so it SURVIVES tab navigation and is a single top-level scope for every tab. */
export type Dept = "all" | "sales" | "service";

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
 * client-side navigation, so only the rooftop scope + window need to ride the URL.
 *
 * `locked` (host-scoped via ?serviceType=, see useDept below) re-encodes the scope as `serviceType=`
 * instead of `dept=` so the NEXT page's useDept() also sees it as host-locked — otherwise an in-app nav
 * (e.g. Overview → By-agent, same iframe) would silently drop the lock and the switcher would reappear. */
export function reportNavQuery(teamId: string, bucket: Bucket, custom: { start: string; end: string } | null, dept: Dept = "all", locked = false): string {
  const deptQS = dept !== "all" ? `${locked ? "serviceType" : "dept"}=${dept}` : "";
  const parts = [dateQS(bucket, custom), deptQS].filter(Boolean);
  const tail = parts.length ? parts.join("&") : "";
  if (teamId) return `?team_id=${teamId}${tail ? `&${tail}` : ""}`;
  return tail ? `?${tail}` : "";
}

/* Read + write the department scope via the URL (shared across all report tabs).
 *
 * The console now gives Sales and Service each their own dedicated space (no more unified "All" view),
 * so a ?serviceType=sales|service on the iframe URL LOCKS the whole report to that department: `dept`
 * resolves straight from it, `setDept` becomes a no-op, and callers (the header's DeptSwitcher) use
 * `locked` to hide the switcher entirely. Absent serviceType (localhost dev, or an older embed) falls
 * back to the in-app switcher via ?dept=, exactly as before. */
export function useDept(): { dept: Dept; setDept: (d: Dept) => void; locked: boolean } {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const svcParam = params.get("serviceType");
  const locked = svcParam === "sales" || svcParam === "service";
  const p = params.get("dept");
  const dept: Dept = locked ? (svcParam as Dept) : p === "sales" || p === "service" ? p : "all";
  const setDept = useCallback(
    (d: Dept) => {
      if (locked) return; // host-scoped — no in-app override
      const sp = new URLSearchParams(params.toString());
      if (d === "all") sp.delete("dept");
      else sp.set("dept", d);
      const qs = sp.toString();
      // replace (not push) so toggling scope doesn't stack browser-history entries.
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router, locked],
  );
  return { dept, setDept, locked };
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
