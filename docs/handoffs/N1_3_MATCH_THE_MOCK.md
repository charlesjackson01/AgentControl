# N1.3: Match the mock (visual fidelity and bundled fonts)

**Status: READY FOR IMPLEMENTATION.** The owner approved this on 2026-10-03, including bundled fonts (**D20** in
`docs/REDESIGN_ARCHITECTURE.md`). The implementer works on `feature/chat-first-redesign`, then Opus reviews. Do not merge into
`main`. Do not start N2.

## 0. Why

N1 and N1.2 fixed the structure; the look is still the old dashboard recoloured.
- **Fonts:** the mock's Inter and IBM Plex Mono are only *named*, so devices fall back (San Francisco on iPhone, DejaVu Sans on
  Linux).
- **Components:**
  - thread entries read like log lines
  - buttons are default white blocks
  - choices and boxes are browser defaults

This milestone makes the chat **look like `docs/inputs/agentcontrol-ui.html`**. Behaviour, approvals and the backend stay as
they are.

**Inputs:**
- the mock (`docs/inputs/agentcontrol-ui.html`): its CSS (lines 8–47) is the visual source of truth
- `docs/inputs/agentcontrol-ui-handoff1.md` §Shell (visual system)
- D8–D20
- `docs/PERSISTENT_AGENTS_ACCEPTANCE.md` §A

## 1. Bundled fonts (D20)

1. **Add local WOFF2 files for Inter and IBM Plex Mono.**
   - Inter: variable, or weights 400, 500, 600 and 700. IBM Plex Mono: 400 and 500.
   - Latin and Latin Extended subsets only.
   - Store them **flat** in `agent-autonomy/chat/`, named like `inter-latin-var.woff2` and `ibm-plex-mono-latin-400.woff2`
     (the allow-list pattern requires flat, lower-case names).
   - Obtain them from the official upstream releases (`rsms/inter`, `IBM/plex`) or the Fontsource npm packages, which ship the
     same OFL files.
2. **Record provenance** in `agent-autonomy/chat/FONTS.md`: source URL, version, licence (SIL OFL 1.1) and the SHA-256 of
   each file.
   - Put each licence text, unmodified, in `agent-autonomy/third_party/fonts/` (`OFL-Inter.txt`, `OFL-IBM-Plex.txt`). It is
     not served.
   - Total font payload at most **400 KB**; report the actual size.
3. **The server change, exactly** (the only Python change in N1.3; authorised by D20):
   - In `app.py` `do_GET`, the chat asset pattern `r'[a-z0-9][a-z0-9-]*\.(css|js)'` becomes
     `r'[a-z0-9][a-z0-9-]*\.(css|js|woff2)'`.
   - The MIME type for `.woff2` is `font/woff2`.
   - Nothing else changes: same flat-directory check, same `reply()` and headers (including `no-store` and `nosniff`), same
     404 for anything else.
4. **Route tests** in `tests/test_chat_routes.py` (authorised additions only; existing assertions unchanged):
   - every bundled `.woff2` is served with `font/woff2` and the same security headers
   - an unknown `.woff2` gives 404
   - `.ttf`, `.woff`, `.txt`, `.md` and nested paths give 404
   - `FONTS.md` and the licence files are not served
5. **CSS:** add `@font-face` rules in `tokens.css` with `url('/chat/<file>.woff2') format('woff2')` and `font-display: swap`.
   - Keep the existing stacks, with Inter and IBM Plex Mono first and system fallbacks after.
   - **No request may leave the origin;** test it (§5).

## 2. Restyle: adopt the mock's component styling

For each component, **use the mock's CSS values** (colours, radii, padding, font sizes and weights, borders, gaps), expressed
as tokens in `tokens.css`. `chat.css` must keep using `var(--…)` only; the existing test enforces this. The mock selector is
the reference.

