# Handoff M6: Members and team

**From:** Opus (architecture) → **To:** Codex (implementation)
**Branch:** `feature/chat-first-redesign`. Commit and push only there; **never merge into `main`**.
**Prerequisites:** M5 is **accepted** (the review is in `docs/handoffs/M5_DECISIONS.md`). Start from `b12e88a` or later.
**Read first, in this order:**
1. `CURRENT_STATE.md`
2. `docs/REDESIGN_ARCHITECTURE.md` (binding; §3, §8, §9, §10 and §12)
3. `docs/handoffs/M5_DECISIONS.md`, the review at the end (finding F1 and optional items O1–O3)
4. this file

**Size:** about 3 days.
- Deliver **Part A as its own commit first.** It is the M5 carry-over: the read model plus one card status line.
- Then Parts B–D, the M6 UI, in one or more commits.

---

## 1. Outcome

The room shows **who is working on the project and how the team is organised**, from recorded state only:

- **Members:** every agent in the selected session, with its presence (symbol and label), its role, its current task
  and how long it has been in that state. Hermes comes first.
- **Team formation:**
  - while Hermes proposes, the panel says so
  - while a plan waits, it shows the **proposed** roster, clearly marked as not running yet, and points to the
    decision card in the room
  - after approval, it shows the **live** roster and the task graph
- **Task graph:** the team's tasks grouped by dependency depth, each with its agent, status (symbol and label), attempts,
  and a link to the task's latest turn in the room.
- **Connections:** the rail indicator gains per-service detail and the existing "Check connections" action.
- **Rail sessions:** the rail's session list stops being limited to `/api/state`'s 30 newest runs. Paging in older room
  history also adds those sessions to the rail.

M6 is a **read-and-display milestone**.
- It adds **no decision controls**. Team decisions stay on the room's proposal card from M5 (architecture §10: "an
  approval appears **once** in the room").
- Its only new POST is the existing `/api/check`, under the shared write lock.

## 2. Hard rules

1. **No API, schema, engine, journal, permission or classic change.**
   - Part A changes only the read-only projection in `conversation.py` and the room's outcome card.
   - Parts B–D are client-only and use responses the client already receives: `/api/state`, the existing
     `GET /api/state?scope=current&run=<id>`, `/api/thread` and `/api/channels`.
   - If something else seems needed, stop and report it.
2. **Recorded state only.**
   - Members come from `state.agents`, which is `agents.describe()` over the recorded agents.
   - The proposed roster comes from `run.team.proposal.agents`. Tasks come from `run.team.tasks`, and the team
     state from `run.team.state`.
   - Never invent a member, a task, a state or a count.
   - A proposed agent is never shown as a live member.
3. **No decision controls in the panel.** The proposal section links to the room's actionable proposal card ("Decide in
   the room"). It never renders Approve, Run as one agent or Ask for another plan, and never POSTs `/api/control`.
4. **No private or workspace material.** Never render anything taken from a step in `state.steps`: transcripts, tool
   output, results, prompts or reasoning. Output tails, terminals and diffs are M7 (Workspaces).
   - Show a member's `task` (the recorded one-line title) and `stats` counts only.
   - Fixtures must contain sentinel strings in step transcripts and results, and tests prove they never render (§8).
5. **Never colour alone.** Every presence and task status has a symbol **and** a label (architecture §8). Use tokens only.
6. **The M4/M5 footer budgets hold.** M6 adds nothing to the footer.
7. **The shared write lock covers `/api/check`** (`core.beginWrite`), so it never overlaps a decision or composer write.

## 3. Part A: M5 carry-over (separate commit, first)

### 3.1 F1: make each on-demand verification observable (read model)

The problem is in `docs/handoffs/M5_DECISIONS.md`, review finding F1.

- **Read model.** In `conversation.project_session`, on the **actionable** outcome only, when `run.manual_verification`
  is a dict, add:

  `detail.verification = {status, created, ended}`

  - Bound it with the existing `Bounds`, and include only the keys present.
  - **Never** include `output`, `argv` or `exit_code`.
  - The field disappears when the outcome stops being actionable. Its `rev` changes then anyway, because `action`
    becomes `null`.
