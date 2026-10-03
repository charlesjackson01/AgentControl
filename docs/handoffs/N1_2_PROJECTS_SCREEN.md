# N1.2: The Projects screen (design correction)

**Status: READY FOR CODEX.** The owner reviewed the shipped N1 shell and approved this correction on 2026-10-03. It is recorded
as **D13** in `docs/REDESIGN_ARCHITECTURE.md`. Codex implements, then Opus reviews. Work on `feature/chat-first-redesign`. Do
not merge into `main`. Do not start N2.

## 0. Why

N1 kept every old room component and moved each one into the new frame. The result reads as three dashboards in one frame:
- a second navigation inside the Projects panel (Channels, Sessions, "In this session")
- the same session drawn three times (panel list, summary card, Session details beside the thread)
- one approval painted six times (rail badge, channel count, panel link, summary count, the card's waiting line, the waiting
  strip)
- old-shell chrome ("Open classic dashboard", "Reconnecting…")
- a clipped composer
- rail labels breaking mid-word

The fault was in the N1 handoff, which asked for relocation instead of redesign. This handoff replaces that with the owner's
model.

> **The Projects screen is: rail, project list, team thread, composer. Details open on demand. They never sit open beside a
> copy of themselves.**

**Inputs:** `docs/inputs/agentcontrol-ui-handoff1.md` (behaviour), `docs/inputs/agentcontrol-ui.html` (visual reference only;
copy no code), D8–D13 in `docs/REDESIGN_ARCHITECTURE.md`, and `docs/PERSISTENT_AGENTS_ACCEPTANCE.md` §A.

## 1. Owner decisions this implements (D13)

1. **An approval appears once:** as its card in the team thread, the action that needs it. The only other cue is a **count on
   the Projects rail item** (and bottom-bar item). It is a pointer, not a copy: activating it opens Projects and moves to the
   first actionable card (the existing `locateWaiting`).

   Removed:
   - the waiting strip and `#waiting-pointer`
   - the panel channel count and `#rail-waiting-link`
   - the summary card's count
   - the "Open in classic dashboard" link on every waiting line
2. **The panel sessions list is retired.** Session history lives in the thread: session blocks, "Load earlier", and `#/s/<id>`
   links, which keep working.
3. **The summary card is retired** (`#project-summary`). This supersedes the handoff text's "project cards".
4. **Classic links appear only:**
   - on a card that cannot be reviewed here (`decisions.js` "Too large to review here / Cannot review this approval here ·
     Open in classic")
   - in **Settings** (Settings › Classic dashboard, and its Approvals, Usage and activity entries)

   Two existing links stay, as functional fallbacks on the action itself rather than chrome, and are listed here so nobody
   removes them by accident:
   - the composer's blocked-state `#composer-classic`, shown only when the composer cannot act for a reason only classic
     resolves
   - Turn details' `/classic?popout=` surface links (G2 (a), C1)

   Everything else that links to `/classic` goes, or moves into Settings › Classic dashboard:
   - the session menu "Classic dashboard"
   - Session details "View in classic"
   - the composer Settings sheet's two classic sentences, which become "Set in Settings › Classic dashboard" with an in-app
     link to `#/settings`
   - Workspace's "Open in classic" and Skills' "Add or remove skills in classic"
5. **Rail labels are whole words.**
   - The rail is sized in `rem` (it grows with text zoom), and each label sits on one line.
   - No ellipsis, and no mid-word or `overflow-wrap: anywhere` breaks.

## 2. Target layout

```
┌ rail ┬ project list (300) ─┬ stage ─────────────────────────────────────────┐
│ AC   │ Projects        [+] │ project-name                        [Details] ⋯ │
│ Prim │ [ Search          ] │ ~/path/to/project            (Reconnecting… only │
│ Agen │ ● project   current │                               when not live)    │
│ Proj!│   ~/project         │ ── Task storage · Coding · team ─────────────── │
│ Work │   other-project     │ hermes: …                                        │
│ Skil │   ~/other-project   │ ▸ coder-1 · turn 1 · …   Open turn details      │
│ Sett │   …                 │ ┌ ! coder-2 asks: Which format? ─────────────┐   │
│      │                     │ │ [JSON] [SQLite] [Your answer] [Answer]      │   │
│  ○   │                     │ └────────────────────────────────────────────┘   │
│      │                     │ ╭ Team  Note → Hermes ──────────────────────╮   │
│      │                     │ │ Message Hermes…                           │   │
│      │                     │ ╰───────────────────────────── ⚙   [Send] ─╯   │
└──────┴─────────────────────┴────────────────────────────────────────────────┘
```

### Rail and bottom bar
- **Width** in `rem`, chosen so every label (12px token, in `rem`) fits on **one line in both browser passes** (normal and the
  0.06em wide-font pass). About `5.25rem` is expected; measure it. At 200% text zoom the rail doubles with the text.
- **Labels:** `white-space: nowrap`. No ellipsis, no `overflow-wrap: anywhere`, no hyphenation. This supersedes N1.1's
  wrap-anywhere rule and O7.
- **Bottom bar (< 720px):** if all six one-line labels fit, show icon plus label for every item. If not (for example at 320px,
  or in the wide pass), show **icons for all items and the label only for the active item**. Every item keeps its full
  accessible name, a target of at least 40×40px, and `aria-current`. Labels never break mid-word.
- **The Projects count badge** shows a symbol and a number, never colour alone, with the accessible name "Projects, N waiting
  for you". It is visible in every section.

### Project list (secondary panel)
- **Projects only.** Title "Projects", search, and "+".
  - The current project first: name and directory, marked current.
  - Then the git folders inside the projects root, from the existing `GET /api/projects/browse`, as project rows (name and
    directory).
  - Activating a row opens the existing switch confirmation (`POST /api/projects/select`).
- **Removed from the panel:** "Channels", "Sessions", "In this session", the waiting link, and the folder-browser breadcrumbs
  ("Root", "Parent folder", "Refresh").
- **"+" opens a small menu:**
  - **Create project:** the existing dialog and `POST /api/projects/create`.
  - **Open folder…:** a dialog that browses inside the root, using the existing breadcrumbs and Refresh, plus the switch
    confirmation. Non-git folders appear only here, labelled "Team sessions need git".
- **Members of the active project** are library agents, which arrive in N2. Until then the panel shows **no** member list.
  Today's per-run roster stays inside Session details.

### Stage
- **Top bar:**
  - title: the project name
  - context: the project directory, plus, **only while the connection is not live**, a quiet "Reconnecting…" (or the existing
    offline wording)
  - actions: **Details** (Session details, enabled when a session is selected or active) and the session menu ⋯
    (Pause/Resume/Stop, and Turn details links for active members). No classic link in the menu.
- **The team thread:** the existing timeline with session blocks, messages, collapsed turns, "Open turn details", "Load
  earlier", and the decision cards.
  - **No summary card.**
  - **No waiting strip.**
  - A pending card keeps its own "Waiting for you" state marker. That is the card itself, but without the generic classic link.
- **Composer** (the mock's layout; behaviour unchanged):
  - **Room width at least 600px:** one row, `[Team chip][target chip][input][⚙ Settings][Send]`.
  - **Room width below 600px** (phones, or Session details open beside a narrow room): two rows. Row 1: Team chip, target
    chip, Cancel follow-up and Resume when present, then ⚙ Settings. Row 2: the full-width input and Send.
  - Use a CSS container query on the footer (vanilla CSS, no build step) or a measured width class.
  - **No control may overlap or clip another** at any matrix width, at 200% zoom, or in either pass.
  - Literal, mention and slash parsing, six-line growth, the blocked states (`#composer-blocked`, `#composer-classic`) and
    the Settings sheet behave as today.

### Details on demand
- **Session details is closed by default.** It opens **only** from the Details button.
  - Following a `#/s/<id>` link focuses and selects that session in the thread, with the existing guarded read, and **does
    not** open Session details.
  - Remove the auto-open in `shell.js` `route()` (`contextOpen=true` on `#/s/`) and the persisted
    `acx-context-open` preference.
- When open:
  - ≥ 1200px: an overlay pane over the right of the stage, at most 360px, with focus trapped, Escape and close restoring the
    Details button, and the thread not reflowed under it
  - 720–1199px: a centred overlay of at most 560px
  - < 720px: a full-screen sheet
- **Turn details** keeps its N1 behaviour and routes: opened only from "Open turn details" or the session menu, with
  `#/w/<run>/<agent>`, `#workspace` and `workspace-*` unchanged.

## 3. Hard rules

- **Frontend and frontend tests only:** `agent-autonomy/chat/*`, `tests/test_chat_ui.cjs`, `tests/chat_screenshots.cjs`,
  `tests/fixtures.cjs`.
- **Docs:** `CURRENT_STATE.md`, this report, `docs/PARITY_CHECKLIST.md` (only update locations that cite the rail sessions
  list, waiting pointer or More links; no classification changes), and `docs/REDESIGN_ARCHITECTURE.md` §10 to describe the
  shipped screen.
- **No `.py`, Python test, classic, state or endpoint change. No new request type.**
- **Approval semantics are unchanged:** fingerprints, typed confirmation, remember, deny and redirect, 409, idempotent taps,
  and the M5.0 rule that the server's waiting count equals the actionable non-outcome items. The Projects badge count is the
  channel's server count.
- **No request in the room's steady state is added.** The boot read of browse may be removed (the panel no longer browses
  until "Open folder…"), but nothing new is added.
- **Every rule of `docs/PERSISTENT_AGENTS_ACCEPTANCE.md` §A applies,** including escaping, accessibility, no fabricated
  content, and both browser passes.

## 4. Tests

### Retire (feature removed by D13; list each by exact name in the report)
- the rail and panel **sessions list** tests (M3.1 rail counts, M6 rail union, live precedence and paging, M8 A disclosure,
  M8 B rail-title truncation, M8 D singular rail counts)
- the **waiting strip and pointer** tests (M3 pointer, M3.1 waiting line in every layout, M5 pointer recovery, the M9.1 B rail
  waiting link)
- the **summary card** tests
- the **classic-link placement** assertions for removed links

**Behaviour that moves must keep its assertions:**
- `locateWaiting` (now from the badge), including the ten-page budget and focus on the first actionable card
- thread paging, and `#/s/` focus and guarded reads
- the server-count waiting invariant
- Turn details routes, privacy and zero writes

### Add (fatal)
1. **The approval appears once.**
   - For each fixture with N actionable requests, the DOM has exactly N decision cards.
   - **No other element** shows waiting or approval text, except the badge's count and accessible name.
   - No `#waiting`, `#waiting-pointer`, `#rail-waiting-link` or `#project-summary`.
2. **No duplicate session or member rendering:** a session title appears only in its thread block, plus in Session details
   while open. The panel contains only project rows, search and "+".
3. **Details on demand:**
   - Session details is closed on load and after `#/s/<id>`, and opens only from Details.
   - Closing restores focus to Details.
   - No `acx-context-open` is read or written.
4. **Classic links:** a DOM scan finds `href^="/classic"` only inside Settings, unreviewable cards, `#composer-classic` and
   Turn details pop-out links.
5. **Composer:**
   - In both passes, at 1280, 1200, 1024, 768, 390, 844×390, 320 and 200% zoom (including with Session details open), no two
     composer controls' boxes intersect, and none clips (scroll ≤ client).
   - The one-row and two-row forms switch at a room width of 600px.
6. **Labels:**
   - Rail labels are one line (height of one line box) and unclipped in both passes and at 200% zoom.
   - The bottom bar uses all labels or only the active one, per the rule.
   - No label element uses ellipsis or breaks mid-word.
7. **Connection status:** hidden while live; visible as quiet text when not live.
8. **The badge** is visible and correct in every section, and activating it from another section reaches the first card.

### Footer limits (D10, unchanged)
- Phone portrait conversation at least 55% with the bar.
- Landscape conversation at least 45%, idle footer at most 72px. With no waiting strip, the waiting footer equals the idle
  footer.
- Bar at most 64px, hidden while the keyboard is open.

### Renders for owner review
Save these named screenshots in **both** passes, and inspect them before reporting:
- `n12-projects-1280-idle`, `n12-projects-1280-waiting`, `n12-projects-1280-details-open`
- `n12-projects-390-waiting`, `n12-projects-320-waiting`
- `n12-projects-1280-zoom200-waiting`, `n12-projects-1280-zoom200-details-open`
- `n12-plus-menu`, `n12-open-folder`

Opus compares them against §2 before accepting.

### Regression (must all pass)
- Full browser matrix, both passes.
- Chat DOM, classic **82/82**, routes **4/4**, cutover smoke **5/5**, the isolated fixture cases.
- One full Python run (unchanged files; gates labelled).
- **Walkthrough substitution (owner decision, 2026-10-03, option (a)).** The M9/N1 eight-step real-server walkthrough script
  was never committed, so it is **not required for N1.2**. N1.2 changes no request path. In its place:
  - the committed isolated fixture cases and cutover smoke must pass
  - DOM tests must show that every approval, decision, composer and project POST keeps its exact endpoint and body
  - the report lists any change in GET counts at boot or in the steady state

  Opus adds its own real-server fixture probe at review. Rebuilding and committing the walkthrough under
  `agent-autonomy/tests/` is deferred to N2's harness work.

## 5. When you finish

Append a completion report covering:
- start and end commits, and files changed
- every retired test (exact name and why) and every changed or added assertion
- suite results with logs, and both pass counts
- the walkthrough counts
- the named renders inspected
- deviations

Update `CURRENT_STATE.md`. Commit and push only to `feature/chat-first-redesign`. Stop for Opus review: no N2, no merge into
`main`.


---

## N1.2 completion report — Claude Code (interim implementer), 2026-10-03

**Start:** `c26c882`. **Implementation commit:** `f135bb3` (product, tests, §10, parity notes). This report and
`CURRENT_STATE.md` follow in the next commit. Pushed only to `feature/chat-first-redesign`; no merge into `main`,
no N2. Stop for independent Opus review.

### Shipped scope (D13)

- **Approval once.** The waiting strip, `#waiting-pointer`, `#rail-waiting(-link)`, the panel channel count, the
  summary card (`#project-summary`) and the per-card generic "Open in classic dashboard" link are gone. A pending card
  keeps its own "! Waiting for you" line. The only other cue is the **Projects count** on the rail and bottom-bar
  item: visible in every section, symbol plus number (`! N`, `aria-hidden`), accessible name "Projects, N waiting for
  you", the channel's server count. Activating it opens Projects and runs the existing `locateWaiting` (ten-page
  budget) and now **focuses** the first actionable card. The polite `#waiting-live` announcement is kept (§9).
