# AgentControl — version 5

## What this version does

Enter one project goal in AgentControl. The controller asks your existing Hermes
profile to choose a small coding task, saves the complete prompt, and sends it to
OpenCode. When OpenCode finishes, the controller captures file changes and runs
your configured verification command. Hermes reviews that evidence and chooses
another task, a correction, completion, or a blocker. One OpenCode session is
reused for the entire run.

The dashboard shows each submitted prompt, OpenCode's response as it grows, tool
activity, Hermes's decisions, file diffs, and test output. Hermes's existing
`push` channel sends step-finished, needs-input, completion, and error alerts.

Version 5 lays each run out horizontally. A **turn rail** lists every coding
turn. The **workflow board** shows the selected turn as Plan → Prompt → Code →
Verify, and the Code stage is a **live OpenCode terminal**: text, tool calls,
and running command output stream in as OpenCode works. **Mac** (following the
system light/dark setting) is the default theme; **Terminal** and **XP** are in
the toolbar. Read `UPDATE_REPORT.md` for the change log and known gaps.

## Start or update

Stop the old dashboard with Ctrl+C in its terminal and keep your OpenCode
server running. Then, from the repository root:

```bash
python3 agent-autonomy/app.py \
  --host 100.79.242.24 \
  --port 8766 \
  --project /path/to/your/project \
  --opencode http://127.0.0.1:45381 \
  --profile ai-arch-dev
```

Run history and the dashboard key live in `agent-autonomy/state/`, which is not
tracked by git, so updating the code preserves them.

1. With Tailscale connected, open **http://100.79.242.24:8766** on your phone.
2. Enter the **Dashboard key** printed in the server terminal. Tick
   **Remember on this device** to keep it in that browser; otherwise it lasts
   for the tab. **Connections → Forget key and sign out** removes it.
3. Open **Connections** and wait for **Hermes CLI and OpenCode API ready**. The
   startup check reads the installed Hermes CLI's flags without invoking a
   model. If a check fails, the error appears at the top of the page.
4. Click **New run**, then **Try the Python todo-app brief** and **Start run**.
   This fills in a small Python todo-app goal under `demo_app/` and a unittest
   command. It uses your configured Hermes and OpenCode models, and configured
   provider usage may incur charges.

You don't have to type the follow-up prompts. Each turn shows Hermes's plan and
exact prompt next to OpenCode's live terminal.

If a run was active when you stopped the dashboard, it will appear as
**Interrupted**. Press **Resume** to reconnect to the same OpenCode session;
this does not resend its coding prompt.

## Model and profile behavior

- Planning uses `hermes --profile ai-arch-dev chat`. It uses the model already
  configured in that profile. Push notifications use the same profile.
- OpenCode uses the model and permissions already configured for the server.
- The controller runs Hermes in quiet single-query mode. It detects support for
  `--query-file`, `--oneshot`, `--ignore-rules`, and `--format stream-json` from
  `hermes chat --help` and uses the supported options. If a required base flag
  is missing, it reports the issue instead of starting a model.
- Hermes is launched with the `todo` toolset and a request to return a JSON
  decision. The controller supplies file evidence; coding is sent to OpenCode.
  It does not use `--yolo` or change either agent's global permissions.
- Every Hermes planning turn is a fresh invocation with the goal, prior step
  summaries, plan, new user instructions, file previews, and latest verification
  evidence. OpenCode keeps one session for the whole run. Durable history lives
  in the controller's SQLite journal.

## Controls

| Control | Effect |
| --- | --- |
| Start run | Begins one bounded project run from your goal. |
| Pause | Lets the current coding/verification step finish, then waits before the next model request or coding prompt. A planning turn already running can finish. |
| Resume | Continues a paused run, or reconciles a run interrupted by a restart/network failure. |
| Send instruction | Adds a requirement before the next coding prompt. If a planning response is in flight, that response is discarded and regenerated with your new instruction. |
| Stop (with confirmation) | Stops the controller's current Hermes/check subprocess and asks OpenCode to abort its managed session. Existing code changes remain. |
| Maximum coding prompts | Hard cap on how many coding prompts this run can submit, including corrections. |

