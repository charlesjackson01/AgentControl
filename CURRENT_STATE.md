# Current state

**Last updated:** 2026-10-02, by Opus (G3 round 2 passed per owner report; awaiting explicit "G3 cleared"; Part B not authorised).
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
| Handoffs | `docs/handoffs/`. **Current:** owner device run (`docs/DEVICE_CHECKLIST.md` round 2); M9.1 is accepted |
| Earlier design docs | `docs/MULTI-AGENT-PLAN.md`, `docs/UI-UX-AUDIT.md`, `docs/W7LiveEvents.md`, `docs/M0-SPIKE-REPORT.md` |

## Redesign progress

| Milestone | Status | Owner | Notes |
|---|---|---|---|
| Planning: decisions D1–D5 | ✅ done | Opus | recorded in the architecture doc §2 |
| **D6 events index** | ✅ **approved by the owner 2026-09-30** | owner | exactly one `events(run, id)` index via migration `_v7`, implemented in M2.1 Part B; a narrow exception to the no-migration rule, not permission for other schema changes (architecture §2 and §3) |
| **D7 engine guards** | ✅ **approved by the owner 2026-09-30** | owner | limited exactly to M5.0 Part B: `decide_research` refuses finished or stopping sessions, and `fetch_capability` refuses finished sessions, before any write, audit, download or other effect. Not permission for broader engine, lifecycle, approval, skill, research, API or schema changes |
| D1 backend merge | ✅ done | Opus | `af4da89`; tree = `967aa85` + redesign docs |
| **M1 App shell** | ✅ accepted (review 2026-09-30) | Codex | read-only `/chat`, `/classic` alias; completion report and Opus review in `docs/handoffs/M1_APP_SHELL.md` |
| **M1.1 Shell corrections** | ✅ accepted (review 2026-09-30) | Codex | `docs/handoffs/M1_1_CORRECTIONS.md`: stale links recover with a notice; scrim follows visible panels; DOM and browser regressions pass |
| **M2 Thread read model** | ✅ accepted, with corrections (review 2026-09-30) | Codex | `conversation.py`, `/api/channels`, `/api/thread`, `Store.events_page`; review in `docs/handoffs/M2_THREAD_READ_MODEL.md` |
| **M2.1 Read-model corrections** | ✅ accepted (review 2026-09-30) | Codex | Parts A + B: recorded-session request attribution, stable outcome actions/revisions, non-empty planner decisions, cheaper reads, and exactly the D6 `_v7` index; 15 new regressions |
| **M3 Room timeline** | ✅ accepted (with M3.1, review 2026-09-30) | Codex | `thread.js`: read-only project room, keyed updates, paging, session disclosure, deep links and waiting pointers; completion report in `docs/handoffs/M3_ROOM_TIMELINE.md` |
| **M3.1 Timeline corrections** | ✅ accepted (review 2026-09-30) | Codex | `docs/handoffs/M3_1_CORRECTIONS.md`: classic receipt labels, server revalidation capped at ten pages with history reset, separate waiting lines, exact strip wording, real rail cap note; eight new regressions |
| **M4 Composer** | ✅ accepted (with M4.1, review 2026-09-30) | Codex | measured 57 px idle / 105 px with waiting / ≥ 75.3% conversation at 390 × 844; the native keyboard is unverified (M8) |
| **M4.1 Composer corrections** | ✅ accepted (review 2026-09-30) | Codex | `docs/handoffs/M4_1_CORRECTIONS.md`: only allowed preferences remembered; title/checks/dirty acknowledgement reset; isolated follow-up overlay; leading-only `@agent`; literal content and empty-room copy corrected |
| **M5.0 Actionability (M5 prerequisite)** | ✅ **accepted (Parts A and B; review 2026-10-01)** | Codex | `docs/handoffs/M5_0_ACTIONABILITY.md`: shared action predicates and exact paged-thread waiting count; expired research/skill label; exactly the two D7 guards; in-flight fetch race excluded |
| **M5 Decisions in the room** | ✅ **accepted (Parts A `e6e6ebf` and B `b12e88a`; review 2026-10-01)** | Codex | every room decision uses its existing endpoint with server-authoritative state. Owner authorized only the awaiting-fetch skill Reject endpoint exception. F1 (fast verification reconciliation) is corrected in M6 Part A. The review is in `docs/handoffs/M5_DECISIONS.md` |
| **M6 Members and team** | ✅ **accepted (Part A `813fd9f`, M6 `7134ada`; review 2026-10-01)** | Codex | `docs/handoffs/M6_MEMBERS_AND_TEAM.md`: standalone Part A `813fd9f` fixes verification and alias drafts; recorded roster, separate proposed team, vertical task graph, Connections check and shared-history rail are complete. Final commit contains the completion report. No new APIs or panel decisions. S1 is corrected in M7 Part A: stopping plans are not pending, and every never-approved roster remains explicitly proposed |
| **M7 Workspaces** | ✅ **accepted (Part A `fb8c90f`, M7 `9b97b51`; review 2026-10-01)** | Codex | `docs/handoffs/M7_WORKSPACES.md`: standalone Part A `fb8c90f` fixes S1; final commit `Add read-only agent Workspaces` contains the completion report. Parts B–D add read-only, POST-free `#/w/<run>/<agent>` Workspaces with turns, classic stages, terminal, changes, verification and recorded logs. Active data adds no read; historical data shares M6's one GET. Surfaces use the classic pop-out; native surfaces need their own handoff before M9 |
| **M8 Phone and accessibility** | ✅ **accepted (A `68c7cab` … E `2741085`; review 2026-10-02)** | Codex | `docs/handoffs/M8_PHONE_AND_ACCESSIBILITY.md`: deferrals closed, tablet/landscape layouts, keyboard and focus trap, announcements, tested contrast (border tokens only), 672-combination matrix, `docs/DEVICE_CHECKLIST.md`. N1 (the rail disclosure when X > N) is corrected in M9 Part 0 `568534e` |
| **M9 Parity and cutover** | ✅ Part 0 + A accepted; **G1 cleared, G2 (a) approved, G3 round 1 failed; M9.1 corrections; Part B not authorised** | Codex, then the owner | Separate Part 0 `568534e` fixes N1 with its sole owner-approved earlier assertion replacement. Part A adds `docs/PARITY_CHECKLIST.md`: 72 rows (17 Native, 54 Linked, 1 intentionally not ported, 0 Missing), real `/chat` walkthrough and readiness findings. Completion reports in `M9_PARITY_AND_CUTOVER.md`. **Stopped before Part B:** G1 cleared, G2 choice (a) recorded; G3 pending |
| **M9.1 Device corrections** | ✅ **implementation accepted (re-review 2026-10-02, `fd3c4d3`)** | Codex | `docs/handoffs/M9_1_DEVICE_CORRECTIONS.md`: 16 px inputs; app and sheets follow the visible area above the keyboard, frozen while pinch-zoomed; rail waiting line and visible Workspace links; isolated device fixture confined to its temporary folder; reliable focus return. **Physical-device checks: Not performed** |
| R1 Persistent bots | roadmap only | owner | architecture §12.1; needs its own owner decisions; not part of M8 or M9 |

