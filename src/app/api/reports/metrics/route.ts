import { getSupabase } from "@/lib/reports/supabase";
import { requireTeamAuth } from "@/lib/reports/auth";
import {
  REPORT_APPT_STATUS,
  REPORT_TRANSFER_QUALITY,
  REPORT_CALLS_BY_REASON,
  REPORT_OUTBOUND_CAMPAIGNS,
  REPORT_OBJECTIONS,
  REPORT_MISSED_OPPORTUNITIES,
  REPORT_UPCOMING_MEETINGS,
  REPORT_FOLLOW_UPS,
  REPORT_HIGHLIGHTS,
} from "@/lib/reports/supabase";
import type {
  ApptStatusRow,
  TransferQualityRow,
  CallsByReasonRow,
  OutboundCampaignRow,
  ObjectionRow,
  MissedOpportunityRow,
  UpcomingMeetingRow,
  FollowUpRow,
  HighlightRow,
} from "@/lib/reports/schema";

/* Coming-soon metrics derived from ClickHouse (dealer_leads), not Q12227/Metabase — see
 * AGENT_FIELDS.md widgets #9, #12, #15, #16, #19, #22, #23 and the `showed` metric.
 *
 *   POST /api/reports/metrics  — ingest. The ETL bridge: scripts/push_metrics.py runs the `ch`
 *       queries (prod has no ClickHouse access) and POSTs the computed rows here. Protected by
 *       CRON_SECRET. Replaces a team's rows per section (delete-by-team then insert), like the
 *       other report_* detail tables — so a re-push never accumulates stale rows. Partial pushes
 *       are fine: only sections present in the body are touched.
 *
 *   GET  /api/reports/metrics?team_id=…  — read. Returns every section for the rooftop; each table
 *       degrades to [] independently if the migration (0009) isn't applied yet, so a missing table
 *       never fails the whole response.
 *
 * Tables: see supabase/migrations/0009_report_coming_soon.sql. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const CHUNK = 500;

// Body key → table, and whether to stamp window_days (windowed snapshots vs point-in-time feeds).
const SECTIONS: ReadonlyArray<{ key: string; table: string; windowed: boolean }> = [
  { key: "appt_status", table: REPORT_APPT_STATUS, windowed: true },
  { key: "transfer_quality", table: REPORT_TRANSFER_QUALITY, windowed: true },
  { key: "calls_by_reason", table: REPORT_CALLS_BY_REASON, windowed: true },
  { key: "campaigns", table: REPORT_OUTBOUND_CAMPAIGNS, windowed: false },
  { key: "objections", table: REPORT_OBJECTIONS, windowed: true },
  { key: "missed", table: REPORT_MISSED_OPPORTUNITIES, windowed: true },
  { key: "upcoming", table: REPORT_UPCOMING_MEETINGS, windowed: false },
  { key: "follow_ups", table: REPORT_FOLLOW_UPS, windowed: false },
  { key: "highlights", table: REPORT_HIGHLIGHTS, windowed: false },
];

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // never run open
  const hdr = request.headers.get("authorization") || "";
  const url = new URL(request.url);
  return hdr === `Bearer ${secret}` || url.searchParams.get("key") === secret;
}

async function chunkedInsert(
  sb: NonNullable<ReturnType<typeof getSupabase>>,
  table: string,
  rows: object[],
): Promise<string | null> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await sb.from(table).insert(rows.slice(i, i + CHUNK));
    if (error) return error.message;
  }
  return null;
}

export async function POST(request: Request): Promise<Response> {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const sb = getSupabase();
  if (!sb) return Response.json({ error: "Supabase is not configured." }, { status: 503 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const teamId = typeof body.team_id === "string" ? body.team_id : "";
  if (!teamId) return Response.json({ error: "team_id is required" }, { status: 400 });
  const windowDays = Number(body.window_days) || null;

  const written: Record<string, number> = {};
  for (const { key, table, windowed } of SECTIONS) {
    if (!(key in body)) continue; // partial push — leave untouched sections alone
    const raw = body[key];
    const rows = (Array.isArray(raw) ? raw : raw == null ? [] : [raw]) as Record<string, unknown>[];

    // Replace this team's rows for this section.
    const del = await sb.from(table).delete().eq("team_id", teamId);
    if (del.error) return Response.json({ error: `delete ${table}: ${del.error.message}` }, { status: 502 });

    if (rows.length) {
      // Strip any client-sent team_id/synced_at; stamp our own. synced_at uses the column default.
      const stamped = rows.map((r) => {
        const { team_id: _t, synced_at: _s, ...rest } = r;
        void _t;
        void _s;
        return { ...rest, team_id: teamId, ...(windowed && windowDays ? { window_days: windowDays } : {}) };
      });
      const err = await chunkedInsert(sb, table, stamped);
      if (err) return Response.json({ error: `insert ${table}: ${err}` }, { status: 502 });
    }
    written[key] = rows.length;
  }

  return Response.json({ ok: true, team_id: teamId, window_days: windowDays, written });
}

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const teamId = searchParams.get("team_id");
  if (!teamId) return Response.json({ error: "team_id is required" }, { status: 400 });

  // Require a credential and validate team scope (same guard as the other read routes). The POST ingest
  // path keeps its own CRON_SECRET check untouched. No credential → 401; wrong team scope → 403.
  const auth = requireTeamAuth(request, teamId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const sb = getSupabase();
  if (!sb) return Response.json({ team_id: teamId, configured: false }, { status: 200 });

  // Each table may not exist yet (migration 0009 unapplied) — degrade per-table to [] independently.
  const safe = async <T,>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> => {
    try {
      const { data, error } = await p;
      return error ? [] : ((data ?? []) as T[]);
    } catch {
      return [];
    }
  };
  const byTeam = (table: string) => sb.from(table).select("*").eq("team_id", teamId);

  const [
    apptStatus,
    transferQuality,
    callsByReason,
    campaigns,
    objections,
    missed,
    upcoming,
    followUps,
    highlights,
  ] = await Promise.all([
    safe<ApptStatusRow>(byTeam(REPORT_APPT_STATUS)),
    safe<TransferQualityRow>(byTeam(REPORT_TRANSFER_QUALITY)),
    safe<CallsByReasonRow>(byTeam(REPORT_CALLS_BY_REASON)),
    safe<OutboundCampaignRow>(byTeam(REPORT_OUTBOUND_CAMPAIGNS)),
    safe<ObjectionRow>(byTeam(REPORT_OBJECTIONS)),
    safe<MissedOpportunityRow>(byTeam(REPORT_MISSED_OPPORTUNITIES)),
    safe<UpcomingMeetingRow>(byTeam(REPORT_UPCOMING_MEETINGS).order("meeting_start_time", { ascending: true })),
    safe<FollowUpRow>(byTeam(REPORT_FOLLOW_UPS)),
    safe<HighlightRow>(byTeam(REPORT_HIGHLIGHTS)),
  ]);

  return Response.json(
    {
      team_id: teamId,
      appt_status: apptStatus,
      transfer_quality: transferQuality[0] ?? null, // one row per team
      calls_by_reason: callsByReason,
      campaigns,
      objections,
      missed,
      upcoming,
      follow_ups: followUps,
      highlights,
    },
    { headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=120" } },
  );
}
