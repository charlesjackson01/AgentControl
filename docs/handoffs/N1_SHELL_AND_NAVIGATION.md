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

---

## N1 completion report — Codex, 2026-10-03

**Implementation complete; independent Opus review pending.** Started from clean `49a3fa9` after
`git pull --ff-only origin feature/chat-first-redesign`; verified that commit is an ancestor of HEAD.
End: the N1 implementation commit containing this report on `feature/chat-first-redesign` (its exact
hash is reported with publication). No merge into main and no N2 work.

### Shipped scope

D8–D12 are applied. Six icon/label sections share the accepted room, decisions, composer and inspection
components. The shell is 76/300/stage on desktop, a secondary drawer at 720–1199 and a six-item bottom
bar below 720. Session details and Turn details follow the specified pane/overlay/full-screen rules.
Primary, persistent Agents, Direct conversations, project files, skill assignment and the three separate
Memory scopes are unavailable; no example records or messages were seeded. Skills renders only the
actual library and exposes descriptions, risk reasons, review status and classic management.

Projects adds the existing folder browser and name-only creation/selection endpoints. Both writes are
confirmed, guarded by `writeOwner`, and single activation sends one exact body. Refusal text is preserved.
Folder/catalog reads are one-shot, serialized with refresh/paging, never polled, and only made on opening
or explicit refresh. A direct Turn details bookmark does not fetch hidden folder data. Returning to a
section retains the room cache, selected session, scroll and focus without fetching the thread.

The shared modal mechanism now records the new project dialog's opener explicitly. The skip link targets
the visible section outside Projects. Normal-zoom keyboard detection handles shrinking visual and layout
viewports and orientation; zoom keeps the M9.1a layout freeze and does not disable pinch zoom. The phone
Projects badge retains its SVG icon. Safe-area bottom-bar targets remain above the inset. Composer spacing
is compacted, with its original literal/mention/slash parsing and automatic multiline growth preserved.

The per-agent view is **Turn details**, with the same `#workspace`, `workspace-*`, `#/w/...`, content, privacy
filters and `/classic?popout=` URLs. `workspace.js` and `decisions.js` are unchanged. The new project files
placeholder uses `project-files-empty`. Outcome branch wording such as "Workspace open" is deliberately
unchanged: it describes the branch outcome, not the renamed inspection view.

### Changed files and boundary review

- `agent-autonomy/chat/`: `index.html`, `tokens.css`, `chat.css`, `core.js`, `composer.js`, `shell.js`,
  `thread.js`, `members.js`, and new flat `sections.js`.
- Frontend tests only: `tests/test_chat_ui.cjs`, `tests/chat_screenshots.cjs`, `tests/fixtures.cjs`.
- `README.md`, `agent-autonomy/README.md`, `CURRENT_STATE.md`, this report.
- Architecture: only §10 and the authorized shipping notes/vocabulary in §9/§11. D8–D12, all invariants
  and every backend/API/schema/approval contract are unchanged.

No `.py`, Python test, classic product file, journal, state or fixture backend changed. No new endpoint,
runtime dependency, external font, engine behavior, interactive surface, agent record or memory store.

### Authorized earlier assertion changes — exact names, before and after

Only D10/P-12 placement/geometry and D11 visible inspection vocabulary were changed. All other assertions
in these tests remain, including request counts/bodies, identity, focus, privacy, server authority and paging.

| Existing DOM test name | Before | After |
|---|---|---|
| `M3 kinds, progressive detail, roles, receipts and unknown kinds` | Inspection link text `Open workspace` | `Open turn details`; identical `#/w/run_test/coder-1` assertion |
| `M6 keyed panel and rail items retain focus and scroll through recorded updates` | Connections summary inspected in the rail | Navigate `#/settings` before inspecting the same summary; all node identity/scroll/focus assertions retained |
| `M6 Connections display per-service symbols, labels and exact shared-lock check` | Inspect/check Connections in the rail | Navigate `#/settings`; same labels, shared lock, disabled composer/decisions, duplicate-tap suppression and exact `/api/check {}` |
| `M6 Connections check is disabled by decisions and composer writes and shows errors` | Check Connections in the rail during each write and refusal | Navigate `#/settings`; same disabled/one-write/error assertions |
| `M6 keyed updates preserve every More link and focus the latest recorded task turn` | Six stable links under `#more a` | Six stable links under `#section-nav [data-section]`; exact latest-task focus assertion unchanged |
| `M7 B room, live members and tasks link into Workspace while proposed agents do not` | `Open workspace` / task `Workspace` | `Open turn details` / `Turn details`; all route, proposed-member exclusion and zero-POST assertions unchanged |
| `M8 C phone rail and context sheets trap focus and restore visible openers` | Last drawer control `#more > summary` | Last drawer control `#refresh-folders`; same trap, inert background, Escape, opener and context-tab behavior |
| `M8 D all token text, boundary and focus colour contrasts meet their measured thresholds` | 52 pairs in light+dark | 26 pairs in dark only (D9); every text ≥4.5 and boundary/focus ≥3 threshold retained |
| `M9.1 B each turn has one visible summary Workspace link with its exact route` | `Open workspace` | `Open turn details`; one visible link, outside Details, exact route and no POST unchanged |
| `M9.1 B rail and session menu link only the active recorded members to their Workspaces` | `Open workspace`, menu `Workspaces` | `Open turn details`, menu `Turn details`; Hermes `Open log`, exact routes, both entry links and decision exclusions unchanged |
| `M9.1 B Workspace navigation from the drawer restores its visible opening link without a write` | Capture total requests immediately after opening the old drawer | Allow the authorized one-shot browse to settle before capture; subsequent Turn details opening/Back still adds **zero** requests, returns the identical opener and makes zero POST |

