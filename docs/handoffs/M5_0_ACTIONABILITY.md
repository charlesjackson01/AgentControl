# Handoff M5.0: One definition of "actionable" (the M5 prerequisite)

**From:** Opus (architecture) → **To:** Codex (implementation)
**Branch:** `feature/chat-first-redesign`. Commit and push only there; **never merge into `main`**.
**Status:** **Parts A and B are both required before M5.** The owner approved **D7** on 2026-09-30, limited exactly
to Part B as written in §4.
**Starting point:** M4 and M4.1 are **accepted** (review 2026-09-30, commit `581b382`). M4.1's `thread.js` empty-state
change has already landed, so M5.0 changes only the research and skill label in `thread.js` (§3). The backend facts
in §1 were re-checked against `581b382`: `conversation.py`, `engine.py` and `app.py` are unchanged since M2.1.
**Read first:**
1. `CURRENT_STATE.md`
2. `docs/REDESIGN_ARCHITECTURE.md` §3 and §6
3. the M3 review note in `docs/handoffs/M3_ROOM_TIMELINE.md`
4. this file

---

## 1. The problem, precisely

Today, two read paths disagree about what is waiting for you, and neither matches what the engine can actually do.

| Item | `/api/thread` gives it an `action` when… | `/api/channels.waiting` counts it when… | What the engine does for a **finished** session |
|---|---|---|---|
| research step | `step.status == 'awaiting_approval'` and there is a `request` (**no session-state check**) | the step belongs to the active, non-stopping session | `decide_research` **accepts approve** (it checks only the step status). But approved research runs only inside the session's control loop (`_research_poll`, called from `_drive` and `_run_tasks`), which no longer exists, so **the approval is recorded and audited, and nothing ever runs**. `_end()` leaves the step `awaiting_approval` for ever. Classic's `research_requests()` hides it (it skips finished sessions) |
| skill item | `state in ('proposed', 'awaiting_fetch')` (**no session-state check**) | the item belongs to the active, non-stopping session | `decide_capability` **refuses approve** ("no longer has a worktree"), allows reject, and `fetch_capability` still fetches from the network. `_retire_skills` rejects leftovers only on **Apply or Discard**, not when the session ends |
| team proposal | `team.state == 'proposed'` and the session is not finished (**stopping is not checked**) | the active, non-stopping session | `_team_decision` refuses finished sessions (it does not check `stop`) |
| request (permission or question) | the session is not finished **and not stopping** | the active, non-stopping session | `review()` refuses finished or stopping sessions (`ReviewConflict`) |

So `/api/thread` currently offers a research approval that can never execute, skill actions whose approve path is
refused, and proposals during a stop. `waiting` does not count any of these.

## 2. The rule: which source is authoritative

**What the engine can meaningfully act on decides actionability**, and that is the rule `waiting` already uses.
Classic uses it for research too: an item is actionable only while its session **accepts decisions**.

```
accepts_decisions(run) = run.status not in TERMINAL and not run.get('stop')
```

For each item kind:

| Kind | Actionable when | `action` |
|---|---|---|
| request | `accepts_decisions(run)` and the packet is pending, as today | unchanged |
| proposal | `accepts_decisions(run)` and `team.state == 'proposed'` and it is the newest proposal | unchanged shape |
| research | `accepts_decisions(run)` and `step.status == 'awaiting_approval'` and there is a `request` | unchanged shape |
| skill | `accepts_decisions(run)` and `state in ('proposed', 'awaiting_fetch')` | unchanged shapes (fetch / decide) |
| outcome | **unchanged** (the channel's newest terminal session, M2.1) | unchanged |

**Items that were left undecided when a session ended.** A research or skill item whose state still reads as waiting,
but whose session no longer accepts decisions, gets `action: null` and **`detail.expired: true`**. That is a flag
derived from recorded state; its text is never fabricated. The recorded `status` and `state` values are **not rewritten**.

**One definition, used twice.** `channels.waiting` must be computed from **the same item predicates** as the thread's
actions, so the two can never drift apart again: the number of non-outcome items in the active session that are actionable under the table above.

## 3. Part A: the projection (required; read-only; no owner decision needed)

It belongs in the **projection layer** (`conversation.py`), because this is a presentation and read-model rule
inside D5's scope. It changes no engine state, journal row, endpoint shape, or approval behaviour.

- Add `accepts_decisions(run)` and small pure predicates (`research_actionable`, `skill_actionable`,
  `proposal_actionable`) in `conversation.py`. Use them in `project_session()` for the research, skill and proposal actions.
  Requests already follow the rule.
- Set `detail.expired = true` on research and skill items that are waiting by state, but whose session does not accept decisions.
- Rewrite the waiting count in `channels()` to use the same predicates on the active session's steps, capabilities,
  pending packets and team state. The result is identical to today's number in every case where today's number was correct.
- **Frontend label** (the one `thread.js` change): when `detail.expired` is true, research and skill lines show a muted
  "Not decided before the session ended" in place of their waiting status. No other UI change.
  - In `body()`, the `research` case renders `statusText(d.status)` (for example "Awaiting approval"). Replace that
    part only, and keep "research · ‹title›" and the Details.
  - The `skill` case renders `[message.text, d.agent, d.state]`. Replace `d.state` with the label, and keep the name, agent and Details.
  - `action` is already `null` for these items, so no waiting line or classic link renders. Do not add any.
- **Contract:** add to architecture §6.4 and the change log: "Actionable = the session accepts decisions (not finished,
  not stopping), except outcomes (M2.1 rule). `channels.waiting` counts exactly the actionable non-outcome items of the
  active session. Items waiting by state in a session that no longer accepts decisions carry `detail.expired`."