- **Project list.** Title "Projects", search, "+". The current project first (name, directory, "Current"), then the
  git folders in the root from the existing `GET /api/projects/browse` as rows; a row opens the existing switch
  confirmation. "+" is a disclosure menu with **Create project** (existing dialog) and **Open folder…** (a dialog
  with Root, Parent folder, Refresh, the folder path and rows; non-git folders only here, "No git · Team sessions
  need git"; choosing one leads to the same switch confirmation). A choice closes the menu; Escape on the menu or a
  dialog returns focus to "+". Channels, Sessions, In this session, the roster, the waiting link and breadcrumbs are
  removed from the panel. The browse read stays exactly where it was (desktop on first Projects render; tablet/phone
  when the panel opens); Open folder… reuses the panel's root listing and reads only on navigation or Refresh.
- **Stage.** Top bar: project name; the directory plus a quiet `#connection-label` ("Reconnecting…") **only while not
  live** (section headers follow the same rule); **Details** (enabled when a session is selected or active; it then
  describes the active session) and ⋯ (Pause/Resume/Stop…, Turn details links; no classic link, "No active session"
  when empty). The header session count is gone.
- **Details on demand.** Session details is closed on load, after `#/s/<id>` (which still focuses the session with
  the existing guarded read) and on any route change; it opens only from Details. `acx-context-open` is neither read
  nor written. It is a modal at every width now: ≥ 1200 px a ≤ 360 px right overlay with scrim, focus trap, inert
  background and no thread reflow; 720–1199 px the existing ≤ 560 px centred overlay; < 720 px a full-screen sheet.
  Escape and × return focus to Details. Returning from Turn details restores it if it was open.
- **Classic links** only in Settings (new **Settings › Classic dashboard** entry, plus Approvals and Usage and
  activity), on cards that cannot be reviewed here, `#composer-classic` and Turn details pop-outs. The session-menu
  link, "View in classic", Workspace's "Open in classic" and Skills' "Add or remove skills in classic" are gone; the
  composer Settings sheet sentences read "Set in Settings › Classic dashboard" linking `#/settings`
  (`data-setting-link` opens that entry and closes the sheet).
- **Rail and labels.** `--nav-width: 5.25rem` (84 px at 16 px; doubles at 200%). Labels are `white-space: nowrap`,
  no ellipsis, no `overflow-wrap: anywhere`, no hyphenation, and the accessible name is on the link. The phone bar
  shows every label when the widest fits an equal cell, else icons for all and the active item's label (inactive
  labels become visually hidden, keeping their measured width); a `ResizeObserver` keeps this right under text zoom
  and fonts. In both passes 320 and 390 use the active-only form; 600 and 719 show all labels.
- **Composer.** A container query on `#room`: ≥ 600 px one row `[Team][target][input][⚙][Send]`; < 600 px two rows
  (Team, target, Cancel follow-up, Resume, ⚙; then input and Send; row 1 is at least 40 px so the footer does not
  change with the mode). Parsing, growth, blocked states and the Settings sheet are unchanged.

### Files changed (`c26c882..f135bb3`)

`agent-autonomy/chat/`: `index.html` (no `#project-summary`/`#waiting`; asset version `n12`), `tokens.css` (rem
rail), `chat.css` (retired rules removed; N1.2 section), `shell.js`, `sections.js`, `thread.js`, `decisions.js`,
`composer.js`. Tests: `tests/test_chat_ui.cjs`, `tests/chat_screenshots.cjs` (`fixtures.cjs` unchanged). Docs:
`docs/REDESIGN_ARCHITECTURE.md` §10 (describes the shipped screen; the "superseded by D13" note is folded in),
`docs/PARITY_CHECKLIST.md` (locations only: More → Settings, waiting pointer → Projects count, sessions list →
thread, T22 marked retired; **classification counts unchanged**). **No `.py`, Python test, classic file, state or
endpoint changed** (`git diff --stat c26c882 f135bb3` lists only the files above).

### Retired DOM tests (6, all in the handoff's retire list)

