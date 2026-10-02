# Handoff M9.1: Device corrections (G3 round 1)

**From:** Opus (architecture) → **To:** Codex (implementation)
**Branch:** `feature/chat-first-redesign`. Commit and push only there; **never merge into `main`**.
**Prerequisites:** M9 Part 0 and Part A are accepted, and G1 is cleared. **G3 failed round 1** on the owner's physical
devices (2026-10-02). Start from `62cf3cc` or later.
**Read first:**
1. `CURRENT_STATE.md`
2. `docs/REDESIGN_ARCHITECTURE.md` (§3, §10 and §12.1)
3. `docs/handoffs/M8_PHONE_AND_ACCESSIBILITY.md` (§4, §5 and §7.2)
4. `docs/DEVICE_CHECKLIST.md`
5. this file

**Size:** about 2 days.

**Order:**
1. **Part A, the composer and the viewport (priority)**, its own commit.
2. **Part B, discoverability**, its own commit.
3. **Part C, device-test tooling and the checklist**, its own commit.

Then stop. **M9 Part B (the cutover) stays unauthorised. G3 stays pending** until the owner re-runs the device
checklist after these fixes.

## 0. What the owner observed, and Opus's classification

| Observation | Classification | Basis |
|---|---|---|
| **Composer:** the message field does not remain visible | **1. Implementation defect** (two root causes, confirmed by code inspection), plus a test gap | See §0.1 |
| **Approvals:** no approvals section found in chat; only in classic | **3. A missing test prerequisite**, plus **2. present but undiscoverable on mobile** | By design (M5, architecture §10), chat has no Approvals section: a waiting request appears once in the room as a card, plus a "! N waiting for you" strip. With nothing pending, **nothing at all** in chat says where approvals appear: the strip is absent when the count is 0, the empty room says nothing about approvals, and More has no such entry. The checklist's prerequisite ("a pending critical permission") is hard for the owner to create on a real project |
| **Workspaces:** no entry point found; only in classic | **2. Present but undiscoverable on mobile**, plus **3. a missing prerequisite** | The M7 entry points exist but are buried. The turn message's "Open workspace" sits inside a **collapsed Details** disclosure, and the Members panel links are behind **Session details → Members/Team**. The rail's member list has **no** links. A room with no recorded agent turns has no entry at all |
| **Rotation:** worked | **Performed, and passed.** | Re-run it after Part A, because rotation with the keyboard open involves the composer |
| **Screen reader and light/dark** | **4. Not yet performed** | Not passes. Still required for G3 |

### 0.1 Composer: the root causes

1. **iOS focus zoom.**
   - Every text-entry control inherits `font-size: calc(var(--type-body) / var(--s4) * 1rem)` = **15 px**
     (`chat.css:2`, `:6`, `:136`, with `--type-body: 15px` in `tokens.css`).
   - iOS Safari zooms the page when an input under 16 px gets focus. With `body { overflow: hidden }` and the
     viewport-sized `#app`, the zoomed composer can end up off-screen.
   - This affects the composer, the typed-confirm field, the redirect and repropose textareas, the custom answer,
     the Settings inputs and the sign-in key field.
2. **The visual viewport offset is ignored.**
   - `composer.js:272` sets `--viewport-height` from `visualViewport.height`, but nothing uses `visualViewport.offsetTop`.
   - `#app` (`chat.css:20`) stays at the top of the **layout** viewport. On iOS, and on Android Chrome's default
     `resizes-visual` behaviour, the keyboard pans the visual viewport, so the bottom of `#app`, where the composer
     is, is no longer the bottom of what the user sees.
   - The phone decision sheet is `position: fixed; inset: auto 0 0` (`chat.css:215`), anchored to the layout
     viewport's bottom, which is **under the keyboard**.
   - The sheets and the composer's growth limit use `75dvh` and `40dvh`, which do not shrink for the keyboard.
3. **The test gap.** M4 and M8's "keyboard" check (`chat_screenshots.cjs`, `composerKeyboard`) resizes the **whole**
   Chromium page to 480 px. That never produces a visual-viewport offset or a focus zoom, so emulation passed while
   the devices fail.

## 1. Hard rules

- **Client-only.** No Python product, API, schema, engine or classic change. `decisions.js` semantics stay frozen;
  markup is allowed only where §3 needs it.
- **No weakening.**
  - Every M1–M8 assertion and budget holds: footer ≤ 72/120 px portrait and ≤ 72/112 px landscape, conversation
    ≥ 65%/45%, 40 px targets, the contrast pairs, the a11y audit and the privacy sentinels.
  - **Do not** add `maximum-scale` or `user-scalable=no` to the viewport tag. Page zoom must stay available (WCAG
    1.4.4).
- **No new decision surface** (architecture §10). Part B adds links and status text only, never decision controls or
  POSTs.
- **Honest status.** Chromium checks cannot verify iOS or Android. G3 is cleared only by the owner on devices.
- **Earlier assertions** may change only where this handoff moves something they pin: the turn link's location, and
  geometry or measurements affected by the 16 px font. Name each one in the report.

