# Client-side benchmark — ai-arch-dev → host llama.cpp server

- **Date:** 2026-08-26 (UTC)
- **Purpose:** Phase 2 first benchmark, per the corrected design: the distro
  does **not** host its own AI — it is a client/dev environment for the
  existing `llama-server` running on the host. This logs the client path
  (VM → host server), including network overhead.
- **Replaces (historical):** `2026-08-26-cpu-smoke-ai-arch-dev.md` — a
  local-hosting experiment (ollama on TCG in-VM) that the owner decided
  against 2026-08-26; kept for the record.

## Server (host, pre-existing — not part of the distro)

- `llama-server` (llama.cpp build at `/home/charlesjackson/llama.cpp/build/`),
  running under tmux session `llama`
- Model: `Qwen3.8-27B-UD-Q4_K_XL.gguf` + vision `mmproj-Qwen3.8-27B-BF16.gguf`
  (multimodal)
- Flags of note: `-ngl 99` (full GPU offload), `-c 128000`, `-fa on`,
  KV cache `q4_0`, `--spec-type draft-mtp --spec-draft-n-max 2` (speculative
  decoding), `--jinja`, `-t 16`, **`-np 1` (single slot)**, `--host 0.0.0.0
  --port 8080`
- Reachable from the VM via libvirt NAT gateway `http://192.168.122.1:8080`
  and via tailnet `http://100.79.242.24:8080` (both verified).

## Client (the distro side)

- `ai-arch-dev` VM, layer `20-ai-client`: `/etc/ai-arch/llama-server.json` +
  `ai-gen` (python3 stdlib, urllib)
- OpenAI-compatible API: `POST /v1/chat/completions`, `stream=false`,
  `max_tokens=64` (bounded — server is single-slot and also serves the owner's
  interactive session)

## Results (via NAT gateway)

| Run | Wall | Tokens | Throughput |
|---|---|---|---|
| cold (first request) | 2.94 s | 64 | 21.79 tok/s |
| warm | 1.45 s | 64 | 44.25 tok/s |

Content was clean and on-task both runs ("1, 2, 3, …") — no thinking-mode
budget burn at 27B with `--jinja`.

## Notes

- Single slot (`-np 1`): concurrent requests queue. The distro-side convention
  is bounded, serial requests (`ai-gen` has a 600 s client timeout).
- Model id is the full gguf path (server started without `--alias`); adding
  `--alias qwen3-27b` to the host server would make config/requests friendlier
  (owner's choice, host-side).
- Warm 44 tok/s includes ~1–2 ms network RTT per request round — negligible
  vs generation time at these batch sizes.