Harness additions load `sections.js` and return the real browse/skills response shapes. No earlier Python
or classic test changed. All M3.1/M6/M8 session union/count/disclosure/paging assertions are unchanged.
All M9.1a F3 menu identity, closed/removed opener and closed-context assertions are unchanged.

Browser updates, by function/case name:

| Existing function/cases | Before | After |
|---|---|---|
| `matrixViewports` and the main state matrix | Seven viewports, light and dark: 672 combinations | Add `handoff` 1280×800, `boundary` 720×900, `boundary-phone` 719×900; dark only: 480 existing combinations plus 60 new section combinations = 540 |
| `deviceDiscoveryCases` / `device-menu-workspaces` | Visible menu heading includes `Workspaces`; four light/dark rows | `Turn details`; two dark rows. Every request, focus/Back/Escape and recorded-member assertion retained |
| `deviceViewportCases` / `context sheet within panned viewport` | Phone context height ≤75% of keyboard viewport | Phone full-screen context height ≤100%, tablet remains ≤75%; bottom/centre assertions retained |
| `deviceViewportCases` / `close keyboard restores footer geometry` | Footer bottom equals full viewport bottom | Below 720, footer bottom equals viewport bottom minus the 64px bar; tablet/landscape unchanged; keyboard-open footer and zoom checks retained |
| `layoutCheck` | The old rail toggle is `#open-rail` | Visible toggle is `#open-rail` or `#open-section-panel`, according to section; same centred overlays, target, label, focus and overflow assertions |
| Main matrix / `connections` | Expand Connections in the Projects rail and budget the visible room footer | Open Settings › Connections and retain exact service assertions; room-only budgets run in Projects, whose room is hidden in Settings |
| Main matrix / desktop `workspace*` geometry | Width formula uses `#rail` width 260 | Uses `#section-nav` width 76; secondary hidden, same ≥420 thread and exact `min(960,width−rail−420)` pane assertion |
| Main matrix / phone footer, plus `decisionQuestion` command-error recovery | Waiting footer ≤120, portrait conversation ≥65% | Waiting footer ≤112, portrait conversation ≥55% (D10); idle ≤72, waiting row dimensions/baseline, newest-message visibility, overflow and pointer recovery retained |
| `deviceDiscoveryCases` / initial phone footer | Phone ≤120 | ≤112; landscape ≤112 unchanged |
| `accessibilitySpots`, `emptyHistoryCases`, `phonePanelCases`, `keyboardPaths`, `deviceViewportCases`, `deviceDiscoveryCases`, main matrix | Light and dark rows | Dark-only rows (D9), with all behavioral cases and thresholds retained. Result counters now report actual dark-only cases |

**Cutover smoke:** still exactly five cases; **no selector changes**. The preserved `#rail`, `#workspace`
and pop-out controls let its existing selectors and all classic checks carry over unchanged.
The accepted M9 scratch walkthrough's obsolete six-link More placement check now inspects the six section
links; composer Settings' two classic fallback link assertions are unchanged. The eight core steps are unchanged.

### New regressions

18 new DOM tests cover six-section order/icons/labels/current route/AC/key avatar; every route and unknown
fallback; all honest placeholders and absence of sample names or messages; three Memory scopes; hostile
markup/long/RTL skill descriptions with library-only output; escaped folders/current pin/breadcrumbs/local
search; exact switch/create bodies, confirmations, required/read-only fields, duplicate taps, shared locks
and literal refusal text; waiting badge/count/locate recovery in every section; both key stores and stream
abort on sign-out; Team chip and preserved parsers; room scroll/focus and selected-session return without
thread GETs; read serialization/no polling; normal-zoom keyboard/orientation and pinch protection; project
modal trap/Escape/focus return; visible-section skip navigation; hidden-panel read boundaries.

Browser additions cover all six sections at all ten widths; icon visibility, active selection, 200% text zoom,
forced colours, phone safe-area bar geometry, tablet/phone panel traps, project-dialog Cancel/Escape/focus,
waiting discovery, keyboard bar hiding and unchanged room behavior. The isolated fixture exercises all six
sections, real git project creation, switch-back and Forget/reconnect. Its temporary root is removed on exit.

### Verification

All checks below ran against the N1 working tree; no earlier milestone result substitutes for these runs.

