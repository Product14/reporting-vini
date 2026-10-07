/* STORE-LOCAL CLOCK — the one place a dealer-facing timestamp is turned into wall-clock fields.
 *
 * THE BUG THIS EXISTS TO KILL. Every appointment label in the report used to be built from the UTC
 * getters (getUTCHours/getUTCDate/getUTCDay). A Pacific rooftop's 08:30 PM booking is 03:30Z the NEXT
 * day, so the Overview card printed "MONDAY, OCT 5 · 08:30 PM" as Tuesday 03:30 AM — the dealer read a
 * time and a DAY that were not when the customer is coming in. Worse, the same slice(0,10)-of-the-UTC-
 * string was used as the day GROUP KEY and as the "is it still upcoming" cutoff, so an evening booking
 * also filed itself under the following day's heading and could vanish from "upcoming" near midnight.
 *
 * WHY ONE MODULE AND NOT Intl AT EACH CALL SITE. The display string, the group key and the today-cutoff
 * MUST agree. They are computed in four different components; the only way they cannot drift apart is if
 * they all read the same wall-clock fields from the same function. `storeParts` is that function.
 *
 * WHY NO REACT / NO kitV3 IMPORT. roiPdf.ts (jsPDF, no React) and lib/reports/build.ts (server) both
 * format dealer-facing timestamps. Keeping this dependency-free lets all three share it without pulling
 * the report kit's components into the PDF bundle or onto the server.
 *
 * DEGRADATION IS DELIBERATE AND IS "UTC, EXACTLY AS BEFORE". When no IANA zone is known — getStoreTimeZone
 * returns null whenever the Spyne token is absent or the working-days call fails, which is a NORMAL state
 * (api/reports/route.ts: "best-effort; both null … → previous behavior: UTC windows") — every function
 * here falls back to the UTC getters. It does NOT fall back to Intl-with-no-timeZone: that is the
 * BROWSER's zone, which would put a New York analyst's clock on a Phoenix rooftop's appointments with no
 * label saying so, and would differ per viewer. UTC is at least the same for everyone, is what shipped
 * before, and matches the window the card is drawn from (rangeFor also degrades to UTC on the same
 * failure), so a tz-resolution failure can only ever be no-worse-than-today.
 *
 * NOT TO BE CONFUSED WITH the deliberately-UTC date arithmetic elsewhere (liveData.ts shiftDays/addDay,
 * serviceMetrics.ts inclusiveEnd, api/reports/route.ts ymd/addDay). Those operate on a BARE "YYYY-MM-DD"
 * at UTC midnight precisely BECAUSE that is zone-agnostic: it adds whole calendar days without DST ever
 * shifting the result. They are correct. Do not "fix" them with this.
 */

const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Wall-clock fields of an instant, in the store's zone (or UTC when none is known). `mon` is 0-based
 *  and `dow` is 0=Sunday, matching Date's getters so the UTC fallback is literally the same numbers. */
export interface StoreParts {
  y: number;
  mon: number;  // 0-11
  day: number;  // 1-31
  dow: number;  // 0=Sun
  h24: number;  // 0-23
  min: number;  // 0-59
}

/* Parse the two shapes that reach the report's formatters, and ONLY these two:
 *   (a) ClickHouse `FORMAT JSONEachRow` DateTime → "YYYY-MM-DD HH:MM:SS", NAIVE, no zone marker. It is
 *       a UTC instant, so the "Z" we append is an assertion, not a guess — dropping it would make the
 *       browser read it as viewer-local and shift the snapshot path by the viewer's offset.
 *   (b) the Spyne meetings API → a zoned ISO-8601 string, which `new Date` already handles.
 * Both producers feed the SAME components (route.ts picks between them at runtime by whether the live
 * meetings call succeeded), so this normaliser is load-bearing on the degraded path specifically. */