The isolated frontend is in `agent-autonomy/chat/`: `index.html`, `tokens.css`, `chat.css`, `core.js`, `model.js`, `thread.js`, `decisions.js`, `composer.js`, `members.js`, `workspace.js`, `shell.js`.
`/chat` shows real project sessions, members and Connections, with authenticated SSE and polling fallback.
The room composer starts sessions and follow-ups, sends notes and offers the M4 controls through existing endpoints.
Actionable cards now expose the M5 permission, question, team, research, skill and outcome decisions in the room.
Classic remains the fallback for truncated or unsupported review; `/` and `/classic` serve the unchanged classic UI.
The new read-only endpoints project the journal with bounded messages, stable ids/revisions and cursor paging.
The timeline and channel rail consume `/api/thread` and `/api/channels`; `/api/state` supplies live members and Connections; a guarded historical read supplies selected team details. The rail combines live runs with loaded thread sessions. The client retains only a page-lifetime read cache, with no writable message store or local submission echoes. Allowed Settings preferences use `acx-settings`; unsent drafts use session-only `acx-draft`.
M4.1 cleans legacy stored titles/checks, preserves per-session fields on failed starts, and clears them after success
or follow-up cancellation. Inherited follow-up preferences are remembered only when explicitly edited in Settings.
Only a valid leading `@agent` routes a note; later, unknown, package and decorator tokens stay literal.
M5.0 removes research, skill and proposal actions from finished/stopping sessions, derives `detail.expired` for
leftover waiting research/skills, and counts waiting from the same item predicates. Requests and M2.1 outcomes
retain their existing rules. The two D7 refusals precede effects; skill fetches in stopping sessions stay allowed.
M5 Part A adds only bounded, explicitly selected review inputs on actionable permissions and proposed skills,
plus the actionable outcome's branch/change summary. Unsupported or truncated review material sets
`review_truncated`; historical messages, privacy filters, action predicates and existing bounds are preserved.
M5 Part B uses only existing endpoints and server actions. `/verify`, `/apply`, `/discard` and `/team` use the same
card decisions and confirmations. Only delivery status is transient browser state; messages, receipts, waiting
markers and counts change through fresh server reads. Shared write locking, stale-dialog notices, network
uncertainty and three-refresh/15-second Refresh recovery are covered. Critical, research and skill evidence is
expanded by default; phone dialogs are full-width bottom sheets with Cancel focus and 40 px targets.
M6 Part A projects bounded recorded verification status/times on actionable outcomes and clears successful decision-alias drafts. It preserves the existing revision reconciliation and server authority.
M7 Part A aligns team-panel pending state with not-terminal/not-stopping actionability and keeps never-approved rosters labelled as proposed.
M6 adds recorded member labels/presence/activity, classic team-plan wording, vertical dependency groups and latest-turn links. Proposed agents remain separate from recorded members, and panel links only focus room cards. Historical details are read once per selection and again only on a status change. Connections checks share the existing write lock. Rail history and room history share paging; keyed updates preserve focus and scroll. Step transcripts, results and prompts never enter this panel.
M7 opens Workspaces from turns, recorded member rows and assigned tasks. Back/Escape restore the room and focus.
The desktop pane keeps the room usable; laptops use an overlay and phones a full-screen sheet. Raw `/api/state`
step material appears only in the open Workspace. Reasoning, unknown transcript types, `tool_results` and Hermes
requests are excluded; recorded strings are escaped and output URLs remain text. Latest follows new turns and
output; scrolling up pauses follow, and keyed updates preserve focus and disclosures. Historical reads are shared
with members in `core`; a live read begun before Workspace opens still updates the active snapshot. There are
no Workspace POSTs, independent reads, timers, frames or surface input. M3's bounded public room projection,
M5 server authority/actionability and D7 are unchanged.
Backend read-model tests: `tests/test_conversation.py` (51) and `tests/test_thread_api.py` (19); journal tests (7) include v6-to-v7 preservation and index query plans.