- **Why this is enough.** Each verification has a new `created`. The outcome's `rev` therefore changes when a
  verification starts and again when it ends, and can never return to a value the card has already seen. The M5 card
  then leaves "Sent · waiting…" on the next read, through its existing new-`rev` rule. **Do not change `decisions.js`
  for F1.**
- **The outcome card** (`thread.js`, outcome summary) shows one quiet line from that field:
  "Verification (on demand) · running", "· passed" or "· failed".
  - Map statuses through an explicit table. An unknown status shows the raw status text.
  - This is recorded state, not a delivery status. It never replaces the M5 transient status, and it does not
    replace the recorded system message.

### 3.2 O1: clear the alias draft after a successful hand-off

In `composer.js`, when a decision slash alias resolves to a card (`controls.decision()` returns `''`, which means its
dialog opened or its decision was sent), clear the draft and `acx-draft`.
- On every error (missing target, waiting card, unsupported item) keep the draft, exactly as M5 does.
- Rewrite the M5 test's line 821 (`await h.composer.submit(); assert.equal(posts(h).length,1)`) to assert an empty
  draft, and keep its single-send assertion.

### 3.3 O2 (optional): key-fact fallback

When a permission's `detail.review` has neither `command` nor `file`, the key-fact line shows the first `detail.patterns`
entry. That is classic `requestText()`'s next fallback. Never show an empty line.

### 3.4 Part A tests

- **Python** (`test_conversation.py`, `test_thread_api.py`):
  - the outcome `rev` differs before a verification, while it runs, and after a fast verification that ends with
    the same choices
  - `verification` carries only `status`, `created` and `ended`, with no `output`, `argv` or `exit_code`, even when
    the record has them
  - it is absent on a non-actionable outcome
  - `workspace_status` is still called at most once
  - every existing test passes unmodified
- **DOM:**
  - after a 2xx for Verify now, when a new `rev` with `verification.status: 'running'` arrives, the card leaves
    "Sent" and shows no "Not recorded yet." after three further reads
  - the status line renders all three statuses
  - O1's draft behaviour (and O2's fallback, if you do O2)
- **Real server:** repeat the review's probe (the verifier `true`, `POST /api/control {run, action:'verify'}`, a read
  1.5 s later). Record that the outcome `rev` changed and that the card returned to idle with no "Not recorded yet."

## 4. Part B: Members and team panel

### 4.1 Where it lives

Rename the context panel's **Members** tab to **Team** when the selected session's `mode` is `team`. Otherwise keep
**Members**.

The tab shows, in order:
1. **Members** (§4.2)
2. **Team plan** (§4.3), for team sessions only
3. **Tasks** (§5), for team sessions with tasks

The Session tab is unchanged. "Changes" (architecture §10) is M7.

### 4.2 Members (the roster)

**Source:**
- For the active session: `state.agents`.
- For a selected non-active session: the same field from `GET /api/state?scope=current&run=<id>` (§6).

**Order:** Hermes first, then the order `state.agents` returns, which is recorded join order. Do not sort by name.

Each member is one list item:

| Field | Source | Notes |
|---|---|---|
| name | `name`; for team agents, also `run.team.agents[name].label` if present, as in classic `agentName()`: "coder-1 (API)" | Hermes shows as "Hermes" |
| role | `role` (from `agents.describe`) | specialists (researcher, reviewer) are marked by role text, not colour |
| presence | `state` → the existing `model.js` `presence` table (symbol + label) | an unknown state shows the raw state text with `◌` |
| task | `task` | one line, clamped; empty means nothing is shown |
| since | `since` → `relTime` | only when present (the server sets it only while it matches the state) |
| activity | `stats.turns` and `stats.tool_calls` | "3 turns · 12 tool calls"; for Hermes, "N decisions" from `stats.turns`; pluralised |
| waiting | presence `waiting_on_you` | a "Go to waiting item" link (§4.4) |

The rail's compact member list uses the same model function, so the rail and the panel never disagree.
- While the team plan is `proposing`, `proposed` or `unusable`, and the session is active, the rail also shows one line
  after the members: "Team plan pending". This is text only; nothing is added to the member list.

### 4.3 Team plan (team formation)

The source is `run.team` for the selected session. **Copy the state wording from classic `renderTeam()` and
`autoNote()`**, the existing source of truth for these states:

| `run.team.state` | Panel shows |
|---|---|
| `proposing` | "Hermes is proposing a team. Nothing runs until you approve it." (only while the session is not finished) |
| `proposed` | The **proposed roster**, under the heading "Proposed team · not running yet": each agent's name, label and responsibility, then the warnings (`run.team.warnings`), then "Proposal N" (`run.team.proposals`; **do not hard-code the server's limit**), then a **"Decide in the room"** link (§4.4) |
| `unusable` | "Hermes could not produce a usable team plan:" followed by `run.team.problems` as a list, then "Decide in the room" |
| `single` | "Running with one agent, as chosen", or the Auto note when `run.auto` is set |
| `approved`, `running` | "Team · k of n tasks done", with the live roster in §4.2 |
| `review` | as `running`, plus "Hermes reviews the merged result" |

- When `run.auto` is set, add the Auto note, using `autoNote()`'s outcome wording and `run.auto.reasons`.
- Every string comes from the run record. Bound displayed lists (50 items, 300 characters each) and mark truncation
  with "…and N more".
- **After the session finishes,** `proposing`, `proposed` and `unusable` show "Not decided before the session ended",
  matching M5.0's expired wording. They show no "Decide in the room" link.

### 4.4 Links into the room (no new controls)

- **"Decide in the room"** focuses the room's actionable `proposal` message for that session. That is the message
  whose `action` is set; there is at most one (M5.0). Use the same locate path as the waiting pointer.
  - If the message is not in the loaded cache, page with the existing `loadOlder`, within the shared ten-page budget.
  - If it still is not found, fall back to the session deep link `#/s/<id>`.
  - On phones, close the context sheet before focusing.
- **"Go to waiting item"** (for a member that is `waiting_on_you`) focuses the first actionable non-outcome message
  whose `actor` is that member, using the same locate path. If none is found, use `core.locateWaiting()`.
- These are links and focus moves only. They never POST.

## 5. Part C: Task graph

**Source:** `run.team.tasks` for the selected session. Each task has these fields from the planner: `id`, `title`,
`agent`, `depends_on`, `files`, `status` (`waiting`, `running`, `done`, `failed` or `blocked`), `attempts`, `steps`
and `reason`.

- **Grouping.** Group tasks by dependency depth, using classic `taskDepths()` semantics: depth 0 for no dependencies,
  otherwise 1 + the deepest dependency. A missing dependency id or a cycle counts as depth 0 and must never recurse
  forever. Render the groups **vertically**:
  - headings "Can start now", "After step 1", "After step 2", …
  - each group is a list of task rows
  - no horizontal columns, because the panel is 360 px and phones are 390 px
- **A task row** shows:
  - `id`
  - `title`
  - the agent, with its label as in §4.2
  - "After t1, t2", when there are dependencies
  - the status
  - "· N tries", when `attempts` > 1
  - `reason`, when the status is `failed` or `blocked`, as one muted line
- **Status symbols and labels** (a new table in `model.js`):

  | Status | Shown as |
  |---|---|
  | `waiting` | ◌ Waiting |
  | `running` | ● Running |
  | `done` | ✓ Done |
  | `failed` | ✕ Failed |
  | `blocked` | ! Blocked |

  An unknown status shows `◌` and the raw text.
- **The heading** is "Tasks · k of n done".
- **The latest turn.** When `steps` is non-empty, the task's id is a button. It focuses room message
  `turn:<last step id>`, through the same locate path as §4.4, with the deep-link fallback. Its label names the task:
  `aria-label="Show the latest turn of task t2: Add tests"`.
- **Bounds.** Show up to 50 tasks, and note "…and N more" beyond that.

## 6. Part D: Data, Connections and rail sessions

### 6.1 Selected-session details (one guarded read)

- **The active session** uses the `/api/state` the client already keeps live. There is no extra request.
- **A selected non-active session** needs `run.team`, `state.agents` and the labels, so fetch
  `GET /api/state?scope=current&run=<id>` (the existing route, which the composer already uses):
  - **once per selection,** with a single request in flight and a generation guard: a response for a session that
    is no longer selected is dropped
  - **again** only when that session's entry in `state.runs` changes `status`
  - the response is held in memory only, and discarded on sign-out and 401 (`rejectKey`)
  - while loading, the panel shows "Loading team…"
  - on failure, it shows the server message and a "Retry" button that repeats the read (a GET, so it needs no
    write lock)