| Component | Mock reference | What it must look like |
|---|---|---|
| Rail | `.rail`, `.mark`, `.rail-btn`, `.rail-btn.active` | `#0b0b0d` background with a 1px separator. A white 38px "AC" tile with radius 12. Icon above label, muted label, a light active fill (8% white) with white text |
| Secondary panel | `.side`, `.side-head`, `.search`, `.list`, `.label`, `.item`, `.dot`, `.meta` | `#101012`. A 15px title. A rounded 10px search field on the surface colour. Project rows as `.item`: a **34px rounded avatar tile** with the initial, then name (bold, 13.5px) over directory (12px muted, mono for paths) |
| Top bar | `.topbar` | 62px. Title 15px semibold, one-line context 12px muted. Actions as `.ghost` buttons (`Details`, ⋯) |
| User message | `.msg.user`, `.user .bubble` | **Right-aligned bubble**: `#1f1f23`, 1px border, radius 16 16 6 16, 14.5px text |
| Agent and Hermes messages | `.msg`, `.dot`, `.bubble` | A **34px avatar tile** with the agent's initial (an "H" tile for Hermes), then a bold name with a muted time, then the text. No log-style bullets ("●", "◇") in front of names |
| Session block header | — (thread rhythm per `.thread`) | A quiet divider row: title (semibold), status label and time (muted), "Collapse session" as a small ghost button. Inner padding consistent with cards (fixes O10). Thread column `width: min(780px, 100% − 40px)`, centred |
| Turn rows | — | One compact row: avatar tile (small), agent, turn title, then result labels in **IBM Plex Mono** (files, +/−). "Open turn details" as a link-style ghost control. Details stays a disclosure |
| Decision cards | `.card`, `.kicker`, `.solid`, `.ghost` | Surface card: `#161618`, radius 16, padding 14. Kicker label (uppercase 11px) for the request type. The primary action (Approve once, Answer) as **`.solid`** (white with black text); the others (Deny…, Dismiss) as **`.ghost`**. "Waiting for you" as a quiet status line in the card |
| Question choices | — | Keep native radio inputs for accessibility, styled as selectable rows: rounded, surface fill, a white ring when selected. No default grey circles |
| Composer | `.composer`, `.pills`, `.pills button.on`, `.send` | Surface `#161618`, 1px stronger border, radius 18. Pills row (Team as `.on`: white with black text; the target chip as a quiet pill). A full-width borderless textarea. **Send as a white 32px circle** with an arrow glyph and the accessible name "Send". ⚙ Settings as a quiet icon button |
| Section stages (Primary, Agents, Workspace, Skills, Settings) | `.canvas`, `.grid`, `.card`, `.setting`, `.sub` | Canvas padding 22/26. Skills as a `.grid` of `.card`s. Settings rows as `.setting` (surface, radius 14). Notices as quiet `.card`s, not boxed alerts |
| Dialogs and "+" menu | `.modal-back`, `.modal`, `.field` | Modal `#141416`, radius 16, 1px stronger border. Fields as rounded 10px inputs on `#0e0e10`. Buttons `.ghost` and `.solid` |
| Badges | — | The Projects count as a small rounded pill (symbol and number), consistent with the pill style |

### Floors that override the mock (unchanged rules; the visuals must work within them)
- **Text contrast** at least 4.5:1. The mock's `--faint` (`#5c5c66`) is never used for text.
- **Essential control boundaries and focus rings** at least 3:1. Input and textarea outlines and the composer's input edge use
  the tested border token; the mock's 7% lines are decorative separators only.
- **Targets** at least 40×40px on **tablet and phone**. At 1200px and above the mock's compact sizes (26px pills, 30px ghost
  buttons, 32px send) are allowed. On touch layouts, keep the mock's *visual* size but give a 40px hit area (padding or an
  invisible extension), and test the hit area.
- **Text sizes:** inputs at least 16px. No text below the existing smallest token (12px); rail and bar labels stay 12px, not
  the mock's 9px.
