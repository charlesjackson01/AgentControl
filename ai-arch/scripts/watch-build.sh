#!/usr/bin/env bash
# watch-build.sh — live-stream a build to Buzz + terminal.
#
# Usage:
#   scripts/build-ai-arch-vm.sh --name hermes-vm &            # start build
#   bash scripts/watch-build.sh hermes-vm                      # follow it
#
# What it does:
#   * follows the newest build/hermes-vm-*.log
#   * on each phase boundary -> buzz_session(progress, status=working)
#   * on FATAL               -> buzz_session(status=failed) + buzz_notify
#   * on BUILD OK            -> buzz_session(status=done)     + buzz_notify
#   * mirrors log lines to stdout (tail -F)
#
# Requires: buzz MCP reachable (mcp__buzz__buzz_session / buzz_notify).
set -uo pipefail

VM_NAME="${1:-hermes-vm}"
LOG_DIR="$(cd "$(dirname "$0")/.." && pwd)/build"
LOG="$(ls -t "$LOG_DIR"/${VM_NAME}-*.log 2>/dev/null | head -1)"
[ -n "$LOG" ] || { echo "no build log for $VM_NAME in $LOG_DIR" >&2; exit 2; }

# Buzz endpoints (filled by the hermes host; override via env for testing)
BUZZ_SESSION="${BUZZ_SESSION:-http://127.0.0.1:8787/mcp/buzz/session}"
BUZZ_NOTIFY="${BUZZ_NOTIFY:-http://127.0.0.1:8787/mcp/buzz/notify}"
AUTH="${BUZZ_AUTH:-}"

buzz() {  # buzz <session|notify> <json-body>
  local kind="$1" body="$2" url
  case "$kind" in
    session) url="$BUZZ_SESSION";;
    notify)  url="$BUZZ_NOTIFY";;
  esac
  [ -n "$AUTH" ] || return 0
  curl -sS -m 5 -X POST -H "Authorization: Bearer $AUTH" -H 'Content-Type: application/json' \
       -d "$body" "$url" >/dev/null 2>&1 || true
}

PHASE_RE='phase [0-9]/[0-9]'
FATAL_RE='^FATAL:'
DONE_RE='^BUILD OK'

follow() {
  tail -F "$LOG" 2>/dev/null | while IFS= read -r line; do
    echo "$line"
    if [[ "$line" =~ $PHASE_RE ]]; then
      local p frac
      p=$(echo "$line" | grep -oE '[0-9]+' | head -1)
      frac=$(awk "BEGIN{printf \"%.2f\", $p/7}")
      buzz session "{\"session\":\"ai-arch/${VM_NAME}\",\"title\":\"build phase ${p}/7\",\"progress\":${frac},\"status\":\"working\",\"important\":true}"
    elif [[ "$line" =~ $FATAL_RE ]]; then
      buzz session "{\"session\":\"ai-arch/${VM_NAME}\",\"title\":\"build FAILED\",\"status\":\"failed\",\"important\":true}"
      buzz notify  "{\"title\":\"build FAILED\",\"body\":\"$line\"}"
    elif [[ "$line" =~ $DONE_RE ]]; then
      buzz session "{\"session\":\"ai-arch/${VM_NAME}\",\"title\":\"build done ✓\",\"progress\":100,\"status\":\"done\",\"important\":true}"
      buzz notify  "{\"title\":\"build done ✓\",\"body\":\"$VM_NAME ready\"}"
      break
    fi
  done
}

echo "watching: $LOG"
follow
