# Handoff M2.1: Thread read model corrections

**From:** Opus (architecture review) → **To:** Codex (implementation)
**Branch:** `feature/chat-first-redesign`. Commit and push only there; **never merge into `main`**.
**Size:** small to medium (about half a day). **Must land before M3.**
**Read first:**
1. the "Architecture review" section at the end of `docs/handoffs/M2_THREAD_READ_MODEL.md`
2. `docs/REDESIGN_ARCHITECTURE.md` §3 and §6

Fix exactly the findings below. **Part A and Part B are both required.** The owner approved **D6** on 2026-09-30,
so Part B (the events index) is in scope.
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

## Part B: required (D6 approved by the owner, 2026-09-30)

**D6:** add an index on `events(run, id)`. The `events` table has no index on `run`, so every `WHERE run=?` scans the
whole table. That also slows classic `/api/state` and `Lifecycle`.

- Append a migration to `journal.MIGRATIONS` (never edit an applied one):
  ```python
  def _v7(c):
      """Index events by run (redesign M2.1): reads by run no longer scan the whole table."""
      c.execute('CREATE INDEX IF NOT EXISTS events_run_id ON events(run, id)')
  ```
  It adds no table, no column and no data change.
- **Scope of the approval:** exactly this one index, in exactly this one migration. D6 is a narrow exception to
  architecture invariant 1. It does **not** authorise any other migration, index, table, column, trigger or
  data change. If you believe another schema change is needed, stop and record it as an open question for Opus
  and the owner.
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
   - `agent-autonomy/journal.py`: **only** the appended `_v7` function and its `MIGRATIONS` entry, plus journal migration tests
   - optionally `agent-autonomy/app.py`, for the `KeyError` narrowing
   - `docs/REDESIGN_ARCHITECTURE.md` (the change log), `CURRENT_STATE.md` and this file
4. The response shapes are unchanged, and a trimmed sample response for a team run shows `coder-2` on a decided request.

## 4. When you finish

1. Add to the change log in `docs/REDESIGN_ARCHITECTURE.md`:
   - "M2.1: decided requests are attributed via the recorded session id"
   - "the actionable outcome is the channel's newest terminal session, independent of page and view"
   - "planner-shaped Hermes decisions use recorded `reason`/`title` or are folded"
   - "D6: `events_run_id` index added as migration `_v7`"
2. Append a completion report to this file: the changes, test commands and counts (with skipped tests named), the benchmark numbers, and any deviation.
3. Set M2.1 to done in `CURRENT_STATE.md`, then push. No PR and no merge unless the owner asks.

## Completion — 2026-09-30 (Codex)

Started from `4d7a46b` after a fast-forward pull on `feature/chat-first-redesign`, with a clean tree.
Implemented Parts A and B only:
- Request actors prefer the recorded packet's `agent`, then the pure `agent_for_session` mapping over
  `run.session`, specialists and team agents, then the older single-agent fallback.
- Outcome eligibility comes from the channel's newest terminal session before paging. Older outcomes
  have identical null actions and revisions across full pages, older pages and session views. Workspace
  status is read at most once, only when that newest outcome is returned and its recorded workspace is open.
- Hermes decisions choose non-empty recorded summary, reason or title. Planner-shaped decisions expose
  only planning/count metadata and existing whitelisted fields; textless decisions are folded.
- Channels read one newest event per session and only the active session's steps/capabilities. Gather
  uses one event scan per 5,000-row batch and splits public events/annotations in Python; prompt text
  remains stripped from annotations.
- Appended exactly `_v7` and its migration-list entry, creating only `events_run_id ON events(run, id)`.
  Tests prove a v6 journal reaches version 7 with every table's rows unchanged, no other schema change,
  and an indexed events-page query plan. Existing migrations and Store methods are unchanged.

The only optional handoff item taken was removing the persistent `/tmp/ac-thread-sample.json` write from
`test_public_single_and_team_shapes`. Its assertions are unchanged. No UI, orchestration, agent,
approval, verification, existing journal-read semantics, or M3 work was changed. An AST audit confirms
all existing tests are unchanged except that explicitly permitted sample-file write removal.

### Verification

