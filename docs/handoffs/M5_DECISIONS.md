# Handoff M5: Decisions in the room

**From:** Opus (architecture) → **To:** Codex (implementation)
**Branch:** `feature/chat-first-redesign`. Commit and push only there; **never merge into `main`**.
**Prerequisites:** M4, M4.1 and M5.0 (with D7) are **accepted** (reviews in their handoffs; starting commit `f1115cd` or later).
**Read first, in this order:**
1. `CURRENT_STATE.md`
2. `docs/REDESIGN_ARCHITECTURE.md` (binding; §3, §6, §7, §9 and §10)
3. `docs/handoffs/M5_0_ACTIONABILITY.md` (the definition of actionable, and its review)
4. `docs/handoffs/M4_COMPOSER.md` §2 (write rules M5 inherits)
5. this file

**Size:** about 3–4 days. Deliver **Part A as its own commit first** (server read model), then **Part B** (the UI).

---

## 1. Outcome

Everything that is waiting for you in the project room can be decided **in the room**, through the existing decision
endpoints and their existing rules:
- approve or deny agent requests, and answer agent questions
- approve, decline or send back a team plan
- allow or decline research
- fetch, install or reject skills
- apply, discard or verify a finished session's work

The classic dashboard stays available as a secondary path, and is the **only** path for anything the room cannot show in full.

**The rules that make this safe:**
- **The server decides what is actionable, and what happened.** Controls render only on messages whose `action` is
  non-null, using that action's endpoint and fields. A decision appears as made **only** when `/api/thread` returns the recorded result.
- **No optimistic mutation.** Clicking never removes a marker, writes a receipt, or changes a count in the browser.
- **The M5.0 invariant is preserved:** `channels.waiting` equals the number of actionable non-outcome messages. M5
  adds no client-side actionability rule and no count adjustment.
- **You see what you approve.** The room shows the same material classic shows for a decision. When that material is
  truncated, the room refuses to approve and points to classic.

## 2. Hard rules (inherited and new)

1. **Existing endpoints and semantics only:** `/api/review`, `/api/control`, `/api/research/decide`,
   `/api/skills/fetch` and `/api/skills/decide`, with the bodies in §4.
   - No engine, approval, permission, journal or schema change.
   - Part A changes **only** the read-only projection in `conversation.py`.
   - If anything else seems needed, stop and report it.
2. **Endpoint allow-list.** The client may POST only to the endpoint named in a message's `action.endpoint`, and only if
   it is one of the five above. Any other value renders the classic link only. For actions that carry `choices`, only those choices are offered.
3. **No local decision state.** The only browser state allowed is a **transient card status** (§5), tied to the
   message id and `rev`, and dropped when a new `rev` arrives. It never alters the message, the cache, the waiting count or receipts.
4. **One decision in flight across the room, sharing the composer's single-flight lock.** While any decision or composer
   request is in flight, every decision control and Send is disabled.
5. **The typed confirm word comes from the server:** `state.permissions.confirm_word` from `/api/state`. Never hard-code it.
6. **No private material.** Never show tool output, transcripts or reasoning. Part A exposes only the **request input**
   that is being approved, the same fields classic's review dialog shows, bounded.
7. **Still in classic only:** rule revocation, paid models, the stuck watch, internet during work, skill removal or
   rollback, proposing skills from the library, and preview, container or VM controls.

## 3. Part A: give the room what a decision needs (read model only)

`/api/thread` must carry, for **actionable** messages only, the bounded material a person inspects before deciding. That is
what classic shows. Add it to `conversation.py`; no other server file changes.

| Message | Add to `detail` (bounded) | Source (existing records) |
|---|---|---|
| `request` (permission) | `review: {command, file, description, diff, old_text, new_text, content}`: only the keys present | the pending packet's `context.input` (`command`, `filePath`/`path`, `diff`, `oldString`, `newString`, `content`) and `metadata` (`command`, `description`, `diff`). These are the same fields as classic `requestText()` and `permissionHTML()` |
| `request` (question) | `questions` already present; make sure `multiple` and `custom` survive bounding | the pending packet |
| `skill` (state `proposed`) | `review: {description, files (≤ 50 paths), size, skill_md}` | the capability record (classic `skillCard` fields) |
| `proposal` (actionable) | no new fields | – |
| `outcome` (the actionable one only) | `workspace` gains `branch`, `base_branch`, `commits` and `shortstat` | `run.workspace.integration.branch`, `run.workspace.base_branch`, and `workspace_status()` (already called at most once per request) |

- **Bounds:** each string ≤ 4,000 characters (`diff`, `content`, `old_text`, `new_text` and `skill_md` may use
  ≤ 8,000), and lists ≤ 50.