| Suite | Command | Result / log |
|---|---|---|
| Python, unchanged | `python3 -m unittest discover -s agent-autonomy/tests -v` | **424 tests, OK (skipped=3), 260.354 s**, first N1 full attempt; `/tmp/ac-n1-python.log` |
| Classic, unchanged | `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_ui.cjs` | **82/82**; `/tmp/ac-n1-classic.log` |
| Chat DOM | `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_chat_ui.cjs` | **273/273** (255 carried over + 18 new); `/tmp/ac-n1-chat-final-tree.log` |
| Routes, unchanged | `PYTHONPATH=agent-autonomy:agent-autonomy/tests python3 -m unittest -v test_chat_routes` | **4/4**, 4.148 s; `/tmp/ac-n1-routes-verified.log` |
| Complete browser matrix | `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/chat_screenshots.cjs /tmp/chat-shots-n1-final-tree` | **540 combinations + 46 regression cases, 814 screenshots**; `/tmp/ac-n1-browser-final-tree.log` |
| Real-server walkthrough | `NODE_PATH=/tmp/ac-tests/node_modules node /tmp/ac-n1-real-check.cjs` | **8/8** core steps, **67 GET / 8 POST**; `/tmp/ac-n1-real-release.log` |
| Isolated device fixture | Included in the complete browser command | **9 cases**: all six sections, create, switch-back, Forget/reconnect; `/tmp/chat-shots-n1-final-tree/n1-fixture-results.json` |

**Gates, not passes:** the unchanged Python suite skipped
`test_container_e2e.ContainerRunE2E.test_agent_works_in_a_locked_down_container` (requires
`AGENTCONTROL_CONTAINER_TESTS=1`, runtime and image),
`test_preview.DesktopTests.test_desktop_preview_shows_frames_and_accepts_input` (desktop tools missing),
and `test_vm_e2e.VMRunE2E.test_agent_works_in_a_kvm_clone` (requires
`AGENTCONTROL_VM_TESTS=1` on a KVM host). The three real-OpenCode tests ran and passed.
No Python timing failure occurred in this N1 run; no isolated timing retry or full-suite retry was needed.
The established lifecycle sampling, fixed-timeout workflow/team and asynchronous VM log races were not
changed or weakened. Python ran after the browser and fixture runs had ended.

**Retries and corrections:** the first focused routes attempt failed at socket setup with four sandbox
`PermissionError`s; the same unchanged command passed outside the sandbox. Chromium and socket-based
checks ran with the required execution permission. This was a permission retry, not an environment skip.
Development DOM/browser attempts exposed old location/text assumptions and real new-shell defects:
room scroll restoration, project-dialog opener restoration, short-keyboard timeline padding, phone Team
chip spacing, footer status/recovery placement, and the obscured Projects icon. These were fixed before
the final passing runs. The original literal multiline draft, automatic growth and fatal footer assertions
were retained. No browser failure was made non-fatal or concealed with an arbitrary wait. Final matrix
checks also require bottom-bar targets to fit above a 20px safe-area inset.

The dark-only main matrix is **48 existing states × 10 viewports = 480**, plus **6 sections × 10 = 60**.
All 46 remaining regressions are fatal, including five cutover smoke cases and nine isolated fixture cases.
All **26** contrast pairs retain text ≥4.5:1 and boundary/focus ≥3:1; targets ≥40px and inputs ≥16px,
keyboard workflows/traps, reduced motion, forced colours and 200% text zoom pass. User pinch zoom is
preserved, and the bottom bar hides with the keyboard at normal zoom.

Actual screenshots of **every section at 1280×800 and 390×844** were inspected, together with the tablet,
719/720 boundary, phone landscape, Turn details and 200% text-zoom renders. Final artifacts are in
`/tmp/chat-shots-n1-final-tree` (`n1-<section>-handoff.png`, `n1-<section>-phone.png`,
`section-<section>-text-zoom-dark.png`). These renders contain only disposable test data.
`footer-measurements.json` records 47 room cases per phone orientation: portrait **57px idle / 105px
waiting**, conversation **≥68.95%**; landscape **59px / 107px**, conversation **≥57.82%**.
The waiting row is 40px and the bottom bar is 64px; all approved P-12 budgets pass.

### Real-server walkthrough (final run)

Real `app.handler` and `Controller`, existing workflow/team test fakes, one temporary git project/state and
throwaway key; cleanup verified. `/tmp/ac-n1-real-release.log`, `/tmp/ac-n1-real-results.json` and
`/tmp/ac-n1-real-server.py` / `/tmp/ac-n1-real-check.cjs` record exact requests and receipts.

| Step | GET | POST |
|---|---:|---:|
| Start | 8 | 1 |
| Critical typed approval | 3 | 1 |
| Question answer | 6 | 1 |
| Start team and approve recorded proposal | 21 | 2 |
| Watch live Turn details grow | 8 | 0 |
| Verify now | 10 | 1 |
| Apply | 3 | 1 |
| Follow-up | 8 | 1 |
| **Total** | **67 (64 API fetches + 3 event streams)** | **8** |

All fully paged before/after checkpoints preserve waiting = actionable non-outcome messages and decision
cards = actions + actionable outcomes. Unapproved agents remain proposed, verification is recorded server
status/time, critical permissions retain typed confirmation, Apply retains explicit confirmation, and
Turn details opening adds zero requests.
Reasoning is absent; raw output stays confined to Turn details. Only `/` is loaded during the eight steps.
Boot is 21 GET/0 POST: M9's 19 plus the flat `sections.js` asset and one authorized desktop panel browse.
There are no additional steady-state or per-step reads. Auto explanation remains a separate 2 GET/1 POST
check. Separate same-key classic smoke is 9 GET/0 POST; all five cutover smoke cases remain fatal and passing.

