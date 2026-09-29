# Changelog

All notable changes to the AI-Arch project. Format: dated, newest first.

## 2026-09-26

- **Pivot: the VM becomes a dedicated private Hermes Agent home base**
  (ADR-0008, `decisions/0008-hermes-vm-pivot.md`). The desktop distro
  direction (Phase 2a/2a2/2a3) is shelved: `30-desktop`, `31-desktop-apps`,
  and `32-desktop-theme` move to `profile/layers-archived/` (recoverable via
  `git mv`; the pipeline has no skip/enable mechanism). The active layer set
  is now `10-devtools` + `20-ai-client` + `30-hermes`. New layer `30-hermes`
  installs Hermes Agent from the pinned git tag `v2026.9.24` (commit
  `e3dd27ee`, version 0.21.5) via the repo's self-provisioning
  `scripts/install.sh` — run as `archdev` (uv-managed Python 3.11, Node 26,
  `base-devel`, Chromium deps all self-provisioned; `archdev` has NOPASSWD
  sudo), writes an OpenAI-compatible provider config pointing at the host
  `llama-server` endpoint (recorded by `20-ai-client` at
  `/etc/ai-arch/llama-server.json`, `context_length: 131072`, model name
  cosmetic), and enables the `hermes-gateway` systemd service with linger.
  `verify.sh` proves the home base: hermes present + version, config points at
  the host endpoint, browser cache present, and a real one-shot chat
  completion against the live host llama.cpp server. Mission docs rewritten
  for the pivot (README, ROADMAP, LAYERS); inference stays host-side on the
  3090's `llama-server`. Build target: `--name hermes-vm`.

## 2026-08-27

- **Phase 2a3 completed: color scheme default fixed, visually verified,
  buildtest proven, baseline refreshed.** Root cause of "AIArch configured
  but apps render light" had two parts: (1) the scheme was only written to
  the per-user `kdedefaults`, while the existing user's session resolves
  from their own `kdeglobals` (no such key) falling back to
  `/etc/xdg/kdeglobals` — the layer now also writes
  `ColorScheme=AIArch` system-wide to `/etc/xdg/kdeglobals` (idempotent;
  `verify.sh` checks it), with the `kdedefaults` entry covering users
  created after the layer; (2) the remaining "light render" was a test
  artifact — a Qt app only applies the KDE color scheme when launched with
  `QT_QPA_PLATFORMTHEME=kde6` (normal session launches have it; ad-hoc
  `sudo -u` launches must set it or fall back to the light default
  palette). With the proper environment the live session resolves AIArch
  (merged `kdeglobals` + `plasma-apply-colorscheme` report it current) and
  in-app palettes match the AIArch `.colors` values exactly (window 18,22,27;
  view 14,17,20; alternate 20,24,30; accent 64,190,220). Fresh-build test
  re-run with the updated layer: PASS 15/0, all five layers (an earlier
  re-run attempt hit a transient mirror corruption — pacstrap PGP-signature
  failure on `linux`/`mkinitcpio` packages; both mirrors verified healthy
  afterwards and the re-run passed). Baseline refreshed:
  `vms/ai-arch-baseline-with-theme.qcow2` (cold copy of the lab disk,
  SHA256 `66d0efd2c43365f583407531c42a94432372bc409b2ca0f84dbda13a4052d1e8`,
  supersedes `with-suite`); `docs/RUNBOOK.md` rollback section updated and
  new "Headless lab VM: idle lock + keepalive" section added, with the
  uinput keepalive recipe moved into the repo as `tools/keepalive.c`.
- **Phase 2a3 — visual identity (chrome) implemented + verified on the lab
  VM.** `32-desktop-theme` layer: AIArch color scheme (dark, charcoal +
  muted cyan) installed as the `kdedefaults` default; `ai-arch` KWin
  aurorae QML decoration (dark titlebar, thin border, cyan accent) selected
  in `kwinrc`; SHA256-pinned generated abstract wallpaper at
  `/usr/share/wallpapers/ai-arch`; SDDM `ai-arch` theme (breeze-based) +
  `/etc/sddm.conf.d/theme.conf` for the login background. Root-caused the
  "desktop shows the default wallpaper" bug: the Plasma 6.7 image wallpaper
  plugin loads its KConfig through a KConfigLoader that wraps the plugin
  keys in a `General` group, so the key must live in
  `[Containments][N][Wallpaper][org.kde.image][General]` — the
  Plasma-5-style `wallpaperpluginorg.kde.image.Image` key in the containment
  is silently ignored (falls back to the default wallpaper). Verified
  three ways: config-level (`verify.sh` PASS), runtime (wallpaper plugin
  loads the pinned image to status Ready), and visual (desktop screenshot
  vs the pinned wallpaper: center-region Pearson correlation 1.000; KWin
  decoration dark titlebar + cyan accent confirmed on a live window).
  Also characterized the lab VM's screen locker: it locks after ~5 min of
  idle (reset by real input events — a uinput keepalive daemon keeps the
  headless TCG desktop alive) and on any new TTY/SSH session on the seat.
  Remaining: buildtest proof + baseline refresh.
