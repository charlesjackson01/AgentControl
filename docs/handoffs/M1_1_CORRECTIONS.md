# Handoff M1.1: App shell corrections

**From:** Opus (architecture review) → **To:** Codex (implementation)
**Branch:** `feature/chat-first-redesign`. Commit and push only there; **never merge into `main`**.
**Size:** small (a few hours). **Must land before M3.** It is independent of M2.
**Read first:**
1. the "Architecture review" section at the end of `docs/handoffs/M1_APP_SHELL.md`
2. `docs/REDESIGN_ARCHITECTURE.md` §5 and §10

Fix exactly the two findings below, and add tests for them. **Do not refactor or restyle anything else in M1.**
The optional-polish items in the review are *not* part of this task.

---

## 1. Unknown session link freezes the shell

**Reproduce:** open `/chat#/s/bogus`.
- On a fresh load, the room stays on "Connecting…" forever and the banner says "Unknown run".
- If the shell loaded normally first and you then navigate to `#/s/bogus`, the rail and timeline stop updating,
  while polls continue every 2 s and each gets a 404.

**Cause:**
1. `core.refresh()` fetches `/api/state?scope=current&run=<id>`, which returns 200 with `run: null` and `agents: []`.
2. It then fetches `/api/agents?run=<id>`, which returns **404**.
3. That throw happens before `state = …` is assigned, so every refresh discards its result.

**Required behaviour:**
1. **Drop the `/api/agents` fetch.** `/api/state` already returns `agents` for the selected run, built by the same
   `Controller.agents()` that `/api/agents` uses. Members come from `state.agents`. Remove `agentsByRun`, or keep it
   filled from `state.agents` keyed by `state.run.id`; the choice is yours. A refresh then makes **one** request.
2. **Handle a missing session.** When a session is focused and the response does not contain it (`state.run` is
   `null` or `state.run.id !== requested`):
   - keep and render the returned state (never discard a valid response)
   - clear the focus and replace the hash with `#/` (use `location.replace`, or set the hash without adding a history entry, so Back does not loop)
   - show a dismissible, non-blocking notice: "That session is not in this project's history."
3. **A failed refresh must never block later ones.** An error on one refresh shows the banner, as it does today, and the next change or poll tries again.

## 2. A stale context preference leaves the scrim over the room

**Reproduce:**
1. At 1024 px or 390 px, open a session (the context panel opens).
2. Press the browser Back button to return to `#/`, or reload `#/` with `acx-context-open=true` saved.
3. The context panel is hidden, but the scrim still covers the room and swallows the first click.

**Cause:** `panels()` sets `scrim.hidden = !railOpen && !contextOpen`. The preference `contextOpen` can be `true` while no session is focused, so the panel itself is hidden.

**Required behaviour:**
1. The scrim is visible **only** when a panel is actually showing:
   - at phone width, when the rail drawer is open or the context panel is visible
   - at 768–1199 px, when the context panel is visible (the CSS already hides the scrim at 1200 px and above)

   Derive this from the rendered panel state (for example `!$('context').hidden`), never from the saved preference.
2. Routing to `#/` (by Back, a link or a missing session) must never leave an overlay showing. The saved preference
   may still decide whether the panel opens the *next* time a session is focused at desktop width.

## 3. Tests (add them; keep every existing test green)

In `agent-autonomy/tests/test_chat_ui.cjs`:
- A fresh load at `#/s/bogus`, where the stub `/api/state` returns `run: null`: the shell renders the sessions,
  the hash becomes `#/`, the notice is shown, and **no** request to `/api/agents` is made.
- A good load, then navigating to `#/s/bogus`, then a state change: the rail reflects the new state (live updates continue).
- Each refresh issues exactly one `/api/state` request and zero `/api/agents` requests.
  Update the existing assertions that expected the roster call.
- `acx-context-open=true` saved, with `#/` loaded: `#scrim` is hidden and `#context` is hidden.
- Open a session, then set the hash to `#/`: `#scrim` and `#context` are both hidden.

In `agent-autonomy/tests/chat_screenshots.cjs`, add two cases at laptop (1024) and phone (390) widths, light theme only:
- a stale `acx-context-open=true` on `#/`: assert that `document.elementFromPoint(centre)` is not `#scrim`
- a `#/s/bogus` deep link: assert that the rail renders the sessions and the hash ends as `#/`

Remove `/api/agents` from that script's route stub, or leave it as an unused 404.

## 4. Acceptance

1. `python3 -m unittest discover -s agent-autonomy/tests` passes.
   - The review environment expects **351 tests, OK (skipped=6)**; an environment with an OpenCode binary gives 3 skips.
   - Report the skipped tests by name.
2. `test_ui.cjs` passes 82/82; `test_chat_ui.cjs` passes, with the new tests; `chat_screenshots.cjs` passes.
3. The diff touches only `agent-autonomy/chat/core.js`, `agent-autonomy/chat/shell.js` and, if needed,
   `agent-autonomy/chat/model.js` or `chat.css`, plus the two test files, `CURRENT_STATE.md` and this file.
   **No backend change.**
4. Manual check (a fake or real server): `#/s/bogus` recovers to the room, and Back after opening a session leaves no dimmed overlay.

## 5. When you finish

1. Append a short completion report to this file: what changed, the test commands and counts (with skipped tests named), and any deviation.
2. In `CURRENT_STATE.md`, set M1.1 to done.
3. Push to `feature/chat-first-redesign`. No PR and no merge unless the owner asks.

## Completion — 2026-09-30 (Codex)

Removed the redundant `/api/agents` request. Each refresh renders the returned `/api/state`,
including a missing selected session; missing sessions clear focus, replace the hash with `#/`,
and show the required dismissible notice. Refresh failures remain recoverable. The scrim now
follows the context panel's rendered visibility and the rail drawer.

Regression coverage includes fresh and subsequent bogus links, live updates after a stale link
and a failed refresh, one state request per refresh with no roster requests, saved context on
the room, and returning from a session. Chromium checks both 1024 px and 390 px, including
actual browser Back navigation and centre-point hit testing against the scrim.

Verification: classic DOM 82/82; chat DOM 16/16; browser matrix 24 combinations plus four
regressions, 54 screenshots in `/tmp/chat-shots`. Python: 351 tests, OK (skipped=3), outside the sandbox.
Skipped: `test_container_e2e.ContainerRunE2E.test_agent_works_in_a_locked_down_container`,
`test_preview.DesktopTests.test_desktop_preview_shows_frames_and_accepts_input`,
`test_vm_e2e.VMRunE2E.test_agent_works_in_a_kvm_clone`.
The initial sandbox run had two team timeouts and one VM background-log race;
the complete rerun passed without backend or test changes.
Commands: `python3 -m unittest discover -s agent-autonomy/tests`;
`NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_ui.cjs`;
`NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_chat_ui.cjs`;
`NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/chat_screenshots.cjs /tmp/chat-shots`.

No scope deviations or unresolved M1.1 issues. Backend and classic UI are unchanged.
