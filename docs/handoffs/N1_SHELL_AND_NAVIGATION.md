# N1: Shell and navigation (presentation pass)

**Status: READY FOR CODEX.** Its start conditions were met on 2026-10-03, when the owner approved **P-1, P-11 (a), P-12,
P-13, P-14 and the milestone sequence** (recorded as D8–D12 and §12.2 in `docs/REDESIGN_ARCHITECTURE.md`). P-11 is
**option (a): dark-only**. No other N decision is approved; nothing in N1 may depend on P-2 to P-10 or P-15.

Codex implements, then Opus reviews. Work on `feature/chat-first-redesign`. Do not merge into `main`.

**Inputs:**
- `docs/PERSISTENT_AGENTS_ARCHITECTURE.md` (§11 and §12)
- `docs/inputs/agentcontrol-ui-handoff1.md` (behaviour)
- `docs/inputs/agentcontrol-ui.html` (visual reference only; **copy none of its code**)
- `docs/PERSISTENT_AGENTS_ACCEPTANCE.md` (acceptance and regression)

## 1. Outcome

The chat at `/` gets the handoff's six-section shell (Primary, Agents, Projects, Workspace, Skills, Settings), built **only from
data and endpoints that exist today**.
- Every working feature of the accepted M9 chat keeps working, in a stated new place (§5).
- Projects becomes the home of the existing project room (the team thread). Project switching and creation become native, using
  the existing endpoints.
- Primary, Agents, Workspace file browsing, skill assignment and memory show honest "not available yet" states. Nothing is
  faked.

## 2. Hard rules

1. **No backend change.** No `.py` file changes, and no Python test changes. No new endpoint, route, table, migration or file
   written on the server.
2. **Endpoints.** Chat may use only today's endpoints plus these existing ones, all behind the same key:
   - `GET /api/projects/browse` and `GET /api/skills`
   - `POST /api/projects/select` (`{path}`) and `POST /api/projects/create` (`{name}`)

   Every other request chat makes stays exactly as in M9.
3. **No records, no sample data.** No agent, project, membership or memory record is created or implied. None of the names
   Grok, Atlas, Codex, Muse, Sentinel, "Parking lot model" or "Hermes local" appears in the product. UI copy names no
   milestone codes; it says "Not available yet" in plain words.
4. **Approvals unchanged.** Request cards, decision dialogs, the waiting strip and pointer, typed confirmation, remember, deny
   and redirect, 409 handling and idempotent taps behave exactly as accepted. They live in the Projects team thread.
5. **Invariants 3, 4, 6, 7 and 8 hold:**
   - no text in an agent's voice
   - step material only in Turn details; reasoning never shown
   - the API acts as you
   - no logging of goal text
   - no CDN, web fonts, framework or build step
6. **Escaping.** Every server or user string rendered (folder names, paths, skill names and descriptions, errors) goes through
   the existing escaping (`e()` / `model.esc`). No unescaped `innerHTML`.
7. **Classic is untouched.** No change to `index.html`, `app.js`, `workspace.js`, `app.css`, `workspace.css` or `themes.css` at
   the repository root of `agent-autonomy/`.
8. **Requests stay as they are.** No new requests in the room's steady state. Browse and skills are fetched only when their
   section or panel opens, or on an explicit refresh. They are serialised with the existing read controls and never polled.
9. **Writes.** The two new POSTs use the existing shared write lock (`writeOwner`), send one request per activation, and show the
   server's refusal text verbatim.

## 3. Shell

| Width | Layout |
|---|---|
| ≥ 1200px | Three columns: **rail 76px**, **secondary panel 300px**, **stage** |
| 720–1199px | Rail 76px plus stage. The secondary panel is an overlay drawer (≤ 320px) opened from a top-bar button (`aria-expanded`, `aria-controls`), with a focus trap and Escape |
| < 720px | Stage plus a **bottom bar** (the same six items). The secondary panel opens as a sheet over the stage from the top-bar button, using M8's focus-trap mechanics. The bottom bar is hidden while the on-screen keyboard is open (reuse M9.1's `visualViewport` handling) and respects safe-area insets |

