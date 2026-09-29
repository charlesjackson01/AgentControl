# AI-Arch Production Architecture

**Status: Stage D (2026-08-27).** Architecture + implementation foundation for
the AI-Arch desktop (roadmap phase 2b). This document is authoritative for
layer boundaries, service decomposition, and repository structure. It does not
change the Stage A concept (`docs/AI-ARCH-CONCEPT.md`), the design brief
(`docs/AI-ARCH-DESIGN.md`), or the layer mechanism (`docs/LAYERS.md`).

Companion documents:

| Topic | Document |
|-------|----------|
| AI service interfaces, gateway, context, agents, RAG | `docs/AI-ARCHITECTURE.md` |
| Permission model, audit, context privacy | `docs/SECURITY.md` |
| Concept-to-production QML mapping, Plasma integration | `docs/PRODUCTION-QML.md` |
| Build system, install/rollback | `docs/BUILD.md` |
| Test strategy | `docs/TESTING.md` |

---

## 1. Layer architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│ L0  Kernel + hardware                                                  │
│     Arch, systemd, NetworkManager, PipeWire, CUPS, BlueZ, SDDM        │
├──────────────────────────────────────────────────────────────────────┤
│ L1  Stock system services (unchanged by AI-Arch)                      │
├──────────────────────────────────────────────────────────────────────┤
│ L2  Desktop shell — stock Plasma 6                                     │
│     plasmashell, KWin (Wayland), SDDM, KRunner, Kickoff, panel        │
│     applets, KNotification, System Settings                            │
│     + ai-arch theme layer: AIArch color scheme, ai-arch KWin          │
│       decoration, AIArch icon theme, v2-balanced wallpaper, KCMs      │
│                                                                       │
│     HARD RULE: L2 must not depend on L3/L4/L5. The desktop is         │
│     100% functional with every AI component uninstalled.              │
├──────────────────────────────────────────────────────────────────────┤
│ L3  AI services — user-session D-Bus services, all optional           │
│     configd   org.aiarch.Config    configuration, kill switch         │
│     aid       org.aiarch.AI        gateway: the only backend client   │
│     permd     org.aiarch.Permits   permission broker + tool executors │
│     contextd  org.aiarch.Context   context provider (only context     │
│                                 egress to AI requests)                │
│     agentsd   org.aiarch.Agents    agent + workflow runtime           │
│     ragd      org.aiarch.Rag       datasets + indexing + retrieval    │
├──────────────────────────────────────────────────────────────────────┤
│ L4  AI applications — nine standalone Qt/QML apps (Stage A §4)        │
│     + shell extensions: AI panel plasmoid, System Settings AI KCM,    │
│       (optional) KRunner AI plugin                                    │
├──────────────────────────────────────────────────────────────────────┤
│ L5  Inference backends — NOT shipped. User-managed OpenAI-compatible  │
│     servers: llama.cpp, vLLM, cloud. Endpoint is a first-class config │
│     knob (owner decision: the distro ships AI apps, not inference).   │
└──────────────────────────────────────────────────────────────────────┘
```

Dependency direction is strictly downward. L4 depends on L3 via D-Bus and
must render a full "AI unavailable" state when L3 is absent. L3 depends on
L5 via plain HTTP (OpenAI-compatible API) and degrades to an `offline`
status. L2 touches L3 only through independently degradable shell
extensions (the panel plasmoid shows a static icon when `configd` is absent;
the KCM is inert without L3).

The conceptual layering proposed for Stage D (kernel → services → desktop →
AI layer → backends) is kept, with two refinements that the material forced:

1. **The theme is part of L2, not of the AI layer.** The AIArch color
   scheme, KWin decoration, icon theme, and wallpaper are OS chrome that the
   normal desktop uses with or without AI (established in 2a3). Making them
   part of L3 would let "AI off" change the look of the desktop, which the
   concept forbids.
2. **The permission broker is a service (L3), not a module inside the
   gateway.** The gateway asks the model for tool calls; it is not the
   component that may touch the system. `permd` is the only component with
   executors. This keeps the security boundary at a process boundary
   (see `docs/SECURITY.md`).

## 2. The "AI off" guarantee

Normal Linux functionality must never depend on AI (Stage D §3; owner
directive 2026-08-27). Concretely:

- **No L2 code path imports an ai-arch symbol.** The only L2↔L3 contact
  points are: (a) one panel plasmoid that polls `org.aiarch.Config` and
  renders a plain icon if the name is not on the bus; (b) the System
  Settings AI KCM, which is a standard optional KCM; (c) the icon theme's
  nine AI app icons (static assets).
- **Kill switch.** `ai_enabled: false` in the user config (KCM, CLI, or
  D-Bus) makes the gateway refuse new requests, cancel in-flight ones, and
  disable tool execution. Services stay up and report the state.
- **Total absence.** Masking/stopping all `aiarch-*.service` user units and
  removing the packages leaves a stock Plasma desktop: panel, launcher,
  windows, workspaces, notifications, quick settings, KRunner all stock and
  functional. This is a testable requirement (see `docs/TESTING.md`,
  reliability suite).
- **No L2 dbus-activation hooks, no KWin scripts, no session autostart
  hooks in the default configuration.** D-Bus service files exist only for
  `org.aiarch.*` names (activating the AI services themselves — see the
  activation model in §3); nothing in L2 autostarts or waits on them.

## 3. Service map (L3)

All six services are user-session systemd services (`systemd --user`,
activated on the session bus), written in C++/Qt6 with KDE Frameworks.
They are small on purpose; the heavy logic is HTTP to the backend and
SQLite. Full interface contracts: `docs/AI-ARCHITECTURE.md`.

| Service | Name | Owns | Talks to |
|---------|------|------|----------|
| `configd` | `org.aiarch.Config` | endpoint/privacy/permission config (sole writer), `ai_enabled` kill switch, secret store (key refs; 0600 file in Stage D, KWallet in Stage E) | config files, local secret store |
| `aid` (gateway) | `org.aiarch.AI` | backend client (only one), request queue + cancellation, streaming, usage metering, logs, health/diagnostics, model control (llama.cpp slots) | backend HTTP, `permd`, `contextd`, `configd`, SQLite |
| `permd` | `org.aiarch.Permits` | tool registry, policy, confirmation prompts, **all tool executors**, append-only audit | `configd`, KNotification, (polkit for privileged ops) |
| `contextd` | `org.aiarch.Context` | available context (KWin/session), exposed-context decision, pinning/attachments, exclusions (only context egress) | KWin D-Bus, `configd`, cooperating apps' `org.aiarch.ContextProvider` |
| `agentsd` | `org.aiarch.Agents` | agent + workflow definitions, run lifecycle, run history (scheduling: Stage E) | `aid` (runs the tool loop), `configd`, SQLite |
| `ragd` | `org.aiarch.Rag` | datasets, chunking, embeddings, vector store (SQLite), reindex | `aid` (embeddings via `/v1/embeddings`), `configd` |

**Single-instance rule:** each service is a `KDBusService` with
`ActivationMode::Unique`; a second launch activates the first.

**Activation model (explicit):** D-Bus activation (the `dbus/*.service`
files) is the activation mechanism — any service starts on first bus use.
User units *may* be enabled at first run (by `configd`) to provide
resident behavior; the test harness can mask/disable those units
(TESTING.md T7). Activation and residency are complementary mechanisms,
not alternatives: the default configuration ships D-Bus-activation only.

**Why six services and not one:** the security boundary (permd), the context
privacy boundary (contextd), and the config/kill-switch (configd) must not
be reachable from a compromised gateway. If the endpoint is hostile
(prompt injection), the blast radius is `aid` + whatever `permd`'s policy
allows — not the config, not the audit, not the context decisions.
Alternatives considered:

- *One monolithic `ai-arch-daemon`* — rejected: a single crash or a hostile
  backend would take down config, audit, and permissions together; the
  permission boundary would be a function call, not a process boundary.
- *Three services (config, ai, tools)* — rejected: merging context into the
  gateway lets the gateway self-select what enters a prompt, which defeats
  the "deliberate privacy" requirement (Stage D §6).

## 4. Application map (L4)

Nine standalone Qt/QML applications — the Stage A §4 information
architecture, preserved exactly. Each is its own launchable program with its
own `.desktop`, its own icon (AIArch icon theme), and its own window under
the stock ai-arch KWin decoration. Each is a D-Bus client of L3 and degrades
to an "AI unavailable" state when L3 is absent. No app embeds another app's
UI; cross-navigation is via actions ("Open in Model Manager" → xdg-open of
the sibling's `.desktop`).

| App | Form | Instance | Primary L3 deps |
|-----|------|----------|-----------------|
| AI Control Center | standalone app | unique | Config, AI (status), Agents (summary), Rag (summary) |
| AI Assistant | standalone app | **multiple** (parallel chats) | AI (chat), Context, Permits (via AI) |
| Model Manager | standalone app | unique | AI (models/slots), Config |
| Inference Manager | standalone app | unique | AI (queue/usage signals) |
| Agent Manager | standalone app | unique | Agents, AI |
| RAG Tools | standalone app | unique | Rag |
| AI Monitoring | standalone app | unique | AI (usage time series) |
| AI Diagnostics | standalone app | unique | AI (diagnostics/logs), Config |
| AI Workflows | standalone app | unique | Agents (workflow = fixed-pipeline agent) |

Per-app detail (purpose, UI, integration points, context exposed, actions the
AI may request, permission requirements): `docs/PRODUCTION-QML.md` §7.

Shell extensions (L4, but living in the Plasma shell):

- **AI panel plasmoid** — the subtle global AI affordance (Stage A §8: the
  panel's AI entry). Toggles/launches AI Control Center; shows endpoint
  state dot; static icon when L3 is absent.
- **System Settings AI KCM** — Stage A §12 (Endpoint / Models / Privacy &
  data). Standard KCM chrome; the single source of truth UI; writes through
  `configd` only.
- **KRunner AI plugin (optional, later)** — the "natural-language matching"
  the concept defers to the implementation phase. Off by default until
  proven.

## 5. Repository structure

```
ai-arch/
├── preseed/  profile/  scripts/  vms/  build/  iso/  docs/  decisions/
│             (existing: OS install, distribution profile, build pipeline)
├── concept/                       # Stage A–C material — FROZEN reference
├── src/                           # NEW — production source
│   ├── CMakeLists.txt
│   ├── ui/                        # AIArch.Ui: shared QML module (theme + components)
│   ├── services/                  # configd, aid, permd, contextd, agentsd, ragd (C++/KF6)
│   └── apps/                      # the nine AI apps (Qt/QML)
├── dbus/                          # org.aiarch.* service files + interface XML
├── plasma/                        # AI panel plasmoid, AI KCM, AIArch icon theme, panel config
└── tests/                         # harnesses + suites (capture runner, pixel checks,
                                   # D-Bus contract tests, mock endpoint, AI-off suite)
```

`profile/layers/40-ai-apps/` (Stage E) installs the built `src/` + `dbus/` +
`plasma/` into a fresh VM per the layer rules in `docs/LAYERS.md`; the build
pipeline stages the source tree into the layer directory first (same-commit
determinism, per decision 0005's "repo holds the recipe" rule).

**Alternatives considered:**

- *`shell/ apps/ services/ ai/ security/` top-level (Stage D example)* —
  rejected as a split that duplicates `src/`: "security" and "ai" are
  properties of the services, not separate trees; the example was an example.
- *Everything under `profile/layers/40-ai-apps/`* — rejected: source under
  the profile tree inverts the dependency (the profile should consume
  builds, not own the source) and breaks the iteration loop (editing an app
  means editing a layer).
- *Separate git repo for the apps* — rejected: single repo is the current
  distribution model (one commit → one image); no remote yet (D4) makes a
  second repo pure overhead.

## 6. Configuration and data layout

| Path | Owner | Content |
|------|-------|---------|
| `/etc/xdg/ai-arch/ai-arch.json` | distro (layer) | defaults: endpoint placeholder, privacy defaults, permission defaults |
| `~/.config/ai-arch/ai-arch.json` | `configd` (sole writer) | user config; overrides distro defaults key-wise |
| `/etc/ai-arch/llama-server.json` | legacy (20-ai-client) | still read as last fallback by `ai-gen` and `configd` import |
| `~/.local/share/ai-arch/secrets/` (Stage D) · KWallet `ai-arch` folder (Stage E) | `configd` | API keys by ref (`endpoint-key`), 0600 file in Stage D; never in the JSON file |
| `~/.local/share/ai-arch/` | services | `usage.db`, `audit.db`, `conversations.db`, `agents.db` (SQLite), `rag/` (vector store), `logs/` |

Config format and precedence: `docs/AI-ARCHITECTURE.md` §3.

## 7. Decisions

| # | Decision | Alternatives | Why rejected |
|---|----------|--------------|--------------|
| A1 | L2 never depends on L3/L4/L5; AI-off = stock desktop | "AI-aware shell" (shell imports AI state everywhere) | single point of failure; concept §1: AI layers on, never replaces |
| A2 | Six small user D-Bus services, not one daemon | monolith; three services | blast-radius isolation; process-boundary security (§3) |
| A3 | `permd` is the only executor; gateway never touches the system | gateway-internal tool dispatch | hostile-backend containment (§3, SECURITY.md) |
| A4 | `contextd` is the only context egress | apps collect context and pass it in | privacy must be deliberate (Stage D §6) |
| A5 | Services + apps in C++/Qt6 + KDE Frameworks 6 | Rust services; Python services | KF6 gives KDBusService/KConfig/KWallet/KNotification/KCM/KRunner/plasmoid natively; Rust/Python would hand-roll them and split the codebase |
| A6 | Theme (color scheme, decoration, icons, wallpaper) stays L2 | move theme into the AI layer | "AI off" must not change the look of the desktop (§2) |
| A7 | Panel/launcher/quick settings/notifications = stock Plasma + theme + config + icon theme + one plasmoid; Stage C QML for them is demonstrative | port Stage C Panel/Launcher/StatusControl/Notification QML into production | reinventing plasmashell components; the Stage C versions have no KWin/KNotification/Plasma integration and would fork from Plasma updates |
| A8 | D3 (AI app stack) resolves to the Stage A nine-app native stack | Open WebUI (prior D3 recommendation) | Stage A (owner-approved) defines nine first-class windows; Open WebUI is one web mega-app (browser-dependent, divergent UI, no native panel/launcher/notification integration). D3's "minimal custom tools" option is the one the approved concept selects |
| A9 | Workflows execute through `agentsd` (a workflow = fixed-pipeline agent) | separate workflow runtime | one runtime, one run-history store, one permission path |
| A10 | CMake + manifest install for now; pacman packaging later (2c) | PKGBUILDs from day one | distribution build must stay simple on TCG; pacman packaging is the 2c hardening item (ROADMAP phase 3) and is designed for, not skipped |

## 8. Dependencies

- Qt 6.7+ / KDE Frameworks 6 (official Arch repos; Plasma 6.7 already on the
  VM, so the runtime versions match the desktop).
- `systemd --user` (present), session D-Bus (present).
- Backend: any OpenAI-compatible server; embeddings endpoint required for RAG
  (host `llama-server --embeddings` — owner host config, documented).
- KWallet (present with Plasma) — Stage E secret storage; Stage D uses
  `configd`'s 0600 local secret store (SECURITY.md §8).
- Build toolchain: `10-devtools` layer already provides cmake/gcc; KF6 dev
  packages are new (BUILD.md §4).

## 9. Risks

| Risk | Mitigation |
|------|------------|
| Plasma 6.7 API drift (plasmoid/KCM/KWin overlay APIs) pin the shell extensions to a version | pin + verify in layer `verify.sh`; extensions are the only version-sensitive surface (PRODUCTION-QML.md) |
| TCG in-VM build time for C++ services + nine apps in the distribution build | build once per release (not per layer-apply); host fast-path for iteration (BUILD.md §6) |
| Single-slot host `llama-server` (`-np 1`) starves AI apps when the owner's interactive session runs | gateway queue + bound `max_tokens` + documented etiquette (existing 20-ai-client gotcha) |
| Hostile endpoint / prompt injection | SECURITY.md threat model: schema-validated tool calls, permd-only execution, risk classes, audit, kill switch |
| Stage C look ≠ production stock-Plasma look in places (e.g., notification accent edge) | explicit per-component verdicts with "accepted deviation" list (PRODUCTION-QML.md §8) |

## 10. Unresolved questions

1. **AIBar over stock apps** (dolphin, plasma-systemmonitor): in-app is
   trivial for the nine AI apps; for stock apps the only non-fragile options
   are a KWin overlay script (version-sensitive) or dropping in-window chips
   for stock apps (context still reachable via KRunner/Control Center).
   Default plan: in-app for AI apps now; KWin overlay behind a config flag,
   off by default. Needs a prototype on the VM before Stage E commits.
2. **Notification accent edge** (2 px cyan left edge for AI notifications):
   stock KNotification rendering does not expose per-sender edges without a
   custom notification theme. Evaluate a notification theme in Stage E;
   acceptable to drop the detail if the theme proves fragile.
3. **Task-area active-window indicator**: stock task manager's indicator is
   a fill; the concept wants a 2 px accent underline. Check whether the
   AIArch theme + task-manager plasmoid style can express it; if not, keep
   stock indicator (accepted deviation).
4. **Embeddings endpoint**: RAG needs `/v1/embeddings`. The host llama.cpp
   server would need `--embeddings` (owner host-config decision, open since
   D3). Until then RAG Tools runs with a "embeddings unavailable" state.
5. **D4 publish target** still open (no git remote) — does not block Stage D.
