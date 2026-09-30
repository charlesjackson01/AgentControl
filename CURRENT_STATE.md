# Current state

**Last updated:** 2026-09-30, by Opus (M1 architecture review; M1.1 and M2 handoffs).
**Rule:** every session that changes the redesign updates this file before it pushes. Keep it short and true.
History belongs in git, and rules belong in `docs/REDESIGN_ARCHITECTURE.md`.

## Where things are

| | |
|---|---|
| Working branch | `feature/chat-first-redesign`. All redesign work goes here; **never merge into `main`** |
| `main` | `9c20d73`, untouched by the redesign |
| Backend source | merged from `claude/gifted-fermi-rcas2a` @ `967aa85` in merge commit `af4da89` (61 commits: engine M0–M13, Workspaces W0–W6, Jev stuck watch) |
| Architecture (binding) | `docs/REDESIGN_ARCHITECTURE.md` |
| Detailed plan and rationale | `docs/CHAT-FIRST-PLAN.md` |
| Handoffs | `docs/handoffs/`. **Ready:** `M1_1_CORRECTIONS.md` and `M2_THREAD_READ_MODEL.md` (independent; may run in parallel) |
| Earlier design docs | `docs/MULTI-AGENT-PLAN.md`, `docs/UI-UX-AUDIT.md`, `docs/W7LiveEvents.md`, `docs/M0-SPIKE-REPORT.md` |

## Redesign progress

| Milestone | Status | Owner | Notes |
|---|---|---|---|
| Planning: decisions D1–D5 | ✅ done | Opus | recorded in the architecture doc §2 |
| D1 backend merge | ✅ done | Opus | `af4da89`; tree = `967aa85` + redesign docs |
| **M1 App shell** | ✅ accepted (review 2026-09-30) | Codex | read-only `/chat`, `/classic` alias; completion report and Opus review in `docs/handoffs/M1_APP_SHELL.md` |
| **M1.1 Shell corrections** | ⏭ ready; **must land before M3** | Codex | `docs/handoffs/M1_1_CORRECTIONS.md`: an unknown session link freezes live updates; a stale context preference leaves the scrim over the room |
| **M2 Thread read model** | ⏭ ready | Codex | `docs/handoffs/M2_THREAD_READ_MODEL.md`: `conversation.py`, `/api/channels`, `/api/thread`, `Store.events_page`; backend read path only |
| M3–M9 | not started | | M3 (room timeline) needs M1.1 + M2; see architecture §12 |

The isolated frontend is in `agent-autonomy/chat/`: `index.html`, `tokens.css`, `chat.css`, `core.js`, `model.js`, `shell.js`.
`/chat` shows real project sessions, members and Connections, with authenticated SSE and polling fallback.
Messaging and actions remain in classic; `/` and `/classic` serve the unchanged classic UI.

## Tests (at `990f258`, re-verified in the Opus review environment 2026-09-30)

| Suite | Command | Result |
|---|---|---|
| Backend (Python) | `python3 -m unittest discover -s agent-autonomy/tests` | **351 tests, OK (skipped=6)** here; 3 skipped in Codex's environment (see below) |
| Classic DOM | `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_ui.cjs` | **82/82 passed** |
| Chat DOM | `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_chat_ui.cjs` | **13/13 passed** |
| Chat browser matrix | `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/chat_screenshots.cjs /tmp/chat-shots` | **24 combinations passed**, 50 temporary screenshots; no horizontal overflow at 390 px |

DOM test dependencies (test-only, installed outside the repo):
`npm install --prefix /tmp/ac-tests --no-save linkedom cssom playwright-core`.
Chromium was found under `~/.cache/ms-playwright` in this environment; the screenshot script discovers it or accepts `CHROMIUM_PATH`.
In Codex's environment, the socket-based backend tests and Chromium had to run outside the sandbox.
The review environment has Chromium at `/opt/pw-browsers/chromium`.

**Skipped tests are environment-gated. Report them by name, not only by count:**

| Skipped when | Tests |
|---|---|
| no OpenCode binary (`OPENCODE_BIN` or `opencode` on `PATH`) | `test_roles_e2e…test_paid_coder_and_read_only_reviewer`, `test_team_e2e…test_installed_skill_reaches_the_agent_on_its_next_turn`, `test_team_e2e…test_two_agents_killed_mid_run_and_resumed` |
| `Xvfb`, `xdotool` or `import` missing | `test_preview…test_desktop_preview_shows_frames_and_accepts_input` |
| no `AGENTCONTROL_CONTAINER_TESTS=1` with a runtime and image | `test_container_e2e…test_agent_works_in_a_locked_down_container` |
| no `AGENTCONTROL_VM_TESTS=1` on a KVM host | `test_vm_e2e…test_agent_works_in_a_kvm_clone` |

Six skipped means none of those are available. Codex's three skips mean the OpenCode trio ran and passed there.

## The app today (classic UI)

- **Server:** `agent-autonomy/app.py`, standard-library HTTP. It serves classic at `/` and `/classic`, chat at `/chat`, and every `/api/*` route needs `Authorization: Bearer <dashboard key>`.
  - The key is in `agent-autonomy/state/dashboard.key`, which is gitignored.
  - Live updates: `GET /api/events` (SSE change notices), then re-read `GET /api/state`.
- **Engine:** `agent-autonomy/engine.py` (`Controller`). Hermes plans each turn, and OpenCode agents carry it out. It supports:
  - team runs, specialists, approvals with R0–R3 risk levels and a hash-chained audit
  - containers and VMs, preview surfaces, skills, models, the gateway and spend caps
- **Journal:** `agent-autonomy/journal.py`, SQLite in WAL mode at `agent-autonomy/state/autonomy.sqlite3`.
- **Classic frontend:** `index.html`, `app.js` (about 2.4k lines), `workspace.js`, `app.css` (about 5.3k), `workspace.css` and `themes.css`,
  with the Mac, Terminal and XP themes. The redesign does not modify it until M9.
- **Run it:** `python3 agent-autonomy/app.py --host 127.0.0.1 --port 8766 --project <dir> --opencode <url> --profile <hermes profile>`.
  Real runs need a Hermes CLI and an OpenCode server; the UI renders without them.

## Known issues and open questions

- The redesign milestones M1–M9 reuse the "M" prefix that the engine's history uses for M0–M13. They are unrelated, and
  the architecture doc §12 says so.
- W7 (live Hermes streaming) is still tabled. Until it exists, Hermes appears in the room only when a decision lands.
- Multiple concurrent runs are not supported by the backend (one active run). The chat UI must reflect that honestly.
- For M2: if paging a project-scoped thread across sessions proves costly, architecture §6.1 allows temporarily
  backing `main` with the latest `parent_run` chain behind the same API.
- The M1 review lists optional polish items (401 key handling, autocomplete, `/classic/`, live region, pluralisation,
  tab keys, stream backoff reset). None is required, and they can be folded into later UI milestones.
- `/api/state` caps runs at 30. The chat shell's session list inherits that until M3 switches to `/api/thread`.

## Next step

1. Codex executes **`docs/handoffs/M1_1_CORRECTIONS.md`** (small; frontend only) and
   **`docs/handoffs/M2_THREAD_READ_MODEL.md`** (backend read path only). They touch disjoint files and can run in either order or in parallel.
2. Opus reviews both, then writes the M3 handoff (room timeline rendering `/api/thread`).