### Limits and exclusions

This implements N1 only. Persistent agent/Primary/Direct backend records, Memory, file browsing, skill
assignment and new orchestration remain unavailable. Interactive surfaces remain in classic. The intentionally
excluded in-flight skill-fetch race remains excluded; D7 and M5.0 are unchanged. No new physical iOS/Android
keyboard or assistive-technology testing is claimed. Historical owner G3 evidence is not new N1 evidence.
Native device behavior should be rechecked on the new shell before treating it as newly verified.
No scope or authorization deviation; no backend, classic or protected test was weakened. Stop for independent
Opus review; do not start N2 or merge into main.

---

## Review of N1 — 2026-10-03 (Opus)

**Verdict: not yet accepted.** One Blocking finding (a fatal accessibility check fails reproducibly), plus three Should-fix
findings. The bounded **N1.1** corrections below fix them. Everything else in N1 is sound, and most of it is verified
independently. No physical-device testing is claimed by this review either.

Reviewed `8be5d62` against `49a3fa9`: 17 files changed. **No `.py` file, Python test, classic file or state file changed.**

### What was verified

| Check | Result (this review) |
|---|---|
| Python (`unittest discover`) | **424, OK (skipped=6)**, first attempt. The 6 skips are gates, not passes: container, desktop preview, KVM, and the three real-OpenCode tests (this container has no OpenCode binary; Codex's environment ran them) |
| Classic DOM | **82/82** |
| Chat DOM | **273/273** |
| Chat routes | **4/4** (run with `PYTHONPATH=agent-autonomy:agent-autonomy/tests`) |
| Full browser matrix, as committed | **Fails** at `teamProposed zoom clipped control waiting-pointer`, after 452 screenshots (B1) |
| Full matrix, with only that clip check downgraded to logging in a scratch copy | **540 combinations + 46 regressions, 814 screenshots**, matching the report. The only clipping recorded is B1's five cases |
| Control: desktop matrix on pre-N1 `49a3fa9`, same container | **Passes**: 96 combinations + 66 regressions, every zoom check included. B1 is an N1 regression, not an environment artefact |

**Fewer regression rows (66 → 46) is legitimate.** Every removed row comes from a `colorScheme` loop narrowed from
`['light','dark']` to `['dark']` (D9). No case type was dropped, and the counters now report real totals.

**Product code**
- `sections.js` escapes every server and user string (folder names and paths, skill names and descriptions, errors), uses
  only the authorised endpoints (`GET /api/projects/browse`, `GET /api/skills`, `POST /api/projects/select` and `create`),
  takes the shared write lock, sends one POST per activation, and shows refusals verbatim.
- No sample names anywhere in `chat/`. No CDN, `@import`, `@font-face` or external URL.
- `tokens.css` is dark-only: `color-scheme: dark`, no `prefers-color-scheme` branch, system stacks naming Inter and IBM
  Plex Mono.
- Turn details keeps `#workspace`, `workspace-*`, `#/w/…` and `/classic?popout=`.
- `signOut` reuses the existing `rejectKey` path.

**Approval and security behaviour** is unchanged, shown by the unchanged suites and the walkthrough counts in the report
(67 GET / 8 POST).

### Findings

**B1 (Blocking): 200% text zoom clips the waiting pointer when Session details is open.**
- The fatal M8 zoom check (`zoomCheck`: root font 32px, 1280×800) fails for `singleMembers`, `teamProposed`, `teamReview`,
  `teamRunning` and `teamUnusable`.
- With the rail (76px), panel (300px) and Session details (360px) open, the room is 544px wide. "! 1 waiting for you" needs
  220px and gets 211px (`scrollWidth` 220, `clientWidth` 211), so the strip's text runs into "Open classic dashboard".
- This container's sans-serif fallback is DejaVu Sans, a wide font and the default on many Linux desktops. M9 passed the
  same check here with the same fallback. Codex's environment presumably resolves a narrower font, so the layout has no
  slack for common fallback fonts.
- This breaks acceptance A9 and B12 (text zoom to 200% without clipped controls) on the control that leads to approvals.

**S1 (Should fix): invalid skills are labelled "Low" risk.**
- `capabilities.skill_library()` returns entries that fail validation as `{folder, name, error}`, with no `risk`.
- The card's label `skill.risk==='sensitive'?'Sensitive':'Low'` (`sections.js`) shows **Low** for them: a wrong safety label
  on exactly the skills that failed inspection.

**S2 (Should fix; documentation, fixed in this review).** The §10 rewrite dropped the binding "One place per control" rule:
an approval appears once as a card plus one waiting pointer, and Pause, Resume and Stop are in the session menu and slash
commands. The behaviour and its tests are unchanged. The rule is restored in `docs/REDESIGN_ARCHITECTURE.md` §10 by this
review commit.

**S3 (Should fix): navigation labels don't fit with a wider fallback font.**
- On the live fixture, the bottom-bar label "Workspace" needs 66px and gets 53px at 320×640, so it is ellipsised.
- At 390×844 it fits by under a pixel on the fixture, but the harness render with the Projects badge shows "Workspa…"
  (`n1-projects-phone.png`).
- The clip check covers only `button, summary, select, input`, so truncated navigation links are never tested. Same root
  cause as B1.

**Optional** (fix in N1.1 if cheap, otherwise leave):
- **O1.** Settings › Sign-in renders a second "Sign-in and key" button (`#phone-key-avatar`) at every width. It links to the
  page it sits on.
- **O2.** At 200% text zoom the rail labels truncate ("Pri…", "Ag…"). The icons and full accessible names remain.
- **O3.** Pressing Escape during an in-flight create or select closes the dialog. A later refusal is written into the closed
  dialog and never seen.
- **O4.** `projectPanel` rebuilds the Projects panel by scraping the shell's old rail HTML by position
  (`template … querySelectorAll('section')[0..2]`, replacing the `<h2>Members</h2>` string). Brittle coupling: prefer the
  shell exporting those pieces.
- **O5.** "1 sessions" in the Projects top bar and summary card. M8 D fixed exactly this singular wording for the rail.
- **O6.** The Projects panel still shows a "Channels · # project" block under the current-project header that repeats it.

## N1.1 corrections (bounded; frontend and frontend tests only)

**Scope:** `agent-autonomy/chat/*`, `tests/test_chat_ui.cjs`, `tests/chat_screenshots.cjs`, `tests/fixtures.cjs`,
`CURRENT_STATE.md` and a completion report appended here. **No `.py`, Python test, classic, state or endpoint change.**
Every rule of this handoff and of `docs/PERSISTENT_AGENTS_ACCEPTANCE.md` §A and §B still applies.

1. **C1 (B1).** The waiting strip must never clip.
   - At 200% text zoom with Session details open at 1280×800, every zoom-check state passes with no clipped control.
   - Let the strip wrap: the pointer and the classic link may go on separate lines, or the pointer text may wrap.
   - **At normal zoom, keep D10's footer limits** (portrait conversation at least 55%; landscape at least 45%, idle footer at
     most 72px, waiting at most 112px).
   - The pointer stays one control, keeps its exact accessible text, and keeps locating the first actionable card.
