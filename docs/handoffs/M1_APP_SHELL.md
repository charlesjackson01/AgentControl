# Handoff M1: App shell

**From:** Opus (architecture and planning) → **To:** Astra (implementation)
**Branch:** `feature/chat-first-redesign`. Commit and push only there; **never merge into `main`**.
**Read first, in this order:**
1. `CURRENT_STATE.md`
2. `docs/REDESIGN_ARCHITECTURE.md` (binding; §3, §5, §9 and §10 matter most for M1)
3. this file

The rationale lives in `docs/CHAT-FIRST-PLAN.md`. You do not need it to do this task.

---

## 1. Outcome

When M1 is done, `http://<host>:<port>/chat` opens a new, isolated AgentControl interface that:
- signs in with the same dashboard key as the classic UI
- shows the current **project room** in the new design language, built on real data from existing APIs:
  - the channel list
  - the sessions (runs)
  - the members and their presence
  - the Connections status
  - a room timeline of session blocks
  - a context panel for the focused session
- stays live through the existing SSE stream, with a polling fallback
- lays out correctly at desktop, laptop and phone widths

It is **read-only**. Sending messages, acting on requests and Workspaces come in later milestones.
Where the user needs one of those now, the shell links to `/classic`.

The classic UI must behave exactly as it does today, at `/` and also at the new `/classic`.

## 2. In scope

### 2.1 Server routes (`agent-autonomy/app.py`, `do_GET` only)

Add the following, exactly as specified in architecture §5.1:
- `/classic` → the classic `index.html`, served the same way as `/`
- `/chat` and `/chat/` → `agent-autonomy/chat/index.html` (`text/html; charset=utf-8`)
- `/chat/<name>.css|js` → a file in `agent-autonomy/chat/`:
  - the name must match `^[a-z0-9][a-z0-9-]*\.(css|js)$`
  - the resolved path must be inside `chat/`, and `is_file()` must be true
  - anything else returns **404**
  - use the fixed content types from §5.1

Use the existing `self.reply(...)` so the security headers are unchanged. No key is needed for these static
routes, as for the classic assets. Change nothing else in `app.py`.

### 2.2 Frontend files (new, `agent-autonomy/chat/`)

**`index.html`**
- It loads `/chat/tokens.css`, `/chat/chat.css`, then `/chat/core.js`, `/chat/model.js` and `/chat/shell.js`, with `defer`.
- Add a `?v=1` query to each asset, to match the classic cache-busting habit.
- It needs a `<title>`, a viewport meta tag and `color-scheme: light dark`.
- Regions:
  - `#sign-in`
  - `#app`, containing `nav#rail`, `main#room` and `aside#context`
  - an inline boot/connecting state

**`tokens.css`**
- All design tokens, in light and dark sets via `prefers-color-scheme` (architecture §9).
- No component rules.

**`chat.css`**
- Layout and components, using `var(--…)` only.
- The three-breakpoint layout from architecture §10.
- A drawer for the rail and a bottom sheet for the context panel on phones.
- Focus styles, and `prefers-reduced-motion`.

**`core.js`** (`AC.core`)
- **Key storage.** Share the classic key name `ac-dashboard-key`: read `localStorage`, then `sessionStorage`.
  Offer "Remember on this device" (write to `localStorage`) or save for this session only.
  Wrap every storage access in `try/catch`.
- **`api(path, method, body)`.** Send `Authorization: Bearer <key>` and JSON. On a 401, clear the in-memory key and
  show sign-in with the server's `error` text. Surface other errors in a dismissible banner.
- **Live stream.** Read `GET /api/events` via `fetch` streaming, because `EventSource` cannot send the header.
  The reference implementation is the classic `connectEvents()` in `agent-autonomy/app.js` (about lines 343–392).
  **Copy and adapt it; do not import it.** Behaviour:
  - Parse the `hello` and `change` events. On `change`, schedule one coalesced refresh (at most one in flight,
    plus a trailing refresh if more arrive).
  - On a 503 or a dropped stream, fall back to polling `/api/state`. Poll every 2 s while a session is active,
    and every 10 s when idle.
  - Retry the stream with backoff.
  - Show a small "Live" / "Reconnecting…" indicator.