export function parseReportTs(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** Wall-clock fields of `iso` in `tz`; UTC fields when `tz` is absent or unusable; null when unparseable. */
export function storeParts(iso: string | null | undefined, tz?: string | null): StoreParts | null {
  const d = parseReportTs(iso);
  if (!d) return null;
  return partsOf(d, tz);
}

function partsOf(d: Date, tz?: string | null): StoreParts {
  const utc = (): StoreParts => ({
    y: d.getUTCFullYear(), mon: d.getUTCMonth(), day: d.getUTCDate(),
    dow: d.getUTCDay(), h24: d.getUTCHours(), min: d.getUTCMinutes(),
  });
  if (!tz) return utc();
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(d);
    const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
    const y = parseInt(get("year"), 10);
    const mon = parseInt(get("month"), 10) - 1;
    const day = parseInt(get("day"), 10);
    // Some engines render midnight as "24" under hourCycle h23 — the same workaround aggregate.ts's
    // hourOf already carries. Without it the 00:xx appointments, i.e. exactly the ones this fix is for,
    // would print "24:15 AM".
    const h24 = parseInt(get("hour"), 10) % 24;
    const min = parseInt(get("minute"), 10);
    const dow = DOW_SHORT.indexOf(get("weekday"));
    if (dow < 0 || ![y, mon, day, h24, min].every((n) => Number.isFinite(n))) return utc();
    return { y, mon, day, dow, h24, min };
  } catch {
    // Malformed IANA string (a stale team_tz row, say). Degrade to UTC rather than render "Invalid Date"
    // in front of a dealer — and specifically NOT to Intl-without-timeZone, which is browser-local.
    return utc();
  }
}

/** Calendar day (YYYY-MM-DD) of `iso` in the store's zone — the ONE key for grouping and for comparing
 *  against "today". "" when unparseable, which sorts before every real key and so never reads as upcoming. */
export function storeDayKey(iso: string | null | undefined, tz?: string | null): string {
  const p = storeParts(iso, tz);
  return p ? fmtDayKey(p) : "";
}

/** Today's calendar day (YYYY-MM-DD) in the store's zone. The "upcoming" cutoff: a Pacific rooftop's
 *  remaining bookings must not disappear between 00:00Z and 08:00Z just because UTC has rolled over. */
export function storeTodayKey(tz?: string | null): string {
  return fmtDayKey(partsOf(new Date(), tz));
}

const fmtDayKey = (p: StoreParts) =>
  `${p.y}-${String(p.mon + 1).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;

/** "Jan"…"Dec" for a 0-based month. */
export const monShort = (mon: number) => MON_SHORT[mon] ?? "";

/** 12-hour clock pieces of a 24-hour hour: `{ h, ap }`, e.g. 20 → { h: 8, ap: "PM" }. */
export function hour12(h24: number): { h: number; ap: "AM" | "PM" } {
  return { h: h24 % 12 || 12, ap: h24 >= 12 ? "PM" : "AM" };
}

/** "Jul 7 · 2:30 PM" in the store's zone (UTC when unknown). The report's canonical short timestamp.
 *  The " · " separator and the un-padded hour are load-bearing: three call sites split on it. */
export function fmtWhenShortIn(iso: string | null | undefined, tz?: string | null): string {
  const p = storeParts(iso, tz);
  if (!p) return "—";
  const { h, ap } = hour12(p.h24);
  return `${monShort(p.mon)} ${p.day} · ${h}:${String(p.min).padStart(2, "0")} ${ap}`;
}

/** Shift a bare "YYYY-MM-DD" by n whole days. UTC-midnight arithmetic ON PURPOSE — a bare calendar date
 *  has no zone, so this adds whole days without DST ever moving the result. Same reasoning as
 *  liveData.ts's shiftDays; duplicated here only to keep this module dependency-free. */
export function shiftDayKey(key: string, n: number): string {
  const d = new Date(`${key}T00:00:00Z`);
  if (!Number.isFinite(d.getTime())) return key;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Day-of-week (0=Sun) and day-of-month of a bare "YYYY-MM-DD". UTC getters are EXACT here: the key has
 *  already been resolved to a calendar date, so there is no instant left to re-zone. */
export function dayKeyFields(key: string): { dow: number; day: number } {
  const d = new Date(`${key}T00:00:00Z`);
  if (!Number.isFinite(d.getTime())) return { dow: 0, day: 1 };
  return { dow: d.getUTCDay(), day: d.getUTCDate() };
}
