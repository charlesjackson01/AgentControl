# Current state

**Last updated:** 2026-09-30, by Codex (M4 implemented and verified; awaiting architecture/UX review).
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
| Handoffs | `docs/handoffs/`. **Next:** review the completion report in `M4_COMPOSER.md` |
| Earlier design docs | `docs/MULTI-AGENT-PLAN.md`, `docs/UI-UX-AUDIT.md`, `docs/W7LiveEvents.md`, `docs/M0-SPIKE-REPORT.md` |

## Redesign progress

| Milestone | Status | Owner | Notes |
|---|---|---|---|
| Planning: decisions D1–D5 | ✅ done | Opus | recorded in the architecture doc §2 |
| **D6 events index** | ✅ **approved by the owner 2026-09-30** | owner | exactly one `events(run, id)` index via migration `_v7`, implemented in M2.1 Part B; a narrow exception to the no-migration rule, not permission for other schema changes (architecture §2 and §3) |
| D1 backend merge | ✅ done | Opus | `af4da89`; tree = `967aa85` + redesign docs |
| **M1 App shell** | ✅ accepted (review 2026-09-30) | Codex | read-only `/chat`, `/classic` alias; completion report and Opus review in `docs/handoffs/M1_APP_SHELL.md` |
| **M1.1 Shell corrections** | ✅ accepted (review 2026-09-30) | Codex | `docs/handoffs/M1_1_CORRECTIONS.md`: stale links recover with a notice; scrim follows visible panels; DOM and browser regressions pass |
| **M2 Thread read model** | ✅ accepted, with corrections (review 2026-09-30) | Codex | `conversation.py`, `/api/channels`, `/api/thread`, `Store.events_page`; review in `docs/handoffs/M2_THREAD_READ_MODEL.md` |
| **M2.1 Read-model corrections** | ✅ accepted (review 2026-09-30) | Codex | Parts A + B: recorded-session request attribution, stable outcome actions/revisions, non-empty planner decisions, cheaper reads, and exactly the D6 `_v7` index; 15 new regressions |
| **M3 Room timeline** | ✅ accepted (with M3.1, review 2026-09-30) | Codex | `thread.js`: read-only project room, keyed updates, paging, session disclosure, deep links and waiting pointers; completion report in `docs/handoffs/M3_ROOM_TIMELINE.md` |
| **M3.1 Timeline corrections** | ✅ accepted (review 2026-09-30) | Codex | `docs/handoffs/M3_1_CORRECTIONS.md`: classic receipt labels, server revalidation capped at ten pages with history reset, separate waiting lines, exact strip wording, real rail cap note; eight new regressions |
| **M4 Composer** | ✅ implemented, awaiting review | Codex | `docs/handoffs/M4_COMPOSER.md`: new session, follow-up, notes with `@agent`, pause/resume/confirmed stop, `/check` and `/title`, Basic/Advanced Settings; server-authoritative messages, compact phone footer; decisions stay in classic until M5 |
| M5–M9 | not started | | see architecture §12 |

The isolated frontend is in `agent-autonomy/chat/`: `index.html`, `tokens.css`, `chat.css`, `core.js`, `model.js`, `thread.js`, `composer.js`, `shell.js`.
`/chat` shows real project sessions, members and Connections, with authenticated SSE and polling fallback.
The room composer starts sessions and follow-ups, sends notes and offers the M4 controls through existing endpoints.
Decision actions remain in classic; `/` and `/classic` serve the unchanged classic UI.
The new read-only endpoints project the journal with bounded messages, stable ids/revisions and cursor paging.
The timeline and channel rail consume `/api/thread` and `/api/channels`; `/api/state` still supplies members, Connections, the rail session list and context. The client retains only a page-lifetime read cache, with no writable message store or local submission echoes. Allowed Settings preferences use `acx-settings`; unsent drafts use session-only `acx-draft`.
Backend read-model tests: `tests/test_conversation.py` (34) and `tests/test_thread_api.py` (11); journal tests (7) include v6-to-v7 preservation and index query plans.

## Tests (M4 working tree on `137a5b8`; verified by Codex 2026-09-30)

