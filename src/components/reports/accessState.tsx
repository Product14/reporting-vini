"use client";

import { useEffect } from "react";
import { track, type ReportTab } from "@/lib/analytics";

/* ─────────────────────────────────────────────────────────────────────────────
 * THE REPORT IS FINE — THIS BROWSER IS NOT ALLOWED TO READ THIS ROOFTOP.
 *
 * `/api/reports` answers 401 (no credential reached it) or 403 (the credential names a different
 * rooftop — requireTeamAuth in lib/reports/auth.ts). fetchAgents treats both as terminal and returns
 * `{ agents: [], hasData: false, unauthorized: true }` with NO `degraded` flag, so every caller that
 * gates on `everLive ?? hasData` used to fall straight into the "Coming soon" placeholder and tell a
 * live dealer their agents hadn't started yet.
 *
 * Paragon Honda (team 5895de05b), 2026-09-10: 12,248 non-test calls in 30 days, agent_daily rows
 * through that morning, the deployed API returning everLive:true to a service credential — and the
 * console showing "Paragon Honda's report is on its way". The rooftop sits in a group with Paragon
 * Acura and Acura of Paragon, and switching rooftop changes the requested team_id while the forwarded
 * session token still names the one the user signed in with → 403 on every read.
 *
 * So the two failures are told apart, in the dealer's words, and the denial is now COUNTABLE
 * (report_access_denied) instead of hiding inside the coming-soon rate. Recovery is deliberately not a
 * "Retry" button: refetching sends the same credential and fails identically. Re-opening the rooftop
 * from the dashboard is what actually issues a token scoped to it.
 * ───────────────────────────────────────────────────────────────────────────── */

export function ReportAccessDenied({
  tab, teamId, name, status,
}: {
  tab: ReportTab;
  teamId: string;
  name?: string;
  status?: 401 | 403;
}) {
  useEffect(() => {
    track("report_access_denied", { tab, team_id: teamId, status: status ?? 0 });
  }, [tab, teamId, status]);

  const rooftop = name || "this rooftop";
  const wrongRooftop = status === 403;

  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[#e0d8f5] bg-[#faf8ff] px-6 py-16 text-center">
      <p className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-[#813fed]">Access</p>
      <p className="text-[14px] font-bold text-[#111]">
        {wrongRooftop
          ? `Your session isn’t signed in to ${rooftop}`
          : `We couldn’t verify your access to ${rooftop}`}
      </p>
      <p className="max-w-[460px] text-[12.5px] leading-snug text-[#6b7280]">
        {wrongRooftop
          ? `You’re signed in to a different rooftop, so we can’t show ${rooftop}’s numbers here. Open ${rooftop} from your dashboard again and the report loads with the right access.`
          : `Your session didn’t reach the report. Open ${rooftop} from your dashboard again, or sign in once more. Your numbers are safe and nothing needs setting up.`}
      </p>
      <p className="mt-1 text-[11px] text-[#9ca3af]">
        This is a sign-in issue, not missing data. If it keeps happening, send your dealership contact this
        reference: rooftop {teamId || "unknown"}, access check {status ?? "failed"}.
      </p>
    </div>
  );
}