- **Do not poll** finished sessions.
- If you also make the composer's details read use this loader, every M4 and M5 test must still pass unchanged.
  Otherwise leave the composer alone.

### 6.2 Connections

The rail's existing `#connections` disclosure gains:
- per service (`state.health.agents`): the name, a symbol and label (`✓ Ready`, or `! Needs attention` for any other
  state) and the server's `label`
- `state.health.message`, as one line
- a **"Check connections"** button that sends `POST /api/check {}`, the existing endpoint the composer already uses:
  - under `core.beginWrite('connections')`, disabled while any write is in flight
  - on success, `core.refreshNow()`
  - on error, the server's message inline

  The composer's existing "Check connections" stays as it is.

### 6.3 Rail sessions (the M3 review's open item)

- **The rail list** is the union, by id, of:
  - `state.runs`, which wins for its live `status`
  - every session already present in the room's thread cache (`thread.sessions`, from pages the room has loaded)
- **Order:** newest `created` first.
- **The cap note** becomes "Showing X of N sessions". X is the number listed; N is `/api/channels`' `sessions` count.
- **A "Load earlier sessions" button** (rail, only while X < N and the cache has `before`) calls the existing
  `core.loadOlder()`. It is the room's own paging, so older room history loads too. That is intended: there is one
  cache.
- No new endpoint, and no per-session status fetch: thread sessions show the status they were recorded with.

## 7. UX: desktop and phone

- **Desktop and laptop.** The Team or Members tab scrolls inside the context panel. Section headings are `h3`. Lists use
  list semantics, and each group in the task graph is a labelled list.
- **Phone (390 × 844).** The context panel opens as today, an overlay or bottom sheet (architecture §10):
  - there is no horizontal scroll
  - links and buttons are at least 40 px high
  - "Decide in the room" and "Show the latest turn" close the sheet, then focus the room message
  - the footer budgets are unchanged (57 / 105 px measured in M5; the limits are ≤ 72 / ≤ 120 px, conversation ≥ 65%)
- **Live updates** keep scroll position and focus: re-render by keyed list items, as the rail does today, never by
  replacing the whole panel while it has focus.
- **Copy.** Use the architecture §11 vocabulary. Say "team plan", not "proposal", in panel headings.

## 8. Tests

**Pure helpers** (`model.js` or a new `members.js`; your choice, but export them):
- the roster order, labels, unknown-state fallback, the "Team plan pending" rule, and pluralised activity
- every team state in §4.3, including finished-session expiry and `run.auto`
- task depths: linear, diamond, missing dependency and cycle, all finite
- task status labels, the done count, and truncation at 50
- the rail union: dedupe, precedence for `state.runs`, order, and the X/N note

**DOM:**
1. **The panel renders only from fixtures.**
   - Proposed agents appear only under "Proposed team · not running yet", never in the live member list or the rail.
   - A finished session's plan shows the expired wording and no link.
2. **No decision controls and no POSTs** from the panel. Clicking every panel link and button sends nothing except
   `/api/check`.
3. **Links.**
   - "Decide in the room" focuses the actionable proposal: loaded, after paging, and through the deep-link fallback.
   - "Go to waiting item" focuses that member's first actionable item.
   - A task's latest-turn button focuses `turn:<id>`.
   - On phones, the sheet closes first.
4. **Selected-session reads.**
   - One GET per selection. A stale response is dropped.
   - The session is refetched when its status changes, and never polled otherwise.
   - A 401 discards the response and returns to sign-in.
   - Retry after an error.
5. **Connections.** The exact body `{}` is sent under the shared lock. The button is disabled during a decision or
   composer write, and vice versa. The server's error is shown.
6. **Rail sessions.** Paged room history adds sessions to the rail. The note counts are correct. "Load earlier
   sessions" uses `loadOlder`.
7. **Privacy.** Fixtures put `TRANSCRIPT-SENTINEL`, `RESULT-SENTINEL` and `PROMPT-SENTINEL` into `state.steps`
   (transcripts, results and prompts). None of them appears anywhere in the DOM.
8. **Guards kept:** tokens only, no classic assets, and every M1–M5 test passes. **No earlier assertion may be
   rewritten** except Part A's single O1 line (§3.2). List it in the completion report.

