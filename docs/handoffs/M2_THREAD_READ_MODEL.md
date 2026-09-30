# Handoff M2: Thread read model (server side)

**From:** Opus (architecture) → **To:** Codex (implementation)
**Branch:** `feature/chat-first-redesign`. Commit and push only there; **never merge into `main`**.
**Read first, in this order:**
1. `CURRENT_STATE.md`
2. `docs/REDESIGN_ARCHITECTURE.md` (binding; §3 and §6 matter most)
3. this file

**Depends on:** nothing. It can run in parallel with M1.1, which touches only `agent-autonomy/chat/`.
**Size:** about 1–2 days.

---

## 1. Outcome

Two new **read-only**, key-protected endpoints turn the durable journal into a project conversation:
- `GET /api/channels`: the project's channels (v1: one, `main`)
- `GET /api/thread`: the channel's sessions and messages, in time order, cursor-paged, with `rev` deltas

They are built by a new module, `agent-autonomy/conversation.py`. Its **pure projection functions** turn journal
records into messages, and one thin `gather()` reads the journal through existing read methods only.

Nothing is written. Orchestration, schemas and every existing endpoint are unchanged, and `/api/state` stays
byte-identical for the same journal. No UI is built in M2; M3 renders it.

## 2. Hard rules (from architecture §3; any violation fails review)

1. **No writes.** Do not call any `Store.put/update/event/save_review/audit_append/usage_add/put_*`, and do not
   call any `Controller` method that changes state or starts work. Allowed reads:
   - `Store`: `runs`, `get`, `steps`, `events`, the new `events_page` (§4.3), `reviews`, `review`, `capabilities` and `agents`
   - `Controller`: `run_project`, `research_requests`, `workspace_status` (see the limits in §5.9), `store` and `s.project`
2. **No change** to `engine.py`, `adapters/`, `permissions.py`, `planner.py`, `roles.py`, `lifecycle.py`, `watch.py`,
   `verify.py`, `sandbox.py`, `vmenv.py`, `gateway.py`, `models.py` or the journal schema (**no migration**).
3. **No fabricated text.** Every `text` and `detail` value is copied, or bounded and trimmed, from a journal record.
   The only strings you may compose are labels built from recorded fields (for example `"coder-1 · turn 3"`).
   Never write in Hermes's or an agent's voice.
4. **No private reasoning.** Never emit OpenCode `reasoning` parts. Emit nothing from `step.transcript` except the
   bounded text and tool parts that `verify.transcript()` already keeps. In M2 the turn message carries **no transcript at all** (§5.4).
5. **Approvals are not reimplemented.** An actionable message's `action` only *describes* which existing endpoint
   the UI would call, with the exact fields that endpoint requires. The server's decision rules stay where they are.
6. **Standard library only.**

## 3. Files

| File | Change |
|---|---|
| `agent-autonomy/conversation.py` | **new**: `MAPPING`, the pure projection functions, `gather()`, `thread()`, `channels()` |
| `agent-autonomy/journal.py` | **add one read method**, `Store.events_page` (§4.3); nothing else |
| `agent-autonomy/app.py` | **add two `do_GET` routes** (§4.1, §4.2); nothing else |
| `agent-autonomy/tests/test_conversation.py` | **new**: pure projection tests with fixtures |
| `agent-autonomy/tests/test_thread_api.py` | **new**: HTTP tests (auth, 404s, paging, deltas, byte-identical `/api/state`) |
| `docs/REDESIGN_ARCHITECTURE.md` | only if you find a genuine contract gap; record it in its change log and flag it in your report |
| `CURRENT_STATE.md`, this file | status and completion report |

## 4. API

### 4.1 `GET /api/channels`

The key is required (401 without it, like every `/api/*` route).

```json
{"project": "/abs/path", "channels": [{"id": "main", "kind": "project", "title": "<project folder name>",
  "sessions": 12, "active_session": "run_x" | null, "waiting": 1, "updated": "ISO" | null}]}
```

- `sessions` counts the runs in the channel (§5.1).
- `waiting` is the number of pending requests, research approvals, team proposals awaiting a decision, and skill
  items awaiting you, across the channel's active session.
- `updated` is the newest `created` time among the channel's events and steps, or `null`.