- **Store.** Keep `state` (the last `/api/state` payload) and `agentsByRun` (from `GET /api/agents?run=` for the
  focused session, refreshed on change). Provide `subscribe(fn)` / `getState()`.
  Fetch `/api/state?scope=current&run=<focused>`.

**`model.js`** (`AC.model`, **pure**, exported with the CommonJS guard)

`channelsFromState(state)` returns `[{id:'main', kind:'project', title:<project folder name>, sessions:<count>, active_session:<id|null>, waiting:<inbox count>}]`.
- This function is the seam that M2 replaces with `GET /api/channels`. Callers must not depend on how it is computed.

`sessionsFromState(state)` returns sessions, newest first. Each is built from `state.runs[]`:
- `id`, `title`: the run's `title` if set, else the first line of `goal`, trimmed to 80 characters with `…`
- `status` and `statusLabel`; `symbol` (● active, ! needs you, ✓ completed, ✕ failed, ■ stopped, ◌ other)
- `created`, `parent` (from `parent_run`), `promptCount` (from `prompt_count`), `active` (not terminal)

The terminal statuses are `completed`, `blocked`, `failed`, `stopped` and `limit_reached`; `interrupted` and
`paused` are not terminal. Mirror `engine.TERMINAL`, noting the source in a comment.

`membersFromState(state)` returns a list from `state.agents` (the focused run):
- `name`, `role`, `state`, `stateLabel`, `symbol`, `task`, `since`
- Hermes comes first, then the order given.
- Use the presence states and labels from architecture §8. Symbol plus label, never colour alone.

`connectionsFromState(state)` returns `{ready, label, items:[{name, state, label}]}` from `state.health`.

`waitingFromState(state)` returns `{count, runs:[…]}` from `state.inbox`.

Also include small copied helpers: `esc`, `relTime` and `timeLabel`, noting their source.

**`shell.js`** (`AC.shell`)
- **Sign-in.** Use the copy "Connect" (not "Connect to workspace").
- **Hash router** (architecture §5.2):
  - `#/` is the room
  - `#/s/<runId>` focuses that session: it highlights it in the rail and the timeline, and opens the context panel
  - anything else falls back to `#/`
- **Rendering.** Re-render on store changes. Avoid replacing focused inputs, and preserve the scroll position.

**Rail:**
- **Project header:** the folder name, with the full path as a tooltip. Switching projects is **not** in M1.
  Show the name only; a "Switch project" item in More may link to `/classic`.
- **Channels:** from `channelsFromState`. `main` is selected, and it shows a waiting badge when `waiting > 0`.
- **Sessions:** from `sessionsFromState`. Each has a symbol, title and relative time. Clicking one sets `#/s/<id>`.
- **Members:** from `membersFromState`, for the active or focused session. When there is no session, show Hermes only, idle.
- **Connections:** one line at the bottom from `connectionsFromState`. It expands to the per-service list.
- **More** menu: links to `/classic` for "Skills", "Usage", "Activity" and "Classic dashboard".

**Room:**
- **Header:** `# <project>`, the active session's title and status, and the "Live" indicator.
- **Timeline:** one **session block** per session, oldest at the top and newest at the bottom, scrolled to the bottom on first load.
  - Each block shows the title, status symbol and label, the created time, `promptCount` turns and "continues ‹title›" when `parent` is set.
  - The focused block is expanded. It shows `run.summary` (the recorded summary, styled as **system status, not a message**) and a
    "View in classic" link to `/classic`.
  - Do not invent any message content. The full message timeline arrives in M3.
- **Waiting pointer:** when `waiting.count > 0`, a pinned strip above the composer area reads
  "! N requests waiting" and links to `/classic` ("Review in classic dashboard").
  Do not render approval controls in M1.
