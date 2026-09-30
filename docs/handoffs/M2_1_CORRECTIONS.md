# Handoff M2.1: Thread read model corrections

**From:** Opus (architecture review) → **To:** Codex (implementation)
**Branch:** `feature/chat-first-redesign`. Commit and push only there; **never merge into `main`**.
**Size:** small to medium (about half a day). **Must land before M3.**
**Read first:**
1. the "Architecture review" section at the end of `docs/handoffs/M2_THREAD_READ_MODEL.md`
2. `docs/REDESIGN_ARCHITECTURE.md` §3 and §6

Fix exactly the findings below. **Part A** is required. **Part B** applies only if `CURRENT_STATE.md` records
decision **D6 as approved**; if it is not approved, skip Part B and say so in your report.
The API shape (`/api/channels`, `/api/thread`, message fields) **does not change**. Do not refactor anything else.

---

## Part A: required

### A1. Credit decided requests to the agent that made them

**Now:** a decided request becomes a message built from `store.reviews(run)[i]['request']`, which has no `agent`.
`request_message` then uses `packet.get('agent', 'coder-1')`.

**Required:**
- Add a pure helper in `conversation.py`, `agent_for_session(run, session_id)`, that maps an OpenCode session id to
  an agent name **using only the run record**:
  - `run['session']` → `coder-1`
  - `run['specialists'][name]['session']` → `name`
  - `run['team']['agents'][name]['session']` → `name`

  These are the same pairs as `Controller._agent_sessions`. Do not call that private method; reimplement the mapping over the dict.
- The actor of a request message (pending or decided) is:
  1. `packet['agent']`, if present
  2. otherwise the agent mapped from `packet['sessionID']`
  3. otherwise `coder-1` (older single-agent rows)
- **Tests:**
  - a decided request whose `request.sessionID` is coder-2's session → actor `coder-2`
  - the same for a specialist (for example `reviewer-1`)
  - a pending packet that has `agent` keeps it
  - an unmapped session id falls back to `coder-1`

### A2. Make outcome actions independent of the page

**Now:** `actionable_outcome = (r is newest terminal session in the page)`, so the same `out:<id>` has different
`action` and `rev` values on different pages. The architecture review has a reproduction.

**Required:**
- The **actionable outcome is the newest terminal session of the channel**: the first terminal run in
  `channel_runs(controller)`, whatever page is requested. The same rule applies in the `session=` view: that session's
  outcome is actionable only if it is the channel's newest terminal session.
- `workspace_status` is called **at most once per request**, only for that run, and only when its outcome message is
  on the returned page and its recorded workspace is neither `applied` nor `discarded`.
- Every other terminal session's outcome has `action: null`. Its `detail.workspace` comes from the recorded flags
  only (`{state: 'applied' | 'discarded' | 'open'}`), as today.
- **Tests:**
  - With two terminal sessions that both have open workspaces and verifiers, `out:old` has the same `action` (`null`)
    and the same `rev` in a full page and on its own older page.
  - `out:new` is actionable on every page it appears on.
  - `workspace_status` is called at most once, and never for `old`.

Architecture change: this replaces M2 handoff §5.9's "newest terminal session in the page". Record it in the
architecture change log, as §4 below says.

### A3. Never emit an empty Hermes decision

**Now:** the team-planning path records the planner's JSON as `Hermes decision`
(`{mode, agents, tasks, reason, …}`, with no `summary`), so the message has `text: ''`.

**Required (still copying only recorded fields):**
- If a decision payload has no non-empty `summary`, use its recorded `reason`, then its `title`, as `text`, bounded.
- For a planner-shaped payload (it has `agents` or `tasks` and no `action`), set
  `detail.proposal_counts = {agents: len, tasks: len}` and `detail.planning = true`. Never include the raw payload.
- If no text field is available at all, **fold** the event: emit no message.
- **Tests:**
  - a planner payload with `reason` → a decision whose text is the reason, with `planning` and counts set
  - a planner payload with no text fields → no message
  - a normal decision → unchanged

### A4. Stop `/api/channels` and `/api/thread` from scanning more than they need

**Now:**
- `channels()` reads every event, with its payload, of every channel run, and the full steps of every run, only to compute `updated`.
- `gather()` runs two event scans per session: the public events, then the annotations.

