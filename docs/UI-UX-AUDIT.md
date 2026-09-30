# UI/UX and theme audit

Date: 2026-09-30. Based on the screenshot matrix (414 images; 3 themes × desktop, laptop and phone) and the code at `ce06c05`. Screenshot names are `tests/screenshots.cjs` scenarios. All eight quick wins from §5 were applied afterwards (the fix note at the end of this file); the bigger changes await a decision.

## Context
You asked me to table W7 and do an honest audit of the whole UI/UX, especially the themes. This is an audit only: nothing in the app changes.

How I looked:
- The current screenshot matrix: 414 screens across Mac, Terminal and XP at desktop, laptop and phone widths.
- The live checks from W1–W6.
- The code behind what I saw.

Screenshot names below are the `tests/screenshots.cjs` scenarios, e.g. `active-xp-desktop`.

**Overall verdict.** The product is capable and careful: approvals, the evidence trail, and live output. The UI has grown by *adding* surfaces milestone after milestone, and almost never by *removing* them. The result is too many ways to see the same thing, and chrome that competes with the content. The themes are charming, but they multiply that clutter, and they triple the styling cost of every feature.

---

## 1. Structure (the biggest problems)

**1.1 The same thing is shown in too many places.**
- **Agents:** an agent can be viewed in three places:
  - Mission cards
  - Runs, with its agent filter
  - Workspace, in three layouts
- **Approvals:** one pending approval appears up to five times on one screen (`active-xp-desktop`):
  - the inline card
  - the terminal's "! python3 … Review" line
  - the sidebar badge
  - the XP balloon
  - the XP tray, plus the Approvals page
- **Pause and Stop** appear up to four times: the page buttons, XP's toolbar, XP's "Run Tasks" pane, and the Mission header.

→ Give each page one job:
- **Mission** is the overview.
- **Workspace** is per agent.
- **Runs** is history and detail.
- **Approvals** is the queue.

Remove the Runs agent filter, since Workspace replaces it. Show one approval surface per screen. Keep one Pause/Stop location.

**1.2 The sidebar is overloaded.**
- It holds 9 nav items, "Recent runs" with an "All projects" checkbox, and "Agents · last check".
- That last section lists the *services* Hermes and OpenCode, not the run's agents (coder-1, coder-2). That contradicts the whole Agents concept.

→ Move service health into a compact "Connections" status in the footer or top bar. Group Skills, Usage and Activity under "More". Keep about 5 primary items: Mission, Workspace, Runs, Approvals, Project.

**1.3 The run title is the truncated brief.**
- Every page opens with a 2–3 line bold headline ending in "Use…" (Runs, Mission, Project, the XP window title).
- It is the largest element on the screen, and it carries the least information.

→ Use a short generated title ("Todo CLI with JSON storage"). The brief stays behind "Read brief". The existing optional Title field is rarely filled, so fall back to a summary instead of the raw brief.

**1.4 Words collide.**
- **"Workspace"** is the agent view, the git worktree ("Works in branch…"), the page's `<main id="workspace">`, and the login button "Connect to workspace".
- **"OpenCode" vs "coder-1"**, and **"prompt" vs "turn"**, are used interchangeably:
  - "opencode — turn 2"
  - "Prompt 2 of 6"
  - "2 coding prompts submitted"
- The New run Agents panel still says "OpenCode · coder".

→ Pick one term for each and apply it everywhere:
- the agent's name (coder-1) is the actor, and OpenCode is its runtime
- a "turn" is one unit of work
- the login says "Connect"

**1.5 The theme switcher sits in the top bar on every page.**
You change it once in a while. → Move it into settings or More (for XP, the View menu; for Terminal, `:theme`).

## 2. Pages

**Runs (`active-*`, `completed-*`)**
- The board's Plan, Prompt and Verify columns stretch to the terminal's height, leaving large empty boxes. → Size the columns to their content, or collapse finished stages to a one-line chip.
- The time budget reads "33h 27m of 30m 0s" with no "over the limit" wording, and XP shows a full green bar for it. → Clamp the bar, show "over by 33h", and use the warning colour.
- **Completed runs repeat themselves:**
  - the summary appears twice ("The todo app works…" in the header and in the card)
  - "Original brief" repeats "Read brief"
  - "How the run went" restates the counts
- **"Goal checks · 0 of 2 verified"** with an empty progress bar on a *passed* run reads as a failure, although checks are never auto-verified. → Show "not checked individually" in neutral styling, with no progress bar.
- The steering box, "+ Add a goal check", "Ask for a status" and "Enter sends · Shift+Enter…" are four lines of controls under the board. → Keep the input, and move the rest into its menu.

**Review dialog (`review-*`)**
- **A copy bug:** the footer says "Approval applies to this request only unless you tick the box above", but no box is shown for this request.
- The dialog repeats the whole brief above the command. → Show the command and its risk first, and the brief collapsed.

**Mission (`mission-*`)**
- Good at a glance.
- But its header has four buttons: "1 item waiting for you", "Open run", Pause and Stop. The cards each end with a "Workspace" button, and the tasks with "Workspace ›", which crowds the view. → Make the whole card the link, remove the per-task links, and keep one "waiting" button.
- The Resources text is tiny and grey on grey ("1 of 1 slot busy…").

**New run (`newrun-*`)**
- One very long form (about 1,900 px) with help text under every field.
- The Container and VM options are shown even when they can't be used ("Checking for a container runtime…").

→ Split it into basic (title, brief, folder, verification) and **Advanced**, collapsed (isolation, preview, limits, models, team size). Show an unavailable option as a single greyed line with "why?".

**Project (`project-*`)**
- A ~600 px empty black terminal before anything runs, with "Exited" and "Start preview" both at the top. → A compact empty state until the preview starts.
- The preview settings form sits permanently under the preview. → Move it to a "Settings" disclosure.

