#!/usr/bin/env bash
# Local/manual sweep of the "coming soon" report metrics for every active rooftop. Delegates to
# push_metrics.py --all (the single sweep implementation, shared with the GitHub Actions workflow).
# Prod runs this on GitHub Actions (.github/workflows/refresh-metrics.yml); use this script for a
# manual local sweep. Uses the read-only `ch` CLI locally; CRON_SECRET/REPORTS_BASE_URL from .env.local.
set -uo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
REPO="/Users/devansh-cm56/reporting-vini"
cd "$REPO" || { echo "repo not found: $REPO" >&2; exit 1; }

export REPORTS_BASE_URL="${REPORTS_BASE_URL:-https://reporting-vini.vercel.app}"
LOG="$REPO/scripts/.metrics_refresh.log"
LOCK="/tmp/reporting-vini-metrics-refresh.lock"

# A full sweep takes ~20 min — don't let runs overlap.
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "$(date '+%F %T') skip — previous run still active" >> "$LOG"
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

echo "$(date '+%F %T') refresh start (base=$REPORTS_BASE_URL)" >> "$LOG"
python3 scripts/push_metrics.py --all >> "$LOG" 2>&1
echo "$(date '+%F %T') refresh done" >> "$LOG"
