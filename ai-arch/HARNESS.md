# AI-Arch — harness working agreement

You are a coding harness working inside this repo. A human (Charles) reviews
your completions; an overseer (Hermes, @ai-arch-dev) prompts you, steers you
mid-task, and verifies your work before it reaches him. Read this file fully
before acting.

## Mission (one line)

A dedicated, reproducible, private **Hermes Agent VM** on Arch Linux: the VM is
the agent's home base (runtime, gateway, memory, skills, headless browser);
model inference stays on the host's `llama-server` (3090), reached over
LAN/Tailscale. See `README.md` and `decisions/0008-hermes-vm-pivot.md` for
full context.

## Repo layout (what matters)

- `scripts/build-ai-arch-vm.sh` — the ONLY build entry point. Fail-fast, 7
  phases, target 15/15 checks. Never edit it casually.
- `preseed/archinstall-config.json` — frozen install recipe. Don't change
  unless the task says so.
- `profile/layers/<NN>-*/` — install.sh + verify.sh pairs, applied in
  lexicographic order on a fresh VM. Active set: `10-devtools`,
  `20-ai-client`, `30-hermes`.
- `profile/layers-archived/` — shelved desktop layers. Don't delete; they are
  the recoverable KDE-era record.
- `decisions/` — ADRs. Read relevant ones before touching their domain.
- `docs/LAYERS.md` — the layer map; keep it in sync with any layer change.
- `vms/` — libvirt XML, serial logs, snapshots (VMs are disposable).
- `build/` — build artifacts + logs (untracked).

## Ground rules

1. **Scope discipline.** Touch only files your task names. No drive-by
   refactors. No rewrites of working scripts.
2. **No secrets.** `preseed/archinstall-creds.json` is the secret file;
   never print it, never commit it, never echo token values.
3. **VMs are disposable.** `ai-arch-dev` (lab) and `hermes-vm` (build
   target) can be destroyed/rebuilt. The durable product is the repo:
   preseed, scripts, layers, docs.
4. **Verification is mandatory.** A change is not done until its `verify.sh`
   (or the named command) passes on the real VM. Paste the pass output in
   your completion report.
5. **Layer contract.** `install.sh` runs as root, fail-fast; `verify.sh`
   proves the layer and exits non-zero on failure. `30-hermes` depends on
   `20-ai-client` writing `/etc/ai-arch/llama-server.json` — keep that
   ordering.
6. **Hermes install is pinned.** Tag `v2026.9.24`, commit
   `e3dd27ee2d8b011737a4eea8e3eb3d711ab78690`, via the repo's
   self-provisioning `scripts/install.sh` (monolith) as user `archdev`.
   Don't swap in pip, web bootstrap, or `hermes pm`.
7. **Model name is cosmetic.** The host's loaded model varies. Config must
   carry `context_length: 131072` and a generic model id — never hard-code a
   specific GGUF filename.
8. **Builds are slow** (~2h on TCG). Use a long timeout on build commands;
   poll logs instead of killing them.
9. **When blocked**, stop and say exactly what is missing. Don't guess at
   credentials, network facts, or layer internals.
10. **Report shape** (your final message must be exactly this):
    - **What changed** — files touched + one line each
    - **Evidence** — command + pass/fail output (trimmed to the decision lines)
    - **Next suggestion** — one concrete follow-up (or "none")

## Commands

- Build fresh VM: `bash scripts/build-ai-arch-vm.sh --name <vm> [--from-baseline <base>]`
- Rebuild from existing baseline (fast, ~10min): add `--from-baseline <base>`
- Apply one layer to a running VM: scp `install.sh`/`verify.sh` to
  `archdev@<vm>:/tmp/layer-<name>/`, then on the VM run
  `sudo bash /tmp/layer-<name>/install.sh && sudo bash /tmp/layer-<name>/verify.sh`
- One-shot chat test (the core proof):
  `sudo -u archdev hermes chat -q "Reply with exactly one word: pong"` → expect `pong`
- Layer status on a VM: `cat /etc/ai-arch/installed-layers.json`

## Don't

- Don't delete or rename anything under `profile/layers-archived/`.
- Don't commit build artifacts (`build/`), throwaway VM XML, or logs.
- Don't run interactive prompts in the build (use `--non-interactive`).
- Don't change the Tailscale/SSH access model without an ADR.
