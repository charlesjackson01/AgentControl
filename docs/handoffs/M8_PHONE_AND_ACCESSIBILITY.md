# Handoff M8: Phone and accessibility

**From:** Opus (architecture) → **To:** Codex (implementation)
**Branch:** `feature/chat-first-redesign`. Commit and push only there; **never merge into `main`**.
**Prerequisites:** M7 is **accepted** (the review is at the end of `docs/handoffs/M7_WORKSPACES.md`). Start from
`9b97b51` or later.
**Read first, in this order:**
1. `CURRENT_STATE.md`
2. `docs/REDESIGN_ARCHITECTURE.md` (binding; §3, §5.2, §9, §10, §11 and §12)
3. the M7 review (Q1, Q2), the M6 review (P1–P4) and the M5 review (O2)
4. this file

**Size:** about 4 days.

**Implementation order.** Each part is its own commit and passes the full suites before the next part starts.
1. **Part A:** the scheduled deferrals from earlier milestones.
2. **Part B:** small-screen and layout pass.
3. **Part C:** keyboard and focus.
4. **Part D:** screen readers, contrast and motion.
5. **Part E:** the final rendered matrix and the owner's device checklist.

---

## 1. Outcome

The chat UI is **comfortable and correct on phones, tablets and desktops, and fully usable by keyboard and screen
reader**, with measured contrast in both appearances. All carried-over polish is closed.

M8 is a **presentation and accessibility milestone**:
- it changes no data, no request pattern, no decision semantics and no backend
- every accepted M1–M7 contract (§2) holds

## 2. Hard rules (the M1–M7 contracts to preserve)

1. **No Python, API, schema, engine, journal, adapter or classic change.** If something seems to need one, stop and
   report it.
2. **No new requests, timers or polling,** except the single bounded case in §3.1 (the single-session fallback refresh). M8 must not change what is read,
   when, or how often. In particular:
   - the live `/api/state` follows the active session
   - historical sessions use the one shared selected-session read
   - the Workspace makes zero extra reads
3. **No change to decision semantics:**
   - the `decisions.js` bodies, endpoints, transient-status machine, shared write lock and confirm word are frozen
   - markup and attributes in `decisions.js` may change **only** for O2 (§3.4) and for accessibility fixes found by
     §6's audit, each with its own test
   - the M5.0 invariant (waiting = actionable non-outcomes; cards = waiting + 0/1 outcome) holds
4. **Server truth everywhere.** There are no optimistic states. The proposed and live roster distinction (M6/M7 S1)
   and the Workspace's read-only, POST-free boundary (M7) are unchanged.
5. **Privacy:**
   - step material renders only inside a Workspace
   - reasoning is never rendered
   - `tool_results` and `Hermes request` are never rendered
   - every M5–M7 sentinel test passes unchanged
6. **Tokens only.**
   - Colour changes go in `tokens.css` (light and dark).
   - There are no raw colours in `chat.css`, no fonts, no CDN and no framework (architecture §3.8).
7. **Interactive surfaces stay in the classic pop-out.** Native surface viewing and input still need their own handoff
   before M9.
8. **Earlier assertions.**
   - An earlier test may be rewritten only where M8 deliberately changes something it pins: a measurement, a label
     listed here, or layout geometry.
   - Each rewrite is named in the report, with the reason and the stricter or equal replacement.
   - Never weaken a privacy, decision, invariant or footer-budget assertion.