- `M3.1 rail counts use the M6 session union and current count wording` — the rail sessions list and its X of N note are retired by D13 (2); session history lives in the thread.
- `M8 A rail disclosure is accurate while incomplete and disappears only at completion including paging` — the rail sessions list, its disclosure and 'Load earlier sessions' are retired by D13 (2); thread paging keeps its own tests.
- `M9 N1 cached sessions exceeding the server total do not show an incomplete-history disclosure` — the rail sessions-list disclosure is retired by D13 (2).
- `M9.1 B rail waiting is always findable and exactly matches channel counts` — the panel waiting line (#rail-waiting) is retired by D13 (1); the Projects count equals the channel count in N1.2 approval-once and badge tests.
- `N1.1 Projects header and summary use the recorded singular and plural session counts` — the summary card is retired by D13 (3), and the header context is the project directory (§2), so neither shows a session count.
- `M6 rail paging grows the shared room cache and reports exact X/N counts` — the rail sessions list, its X of N count and 'Load earlier sessions' are retired by D13 (2); thread paging of the same shared cache keeps its M3/M8 tests.

Two pure `model.railSessions` tests in the listed families are **kept, not retired**, because the function still
chooses which session Session details describes: `M6 rail union dedupes with live precedence, orders history and
counts actual entries` and `M8 D singular rail counts use session without changing counts or pagination`.
The listed "M3 pointer", "M5 pointer recovery" and "M3.1 waiting line" tests were **relocated rather than retired**
(their locateWaiting, count and marker assertions now run against the Projects count and the card).

### Changed DOM assertions (behaviour moved; exact before/after in Appendix A)

- `sessions ordered, deep links focus and open context`: the rail sessions list is retired (D13 (2)); session order stays asserted on the thread blocks on the next line. D13: a #/s/ link focuses the session but no longer opens Session details; it opens from Details. D13: the acx-context-open preference is removed and never written.
- `unknown fresh session recovers and never fetches agents`: the rail sessions list is retired; both sessions stay listed as thread blocks.
- `stale link and failed refresh preserve later live updates`: the rail sessions list is retired; the later live title is asserted in Session details, opened from Details.
- `saved context and return to room leave no scrim`: D13: a saved acx-context-open=true and a #/s/ link no longer open Session details; it opens from Details.
- `every presence state has a symbol and label, Hermes first`: the panel roster is retired (no member list in the panel until N2); every presence label is asserted in Session details' roster.
- `waiting pointer and room composer, controls only on actionable messages`: D13 (1): the waiting pointer and its classic link are removed; the Projects count carries the same server count. D13 (1): with nothing waiting there is no count, as there was no pointer.
- `M3 actions link once to classic; M5 controls are scoped and hide fingerprints`: D13 (1)/(4): the generic per-card classic link is removed; only a card that cannot be reviewed here keeps its one classic link.
- `M3 waiting count is from channels and pointer finds first action`: locateWaiting moves from the pointer to the Projects count (D13 (1)); same count and same first-card result. same server-count update, asserted on the Projects count.
- `M3.1 waiting line separates summary, marker and link in every layout`: D13 (1): the card keeps its own Waiting for you marker on a separate line, without the generic classic link.
- `M4 Basic/Advanced Settings and unavailability reasons disclose progressively`: D13 (4): the Settings sheet's classic sentences become 'Set in Settings › Classic dashboard' with an in-app link.
- `M5 no controls on historical, expired, decided or unsupported actions`: D13 (4): an unsupported action is a card that cannot be reviewed here; it keeps the card's own classic fallback instead of the removed generic link.
- `M5 waiting pointer prefers the first non-outcome actionable card`: locateWaiting moves from the pointer to the Projects count; the same first non-outcome card is located.
- `M6 proposed agents never become live members and the panel has no decisions`: the panel roster and its 'Team plan pending' line are retired (no member list in the panel); the proposed plan stays asserted in Session details below.
- `openMembers (helper)`: D13: Session details opens only from Details, so the helper presses Details after following the #/s/ link.
- `M8 B truncated room and rail titles retain the full server value`: the rail title is retired (D13 (2)) and the header context is now the project directory (§2); the room title keeps its full value, and the session title keeps its full escaped value in its thread block.
- `M8 C phone rail and context sheets trap focus and restore visible openers`: Refresh moved from the panel into Open folder… (D13); the trap is checked with the panel's last focusable control.
- `M8 D decorative state symbols are hidden while recorded labels and list semantics remain`: the sessions list is retired; the panel's project list keeps list semantics. the pointer's decorative symbol moves to the Projects count, which keeps its symbol aria-hidden behind the full accessible name.
- `M9.1 B rail waiting uses locateWaiting and reveals the room after closing the phone drawer`: the panel waiting link is retired; locateWaiting is reached from the phone bar's Projects count in another section, with the same located, closed-drawer and focused-card assertions.
- `M9.1 B rail and session menu link only the active recorded members to their Workspaces`: the panel roster is retired; the roster entry links are asserted in Session details' roster (today's per-run roster). same no-run-together and no-decision checks, in the roster's new location.
- `M9.1 B proposed-only, stopping and never-approved expired agents get no entry links`: the panel waiting line is retired (D13 (1)); the no-entry-link assertions are unchanged.
- `M9.1 B empty and quiet rooms explain the existing decision cards without another decision surface`: the guidance no longer mentions the removed waiting bar; it names the Projects count.
- `M9.1 B Workspace navigation from the drawer restores its visible opening link without a write`: the drawer roster is retired; the same Turn details round trip starts from the phone Session details sheet and returns to that sheet and its opening link.
- `M9.1a F3 returning to a selected session preserves its previously closed context sheet`: D13: the acx-context-open preference is removed and never written.
- `N1 Projects current pinned, escaped browse, breadcrumb requests and client-only search`: D13: the panel lists git projects only, with the current project first; non-git folders, breadcrumbs and Refresh moved into Open folder…, where escaping, the 'Team sessions need git' label and the exact browse request are asserted.
- `N1 project confirmation traps focus, Escape restores its live panel opener and writes nothing`: Create project now sits in the panel's + menu (D13); choosing it closes the menu, so the dialog's live opener is the + button, and Escape restores focus there.

### New fatal DOM tests (9)

1. `N1.2 an approval appears once: one card per action and only the Projects count elsewhere` — six fixtures
   (all decisions, critical, outcome, active, team, completed): cards = actions exactly; markers only inside cards;
   no retired ids; no visible text, `title` or `aria-label` outside the thread mentions waiting/approval except the
   count's own label; two counts (rail + bar) with `! N` and the exact accessible name, none when N = 0.
2. `N1.2 sessions render once in the thread, again only in open Session details, and the panel lists only projects`.
3. `N1.2 Session details is closed on load and after a session link, opens only from Details and restores focus
   there` — at 1280, 1024 and phone, with a stale `acx-context-open=true` present (left untouched); Escape and ×
   return focus to Details; no chat file mentions `acx-context-open`; Details disabled with no session.
4. `N1.2 classic links appear only in Settings, unreviewable cards, the composer fallback and Turn details
   pop-outs` — scans every `a[href^="/classic"]` in the room, session menu, Session details, both Settings sheets,
   every section and every Settings entry, and Turn details.
5. `N1.2 navigation labels are whole words on one line in a rem-sized rail` (CSS rules and token).
6. `N1.2 navigation items keep full names, one label each and aria-current`.
7. `N1.2 connection status is hidden while live and quiet text when not live` (room and section headers).
8. `N1.2 the Projects count is in every section and its activation focuses the first actionable card` (real
   `locateWaiting`, `document.activeElement` is the card).
9. `N1.2 + offers Create project and Open folder…, which browses inside the root and confirms one exact switch` —
   Escape returns to "+", no extra read on opening, exact `GET /api/projects/browse?path=…`, escaped names, exactly
   one `POST /api/projects/select {path}`.

All nine fail on the `c26c882` frontend (the first by never completing) and pass on `f135bb3`.

### Browser matrix changes (both passes)

- New `n12Cases` (96 cases per pass, fatal): the composer in five states (new session with ⚙, note, paused with
  Resume, follow-up with Cancel, two waiting) at 1280, 1200, 1024, 768, 600, 599, 390, 844×390, 320 and 1280 at 200%,
  each with Session details closed and (where a session exists) open: no two control boxes intersect, none clips,
  all stay inside the row, one row exactly when the room is ≥ 600 px (asserted at 600 → 1 row and 599 → 2 rows), no
  page overflow, plus the label checks. Footer equality idle vs waiting at 390×844 (103 px) and 844×390 (59 px).
  Session details at 1280/1024/390: closed after `#/s/`, overlay bounds, no thread reflow at 1280, 40 Tabs stay
  inside, Escape returns to Details. The Projects count in all six sections at 1280 and 390, focusing the first
  card; no visible waiting/approval text outside the cards; quiet `Reconnecting…` (muted colour, one line).
- `clippedControls` now also asserts every label is one line, `nowrap`, `overflow-wrap: normal`,
  `word-break: normal`, not `hyphens: auto`, inside its item, targets ≥ 40 px, and the bar shows all labels or only
  the active one; it waits two frames first (the label rule reports through `ResizeObserver`).
- Relocated cases (exact before/after in Appendix B): fixture, cutover, discovery, device viewport, accessibility
  spots, phone panel, keyboard paths, members/decision/workspace/context states, `railPaged` (now pages the thread),
  the stale-context regression and the rail-width assertion (76 px → 5.25 rem).
- **Geometry assertions replaced** (§2 makes the phone composer two rows): the portrait footer limit moves from
  ≤ 72 px idle / ≤ 112 px waiting to ≤ 112 px always (D10's ceiling; the conversation floor of 55% is unchanged and
  measured ≥ 73.05%); landscape keeps ≤ 72 px and now applies it whether or not anything waits (measured 59 px);
  the waiting-strip height and pointer/link baseline checks are removed with the strip; the device "close keyboard"
  check allows ≤ 112 px only below a 600 px room and adds waiting = idle.

### Verification

| Check | Command | Result / log |
|---|---|---|
| Chat DOM | `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_chat_ui.cjs` | **278/278** (275 − 6 retired + 9 new); `/tmp/ac-n12-chat-5.log` |
| Classic DOM, unchanged | `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_ui.cjs` | **82/82**; `/tmp/ac-n12-classic.log` |
| Routes, unchanged | `PYTHONPATH=agent-autonomy:agent-autonomy/tests python3 -m unittest -v test_chat_routes` | **4/4**, 2.111 s; `/tmp/ac-n12-routes.log` |
| Full matrix, normal + required wide child | `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/chat_screenshots.cjs /tmp/chat-shots-n12-final` | **Normal: 540 combinations + 157 regression cases, 830 screenshots. Wide (0.06em): 540 + 157, 830.** Total 1,660, exit 0, 10 m 54 s; `/tmp/ac-n12-browser-final.log` |
| Cutover smoke | inside each pass | **5/5 per pass**, zero POSTs, zero page errors |
| Isolated fixture (`device_fixture.py`, temporary root) | inside each pass | **9/9 per pass**; POSTs exactly Stop, `/api/projects/create {name}`, `/api/projects/select {path}`; root removed |
| Python, unchanged | `python3 -m unittest discover -s agent-autonomy/tests -v` | **424 tests, OK (skipped=6), 120.124 s**, first attempt, run alone after the browser work; `/tmp/ac-n12-python.log` |

157 regression cases per pass = the 61 carried over + 96 N1.2 cases. The 540 combinations are unchanged (48 states ×
10 viewports + 6 sections × 10). Contrast pairs, targets, input fonts, keyboard paths, reduced motion, forced colours,
200% zoom and the bar's ≤ 64 px/keyboard hiding remain fatal in both passes. **Gates, not passes:** container e2e,
desktop preview and KVM e2e (environment), and the three real-OpenCode tests (`test_roles_e2e…paid_coder…`,
`test_team_e2e…installed_skill…`, `test_team_e2e…two_agents_killed…`), skipped because this container has no OpenCode
binary. No Python failure or retry occurred.

### Walkthrough substitution (owner option (a))

- Committed isolated fixture cases **9/9** and cutover smoke **5/5**, in both passes.
- POST endpoints and bodies are pinned by DOM tests that pass unchanged in assertion: approvals/decisions
  (`M5 body helpers exclude unapproved fields and enforce text/confirm rules`, `M5 real-server confirm word required,
  remember follows recorded risk`, `M5 slash aliases use the exact same controls and confirmations`,
  `M5 only awaiting-fetch skill Reject can use the authorized endpoint exception`), composer
  (`M4 new session sends only goal and remembered/changed settings`, `M4 Hermes and leading @agent routing use exact
  bodies and preserve later tokens`, `M4 available isolation and all changed Basic/Advanced values send their exact
  shapes`, `M4 pause, resume and chip are exact aliases; menu errors stay inline`), projects
  (`N1 Create required name, read-only derived directory and exactly one request under lock`, `N1 project Switch
  confirms exact path once and preserves server refusal verbatim`, `N1 create respects the existing writeOwner`,
  `N1 select respects the existing writeOwner`) and the new N1.2 Open folder… test; plus the browser keyboard paths' exact `/api/runs`,
  `/api/control` and `/api/review` bodies.
- **GET counts unchanged**, measured on the same fixture with `c26c882` and `f135bb3` (identical JSON):
  boot **5** at 1280 (state, channels, thread, events, one panel browse), **4** at 1024 and 390; steady-state
  refresh **3** (state, channels, thread) everywhere. No request was added.

### Renders inspected (both `/tmp/chat-shots-n12-final` and `/tmp/chat-shots-n12-final-wide`)

