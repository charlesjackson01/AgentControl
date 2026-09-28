#!/usr/bin/env bash
# Layer 20-ai-client — client access to the EXISTING llama.cpp server.
#   The distro does NOT host its own AI (owner decision 2026-08-26): inference
#   runs on the host's llama-server (llama.cpp, OpenAI-compatible API). This
#   layer only wires client access:
#     /etc/ai-arch/llama-server.json  endpoint + model config (owner-editable)
#     /usr/local/bin/ai-gen           one-shot completion helper (stdlib only)
#   Lab defaults: NAT gateway http://192.168.122.1:8080; the host is also on
#   the tailnet (100.79.242.24) — the server binds 0.0.0.0, both paths work.
# Runs as root inside the installed VM. Idempotent; no secrets.
set -euo pipefail

mkdir -p /etc/ai-arch
cat > /etc/ai-arch/llama-server.json <<'JSON'
{
  "base_url": "http://192.168.122.1:8080",
  "model": "/home/charlesjackson/.cache/llama.cpp/Qwen3.8-27B-UD-Q4_K_XL.gguf",
  "max_tokens": 256,
  "notes": "Existing host llama.cpp server (single slot -np 1: queue politely). Also reachable via tailnet http://100.79.242.24:8080. Add --alias to the host server for a friendlier model id."
}
JSON

cat > /usr/local/bin/ai-gen <<'PY'
#!/usr/bin/env python3
"""ai-gen: one-shot chat completion from the configured llama.cpp server."""
import json
import sys
import urllib.request

cfg = json.load(open("/etc/ai-arch/llama-server.json"))
prompt = " ".join(sys.argv[1:]) or "hello"
body = json.dumps({
    "model": cfg["model"],
    "messages": [{"role": "user", "content": prompt}],
    "max_tokens": int(cfg.get("max_tokens", 256)),
    "stream": False,
}).encode()
req = urllib.request.Request(
    cfg["base_url"] + "/v1/chat/completions",
    data=body,
    headers={"Content-Type": "application/json"},
)
with urllib.request.urlopen(req, timeout=600) as r:
    d = json.load(r)
print(d["choices"][0]["message"]["content"])
PY
chmod +x /usr/local/bin/ai-gen

echo "20-ai-client: config + ai-gen installed (stdlib only, no local inference)"
