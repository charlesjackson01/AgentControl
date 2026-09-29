# AI-Arch Production QML & Plasma Integration

**Status: Stage D (2026-08-27).** Authoritative for how the Stage C concept
QML (`concept/qml/`) maps to production, what the shared UI module
contains, and how the AI layer integrates with stock Plasma 6. The concept
remains the visual/IA reference and is frozen (Stage C report).

## 1. Verdicts: concept component → production

| Concept component | Verdict | Production home | Rationale |
|-------------------|---------|-----------------|-----------|
| `Theme.qml` (colors, fonts, radii, shadows) | **Keep** (refactored) | `src/ui` → `AIArch.Ui.Theme` singleton | the design-token source of truth (AIArch.colors + AIArch.fonts); same values, now also consumed by the icon theme and KCM |
| `Surface.qml` (surface tokens, alpha_, radius/shadow helpers) | **Keep** (renamed) | `AIArch.Ui.Surface` (`alpha_*` → `surfaceAlpha*`) | used by all nine apps + plasmoid |
| `Glyph.qml` (25 inline SVG icons) | **Keep** (split) | in-app: `AIArch.Ui.Glyph`; system: 9 SVG icons in AIArch icon theme | in-app chrome (toolbars, status) stays QML; .desktop/plasmoid/KCM need real icon names |
| `Chip.qml` | **Keep** | `AIArch.Ui.Chip` | status chips in apps |
| `AIBar.qml` (in-window AI chips) | **Keep** (for AI apps; semantics noted) | `AIArch.Ui.AIBar`; each AI app embeds it | Stage C's in-window AI chip concept (this file); production retains both facets — status + contextual actions, see §2 "AIBar semantics" |
| `AICommandCenter.qml` | **Superseded prototype** | re-specified per concept §5.1 in `src/apps/control-center/` (see §4.1) | Stage C's chat-oriented surface was an interaction experiment; Stage A concept §5.1/§6 (command console, **no chat surface**) is authoritative. The Stage C file is preserved unchanged under `concept/` as reference |
| `Panel.qml` (floating bottom panel, zones, AI pill) | **Conceptual** | production panel = stock Plasma panel, configured: floating, bottom, width 85%, height 48 px, AIArch color scheme, applets `kickoff \| ai-plasmoid \| tasks \| systemtray`; task-area active indicator per §10 (stock fill, see §8) | plasmashell's panel is the production object: applet model, D-Bus, SDDM lock, multi-monitor. Porting our Panel.qml would fork from Plasma updates forever. Geometry/appearance match via config + theme |
| `Launcher.qml` (720×560, AI dot 6 px) | **Conceptual** | stock Kickoff, configured (size 720×560, search row, AIArch theme); the "AI" dot = AIArch icon theme renders the nine AI app icons with the 6 px accent dot | Kickoff gives FuzzySearch, categories, D-Bus, keyboard nav for free; the dot is an icon property, not a launcher property |
| `Notification.qml` (380×88 toast, 2 px AI edge) | **Conceptual** | stock KNotification (Plasma toast); AI accent edge via notification theme — **evaluated in Stage E, may drop** (§8) | KNotification owns the stack, actions, SDDM, Wayland layer-shell; a QML toast cannot intercept stock notifications |
| `StatusControl.qml` (quick-settings grid) | **Conceptual** | stock Quick Settings (global menu → systemtray → quick settings), AIArch theme; AI status reachable from the panel plasmoid, not from a custom grid | same reason as Panel; quick-settings content is Plasma-owned |
| `WindowFrame.qml` (12 px radius, 2 px accent focus) | **Conceptual** | KWin + existing `ai-arch` aurorae decoration (32-desktop-theme already ships it); focus ring accent via KWin config/theme | KWin draws frames; a QML frame can't. The decoration already matches the concept look (Stage C used it for the captures) |
| `DesktopShell.qml`, `MockData.qml`, `main.qml`, `runner.cpp`, `apps/*.qml` | **Test-only** | `tests/` capture harness (generalized runner + MockData as a QML test model) | Stage C's purpose was pixel verification; the production equivalents are the apps + real Plasma |
| Wallpaper `v2-balanced` | **Keep** | already installed by 32-desktop-theme (unchanged) | done |