- **Composer area:** present for layout, but **disabled**. The placeholder is honest:
  "Messaging from this view is coming soon. Use the classic dashboard to start or steer a session."
  Add a link to `/classic`.

**Context panel** (for the focused session): tabs **Session** · **Members**.
- **Session** shows:
  - the goal (collapsed after 3 lines, "Show more")
  - status, created time, mode (`run.mode`) and the turn count
  - the verifier command, if any
  - the parent session link
- **Members** shows the full member list with tasks.
- It is collapsible. Remember whether it is open under `acx-context-open`.

### 2.3 Tests (new)

**`agent-autonomy/tests/test_chat_routes.py`** (unittest). Follow the pattern of
`test_workflow.py::test_http_auth_and_goal_submission`: a `ThreadingHTTPServer` on port 0 with `handler(c, 'test-key')`,
and an opener with `ProxyHandler({})`.
- It asserts:
  - `/chat` and `/chat/` return 200 with the chat HTML, and `/classic` returns 200 with the classic HTML
    (the same bytes as `/`)
  - every file in `chat/` is served with the right content type
  - `/chat/../app.py`, `/chat/%2e%2e/app.py`, `/chat/x.py`, `/chat/sub/x.js`, `/chat/.hidden.js` and `/chat/missing.js`
    all return 404
  - `/api/state` still returns 401 without the key
- To construct `Controller`, reuse the existing test helpers. Read `tests/test_workflow.py` for how `self.controller(...)` builds one.

**`agent-autonomy/tests/test_chat_ui.cjs`** (linkedom DOM tests, the same style as `tests/test_ui.cjs`). Build the
harness the same way:
- parse `chat/index.html`
- evaluate `core.js`, `model.js` and `shell.js` in a `node:vm` context with stubbed `fetch`, storage and `location`
- use the simulated states from `tests/fixtures.cjs` (`fixture()`, `richActive()`, `richCompleted()`); add fixtures there only if needed

Cover at least:
1. no key shows sign-in; a key shows the shell; a 401 returns to sign-in with the server message
2. sessions render newest-first in the rail and oldest-first in the timeline; `#/s/<id>` focuses a session and opens the context panel
3. members show symbol plus label for every presence state; Hermes comes first
4. the waiting pointer appears only when `inbox` is non-empty and links to `/classic`; there are **no** approve/deny controls anywhere
5. the composer is disabled with the honest placeholder
6. a `change` event triggers exactly one coalesced refresh; a 503 on `/api/events` falls back to polling
7. every API string is escaped (use a fixture title containing `<img src=x onerror=…>`)
8. unit tests of the pure `model.js` functions via `require`
9. **token guard:** `chat.css` contains no hex, `rgb(`, `hsl(` or named-colour literals; `tokens.css` defines every `var(--x)` used in `chat.css`
10. **isolation guard:** no chat file references `/app.js`, `/workspace.js`, `/app.css`, `/themes.css` or `/workspace.css`

**Optional but recommended: `agent-autonomy/tests/chat_screenshots.cjs`.**
- Base it on `tests/screenshots.cjs`: the same fixture interception, with no services contacted.
- Capture `/chat` at desktop (1440×900), laptop (1024×768) and phone (390×844), in light and dark
  (`page.emulateMedia({colorScheme})`), for these states:
  - empty (no runs)
  - active with a waiting request
  - completed
  - team with members
- Use them for your own visual review. Do not commit the images; the directory is ignored or temporary.

## 3. Out of scope (do not do in M1)

