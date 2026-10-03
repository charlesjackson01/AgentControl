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

---

## M4 completion report — Codex, 2026-09-30

### Implementation and scope

Verified `/home/charlesjackson/AgentControl` on `feature/chat-first-redesign`, with a clean starting tree.
`git pull --ff-only origin feature/chat-first-redesign` advanced the branch to `137a5b8` before implementation.
Read `CURRENT_STATE.md`, the binding architecture, this handoff, and the accepted M3/M3.1 handoffs and reviews.

Added `AC.composer` in `chat/composer.js` and mounted it in the existing project room. The one input supports
new goals, finished-session follow-ups with inherited verifier/turn-limit/mode, Hermes notes, one targeted
agent (last mention wins), pause/resume, confirmed stop, `/check`, `/title` and local `/help`. The header menu
and Resume chip call the same controls. Stop starts focus on Cancel; Cancel and Escape send nothing.
Basic Settings show title, verifier, up to twenty checks and mode; Advanced starts collapsed and exposes
the permitted limits, isolation availability/reasons, network/resource/setup options and classic preview shapes.
Auto's explanation must be visible before sending; dirty folders require the explicit acknowledgement.
Remembered preferences are restricted to allowed Settings under `acx-settings`; the unsent draft is session-only.

All writes use the existing endpoints and request shapes in §2. `core.post()` uses the existing authenticated
`api()` and 401 handling. Successful writes clear only the submitted draft (new edits survive), set the stable
status node, follow to the bottom and request one immediate coalesced read refresh. Nothing inserts submitted
text or decision state into the timeline. Preparation, POSTs and Auto previews share the submission guard.
When an older session is focused, an existing active-session `/api/state` details read supplies the real agent
roster and pause flag; it does not supply room messages or create another conversation store.

`thread.js` changes only the outcome Reply link. The existing ordering, paging, keyed disclosure state,
SSE/polling refresh, receipts, bounded ten-page stale-action revalidation, rail disclosure, privacy guards and
classic decision pointers remain intact. `/verify`, `/apply`, `/discard` and `/team` remain unavailable
with a classic link. No paid-model, stuck-watch, internet-during-work or M5 controls were added.
Only the eleven files allowed in §7 changed; fixtures are append-only. Backend, API, schema, orchestration,
classic frontend and unrelated tests are unchanged. No architecture conflict or implementation deviation.

### Required verification

| Command | Result |
|---|---|
| `python3 -m unittest discover -s agent-autonomy/tests` | **398 tests, OK (skipped=3)**, 254.364 s; no timing-sensitive failure in this M4 run |
| `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_ui.cjs` | **82/82 passed**, unchanged classic tests |
| `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_chat_ui.cjs` | **67/67 passed**: all 42 existing tests plus 25 M4 regressions |
| `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/chat_screenshots.cjs /tmp/chat-shots-m4` | **84 combinations + 4 regressions passed**, 134 temporary screenshots |
| `git diff --check` | passed |

The three environment skips were:

- `test_container_e2e.ContainerRunE2E.test_agent_works_in_a_locked_down_container`: container opt-in/runtime/image gate.
- `test_preview.DesktopTests.test_desktop_preview_shows_frames_and_accepts_input`: desktop display tools gate.
- `test_vm_e2e.VMRunE2E.test_agent_works_in_a_kvm_clone`: VM opt-in/KVM gate.

The OpenCode end-to-end trio ran and passed. Python/socket tests and Chromium ran outside the sandbox.
No protected test was weakened or changed. Logs: `/tmp/ac-python-verified.log`, `/tmp/ac-m4-classic.log`,
`/tmp/ac-m4-chat.log` and `/tmp/ac-m4-browser.log`.

The new regressions cover exact start/follow-up/note/control bodies, every terminal outcome's Reply link,
server-only message appearance while the thread response is held, one immediate refresh, persistent draft
on failures/401, draft edits during sending, active-session agent and pause metadata while focusing history,
single-flight preparation/POST/Auto previews, Stop confirmation/focus/cancellation, mention and slash keys,
touch Enter behavior, focused finished-session rename, Basic/Advanced disclosure, isolation reasons,
dirty acknowledgement, Auto visibility, all preview shapes, preferences and prohibited payload fields.
Existing M3/M3.1 guards and revalidation regressions still pass.

### Phone measurements and screenshots

At **390 × 844**, in both light and dark:

| Idle state | Footer | Waiting row | Timeline | Viewport retained |
|---|---:|---:|---:|---:|
| Without waiting | **57 px** (limit 72) | absent | **683.5 px** | **81.0%** |
| With waiting | **105 px** (limit 120) | **40 px** | **635.5 px** | **75.3%** |

The matrix asserts these budgets for every phone case, waiting-row height 32–40 px, text/link alignment
within 1 px, visible Hermes target chips, no joined waiting/link text, no horizontal overflow and no page errors.
It retains the expanded long-token, newest-message visibility, context/drawer, stale-link and scrim checks.
The idle footer removes the visible eyebrow and duplicate classic link; classic stays in the header menu,
waiting row, rail and actionable messages. Settings is a side sheet on desktop and bottom sheet on phones.