- Whole-word labels, the `rem` rail, the two-row composer below a 600px room, details on demand, and one rendering per
  approval (D13) are all unchanged.

### Out of scope
- No new features or data, and no changes to approval behaviour, request bodies or routes.
- No light theme, no purple, no gradients.
- O8 (whether the session header shows "!") stays as it is unless the owner decides otherwise.

## 3. Hard rules

- **May change:**
  - `agent-autonomy/chat/*` (including the new `.woff2` files and `FONTS.md`), `agent-autonomy/third_party/fonts/*`
  - `agent-autonomy/app.py`: **only** the one-line asset pattern and MIME mapping in §1.3
  - `tests/test_chat_routes.py`: only the §1.4 additions
  - `tests/test_chat_ui.cjs`, `tests/chat_screenshots.cjs`, `tests/fixtures.cjs`
  - `CURRENT_STATE.md`, the README chat description, this report, and architecture §9 (describe the shipped visual system)
- **Must not change:** classic files, any other Python file or test, state, endpoints, approval semantics or request bodies.
- All of §A in the acceptance document applies (escaping, accessibility, no fabricated content, both browser passes).
  **A8 now means:** no external requests and no downloaded fonts; same-origin bundled fonts are allowed (D20).

## 4. Tests

### Changed assertions
Tests that pin exact old *visual* values (colours, radii, sizes, the bullet glyphs before names, button fill) may change to the
new values. List each one by name, with before and after. No behaviour, accessibility, privacy, count or request assertion may
change.

### New (fatal)
1. **Fonts load from the origin:**
   - After load, `document.fonts.check('15px Inter')` and `document.fonts.check('13px "IBM Plex Mono"')` are true.
   - Every loaded face's URL is same-origin `/chat/*.woff2`.
   - **Zero requests leave the origin** during the full matrix: assert on every request, in both passes.
2. **The route tests** in §1.4.
3. **Component checks:**
   - user messages are right-aligned bubbles and agent messages have avatar tiles
   - decision cards have exactly one `.solid` primary action
   - the Send control is a circle with the accessible name "Send"
   - no "●" or "◇" glyph precedes an agent name in the thread
4. **Hit areas:** on tablet and phone, every pill, ghost button and Send has a hit area of at least 40×40px, even where the
   visual is smaller.
5. **Contrast:** the token contrast test covers every new text and boundary token.

### Visual comparison (the main acceptance check)
- **Render the mock** in Playwright from `docs/inputs/agentcontrol-ui.html`, with its Google Fonts request **intercepted and
  served from the bundled files**, so nothing is fetched online.
- **Render the app** in comparable states, at **1280×800 and 390×844**, for every section:
  - Primary
  - Agents
  - Projects, with a thread containing a user message, an agent message, a turn row and one decision card
  - Workspace
  - Skills
  - Settings
  - the composer
  - the Create project dialog
- Save each pair as `n13-compare-<section>-<width>.png`, side by side: mock left, app right.
- **Inspect every pair**, and list in the report any intentional difference (the floors in §2, real data versus mock text,
  sections not yet available).
- Opus compares these before accepting.

### Regression (must all pass)
- Full browser matrix, **both passes**.
- Chat DOM, classic **82/82**, routes (the existing 4, plus the new font tests).
- Cutover smoke **5/5**, the isolated fixture cases.
- One full Python run.
- DOM proof that every approval, decision, composer and project POST keeps its exact endpoint and body.

## 4a. When you finish

Append a completion report covering:
- commits and files changed
- font provenance, sizes and hashes
- every changed assertion (before and after) and every new test
- suite results with both pass counts
- the comparison pairs inspected, and the intentional differences
- deviations

Update `CURRENT_STATE.md`. Push only to `feature/chat-first-redesign`, then stop for Opus review: no N2, no merge, no pull
request.


## N1.3 completion report — 2026-10-03

