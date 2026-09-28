# AI-Arch Test Strategy (Stage D foundation)

**Status: Stage D (2026-08-27).** Authoritative for how the Stage D
foundation is verified and how Stage E work will be gated. Stage C's pixel
method (pure-python PNG decode, region stats, offscreen Qt captures) is the
foundation of the UI layer and is generalized here, not reinvented.

## 1. Test layers & ownership

| Layer | What | Tooling | Runs when |
|-------|------|---------|-----------|
| T1 Unit (C++) | config merge/validate, tool-arg schema validation, permission decision table, chunker, vector cosine, usage aggregation | Qt Test (QTest) per service lib | every build (`ctest`) |
| T2 QML | lint, offscreen render, pixel regression of `AIArch.Ui` + app windows | qmllint + capture runner + pixel harness | every build (offscreen); baselines per release |
| T3 D-Bus contract | the 6 service contracts against the interface XML | `busctl introspect` diff + scripted `busctl call` sequences | every build (headless user session) |
| T4 AI behavior | gateway lifecycle, streaming, cancellation, failure modes, tool-call loop | mock OpenAI endpoint + D-Bus clients | every build |
| T5 Security | permission matrix, injection scenarios, audit integrity, kill switch, egress | per SECURITY.md §10 | every build (automated) + manual spot per release |
| T6 Desktop (live) | panel/plasmoid/KCM/KWin in the real session | VNC session + screenshot + pixel region checks | per change to `plasma/`, per release image |
| T7 Reliability (AI-off) | full desktop function with L3 stopped | desktop verification suite (Stage C tooling, generalized) | per release image |

Gates: **layer `verify.sh`** (fresh VM) = T1–T5 via `ai-arch-selftest` +
endpoint check. **Lab iteration** = T1–T4 + affected T2. **Release image**
= T1–T7.

## 2. T1 — unit tests

C++ Qt Test, one `.cpp` per module under test, registered with `ctest`
(CTest is wired in `src/CMakeLists.txt` at the Stage D foundation).
Coverage targets for the foundation: 100% of the permission decision
function (it is the security boundary), 100% of config merge precedence
(user → distro → legacy), ≥90% of tool-arg validation, chunker/vector
math exact. No mocking of D-Bus at this layer (pure functions only).

## 3. T2 — QML UI tests

- **qmllint:** every QML file in `src/` + installed output; zero errors
  (warnings tracked, new ones blocked) — same standard as Stage C.
