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