- **Truncation.** If **any** review field, question field, or proposal agent or task was truncated, set
  `detail.review_truncated = true` on that message.
- **Only these keys.** Never copy `output`, `error`, `metadata.output` or any key outside those listed. `PRIVATE_FIELDS` stays in force.
- **Scope.** Review material is added only while the message is actionable. Historical (decided or expired) messages stay as they are.
- **Tests** (`tests/test_conversation.py`, `tests/test_thread_api.py`):
  - each review field comes from its source, for a bash command, an edit (old and new), a write (content) and a diff
  - the bounds and `review_truncated` are set
  - no `output` or reasoning key ever appears
  - question `multiple` and `custom` are kept
  - skill review fields appear only for `proposed`
  - the outcome workspace summary appears only on the actionable outcome, and `workspace_status` is still called at most once
  - review material disappears once the item is decided
  - **The M5.0 invariant tests and every existing projection test pass unmodified.**

## 4. Part B: the decision catalogue (what the room exposes)

The source is each message's `action` (and `choices`, where given). The bodies are **exactly** these; the server already
validates every one of them.

### 4.1 Permission request (`kind: request`, `detail.kind: 'permission'`, endpoint `/api/review`)

| Control | Body | Rules |
|---|---|---|
| **Approve once** | `{run, kind:'permission', request_id, fingerprint, action:'approve', remember?, confirm?}` | **Critical** (`risk.decision === 'confirm'`): show a typed-confirm field ("Type ‹confirm word› to approve") and send it as `confirm`. **"Also allow identical requests in this session"** appears only when `risk.remember_allowed`, and sends `remember: true`. **Disabled when `detail.review_truncated`** ("Too large to review here · Open in classic") |
| **Deny…** | `{…, action:'reject', redirect?}` | an optional "Tell Hermes what to do instead" textarea (1–5,000 characters; omit `redirect` when it is empty). Always allowed, even when truncated: refusing is safe |

### 4.2 Question request (`detail.kind: 'question'`, endpoint `/api/review`)

| Control | Body | Rules |
|---|---|---|
| **Answer** | `{run, kind:'question', request_id, fingerprint, action:'answer', answers}` | `answers` is a list with one list of strings per question. Use a radio group for single questions and checkboxes when `multiple`; offer a free-text option unless `custom === false`. Mirror the server's validation as hints only: every question answered, no duplicates, ≤ 5,000 characters. Disabled when `review_truncated` |
| **Dismiss** | `{…, action:'reject'}` | always allowed |

### 4.3 Team proposal (endpoint `/api/control`, `choices` from the action)

| Control | Body | Rules |
|---|---|---|
| **Approve team** | `{run, action:'approve_team'}` | shows the agents and tasks (`detail.proposal`) inline. Disabled when `review_truncated` |
| **Run as one agent** | `{run, action:'single_agent'}` | none |
| **Ask for another plan…** | `{run, action:'repropose', text}` | a required note, 1–2,000 characters. The server refuses after 3 proposals; show its message |

### 4.4 Research (endpoint `/api/research/decide`)

| Control | Body | Rules |
|---|---|---|
| **Allow research…** | `{run, step, fingerprint, action:'approve', confirm}` | it browses the internet, so **typed confirm is always required** (the server enforces it). Show the question, why, toolsets and limits from `detail.request` |
| **Decline** | `{run, step, fingerprint, action:'reject'}` | none |

### 4.5 Skill

| State | Control | Endpoint and body | Rules |
|---|---|---|---|
| `awaiting_fetch` | **Fetch for review** | `/api/skills/fetch {id}` | a network fetch into quarantine. The result appears as `proposed` with review material, after refresh |
| `proposed` | **Install** | `/api/skills/decide {id, action:'approve'}` | shows `detail.review` (description, files, size, `SKILL.md`). Disabled when `review_truncated`. A server "skill changed" error triggers a refresh and re-review |
| `proposed` / `awaiting_fetch` | **Reject** | `/api/skills/decide {id, action:'reject'}` | always allowed |

### 4.6 Outcome (the channel's newest finished session only; endpoint `/api/control`, `choices` from the action)

| Control | Body | Rules |
|---|---|---|
| **Apply to ‹base_branch›…** | `{run, action:'apply'}` | a confirmation dialog: "Merge ‹branch› into ‹base_branch›? ‹commits› commits · ‹shortstat›. This changes your branch." A merge conflict returns the server's 400 text ("Your branch is unchanged…"); show it verbatim |
| **Discard work…** | `{run, action:'discard_workspace'}` | a confirmation dialog: "Delete ‹branch› and its worktrees? This cannot be undone." |
| **Verify now** | `{run, action:'verify'}` | no confirmation. The result arrives later as the recorded "verification (on demand)" system message |

