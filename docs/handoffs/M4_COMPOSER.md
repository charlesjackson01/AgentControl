# Handoff M4: Composer (talk to the project room)

**From:** Opus (architecture) → **To:** Codex (implementation)
**Branch:** `feature/chat-first-redesign`. Commit and push only there; **never merge into `main`**.
**Prerequisite:** M3 and M3.1 are **accepted** (review 2026-09-30, `docs/handoffs/M3_1_CORRECTIONS.md`).
**Read first, in this order:**
1. `CURRENT_STATE.md`
2. `docs/REDESIGN_ARCHITECTURE.md` (binding; §3, §7, §9, §10 and §11 matter most)
3. `docs/handoffs/M3_ROOM_TIMELINE.md` and `M3_1_CORRECTIONS.md` (the room you are extending, and its reviews)
4. this file

**Size:** about 2–3 days.

---

## 1. Outcome

The disabled footer becomes the room's **one composer**. From `/chat` you can:
- start a new session with a goal (with a Settings sheet)
- reply to a finished session with a follow-up
- send notes to Hermes during a session, optionally aimed at one agent with `@agent`
- pause, resume or stop the active session
- add a goal check or rename a session, with slash commands

Everything you send appears in the room **only when the journal records it**: through the existing `/api/thread`
refresh, never as a client-side echo. On phones, the footer shrinks to a compact single line, so the room keeps the screen.

This is **the same room and the same interaction model as M3.** M4 adds one input and a few controls; it does not add a new page, panel or mode.

**Still not in M4** (M5 handles them): decisions on agent requests, team proposals, research, skills and outcomes (Apply, Discard, Verify).
Those keep linking to the classic dashboard, exactly as in M3.

## 2. Hard rules

1. **Existing endpoints only, and exactly their current bodies.**

   | Purpose | Endpoint and body |
   |---|---|
   | new session | `POST /api/runs {goal, title?, verifier?, goal_checks?, max_steps?, run_minutes?, mode?, team_size?, isolation?, network?, cpus?, memory_gb?, setup?, allow_dirty?, preview?}` |
   | follow-up | the same, plus `parent_run` |
   | note | `POST /api/control {run, action:'instruction', text, agent?}` |
   | goal check | `POST /api/control {run, action:'goal_check', text}` |
   | rename | `POST /api/control {run, action:'title', text}` |
   | pause / resume / stop | `POST /api/control {run, action:'pause' \| 'resume' \| 'stop'}` |
   | re-check connections | `POST /api/check {}` |
   | mode preview (read-only) | `POST /api/mode/preview {goal, goal_checks, verifier, max_steps}` |
   | dirty-folder check | `GET /api/workspace/preflight` |
   | isolation availability | `GET /api/sandbox`, plus `state.vm_env` from `/api/state` |

   **No new endpoint, no server change, no schema change.** If a need cannot be met with these, stop and record it as an open question.
2. **No fabricated messages.**
   - Do not insert sent text into the timeline. After a 2xx response, clear the draft, show a brief composer status
     ("Sent · it will appear in the room"), and trigger one immediate coalesced refresh. The real `note`, `goal` or
     `session_start` message arrives from `/api/thread`.
   - Hermes does not reply to notes; keep the M3 hint "Hermes reads this before the next turn".
3. **No decision controls.**
   - Nothing in M4 approves, denies, answers, applies, discards or verifies. The M3 DOM guard stays: no button or link named Approve, Deny, Apply, Discard, Verify, Reject or Answer.
   - `/verify`, `/apply` and `/team …` are **not** M4 commands (§5.4).
4. **Paid models and the stuck watch stay in classic.** They need typed confirmations and send data to external
   services. The Settings sheet shows one line, "Paid models and the stuck watch: set them in the classic dashboard",
   with a link. **Never** send `models`, `spend_cap`, `confirm` or `watch` from `/chat`.
5. **Internet during work needs confirmation.** `network: 'internet'` with container or VM isolation requires the
   server's typed confirm word. Do not offer `internet` in M4; offer `setup` (the default) and `none` only, and point to classic for internet access.
6. **Server validation is the authority.** Mirror the limits only as input hints:
   - goal 1–12,000 characters
   - title ≤ 120
   - notes 1–5,000
   - goal checks: at most 20, each 1–1,000
   - `max_steps` an integer 1–20
   - `run_minutes` an integer 1–120
   - `verifier` and `setup` ≤ 2,000 characters (the server splits them with `shlex`)

   On a 4xx response, show the server's `error` inline next to the composer, **keep the draft**, and change nothing else.