**Implemented and verified; independent Opus review pending.** One implementation/report commit, titled
`N1.3: match the mock with bundled fonts`, from `a9a4441`; its hash is in the delivery note and branch history.
Push destination: only `feature/chat-first-redesign`. No N2, main merge or pull request.

### Sync and scope

The requested pull fetched `a9a4441`, but could not fast-forward the original checkout because ten surviving,
uncommitted N1.2 files overlapped. They were not reset, restored, stashed or discarded. Implementation and all
verification used a clean isolated worktree, `/tmp/AgentControl-n13`, at `a9a4441` (detached so the original
checked-out branch and edits remain intact). The implementation commit is pushed as a fast-forward to the requested
remote branch. The original checkout intentionally retains its earlier dirty work.

Changed files (24):

- `agent-autonomy/chat/`: `chat.css`, `tokens.css`, `index.html`, `thread.js`, `decisions.js`, `sections.js`,
  `FONTS.md` and the six WOFF2 files listed below.
- `agent-autonomy/third_party/fonts/`: unmodified `OFL-Inter.txt` and `OFL-IBM-Plex.txt`.
- `agent-autonomy/app.py`: only D20's flat asset allow-list extension and `font/woff2` MIME mapping. CSS/JS MIME,
  flat-directory checks, `reply()` headers, authentication and 404 behavior are preserved.
- `agent-autonomy/tests/`: `test_chat_routes.py` (two additions only), `test_chat_ui.cjs`, `fixtures.cjs`,
  `chat_screenshots.cjs`.
- `CURRENT_STATE.md`, README chat description, architecture **§9 only**, this appended report.

No classic file, other Python file/test, engine, journal, schema, endpoint, approval body or decision semantics changed.
Presentation uses escaped existing fields; avatars are decorative initials of recorded identities. Request catalogues,
confirmation rules, privacy boundaries, server-authoritative delivery and D7 remain unchanged. The in-flight skill-fetch
race remains excluded. D13's one approval card plus Projects count, details on demand, session history, one/two-row
composer and footer constraints remain in force; O8's session marker is unchanged.

### Fonts and provenance

Unmodified Fontsource packages **5.3.0**, metadata font version **v20**, SIL OFL 1.1:

- Inter: https://registry.npmjs.org/@fontsource-variable/inter/-/inter-5.3.0.tgz ; upstream `rsms/inter`.
- Plex: https://registry.npmjs.org/@fontsource/ibm-plex-mono/-/ibm-plex-mono-5.3.0.tgz ; upstream `IBM/plex`.

Inter variable 400–700 and Plex 400/500; Latin and Latin Extended only. Six flat same-origin files, **189,700 bytes**
(total), below 400 KB. `font-display: swap`; system fallback stacks retained. Full source filenames and provenance
are also in `chat/FONTS.md`. Both licence texts are unchanged package copies and are not served.

| File | Bytes | SHA-256 | Package file |
|---|---:|---|---|
| `inter-latin-var.woff2` | 48,256 | `3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62` | `inter-latin-wght-normal.woff2` |
| `inter-latin-ext-var.woff2` | 85,068 | `34b9c504cab7a73e37b746343a449132e56cf7b5481af2cb81dc74dcff25c956` | `inter-latin-ext-wght-normal.woff2` |
| `ibm-plex-mono-latin-400.woff2` | 14,708 | `08949f728dc52d528e69b1667d15c89a5686a4ee9a296ff90983985f99c380f7` | `ibm-plex-mono-latin-400-normal.woff2` |
| `ibm-plex-mono-latin-500.woff2` | 14,888 | `01d285447409c8a588692162439a038b8cbd7871309ee20267b0d2d91c6e8e22` | `ibm-plex-mono-latin-500-normal.woff2` |
| `ibm-plex-mono-latin-ext-400.woff2` | 13,348 | `6bc0f226a5b7884a8170e3f62c63d7675609d4631bdc5931b5cdab81821f00eb` | `ibm-plex-mono-latin-ext-400-normal.woff2` |
| `ibm-plex-mono-latin-ext-500.woff2` | 13,432 | `6bb06407c97584b0867a959e05e8874693bfeb8c317de190811c51598f2d99ea` | `ibm-plex-mono-latin-ext-500-normal.woff2` |

