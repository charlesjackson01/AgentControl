# AgentControl update — version 5

## What changed in version 5

**Horizontal workflow.** The run view reads left to right:
- A **turn rail** lists every coding turn with its result and line counts.
- A four-stage **board** shows the selected turn: Plan (Hermes's recorded summary, plan, and the notes it used), Prompt (the exact text sent), Code, and Verify (command, output tail, captured files, and Hermes's review).
- The board follows the latest turn until you pick an older one, and a "Next turn" chip appears while Hermes plans.
- Below 1280px the board wraps to two columns. On phones it becomes a swipeable carousel with stage tabs that opens on the stage needing attention.
- Pending approvals show as a full-width banner above the board. Supporting cards (goal checks, verification, files, brief) sit in a responsive row below it.

**Live OpenCode terminal.** The Code stage is a contained, always-dark terminal:
- It shows OpenCode's ordered text and tool calls, with running tool output when OpenCode streams it.
- It appends incrementally, so scroll position and expanded outputs survive polling.
- It has Follow, Copy, and full-screen (`t`) controls, a "New output" pill after you scroll up, and inline Review buttons for held requests.
- The engine records a bounded `transcript` per step (last 300 parts, about 80 KB) and polls OpenCode at most every second while coding. The browser polls every second during a coding turn, every 2s otherwise, every 10s in a background tab, and backs off to 30s when disconnected.

**Phone and approval flow:**
- No sign-in flash when a key is stored.
- An optional "Remember on this device" setting, and "Forget key and sign out".
- A favicon badge for pending requests and opt-in browser notifications.
- Full-height review dialogs with sticky action buttons, and Approve once as the primary action.

**Clarity:**
- Unsupported controls are hidden instead of shown disabled.
- Start run explains why it is disabled.
- Errors can be dismissed and clear themselves.
- Times are relative, with the exact time on hover.
- Recent runs and Activity can be filtered or searched.
- `?` opens a shortcut table.
- Diffs are grouped per file.
- Enter sends a steering note, and the note field grows as you type.
- Mac follows the system dark appearance.

**Small backend additions:**
- **Verify now** runs the saved command while a run is paused or finished, so it never overlaps a coding turn. The result is stored as `manual_verification` with an event.
- Optional run **titles**, editable with **Rename**.
- Steps store the Hermes summary, plan, and kind that produced them.
- Project snapshots now exclude `agent-autonomy/`. Previously the exclusion list still named `trial-autonomy/`, so the controller's own files could be captured as evidence.

**Live project preview (Project tab):**
- A run can save a preview: a web dev server, a static page, a command-line program, or a desktop app on an Xvfb virtual screen.
- It starts when the run completes, and the Project tab opens with the project running next to its verification and change summary.
- `preview.py` runs the saved argv in the project folder, in its own process group.
- Web and static content is served on a separate preview port (a different origin, entered with a one-time ticket that becomes an HttpOnly cookie). Frame headers are rewritten, so only the dashboard can embed it.
- Command-line previews use a real pseudo-terminal. Desktop previews stream PNG frames and forward clicks and keys through `xdotool`.
- Tested with real subprocesses and in Chromium: a Python web server, the demo todo CLI, and `xclock`.

**Maintenance:**
- `app.css` is readable, sectioned source; a CSSOM comparison confirmed the reformat changed no rules.
- `app.js` is split into small render helpers and an action map.
- The legacy single-file `dashboard.py` is retired.
- `tests/screenshots.cjs` renders every theme at three widths with simulated data.

The version 4 report follows for reference.

# AgentControl UI/UX update — version 4

The dashboard is now branded **AgentControl**. It uses the supplied Mac, Terminal,
and XP design references through one shared interface and a token-based theme
system. Mac is the default. The existing Python runtime, authentication,
Hermes/OpenCode workflow, journal, and notifications remain in use.

## Discovery: stack, routes, and files

The frontend is plain HTML, CSS, and JavaScript. Python's standard-library
`ThreadingHTTPServer` serves the app. There is no frontend framework, build step,
or client-side routing dependency. Runs, Approvals, Activity, and New run are
in-page views. The browser polls authenticated `GET /api/state` every two seconds;
there is no websocket or SSE transport.

