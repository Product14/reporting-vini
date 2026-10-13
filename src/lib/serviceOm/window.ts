import type { Bucket } from "@/components/reports/data";
import { BUCKET_LABELS } from "@/components/reports/data";
import { rangeFor } from "@/components/reports/liveData";
import type { WindowParams } from "./contract";

/* One resolved window, shared by every Service OM page so the Overview and Reports always ask the API the
 * same question.
 *
 * - `params`: what the API is sent. Presets it knows go as presets (the API cuts days in rooftop time, G8);
 *   anything else goes as explicit dates with an INCLUSIVE end, same rule as serviceMetricsWindowFor.
 * - `startKey` / `endKey`: store-local days, end EXCLUSIVE, same as the rest of this app (rangeFor). The
 *   mock counts on these.
 * - All time is the last 366 days: Om's API answers at most 366 days (doc v6, "Limits"; a longer custom
 *   window is a 400), and its "All time" is the rooftop's start date capped at 366 days back. */
export interface ResolvedWindow {
  params: WindowParams;
  startKey: string;
  endKey: string;
  label: string;
  /** The window inside a sentence: "today", "in the last 30 days", "all time", "from 2026-10-01 to 2026-10-07". */
  phrase: string;
}

export function resolveWindow(bucket: Bucket, custom: { start: string; end: string } | null, timezone?: string | null): ResolvedWindow {
  const tz = timezone ?? undefined;
  if (custom) {
    const label = custom.start === custom.end ? custom.start : `${custom.start} – ${custom.end}`;
    return {
      params: { window: "custom", startDate: custom.start, endDate: custom.end, timezone: tz },
      startKey: custom.start,
      endKey: nextDay(custom.end),
      label,
      phrase: custom.start === custom.end ? `on ${custom.start}` : `from ${custom.start} to ${custom.end}`,
    };
  }
  const r0 = rangeFor(bucket, tz);
  const r = bucket === "lifetime" ? { ...r0, start: maxKey(r0.start, shift(r0.end, -MAX_DAYS)) } : r0;
  const preset: Partial<Record<Bucket, WindowParams["window"]>> = { today: "today", last7: "7d", last30: "30d", mtd: "mtd" };
  const p = preset[bucket];
  return {
    params: p ? { window: p, timezone: tz } : { window: "custom", startDate: r.start, endDate: prevDay(r.end), timezone: tz },
    startKey: r.start,
    endKey: r.end,
    label: BUCKET_LABELS[bucket],
    phrase: PHRASES[bucket],
  };
}

const PHRASES: Record<Bucket, string> = {
  today: "today",
  yesterday: "yesterday",
  last7: "in the last 7 days",
  last14: "in the last 14 days",
  last30: "in the last 30 days",
  mtd: "this month so far",
  lifetime: "in the last 366 days",
};

/** The longest window the API answers (doc v6). */
export const MAX_DAYS = 366;
const maxKey = (a: string, b: string) => (a > b ? a : b);

export function nextDay(key: string): string {
  return shift(key, 1);
}
export function prevDay(key: string): string {
  return shift(key, -1);
}
function shift(key: string, n: number): string {
  const d = new Date(`${key.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