### 4.7 Slash commands (added in M5)

These are aliases only. They act on the room's **current actionable item of that type**; if there is none, they show an
inline error ("Nothing to apply here") and send nothing.

| Command | Does |
|---|---|
| `/verify` | Verify now |
| `/apply` | opens the Apply dialog |
| `/discard` | opens the Discard dialog |
| `/team approve` | Approve team |
| `/team single` | Run as one agent |
| `/team repropose <text>` | Ask for another plan, with `<text>` as the note |

Remove them from M4's "not available here" list. Request, research and skill decisions have no slash aliases; use the cards.

## 5. Server authority and stale or racing decisions

Each actionable card has a small state machine. Only the **transient status** is browser state; everything else comes from `/api/thread`.

| Situation | What the card shows | Then |
|---|---|---|
| idle | the controls (§4) | – |
| request in flight | the controls disabled; status "Sending your decision…" | – |
| 2xx response | the controls hidden; status **"Sent · waiting for AgentControl to record it"** | one immediate coalesced refresh. The card changes only when a **new `rev`** for this message arrives (`action: null` and a receipt, or a revised item) |
| still the same `rev` after 3 refresh cycles or 15 s | status "Not recorded yet." with **Refresh** | the controls come back only if a fresh read still shows the same actionable `rev` |
| the server receipt shows a decision in flight (`detail.receipt.state` in `dispatching`, `sent`, `uncertain`) | **no controls**; the server receipt label (M3.1), for example "Delivery uncertain · by you" | the server resolves it. Never offer a second decision while a receipt is in flight |
| 409 (`ReviewConflict`: changed, no longer pending, already decided; or the research fingerprint changed) | the server's message inline, for example "The requested action changed…" | an immediate refresh; the controls re-render from the **fresh** message (new fingerprint) or disappear |
| 400 (validation, D7 "session has ended", "skill changed", apply conflict, repropose limit) | the server's message inline. Typed-confirm fields clear, other inputs stay | an immediate refresh |
| 401 | sign-in (as today); typed inputs are discarded | – |
| network failure (no response) | "Couldn't reach AgentControl. The decision may or may not have been recorded. Checking…" | an immediate refresh. The controls come back only if the fresh read shows the item still actionable **without** an in-flight receipt |
| the item stops being actionable while a dialog is open (a new `rev` with `action: null`) | close the dialog: "This was decided elsewhere or is no longer waiting." | – |

**Never:**
- send a second decision for the same message while one is in flight or its receipt is in flight
- render "Approved", "Denied", "Installed" or "Applied" from the click; only the server's receipt or events do that
- adjust the waiting count

## 6. UX: desktop and phone

- **Progressive disclosure.**
  - The collapsed card shows its one-line summary (M3), the key facts (the command or file for a permission; the plan size
    for a proposal; the question for research; the skill name and risk), and **one primary row of buttons**.
  - Large material (diffs, file contents, `SKILL.md`, full task lists) sits in a "Review details" disclosure.
  - It is **expanded by default** for critical (R3) permissions, for research approval, and for skill install.
- **Primary and secondary.**
  - On a request, the primary button is Approve once, or Answer.
  - Deny, Dismiss, Decline and Reject are visible secondary buttons. Destructive outcome actions are never primary.
  - Each card keeps a quiet "Open in classic dashboard" link.
- **Dialogs** (the M4 `<dialog>` pattern; a bottom sheet on phones): Apply, Discard, any typed confirm (critical approve,
  research allow), the Deny redirect, and the repropose note.
  - Focus starts on the safe choice (Cancel); Escape cancels.
  - The dialog title names the object.
- **Button labels name their object for assistive technology,** for example `aria-label="Approve once: bash · npm test"`.
  The card's status uses one stable `role="status"` node. After a decision, focus stays on the card (M3's keyed focus restoration).
- **Phone (390 × 844):**
  - the button row wraps to full-width buttons, at least 40 px high
  - dialogs are bottom sheets that do not cover the room header
  - the M4 footer budgets still hold (≤ 72 px idle, ≤ 120 px with the waiting row, conversation ≥ 65%)
  - the waiting pointer still jumps to the first actionable card
- **Tokens only.** Use the warning colour for waiting cards and the danger colour only for destructive confirmations, never for status.

## 7. Files