| File / route | Role |
| --- | --- |
| `agent-autonomy/index.html` | Shared shell, screens, forms, dialogs, and the pre-paint theme bootstrap. |
| `agent-autonomy/themes.css` | Supplied theme tokens, plus supporting component/chrome tokens. |
| `agent-autonomy/app.css` | Shared layout, responsive rules, and small theme-specific styling. |
| `agent-autonomy/app.js` | State rendering, polling, themes, approvals, steering, shortcuts, and form handling. |
| `agent-autonomy/app.py` | HTTP server, authentication, explicit static asset allowlist, and API routing. |
| `agent-autonomy/engine.py` | Existing controller, durable records, OpenCode/Hermes adapters, and added UI metadata. |
| `GET /api/state` | Current run, history, turns, events, pending requests, decisions, readiness, and supported capabilities. |
| `POST /api/runs` | Start a bounded run; now accepts goal checks, minutes, and an optional parent run. |
| `POST /api/control` | Pause, resume, stop, steering instructions, and adding a goal check. |
| `POST /api/review` | Revalidate and submit a permission/question decision; now accepts a denial redirection. |
| `POST /api/check` | Check the OpenCode API and Hermes CLI without invoking a model. |

## What changed

**App shell and live run.** Removed the hero banner and vague stat cards. The
shell provides Runs, Approvals, Activity, recent runs, agent readiness, a theme
switcher, and New run. The live screen contains the status, brief, working folder,
prompt/time budgets, the Plan → Prompt → Code → Verify loop, expandable coding
turns, tool activity, steering, goal checks, verification output, and captured
file changes. Policies and project/model switchers are omitted because they do
not have working backend controls.

**Approvals.** Pending requests sit beside their run and also appear in the
Approvals page. The review dialog shows exact commands/scope and any supplied
file changes, with full raw details available. Deny and redirect records the
user's note before dispatching the refusal, so the next Hermes planning turn
receives it. Failed delivery does not erase that note. Stale requests are refused,
repeat taps are deduplicated, and uncertain decisions are not automatically
resent. Confirmation, run status, history, badge, and tab title refresh from the
real API. Questions support choices and custom answers.

**Run review and setup.** Finished runs show their actual outcome, verification
status, prompt usage, captured paths, a timeline, and the original brief. A
follow-up opens a new brief with the parent run's brief and summary included as
context. New runs support manually entered checks, a prompt cap, a wall-time
limit, and the existing independent verification command. Goal checks can also
be added mid-run and are passed to Hermes with the next planning prompt.

**Themes.** The root uses `data-theme="mac|terminal|xp"`. `ac-theme` is stored in
localStorage and read in the head before CSS loads. Switching changes the theme
without recreating forms or clearing drafts. All component colors reference
`--ac-*` tokens. Mac uses light cards, grouped content, and a pill-shaped steering
field. Terminal uses monospace, outlined panels, colored agent rules, a status
bar, block progress, and a clickable key bar. XP adds a window frame, functioning
menus, toolbar, address bar, task pane, table-like turn rows, approval windows,
segmented time meter, taskbar, clock, and approval notification bubble.

**Accessibility and smaller screens.** Controls use native elements and labeled
icons; approvals are announced politely. The navigation becomes a keyboard-accessible
drawer below 700px. The run side column stacks below 1100px with pending approvals
first. Reduced-motion settings disable cursor blinking. Stop requires a separate
confirmation. Shortcuts ignore editable fields and modifier keys. `a` opens a
review and can submit within that review; `d` opens denial/redirection; `p` pauses
or resumes; `x` opens Stop confirmation; `/` focuses steering.

## Small backend additions

- Saved manual goal checks and inclusion in the Hermes context; individual
  statuses deliberately remain pending until evidence is supplied.
- Per-run time limit and parent-run context using the existing bounded controller.
- A denial redirection saved under the review lock, with retry deduplication.
- Per-turn timestamped activity and Hermes's proposed next action/summary.
- Captured file addition/removal counts and change tags, including partial flags.
- Separate OpenCode API and Hermes CLI readiness results, labeled as last checked.
- Capability flags and efficient run turn counts for navigation.

Older journals continue loading without these optional fields. Historical turns
without timestamped activity or detailed counts show empty states rather than
fabricated history. The update archive excludes the state directory and preserves
the user's dashboard key, journal, original manual dashboard, and project files.

## Backend gaps and smallest useful additions