Every route test checks exact bytes, `font/woff2`, `no-store`, `nosniff`, and `DENY`. Unknown fonts, other extensions,
FONTS.md, licence files and nested/traversal paths are rejected. Outside-chat licence checks use the existing Bearer
contract; no unauthenticated non-chat route was broadened.

### Assertions changed (only these two)

| Test | Before | After | Reason |
|---|---|---|---|
| `M3.1 exact receipt decisions, delivery labels, actors and redirect` | actor text `● coder-2` | actor text `coder-2` | N1.3 removes the decorative log glyph; all receipt, actor identity, decision and redirect assertions stay |
| `M8 D all token text, boundary and focus colour contrasts meet their measured thresholds` | `ratios.length === 26` | `ratios.length === 67` | All original 26 pairs remain; 40 new neutral-surface pairs and the solid foreground/background pair are added; thresholds unchanged |

No test is retired. No behavior, accessibility, privacy, count, request or permission assertion is removed or weakened.
The browser target selector additionally covers composer chips; all existing matrix rows, zoom, clipping, safe-area,
focus, keyboard, footer and network assertions remain fatal.

### New checks

Two route tests: `test_bundled_fonts_and_security_headers` and `test_font_allow_list_does_not_expose_other_files`.
Four chat DOM tests:

1. `N1.3 thread bubbles and avatar tiles preserve escaped recorded identities and content`.
2. `N1.3 each supported decision card has one solid primary and ghost secondary controls`.
3. `N1.3 Send retains its exact action with an accessible arrow and project avatars are decorative`.
4. `N1.3 fonts are local OFL subsets with provenance hashes and no remote CSS sources`.

Fatal browser checks load/check both font families (including Latin Extended), validate all six face URLs and swap,
record **every** HTTP request's origin, measure right alignment/bounded user bubbles, require agent avatar tiles with
no log prefixes, and require exactly one solid primary on every supported actionable card. Comparison cases also
measure the circular Send and its accessible name. Every visible tablet/phone interactive target and composer chip
must be at least 40×40 px. The reference's 26 px pills, 30 px ghost outlines and 32 px Send stay inside those touch
areas. Font reports record **1,394 checks and zero app origin failures per pass**.

The contrast test covers 67 pairs; lowest text contrast **4.5698:1**, lowest boundary/focus contrast **3.3412:1**.
Native question radios retain their semantics and keyboard behavior, with styled rows and a selected white ring.

### Final verification

| Suite | Result | Log / artifacts |
|---|---|---|
| Chat DOM | **282/282** | `/tmp/ac-n13-chat-accepted.log` |
| Classic DOM (unchanged) | **82/82** | `/tmp/ac-n13-classic-accepted.log` |
| Chat routes | **6/6** (original four unchanged, two additions) | `/tmp/ac-n13-routes.log`; also in full Python |
| Full Python, first full attempt | **426 tests; OK, skipped=3** (**423 passed**) in **263.809 s** | `/tmp/ac-n13-python-full.log` |
| Browser, normal | **540 combinations + 179 regression cases; 848 screenshots** | `/tmp/ac-n13-browser-accepted.log`; `/tmp/chat-shots-n13-accepted/` |
| Browser, required 0.06em wide text | **540 + 179; 848 screenshots** | same log; `/tmp/chat-shots-n13-accepted-wide/` |
| Cutover smoke | **5/5 in each pass** | each directory's `cutover-smoke.json` |
| Isolated real-server fixture | **9/9 in each pass**, cleanup passed | each directory's `n1-fixture-results.json` |
| Eight-step real-server walkthrough | **8/8**, invariants and same-key classic smoke passed; no page errors; disposable project removed | `/tmp/ac-n13-real-verified.log`, `/tmp/ac-n13-real-results.json` |

