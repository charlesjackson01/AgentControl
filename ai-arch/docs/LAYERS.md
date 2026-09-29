# Layered distribution profile

**Status: PIVOTED (2026-09-26, ADR-0008).** Active set on the build path:
`10-devtools` + `20-ai-client` + **`30-hermes`** (the dedicated Hermes Agent
home base — agent runtime, gateway systemd service, headless Chromium browser,
all in the VM). The three desktop layers (`30-desktop`, `31-desktop-apps`,
`32-desktop-theme`) are **archived** in `profile/layers-archived/` (recoverable
via `git mv`, not deleted). Model inference stays on the host's existing
`llama-server` (llama.cpp, OpenAI-compatible API) — the VM is a client, not an
inference host. Design: `decisions/0008-hermes-vm-pivot.md`. Client-side
benchmark logged:
`benchmarks/2026-08-26-llama-server-client-ai-arch-dev.md`.

## Goal

A reproducible AI-focused image = **frozen preseed** (OS + access, T0) +
**ordered declarative layers** (the "distribution profile"). The VMs stay
disposable; a fresh `build-ai-arch-vm.sh` run reproduces the customized image
exactly, and the verify battery proves it.

## Mechanism

```
profile/
  layers/
    10-devtools/
      install.sh      # idempotent, runs as root inside the installed VM
      verify.sh       # assertions only; results appended to the build verify report
    20-ai-client/
      install.sh
      verify.sh
```

Rules:

- Layers apply in lexicographic order (numeric prefix = ordering).
- `install.sh`: `set -euo pipefail`, root, idempotent (safe to re-run), no
  secrets, network only to pacman mirrors + known hosts.
- `verify.sh`: checks only (no installs); non-zero exit = layer FAIL.
- Anything a layer installs/configures must be reproducible from the layer
  alone — no out-of-band VM state.

Two entry points, same layer code:

1. **`build-ai-arch-vm.sh`** — phase 6/7 (between disk boot and verify):
   for each enabled layer: scp the layer dir to the VM → run `install.sh`
   (logged to `/tmp/layer-<name>-install.log`) → run `verify.sh` → per-layer
   PASS/FAIL appended to the build verify report. Fail-fast like the rest.
2. **`scripts/apply-profile.sh`** (new) — applies layers over SSH to a running
   VM (the lab VM, owner key). This is how we iterate: change a layer in the
   repo, re-apply to the lab VM, test; a fresh build then reproduces it.

## Sourcing policy (package provenance)

1. Official Arch repos first (pacman).
2. Python: one venv per concern (`python -m venv`); pip only inside venvs —
   never system pip installs.
3. Source builds: pinned commit + recorded toolchain; last resort (builds run
   under TCG in-VM — expect ~10× wall time).
4. AUR: not yet (supply-chain + build variability); revisit per package.
5. **Model weights are NOT part of the image** — they are variable data.
   Download commands (HF, host-side `ollama pull`, etc.) live in docs/scripts,
   run on demand; storage per decisions/0007. The distro itself points at an
   existing inference server (decision 1 below), so it typically needs none.

## Initial layers (proposal)

**10-devtools**
- pacman: `rust` (1:1.98.0, extra), `python` (3.14.7), `python-pip`, `cmake`,
  `gcc`, `make` (git/openssh/curl/sudo already in preseed)
- verify: `rustc --version`, `cargo --version`, `python3 --version`

