# AI-Arch Build System (Stage D foundation)

**Status: Stage D (2026-08-27).** Authoritative for building, installing,
and rolling back the new `src/` production code (services + apps + UI
module), and for the distribution path that phase 2c/3 will formalize.
Build pipeline (OS install + layers): `docs/LAYERS.md`, decision 0005.

## 1. Toolchain

- **CMake ≥ 3.25** + **gcc** (already on the VM via 10-devtools) for
  services (C++17) and apps (C++17).
- **Qt 6** (`qt6-base`, `qt6-declarative`, `qt6-quickcontrols`) for the
  QML apps + `AIArch.Ui`; **Qt Charts** (`qt6-charts`) for Monitoring.
- **KDE Frameworks 6**: `extra-cmake-modules`, `frameworkintegration`,
  `kcoreaddons`, `kconfig`, `kdbusaddons`, `kwallet`, `knotifications`,
  `kservice` (services; the pinned set grows here only if a Stage E app
  actually needs a further framework — e.g. `solid` for hardware
  detection, `kitemviews` for C++ item views). For the plasmoid
  (Stage E): `plasma-framework`, `purpose`.
- **cmake / ninja / pkg-config** present via 10-devtools; ninja generator
  (faster on TCG than make).
- The runtime versions must match the desktop's Plasma 6.7 (same repos,
  same install — no separate Qt build).

> **Build-location note (open, pending probe):** the lab VM (TCG) is the
> **canonical build host** because the distribution path (layer 40-ai-apps)
> builds there by definition; a host-side build (fast) is the iteration
> path if the host has the same Qt6/KF6 versions — to be confirmed by a
> one-time toolchain probe (versions must match the VM's, else offscreen
> baselines drift). The probe is deferred; nothing in Stage D depends on
> its answer.

## 2. Project layout & build targets

```
src/CMakeLists.txt            # project(ai-arch), options, subdirs
src/ui/                       # AIArch.Ui QML module → /usr/lib/qt6/qml/AIArch/Ui
src/services/
  CMakeLists.txt
  common/                     # libaiarch-common (config load, sqlite helpers, logging)
  aiarch-client/              # libaiarch-client (D-Bus wrappers for all 6 services)
  configd/  aid/  permd/  contextd/  agentsd/  ragd/   # 6 executables
src/apps/
  CMakeLists.txt
  control-center/  assistant/  model-manager/  inference-manager/
  agent-manager/  rag-tools/  monitoring/  diagnostics/  workflows/
dbus/                         # org.aiarch.*.service (session) + interface XML
plasma/                       # (Stage E) plasmoid, KCM, icon theme, panel config
```

Targets per component:

| Target | Type | Installs to |
|--------|------|-------------|
| `AIArch.Ui` | QML module | `/usr/lib/qt6/qml/AIArch/Ui/` |
| `libaiarch-common`, `libaiarch-client` | shared libs | `/usr/lib/` |
| `aiarch-{configd,aid,permd,contextd,agentsd,ragd}` | executables | `/usr/bin/` |
| 9 apps | executables | `/usr/bin/ai-arch-<name>` |
| 9 `.desktop` files | | `/usr/share/applications/` |
| 6 session `.service` files | | `/usr/share/ai-arch/dbus/` + user unit dir via install |
| interface XML | | `/usr/share/dbus-1/interfaces/` (documentation) |
| `tools.json` (tool registry) | | `/usr/share/ai-arch/tools.json` |
| default config | | `/etc/xdg/ai-arch/ai-arch.json` |
| systemd user units (`aiarch-*.service`) | | `/usr/share/ai-arch/systemd/` → enabled in `~/.config/systemd/user/` at first run (via configd) |

Build layout: out-of-tree `build/` (gitignored), `cmake -G Ninja
-DCMAKE_INSTALL_PREFIX=/usr -DCMAKE_BUILD_TYPE=Release`.

## 3. Distribution path (fresh VM)

The build pipeline (`build-ai-arch-vm.sh`) is unchanged; it gains one layer:

1. `profile/layers/40-ai-apps/` (Stage E) contains:
   `install.sh` — `pacman -S` the KF6/Qt deps (pinned set), stage the
   source tree (scped into the layer dir by `tools/stage-layer-40.sh` from
   the same git commit — determinism per decision 0005), `cmake + ninja +
   ninja install`, write provenance (`/etc/ai-arch/version.json`: commit,
   date, layer list), enable user units, run `ai-arch-selftest` (below).
   `verify.sh` — manifest present, services on session bus (start+introspect
   in a headless user session or via a test session), `qmllint` clean on
   installed QML, token check passes, `ai-gen --list` reaches the
   configured endpoint (lab: NAT gateway).
2. Layer order: `10-devtools → 20-ai-client → 30-desktop →
   31-desktop-apps → 32-desktop-theme → 40-ai-apps`. 40 depends on 10
   (build tools) and 20 (endpoint config); no other coupling.
3. Build-once-per-release: the layer build happens during image build, not
   per `apply-profile.sh` iteration (TCG: a full C++ build is ~30–60 min;
   acceptable for a release image, unacceptable per iteration — see §5).

## 4. Development path (lab iteration)

Fast loop for Stage D/E work (mirrors the existing lab workflow):

1. Build on the chosen host (VM or machine with matching Qt6/KF6):
   `cmake --build build/ -j && cmake --install build/ --prefix=/tmp/ai-arch-install`.
2. `tools/deploy.sh` (new, tiny): tar the install tree → scp to VM →
   extract to `/opt/ai-arch-dev/` (never `/usr` on the lab VM — keeps the
   distribution install pristine) → restart affected user services
   (`systemctl --user restart aiarch-*` for the changed ones).