## Reviewing approvals and questions

When OpenCode needs permission or clarification, a push alert tells you to open
**Approvals**. The inbox only includes requests belonging to the controller's
managed run. Use the inline card beside the run, or the **Approvals** page. **Inspect full request** opens the review window:

- Permission requests show the command or file scope, any proposed diff or file
  content supplied by OpenCode, and the full request. **Approve once** allows the
  specific request; **Deny and redirect** saves your note for Hermes and sends a refusal. Permanent approvals are not offered.
- Questions show OpenCode's choices and, when supported, a custom answer box.
  Complete every question and click **Send answers**, or reject the request.
- The server reloads the request and checks its session and exact displayed
  details before sending your decision. Changed or expired requests must be
  reviewed again. Double taps do not send a second decision.
- **Awaiting confirmation** means OpenCode accepted the reply but still lists
  the request. **Delivery uncertain** means an acknowledgement was lost; the
  controller will not automatically resend it. Check that session in OpenCode.
- **Decision history** stores the action, answers, original request, and status.
  Click a decision to reopen its details. The Activity tab also records replies.

A saved redirection is included in the next Hermes planning prompt. OpenCode receives the refusal immediately; it does not receive a replacement coding prompt until the current turn ends. If delivery fails, the note remains saved and the UI reports the failure.

Hermes proposes the next coding prompt; **you** make these approval decisions.
The controller sends your reply to OpenCode and continues monitoring the same
session. Rejecting a request lets OpenCode report the refusal or choose another
approach; it does not undo earlier changes or stop the entire run.

## Verification and completion

The optional verification command is fixed by you at run creation. It runs after
each OpenCode step, from the project directory. The command is parsed into an
argument list and executed directly; shell pipes, `&&`, and redirections are not
interpreted. For multiple commands, point it at your own verification script.

If verification is configured, a nonzero exit code prevents completion. Hermes
receives the actual output and is asked to send a correction. If the command is
blank, the UI and completion result explicitly say **review only**. A passing
command proves only what that command checks, not full correctness. For example,
a test runner that exits successfully after discovering zero tests is an
inadequate verifier; inspect the recorded output and choose meaningful checks.

File evidence is collected independently by reading eligible project text files
and computing differences. Previews are bounded: at most 100 files, 12,000
characters per file, and a 120,000-character total before manager-context
trimming. Hidden directories, secret-like filenames, symlinks, large/binary
files, dependencies, and the control service itself are excluded. This keeps
context manageable on your local model. It is not a complete repository audit.

## Limits and recovery

- Controller default prompt cap: 8; the new-run form starts at 6 (range 1–20).
- Three consecutive failed steps stop the run. Correction decisions are also
  bounded to three consecutive attempts.
- Hermes decision turn: at most 20 minutes and four tool iterations.
- OpenCode coding step: at most 30 minutes.
- Verification command: at most 5 minutes.
- Entire run: your selected limit, up to 2 hours of wall time, including pauses and approval waits. The new-run form starts at 30 minutes.
- Hermes decisions are also capped, so malformed or invalid completion behavior
  cannot cause an unbounded loop.
- Timeout requests an OpenCode abort. If the abort cannot be confirmed, the run
  enters **attention** and no new run is allowed until it is reconciled/stopped.
- On restart, active work is marked **interrupted**. **Resume** inspects the
  existing session and recorded message ID. A previously submitted prompt is
  never blindly replayed. OpenCode may continue a submitted task while the
  dashboard is offline.
- A lost acknowledgement during submission is reconciled using the message ID.
  If OpenCode has no record after 45 seconds, the controller asks for attention.
- Blocked, failed, completed, and limit-reached runs keep their records. Start a
  new goal after reviewing the result; the new run gets its own OpenCode session.
- Budget controls here are prompt/iteration/time limits, not a dollar spending
  cap. Reported model costs are not tracked in this version.
- One run executes at a time. The controller does not schedule concurrent agents.

## Troubleshooting

**Port 8766 is in use:** stop the old dashboard in its terminal. Do not terminate
unknown processes. Or choose `--port 8767` and open that port on the same IP.