**Rail and bottom bar**
- Items, in order: **Primary, Agents, Projects, Workspace, Skills, Settings**. Each is an inline SVG icon plus a short label, with
  no icon font.
- The active item has a light fill **and** white label text (the inactive label is muted), plus `aria-current="page"`.
- Every item is a real link or button with a 40×40px or larger target.
- **AC mark** at the top: a button labelled "AgentControl, open Primary" that goes to `#/primary`.
- **Avatar placeholder** at the bottom of the rail (in Settings on phones): a button labelled "Sign-in and key" that opens
  Settings › Sign-in. There are no accounts and no identity is implied.
- **Waiting badge on Projects:** shown when the channel waiting count is above zero. It uses a symbol and a number, never colour
  alone, and the accessible name "Projects, N waiting for you". Activating it goes to Projects and runs the existing
  `locateWaiting`. It is visible in every section.

**Secondary panel:** a section title, a search field (a labelled input that filters the panel's list on the client, with no
requests), then the list.

**Stage top bar:** a title, a one-line context, and the section's actions. The existing error banner stays global.

**Overlays**
- **Session details** (today's context panel: Session and Members/Team tabs, task graph). At 1200px and above it is a 360px right
  pane inside the stage, with the panel still shown. From 720 to 1199px it is a centred overlay of at most 560px. Below 720px it
  is a full-screen sheet.
- **Turn details** (today's Workspace, `#/w/<run>/<agent>`). At 1200px and above it is a right pane of
  `min(960px, 100vw − 76px − 420px)`; it **hides the secondary panel while open** and keeps at least 420px for the thread. Smaller
  widths follow the Session details rule.
- Back, close and Escape restore the previous route and focus, as today.

## 4. Sections

### Primary (`#/primary`)
- **Top bar:** "Primary", context "Everyday". No team wording.
- **Stage:** a system-styled notice (not a message): "Your primary agent isn't available yet. It will be one everyday
  conversation that stays with you across projects."
- **Composer:** shown **disabled**, with the placeholder "Message the primary agent" and a visible reason linked by
  `aria-describedby`. No pills.
- **Panel:** one row, "Primary · Everyday".
- **Requests:** none.

### Agents (`#/agents`)
- **Panel:** title "Agent library", then the empty state "No agents yet". No search field and no "+" while the list is empty.
- **Stage:** top bar "Agents", context "Library". Text: "Creating and configuring your own agents isn't available yet. Sessions
  choose their agents automatically. To see who is working, open Projects › Session details", with a link that opens it.
- **Requests:** none. Do not show per-session agents as if they were library agents.

### Projects (`#/projects`, the same as `#/`): home of the team thread

**Panel**
- Title "Projects", a search field, and a "+" button (labelled "Create project").
- **Current project** first, with name, directory (relative to the projects root when inside it) and "Current". **No member
  count**: there is no membership data yet, and none is faked.
- **Under the current project:**
  - **Sessions:** today's rail list, moved here with all its behaviour (M6 union, live precedence, "Showing X of N sessions"
    only while incomplete, "Load earlier sessions", truncation with full titles, keyed updates keeping focus and scroll).
  - **In this session:** today's live roster, linking active members to Turn details exactly as M9.1 B. Label it "In this
    session", never "Team members".
  - The waiting link (M9.1 B: always findable; counts equal the channel counts).
- **Other folders**, under the heading "Folders in <root>": from `GET /api/projects/browse` (one request when the panel opens,
  plus breadcrumb navigation with `?path=`). Each row shows the folder name and a git or no-git label. Activating a row opens a
  confirmation dialog: "Switch to <name>? <current>'s sessions stay in its history." Then send **one**
  `POST /api/projects/select {path}` and show any refusal verbatim (for example during an active run). A non-git folder says
  "Team sessions need git" but may still be selected (today's server behaviour).

**Create project**
- A real dialog with a focus trap. **Name** is required.
- **Directory** is shown read-only as `<root>/<name>`, updating as you type. The note says: "AgentControl creates this folder
  with git and a first commit. Choosing agents for a project isn't available yet."
- The button is labelled **Create project**. It sends **one** `POST /api/projects/create {name}`. On success the server selects
  the project, and you land on its (empty) team thread. Errors appear in the dialog verbatim (role `alert`).

**Stage**
- **Top bar:** the project name; context "<directory> · <n> sessions · <active session status>"; actions:
  - Session details (when a session is selected)
  - the session menu (Pause/Resume/Stop, Turn details links, Classic dashboard), unchanged
- **One summary card** for the current project: directory, session count, active session status, waiting count. All of it comes
  from the snapshot.
- **The team thread:** today's room timeline, waiting strip and composer, unchanged in behaviour.
- **Composer:** a static "**Team**" chip before today's target chip (New session / Note → Hermes / Follow-up). **No member
  pills.** The in-text `@agent` note, slash commands and the Settings sheet are unchanged.

### Workspace (`#/workspace`)
- **Top bar:** "Workspace"; context "<current project directory> · the current project's folder".
- **Stage:**
  - "Browsing project files isn't available yet."
  - "Live preview, program, VM and desktop screens: Open in classic" (link to `/classic`).
  - "Turn details for each agent are in Projects."
- **Requests:** none. **No file list of any kind.**

### Skills (`#/skills`)
- **Data:** one `GET /api/skills` when the section opens, plus a Refresh button. Render **only `library`**; do not render
  `installs` or `log`.
- **Panel:** skill names, filtered by search. Activating one moves focus to its card.
- **Stage:** top bar "Skills"; context "Shared catalog · <library_path>". A grid of cards, each with:
  - name
  - description (escaped and visually clamped, with the full text available)
  - status: "Ready" or "Problem: <error>"
  - risk label (Low or Sensitive), with reasons in a disclosure
  - review status: "Reviewed version" or "Not reviewed yet"
  - "Assigned to: assigning skills isn't available yet"
  - "Tool permission: uses the existing approval gate"

  Do **not** claim that every request is asked: OpenCode's own config decides which requests reach the gate.
- **Page action:** "Add or remove skills in classic" (link to `/classic`).
- **Empty state:** "No skills in <library_path>."
- **Requests:** no POST.

### Settings (`#/settings`)
The panel lists **Connections, Approvals, Memory, Usage and activity, Appearance, Sign-in, Classic dashboard**. The stage shows
the selected item:
- **Connections:** today's Connections component, including **Check connections** (`POST /api/check` under the write lock).
- **Approvals:** fixed explanatory copy, true to `permissions.py` and the README:
  - requests appear as cards in Projects
  - critical requests need you to type `approve`
  - a remembered approval covers identical requests in one session only, and can be revoked in classic
  - OpenCode's own permission settings decide which requests it asks about

  Plus a link: "Remembered approvals and full history: classic".
- **Memory:** **three separate rows** (Primary memory, Specialist memory, Project context). Each has its one-line scope
  description from the handoff and "Not available yet". Never one combined panel.
- **Usage and activity:** links to classic, as today's More links do.
- **Appearance:** "AgentControl uses one dark appearance." Information only, with no control (D9).
- **Sign-in:** "This browser is signed in with the dashboard key." A button, **Forget key and sign out**, opens a confirmation,
  then clears the stored key from local and session storage, closes the event stream and shows sign-in. No POST.
- **Classic dashboard:** a link to `/classic`.

## 5. Where today's features go (each must stay reachable, and its existing tests carry over)

| Feature (M1–M9) | N1 location |
|---|---|
| Channel (one `main`) and its waiting count | Projects panel (the current project) and the Projects rail badge |
| Sessions list, counts, disclosure, paging | Projects panel, under the current project |
| Rail members and Turn details links | Projects panel, "In this session" |
| Rail waiting link | Projects rail badge and the Projects panel waiting link |
| Connections (rail bottom) | Settings › Connections; the composer's blocked message is unchanged |
| More › Skills | Skills section, plus its classic link |
| More › Usage, Activity, Settings, Classic dashboard | Settings |
| More › Switch project | Projects panel (now native) |
| Room header, session menu, Session details | Projects top bar |
| Context panel (Session and Members/Team tabs, task graph) | The Session details pane |
| Workspace `#/w/…` (turns, stages, terminal, changes, diff, verification, logs, surfaces and pop-out) | **Turn details** pane: the same content, renamed |
| Waiting strip and pointer, request cards, decision and stop dialogs | Projects team thread, unchanged |
| Composer (new session, notes, `@agent`, follow-up, slash commands, Settings sheet) | Projects composer, unchanged |
| Error banner and connection label | Global |

## 6. Routes

- `#/` and `#/projects` both show Projects. `#/s/<id>` and `#/w/<run>/<agent>` behave exactly as today, inside Projects.
- `#/primary`, `#/agents`, `#/workspace`, `#/skills` and `#/settings` show their sections.
- An unknown hash shows Projects.
- Switching section never refetches the thread. It keeps the thread's scroll and focus for when you return.
- Server routes (`/`, `/chat`, `/classic`, C1) are untouched.

## 7. Visual tokens (in `chat/tokens.css`)

**Surfaces:** `#070708` (background), `#101012` (panel), `#161618` (surface).
- Separators: white at about 7%, decorative only.
- **Essential control boundaries and focus rings:** at least 3:1 against their background.

**Text**
- Primary text `#f4f4f5`.
- Muted text `#8b8b93` (about 5.6–5.9:1).
- **Nothing below 4.5:1 for text.** The mock's `--faint` (`#5c5c66`) is not used for text.

**Controls**
- Active pills and the send button: white with black text.
- The send button has the accessible name "Send".
- The composer is a rounded dark pill.

**Type:** `Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`, and `"IBM Plex Mono", ui-monospace,
SFMono-Regular, Menlo, monospace` for model and file labels. Nothing is downloaded.

**Appearance (D9, approved):** dark-only. Set `color-scheme: dark`, remove the light token set and the `prefers-color-scheme`
branch, and do not add a switcher. Forced colours and reduced motion keep working.

**Sizes:** inputs at 16px or larger. No text smaller than today's smallest type token. Rail and bottom-bar labels use that token,
not the mock's 9px.

**Forbidden:** purple themes, heavy gradients and marketing layouts.

## 8. Tests

### New DOM tests (`tests/test_chat_ui.cjs`)
1. **Rail:** the rail and bottom bar list exactly the six items in order, with icon plus label. `aria-current` follows the
   route. AC goes to `#/primary`. The avatar opens Settings › Sign-in.
2. **Routes:** every route renders its section. An unknown hash shows Projects. `#/s/…` and `#/w/…` behave as before.
3. **Honest empty states:** Primary, Agents, Workspace and Settings › Memory make no POST and add no GET. No element in them is
   rendered as an agent message, and **none of the sample names appears anywhere in the DOM**. Settings › Memory renders three
   separate elements.
4. **Skills:** cards render only from `library`. A hostile name or description (markup, a long string, RTL control characters)
   is escaped. `installs` and `log` are not rendered. No POST.
5. **Projects:**
   - browse rows are escaped and the current project is pinned
   - Switch confirms, then sends exactly one `POST /api/projects/select {path}`
   - Create sends exactly one `POST /api/projects/create {name}`, even on a double activation
   - the server's refusal text is shown verbatim
   - both POSTs respect `writeOwner`
6. **Waiting badge:** its count equals the channel waiting count in every section. Activating it reveals the first actionable
   card.
7. **Search:** filters the panel lists with no requests.
8. **Forget key:** clears both storages, shows sign-in, and makes no POST.
9. **Composer:** shows a static Team chip and no member pills. `@agent` notes and slash commands are unchanged.
10. **Section switching:** keeps the thread's scroll and focus, and causes no thread GET.

### Assertions you may replace (P-12 only)
- Only assertions that pin the old shell's **geometry or placement**: the rail headings and structure, the More list, the 260px
  rail, the 768px and 1200px breakpoints, footer budgets and conversation ratios, and the matrix layout dimension.
- List each one by test name, with exact before and after, in the completion report.
- A test whose *behaviour* is still valid moves with its feature and keeps every behavioural assertion. For example, the M6 and
  M8 rail paging and count tests now target the Projects panel.
- **Under D11 (vocabulary) only:** assertions on the visible label "Workspace" for the per-agent view may change to "Turn
  details". Change the strings only, and list each one. Keep the existing Turn details element ids and classes (`#workspace`,
  `workspace-*`), the `#/w/…` route and the `/classic?popout=` link, so that behaviour tests carry over unchanged. The new
  Workspace section uses new ids (for example `project-files-*`).

### Browser matrix (`tests/chat_screenshots.cjs`)
- Add viewports **1280×800** (the handoff), **720×900** and **719×900** (boundary).
- Keep 1440, 1200, 1024, 768, 390, 844×390 and 320.
- Cover each section at each viewport, plus the existing states.
- **Fatal checks:**
  - no page overflow
  - targets at least 40×40px (tablet and phone)
  - inputs at least 16px
  - contrast pairs rebaselined to the new dark tokens (text at least 4.5:1, essential boundaries and focus at least 3:1). The
    matrix's light-appearance rows are replaced by dark-only rows (D9); report the new combination count
  - keyboard order and focus traps
  - reduced motion and forced colours
  - the bottom bar hidden while the keyboard is open
  - P-12 footer limits: portrait conversation at least 55% with the bar; landscape at least 45%, idle footer at most 72px,
    waiting footer at most 112px; bar at most 64px
- The cutover smoke stays five cases. Its selectors may change only where the shell moved them; list each change.

### Real server
- Repeat the accepted eight-step walkthrough at `/` (Projects), using the M9 harness: the real `app.handler` and `Controller`,
  the existing workflow and team fakes, and one disposable git project and state. The GET and POST counts per step must equal
  M9's (67 GET, 64 of them API fetches, and 8 POST), plus only documented asset GETs.
- On the isolated `device_fixture.py` server (temporary root and state, throwaway key):
  - visit all six sections
  - create a project inside the temporary root, then switch back
  - forget the key and sign in again
- Inspect screenshots of every section at 1280 and 390. **Never touch real projects or state.**

### Regression (must all pass; see `docs/PERSISTENT_AGENTS_ACCEPTANCE.md` §A)
- Python: unchanged files, all passing, gated skips labelled.
- Classic: **82/82**.
- Chat routes: **4/4**.
- Every carried-over chat behaviour test.

## 9. Files

- **May change:**
  - `agent-autonomy/chat/*`. New **flat** files such as `nav.js` or `sections.js` are served by the existing allow-list; no
    Python change.
  - `agent-autonomy/tests/test_chat_ui.cjs`, `tests/chat_screenshots.cjs`, `tests/fixtures.cjs`
  - `README.md` and `agent-autonomy/README.md` (the chat description)
  - `CURRENT_STATE.md` and this handoff's completion report
  - `docs/REDESIGN_ARCHITECTURE.md`: rewrite §10 Layout for the shipped shell, and remove the "effective when N1 ships"
    notes in §9 and §11 once they are true. D8–D12 are already recorded; change nothing else
- **Must not change:** any `.py` file (including `device_fixture.py`), any Python test, classic files, the journal or state.

## 10. Acceptance

All of `docs/PERSISTENT_AGENTS_ACCEPTANCE.md` **§A (always)** and **§B (N1)**.

## 11. When you finish

1. Append a completion report to this file, covering:
   - start and end commits
   - files changed
   - every replaced assertion (name, before, after)
   - new tests
   - exact suite results with logs
   - matrix counts and screenshots inspected
   - walkthrough GET and POST counts per step
   - deviations, and anything not done
2. Update `CURRENT_STATE.md`.
3. Commit and push only to `feature/chat-first-redesign`. **Do not merge into `main`.**
4. Stop for Opus review. Do not start N2.