- **AI-Arch visual design brief approved; phase 2a3 planned.** Owner
  design brief captured as `docs/AI-ARCH-DESIGN.md` (authoritative for
  desktop chrome + AI Control Center): dark minimalist futuristic,
  restrained sci-fi ("Tony Stark's workstation if he designed a modern
  Linux desktop"); near-black/charcoal + dark translucent glass surfaces,
  muted electric cyan primary accent with subtle blue/violet secondary;
  AI Control Center = distinct AI-product styling (custom subtle window
  decorations, glass surfaces, contextual panels, clean data viz,
  restrained animation) that still behaves as a normal desktop app;
  minimal abstract geometric wallpaper, subtle branding. Implementation
  mapped to a new `32-desktop-theme` layer (Plasma color scheme + theme,
  custom KWin decorations, SHA256-pinned generated wallpaper), phased
  chrome-first (Plasma + SDDM) before the full Plasma component restyle;
  roadmap item added as phase 2a3 (before 2b).
- **Phase 2a2 — standard desktop suite (owner directive: everyday OS apps
  before any AI apps).** New `31-desktop-apps` layer — established
  official-repo apps, KDE-native first, no AUR, no reinvention:
  everyday (kate, ark, gwenview, vlc, elisa, okular, kcalc, spectacle,
  klevernotes, khelpcenter), core (discover = software center **and** update
  manager, binary `plasma-discover`; `pamac` no longer packaged; flatpak),
  system utilities (partitionmanager, font-manager, keepassxc, simple-scan),
  platform services (networkmanager, bluez, bluedevil, cups, bluez-cups).
  Product networking switches from systemd-networkd (preseed's install-time
  stack, now masked: service + sockets) to **NetworkManager**, so the Plasma
  network applet/KCM work; NM auto-connects the wired link. Applied +
  verified on the lab VM (config-level: packages, exact `.desktop` entries,
  NM owns ens3, cups/bluetooth enabled, networkd masked) and proven on a
  cold boot (NM up, SSH up, desktop up). Apps spot-launched inside the user
  session (kcalc) — note: GUI apps SIGABRT from a bare SSH session (no
  display env; Qt 6 has no offscreen fallback), so functional tests must run
  inside the session. Packaging findings: KDE's `fontmanager` and `knotes`
  are gone from the repos (replaced by `font-manager` / `klevernotes`);
  BlueZ's package is `bluez`. D6 (code editor/IDE) decided 2026-08-27:
  **omitted entirely** — no GUI IDE in official repos, no tarball
  workaround, no bundled editor. Buildtest proof (throwaway
  `ai-arch-buildtest`, 2026-08-27, ~25 min wall, TCG): full
  `build-ai-arch-vm.sh` run → 15/15 verify PASS, all four profile layers
  PASS (`10-devtools`, `20-ai-client`, `30-desktop`, `31-desktop-apps`),
  zero warnings. New baseline `vms/ai-arch-baseline-with-suite.qcow2`
  (cold copy, SHA256 `bc0a497f…`, live-verified post-boot: NM up, desktop
  up). Design: `docs/AI-ARCH-DESKTOP.md` ("Standard desktop suite (2a2)").

## 2026-08-26

- **Phase 2a — desktop foundation complete (lab VM + buildtest).** New
  `30-desktop` layer:
  lean KDE Plasma 6.7.4 (deliberately not `kde-plasma-meta`) mapped to the
  AI-ARCH DESKTOP vision diagram — Browser → firefox, Files → dolphin,
  Terminal → konsole, Settings → systemsettings, Monitor →
  plasma-systemmonitor — plus SDDM autologin for `archdev`
  (`/etc/sddm.conf.d/autologin.conf`), `graphical.target` default, Wayland
  session (`Session=plasma`; `plasmax11` remains available). Applied +
  verified on the lab VM; live desktop confirmed after reboot:
  sddm active, `plasmashell` running under `kwin_wayland`, screenshot
  (`virsh screenshot`) fully rendered. Packaging gotcha found and fixed
  mid-iteration: the shell QML ("org.kde.plasma.desktop" corona) ships in
  the separate `plasma-desktop` package, not `plasma-workspace` — without
  it plasmashell exits silently with "starting invalid corona" in the user
  journal. Mirror resilience: the pinned `mirror.arizona.edu` proved
  flaky (TCP stalls, file 404s against a lagging rolling DB) —
  `mirror.rackspace.com` is now the **primary** preseed `custom_server`
  (arizona demoted to fallback; both stay frozen in the preseed, and
  `scripts/validate-preseed.py` now asserts the new pin). Key finding: a
  *stalled* transfer is fatal to the file even with a fallback mirror in
  the list (pacman marks it failed and never retries it on the next
  mirror), and the low-speed check (1 B/s over 10 s) is hardcoded in
   libalpm — no pacman.conf option tunes it. `scripts/apply-profile.sh`
   now runs `pacman -Sy` on the target before applying layers. Buildtest
   proof (throwaway `ai-arch-buildtest`, 2026-08-26, ~18 min wall, TCG):
   full `build-ai-arch-vm.sh` run → 15/15 verify PASS, all three profile
   layers PASS (`10-devtools`, `20-ai-client`, `30-desktop`), zero warnings.
   Next: baseline re-snapshot before 2b; 2b awaits D3/D4/D5.
   Design: `docs/AI-ARCH-DESKTOP.md` (D1 decided: KDE Plasma).
- **Phase 2 gate: build pipeline proven end-to-end with profile.** Throwaway
  `ai-arch-buildtest` (~16 min wall, TCG) ran the full `build-ai-arch-vm.sh`:
  ISO preseed install → disk boot → profile phase (`10-devtools` +
  `20-ai-client`, both PASS) → 15/15 verify PASS, including a live `ai-gen`
  completion against the host `llama-server` (sample reply "pong") — the
  profile phase is now proven on the build path, not only via
  `scripts/apply-profile.sh`. Also found + fixed a latent race: install env
  and disk env share the per-run MAC, so the ISO-env DHCP lease can linger in
  the dnsmasq table after destroy; the script now snapshots the stale lease
  set before destroy (fail-closed if empty) and accepts only a lease outside
  it. Buildtest retired after proof (T2 precedent: changelog + re-runnable
  script carry the evidence).
- **Pivot (owner decision): the distro does not host its own AI** — it is a
  client/dev environment for the host's existing `llama-server` (llama.cpp,
  Qwen3.8-27B Q4_K_XL, full GPU offload, OpenAI-compatible API on
  `192.168.122.1:8080` / tailnet `100.79.242.24:8080`). `20-ai-cpu` (ollama +
  pinned torch venv — installed and benchmarked earlier the same day) was
  removed from the profile and the lab VM (package + lingering `ollama serve`
  process + pulled model + `/opt/venvs`); new `20-ai-client` layer: endpoint
  config `/etc/ai-arch/llama-server.json` + stdlib `ai-gen` helper, verified
  end-to-end. New client-side benchmark: warm ≈44 tok/s at 64-token requests
  (`benchmarks/2026-08-26-llama-server-client-ai-arch-dev.md`); the local
  TCG experiment is kept as
  `benchmarks/2026-08-26-cpu-smoke-ai-arch-dev.md`.