`n12-projects-1280-idle`, `n12-projects-1280-waiting`, `n12-projects-1280-details-open`, `n12-projects-390-waiting`,
`n12-projects-320-waiting`, `n12-projects-1280-zoom200-waiting`, `n12-projects-1280-zoom200-details-open`,
`n12-plus-menu`, `n12-open-folder`. They match §2: rail with whole one-line labels and the `! 2` count on Projects;
project list with the current project first; one card per request with its own "! Waiting for you"; no strip,
summary or classic chrome; "Reconnecting…" quiet beside the directory; composer one row at 1280 (also at 200%) and
two rows at 390/320 with the phone bar showing only "Projects"; Session details as a right overlay; "+" menu;
Open folder… listing the non-git folder with "No git · Team sessions need git". Notes for review: at 200% the
project-list directories wrap inside the path (they are paths, not navigation labels) and Session details' two tabs
stack; nothing clips.

### Deviations and decisions to review

1. **Unsupported actions keep a classic fallback on the card.** With the generic link removed, a waiting item whose
   endpoint the room cannot use would have had no way forward. It now shows the existing "Cannot review this approval
   here · Open in classic" line (D13 (4)'s "card that cannot be reviewed here"). No control or request added.
2. **Details describes the active session when none is selected**, so the button is enabled whenever a session is
   active (§2: "enabled when a session is selected or active").
3. **Session details closes on any route change** (Back, section switch, `#/`), except returning from Turn details,
   which restores it.
4. **Agents' "Projects › Session details" link** now goes to Projects and focuses Details instead of auto-opening.
5. **The phone portrait footer is 103 px** (two rows) where it was 57/105 px; see the replaced geometry assertions.
6. The section headers also hide "Live" (same rule as the Projects top bar).
7. Test harness additions: a focused `--n12-only` flag (never used by complete passes) and the two-frame settle.

### Not done / limits

The M9/N1 real-server walkthrough was not run (owner option (a)); Opus adds its own probe. No physical-device or
assistive-technology testing. N2, Primary, persistent agents and any backend work remain out of scope.

### Appendix A — exact DOM assertion changes (`test_chat_ui.cjs`)

**`sessions ordered, deep links focus and open context`** — the rail sessions list is retired (D13 (2)); session order stays asserted on the thread blocks on the next line.

Before:
```js
const h=await harness(richActive());const rail=[...h.document.querySelectorAll('#session-list a')];assert.match(rail[0].getAttribute('href'),/run_test/);
```
After:
```js
const h=await harness(richActive());
```

**`sessions ordered, deep links focus and open context`** — D13: a #/s/ link focuses the session but no longer opens Session details; it opens from Details.

Before:
```js
  assert.equal(h.document.querySelector('#context').hidden,false);assert.equal(h.document.querySelector('.focused [data-session]').dataset.session,'run_test');
```
After:
```js
  assert.equal(h.document.querySelector('#context').hidden,true);h.document.querySelector('#open-context').click();assert.equal(h.document.querySelector('#context').hidden,false);assert.equal(h.document.querySelector('.focused [data-session]').dataset.session,'run_test');
```

**`sessions ordered, deep links focus and open context`** — D13: the acx-context-open preference is removed and never written.

Before:
```js
  h.shell.setContext(false);assert.equal(h.local.get('acx-context-open'),'false');
```
After:
```js
  h.shell.setContext(false);assert.equal(h.local.has('acx-context-open'),false);
```

**`unknown fresh session recovers and never fetches agents`** — the rail sessions list is retired; both sessions stay listed as thread blocks.

Before:
```js
  assert.equal(h.document.querySelectorAll('#session-list a').length,2);
```
After:
```js
  assert.equal(h.timeline.querySelectorAll('.session-divider[data-session]').length,2);
```

**`stale link and failed refresh preserve later live updates`** — the rail sessions list is retired; the later live title is asserted in Session details, opened from Details.

Before:
```js
  assert.match(h.document.querySelector('#session-list').textContent,/Updated session/);
```
After:
```js
  h.document.querySelector('#open-context').click();assert.match(h.document.querySelector('#context').textContent,/Updated session/);
```

**`saved context and return to room leave no scrim`** — D13: a saved acx-context-open=true and a #/s/ link no longer open Session details; it opens from Details.

Before:
```js
  h.window.location.hash='#/s/run_test';h.shell.route();await h.runTimers(0);
  assert.equal(h.document.getElementById('context').hidden,false);
  h.window.location.hash='#/';
```
After:
```js
  h.window.location.hash='#/s/run_test';h.shell.route();await h.runTimers(0);
  assert.equal(h.document.getElementById('context').hidden,true);h.document.querySelector('#open-context').click();
  assert.equal(h.document.getElementById('context').hidden,false);
  h.window.location.hash='#/';
```

**`every presence state has a symbol and label, Hermes first`** — the panel roster is retired (no member list in the panel until N2); every presence label is asserted in Session details' roster.

Before:
```js
  const h=await harness(state);const members=model.membersFromState(state);assert.equal(members[0].name,'hermes');for(const member of members){assert(member.symbol);assert.match(h.document.querySelector('#rail').textContent,new RegExp(member.stateLabel));}
  h.window.location.hash='#/s/run_test';h.shell.route();await h.runTimers(0);h.document.querySelector('#members-tab').click();
```
After:
```js
  const h=await harness(state);const members=model.membersFromState(state);assert.equal(members[0].name,'hermes');
  h.window.location.hash='#/s/run_test';h.shell.route();await h.runTimers(0);h.document.querySelector('#open-context').click();h.document.querySelector('#members-tab').click();for(const member of members){assert(member.symbol);assert.match(h.document.querySelector('#context').textContent,new RegExp(member.stateLabel));}
```

**`waiting pointer and room composer, controls only on actionable messages`** — D13 (1): the waiting pointer and its classic link are removed; the Projects count carries the same server count.

Before:
```js
  const h=await harness();assert.equal(h.document.querySelector('#waiting-pointer').textContent,'! 1 waiting for you');assert.equal(h.document.querySelector('#waiting a').getAttribute('href'),'/classic');
```
After:
```js
  const h=await harness();assert.equal(h.document.querySelector('#section-nav [data-locate-waiting]').getAttribute('aria-label'),'Projects, 1 waiting for you');assert.equal(h.document.querySelector('#section-nav .projects-badge').textContent,'! 1');assert.equal(h.document.querySelector('#waiting'),null);
```

**`waiting pointer and room composer, controls only on actionable messages`** — D13 (1): with nothing waiting there is no count, as there was no pointer.

Before:
```js
  const done=await harness(richCompleted());assert.equal(done.document.querySelector('#waiting').textContent,'');
```
After:
```js
  const done=await harness(richCompleted());assert.equal(done.document.querySelectorAll('[data-locate-waiting],.projects-badge').length,0);
```

**`M3 actions link once to classic; M5 controls are scoped and hide fingerprints`** — D13 (1)/(4): the generic per-card classic link is removed; only a card that cannot be reviewed here keeps its one classic link.

Before:
```js
assert.equal(node.querySelectorAll('a[href="/classic"]').length,1);assert(node.textContent.includes('Waiting for you'));
```
After:
```js
assert.equal(node.querySelectorAll('a[href="/classic"]').length,node.querySelector('.review-unavailable')?1:0);assert(node.textContent.includes('Waiting for you'));
```

**`M3 waiting count is from channels and pointer finds first action`** — locateWaiting moves from the pointer to the Projects count (D13 (1)); same count and same first-card result.

Before:
```js
assert.equal(h.document.querySelector('#waiting-pointer').textContent,'! 2 waiting for you');h.document.querySelector('#waiting-pointer').click();
```
After:
```js
assert.equal(h.document.querySelector('#section-nav [data-locate-waiting]').getAttribute('aria-label'),'Projects, 2 waiting for you');h.document.querySelector('#section-nav [data-locate-waiting]').click();
```

**`M3 waiting count is from channels and pointer finds first action`** — same server-count update, asserted on the Projects count.

Before:
```js
assert.equal(h.document.querySelector('#waiting-pointer').textContent,'! 1 waiting for you');assert(!h.document.querySelector('#waiting').textContent.includes('requests'));
```
After:
```js
assert.equal(h.document.querySelector('#section-nav [data-locate-waiting]').getAttribute('aria-label'),'Projects, 1 waiting for you');assert(!h.document.querySelector('#section-nav').textContent.includes('requests'));
```

**`M3.1 waiting line separates summary, marker and link in every layout`** — D13 (1): the card keeps its own Waiting for you marker on a separate line, without the generic classic link.

Before:
```js
assert.equal(line.textContent,'! Waiting for you · Open in classic dashboard');
    assert.equal(line.querySelector('a').getAttribute('href'),'/classic');
```
After:
```js
assert.equal(line.textContent,'! Waiting for you');
    assert.equal(line.querySelector('a'),null);
```

**Retired:** `M3.1 rail counts use the M6 session union and current count wording`

```js
test('M3.1 rail counts use the M6 session union and current count wording',async()=>{
  const state=fixture();state.runs=Array.from({length:30},(_,i)=>({...state.run,id:'rail:'+i}));
  const channels=fx.threadChannels(fx.threadActive(),1);channels.channels[0].sessions=47;
  const h=await harness(state,{channels});assert.equal(h.document.querySelectorAll('#session-list a').length,31);
  assert(h.document.querySelector('#session-list a[href="#/s/run_test"]'));
  const note=h.document.querySelector('#session-list + .muted');assert(note);assert.equal(note.textContent,'Showing 31 of 47 sessions');
 …[truncated; exact text in the commit diff]
```

**`M4 Basic/Advanced Settings and unavailability reasons disclose progressively`** — D13 (4): the Settings sheet's classic sentences become 'Set in Settings › Classic dashboard' with an in-app link.

Before:
```js
assert(h.document.querySelector('#settings-sheet').textContent.includes('Paid models and the stuck watch: set them in the classic dashboard'));
```
After:
```js
assert(h.document.querySelector('#settings-sheet').textContent.includes('Paid models and the stuck watch: set in Settings › Classic dashboard'));assert.equal(h.document.querySelectorAll('#settings-sheet a[href^="/classic"]').length,0);assert(h.document.querySelectorAll('#settings-sheet a[href="#/settings"][data-setting-link="Classic dashboard"]').length>=1);
```

**`M5 no controls on historical, expired, decided or unsupported actions`** — D13 (4): an unsupported action is a card that cannot be reviewed here; it keeps the card's own classic fallback instead of the removed generic link.

Before:
```js
assert.equal(decisionCard(h,'m5:unknown').querySelector('a[href="/classic"]').textContent,'Open in classic dashboard');
```
After:
```js
assert.equal(decisionCard(h,'m5:unknown').querySelector('a[href="/classic"]').textContent,'Open in classic');assert.match(decisionCard(h,'m5:unknown').querySelector('.review-unavailable').textContent,/^Cannot review this approval here · Open in classic$/);
```