9. **Out of scope:**
   - native surfaces
   - persistent bots (the roadmap, architecture §12.1)
   - parity and cutover (M9)
   - the skill-fetch race (the D7 boundary)
   - backend test robustness (the owner's call)

## 3. Part A: scheduled deferrals (first commit)

### 3.1 M3 carry-overs

- **Focus after "Load earlier."** After older messages load:
  - focus moves to the first newly revealed message (`tabIndex=-1`)
  - the scroll anchor keeps the previously first visible message in place
  - if nothing new loaded, focus stays on the button
  - the button's `aria-busy` reflects paging
- **Partial-session divider count.** A collapsed divider whose session is only partly loaded must not show an
  undercount (today "Show 0 messages" appears for older sessions; see `railPaged-desktop-dark`).
  - Show **"Show messages"** when the session's loaded messages may be incomplete: its `session_start` is not loaded,
    or the cache has `before` and the session continues beyond the oldest loaded message.
  - Otherwise show the exact count, pluralised ("Show 1 message").
- **Live refresh of the single-session fallback view.** While the M3 fallback (`snapshot.single`) shows a session
  that is **not terminal**:
  - each existing refresh cycle also re-reads that session with `known=` stubs: `/api/thread?session=<id>&limit=200&known=…`
  - it uses the existing `mergeNewest`
  - a terminal session is never re-read
  - no timer is added; this rides the existing refresh

  This is the only request-pattern change in M8. It is bounded to one GET per existing refresh, and only while a
  non-terminal fallback session is on screen.

### 3.2 M6 P1–P4

- **P1:** the outcome's "Verification (on demand) · ‹status›" line appends the recorded relative time from `ended`
  (or `created` while running).
- **P2: approved by the owner, 2026-10-01.** The rail hides the redundant "Showing X of N sessions" disclosure when
  every session is listed.
  - **Hidden** when X = N.
  - **Shown** when history is incomplete (X < N), with the correct counts: X is the number of sessions the rail lists,
    and N is `/api/channels`' `sessions` count.
  - **Scope of the approval: rail presentation only.**
    - Do not change pagination, "Load earlier sessions", `loadOlder()`, the session union, session-count semantics or
      the data source.
  - **The one authorised test rewrite.** Only the assertion in **`M3.1 rail counts use the M6 session union and current
    count wording`** that pins the old always-shown wording may be rewritten. The replacement must assert both:
    - no disclosure when X = N
    - "Showing X of N sessions" with exact counts when X < N, including after paging

    No other rail, paging or count assertion may change.
- **P3:** a member's state time reads "since 2d ago".
- **P4:** in the task graph, task-id buttons and plain ids align.

### 3.3 M7 Q2: a compact sticky Workspace context line

The Workspace's sticky header shows **Back to room** plus one line: "‹agentLabel› · ‹symbol label› · Turn n", from the
same recorded data.

### 3.4 M5 O2 (the only permitted `decisions.js` content change)

When a permission's `detail.review` has neither `command` nor `file`, the key-fact line shows the first
`detail.patterns` entry. That is classic `requestText()`'s next fallback. Never render an empty key-fact paragraph.

### 3.5 Part A tests

Add one regression per item, each failing on `9b97b51`. P2 is approved; its regression covers both the hidden case (X = N) and the shown case (X < N).

## 4. Part B: small-screen and layout pass

### 4.1 Viewports (the matrix's sizes)

| Name | Size |
|---|---|
| desktop | 1440 × 900 |
| desktop-workspace | 1200 × 800, with the Workspace open |
| laptop | 1024 × 768 |
| tablet | 768 × 1024, portrait — **new** |
| phone | 390 × 844 |
| phone-landscape | 844 × 390 — **new** |
| narrow | 320 × 640 |

### 4.2 Requirements

1. **No page-level horizontal scroll** at any size. Code and diff `<pre>` blocks scroll internally.
2. **Touch targets of at least 40 × 40 px** on tablet, phone, landscape and narrow, for **every** interactive element:
   links, buttons, summaries, tabs, rail links, task and turn buttons, dialog controls, and composer chips. The
   matrix enumerates them all, not a curated list.
3. **Footer budgets** (with the Workspace closed):

   | Viewport | Idle footer | With the waiting row | Conversation |
   |---|---|---|---|
   | portrait phone (390 × 844) | **unchanged:** ≤ 72 px | ≤ 120 px | ≥ 65% |
   | landscape phone (844 × 390) | ≤ 72 px | ≤ 112 px | ≥ 45%, measured |

   Record both sets of measurements. In landscape, the room header may collapse to one line.
4. **Q1, the room beside a Workspace.** On desktop with the Workspace open:
   - the room column keeps **≥ 420 px**
   - the Workspace width becomes `min(960px, 100vw − rail − 420px)`
   - the waiting strip stays on one line
   - the composer chip is not truncated at 1200 and 1440 px
5. **Tablet (768–1199 px).**
   - The rail is a drawer and the context panel an overlay, as specified in architecture §10.
   - Dialogs and sheets are centred cards, at most 560 px wide, not full-bleed.
6. **Long content.**
   - Long titles, agent names, branch names, paths and URLs wrap (`overflow-wrap: anywhere`) or truncate with the
     full value in `title`.
   - There is no overlap at 320 px or at 200% text zoom (§4.3).
7. **Safe areas.** The phone footer, sheets and the Workspace header respect `env(safe-area-inset-*)`. This is
   checked with an emulated inset.

### 4.3 Zoom and reflow

At 1280 × 800 with the root font size doubled (a 200% text-zoom equivalent), every view reflows:
- no horizontal page scroll
- no clipped controls
- the composer remains reachable

## 5. Part C: keyboard and focus

1. **A skip link,** "Skip to conversation", is the first focusable element. It is visible on focus, and moves focus to
   `#timeline`.
2. **A logical tab order:** rail, header, timeline, waiting pointer, composer, then any open panel. No positive
   `tabindex` anywhere.
3. **Visible focus** on every focusable element in both appearances, using the existing `--focus`/`--accent`. The focus
   ring is never clipped by `overflow` containers; the matrix checks this.
4. **Context tabs** follow the ARIA tabs pattern: Left/Right/Home/End move between tabs, `tabindex` is roving, and the
   selected tab controls the panel (M1 polish item 10).
5. **Dialogs and sheets** (decision, stop, settings, the phone rail drawer and the context sheet):
   - focus is trapped inside while open
   - the first focus is the safe choice
   - Escape closes
   - focus returns to the opener
   - the background is `inert` (or `aria-hidden` on unsupported engines) while a modal is open

   The behaviour of existing dialogs must not change beyond adding the trap and `inert` where missing.
6. **Workspace:**
   - the turn picker is a toolbar with arrow-key movement
   - the terminal (`tabindex=0`) scrolls with the arrow, Page and Home/End keys
   - "Jump to latest" is reachable
   - Escape closes and returns focus (as accepted)
7. **Keyboard-only paths, each tested:**
   - start a session
   - send a note
   - answer a question
   - approve with the typed confirm
   - deny with redirection
   - open a Workspace and return
   - load earlier history
   - switch context tabs

## 6. Part D: screen readers, contrast and motion

1. **Live regions.**
   - There is one stable `#live` node (M1 polish item 8), never recreated on render.
   - Connection status changes are announced politely, once per change.
   - A change in the waiting count is announced politely, for example "2 waiting for you".
   - Decision card statuses keep their single stable `role="status"`.
   - The terminal stays `aria-live="off"`.
2. **Names and roles.**
   - Every icon-only control has an accessible name.
   - Symbols such as ● ! ✓ ✕ ■ ◌ ▶ are `aria-hidden`, with the label as text.
   - Headings form a sane outline per region (one `h1`).
   - Lists use list semantics.
   - The rail is a `nav`, the room a `main`, and the context panel and Workspace are labelled `complementary` regions.
3. **Pluralisation** is correct everywhere: "1 waiting for you", "1 message", "1 turn", "1 session" (M1 item 9).
4. **Contrast** is computed from the tokens, not eyeballed. A test reads `tokens.css` and asserts the WCAG 2.1 ratios
   in **both** light and dark:
   - ≥ 4.5:1 for `--text`, `--muted`, `--accent`, `--warning`, `--danger` and `--success` on `--bg`, `--surface` and
     `--rail`
   - ≥ 4.5:1 for `--warning` on `--warning-bg`, and for the accent on `--accent-soft`
   - ≥ 3:1 for `--border` used as a control boundary, and for `--focus` against the adjacent background

   Adjust token values only, in `tokens.css`. Record the before and after ratios.
5. **Motion.**
   - Every animation and transition, and `scroll-behavior: smooth`, respects `prefers-reduced-motion` (it partly
     does already).
   - Highlight effects on deep links degrade to a static outline.
6. **Forced colours.** Under `forced-colors: active`, focus and selection remain visible, and status is never conveyed
   by background alone. This is a single emulated-check screenshot.
7. **Sign-in field.** It gets `autocomplete="off"` with `autocapitalize="off"` and `spellcheck="false"` (M1 item 4),
   so password managers do not store the dashboard key. The shared-key semantics are unchanged.

### Automated accessibility audit

- Add a test-only audit to the browser matrix. Implement it in-repo: role/name checks, focusable-without-name
  detection, duplicate-id detection, and heading-order checks. Add **no new npm packages beyond the existing
  test-only set** unless the owner approves.
- Zero findings are allowed in the audited states.

## 7. Part E: the final matrix, and the owner's device checklist

### 7.1 Matrix

Run every existing state across §4.1's seven viewports, in light and dark, with these assertions:
- overflow
- targets
- footer budgets (portrait and landscape)
- focus visibility
- the a11y audit
- contrast
- page errors

Add reduced-motion and forced-colours spot checks. Report combinations, screenshot counts and every measurement.

**Inspect and name in the report**, at minimum:
- phone portrait and landscape for: the room with waiting, a critical decision dialog, the Team panel, a Workspace
  with a live terminal
- tablet: the room with the context overlay
- desktop-workspace at 1200 px
- 200% text zoom
- forced colours

### 7.2 Native phone keyboard (deferred, owner-run)

Native phone OS keyboard testing **remains deferred**: it needs a real device, which this environment does not have.
Codex must **not** claim it.

Instead, add `docs/DEVICE_CHECKLIST.md`: a short, step-by-step checklist for the owner, on iOS Safari and Android
Chrome. It covers:
- the composer staying above the keyboard while typing a multi-line draft
- the Settings sheet with the keyboard open
- the typed-confirm field in a decision sheet
- the Workspace terminal scroll
- rotation with the keyboard open
- VoiceOver/TalkBack reading of a decision card and the waiting pointer

It ends with a results table for the owner to fill in. Running it is an M9 sign-off input, not an M8 acceptance gate.

## 8. Files

| File | Change |
|---|---|
| `agent-autonomy/chat/tokens.css` | contrast-driven token values only (light and dark); safe-area and spacing tokens if needed |
| `agent-autonomy/chat/chat.css` | the layout, target, focus, reflow, motion and forced-colour rules (tokens only) |
| `agent-autonomy/chat/index.html` | skip link, landmarks, stable `#live`, sign-in attributes, cache-busting `?v=8` |
| `agent-autonomy/chat/shell.js`, `thread.js`, `members.js`, `workspace.js`, `composer.js`, `model.js` | the accessibility and markup changes above, and Part A |
| `agent-autonomy/chat/core.js` | only §3.1's single-session fallback refresh |
| `agent-autonomy/chat/decisions.js` | only O2 and accessibility markup found by the audit (§2.3) |
| `agent-autonomy/tests/test_chat_ui.cjs`, `fixtures.cjs`, `chat_screenshots.cjs` | the tests and matrix, including the in-repo a11y audit and contrast test |
| `docs/DEVICE_CHECKLIST.md` | **new**, the owner-run device checklist |
| `docs/REDESIGN_ARCHITECTURE.md`, `CURRENT_STATE.md`, this file | contract notes (§9), status, completion report |

**No change** to any Python file, the classic UI, or any backend file.

## 9. Contract updates (make them when you finish)

- **§9 Design language:** the contrast ratios are now tested, and the token values changed (before and after).
- **§10 Layout:** the tablet and landscape rules, the room's ≥ 420 px beside a Workspace, safe areas, and the landscape
  footer budget.
- **§3 or §10:** the keyboard and screen-reader commitments (skip link, tabs pattern, modal trap and `inert`, one
  stable live region).
- **The change log:** M8 is accepted when reviewed, and native phone-keyboard testing is owner-run via
  `docs/DEVICE_CHECKLIST.md` before M9.

## 10. Acceptance

1. `python3 -m unittest discover -s agent-autonomy/tests` passes, unchanged; report skipped tests by name.
   - Baseline: **423, OK** (6 skipped in the review environment, 3 with OpenCode).
   - An unchanged timing-sensitive test that fails intermittently is rerun and recorded, never modified.
2. `test_ui.cjs` passes 82/82. `test_chat_ui.cjs` passes (215 existing tests plus the new ones, with only §2.8's named
   rewrites). `chat_screenshots.cjs` passes across §4.1, with every budget and audit.
3. Every Part A regression fails on `9b97b51`, and every later part's new tests fail on the previous part's commit;
   record both runs.
4. The diff touches only §8's files.
5. **A real server check** (`app.py` with the existing fakes) records:
   - zero change in the request pattern, apart from §3.1's fallback refresh, by counting GETs and POSTs on the room,
     a decision, the Team panel and a Workspace before and after M8
   - the M5.0 invariant
   - one keyboard-only decision (typed-confirm approve) on a real pending permission

## 11. When you finish

1. Append a completion report to this file:
   - the commits
   - test commands and counts (with skipped tests named)
   - every measurement (footer, contrast before and after, targets)
   - the screenshots inspected
   - the real server check
   - every rewritten assertion
   - deviations
   - the P2 rewrite (the one authorised assertion, before and after)
2. Update `CURRENT_STATE.md`. Push to `feature/chat-first-redesign`. No PR and no merge unless the owner asks.

Deferrals that stay recorded:
- interactive surfaces (classic pop-out; their own handoff before M9)
- native phone-keyboard testing (owner device checklist)
- the in-flight skill-fetch race (the D7 boundary)
- persistent bots (the roadmap, architecture §12.1)

If this handoff conflicts with `docs/REDESIGN_ARCHITECTURE.md`, stop and record the conflict instead of choosing silently.

---

## Implementation report — Part A (2026-10-01)

The standalone commit containing this section completes the nine §3 corrections; Parts B–E remain pending.
Load earlier retains its control during paging, exposes `aria-busy`, focuses the first new message with
`preventScroll`, preserves the old visible anchor and retains button focus after a failed read. Partial dividers
use “Show messages”; complete dividers show the exact pluralised count. A visible non-terminal single-session
fallback adds one known-stub GET to the existing refresh and merges recorded messages with `mergeNewest`.
Existing bounded decision recovery remains intact; no timer or other request pattern changes.

The outcome uses recorded verification times; member times say “since”; task ids reserve the same box whether
linked or plain. The sticky Workspace line uses recorded agent presence and selected turn. O2 adds only the
first-pattern fallback and removes empty key-fact paragraphs. The fully loaded rail hides its disclosure without
changing counts, union, data sources or pagination.

Verification:

- `NODE_PATH=/tmp/ac-tests/node_modules node …/test_chat_ui.cjs`: **224/224**. All **nine new Part A tests fail
  on 9b97b51**; that archived baseline reports **213/224**, with the other two failures being the explicitly
  superseded M3.1 and M6 complete-history assertions. Logs: `/tmp/ac-m8a-before-9b97b51.log`,
  `/tmp/ac-m8a-chat.log`. An initial baseline attempt exhausted memory while formatting a failed DOM-object
  assertion; equivalent boolean absence checks bounded its diagnostics and the completed baseline proves all
  nine failures. This changes no protected expectation.
- `python3 -m unittest discover -s agent-autonomy/tests`: **423, OK (skipped=3)**, **265.611 s**, unchanged suite.
  Skips: `test_container_e2e.ContainerRunE2E.test_agent_works_in_a_locked_down_container`,
  `test_preview.DesktopTests.test_desktop_preview_shows_frames_and_accepts_input`,
  `test_vm_e2e.VMRunE2E.test_agent_works_in_a_kvm_clone`. OpenCode tests ran. Log: `/tmp/ac-m8a-python.log`.
- Classic `test_ui.cjs`: **82/82**; chat `chat_screenshots.cjs /tmp/chat-shots-m8a`: **276 combinations + seven
  regressions**, **441 screenshots**. Existing privacy, delivery, waiting invariants and footer budgets pass.
- Inspected `teamRunning-desktop-light-tasks.png`, `railPaged-desktop-dark.png`,
  `workspaceLive-phone-light-error.png`, `workspaceLive-compact-desktop-dark.png` in `/tmp/chat-shots-m8a`.
  Linked/plain ids align, the complete rail disclosure is absent, and the Workspace sticky line reflects the
  recorded agent/status/turn. The narrow desktop room remains for Part B’s explicitly scheduled layout correction.

Earlier assertion changes, limited to the owner’s authorization:

1. `M3.1 rail counts use the M6 session union and current count wording`: the old X=N always-shown assertion
   becomes disclosure absence. Its incomplete count assertions remain; the new M8 regression checks initial
   **30/40**, paged **35/40** and complete **40/40** with no disclosure, unchanged total and null final cursor.
2. `M6 rail paging grows the shared room cache and reports exact X/N counts`: only its post-paging
   “Showing 35 of 35 sessions” assertion becomes disclosure absence. Initial 30/35, all 35 rows, the shared
   cached session, removal of the paging control and zero POSTs remain asserted.
3. Browser `railPaged`: only “Showing 35 of 35 sessions” becomes absence; scrolling targets the last rail row
   because the removed disclosure cannot be scrolled. Paging and 35-row assertions are preserved. The owner
   explicitly approved these two additional P2 exceptions in the session.

Only §8 client/test/documentation files changed. No Python, classic, backend, decision-state or engine changes.
The D7 in-flight skill-fetch race, interactive surfaces and persistent bots remain out of scope. Native device
keyboard checks remain unverified; Parts B–E and the final real-server/accessibility matrix still need completion.

## Implementation report — Part B (2026-10-01)

Part A is **68c7cab**. The standalone commit containing this section completes Part B; C–E remain pending.
The room keeps 420 px beside a desktop Workspace, whose width matches `min(960px, viewport − rail − 420px)`.
Normal-size waiting controls stay on one line and the chip remains untruncated at 1200/1440. Tablet and
landscape use a rail drawer and centred cards bounded to 560 px. Context navigation stays visible while
scrolling. Small-screen controls, including radio/checkbox inputs, have 40 × 40 px targets.

Existing type-token ratios now follow root text zoom without modifying the type tokens. Full server titles are
escaped in tooltips while display labels retain their existing bounds. There is no page overflow with long titles
or branches. Code/diffs retain internal scrolling. Safe-area padding is applied to footer, sheets and Workspace
navigation; a test-only 20 px substitution verifies the insets without claiming native-device testing. §10's
layout contract is updated according to §9.

Verification:

- Chat DOM: **225/225** (215 accepted + nine A + one B). The new full-title/escaping test fails on Part A,
  **224/225**; log `/tmp/ac-m8b-before-68c7cab.log`. Browser layout regressions fail on Part A with
  “M8 tablet/landscape rail is a drawer”, `/tmp/ac-m8b-before-browser.log`. Actual geometry and actual doubled
  text are asserted by Chromium, rather than assertions about implementation strings.
- Classic DOM: **82/82**, `/tmp/ac-m8b-classic.log`.
- Final full browser run: **672 combinations + seven regressions**, **1,095 screenshots**,
  `/tmp/ac-m8b-browser-complete.log`, `/tmp/chat-shots-m8b-complete`. This is all 46 earlier states plus two
  long-content states, seven viewports and both appearances, plus 96 real text-zoom renders and inset checks.
  Every visible interactive element is enumerated. Targets are ≥ 40 × 40 px where required.
- Portrait footer: **57 px idle / 105 px waiting**, waiting row **40 px**, conversation **≥ 70.0829%**.
  Landscape: **57 / 105 px**, row **40 px**, conversation **≥ 58.3333%**. Both appearances match. Detailed
  per-state measurements are in `footer-measurements.json` in that screenshot directory; the final report will
  include the final matrix measurements.
- Python full suite, unchanged: **423, OK (skipped=3)**, **256.479 s**, `/tmp/ac-m8b-python.log`. The same
  three environment-gated skips named in Part A remain; OpenCode ran. First attempt: 423 in 428.652 s, six
  unchanged timing failures (`/tmp/ac-m8b-python-attempt1.log`). All six passed in isolation in **13.365 s**
  (`/tmp/ac-m8b-python-isolated.log`), then the full suite passed. Failures were
  `test_vm.VMRunTests.test_console_input_is_checked_and_audited` and these `test_workflow.WorkflowTests`:
  `test_permission_approve_once_and_workflow_resumes`, `test_permission_rejection_is_recorded`,
  `test_permission_scope_cannot_be_widened_by_api`, `test_question_answer_can_be_sent_from_dashboard`,
  `test_removed_or_foreign_request_is_rejected`. No protected code, waits, environment gates or skips changed.

Inspected renders: `decisionCritical-phone-landscape-light.png`,
`teamRunning-phone-landscape-dark-tasks.png`, `workspaceLive-phone-landscape-light-error.png`,
`teamRunning-tablet-light.png`, `workspaceLive-desktop-workspace-light.png`,
`workspaceLive-text-zoom-light.png`, `decisionCritical-phone-light.png`. Inspection found the landscape
context header needed to remain visible; its final sticky navigation is checked in the full matrix.

No earlier expectation was rewritten for B. The Part A CSSOM test uses a compatibility translation of
unsupported container-rule syntax before parsing; all its equality/alignment expectations remain, and the
browser still checks actual task geometry. The browser's rail-opening setup now opens the drawer at tablet
widths; its accepted assertions are unchanged. No request, timer, decision, API, classic or backend changes.
Native keyboards, interactive surfaces, the in-flight skill-fetch race and persistent bots remain deferred.

## Implementation report — Part C (2026-10-01)

Part A is **68c7cab**, Part B **fddf9eb**. The standalone commit containing this section completes keyboard and
focus; D–E remain pending. The skip link is the first focusable control and focuses the timeline without changing
the route or issuing a read. Context tabs and the Workspace toolbar use roving arrow/Home/End navigation.
The read-only terminal supports arrow/Page/Home/End scrolling; Jump to latest remains reachable.

A shared presentation helper traps focus in decision/Stop/Settings dialogs and small-screen rail/context/Workspace
sheets, isolates their background with inert and aria-hidden, starts on Cancel/Close/Back, and restores the opener.
Nested panels restore their previous surface; vanished Workspace links fall back to the recorded session divider.
This helper leaves decisions.js and all decision requests, confirmation words and delivery reconciliation unchanged.
All focus outlines use the existing accent and width tokens with an inset offset to avoid clipping.

Verification:

- Chat DOM: **233/233**, eight new C tests. All eight fail on Part B **fddf9eb**, **225/233**,
  `/tmp/ac-m8c-before-fddf9eb.log`; current `/tmp/ac-m8c-chat.log`.
- All eight keyboard-only workflows run using real Tab/arrow/Enter/Space/typing events, at desktop and phone in
  both appearances: **32/32**. They check exact request shapes and preserve server-authoritative waiting and
  delivery. All **32** fail on Part B, `/tmp/ac-m8c-before-browser.log`; the passing focused run is
  `/tmp/ac-m8c-keyboard.log`, `/tmp/chat-shots-m8c-keyboard/keyboard-results.json`.
- Classic DOM: **82/82**, `/tmp/ac-m8c-classic.log`.
- Full browser: **672 combinations + 39 regressions**, **1,127 screenshots**, `/tmp/ac-m8c-browser.log`,
  `/tmp/chat-shots-m8c`. **1,612 audits / 38,906 control checks** report a ring and inset of at least **2 px**, including actual 200%
  text-zoom renders; measurements are in `focus-measurements.json`. Footer and target budgets remain unchanged.
- Python, unchanged: **423, OK (skipped=3)**; the three named Part A skips remain and OpenCode ran.
  **326.767 s**, `/tmp/ac-m8c-python.log`.
- Inspected `keyboard-context-tabs-390-light.png`, `keyboard-history-390-dark.png`,
  `keyboard-workspace-1440-light.png`: visible selected-tab/control focus, preserved scroll anchor and return to
  the Workspace opener.

No earlier assertion changed. The DOM harness now reflects native tabIndex and focusin behaviour. Failed
baseline diagnostics use boolean identity to avoid serialising cyclic DOM objects. The matrix focus audit saves
focus and scroll before establishing keyboard modality, then restores both; an initial audit moved the timeline
before taking its snapshot and failed the unchanged newest-message visibility assertion. The corrected audit
preserves that assertion and measures every focusable control, including doubled-text views.

No new requests, timers, APIs, private material or decision semantics. Native keyboard behaviour, interactive
surfaces, persistent bots and the D7 in-flight skill-fetch race remain excluded.

## Implementation report — Part D (2026-10-01)

Parts A/B/C are **68c7cab / fddf9eb / dbb8713**. The standalone commit containing this section completes
screen-reader semantics, measured contrast and motion/forced-colour handling; Part E remains pending.

The connection and waiting announcements are stable, polite, atomic nodes outside the modal background.
Connection text and waiting-count text change only when their values change; the visible connection copy is
aria-hidden to avoid a duplicate announcement. The existing stable decision status nodes and terminal live-off
behaviour remain intact. Generated decorative symbols are hidden, with recorded labels retained. Session rows
and timeline items have list semantics; the rail links remain links. Members/Team/task sections and message
review evidence have a sequential heading outline with one visible h1. Singular session wording is corrected.
The sign-in field disables autocomplete, capitals and spelling; shared-key/storage behaviour is unchanged.
All chat asset versions now use v8.

Reduced motion also disables smooth scrolling and covers pseudo-elements. Deep-link highlighting is a static
outline. Forced colours use selection outlines and weight alongside text/symbol state labels. Only the light and
dark border tokens needed colour changes: **#dedee4 → #85858f**, **#393a44 → #777984**. The --focus token is
the existing 2 px ring width; its actual colour is --accent. Every measured pair appears below.

| Foreground / background | Required | Light before → after | Dark before → after |
|---|---:|---:|---:|
| text / bg | 4.5:1 | 16.068 → 16.068 | 14.589 → 14.589 |
| text / surface | 4.5:1 | 15.394 → 15.394 | 13.260 → 13.260 |
| text / rail | 4.5:1 | 14.757 → 14.757 | 15.349 → 15.349 |
| muted / bg | 4.5:1 | 5.887 → 5.887 | 8.091 → 8.091 |
| muted / surface | 4.5:1 | 5.640 → 5.640 | 7.354 → 7.354 |
| muted / rail | 4.5:1 | 5.406 → 5.406 | 8.513 → 8.513 |
| accent / bg | 4.5:1 | 6.015 → 6.015 | 8.129 → 8.129 |
| accent / surface | 4.5:1 | 5.763 → 5.763 | 7.389 → 7.389 |
| accent / rail | 4.5:1 | 5.524 → 5.524 | 8.553 → 8.553 |
| warning / bg | 4.5:1 | 7.306 → 7.306 | 11.681 → 11.681 |
| warning / surface | 4.5:1 | 6.999 → 6.999 | 10.616 → 10.616 |
| warning / rail | 4.5:1 | 6.709 → 6.709 | 12.289 → 12.289 |
| danger / bg | 4.5:1 | 6.832 → 6.832 | 8.324 → 8.324 |
| danger / surface | 4.5:1 | 6.546 → 6.546 | 7.566 → 7.566 |
| danger / rail | 4.5:1 | 6.275 → 6.275 | 8.758 → 8.758 |
| success / bg | 4.5:1 | 5.822 → 5.822 | 9.985 → 9.985 |
| success / surface | 4.5:1 | 5.578 → 5.578 | 9.075 → 9.075 |
| success / rail | 4.5:1 | 5.347 → 5.347 | 10.505 → 10.505 |
| border / bg | 3:1 | 1.340 → 3.653 | 1.510 → 3.934 |
| border / surface | 3:1 | 1.284 → 3.500 | 1.372 → 3.575 |
| border / rail | 3:1 | 1.230 → 3.355 | 1.589 → 4.139 |
| focus / bg | 3:1 | 6.015 → 6.015 | 8.129 → 8.129 |
| focus / surface | 3:1 | 5.763 → 5.763 | 7.389 → 7.389 |
| focus / rail | 3:1 | 5.524 → 5.524 | 8.553 → 8.553 |
| warning / warning-bg | 4.5:1 | 6.784 → 6.784 | 8.978 → 8.978 |
| accent / accent-soft | 4.5:1 | 5.335 → 5.335 | 6.029 → 6.029 |

Verification:

- Chat DOM: **238/238**, five new D tests. All five fail on Part C **dbb8713**, **233/238**,
  `/tmp/ac-m8d-before-dbb8713.log`; current `/tmp/ac-m8d-chat.log`.
- The four reduced-motion/forced-colours browser checks all fail on Part C: smooth scrolling remains enabled
  and selected tabs lack a forced-colour outline/weight. `/tmp/ac-m8d-before-browser.log` and
  `/tmp/chat-shots-m8d-before/accessibility-spots.json`. Current focused run: all four plus 32 keyboard workflows
  and seven earlier regressions pass, `/tmp/ac-m8d-keyboard.log`.
- Classic DOM: **82/82**, `/tmp/ac-m8d-classic.log`.
- Full browser: **672 combinations + 43 regressions**, **1,131 screenshots**, `/tmp/ac-m8d-browser.log`,
  `/tmp/chat-shots-m8d`; all 52 contrast pairs pass, including control boundaries ≥ **3.355:1**.
  **1616 accessibility audits, zero findings**; **1616 focus audits / 39062 control checks**,
  ring/inset ≥ **2 px**.
- Python full suite: **423, OK (skipped=3)**, **260.464 s**, `/tmp/ac-m8d-python.log`; the same three Part A skips remain,
  and OpenCode ran. No test or backend change.
- A full phone run passes **96 combinations + 43 regressions**, **229 screenshots**,
  `/tmp/ac-m8d-phone.log`. The original waiting text/link baseline assertion remains unchanged: decorative
  symbol spans use display:contents so hiding them from assistive technology adds no line box.
- The audit is implemented in-repo with existing test dependencies: duplicate ids, role/name checks,
  unnamed focusables, positive tabindex, heading order and live-region attributes. Zero findings are allowed.

Inspected `forced-colors-light.png` in `/tmp/chat-shots-m8d-keyboard`: selected rail rows and the selected Team
tab remain outlined, the waiting state retains its symbol and words, and the keyboard focus ring is visible.
No earlier assertion, request, timer, decision state, API, backend or classic implementation changed. decisions.js
was not changed in this part. Native device testing, interactive surfaces, bots and the in-flight skill-fetch race
remain deferred.

## Completion report — Part E / M8 (2026-10-01)

The implementation is complete and awaiting review. Standalone commits, in the required order:
**A 68c7cab**, **B fddf9eb**, **C dbb8713**, **D 316ba80**, then the final Part E commit containing this report.
Each A–D commit passed the full Python, classic, chat and browser suites before the next part began.
No M9, backend, API, schema, engine, journal, adapter or classic work is included.

Final verification exposed two missing presentation cases, corrected within the existing M8 requirements:

- An empty final older page removed the focused Load earlier button. It now retains that same control, exposes
  aria-busy=false/aria-disabled=true, preserves the ids/cursor supplied by AgentControl and cannot issue another
  read. Once focus leaves, the next render shows the existing beginning marker. The new DOM regression fails
  on Part D **316ba80** (**238/239**) and passes now; all four native-focus cases at desktop/phone in both
  appearances fail on Part D and pass now. `/tmp/ac-m8e-before-316ba80.log`,
  `/tmp/ac-m8e-before-browser.log`, `empty-history-results.json`.
- Actual screenshot inspection found that scrolling a tall task graph could scroll the outer grid's hidden
  overflow and pull the phone sheet away from the bottom. The outer grid uses non-scrolling clipping; its
  existing rail/timeline/context/Workspace scrollers continue to scroll internally. Four new geometry checks at
  **390 × 844 and 320 × 844**, in both appearances, fail on Part D and pass now.
  `/tmp/ac-m8e-panels-before.log`, `/tmp/ac-m8e-panels.log`, `phone-panel-results.json`.

These are Part A/B follow-ups discovered during the specified final verification, rather than additional scope.
No earlier assertion changed for C, D or E. The only three earlier assertion rewrites remain the explicitly
approved P2 checks listed verbatim in the Part A report: named M3.1 complete-history assertion, M6 post-paging
35/35 assertion, and browser railPaged 35/35 assertion. Exact incomplete counts and all other paging assertions
remain. No privacy, footer, server-authority, decision or invariant assertion was weakened.

Real app.py verification uses the existing FakeAPI/FakeManager/FakeTeamAPI/FakeTeamManager in disposable test
repositories; before-M8 assets are from **87ce82f**, with the same server implementation and fixtures for both.
Actual server counters are compared to the browser counters for each probe. Logs/results:
`/tmp/ac-m8-real-check.log`, `/tmp/ac-m8-real-results.json`, `/tmp/ac-m8-workspace-check.log`,
`/tmp/ac-m8-workspace-results.json`.

| Probe | Before M8 | M8 |
|---|---|---|
| Normal room refresh (permission/team) | 3 GET: state/channels/thread | same 3 GET |
| Open Team/Members tab | 0 additional GET, 0 POST | same |
| Open active Workspace | 0 additional GET, 0 POST | same |
| Keyboard-only critical approval | 1 exact POST /api/review, then 3 GET | same |
| Non-terminal fallback (2,400 recorded history notes) | 3 GET | 4 GET: the extra session thread read uses limit=200 and known stubs |
| Terminal fallback refresh | 3 GET | same 3 GET |
| Reopen historical Team/Workspace | accepted M6/M7 shared read | 1 shared selected-session GET total |

The critical permission has a real R3 fingerprint and pending review. Real Tab/Enter/typing starts on Cancel,
sends the displayed confirm word with precisely the action fields, and shows Approved once only after a real
GET returns the confirmed receipt and count zero. The fully paged invariant holds before approval
(**waiting/actions/cards = 1/1/1**), after approval (**0/0/0**), for the proposed team (**1/1/1**) and for the
finished actionable outcome (**waiting/actions = 0/0, outcome/cards = 1/1**). The proposed roster remains
separate; actual members exactly equal the server roster, with proposed coder-2 absent from it.
The fallback fixture writes only existing public test-journal events; it changes no production API or data source.

The retained real Workspace check verifies growth to three recorded transcript entries, escaped output and
excluded reasoning, an exact recorded diff and passed verifier output, one shared historical GET, zero Workspace
POSTs, the actionable outcome/card invariant and HTTP 200 for the existing classic pop-out. Test drivers live
under /tmp; they introduce no endpoint or product code.

`docs/DEVICE_CHECKLIST.md` supplies the owner-run iOS Safari/Android Chrome steps and blank results table.
Physical keyboard, rotation and VoiceOver/TalkBack results are **unverified**, not inferred from emulation.
Interactive surfaces, the in-flight skill-fetch race and persistent bots remain out of scope. There are no other
known M8 limitations; review and the owner device checks remain outstanding before the relevant M9 sign-off.

Final measured matrix (all 48 states × seven viewports × light/dark): **672 combinations**, **51 regression cases**,
**1,139 screenshots**, including 96 actual doubled-text renders and emulated 20 px safe-area checks.
`/tmp/ac-m8e-browser.log`, `/tmp/chat-shots-m8e`. All 52 contrast pairs pass with the unchanged Part D values
reported above. Page errors, accessibility findings and budget failures are zero.

**1624 accessibility audits**, zero findings; **1624 focus audits / 39818 control checks**,
minimum ring and inset **2 px**. Every interactive target is enumerated; the following minima include both
appearances and every matrix state, not selected controls. Full individual records are in
`target-measurements.json`, `focus-measurements.json`, `accessibility-measurements.json`,
`contrast-measurements.json` and `footer-measurements.json` alongside the screenshots.

| Viewport | Target measurements | Minimum width × height (px) | Required |
|---|---:|---:|---|
| desktop | 7776 | 37.875 × 13.000 | keyboard focus/reflow |
| desktop-workspace | 7762 | 37.875 × 13.000 | keyboard focus/reflow |
| laptop | 5685 | 40.000 × 40.000 | 40 × 40 |
| tablet | 5692 | 40.000 × 40.000 | 40 × 40 |
| phone | 5637 | 40.000 × 40.000 | 40 × 40 |
| phone-landscape | 5709 | 40.000 × 40.000 | 40 × 40 |
| narrow | 5633 | 40.000 × 40.000 | 40 × 40 |

Footer and conversation measurements below are identical in light and dark. Portrait viewport is 844 px tall;
landscape 390 px. Footer limits remain 72 idle / 120 waiting in portrait, 72 / 112 in landscape; the waiting row
is 40 px and conversation minima exceed 65% / 45%. Workspaces are measured after returning to the room,
as those limits apply with the Workspace closed. Desktop room width is ≥420 px; normal-text waiting strips
remain one line and composer chips retain their full text at 1200/1440. Actual doubled text reflows, with the
composer reachable and no clipped control; code/diff scrolling stays internal.

| State | Portrait footer | Waiting row | Conversation px / % | Landscape footer | Waiting row | Conversation px / % |
|---|---:|---:|---:|---:|---:|---:|
| empty | 57 | 0 | 683.500 / 80.983% | 57 | 0 | 275.500 / 70.641% |
| active | 105 | 40 | 635.500 / 75.296% | 105 | 40 | 227.500 / 58.333% |
| completed | 57 | 0 | 683.500 / 80.983% | 57 | 0 | 275.500 / 70.641% |
| team | 105 | 40 | 635.500 / 75.296% | 105 | 40 | 227.500 / 58.333% |
| threadActive | 105 | 40 | 635.500 / 75.296% | 105 | 40 | 227.500 / 58.333% |
| threadTeam | 105 | 40 | 635.500 / 75.296% | 105 | 40 | 227.500 / 58.333% |
| threadLong | 57 | 0 | 683.500 / 80.983% | 57 | 0 | 275.500 / 70.641% |
| composerIdle | 57 | 0 | 683.500 / 80.983% | 57 | 0 | 275.500 / 70.641% |
| composerNote | 105 | 40 | 635.500 / 75.296% | 105 | 40 | 227.500 / 58.333% |
| composerPaused | 105 | 40 | 635.500 / 75.296% | 105 | 40 | 227.500 / 58.333% |
| composerFollow | 57 | 0 | 683.500 / 80.983% | 57 | 0 | 275.500 / 70.641% |
| composerBasic | 57 | 0 | 683.500 / 80.983% | 57 | 0 | 275.500 / 70.641% |
| composerAdvanced | 57 | 0 | 683.500 / 80.983% | 57 | 0 | 275.500 / 70.641% |
| composerStop | 105 | 40 | 635.500 / 75.296% | 105 | 40 | 227.500 / 58.333% |
| composerLiteral | 105 | 40 | 635.500 / 75.296% | 105 | 40 | 227.500 / 58.333% |
| composerTarget | 105 | 40 | 635.500 / 75.296% | 105 | 40 | 227.500 / 58.333% |
| composerCleanSettings | 57 | 0 | 683.500 / 80.983% | 57 | 0 | 275.500 / 70.641% |
| composerRestored | 57 | 0 | 683.500 / 80.983% | 57 | 0 | 275.500 / 70.641% |
| longRoom | 105 | 40 | 635.500 / 75.296% | 105 | 40 | 227.500 / 58.333% |
| decisionCritical | 105 | 40 | 635.500 / 75.296% | 105 | 40 | 227.500 / 58.333% |
| decisionQuestion | 105 | 40 | 635.500 / 75.296% | 105 | 40 | 227.500 / 58.333% |
| decisionTeam | 105 | 40 | 635.500 / 75.296% | 105 | 40 | 227.500 / 58.333% |
| decisionResearch | 105 | 40 | 635.500 / 75.296% | 105 | 40 | 227.500 / 58.333% |
| decisionInstall | 105 | 40 | 635.500 / 75.296% | 105 | 40 | 227.500 / 58.333% |
| decisionApply | 57 | 0 | 683.500 / 80.983% | 57 | 0 | 275.500 / 70.641% |
| decisionSent | 105 | 40 | 635.500 / 75.296% | 105 | 40 | 227.500 / 58.333% |
| decision409 | 105 | 40 | 635.500 / 75.296% | 105 | 40 | 227.500 / 58.333% |
| teamProposing | 57 | 0 | 639.500 / 75.770% | 57 | 0 | 275.500 / 70.641% |
| teamProposed | 105 | 40 | 591.500 / 70.083% | 105 | 40 | 227.500 / 58.333% |
| teamUnusable | 105 | 40 | 591.500 / 70.083% | 105 | 40 | 227.500 / 58.333% |
| teamRunning | 105 | 40 | 591.500 / 70.083% | 105 | 40 | 227.500 / 58.333% |
| teamReview | 105 | 40 | 591.500 / 70.083% | 105 | 40 | 227.500 / 58.333% |
| teamFinished | 57 | 0 | 639.500 / 75.770% | 57 | 0 | 275.500 / 70.641% |
| singleMembers | 105 | 40 | 591.500 / 70.083% | 105 | 40 | 227.500 / 58.333% |
| connections | 105 | 40 | 591.500 / 70.083% | 105 | 40 | 227.500 / 58.333% |
| railPaged | 105 | 40 | 591.500 / 70.083% | 105 | 40 | 227.500 / 58.333% |
| teamStopping | 57 | 0 | 639.500 / 75.770% | 57 | 0 | 275.500 / 70.641% |
| teamExpired | 57 | 0 | 639.500 / 75.770% | 57 | 0 | 275.500 / 70.641% |
| workspaceLive | 105 | 40 | 635.500 / 75.296% | 105 | 40 | 227.500 / 58.333% |
| workspaceHistorical | 57 | 0 | 683.500 / 80.983% | 57 | 0 | 275.500 / 70.641% |
| workspaceUnknown | 105 | 40 | 635.500 / 75.296% | 105 | 40 | 227.500 / 58.333% |
| workspaceReviewer | 105 | 40 | 635.500 / 75.296% | 105 | 40 | 227.500 / 58.333% |
| workspaceNoOutput | 105 | 40 | 635.500 / 75.296% | 105 | 40 | 227.500 / 58.333% |
| workspaceNoTurns | 105 | 40 | 635.500 / 75.296% | 105 | 40 | 227.500 / 58.333% |
| workspaceResearcher | 105 | 40 | 635.500 / 75.296% | 105 | 40 | 227.500 / 58.333% |
| workspaceHermes | 105 | 40 | 635.500 / 75.296% | 105 | 40 | 227.500 / 58.333% |
| workspaceSurfaces | 105 | 40 | 635.500 / 75.296% | 105 | 40 | 227.500 / 58.333% |
| workspaceLong | 57 | 0 | 683.500 / 80.983% | 57 | 0 | 275.500 / 70.641% |

Actual final renders inspected in `/tmp/chat-shots-m8e`:

- Waiting room: `threadActive-phone-light.png`, `threadActive-phone-landscape-dark.png`.
- Critical dialog: `decisionCritical-phone-light.png`, `decisionCritical-phone-landscape-dark.png`; Cancel has
  visible focus and the typed-confirm field/buttons fit while the evidence remains available in the room.
- Team: `teamRunning-phone-light-tasks.png`, `teamRunning-phone-landscape-dark-tasks.png`, plus the corrected
  anchoring render `phone-panel-390-light.png` (also inspected in `/tmp/chat-shots-m8e-panels`).
- Live Workspace terminal: `workspaceLive-phone-light-error.png`,
  `workspaceLive-phone-landscape-dark-error.png`; output/diff scroll internally and navigation remains visible.
- Tablet: `teamRunning-tablet-light.png`, with the centred context card.
- Desktop Workspace: `workspaceLive-desktop-workspace-light.png` at 1200 px.
- Doubled text: `workspaceLive-text-zoom-dark.png`; wrapped waiting controls and full composer target.
- Forced colours: `forced-colors-light.png`; visible selection/focus and explicit status labels.

Final chat DOM: **239/239** (215 accepted + nine A + one B + eight C + five D + one E),
`/tmp/ac-m8e-chat.log`. Classic: **82/82**, `/tmp/ac-m8e-classic.log`. Every new behaviour regression has its
recorded pre-part failure above; the eight extra E browser checks fail on Part D. All retained real-server checks
pass. The only sequence adjustment was correcting the two existing A/B requirements found by final verification.

Final Python: `python3 -m unittest discover -s agent-autonomy/tests`, **423, OK (skipped=3)**, **337.007 s**,
`/tmp/ac-m8e-python.log`. OpenCode tests ran. Environment skips remain exactly:

- `test_container_e2e.ContainerRunE2E.test_agent_works_in_a_locked_down_container`
- `test_preview.DesktopTests.test_desktop_preview_shows_frames_and_accepts_input`
- `test_vm_e2e.VMRunE2E.test_agent_works_in_a_kvm_clone`

The first final attempt ran 423 in **269.620 s**, with the single previously documented lifecycle timing failure
`test_agents.ControllerLifecycleTests.test_a_turn_records_join_work_approval_and_finish` (idle→finished sampled
instead of the brief working→finished). Preserved log: `/tmp/ac-m8e-python-attempt1.log`. The unchanged isolated
test passed in **2.544 s**, `/tmp/ac-m8e-python-isolated.log`, then the full unchanged suite passed. No runtime,
wait, test assertion, skip gate or backend code changed. All five parts' full verification and failed-baseline
records are retained above.

Final scope inspection uses git status, diff stat, names and whitespace checks (also staged checks); only §8 files
are included. The final push targets `HEAD:refs/heads/feature/chat-first-redesign` only. No PR or main merge.
