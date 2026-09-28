#!/usr/bin/env bash
# Layer 20-ai-client verify: config present, server reachable, one small
# completion succeeds. The server is on the HOST, not in this VM — this checks
# the client path end to end.
set -euo pipefail

test -x /usr/local/bin/ai-gen
test -r /etc/ai-arch/llama-server.json

BASE="$(python3 -c 'import json; print(json.load(open("/etc/ai-arch/llama-server.json"))["base_url"])')"

curl -fsS --max-time 10 "$BASE/health" > /dev/null
curl -fsS --max-time 10 "$BASE/v1/models" | grep -q gguf

out="$(ai-gen 'Reply with exactly one word: pong')"
test -n "$out"
echo "20-ai-client: PASS (server $BASE reachable; sample reply: $(echo "$out" | head -c 60))"