### 4.2 `GET /api/thread`

Query parameters:
- `channel=main` **or** `session=<runId>` (exactly one; if neither is given, the default is `channel=main`)
- `before=<cursor>` (optional)
- `limit=<n>` (default 200, clamped to 1–500)
- `known=<id:rev,…>` (optional; at most 2,000 entries; ignore malformed items, as `parse_known` does)

Errors:
- 400 for both `channel` and `session`, a malformed `before`, or an unknown `channel` id
- 404 for an unknown `session` id

The response shape is architecture §6.3, filled as follows:
- **`sessions`:** the sessions that have at least one message in this page, oldest first:
  `{id, title, status, created, ended, parent, mode, summary}`.
  - `title` is `run.title`, or else the first line of `run.goal` trimmed to 80 characters.
  - `summary` is `run.summary`, bounded to 2,000 characters.
- **`messages`:** oldest first within the page (§5).
- **`before`:** the cursor for the next older page, or `null` when the oldest message is included.
- **`live`:** the channel's active (non-terminal) session: `{session, phase: run.phase, status: run.status}`, or all nulls.

The **`session=<id>` view** returns that single run's messages whichever project it belongs to, as `/api/state?run=`
allows. It is used by Workspaces and deep links.

### 4.3 `Store.events_page(run, before_id=None, limit=500, exclude_kinds=())`

A read-only helper. It returns up to `limit` events for `run` with `id < before_id` (when given) and
`kind NOT IN exclude_kinds`, **newest first**, in the same dict shape as `Store.events`. It is one parameterised
`SELECT`; do not interpolate kinds into the SQL string. Add a unit test in `tests/test_journal.py`, or in your new test file.

## 5. Projection rules

### 5.1 Channel membership

`main` holds every run where `Controller.run_project(run) == str(controller.s.project)`, **plus** any non-terminal
run. This is the same filter as `Controller.state(scope='current')`. Older runs that recorded no project are
excluded, again as in `state()`.

### 5.2 Ordering, ids, `rev` and cursor

- **Total order:** `(session.created, session.id, message.at, rank, source_seq)`.
  - `rank` breaks ties at the same second: `session_start` < `goal` < everything else < pending actionables < `outcome`.
  - `source_seq` is the event id, the step `number`, or similar.
  - Sessions practically never overlap, because the backend allows one active run, so this reads as global time order.
- **Ids** follow architecture §6.3 and are stable across calls:
  - `run:<runId>` for `session_start`
  - `ev:<eventId>`
  - `turn:<stepId>`
  - `req:<kind>:<requestId>`
  - `cap:<capabilityId>`
  - `out:<runId>`
- **`rev`** is `zlib.crc32` of the canonical JSON (`sort_keys=True`, compact separators) of the message *without*
  `rev`. With `known=`, a message whose id and rev match comes back as `{"id", "rev", "same": true}`.
- **Pages** are the newest `limit` messages strictly older than the cursor. The cursor is opaque:
  URL-safe base64 of a small JSON object holding the last position in the total order.
  - Walking `before` until `null` must return **every message exactly once**.
  - While no new data arrives, pages are stable. New messages only ever appear at the newest end.
- **Efficiency.** Do not materialise the whole project. Walk sessions from newest to oldest, and read events with
  `events_page(..., exclude_kinds=OMITTED ∪ FOLDED)` until the page is full.
  - v1 may materialise one session's non-omitted messages in full.
  - Document the cap you choose. A session with more than 5,000 non-omitted events may be served by paging events inside the session.

### 5.3 The mapping table: `conversation.MAPPING`

`MAPPING` is a single dict from event kind to one of `('goal' | 'note' | 'decision' | 'proposal' | 'progress' |
'research' | 'skill' | 'alert' | 'system' | 'outcome', FOLD | OMIT)`. It is the one normative place for this.
**Any kind not in it maps to a quiet `system` message and is never dropped.**