## Tests (M7, based on `0878af1`; verification 2026-10-01)

| Suite | Command | Result |
|---|---|---|
| Backend (Python) | `python3 -m unittest discover -s agent-autonomy/tests` | **423 tests, OK (skipped=3)**, 259.153 s; unchanged suite |
| Classic DOM | `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_ui.cjs` | **82/82 passed** |
| Chat DOM | `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_chat_ui.cjs` | **215/215 passed** (167 accepted M6 + 48 M7 regressions); 9,984 classic stage comparisons; earlier decisions, delivery and paged waiting invariants preserved |
| Chat browser matrix | `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/chat_screenshots.cjs /tmp/chat-shots-m7d` | **276 combinations + 7 regressions passed**, 441 screenshots; desktop/laptop/390/320 px, light/dark, keyed output and a held-live-read race; phone footer **57 px idle / 105 px waiting**, row 40 px, conversation ≥ 70.1% with sheet closed |
| Projection + HTTP | included unchanged in the full Python command | **70 existing tests**, including M5.0's paged waiting invariant and exact D7 guards; no new Python tests or API semantics |
| Real server + Chromium | `NODE_PATH=/tmp/ac-tests/node_modules node /tmp/ac-m7-real-check.cjs` | **Passed**: zero extra active-open requests; transcript grows through the normal live read; real diff + passed verification; exactly one shared historical GET; pop-out HTTP 200; zero POSTs; fully paged waiting/actions/cards invariant |