Python's three skips are environment gates, not passes: container E2E needs an enabled runtime/image, desktop preview
needs missing desktop tools, and VM E2E needs an enabled KVM host. All three installed real-OpenCode tests ran and
passed. No Python timing failure or retry occurred in this full run. Heavy browser work finished before it started.

Both complete browser passes were run by the committed harness with no nonfatal substitutions: **1,696 screenshots**
total. All pre-N1.3 regression kinds remain (157 earlier regression cases plus 22 N1.3 comparison/component cases).
The read-only fixture creates/switches projects only under its disposable root. Recorded project POSTs are exactly
Stop, `/api/projects/create {name}`, `/api/projects/select {path}`; no real project data is used.

Unchanged DOM request/body checks include `M5 body helpers exclude unapproved fields and enforce text/confirm rules`,
`M5 real-server confirm word required, remember follows recorded risk`, all permission/question/team/research/skill/
outcome delivery tests, M4 submission/command/single-flight cases, and N1/N1.2 creation/switch confirmation tests.

The eight-step walkthrough reused the existing scratch real-server fakes, adapted only to current D13 navigation.
It creates three sessions through the UI, confirms the critical request with the server's word, answers the question,
approves a proposed team without pretending agents already joined, watches recorded Turn details grow, verifies,
applies, then replies in session. At every fully paged checkpoint, waiting equals actionable non-outcome messages
and cards equal actionable messages plus actionable outcomes. Turn details adds no read when it uses cached live data.

| Step | GET | POST |
|---|---:|---:|
| Start | 8 | 1 |
| Critical approval | 3 | 1 |
| Question | 6 | 1 |
| Team proposal | 21 | 2 |
| Live Turn details | 8 | 0 |
| Verify | 10 | 1 |
| Apply | 3 | 1 |
| Follow-up | 8 | 1 |

These per-step counts exactly match `/tmp/ac-n1-real-results.json`. Boot is **27 GET / 0 POST**, versus 21/0: the
only additions are the **six same-origin font GETs**, eagerly loaded for this probe. API boot/steady behavior is
unchanged. Auto explanation also passed (2 GET / 1 POST, the existing preflight). All eight steps use chat only;
the separate classic smoke afterwards loads `/classic` once with the shared key, 9 GET / 0 POST.

### Comparison renders inspected

The mock's original Google Fonts stylesheet request is intercepted and fulfilled with local `@font-face` rules;
font URLs resolve to the mock page's own origin. No online font fetch occurs. Mock code is used only by tests;
product code never imports it. The Projects comparison adds matching recorded-shaped test content to the reference
thread, styled with the mock's own CSS: user, Hermes, one turn and one permission card. Product rendering remains
entirely server/read-model driven.

**Every pair inspected in both final pass directories** (mock left, app right), each at 1280×800 and 390×844:

| Section/state | File stems (both widths) |
|---|---|
| Primary | `n13-compare-primary-1280.png`, `n13-compare-primary-390.png` |
| Agents | `n13-compare-agents-1280.png`, `n13-compare-agents-390.png` |
| Projects | `n13-compare-projects-1280.png`, `n13-compare-projects-390.png` |
| Workspace | `n13-compare-workspace-1280.png`, `n13-compare-workspace-390.png` |
| Skills | `n13-compare-skills-1280.png`, `n13-compare-skills-390.png` |
| Settings (Memory) | `n13-compare-settings-1280.png`, `n13-compare-settings-390.png` |
| Composer | `n13-compare-composer-1280.png`, `n13-compare-composer-390.png` |
| Create project | `n13-compare-create-project-1280.png`, `n13-compare-create-project-390.png` |
| Supplement: decision scrolled fully into view | `n13-compare-projects-decision-1280.png`, `n13-compare-projects-decision-390.png` |