**`M5 waiting pointer prefers the first non-outcome actionable card`** — locateWaiting moves from the pointer to the Projects count; the same first non-outcome card is located.

Before:
```js
h.document.querySelector('#waiting-pointer').click();await tick();assert(decisionCard(h,'m5:low').classList.contains('focused'));
```
After:
```js
h.document.querySelector('[data-locate-waiting]').click();await tick();assert(decisionCard(h,'m5:low').classList.contains('focused'));
```

**`M6 proposed agents never become live members and the panel has no decisions`** — the panel roster and its 'Team plan pending' line are retired (no member list in the panel); the proposed plan stays asserted in Session details below.

Before:
```js
assert(!h.document.querySelector('#rail .members').textContent.includes('coder-'));assert(h.document.querySelector('#rail').textContent.includes('Team plan pending'));
```
After:
```js
assert.equal(h.document.querySelector('#rail .members'),null);assert(!h.document.querySelector('#rail').textContent.includes('coder-'));
```

**`openMembers (helper)`** — D13: Session details opens only from Details, so the helper presses Details after following the #/s/ link.

Before:
```js
async function openMembers(h,id='run_test') {h.window.location.hash='#/s/'+id;h.shell.route();await h.runTimers(0);await tick();await tick();h.document.querySelector('#members-tab').click();await tick();}
```
After:
```js
async function openMembers(h,id='run_test') {h.window.location.hash='#/s/'+id;h.shell.route();await h.runTimers(0);await tick();await tick();if(h.document.querySelector('#context').hidden)h.document.querySelector('#open-context').click();h.document.querySelector('#members-tab').click();await tick();}
```

**Retired:** `M8 A rail disclosure is accurate while incomplete and disappears only at completion including paging`

```js
test('M8 A rail disclosure is accurate while incomplete and disappears only at completion including paging',async()=>{
  const f=fx.membersHistory();f.channels.channels[0].sessions=40;f.older.before='members:last';const sessions=Array.from({length:5},(_,i)=>fx.threadSession('history:'+(35+i),{created:new Date(Date.UTC(2026,8,30,0,0,-35-i)).toISOString()})),last=fx.threadResponse(sessions.map(s=>fx.threadMessage('run:'+s.id,'session_start',s.title,{}, {session:s.id,at:s.created})),sessions);
  const h=await harness(f.state,{thread:f.thread,channels:f.channels,respond:url=>url.includes('before=m …[truncated; exact text in the commit diff]
```

**`M8 B truncated room and rail titles retain the full server value`** — the rail title is retired (D13 (2)) and the header context is now the project directory (§2); the room title keeps its full value, and the session title keeps its full escaped value in its thread block.

Before:
```js
  assert.equal(h.document.querySelector('#room-header h1').title,title);assert.equal(h.document.querySelector('#room-header .heading p').title,title);
  assert.equal(h.document.querySelector('#session-list .truncate').title,title);assert.equal(h.document.querySelectorAll('#room-header img,#session-list img').length,0);
```
After:
```js
  assert.equal(h.document.querySelector('#room-header h1').title,title);assert.equal(h.document.querySelector('#room-header .room-context .directory').title,h.core.getState().state.project);
  assert.equal(h.timeline.querySelector('.session-divider .session-title').textContent,title);assert.equal(h.document.querySelectorAll('#room-header img,#rail img,#timeline .session-divider img').length,0);
```

**`M8 C phone rail and context sheets trap focus and restore visible openers`** — Refresh moved from the panel into Open folder… (D13); the trap is checked with the panel's last focusable control.

Before:
```js
last=h.document.querySelector('#refresh-folders');
```
After:
```js
last=h.document.querySelector('#panel-search');
```

**`M8 D decorative state symbols are hidden while recorded labels and list semantics remain`** — the sessions list is retired; the panel's project list keeps list semantics.

Before:
```js
assert.equal(h.document.querySelector('#session-list').getAttribute('role'),'list');
```
After:
```js
assert.equal(h.document.querySelector('#project-list').getAttribute('role'),'list');
```

**`M8 D decorative state symbols are hidden while recorded labels and list semantics remain`** — the pointer's decorative symbol moves to the Projects count, which keeps its symbol aria-hidden behind the full accessible name.

Before:
```js
assert(h.document.querySelector('#waiting-pointer [aria-hidden="true"]'));
```
After:
```js
assert(h.document.querySelector('#section-nav .projects-badge[aria-hidden="true"]'));
```

**Retired:** `M9 N1 cached sessions exceeding the server total do not show an incomplete-history disclosure`

```js
test('M9 N1 cached sessions exceeding the server total do not show an incomplete-history disclosure',async()=>{
  const state=fixture(),channels=fx.threadChannels(fx.threadActive(),0);
  state.runs=[{...state.run,id:'live-project-session'}];channels.channels[0].sessions=1;
  const h=await harness(state,{channels}),snapshot=h.core.getState(),ids=[...h.document.querySelectorAll('#session-list a')].map(a=>a.getAttribute('href'));
  assert.equal(ids.length,2);assert(ids.includes('#/s/live-project-session'));assert(ids.includes('#/s/run_test'));
  assert.equal(snapshot.channels.channels[0].sessions …[truncated; exact text in the commit diff]
```

**Retired:** `M9.1 B rail waiting is always findable and exactly matches channel counts`

```js
test('M9.1 B rail waiting is always findable and exactly matches channel counts',async()=>{
 const h=await decisionHarness('critical');for(const count of [0,1,2]){h.f.channels.channels[0].waiting=count;await h.core.refresh();const line=h.document.querySelector('#rail-waiting');assert(line,'Waiting line remains present');assert.equal(line.textContent,count?'! '+count+' waiting for you':'Nothing is waiting for you');assert.equal(!!line.querySelector('a'),count>0);assert.equal(h.core.getState().channels.channels[0].waiting,count);}assert.equal(h.document.querySelectorAll('#rail [data-decision]'). …[truncated; exact text in the commit diff]
```

**`M9.1 B rail waiting uses locateWaiting and reveals the room after closing the phone drawer`** — the panel waiting link is retired; locateWaiting is reached from the phone bar's Projects count in another section, with the same located, closed-drawer and focused-card assertions.

Before:
```js
h.document.querySelector('#open-rail').click();const link=h.document.querySelector('#rail-waiting a');assert(link);link.click();
```
After:
```js
section(h,'settings');const link=h.document.querySelector('#bottom-nav [data-locate-waiting]');assert(link);link.click();
```

**`M9.1 B rail and session menu link only the active recorded members to their Workspaces`** — the panel roster is retired; the roster entry links are asserted in Session details' roster (today's per-run roster).

Before:
```js
 const h=await membersHarness('teamRunning'),run=h.f.state.run.id;for(const member of h.f.state.agents){const href='#/w/'+encodeURIComponent(run)+'/'+encodeURIComponent(member.name),rail=h.document.querySelector('#rail [data-member="'+member.name+'"] [data-workspace-link]')
```
After:
```js
 const h=await membersHarness('teamRunning'),run=h.f.state.run.id;await openMembers(h);assert.equal(h.document.querySelectorAll('#rail [data-member]').length,0);for(const member of h.f.state.agents){const href='#/w/'+encodeURIComponent(run)+'/'+encodeURIComponent(member.name),rail=h.document.querySelector('#context [data-member="'+member.name+'"] [data-workspace-link]')
```

**`M9.1 B rail and session menu link only the active recorded members to their Workspaces`** — same no-run-together and no-decision checks, in the roster's new location.

Before:
```js
assert(!h.document.querySelector('#rail').textContent.includes('youOpen'));assert.equal(h.document.querySelectorAll('#rail [data-decision],#session-menu [data-decision]').length,0);
```
After:
```js
assert(!h.document.querySelector('#context').textContent.includes('youOpen'));assert.equal(h.document.querySelectorAll('#rail [data-decision],#context [data-decision],#session-menu [data-decision]').length,0);
```

**`M9.1 B proposed-only, stopping and never-approved expired agents get no entry links`** — the panel waiting line is retired (D13 (1)); the no-entry-link assertions are unchanged.

Before:
```js
h=await harness(f.state,{thread:f.thread,channels:f.channels});assert(h.document.querySelector('#rail-waiting'));for(
```
After:
```js
h=await harness(f.state,{thread:f.thread,channels:f.channels});for(
```

**`M9.1 B empty and quiet rooms explain the existing decision cards without another decision surface`** — the guidance no longer mentions the removed waiting bar; it names the Projects count.

Before:
```js
 const guidance='Approvals and questions from agents appear here as cards, with a "waiting for you" bar above the message box.';
```
After:
```js
 const guidance='Approvals and questions from agents appear here as cards. The count on Projects takes you to the first one.';
```

**`M9.1 B Workspace navigation from the drawer restores its visible opening link without a write`** — the drawer roster is retired; the same Turn details round trip starts from the phone Session details sheet and returns to that sheet and its opening link.

Before:
```js
 const h=await membersHarness('teamRunning',{coarse:true});h.document.querySelector('#open-rail').click();await tick();await tick();const opener=h.document.querySelector('#rail [data-member="coder-1"] [data-workspace-link]');assert(opener);opener.focus();const n=h.calls.length;opener.click();await tick();assert.equal(h.window.location.hash,'#/w/run_test/coder-1');assert(!h.document.querySelector('#app').classList.contains('rail-open'));h.document.querySelector('[data-back-room]').click();await tick();assert(h.document.querySelector('#app').classList.contains('rail-open'));
```
After:
```js
 const h=await membersHarness('teamRunning',{coarse:true});await openMembers(h);const opener=h.document.querySelector('#context [data-member="coder-1"] [data-workspace-link]');assert(opener);opener.focus();const n=h.calls.length;opener.click();await tick();assert.equal(h.window.location.hash,'#/w/run_test/coder-1');assert(h.document.querySelector('#context').hidden);h.document.querySelector('[data-back-room]').click();await tick();assert(!h.document.querySelector('#context').hidden);
```

**`M9.1a F3 returning to a selected session preserves its previously closed context sheet`** — D13: the acx-context-open preference is removed and never written.

Before:
```js
assert.equal(h.local.get('acx-context-open'),'false');
```
After:
```js
assert.equal(h.local.has('acx-context-open'),false);
```

**`N1 Projects current pinned, escaped browse, breadcrumb requests and client-only search`** — D13: the panel lists git projects only, with the current project first; non-git folders, breadcrumbs and Refresh moved into Open folder…, where escaping, the 'Team sessions need git' label and the exact browse request are asserted.