7. **One request at a time.** Disable Send while a request is in flight. That prevents double-submitting a note or a second session.
8. **Storage.** Remembered Settings defaults go under `acx-` keys in `localStorage`: verifier, limits, mode, isolation,
   network and preview. The unsent draft may be kept in `sessionStorage` (`acx-draft`) only. Never store the dashboard key anywhere new.

## 3. Composer states (architecture §7, refined)

The composer's target is always visible: in the placeholder, and in a small **target chip** at its left edge.

| Room state (from `/api/thread` `live` and `/api/state`) | Chip | Enter sends | Endpoint |
|---|---|---|---|
| no active session in this project | **New session** | the goal | `POST /api/runs` |
| "Reply in session" chosen on a finished session | **Follow-up · ‹title›** (with ✕ to cancel) | the follow-up goal | `POST /api/runs {…, parent_run}` |
| active session running | **Note → Hermes**, or **Note → @agent** after a mention | a note | `POST /api/control {action:'instruction'}` |
| active session paused or interrupted | **Note → Hermes**, plus a **Resume** chip beside it | a note; the Resume chip calls `resume` | `/api/control` |
| a session is active in **another** project | disabled: "A session is running in ‹project›. Finish it there first." | nothing | none |
| connections not ready (`state.health.ready === false`) for a new session | the chip still shows | nothing; show "Connections are not ready" with **Check again** (`POST /api/check`) | none |

- **Reply in session.** Add a quiet "Reply in session" link on the `outcome` footer of **every finished session in this
  project's room** (not in the single-session view of another project). It sets follow-up mode. The follow-up
  inherits the parent's `verifier`, `max_steps` and `mode` from `/api/state?run=<parent>`, which is the existing
  session-details read. The Settings sheet shows these values and lets you edit them.
- **Mentions.**
  - Typing `@` opens a suggestion list of the active session's **non-orchestrator agents** (from `/api/state` `agents`).
  - Choosing one sets the chip to "Note → @name" and sends `agent: name`. The text is sent **without** the `@name` token.
  - Only one agent per note: a second mention replaces the first.
  - An unknown name is a local error: "This session has no agent named ‹x›".
- **Keys.**
  - Enter sends on devices with a fine pointer; on touch devices, Enter inserts a newline and the Send button sends.
  - Ctrl/⌘+Enter always sends. Shift+Enter always inserts a newline.
  - Escape closes the mention list, then cancels follow-up mode.
- **Status line** (`role="status"`, one stable node): "Sending…", "Sent · it will appear in the room", or the server error.

## 4. Settings sheet (new session and follow-up)

It opens from a **Settings** control next to Send, and only in the New session and Follow-up states.
It is a sheet (the M1 context-panel pattern: a side panel on desktop, a bottom sheet on phones), not a page.
Progressive disclosure: **Basic** is visible and **Advanced** is collapsed.

- **Basic:**
  - Title (optional)
  - Verification command
  - Goal checks (add/remove rows; at most 20)
  - Mode: Single, Team or Auto. Auto shows the `/api/mode/preview` explanation, read-only, before sending.
    Team shows team size (2 up to the server's maximum; take the default from the classic form's constants or the server error)
- **Advanced** (collapsed):
  - Turn limit (`max_steps`) and time limit (`run_minutes`)
  - Isolation: Host, Container or VM. Show options that are unavailable (per `/api/sandbox` and `state.vm_env`) as one greyed line with a "why?" disclosure carrying the server's reason.
  - Network (`setup` or `none`) and CPUs/memory, for container and VM only
  - Setup command
  - Preview: mode from `state.capabilities.preview_modes`, plus its command, port or path fields as classic sends them.
    Copy classic's `preview` body shape, with a source comment.
  - **Uncommitted changes:** if `GET /api/workspace/preflight` reports `dirty_count > 0`, show the count and require
    an explicit "Start anyway with uncommitted changes" checkbox, which sends `allow_dirty: true`.
- The paid-models and stuck-watch line from §2.4.

Remember the last used Basic and Advanced values (§2.8). Never pre-fill the goal from storage, except the unsent session draft.

## 5. Session controls and slash commands

### 5.1 Pause, Resume and Stop: one place

- The **room header** shows a "⋯" menu for the active session: **Pause** (or **Resume** when paused or interrupted) and **Stop…**.
  This is the only place for these controls (architecture §10). The Resume chip in §3 is the same action.
- **Stop…** opens a `<dialog>` confirmation: "Stop ‹title›? The current turn is aborted and the session ends. This
  cannot be resumed." It has **Stop session** and **Cancel**, focus starts on Cancel, and Escape cancels.
- Every result appears through the journal (the `control` system line and the status change). Show server errors inline in the menu.

