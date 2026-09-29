# CPU inference smoke test — ai-arch-dev (TCG)

- **Date:** 2026-08-26 (UTC)
- **Purpose:** Phase 2 first benchmark — log a local LLM inference smoke test.
  The point is the logged pipeline (layers → ollama → timed inference), not
  performance.
- **VM:** `ai-arch-dev` — QEMU **TCG** (no KVM), 4 vCPU (EPYC model), 8 GiB RAM,
  Arch kernel `7.1.9-arch1-2`. TCG numbers are orders of magnitude slower than
  native — do not extrapolate to real hardware.

## Stack (versions at first layer application)

| Component | Version | Source |
|---|---|---|
| ollama | 0.32.15 | official extra (layer `20-ai-cpu`) |
| torch | 2.13.0+cpu | pinned venv `/opt/venvs/pytorch` (cpu index) |
| rustc / cargo | 1.98.0 | official extra (layer `10-devtools`) |
| python | 3.14.7 | official |
| gcc | 16.2.1 | official |
| cmake | 4.4.2 | official |
| make | 4.4.1 | official |

## Model

- `qwen3:0.6b` — 751.63M params, **Q4_K_M**, 522,653,767 bytes, ctx 40960,
  digest `7df6b6e0…a435`
- Pulled on demand (`ollama pull`) — model weights are intentionally NOT part
  of the image/layers (variable data, `docs/LAYERS.md`).

## Method

`POST /api/generate` (stream=false), prompt `"Count from 1 to 20."`,
`num_predict=64`. (qwen3 is a thinking model: unbounded runs spend the token
budget on reasoning — one unbounded run kept generating for >10 min at
0.57 t/s and hung the unbounded client curl; always bound generate calls.)

## Results

| Run | Prompt eval (19 tok) | Gen (64 tok) | Total |
|---|---|---|---|
| cold (post-restart, incl. ~15 s model load) | 21.87 s — 0.87 t/s | 103.88 s — 0.616 t/s | 140.79 s |
| warm 1 | 1.72 s — 11.07 t/s | 103.68 s — 0.617 t/s | 105.57 s |
| warm 2 | 1.76 s — 10.81 t/s | 103.86 s — 0.616 t/s | 105.75 s |

**Steady state: ≈0.62 tok/s generation, ≈11 tok/s prompt eval (4 vCPU TCG).**
Run-to-run variance < 0.3%.

## Notes

- For real prompts: raise `num_predict` or disable thinking (small budgets can
  leave the `response` field empty — all tokens spent reasoning).
- ollama listens on 127.0.0.1 only; no firewall change (policy, decisions/0006).
