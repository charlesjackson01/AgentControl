# Current state

**Last updated:** 2026-09-30, by Opus (M1.1 + M2 architecture review; M2.1 and M3 handoffs).
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
| Handoffs | `docs/handoffs/`. **Next:** `M2_1_CORRECTIONS.md`, then `M3_ROOM_TIMELINE.md` (M3 starts only after M2.1 is accepted) |
| Earlier design docs | `docs/MULTI-AGENT-PLAN.md`, `docs/UI-UX-AUDIT.md`, `docs/W7LiveEvents.md`, `docs/M0-SPIKE-REPORT.md` |

## Redesign progress

| Milestone | Status | Owner | Notes |
|---|---|---|---|
| Planning: decisions D1–D5 | ✅ done | Opus | recorded in the architecture doc §2 |
| **D6 events index** | ⚠ **owner decision needed** (recommended: approve) | owner | an additive `events(run, id)` index migration; see architecture §2 and `M2_1_CORRECTIONS.md` Part B. Record the decision here: **D6: pending** |
| D1 backend merge | ✅ done | Opus | `af4da89`; tree = `967aa85` + redesign docs |
| **M1 App shell** | ✅ accepted (review 2026-09-30) | Codex | read-only `/chat`, `/classic` alias; completion report and Opus review in `docs/handoffs/M1_APP_SHELL.md` |
| **M1.1 Shell corrections** | ✅ accepted (review 2026-09-30) | Codex | `docs/handoffs/M1_1_CORRECTIONS.md`: stale links recover with a notice; scrim follows visible panels; DOM and browser regressions pass |
| **M2 Thread read model** | ✅ accepted, with corrections (review 2026-09-30) | Codex | `conversation.py`, `/api/channels`, `/api/thread`, `Store.events_page`; review in `docs/handoffs/M2_THREAD_READ_MODEL.md` |
| **M2.1 Read-model corrections** | ⏭ ready; **must land before M3** | Codex | `docs/handoffs/M2_1_CORRECTIONS.md`: decided-request attribution, page-independent outcome actions, no empty planner decisions, cheaper channels/gather (+ the D6 index if approved) |
| **M3 Room timeline** | ⏭ handoff ready; starts after M2.1 | Codex | `docs/handoffs/M3_ROOM_TIMELINE.md`: renders `/api/thread` in the project room; read-only; decisions still link to classic |
| M4–M9 | not started | | see architecture §12 |

The isolated frontend is in `agent-autonomy/chat/`: `index.html`, `tokens.css`, `chat.css`, `core.js`, `model.js`, `shell.js`.
`/chat` shows real project sessions, members and Connections, with authenticated SSE and polling fallback.
Messaging and actions remain in classic; `/` and `/classic` serve the unchanged classic UI.
The new read-only endpoints project the journal with bounded messages, stable ids/revisions and cursor paging.
The M1 frontend still reads `/api/state`; M3 timeline rendering has not started.
New backend tests: `tests/test_conversation.py` and `tests/test_thread_api.py`.

## Tests (at `f314462`; re-verified in the Opus review environment 2026-09-30)

| Suite | Command | Result |
|---|---|---|
| Backend (Python) | `python3 -m unittest discover -s agent-autonomy/tests` | **383 tests, OK (skipped=6)** here; 3 skipped in Codex's environment, which has OpenCode (see named gates below) |
| Classic DOM | `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_ui.cjs` | **82/82 passed** |
| Chat DOM | `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_chat_ui.cjs` | **16/16 passed** |
| Chat browser matrix | `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/chat_screenshots.cjs /tmp/chat-shots` | **24 combinations + 4 regressions passed**, 54 temporary screenshots; no horizontal overflow at 390 px |

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
- M2 pages all project sessions. V1 materialises one session’s public messages at a time, using 5,000-event
  SELECT batches with no history cutoff; large-session memory use is a future optimisation.
- **Pre-existing timing-sensitive backend tests (not caused by the redesign).** The review reproduced
  `test_agents.ControllerLifecycleTests.test_a_turn_records_join_work_approval_and_finish` failing in 2 of 3 runs on
  `af4da89` (the pre-redesign backend), with three suites running at once.
  - The failure: `('coder-1','idle','finished') != ('coder-1','working','finished')`.
  - Cause: `Lifecycle` samples changes at most every 0.5 s, so a short `working` state can be skipped under load.
  - `test_modes`, `test_paid` and the team tests Codex saw use the same fixed 5-second waits on background threads.
  - Rule: rerun and record such failures; never modify protected code or these tests within a redesign milestone.
    A backend test-robustness fix is the owner's call, outside the redesign.
- **Performance:** every read of events by run scans the whole `events` table (there is no index on `run`). On a
  461 MB journal, `/api/thread` and `/api/channels` take about 2.4 s each. M2.1 reduces the scans; D6 (the index)
  brings the first thread page to about 0.3 s.
- The M1 review lists optional polish items (401 key handling, autocomplete, `/classic/`, live region, pluralisation,
  tab keys, stream backoff reset). None is required, and they can be folded into later UI milestones.
- `/api/state` caps runs at 30. The rail's session list still inherits that in M3; the timeline itself pages the full history through `/api/thread`.

## Next step

1. **The owner decides D6** (the events index). Record it in the progress table above.
2. Codex executes **`docs/handoffs/M2_1_CORRECTIONS.md`**, including Part B only if D6 is approved.
3. Opus reviews M2.1. Codex then executes **`docs/handoffs/M3_ROOM_TIMELINE.md`**.
4. M4–M9 remain unstarted; the architecture contract stays binding.