**Browser matrix:** at desktop, laptop and phone, in light and dark, add:
- `teamProposing`
- `teamProposed`, with the panel open
- `teamUnusable`
- `teamRunning`, with a five-task diamond graph including failed and blocked tasks
- `teamReview`
- a finished team session
- a single-agent session's Members tab
- Connections expanded, with one service needing attention
- the rail with paged sessions

Assert no horizontal overflow, the footer budgets, and 40 px targets on phone. Inspect and name at least the phone
`teamProposed` and `teamRunning` images, and the desktop `teamRunning` image, in the report.

**Real server check (required):** use `app.py` with the existing team fakes from `tests/test_team.py` and
`test_workflow.py`. Record:
- the panel during `proposing` and `proposed`: the proposed roster, with no live phantom members
- after Approve team on the room card (the M5 path): the live roster and the task graph with recorded statuses
- a task's latest-turn link landing on its turn message
- `/api/check`, sent once, with the server's result
- Part A's verify probe (§3.4)

**Python:** only Part A's tests (§3.4). Every existing test passes unmodified.

## 9. Files

| File | Change |
|---|---|
| `agent-autonomy/conversation.py` | Part A only: `detail.verification` on the actionable outcome |
| `agent-autonomy/chat/thread.js` | Part A: the outcome card's verification line (and O2, if done, in `decisions.js` key facts) |
| `agent-autonomy/chat/composer.js` | Part A: O1 draft clearing |
| `agent-autonomy/chat/model.js` and/or `agent-autonomy/chat/members.js` (**new**, `AC.members`) | roster, team state, task graph and rail-union helpers, plus the panel rendering |
| `agent-autonomy/chat/shell.js`, `index.html`, `chat.css` | tab label, panel mounting, Connections detail, rail sessions, script load (cache-busting `?v=6`), styles (tokens only) |
| `agent-autonomy/chat/core.js` | only if needed: expose `thread.sessions` for the rail; no new endpoints |
| `agent-autonomy/tests/fixtures.cjs`, `test_chat_ui.cjs`, `chat_screenshots.cjs` | §8 |
| `agent-autonomy/tests/test_conversation.py`, `test_thread_api.py` | Part A only |
| `docs/REDESIGN_ARCHITECTURE.md`, `CURRENT_STATE.md`, this file | contract notes (§10), status and completion report |

**No change** to `engine.py`, `app.py`, `journal.py`, `agents.py`, `planner.py`, `permissions.py`, `capabilities.py`, the
classic UI, or any other backend file. **No change to `decisions.js` semantics**: O2's key-fact fallback is the only
permitted edit there.

## 10. Contract updates (make them when you finish)

- §6.4 and the change log: "The actionable outcome carries bounded `detail.verification {status, created, ended}`, so
  each on-demand verification changes its `rev`."
- §8: "The Team/Members tab shows the live roster from `state.agents`, the proposed roster from `run.team.proposal`
  (never as live members), team-state wording from classic `renderTeam()`, and the task graph from `run.team.tasks`.
  The panel has no decision controls; team decisions stay on the room card."
- §5.2: add `members.js` if you created it.
- Record that the rail's session list is the union of `state.runs` and the sessions in the loaded thread cache.

## 11. Acceptance

1. `python3 -m unittest discover -s agent-autonomy/tests` passes; report skipped tests by name.
   - Baseline: **420, OK** (6 skipped in the review environment, 3 with OpenCode).
   - An unchanged timing-sensitive test that fails intermittently is rerun and recorded, never modified.
2. `test_ui.cjs` passes 82/82. `test_chat_ui.cjs` passes (139 existing tests plus the new ones). `chat_screenshots.cjs`
   passes, with the budgets.
3. Part A is its own commit. Its new tests fail on `b12e88a` and pass after it; record both runs.
4. The diff touches only the files in §9.
5. The real server check (§8) is recorded.

## 12. When you finish

1. Append a completion report to this file:
   - the Part A and later commits
   - test commands and counts (with skipped tests named)
   - the screenshots inspected
   - the real server check
   - the one rewritten assertion
   - deviations and open questions
2. Update `CURRENT_STATE.md`. Push to `feature/chat-first-redesign`. No PR and no merge unless the owner asks.

If this handoff conflicts with `docs/REDESIGN_ARCHITECTURE.md`, stop and record the conflict instead of choosing silently.