### Existing behaviour affected

- Research and skill items in finished or stopping sessions lose their `action` and "Waiting for you" marker, and show
  the expired label. Their `rev` changes once, and clients revalidate normally, through the M3.1 bounded rules.
- A team proposal in a **stopping** session loses its `action`. That matches `waiting` and the engine's intent.
- `channels.waiting` is unchanged for every correctly counted case. Requests and outcomes are unchanged.
- **Classic, `/api/state`, the engine and the journal are unchanged.**
- The M3.1 client guard ("unchanged waiting never walks for an actionable finished-session research item") keeps passing,
  but its scenario can no longer arise from the server. Keep it as a client-side guard.

### Tests (Part A)

In `tests/test_conversation.py`:
1. **Research:** `awaiting_approval` with a request is actionable in an active session. In a finished session
   (each terminal status) it has `action: null` and `detail.expired`. In a stopping session (`stop: True`, non-terminal) it has `action: null`.
2. **Skill:** `proposed` and `awaiting_fetch` are actionable in an active session. In finished and stopping sessions they
   have `action: null` and `detail.expired`. `installed`, `rejected` and `failed` never have an action or `expired`.
3. **Proposal:** actionable in an active session. In a stopping session, `action: null`.
4. **Requests** unchanged, and **outcomes** unchanged (the M2.1 tests pass unmodified).
5. **The invariant (the key test).** For a set of journals, walk every `/api/thread?channel=main` page and assert that
   **`channels.waiting` equals the number of non-outcome messages with a non-null `action`**:
   - an active session with one of each item kind
   - a finished session with leftover research and skills, next to an active session
   - a stopping session
   - no active session
   - a team proposal pending

In `tests/test_thread_api.py`: one HTTP case for the invariant, and a check that the expired research message has
`action: null` and `detail.expired`.

In `tests/test_chat_ui.cjs`: the expired label renders, with no waiting line and no classic decision link on that item.

## 4. Part B: engine guards (required; D7 approved 2026-09-30)

The projection makes the UI truthful. The API still **accepts a research approval for a finished or stopping session**,
recording an audited decision that can never execute. It also fetches skills from the network for finished sessions.
M5 will add real controls, so the server should refuse these dead decisions itself.

**D7 (approved): two narrow guards in `engine.py`, and nothing else.**
- `decide_research`: if the session is finished or stopping, raise `ValueError("This session has ended; its research
  task can no longer run.")` **before** any state change, audit entry or event.
- `fetch_capability`: if the item's session is finished, raise `ValueError("This session has ended; the skill can no
  longer be installed.")` before any network access.
- **Unchanged:** `decide_capability` (approve is already refused; reject stays allowed, since it is harmless and
  classic may use it), `review()`, `_team_decision`, `_end()`, `_retire_skills` and every journal row.

**Tests (Part B):**
- Both refusals: an HTTP 400 through `/api/research/decide` and `/api/skills/fetch`, with **no** audit entry, event
  or state change (snapshot the row counts and the audit chain).
- Active-session behaviour is unchanged: the existing research and skill tests pass unmodified.

**Implementation boundary (binding):**
- Each guard needs only a **read** of the owning run: `self.store.get('runs', …)`. Add it at the top of the existing
  method, before its first write, audit entry, event, or (for `fetch_capability`) its call to `_fetch_into`.
  - In `decide_research`, add it inside the existing lock, after the existing step and run-ownership check, and before
    the fingerprint check or any update.
  - In `fetch_capability`, read `item['run']` and refuse if it is finished, before `_fetch_into`.