2. **C2 (S3).** Every rail and bottom-bar label is fully visible, with no ellipsis, **at normal text size at every matrix
   width, including 320×640**, with the handoff's exact names.
   - Options: a two-line label within the 64px bar, tighter horizontal padding, or tighter letter-spacing within the
     existing smallest type token.
   - Targets stay at least 40×40px, and the bar stays at most 64px.
3. **C3 (font-independent checks).** The matrix must catch B1 and S3 whatever fonts are installed.
   - Add a "wide font" pass: inject a stylesheet that inflates text width (for example `* { letter-spacing: 0.06em }`, or a
     measured equivalent that reproduces DejaVu Sans widths) and re-run:
     - the 200% zoom check for every state
     - the navigation-label fit check at every width
   - Extend clipped-control detection to `#section-nav a`, `#bottom-nav a` and the composer chips.
   - Both passes are fatal. Document the inflation factor and why it covers common fallback fonts.
4. **C4 (S1).** Show Low or Sensitive only when the entry has a `risk`.
   - An entry with `error` shows "Problem: <error>" and "Risk: not assessed", never Low or Sensitive.
   - Add a DOM test with an invalid library entry.
5. **C5 (O5).** Use the singular "1 session" in the Projects top bar and summary card. Add a DOM test.
6. **Optional:** O1, O3, O4 and O6 at Codex's discretion. List what was done and what was left.

**Verification for N1.1:**
- The full browser matrix passes as committed, **both normally and in the wide-font pass**. Report the combination,
  regression and screenshot counts.
- Chat DOM, classic **82/82**, routes **4/4**, cutover smoke **5/5**, and the isolated fixture cases.
- One full Python run (unchanged files; gates labelled).
- Inspect renders of the five B1 states at 200% zoom, and of the bottom bar at 390 and 320, in both passes.
- List every changed or added assertion.
- Then stop for Opus re-review. N2 is not started, and nothing is merged into `main`.


---

## N1.1 completion report — Codex, 2026-10-03

Started clean at `65b07e2`, the approved N1 review/corrections, after pulling only
`feature/chat-first-redesign`. End: the N1.1 implementation commit containing this report; the publication
response supplies its exact hash. N1 remains subject to independent Opus re-review. No N2 or main merge.

### Corrections

- **C1:** the waiting strip permits wrapping, and neither its pointer nor classic link shrinks below its
  text. At 200% zoom they can occupy separate lines. The pointer remains one control with the same text,
  location handler and server-derived count. Normal phone text/link alignment and all D10 limits remain fatal.
- **C2:** navigation labels wrap within their existing rail/bar widths, without ellipsis. The phone bar
  retains 12px label type, 40px targets and its 64px maximum; a 15px icon leaves room for two full label lines
  above the tested safe-area inset. Rail controls do not flex-shrink their wrapped text at 200% zoom.