| Requested feature | Current truthful behavior | Smallest useful addition |
| --- | --- | --- |
| Separate editable run titles | The visible title is shortened from the brief; full brief is expandable. | Optional `title` on run creation and update. |
| Automatic extraction and per-goal evidence | Manual criteria are saved and shown as pending. Verification-command results are shown separately. | An extraction endpoint plus persisted check results linked to actual verification evidence. |
| Structured test counts / failing test names | Shows command exit status and raw output, without guessing counts for arbitrary tools. | A structured verifier result format or adapters for supported test runners. |
| Hermes approval recommendation and reason | Explicitly says no recommendation was supplied; both actions remain available. | Advisory evaluation stored against the exact request fingerprint; never auto-approve it. |
| Triggering policy name, policy editor, or guardrail switches | Shows OpenCode's permission type. No invented policy names or inactive Policies page. | Expose actual matched rules and an enforced per-run policy API. |
| Review plan before coding | Unavailable; Hermes currently plans and dispatches through the existing loop. | A persisted plan-review state and explicit user decision before dispatch. |
| Undo | Omitted; dispatched approval decisions cannot reliably be reversed. | A cancellable pre-dispatch holding window. This cannot undo commands already executed. |
| Verify now / re-run checks | Disabled and labeled unavailable; `v` does not execute anything. | A serialized verification action at a safe workflow boundary using the saved command. |
| Model picker / real model online status | Shows fixed profile/server configuration and API/CLI readiness. | Read-only model configuration/status, then a supported model selection API if needed. |
| Multiple projects / per-run working folder | The folder is fixed by the controller's startup settings. | A validated project registry and scoped session routing. |
| File downloads | Can download recorded diffs; does not invent a deliverable ZIP endpoint. | An authenticated, project-scoped export endpoint with path and symlink checks. |
| Hermes-suggested follow-ups | Supports a manually written follow-up with parent context. No invented suggestions. | Persist structured suggestions from Hermes's final result. |
| “Nothing outside this folder touched” | Makes no such claim. Counts describe bounded text snapshots; repeated edits may be counted again. | A complete change inventory with explicit coverage; enforced filesystem confinement is a separate backend capability. |

## Deliberate differences from the references

1. The product name is **AgentControl**, matching the user's final naming choice.
2. Sample runs, commands, test counts, passing criteria, recommendations, and model
   names were not copied into live data. The example brief appears only when the
   user explicitly selects it in the new-run form.
3. Approval actions open the detail window before final submission. This lets the
   user inspect file changes, scope, or a redirection before deciding.
4. Unsupported actions are omitted or visibly unavailable. A passed verification
   command is not labeled proof that every goal passed.
5. The role/chrome palette has a few darker text backgrounds for legibility.
   Terminal prefers JetBrains Mono when installed and otherwise uses a monospace
   fallback; the app makes no external font request.
6. New/modified/deleted tags and counts describe the captured snapshots, not a
   complete Git audit. Large/excluded files and repeated edits limit the evidence.
7. Window decorations are decorative; the XP menus, toolbar, taskbar, and
   notification controls perform real dashboard actions. No OS logos are used.

## Validation and screenshot status

- 41 Python tests cover the controller, actual local HTTP/subprocess paths with
  simulated services, approvals, stale fingerprints, restart recovery, limits,
  goal checks, follow-up context, redirection, and captured file counts.
- 11 DOM/CSS checks cover live screen rendering from fixtures, theme persistence,
  draft preservation, approve/deny/question submission, stale controls, Stop
  confirmation, new-run fields, shortcut guards, real-data summaries, CSS parsing,
  token references, breakpoints, and reduced-motion rules.
- Python sources are checked against Python 3.10 syntax; JavaScript is syntax checked.
- Packaged extraction is checked to preserve an existing dashboard key and original
  manual dashboard. The application still requires no new runtime dependencies.

**Rendered screenshots were not produced.** The browser security policy blocked
opening the local preview. DOM tests do not measure layout or visual appearance,
so exact matching at 1440px, 1024px, and 390px remains visually unverified. The supplied
screenshots were inspected as references and are not presented as screenshots of
the implementation. No workaround for that browser restriction was used.

No live calls were made to the user's Hermes model or OpenCode instance from this
workspace. The first deployment on the user's server remains the live integration
check.

## Deployment and access

Keep the existing launch command, project path, and Tailscale bind address. Download
the updated archive, stop the dashboard, extract it over the current installation,
and restart `agent-autonomy/app.py`. Keep the OpenCode server running. If a run was
interrupted, Resume reconciles its existing session without replaying its prompt.

`100.79.242.24` is the user's Tailscale address, not a public internet address.
Keep access on the tailnet and retain the dashboard key. If exposing the app
outside that private network, add HTTPS with authentication. Deployment and
network exposure were not changed by this UI task.