A ten-line draft is capped by six lines plus padding (151 px at the current line height) or 40% of the viewport,
whichever is smaller. Chromium phone emulation shrank the visual viewport to **390 × 480** and restored it;
the app height followed `visualViewport` and the composer stayed above the reduced viewport's lower edge.
**Limitation:** an actual phone OS keyboard was unavailable; this verifies viewport emulation, not native
keyboard interaction. The browser writes measurements to `/tmp/chat-shots-m4/footer-measurements.json`.

Inspected actual images, including:

- `/tmp/chat-shots-m4/composerIdle-phone-light.png` and `composerIdle-desktop-dark.png`.
- `composerNote-phone-dark.png`, `composerPaused-phone-light.png` and `composerFollow-desktop-light.png`.
- `composerBasic-desktop-light.png`, `composerAdvanced-desktop-light.png` and `composerAdvanced-phone-dark.png`.
- `composerStop-phone-light.png` and `composerKeyboard-phone-light.png`.
- Real-server `/tmp/ac-m4-real-desktop.png` and `/tmp/ac-m4-real-phone.png`.

The images confirm the compact footer, waiting-row alignment, visible target, desktop/phone sheets,
Stop confirmation, follow-up target and reduced-viewport placement. Screenshots and scratch logs remain
temporary artifacts outside the repository.

### Real server check

Ran the real `app.handler`/Controller and journal on a temporary localhost HTTP server using only
`tests/test_workflow.py`'s `FakeManager` and `FakeAPI` (held fake task); no real Hermes/model/agent ran.
Chromium used `/chat` and the normal authenticated APIs. Scratch commands:

```sh
python3 /tmp/ac-m4-real-server.py
NODE_PATH=/tmp/ac-tests/node_modules node /tmp/ac-m4-real-check.cjs
NODE_PATH=/tmp/ac-tests/node_modules node /tmp/ac-m4-real-follow.cjs
```

Both browser checks passed. Starting run `5059a3f622da` sent only `{goal}`, recorded the `goal` event and
returned that goal to the room through `/api/thread`. Hermes and `@coder-1` notes appeared through the same
read model; the targeted note sent text without the token and returned `detail.to: 'coder-1'`. `/title` updated
the server title, and `/check` recorded a goal check and its journal note. Pause set the real pause flag;
Resume cleared it; Stop required the dialog and produced the stopped outcome and the recorded control events.
A 1,001-character goal check produced the server's inline 400 error and retained the draft. `/` and `/classic`
returned HTTP 200 with the unchanged classic app. No browser page errors occurred.

The separate follow-up check clicked the stopped session's real Reply link, created a child with the correct
`parent_run`, inherited verifier/mode/turn limit, observed the child goal from `/api/thread`, and stopped the
fake child through confirmation. Evidence: `/tmp/ac-m4-real-check.json`, `/tmp/ac-m4-real-check.log` and
`/tmp/ac-m4-real-follow.log`. An initial scratch assertion expected the targeted-note journal prefix in the
public text; it was corrected to the existing projection contract (text plus `detail.to`); production code
and the backend contract were unchanged.

### Open questions and carried-forward limitations

No unresolved M4 implementation issue or scope deviation. The large phone footer and misaligned waiting
strip from the M3.1 review are fixed and verified. As the accepted review explicitly defers them, Load earlier
focus, partial-session divider counts and live refresh of the single-session fallback remain unchanged.
The research/skill actionable-state versus waiting-count mismatch remains visible and untouched; its
server-side reconciliation is an explicit prerequisite for M5. M5 has not begun. Native phone keyboard
verification remains an environment limitation for review.


## Architecture, correctness and UX review — 2026-09-30 (Opus)

**Verdict: corrections required before M4 is accepted (M4.1).** The composer's architecture, endpoints, failure
handling and phone layout are right. **Two write-path defects send content the user did not see or did not write**;
they are handed off in `docs/handoffs/M4_1_CORRECTIONS.md`. Separately, the M5 prerequisite has been investigated
and defined in `docs/handoffs/M5_0_ACTIONABILITY.md`.

Reviewed: `137a5b8..30e83f2` (the single commit `30e83f2`), with the suites re-run, the screenshot matrix and
footer measurements regenerated, and the pure helpers probed directly.

### Re-run in the review environment (at `30e83f2`)

| Suite | Result |
|---|---|
| Python | **398 tests, OK (skipped=6)**: the same six environment gates; 3 in Codex's environment |
| Classic DOM | **82/82** |
| Chat DOM | **67/67**. Against the pre-M4 frontend, the 25 new tests all fail (42/67), as expected with no composer |
| Browser | **84 combinations + 4 regressions**, 134 screenshots |

