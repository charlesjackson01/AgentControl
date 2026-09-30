# Handoff M3.1: Room timeline corrections

**From:** Opus (architecture and UX review) → **To:** Codex (implementation)
**Branch:** `feature/chat-first-redesign`. Commit and push only there; **never merge into `main`**.
**Size:** small (a few hours). **Must land before M4.**
**Read first:**
1. the "Architecture and UX review" section at the end of `docs/handoffs/M3_ROOM_TIMELINE.md`
2. `docs/REDESIGN_ARCHITECTURE.md` §3, §9 and §10

Fix exactly the items below. They are frontend-only. **No server, schema, classic-UI or orchestration change.**
Do not refactor M3 beyond what these fixes need.

---

## 1. Receipt labels must say what was decided

**Now:** `receiptState` in `chat/thread.js` maps only `approve` to a word. It checks for `deny`, which the engine never
records. A denied permission (`action: 'reject'`) or an answered question (`action: 'answer'`) in state `confirmed`
renders as just "Confirmed".

**Required:**
- Copy classic's `receiptLabel` semantics from `agent-autonomy/app.js`, with a one-line source comment, as architecture §5.2 requires:
  - `state: 'confirmed'`: `approve` → **"Approved once"**, `reject` → **"Denied"**, `answer` → **"Answered"**
  - any other state:
    - `sent` → "Awaiting confirmation"
    - `dispatching` → "Sending decision"
    - `uncertain` → "Delivery uncertain"
    - `resolved` → "Request resolved"
    - `failed` → "Delivery failed"
    - anything else → the state text as recorded
- Append the actor: " · by you" when `actor` is `You, via dashboard`; otherwise " · by <actor>", verbatim.
- If `receipt.redirect` is present on a denial, add "· redirected" to the collapsed line. The redirect text itself stays under "Details".
- Keep `detail.receipt` fields under "Details" as today.
- **Tests:**
  - Add fixtures with confirmed `approve`, `reject` and `answer` receipts, and one each in `sent`, `uncertain` and `failed`.
  - Assert the exact collapsed labels.
  - Assert that a denied request's collapsed text contains "Denied" and never contains "Approved" or bare "Confirmed".

## 2. No stale "Waiting for you" markers, and no unbounded walks

**Now:**
- Only an *outcome* whose action was retired by a newly finished session is revalidated. A request, proposal,
  research item or skill that is still marked actionable but lies outside the newest 200-message window keeps
  "! Waiting for you" after it is decided in classic.
- The outcome revalidation loop in `core.refresh` has no page limit.