DOM test dependencies (test-only, installed outside the repo):
`npm install --prefix /tmp/ac-tests --no-save linkedom cssom playwright-core`.
Chromium was found under `~/.cache/ms-playwright` in this environment; the screenshot script discovers it or accepts `CHROMIUM_PATH`.
The socket-based backend tests and Chromium ran outside the sandbox after their socket setup was refused inside it.
M5's room decision checks and screenshots use fresh runs. Desktop and phone renders were inspected for critical
review, research, skill install, questions, team, Apply and delivery/error states. The M6 phone footer is
57 px idle / 105 px waiting, with at least 70.1% conversation when a selected-session header is present (75.3% in the earlier unselected M5 cases). Earlier composer verification included literal/targeted notes,
cleaned legacy Settings and restored Settings after cancelling a follow-up.
The M4 report records the fake-backed real HTTP/browser start, note, targeting, rename, check,
pause/resume/stop and follow-up checks. Keyboard viewport shrinkage to 480 px passed in Chromium;
an actual phone OS keyboard was unavailable. The prior review environment used `/opt/pw-browsers/chromium`.

**Skipped tests are environment-gated. Report them by name, not only by count (three skipped in this run):**

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
Part A's first full Python run overlapped browser/HTTP verification and hit five unchanged workflow timeouts;
all five passed in an isolated rerun, and the subsequent sequential full suite passed. Names and evidence are
recorded in the M5 Part A completion report. No protected test or engine code was changed.
Part B's first full run hit three host Podman image-inspection errors and two unchanged container-fixture waits.
All four distinct tests passed in isolation (6.889 s), then the full verbose suite passed. Exact names and
logs are in the M5 completion report; no protected tests, runtime configuration or engine code was changed.
M6's first final full run hit the unchanged lifecycle sampling assertion and two fixed-timeout team waits.
All three passed together in isolation (5.992 s), then the full 423-test rerun passed (256.332 s).
Exact names and results are recorded in the M6 completion report; no protected test or backend was changed.
M7 Part A was verified and committed before B. B's first full run hit three unchanged specialist timeouts;
all three passed together in isolation (2.409 s), then the full suite passed (257.249 s). C passed its full gate
(257.483 s) before D began. The completion report records each gate and regression proof, including exactly
two owner-authorized earlier-test rewrites. No protected backend test or engine code was changed.
M7's final Python verification hit intermittent protected-test failures in four attempts: Podman inspection,
fixed workflow/skill waits, lifecycle sampling and an asynchronous VM log assertion, including teardown races.
Every failing test passed in isolation; the fifth unchanged full run passed (259.153 s), with no other shell
checks alongside it. Exact names, outcomes and preserved logs are in the M7 report. No runtime setting or skip
was changed.

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
- `/api/state` caps runs at 30. M6 unions those entries with loaded thread sessions, so rail paging grows the
  list using the room cache. The incomplete-history count is “Showing X of N sessions”; the disclosure is hidden when X = N. No per-session rail fetch is added.
- **M5.0 accepted (`M5_0_ACTIONABILITY.md`).** Thread actions and `channels.waiting` now use
  the same predicates. Fully paged journals match exactly, including leftover research/skills, stopping sessions,
  missing fingerprints, duplicate packets and proposal history. Exactly the two D7 guards refuse dead research
  decisions and finished-session skill fetches before effects.
- **Intentionally excluded skill-fetch race (D7 boundary):** a session can finish while a fetch accepted earlier
  is already downloading outside the controller lock. Existing post-fetch behaviour is unchanged; no new guard,
  cleanup or lifecycle change handles this case in M5.0 or M5–M8.