**20-ai-client**
- No inference stack in the VM (owner decision: the distro does not host its
  own AI; the host's existing `llama-server` does the inference).
- `/etc/ai-arch/llama-server.json` — endpoint + model config (owner-editable;
  lab defaults: NAT gateway `http://192.168.122.1:8080`, tailnet alternative
  `http://100.79.242.24:8080`)
- `/usr/local/bin/ai-gen` — one-shot chat completion, python3 stdlib only
  (urllib, OpenAI-compatible `/v1/chat/completions`)
- verify: config present, `/health` + `/v1/models` reachable, one small
  completion succeeds end-to-end
- (Future, if local experimentation is ever wanted: optional torch venv or
  `ollama` as a separate layer — not part of the base profile.)

**30-hermes** (dedicated Hermes Agent home base — `decisions/0008-hermes-vm-pivot.md`)
- Installs Hermes Agent **from git** (tag `v2026.9.24` → v0.21.5), not PyPI:
  the repo monolith installer `scripts/install.sh` (self-contained on Arch —
  `uv` → managed **Python 3.11** (Arch ships 3.14.7, out of `>=3.11,<3.14`),
  Node, `base-devel`, Chromium system deps via `pacman`, Playwright).
  Run as `archdev` (NOPASSWD sudo needed for the `pacman` step).
- Lands in `~/.hermes/hermes-agent` + `~/.local/bin/hermes` (non-root layout).
- Browser: Node-based `agent-browser` over CDP/websockets (NOT Playwright
  Python, NOT `hermes pm` — not a command on 0.21.4), Chromium into
  `~/.cache/ms-playwright`.
- Reads `/etc/ai-arch/llama-server.json` (written by `20-ai-client`, runs
  first) for the host `llama-server` `base_url`; model name is cosmetic;
  `context_length: 131072` (≥64K).
- Gateway: `hermes gateway install` (systemd service) + `loginctl enable-linger`
  for `archdev` so the gateway survives headless with no login session.
- verify: `hermes --version`, `~/.local/bin/hermes` present, Chromium in
  `~/.cache/ms-playwright`, config points at the host endpoint, and a real
  `hermes chat --oneshot -q "..."` returns a non-empty completion.

**30-desktop** (AI-Arch Desktop, phase 2a — `docs/AI-ARCH-DESKTOP.md`) — **ARCHIVED** in `profile/layers-archived/30-desktop` (recovered via `git mv`)
- Lean KDE Plasma set (deliberately NOT `kde-plasma-meta`), mapped to the
  vision diagram: Browser → `firefox`, Files → `dolphin`, Terminal →
  `konsole`, Settings → `systemsettings`, Monitor → `plasma-systemmonitor`;
  plus `plasma-workspace` (plasmashell binary — but NOT the shell QML),
  **`plasma-desktop` (the desktop shell QML, "org.kde.plasma.desktop" corona
  — without it plasmashell exits with 'starting invalid corona'),**
  `plasma-pa`, `plasma-workspace-wallpapers`, `sddm`, `sddm-kcm`,
  `plasma-x11-session`, `xorg-server`, `mesa`. Package set verified against
  the pinned 2026 mirror (Plasma 6.7.4): no standalone `plasmashell` /
  `plasma-wayland-session` packages, no `font-awesome` package.
- Desktop user = `archdev` (the preseed user): SDDM autologin
  (`/etc/sddm.conf.d/autologin.conf`), `graphical.target` default, no login
  prompt.
- `Session=plasma` maps to the **Wayland** session
  (`wayland-sessions/plasma.desktop`); X11 remains available as `plasmax11`.
- verify: config-level (packages incl. `plasma-desktop`, binaries, default
  target, sddm enabled, autologin config); live-desktop proof on the lab VM
  via VNC / `virsh screenshot`.

**31-desktop-apps** (phase 2a2 — `docs/AI-ARCH-DESKTOP.md`, "Standard
desktop suite") — **ARCHIVED** in `profile/layers-archived/31-desktop-apps` (recovered via `git mv`)
- The everyday-OS app suite: established official-repo apps, KDE-native
  first, no AUR, no reinvention. Everyday: `kate` (text editor), `ark`
  (archives), `gwenview` (images), `vlc` (media), `elisa` (music), `okular`
  (PDF/docs), `kcalc` (calculator), `spectacle` (screenshot/record),
  `klevernotes` (notes), `khelpcenter` (help). Core: `discover` (software
  center **and** update manager — binary is `plasma-discover`; `pamac` is
  gone from the repos), `flatpak`. System utilities: `partitionmanager`
  (storage), `font-manager` (fonts), `keepassxc` (passwords), `simple-scan`
  (scanner). Platform services: `networkmanager`, `bluez`, `bluedevil`,
  `cups`, `bluez-cups`.
- Networking switch: `systemd-networkd` (preseed's install-time stack) is
  masked (service + sockets) and **NetworkManager becomes the product
  networking** (Plasma network applet + network KCM). NM auto-connects the
  wired link; cold-boot verified (ens3 connected, SSH up).
- Gotchas found in iteration (2026-08-27): KDE's own `fontmanager` and
  `knotes` are no longer packaged (replaced by `font-manager` /
  `klevernotes`); BlueZ's package is `bluez` (not `bluetooth`); GUI apps
  abort (SIGABRT) when launched from a bare SSH session — no display env,
  Qt 6 has no offscreen fallback — test them inside the user session
  (copy env from `/proc/$(pgrep plasmashell)/environ`).
- verify: config-level (packages, exact `.desktop` entries, NM active +
  enabled + owns ens3, cups/bluetooth enabled, networkd masked).

**First benchmark (roadmap Phase 2):** client-side timed completion from the
VM against the host `llama-server`, logged to a committed report
(`benchmarks/2026-08-26-llama-server-client-ai-arch-dev.md`).

## Explicitly NOT layers

- Access/bootstrap (frozen preseed), Tailscale join (owner one-off, 0006)
- Model weights, datasets, lab-only state
- GPU stack — needs the target-host decision (cuda vs rocm); future
  `50-ai-gpu` layer, ADR when the host is known

## Decisions (owner-approved, 2026-08-26)

1. **The distro does not host its own AI.** Inference runs on the host's
   existing `llama-server` (llama.cpp, OpenAI-compatible API, full GPU
   offload, single slot). The profile provides *client* access only
   (`20-ai-client`): endpoint config + stdlib helper.
2. Layers apply to the lab VM via `scripts/apply-profile.sh` — that is the
   iteration loop; the fresh baseline snapshot is the rollback point.
3. Superseded the same day, before decision 1: a local ollama + pinned torch
   venv (`20-ai-cpu`) was implemented, applied, and benchmarked (TCG, ~0.62
   tok/s on qwen3:0.6b — `benchmarks/2026-08-26-cpu-smoke-ai-arch-dev.md`),
   then removed from the profile and the lab VM.
4. **30-desktop: KDE Plasma, lean set, `archdev` is the desktop user.**
   Owner green-lit 2a on the KDE recommendation (2026-08-26). Autologin, no
   login prompt (personal single-user desktop; key-only SSH stays the admin
   path). Wayland session (`Session=plasma`); X11 (`plasmax11`) remains
   available.

## Known gotchas (from first runs)

- The host `llama-server` is single-slot (`-np 1`) and also serves the
  owner's interactive session: bound and serialize requests (`ai-gen` has a
  600 s client timeout).
- Small qwen3-class models are thinking models: unbounded generate runs burn
  the token budget on reasoning (observed >10 min at 0.57 t/s on TCG). Bound
  calls (`max_tokens`/`num_predict`).
- Pacman package removal does NOT stop running services — after
  `pacman -Rns ollama`, `ollama serve` was still alive and had to be killed
  by PID.
- `jq` is not in the base image; use `python3` for JSON parsing in ad-hoc
  commands.
- **Plasma 6.7.4 packaging (2026):** the shell QML ("org.kde.plasma.desktop")
  ships in the separate `plasma-desktop` package, not `plasma-workspace` —
  missing it, `plasmashell` exits silently (status 1, ~1s, nothing on
  stderr); the real error `starting invalid corona "org.kde.plasma.desktop"`
  is in the **user** journal (`journalctl --user -u
  plasma-plasmashell.service`), not the system journal.
- **Mirror flakiness (2026-08-26):** `mirror.arizona.edu` (the original
  pinned mirror) showed intermittent TCP stalls ("Operation too slow. Less
  than 1 bytes/sec...") and file 404s when the synced DB lags rolling
  rebuilds. Two hard facts: the low-speed check (1 B/s over 10 s) is
  hardcoded in libalpm — **no pacman.conf option tunes it** (there is no
  `RetryTimeout`; adding one makes every pacman call warn) — and a stalled
  transfer is fatal to the *file*: pacman marks it failed and never retries
  it on the next mirror, so a flaky primary can abort the whole transaction
  even with a healthy fallback in the list. Mitigations in place:
  `mirror.rackspace.com` is now the **primary** preseed `custom_server`
  (arizona demoted to fallback — both stay frozen in the preseed for
  reproducibility, `scripts/validate-preseed.py` asserts the pin);
  `scripts/apply-profile.sh` runs `pacman -Sy` on the VM before applying
  layers. For big manual transactions, pre-staging the cache via parallel
  `curl` from a healthy mirror is the fast path.