## 2. Part A: the composer and the viewport (first commit)

1. **16 px text entry.** Every text-entry control computes `font-size ≥ 16px` at every viewport:
   - `input` other than checkbox and radio
   - `textarea`
   - `select`
   - the composer, the typed confirm, the redirect, repropose and custom-answer fields, the Settings fields, and the
     sign-in key

   Introduce a token (for example `--type-input: 16px`); there are no raw values in `chat.css`. Re-measure the footer:
   it must stay within the budgets above, and the report records the new values.
2. **Pin the app to the visual viewport.**
   - Extend the existing `visualViewport` handler to set `--viewport-top` from `visualViewport.offsetTop` alongside
     `--viewport-height`, on both `resize` and `scroll`.
   - `#app` becomes `position: fixed; left: 0; right: 0; top: var(--viewport-top, 0); height: var(--viewport-height)`.
   - **Apply the offset only while `visualViewport.scale` is about 1.** While the user is pinch-zoomed, leave
     `--viewport-top: 0` and do not fight the zoom.
   - Without `visualViewport` support, behave exactly as today.
3. **Sheets follow the visual viewport.**
   - **What follows:** the phone decision sheet, the Stop dialog, the Settings sheet and the context sheet.
   - **The bottom edge** equals the visual viewport's bottom.
   - **The maximum height** is `calc(var(--viewport-height) * 0.75)`, not `75dvh`.
   - The confirm field and its buttons stay inside the visual viewport.
   - Tablet's centred cards stay centred **within** the visual viewport.
4. **Composer growth.** The maximum height uses `var(--viewport-height)` (40%), not `40dvh`. The existing `resize()`
   already uses `visualViewport.height`; make the CSS match.
5. **Keep the conversation anchored.** If the timeline was following the newest message when the viewport shrinks
   (keyboard opening), it still shows the newest message afterwards. If the user had scrolled up, their position is
   preserved.
6. **Viewport tag.** Add `interactive-widget=resizes-content`. Android Chrome 108+ then resizes the layout viewport for
   the keyboard; other browsers ignore it, and item 2 covers them.

### Part A tests (each must fail on `62cf3cc`)

- **Browser (Chromium), with a fake visual viewport.** Using `page.addInitScript`, replace `window.visualViewport` with
  a controllable `EventTarget` (`width`, `height`, `offsetTop`, `offsetLeft`, `scale`), and dispatch `resize`/`scroll`.
  At 390 × 844 and 844 × 390, in light and dark:
  - **Keyboard open:** height 844 → 480, with `offsetTop` 0, then 260. The composer, Send and target chip lie within
    `[offsetTop, offsetTop + height]`. `#room-footer`'s bottom equals the visual viewport's bottom (± 1 px). The newest
    message stays visible while following.
  - **Decision sheet with the typed confirm focused,** under the same viewport: the sheet's bottom equals the visual
    viewport's bottom, and the confirm input, Cancel and Approve are all inside it. The same holds for the Settings
    sheet with a field focused.
  - **Pinch-zoom (`scale: 2`, `offsetTop: 300`):** `#app` top stays 0. No compensation is applied.
  - **Close the keyboard** (back to 844, offset 0): the layout returns to the M8 footer measurements.
- **CSS audit.** At every M8 viewport, every visible text-entry control computes ≥ 16 px.
- **The viewport meta** contains `interactive-widget=resizes-content`, and contains no `maximum-scale` or
  `user-scalable`.
- **DOM.** The handler sets both variables, gates on scale, and does nothing without `visualViewport`.
- **The full M8 matrix still passes,** with every budget.

## 3. Part B: discoverability on mobile (second commit)

1. **"Waiting for you" is always findable.** Without changing the footer budgets or adding a decision surface:
   - **The rail** gets a "Waiting" line under Channels:
     - **When the count is above 0:** a link reading "! N waiting for you". It runs the existing
       `core.locateWaiting()` and closes the drawer on phones, so the user sees where approvals live.
     - **When the count is 0:** muted text reading "Nothing is waiting for you".
     - **The count** is `channels.waiting`, exactly the same as the strip.
   - **The empty room and the quiet room hint** add one sentence: "Approvals and questions from agents appear here as
     cards, with a "waiting for you" bar above the message box."
   - **No Approvals page is added.** Classic keeps rule revocation and audit history; those are G1 Linked rows.
2. **Workspace entry points are visible on mobile:**
   - **Turn messages** show **"Open workspace"** in the visible summary line, not only inside the collapsed Details.
     Keep exactly one link per turn.
   - **Rail members:** in the active session, each recorded live member's row links to its Workspace ("Open log" for
     Hermes), with the same hrefs as the Members panel. **Proposed-only agents get no link**, as M6 and M7 require.
   - **The room header's ⋯ session menu** gains a "Workspaces" group listing the active session's live members as
     links.
   - All three are plain links with no POST, under the M7 rules.

### Part B tests (each must fail on the Part A commit)