**Footer measurements at 390 × 844, reproduced exactly:**
- idle **57 px** (limit ≤ 72)
- with the waiting row **105 px** (limit ≤ 120; the row itself 40 px)
- the conversation keeps **81.0%** of the viewport, or **75.3%** with the waiting row (minimum 65%)

The renders (`composerIdle-desktop-light`, `composerNote-phone-light`, `composerAdvanced-phone-dark`,
`composerStop-phone-light`) look deliberately compact, not merely inside the budgets:
- one line holding the target chip, the input, a gear-only Settings button on phones, and Send
- a bottom-sheet Settings panel with Advanced collapsed
- a clear Stop dialog with Cancel focused
- the mention list above the input

**Limitation:** native phone-keyboard behaviour is **unverified** (only `visualViewport` emulation was tested).
M8 must check it on a real device.

### Verified

- **Same room, no new interaction model.** The one composer lives in the existing footer; Settings is a sheet;
  Stop is a `<dialog>`; the session menu sits in the room header. There is no new page, panel mode or message store:
  the composer holds only the draft and the Settings preferences.
- **Endpoints and shapes.** The only calls are `/api/runs`, `/api/control` (instruction, goal_check, title, pause,
  resume, stop), `/api/check`, `/api/mode/preview`, `/api/workspace/preflight`, `/api/sandbox` and `/api/state`.
  Real-server checks with the test fakes show the exact bodies. `models`, `spend_cap`, `confirm`, `watch` and
  `network:'internet'` are refused on the client and stripped from stored settings.
- **Server-authoritative appearance.** There is no local echo. After a 2xx response, the draft clears only if it is
  unchanged, the status node reads "Sent · it will appear in the room", and one immediate coalesced refresh runs.
  A test holds `/api/thread` and proves the timeline does not change until it returns.
- **Failure behaviour:**
  - a 4xx error shows inline and keeps the draft
  - a 401 returns to sign-in, keeping the draft in `sessionStorage`
  - a network failure keeps the draft
  - single-flight covers preparation (preflight and Auto preview) and the POST
  - Resume, Check again and the session controls are disabled while a request is in flight
  - Stop re-checks that the active session is still the one confirmed
  - nothing false is left in the room after a failure
- **Out of scope, as required.**
  - `/verify`, `/apply`, `/discard` and `/team` say "not available here" with a classic link and send nothing.
  - There are no decision controls, paid-model, stuck-watch or internet options, and no client-side decision state.
  - The research/skill mismatch is untouched and still visible (the M3.1 guard test is intact).
- **Carried-forward polish:**
  - Resolved: the phone footer height, the waiting-row alignment and the duplicate classic link.
  - Still deferred, legitimately: focus after "Load earlier", the partial-session divider count, and live refresh of
    the single-session view. These are now scheduled for M8 (phone and accessibility).

### Findings

**Blocking** (handed off in `M4_1_CORRECTIONS.md`):

1. **The previous session's title and goal checks are silently resent with the next session.**
   - After a successful start, `submit()` saves the whole `settings` object to `acx-settings`, including `title` and
     `goal_checks`. Within one page load, `settings` is never reset either.
   - Probe: after a session with title "Todo CLI v1" and goal check "Persist tasks to JSON", the next goal "Add a web UI"
     sends `{"title":"Todo CLI v1","goal_checks":["Persist tasks to JSON"], …}`.
   - Goal checks are acceptance criteria Hermes must satisfy, and the Settings sheet is closed by default, so the user never sees them.
   - The handoff's remember-list (§2.8) was verifier, limits, mode, isolation, network and preview. The test
     "new session sends only goal and remembered/changed settings" **asserts** the title is remembered, so it fixed the defect in place.
2. **Mention parsing blocks or rewrites ordinary notes.**
   - Any `@word` is treated as a target: "Pin @types/node to v20" and "Use the @pytest.fixture decorator" **cannot be
     sent** ("no agent named types").
   - Every known mention is stripped: "Ask @coder-2 to sync with @coder-1 on the schema" is sent as
     **"Ask  to sync with  on the schema"**, routed to `coder-1`.
   - The first behaviour follows this handoff's own wording ("an unknown name is a local error"; "a second mention
     replaces the first"), so **the spec is corrected** in M4.1: only a leading `@agent` targets, and every other `@word` is literal text.

**Should fix before M5** (also in M4.1):

3. The empty room still says "Start a session in classic", although the composer now starts sessions.
4. Cancelling a follow-up leaves the parent's verifier, turn limit and mode in the in-memory settings, so the next
   *new* session inherits them, and saves them after it succeeds.

**Optional polish:**

5. A network failure shows the browser's raw text ("Failed to fetch"). Say that the request may or may not have been recorded, and to check the room before resending.
6. The session menu stays open behind the Stop dialog.
7. Native-keyboard verification, and the three deferred M3 items, move to M8.

### The M5 prerequisite

This was investigated as requested; see `M5_0_ACTIONABILITY.md` for the definition, the authoritative source, the layer, the impact and the tests.
M5 itself stays unstarted.