Net: **5 shared components carried into `AIArch.Ui`** (Theme, Surface,
Chip, Glyph, AIBar); the **Control Center window is re-specified** per
concept §5.1 (the Stage C chat surface is a superseded prototype,
preserved under `concept/`); **4 shell objects realized as stock Plasma +
theme/config/icons** (Panel, Launcher, Notification, StatusControl);
**1 as KWin decoration** (WindowFrame); and the Stage C harness
repurposed into `tests/`. This satisfies the Stage D §9 requirement
("state explicitly what is carried into production, what remains
conceptual") and keeps the Stage C look authoritative wherever stock
Plasma can be configured to it.

## 2. `AIArch.Ui` — shared QML module

```
src/ui/
├── CMakeLists.txt
├── qmldir                    # module AIArch.Ui
├── Theme.qml                 # colors/fonts/radii/shadows (tokens)
├── Surface.qml               # surfaceAlpha*, radius/shadow helpers
├── Chip.qml
├── Glyph.qml                 # in-app icons (25 glyphs)
├── AIBar.qml                 # in-window AI status chip (endpoint state, model, status)
├── StatusDot.qml             # shared 6 px endpoint dot (plasmoid + AIBar + KCM)
└── icons/                    # source SVGs for the AIArch icon theme (9 app icons + plasmoid)
```

- Installed to `/usr/lib/qt6/qml/AIArch/Ui` (Qt6 QML module path).
- **Token sync rule:** `AIArch.Ui.Theme` values must equal
  `AIArch.colors` / `AIArch.fonts` (design brief). A check script
  (`tests/check-tokens.py`) diffs them and runs in the build (fail on
  drift). One human edits the brief's values; both copies update in the
  same commit.
- **AIBar behavior:** two facets, both present in each AI app's header
  row:
  - **Status facet** — reads `org.aiarch.Config` + `org.aiarch.AI` over
    D-Bus: `offline` (gray dot, "AI off"/"no endpoint"), `connected`
    (cyan dot, model short name), `degraded` (amber), `working`
    (pulsing, request in flight). Absent services ⇒ static "AI
    unavailable" chip.
  - **Actions facet** — 1–2 contextual quick actions/suggestions
    relevant to the app (Stage C semantics, see below).
- **AIBar semantics (Stage C vs production — explicit, not silent):**
  Stage C's AIBar (`concept/qml/components/AIBar.qml`) = *contextual
  suggestion/action chips* for the focused window (e.g., in Files:
  "Summarize this folder"). The production AIBar **retains that
  contextual-actions facet** in the nine AI apps alongside the status
  facet; it is *not* reduced to a bare endpoint-status indicator. The
  in-window AIBar over *stock* apps (dolphin, plasma-systemmonitor, …)
  remains **deferred** (unresolved §1); nothing changes there yet.
- The AIBar is the app-side expression of the Stage C in-window AI chip
  concept; the panel plasmoid is the panel-side status expression; both
  share `StatusDot`.

## 3. App template (the nine apps)

Each app in `src/apps/<name>/`:

```
CMakeLists.txt
main.cpp            # QGuiApplication + QQmlApplicationEngine (Qt6), KF6 where needed
main.qml            # ApplicationWindow, AIArch theme, AIBar in the header row
<feature QML>
<name>.desktop      # Name, Icon=ai-arch-<name>, Categories=Utility;AI;
```

- Window: stock KWin + ai-arch aurorae decoration (radius 12, accent focus
  ring) — no custom frame (concept WindowFrame is conceptual, §1).
- Single-instance via `QDBusConnection::sessionBus().registerService`
  (assistant is the exception: `registerService` per chat id, multiple
  windows).
- D-Bus clients via `QDBusInterface` wrappers per service (small, in
  `src/services/<svc>-client/` shared lib `libaiarch-client`), so all nine
  apps share one set of interface definitions (mirrors `dbus/*.xml`).
- "AI unavailable" state: every app's root checks service availability at
  startup and on `NameAcquired`/`NameLost`; shows the offline surface
  (concept MockData's offline look), never a blank window.

## 4. Per-app integration (Stage D §7 detail)

Common to all: AIBar in header; D-Bus to L3; `.desktop` in
`/usr/share/applications`; icon `ai-arch-<name>` (AIArch theme, 6 px cyan
dot); degrades to offline surface.

1. **AI Control Center** (`ai-arch-control-center`)
   - Purpose: the AI command center (concept §5.1/§6): glanceable status,
     navigation, quick actions. It is a **console, not a chatbot** — no
     chat surface (concept §6 "Is not" list). The Stage C
     `AICommandCenter.qml` chat-oriented surface was a prototype
     interaction experiment and is **superseded** for production; it
     remains under `concept/` unchanged as reference.
   - UI (per concept §5.1 anatomy): titlebar (app name + left-rail
     collapse toggle) · left rail (Overview, Models, Agents, Inference,
     RAG, Diagnostics, Settings) · main pane · bottom status bar
     (endpoint dot + name, default model, queue depth).
     - **Overview (default):** four status tiles (Endpoint
       connected/offline + latency ms · Model loaded name or "none" ·
       Agents active/total · Queue depth) · Recent Activity feed (last
       ~10 events: time, subject, one-line outcome, status dot) · Quick
       Actions row (Start Assistant · Run diagnostics · Open Model
       Manager).
     - **Models / Agents / Inference / RAG / Diagnostics / Settings
       views:** compact summary (table/list) + "Open in …" deep link into
       the sibling app (xdg-open its `.desktop`) — summary + link, never
       embedded management (concept §6 rule).
   - AI integration: status from `org.aiarch.AI` (status, queue) +
     `org.aiarch.Config`; quick actions are D-Bus calls (launch
     assistant, PauseQueue/ResumeQueue, Cancel, diagnostics).
   - System APIs: none beyond D-Bus. Context exposed: none (it displays,
     doesn't prompt). AI-requestable actions: none (it is the console,
     not a target). Permissions: none.
2. **AI Assistant** (`ai-assistant`, multiple instances)
   - Purpose: chat with context + tools.
   - UI (concept §5.2): slim toolbar (model picker, history drawer
     toggle, new chat) · conversation view (messages, streaming) ·
     collapsible left **history drawer** (recent conversations: title,
     model, time; persistence schema is unresolved —
     AI-ARCHITECTURE.md §9.3) · context tray (pinned/attached items with
     remove) · tool-activity inline (each permission ask renders as an
     inline card with what/why/impact + Approve/Deny/Remember, mirroring
     the KNotification) · composer with model picker + max-tokens.
   - AI integration: `aid.Chat` with `tools` (assistant toolset:
     files.*, apps.launch, context.attach_file, rag.query), streaming via
     `ChatDelta`; `contextd` scope = default + its own ContextProvider
     (conversation summary, opt-in source "AI Assistant").
   - Context exposed: its own conversation (opt-in, via ContextProvider),
     user attachments.
   - AI-requestable actions: the toolset above (gated per SECURITY.md).
   - Permissions: whatever the toolset needs (R0–R2; no critical tools in
     the assistant set).
3. **Model Manager** (`ai-model-manager`)
   - UI: current model card (slot, load state), model list from
     `/v1/models` (via `aid.Models`), actions: **add model** (an
     endpoint model, or a local model path known to the endpoint server
     — the desktop never hosts inference, ARCHITECTURE.md L5), set
     default, test (one-token latency), reload, unload; per-model notes.
   - AI integration: `org.aiarch.AI` model methods; `configd` for
     `SetDefaultModel`.
   - Context: none. AI-requestable actions: none. Permissions: none
     (model control is a config action, not a tool).
4. **Inference Manager** (`ai-inference-manager`)
   - UI: queue table (request id, app, model, waited, state), pause/resume
     button, active/failed counters, slot note (`-np 1` etiquette card).
   - AI integration: `org.aiarch.AI` queue/`RequestUpdated` signals.
   - Context: none. AI-requestable: none. Permissions: none.
5. **Agent Manager** (`ai-agent-manager`)
   - UI: agent list (name, model, tools, last run), create/edit form
     (prompt, model override, tool allowlist checkboxes, max_steps), run
     now, run history (steps, status, duration, tokens), stop.
   - AI integration: `org.aiarch.Agents` full contract.
   - Context: agents receive the same default scope as the assistant
     (configurable per agent: `none | default | custom-pin`).
   - AI-requestable actions: the agent's tool allowlist (user-chosen
     subset of the registry; the form shows each tool's risk class and
     impact text from the registry).
   - Permissions: per tool class at run time.
6. **RAG Tools** (`ai-rag-tools`)
   - UI: dataset list (docs, vectors, last index), create/delete, add
     documents (file picker), remove doc, reindex, index progress, query
     box (top-k results with source + score), embeddings-availability
     state card.
   - AI integration: `org.aiarch.Rag`.
   - Context: none (datasets are explicit user data). AI-requestable:
     `rag.query` (R0). Permissions: file reads for indexing go through
     the user's file picker (the app reads them directly — the app is the
     user's agent here, not the model's; exclusions still enforced by
     ragd).
