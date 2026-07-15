import { track as vercelTrack } from "@vercel/analytics";

/* ─────────────────────────────────────────────────────────────────────────────
 * Product analytics — a thin, typed wrapper over Vercel Web Analytics custom events.
 *
 * One place that lists every event we emit and the exact shape of its properties, so
 * names stay consistent and the Vercel dashboard ("Events") groups cleanly. Vercel's
 * track() is a no-op on the server and outside production (in dev it logs to the
 * console), so these are safe to call from any client component without guarding.
 *
 * Conventions:
 *   • snake_case event names, grouped by what they tell us (usage / depth / upsell).
 *   • every event carries `team_id` (the rooftop) and, where it applies, `tab` (the
 *     report surface) so the dashboard can segment by rooftop and by tab.
 *   • NO PII — we track which agent / rooftop / range, never names, emails or phones.
 *   • Vercel only accepts flat string | number | boolean | null props (no nesting).
 * ───────────────────────────────────────────────────────────────────────────── */

export type ReportTab = "overview" | "appointments" | "calls" | "actions" | "customers" | "agents" | "campaigns" | "reporting";

/** The full event catalogue: event name → its property shape. Add new events here. */
export interface ReportEvents {
  // ── usage: who opens what, how they slice it ──
  report_viewed: { tab: ReportTab; team_id: string };
  report_tab_clicked: { from: ReportTab; to: ReportTab; team_id: string }; // nav flow between tabs
  date_range_changed: { tab: ReportTab; range: string; team_id: string };
  campaigns_filtered: { team_id: string; subtype: string }; // campaigns sub-type filter
  report_refreshed: { tab: ReportTab; team_id: string };
  report_exported: { tab: ReportTab; team_id: string; format: "csv" | "xlsx" };

  // ── depth: signals they trust the numbers and dig in ──
  appointments_drilldown_opened: { tab: ReportTab; team_id: string; agent?: string };
  appointments_drilldown_result: { team_id: string; status: "ok" | "empty" | "error"; count: number };
  agent_opened: { team_id: string; agent: string }; // overview leaderboard → agent report
  agent_switched: { team_id: string; agent: string }; // agents-tab picker
  agent_detail_toggled: { team_id: string; agent: string; shown: boolean }; // show/hide detailed metrics
  campaign_opened: { team_id: string; campaign_id: string };
  // v3 named sections (no PII — tier/flags only, never names or phones)
  warm_lead_phone_clicked: { team_id: string; tier: string }; // "Work these now" tel: tap
  named_appointment_row_clicked: { team_id: string; assisted: boolean };
  outcome_table_viewed: { team_id: string; agent: string }; // OB ranked-outcomes table rendered
  // v3 detail pages (Appointments / Recent calls / Action items / Customers)
  action_items_opened: { tab: ReportTab; team_id: string };
  action_item_filtered: { team_id: string; dept: string; scope: string };
  customers_filtered: { team_id: string; bucket: string };
  call_row_opened: { team_id: string; channel: string };
  customer_row_opened: { team_id: string; bucket: string };

  // ── ROI setup funnel: prompted → set (and edited) — powers the $ value story ──
  cost_per_appt_prompted: { team_id: string };
  cost_per_appt_edit_opened: { team_id: string };
  cost_per_appt_set: { team_id: string; cost: number };

  // ── upsell funnel: pitch → interest → submit (for not-live agents) ──
  agent_upsell_viewed: { team_id: string; agent: string };
  agent_interest_opened: { team_id: string; agent: string };
  agent_interest_submitted: { team_id: string; agent: string };

  // ── recovery / monitoring ──
  empty_window_widened: { team_id: string; agent: string }; // "View last 30 days" from an empty window
  report_load_failed: { tab: ReportTab; team_id: string };
}

type Props = Record<string, string | number | boolean | null | undefined>;

/**
 * Emit a custom product event. Typed against the catalogue above, so the event name
 * and its properties are checked at the call site.
 */
export function track<E extends keyof ReportEvents>(event: E, props: ReportEvents[E]): void {
  const clean: Props = { ...props };
  // The rooftop is unknown until ?team_id= resolves; normalize the empty sentinel so
  // the dashboard doesn't split a real rooftop's funnel across "" and "(unscoped)".
  if (clean.team_id === "") clean.team_id = "(unscoped)";
  vercelTrack(event, clean);
}