**DOM:**
- The rail waiting line shows the right count and wording for 0, 1 and 2 waiting items, always equal to
  `channels.waiting`.
- The link calls `locateWaiting` and closes the drawer.
- No `[data-decision]` and no POST is added anywhere.
- The turn summary has a visible workspace link with the exact href, outside any closed `details`.
- Rail and menu member links use the exact hrefs. Proposed-only and stopping/expired never-approved agents get no
  link.

**Browser:**
- Phone and landscape: every new link is ≥ 40 × 40 px.
- The footer budgets are unchanged.
- No overflow.
- The new lines pass the a11y audit and contrast checks.
- Inspect and name the phone renders of the rail waiting line and the turn summary link.

## 4. Part C: device-test tooling and the checklist (third commit)

1. **`agent-autonomy/tests/device_fixture.py`**, test tooling only. The name has no `test_` prefix, so discovery does
   not collect it.
   - **What it runs:** the real `app.py` handler and `Controller` with the existing test fakes (`test_workflow`,
     `test_team`) in a **temporary** state directory and a disposable git project. It never touches the owner's real
     projects or state.
   - **What it prepares,** through the real fakes and endpoints:
     - one active session with a **pending critical permission**
     - a **waiting question**
     - a coder whose transcript **grows** every few seconds
     - a finished turn with a diff and a verification
   - **Flags:** `--host` (default `127.0.0.1`; the owner must pass a LAN or tailnet address **explicitly**) and
     `--port`.
   - **Output:** it prints the URL and a **freshly generated** test key, and nothing else secret.
   - **Python test.** Add one small Python smoke test (a new file, `tests/test_device_fixture.py`). It starts the
     fixture in-process on `127.0.0.1` and asserts:
     - `/chat` returns 200
     - the thread has one actionable critical permission and one question
     - `channels.waiting == 2`
     - shutdown cleans its temporary directory

     Every existing Python test is unchanged.
2. **`docs/DEVICE_CHECKLIST.md` update:**
   - **A "Before you start" section:** how to run the fixture (an exact command, `--host` explained, and that the key
     is a throwaway test key), or how to create the same prerequisites in a real project.
   - **A "Where things are in the chat UI" section:**
     - approvals: a room card, the "N waiting for you" bar and the rail line
     - Workspaces: a turn's "Open workspace", the rail members, and ⋯ → Workspaces
     - classic: `/classic`
   - **Explicit steps** for switching light and dark on iOS and Android, and for turning VoiceOver and TalkBack on
     and off.
   - **Results.** Every cell is **Pass**, **Fail** (with notes) or **Not performed**. A blank or "not performed" cell
     never counts as a pass.
   - **Round 1 recorded, as reported by the owner:**
     - Composer: **Fail**
     - Approvals: **Not found**, prerequisite missing
     - Workspaces: **Not found**
     - Rotation: **Pass**
     - Screen reader: **Not performed**
     - Light/dark: **Not performed**
     - Devices and versions as the owner supplies them; leave a placeholder if they are not given

## 5. Files

| Part | Files |
|---|---|
| A | `chat/tokens.css` (the input-size token), `chat/chat.css`, `chat/composer.js` (the viewport handler), `chat/index.html` (the viewport meta, cache-busting `?v=9`), `tests/chat_screenshots.cjs`, `tests/test_chat_ui.cjs`, `tests/fixtures.cjs` |
| B | `chat/shell.js`, `chat/thread.js`, `chat/members.js`, `chat/chat.css`, `tests/test_chat_ui.cjs`, `tests/chat_screenshots.cjs`, `tests/fixtures.cjs` |
| C | `tests/device_fixture.py` (**new**), `tests/test_device_fixture.py` (**new**), `docs/DEVICE_CHECKLIST.md` |
| all | this file (reports), `CURRENT_STATE.md` |

**No change** to `app.py` or any other Python product file, the classic UI, `decisions.js` semantics, or the M9 Part
B routing.

## 6. Acceptance

1. **Each part's new tests fail on the previous commit and pass after it;** record both runs.
2. **The suites pass:** Python 423 plus Part C's smoke test, with nothing else changed; classic 82/82; chat 240 plus
   the new ones, with only the named rewrites; the full browser matrix with every budget, audit and contrast check.
3. **The report records:**
   - the new footer measurements at 16 px
   - the fake-visual-viewport results for each scenario
   - the renders inspected
   - a real-server run of the fixture: the waiting count, a Workspace reachable from the rail, and both
     prerequisites present
4. **Stop after Part C.**
   - The owner re-runs `docs/DEVICE_CHECKLIST.md` on a real iPhone (Safari) and a real Android phone (Chrome), in
     light and dark, with a screen reader.
   - G3 is cleared **only** by the owner recording it.
   - M9 Part B stays unauthorised until then.

If this handoff conflicts with `docs/REDESIGN_ARCHITECTURE.md`, stop and record the conflict instead of choosing silently.

---

## Part A completion report — 2026-10-02

Part A is complete before Parts B/C begin. Synced the clean feature branch to `3012231`; the product frontend
is byte-identical to `62cf3cc` (`git diff 62cf3cc 3012231 -- agent-autonomy/chat` empty).

