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


## Architecture and UX review — 2026-09-30 (Opus)

**Verdict: M3.1 accepted, and with it M3.** Nothing is blocking, and nothing needs fixing before M4. M4 may start
(`docs/handoffs/M4_COMPOSER.md`).

Reviewed: `5563b40..71c08d4` (the single commit `71c08d4`), with the suites re-run, the new tests run against the
pre-M3.1 frontend, and Chromium renders of the receipt and team fixtures at desktop and phone widths.

### Re-run in the review environment (at `71c08d4`)

| Suite | Result |
|---|---|
| Python | **398 tests, OK (skipped=6)**: the same six environment gates; 3 in Codex's environment |
| Classic DOM | **82/82** |
| Chat DOM | **42/42** |
| Browser | **42 combinations + 4 regressions**, 90 screenshots; no "youOpen" and no overflow |

No backend, API, schema, classic or orchestration file changed. The M3.1 diff adds no POST, no new endpoint and no
browser storage. Codex's first full Python run hit
`test_agents…test_a_turn_records_join_work_approval_and_finish`, the pre-existing lifecycle timing test (reproduced
earlier on the pre-redesign backend). M3.1 changes no Python, and it was correctly rerun and recorded, not modified.

### Verified

- **Receipts.** The logic is copied from classic `receiptLabel`, with a source comment, and recognises the engine's real
  `reject` and `answer` actions.
  - In Chromium at 1440 px and 390 px, the collapsed labels read exactly:
    - "Approved once · by you"
    - "Denied · by you · redirected"
    - "Answered · by you"
    - "Awaiting confirmation" / "Sending decision" / "Delivery uncertain" / "Request resolved" / "Delivery failed · by …"
    - an unknown state verbatim ("recorded custom state · by <local rule>", rendered as literal text)
  - A denied item never says "Approved" or bare "Confirmed". The redirect text stays under "Details".
- **Revalidation comes from the server and is bounded.**
  - It is triggered only by a newly received outcome, or by a **decrease** in `channels.waiting` against the previous
    refresh in the same project. It never compares counts, so finished-session research and skill items cannot cause repeated walks (tested).
  - Gap recovery and revalidation share **one 10-page budget**. Unverifiable history is dropped at the limit
    (the cache is trimmed to the fetched pages with their cursor, and "Load earlier" still works).
  - The client never clears or invents an `action`; markers change only because the server copy changed (tested for skill, proposal, request, research and outcome).
- **Waiting presentation.**
  - The waiting state and its classic link are one separated line in quiet, line, bubble and card layouts.
  - The strip reads exactly "! N waiting for you", which covers requests, proposals, research and skills.
  - The rail shows "Showing 30 of N sessions · older sessions are in the room history" only when it is capped.
- **The regression tests reproduce the M3 findings.** Against the pre-M3.1 frontend (`5563b40`), **7 of the 8 new M3.1
  tests fail**. The one that passes is the intended guard: "unchanged waiting never walks".
- **The M5 mismatch is deferred, not worked around.** An actionable research item on a finished session keeps its
  marker, with no client-side reconciliation (the guard test documents this).

### Findings

**Blocking:** none. **Should fix before M4:** none.

**Optional polish** (all folded into the M4 handoff, since M4 rebuilds the footer):
1. On phones the room footer still takes **about 30% of the viewport**. Measured: 257 of 844 px with the waiting
   strip, 181 px without. It is made up of the disabled composer, a visible "Project room" label and a second
   "Open classic dashboard" link.
2. In the phone waiting strip, the 40 px pointer button and its link sit misaligned vertically.
3. Still deferred from M3: keeping focus after "Load earlier", the partial-session divider count, and the single-session view not refreshing live.
