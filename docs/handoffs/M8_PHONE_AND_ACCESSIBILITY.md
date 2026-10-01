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
