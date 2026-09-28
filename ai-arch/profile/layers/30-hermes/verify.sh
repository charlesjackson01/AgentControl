#!/usr/bin/env bash
# Layer 30-hermes verify — prove the VM is a working Hermes home base.
#   Checks (as archdev): hermes command present + version, config points at the
#   host llama-server endpoint, the headless browser is provisioned, and a REAL
#   one-shot chat completion succeeds end to end (agent -> host llama.cpp).
# Runs as root (build pipeline phase-6 contract).
set -euo pipefail

TARGET_USER="archdev"
TARGET_HOME="/home/${TARGET_USER}"

run_as_user() {
  runuser -l "$TARGET_USER" -c '
    set -euo pipefail
    unset HERMES_HOME HERMES_PROFILE HERMES_SESSION_PROFILE || true
    export PATH="$HOME/.local/bin:$PATH"
    '"$1"'
  '
}

# 1. hermes command present and reporting a real version
test -x "$TARGET_HOME/.local/bin/hermes"
VERSION="$(run_as_user 'hermes --version 2>/dev/null || hermes version 2>/dev/null')"
test -n "$VERSION"
echo "30-hermes: hermes present ($VERSION)"

# 2. config points at the host endpoint (not a local inference host)
test -r "$TARGET_HOME/.hermes/config.yaml"
grep -q "base_url: http://" "$TARGET_HOME/.hermes/config.yaml"
grep -q "context_length: 131072" "$TARGET_HOME/.hermes/config.yaml"
echo "30-hermes: config -> host llama-server, context_length 131072"

# 3. headless browser provisioned (Chromium via Playwright/ms-playwright)
if [ -d "$TARGET_HOME/.cache/ms-playwright" ] && \
   find "$TARGET_HOME/.cache/ms-playwright" -name 'chrome*' -type f 2>/dev/null | grep -q .; then
  echo "30-hermes: browser (ms-playwright chromium) present"
else
  echo "30-hermes: WARNING — browser not found in ~/.cache/ms-playwright (browser tools will lazy-install on first use)"
fi

# 4. REAL one-shot completion against the host endpoint (the core proof).
#    Some model loads stream chain-of-thought before the answer, so check the
#    whole output for the expected word rather than asserting on one line.
out="$(run_as_user 'hermes chat --oneshot -q "Reply with exactly one word: pong" 2>&1')"
case "$out" in
  *pong*) echo "30-hermes: PASS (real one-shot against host llama-server: $(echo "$out" | tr -d '\r' | grep -i pong | tail -1 | head -c 80))" ;;
  *) echo "30-hermes: FAIL — one-shot output did not contain 'pong':" >&2; echo "$out" | tail -5 >&2; exit 1 ;;
esac