Before:
```js
await folders(h);assert.equal(h.document.querySelectorAll('#project-folders img').length,0);assert(h.document.querySelector('#current-project'));assert.match(h.document.querySelector('#project-folders').textContent,/Team sessions need git/);const before=h.calls.length,input=h.document.querySelector('#panel-search');input.value='safe';input.dispatchEvent(new h.window.Event('input',{bubbles:true}));assert(h.document.querySelector('[data-select-project="0"]').parentElement.hidden);assert.equal(h.calls.length,before);h.document.querySelector('[data-browse-path="/tmp/safe"]').click();await tick();assert(h.calls.some(c=>c.url==='/api/projects/browse?path=%2Ftmp%2Fsafe'));
```
After:
```js
await folders(h);assert.equal(h.document.querySelectorAll('#rail img').length,0);assert(h.document.querySelector('#current-project'));assert.equal(h.document.querySelector('#project-list').firstElementChild.id,'current-project');assert(!h.document.querySelector('#rail').textContent.includes('Team sessions need git'));assert.equal(h.document.querySelector('[data-select-project="0"]'),null);assert(h.document.querySelector('[data-select-project="1"]'));const before=h.calls.length,input=h.document.querySelector('#panel-search');input.value='safe';input.dispatchEvent(new h.window.Event('input',{bubbles:true}));assert(h.document.querySelector('#current-project').hidden);assert(!h.document.querySelector('[data-select-project="1"]').parentElement.hidden);assert.equal(h.calls.length,before);
 h.document.querySelector('#project-add-button').click();h.document.querySelector('#open-folder').click(); …[truncated; exact text in the commit diff]
```

**`N1 project confirmation traps focus, Escape restores its live panel opener and writes nothing`** — Create project now sits in the panel's + menu (D13); choosing it closes the menu, so the dialog's live opener is the + button, and Escape restores focus there.

Before:
```js
 const h=await harness(fixture(),{coarse:true});await folders(h);const opener=h.document.querySelector('#create-project');opener.focus();opener.click();
```
After:
```js
 const h=await harness(fixture(),{coarse:true});await folders(h);h.document.querySelector('#project-add-button').click();const opener=h.document.querySelector('#project-add-button'),choice=h.document.querySelector('#create-project');choice.focus();choice.click();assert(h.document.querySelector('#project-add-menu').hidden,'the + menu closes on a choice');
```

**Retired:** `N1.1 Projects header and summary use the recorded singular and plural session counts`

```js
test('N1.1 Projects header and summary use the recorded singular and plural session counts',async()=>{
 const h=await harness();for(const count of [1,2,0]){h.core.getState().channels.channels[0].sessions=count;h.shell.render(h.core.getState());for(const selector of ['#room-header .heading p','#project-summary']){const text=h.document.querySelector(selector).textContent;assert(text.includes(count+' '+(count===1?'session':'sessions')));if(count===1)assert(!text.includes('1 sessions'));}}
});
```

**Retired:** `M6 rail paging grows the shared room cache and reports exact X/N counts`

```js
test('M6 rail paging grows the shared room cache and reports exact X/N counts',async()=>{
  const f=fx.membersHistory(),h=await harness(f.state,{thread:f.thread,channels:f.channels,respond:url=>url.includes('before=members%3Aolder')?f.older:undefined});assert.equal(h.document.querySelectorAll('#session-list a').length,30);assert.equal(h.document.querySelector('#session-count').textContent,'Showing 30 of 35 sessions');h.document.querySelector('#load-earlier-sessions').click();await tick();await tick();assert.equal(h.document.querySelectorAll('#session-list a').length,35);assert.equal(!!h.docume …[truncated; exact text in the commit diff]
```

### Appendix B — exact browser matrix changes (`chat_screenshots.cjs`)

New helpers (`composerSound`, `n12Cases`) and the rewritten `clippedControls` are in the diff; below are the replaced statements.

**cutoverSmoke** — D13 (1): the waiting pointer is retired; the room is ready when the Projects count shows the fixture's waiting items.

Before:
```js
await room.locator('#waiting-pointer').waitFor();
```
After:
```js
await room.locator('[data-locate-waiting]:visible').first().waitFor();
```

**n1Fixture** — D13 (1): readiness waits for the Projects count instead of the retired pointer.

Before:
```js
await page.locator('#connect-form button').click();await page.locator('#waiting-pointer').waitFor();const fixtureRoot
```
After:
```js
await page.locator('#connect-form button').click();await page.locator('[data-locate-waiting]:visible').first().waitFor();const fixtureRoot
```

**n1Fixture** — D13: the panel lists projects (current first) instead of a folder browser; Create project is in the + menu.

Before:
```js
await page.locator('#open-rail').click();await page.waitForFunction(()=>document.getElementById('project-folders').textContent.includes('Folders in /tmp/agentcontrol-device-'));await page.locator('#create-project').click();
```
After:
```js
await page.locator('#open-rail').click();await page.waitForFunction(()=>document.getElementById('current-project') && !document.querySelector('#rail p[role="status"]'));assert.equal(await page.locator('#current-project .directory').textContent(),original);await page.locator('#project-add-button').click();await page.locator('#create-project').click();
```

**n1Fixture** — D13: switching back activates the original project's row in the project list (same confirmation and POST).

Before:
```js
await page.locator('#open-rail').click();await page.locator('#project-folders [data-select-project]').first().waitFor();await page.locator('#project-folders [data-select-project]').evaluateAll((nodes,path)=>nodes.find(n=>n.parentElement.querySelector('[data-browse-path]').dataset.browsePath===path).click(),original);
```
After:
```js
await page.locator('#open-rail').click();await page.locator('#project-list [data-select-project]').first().waitFor();await page.locator('#project-list [data-select-project]').evaluateAll((nodes,path)=>nodes.find(n=>n.querySelector('.directory').textContent===path).click(),original);
```

**deviceDiscoveryCases** — the panel waiting line and drawer roster are retired (D13 (1), §2): the Projects count is checked and activated instead, and the Turn details round trip starts from Session details' roster.

Before:
```js
   await page.locator('#open-rail').click();assert.equal(await page.locator('#rail-waiting').textContent(),'! 2 waiting for you');assert.equal(await page.locator('#rail [data-decision]').count(),0);await layoutCheck(page,'device-waiting-rail',size,width);await page.locator('#rail-waiting').scrollIntoViewIfNeeded();await page.screenshot({animations:'disabled',path:path.join(out,'device-waiting-rail-'+size+'-'+colorScheme+'.png')});shots++;
   const railLink=page.locator('#rail [data-member="coder-1"] [data-workspace-link]');assert.equal(await railLink.getAttribute('href'),'#/w/run_test/coder-1');await railLink.click();await page.locator('#workspace:not([hidden])').waitFor();assert.equal(await page.locator('#app').evaluate(n=>n.classList.contains('rail-open')),false);await page.locator('[data-back-room]').click();await page.locator('#app.rail-open').waitFor();assert(await railLink.evaluate …[truncated; exact text in the commit diff]
```
After:
```js
   const count=page.locator('[data-locate-waiting]:visible').first();assert.equal(await count.getAttribute('aria-label'),'Projects, 2 waiting for you');assert.equal(await count.locator('.projects-badge').textContent(),'! 2');await page.locator('#open-rail').click();assert.equal(await page.locator('#rail [data-decision]').count(),0);assert(!/waiting/i.test(await page.locator('#rail').textContent()));await layoutCheck(page,'device-waiting-count',size,width);await page.screenshot({animations:'disabled',path:path.join(out,'device-waiting-count-'+size+'-'+colorScheme+'.png')});shots++;await page.keyboard.press('Escape');
   await page.locator('#open-context').click();await page.locator('#members-tab').click();const railLink=page.locator('#context [data-member="coder-1"] [data-workspace-link]');assert.equal(await railLink.getAttribute('href'),'#/w/run_test/coder-1');await railLink.click();awai …[truncated; exact text in the commit diff]
```

**deviceViewportCases pinch** — the waiting pointer is retired; the frozen-geometry check covers the whole composer row instead.

Before:
```js
const selectors=['#app','#room-footer','#composer','#send-message','#composer-target','#waiting-pointer'];
```
After:
```js
const selectors=['#app','#room-footer','#composer','#send-message','#composer-target','.composer-row'];
```

**deviceViewportCases context sheet** — D13: a #/s/ link no longer opens Session details; the sheet is opened from Details.

Before:
```js
await page.evaluate(()=>{location.hash='#/s/run_test';AC.shell.route();});await page.locator('#context:not([hidden])').waitFor();
   await check('context sheet within panned viewport'
```
After:
```js
await page.evaluate(()=>{location.hash='#/s/run_test';AC.shell.route();});await page.locator('#open-context').click();await page.locator('#context:not([hidden])').waitFor();
   await check('context sheet within panned viewport'
```

**accessibilitySpots** — D13: Session details is opened from Details after the #/s/ link.

Before:
```js
await page.goto('http://agentcontrol.test/chat#/s/run_test');await page.locator('#context:not([hidden])').waitFor();await page.evaluate(()=>AC.core.stop());
   if(mode==='reduced-motion'){
```
After:
```js
await page.goto('http://agentcontrol.test/chat#/s/run_test');await page.locator('#open-context').click();await page.locator('#context:not([hidden])').waitFor();await page.evaluate(()=>AC.core.stop());
   if(mode==='reduced-motion'){
```

**accessibilitySpots reduced motion** — the pointer is retired; the Projects count locates the card (Session details, now a modal overlay, is closed first).

Before:
```js
    await page.locator('#waiting-pointer').click();assert.equal(await page.locator('.focused[data-message]').evaluate(n=>parseFloat(getComputedStyle(n).outlineWidth)),2);
```
After:
```js
    await page.locator('#close-context').click();await page.locator('[data-locate-waiting]:visible').first().click();assert.equal(await page.locator('.focused[data-message]').evaluate(n=>parseFloat(getComputedStyle(n).outlineWidth)),2);
```

**phonePanelCases** — D13: Session details is opened from Details after the #/s/ link.

Before:
```js
await page.goto('http://agentcontrol.test/chat#/s/run_test');await page.locator('#context:not([hidden])').waitFor();await page.evaluate(()=>AC.core.stop());await page.locator('#members-tab').click();await page.locator('.task-graph')
```
After:
```js
await page.goto('http://agentcontrol.test/chat#/s/run_test');await page.locator('#open-context').click();await page.locator('#context:not([hidden])').waitFor();await page.evaluate(()=>AC.core.stop());await page.locator('#members-tab').click();await page.locator('.task-graph')
```

**keyboardPaths typed-approve/deny-redirect** — the pointer is retired; the unchanged server count is read from the Projects count.

Before:
```js
assert.equal(await page.locator('#waiting-pointer').textContent(),'! 1 waiting for you');assert.equal(await page.locator('[data-actionable]').count(),1,
```
After:
```js
assert.equal(await page.locator('[data-locate-waiting]:visible').first().getAttribute('aria-label'),'Projects, 1 waiting for you');assert.equal(await page.locator('[data-actionable]').count(),1,
```