- **Phase 2 started — layered profile implemented.** `profile/layers/` with
  ordered `install.sh` + `verify.sh` layers; `build-ai-arch-vm.sh` gained
  profile phase 6/7 (fail-fast, per-layer PASS/FAIL appended to the verify
  report); new `scripts/apply-profile.sh <vm-ip> [layers]` applies layers to a
  running VM (iteration loop). Layers: `10-devtools` (rust 1.98, python 3.14,
  gcc/cmake/make) and `20-ai-cpu` (ollama 0.32.15 from official extra; torch
  2.13.0+cpu pinned venv at `/opt/venvs/pytorch` — pytorch is NOT in official
  repos on the pinned mirror, verified against the live mirror 2026-08-26).
  Both layers applied + verified on the lab VM; `docs/LAYERS.md` design is now
  implemented.
- **First benchmark logged.** CPU inference smoke test on TCG: qwen3:0.6b
  (Q4_K_M) via ollama — steady state ≈0.62 tok/s generation, ≈11 tok/s prompt
  eval (4 vCPU TCG; orders of magnitude slower than native by design of the
  host, not the stack). Report:
  `benchmarks/2026-08-26-cpu-smoke-ai-arch-dev.md`.
- **Fresh baseline snapshot** `vms/ai-arch-baseline-with-tailscale.qcow2`
  (cold, SHA256-verified copy; post-Tailscale/access known-good) + disk-sizing
  ADR `decisions/0007-disk-sizing.md` (keep 120 GiB single disk; add a `/data`
  disk when variable AI data approaches ~80 GiB).