**Skills (`skillstab-terminal-*`)** has a large blank band above its heading in the Terminal theme, which is a layout bug.

**Workspace**
- Solid: tabs, split, windows and pop-outs all work.
- But each pane repeats a 5-row facts table (Model, Tools, Skills, Works in, Usage) that rarely changes, and it pushes the terminal down. → Collapse it to a single line with a hover or expand.
- The "Private model reasoning is not recorded…" sentence repeats in every pane. → Say it once in help.

**Phone (`active-mac-phone`, `workspace-xp-phone`, `mission-xp-phone`)**
- Pause and Stop sit above the approval card.
- The card's big centred icon pushes the Approve and Deny buttons below the fold.
- The bottom tab bar covers part of the content.

→ On phones, show approvals first and compactly (actions visible without scrolling), put Pause and Stop in a menu, and pad the page for the tab bar.

## 3. Themes

**Mac** is the cleanest and closest to done:
- Cards inside cards, and many borders plus shadows, make it feel busy. Use fewer containers and more spacing.
- The selected recent run is a loud solid-blue block. A subtle highlight is enough.
- The approval card's 48 px orange icon and centred layout is heavy. A left-aligned banner with the command and buttons is enough.
- Type sizes jump between panels (headline 32 px, labels 12 px, facts 13–14 px). Set a tighter type scale.

**Terminal** has the strongest identity, but mixes metaphors:
- Rounded pill buttons ("Send") and coloured traffic-light dots don't belong in a tty look.
- Three border styles appear: the `┤ legend ├` box drawing, solid boxes, and a dashed rule.
- **Four chrome regions:** the top status line, the sidebar, the page, and the bottom key bar. The key bar lists keys that don't apply to the current view.
- The top status line duplicates the page status ("NEEDS YOUR APPROVAL" twice).
- Dim secondary text (grey on near-black at 11–12 px) is hard to read.

→ Commit fully to text-mode:
- square buttons, one border style, no rounded shapes
- a key bar that shows only the keys for the current view
- brighter secondary text

**XP** is the most charming and the most cluttered:
- **Seven chrome layers come before any content:** the window title bar, the menu bar, the toolbar (Pause, Stop, Theme, New run), the address bar, the sidebar task pane, the taskbar and the status bar.
- The **notification balloon stays up** and covers content (the terminal's Copy button, the approval's "Inspect full request", an Approvals row).
- The **login screen doesn't use XP chrome**, and its subtitle is dark text on blue, which is unreadable (`login-xp-desktop`).
- "Theme :" wraps onto two lines.
- The tabs' red close squares are heavy (`workspace-xp-phone`), and on a phone the tab strip starts scrolled so that "Mission" is cut to "sion".
- The fixed taskbar overlaps the bottom of the page.

→ Have fewer layers:
- drop the address bar and the "Run Tasks" pane
- let the balloon auto-hide after a few seconds
- give the login an XP window
- use smaller tab close buttons

**Across themes:**
- Each theme restyles almost every component: `app.css` is about 5,000 lines and `workspace.css` about 1,000. Every new feature therefore needs three designs and three rounds of screenshot review. That is why W1–W6 each spent time on per-theme fixes.

→ Narrow the themes to tokens (colour, font, radius, border style) plus chrome (window frame, taskbar, status line), and let components share one layout. You would keep the look and halve the upkeep.

## 4. Accessibility and wording
- **Contrast:** the XP login subtitle fails, and Terminal's muted text and Mac's grey-on-grey Resources text are borderline.
- **Colour-only status:** recent-run dots and some pills rely on colour alone. The workspace tabs already pair colour with a symbol (● ! ✓), so use that pattern everywhere.
- **Help text** sits under nearly every field and panel. Keep the essential sentences, and move the rest into "?" tooltips or help.
- **Copy:** fix the review dialog's "tick the box above" when there is no box, and "Connect to workspace".

## 5. What I would do first
**Quick wins (hours):**
1. Fix the review dialog's copy.
2. Auto-hide the XP balloon.
3. Give the XP login contrast and window chrome.
4. Clamp the over-budget time display.
5. Size the board columns to their content.
6. Neutral styling for unchecked goal checks.
7. Rename "Agents · last check" to "Connections" and show the run's agents instead.
8. Fix the phone tab-strip scroll ("sion") and the Skills top gap.

**Bigger changes (days):**
1. One job per page: remove the Runs agent filter and show one approval surface per screen.
2. A slimmer sidebar and a "More" group.
3. Short run titles.
4. New run split into basic and advanced.
5. Terminal fully text-mode, and XP with fewer layers.
6. Themes reduced to tokens plus chrome.

## Quick wins applied
1. **Review dialog copy:** "…unless you tick the box above" now appears only when the box is actually offered.
2. **XP balloon:** it pops up only for a request you haven't seen, and hides itself after 8 s; the tray keeps the count.
3. **XP sign-in:** it is now an XP window, with a blue title bar and a solid, readable body.
4. **Over budget:** the time reads "30m 0s limit · over by 3h 12m" in the warning colour (Mission, Runs, the Terminal status line), and XP's meter turns red.
5. **Board:** Plan, Prompt and Verify are as tall as their content, with no empty boxes beside the terminal.
6. **Goal checks:** until a check is evaluated they show as "saved requirements", with no progress bar that reads as failing.
7. **Sidebar:** "Agents · last check" is now "Connections", since it lists services.
8. **Layout:**
   - Short pages (Skills, and any other page) no longer start ~110 px down. The cause was `.workspace { margin:auto }`, which also centred pages vertically.
   - The workspace tab strip always starts on a whole tab (no cut labels such as "sion"), and on phones it drops its Mission tab, since the bottom bar already has one.