3. Run/observe in the live session (VNC); D-Bus via `dbus-send`/`qdbus`/
   `busctl` as archdev.
4. Revert = delete `/opt/ai-arch-dev`, restart services; or full rollback
   = baseline snapshot (decision 0004) — the lab VM's distro state is
   untouched by dev deploys.

Rules: dev deploys never write `/usr`, `/etc`, or user config on the lab
VM (the layer does that, during image build); `deploy.sh` refuses paths
outside `/opt/ai-arch-dev`.

## 5. Install manifest & uninstall (Stage D requirement: clean rollback)

- `cmake --install` with `CMAKE_INSTALL_SYSTEMD_*` off; the layer's
  `install.sh` captures every installed file via
  `ninja install DESTDIR=/tmp/stage` and records the file list in
  `/var/lib/ai-arch/installed-manifest` (paths + sha256).
- `ai-arch-uninstall` (installed by the layer): reads the manifest,
  removes exactly those files (dirs pruned), disables user units, leaves
  user data (`~/.config/ai-arch`, `~/.local/share/ai-arch`) — removed only
  with `--purge`. This is the "uninstall cleanly" requirement: no
  half-removed app, no orphaned theme icon breaking the panel.
- **Rollback ladder:** (1) `ai-arch-uninstall` (same image, AI layer gone,
  desktop stock); (2) disable user units only (instant AI-off); (3)
  baseline qcow2 copy (decision 0004) — full distro rollback. Each level
  is documented in RUNBOOK (Stage E adds the AI sections).
- pacman packaging (proper PKGBUILDs, AUR-ready) is the **phase 2c/3
  hardening item** (ROADMAP): the manifest approach is deliberately
  transitional so Stage D/E never blocks on package policy; the source
  layout is already packaging-shaped (single prefix, no absolute paths in
  QML, data under share/).

## 6. `ai-arch-selftest` (installed smoke check)

Installed by the layer, run by `verify.sh` and by RUNBOOK:
1. `qmllint` over installed `AIArch.Ui` + app QML (no errors).
2. Token check (`tests/check-tokens.py` vs design brief values).
3. Start each user service in the test session; assert its bus name
   acquires + introspects (6/6).
4. `ai-gen --list` (endpoint reachability, lab NAT).
5. Kill-switch toggle via D-Bus ⇒ `aid` cancels + refuses (assert on
   status).
Exit code gates the layer (fail-fast, per LAYERS.md).

## 7. Versioning & provenance

- Provenance: `/etc/ai-arch/version.json` = `{commit, date, layers[],
  qt, kf, plasma}` written by the layer install; `ai-arch-diagnostics`
  shows it; build reports include it (phase 7 report format, unchanged).
- Pinned inputs: git commit (repo), pacman versions from the live repo at
  build time (documented in the report; no ISO pinning for these packages
  yet — phase 3 hardening, consistent with D4 "no publish target yet").

## 8. Decisions

| # | Decision | Alternatives | Why rejected |
|---|----------|--------------|--------------|
| B1 | CMake + Ninja, single top-level project for `src/` | per-component CMake projects; meson (KF6 native) | one configure/build/install/manifest pass; meson would match KF6 but split the build system in the repo (preseed/pipeline is CMake-agnostic, but two systems double the docs/tests) — meson revisited if CMake pain appears |
| B2 | Distribution build happens inside the layer on the target VM (build-once-per-release) | prebuilt binaries shipped in the repo; host-build → artifact → layer install | prebuilt-in-repo violates "repo holds the recipe, not the bytes" (0005) and TCG timing is fine for release cadence; host-artifact path exists as the dev fast path (§4), not the distribution path |
| B3 | Dev deploys to `/opt/ai-arch-dev`, never `/usr` on the lab VM | install to `/usr` during iteration | keeps the lab VM's distribution state pristine (one-way: layer-built `/usr` is what verify.sh certifies); rollback = delete one dir |
| B4 | Manifest-based install/uninstall now; PKGBUILDs in 2c/3 | PKGBUILDs now | packaging policy (AUR, signing, repo) is phase 3 scope; the manifest gives clean uninstall today and the source is packaging-shaped for the swap |
| B5 | Toolchain probe (host vs VM for dev builds) deferred, VM is canonical | probe now | nothing in Stage D depends on it; the distribution path is defined either way (B2) |

## 9. Risks & open items

| Item | State / mitigation |
|------|--------------------|
| TCG build time (full C++: services + 9 apps) | expected 30–60 min; build-once-per-release (B2); dev loop uses deploy.sh (§4); first measured build updates this estimate in the build report |
| KF6/Qt6 dev packages not yet on the lab VM | layer `install.sh` adds them (pinned set §1); first dev build installs them manually once (documented in RUNBOOK) |
| Qt6/KF6 version drift between host and VM | pin "same repo state" rule + `version.json` records actual versions; baselines regenerated only when versions change (TESTING.md §3) |
| `ninja install` manifest completeness (symlinks, QML cache) | selftest re-introspects installed artifacts (catches missing pieces); uninstall dry-run in verify |
| User units enabled at first run vs at install | activation model (ARCHITECTURE.md §3): D-Bus activation is the activation mechanism; first-run enablement (configd) adds resident behavior once a user logs in, keeping `systemctl --user` state out of the image until then (avoids masked-unit noise in headless test sessions); the test harness can mask/disable the units (TESTING.md T7) — activation and residency are complementary, not conflicting |