**Cannot connect to OpenCode:** confirm the server is still running. If you used
`--port 0` and restarted it, use the newly printed port in `--opencode`.

**Hermes flag or JSON error:** share the dashboard error and the output of:

```bash
hermes --profile ai-arch-dev chat --help
```

No automatic Hermes upgrade is required by this package. Installed CLI support
is checked at startup, but a real model turn is still needed to verify provider
and model behavior.

**Permission or question waiting:** open **Approvals** and review the request.
If its details changed, close and reopen the window. If delivery remains
uncertain or your server does not support the reply API, open **Connections**
and use the displayed `opencode attach` command from your server terminal.
Keep the same session; do not send a separate task while the controller manages it.

**Tailscale address fails to bind:** confirm that `100.79.242.24` is the server's
current address with `tailscale ip -4`. The dashboard binds exactly to the host
argument supplied, not to every network interface.

**Test notifications worked, but this run has no push:** the package pins the
`ai-arch-dev` profile from your earlier Hermes output. If you changed profiles,
use `--profile` to select the one that owns the working push target.

## Offline checks

These tests simulate OpenCode and Hermes; they make no paid model calls and send
no notifications:

```bash
python3 -m unittest discover -s agent-autonomy/tests -v
```

To check the actual local connections without starting a model:

```bash
python3 agent-autonomy/app.py --doctor \
  --project /path/to/your/project \
  --opencode http://127.0.0.1:45381 --profile ai-arch-dev
```

Stop the running controller before using `--doctor`, since both use the same
journal lock. The dashboard's **Check connections** button performs the same
checks while it is running.

## Sources used for the adapters

- Hermes CLI: https://hermes-agent.nousresearch.com/docs/reference/cli-commands/
- Hermes toolsets: https://hermes-agent.nousresearch.com/docs/user-guide/features/tools
- OpenCode HTTP API: https://opencode.ai/docs/server/
- OpenCode attach CLI: https://opencode.ai/docs/cli/

The complete live integration still needs to be exercised on your server. This
package was checked with simulated services and real local subprocesses; it has
not called your Hermes model or your OpenCode instance from the build workspace.
The interface has been rendered in Chromium with simulated state in every
theme at 1440, 1024, and 390px (`tests/screenshots.cjs`). Those screenshots
use fixtures, not your real runs.

## Themes and keyboard controls

Use **Terminal / Mac / XP** in the toolbar. At phone widths, the navigation is
in the menu drawer. Terminal has a clickable shortcut bar. XP adds a window
frame, menus, a task pane, and a taskbar notification that opens pending reviews.
Window decorations are decorative and contain no real OS logos.

- `a`: open the pending approval; submit from the review window when appropriate.
- `d`: open Deny and redirect.
- `p`: pause/resume.
- `x`: open Stop confirmation; stopping still needs confirmation.
- `/`: focus the steering field.
- `v`: Verify now (runs your saved command while the run is paused or finished).
- `t`: open the OpenCode terminal full screen.
- `?`: show the shortcut table.
- `Enter` sends a steering note on devices with a keyboard; `Shift+Enter` adds a line.

Shortcuts are ignored in editable fields, while a modifier key is held, and
inside unrelated dialogs. Reduced-motion preferences disable the terminal cursor.

## Agents

Every run records the agents working on it:
- **`hermes`**: the orchestrator, using your Hermes profile.
- **`coder-1`**: the OpenCode coder.

Each coding turn is tagged with the agent that did it.

`GET /api/agents?run=<id>` (also included in `/api/state`) returns each agent's role, runtime, model, current state (`working`, `waiting_on_you`, `paused`, `idle`, `needs_attention`, `finished`…), current task, and counters.

States are worked out from the run's own record, so they always agree with it. Runs from before this version show the same two agents without their history being changed. This is the groundwork for multi-agent runs; the dashboard views for agents come later.

## Live updates