- **M5 F1 corrected in M6 Part A.** The actionable outcome projects recorded `detail.verification {status, created, ended}`, preventing a fast verification from returning to its pre-verification revision. No `decisions.js` change. Successful slash aliases also clear their draft; errors retain it.
- **M8 rail assertions confirmed by the owner (2026-10-02).**
  - All three rewrites stand: the M3.1 DOM test, the M6 post-paging check, and the browser `railPaged` check.
  - They cover **only** the completed-history wording (X = N → no disclosure).
  - Incomplete-history, pagination and session-count checks remain intact.
- **N1 approved as M9 Part 0 (2026-10-02).** When X > N, the disclosure is hidden. Counts and pagination are
  unchanged.
- **M9 gates (updated 2026-10-02).**
  - **G1 is cleared** (17 Native, 54 Linked, 1 not ported; classic stays at `/classic`; C1 approved).
  - **G2 is approved: (a).**
  - **G3 is pending.**
  - **The cutover (Part B) must not start** until the owner explicitly clears G3.
- **M8 rail disclosure approved by the owner (2026-10-01).**
  - The behaviour:
    - "Showing X of N sessions" is hidden when every session is listed (X = N).
    - It is shown with correct counts while history is incomplete (X < N).
  - The scope is the rail presentation only. Pagination, session-count semantics and the data source are unchanged.
  - The named M3.1 assertion now hides the complete-history disclosure. The owner additionally authorized only
    the M6 paging test and browser `railPaged` complete-history assertions to change from “Showing 35 of 35
    sessions” to no disclosure. All their other count and paging assertions remain intact; the M8 report records this.
- **M5 endpoint clarification resolved by the owner:** only Reject on an actionable awaiting-fetch skill may
  use `/api/skills/decide` when its accepted action names `/api/skills/fetch`. Every other decision uses the
  action's named endpoint and choices. No backend or action-shape change was required.
- M8 Part A corrects Load earlier focus/anchor/busy state, partial-session divider counts and single-session live
  fallback refresh (one known-stub GET per existing cycle while non-terminal). Native phone-keyboard verification
  remains deferred to the owner device checklist; M4 verified `visualViewport` emulation only.

## M9 Part 0 verification (2026-10-02)

- N1 changes only the disclosure condition to `sessions.length < total`; the rail union, server counts and paging
  are unchanged. New X > N regression fails on the `2741085` product code and passes after the fix.
- Owner approved exactly one older-test exception: replace the M3.1 “Showing 3 of 2 sessions” assertion with
  disclosure absence. X = N, X < N, counts and paging assertions remain unchanged. Exact before/after is in the
  handoff completion report.
- Final Python **423, OK (skipped=3), 258.358 s**; classic **82/82**; chat **240/240**;
  browser **672 combinations + 51 regressions**, 1,139 screenshots. Inspected text-zoom Team and Workspace renders.
- First two full Python runs repeated the known lifecycle sampling and asynchronous VM console-log failures.
  Both then passed together in isolation (6.941 s) and in the final full run. The failures match M7 and M8's
  established flakiness; no backend, protected test, runtime setting or skip was changed. Logs and exact names are
  retained in the M9 handoff report.

## M9 Part A verification (2026-10-02)

- Completed after the separately committed/pushed Part 0 `568534e`; Part A changes **docs only**.
- Complete parity checklist: **72 feature/view/facet rows**, including all **15 README bullets** and **12 classic
  views/navigation surfaces**. **17 Native / 54 Linked to classic / 1 intentionally not ported (D4) / 0 Missing**.
  Generic More links open `/classic`, then the user selects the destination. Zero Missing does not claim full native parity.
- Real `app.py`/controller with existing fakes and one disposable git project: **8/8 `/chat`-only steps**, zero classic
  document loads and page errors. Start, critical typed approval, question, team approval, growing Workspace,
  Verify, confirmed Apply and Reply follow-up all use recorded server state. Waiting/non-outcome actions and
  cards/outcomes match at every fully paged checkpoint. Actual counts: **67 GET (64 API) / 8 POST**; separate Auto
  evidence check **2 GET / 1 POST**. Exact bodies and per-step counts are in the checklist/report.
