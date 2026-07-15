import { getSupabase, AGENT_DAILY } from "@/lib/reports/supabase";
import { readBearer } from "@/lib/reports/auth";

/* Freshness probe for the reporting aggregate. Returns sync_state + the newest agent_daily day so an
 * external watchdog (vini-daily-calls' /api/cron/sync-health) can page when the sync-reports job stalls.
 * MUST live here, not in the watchdog: sync_state / agent_daily sit behind RLS, and only this project's
 * SUPABASE_SERVICE_ROLE_KEY can read them — the watchdog's ROI publishable key silently reads ZERO rows
 * (which is what produced the first false "nullh stale" page). CRON_SECRET-guarded; the watchdog forwards
 * it as REPORTING_CRON_SECRET. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (secret && readBearer(request) !== secret) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const sb = getSupabase();
  if (!sb) return Response.json({ ok: false, error: "supabase not configured" }, { status: 500 });

  const [stateRes, latestRes] = await Promise.all([
    sb.from("sync_state").select("watermark,last_run_at,last_status,error,rows_synced,window_start").eq("id", 1).maybeSingle(),
    sb.from(AGENT_DAILY).select("activity_day").order("activity_day", { ascending: false }).limit(1),
  ]);
  if (stateRes.error || latestRes.error) {
    return Response.json({ ok: false, error: `read failed: ${(stateRes.error || latestRes.error)?.message}` }, { status: 500 });
  }
  const state = stateRes.data as Record<string, unknown> | null;
  const latest = latestRes.data as Array<{ activity_day: unknown }> | null;
  return Response.json(
    {
      ok: true,
      watermark: (state?.watermark as string) ?? null,
      lastRunAt: (state?.last_run_at as string) ?? null,
      lastStatus: (state?.last_status as string) ?? null,
      lastError: (state?.error as string) ?? null,
      rowsSynced: (state?.rows_synced as number) ?? null,
      windowStart: (state?.window_start as string) ?? null,
      maxActivityDay: latest && latest[0] ? String(latest[0].activity_day) : null,
      checkedAt: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