---

## Part A completion — 2026-10-01 (Codex)

F1 projects only bounded `status`, `created` and `ended` from recorded on-demand verification on an actionable
outcome. The existing revision reconciliation now observes fast completion even when the choices return to their
previous value. The outcome shows the recorded status separately from delivery status and recorded system events.
No decision reconciliation or backend execution semantics changed.

O1 clears the draft and `acx-draft` when a decision alias successfully opens its dialog or sends. Missing,
unsupported, restricted, truncated and still-unresolved targets retain their drafts. O2 and O3 were left out.

Regression proof against accepted M5 `b12e88a`, in an isolated git archive with the new test files:
- All three new Python regressions fail: two revision-collision failures and one missing-field error.
- Chat: 138/142 pass; the three new tests and the one authorized O1 rewrite fail.
- After the fix: projection/API 70/70, classic 82/82 and chat 142/142 pass.

The sole rewritten earlier assertion is in **M5 slash aliases use the exact same controls and confirmations**:
the repeated-submit line now first asserts an empty composer and absent `acx-draft`, retaining its one-POST check.
Every other earlier assertion is unchanged.

Browser verification: 156 state/viewport/appearance combinations plus six regressions passed, 220 screenshots.
The real `app.py` probe used the existing workflow fakes and verifier `true`. After one `/api/control` Verify POST,
a first read 1.5 seconds later changed the outcome revision **648751757 → 2457344973**, with identical choices and
recorded `passed` status/times. The card returned to idle and stayed out of “Not recorded yet.” after three further
reads. Inspected `/tmp/ac-m6a-fast-verification-phone.png`.

The first full Python run reached 423 tests in 259.633 s with one unchanged failure:
`test_vm.VMRunTests.test_console_input_is_checked_and_audited` observed a background `push` interleaved between
console operations. Its isolated rerun passed (1 test, 1.203 s). No VM, engine or protected test was changed.
Full-suite rerun result and standalone commit are recorded below before Parts B–D begin.

D7 remains exactly the two accepted guards. The intentionally excluded race where a skill fetch has begun and
its session finishes during the download remains outside scope.

Final Part A full-suite rerun: **423 tests, OK (skipped=3), 260.527 s**. Commands:
`python3 -m unittest discover -s agent-autonomy/tests`;
`PYTHONPATH=agent-autonomy:agent-autonomy/tests python3 -m unittest -v test_conversation test_thread_api`;
`NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_ui.cjs`;
`NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_chat_ui.cjs`;
`NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/chat_screenshots.cjs /tmp/chat-shots-m6a`;
`NODE_PATH=/tmp/ac-tests/node_modules node /tmp/ac-m6a-real-check.cjs`.

Skipped tests (environment gates):
- `test_container_e2e.ContainerRunE2E.test_agent_works_in_a_locked_down_container`
- `test_preview.DesktopTests.test_desktop_preview_shows_frames_and_accepts_input`
- `test_vm_e2e.VMRunE2E.test_agent_works_in_a_kvm_clone`

Part A is committed independently after the status/stat/name/whitespace scope inspection. Its hash will be
recorded in the final M6 report. Parts B–D have not been implemented in this commit.

## M6 completion report — 2026-10-01 (Codex)

**Part A commit:** `813fd9f0f5979147368e09c355f90361e86a34e1` — `Make recorded verification observable for M6 Part A`.
All its required checks completed before that commit and before Parts B–D implementation began. Evidence is above.

**Remaining M6 commit:** the commit containing this completion report, titled `Show recorded members and team plans for M6`.
The final hash is reported separately from Part A when pushing `feature/chat-first-redesign`.

### Recorded members and team

`model.js` exposes pure roster, team-state, task-depth/status and rail-union helpers. `members.js` renders the
Team/Members panel and reconciles keyed rows and controls in place, preserving focus and scroll. Hermes comes
first, followed by the server's join order. Labels, roles, presence symbols, current task, relative state time and
pluralised activity come from recorded state. Neither an empty nor a missing server roster creates a live member.
The earlier pure helper's absent-snapshot default remains for compatibility; both UI surfaces require the actual
server `agents` field.

