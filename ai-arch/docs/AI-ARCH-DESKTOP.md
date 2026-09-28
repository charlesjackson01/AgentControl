# AI-Arch Desktop — Design

Status: **2a done (2026-08-26).** KDE Plasma desktop live on the lab VM
(plasmashell running, Wayland session, SDDM autologin, screenshot-verified)
and proven on the full build path — throwaway `ai-arch-buildtest`:
preseed install → disk boot → all three profile layers PASS → 15/15 verify
PASS, zero warnings (~18 min wall, TCG). D1 decided: **KDE Plasma** (owner
green-lit 2a on the recommendation). D3/D4/D5 still pending before 2b/2c.

## Vision

AI-ARCH DESKTOP — a distributable, reproducible Arch-based desktop
distribution.

```
                     AI-ARCH DESKTOP
                            │
          ┌─────────────────┼─────────────────┐
          │                 │                 │
       NORMAL APPS       SYSTEM APPS        AI APPS
          │                 │                 │
      Browser          Settings           Models
      Files            Monitor            Agents
      Terminal                           RAG
```

Personal use is the first customer (dogfood on the lab VM);
distributability is a design constraint from day one, not a later phase.

## Product position

- **The distro ships AI *apps*, not AI *inference*.** Inference is a
  user-configured OpenAI-compatible endpoint (own host, LAN box, or cloud).
  This generalizes the 2026-08-26 pivot: the pivot made the *base* distro a
  client for the owner's host server; distribution requires the endpoint to
  be a first-class config knob instead of a hardcoded host IP.
- **Reproducible:** one git commit → one image. Pinned ISO + mirrors (done —
  primary `mirror.rackspace.com` with `mirror.arizona.edu` fallback, both
  frozen in the preseed; order chosen 2026-08-26 after arizona proved
  flaky from the lab network), pinned layer package sets.
- **Arch underneath:** we ship a *profile* on top of official Arch (pacman,
  mirrors, ABS), not a re-packaged base.

## Decisions needed (owner)

| # | Decision | Options | Recommendation |
|---|----------|---------|----------------|
| D1 | Desktop environment | KDE Plasma · GNOME · XFCE · Sway | **KDE Plasma** — official Arch ISO precedent; "Settings" + "Monitor" map 1:1 to the vision diagram (systemsettings, plasma-systemmonitor); end users run real hardware (KVM+GPU), so TCG slowness only affects our lab. XFCE if lab iteration speed wins. |
| D2 | Remote access (lab) | VNC (already wired in VM XML) · SPICE · RDP | **VNC for the lab** (zero new stack, 127.0.0.1:5900 already defined); document RDP as the product's remote option. Product is local-first on the user's own machine. |
| D3 | AI app stack (Models/Agents/RAG) | Open WebUI · AnythingLLM · LibreChat/LobeChat · minimal custom tools | **Open WebUI** — one local web app covering all three boxes against the configured endpoint (models page, chat+tools, built-in RAG). RAG needs an embeddings endpoint → host llama.cpp would take `--embeddings` (owner call, host config). **Superseded (2026-08-27):** the owner-approved Stage A concept (`docs/AI-ARCH-CONCEPT.md` §4) resolves D3 to the nine native AI apps; Stage D decision A8 (`docs/ARCHITECTURE.md` §7) records the rationale. Open WebUI remains the rejected alternative. |
| D4 | Distribution artifact | signed qcow2 per release · bootable ISO · repo-only | **Signed qcow2 per release tag** (sha256 + GPG + build provenance: exact commit, ISO version, package pins) + the git repo for tinkerers. Bootable ISO later if demand. **Repo has no remote yet — publish target (GitHub?) is part of this decision.** |
| D5 | GPU in the VM | none (host keeps RTX 3090 for the llama.cpp server) · VFIO passthrough | **None now** — the 3090 stays with the host inference server; software rendering (llvmpipe) in the VM is acceptable for lab work and the product targets users' own hardware. VFIO passthrough is a future experiment (needs host reboot + IOMMU; steals the GPU from the server while booted). |

## Architecture