- `app.py` already maps `ValueError` to HTTP 400 for `/api/research/decide` and `/api/skills/fetch`. **No `app.py` change.**
- **Explicitly out of scope, not covered by D7:** a session that finishes **while** an already-accepted fetch is in
  progress (`_fetch_into` runs outside the lock). Leave the existing post-fetch behaviour unchanged, and mention the case in your report.
- If either guard seems to need anything more (another method, a lifecycle hook, a state rewrite, a new endpoint or
  field, or a change to `decide_capability`, `review()`, `_team_decision`, `_end()` or `_retire_skills`), **stop and report the conflict.** Do not expand D7.

## 5. Out of scope

- Any M5 decision UI or control.
- Rewriting stored step or skill states: no expiry migration and no `_end()` change.
- Any change to requests, outcomes, classic or `/api/state`.

## 6. Acceptance

1. `python3 -m unittest discover -s agent-autonomy/tests` passes, with the new tests. Report skipped tests by name.
   - Baseline at `581b382`: Python **398 tests, OK** (6 skipped in the review environment, 3 with OpenCode); classic DOM
     **82/82**; chat DOM **77/77**; browser **108 combinations + 4 regressions**.
   An unchanged timing-sensitive backend test that fails intermittently is rerun and recorded, never modified.
2. `test_ui.cjs` passes 82/82. `test_chat_ui.cjs` and `chat_screenshots.cjs` pass.
3. The diff touches only:
   - `agent-autonomy/conversation.py`
   - `agent-autonomy/chat/thread.js` (the expired label only)
   - the three test files named above
   - `docs/REDESIGN_ARCHITECTURE.md`, `CURRENT_STATE.md` and this file
   - the two D7 guards in `agent-autonomy/engine.py` (only those lines) and their tests
4. Your report includes a trimmed `/api/thread` sample with one expired research item and the matching `/api/channels`.

## 7. When you finish

1. Append a completion report: the changes, test commands and counts (with skipped tests named), the exact `engine.py` lines changed for D7, and the samples.
2. Set M5.0 to done in `CURRENT_STATE.md`, then push. No PR and no merge unless the owner asks.

After M5.0 (and M4.1) are accepted, Opus writes the full M5 handoff (decision controls) on this single definition of actionable.

---

## Completion report — 2026-09-30 (Codex)

**M5.0 Parts A and B are complete, awaiting architecture review.** Work resumed from the surviving diff at
`a60589d` on `feature/chat-first-redesign`. M5 decision controls have not begun.

### Recovery assessment

The surviving five-file diff contained the shared actionability predicates, waiting-count alignment, exactly
the two D7 engine guards, five projection/reader regressions, three HTTP regressions and two DOM regressions.
No file was syntactically truncated. The expired label, contract/state updates, completion report and final
verification were unfinished. One new DOM assertion incorrectly expected a revised message to keep the old
DOM node; it now checks the replacement node's preserved disclosure and removal of the waiting marker,
following the existing renderer. All surviving implementation work was retained and completed.

Verification was restarted after the interruptions; no earlier process's results were used.

### Part A: projection and presentation

- `accepts_decisions`, `research_actionable`, `skill_actionable` and `proposal_actionable` now govern both
  thread actions and channel waiting counts. The newest recorded proposal alone can act.
- The existing request rules are shared too: the first packet per recorded kind/id is projected, and only
  a pending packet with a fingerprint has an action. Duplicates, packets needing refresh, non-research steps
  and a proposed team without a recorded proposal no longer inflate waiting counts.
- Research waiting by status and skills in `proposed`/`awaiting_fetch` gain `detail.expired: true` when their
  session is finished or stopping. Recorded status/state values remain intact. Installed, rejected and failed
  skills have neither actions nor expiry flags. Expiry changes message revisions once; known revisions then
  yield normal stubs, including when a stopping session becomes terminal.
- `thread.js` changes only the two requested labels. Expired research and skill rows show the muted
  "Not decided before the session ended", keeping the research title, skill name/agent and Details. They have
  no waiting line or classic decision link. Skills retain their existing inline layout.
- Requests, receipts, and the M2.1 newest-terminal outcome rule are preserved. Existing outcome action/revision
  tests pass unmodified across pages and single-session views. The M3.1 defensive client guard is retained.

The invariant regression fully pages five fixture journal cases (active with every kind; finished leftovers
beside active; stopping; no active; proposal-only), for each of two project views. Another case checks duplicate
packets, missing fingerprints, non-research steps and unrecorded/older proposals. The authenticated HTTP case
also walks every page and checks that the expired research item has a null action and unchanged recorded status.
Reads leave the recorded rows and audit chain unchanged.

### Part B: exactly D7

`engine.py` has **six added lines in two guards**, with no other engine changes:

At lines **1676–1678**, inside the existing `decide_research` lock, after the step/run-ownership check and before
the fingerprint check or first update:

```python
run = self.store.get('runs', ident)
if run.get('status') in TERMINAL or run.get('stop'):
    raise ValueError('This session has ended; its research task can no longer run.')
```

At lines **2015–2017**, in `fetch_capability`, before the state check and `_fetch_into`:

```python
run = self.store.get('runs', item['run'])
if run.get('status') in TERMINAL:
    raise ValueError('This session has ended; the skill can no longer be installed.')
```

Authenticated POST tests receive HTTP 400 for research decisions on every terminal status and stopping,
including stale fingerprints, and for skill fetches on every terminal status. Snapshots compare every table's
row count and contents plus the audit chain; spies verify no update, event, audit append or download occurred.
A boundary test verifies skill fetch still succeeds in active **and stopping** sessions. The existing active
research approval/rejection and real skill-fetch tests pass unmodified in the full suite.

**Intentionally excluded in-flight skill-fetch race:** a session may finish after an accepted fetch has already
begun downloading in `_fetch_into`, outside the controller lock. D7 authorizes the entry guard only. The existing
post-fetch behaviour remains unchanged; M5.0 adds no second completion check, state rewrite, cleanup or lifecycle
hook for this race. `decide_capability`, `review`, `_team_decision`, `_end` and `_retire_skills` are unchanged.

### Fresh verification

| Suite | Command | Result |
|---|---|---|
| All Python | `python3 -m unittest discover -s agent-autonomy/tests -v` | **408 tests, OK (skipped=3)**; no intermittent failures |
| Classic DOM | `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_ui.cjs` | **82/82 passed** |
| Chat DOM | `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_chat_ui.cjs` | **79/79 passed**, including both M5.0 label/refresh regressions |
| Browser matrix | `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/chat_screenshots.cjs /tmp/chat-shots-m50-resumed` | **108 combinations + 4 regressions passed**, 158 temporary screenshots; no overflow or page errors |
| Dedicated projection + HTTP | From `agent-autonomy/tests`: `python3 -m unittest -v test_conversation test_thread_api` | **55 tests, OK** (40 projection/reader + 15 HTTP); 10 new Python regressions |
| Syntax and diff hygiene | `node --check` on `thread.js` and `test_chat_ui.cjs`; `git diff --check` | Passed |

Skipped tests, by name:

- `test_container_e2e.ContainerRunE2E.test_agent_works_in_a_locked_down_container` — requires
  `AGENTCONTROL_CONTAINER_TESTS=1` with a runtime and agent image.
- `test_preview.DesktopTests.test_desktop_preview_shows_frames_and_accepts_input` — desktop preview tools unavailable.
- `test_vm_e2e.VMRunE2E.test_agent_works_in_a_kvm_clone` — requires `AGENTCONTROL_VM_TESTS=1` on a KVM host.

The OpenCode E2E trio ran and passed. Socket-based tests and Chromium were rerun outside the sandbox after
socket creation/launch was blocked inside it. Test-only npm packages were installed in `/tmp/ac-tests`, outside
the repository. Desktop/light and phone/dark team timeline screenshots were inspected from the fresh matrix.

### Trimmed matching read-model samples

Temporary fixture journal, using the same completed-plus-active pattern as the paged HTTP regression:
**8 pages at limit 2, 16 unique messages, 5 actionable non-outcome messages, waiting = 5**. The completed session
also has an actionable outcome, which remains excluded from waiting. The research status below is recorded;
only the action and expiry flag are derived.

`/api/thread?channel=main` (other messages and metadata omitted):

```json
{
  "channel": "main",
  "project": "/project",
  "messages": [{
    "id": "turn:ended-research",
    "session": "ended",
    "actor": "researcher-1",
    "kind": "research",
    "text": "Find docs",
    "detail": {
      "status": "awaiting_approval",
      "request": {"question": "Find docs"},
      "expired": true
    },
    "action": null
  }]
}
```

Matching `/api/channels` (updated timestamp omitted):

```json
{
  "project": "/project",
  "channels": [{
    "id": "main",
    "kind": "project",
    "title": "project",
    "sessions": 2,
    "active_session": "active",
    "waiting": 5
  }]
}
```

### Scope and delivery

The diff is limited to `conversation.py`, the expired-label lines in `chat/thread.js`, the two guards in
`engine.py`, `test_conversation.py`, `test_thread_api.py`, `test_chat_ui.cjs`, the architecture contract,
`CURRENT_STATE.md` and this handoff. No endpoint or schema change, classic UI change, or other lifecycle/engine
change is included. `git diff --stat`, `git diff --name-only` and `git diff --check` were inspected before committing.
Delivery is only to `feature/chat-first-redesign`; no PR or merge into `main`. Opus review precedes the M5 handoff.
