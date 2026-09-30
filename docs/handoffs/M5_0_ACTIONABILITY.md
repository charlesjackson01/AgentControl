# Handoff M5.0: One definition of "actionable" (the M5 prerequisite)

**From:** Opus (architecture) → **To:** Codex (implementation)
**Branch:** `feature/chat-first-redesign`. Commit and push only there; **never merge into `main`**.
**Status:** **Parts A and B are both required before M5.** The owner approved **D7** on 2026-09-30, limited exactly
to Part B as written in §4.
**Independent of** `M4_1_CORRECTIONS.md`. The only shared file is `chat/thread.js`: one research/skill label here,
one empty-state line there. Either order works.
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