| File | Change |
|---|---|
| `agent-autonomy/conversation.py` | Part A only: bounded review material and `review_truncated`, and the outcome workspace summary |
| `agent-autonomy/chat/decisions.js` | **new**, `AC.decisions`. Pure helpers exported (`controlsFor(message, permissions)`, `reviewBody`, `controlBody`, `researchBody`, `skillBody`, `answersFrom`, `allowedEndpoint`, `cardStatus`), plus the card controls and dialogs |
| `agent-autonomy/chat/thread.js` | mount the decision controls on actionable messages; replace the M3 "no decision controls" rendering for them |
| `agent-autonomy/chat/composer.js` | M5 slash commands; share the single-flight lock |
| `agent-autonomy/chat/core.js` | expose `permissions` from `/api/state` (already fetched) if needed; no new endpoints |
| `agent-autonomy/chat/shell.js`, `index.html`, `chat.css` | dialogs, the script load, styles (tokens only) |
| `agent-autonomy/tests/fixtures.cjs` | additions: actionable requests (critical, low, question single and multiple, truncated), proposal, research, skill (awaiting_fetch and proposed), actionable outcome |
| `agent-autonomy/tests/test_chat_ui.cjs`, `chat_screenshots.cjs` | §8 |
| `agent-autonomy/tests/test_conversation.py`, `test_thread_api.py` | Part A tests |
| `docs/REDESIGN_ARCHITECTURE.md`, `CURRENT_STATE.md`, this file | contract notes (§9), status, completion report |

**No change** to `engine.py`, `app.py`, `journal.py`, `permissions.py`, the classic UI, or any other backend file.

## 8. Tests

