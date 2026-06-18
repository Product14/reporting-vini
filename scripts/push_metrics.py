#!/usr/bin/env python3
"""
ETL bridge for the coming-soon metrics (AGENT_FIELDS.md widgets #9, #12, #15, #16, #19, #22, #23 and
the `showed` metric). Production has no ClickHouse access, so this runs offline (a box with the `ch`
CLI, e.g. cron) — it computes each metric from dealer_leads and POSTs the result to:

    POST {REPORTS_BASE_URL}/api/reports/metrics?key={CRON_SECRET}

which replaces that team's rows in Supabase (delete-by-team then insert). GET /api/reports/metrics
reads them back. No third-party deps — stdlib only; ClickHouse via the `ch` CLI.

Env:
    REPORTS_BASE_URL   e.g. https://reporting-vini.vercel.app  (or http://localhost:3000)
    CRON_SECRET        same secret the app uses for /api/sync ingest auth

Usage:
    python3 scripts/push_metrics.py --ent 7d06f7427 --team 49a06313cf --days 30
    python3 scripts/push_metrics.py --ent ... --team ... --dry-run   # print payload, don't POST
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path
from urllib.error import HTTPError, URLError

TOP = 25  # row cap for the feed sections (upcoming, follow-ups, highlights)


def load_env_local() -> None:
    """Populate os.environ from the repo's .env.local for any key not already set (the shell wins).
    Lets .env.local supply REPORTS_BASE_URL / CRON_SECRET without exporting them. No external dep."""
    env_path = Path(__file__).resolve().parent.parent / ".env.local"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


# ── ClickHouse. Two transports, same JSONEachRow output:
#   • Local: the read-only `ch` CLI (creds in ~/.clickhouse-spyne.env).
#   • CI/server: direct HTTPS to ClickHouse Cloud when CH_HOST is set (the `ch` binary isn't on a
#     GitHub runner) — same endpoint/headers the `ch` wrapper uses. ──
def _ch_http(sql: str) -> str:
    host, port = os.environ["CH_HOST"], os.environ.get("CH_PORT", "8443")
    req = urllib.request.Request(
        f"https://{host}:{port}/?default_format=JSONEachRow",
        data=sql.encode(),
        method="POST",
        headers={
            "X-ClickHouse-User": os.environ.get("CH_USER", ""),
            "X-ClickHouse-Key": os.environ.get("CH_PASSWORD", ""),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.read().decode()
    except HTTPError as e:
        sys.exit(f"ClickHouse HTTP error [{e.code}]: {e.read().decode()[:500]}\n--- sql ---\n{sql}")
    except URLError as e:
        sys.exit(f"ClickHouse HTTP connect error: {e.reason}\n--- sql ---\n{sql}")


def ch_rows(sql: str) -> list[dict]:
    if os.environ.get("CH_HOST"):
        out = _ch_http(sql)
    else:
        env = {**os.environ, "CH_FORMAT": "JSONEachRow"}
        r = subprocess.run(["ch", sql], capture_output=True, text=True, env=env)
        if r.returncode != 0:
            sys.exit(f"ch error:\n{r.stderr.strip()}\n--- sql ---\n{sql}")
        out = r.stdout
    # JSONEachRow → one object per line. Skip any stray non-JSON line (notices, blanks).
    rows = [json.loads(line) for line in out.splitlines() if line.strip().startswith("{")]
    # ClickHouse reports query errors as a JSON {"exception": "..."} row even with HTTP 200 — never let
    # that masquerade as data (it would push a bad row and silently mislead). Fail loudly instead.
    for row in rows:
        if "exception" in row:
            sys.exit(f"ch query error: {row['exception']}\n--- sql ---\n{sql}")
    return rows


def active_rooftops(min_calls: int, days: int) -> list[tuple]:
    """Every rooftop with >= min_calls in the window → [(enterpriseId, teamId), ...]."""
    rows = ch_rows(f"""
        SELECT enterpriseId AS ent, teamId AS team
        FROM dealer_leads.endcallreports
        WHERE createdAt>=today()-{days} AND isActive AND NOT __deleted AND NOT isTestCall
          AND enterpriseId!='' AND teamId!='' AND enterpriseId IS NOT NULL AND teamId IS NOT NULL
        GROUP BY ent, team HAVING count()>={min_calls} ORDER BY count() DESC
    """)
    return [(r["ent"], r["team"]) for r in rows if r.get("ent") and r.get("team")]


def q(s: str) -> str:
    """Single-quote a ClickHouse string literal (ids are alphanumeric, but be safe)."""
    return "'" + s.replace("'", "''") + "'"


def build_sections(ent: str, team: str, days: int) -> dict:
    E, T, D = q(ent), q(team), int(days)
    ecr_scope = f"isActive AND NOT __deleted AND NOT isTestCall AND enterpriseId={E} AND teamId={T} AND createdAt>=today()-{D}"
    mtg_scope = f"source='spyne' AND is_active=1 AND __deleted=0 AND enterprise_id={E} AND team_id={T}"

    appt_status = ch_rows(f"""
        SELECT
          coalesce(nullIf(service_type,''),'(none)')                    AS service_type,
          multiIf(call_id IS NOT NULL AND call_id!='','call','sms/chat') AS booked_via,
          count()                                                        AS booked,
          countIf(status IN ('show','completed'))                        AS showed,
          countIf(status IN ('noshow','no_show'))                        AS no_show,
          countIf(status='cancelled')                                    AS cancelled,
          countIf(status='scheduled' AND meeting_start_time>=now())      AS upcoming,
          round(countIf(status IN ('show','completed'))
                /nullIf(countIf(status IN ('show','completed','noshow','no_show')),0),4) AS show_rate
        FROM dealer_leads.meetings
        WHERE {mtg_scope} AND created_at >= today()-{D}
        GROUP BY service_type, booked_via
    """)

    transfer_quality = ch_rows(f"""
        SELECT
          countIf(callDetails_endedReason='transferred')              AS transfers_ok,
          countIf(callDetails_endedReason IN (
             'customer-ended-call-before-warm-transfer',
             'customer-ended-call-after-warm-transfer-attempt',
             'call.in-progress.error-transfer-failed','transfer_failed')) AS transfers_failed,
          countIf(callDetails_endedReason='assistant-forwarded-call')  AS forwarded,
          round(countIf(callDetails_endedReason='transferred')
                /nullIf(countIf(callDetails_endedReason IN (
                  'transferred','customer-ended-call-before-warm-transfer',
                  'customer-ended-call-after-warm-transfer-attempt',
                  'call.in-progress.error-transfer-failed','transfer_failed')),0),4) AS success_rate
        FROM dealer_leads.endcallreports WHERE {ecr_scope}
    """)

    calls_by_reason = ch_rows(f"""
        SELECT lower(report_inOutType) AS direction,
               coalesce(nullIf(report_useCase,''),'Unknown') AS reason,
               count() AS calls,
               countIf(report_overview_appointmentScheduled='Yes') AS booked
        FROM dealer_leads.endcallreports WHERE {ecr_scope}
        GROUP BY direction, reason ORDER BY calls DESC LIMIT 25
    """)

    campaigns = ch_rows(f"""
        SELECT
          c.campaignId                                AS campaign_id,
          any(c.name)                                 AS name,
          any(c.campaignStatus)                       AS status,
          dateDiff('day', max(c.startDate), now())    AS days_live,
          max(c.totalCustomersLeadCreated)            AS leads,
          countDistinctIf(t.id, t.channel='call')     AS call_tasks,
          countDistinctIf(t.id, t.channel='sms')      AS sms_tasks,
          countDistinct(m.lead_id)                    AS appts,
          round(countDistinct(m.lead_id)/nullIf(max(c.totalCustomersLeadCreated),0),4) AS conversion_rate
        FROM dealer_leads.campaigns c
        LEFT JOIN dealer_leads.outboundTasks t ON t.campaignId=c.campaignId
        LEFT JOIN dealer_leads.meetings m ON m.lead_id=t.leadId AND m.source='spyne' AND m.is_active=1 AND m.__deleted=0
        WHERE c.enterpriseId={E} AND c.teamId={T} AND c.status='active'
        GROUP BY campaign_id
    """)

    objections = ch_rows(f"""
        SELECT 'outbound_outcome' AS kind, outcome AS label, channel, count() AS count
        FROM dealer_leads.outboundTasks
        WHERE enterpriseId={E} AND teamId={T} AND createdAt>=today()-{D}
          AND outcome IN ('Not Interested','Soft Decline','Customer Permanently Declined',
                          'Already Purchased','Vehicle Sold Or Traded','Customer No Longer Owns Vehicle',
                          'Opt Out','Wrong Number')
        GROUP BY label, channel ORDER BY count DESC
    """)

    missed = ch_rows(f"""
        SELECT 'call' AS channel,
          multiIf(callDetails_endedReason='voicemail','voicemail',
                  callDetails_endedReason IN ('customer-did-not-answer','no_answer','customer-busy','busy'),'no_answer',
                  callDetails_endedReason='silence-timed-out','abandoned','other') AS category,
          count() AS count
        FROM dealer_leads.endcallreports
        WHERE {ecr_scope} AND lower(report_inOutType)='inbound'
          AND callDetails_endedReason IN ('voicemail','customer-did-not-answer','no_answer','customer-busy','busy','silence-timed-out')
        GROUP BY category
    """) + ch_rows(f"""
        SELECT 'sms' AS channel, 'sms_failed' AS category, count() AS count
        FROM dealer_leads.smsMessages s
        INNER JOIN dealer_leads.conversations cv ON cv.conversationId=s.conversationId
        WHERE cv.enterpriseId={E} AND cv.teamId={T} AND s.direction='out' AND s.status='failed' AND s.createdAt>=today()-{D}
    """)

    # Filter on the raw DateTime column in the inner query, format in the outer — aliasing the formatted
    # string AS meeting_start_time and then filtering on it would shadow the column (String >= DateTime).
    upcoming = ch_rows(f"""
        SELECT lead_id, service_type, intent, booked_via,
               formatDateTime(mst,'%Y-%m-%dT%H:%i:%SZ') AS meeting_start_time
        FROM (
          SELECT lead_id, service_type, coalesce(nullIf(intent,''),'') AS intent,
                 multiIf(call_id IS NOT NULL AND call_id!='','call','sms/chat') AS booked_via,
                 meeting_start_time AS mst
          FROM dealer_leads.meetings
          WHERE {mtg_scope} AND status='scheduled' AND meeting_start_time>=now()
          ORDER BY meeting_start_time ASC LIMIT {TOP}
        )
    """)

    follow_ups = ch_rows(f"""
        SELECT 'call_action_item' AS source, 'call' AS channel, leadId AS lead_id,
               substring(report_actionItems,1,300) AS detail,
               formatDateTime(createdAt,'%Y-%m-%dT%H:%i:%SZ') AS due_at
        FROM dealer_leads.endcallreports
        WHERE isActive AND NOT __deleted AND NOT isTestCall AND enterpriseId={E} AND teamId={T}
          AND createdAt>=today()-7 AND report_actionItems NOT IN ('','[]','[""]')
        ORDER BY createdAt DESC LIMIT {TOP}
    """) + ch_rows(f"""
        SELECT 'outbound_callback' AS source, channel, leadId AS lead_id, outcome AS detail,
               if(nextVisibleAt IS NULL, NULL, formatDateTime(nextVisibleAt,'%Y-%m-%dT%H:%i:%SZ')) AS due_at
        FROM dealer_leads.outboundTasks
        WHERE enterpriseId={E} AND teamId={T} AND outcome IN ('Callback Requested','Reconnect Needed')
        ORDER BY nextVisibleAt DESC LIMIT {TOP}
    """)

    highlights = ch_rows(f"""
        SELECT lower(report_inOutType) AS direction, report_useCase AS use_case,
               report_aiScore_totalScore AS score, substring(report_title,1,140) AS title,
               toDate(createdAt) AS occurred_on
        FROM dealer_leads.endcallreports
        WHERE {ecr_scope} AND report_overview_appointmentScheduled='Yes' AND report_aiScore_totalScore IS NOT NULL
        ORDER BY report_aiScore_totalScore DESC LIMIT {TOP}
    """)

    return {
        "appt_status": appt_status,
        "transfer_quality": transfer_quality,  # single row (array of one) — the API takes [0]
        "calls_by_reason": calls_by_reason,
        "campaigns": campaigns,
        "objections": objections,
        "missed": missed,
        "upcoming": upcoming,
        "follow_ups": follow_ups,
        "highlights": highlights,
    }


def post(base_url: str, secret: str, payload: dict) -> dict:
    url = f"{base_url.rstrip('/')}/api/reports/metrics?key={secret}"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode())
    except HTTPError as e:
        sys.exit(f"POST failed [{e.code}]: {e.read().decode()}")
    except URLError as e:
        sys.exit(f"POST failed: {e.reason}")


def push_one(ent: str, team: str, days: int, base_url: str, secret: str, dry_run: bool) -> bool:
    sections = build_sections(ent, team, days)
    payload = {"team_id": team, "window_days": days, **sections}
    if dry_run:
        print(f"[dry-run] {ent}/{team}: " + ", ".join(f"{k}={len(v)}" for k, v in sections.items()))
        return True
    result = post(base_url, secret, payload)
    ok = bool(result.get("ok"))
    print(f"{'✓' if ok else '✗'} {team} → {json.dumps(result)}")
    return ok


def main() -> None:
    load_env_local()  # so REPORTS_BASE_URL / CRON_SECRET can live in .env.local
    ap = argparse.ArgumentParser(description="Compute coming-soon metrics from ClickHouse and push to Supabase.")
    ap.add_argument("--ent", help="enterpriseId (omit with --all)")
    ap.add_argument("--team", help="teamId (omit with --all)")
    ap.add_argument("--all", action="store_true", help="sweep every active rooftop (>= --min-calls)")
    ap.add_argument("--min-calls", type=int, default=int(os.environ.get("MIN_CALLS", "50")))
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--base-url", default=os.environ.get("REPORTS_BASE_URL", ""))
    ap.add_argument("--dry-run", action="store_true", help="compute only, don't POST")
    args = ap.parse_args()

    secret = os.environ.get("CRON_SECRET")
    if not args.dry_run and (not args.base_url or not secret):
        sys.exit("Set REPORTS_BASE_URL (or --base-url) and CRON_SECRET to POST. Use --dry-run to preview.")

    if args.all:
        rooftops = active_rooftops(args.min_calls, args.days)
        print(f"Sweeping {len(rooftops)} rooftops (>= {args.min_calls} calls/{args.days}d)…")
        ok = 0
        for ent, team in rooftops:
            try:
                if push_one(ent, team, args.days, args.base_url, secret, args.dry_run):
                    ok += 1
            except (SystemExit, Exception) as e:  # one bad rooftop must not abort the sweep
                print(f"✗ {team} → {e}")
        print(f"\nDone: {ok}/{len(rooftops)} ok")
        return

    if not args.ent or not args.team:
        sys.exit("Provide --ent and --team, or use --all.")
    push_one(args.ent, args.team, args.days, args.base_url, secret, args.dry_run)


if __name__ == "__main__":
    main()