### Changes

- Added `--type-input: 16px`, expressed relative to root text size. All visible inputs except checkbox/radio,
  textareas and selects compute at least 16 px, including sign-in, custom answers, Settings and decision fields.
  Root text zoom remains supported; no maximum-scale/user-scalable restriction. Assets use `?v=9` and the
  viewport meta includes `interactive-widget=resizes-content`.
- Existing visualViewport resize/scroll handler sets height and top, with offset applied only within 0.01 of
  scale 1. Pinch scale 2/offset 300 leaves app top 0. No handler/variable writes without visualViewport.
- Fixed app frame follows that viewport. Sheet maximum height is 75% and composer growth 40% of its height.
  Portrait sheets use its bottom; landscape keeps the existing horizontally centred, ≤560 px cards at that
  bottom. Tablet portrait cards centre in both axes inside it. Stop and context are covered as well.
- Focused sheet text fields remain reachable; the Settings header and decision buttons stay available when
  scrolling. The timeline follows newest across shrinkage only when already following; scrolled-up position stays.
- The first full matrix caught the literal-note font wrapping at 129 px (`/tmp/ac-m91-a-browser.log`). Reduced
  portrait composer horizontal padding using existing spacing tokens; the same note now fits, with no smaller
  font or relaxed footer budget.

### Regression proof and verification

New tests were written before product fixes. Preserved frontend plus final new tests are under
`/tmp/ac-m91-before-a/` (no reset/restore). DOM baseline: **241/244**, only the new missing top, timeline follow
anchor and viewport-meta defect tests fail; the separate fallback-preservation check passes. Log:
`/tmp/ac-m91-a-before-dom-final.log`. Browser baseline: all **6** portrait/landscape/tablet × light/dark cases
fail for 15 px entry, ignored offset, sheet bounds/focus or newest position;
`/tmp/ac-m91-a-before-browser-final.log`, `/tmp/chat-shots-m91-a-before-final/device-viewport-results.json`.
Before-fix out-of-view Close controls also prevent normal cleanup in four cases, as recorded in that artifact.

After-fix DOM **244/244**, classic **82/82**: `/tmp/ac-m91-a-dom-final.log`, `/tmp/ac-m91-a-classic.log`.
Full browser **672 combinations + 57 regressions**, **1,151 screenshots**:
`/tmp/ac-m91-a-browser-final.log`, `/tmp/chat-shots-m91-a-final/`. All six fake-viewport cases pass 14 checks each:
keyboard height 480 (portrait/tablet) or 240 (landscape), offsets 0/260, focused confirmation/Settings, Stop/context,
scale 2, close/restore, scrolled-up history and growth. Portrait footer bottoms are exactly 480/740;
landscape 240/500. These are geometry checks with the layout viewport unchanged, not native keyboard claims.

Footer remains **57 px idle / 105 px waiting**, portrait conversation ≥ **70.0829%**, landscape ≥ **58.3333%**.
The matrix audits every visible text entry at each M8 size and appearance, including 200% root text zoom;
minimum font is 16 px. All existing footer, target, contrast, accessibility, focus and privacy checks pass.
Full Python verification is reserved for the final Part C gate (no Python file changed in Part A).

Actual inspected renders: `composerLiteral-phone-light.png`, `device-critical-phone-light.png`,
`device-critical-landscape-light.png`, `device-critical-tablet-dark.png`, `device-settings-phone-dark.png`
under `/tmp/chat-shots-m91-a-final/` or its focused predecessor `/tmp/chat-shots-m91-a-focus2/`.
The confirmation field and safe buttons remain in view; the short card may scroll its title, retaining the
complete review in the room and scrollable confirmation content.

**Earlier assertion rewrites: none.** No permission/decision semantics, API, Python product, classic, schema,
engine, data, routes or `decisions.js` change. Checked status/stat/names/whitespace before the separate commit.
G3 remains pending; M9 Part B, native surfaces, R1 and the in-flight skill-fetch race remain excluded.

## Part B completion report — 2026-10-02

Part A `fdbc64a` was committed before Part B. This second commit adds only discoverability under §3.

- Rail Waiting always exists. At 0 it says “Nothing is waiting for you”; at 1/2 it uses exactly the channel
  count, the same count as the strip. The link invokes existing `locateWaiting`, closes the phone drawer
  and reveals the authoritative room card. Empty and quiet rooms contain the specified explanatory sentence.
- Each turn has exactly one visible summary “Open workspace” link outside closed Details. Recorded active
  roster members have rail links, and the session menu has a Workspaces group using the Members panel's same
  encoded href helper. Hermes uses “Open log”. Proposals do not create recorded member links; never-approved
  stopping/finished proposals remain separate. No Workspace data is exposed by these links.
- Returning from a rail Workspace restores that visible rail link; menu returns restore its replacement by id.
  A browser regression exposed duplicate hashchange handling clearing the restored drawer; an already handled
  hash is now ignored. This is navigation/focus only, with no API or decision semantics changed.