**Required: one bounded revalidation rule, replacing the outcome-only loop.**
- After fetching the newest page, compute `stale` = the cached messages with a non-null `action` that are **not** in
  the newest page. Revalidate them when either:
  - a newly received (non-stub) `outcome` exists in the newest page (today's case), or
  - `channels[0].waiting` is **lower than it was on the previous refresh**: a decision was made somewhere, possibly
    outside the window.
- Use a *decrease* between refreshes, never a comparison against the number of cached markers. Research and skill
  items on finished sessions can legitimately keep an `action` that `waiting` (active session only) does not count,
  so a count comparison would re-walk on every refresh.
- **To revalidate,** walk `before` from the newest page until every `stale` id is covered, **at most 10 pages**,
  and merge the pages as today. If ids are still uncovered after 10 pages, **drop the cached history older than the
  fetched pages** (reset the cache to the fetched contiguous pages, with their `before` cursor) instead of keeping
  markers that can no longer be verified. The user can "Load earlier" again.
- **Never** clear or invent an action on the client. A marker changes only because the server returned the message without one.
- **Tests:**
  1. A skill (or proposal) marked actionable outside the newest window, and `waiting` dropping from 1 to 0 between refreshes: the
     next refresh re-reads until it is covered, and its marker disappears because the server copy has `action: null`.
  2. The same, with the item more than 10 pages back: the cache is trimmed to the fetched pages, and no stale marker remains.
  3. The existing "new terminal outcome revalidates older cached actions" test still passes.
  4. The walk never exceeds 10 `before` requests in one refresh.
  5. With an unchanged `waiting`, and an actionable research item on a finished session outside the window, repeated refreshes make **no** extra `before` requests.

## 3. Inline actionable rows and the waiting strip

**Now:**
- In quiet one-line rows (for example a skill item), the waiting state and its link run together:
  "! Waiting for youOpen in classic dashboard".
- The strip reads "N waiting for you · requests", although the count also covers proposals, research and skills.

**Required:**
- Render the waiting state and the classic link as **one separate line under the summary**, in every message
  layout: "! Waiting for you · Open in classic dashboard", with a visible separator and the link as its own element.
  Quiet rows keep their compact summary line; only the waiting line is added below it.
- The strip text is exactly **"! N waiting for you"**, keeping the existing "Open classic dashboard" link.
- **Rail honesty:** when `channels[0].sessions` is greater than the number of sessions in the rail list, show a
  muted line under the list: "Showing 30 of N sessions · older sessions are in the room history". Use the real
  numbers; no link is needed.
- **Tests:**
  - The waiting line's text content has a separator between "Waiting for you" and the link, in quiet, line, bubble and card layouts.
  - The strip text is exact.
  - The rail note appears only when `sessions` exceeds the list length.
- **Browser matrix:** the existing cases must still pass. Add one assertion that no rendered element's text
  contains "youOpen". Review `threadTeam` at desktop and phone.

## 4. Optional, only if trivial while you are in these lines

- Keep focus on "Load earlier" after it loads, or move focus to the first newly loaded message.
- Label a collapsed divider "Show messages" when not all of the session's messages are loaded, instead of an undercounted number.

## 5. Acceptance

1. `python3 -m unittest discover -s agent-autonomy/tests` passes; it changes no Python. Report skipped tests by name.
   An unchanged timing-sensitive backend test that fails intermittently is rerun and recorded, never modified.
2. `test_ui.cjs` passes 82/82. `test_chat_ui.cjs` passes (all 34 existing tests plus the new ones).
   `chat_screenshots.cjs` passes.
3. The diff touches only `agent-autonomy/chat/thread.js`, `core.js`, `shell.js`, `chat.css` (and `index.html` for the
   `?v=` bump), `tests/fixtures.cjs` (additions only), `tests/test_chat_ui.cjs`, `tests/chat_screenshots.cjs`,
   `CURRENT_STATE.md` and this file.
4. No POST, no new endpoint, and no browser storage of messages.

## 6. When you finish

1. Append a completion report to this file: the changes, test commands and counts (with skipped tests named), and the screenshots reviewed.
2. Set M3.1 to done in `CURRENT_STATE.md`, then push. No PR and no merge unless the owner asks.


## M3.1 completion report — 2026-09-30 (Codex)

Implemented only the frontend corrections in this handoff, starting from a clean `5563b40` after pulling
`feature/chat-first-redesign`. M4 remains unstarted.

- Receipt labels copy classic `receiptLabel` semantics, including confirmed approve/reject/answer and all delivery
  states. Recorded actors remain attributed; dashboard actors read “by you”. Denials with a redirect add
  “· redirected”; the redirect text and receipt fields remain under Details.
- Refresh revalidates every cached actionable kind outside the newest window when channel waiting decreases or
  a non-stub outcome arrives. It reads contiguous server pages with a shared maximum of ten `before` requests
  (including gap recovery). Uncovered history is discarded at the bound, preserving the fetched pages and their
  cursor so Load earlier still works. No action is cleared or invented in the browser.
- All layouts put “! Waiting for you · Open in classic dashboard” on a separate line. The strip says exactly
  “! N waiting for you”, with whitespace before its classic link. A muted rail note uses the actual shown/total
  session counts when the list is capped. Asset versions are bumped to `3.1`.

**Regressions reproduced before the fix:** the expanded DOM suite ran against the unchanged M3 frontend and
returned **31/41**. The final 42-test suite also ran against an isolated copy of the untouched `5563b40`
frontend and returned **31/42**, confirming that the new shared-budget test reproduces the old unbounded walk.
Failures exposed incorrect confirmed and in-flight labels, missing waiting-line separation,
incorrect strip wording, missing rail disclosure, unrevalidated skill markers, and an outcome walk of twelve
pages rather than ten. Final coverage adds eight tests to the original 34, including all four older actionable
kinds, ten-page cache trimming and continued paging, a shared gap/revalidation budget, and no repeated walk for
finished-session research when waiting is unchanged. The existing terminal-outcome regression still passes.

**Required verification:**

| Command | Result |
|---|---|
| `python3 -m unittest discover -s agent-autonomy/tests` | **398 tests, OK (skipped=3)** on full rerun |
| `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_ui.cjs` | **82/82 passed** |
| `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_chat_ui.cjs` | **42/42 passed** (34 existing + 8 new) |
| `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/chat_screenshots.cjs /tmp/chat-shots-m31` | **42 combinations + 4 regressions passed**, 90 screenshots; no “youOpen” and no phone overflow |

Skipped backend tests (environment gates):

- `test_container_e2e.ContainerRunE2E.test_agent_works_in_a_locked_down_container`
- `test_preview.DesktopTests.test_desktop_preview_shows_frames_and_accepts_input`
- `test_vm_e2e.VMRunE2E.test_agent_works_in_a_kvm_clone`

The OpenCode integration tests ran. The initial sandbox run could not bind HTTP/Unix sockets and Chromium
could not launch; both were rerun outside the sandbox. The first outside-sandbox Python run completed 398 tests
with one documented timing failure: `test_agents.ControllerLifecycleTests.test_a_turn_records_join_work_approval_and_finish`
observed `('coder-1', 'idle', 'finished')` instead of `('coder-1', 'working', 'finished')`.
The full rerun passed all tests (398, skipped=3). No protected code or tests were modified.

**Screenshots reviewed:** `threadTeam-desktop-light`, `threadTeam-desktop-dark`, `threadTeam-phone-light` and
`threadTeam-phone-dark` under `/tmp/chat-shots-m31`. Waiting markers and links are visibly separated beneath the
summary/details, and the strip has the required wording in both appearances and sizes.

**Scope and remaining issues:** no deviations from required scope. Only the allowed frontend/test/docs files
changed; `fixtures.cjs` is additions only. The room remains read-only, uses `/api/thread` and `/api/channels`,
and has no new endpoint, write control, POST or message storage. The optional Load earlier focus and collapsed
partial-session count polish remain deferred. The M5 research/skill action-count mismatch remains intentionally
unresolved. No backend, orchestration, classic UI, API, schema or decision semantics changed; no merge or PR.