`python3 -m unittest discover -s agent-autonomy/tests`: **398 tests, OK (skipped=3)**
outside the sandbox, on the final implementation. No intermittent test failures occurred in this run.
The 15 added regressions cover attribution, stable outcome actions/revisions across pages and views,
planner decisions, scan counts, and the narrowly approved migration/query plan. Existing paging,
5,010-event, read-only, journal and migration tests pass unchanged.

Skipped tests by name:
- `test_container_e2e.ContainerRunE2E.test_agent_works_in_a_locked_down_container`
- `test_preview.DesktopTests.test_desktop_preview_shows_frames_and_accepts_input`
- `test_vm_e2e.VMRunE2E.test_agent_works_in_a_kvm_clone`

Focused checks and existing browser suites also passed:
- `python3 -m unittest discover -s agent-autonomy/tests -p test_conversation.py -v`: **34 passed**.
- `python3 -m unittest discover -s agent-autonomy/tests -p test_thread_api.py -v`: **11 passed** outside the sandbox.
- `python3 -m unittest discover -s agent-autonomy/tests -p test_journal.py -v`: **7 passed**.
- `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_ui.cjs`: **82/82**.
- `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_chat_ui.cjs`: **16/16**.
- `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/chat_screenshots.cjs /tmp/chat-shots`:
  **24 combinations + 4 regressions**, 54 screenshots; all browser tests unchanged.
  Chromium's initial sandbox launch was blocked by socket restrictions; the unsandboxed run passed.
- `git diff --check` and scope/AST audits passed. `journal.py` only appends the exact approved `_v7`
  function and list entry; existing journal functions, all six prior migrations, and test assertions are intact.

### Performance

Synthetic scratch journal: **100 sessions × 1,000 `OpenCode tool` events**, **4,126 bytes per payload**,
**439.7 MiB** before indexing. All sessions are terminal, so the default first thread page walks all
100 sessions and returns 200 start/outcome messages. No tool text is emitted. Measurements call the
same endpoint projection functions used by GET routes, excluding HTTP transport; medians of three
sequential calls on the same machine/journal, with no regression suite running during timing.

| Version | `/api/channels` median | first `/api/thread` median |
|---|---:|---:|
| Starting implementation, v6 without index | 1,777.556 ms | 3,072.008 ms |
| Part A, v6 without index | 726.911 ms | 1,679.906 ms |
| Starting implementation with D6 index only | 280.403 ms | 150.448 ms |
| Parts A + B, v7 | **12.851 ms** | **91.929 ms** |

The final read-model queries use `events_run_id`; `EXPLAIN QUERY PLAN` checks cover both the first
batch and `id < before_id` continuation with excluded kinds. Benchmark artifacts stay outside the
repository in `/tmp/ac-m21-bench`; commands: `python3 /tmp/ac-m21-benchmark.py before`, then
`python3 /tmp/ac-m21-benchmark.py after`. The script preserves the starting conversation/journal
modules, builds the fixture at v6 with `MIGRATIONS[:6]`, measures Part A, applies the actual `_v7`
migration, and measures the index-only baseline and final projection. No extra benchmark index exists.

### Sample team response

Trimmed `/api/thread?session=team` projection from a scratch test journal. Other messages and most
risk/session metadata omitted; the decided packet has `sessionID: "ses2"` and no `agent`, and the
team run records `coder-2.session = "ses2"`:

```json
{
  "channel": "main",
  "project": "/project",
  "sessions": [{"id": "team", "mode": "team", "status": "coding", "title": "Build CLI"}],
  "messages": [{
    "id": "req:permission:p1",
    "rev": 1571612196,
    "at": "2026-09-30T12:00:03+00:00",
    "session": "team",
    "actor": "coder-2",
    "kind": "request",
    "text": "bash · npm test",
    "refs": {},
    "detail": {
      "kind": "permission",
      "permission": "bash",
      "patterns": ["npm test"],
      "receipt": {"action": "approve", "state": "sent", "actor": "you"}
    },
    "action": null
  }],
  "before": null,
  "live": {"session": "team", "phase": "code", "status": "coding"}
}
```

No scope deviations, additional schema changes, or unresolved M2.1 issues. The previously documented
backend timing-sensitive tests and v1 per-session materialisation remain outside this milestone.
M3 has not been started.