- Fresh final suites: Python **423, OK (skipped=3), 319.958 s**; classic **82/82**; chat **240/240**;
  browser **672 combinations + 51 regressions**, **1,139 screenshots**. Desktop/phone renders inspected;
  footer budgets preserved and accessibility/contrast/keyboard checks pass. No further Python failures in Part A.
- Readiness inventory documents the current root pop-out href and every located route/test/doc assumption; no
  link, route, backend, schema, approval, privacy, D7 or protected test changed in Part A.
- **M9 Part A complete; awaiting owner gates G1–G3.** G2 choice (a) is already recorded. G1 parity and G3 physical
  devices remain pending. No Part B, native surfaces, classic retirement, R1 work or merge into `main`.

## Next step

1. **G3 round 2 passed, per the owner's report** (2026-10-02, "Checklist passed!"). It was run with the isolated
   fixture over the tailnet, and the results are in `docs/DEVICE_CHECKLIST.md`. Device versions were not supplied.
2. **The owner records "G3 cleared"** to finish the gate. G1 is cleared, and G2 (a) is approved.
3. Only after that may Codex implement **M9 Part B**: routing `/` → chat, `/classic` and `/classic/` → classic, the C1
   `/?popout=…` compatibility rule, the chat pop-out href, and the README. Merging into `main` and retiring classic
   remain separate owner decisions.

Still deferred:
- native surface viewing and input (G2)
- native phone-keyboard and assistive-technology testing (G3)
- the in-flight skill-fetch race (the D7 boundary)
- R1 persistent bots (the roadmap, architecture §12.1)

Separately, for the owner: the timing-sensitive backend tests keep needing reruns (M7, M8).

## M9.1 Part A verification (2026-10-02)

- Synced clean `feature/chat-first-redesign` to approved handoff commit `3012231`.
- Text entry uses a root-zoom-responsive 16 px token; app height/top and sheet bounds follow the visual viewport,
  with top compensation disabled outside scale 1 ± 0.01. Following and scrolled-up timeline positions are preserved.
- Regression proof against the unchanged `62cf3cc`/`3012231` frontend: 241/244 DOM (three new defect tests fail;
  the no-visualViewport preservation test passes). All six new fake-viewport browser cases fail before fixes.
- After fixes: chat 244/244, classic 82/82; full browser matrix 672 combinations + 57 regressions, 1,151 renders.
  Portrait/landscape idle/waiting footers remain 57/105 px. All existing budget, contrast, accessibility, zoom
  and privacy assertions remain; no earlier assertion rewrite. Full Python verification runs at the final Part C gate.
- Real iOS/Android keyboard, pinch zoom and assistive technology still require the owner's device re-test.
  M9 cutover remains unauthorised; G1 cleared, G2 (a) recorded, G3 pending.

## M9.1 Part B verification (2026-10-02)

- Part A committed separately as `fdbc64a` before discoverability work.
- Rail Waiting reads the same channel count as the footer; it calls locateWaiting and closes the drawer.
  Empty/quiet room text explains room cards. No new decision controls or writes.
- One Workspace link now sits outside each turn's collapsed Details. Active recorded members get rail and
  session-menu links; proposed-only agents never do. New navigation preserves visible opener focus.
- Before fixes: all seven new DOM regressions fail (244/251) and all four new phone/landscape browser cases fail.
  After: chat 251/251, classic 82/82, four discovery cases pass in light/dark; footers unchanged at 105 px with waiting.
- Only the M3 turn test's Workspace-location assertions were moved, as explicitly authorised by M9.1. All its
  other assertions are unchanged. Final Python/full browser verification runs after Part C. G3 remains pending.

## M9.1 Part C and final verification (2026-10-02)

- Separate A `fdbc64a` and B `9d33510` precede C. The B commit includes the final matrix's missing-space
  correction in a new member link; the unchanged earlier browser assertion remains intact.
- `tests/device_fixture.py` runs real HTTP/controller with existing fakes, fresh key, disposable git project
  and temporary state. It prepares two actionable requests (critical permission + question), growing live coder
  output and a completed turn with diff/passed verification. Default loopback; phone access requires explicit
  `--host`. Ctrl+C removes its temporary project/state. No owner project or state is touched.