### 5.2 Slash commands (aliases only)

| Command | Does |
|---|---|
| `/pause`, `/resume` | the same as the menu |
| `/stop` | opens the same confirmation dialog; it never stops without it |
| `/check <text>` | `goal_check` on the active session |
| `/title <text>` | `title` on the active session, or on the focused session when none is active (the server allows renaming finished sessions) |
| `/help` | lists these commands in a small popover. Local UI only; nothing is sent |

Typing `/` at the start shows the command list. An unknown command shows an inline error and the text stays.

### 5.3 Focus and the room

After a successful send, the room follows to the bottom (M3's follow mode). The new message arrives through the
normal refresh, and focus returns to the composer.

### 5.4 Deferred to M5 (do not implement)

`/verify`, `/apply`, `/discard` and `/team approve|single|repropose`, and every control on request, proposal,
research, skill or outcome cards other than "Reply in session". This refines architecture §7; record it in the change log (§9).

## 6. Layout: give the room its space back

**Measured in the M3.1 review:** on a 390 × 844 phone, the footer takes **257 px with the waiting strip, and 181 px
without**, about 30% of the screen. M4 fixes this by design:

- **The idle composer is one line** (about 44 px): the target chip, an auto-growing textarea and Send, with Settings when relevant.
  - It grows with content up to **6 lines, or 40% of the viewport height**, whichever is smaller, then scrolls inside.
  - Its label is visually hidden but present for assistive technology. The visible "Project room" eyebrow label is removed.
- **The waiting pointer is a slim single-line row** above the composer (about 32–40 px): "! N waiting for you ·
  Open classic dashboard". Align the pointer button and the link on one baseline; that fixes the misalignment found in the M3.1 review.
- **Remove the footer's separate "Open classic dashboard" link.** Classic stays reachable from the waiting row, the
  rail's More menu and each actionable item. Add "Classic dashboard" to the room header's "⋯" menu too.
- **Budgets, asserted in the browser matrix at 390 × 844:**
  - idle footer ≤ **72 px** without the waiting row
  - idle footer ≤ **120 px** with it
  - the timeline keeps at least **65%** of the viewport height
- **On-screen keyboard:** use `visualViewport` where available so the composer stays above the keyboard. There is no
  test for this in linkedom; verify it manually on a phone browser or an emulator if you can, and record the result.
- **Desktop and laptop:** the same compact composer, inside the room column's max width (`--room-width`).
- **Tokens only** (the existing guard applies). Light and dark follow the system.

## 7. Files

| File | Change |
|---|---|
| `agent-autonomy/chat/composer.js` | **new**, `AC.composer`. Pure helpers exported with the CommonJS guard (`composerState`, `parseSlash`, `parseMention`, `runBody`, `noteBody`, `followUpDefaults`, `limits`), plus the composer, mention list, slash popover and Settings sheet renderers |
| `agent-autonomy/chat/core.js` | a small `post(path, body)` using the existing `api()` (401 handling unchanged); expose `refreshNow()` for the after-send refresh |
| `agent-autonomy/chat/shell.js` | mount the composer; the room-header "⋯" menu; the Stop dialog; "Reply in session" routing |
| `agent-autonomy/chat/thread.js` | only the "Reply in session" link on finished-session outcomes |
| `agent-autonomy/chat/index.html` | the new footer markup, the dialog, loading `composer.js`, and the `?v=` bump |
| `agent-autonomy/chat/chat.css` | the compact footer, chips, sheet and dialog (tokens only) |
| `agent-autonomy/tests/fixtures.cjs` | additions only: composer states and server error bodies |
| `agent-autonomy/tests/test_chat_ui.cjs` | the new DOM tests; keep all 42 passing (update only assertions about the removed disabled footer) |
| `agent-autonomy/tests/chat_screenshots.cjs` | composer cases and the footer budgets |
| `CURRENT_STATE.md`, this file | status and completion report |

**No change** to `app.py`, `engine.py`, `conversation.py`, `journal.py` or any other backend file, or to the classic UI.

## 8. Tests

**DOM** (the existing harness; add a POST capture and scripted responses to the fetch stub):
1. **State machine:** each §3 state renders the right chip, placeholder and enabled or disabled Send. Moving between states (a session starts or finishes, or is paused) updates the chip without losing the draft.
2. **Exact bodies:**
   - a new session with only a goal sends `{goal}` plus only the Settings you changed or have remembered
   - a follow-up adds `parent_run` and the inherited `verifier`, `max_steps` and `mode`
   - a note sends `{run, action:'instruction', text}`; an `@coder-2` note sends `agent:'coder-2'` without the token
   - `/check`, `/title`, `/pause`, `/resume` and the Stop dialog send exactly their bodies
   - `models`, `spend_cap`, `confirm`, `watch` and `network:'internet'` never appear in any body
3. **No echo:** after a 2xx response the timeline is unchanged until the next `/api/thread` refresh returns the journal
   message. The draft clears, the status reads "Sent…", and exactly one immediate refresh cycle runs.
4. **Errors:** a 400 shows the server's text inline and keeps the draft; a 401 returns to sign-in (as in M1); a network
   failure keeps the draft. "Connections are not ready" offers Check again, which calls `POST /api/check`.
5. **Single flight:** a double click or Enter-repeat sends once.
6. **Stop:** `/stop` and the menu open the dialog; Cancel and Escape send nothing; only "Stop session" sends `stop`. Focus returns afterwards.
7. **Mentions:**
   - the list shows only non-orchestrator agents
   - keyboard navigation works (arrows, Enter, Escape) with `aria-activedescendant`
   - a second mention replaces the first
   - an unknown name gives the local error
8. **Slash:** the list appears on `/`; an unknown command gives an inline error and keeps the text; `/help` sends nothing.
   `/verify`, `/apply`, `/discard` and `/team` are reported as not available here, with the classic link, and send nothing.
9. **Settings:**
   - Basic and Advanced disclosure
   - unavailable isolation shows the server reason
   - dirty-folder preflight requires the checkbox and sends `allow_dirty:true` only when it is ticked
   - Auto shows the mode-preview explanation
   - remembered values come back from `acx-` keys, and the goal is never pre-filled from `localStorage`
10. **Keys:** Enter versus Shift+Enter versus Ctrl/⌘+Enter; the touch-pointer rule (stub `matchMedia('(pointer: coarse)')`).
11. **Guards kept:** no decision-named controls, no fingerprints in the DOM, tokens only, and no classic assets.

**Browser matrix** (`chat_screenshots.cjs`): add composer cases at desktop, laptop and phone, in light and dark:
- idle new session
- a note with the mention list open
- paused, with the Resume chip
- follow-up mode
- the Settings sheet open (Basic, and Advanced expanded)
- the Stop dialog

Assert the §6 footer budgets at 390 × 844, and assert that there is no horizontal overflow and no page errors.

**Real server check (required):** run `app.py`, or the M3 scratch harness with `ThreadAPITests`' journal, with the
**test fakes** for Hermes and OpenCode from `tests/test_workflow.py`, so that no real model or agent runs. Record:
- starting a session from `/chat` creates a run whose `goal` event then appears in the room
- a note appears as a `note` message
- Pause, Resume and Stop work
- a server validation error shows inline
- `/` and `/classic` still work

## 9. Out of scope, and M5 prerequisites

- **M5 (decision controls) must first reconcile the server-side mismatch** recorded in the M3 review.
  `/api/thread` can mark research (`awaiting_approval`) and skill (`proposed` / `awaiting_fetch`) items actionable
  on **finished** sessions, while `/api/channels.waiting` counts only the active session. **Do not change or work
  around this in M4.** It stays listed in `CURRENT_STATE.md` as an M5 prerequisite.
- Also out of scope: paid models, the stuck watch, internet during work, project switching and creation, presence and
  team panels (M6), Workspaces (M7), and live Hermes streaming (W7).
- **Architecture:** the slash-command split and the footer budgets are already recorded in
  `docs/REDESIGN_ARCHITECTURE.md` §7 and its change log (M3.1 review). No contract edit is needed for M4
  unless you find a gap.

## 10. Acceptance

1. `python3 -m unittest discover -s agent-autonomy/tests` passes; M4 changes no Python. Report skipped tests by name.
   An unchanged timing-sensitive backend test that fails intermittently is rerun and recorded, never modified.
2. `test_ui.cjs` passes 82/82. `test_chat_ui.cjs` passes (all existing tests plus the new ones). `chat_screenshots.cjs`
   passes, including the footer budgets.
3. The diff touches only the files in §7.
4. The real server check (§8) is recorded in the completion report.

## 11. When you finish

1. Append a completion report to this file:
   - what was built and any deviation
   - test commands and counts (with skipped tests named)
   - the measured footer heights at 390 × 844
   - the screenshots reviewed
   - the real server check
   - open questions for Opus
2. Update `CURRENT_STATE.md`: M4 status, new files and test counts.
3. Push to `feature/chat-first-redesign`. No PR and no merge unless the owner asks.

If this handoff conflicts with `docs/REDESIGN_ARCHITECTURE.md`, stop and record the conflict instead of choosing silently.
