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

Open the printed address at **`/`** for the chat interface and enter the **dashboard key** shown in the terminal.
Tick **Remember on this device** so you don't have to type it again on that
browser. To reach the dashboard from your phone, bind `--host` to your Tailscale
address and keep it on the tailnet. Do not expose the port publicly without
HTTPS and authentication.

Before upgrading, **stop the server and back up `state/autonomy.sqlite3`**. The journal uses WAL; stop it before
copying the database. N2 appends migration `_v8` without changing historical rows. Older builds ignore its new tables.

Chat bundles Inter and IBM Plex Mono locally and uses the mock's dark component styling, with accessible contrast,
touch targets and text sizing. It has six sections: **Primary, Agents, Projects, Workspace, Skills and Settings**. Projects holds the
existing team thread, approvals and sessions. Agents manages your specialist library; Primary has an explicit setup
and editable configuration. Projects supports nested directories and advisory membership, while Skills stores
assignments and separate Ask/Deny tool policies. Sessions still choose agents automatically; these records do not
change execution or grant permissions. Primary and Direct conversations, file browsing and Memory remain unavailable.
Skills shows the real shared catalog.
The classic dashboard remains at **`/classic`**, using the same key. Settings and Skills link to its full
management, Usage, Activity and runtime controls. **Turn details** links to a standalone classic pop-out for
interactive surfaces. `/chat` remains an alias
for the chat interface; existing `/?popout=…` bookmarks keep opening classic.

`python3 agent-autonomy/app.py --doctor --project … --opencode …` checks the
Hermes CLI and the OpenCode API without starting a model.

## What you see

- **Project room and turns.** The default chat interface shows sessions, recorded messages and decision cards.
  Open a turn's **Turn details** for stages, output, changed files, diffs and verification. Classic retains the
  turns rail and horizontal Plan → Prompt → Code → Verify board.
- **Live OpenCode terminal.** The Code stage streams OpenCode's text, tool
  calls, and command output while it works. It follows new output until you
  scroll up. Chat Turn details shows recorded output; classic offers Copy and `t` for full screen.
- **Approvals.** Actionable requests appear once as room cards, with a waiting indicator linking to them.
  Approve once, or deny and redirect Hermes. Each request
  carries a risk class (R0–R3). Critical ones need the server's typed confirmation word, and
  every request and decision goes into a hash-chained audit log.
- **Project tab (live preview, in classic).** When a run completes, AgentControl starts the
  preview you saved and shows the project running. It can be a web app in a
  frame, a static page, a command-line program you can type into, or a desktop
  app on a virtual screen. See `agent-autonomy/README.md` for setup.
- **Runs work on their own branch** (git projects). Your checkout is not
  touched until you press **Apply**, which merges the run's branch with a merge
  commit. Verification runs on the merged result.
- **Team runs.** Hermes proposes a small team of coders and a task plan; after
  you approve it, the coders work in parallel on their own branches and their
  work is merged and verified. Every agent's approvals still come to you.
- **Auto mode.** Let AgentControl choose between one agent and a team from
  your brief; it explains its choice, and a team still needs your approval.
- **Skills.** Give agents OpenCode skills from your own library or a pinned git
  commit. Every install is reviewed and approved by you, installed per agent,
  logged, and removable. Chat supports actionable installation review; the library and removal stay in classic.
- **Virtual machines (configured in classic).** Opt in per run to run the agents in a KVM clone of your
  ai-arch baseline: files move over SSH, the VM reaches only your host after
  setup, agents have no sudo, and you can watch and use its screen through the classic pop-out.
- **Specialists.** Hermes can add a tester (only test changes merge), a
  read-only reviewer, or a web researcher (each question needs your typed
  approval) when the work needs one.
- **Optional paid models (in classic).** Pick a paid model per run and role, with a
  typed confirmation and a spend cap enforced at the gateway; a Usage page
  reports tokens and spend. Nothing requires a paid provider.
- **Members and Mission control.** Chat separates recorded members from proposed teams and shows the task graph
  in Session details. Classic retains a home view with a live card per agent (state, task,
  output, tokens, requests waiting), the task graph and the model queue; open
  any agent for its own filtered view. Classic phones get a bottom tab bar.
- **Containers (configured in classic).** Opt in per run to run the agents in a rootless Docker or
  Podman container: only the run's worktrees, no network after setup, CPU and
  memory limits, and your approvals still apply. Desktop previews run inside
  it and stay clickable from classic's Project tab or pop-out.
- **Model server.** Optionally describe your model server (for example
  llama-server) in `state/models.json`. AgentControl checks that it answers
  before sending work, records token usage per agent, and can run a local
  gateway that queues model calls. Chat shows Connections; detailed queue and usage controls stay in classic.
  See `agent-autonomy/README.md`.
- **Appearance.** Chat has one dark appearance with same-origin bundled fonts. Classic retains Mac, Terminal and XP themes.

## Tests

```bash
python3 -m unittest discover -s agent-autonomy/tests -v
# optional browser-free DOM tests and rendered screenshots
npm install --prefix /tmp/ac-tests --no-save linkedom cssom playwright-core
NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_ui.cjs
NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_chat_ui.cjs
NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/chat_screenshots.cjs /tmp/chat-shots
NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/screenshots.cjs
```

## The retired single-file dashboard

The original prompt journal `dashboard.py` was removed in version 5. Every one of
its features exists in `agent-autonomy/`. If you still have its local
`activity.sqlite3` journal, it is untouched. It is plain SQLite, so you can open
it with `sqlite3 activity.sqlite3 'select * from tasks'`.

The isolated device-checklist fixture accepts an optional readable throwaway key:
`python3 agent-autonomy/tests/device_fixture.py --port 8767 [--key <value>]`.
Omit `--key` to generate an eight-character disposable key. Explicit keys accept 4–64 printable ASCII
characters without spaces and are used exactly.