### Layers (`profile/layers/`)

| Layer | Status | Contents |
|-------|--------|----------|
| `10-devtools` | done | rust, python, gcc/cmake/make |
| `20-ai-client` | done → generalize | endpoint config `/etc/ai-arch/llama-server.json` + stdlib `ai-gen` |
| `30-desktop` | done (2a) | KDE Plasma (plasma-workspace + plasma-desktop) + vision-diagram app set: firefox (Browser), dolphin (Files), konsole (Terminal), systemsettings (Settings), plasma-systemmonitor (Monitor); SDDM autologin for `archdev` |
| `31-desktop-apps` | new (2a2) | standard everyday-OS app suite (see below): kate, discover, okular, ark, gwenview, vlc, elisa, kcalc, spectacle, klevernotes, khelpcenter, partitionmanager, font-manager, keepassxc, simple-scan, flatpak, networkmanager, bluez, bluedevil, cups, bluez-cups |
| `32-desktop-theme` | done (2a3) | AI-Arch visual identity per `docs/AI-ARCH-DESIGN.md`: AIArch color scheme (dark default), `ai-arch` KWin aurorae decoration (dark titlebar + cyan accent), SHA256-pinned generated wallpaper on the Plasma desktop + SDDM login background; Plasma 6.7 wallpaper key lives in `[Containments][N][Wallpaper][org.kde.image][General]` |
| `40-ai-apps` | new (2b) | the nine native AI apps against the configured endpoint (D3 superseded — see table above); AI Control Center per concept §5.1, styled per the design brief |

### AI-client generalization (the distribution-critical change)

`/etc/ai-arch/llama-server.json` already holds `base_url` / `model` /
`max_tokens`. Product form:

- endpoint is a documented, editable config; a first-run helper
  (`ai-arch-config`) writes/validates it
- owner default: host server `http://192.168.122.1:8080`; distribution:
  "point at any OpenAI-compatible server" (llama.cpp, vLLM, cloud)
- `ai-gen` and all 40-ai-apps services read the same config

### Access

- lab VM: VNC (already in the XML) or tailnet tunnel; SSH stays the
  primary management path (key-only, unchanged)
- product: local-first; remote access documented, not required

## Standard desktop suite (2a2)

Goal: AI-Arch is a complete everyday OS **before** any AI feature.
Principle: ship established, official-repo applications (KDE-native first)
rather than reinventing; custom engineering effort goes to the AI layer and
its integrations. No AUR (reproducibility).

Three categories:

- **Core desktop** — shell, files, terminal, settings, launcher,
  notifications, system monitor, software center, update manager.
  Mostly `30-desktop` + `discover` (software center *and* update manager —
  `pamac` is gone from the repos).
- **Everyday applications** — browser (firefox), text editor (kate),
  archive (ark), image viewer (gwenview), media player (vlc), music (elisa),
  document/PDF viewer (okular), calculator (kcalc), screenshot/recording
   (spectacle), notes (klevernotes), help (khelpcenter). Code editor/IDE:
   omitted (D6 below).
- **System utilities** — storage (partitionmanager), fonts (font-manager),
  passwords (keepassxc; kwallet already built in), users (systemsettings
  KCM), network (networkmanager + Plasma applet), audio (plasma-pa),
  bluetooth (bluez + bluedevil), printers/scanners (cups + bluez-cups +
  simple-scan), clipboard history (Plasma built-in), lock screen
  (kscreenlocker, built in).

App → package map (2026-08-27, all official repos):