- **C3:** clipped-control detection includes navigation anchors, their label spans and both composer chips,
  in addition to every previously checked control. It checks horizontal and vertical fit. Chips wrap, and
  the follow-up chip gets a 30% width allowance, leaving a 40px input and room for its Cancel control.
  Phone note chips wrap within 20%, with compact line spacing/padding and unchanged 12px type; this keeps
  the original literal draft on one textarea line at 390px even with the wider text. Automatic growth remains.
  A complete browser invocation automatically runs a second **fatal** full matrix with `--wide-font`;
  it cannot report success if that child fails. No optional/non-fatal scratch check is used.
- **C4:** only validated entries with `risk: low` or `risk: sensitive` show Low/Sensitive. Invalid entries,
  even if they carry a stale risk field, and entries without an assessed risk show **Risk: not assessed**.
  Server validation errors remain escaped and visible word for word.
- **C5:** Projects' header and summary use **1 session**, otherwise the recorded count with **sessions**.
  Server counts, the rail's union/disclosure, pagination and all data sources are unchanged.

Only `chat/chat.css`, `chat/sections.js`, `chat/shell.js`, `tests/test_chat_ui.cjs`,
`tests/chat_screenshots.cjs`, `CURRENT_STATE.md` and this appended report change. No Python/Python test,
classic, state, endpoint, schema, engine, approval, authentication, journal or privacy change.
The review's restored architecture §10 one-place-per-control rule is retained unchanged.

### Reproduction and strengthened assertions

Tests were added before product fixes. On the `65b07e2` product:

| Regression | Actual failure / evidence |
|---|---|
| Wide text, Session details open, 1280×800 at 200% zoom | `n11-singleMembers zoom clipped control waiting-pointer`: scrollWidth **226**, clientWidth **190**; `/tmp/ac-n11-before-pointer.log` |
| Wide text, 320×640 navigation | `n11-narrow clipped control Workspace`: scrollWidth **71**, clientWidth **53**; `/tmp/ac-n11-before-phone.log` |
| Wide text, normal desktop rail | Workspace **71 > 67**; `/tmp/ac-n11-before-nav.log` |
| Invalid skill DOM case | Card showed `Problem: Invalid <manifest>Low`, not `Risk: not assessed`; `/tmp/ac-n11-dom-before.log` |
| Singular count DOM case | Header/summary included `1 sessions`; same log. **273/275 passed**, the two new cases failed |

The width stress adds **0.06em letter spacing to every glyph**, through a test-only injected stylesheet;
no installed-font choice or downloaded font is required. Calibration records both widths in
`n11-layout-results.json`: here Workspace at 12px grows **64.09 → 70.58px**, exceeding the review's
66px DejaVu Sans case; the waiting pointer at 24px grows **198.38 → 225.73px**, exceeding its reported
220px requirement. This reproduces the observed common-fallback-width difference with margin, and runs
on whatever local font the browser resolves. Product font stacks and user zoom remain unchanged.

**Every assertion added/changed:**

1. New DOM `N1.1 invalid and unassessed skills never claim an assessed risk`: invalid, unassessed and
   invalid-with-stale-risk cards require Risk: not assessed and exclude Low/Sensitive; valid low/sensitive
   cards retain their labels; hostile error text remains text and no POST occurs.
2. New DOM `N1.1 Projects header and summary use the recorded singular and plural session counts`:
   both surfaces require 0 sessions, 1 session (excluding 1 sessions), and 2 sessions.
3. `zoomCheck`: replace its existing button/summary/select/input width-only loop with the same fatal
   width threshold (scrollWidth ≤ clientWidth + 1), plus vertical fit and navigation anchors/labels/chips.
   Actual font doubling, overflow, reachable composer, accessibility and focus checks are unchanged.
4. `layoutCheck`: add the new navigation/chip fit checks at every existing state/width.
5. `n1Sections`: add the same full-label checks for all six sections at every width; require no ellipsis.
6. New `n11Layout`: five named B1 states (`singleMembers`, `teamProposed`, `teamReview`, `teamRunning`,
   `teamUnusable`) explicitly open Session details and pass 200% zoom; all ten widths check navigation
   and chips with the sheet closed. Fifteen fatal cases, seven additional screenshots per pass.
7. Complete matrix entry/exit: install the stress style in every wide-pass page/context; normal full
   invocation requires the wide child to exit zero. Counts include the fifteen added cases per pass.
8. New optional `--state=<name>` diagnostic filter validates the named state, then runs its unchanged
   fatal cases and the five retained stale/live races, saving layout geometry and a pre-check screenshot.
   It suppresses unrelated fixture/section setup only in this explicitly focused mode. Neither complete
   matrix pass uses a state/viewport filter, and neither can skip any carried-over case.

No carried-over DOM assertion was replaced or removed. The 273 accepted cases are preserved. No footer,
target, contrast, input, alignment, waiting-count, focus, request-shape or other behavior threshold is relaxed.
All 46 N1 regression cases and all 540 N1 combinations carry over into each pass.

### Verification and inspected renders

All verification is fresh against N1.1. The normal full command automatically launches the mandatory
wide-font full command only after closing its browser. Neither invocation uses a state/viewport filter.