The proposed roster is a separate list, with classic state wording, warnings, proposal number and the room link.
Finished pending plans show the expired wording. Auto outcomes use classic `autoNote()` wording and recorded
reasons. Lists show at most 50 items and strings at most 300 characters, with omitted-list counts.

Tasks appear in labelled vertical dependency groups with recorded status, attempts and failure/block reasons.
Latest-turn controls retain their identity as a recorded retry changes their destination. Proposal, member-waiting
and task links use existing history paging and share a ten-page budget, including the waiting-pointer fallback.
Phone links close the sheet before focusing; an absent target falls back to its session link.

The live state read stays on the active session. Selected historical details have one memory-only, single-flight
read per selection, with a generation guard, status-only refetch, 401 disposal and GET Retry. This small client
`core.js` query change is needed to avoid polling the historical session through the existing refresh loop.
It changes no endpoint or backend semantics. The composer's existing details read remains independent.

Connections displays each service's recorded symbol/label and server detail. Its only POST is `/api/check {}`
under `core.beginWrite('connections')`, followed by a server refresh; errors remain inline. The rail unions live
runs and loaded thread sessions, preserves live status on duplicate ids, and shares paging with the room.
There are no team decisions in the panel and no use of step transcripts, results, prompts or raw tool output.

### Regressions and permitted earlier-test changes

Final test files run against an isolated archive of **pre-M6 UI `813fd9f`**: **142/167 pass, 25 fail**.
Those failures are 24 of the 25 new M6 tests, plus the owner-authorized rail rewrite. The privacy absence guard
passes before and after, as expected. After implementation, **167/167 pass**. New tests cover helper semantics,
all plan states, pending/live separation, bounds, room links/paging/fallback, phone close-before-focus,
selected-reader races/status/refetch/401/Retry, shared write locks, error text, rail growth, keyed focus and the
three private step sentinels across the entire DOM.

Final-review regressions also reproduced two M6 helper/link defects before their fixes: a displayed task depending
on tasks beyond the 50-row display limit lost its depth, and a superseded paging attempt followed by the waiting
fallback made 11 reads. Each run had **166/167 passing**, with only its new assertion failing. Depth now uses the
full recorded graph before limiting displayed rows; every attempted page consumes the shared ten-read budget.
The final chat run passes all **167/167**.

Exactly two earlier tests are changed across M6:
1. Part A **M5 slash aliases use the exact same controls and confirmations**: the handoff-authorized O1 line
   asserts the empty draft and absent `acx-draft`, retaining the one-POST assertion.
2. **M3.1 rail discloses the real shown and total session counts only when capped**, renamed to
   **M3.1 rail counts use the M6 session union and current count wording**: the old count excludes a loaded
   thread session and its text requires the superseded cap note. M6 §6.3 and §8 conflicted on this test.
   The owner explicitly answered **“Allow only this M3.1 rail-test exception”**. The replacement asserts the
   loaded-session union, actual listed count, and “Showing X of N sessions”, including completed paging.

No other earlier assertion is rewritten, no unrelated test is weakened, and no classic test changes.

### Verification

| Suite | Command | Result |
|---|---|---|
| Full Python | `python3 -m unittest discover -s agent-autonomy/tests` | **423, OK (skipped=3)**, 256.332 s; OpenCode trio ran |
| Projection/API | `PYTHONPATH=agent-autonomy:agent-autonomy/tests python3 -m unittest -v test_conversation test_thread_api` | **70, OK**, 14.427 s; unchanged actionability, workspace-read and D7 regressions included |
| Classic DOM | `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_ui.cjs` | **82/82** |
| Chat DOM | `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_chat_ui.cjs` | **167/167**: 139 accepted M5 + 3 Part A + 25 remaining M6 |
| Browser | `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/chat_screenshots.cjs /tmp/chat-shots-m6` | **210 combinations + 6 regressions**, **290 screenshots**; desktop/laptop/phone, light/dark, 320 px checks, targets, overflow and footer budgets |
| Real M6 server/browser | `NODE_PATH=/tmp/ac-tests/node_modules node /tmp/ac-m6-real-check.cjs` | **Passed**, actual `app.py`/Controller, disposable git project, existing team/workflow fakes |
| Final F1 probe | `NODE_PATH=/tmp/ac-tests/node_modules node /tmp/ac-m6a-real-check.cjs` | **Passed** after integration; `true`, first read after 1.5 s, outcome rev **2670561505 → 2724684457**, recorded `passed`, idle card and no false timeout after three more reads |

