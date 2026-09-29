# AI-Arch Desktop Experience Concept

Status: **Concept specification (Stage A, 2026-08-27).** Approved for concept
rendering (Stages B–D: wallpaper candidates, QML prototypes, composition
screenshots). Production implementation explicitly **not** started.

Authority: `docs/AI-ARCH-DESIGN.md` remains the visual-direction brief
(aesthetic, materials, typography). This document is authoritative for the
workspace concept, application IA, panel/launcher/icon specification, and
concept-shot compositions. Product phasing stays in `AI-ARCH-DESKTOP.md` +
`ROADMAP.md`.

Scope guard: this document specifies a concept. It creates no code, touches
no VM, modifies no Plasma behavior, and pins no production asset.

---

## 1. Workspace philosophy

AI-Arch is a **complete, general-purpose Linux desktop with AI deeply
integrated** — not an AI dashboard and not an AI-themed theme.

- AI makes the desktop smarter. AI does not replace the desktop.
- The desktop must be usable day-to-day with zero AI apps open: files,
  terminal, browser, settings, monitoring, software management, networking,
  audio, notifications.
- AI is layered on top as a **set of independent first-class applications**
  (§4) plus one dedicated System Settings category (§12) — the same way a
  normal OS ships `systemsettings` or `plasma-systemmonitor`.
- The future is not "AI replaces the user's workflow." The future is a
  professional workstation where AI is as native as the file manager:
  present, capable, and out of the way until invoked.
- Aesthetic: "a professional Linux workstation that Tony Stark designed."
  Futurism comes from materials, transparency, typography, spacing, and
  hierarchy — not from HUDs, neon, or holograms.

## 2. Complete Linux desktop philosophy

The workspace reads as a real desktop distro because every OS function maps
to a real, first-party application from official repositories (project rule:
no AUR, no re-implemented system components):

- **Desktop shell** — Plasma 6 desktop, floating panel, window manager with
  the custom `ai-arch` KWin decoration, SDDM login.
- **Launch + search** — Kickoff launcher, KRunner global search.
- **Windowing** — real KWin windows: independently openable, focusable,
  movable, resizable, minimizable; every app appears on the task area.
- **Files / terminal / browser** — Dolphin, Konsole, Firefox.
- **System administration** — System Settings, System Monitor, Discover
  (software + Flatpak), Partition Manager, KeepassXC, font manager, scanner.
- **Services** — NetworkManager, audio, Bluetooth, CUPS printing,
  notifications.
- **AI layer** — nine AI-native applications + one Settings category (§12),
  all reading one shared endpoint configuration.

The AI layer is visually of the same family as the OS (same palette, same
decoration, same typography) so it reads as "part of this desktop," while
the app *content* carries the slightly more refined AI-product character
from the brief.

## 3. Normal application ecosystem

First-class OS applications (all verified present on the lab VM; all stock,
tinted only by the system-wide AIArch color scheme):

| Role | Application |
|------|-------------|
| Files | dolphin |
| Terminal | konsole |
| Browser | firefox |
| System settings | systemsettings |
| System monitor | plasma-systemmonitor |
| Software manager | plasma-discover |
| Text editor | kate |
| Archive manager | ark |
| Image viewer | gwenview |
| Video | vlc |
| Document reader | okular |
| Notes | klevernotes |
| Music | elisa |
| Calculator | kcalc |
| Screenshots | spectacle |
| Help | khelpcenter |
| Partitioning | partitionmanager |
| Passwords | keepassxc |
| Fonts | font-manager |
| Scanning | simple-scan |
| Networking / audio / printing / Bluetooth | networkmanager, bluedevil, cups, bluez |
| Global search | krunner |

Terminal-native AI access: the `ai-gen` CLI (layer `20-ai-client`) is part
of the normal OS experience — an AI endpoint reachable from any shell, not
a GUI-only feature.

## 4. AI application ecosystem

Nine **independent, first-class AI applications**. Each is its own launchable
program with its own icon, its own window, its own entry in the launcher,
its own `.desktop` identity, and its own purpose. None is a tab of another;
none is a section of a mega-app.