| Suite | Command | Result |
|---|---|---|
| Backend (Python) | `python3 -m unittest discover -s agent-autonomy/tests` | **398 tests, OK (skipped=3)**; OpenCode tests ran; no timing failure in this M4 run |
| Classic DOM | `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_ui.cjs` | **82/82 passed** |
| Chat DOM | `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_chat_ui.cjs` | **67/67 passed** (42 carried forward + 25 M4 regressions) |
| Chat browser matrix | `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/chat_screenshots.cjs /tmp/chat-shots-m4` | **84 combinations + 4 regressions passed**, 134 temporary screenshots; idle phone footer 57 px, with waiting 105 px, waiting row 40 px; timeline ≥75.3%; waiting text aligned, no overflow or page errors |

DOM test dependencies (test-only, installed outside the repo):
`npm install --prefix /tmp/ac-tests --no-save linkedom cssom playwright-core`.
Chromium was found under `~/.cache/ms-playwright` in this environment; the screenshot script discovers it or accepts `CHROMIUM_PATH`.
The socket-based backend tests and Chromium ran outside the sandbox. All required M4 suites passed;
the earlier lifecycle sampling failure remains documented below. Desktop and phone screenshots were inspected.
The M4 report records the fake-backed real HTTP/browser start, note, targeting, rename, check,
pause/resume/stop and follow-up checks. Keyboard viewport shrinkage to 480 px passed in Chromium;
an actual phone OS keyboard was unavailable. The prior review environment used `/opt/pw-browsers/chromium`.

**Skipped tests are environment-gated. Report them by name, not only by count:**

| Skipped when | Tests |
|---|---|
| no OpenCode binary (`OPENCODE_BIN` or `opencode` on `PATH`) | `test_roles_e2e…test_paid_coder_and_read_only_reviewer`, `test_team_e2e…test_installed_skill_reaches_the_agent_on_its_next_turn`, `test_team_e2e…test_two_agents_killed_mid_run_and_resumed` |
| `Xvfb`, `xdotool` or `import` missing | `test_preview…test_desktop_preview_shows_frames_and_accepts_input` |
| no `AGENTCONTROL_CONTAINER_TESTS=1` with a runtime and image | `test_container_e2e…test_agent_works_in_a_locked_down_container` |
| no `AGENTCONTROL_VM_TESTS=1` on a KVM host | `test_vm_e2e…test_agent_works_in_a_kvm_clone` |

The three skipped tests were `ContainerRunE2E.test_agent_works_in_a_locked_down_container`,
`DesktopTests.test_desktop_preview_shows_frames_and_accepts_input` and
`VMRunE2E.test_agent_works_in_a_kvm_clone`. The OpenCode trio ran and passed.
The M3.1 real `app.py` HTTP test journal passed history, live SSE update, three older pages to the beginning,
classic decision links and zero frontend writes (673 cached records). M4 preserves the room's read model,
ordering, paging, disclosure state, receipt labels and bounded stale-action revalidation.

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
- **Performance (M2.1):** D6 is implemented as the single `_v7` index `events_run_id ON events(run, id)`.
  On the 439.7 MiB, 100-session × 1,000-tool-event benchmark, median channels/thread times fell from
  1,777.6/3,072.0 ms to **12.9/91.9 ms**. Part A and index-only timings are in the completion report.
- The M1 review lists optional polish items (401 key handling, autocomplete, `/classic/`, live region, pluralisation,
  tab keys, stream backoff reset). None is required, and they can be folded into later UI milestones.
- `/api/state` caps runs at 30. The rail's session list still inherits that in M3; the timeline itself pages the full history through `/api/thread`.
  Reviewed and acceptable: older sessions stay reachable through paging, deep links and "continues" links. M3.1 now shows a
  "Showing 30 of N sessions · older sessions are in the room history" note using the actual counts; M6 replaces the rail's data source.
- For M5: `/api/thread` can mark research and skill items actionable on finished sessions, while `/api/channels.waiting`
  counts only the active session. **An explicit M5 prerequisite:** reconcile it server-side before M5 offers real
  controls (see the M3 review). M3.1 and M4 deliberately do not work around it.
- Still deferred from the accepted M3/M3.1 reviews: focus after Load earlier, partial-session divider counts,
  and live refresh of the single-session fallback view. M4 only adds the outcome Reply link in `thread.js`.

## Next step

1. Opus reviews **M4** and its completion report in `docs/handoffs/M4_COMPOSER.md`.
2. After acceptance, Opus writes the M5 handoff (decision controls). **M5 prerequisite:** reconcile the research/skill
   action versus `waiting` mismatch server-side first (see Known issues).
3. M5–M9 remain unstarted; the architecture contract stays binding.