7. **AI Monitoring** (`ai-monitoring`)
   - UI: today/month cards (tokens, est. cost), per-app bar, per-model
     bar, 30-day line chart (Qt Charts), raw `UsageRange` table.
   - AI integration: `org.aiarch.AI` usage properties + `UsageRange`.
   - Context: none. AI-requestable: none. Permissions: none.
8. **AI Diagnostics** (`ai-diagnostics`)
   - UI (concept §5.8 check set): run-diagnostics button with checks —
     endpoint reachability (DNS → TCP → TLS → `/v1/models` → one-token),
     **auth (key valid)**, **default model load test, local-runtime
     process health (endpoint host), disk space for local models, queue
     depth sanity** — results panel (pass/warn/fail + one line each);
     request logs (respects `content_logging`); audit viewer (filter by
     actor/tool/decision, export range to CSV); grant list (revoke);
     config summary read-only.
   - AI integration: `org.aiarch.AI.Diagnostics/Logs`, `org.aiarch.Permits
     .Policy/Audited`.
   - Context: none. AI-requestable: none. Permissions: none.
9. **AI Workflows** (`ai-workflows`)
   - UI (concept §5.9): workflow list (name, step count, last run,
     status dot), create form (input schema → ordered steps [prompt /
     tool / rag-query / condition] → output schema), **import/export
     (JSON)**, run now, run history (per-step results).
   - AI integration: `org.aiarch.Agents` (workflow = fixed-pipeline agent,
     ARCHITECTURE.md A9).
   - Context: per workflow definition (default: `none` — workflows are
     explicit). AI-requestable: the workflow's step tools. Permissions:
     per tool class at run time.

