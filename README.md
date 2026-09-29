# AgentControl

A local control plane for autonomous coding runs. You write one goal. Hermes
plans each coding turn, OpenCode carries it out, and AgentControl captures file
changes, runs your verification command, and keeps every prompt, tool call, and
approval in view. You approve requests and steer from any browser on your
tailnet, including your phone.

The app lives in [`agent-autonomy/`](agent-autonomy/). Its README covers the
controls, limits, and recovery behavior in detail.

## Start

Keep your OpenCode server running. From the repository root:

```bash
python3 agent-autonomy/app.py \
  --host 127.0.0.1 --port 8766 \
  --project /path/to/your/project \
  --opencode http://127.0.0.1:45381 \
  --profile ai-arch-dev
```

Open the printed address and enter the **dashboard key** shown in the terminal.
Tick **Remember on this device** so you don't have to type it again on that
browser. To reach the dashboard from your phone, bind `--host` to your Tailscale
address and keep it on the tailnet. Do not expose the port publicly without
HTTPS and authentication.

`python3 agent-autonomy/app.py --doctor --project … --opencode …` checks the
Hermes CLI and the OpenCode API without starting a model.

## What you see

- **Turns rail and workflow board.** Each coding turn reads left to right: Plan
  (Hermes) → Prompt → Code (OpenCode) → Verify (your command).
- **Live OpenCode terminal.** The Code stage streams OpenCode's text, tool
  calls, and command output while it works. It follows new output until you
  scroll up. Press `t` for full screen.
- **Approvals.** Requests appear as a banner above the board and in the terminal
  with a Review button. Approve once, or deny and redirect Hermes. Each request
  carries a risk class (R0–R3). Critical ones need you to type `approve`, and
  every request and decision goes into a hash-chained audit log.
- **Project tab (live preview).** When a run completes, AgentControl starts the
  preview you saved and shows the project running. It can be a web app in a
  frame, a static page, a command-line program you can type into, or a desktop
  app on a virtual screen. See `agent-autonomy/README.md` for setup.
- **Runs work on their own branch** (git projects). Your checkout is not
  touched until you press **Apply**, which merges the run's branch with a merge
  commit. Verification runs on the merged result.
- **Model server.** Optionally describe your model server (for example
  llama-server) in `state/models.json`. AgentControl checks that it answers
  before sending work, records token usage per agent, and can run a local
  gateway that queues model calls. See `agent-autonomy/README.md`.
- **Themes.** Mac (follows the system light/dark setting), Terminal, and XP.

## Tests

```bash
python3 -m unittest discover -s agent-autonomy/tests -v
# optional browser-free DOM tests and rendered screenshots
npm install --prefix /tmp/ac-tests --no-save linkedom cssom playwright-core
NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_ui.cjs
NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/screenshots.cjs
```

## The retired single-file dashboard

The original prompt journal `dashboard.py` was removed in version 5. Every one of
its features exists in `agent-autonomy/`. If you still have its local
`activity.sqlite3` journal, it is untouched. It is plain SQLite, so you can open
it with `sqlite3 activity.sqlite3 'select * from tasks'`.
