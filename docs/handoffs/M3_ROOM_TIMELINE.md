# Handoff M3: Room timeline (conversation and message UI)

**From:** Opus (architecture) → **To:** Codex (implementation)
**Branch:** `feature/chat-first-redesign`. Commit and push only there; **never merge into `main`**.
**Prerequisite:** M2.1 is **accepted** (review 2026-09-30, `docs/handoffs/M2_1_CORRECTIONS.md`), and this handoff has been
checked against the final M2.1 API behaviour (see §2.1).
**Read first, in this order:**
1. `CURRENT_STATE.md`
2. `docs/REDESIGN_ARCHITECTURE.md` (binding; §1, §3, §5, §6, §9, §10 and §11 matter most)
3. `docs/handoffs/M2_THREAD_READ_MODEL.md` §4–§5 (the API you consume) and its review
4. this file

**Size:** about 2–3 days.

---

## 1. Outcome

`/chat` becomes a real **project room**. The timeline shows the project's conversation from `/api/thread`, in time order:
- sessions as dividers
- your goals and notes
- Hermes's decisions
- agents' turns, requests, proposals, research and skill items
- AgentControl's progress, alerts and outcomes

It updates live, pages back through history, and uses **progressive disclosure**: every item is one calm line or a
short bubble by default, and the detail opens in place.

M3 is **still read-only**:
- no composer sending (M4)
- no approve, deny, apply or other decision controls (M5)
- no native Workspace (M7)

Where an item is actionable, it says so honestly and links to the classic dashboard for the decision.

## 2. Data contract: consume what exists, invent nothing

| Need | Source | Notes |
|---|---|---|
| channel list, waiting count, active session | `GET /api/channels` | replaces M1's client-side `channelsFromState` inside the rail; keep that adapter only as a fallback while loading |
| timeline sessions and messages | `GET /api/thread?channel=main` (+ `before`, `limit`, `known`) | the **only** source of timeline content |
| focused-session deep link | `GET /api/thread?session=<id>` **only** if the session is not reachable by paging (§4.4) | |
| members, presence, Connections, context-panel session details, rail session list | `GET /api/state` (as in M1/M1.1) | unchanged; M6 revisits presence |
| live notices | `GET /api/events` (as in M1) | unchanged |

**Rules:**
- Do not derive timeline messages from `/api/state` (its steps, events or inbox), and do not call `/api/agents`.
- Render only what a message carries. Every visible string comes from a message's `text`, from `detail` or `sessions`
  fields, or from a fixed UI label in §3.
- **Never compose text in Hermes's or an agent's voice.**
- Render all text as **plain text**: escaped, `white-space: pre-wrap`, long tokens wrapping. No Markdown or HTML
  rendering in M3, because model output is untrusted.
- Unknown `kind` values render as a quiet system line, using `text`. Unknown `detail` keys are ignored.

### 2.1 Final API behaviour to rely on (after M2.1)

- **Request actors are correct in team runs.** A decided request keeps the agent that made it (mapped from its
  recorded session). Render `actor` as given; never infer it on the client.
- **Only one outcome can be actionable:** the **channel's newest terminal session**. Every other outcome has
  `action: null`, and its `detail.workspace` holds only `{state}` from recorded flags (no `apply_blocked`).
  The same outcome has the same `action` and `rev` on every page and in the `session=` view, so merging pages by `id` and `rev` is safe.
- **Decisions always have visible text.** A decision without text is folded out, so never assume every turn is
  preceded by a decision message. Planning decisions carry `detail.planning` and `detail.proposal_counts`.