**36 pairs** inspected: the required 16 per pass plus two supplemental decision views per pass. The supplemental
views show the entire card when the real session header/history pushes part below the phone fold. Also inspected
the wide-text 200% Skills render showing the zoom-scaled single-column grid. Images stay in `/tmp`, not the repository;
the committed harness reproduces them, and `n13-comparisons.json` lists the cases.

Intentional differences from the mock:

- Accessibility floors: 12 px rail/bar/kicker text instead of 9/11 px, inputs at least 16 px; contrast-safe muted
  copy and essential borders; slightly darker avatar fill (`#242429`); 40 px touch areas around smaller visuals.
- The rail stays 5.25 rem, with whole words; phones retain the approved bottom bar/drawer rather than the mock's
  top scrolling rail. Widened text may show only the active bottom label, with all names retained accessibly.
- D13 keeps the one-row composer at a room ≥600 px and two rows below, a single Team pill plus recorded target,
  the pinned compact footer, Projects count and details on demand. No mock member pills or persistent right panel.
  Idle/waiting footer is **110 px portrait / 66 px landscape**, equal in both passes; established limits and
  conversation fractions pass unchanged. The 240 px skill-card minimum is 15 rem, scaling at text zoom.
- The app retains recorded session dividers, dates/times, disclosure links, risk/review evidence, remember controls
  and actual decision choices. These account for taller thread/cards than the illustrative mock. Render comparison
  names and messages are test fixtures; runtime names, counts, paths and skill state come only from existing data.
- Primary, persistent Agents, Direct, project-file browsing, assignment and Memory remain honest unavailable
  states. Settings has the existing separate memory scopes; approval gates stay in their own Settings section.
  Create project retains the actual name-only creation contract and explanatory copy, with no future member picker.
- The mock's project/sample/member/skill copy is not shipped. The offline comparison shows Reconnecting because
  its SSE is intentionally unavailable; real-server live behavior is separately verified.

### Development failures, corrections and limits

These are development attempts, not substituted passing matrices:

- Before D20, the new font tests rejected all six WOFF2 files. The new outside-chat licence probe was corrected
  to authenticate, retaining the existing non-chat authentication contract. Existing route assertions never changed.
- Early DOM checks caught the authorised actor-glyph assertion and a muted/avatar contrast ratio below 4.5;
  the glyph assertion was updated as listed, and the avatar token darkened. Final 282/282 and all 67 ratios pass.
- Comparison-only harness faults (relative mock font URLs and a fixture lacking goal/agent messages) were fixed;
  no product content or runtime requests were invented.
- `/tmp/ac-n13-browser-first-full.log`: forced-colors active weight was 600; restored 700 with its focus outline.
- `/tmp/ac-n13-browser-final.log`: safe-area padding 8 px versus expected 20 px; restored `env()` maxima.
- `/tmp/ac-n13-browser-verified.log`: compact Send was vertically offset beside Turn details in a two-row composer;
  aligned its grid cell to the input. Both focused normal/wide checks then passed (11 screenshots / 1 combination /
  5 regression cases each, `/tmp/ac-n13-workspace-focused*.log`).
- `/tmp/ac-n13-browser-complete.log`: normal passed, required wide failed the 200% skill-summary clipping check
  (151 px client height / 241 px scroll height). The 240 px minimum now scales as 15 rem; the unchanged section
  checks passed (60 combinations / 18 screenshots, `/tmp/ac-n13-sections-wide.log`), followed by both complete
  passing matrices in `/tmp/ac-n13-browser-accepted.log`.
- Scratch walkthrough attempts required D13 adaptations: close restored Session details before the next decision,
  assert the exact Settings destination instead of obsolete direct classic links, and enter Settings through the
  rail while active-session composer Settings is hidden. Each remained fatal; final eight steps, fallback navigation,
  classic smoke and cleanup pass in `/tmp/ac-n13-real-verified.log`. No committed behavior test was weakened.