## 2026-08-25

- **T0 — frozen preseed:** `preseed/archinstall-config.json` is now the single
  declarative source of truth, verified against the ISO's actual archinstall 4.4
  source (loop-mounted airootfs.sfs), not the TUI: owner key injected for BOTH
  root and archdev (700/600, chowned), Tailscale switched from curl|sh staging to
  the official repo package (`tailscaled` enabled, join post-boot). Schema/geometry
  checks: `scripts/validate-preseed.py`.
- **T1 — `scripts/build-ai-arch-vm.sh`:** one script + frozen preseed → verified
  VM. Six fail-fast, fully-logged phases: preflight → ISO verify (sha256+GPG,
  downloads if absent) → render per-build artifacts into gitignored `build/<name>/`
  → unattended `archinstall --silent` → disk-boot switch → 15-check verify.
  IP-agnostic (dnsmasq lease resolution), per-run unique MAC, lab-VM name
  protected, serial-log tail on error.
- **T2 — build proof:** throwaway domain `ai-arch-buildtest` built end-to-end:
  "Installation completed without any errors", systemd-boot disk boot from vda,
  **15/15 verify PASS**, owner key authenticates as both `archdev` and `root`
  (T0 key injection proven). Three initial FAILs were script check-logic bugs
  (absent `hostname` binary; local `$(stat)` expansion) — fixed in the script,
  not VM defects. Lab VM `ai-arch-dev` untouched.
- **Buildtest retired:** T3 (tailnet join on a build VM) needs an owner one-off
  `tskey-auth` key (never stored by design), so the throwaway domain was torn
  down and `build/ai-arch-buildtest/` removed; T2 evidence is carried by this
  changelog + the T1 commit. Re-run `scripts/build-ai-arch-vm.sh` any time.
- Docs synced with reality: README (status/quick start/layout), ROADMAP (Phase 1),
  `docs/VM.md` + `docs/ACCESS.md` (frozen-preseed provisioning; live-verified
  sudoers drop-in is `/etc/sudoers.d/ai-arch` on the lab VM, `archdev` in
  preseed builds). ADRs recorded in `decisions/`; superseded recon scripts moved
  to `scripts/legacy/`.

## 2026-08-24

- **Access bootstrap applied to the installed VM** (via ISO-chroot pattern;
  libguestfs unavailable on host): owner key for `archdev` + `root`,
  passwordless-sudo drop-in. Verified: BatchMode key-only ssh OK, `sudo -n` OK.
- **Tailscale 1.102.3 installed** on the VM; `tailscaled` enabled + active.
- **Tailnet join RESOLVED** with a regular `tskey-auth-...` key: node
  `ai-arch-dev` joined as **100.120.185.70** (IPv6
  `fd7a:115c:a1e0::cf3a:b947`); owner ping + key-only SSH from host verified
  over the tailnet. (The earlier `tskey-client-...` OAuth key was rejected —
  client-managed keys need permitted advertise tags; gotcha documented in
  `docs/NETWORKING.md`.)
- **Baseline snapshot:** `vms/ai-arch-clean-arch-baseline.qcow2` (cold,
  SHA256-verified byte-identical copy) + `vms/SNAPSHOT-ai-arch-clean-arch-baseline.md`.
- **Reboot-verify:** ISOs detached (persistent XML edit), VM boots from `vda`,
  `systemd-boot` on ESP confirmed, timesyncd active, health OK.
- Preseed `custom_commands` expanded: owner-key for root, passwordless sudo,
  Tailscale install script — any future clean install gets full access +
  Tailscale automatically.
- Docs written: `README.md`, `docs/VM.md`, `docs/NETWORKING.md`, `docs/ACCESS.md`,
  `ROADMAP.md`, this changelog, `docs/RUNBOOK.md`.

## 2026-08-23

- **Unattended Arch install completed** from preseed (archinstall
  "Installation completed without any errors", ~20:49 UTC, monitored).
- Owner pubkey injected into installed system via preseed `custom_commands`
  (arch-chroot); hand-typed-base64 mistake caught by fingerprint mismatch and
  fixed with byte-exact `scp` copy.
- ISOs detached for disk boot; live `detach-device` refused CDROMs → persistent
  XML edit + redefine (documented in `docs/VM.md`).
- VM definition cleaned: single `<boot dev='hd'/>`, no CDROMs; serial log
  fixed (umask/ownership).
- Host recon + archinstall source notes captured in `recon/` and `state/`.