- All new entries are links/status text, never `[data-decision]` or POST actions. The menu scrolls inside its
  bounded height; the footer remains unchanged.

Regression proof on the Part A product: `/tmp/ac-m91-b-before-dom.log` **244/251** (all seven new tests fail),
`/tmp/ac-m91-b-before-browser.log` / `/tmp/chat-shots-m91-b-before/device-discovery-results.json`
(all four portrait/landscape × light/dark cases fail for absent waiting links).
After: `/tmp/ac-m91-b-dom-final.log` **251/251**, `/tmp/ac-m91-b-classic.log` **82/82**;
`/tmp/ac-m91-b-browser-final2.log`, `/tmp/chat-shots-m91-b-final2/`: four cases, **12** actual renders.
New links meet ≥40 × 40 px, existing layout/a11y/focus audits pass, no overflow, zero POSTs,
footer **105 px** unchanged in both orientations. Full matrix/contrast/zoom and Python rerun at Part C's final gate.

Inspected the actual phone rail, phone turn-summary and landscape menu renders:
`device-waiting-rail-phone-light.png`, `device-turn-summary-phone-dark.png`,
`device-menu-workspaces-phone-landscape-light.png` (focused predecessor and final directory above).

### Sole earlier assertion rewrite (explicitly authorised by §1)

Test **“M3 kinds, progressive detail, roles, receipts and unknown kinds”** originally asserted:

```js
assert(details.textContent.includes('Open workspace'));
assert.equal(details.querySelector('a').getAttribute('href'),'#/w/run_test/coder-1');
```

Replacement asserts the link's absence inside Details, then the same wording and exact href in the visible summary:

```js
assert(!details.querySelector('[data-workspace-link]'));
const workspaceLink=h.timeline.querySelector('[data-message="turn:1"] .message > [data-workspace-link]');
assert.equal(workspaceLink.textContent,'Open workspace');
assert.equal(workspaceLink.getAttribute('href'),'#/w/run_test/coder-1');
```

All other earlier assertions remain unchanged, including the complete decision-card/waiting-count tests,
server-authoritative delivery, D7, privacy sentinels, paging, geometry budgets and user zoom. No geometry
assertion was rewritten. Checked status/stat/names/whitespace before this separate commit. Part C next;
M9 route cutover and merging into main remain unauthorised.

Part B final-matrix correction before publishing: the unchanged “joined waiting link” browser assertion found
`Waiting for youOpen workspace` in a new rail row. Added a separation assertion to the new roster regression
(`250/251` on the initial Part B product, `/tmp/ac-m91-b-separator-before.log`), then a literal separator
before the link. No older assertion changed. This correction is included in the local Part B commit before push.

## Part C completion report and final M9.1 verification — 2026-10-02

The required sequence is complete: **Part A `fdbc64a`**, **Part B `9d33510`**, then this separate Part C commit.
Part B's unpublished local commit includes the separator correction above; `9d33510` is its final hash.
Stopped for Opus review. **G1 cleared, G2 (a) approved, G3 pending. M9 Part B remains unauthorised.**

### Isolated fixture and physical checklist

- Added only test tooling: `agent-autonomy/tests/device_fixture.py` and the one small smoke test in
  `test_device_fixture.py`. The fixture runs the real handler and Controller, existing FakeTeamAPI/FakeTeamManager,
  normal `/api/runs` submission and engine polling. It does not seed projected messages or modify product code.
- Each invocation generates a fresh key and temporary state plus disposable git project. Turn 1 creates
  `device-example.txt`, captures its diff and passes a real verifier subprocess. Turn 2 remains live with one
  simulated R3 permission and one question; fake output grows every three seconds and is recorded normally.
  The simulated destructive command is never executed. Output is bounded; the run holds for up to two hours.
- Default `--host 127.0.0.1`; explicit LAN/tailnet IPv4 bind is needed for phones. Supports `--port`, prints only
  the URL, throwaway key and cleanup instruction. No real project/state path is accepted. Ctrl+C stops threads,
  closes the server and removes temporary data. The owner must restart to restore decided/stopped prerequisites.
- The checklist explains exact fixture setup, the real-project alternative, all three Workspace entry points,
  room cards/Waiting, `/classic`, official platform appearance and reader instructions, and eight exact physical
  steps. Settings is tested last after stopping the disposable session, since its gear is hidden during a run.
- Round 1 preserves Composer Fail, approvals/workspaces “Not found” as Fail with notes, Rotation Pass, and
  screen-reader/light-dark Not performed. No per-device attribution/version is invented. Every round-2 result
  is explicitly **Not performed**, with owner placeholders for versions, dates and notes. G3 is not cleared.

### Regression proof, commands and final results

The new smoke test first failed on the Part B implementation because the fixture module did not exist:
`/tmp/ac-m91-c-before-python.log`, `ModuleNotFoundError: No module named 'device_fixture'` (one test, one error).
After implementation:

```sh
python3 -m unittest discover -s agent-autonomy/tests -p test_device_fixture.py -v
```