No functional deviation from N1.3. Additional decision comparison views and the scratch eight-step walkthrough
provide evidence beyond the required matrix/fixture checks. No physical-device or native assistive-technology
verification is claimed; Android keyboard/device checks remain deferred. Only the authorized font asset handler
changes Python. N2, persistent-bot roadmap work and main are untouched. Stop for independent Opus review.

---

## Review of N1.3 — 2026-10-04 (Opus)

**Verdict: N1.3 is accepted.** The chat now reads as the mock. One Should-fix (S1, desktop radio indicators drawn as ovals) is
carried into **N2 Part 0**. Reviewed `2811a04` against `a9a4441`.

| Check | Result (this review) |
|---|---|
| Scope | The only Python change is D20's: the `app.py` chat asset pattern gains `woff2`, plus its MIME mapping (`font/woff2`). Same `reply()` headers. Classic untouched |
| Fonts | Six WOFF2 files, **189,700 bytes**. Genuine `wOF2` headers, and SHA-256 equal to `chat/FONTS.md`. **Byte-identical** to `@fontsource-variable/inter` 5.3.0 and `@fontsource/ibm-plex-mono` 5.3.0, downloaded independently from the npm registry. Unmodified OFL 1.1 licences in `third_party/fonts/` |
| Routes | **6/6**: the original 4, plus bundled fonts with headers, plus every non-font, nested, traversal, licence and `FONTS.md` path giving 404 |
| Chat DOM / classic | **282/282** / **82/82**. Changed assertions: the agent-name bullet removed (with a new no-bullet check), and token contrast pairs expanded from **26 to 67** (stricter) |
| Browser matrix | **Normal: 540 + 179, 848 screenshots. Wide (0.06em): 540 + 179, 848 screenshots** |
| Python | **426, OK (skipped=6)**, first attempt (424 plus 2 font route tests; the 6 are gates) |

**Live probe** (isolated fixture, 1280 and 390):
- `document.fonts.check` is true for Inter and IBM Plex Mono.
- Only the needed same-origin subsets are fetched (`/chat/inter-latin-var.woff2`, `/chat/ibm-plex-mono-latin-400.woff2`).
- **Zero external requests**, zero POSTs.

**Comparison renders inspected** (`n13-compare-*`, mock on the left and app on the right): Projects, Projects with a decision,
Skills and Settings at 1280 and 390, plus the remaining pairs from the matrix output. They match the mock:
- the white AC tile
- 34px avatar tiles in panel rows and messages
- the right-aligned user bubble
- rounded surface cards with a kicker
- solid primary and ghost secondary buttons
- the pill composer with a round white Send
- Inter and Plex type

**Intentional differences:**
- real data instead of mock samples
- the handoff's phone bottom bar instead of the mock's 900px top row
- the accessibility floors (12px labels, tested borders, 40px touch targets)
- assignment and memory placeholders until N2 and N4
- classic links routed to Settings per D13

**S1 (Should fix, carried into N2 Part 0): desktop radio indicators render as 40×16 ovals.**
- On the live fixture at 1280px, `.decision-question input[type="radio"]` computes `width 40px, height 16px, min-width 40px`.
- A general `min-width: 40px` (touch target) overrides the radio's `width: var(--s4)`, and with `border-radius: 999px` each
  choice shows a pill instead of a circle. Phones are correct (40×40).
- **Fix:** at 1200px and above, give the radio `min-width: var(--s4)` (or `min-width: 0`). The whole choice row is already the
  click target.
- **Test:** every visible radio and checkbox indicator is square (`|width − height| ≤ 1px`) at every width, in both passes.

**Optional:**
- **O11.** Some request cards show a repeated risk label, for example "R1 · Low · low" on a question card in the fixture
  (level, label and class all printed). This predates N1.3; print the level and label only.
- O8–O10 as before (O10's padding is fixed by N1.3).

**No physical-device testing is claimed.** A phone recheck of the new look is advisable.