| Check | Command / evidence | Result |
|---|---|---|
| Chat DOM | `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_chat_ui.cjs`; `/tmp/ac-n11-chat-final.log` | **275/275**: all 273 carried over plus two new regressions |
| Classic DOM, unchanged | `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_ui.cjs`; `/tmp/ac-n11-classic-final.log` | **82/82** |
| Routes, unchanged | `PYTHONPATH=agent-autonomy:agent-autonomy/tests python3 -m unittest -v test_chat_routes`; `/tmp/ac-n11-routes.log` | **4/4**, 4.752 s |
| Full normal + required wide browser | `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/chat_screenshots.cjs /tmp/chat-shots-n11-final6`; `/tmp/ac-n11-browser-final6.log` | **Each pass: 540 combinations + 61 regression cases, 821 screenshots**; total **1,080 combinations, 122 cases, 1,642 screenshots** |
| Cutover smoke | Included, unchanged, in each full pass | **5/5 per pass** |
| Isolated fixture | Included, unchanged, in each full pass; each `n1-fixture-results.json` | **9/9 per pass**: six sections, create real git project, switch back, Forget/reconnect; disposable roots removed |
| Real server | `NODE_PATH=/tmp/ac-tests/node_modules node /tmp/ac-n11-real-check.cjs`; `/tmp/ac-n11-real.log` | **8/8**, **67 GET (64 API + 3 SSE) / 8 POST** |
| Python, unchanged | `python3 -m unittest discover -s agent-autonomy/tests -v`; `/tmp/ac-n11-python-verified.log` | **424 tests, OK (skipped=3), 260.249 s**; exact failed attempts and isolated retries below |

All original contrast pairs, target/input bounds, keyboard/focus paths, forced colours, reduced motion,
200% text zoom, server-authoritative decisions and waiting/count tests remain fatal and pass in **both**
matrices. The 26 contrast pairs and all ten viewport sizes are unchanged. The fifteen additional layout
cases explain **46 → 61** regressions; no earlier case was removed.

Inspected final renders in both `/tmp/chat-shots-n11-final6` and `/tmp/chat-shots-n11-final6-wide`:
all five `n11-<B1-state>-text-zoom-dark.png` files at **1280×800 / 200%**, and
`n11-navigation-phone.png` / `n11-navigation-narrow.png` at **390×844 / 320×640**.
The full names fit; wider waiting text and the recovery link occupy separate rows. Turn details preserves
its existing desktop one-flex-row assertion, with its pointer/link text allowed to wrap internally.
Phone `footer-measurements.json` is identical across the two final passes (47 cases per orientation):
**57px idle / 105px waiting**, conversation **≥68.95%** at 390×844; landscape **59px / 107px**,
conversation **≥57.82%**. The bar remains ≤64px with its safe-area check and hides for the normal-zoom
keyboard. Actual native keyboard/assistive-technology/device testing is not claimed.

The real-server repeat uses the same M9/N1 harness and fakes, copied only to fresh `/tmp/ac-n11-*`
paths. Per-step GET/POST remain **8/1, 3/1, 6/1, 21/2, 8/0, 10/1, 3/1, 8/1**. Every fully paged
checkpoint preserves waiting = actionable non-outcome messages and cards = actions + actionable outcomes.
Critical typed permission, question, team approval, live Turn details, recorded Verify, confirmed Apply and
inherited follow-up pass. Boot **21 GET / 0 POST**, separate Auto **2 GET / 1 POST**, shared-key classic
smoke **9 GET / 0 POST**. `/tmp/ac-n11-real-results.json` contains receipts/counts; cleanup passed.

**Development retries (no weakened assertions):**

- The first normal matrix exposed waiting text/link alignment differing by **11px**;
  `/tmp/ac-n11-browser-normal.log`. Restored vertical alignment of the classic link.
- Follow-up wrapping initially made the phone idle footer **79px**; `/tmp/ac-n11-browser-final.log`.
  A first width adjustment squeezed the narrow composer to **16.67px**;
  `/tmp/ac-n11-browser-final2.log`. The final 30% follow-up width and compact phone chip spacing
  preserve the existing 40px target and footer assertions.
- `/tmp/ac-n11-browser-final3.log` hit the unchanged **45-second cutover fixture startup timeout**.
  The unchanged five-case smoke passed alone (`/tmp/ac-n11-cutover-retry.log`), then in both final
  full matrices. No timeout, backend, fixture or runtime setting was changed; no leftover test process remained.
- `/tmp/ac-n11-browser-final4.log` caught the existing Turn details one-flex-row assertion after the
  initial universal wrap rule. That assertion is unchanged: Turn details now keeps one flex row while
  permitting text wrapping inside its two controls.
- The normal pass in `/tmp/ac-n11-browser-final5.log` passed fully; the mandatory wide child correctly
  failed on **composerLiteral footer 129px**, so the parent failed too. The focused case reproduced it
  (`/tmp/ac-n11-literal-before.log`, `/tmp/ac-n11-literal-probe.log`). Wrapping the phone note chip and
  removing its extra horizontal padding gave the same literal draft enough width; the focused case then
  passed (`/tmp/ac-n11-literal-after.log`). Final compact chip spacing restores **105px** waiting footers.
  Draft text, slash/mention handling, textarea growth and the **112px** assertion are unchanged.