- **Offscreen render:** the Stage C capture runner, generalized:
  `tests/runner/` loads each app's `main.qml` in `QT_QPA_PLATFORM=offscreen`
  with `AIArch.Ui` + a `TestModel` (QML-injected mock of the D-Bus state,
  replacing `MockData.qml`'s role) at fixed sizes:
  - 1920×1080 (primary), 1366×768, 2560×1440, 1920×1080 @125% scale.
  - Each app renders: default state, `ai_unavailable` state, and one
    key interaction state (e.g., assistant: mid-stream message; model
    manager: model list with 3 models).
- **Pixel regression:** the Stage C harness (pure-python PNG decode —
  no PIL, works on the VM as-is) extended to:
  - region assertions (a named rect: mean/max brightness, dominant color
    within delta, "contains accent pixel" checks — the Stage C
    `pxcheck` patterns: taskbar-zone, clock-zone, focus-border checks
    become reusable assertions),
  - full-frame diff vs baseline (perceptual delta threshold, not exact —
    antialiasing/TIMING noise; threshold tuned per baseline, recorded in
    the baseline manifest),
  - **baselines:** `tests/baselines/<app>/<state>/<size>.png` +
    `manifest.json` (sizes, thresholds, git commit). All production
    baselines are **newly generated from offscreen renders** of the
    production apps/components. The Stage C full-desktop screenshots
    (`concept/screenshots/stage-c/`) are **visual reference material**
    for the approved look (composition, palette, panel/launcher zones) —
    they are not per-app baselines (different content and composition)
    and feed the live-session region checks (T6/T7) instead.
- **Token check:** `tests/check-tokens.py` — parses
  `AIArch.Ui/Theme.qml` and the design brief's
  `AIArch.colors`/`AIArch.fonts` (docs/AI-ARCH-DESIGN.md) and asserts
  equality. Runs in T2 and in `ai-arch-selftest`.

## 4. T3 — D-Bus contract tests

- `dbus/*.xml` is the single source of truth. `tests/contract/` starts
  each service (headless user session: `machinectl`/`systemd-nspawn`-free
  approach — a dedicated `busctl` test session on the lab VM, or an
  in-process `QDBusConnection` with the service linked as a lib where
  practical), then:
  - `busctl --user introspect org.aiarch.<Svc> /org/aiarch/<Svc>` and diff
    against the XML (members, signatures) — drift fails the build.
  - scripted call sequences per service: property read, method with valid
    + invalid args (assert the exact `org.aiarch.Error.*` name), signal
    emission on the documented triggers (e.g., `Changed(endpoint)` after
    `SetEndpoint`).
- These are the tests that keep the 9 apps and the services in lockstep
  when interfaces evolve in Stage E.

## 5. T4 — AI behavior (mock endpoint)

`tests/mock-endpoint/` — a python3-stdlib OpenAI-compatible server (no
deps, runs on the VM) with **scripted behavior**:

| Script | Behavior |
|--------|----------|
| `ok` | normal chat completion (streamed in N chunks) |
| `slow` | 2 s between chunks (tests the 30 s chunk timeout only when set low via config override) |
| `fail-midstream` | streams 5 chunks then closes the socket (ChatError, partial content not marked done) |
| `bad-json` | malformed completion JSON (ChatError(Backend)) |
| `tool-call` | replies with `tool_calls` (files.read; then a second turn after the result) — verifies the full aid→permd→executor→aid loop against the real permd |
| `injection` | tool calls targeting an excluded path / unregistered tool / oversized arg (feeds T5) |
| `no-model` | `/v1/models` returns a list not containing the configured model (status `degraded`/error path) |

Tests (T4): request lifecycle happy path (queued → streaming deltas →
done + usage recorded); cancellation mid-stream (HTTP aborted, state
`cancelled`, no usage counted); queue depth signal accuracy with 3
concurrent `Chat()`; `ai_enabled=false` refusal + in-flight cancel;
endpoint change → health ping → status transition; `degraded` on
`bad-json`; usage.db rows correct per script.

## 6. T5 — security tests (per SECURITY.md §10)

Automated, D-Bus-driven against the real `permd` (no mocks — the security
tests run the real boundary):

1. **Permission matrix:** for each tool in the registry × {default policy,
   matching grant, explicit deny, kill-switch on}: assert decision,
   audit row, and (for asks) that `PermissionRequested` carried
   tool/args/purpose/class. Generated from `tools.json` (new tool ⇒
   matrix row auto-added).
2. **Injection:** mock `injection` script ⇒ every offending call denied
   with the right error, each denied call audited; model loop continues
   with the "denied by user" result (assert the agent step sees the
   denial, not a crash).
3. **Egress:** endpoint override attempt via a crafted model reply
   (e.g., a "system" message trying to set a new URL) ⇒ configd's
   endpoint is unchanged (only `SetEndpoint` can change it; no model
   path exists — assert by attempting and failing).
4. **Audit integrity:** sequence monotonic across the whole suite run;
   export-range returns the exact rows; no UPDATE/DELETE statements in
   the audit module (grep-level static check in CI).
5. **Kill switch:** mid-stream toggle ⇒ cancel + refuse + pending denied;
   restore ⇒ normal. Asserts on `Status` + `RequestUpdated`.
6. **Exclusions:** every executor path touching files checks the exclusion
   list — test: `files.read ~/.ssh/id_rsa` (even as a granted tool) ⇒
   denied + audited.

## 7. T6 — desktop (live session)

Plasma-integration surfaces cannot be tested offscreen; they are verified
in the lab VM's real session:

- **Capture:** `virsh screenshot` (console) or VNC frame grab → same
  python PNG harness; region assertions per Stage C pattern
  (panel zone, plasmoid dot zone, launcher geometry, notification zone).
- **Per surface:** plasmoid present + dot state matches configd state;
  KCM pages render + a KCM write round-trips through configd (read back
  over D-Bus); launcher 720×560 + AI icons with dot; KWin focus ring
  accent on focused window (Stage C's focus-border check, now against
  real KWin); notification toast from a real KNotification (permd ask).
- **Scale:** 125% session spot-check for the plasmoid (icon legibility,
  unresolved item P).
- Frequency: per change to `plasma/`, per release image. Each check is a
  named script in `tests/desktop/` (re-runnable, exit-code gated for
  future CI; today: run in the build report).

## 8. T7 — reliability (AI-off)

The Stage C desktop verification suite (the one that certified the
concept panel/launcher/notifications) generalized to stock Plasma:

1. Mask all `aiarch-*.service` user units + stop them.
2. Run the desktop function suite: panel present (floating, bottom,
   85%, 48 px — region checks), launcher opens + finds an app, window
   open/move/focus (KWin), notifications fire (stock sender), quick
   settings open, KRunner search works, wallpaper + theme intact.
3. All must pass with **zero** ai-arch processes (assert via `pgrep`).
4. Also run with services present but `ai_enabled: false`: same suite +
   the plasmoid shows the static "off" state.

This is the executable form of the AI-off guarantee
(ARCHITECTURE.md §2).

## 9. Tooling inventory (what exists vs. what Stage D adds)

| Tool | Status |
|------|--------|
| Pure-python PNG decode + region stats (`pxcheck` pattern) | exists (Stage C, ad-hoc scripts) → generalized to `tests/pixel/` |
| Offscreen QML capture runner | exists (Stage C `concept/qml/run/runner.cpp`) → generalized to `tests/runner/` (loads production apps + TestModel) |
| Mock OpenAI endpoint | **new** (T5, python stdlib) |
| D-Bus contract harness | **new** (T3, busctl scripts + XML diff) |
| Token check | **new** (T2, 20-line script) |
| Desktop live capture checks | **new** (T6, virsh/VNC + pixel harness) |
| AI-off desktop suite | **new** (T7, generalizes Stage C's verification) |
| CTest wiring | **new** (T1) |

**Foundation scope (explicit):** the Stage D foundation is the full
intended L3 scope — all six services (`configd`, `aid`, `permd`,
`contextd`, `agentsd`, `ragd`) with the contracts in
AI-ARCHITECTURE.md and the permission/tool scope in SECURITY.md §4
(R0 set + `files.*` + `commands.run` executors). The test obligations
below attach to that scope; the foundation is **not** defined by whatever
subset of a partial draft happens to exist at any point.

Stage D foundation implements: CTest wiring, T1 for the implemented
modules (config merge/validate, permission decision table, tool-arg
validation), T2 (qmllint + token check + AIArch.Ui offscreen baselines),
T3 for each service as it lands (foundation starts with `configd` +
`aid`), T4 mock endpoint + lifecycle tests for `aid` against it, T5 for
the implemented R0/`files.*`/`commands.run` executors, T7 skeleton
(mask services + panel/launcher region checks against stock Plasma).
T6 and the remaining T5/T4 scenarios complete with Stage E as the
surfaces they cover land.

## 10. Decisions

| # | Decision | Alternatives | Why rejected |
|---|----------|--------------|--------------|
| E1 | Pure-python pixel harness (no PIL/OpenCV) on the VM | install PIL/numpy on the VM | Stage C proved stdlib works for region stats + bounded diff; zero deps keeps the test path identical on host/VM; full-image perceptual diff uses a bounded integer implementation |
| E2 | Offscreen QML for app UI, live session for Plasma surfaces | try to test plasmoids offscreen (Plasma offscreen is not supported) | Plasma needs the shell; splitting the boundary avoids fake-green offscreen plasmoid tests |
| E3 | Mock endpoint scripted by behavior name | random/fault-injection fuzzing | deterministic scripts give exact assertions (mid-stream cut at chunk 5); fuzzing added later if a bug pattern appears |
| E4 | Security tests run the real permd, no mocks | mocked permd | the permission boundary is the security; testing a mock of it is circular |
| E5 | Baselines per release, regenerated on Qt/KF version change | per-commit baselines | antialiasing drift across Qt patch versions would churn baselines without product change; version-gated baselines record the commit they were made under |

## 11. Risks & open items

| Item | State |
|------|-------|
| Offscreen vs live rendering differences (fonts, effects) | baselines are offscreen-only for apps; live checks are region-based (no pixel-exact) — the two layers deliberately don't compare against each other |
| TCG timing for T4 streaming tests | chunk intervals configurable via test config (ms, not 30 s) so the suite runs in seconds |
| Live-session test flakiness (SDDM/autologin, VNC latency) | capture retries (3×) with settle delays; failures captured to disk for review, not just exit code |
| Baseline storage size (9 apps × states × sizes) | PNGs are small (offscreen, ~100–500 KB each); tracked in git; cap by pruning old Qt-version baselines |
| Secret storage in headless test sessions | Stage D's store is already the 0600 file (no KWallet dependency until Stage E) — nothing to fall back; see SECURITY.md §8 |
