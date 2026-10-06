/* CANCELLED APPOINTMENTS ARE NOT BOOKINGS (added 2026-10-06, Freshdesk #24149).
 *
 * Every appointment number in this report (the AI-booked tile, its drill-down, the AI-assisted counter,
 * the campaign card, the named-appointment lists) used to count a meeting whatever its status, so a
 * booking that was cancelled stayed in the headline and listed underneath it in red. Honda of Reseda,
 * Service Outbound, 30d: the card read 36 with a CANCELLED row in its own drill-down; 35 were real.
 *
 * ONE LIST, EVERY SURFACE. The TS read paths use isCancelledMeeting(); the detail queries use
 * notCancelledSql(); agentBaseFact.sql (a raw .sql file, so it cannot import this) carries the same two
 * literals inline and points back here. Change the list here and in agentBaseFact.sql together, or the
 * tile and its drill-down will disagree again.
 *
 * The two values are the only cancel states the meetings table carries (prod, Jul–Oct 2026: 'cancelled'
 * 3,338 rows, 'cancellation_requested' 28). 'noshow' and 'completed' are NOT excluded: those were real
 * bookings, and what happened at the appointment is a different question from whether one was booked. */
export const CANCELLED_MEETING_STATUSES = ["cancelled", "cancellation_requested"] as const;

const CANCELLED = new Set<string>(CANCELLED_MEETING_STATUSES);

/** True when a meeting's status says it was cancelled. Null/blank/unknown statuses are kept. */
export function isCancelledMeeting(status?: string | null): boolean {
  return CANCELLED.has((status || "").trim().toLowerCase());
}

/** ClickHouse predicate keeping only meetings that are NOT cancelled, e.g. notCancelledSql("m"). */
export const notCancelledSql = (alias = "m"): string =>
  `lower(ifNull(${alias}.status, '')) NOT IN (${CANCELLED_MEETING_STATUSES.map((s) => `'${s}'`).join(", ")})`;