**1 passed, 0.559 s**, `/tmp/ac-m91-c-smoke-final.log`. It checks `/chat` HTTP 200, one actionable critical
permission, one question, waiting count 2, complete thread and cleanup of the temporary directory.
Initial fixture-only failures were corrected before verification (an overwritten fake-request closure);
no backend, existing fake or protected test was changed.

Final suites, run from the repository root:

| Command | Result / evidence |
|---|---|
| `python3 -m unittest discover -s agent-autonomy/tests` | **424 tests, OK (skipped=3), 260.630 s**; `/tmp/ac-m91-final-python.log` |
| `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_ui.cjs` | **82/82**; `/tmp/ac-m91-final-classic.log` |
| `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_chat_ui.cjs` | **251/251**; `/tmp/ac-m91-final-chat.log` |
| `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/chat_screenshots.cjs /tmp/chat-shots-m91-final2` | **672 combinations + 61 regressions**, **1,163 screenshots**; `/tmp/ac-m91-final2-browser.log` |
| `NODE_PATH=/tmp/ac-tests/node_modules node /tmp/ac-m91-fixture-real-check.cjs` | Real fixture/browser **passed**, including shutdown cleanup; `/tmp/ac-m91-fixture-real-final.log`, `/tmp/ac-m91-fixture-real-results.json` |

Python ran alone after Chromium/real-server verification ended. **No timing failures and no retry** in this final
run. All 423 earlier Python tests are unchanged. Two nonfatal unclosed-socket ResourceWarnings surface at
`journal.py:333` and remain recorded in the log; no unrelated backend or protected-test changes.
The same three environment-gated skips are:

- `test_container_e2e.ContainerRunE2E.test_agent_works_in_a_locked_down_container`
- `test_preview.DesktopTests.test_desktop_preview_shows_frames_and_accepts_input`
- `test_vm_e2e.VMRunE2E.test_agent_works_in_a_kvm_clone`

The OpenCode end-to-end tests ran. No runtime configuration or skip conditions were changed.

Full browser results include all six fake-viewport cases (14 checks each), four discovery cases, **1,672**
accessibility/input-font audits with minimum **16 px**, all **52** contrast pairs, **32** keyboard cases and
**four** reduced-motion/forced-colors cases. Existing privacy, server-authoritative delivery, waiting/actionable
invariants, text zoom and all target/budget assertions pass. At 16 px, across 96 measured rows per orientation:
footer **57 px idle / 105 px waiting**, conversation minimum **70.0829% portrait / 58.3333% landscape**.
Phone keyboard offsets 0/260 pin footer bottoms exactly 480/740; landscape 240/500. Fields and safe controls
stay inside those viewports; tablet cards remain centred. Scale 2/offset 300 keeps top compensation at 0.
No maximum-scale/user-scalable restriction; these synthetic results do not claim native keyboard or pinch checks.

The first final matrix found the unchanged member-text assertion described above. It was fixed in Part B,
then this complete matrix passed; no earlier assertion was weakened. The **sole earlier rewrite** remains the
M3 turn-link location test, with original/replacement reproduced in the Part B report. No geometry test rewrite.

### Real server and actual renders

The standalone fixture was started with default loopback and an ephemeral port; Chromium connected using its
fresh test key, without mocked HTTP responses. Fully paged thread (`before: null`) has **waiting 2 = 2 actionable
non-outcome messages**, comprising exactly one R3 permission and one question. The rail member link opens its
Workspace with **zero extra GETs**. After normal refresh, recorded terminal output grows. Turn 1 contains the
captured `device-example.txt` diff and **Verification passed**. **Zero browser POSTs and zero page errors**;
shutdown removed the disposable project/state. Browser requests total **24 GETs** (including assets).

Inspected actual final `active-desktop-light.png` and
`device-menu-workspaces-phone-landscape-light.png` under `/tmp/chat-shots-m91-final2/`, plus the Part A/B
phone/tablet renders named above. Also inspected real-fixture phone renders:
`/tmp/ac-m91-fixture-rail-phone.png`, `/tmp/ac-m91-fixture-live-phone.png`,
`/tmp/ac-m91-fixture-completed-phone.png`. Waiting and recorded Workspace links are visible; live versus
completed turns retain their distinct stages. No proposed agent is turned into a recorded member.

### Scope and remaining limitations

Checked `git status`, `git diff --stat`, `git diff --name-only` and `git diff --check` before each commit.
Part C changes exactly its two new Python test/tool files, DEVICE_CHECKLIST, CURRENT_STATE and this report.
Parts A/B stay within §5. Real projects/state, Python product, APIs, schema, engine, classic UI/routes,
decision semantics, privacy and D7 are unchanged. No new POST surface or interactive-surface mechanism.
Main is untouched; all three commits are pushed only to `feature/chat-first-redesign`.

