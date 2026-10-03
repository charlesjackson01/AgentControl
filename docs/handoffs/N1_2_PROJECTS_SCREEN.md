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
- The eight-step real-server walkthrough. Same POST bodies and counts; GETs equal to or fewer than N1's, with any difference
  explained.

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