- New smoke test fails before the fixture exists, then passes (0.559 s). Final Python **424, OK (skipped=3),
  260.630 s**, run alone; no timing failures or retries. All 423 earlier tests are unchanged. The same container,
  desktop-preview and KVM tests remain environment-gated; OpenCode tests run. Two nonfatal unclosed-socket
  ResourceWarnings appear in the log; no protected backend or test changes.
- Fresh classic **82/82**, chat **251/251**, browser **672 combinations + 61 regressions**, **1,163 screenshots**.
  All six fake-viewport cases and four discovery cases pass. **1,672** accessibility/input-font audits (minimum
  16 px), 52 contrast pairs, 32 keyboard cases and four reduced-motion/forced-colors cases pass.
  Footers **57 px idle / 105 px waiting** in both orientations; conversation ≥ **70.0829% portrait / 58.3333%
  landscape**. No budget or earlier geometry assertion weakened; user zoom preserved.
- Real fixture/Chromium: fully paged waiting **2 = 2 actionable non-outcome messages**, one critical permission
  and one question; rail Workspace adds **zero GETs**, output grows through recorded state, turn 1 has a real
  captured diff and passed verification. **Zero browser POSTs or page errors**; shutdown cleanup passes.
  Actual desktop, phone, landscape and tablet renders inspected, including real fixture Workspaces.
- `docs/DEVICE_CHECKLIST.md` records round 1 honestly and gives exact fixture, appearance, screen-reader and
  eight physical verification steps. Every round-2 result is **Not performed**. Native OS keyboards, pinch zoom,
  VoiceOver/TalkBack remain unverified. Stop for Opus review, then owner re-tests. **G3 pending; no M9 cutover.**

## M9.1a correction verification (2026-10-02)

- Synced a clean feature branch to review commit `ee2e871`. Only F1–F3 implemented, in one commit; the
  appended report corrects the earlier fixture-isolation, zoom and focus claims identified by Opus.
- Fixture-only `projects_root` uses the disposable root. Real HTTP tests reject outside absolute, parent and
  symlink paths, exercise allowed creation/selection and a subsequent fake-coder write, and verify outside
  disposable data is unchanged and shutdown removes the root. Before: 11 assertion failures; after: one test OK.
- Pinch scale 2 with height halved freezes both viewport variables and draft sizing; normal keyboard handling
  resumes at scale approximately 1. Only the explicitly superseded DOM/browser zoom assertions change.
- The intermittent focus race was a live header `innerHTML` replacement detaching the returned menu entry;
  the captured failure had the context sheet hidden. Existing keyed rendering preserves the entry. Closed or
  removed entries return to the visible summary; a previously closed context sheet stays closed.
- New DOM regressions fail on `d738e33` (250/255), then pass (255/255). Classic **82/82**. Discovery **10
  consecutive runs, 40/40 cases**, followed by the full fatal matrix: **672 combinations + 61 regressions,
  1,163 screenshots**. Keyboard, accessibility, contrast, forced-colors and footer budgets pass unchanged.
- Python final result: **424 tests, OK (skipped=3), 260.273 s**, on the full retry run alone. Container, desktop
  preview and KVM end-to-end tests remain environment-gated, not passes; real-OpenCode tests run and pass.
  The first full run had four unchanged five-second
  workflow timeouts and one missing-inbox error (424 tests, three environment skips, 414.246 s). All five passed
  unchanged together in isolation (5.332 s), then in the full retry. Nonfatal unclosed-socket warnings remain;
  exact names and comparison with earlier flakiness are in the report. No protected tests or backend changes.
- Real standalone fixture/Chromium passes: root confinement, waiting **2 = 2 actionable requests**, zero extra
  active Workspace reads, recorded output growth/diff/passed verification, Back/refresh/Escape/summary focus,
  **36 GET / zero browser POST / zero page errors**, and shutdown cleanup. Actual desktop, tablet, portrait and
  landscape renders inspected. Native device results remain **Not performed**; stop for Opus re-review.