The first final Python run reached **423 tests in 360.311 s**, with these three unchanged timing failures:
- `test_agents.ControllerLifecycleTests.test_a_turn_records_join_work_approval_and_finish`: sampled idle-to-finished
  instead of the short working state.
- `test_team.TeamRunTests.test_approvals_from_any_agent_reach_you_and_go_back_to_that_agent`: fixed wait timeout.
- `test_team.TeamRunTests.test_conflicting_tasks_are_retried_with_a_resolution_prompt`: fixed wait timeout.

The exact three-test isolated rerun passed in **5.992 s**, then the full suite passed in **256.332 s**. Evidence:
`/tmp/ac-m6-python-first.log`, `/tmp/ac-m6-timing-rerun.log`, `/tmp/ac-python-verified.log`.
No protected test, lifecycle or engine code was changed. The three skips remain the environment-gated tests named
in Part A above.

The browser's phone measurements remain **57 px idle / 105 px waiting**, waiting row **40 px**, with at least
**70.1% conversation** even when a selected-session header is present. The M4 limits are 72/120 px and 65%.
No footer component was added or changed. All matrix page-error assertions pass.

Actual images inspected under `/tmp/chat-shots-m6` include:
- `teamProposed-phone-light.png`, `teamProposed-narrow-phone-light.png`
- `teamRunning-phone-dark.png`, `teamRunning-phone-dark-tasks.png`, `teamRunning-phone-dark-task-end.png`
- `teamRunning-desktop-light.png`, `teamRunning-desktop-light-tasks.png`
- `singleMembers-phone-light.png`, `connections-phone-light.png`, `railPaged-desktop-dark.png`
- `teamProposing-phone-light.png`, `teamReview-desktop-dark.png`, `teamFinished-desktop-light.png`,
  `teamRunning-narrow-phone-light.png`
Additional real-server renders are included in the same probe.

### Real-server evidence

The gated existing team fake held Hermes while the recorded plan was `proposing`, then released the real planner
into `proposed`. AgentControl already records **Hermes and coder-1** when creating this run; both panel and rail
matched that server roster in both states. The two-agent proposed roster remained separate, and **coder-2 did not
appear as a live member** until AgentControl recorded its join after the existing M5 **Approve team** room action.
The only approval POST was `/api/control {run, action:'approve_team'}`; the panel rendered no decision controls.

The resulting live roster was Hermes, coder-1 and coder-2. The real task graph recorded t1/t2 `running` and t3
`waiting`. A latest-turn button closed the phone sheet and focused the exact `turn:<recorded step id>` message.
One Connections POST sent `/api/check {}`, received the existing **202 `{ok:true}`**, performed exactly one fake
health call, and then displayed the health read back from AgentControl. No successful health state was invented.
The complete paged thread's actionable-card/waiting invariant held: **1 waiting / 1 actionable item / 1 card**
before approval, then **0 / 0 / 0** afterward. JSON evidence is in `/tmp/ac-m6-real-results.json`;
real proposing, proposed, running-task and Connections screenshots are in `/tmp/ac-m6-real-*-phone.png`.

### Scope and remaining limitations

Parts B–D are client-only. The only backend change in all M6 is Part A's two-line, read-only verification projection.
`engine.py`, `app.py`, `journal.py`, `agents.py`, `planner.py`, `permissions.py`, `capabilities.py`, `decisions.js` and
classic files are unchanged from the starting branch. No API, schema or lifecycle change is included.
The required status/stat/name/whitespace inspections cover only §9's permitted files.

- D7 remains exactly its two accepted pre-effect refusals. **The intentionally excluded in-flight skill-fetch race
  remains out of scope**: a session can finish after an accepted fetch has begun downloading. No additional guard,
  cleanup or lifecycle change handles it.
- Optional M5 O2/O3 are not implemented. Native phone keyboard/device verification and the accepted M8 history
  focus/accessibility follow-ups remain deferred. Chromium checks include emulated viewport shrinkage and phone sizes.
- The three environment-gated Python skips are named in Part A above; OpenCode tests run in this environment.
- There is no M7 work, PR or merge into `main`. Push is only to `feature/chat-first-redesign`.
