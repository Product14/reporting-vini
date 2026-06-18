#!/usr/bin/env bash
# Refresh the "coming soon" report metrics (AGENT_FIELDS.md widgets #9/#12/#15/#16/#19/#22/#23 +
# the showed metric) for every active rooftop: enumerate rooftops from ClickHouse and push each to
# the prod /api/reports/metrics ingest endpoint (which writes Supabase). Prod has no ClickHouse, so
# this runs on a box that has the `ch` CLI. Designed for cron — see the crontab entry that installs it.
#
# Env (overridable): REPORTS_BASE_URL (default prod), MIN_CALLS (default 50), WINDOW_DAYS (default 30).
# CRON_SECRET is read from .env.local by push_metrics.py's loader.
set -uo pipefail

# cron runs with a bare PATH — make sure ch / python3 are found.
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
REPO="/Users/devansh-cm56/reporting-vini"
cd "$REPO" || { echo "repo not found: $REPO" >&2; exit 1; }

export REPORTS_BASE_URL="${REPORTS_BASE_URL:-https://reporting-vini.vercel.app}"
MIN_CALLS="${MIN_CALLS:-50}"
WINDOW_DAYS="${WINDOW_DAYS:-30}"
LOG="$REPO/scripts/.metrics_refresh.log"
LOCK="/tmp/reporting-vini-metrics-refresh.lock"

# Prevent overlapping runs (a full sweep can take ~20 min).
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "$(date '+%F %T') skip — previous run still active" >> "$LOG"
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

echo "$(date '+%F %T') refresh start (base=$REPORTS_BASE_URL min_calls=$MIN_CALLS)" >> "$LOG"
ok=0; fail=0
while IFS= read -r pair; do
  [ -z "$pair" ] && continue
  # Defense-in-depth: skip any stray header/garbage line — only well-formed id:id pairs.
  case "$pair" in *" "* | *"("* | *"'"* | *":"*":"*) continue ;; esac
  case "$pair" in *:*) ;; *) continue ;; esac
  ENT="${pair%%:*}"; TEAM="${pair##*:}"
  if python3 scripts/push_metrics.py --ent "$ENT" --team "$TEAM" --days "$WINDOW_DAYS" >> "$LOG" 2>&1; then
    ok=$((ok + 1))
  else
    fail=$((fail + 1))
    echo "$(date '+%F %T') FAIL $TEAM" >> "$LOG"
  fi
done < <(CH_FORMAT=TabSeparated ch "SELECT concat(enterpriseId,':',teamId) FROM dealer_leads.endcallreports WHERE createdAt>=today()-${WINDOW_DAYS} AND isActive AND NOT __deleted AND NOT isTestCall AND enterpriseId!='' AND teamId!='' AND enterpriseId IS NOT NULL AND teamId IS NOT NULL GROUP BY enterpriseId, teamId HAVING count()>=${MIN_CALLS} ORDER BY count() DESC")

echo "$(date '+%F %T') refresh done: $ok ok, $fail fail" >> "$LOG"