- `/api/thread`, `/api/channels` or `conversation.py`. That is M2, and may run in parallel.
- Message rendering, the composer sending anything, approval, research, skill or team-decision UI, Apply/Discard, or project switching.
- Workspaces, live terminals, diffs or preview surfaces.
- Any change to `engine.py`, `adapters/`, `journal.py`, `permissions.py` or any other backend module
  (only `app.py`'s `do_GET` routes, per §2.1).
- Any change to classic files: `index.html`, `app.js`, `app.css`, `themes.css`, `workspace.js`, `workspace.css`.
  The one exception is `tests/fixtures.cjs`, and only by *adding* fixtures.
- Porting Mac, Terminal or XP themes, or adding a theme switcher.
- New runtime dependencies, a build step, frameworks, CDNs or web fonts.
- README changes. The new UI is documented in `CURRENT_STATE.md` until M9.

## 4. Acceptance criteria (all must hold)

1. `python3 -m unittest discover -s agent-autonomy/tests` passes. The baseline is **347 tests, OK (6 skipped)**,
   plus your new route tests.
2. `NODE_PATH=<deps> node agent-autonomy/tests/test_ui.cjs` still passes **82/82**.
3. `NODE_PATH=<deps> node agent-autonomy/tests/test_chat_ui.cjs` passes.
4. `git diff <M1 start>..HEAD --stat` touches only:
   - `agent-autonomy/app.py`
   - `agent-autonomy/chat/*`
   - `agent-autonomy/tests/test_chat_routes.py`, `test_chat_ui.cjs` and optionally `chat_screenshots.cjs`
   - `agent-autonomy/tests/fixtures.cjs` (additions only)
   - `CURRENT_STATE.md`
   - `docs/handoffs/M1_APP_SHELL.md` (the completion report, §7)
5. With a real or fake server: `/chat` signs in with the same key as classic, shows the project's sessions,
   updates live when a run changes, and `/classic` and `/` still show the classic UI.
6. At 390 px wide there is no horizontal scrolling, and the rail and context panel open as a drawer and a sheet.
7. No text anywhere in `/chat` impersonates Hermes or an agent, and nothing shows reasoning.

## 5. How to run

```bash
# backend tests
python3 -m unittest discover -s agent-autonomy/tests -v

# DOM tests (test-only deps outside the repo)
npm install --prefix /tmp/ac-tests --no-save linkedom cssom playwright-core
NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_ui.cjs
NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_chat_ui.cjs

# optional rendered screenshots (Chromium is preinstalled under /opt/pw-browsers)
NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/chat_screenshots.cjs /tmp/chat-shots

# the real app (needs Hermes/OpenCode for runs; the shell itself renders without them)
python3 agent-autonomy/app.py --host 127.0.0.1 --port 8766 --project /path/to/project
#   classic: http://127.0.0.1:8766/   and /classic      new: http://127.0.0.1:8766/chat
```

## 6. Notes and gotchas

- **`state.agents`** describes the *selected* run (`/api/state?run=`). When nothing is selected, it describes the newest run in scope.
- **`state.runs`** is capped at 30 and scoped to the current project, plus any active run. That is fine for M1;
  M2's `/api/thread` pages properly.
- **`/api/state` is large.** It is gzip-compressed above 16 KB when `Accept-Encoding: gzip` is sent; browsers send that automatically.
- **Run `status` values** include, not exhaustively, `planning`, `resuming`, `coding`, `waiting`, `paused`,
  `interrupted` and `attention`, plus the terminal ones. Label unknown statuses generically rather than failing.
- **Pop-out Workspaces** in classic are at `/?popout=<agent>&run=<id>`. They fetch on their own when no dashboard
  relays to them, which could serve as M7's interim link. **Do not use it in M1.**
- **linkedom** has no layout, focus or `dialog` behaviour. Stub them the way `test_ui.cjs` does.
- **Commit style:** match the history (a short imperative subject, for example
  "Redesign M1: serve the chat shell at /chat"), and include the attribution trailer the session gives you.
  Commit in small, green steps.

## 7. When you finish

1. Update `CURRENT_STATE.md`: the milestone status, the new files, the test counts, known issues, and the next milestone.
2. Append a **Completion report** to this file:
   - what was built
   - the deviations from this spec and why
   - the test results (commands and counts)
   - screenshots reviewed, if any
   - open questions for Opus
3. Push to `feature/chat-first-redesign`. Do not open a PR or merge unless the owner asks.

If a requirement here conflicts with `docs/REDESIGN_ARCHITECTURE.md`, stop and record the conflict in the
completion report instead of choosing silently.