Physical iOS Safari/Android Chrome keyboard, zoom, touch and VoiceOver/TalkBack results remain **Not performed**.
After Opus review, the owner runs the checklist on both real devices in Light and Dark, records versions and
each result, and alone decides G3. Container/desktop/KVM end-to-end coverage remains environment-gated.
Native surfaces, M9 cutover, R1 persistent bots and the in-flight skill-fetch race remain out of scope.
**Stop here for Opus review; no M9 Part B or merge into main.**

## Review — 2026-10-02 (Opus)

**Verdict: M9.1 is not yet accepted.**
- Parts A and B meet their handoff in substance, and Part C's fixture exercises the intended UI paths.
- **Three small corrections (M9.1a, below) are required first:** one blocking fixture-isolation gap, and two
  should-fix defects.
- **G3 stays pending.** M9 Part B (the cutover) is not authorised. No physical-device check is claimed.

Reviewed: `3012231..d738e33` (Part A `fdbc64a`, Part B `9d33510`, Part C `d738e33`).

### Re-run in the review environment

| Suite | Result |
|---|---|
| Python, full | **424, OK (skipped=6)**, 125 s, first attempt. Codex had 3 skips. The six skips are environment gates and are labelled as such: the container end-to-end test (`AGENTCONTROL_CONTAINER_TESTS`), the desktop preview test (preview tools not installed), the KVM VM end-to-end test (`AGENTCONTROL_VM_TESTS`), and three real-OpenCode tests (`OPENCODE_BIN`). None is a pass |
| Classic DOM | **82/82** |
| Chat DOM | **251/251** |
| Browser matrix (unmodified) | **Failed:** `deviceDiscoveryCases` aborted the run (F3) |
| Browser, device discovery only, 3 runs | **2, 4 and 2 of 4 cases failed**, intermittently. Every failure is the same focus assertion after returning from a ⋯ → Workspaces link |
| Browser matrix, rest (scratch copy, discovery made non-fatal) | **672 combinations + 57 regressions, 1,151 screenshots, pass.** That includes every Part A simulated-keyboard case: footer bottom = `offsetTop + height` at offsets 0 and 260 |

**Scope.**
- No `app.py` or other Python product file changed, and neither did `decisions.js`, `core.js` or the classic files.
- The only Python files added are `tests/device_fixture.py` and `tests/test_device_fixture.py`.
- The one earlier assertion rewritten is the M3 turn-link location, which §1 authorises.

**Regression proofs are recorded:**
- Part A: 241/244 DOM, and all 6 browser cases fail on `3012231`
- Part B: 244/251, and 4/4 browser cases fail on Part A
- Part C: the smoke test fails with the module absent

### Verified

- **Part A.**
  - A `--type-input: 16px` token with a global text-entry rule. `interactive-widget=resizes-content`, with no zoom
    lock.
  - `#app` is fixed at `--viewport-top` / `--viewport-height`, and the offset applies only at scale ≈ 1.
  - The phone sheets' bottom edges equal the visible area's bottom edge, and the sheet height is 75% of it.
  - The composer's maximum height is 40% of the visible area. The newest message stays anchored while following;
    otherwise the reading position is kept.
  - The footer stays at **57 px idle / 105 px waiting** with 16 px text, in portrait and landscape, with no control
    hidden.
- **Part B.**
  - The rail's "! N waiting for you" equals `channels.waiting`, runs the existing `locateWaiting`, and closes the
    drawer. At zero it reads "Nothing is waiting for you".
  - The empty and quiet room guidance is in place.
  - **Each turn** has one visible "Open workspace" outside Details. Rail members and ⋯ → Workspaces link only to
    recorded live members (`state.agents`). Proposed agents cannot appear.
  - **No `[data-decision]` and no POST** were added. Decision semantics are untouched, and no actionable request is
    manufactured (the count comes from the server).
  - Renders inspected: `device-waiting-rail-phone-light`, `device-turn-summary-phone-dark`,
    `device-menu-workspaces-phone-light`.
- **Part C.**
  - A temporary state directory and disposable repository, a fresh `secrets.token_urlsafe(32)` key, and a loopback
    default.
  - The real handler and Controller with the existing fakes. The simulated `rm -rf` is never executed.
  - My probe of the live fixture: waiting = 2, and the temporary directory is removed after `close()`.
  - The checklist is reproducible, with exact commands, locations, appearance and screen-reader steps. It separates
    the Chromium simulation from native checks, and marks round 2 **Not performed**.

### Findings

**Blocking**

- **F1: the fixture is not isolated from the owner's projects.**
  - **The defect.** `device_fixture.py` builds `Settings` without `projects_root`, so it defaults to `Path.home()`.
    Probe: `/api/state` reported `projects_root: /root`, outside the fixture's temporary root.
  - **The consequence.** Through classic's Switch project, which the checklist itself points to, a tester can browse,
    select or create folders in the owner's home directory. After the fixture run finishes, a new fixture run would
    let the fake coder write `device-example.txt` into a **real** project.
  - **The handoff required** "never touches the owner's real projects or state". The checklist currently claims "No
    real-project changes are performed by the device-test tool", which is untrue.

**Should fix**

