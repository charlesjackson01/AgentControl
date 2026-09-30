# Handoff M3: Room timeline (conversation and message UI)

**From:** Opus (architecture) → **To:** Codex (implementation)
**Branch:** `feature/chat-first-redesign`. Commit and push only there; **never merge into `main`**.
**Prerequisite:** **M2.1 must be accepted first** (`docs/handoffs/M2_1_CORRECTIONS.md`). M2.1 does not change the API
shape, but M3 relies on its attribution and page-independent outcome fixes.
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
| `outcome` | a session footer: the status symbol and label, `text` (the summary, clamped to 3 lines), and the workspace state ("open", "applied" or "discarded"; "apply blocked: …" when present) | full summary |

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

**Fixtures.** Build thread responses in `fixtures.cjs` that match real M2 output. Use the M2 sample in
`M2_THREAD_READ_MODEL.md`, or copy output from `tests/test_thread_api.py` journals. Provide:
- `threadSingle()`: goal, decision, two turns (one failed verification, one uncertain), a decided request, and an outcome with a workspace
- `threadActive()`: an active session with a pending request (with `action`), a note aimed at `coder-2`, a redirect note, and `live.phase: 'code'`
- `threadTeam()`: a proposal with `action`, a planning decision with counts, progress lines, research with request and events, and a skill with `action`
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