**keyboardPaths workspace/context-tabs** — the rail session link is retired (D13 (2)): the keyboard follows the session's thread link, then opens Session details from Details (a modal at every width, focus starting on Close).

Before:
```js
    if(width<1200){await keyboardFocus(page,'#open-rail',true);await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>document.activeElement.id),'close-rail');}
    await keyboardFocus(page,'#session-list a[href="#/s/run_test"]');await page.keyboard.press('Enter');await page.locator('#context:not([hidden])').waitFor();await keyboardFocus(page,'#session-tab',width<1200);
```
After:
```js
    if(width<1200){await keyboardFocus(page,'#open-rail',true);await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>document.activeElement.id),'close-rail');await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.activeElement.id),'open-rail');}
    await keyboardFocus(page,'.session-divider a[href="#/s/run_test"]');await page.keyboard.press('Enter');await page.waitForFunction(()=>AC.core.getState().focused==='run_test');assert(await page.locator('#context').isHidden(),'A session link never opens Session details');await keyboardFocus(page,'#open-context',true);await page.keyboard.press('Enter');await page.locator('#context:not([hidden])').waitFor();assert.equal(await page.evaluate(()=>document.activeElement.id),'close-context');await keyboardFocus(page,'#session-tab',true);
```

**matrix decision phone** — locateWaiting moves from the pointer to the Projects count (phone bottom bar).

Before:
```js
      await page.locator('#waiting-pointer').click();await page.waitForFunction(id=>document.querySelector('[data-message="'+id+'"]').classList.contains('focused'),actionable.id);
```
After:
```js
      await page.locator('[data-locate-waiting]:visible').first().click();await page.waitForFunction(id=>document.querySelector('[data-message="'+id+'"]').classList.contains('focused'),actionable.id);
```

**matrix decisionSent/decision409** — the unchanged server count is read from the Projects count.

Before:
```js
assert.equal(await page.locator('#waiting-pointer').textContent(),'! 1 waiting for you');}
```
After:
```js
assert.equal(await page.locator('[data-locate-waiting]:visible').first().getAttribute('aria-label'),'Projects, 1 waiting for you');}
```

**matrix members** — D13: Session details is opened from Details after the #/s/ link.

Before:
```js
    await page.evaluate(id=>location.hash='#/s/'+id,state.run.id);await page.locator('#context:not([hidden])').waitFor();await page.locator('#members-tab').click();
```
After:
```js
    await page.evaluate(id=>location.hash='#/s/'+id,state.run.id);await page.locator('#open-context').click();await page.locator('#context:not([hidden])').waitFor();await page.locator('#members-tab').click();
```

**matrix teamProposed** — the panel roster is retired (no member list in the panel); the one recorded member stays asserted in Session details.

Before:
```js
assert.equal(await page.locator('#rail .members [data-member]').count(),1);
```
After:
```js
assert.equal(await page.locator('#rail .members').count(),0);
```

**matrix connections/railPaged** — railPaged no longer opens the drawer: the panel has no sessions list.

Before:
```js
    if(name==='connections' || name==='railPaged'){await page.locator('#close-context').click();if(width<1200)await page.locator('#open-rail').click();}
```
After:
```js
    if(name==='connections' || name==='railPaged'){await page.locator('#close-context').click();if(width<1200 && name==='connections')await page.locator('#open-rail').click();}
```

**matrix railPaged** — D13 (2): the rail sessions list and its paging are retired; the same shared cache is paged from the thread's Load earlier until all five older sessions have thread blocks and history is complete, and the panel shows none of them.

Before:
```js
    if(name==='railPaged'){await page.locator('#load-earlier-sessions').click();await page.waitForFunction(()=>document.querySelectorAll('#session-list a').length===35);assert.equal(await page.locator('#session-count').count(),0);await page.locator('#session-list a').last().scrollIntoViewIfNeeded();}
```
After:
```js
    if(name==='railPaged'){await page.locator('#load-earlier').click();await page.waitForFunction(()=>Array.from({length:5},(_,i)=>'history:'+(30+i)).every(id=>AC.core.getState().thread.sessions[id] && document.querySelector('.session-divider[data-session="'+id+'"]')) && AC.core.getState().thread.before===null);assert.equal(await page.locator('#rail a[href^="#/s/"],#rail [data-session],#session-count,#load-earlier-sessions').count(),0);await page.locator('.session-divider').first().scrollIntoViewIfNeeded();}
```

**matrix workspace desktop** — the waiting strip is retired; the composer beside Turn details is checked for overlap and clipping instead (N1.2 composer rule).

Before:
```js
assert(await page.locator('#waiting .waiting-strip').evaluateAll(nodes=>nodes.every(n=>getComputedStyle(n).flexWrap==='nowrap')),'M8 waiting strip stays on one line');}
```
After:
```js
await composerSound(page,name+'/'+size+' beside Turn details');}
```

**matrix workspace compact desktop** — the waiting strip is retired; the composer beside Turn details at 1200px is checked for overlap and clipping instead.

Before:
```js
assert(await page.locator('#waiting .waiting-strip').evaluate(n=>n.scrollWidth<=n.clientWidth),'Waiting pointer and recovery link must fit beside Workspace');
```
After:
```js
await composerSound(page,name+' compact desktop beside Turn details');
```

**matrix phone footer** — D13 (1) removes the waiting strip and §2 makes the phone composer two rows below a 600px room: the portrait footer keeps D10's 112px ceiling and the 55% conversation floor; the strip-height and pointer/link alignment checks go with the strip. Equal idle and waiting footers are asserted in the N1.2 cases and the device keyboard check.

Before:
```js
  if(size==='phone' && name!=='connections'){const heights=await page.evaluate(()=>({footer:document.getElementById('room-footer').getBoundingClientRect().height,waiting:document.querySelector('#waiting .waiting-strip')?.getBoundingClientRect().height || 0,timeline:document.getElementById('timeline').getBoundingClientRect().height,viewport:innerHeight}));measurements.push({name,size,colorScheme,...heights});assert(heights.footer <= (heights.waiting?112:72),`${name} footer ${heights.footer}`);assert(heights.waiting<=40 && (!heights.waiting || heights.waiting>=32),`${name} waiting row ${heights.waiting}`);if(heights.waiting){const baseline=await page.evaluate(()=>{const textTop=node=>{const range=document.createRange();range.selectNodeContents(node);return range.getBoundingClientRect().top;};return Math.abs(textTop(document.getElementById('waiting-pointer'))-textTop(document.querySelector( …[truncated; exact text in the commit diff]
```
After:
```js
  if(size==='phone' && name!=='connections'){const heights=await page.evaluate(()=>({footer:document.getElementById('room-footer').getBoundingClientRect().height,waitingItems:AC.core.getState().channels?.channels?.[0]?.waiting || 0,strip:document.querySelectorAll('#waiting,.waiting-strip').length,timeline:document.getElementById('timeline').getBoundingClientRect().height,viewport:innerHeight}));measurements.push({name,size,colorScheme,...heights});assert.equal(heights.strip,0,`${name} has no waiting strip`);assert(heights.footer<=112,`${name} footer ${heights.footer}`);assert(heights.timeline>=heights.viewport*.55,`${name} timeline ${heights.timeline}`);}
```

**matrix landscape footer** — with no waiting strip the landscape footer meets the idle 72px limit whether or not anything is waiting (D10, unchanged).

Before:
```js
const h=await page.evaluate(()=>({footer:document.querySelector('#room-footer').getBoundingClientRect().height,waiting:document.querySelector('#waiting .waiting-strip')?.getBoundingClientRect().height || 0,timeline:document.querySelector('#timeline').getBoundingClientRect().height,viewport:innerHeight}));measurements.push({name,size,colorScheme,...h});assert(h.footer<=(h.waiting?112:72),`${name} landscape footer ${h.footer}`);
```
After:
```js
const h=await page.evaluate(()=>({footer:document.querySelector('#room-footer').getBoundingClientRect().height,waitingItems:AC.core.getState().channels?.channels?.[0]?.waiting || 0,timeline:document.querySelector('#timeline').getBoundingClientRect().height,viewport:innerHeight}));measurements.push({name,size,colorScheme,...h});assert(h.footer<=72,`${name} landscape footer ${h.footer}`);
```

**matrix phone thread newest** — the pointer is retired; the phone bar's Projects count is visible while something waits.

Before:
```js
if(state.inbox.length)assert(await page.locator('#waiting').isVisible());}
```
After:
```js
if(state.inbox.length)assert(await page.locator('#bottom-nav [data-locate-waiting]').isVisible());}
```

**matrix decisionQuestion phone** — the pointer is retired: the command error must not cover the composer row, and the Projects count locates the question card.

Before:
```js
const notice=await page.locator('#composer-status').boundingBox(), pointer=await page.locator('#waiting-pointer').boundingBox();assert(notice.y+notice.height<=pointer.y,'Command errors must not cover the waiting pointer');await page.locator('#waiting-pointer').click();
```
After:
```js
const notice=await page.locator('#composer-status').boundingBox(), input=await page.locator('.composer-row').boundingBox();assert(notice.y+notice.height<=input.y+.5,'Command errors must not cover the composer');await page.locator('[data-locate-waiting]:visible').first().click();
```

**matrix context** — D13: Session details is opened from Details after the #/s/ link.

Before:
```js
await page.evaluate(id=>location.hash='#/s/'+id,state.run.id);await page.locator('#context:not([hidden])').waitFor();assert.equal(await overflow(),false);
```
After:
```js
await page.evaluate(id=>location.hash='#/s/'+id,state.run.id);await page.locator('#open-context').click();await page.locator('#context:not([hidden])').waitFor();assert.equal(await overflow(),false);
```

**regression scrim/bogus** — the rail sessions list is retired; readiness waits for the thread's session blocks.

Before:
```js
  await page.locator('#session-list a').first().waitFor({state:'attached'});
```
After:
```js
  await page.locator('.session-divider').first().waitFor({state:'attached'});
```

**regression scrim/bogus stale** — D13: the stale preference and the #/s/ link leave Session details closed; it opens from Details, and Back still closes it with no scrim.

Before:
```js
   await page.evaluate(()=>location.hash='#/s/run_test');await page.locator('#context:not([hidden])').waitFor();
```
After:
```js
   await page.evaluate(()=>location.hash='#/s/run_test');await page.waitForFunction(()=>AC.core.getState().focused==='run_test');assert(await page.locator('#context').isHidden(),'A stale acx-context-open must not open Session details');await page.locator('#open-context').click();await page.locator('#context:not([hidden])').waitFor();
```