## 5. Panel production configuration (Stage D §8)

Stock Plasma panel, configured by the AI-Arch profile (layer, Stage E):

- Geometry: floating, bottom, width 85% (of screen), height 48 px —
  matches the Stage C concept panel (1536 px of 1920).
- Layout: `Kickoff (left) | AI plasmoid (left, beside Kickoff — Stage C
  position) | Task manager (center) | System tray (right)`.
- Appearance: AIArch color scheme (plasma-style), background
  `#14171A`/85% via the theme's panel colors.
- **AI plasmoid** (`plasma/plasmoids/org.aiarch.panel/`): 28 px glyph
  (AIArch theme icon) + 6 px `StatusDot` (endpoint state, from configd/aid);
  click ⇒ AI Control Center; right-click menu: Start chat / Pause queue /
  Diagnostics / AI on-off (kill switch, with confirmation). If `configd`
  is absent: static icon, menu disabled items. This is the one custom
  Plasma component in the default configuration (Stage C panel's AI pill,
  realized as a plasmoid).
- Task-area active indicator: stock task-manager fill under the
  AIArch theme (the concept's 2 px underline is an **accepted deviation**
  unless the theme proves it expressible — unresolved §3).
- Multi-monitor: stock behavior (panel per primary; plasmoid follows).

## 6. Launcher / quick settings / notifications production

- **Launcher:** stock Kickoff; size 720×560 via KCM config; AIArch theme;
  FuzzySearch on. The 6 px AI dot on the nine app icons comes from the
  AIArch icon theme — the concept's launcher dot, realized as an icon
  property (ARCHITECTURE.md §4).