**Required (with the existing `Store` read methods only):**
- **`channels()`:**
  - `updated` = the maximum of:
    - the newest event's `created` for each channel run, via `store.events_page(run_id, None, 1)`: one row, one call per run
    - the `created` of every step of the **active** run only
  - Read steps and capabilities for the **active run only**, as the waiting count already requires.
  - Do not call `read_events` in `channels()`.
  - Review measurement of this exact `updated` computation on the 461 MB benchmark journal: **868 ms without the D6
    index** (against 2,408 ms for today's whole `channels()`), and **17 ms with it**.
- **`gather()`:** one event query per session. Read with
  `exclude_kinds = OMITTED ∪ (FOLDED − ANNOTATIONS)`, then split the rows in Python into public events and
  annotations. Keep today's stripping of `OpenCode prompt` text in `annotation_record`.
- **Tests:**
  - `channels()` issues no `events_page` call with `limit` above 1, and reads steps for the active run only
    (use a counting wrapper around the store)
  - `gather()` issues one `events_page` call per 5,000-event batch per session, not two
  - the existing paging, 5,010-event and read-only tests still pass unchanged
- **Report timings:** extend or copy the benchmark in your report. With 100 sessions × 1,000 `OpenCode tool` events
  of about 4 KB each, report `/api/channels` and the first `/api/thread` page before and after. The review measured
  2,408 ms and 2,361 ms at `f314462`.

## Part B: only if D6 is approved (see `CURRENT_STATE.md`)

**D6:** add an index on `events(run, id)`. The `events` table has no index on `run`, so every `WHERE run=?` scans the
whole table. That also slows classic `/api/state` and `Lifecycle`.

- Append a migration to `journal.MIGRATIONS` (never edit an applied one):
  ```python
  def _v7(c):
      """Index events by run (redesign M2.1): reads by run no longer scan the whole table."""
      c.execute('CREATE INDEX IF NOT EXISTS events_run_id ON events(run, id)')
  ```
  It adds no table, no column and no data change.
- **Tests:**
  - A v6 journal (built with `MIGRATIONS[:6]`) migrates to `PRAGMA user_version = 7` with the index present, and its
    rows are unchanged.
  - `EXPLAIN QUERY PLAN` for the `events_page` query uses `events_run_id`.
  - The existing journal and migration tests pass.
- Report the benchmark with the index as well. The review measured 952 ms and 308 ms with the index alone.

## Optional, only if trivial while you are in these lines

- Catch `KeyError` only around `controller.store.get('runs', session_id)` in `thread()`, so projection bugs are not reported as "404 Unknown session".
- Stop `test_public_single_and_team_shapes` from writing `/tmp/ac-thread-sample.json`.
- An outcome whose run has no `ended` field uses the session's latest recorded time as `at`, not `run.created`.

## 3. Acceptance

1. `python3 -m unittest discover -s agent-autonomy/tests` passes. Report the skipped tests **by name**.
   - The review environment expects 6 skipped; your environment with OpenCode gives 3.
   - If an unchanged timing-sensitive test fails intermittently (for example
     `test_agents…test_a_turn_records_join_work_approval_and_finish`, which the review reproduced on the
     pre-redesign code), rerun it and record it. **Do not modify it.**
2. `test_ui.cjs` passes 82/82, `test_chat_ui.cjs` passes 16/16 and the browser matrix passes, all unchanged.
3. The diff touches only:
   - `agent-autonomy/conversation.py`
   - `agent-autonomy/tests/test_conversation.py` and `agent-autonomy/tests/test_thread_api.py`
   - with Part B only: `agent-autonomy/journal.py` (the `_v7` migration) and journal tests
   - optionally `agent-autonomy/app.py`, for the `KeyError` narrowing
   - `docs/REDESIGN_ARCHITECTURE.md` (the change log), `CURRENT_STATE.md` and this file
4. The response shapes are unchanged, and a trimmed sample response for a team run shows `coder-2` on a decided request.

## 4. When you finish

1. Add to the change log in `docs/REDESIGN_ARCHITECTURE.md`:
   - "M2.1: decided requests are attributed via the recorded session id"
   - "the actionable outcome is the channel's newest terminal session, independent of page and view"
   - "planner-shaped Hermes decisions use recorded `reason`/`title` or are folded"
   - the D6 index, if Part B was done
2. Append a completion report to this file: the changes, test commands and counts (with skipped tests named), the benchmark numbers, and any deviation.
3. Set M2.1 to done in `CURRENT_STATE.md`, then push. No PR and no merge unless the owner asks.
