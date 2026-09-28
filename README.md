# TrialProject dashboard

This is a small local prototype. It records the exact prompt sent to OpenCode,
shows task activity and responses, and asks Hermes to send a push alert when a
task completes, fails to submit, or times out. It does not yet ask Hermes to
generate prompts automatically; the API below is the handoff Hermes will use.

## Start

Keep your working OpenCode server running in one terminal. From another:

```bash
cd /home/charlesjackson/TrialProject
python3 dashboard.py
```

If OpenCode restarts on a different port, set it first:

```bash
OPENCODE_URL=http://127.0.0.1:45381 python3 dashboard.py
```

On the server, open `http://127.0.0.1:8765`. Both services intentionally bind
only to localhost. To view the dashboard on your iPhone, SSH from a device on
your Tailnet with local forwarding `-L 8765:127.0.0.1:8765`, then open
`http://127.0.0.1:8765` **on that same device**. An iPhone SSH app must support
local port forwarding to use this approach. Do not publish port 8765 without
adding authentication first.

## First task

Paste this into the dashboard form:

> Describe the files in this project. Do not edit files, run commands, install
> dependencies, or start another agent. If it is empty, say so.

To have Hermes submit a prompt, tell Hermes to POST to the local endpoint. The
exact request shape is:

```bash
curl -fsS -X POST http://127.0.0.1:8765/api/tasks \
  -H 'Content-Type: application/json' \
  --data '{"prompt":"Describe the files in this project. Do not edit files."}'
```

Hermes should generate its own prompt, show it to you if desired, then call
this endpoint once. The server saves the submitted prompt before sending it to
OpenCode. Press **Pause new tasks** to reject new submissions. It does not
interrupt a task already running. The SQLite journal lives beside the script.

## Limits

- This is a local trial, with no login, no durable job queue, and no automatic
  restart. Restarting during a task does not resume monitoring it.
- A submitted prompt starts a fresh OpenCode session. Persistent session reuse
  and editable task queues are next steps after this smoke test.
- The page refreshes every two seconds. Tool names and states come from
  OpenCode messages; it does not expose private model reasoning.
- Tool activity can appear more than once as its status changes. Task output
  is shown when OpenCode becomes idle. A task still running after 15 minutes
  is marked timed out for monitoring purposes, but is not aborted in OpenCode.