**n1Sections rail width** — D13 (5): the rail is sized in rem (5.25rem, 84px at the default 16px root) instead of 76px.

Before:
```js
else{assert.equal((await page.locator('#section-nav').boundingBox()).width,76);
```
After:
```js
else{assert.equal((await page.locator('#section-nav').boundingBox()).width,await page.evaluate(()=>5.25*parseFloat(getComputedStyle(document.documentElement).fontSize)));
```

**n1Fixture menu** — wait for the + menu before choosing Create project.

Before:
```js
await page.locator('#project-add-button').click();await page.locator('#create-project').click();
```
After:
```js
await page.locator('#project-add-button').click();await page.locator('#project-add-menu:not([hidden])').waitFor();await page.locator('#create-project').click();
```

**helper clippedControls** — N1.2 (D13 (5)): labels are one line and whole words; the bottom bar shows all labels or only the active one, so deliberately hidden inactive labels are skipped only by that rule, and every target stays at least 40px.

Before:
```js
async function clippedControls(page,name,zoom=false){
 const selectors=zoom?'button,summary,select,input:not([type="checkbox"]):not([type="radio"]),#section-nav a,#bottom-nav a,.target-chip':'#section-nav a,#bottom-nav a,.target-chip';
 const boxes=await page.locator(selectors).evaluateAll(nodes=>nodes.filter(n=>n.getClientRects().length).flatMap(n=>[n,...n.querySelectorAll('[data-section] > span:not(.projects-badge)')]).map(n=>({name:n.id || n.dataset.section || n.textContent.slice(0,30),scroll:n.scrollWidth,width:n.clientWidth,height:n.clientHeight,scrollHeight:n.scrollHeight})));
 boxes.sort((a,b)=>(b.name==='waiting-pointer')-(a.name==='waiting-pointer'));
 for(const box of boxes){assert(box.scroll<=box.width+1,name+' clipped control '+box.name+' '+JSON.stringify(box));assert(box.scrollHeight<=box.height+1,name+' vertically clipped control '+box.name+' '+JSON.stringify(box));}
 const …[truncated; exact text in the commit diff]
```
After:
```js
async function clippedControls(page,name,zoom=false){
 const selectors=zoom?'button,summary,select,input:not([type="checkbox"]):not([type="radio"]),#section-nav a,#bottom-nav a,.target-chip':'#section-nav a,#bottom-nav a,.target-chip';
 // N1.2: below 720px a crowded bar shows only the active label; the others are deliberately visually hidden (their names stay in aria-label).
 const shownLabel=n=>!n.closest('#bottom-nav.active-label-only') || !!n.closest('[aria-current]');
 const boxes=await page.locator(selectors).evaluateAll((nodes,shown)=>{const visible=new Function('return '+shown)();return nodes.filter(n=>n.getClientRects().length).flatMap(n=>[n,...[...n.querySelectorAll('[data-section] > span:not(.projects-badge)')].filter(visible)]).map(n=>({name:n.id || n.dataset.section || n.textContent.slice(0,30),scroll:n.scrollWidth,width:n.clientWidth,height:n.clientHeight,scrollHeight:n.scr …[truncated; exact text in the commit diff]
```

**helper clippedControls frame** — the bottom-bar label rule follows a ResizeObserver, which reports on the next frame; measure after two frames.

Before:
```js
async function clippedControls(page,name,zoom=false){
```
After:
```js
async function clippedControls(page,name,zoom=false){
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
```

**n1Sections projects** — Create project is in the + menu (D13): the menu is opened first; choosing closes it, and Escape on the dialog returns focus to + before the drawer closes.

Before:
```js
if(name==='projects'){if(width<1200)await page.locator('#open-rail').click();await page.locator('#create-project').click();assert(await page.locator('[data-cancel-project]').evaluate(n=>n===document.activeElement));await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.getElementById('project-dialog').open);assert(await page.locator('#create-project').evaluate(n=>n===document.activeElement));if(width<1200)await page.keyboard.press('Escape');}
```
After:
```js
if(name==='projects'){if(width<1200)await page.locator('#open-rail').click();await page.locator('#project-add-button').click();await page.locator('#create-project').click();assert(await page.locator('[data-cancel-project]').evaluate(n=>n===document.activeElement));await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.getElementById('project-dialog').open);assert(await page.locator('#project-add-button').evaluate(n=>n===document.activeElement),'the dialog returns focus to +');assert(await page.locator('#project-add-menu').isHidden());if(width<1200)await page.keyboard.press('Escape');}
```

**cutoverSmoke Turn details** — the panel roster is retired; the same coder-1 Turn details is opened from the session menu's Turn details link.

Before:
```js
  await room.locator('#rail [data-member="coder-1"] [data-workspace-link]').click();await room.locator('#workspace-terminal').waitFor();
```
After:
```js
  await room.locator('#session-menu > summary').click();await room.locator('#session-menu [data-workspace-link][href$="/coder-1"]').click();await room.locator('#workspace-terminal').waitFor();
```

**deviceViewportCases close keyboard** — §2: below a 600px room the composer is two rows, so the portrait phone footer is held to D10's 112px ceiling (landscape and tablet keep 72px); added: the footer with a waiting card equals the idle footer.

Before:
```js
assert(Math.abs(footer.y+footer.height-(height-(width<720?64:0)))<=1);assert(footer.height<=72);
```
After:
```js
assert(Math.abs(footer.y+footer.height-(height-(width<720?64:0)))<=1);assert(footer.height<=(width<600?112:72),'footer '+footer.height);assert.equal(footer.height,originalFooter.height,'with no waiting strip the waiting footer equals the idle footer');
```

**main n12 registration** — run the N1.2 cases first in every complete pass.

Before:
```js
try {if(!stateFilter){const n11=await n11Layout(browser,out);count+=n11.shots;n11Cases=n11.cases;
```
After:
```js
try {if(!stateFilter){const n12=await n12Cases(browser,out);count+=n12.shots;n12Count=n12.cases;const n11=await n11Layout(browser,out);count+=n11.shots;n11Cases=n11.cases;
```

**main counters** — count the N1.2 cases.

Before:
```js
let keyboardCases=0,deviceCases=0,discoveryCases=0,n11Cases=0;
```
After:
```js
let keyboardCases=0,deviceCases=0,discoveryCases=0,n11Cases=0,n12Count=0;
```

**main summary** — the N1.2 cases are counted in the regression total.

Before:
```js
${stateFilter?5:20+keyboardCases+deviceCases+discoveryCases+cutoverCases+n11Cases} regression cases passed
```
After:
```js
${stateFilter?5:20+keyboardCases+deviceCases+discoveryCases+cutoverCases+n11Cases+n12Count} regression cases passed
```

**focused n12 flag** — a focused diagnostic flag like --n11-layout-only; complete passes never use it.

Before:
```js
 if(process.argv.includes('--n11-layout-only')){
```
After:
```js
 if(process.argv.includes('--n12-only')){try{console.log(JSON.stringify(await n12Cases(browser,out)));}finally{await browser.close();}return;}
 if(process.argv.includes('--n11-layout-only')){
```


---

## Review of N1.2 — 2026-10-03 (Opus)

**Verdict: N1.2 is accepted.** The Projects screen now matches the owner's model: rail, project list, team thread,
composer, with details on demand and each approval rendered once. With this, N1's design acceptance is restored. No
Blocking or Should-fix findings. Reviewed `f135bb3` and `450165e` against `c26c882`, implemented by a separate Claude Code
session while Codex was out of usage. **No `.py`, Python test, classic or state file changed.**

| Check | Result (this review) |
|---|---|
| Browser matrix, normal pass | **540 combinations + 157 regressions, 830 screenshots** |
| Browser matrix, required 0.06em wide-font pass | **540 + 157, 830 screenshots** |
| Chat DOM / classic / routes | **278/278**, **82/82**, **4/4** |
| Python | **424, OK (skipped=6)**, first attempt; all 6 are gates |
| Retired tests | 6, each in a category the handoff authorised (sessions list and disclosure, rail waiting link, summary card). The pointer tests were rewritten to use the Projects count, not dropped |
| New DOM tests | 9, matching the handoff's list |

**Independent real-server probe** (isolated `device_fixture.py`, temporary root and throwaway key, 1280×800 and 390×844):
- `#waiting`, `#waiting-pointer`, `#rail-waiting-link` and `#project-summary` are absent. The panel contains only "Projects"
  and project rows.
- The **only** visible waiting cue outside the cards is the Projects badge, labelled "Projects, 2 waiting for you". The one
  other "2 waiting for you" text is `#waiting-live`, the 1×1px screen-reader-only polite announcement from M8; it is not
  drawn and is correct.
- No visible classic link on the Projects screen.
- No "Reconnecting…" while live. The harness renders show it only because the harness deliberately fails the live stream.
- Session details is closed on load **and after following a `#/s/<id>` link**.
- Zero POSTs and no page errors.

**Renders inspected against handoff §2, in both passes:**
- `n12-projects-1280-idle`, `-waiting`, `-details-open`
- `-390-waiting`, `-320-waiting`
- `-1280-zoom200-waiting`, `-zoom200-details-open`
- `n12-plus-menu`, `n12-open-folder`

What they show:
- At 200% the rail grows and labels stay whole words.
- At 320 and 390 the composer uses two rows and the bar shows icons plus the active label.
- Details is an overlay that does not reflow the thread.
- "+" offers Create project and Open folder….

**Decisions the implementer flagged, all accepted:**
- **Phone portrait footer.** It is 103px (previously 57px idle and 105px waiting), and the old portrait 72px idle limit is
  now 112px. This follows directly from the handoff's two-row composer below a 600px room. D10's portrait rule
  (conversation at least 55%) holds at about 73%. Landscape stays at 59px, within D10's 72px. Recorded in the architecture
  change log.
- **The "Cannot review this approval here · Open in classic" fallback** appears only on cards whose action this screen
  cannot perform, as D13 allows.
- **Details** covers the active session when none is selected. Route changes close it; returning from Turn details restores
  it.
- **The Agents section's "Session details" link** now focuses the Details button instead of opening the panel itself.

**Optional, for the owner's judgement; not blocking:**
- **O8.** A session block's header still shows the session's recorded status, "! Waiting · just now". It is the session
  state, not the approval, but it can read as a second marker. If preferred, the header could show "Waiting" without the
  "!" symbol and leave the "!" to the card.
- **O9.** Session details' Team tab shows "Go to waiting item" for the member awaiting you. It is visible only while the
  details are open on demand, but it is another pointer.
- **O10.** The session block's title and status sit flush against its left border (no inner padding). Cosmetic, and it
  predates N1.2.
- O1, O3 and O4 from the N1 review remain. O6 and O7 are superseded.

**No physical-device testing is claimed.** A phone recheck of the new screen is advisable before treating native behaviour
as verified.
