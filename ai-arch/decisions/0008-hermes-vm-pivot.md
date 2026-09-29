# 0008: Pivot — the VM becomes a dedicated private Hermes agent home base

Date: 2026-09-26

## Context

Phase 2 was built toward an Arch/KDE Plasma distro with a themed desktop and
nine native AI apps (Phase 2a/2a3 complete, Stage A/D concept work in flight
and uncommitted). The owner pivoted the project (2026-09-26): the distro
stops being a desktop and becomes a **dedicated private VM whose primary
resident is the Hermes agent** — its home base (gateway, sessions, memory,
skills, cron, headless browser) lives in the VM, isolated from the host and
reachable via Tailscale/SSH.

Facts established during the pivot research (all verified 2026-09-26):

- `hermes-agent` requires Python `>=3.11,<3.14`; Arch ships Python 3.14.7, so
  the system Python is unusable — uv-managed Python 3.11 is required.
- PyPI lags the git repo (0.19.0 vs host-proven 0.21.x); the install must come
  from `github.com/NousResearch/hermes-agent` git, not pip.
- `hermes-agent`'s `scripts/install.sh` is self-sufficient on Arch: it
  bootstraps its own uv + Python 3.11 venv, its own Node 26, installs
  `base-devel` and the Chromium system deps via pacman itself, and installs
  Playwright/Chromium into the Playwright cache.
- `hermes pm` is not a command; the browser is Node-based `agent-browser`
  (CDP/websockets), not the Playwright Python package.
- Hermes enforces a context floor of 64K; the proven config uses
  `context_length: 131072`.
- The model name in Hermes config is cosmetic — llama.cpp serves whatever is
  loaded; the loaded model on the host is variable data, not a constant.
- The host `llama-server` binds `0.0.0.0:8080` — reachable from the VM over
  the NAT gateway (192.168.122.1) and the tailnet (100.79.242.24).
- The build pipeline (ADR-0005) auto-discovers `profile/layers/*/` in
  lexicographic order and has no skip/enable mechanism — retiring a layer
  means moving its directory out of `profile/layers/`.
- `archdev` is created by the preseed with `NOPASSWD` sudo; layers run as
  root via `sudo bash install.sh` / `verify.sh`.

## Decision

1. **Mission.** The project's active deliverable is a reproducible, private,
   headless Arch Linux VM that hosts the Hermes agent as its primary
   resident. The VM is the agent's home base: `hermes` CLI, gateway,
   sessions, memory, skills, and cron live in the VM. No desktop.
2. **Keep the Phase 1 pipeline.** Frozen archinstall preseed,
   `scripts/build-ai-arch-vm.sh`, the profile-layer mechanism, and the
   Tailscale/SSH access model are unchanged (ADR-0001…0007 remain valid).
3. **Inference stays host-side.** The host's `llama-server` (3090) remains
   the only model endpoint; the VM is a client (ADR-0005's "the distro does
   not host its own AI" extends to "the VM does not host its own AI").
   `20-ai-client` is kept and remains the canonical endpoint record
   (`/etc/ai-arch/llama-server.json`).
4. **New layer `30-hermes`.** Installs Hermes agent (git, pinned tag
   `v2026.9.24` → commit `e3dd27ee2d8b011737a4eea8e3eb3d711ab78690`,
   version 0.21.5) via its self-provisioning `install.sh`, run as `archdev`
   so the layout matches the proven host install
   (`~/.hermes/hermes-agent` + `~/.local/bin/hermes` +
   `~/.cache/ms-playwright`), and writes an OpenAI-compatible provider config
   pointing at the host endpoint with `context_length: 131072`. Model name is
   not hardcoded as a requirement; whatever the server has loaded is served.
   `verify.sh` runs a real one-shot chat against the live host endpoint.
5. **Retire the desktop layers.** `30-desktop`, `31-desktop-apps`,
   `32-desktop-theme` move from `profile/layers/` to
   `profile/layers-archived/` via `git mv` (kept in git history and
   re-adoptable; no skip mechanism exists in the build script).
6. **Build target.** The clean build is named `hermes-vm`
   (`build-ai-arch-vm.sh --name hermes-vm`); the lab VM `ai-arch-dev`
   remains the desktop-era reference and is never a build target.

## Consequences

- The KDE/Stage A/D work is shelved, not deleted: desktop layers survive in
  `profile/layers-archived/` and in git history; the untracked Stage A/D
  concept batch stays in the repo as recoverable context.
- `30-hermes` must stay idempotent and self-contained (layer contract,
  ADR-0005): uv, Node, Chromium, and `base-devel` are provisioned by
  `install.sh` itself — the layer adds no pacman packages.
- A one-shot verify inside the build requires the host `llama-server` to be
  up at build time; the layer verify fails fast otherwise (correct behavior:
  no silent fallback to a different model endpoint).
- The gateway messaging platforms (Telegram etc.) remain an owner-configured
  step after the VM is built; the layer installs and configures the agent,
  not the channels.
- Reversible: restoring the desktop is `git mv` the archived layers back +
  re-applying them; the pipeline and preseed never changed.
