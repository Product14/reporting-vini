/* WHICH AI-ASSISTED (CRM) APPOINTMENTS BELONG TO A WINDOW.
 *
 * canonical: an AI-assisted appointment is a meeting booked in the dealer's CRM (meetings.source != 'spyne')
 * on a lead the agent WORKED IN THE WINDOW — "agent-worked" being ≥1 AI call, text or chat touch inside
 * the reported period. AI-booked meetings carry their own in-window conversation by construction, so this
 * only ever applies to the assisted half.
 *
 * WHY THIS EXISTS AS A SHARED HELPER. report_appointments is a rolling ~120-day snapshot: it cannot know
 * which window a reader will ask for, so appointmentsSql gates the AI-touch check on a trailing 120 days
 * instead. That lists a CRM booking made this month on a lead the AI last spoke to in June. Covina Kia,
 * trailing 30d: the card said 3 AI-assisted while the list showed 5 — the two extras last touched Jun 15
 * and Jul 17, both since cancelled. Every surface that lists appointments has to re-apply the window, and
 * doing that in one place is what stops the appointment count differing between two screens again.
 *
 * agent_lead_days is the same per-lead table the counters are built from, so filtering by it ties a list
 * to its number rather than approximating it. */

/** Leads with an AI-assisted (CRM) appointment inside [start, end). Dates are store-local day strings. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function assistedApptLeads(sb: any, teamId: string, start: string, end: string): Promise<Set<string> | undefined> {
  if (!sb || !teamId) return undefined;
  try {
    const { data, error } = await sb
      .from("agent_lead_days")
      .select("lead_id")
      .eq("team_id", teamId)
      .eq("appointment_assisted", true)
      .gte("activity_day", start)
      .lt("activity_day", end);
    if (error || !Array.isArray(data)) return undefined;
    return new Set((data as Array<{ lead_id?: string }>).map((r) => String(r.lead_id ?? "")).filter(Boolean));
  } catch {
    return undefined;
  }
}

/* True when an appointment row belongs in the window's list.
 *
 * `leads` undefined means the lookup failed — we keep the row rather than silently dropping a real
 * appointment off a dealer's screen because Supabase blipped. Under-reporting an appointment is the more
 * expensive error here: a dealer counting bookings will notice a missing one long before an extra. */
export function assistedInWindow(
  row: { assisted?: boolean | null; lead_id?: string | null },
  leads: Set<string> | undefined,
): boolean {
  if (!row.assisted) return true;
  if (!leads) return true;
  return !!row.lead_id && leads.has(row.lead_id);
}
