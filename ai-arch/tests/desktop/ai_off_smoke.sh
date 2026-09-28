#!/usr/bin/env bash
# ai_off_smoke.sh — T7 skeleton: the desktop must be fully functional with
# the AI layer absent (docs/TESTING.md §8, ARCHITECTURE.md §2 AI-off guarantee).
#
# Stage D checks:
#   1. zero aiarch-* processes
#   2. no org.aiarch.* names on the user bus
#   3. session shell alive (when run inside the desktop session)
# Stage E adds the Stage C panel/launcher region suite on top of this.
set -u

fail=0

# 1. no ai-arch processes
if pgrep -f 'aiarch-(configd|aid|permd|contextd|agentsd|ragd)' > /dev/null 2>&1; then
    echo "FAIL: ai-arch processes running:"
    pgrep -af 'aiarch-' | sed 's/^/    /'
    fail=1
else
    echo "ok: no ai-arch processes"
fi

# 2. no org.aiarch.* bus names (user session bus, if present)
if command -v busctl > /dev/null 2>&1 && [ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
    if busctl --user list 2>/dev/null | grep -q 'org\.aiarch\.'; then
        echo "FAIL: org.aiarch.* names on user bus:"
        busctl --user list | grep 'org\.aiarch\.' | sed 's/^/    /'
        fail=1
    else
        echo "ok: no org.aiarch.* bus names"
    fi
else
    echo "skip: no user session bus in this context"
fi

# 3. session shell alive (only meaningful inside the desktop session)
if [ -n "${XDG_SESSION_TYPE:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ] || [ -n "${DISPLAY:-}" ]; then
    if pgrep -x plasmashell > /dev/null 2>&1; then
        echo "ok: plasmashell running"
    else
        echo "FAIL: plasmashell not running"
        fail=1
    fi
else
    echo "skip: not a desktop session"
fi

if [ "$fail" -eq 0 ]; then
    echo "ai_off_smoke: PASS"
else
    echo "ai_off_smoke: FAIL"
fi
exit "$fail"