| App | Package | Note |
|-----|---------|------|
| Software Center | `discover` | pacman + flatpak (with `flatpak` pkg); installed/available/updates/sources |
| Update Manager | `discover` | updates view; update applet in Plasma |
| Text Editor | `kate` | syntax highlighting, tabs, line numbers |
| Archive | `ark` | integrated in Dolphin right-click |
| Image Viewer | `gwenview` | quick viewer; okular also handles images |
| Media Player | `vlc` | video/audio/subtitles/streams |
| Music | `elisa` | KDE-native library/album/playlist player |
| PDF/Docs | `okular` | PDF + images + more |
| Calculator | `kcalc` | basic + scientific + programmer |
| Screenshot/Record | `spectacle` | region/window/delay + screen recording |
| Notes | `klevernotes` | local-first markdown; `knotes` no longer packaged |
| Help Center | `khelpcenter` | + AI-Arch docs (shipped docs, 2c polish) |
| Storage | `partitionmanager` | KDE-native; `gparted` as power-user option |
| Fonts | `font-manager` | `fontmanager` (KDE) no longer packaged |
| Passwords | `keepassxc` | kwallet (built in) for app keyring integration |
| Scanners | `simple-scan` | with `cups`/`bluez-cups` for print |
| Bluetooth | `bluez` + `bluedevil` | Plasma bluetooth applet + KCM |
| IDE | **omitted (D6)** | no GUI IDE ships in the official repos (VS Code/VSCodium are AUR-only; AUR is out for reproducibility) — no editor/IDE is bundled |

**D6 — Code editor/IDE (decided 2026-08-27: omitted).** Arch's official
repos ship no GUI IDE (VS Code and VSCodium are AUR-only; AUR is out for
reproducibility). Owner decision: omit entirely — no GUI IDE layer, no
tarball workaround, no bundled editor.

**AI-layer separation (owner directive, 2026-08-27):** the normal desktop
is complete and fully functional on its own; the AI layer
(AI Control Center → Assistant/Models/Agents → RAG/Inference/Workflows →
AI System Services) makes the existing desktop smarter, never replaces it.
AI settings live under a separate AI category in System Settings (2b/2c).

## Phases

- **2a — Desktop foundation (done).** `30-desktop` layer (DE + the five
  vision-diagram apps), desktop user + autologin, display device in the
  build-script XML, access path. Iterated on lab VM → buildtest proof
  (15/15, all layers PASS, zero warnings, 2026-08-26).
- **2a2 — Standard desktop suite (done, 2026-08-27).**
  `31-desktop-apps` layer: the everyday-OS app suite above (established
  official-repo apps) + NetworkManager as product networking. Iterated on
  lab VM (config-level verify + cold-boot proof) → buildtest proof
  (15/15, all four layers PASS, zero warnings). D6 decided (omitted — no
  code editor/IDE bundled).
- **2a3 — Visual identity.** `32-desktop-theme` layer implementing the
  owner design brief (`docs/AI-ARCH-DESIGN.md`): dark glass / muted cyan
  palette, custom KWin decorations, generated wallpaper; chrome first
  (Plasma + SDDM), full component restyle later.
- **2b — AI apps.** Generalize `20-ai-client` (endpoint as product knob);
  `40-ai-apps` layer (Models/Agents/RAG, AI Control Center styled per
  `docs/AI-ARCH-DESIGN.md`). Iterate on lab VM → buildtest proof.
- **2c — Distribution hardening** (old Phase 3). Release process +
  signing + provenance, packaging split (reproducible profile vs disposable
  lab state), docs as the product (install guide, layer reference, threat
  model), known-to-work hardware matrix.
- **Baseline re-snapshot:** 2a baseline taken
  (`vms/ai-arch-baseline-with-desktop.qcow2`); **2a2 baseline taken
  2026-08-27** (`vms/ai-arch-baseline-with-suite.qcow2`, cold copy, SHA256
  verified, live-verified post-boot) — current known-good restore point
  before 2b's heavier apps.

## Environment facts (2026-08-26)

- Host: 32-core EPYC, TCG-only (no KVM), 125 GiB RAM, RTX 3090 — the 3090
  is in use by the host llama.cpp server (`-ngl 99`); do not reallocate
  without an owner decision (D5).
- Lab VM: 8 GiB RAM / 4 vCPU, VNC (`127.0.0.1:5900`, autoport) + virtio
  GPU already defined in the XML — a desktop can be booted there with no
  host-side changes.
- Build: full buildtest ≈15 min wall on TCG (install ≈10 min); buildtest
  remains the per-change gate.
- Repo: local only (no git remote) — D4 includes choosing a publish target.