| Event kind(s) | Maps to |
|---|---|
| `goal` | `goal` (actor `you`) |
| `user instruction`, `goal check added` | `note` (actor `you`); see §5.5 |
| `Hermes decision` | `decision` (actor `hermes`); see §5.6 |
| `Hermes JSON repaired` | FOLD into the next `decision` in the same session (`detail.repaired = true`) |
| **`Hermes request`** | **OMIT.** It is the full manager prompt: internal, huge, and not a message |
| `OpenCode prompt`, `OpenCode tool`, `OpenCode result`, `OpenCode needs input`, `verification`, `file changes`, `integration`, `session`, `submission uncertain` | FOLD. The turn message is built from the **step** record (§5.4); `submission uncertain` also sets `detail.uncertain` on its turn |
| `approval decision`, `approval resolved`, `approval failed`, `approval delivery uncertain`, `approval confirmation pending` | FOLD into the matching `request` message's `detail.receipt` (§5.7) |
| `team proposal` | `proposal` (actor `hermes`); the action is attached while pending (§5.8) |
| `team started`, `task started`, `task done`, `task failed`, `task retry`, `task blocked`, `team tasks finished`, `delegated`, `auto mode`, `proposal rejected`, `delegation refused` | `progress` |
| `research requested`, `research started`, `research report`, `research failed`, `research interrupted` | `research` (actor = the step's researcher agent when known) |
| `skill requested`, `skill installed`, `skill rejected`, `skill removed`, `skill request refused`, `skills reloaded`, `skills reload failed` | `skill` |
| `review findings` | `progress` (actor = the reviewer agent in the detail) |
| `attention`, `recovery`, `completion rejected`, `apply conflict`, `watch alert`, `tester change refused`, `reviewer change discarded`, `read-only refusal`, `vm files refused` | `alert` |
| `completed`, `blocked`, `failed`, `stopped`, `limit_reached` (written by `Controller._end` with the status as the kind) | FOLD into `outcome` (§5.9) |
| `agent state` (`lifecycle.KIND`), `watch` (`watch.KIND`), `connection retry`, `notification`, `notification error` | OMIT |
| everything else (`control`, `vm`, `container`, `setup`, `preview`, `workspace`, `model warning`, `spend cap`, `applied`, `discarded`, `verification (on demand)`, `watch unavailable`, `rule not applied`, `refusal not applied`, `abort error`, …) | `system` |

The list above is complete as of `990f258`. Your coverage test (§6) is the authority, so reconcile it.

### 5.4 Turns (from steps)

Emit one `turn:<stepId>` message per step. `at` is `step.created`, and `actor` is `step.agent` (default `coder-1`).
Researcher steps are **`research`** messages instead (§5.8). `text` is the step `title`.

`detail` holds:
- `number`, `status`, `kind` (`task` or `correction`)
- `verification`: `{status, exit_code?}`
- `files`: a list of `{path, change, added, removed}` from `step.evidence.file_stats`, capped at 50, plus `files_omitted`
- `result_tail`: the last 1,000 characters of `step.result`
- `prompt`: the first 2,000 characters of `step.prompt`, as recorded
- `ended`

**No transcript, no activity list and no raw tool output** go in the message. Those stay in `/api/state` for Workspaces (M7).

### 5.5 Notes

`user instruction` details are strings.
- A note aimed at an agent is recorded as `"Note for <agent>: <text>"`. Parse it into `detail.to = <agent>`, with `text = <text>`.
- A deny-and-redirect note is recorded as `"User denied OpenCode request <id>. Redirection: <text>"`. Parse it into
  `detail.redirect_for = <id>`, with `text = <text>`.
- Anything else is `text` verbatim, bounded to 2,000 characters.

### 5.6 Decisions

The detail is usually a dict: `{action, summary, plan, title, kind, prompt?, role?, question?, capabilities?}`.
- `text` = `summary` (2,000 characters).
- `detail` = `{action, title, plan (at most 12 items, 300 characters each), role?, question?, repaired?}`.
- **Omit `prompt`.** It is the turn's prompt and appears in the turn.
- A string detail (the team proposal path records raw text) becomes `text`, bounded, with `detail.raw = true`.

### 5.7 Requests (permissions and questions)

- **Pending:** for each non-terminal, non-stopped run, each packet in `run['pending']` becomes
  `req:<kind>:<request_id>`, where `request_id` is `packet.get('request_id') or packet.get('id') or packet.get('requestID')`.
  - It ranks as a pending actionable, positioned at the end of its session.
  - `actor` is `packet.get('agent', 'coder-1')`.
  - `text` is a label built from recorded fields: the permission and its first pattern, or the first question's header.
  - `detail` holds `{kind, permission, patterns (≤ 10), risk: {level, label, class, decision, remember_allowed, reasons, impact}, questions?, receipt}`,
    with the risk fields as recorded in the packet.
  - `action` is `{"endpoint": "/api/review", "fields": {"run", "kind", "request_id", "fingerprint"}}`.
- **Old saved rows:** if the packet has no `fingerprint` (such rows exist, see `Controller.state`), set `action = null`
  and `detail.refresh_needed = true`. **Never** put the literal `confirm` word, or a pre-filled decision, into `action`.
- **Decided:** each record in `store.reviews(run)` becomes the same id, with no `action`, positioned at `review.created`.
  `detail.receipt` = `{action, state, actor, risk, created, updated, redirect?}`.
  If a request is both pending and has a receipt in state `sent` or `dispatching`, emit it once, as pending with its receipt.

### 5.8 Team proposals, research and skills

- **Team proposal:** each `team proposal` event becomes a `proposal`. While `run.team.state == 'proposed'` and the run
  is not terminal, the **newest** such message in the session gets:
  - `action` = `{"endpoint": "/api/control", "fields": {"run"}, "choices": ["approve_team", "single_agent", "repropose"]}`
  - `detail.proposal` = the agents and tasks from `run.team.proposal`, bounded: at most 8 agents, 20 tasks and 300 characters per string
  - `detail.warnings`
- **Research:** researcher steps (role `researcher`, from `agents.role_of`) become `turn:<stepId>` messages with `kind: research`.
  While the step's status is `awaiting_approval` and it has a `request`:
  - `action` = `{"endpoint": "/api/research/decide", "fields": {"run", "step": <stepId>, "fingerprint"}, "choices": ["approve", "reject"], "confirm_required": true}`
  - `detail.request` = `{question, why, toolsets, max_turns, seconds}` (bounded)

  The `research *` events fold into that message's `detail.events` (at most 10, as `{kind, created, text}`). If there
  is no matching step, emit them as standalone `research` messages.
- **Skill:** each item in `store.capabilities(run)` becomes `cap:<id>` (`actor: agentcontrol`), positioned at `item.created`,
  with `detail` = `{name, agent, state, source, requested_by, risk, reasons}` (bounded).
  - `state == 'awaiting_fetch'`: `action` = `{"endpoint": "/api/skills/fetch", "fields": {"id"}}`
  - `state == 'proposed'`: `action` = `{"endpoint": "/api/skills/decide", "fields": {"id"}, "choices": ["approve", "reject"]}`

  The `skill *` events stay as `skill` messages (they are the log).

### 5.9 Outcome

For each terminal run, emit `out:<runId>` at `run.ended`, ranked last. `actor` is `agentcontrol`, `text` is `run.summary`
(2,000 characters), and `detail` = `{status, ended, workspace?}`.
- **Workspace (git calls are expensive):** call `Controller.workspace_status(run)` **only** for the newest terminal session in the page whose
  `run['workspace']` exists and is neither `applied` nor `discarded`. For older sessions, set `detail.workspace` from
  the recorded flags only (`{state: 'applied' | 'discarded' | 'open'}`).
- **`action`**, only for that newest session: `{"endpoint": "/api/control", "fields": {"run"}, "choices": [...]}`, where the choices are:
  - `apply`, when the workspace state is `open` and `apply_blocked` is empty
  - `discard_workspace`, when the state is `open`
  - `verify`, when `run.verifier` is non-empty and `run.manual_verification.status != 'running'`

  The verify rule mirrors the classic `canVerifyNow` and `Controller._verify_now`.

### 5.10 Bounds (every string you emit)

- `text`: at most 2,000 characters.
- Any string in `detail`: at most 4,000 characters, unless a smaller limit is given above.
- Lists are capped as stated above.
- Trim with an ellipsis (`…`) and set `detail.truncated = true`.

## 6. Tests

**`tests/test_conversation.py`** (pure, with no HTTP; build fixtures as plain dicts, or reuse `Store` in a temp dir):

1. **Coverage.** Collect every event kind literal matching `store.event\([^,]+,\s*'([^']+)'` across
   `agent-autonomy/*.py`. Add the non-literal kinds (`lifecycle.KIND`, `watch.KIND`, the five terminal statuses,
   and `'skill installed'` and `'skill rejected'`). Assert that each is a key in `MAPPING` or covered by the documented fallback.
   Then assert that `'Hermes request'`, `'agent state'` and `'watch'` are OMIT.
2. One test per message kind in §5, checking `kind`, `actor`, `text` and the essential `detail` fields, **including
   the absence** of `prompt` in decisions and of `transcript` and `activity` in turns.
3. **Notes:** the aimed-note and redirect parsing.
4. **Requests:** pending with `action` fields exactly `{run, kind, request_id, fingerprint}`; the old row with no
   fingerprint (`action` null, `refresh_needed`); a decided request with its receipt; pending plus receipt emitted once.
5. **Proposal:** the action only while `team.state == 'proposed'` and only on the newest proposal.
   **Research:** the action only while `awaiting_approval`. **Skills:** the fetch and decide actions by state.
6. **Outcome:** the choices for open, apply-blocked, applied and discarded workspaces, and with no verifier;
   `workspace_status` called at most once per thread (use a counting stub).
7. **Bounds:** a 50k-character result, summary or note is trimmed, with `truncated`.
8. **Stability:** the same inputs give identical ids and revs; changing one step changes only that message's `rev`.
9. **Unknown kind:** it becomes a `system` message, not dropped.

**`tests/test_thread_api.py`** (HTTP; follow `tests/test_chat_routes.py` / `test_workflow.py`):

1. Both endpoints return 401 without the key.
2. `/api/channels` returns one `main` channel with the correct `sessions`, `active_session` and `waiting`.
3. Unknown `session` returns 404; both `channel` and `session`, an unknown channel, or a malformed cursor return 400.
4. **Paging:** a journal with 3 sessions and more than 600 non-omitted events. With `limit=100`, walking `before` until
   `null` returns every message exactly once, in total order; page sizes are at most the limit.
5. **`known=`:** unchanged messages come back as stubs; after a new event, only new or changed messages come back in full.
6. **Byte-identical `/api/state`:** the same journal gives byte-identical `/api/state` output before and after the
   thread endpoints are called. This proves they are read-only.
7. **Read-only:** calling the endpoints does not change the audit chain, the event count or the row counts. Snapshot `Store` counts before and after.
8. **Other projects:** a run from another project is excluded from `main`, but reachable with `session=`.

## 7. Out of scope

- Any UI (M3 renders the thread). No change to `agent-autonomy/chat/*` or the classic UI.
- Writing endpoints, the composer and slash commands (M4); actionable UI (M5).
- Multiple channels beyond `main`; unread tracking; search.
- W7 live Hermes streaming. Keep the mapping open, so a future `Hermes stream` kind can be added to `MAPPING`.
- Performance work beyond §5.2. Record any measurement in your report.

## 8. Acceptance

1. `python3 -m unittest discover -s agent-autonomy/tests` passes.
   - The review environment's baseline after M1 is **351 tests, OK (skipped=6)**; add your new tests to it.
   - Report skipped tests **by name**.
2. `test_ui.cjs` passes 82/82 and `test_chat_ui.cjs` passes, both unchanged by M2.
3. The diff touches only the files in §3.
4. `git diff` shows no change to any function in `engine.py`, `journal.py` (other than the added `events_page`) or any other backend module.
5. Your report includes one sample `/api/thread` response (trimmed) from a test journal with a single run and a team
   run, so the M3 designer can see real shapes.

## 9. When you finish

1. Append a completion report to this file:
   - what was built and any deviation
   - the page and cursor design you chose, and the per-session cap
   - the test commands and counts (with skipped tests named)
   - the sample response
   - open questions for Opus
2. Update `CURRENT_STATE.md`: M2 status, new files, test counts.
3. Push to `feature/chat-first-redesign`. No PR and no merge unless the owner asks.

If this handoff conflicts with `docs/REDESIGN_ARCHITECTURE.md`, stop and record the conflict in your report instead of choosing silently.