- **Pending requests** sort at the end of their session (they use the session's latest time, ranked before the outcome).
  Once decided, they move to their receipt time, which is inside the newest window.
- **Cost.** With the D6 index, the first thread page and `/api/channels` take tens of milliseconds on a 460 MB journal,
  so refreshing all three endpoints on each coalesced change is fine.

## 3. Rendering by message kind (progressive disclosure)

Actors appear as a small mark plus a name: **you**, **hermes**, the agent name (`coder-2`, `reviewer-1`, …) and **AgentControl**.
Specialists get a role mark (tester, reviewer, researcher), as in M1's members list. Times are relative, with the
absolute time as a tooltip or `title`. A day separator goes between messages on different local days.

| `kind` | Collapsed (default) | Expanded in place |
|---|---|---|
| `session_start` | **session divider:** title, status symbol and label (from `sessions[]`), start time, mode (`team` badge), and "continues ‹title›" when `detail.parent` is set, linking to `#/s/<parent>` | none. The divider toggles its session's collapse (§4.3) |
| `goal` | a **you** bubble with the text, clamped to 6 lines, plus "Show more" | the full text |
| `note` | a **you** bubble with a recipient chip: "→ Hermes", or "→ @<detail.to>"; with `detail.redirect_for`, the chip reads "Redirect after denying request <id>". Under the most recent notes in an active session with **no later `decision`** in that session, show the muted hint **"Hermes reads this before the next turn"** | the full text |
| `decision` | a **hermes** bubble: `text`, then "Next: <detail.title>" when present. `detail.repaired` shows a subtle "repaired reply" marker; `detail.planning` shows "Team plan · N agents · M tasks" (from `proposal_counts`) | `detail.plan` as a numbered list |
| `turn` | **one line:** actor mark, "turn <number> · <text>", status symbol and label, a verification chip (✓ passed, ✕ failed, – not configured) and "N files ±a/−r". `detail.uncertain` adds "! submission uncertain" | the prompt (clamped to 8 lines; "Show more"), the file list (path, change, ±), `result_tail` in monospace, and ended time. A link, **"Inspect in classic"** (`/classic`), stands in for Workspaces until M7 |
| `research` | one line: actor mark, "research · <text>", status | `detail.request` (question, why, toolsets, limits) and `detail.events` as a small log |
| `request` | a card: actor mark, the permission or question label (`text`), and the risk level label and class from `detail.risk`. Its state comes from `detail.receipt` (for example "Approved by you", "Denied", "Sent", "Uncertain") or, **if `action` is set**, "Waiting for you" | patterns, questions and risk reasons, and the receipt detail |
| `proposal` | a **hermes** card: `text`. If `action` is set, "Team proposal waiting for your decision" | `detail.proposal` (the agents and tasks) and warnings |
| `skill` | a quiet line: `text`, agent, state | source, risk, reasons |
| `progress`, `system` | a **quiet single line** (muted, small). **Consecutive** `progress` and `system` messages within one session collapse into one line, "N updates", which expands to the list | the individual lines |
| `alert` | a warning line with a "!" symbol (never colour alone) | detail fields, if any |
| `outcome` | a session footer: the status symbol and label, `text` (the summary, clamped to 3 lines), and the workspace state ("open", "applied" or "discarded"). Add "apply blocked: …" only when `detail.workspace.apply_blocked` is present, which happens only on the actionable newest outcome | full summary |

**Receipt actors.** `detail.receipt.actor` is recorded text. Show `You, via dashboard` as "you"; show any other value
(for example an automatic rule approval) verbatim. Never guess who acted.

**For every message with a non-null `action`** (a request, proposal, research, skill or outcome), render an
**"Open in classic dashboard"** link (`/classic`) and a clear "waiting for you" state.
- Render **no** buttons that name a decision: nothing like Approve, Deny, Apply or Verify.
- Do not read or show the `fingerprint` or the action's `fields`, and do not construct a POST.

M5 turns these into real controls. Until then, the classic dashboard is the only decision surface.

## 4. Behaviour

### 4.1 Loading, merging and live updates

- **On load:** fetch `/api/channels` and the first `/api/thread?channel=main&limit=200` page. Keep fetching `/api/state`
  as M1.1 does.
- **The client cache:** an ordered list of message ids plus a map from id to message, and the `sessions` merged by id.
  Keep the server's order: pages are contiguous and already in total order. **Never re-sort on the client.**
- **On each coalesced change** (the M1 refresh scheduler: one in flight, one trailing), fetch:
  - `/api/thread?channel=main&limit=200&known=<id:rev of the cached newest window>` (at most 2,000 entries)
  - `/api/channels`
  - `/api/state`

  Replace the cached newest window with the response. Stubs (`same: true`) reuse the cached message.
- **Gap handling.** If the newest page has no overlap with the cached messages (more than 200 new messages arrived),
  walk `before` from that page until a page contains a cached id. Stop after at most 5 pages; if there is still no
  overlap, discard the older cache and keep the newest pages only.
- Messages can legitimately change position only inside the newest window (for example, a pending request becomes a
  decided receipt). Replacing the window handles that.
- **Re-render keyed by id and `rev`.** Only changed messages are replaced in the DOM. Do not rebuild the whole
  timeline on every refresh the way M1's session blocks did. Preserve expanded or collapsed state per message id,
  and preserve focus and scroll.

### 4.2 Scrolling and paging

- **First load:** scroll to the bottom (the newest message).
- **Follow mode:** while the user is at the bottom, new messages keep the view pinned. When the user has scrolled up,
  show a pill, "N new ↓", which returns to the bottom.
- **Older history:** a **"Load earlier"** control at the top fetches `before=<cursor>` and prepends the page,
  keeping the viewport anchored so nothing jumps. Auto-loading on reaching the top is allowed as an enhancement,
  but the button must exist (tests and keyboard). When `before` is `null`, show "Beginning of this project's history".

### 4.3 Sessions and progressive disclosure

- Sessions are **not separate conversations.** They are dividers and blocks inside the one project room (architecture §1 and §6).
- **The newest session and any active session are expanded. Older sessions are collapsed** to their divider, their
  goal (first line) and their outcome line, with "Show N messages".
- Remember expanded sessions for the page lifetime only; no storage needed.
- **The live status line** is not a message. It sits at the bottom of the timeline, derived only from `/api/thread`'s `live`:
  - `phase: manager` → "Hermes is planning…"
  - `phase: code` → "Agents are working…"
  - `phase: verify` → "Verifying…"
  - hidden when `live.session` is null

  Style it as system status (muted, no actor mark).

### 4.4 Focusing a session (`#/s/<id>`)

- The rail's session links, "continues ‹title›" links and dividers set `#/s/<id>`. The timeline scrolls to that
  session's divider and briefly highlights it. The context panel opens, as in M1.
- If the divider is not loaded, page back with "Load earlier" up to 10 pages. If it still isn't found, fetch
  `/api/thread?session=<id>` and show that single session in a clearly labelled **"Viewing one session"** mode, with
  **"Back to room"**. Do not splice those messages into the room cache.
- Unknown sessions keep M1.1's behaviour: the notice, then `#/`.

### 4.5 Waiting pointer and rail

- The waiting strip above the composer shows `channels[0].waiting`. When it is greater than 0, it reads
  "! N waiting for you" (with correct pluralisation):
  - clicking it scrolls to the **first message with a non-null `action`** in the cache (loading earlier pages if needed, bounded as above)
  - it keeps a secondary "Open classic dashboard" link
- The rail's channel entry uses `/api/channels` for its title and waiting badge.
- The rail's session list and members stay from `/api/state` for now.
- **Remove M1's session-block timeline and its waiting strip.** The thread replaces them.

### 4.6 Composer

It stays **disabled**, as in M1, with its placeholder. M4 enables it.

## 5. Files

| File | Change |
|---|---|
| `agent-autonomy/chat/thread.js` | **new**, `AC.thread`. It holds the pure cache and merge functions (`mergeNewest`, `prependOlder`, `applyStubs`, `findGap`, `groupQuiet`, `sessionCollapsed`, `liveLabel`, `pendingHint`), exported with the CommonJS guard, plus the keyed timeline renderer |
| `agent-autonomy/chat/core.js` | fetch `/api/channels` and `/api/thread` inside the existing coalesced refresh; expose the thread cache in `getState()` |
| `agent-autonomy/chat/shell.js` | mount the timeline; routing for focus and "Viewing one session"; the waiting pointer; remove the M1 session blocks |
| `agent-autonomy/chat/model.js` | keep the M1 adapters; add small label helpers if they are needed |
| `agent-autonomy/chat/index.html` | load `thread.js` (deferred, after `model.js`, before `shell.js`); bump the `?v=` numbers |
| `agent-autonomy/chat/chat.css`, `tokens.css` | message, bubble, divider, card and quiet-line styles, **tokens only** (the existing guard applies) |
| `agent-autonomy/tests/fixtures.cjs` | **add** thread fixtures (§6); do not change existing fixtures |
| `agent-autonomy/tests/test_chat_ui.cjs` | the new DOM tests; keep all 16 existing tests passing (update only assertions about the removed M1 session blocks) |
| `agent-autonomy/tests/chat_screenshots.cjs` | the new rendered cases (§6) |
| `CURRENT_STATE.md`, this file | status and completion report |

**No backend change.** `app.py`, `conversation.py`, `journal.py` and everything else server-side are untouched.
If you find a contract gap, stop and record it; do not patch the server.

## 6. Tests

**Fixtures.** Build thread responses in `fixtures.cjs` that match real M2 and M2.1 output. Start from the sample
responses in the completion reports of `M2_THREAD_READ_MODEL.md` and `M2_1_CORRECTIONS.md` (the latter has a decided
request with actor `coder-2`), or copy output from the `tests/test_thread_api.py` journals. Provide:
- `threadSingle()`: goal, decision, two turns (one failed verification, one uncertain), a decided request, and an outcome with a workspace
- `threadActive()`: an active session with a pending request (with `action`), a note aimed at `coder-2`, a redirect note, and `live.phase: 'code'`
- `threadTeam()`: a proposal with `action`, a planning decision with counts, a **decided request from `coder-2`**, progress lines, research with request and events, and a skill with `action`
- `threadLong()`: three sessions and more than 400 messages across 3 pages, with cursors

**DOM tests** (in `test_chat_ui.cjs` or a new `test_chat_thread.cjs` with the same harness style):
1. Every message kind renders its collapsed form; expanding shows the §3 detail. An unknown kind renders as a quiet line.
2. **No decision controls:** there is no button or link text matching Approve, Deny, Apply, Discard, Verify, Reject or
   Answer. Every actionable message has exactly one `/classic` link and a waiting state. No `fingerprint` appears in the DOM.
3. **Escaping and plain text:** `<img onerror>` in the text, notes, decision plans, file paths and result tails creates no
   elements. Markdown such as `**x**` renders literally.
4. **Merge:** stubs reuse cached messages; changed revs replace only those DOM nodes (assert that node identity is kept
   for unchanged messages); a decided request replaces its pending form without duplication.
5. **Gap:** 250 new messages trigger `before` walking until overlap; the 5-page cap then resets the cache.
6. **Paging:** "Load earlier" prepends in order with no duplicates, until `before` is `null`, which shows the
   beginning marker. The scroll anchor is preserved (assert the `scrollTop` adjustment in the harness).
7. **Follow and pill:** at the bottom, a new message stays pinned; scrolled up, the "N new ↓" pill appears and clicking it returns to the bottom.
8. **Sessions:** the newest and active sessions are expanded and older ones collapsed; the divider toggles;
   "continues" links route to `#/s/<parent>`.
9. **Focus:** a session two pages back loads earlier pages and highlights its divider; a session beyond 10 pages uses
   `?session=` "Viewing one session" mode and "Back to room"; an unknown session keeps M1.1's behaviour.
10. **Live status labels** for each phase; hidden when `live.session` is null. The **pending-note hint** shows only
    until a later decision exists in the same session.
11. **Waiting pointer:** the count comes from `/api/channels`, with correct pluralisation; clicking scrolls to the first actionable message.
12. **Refresh:** one SSE `change` produces exactly one coalesced cycle of `/api/thread` (with `known=`), `/api/channels`
    and `/api/state`, and no `/api/agents`. A 401 from `/api/thread` or `/api/channels` returns to sign-in, as M1 does.
13. The existing guards still pass: tokens only, and no classic asset references.

**Browser matrix** (`chat_screenshots.cjs`): add `threadActive`, `threadTeam` and `threadLong` at desktop, laptop and phone,
in light and dark. Assert:
- no horizontal overflow, including with a 300-character unbroken token in a turn result
- the phone waiting strip and the newest message are visible without scrolling on first load
- no page errors

Review the screenshots yourself for calm density and hierarchy: one line per quiet item, and no cards inside cards.

## 7. Out of scope

- Sending anything (M4). Decision controls and POSTs of any kind (M5). A presence redesign or team panel (M6).
  A native Workspace, live terminal, diff viewer or preview (M7). The phone polish pass beyond "usable and no overflow" (M8).
- Any server change, including new endpoints or fields. If `/api/thread` lacks something you need, record it as an open question.
- Themes. Markdown rendering. Unread markers and search.

## 8. Acceptance

1. `python3 -m unittest discover -s agent-autonomy/tests` passes (M3 changes no Python). Report skipped tests by name.
   An unchanged timing-sensitive backend test that fails intermittently is rerun and recorded, never modified.
2. `test_ui.cjs` passes 82/82. The chat DOM tests pass (the existing ones plus the new ones).
   `chat_screenshots.cjs` passes (the existing cases plus the new ones).
3. The diff touches only the files in §5.
4. **Manual check** against a real server with a real journal, or with the M2 HTTP test journal served by `app.py`:
   - `/chat` shows the room history
   - a new event appears live without a reload
   - "Load earlier" reaches the beginning
   - `/classic` still works for every decision

## 9. When you finish

1. Append a completion report to this file:
   - what was built and any deviation
   - test commands and counts (with skipped tests named)
   - the screenshots you reviewed
   - any contract gaps found in `/api/thread`, as open questions for Opus
2. Update `CURRENT_STATE.md`: M3 status, new files and test counts.
3. Push to `feature/chat-first-redesign`. No PR and no merge unless the owner asks.

If this handoff conflicts with `docs/REDESIGN_ARCHITECTURE.md`, stop and record the conflict instead of choosing silently.

---

## M3 completion report — Codex, 2026-09-30

Implemented only M3, starting from clean `feature/chat-first-redesign` at `53d23cf` after a fast-forward pull.
The new `chat/thread.js` exports the required pure cache/disclosure helpers and mounts a keyed project-room
renderer. `/api/thread` supplies every timeline record; `/api/channels` supplies the room/channel identity,
active session and waiting count. Members, Connections, the rail session list and context still use `/api/state`.
No server, schema, orchestration, lifecycle, journal, approval or verification files changed.

The room renders every specified kind as plain escaped text, with bounded public task/file/result details
expanded in place. Team-plan counts, the decided `coder-2` request and stored receipt actors are covered.
Unknown details are ignored. Action metadata is used only as a non-null marker: fingerprints, fields and
choices are never read or shown, and each actionable item has exactly one classic decision link and a waiting
state. The composer remains disabled; no frontend write was introduced. M4 and later milestones remain unstarted.

Implemented ordered newest-window replacement with `known` stubs, older-page prepending, five-page gap recovery,
new-message follow/pill behaviour, scroll anchoring, session collapse, parent links, ten-page deep-link/waiting
lookup, isolated single-session fallback and the existing unknown-session notice. Unchanged message nodes retain
identity; revised items retain disclosure and restore focused controls. Waiting notes and live status derive from
thread data. Paging updates divider counts as history arrives. When a new terminal outcome retires actions on a cached
older outcome, contiguous read pages revalidate that item from the server rather than inventing new metadata. M1.1 stale-session and scrim regressions remain covered.

### Required verification

| Command | Result |
|---|---|
| `python3 -m unittest discover -s agent-autonomy/tests` | **398 tests, OK (skipped=3)**, 257.697 s; no failures or timing-test reruns |
| `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_ui.cjs` | **82/82 passed**; classic files/tests untouched |
| `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_chat_ui.cjs` | **34/34 passed**: all 16 shell regressions and 18 M3 tests |
| `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/chat_screenshots.cjs /tmp/chat-shots` | **42 combinations + 4 regressions passed**, 90 temporary screenshots; no page errors or horizontal overflow |
| Real `app.py` journal check (scratch scripts `/tmp/ac-m3-manual-server.py`, `/tmp/ac-m3-manual-check.cjs`) | Passed room history, live SSE note without reload, three older pages to the beginning, `/` and `/classic`, every rendered classic decision link, and zero frontend writes; 673 journal-projected records cached |
| `git diff --check` and scope review | Passed; only §5 files changed |

Skipped tests, by full name:

- `test_container_e2e.ContainerRunE2E.test_agent_works_in_a_locked_down_container` — opt-in container runtime/image gate.
- `test_preview.DesktopTests.test_desktop_preview_shows_frames_and_accepts_input` — desktop tools unavailable.
- `test_vm_e2e.VMRunE2E.test_agent_works_in_a_kvm_clone` — opt-in KVM gate.

The OpenCode integration trio ran and passed. Backend socket tests and Chromium ran outside the filesystem
sandbox, using the existing test-only dependencies in `/tmp/ac-tests`; no runtime dependency was added.
The scratch server uses `ThreadAPITests`' actual SQLite journal and unmodified `app.handler`, with its background
execution workers stopped and SSE enabled. The live note was appended by the scratch fixture, not by `/chat`.

### Screenshots reviewed

Reviewed the temporary images in `/tmp/chat-shots`, including `threadActive-desktop-light.png`,
`threadTeam-desktop-dark.png`, `threadTeam-phone-light.png`, `threadTeam-laptop-dark-context.png`,
`threadLong-laptop-dark.png` and `real-journal-room.png`. The room has concise turns, quiet grouped updates,
simple request borders and no cards inside cards. First-load phone checks assert the newest item is inside the
scrollable timeline and the waiting strip is visible. Expanded results include a 300-character unbroken token.
Screenshot review found and resolved a footer-layout scroll issue; the final matrix covers it.

No scope deviations, API contract gaps or unresolved M3 issues. The existing 30-session rail limit, environment
gates, backend timing-sensitive tests and v1 server materialisation remain documented in `CURRENT_STATE.md`.
M3 is ready for architecture review; M4 has not begun.


## Architecture and UX review — 2026-09-30 (Opus)

**Verdict: M3 is architecturally sound, but corrections are required before M4.** Nothing is blocking.
Three correctness and UX issues on the decision surface must be fixed first; they are handed off in
`docs/handoffs/M3_1_CORRECTIONS.md`. The M4 handoff will be written once M3.1 is accepted.

Reviewed: `53d23cf..aee4296` (the single commit `aee4296`), the rendered screenshot matrix, and targeted DOM probes
of the shipped `thread.js`.

### Re-run in the review environment (at `aee4296`)

| Suite | Result |
|---|---|
| Python | **398 tests, OK (skipped=6)**: the same six environment gates; 3 in Codex's environment |
| Classic DOM | **82/82** |
| Chat DOM | **34/34** |
| Browser | **42 combinations + 4 regressions**, 90 screenshots; I reviewed them myself (listed below) |

No backend, schema, classic or orchestration file changed.

### Verified

- **The project room is the primary surface.** The timeline replaced M1's session blocks. Sessions are dividers inside the one room.
  Older sessions collapse to their divider, goal and outcome; the newest and live sessions stay expanded.
  "Viewing one session" is a clearly labelled, temporary mode with "Back to room".
- **The data contract holds.**
  - Timeline content comes only from `/api/thread`; room identity and waiting counts come from `/api/channels`.
  - `/api/state` feeds only members, Connections, the rail session list and the context panel.
  - There are no `/api/agents` calls, no POSTs, and no browser storage of messages.
  - The client cache is page-lifetime and read-only (`thread.js`), so there is no second conversation store.
- **Merging and paging:**
  - `mergeNewest` keeps the server's order, resolves stubs from the cache, and replaces the newest window from its first overlap.
  - `prependOlder` removes duplicates, and a gap is walked for at most 5 pages before a reset.
  - Tests cover moved requests (pending → decided), a 250-message gap and its reset, prepend ordering, the beginning marker and the scroll anchor.
- **Keyed rendering:** unchanged messages keep their DOM node. Disclosure state is remembered per message id, including
  when older history is prepended into a quiet group (tested). Focus is restored inside replaced nodes.
- **Live refresh:** each SSE change produces one coalesced cycle of `/api/state`, `/api/channels` and `/api/thread`
  (with `known=`), and a 401 from any of them returns to sign-in (tested).
- **Attribution and actions:**
  - `actor` is rendered as given, and the decided `coder-2` fixture shows `coder-2`.
  - Only messages with a non-null `action` show "Waiting for you" and exactly one classic link.
  - Only the newest finished session's outcome is actionable (server rule), and a newly finished session retires the older outcome's marker.
  - `fingerprint`, `fields` and `choices` never reach the DOM, and no control names a decision (tested).
- **Privacy:** everything is plain escaped text; Markdown and HTML render literally. The turn's `prompt` is the
  bounded public task from `/api/thread`, not the Hermes request. No reasoning, raw tool output or text in Hermes's
  or an agent's voice appears; the live status line comes only from `live.phase`.
- **Composer:** still disabled, with the honest placeholder. No write path exists.
- **Screenshots reviewed:**
  - `threadTeam-desktop-light`, `threadActive-desktop-dark`, `threadLong-laptop-light`, `threadTeam-laptop-dark-context`, `threadTeam-phone-light`
  - The room reads as calm, one line per quiet item, with "N updates" grouping, "Details" disclosure under
    human-readable summaries, subtle request borders and no cards inside cards. Light and dark both hold up.
  - There is no horizontal overflow at 390 px.

### Findings

**Blocking:** none.

**Should fix before M4** (handed off in `M3_1_CORRECTIONS.md`):

1. **A denied request, or an answered question, looks merely "Confirmed".**
   - `receiptState` maps only `approve` to a word; it looks for `deny`, but the engine records **`reject`**
     (`Controller.review` accepts `approve|reject` for permissions and `answer|reject` for questions).
   - Probe with the shipped `thread.js` and receipts in state `confirmed`: approve → "Approved by you · Confirmed";
     **reject → "Confirmed"**; **answer → "Confirmed"**.
   - On the surface that reports your decisions, a denied `rm -rf` reading as "Confirmed" is misleading.
     The fixtures contain no reject or answer receipts, so the tests could not catch it.
   - Classic's `receiptLabel` already defines the right words.
2. **Stale "Waiting for you" markers, and one unbounded page walk.**
   - Only a newly finished session's effect on *outcome* actions is revalidated.
   - A proposal, research, skill or request that is still marked actionable but lies outside the newest 200-message
     window keeps "! Waiting for you" after it has been decided in classic.
   - The outcome revalidation loop in `core.refresh` also has **no page cap**. Every other walk is capped at 5 or 10 pages.
3. **Inline actionable rows run text together.** In quiet one-line rows (for example a skill item),
   "! Waiting for you" and its link render as **"! Waiting for youOpen in classic dashboard"** (seen in
   `threadTeam-desktop-light` and `threadTeam-phone-light`). Also, the waiting strip reads "N waiting for you ·
   requests" although the count also includes proposals, research and skills; the handoff wording was "! N waiting for you".

**Optional polish** (fold into M4 or later):

4. On a 390 × 844 phone, the disabled composer, its label and a second "Open classic dashboard" link take about a
   third of the viewport. M4 replaces the composer; make it compact there.
5. Focus is lost after "Load earlier", because `#thread-history` is re-rendered. Keep focus on the control, or move it to the first newly loaded message.
6. "Show N messages" on a collapsed divider counts only the loaded messages.
7. The "Viewing one session" view is not refreshed live.

### The known limitations in `CURRENT_STATE.md`

- **The `/api/state` 30-session cap on the rail: acceptable for M3.**
  - The conversation is complete: the timeline pages all history through `/api/thread`.
  - A session older than the rail's 30 is still reachable through "Load earlier", deep links (10-page lookup,
    then the single-session view) and "continues" links. Nothing is lost; only the rail's shortcut list is shorter.
  - Make it honest cheaply: M3.1 shows "Showing 30 of N sessions" using `/api/channels`' `sessions` count.
  - Replace the rail's data source in M6 (members and team), when `/api/state`'s role is revisited.
- **V1 server materialisation of one session at a time: acceptable.** It was measured in the M2.1 review (tens of
  milliseconds with the index). Revisit only if single sessions reach tens of thousands of non-folded events.

**Note for M5 (server, not M3.1).** `/api/thread` can mark a research step (`awaiting_approval`) or a skill
(`proposed` / `awaiting_fetch`) actionable on a *finished* session, while `/api/channels.waiting` counts only the
active session. M5, which adds real decision controls, must decide whether such items are actionable at all. That
needs reconciling server-side, with a contract note, before any control is offered for them.