**DOM** (the existing harness, with POST capture and scripted responses):
1. **Catalogue:** every §4 control renders only on actionable messages, with exact bodies.
   - Permission: approve, approve with remember (only when allowed), critical approve with typed confirm (using the
     server's confirm word), deny with and without redirect.
   - Question: single, multiple and custom answers; dismiss.
   - Proposal: all three choices, with the repropose note required.
   - Research: allow (with confirm) and decline.
   - Skill: fetch, install and reject.
   - Outcome: apply and discard (both through dialogs), and verify.
2. **No controls** on decided, expired, historical or non-actionable messages, or on messages whose endpoint is not allow-listed.
   Approve, Answer, Approve team and Install are disabled with the classic pointer when `review_truncated`.
3. **Server authority:** after a 2xx response, with `/api/thread` held, the card shows only "Sent · waiting…"; the
   marker, receipt and waiting count are unchanged. When the new `rev` arrives, the card renders from it. The "Not recorded yet" timeout path works.
4. **Races:**
   - 409 → inline message, refresh, then controls re-rendered with the new fingerprint
   - 400 (D7 ended, skill changed, apply conflict) → verbatim message and refresh
   - network failure → the "may or may not" message and a refresh
   - an in-flight receipt (`sent` or `uncertain`) → no controls
   - a dialog open while the item is decided elsewhere → the dialog closes with a notice
5. **Single-flight:** double clicks and Enter repeats send once; while a decision is in flight, Send and every other decision control are disabled, and vice versa.
6. **Invariant:** for every fixture room, the number of cards with decision controls equals `channels.waiting` plus the actionable outcome (0 or 1).
7. **Slash commands** for M5: they act only when the item exists, open the same dialogs, and otherwise show an inline error with no send.
8. **Accessibility:** object-naming labels, dialog focus (Cancel first, Escape), and the stable status node.
9. **Guards kept:** tokens only, no classic assets, no fingerprint text in the DOM (the fingerprint is sent, never
   displayed), and the M3, M3.1, M4 and M4.1 tests pass.
   - **One exception:** the M3 and M4 guards asserting that *no* decision-named control exists (and M4's "/verify is not
     available here") are **replaced** by test 2 above. Rewrite only those assertions, and list each one in the completion report.

**Browser matrix:** at desktop, laptop and phone, in light and dark, add:
- a critical request with the typed confirm
- a question
- a team proposal
- research allow
- skill install review
- the Apply dialog
- a card in "Sent · waiting"
- a 409 notice

Assert no overflow, the footer budgets, and the waiting pointer reaching the first actionable card on phone.

**Real server check (required):** use `app.py` with the test fakes from `tests/test_workflow.py` (`FakeAPI` with a held
permission, `FakeManager`) and a git project fixture. Record:
- approve once and deny-with-redirect on real pending permissions (with the receipts arriving from the server)
- a stale-fingerprint 409 (alter the packet between render and click)
- team approve, if the fixture supports team mode
- apply and discard on finished sessions
- verify now
- the waiting count matching the cards throughout

**Python:** the Part A tests (§3). Every existing test passes unmodified.

## 9. Contract updates (make them when you finish)

- §6.4 and the change log: "Actionable messages carry bounded review material (`detail.review`) and `review_truncated`;
  truncated items can be refused, but not approved, in the room."
- §7: "/verify, /apply, /discard and /team are available in M5, acting on the room's current actionable item."
- Record that the transient card status is the only decision-related browser state.

## 10. Acceptance

1. `python3 -m unittest discover -s agent-autonomy/tests` passes; report skipped tests by name.
   - Baseline: **408, OK** (6 skipped in the review environment, 3 with OpenCode).
   - An unchanged timing-sensitive test that fails intermittently is rerun and recorded, never modified.
2. `test_ui.cjs` passes 82/82. `test_chat_ui.cjs` passes (79 existing tests plus the new ones). `chat_screenshots.cjs` passes, with the budgets.
3. The diff touches only the files in §7.
4. The real server check (§8) is recorded.
5. The completion report lists every decision type with its endpoint, body and one recorded server result.

## 11. When you finish

1. Append a completion report to this file:
   - the Part A and Part B commits
   - test commands and counts (with skipped tests named)
   - the screenshots reviewed
   - the real server check
   - deviations and open questions
2. Update `CURRENT_STATE.md`. Push to `feature/chat-first-redesign`. No PR and no merge unless the owner asks.

If this handoff conflicts with `docs/REDESIGN_ARCHITECTURE.md`, stop and record the conflict instead of choosing silently.

---

## M5 Part A completion report — Codex, 2026-10-01

Part A was implemented on the clean, freshly pulled `38dd629` branch. No Part B UI changes were made before
this separate commit. The read-only projection is the only production server file changed.

- Permission review copies only the documented classic input fields, retaining command/input and diff/metadata
  precedence. Structured or unsupported values are omitted and require classic re-review.
- Proposed, actionable skills expose description, at most 50 file paths, size and `SKILL.md`; other states do not
  acquire review material. Question `multiple` and `custom` remain intact.
- Strings retain the 4,000/8,000 bounds; existing question and proposal bounds are not expanded. Relevant
  truncation is flagged on actionable items. Output, errors and private reasoning are not copied.
- Only the actionable outcome gains branch, base branch, commits and shortstat, using the existing single
  workspace-status read. Historical messages, outcome choices and all accepted M5.0 predicates are unchanged.
- Twelve new projection/HTTP regressions cover those fields, privacy, bounds, input immutability, retirement of
  review material and workspace read counts. Every pre-existing Python test remains unmodified.

Verification, all run afresh:

| Check | Result |
|---|---|
| `python3 -m unittest discover -s agent-autonomy/tests -v` | 420 tests, OK, 3 environment skips; sequential final run, 255.049 s |
| From `agent-autonomy/tests`: `python3 -m unittest -v test_conversation test_thread_api` | 67 tests, OK, including the unchanged complete paging invariant and D7 side-effect guards |
| `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_ui.cjs` | 82/82 |
| `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_chat_ui.cjs` | 79/79, unchanged |
| `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/chat_screenshots.cjs /tmp/chat-shots-m5a` | 108 combinations + 4 regressions; 158 screenshots, budgets/overflow/waiting alignment passed |

Skipped: `test_container_e2e.ContainerRunE2E.test_agent_works_in_a_locked_down_container`,
`test_preview.DesktopTests.test_desktop_preview_shows_frames_and_accepts_input`, and
`test_vm_e2e.VMRunE2E.test_agent_works_in_a_kvm_clone`. The OpenCode trio ran and passed.

The first full run overlapped browser/HTTP checks and hit the protected workflow tests' fixed five-second waits:
`test_stale_denial_cannot_add_a_redirection`, `test_step_limit_is_enforced`,
`test_step_records_transcript_and_planning_context`, `test_stop_aborts_only_managed_session`, and
`test_three_failed_steps_stop_even_if_model_calls_them_new_tasks`. All five passed in an isolated rerun
(3.524 s), then the full sequential run passed. No protected tests or engine code were adjusted.

Open clarification for Part B: §2.2 permits POST only to `action.endpoint`, but §4.5 requires Reject for an
awaiting-fetch skill to POST `/api/skills/decide` although its accepted action names `/api/skills/fetch`.
The owner has been asked whether to authorize that single documented exception; no exception or alternate
action metadata has been implemented. This does not affect Part A.

The accepted D7 boundary is preserved. A skill fetch accepted before its session finishes may already be
downloading outside the controller lock; this in-flight race remains intentionally excluded from M5.
Part B verification, rendered screenshot inspection and fake-backed real-server decisions remain to be done.