- Diagnostic wide-font runs for `composerLiteral`, `composerFollow`, `composerTarget` each passed
  **10 widths + five stale/live races** before the final complete runs; `/tmp/ac-n11-<state>-wide.log`.
  These focused checks are additional evidence, never a substitute for the unfiltered normal/wide matrices.

Python ran after both browser passes and real-server checks finished. The first unchanged full run was
**424 tests, FAILED (failures=1, skipped=3), 262.696 s**, `/tmp/ac-n11-python.log`.
Its only failure was `test_agents.ControllerLifecycleTests.test_a_turn_records_join_work_approval_and_finish`
at `test_agents.py:209`: expected `('coder-1', 'working', 'finished')`, observed
`('coder-1', 'idle', 'finished')`. This is the exact pre-redesign lifecycle sampling failure documented in
`CURRENT_STATE.md` (reproduced on `af4da89`; a short working state can fall between the 0.5s samples),
not a new frontend-dependent assertion. No backend, protected test, timeout, runtime flag or skip was changed.
The same unchanged test passed alone: **1 test, OK, 2.575 s**,
`/tmp/ac-n11-python-isolated.log`.

The second full run was **424 tests, FAILED (failures=1, skipped=3), 261.038 s**,
`/tmp/ac-n11-python-retry.log`. `test_vm.VMRunTests.test_console_input_is_checked_and_audited`
failed at `test_vm.py:255`: expected the last three events to be
`[('click', 10, 5, 640, 400), ('type', 'ls'), ('key', 'Return')]`; instead the background
`('push', '/tmp/tmpnq6d9it_/state/worktrees/1b2c8772a36e/coder-1')` displaced `click`, leaving
`type`, `key`, `push`. This is the same asynchronous VM log race documented in the accepted M9 Part B
report. The lifecycle and VM tests passed unchanged together: **2 tests, OK, 3.783 s**,
`/tmp/ac-n11-python-isolated-both.log`.

The third full run was **424 tests, FAILED (failures=6, skipped=3), 406.135 s**,
`/tmp/ac-n11-python-final.log`. All six failed at the unchanged `test_workflow.py:149` assertion,
**Timed out waiting for workflow condition**, within its fixed five-second wait:

| `test_workflow.WorkflowTests` case | Condition / caller |
|---|---|
| `test_deny_redirect_is_saved_once_before_dispatch` | `bool(c.state()['inbox'])`; line 560 → `review_run`, line 402 |
| `test_double_tap_sends_only_one_decision` | Same inbox condition; line 450 → `review_run`, line 402 |
| `test_failed_verification_triggers_correction_same_session` | Terminal run; line 172 → `done`, line 152 |
| `test_full_http_cli_and_notification_path` | Terminal run; line 367 → `done`, line 152 |
| `test_goal_check_added_midrun_is_saved_and_forwarded` | `len(api.prompts) == 1`; line 552 |
| `test_goal_checks_time_limit_and_followup_context` | Terminal run; line 532 → `done`, line 152 |

These six passed in both earlier full attempts, then passed unchanged together in isolation:
**6 tests, OK, 6.551 s**, `/tmp/ac-n11-python-workflow-isolated.log`. The delayed-worker/fixed-five-second
wait mechanism is already documented in M5, M7 and M9.1a verification; this comparison does not claim
every one of these exact case names previously failed. All full Python runs were started after the browser
and real-server work finished. No concurrent heavy browser test, backend change, test weakening, timeout
increase, new skip or runtime workaround was used. Acceptance §A2 requires the full unchanged retry as
well as isolated passing tests. The fourth full run passed unchanged: **424 tests, OK (skipped=3),
260.249 s**, `/tmp/ac-n11-python-verified.log`. Nonfatal unclosed-socket ResourceWarnings remain;
they were not suppressed or changed.

The same three skips in every full run were gates, never passes:
`test_container_e2e.ContainerRunE2E.test_agent_works_in_a_locked_down_container`
(requires `AGENTCONTROL_CONTAINER_TESTS=1`, runtime and image),
`test_preview.DesktopTests.test_desktop_preview_shows_frames_and_accepts_input`
(desktop tools missing), and `test_vm_e2e.VMRunE2E.test_agent_works_in_a_kvm_clone`
(requires `AGENTCONTROL_VM_TESTS=1` on a KVM host). All three real-OpenCode tests ran and passed.
The final full run passed all previously failing cases. These gate labels are distinct from the
**421 executed, passing tests**; no physical-device result is inferred from browser emulation.

### Optional findings and limits

O2 is addressed by the same rail-label wrapping and zoom checks. O5 is required C5 above.
O1 (redundant Sign-in button), O3 (Escape during an in-flight project write can hide the later refusal),
O4 (positional panel HTML extraction) and O6 (duplicate Channels block) are deliberately left unchanged;
this correction concentrates on the required layout, risk and count fixes. No project/decision delivery
or authorization behavior was redesigned. The existing in-flight skill-fetch race remains excluded.
Physical iOS/Android and assistive-technology testing is not claimed. Persistent Primary/Agents/Direct,
Memory and project files remain unavailable; interactive surfaces remain in classic.
Stop for Opus re-review after pushing only the feature branch.