- **Quick settings:** stock; AIArch theme; no custom applets in the default
  (the concept's grid is demonstrative). AI status lives in the panel
  plasmoid (one place, not two).
- **Notifications:** stock KNotification. AI notifications are sent by the
  services via KNotification (permd confirmations, agentsd run-complete,
  ragd index-complete) with the `ai-arch` category. The 2 px cyan left
  edge: attempt via a notification theme in Stage E (unresolved §2);
  fallback = stock rendering (accepted deviation).

## 7. KWin / window integration

- Decoration: existing `ai-arch` aurorae decoration (32-desktop-theme) —
  12 px radius, 2 px accent focus ring (matches concept WindowFrame).
  Stage C used it for the captures; no new KWin work in Stage D.
- **AIBar over stock apps** (dolphin, plasma-systemmonitor): **open**
  (unresolved §1). Options: (a) KWin window-rule script overlaying an
  AIBar layer — version-sensitive, off by default behind a config flag;
  (b) no in-window chip for stock apps; their context still reaches AI
  via contextd (focused metadata) + Control Center. Default: (b) until (a)
  is proven stable on 6.7.
- SDDM: unchanged (theme optional later); the AI layer has no session-
  start dependency (no autostart units in the default config —
  services are D-Bus-activated).

## 8. Accepted deviations (concept → production)

Explicit list, per Stage D §9:

1. Task-area active indicator: stock fill (concept: 2 px accent underline).
2. Notification AI edge: stock rendering unless the Stage E notification
   theme succeeds (concept: 2 px cyan left edge).
3. Quick settings: stock grid (concept: custom 4-col grid) — identical
   function, Plasma-styled.
4. Launcher: stock Kickoff (concept: custom QML) — 720×560 + search +
   AIArch icons reproduce the concept layout.
5. In-window AIBar on stock apps: absent by default (see §7); the
   production AIBar keeps both Stage C facets (status + contextual
   actions) in the nine AI apps (see §2 "AIBar semantics").
6. Panel: stock panel object (concept: custom QML) — geometry/theme
   reproduced; the AI pill becomes the plasmoid in the **left cluster
   beside Kickoff** (Stage C position).
7. AI Control Center content: concept §5.1 console IA (tiles, left rail,
   activity feed, deep links); the Stage C chat-oriented
   `AICommandCenter.qml` is a superseded prototype, preserved under
   `concept/` unchanged.

Everything else (tokens, surfaces, chips, glyphs, Control Center content,
wallpaper, decoration, icon language) carries into production as-is.

## 9. Testing hooks (see TESTING.md)

- `AIArch.Ui` renders offscreen per app in the capture harness (1920×1080
  baseline + 1366×768, 2560×1440, 125%).
- Stage C screenshots (`concept/screenshots/stage-c/`) are the first visual
  regression baselines for the shared components (Theme/Surface/Chip/
  Glyph/AIBar/Control Center content).
- Plasmoid/KCM: verified in the live VM session (screenshot + D-Bus), not
  offscreen (they need the shell).

## 10. Decisions

| # | Decision | Alternatives | Why rejected |
|---|----------|--------------|--------------|
| P1 | Shared `AIArch.Ui` Qt6 QML module, installed system-wide | per-app copy of components | nine apps + plasmoid + KCM need one token source; copies drift (Stage C's Theme already had to sync by hand) |
| P2 | Shell objects = stock Plasma + config + theme + icons + one plasmoid | port Stage C Panel/Launcher/QuickSettings/Notification into production | ARCHITECTURE.md A7: forking plasmashell components is unmaintainable; the Stage C QML had zero Plasma integration by design (it was a concept) |
| P3 | Token sync enforced by a build-time check script | manual discipline | Stage C proved manual sync works but is fragile; the check is 20 lines |
| P4 | AIBar in AI apps; panel plasmoid for global status; no KWin overlay by default | KWin overlay for all apps now | overlay is the version-sensitive surface (RISK, ARCHITECTURE.md §9); ship the safe half first |
| P5 | AI notifications via KNotification (service-sent), not app-sent | apps send their own notifications | one sender = one style + one audit point; permd/agentsd/ragd events don't belong to any one app |

## 11. Risks & unresolved questions

| Item | State |
|------|-------|
| KWin overlay for stock apps (AIBar everywhere) | open — prototype behind flag in Stage E; default off (§7) |
| Notification accent edge | open — Stage E notification-theme evaluation (§6) |
| Task-area underline indicator | open — theme expressibility check (§5) |
| Plasma 6.7 plasmoid/KCM API stability | pinned; verify in layer verify.sh; extensions are the only version-sensitive code |
| Kickoff 720×560 exact geometry | Kickoff honors size config; verify in live capture (Stage E) |
| Icon-theme dot at small sizes (22 px panel) | dot scales to ~2 px at 22 px — check legibility in live capture; if illegible, dot only ≥32 px (accepted deviation if so) |
