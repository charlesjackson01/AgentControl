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