| # | App | Identity (concept) | One-liner |
|---|-----|--------------------|-----------|
| 1 | AI Control Center | `ai-control-center` | The AI command center: status at a glance, navigation, quick actions |
| 2 | AI Assistant | `ai-assistant` | Conversational interface to the configured endpoint |
| 3 | Model Manager | `ai-model-manager` | Catalog + lifecycle of local and remote models |
| 4 | Inference Manager | `ai-inference-manager` | Live view of active requests, queue, throughput |
| 5 | Agent Manager | `ai-agent-manager` | Define, schedule, run, and monitor AI agents |
| 6 | RAG Tools | `ai-rag-tools` | Knowledge sources (datasets) the AI apps query |
| 7 | AI Monitoring | `ai-monitoring` | Usage, tokens, cost, latency over time |
| 8 | AI Diagnostics | `ai-diagnostics` | Health checks, logs, repair actions |
| 9 | AI Workflows | `ai-workflows` | Multi-step AI pipelines |

Shared conventions (apply to all nine):

- **Window chrome:** all nine use the same custom `ai-arch` KWin decoration
  as OS windows — one decoration family for the whole OS. The "custom
  understated window decoration" from the brief is satisfied by the ai-arch
  decoration itself (it replaces stock Breeze); the AI character lives in
  content styling, hierarchy, and status language, not in a divergent
  titlebar. (A per-window refined titlebar variant, if ever wanted, is a
  KWin per-window-rule concern for the implementation phase — out of
  concept scope.)
- **Window behavior:** normal KWin windows. Multiple instances allowed only
  for AI Assistant (parallel conversations); the other eight are single
  instance — launching focuses the existing window.
- **Config source of truth:** the System Settings **AI** category (§12).
  Every app reads it; per-app "Settings" views show a summary and link out —
  no duplicated endpoint/key entry anywhere in the AI apps.