The dashboard gets changes pushed to it the moment they happen: new turns, OpenCode output, approvals, activity, and preview status. It uses a Server-Sent Events stream at `/api/events`, protected by the dashboard key like every other API call.
- The page footer shows **· live** when streaming and **· polling** when it has fallen back to checking every few seconds (older browser, network hiccup, or more than 12 open tabs). The fallback is automatic, and the stream reconnects by itself.
- Measured in Chromium: a server-side change reached the terminal view in about 0.2 s over the stream, versus 0.7–1 s with polling. An idle tab now re-reads the full state every 15 s instead of every 1–2 s.

## Live project preview (Project tab)

In **New run → Live preview**, choose how to run what gets built. You can also set this later in the **Project** tab. The preview starts automatically when the run completes, and the Project tab opens.

| Type | You enter | What you see |
| --- | --- | --- |
| Web app | the dev-server command and its port, e.g. `npm run dev -- --port 5173` and `5173` | the site in an embedded frame, with Full/Tablet/Phone widths, Reload, and Open in new tab |
| Static page | a folder or HTML file, e.g. `site/` or `index.html` | the page in the frame; nothing is executed |
| Command-line app | a command and optional default arguments, e.g. `python3 demo_app/todo.py` + `list` | a terminal you can type into (with Ctrl+C and EOF) and a field to run it again with other arguments |
| Desktop app | a command and screen size | the app on a virtual screen, refreshed about once a second; click it and type into it |

How it works and what to know:
- **What runs, and when.** Only the command saved on the run is executed. It runs in the project folder, without a shell, in its own process group. **Stop preview**, a new preview, stopping the controller (Ctrl+C or `kill`), and 30 idle minutes (`--preview-idle-minutes`) all end it.
- **The preview port.** Web and static previews are served on a separate port, `--preview-port`, which defaults to the dashboard port + 1. Previewed pages are then a different origin and cannot read the dashboard key. Opening that port needs a one-time ticket from the dashboard. Keep both ports on your tailnet.
- **HTTP only.** If you reach the dashboard through HTTPS (for example `tailscale serve`), the plain-HTTP preview frame will be blocked. Open the preview port directly instead.
- **Web limits.** The proxy passes normal HTTP requests. Websocket live-reload (for example Vite HMR) does not update through it, so press Reload. A port already used by another program is refused, so the preview can't show the wrong app.
- **Desktop tools.** Desktop previews need `Xvfb`, `xdotool`, and ImageMagick's `import` on the server, for example `sudo apt install xvfb xdotool imagemagick`. The option is disabled, and the missing tools are named, until they are installed. Without a window manager, windows open at the top-left of a black screen.

## Goal checks and follow-ups

Goal checks are saved acceptance criteria, entered by you and supplied to Hermes.
Use **Add a goal check** during a run to add a criterion before the next prompt.
Individual checks remain pending: the backend does not yet provide structured
criterion-level evidence. A passing verification command is shown separately.

**Start follow-up run** opens a fresh brief and attaches the selected run's brief
and summary as context. It uses a new managed OpenCode session. There are no
automatically invented follow-up suggestions.

## UI tests (optional development check)

The runtime still needs only Python 3.10+ and its standard library. These optional
DOM tests use Node and a small test-only dependency; they do not render screenshots,
contact your services, call a model, or send notifications:

```bash
npm install --prefix /tmp/agentcontrol-ui-tests --no-save --ignore-scripts linkedom cssom playwright-core
NODE_PATH=/tmp/agentcontrol-ui-tests/node_modules node agent-autonomy/tests/test_ui.cjs
# rendered screenshots of every theme at 1440, 1024, and 390px (uses the preinstalled Chromium)
NODE_PATH=/tmp/agentcontrol-ui-tests/node_modules node agent-autonomy/tests/screenshots.cjs
```

The test suite also parses the component CSS and verifies that component colors
reference theme tokens. All API routes remain protected by the dashboard key;
only the static page, JavaScript, and CSS are public to devices that can reach it.

## Access

The supplied launch command binds to your Tailscale address `100.79.242.24`.
Keep access on your tailnet and retain the dashboard key. If exposing the app
outside that private network, use HTTPS with authentication. This update does
not change your deployment or broaden its bind address.