- **F2: pinch-zoom still resizes the app.**
  - **The defect.** The handler always writes `visualViewport.height` to `--viewport-height`. On real devices, a
    2× pinch-zoom roughly halves `visualViewport.height` in CSS pixels, so `#app` shrinks and reflows during zoom.
    That fights the zoom, against §2.2 and WCAG 1.4.4.
  - **Why the test missed it.** The test sets `scale: 2` but leaves `height` unchanged, so it cannot catch this. The
    behaviour dates from M4, but M9.1 is where zoom handling was specified.
- **F3: focus return after a ⋯ → Workspaces link is intermittent.**
  - **The defect.** M9.1's own browser regression fails 2–4 of 4 times per run. After Back, focus reaches
    `#menu-workspace-hermes` and is then lost. This is a real defect against the M7/M8 rule that focus returns to the
    opener, not just a test problem.
  - **Likely causes (unconfirmed):**
    - the header is rebuilt with `innerHTML`, and `syncModal()` runs at the end of `render()`
    - `route()` re-opens the context sheet (`contextOpen = true`) when returning to `#/s/<id>`, which on phones is a
      modal that takes focus

**Optional**

- **O1.** Clean up on SIGTERM as well as Ctrl+C. Today, a killed fixture leaves its temporary directory behind.
- **O2.** Print a one-line warning when `--host` is not loopback, for example "reachable by other devices on this
  network".

## M9.1a corrections (Codex; one commit; then a focused Opus re-review)

1. **F1, fixture isolation.**
   - Pass `projects_root=self.root` (the fixture's temporary root) to `Settings`.
   - **Extend `test_device_fixture.py`:**
     - `/api/state.projects_root` is inside the temporary root
     - `POST /api/projects/select` and `/api/projects/create` with a path outside it are refused, and nothing is
       created outside
     - after `close()`, the temporary root no longer exists
   - Keep the checklist's isolation sentence, which is now true. Add: "Project switching inside the fixture is confined
     to its temporary folder."
2. **F2, zoom.**
   - While `|scale − 1| ≥ 0.01`, do **not** update `--viewport-height` or `--viewport-top`; keep the last unzoomed
     values. When the scale returns to ≈ 1, resume normally.
   - **Make the browser and DOM tests realistic:** set `height = baseHeight / scale` together with `scale: 2`, and
     assert that `#app` height and top are unchanged while zoomed and restored after the zoom ends.
   - The keyboard cases are unchanged.
3. **F3, focus return.**
   - Find the actual race and fix it in product code, so that after Back from a Workspace opened from ⋯ →
     Workspaces, focus is on that menu entry. If the menu is closed, focus goes to the ⋯ summary, and the M7 fallback
     rule (the session block) applies only if neither exists.
   - Returning must not open the context sheet unless it was open before the Workspace.
   - **Do not weaken the assertion.**
   - **Evidence:** run `--device-discovery-only` **10 consecutive times with 0 failures**, then the full unmodified
     matrix. Record the root cause in the report.
4. **Optional:** O1 and O2.

**Files:** `tests/device_fixture.py`, `tests/test_device_fixture.py`, `chat/composer.js`, `chat/shell.js` (and
`chat/thread.js` only if F3 needs it), `tests/chat_screenshots.cjs`, `tests/test_chat_ui.cjs`,
`docs/DEVICE_CHECKLIST.md`, this file, and `CURRENT_STATE.md`.

**Acceptance:**
- Each new test fails on `d738e33` and passes after the change.
- Python is 424 plus the new assertions, classic is 82/82, chat is 251 plus the new tests, and the **unmodified** full
  browser matrix passes.
- Device discovery is green 10 times in a row.
- No other assertion changes.
- Stop afterwards; G3 stays with the owner.

## What the owner must provide for G3 (after M9.1a is accepted)

Run `docs/DEVICE_CHECKLIST.md` round 2 with the M9.1 fixture, on a **real iPhone with Safari** and a **real Android
phone with Chrome**, each in **Light and Dark**. For each device:
1. **Record** the device model, OS, browser and screen-reader versions, and the date.
2. **Composer:** the multi-line draft stays visible above the keyboard, and Settings stays reachable with the keyboard
   open.
3. **Approvals:** found through the "2 waiting for you" bar **and** ☰ → "2 waiting for you". The typed-confirm field and
   Cancel/Approve stay above the keyboard.
4. **Workspaces:** opened from a turn's "Open workspace", from ☰ → Members, and from ⋯ → Workspaces. The live output
   grows. Back returns to the opener.
5. **Pinch-zoom:** zooming does not shrink or reflow the app, and un-zooming restores it.
6. **Rotation with the keyboard open:** passed in round 1; re-run it.
7. **VoiceOver / TalkBack:** room headings, the waiting bar, a decision card, the sheet's safe first focus, and return
   after Cancel. The terminal does not flood announcements.
8. **Results:** each cell is **Pass**, **Fail** (with notes) or **Not performed**. Then record "G3 cleared", or the
   failures you accept.

Until then, every native keyboard, zoom, orientation and screen-reader item stays **Not performed**.