- **Cross-navigation:** apps link to each other with actions ("Open in
  Model Manager"), never by embedding each other's UI.
- **Status language:** consistent dots + text, token colors (§7).
- **Data in the concept:** representative sample data (one local model, one
  remote model, two agents, one dataset, a short activity feed) — clearly
  plausible, never lorem ipsum.

## 5. AI application IA specifications

Each spec covers: purpose, window anatomy, views with element hierarchy,
primary/secondary actions, status language, empty state, error state, and
explicit boundaries.

### 5.1 AI Control Center (`ai-control-center`)

- **Purpose:** the AI command center for the OS — glanceable AI status,
  navigation to the eight sibling apps, quick actions. It is a command
  center, **not** the operating system (boundaries: §6).
- **Anatomy:** titlebar (app name + left-rail collapse toggle) · left rail
  (Overview, Models, Agents, Inference, RAG, Diagnostics, Settings) ·
  main pane · bottom status bar (endpoint dot + name, default model, queue
  depth).
- **Views:**
  - **Overview (default):** status strip — four compact tiles: Endpoint
    (connected/offline + latency ms), Model (loaded name or "none"),
    Agents (active/total), Queue (depth). Below: Recent Activity list
    (last ~10 events: agent run, model load, request burst — time, subject,
    one-line outcome, status dot). Below: Quick Actions row (Start
    Assistant · Run diagnostics · Open Model Manager).
  - **Models:** compact summary table (top 5 models: name, source, status
    dot) + "Open in Model Manager." No catalog management here.
  - **Agents:** compact list (name, status dot, last run) + "Open in Agent
    Manager."
  - **Inference:** current load summary (active, queued, tokens/s) + one
    thin sparkline (last hour).
  - **RAG:** dataset count, index health summary (n indexed / n stale) +
    link out.
  - **Diagnostics:** health summary (endpoint reachability, auth, model
    load test — pass/warn/fail icons + one line each) + "Open in AI
    Diagnostics" for the full report.
  - **Settings:** summary of the AI category (endpoint, default model,
    privacy) + "Open System Settings."
- **Primary actions:** Start Assistant, Run diagnostics.
- **Secondary actions:** every "Open in …" link; per-row status detail.
- **Status language:** endpoint dot (green connected / red offline /
  yellow degraded); tiles neutral until hovered/focused.
- **Empty state:** "No AI activity yet — connect an endpoint to begin" +
  the endpoint status tile shows the reason.
- **Error state:** status bar flips red; the Overview's first tile expands
  into a two-line error (e.g., "Endpoint unreachable — last check 12:04")
  with a "Run diagnostics" action.

### 5.2 AI Assistant (`ai-assistant`)

- **Purpose:** conversational interface to the configured endpoint.
- **Anatomy:** titlebar · slim toolbar (model picker showing the current
  model name, history drawer toggle, new chat) · message list · input bar
  (auto-growing textarea + attach chip slot + send).
- **Views:** single main view (conversation) + collapsible left history
  drawer (recent conversations: title, model, time).
- **Elements:** user messages on a slightly raised glass chip, right
  aligned; assistant messages on base glass, full width; inline markdown;
  code blocks in Noto Sans Mono with a copy affordance; per-message
  micro-label (model · latency · tokens) in 11 px secondary text.
- **Primary actions:** send, new chat, switch model.
- **Secondary actions:** copy message, open conversation from history,
  attach context (file or RAG dataset chip).
- **Status language:** streaming text appears incrementally; "thinking" is
  a thin three-dot pulse (the only permitted ambient animation in the
  concept); per-message result dot (green success / red failure).
- **Empty state:** "Ask anything — model: <default>" + three suggested
  prompts.
- **Error state:** inline error row in the conversation (endpoint offline /
  auth failed / timeout) with Retry; the input bar stays usable.

### 5.3 Model Manager (`ai-model-manager`)

- **Purpose:** catalog and lifecycle of models (local runtime + remote
  endpoint).
- **Anatomy:** titlebar · toolbar (search, filter: All / Local / Remote /
  Loaded, Add model) · catalog table · detail pane (right, ~32 % width).
- **Catalog columns:** name · source (local path / endpoint) · parameters +
  context · status dot · actions (icon row: load, unload, set default,
  test).
- **Detail pane:** model metadata (architecture, quant, size, context,
  capabilities), a Test action (small ping with a sample prompt, result
  inline), actions.
- **Primary actions:** add model (endpoint model or local import), load,
  set as default.
- **Secondary actions:** test, unload, delete (confirm), copy path/ID.
- **Status language:** loaded (cyan dot), available (gray), error (red),
  syncing/importing (yellow, with progress fraction).
- **Empty state:** "No models yet — add an endpoint or import a local
  model" + the two actions.
- **Error state:** row-level error (load failed) with one-line cause +
  "Details" (links to Diagnostics) + Retry.

### 5.4 Inference Manager (`ai-inference-manager`)

- **Purpose:** live view of inference work — what is running, what is
  queued, how fast.
- **Anatomy:** titlebar · toolbar (pause/resume queue, clear completed) ·
  stats row (requests/min · p50 latency · tokens/s — numbers primary, one
  thin sparkline) · Active section (list: source app, model, started,
  elapsed, cancel action) · Queue section (position, source, model, waited,
  cancel action).
- **Primary actions:** pause/resume queue, cancel request.
- **Secondary actions:** retry failed, clear completed, filter by source.
- **Status language:** running (cyan), queued (gray), failed (red),
  cancelled (dim).
- **Empty state:** "No inference activity" (active + queue both empty) —
  calm, not alarming.
- **Error state:** failed request row with cause (timeout / model not
  loaded) + Retry.

### 5.5 Agent Manager (`ai-agent-manager`)

- **Purpose:** define, schedule, run, and monitor AI agents (task
  automation against the endpoint).
- **Anatomy:** titlebar · toolbar (New agent, filter by status) · two-pane
  body: agent list (left) + detail (right).
- **Agent list columns:** name · status dot (running / idle / failed /
  disabled) · trigger (manual / schedule / event) · last run.
- **Detail pane:** config summary (goal/prompt, model, tools, schedule,
  guardrails) with Edit; actions (Run now, Enable/Disable, Delete); Run
  history (time, duration, status dot, one-line outcome; expandable log per
  run, Noto Sans Mono).
- **Primary actions:** New agent, Run now.
- **Secondary actions:** edit config, view/expand run log, Enable/Disable,
  Delete (confirm).
- **Status language:** running (cyan + elapsed), idle (gray), failed (red),
  disabled (dim).
- **Empty state:** "No agents yet — create your first agent" + New agent.
- **Error state:** failed run expanded by default in history with the error
  line + Retry run.

### 5.6 RAG Tools (`ai-rag-tools`)

- **Purpose:** manage knowledge sources (datasets) that AI apps query.
- **Anatomy:** titlebar · toolbar (New dataset, Import) · two-pane body:
  dataset list (left) + detail (right).
- **Dataset list columns:** name · source type (folder / files / url) · doc
  count · index status (indexed / indexing / stale / error) · last updated.
- **Detail pane:** document table (name, size, chunks, per-doc status) ·
  index actions (Index now, Reindex, Remove doc) · dataset settings (chunk
  size, notes).
- **Primary actions:** New dataset, Index now.
- **Secondary actions:** Reindex, remove document, export dataset.
- **Status language:** indexed (green), indexing (yellow + progress
  fraction), stale (yellow), error (red).
- **Empty state:** "No datasets yet — point a dataset at a folder or file
  set."
- **Error state:** indexing failure with cause + Reindex.

### 5.7 AI Monitoring (`ai-monitoring`)

- **Purpose:** usage and performance over time — volume, tokens, cost
  (when the endpoint reports it), latency.
- **Anatomy:** titlebar · toolbar (time range: 1h / 24h / 7d / 30d) ·
  metrics grid (six small cards: requests · tokens in · tokens out · cost ·
  errors · p95 latency — each: big number + delta vs previous period + one
  thin sparkline) · breakdowns (By app and By model: compact horizontal
  bar lists, numbers right-aligned).
- **Primary actions:** change time range, export report.
- **Secondary actions:** copy number, jump to Diagnostics (from the errors
  card).
- **Status language:** neutral; the errors card turns red-tinged only when
  error rate > 0; deltas are colored by meaning (down is good for
  latency/errors, up is good for throughput) — encoded in text, never in
  chart decoration.
- **Empty state:** "No usage data in range."
- **Error state:** n/a (it displays errors; it does not fail the way
  request-path apps do).

### 5.8 AI Diagnostics (`ai-diagnostics`)

- **Purpose:** health checks, logs, and repair actions for the AI
  subsystem only (the OS itself has plasma-systemmonitor — no overlap).
- **Anatomy:** titlebar · toolbar (Run full check, log filters: level /
  source / time, Export log) · health summary (list of checks, each:
  pass/warn/fail icon + name + one-line detail + ms where relevant) · log
  viewer (Noto Sans Mono: timestamp · level · source · message).
- **Checks (concept set):** endpoint reachability (ping + latency) · auth
  (key valid) · default model load test · local runtime process health ·
  disk space for local models · queue depth sanity.
- **Primary actions:** Run full check, Run quick fix (reconnect, re-auth,
  clear queue — context-sensitive per failed check).
- **Secondary actions:** filter logs, export log, open source app (e.g.,
  "Open in Model Manager" from a model check).
- **Status language:** pass (green) / warn (yellow) / fail (red) icons;
  overall banner: "All systems normal" / "1 warning" / "2 failures."
- **Empty state (first run):** "Run the full check to establish a baseline."
- **Error state:** a failed check *is* the error state; each carries the
  one-line cause + the matching quick fix.

### 5.9 AI Workflows (`ai-workflows`)

- **Purpose:** multi-step AI pipelines: ordered steps (prompt → transform →
  model call → … → output) that run as a unit.
- **Anatomy:** titlebar · toolbar (New workflow, Import, Export) ·
  two-pane body: workflow list (left) + detail (right).
- **Workflow list columns:** name · step count · last run · status dot.
- **Detail pane:** ordered step list (each: index, type [model call /
  transform / condition / output], name, model (for model-call steps),
  expandable last-output preview — Noto Sans Mono, truncated) · actions
  (Run now, Edit steps, Delete) · run history (time, duration, status,
  expandable per-step results).
- **Primary actions:** New workflow, Run now.
- **Secondary actions:** edit step order (up/down — no node canvas in the
  concept; a free-form visual builder is explicitly out of scope), import/
  export (JSON), delete.
- **Status language:** succeeded (green), failed (red + failed step
  highlighted), running (cyan + current step index).
- **Empty state:** "No workflows yet — chain your first multi-step
  pipeline."
- **Error state:** run history row expanded at the failed step with the
  error + Rerun from step.

## 6. AI Control Center — role and boundaries

**Is:**

- Glanceable AI status (endpoint, model, agents, queue) — the only app
  that shows all four at once.
- Navigation: the single entry point that links to all eight sibling apps.
- Quick actions for the common verbs (start Assistant, run diagnostics).
- The summary view of the AI Settings category.

**Is not:**

- Not the operating system: no file, terminal, window, or system
  functions.
- Not a dashboard of everything: any UI that needs more than a summary
  table + an "Open in …" link belongs in the sibling app (rule: summary +
  link, never embedded management).
- Not the Assistant: no chat surface.
- Not Monitoring/Diagnostics: no historical charts or log views.

Boundary rule of thumb: the Control Center answers "how is AI doing, and
where do I go from here?" — anything more goes to a sibling app.

## 7. Design tokens

Source of truth for colors: `profile/layers/32-desktop-theme/assets/color-schemes/AIArch.colors`
(the AIArch KDE color scheme, committed in phase 2a3). Concept prototypes
consume these values as QML tokens.

**Surfaces (glass)**

| Token | Value | Use |
|-------|-------|-----|
| `surface.base` | α 0.84 over wallpaper | window content background |
| `surface.raised` | α 0.92 | cards, panes, list rows |
| `surface.overlay` | α 0.96 | popups, menus, launcher |
| `blur.radius` | 30 px | KWin blur behind translucent surfaces |
| `border.hairline` | 1 px `rgba(255,255,255,0.10)` | all surface edges |
| `border.focus` | 1 px `rgba(64,190,220,0.35)` | focused window/element |
| `radius.window` | 0 | decoration owns the window corners |
| `radius.card` | 8 px | cards, panes |
| `radius.control` | 6 px | buttons, inputs |
| `radius.chip` | 999 px | chips, status pills |

**Colors**

| Token | RGB | Use |
|-------|-----|-----|
| `bg.view` | 14, 17, 20 | deepest view background |
| `bg.window` | 18, 22, 27 | window base |
| `bg.alt` | 20, 24, 30 | alternating rows, hover |
| `text.primary` | 232, 236, 240 | body text |
| `text.secondary` | 140, 149, 159 | labels, metadata |
| `text.disabled` | 90, 98, 108 (concept-derived, not in scheme) | disabled, placeholders |
| `accent` | 64, 190, 220 | focus, active nav, links, selection, active status |
| `secondary.violet` | 96, 110, 190 | secondary chart series, rare accents |
| `status.ok` | 63, 185, 80 | success, connected, indexed |
| `status.warn` | 210, 153, 34 | degraded, syncing, stale |
| `status.err` | 248, 81, 73 | failure, offline, error |

Accent usage rule: cyan is for **state**, never for decoration — focus
rings, active items, links, selection, "active/loaded" status. Never a
surface fill, never a glow.

**Typography** (Noto Sans; monospace: Noto Sans Mono)

| Token | Size / weight | Use |
|-------|---------------|-----|
| `type.micro` | 11 px / 400 | status bars, micro-labels, per-message meta |
| `type.small` | 12 px / 400 | table cells, secondary text |
| `type.body` | 13 px / 400 | UI default |
| `type.section` | 15 px / 500 | section headers, pane titles |
| `type.view` | 17 px / 600 | view titles (top of a pane) |
| `type.display` | 20 px / 600 | single hero number (Monitoring cards) |

Line height 1.4. Weights: 400 default, 500 sections, 600 view titles only.

**Spacing & rhythm**

8 px base grid; 4 px micro-steps; card padding 12/16 px; pane gap 16 px;
window content margin 16 px; list row height 36 px.

**Iconography (in UI)**

16 / 20 / 24 px, 1.5 px stroke, monochrome `currentColor`; accent only in
active/hover states.

**Motion**

120–180 ms ease-out on open/close/hover; no bounce, no parallax; the only
permitted ambient motion is the Assistant's "thinking" dot pulse.

**Data visualization**

Line width 1–1.5 px; no area fills (an α 0.06 fill under a single accent
line is the maximum allowed); sparkline height ≤ 48 px, card chart ≤ 120
px; gridlines on hover only; numbers are the primary content, charts
secondary.

**Forbidden (hard constraints from the brief)**

Glow/box-shadow bloom, neon, gradient surface fills (the wallpaper may
carry a subtle vertical gradient), animated backgrounds, large gauges or
HUD rings, robot/brain/hologram motifs.

## 8. Panel specification

- **Type & placement:** floating panel (Plasma `location=4`), bottom-
  center, width ≈ 85 % of screen, height 48 px.
- **Surface:** glass `surface.base`, `border.hairline`, radius 12 px.
- **Zones, left → right:**
  1. **Kickoff button** — the AI-Arch mark glyph (24 px); hover raises
     `surface.raised`.
  2. **Task area** — open windows: 16 px app glyph + truncated title
     (12 px, secondary; primary on hover). Active window: 2 px accent
     underline at the item's bottom edge (not a background fill).
  3. **Hairline separator** — 1 px `rgba(255,255,255,0.08)`.
  4. **Tray** — NetworkManager (glyph; popover with SSID + toggle), audio
     (glyph; slider popover), notifications (glyph + subtle count badge),
     clock (digital, 13 px, secondary → primary on hover; date + calendar
     in popover).
- **Behavior:** always visible (no auto-hide); tray popovers use
  `surface.overlay` + 120 ms open.
- **Notifications:** standard Plasma toasts — glass + hairline + app icon +
  close; AI-app notifications carry a 2 px accent left edge, the only
  visual distinction.
- The panel must never look like an AI product: it is the OS.

## 9. Kickoff launcher specification

- **Trigger:** Kickoff button or Super key.
- **Geometry:** centered popup 720 × 560 px, `surface.overlay`, 1 px
  border, radius 12 px, opens 150 ms ease-out.
- **Layout, top → bottom:**
  1. **Search bar** — full width, 40 px, hairline border, placeholder
     "Search apps…" (15 px, secondary); focus → `border.focus`.
  2. **Recent** (only when search is empty) — up to 8 entries: 20 px glyph
     + 11 px time label.
  3. **Favorites row** — up to 8 icons: 32 px glyph + 11 px label below.
  4. **App grid** — ~8 columns; 32 px glyph + 11 px label; alphabetical;
     scrolls.
  5. **Footer** — right side: power menu (lock / suspend / shutdown) as a
     standard OS element.
- **AI-app marking:** AI applications carry a **subtle 6 px accent dot** at
  the top-right corner of their glyph. No separate section, no banner, no
  "AI" category wall — they sit alphabetically among dolphin, firefox,
  konsole. The dot is the entire treatment.
- **Search behavior:** instant prefix + substring filter over app names;
  (future, implementation phase) natural-language matching against app
  descriptions — not part of the concept render.
- **Must communicate:** every AI app is launchable exactly like every other
  app on this desktop.

## 10. AI application icon language

**Style**

- Monochrome line glyphs: 1.5 px stroke on a 24 px grid, rounded caps, no
  fills, single color (`currentColor`).
- No color in the glyph itself; accent tint applies only in active UI
  states (the launcher's cyan dot is a separate, additive treatment).
- Quiet "AI family" cue: each glyph incorporates a small **node or arc**
  motif — enough to read as one family, without robot/brain clichés.

**Per-app glyphs (concept sketches)**

| App | Glyph |
|-----|-------|
| AI Control Center | concentric arcs + center dot (command mark) |
| AI Assistant | speech bubble containing one node dot |
| Model Manager | stacked layers, top layer marked by a node |
| Inference Manager | three chevrons flowing into a funnel |
| Agent Manager | central node with two branches (small tree) |
| RAG Tools | document outline with three linked nodes |
| AI Monitoring | thin line chart with one peak inside a rounded square |
| AI Diagnostics | circle with check + one pulse arc |
| AI Workflows | three connected rounded squares (chain) |

**Sizes:** 16 px (task area, tables) · 20 px (rows, recent) · 24 px
(favorites, app rail) · 32 px (launcher grid) · 48 px (about/empty states).

**Format:** SVG, single path family, exported at all sizes; the same file
set serves `.desktop` icons and in-app rail icons.

## 11. Normal-OS application mapping

Every required OS function maps to a stock first-party app (no re-skinning
in the concept; the AIArch KDE color scheme is applied system-wide, which
is the entire visual integration of stock apps):

| OS function | Application | Concept-shot appearance |
|-------------|-------------|--------------------------|
| File management | dolphin | shots 1, 2 (real folders, details view) |
| Terminal | konsole | shots 1, 2, 4 (real sessions incl. `ai-gen`) |
| Web | firefox | not in shots (available) |
| System settings | systemsettings | shot 5 (stock category, as-is) |
| System monitoring | plasma-systemmonitor | shot 5 (real live data) |
| Software management | plasma-discover | not in shots (available) |
| Global search | krunner | available (Super) |
| Launcher | kickoff | shot 2 (open) |
| Printing | cups / printer applet | tray (available) |
| Networking | networkmanager | tray |
| Audio | plasma-pa | tray |
| Notifications | Plasma notifications | panel toasts |

The System Settings **AI** category (§12) is the *only* addition to a
stock app — and it is specification-only until the implementation phase.

## 12. Future System Settings AI category (specification only)

Status: **spec only** — implemented in the 2b/2c phase, not in the concept
render. Shot 5 shows the real, stock System Settings window as-is; the AI
category does not appear in it.

- A new top-level **AI** category in `systemsettings`, standard KCM chrome
  (stock layout, AIArch palette) — consistent with the OS, not custom
  chrome.
- **Pages:**
  1. **AI → Endpoint** — server URL (any OpenAI-compatible endpoint), API
     key (masked; stored in KWallet), timeout, "Test connection" button
     with inline result (latency or one-line cause).
  2. **AI → Models** — default model picker (populated from the Model
     Manager catalog) + "Open Model Manager."
  3. **AI → Privacy & data** — local-vs-remote preference, log retention,
     content-exclusion notes (what is never sent).
- **Single source of truth:** this category owns the shared endpoint
  configuration; all nine AI apps read it. Per-app Settings views show a
  read-only summary + "Open System Settings."
- **Config format (concept):** one file under `/etc/xdg/ai-arch/` (distro
  default) overridable per user in `~/.config/ai-arch/` — final placement
  decided in the implementation phase alongside decision D3.

## 13. Wallpaper requirements (concept variant)

**Purpose:** support the interface. Glass surfaces (α 0.84) must let enough
variation show through to read as *surfaces* — the wallpaper behind a
window visibly differs from the window surface — while the desktop as a
whole stays very dark.

**Context:** the current wallpaper reads as near-black (mean ≈
[15, 25, 32], max brightness 66/255), so glass has almost nothing to
transmit. The concept variant raises local contrast without raising overall
brightness.

**Requirements:**

- Keep the approved direction: very dark, minimalist, abstract, futuristic,
  professional, subtle Stark/JARVIS atmosphere.
- Raise local contrast: stronger cyan (below center) and violet (top-left)
  glows, brighter floor-grid hairlines, slightly lifted gradient endpoints —
  so glass has texture to transmit.
- Targets: global mean luminance stays low (dark overall); brightest zone
  ≤ ~90/255 and small in area (no hotspots under typical window
  positions); no region so bright that light UI text over glass loses
  contrast.
- Keep the geometric/architectural language (perspective floor grid, faint
  diagonals, vignette) — brighter, not new motifs.
- **Not:** flashy, neon, gaming, holographic, robots, spaceships, or
  anything that competes with the interface.

**Process:** the wallpaper is procedurally generated (existing generator
script; parameters: gradient endpoints, glow color/strength/radius, grid
alpha, diagonals, vignette). Stage B produces 2–3 candidates under
`concept/wallpaper/variants/` and reports them for owner choice before any
installation on the VM. Pinning a final wallpaper into layer
`32-desktop-theme` is an implementation-phase action after concept
approval, done with SHA256 pinning per project rules.

## 14. Concept shot composition specifications

Common to all shots: 1920 × 1080; the chosen higher-contrast wallpaper
(§13); floating panel at bottom with task area + tray populated; keepalive
running (no lock during capture); windows placed at the coordinates below
by the concept placement script; real content in real apps; QML prototype
content uses the §4 sample-data conventions. Capture is host-side
(`virsh screenshot`); each shot is pixel-verified before delivery.
Coordinates are (x, y) top-left of the window content; the panel occupies
the bottom ~80 px.

### 14.1 Shot 1 — Hero (`01-hero.png`)

Windows (z-order top → bottom):

| Window | Size | Position | Content |
|--------|------|----------|---------|
| AI Control Center (Overview) | 900 × 580 | (100, 90) | 4 status tiles (endpoint connected, model loaded, 1/2 agents active, queue 0), 5-row activity feed, quick actions; focused (accent focus border) |
| Model Manager | 680 × 540 | (1160, 140) | 3-model catalog (1 local loaded, 1 remote available, 1 local available), detail pane on the loaded model |
| Dolphin | 640 × 380 | (120, 620) | real folder (`~/Documents`), details view |
| Konsole | 660 × 340 | (1180, 680) | real session: a short `ai-gen` exchange (prompt + brief answer) |

Overlaps: Control Center's bottom-left corner over Dolphin's top edge;
Model Manager's bottom edge over Konsole's top-right. Must communicate:
normal and AI apps coexist as first-class windows on one desktop; glass
transmits the wallpaper; the panel reads as the OS.

### 14.2 Shot 2 — Launcher (`02-launcher.png`)

| Element | Size | Position | Content |
|---------|------|----------|---------|
| Dolphin | 640 × 400 | (1180, 180) | real folder, unfocused |
| Konsole | 660 × 340 | (100, 560) | real session, unfocused |
| Kickoff popup | 720 × 560 | centered (600, 230) | empty search, Recent row, Favorites row, app grid; AI apps visible with the 6 px cyan dot |

Must communicate: AI apps launch from the same launcher as every other
app — independent launchability.

### 14.3 Shot 3 — Assistant (`03-assistant.png`)

| Window | Size | Position | Content |
|--------|------|----------|---------|
| AI Assistant | 720 × 620 | (600, 200) | focused; a realistic 2–3 exchange conversation, one assistant reply containing a code block, model picker showing the default model, history drawer closed |

Desktop otherwise empty + panel. Must communicate: an AI app as a normal
standalone window — calm, readable, no spectacle.

### 14.4 Shot 4 — Agents (`04-agents.png`)

| Window | Size | Position | Content |
|--------|------|----------|---------|
| Agent Manager | 880 × 560 | (120, 140) | focused; list with 2 agents (1 idle, 1 failed), detail on the idle agent with config summary + 3-run history, latest run expanded |
| Konsole | 660 × 340 | (1180, 640) | real session showing agent-related terminal use (`ai-gen` or a job log) |

Must communicate: AI agents running alongside ordinary desktop work.

### 14.5 Shot 5 — Normal-OS proof (`05-normal-os.png`)

| Window | Size | Position | Content |
|--------|------|----------|---------|
| System Settings | 900 × 600 | (100, 100) | real, stock category as-is (e.g., Workspace) — no AI category (spec only, §12) |
| plasma-systemmonitor | 700 × 500 | (1140, 120) | real live process view |
| AI Assistant | 640 × 420 | (620, 540) | focused; one short exchange |

Must communicate: AI-Arch is still a complete, general-purpose Linux
desktop — settings, monitoring, and files behave exactly like any
serious distro, with AI present as one more set of first-class windows.

---

## Appendix — consistency pointers

- Visual direction (aesthetic, materials, typography, forbidden motifs):
  `docs/AI-ARCH-DESIGN.md` (unchanged; this document extends it with
  workspace/IA content).
- Product phasing: `docs/AI-ARCH-DESKTOP.md` (2a3 desktop theme done;
  2b Models/Agents/RAG + Control Center; AI settings category in 2b/2c).
- Pending decisions D3/D4/D5 do not block the concept; §12 notes where D3
  lands.
- This document is not production code, not a QML prototype, not a
  screenshot, and changes no VM or Plasma state.




