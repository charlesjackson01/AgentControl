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

Needs Python 3.10 or newer (standard library only). The test suite is run on 3.10 and 3.11.

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

## Mission control

**Mission** is the dashboard's home. It shows the selected run (normally the active one) at a glance:
- **One card per agent**, Hermes first, then each coder. A card shows:
  - its state: working, waiting on you, idle, paused, or needs attention
  - its current task, and the last lines of its latest turn's output, live
  - its tokens, turns and tool calls
  - its branch, skills, and whether it runs in the container
  - a button when a request from that agent is waiting for you
- **Tasks:** for a team, a dependency view in which a task starts once the tasks it depends on are merged. For one agent, the latest turns. Selecting either opens that turn.
- **Resources:** the model server and its queue (who is generating, who is waiting), the container, and the preview.
- **Latest activity.**

Select an agent card to open **that agent's view**. It is the run page, filtered to the agent's own turns, live terminal, requests, skills, usage and changed files. The switcher at the top moves between agents, and **← Mission** goes back. A note written there is still sent to Hermes, marked "Note for coder-2: …"; Hermes decides what the coder is told, so nothing bypasses planning or your approvals. **Runs** without an agent selected is the same page as before.

On a phone, a **tab bar** along the bottom holds Mission, Approvals (with the waiting count), Run, Project and More (the drawer with recent runs, Activity, Skills and themes). It takes the place of the terminal theme's shortcut bar and XP's taskbar there. The dashboard remembers the last section you used in this browser.

One run is active at a time; mission control shows that run's agents.

## Controls

| Control | Effect |
| --- | --- |
| Start run | Begins one bounded project run from your goal. |
| Pause | Lets the current coding/verification step finish, then waits before the next model request or coding prompt. A planning turn already running can finish. |
| Resume | Continues a paused run, or reconciles a run interrupted by a restart/network failure. |
| Send instruction | Adds a requirement before the next coding prompt. If a planning response is in flight, that response is discarded and regenerated with your new instruction. From an agent's view the note is marked for that agent and still goes to Hermes. |
| Stop (with confirmation) | Stops the controller's current Hermes/check subprocess and asks OpenCode to abort its managed session. Existing code changes remain. |
| Maximum coding prompts | Hard cap on how many coding prompts this run can submit, including corrections. |

## Reviewing approvals and questions

When OpenCode needs permission or clarification, a push alert tells you to open
**Approvals**. The inbox only includes requests belonging to the controller's
managed run. Use the inline card beside the run, or the **Approvals** page. **Inspect full request** opens the review window:

- Permission requests show the command or file scope, any proposed diff or file
  content supplied by OpenCode, and the full request. **Approve once** allows the
  specific request; **Deny and redirect** saves your note for Hermes and sends a refusal. Permanent approvals are not offered; see *Permission risk and audit* below for run-scoped rules.
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

`tests/test_team_e2e.py` runs a two-agent team on a real `opencode serve` with a scripted model, kills the controller mid-run and resumes it. It runs when an OpenCode binary is available (`OPENCODE_BIN=/path/to/opencode` or `opencode` on PATH) and is skipped otherwise.

The model tests use ai-arch's scripted mock endpoint (`ai-arch/tests/mock-endpoint/server.py`) as the model server, so they need the `ai-arch/` folder next to `agent-autonomy/`.

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

## Permission risk and audit

Every OpenCode request gets a risk class from AgentControl's own registry (`permissions.py`, adapted from ai-arch `docs/SECURITY.md`). The class and the impact text never come from the model.

| Class | Examples | What you do |
|---|---|---|
| **R0 Read only** | read, list, grep | Approve once |
| **R1 Low** | OpenCode's task list, questions | Approve once |
| **R2 Sensitive** | edit, write, shell commands, web access | Approve once |
| **R3 Critical** | recursive delete, `sudo`, `curl … \| sh`, force push, `git reset --hard`, privileged Docker, writes to system folders, anything touching `.ssh`/`.env`/keys, files outside the project, and **any request type AgentControl does not recognise** | Type `approve` to confirm |

- Nothing is approved automatically by default.
- For an R1 or R2 request you can tick **Approve identical requests for the rest of this run**. That creates a rule that matches only the same permission with the same command or paths, only in this run. Rules are listed under **Approvals → Remembered approvals**, where **Revoke** turns them off.
- Critical requests can never be remembered, and the class is re-checked every time a rule is matched.
- The API always records decisions as *You, via dashboard*. Only AgentControl's own rule check can approve automatically, and only with a rule you created.
- **Audit log:** every request, decision, block, rule added and rule revoked is appended to an audit table in the journal. Each entry stores the hash of the one before it, so an edited or deleted entry breaks the chain. The dashboard shows whether the chain is intact. `GET /api/audit?run=<id>` returns `{entries, chain_intact, broken_at}`.

## Runs on git projects work on their own branch

If the project folder is a git repository, each run works in its own **git
worktree** on branch `agentcontrol/<run>/coder-1`. Your checkout stays as it is
while the run works. Worktrees live under `agent-autonomy/state/worktrees/`.
Projects that are not git repositories keep working directly in the folder, as
before.

- **Starting.** The run starts from your last commit on the current branch. If you have uncommitted changes, New run lists them and asks you to tick *Start from my last commit anyway*; your changes stay in your checkout. A detached HEAD, an unfinished merge, or a repository with no commits means the run works in the folder instead, and says why.
- **Setup command** (optional, in New run). A fresh worktree has only committed files, so dependencies like `node_modules` or `.venv` are missing. A setup command such as `npm ci` runs once in each worktree before the first turn.
- **Each turn** is committed on the agent's branch and merged into `agentcontrol/<run>/integration`. The verification command runs on the integration branch, and changed files and diffs come from git, with no 100-file limit.
- **Conflicts.** If a turn does not merge cleanly into integration (for example, when two agents edit the same lines), integration is left untouched. The conflict markers go to the agent's worktree, Hermes is told which files conflict, and the next prompt resolves them. Files that still contain markers are never committed.
- **Apply.** When the run has finished, the **Branch** panel on the run page offers **Apply to <branch>**. After you confirm, it merges the integration branch into your branch with a merge commit. It is only available when your checkout is on that branch, has no uncommitted changes to tracked files, and has no merge in progress; the panel says what is blocking it. Your git hooks run as usual. If the merge conflicts, it is undone, your branch is unchanged, and you can merge it yourself. After Apply, the worktrees are removed and the branches kept.
- **Discard branch** deletes the run's branches and worktrees after confirmation.
- **Follow-up runs** of a run that was not applied continue from its branch.
- Live previews and **Verify now** use the integration branch until you apply.
- Apply and Discard are recorded in the audit log.

AgentControl's own commits and merges on the run branches use an AgentControl identity and skip your repository's hooks, so they need no git configuration and never run project code.

## Team runs (several coders)

In New run, choose **A team** (git projects only) and the largest team you allow
(2 or 3 agents). The run then goes like this:

1. **Hermes proposes a plan.** It lists the agents, what each is responsible for, and the tasks with their dependencies and the files they will touch. AgentControl checks the plan first: every task has an agent and a prompt, dependencies exist and have no cycles, and the size limits hold. A plan that fails the checks gets one retry with the problems listed. Tasks for different agents that touch the same files without an order between them are flagged as likely conflicts.
2. **You decide. Nothing runs before that.** You can:
   - **Approve plan**
   - **Run as a single agent**
   - **Ask for a different plan**, with a note to Hermes (up to three proposals in all)

   If Hermes proposes one agent, approving runs it as a normal single-agent run. The run waits for your decision; the time limit still applies. Your decision is recorded in the audit log.
3. **Agents work in parallel.** Each approved agent gets its own worktree, branch (`agentcontrol/<run>/coder-N`) and OpenCode session.
   - A task starts when its dependencies are done and its agent is free. The agent is first brought up to date with the merged work.
   - Finished tasks are committed, merged into the integration branch and verified there.
   - A task that conflicts with already-merged work, or ends in an OpenCode error, is retried automatically with a targeted prompt (for example, "resolve these conflict markers"). It gets at most 3 attempts in all; after that it is marked failed, and tasks that depend on it are marked blocked.
   - Every agent's permission requests and questions come to your Approvals as usual, labelled with the agent.
4. **Hermes reviews the merged result**, using the same loop as single-agent runs. It sees every task's status, can send a fix to a named agent, and marks the run complete only when your verification command passes on the integration branch.

Every prompt and retry counts toward the run's prompt limit. The run page shows the plan while it waits for you. Once the team starts, the Team panel shows each agent's state and the task list; select a task to follow its latest turn. Turns and approvals show which agent they belong to. Stop aborts every working agent. After a controller restart, **Resume** carries on from the journal:
- a plan waiting for you is not proposed again
- a task that was running is followed to the end, not sent again

Your model server answers one request at a time (M0: `-np 1`), so a team saves time mostly when agents spend time running tools and tests rather than generating text.

## Skills for agents

Agents can be given **OpenCode skills**: folders with a `SKILL.md` (a name and a
description) plus helper files, which OpenCode loads when the agent needs them.
Nothing is installed without you.

- **Your library.** Put skill folders in `~/agentcontrol/skills/` (or start with `--skills-library DIR`). The **Skills** tab lists them, including invalid ones and the reason, and shows whether you have reviewed each exact version.
- **Git.** On a run page you can also give a repository URL (https, ssh, or a local path), a branch, tag or commit, and an optional folder. AgentControl clones it into quarantine and pins the exact commit. Clones run without hooks, submodules or LFS.
- **Checks before you see anything:**
  - `SKILL.md` exists, and its name is lowercase letters, digits and dashes
  - at most 50 files, 256 KB per file and 512 KB in total
  - no symbolic links, and no paths outside the folder

  A skill with only text is **R1 Low**. One containing scripts or programs is **R2 Sensitive**; an agent running them still needs your `bash` approval.
- **Review and approval.** Each install proposal in **Approvals** shows:
  - who asked, and why
  - the source and commit
  - the file list and the `SKILL.md` text, shown as text; it is never treated as instructions

  Approving installs that exact version. If the content changed after it was shown to you, the install is refused and the new version is shown instead. Once you have approved a version from your library, adding the same version again installs straight away. A changed version is reviewed again.
- **Hermes can ask** for a library skill in a decision, or per agent in a team plan. It can also name a git repository. Every such request is a proposal for you, even for content you trusted before. For git, nothing is downloaded until you press **Fetch for review**. Hermes gets at most 3 requests per decision and 10 per run. Library descriptions reach Hermes marked as untrusted data.
- **Per agent.** A skill is copied into one agent's worktree only (`.opencode/skills/<name>/`). When that agent asks OpenCode to load it, AgentControl approves the load automatically, as your install approval. The same request from another agent, or for another skill, still comes to you. OpenCode reads skills once per folder, so AgentControl has it reload them just before that agent's next prompt: a skill you add mid-turn is available from the next turn.
- **Never on your branch.** Installed skills are left out of every turn commit, so Apply never brings them into your project.
- **Rollback.** **Remove** on the run page deletes the folder and stops the automatic approvals. Applying or discarding the branch removes all of the run's skills. Every request, fetch, install, rejection and removal is in the audit log and in the Skills tab's history.
- Skills work in runs on their own branch (git projects). MCP tool servers, packages, and Hermes's own skills come in later milestones.

## Running agents in a container

By default OpenCode runs its tools (shell commands, edits) on this machine as
your user. In **New run → Where agents run** you can choose **Container**
instead, one run at a time. The run's OpenCode server then runs inside a
locked-down container; AgentControl and Hermes stay on the host.

**What the container gets**
- **Files:** only the run's worktrees, read-write, plus the repository's `.git`, **read-only** (git works, history cannot be rewritten). Your checkout and home folder are not mounted.
- **Locked down:**
  - all Linux capabilities dropped, and `no-new-privileges`
  - a read-only root filesystem, with `/tmp` in memory
  - a process limit, plus the CPU and memory you choose (default 4 CPUs, 8 GB)
  - no published ports; AgentControl talks to it over Unix sockets in `state/`
- **Network**, one of:
  - **Internet for the setup command only, then none** (default): the network is cut before the first prompt, and the time is shown on the run page.
  - **None at all.**
  - **Internet while agents work.** This is critical: you type `approve` to choose it.
- **Model:** the container reaches your model server only through a per-run gateway on a Unix socket. It needs no network, every call is queued and counted as usual, and `state/models.json` must be configured (see "Model server" below).
- **Your approvals still apply.** OpenCode inside uses the `permission` block from your OpenCode config (default: ask for edits, shell, web fetches and outside folders). Its requests come to Approvals as usual. Agents cannot change that config: an edit to `opencode.json` or `.opencode/` is always critical.
- **Where commands run:** the setup command, the verification command and Verify now run inside the container. Commits, merges and Apply happen on the host.
- **Previews:** web, terminal and desktop previews run inside the container. In the Project tab you see the container's virtual screen and can click and type into it.

**On the run page** a Container panel shows:
- state, runtime (rootless ✓), image, limits and network
- **Stop container** (only while the run is paused or finished) and **Start container**

The container is removed when you apply or discard the branch. Container runs need a git project, a rootless runtime and the agent image.

**One-time setup on your server**

1. **Use a rootless runtime.** Membership in the `docker` group is equivalent to root, so AgentControl refuses a root-owned Docker daemon for agent containers. Choose one:
   - **Podman** (rootless by default):
     ```
     sudo apt install podman uidmap        # Zorin/Ubuntu/Debian   (Arch: sudo pacman -S podman)
     grep $USER /etc/subuid /etc/subgid   # both need a range; if not: sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $USER
     podman info --format '{{.Host.Security.Rootless}}'   # prints true
     ```
   - **Rootless Docker**, next to your existing Docker:
     ```
     sudo apt install uidmap docker-ce-rootless-extras   # Zorin/Ubuntu, from Docker's own apt repository
     #   (Ubuntu's docker.io package has no dockerd-rootless-setuptool.sh; Arch: yay -S docker-rootless-extras)
     dockerd-rootless-setuptool.sh install
     systemctl --user enable --now docker
     export DOCKER_HOST=unix://$XDG_RUNTIME_DIR/docker.sock   # start AgentControl with this set
     docker info | grep -i rootless                           # shows "rootless"
     ```
   AgentControl tries Podman first, then Docker; `--container-runtime docker|podman` picks one. `--allow-rootful-containers` lifts the refusal and shows a warning. Use it only for throwaway machines.
2. **Build the agent image** (Debian slim with git, Python, Node, Xvfb, xdotool and ImageMagick, plus your own OpenCode binary, so the version matches the host):
   ```
   python3 agent-autonomy/app.py --build-agent-image
   ```
   The command is printed before it runs. If `opencode` on your PATH is a wrapper script and not the standalone binary, pass `--opencode-binary ~/.opencode/bin/opencode`. The image needs network only while it builds.
3. Restart AgentControl. The Container option explains why when something is missing; **Check again** re-detects.

A container test is included and runs only when you ask for it:
```
AGENTCONTROL_CONTAINER_TESTS=1 python3 -m unittest tests.test_container_e2e   # from agent-autonomy/
```
The test checks, for a real run inside a real container (with a scripted model):
- the agent's edit request is approved as usual
- the work appears in the worktree only
- there is no internet, all capabilities are dropped, and the root filesystem is read-only
- a desktop preview frame is drawn and a click goes through
- stopping the preview ends it inside the container
- Apply removes the container

## Running agents in a virtual machine (KVM)

For work that needs a whole machine, choose **Virtual machine** in New run. The run gets its own KVM clone of your ai-arch baseline, and AgentControl and Hermes stay on your host.

**What the VM is**
- **A thin copy-on-write clone:** a new qcow2 overlay whose backing file is your baseline, so the baseline is only read. It uses a libvirt domain built from your `ai-arch-dev` definition (never modified) and switched to KVM with your CPU. It gets:
  - the CPUs and memory you choose
  - its own firmware variables
  - displays on 127.0.0.1 only
  - no shared host folders or passed-through devices
- **Provisioned on first boot,** over SSH as your baseline's admin user (`archdev`):
  - **Tailscale is stopped and disabled in the clone,** so it never appears on your tailnet as `ai-arch-dev`.
  - An unprivileged `agent` user is created **without sudo**; every agent command runs as that user.
  - `git`, `python`, the Xvfb tools and ImageMagick are installed with pacman if missing.
  - Your own OpenCode binary is copied in, with a config whose only model provider is AgentControl's run gateway, and your host `permission` rules.
- **Your files never get mounted:**
  - Before each prompt, the agent's folder is copied into the VM over SSH, at the same path: the tracked and unignored files, with deletions mirrored. The VM keeps its own git snapshot of it.
  - After the turn, the folder comes back the same way. Only regular files with plain paths inside the worktree are accepted; links and paths that point outside are refused and logged. Files ignored by git (for example `node_modules`) stay in the VM.
  - Commits, merges, Apply and Discard happen on your host as always. The verification command and the setup command run inside the VM.
- **Transport:** one SSH connection carries AgentControl → OpenCode in the VM, and the VM's model requests → the run's gateway. Your approvals, spend caps and usage work exactly as elsewhere.
- **Network:**
  - A new clone first boots on `agentcontrol-isolated`, with no route out. Over SSH, AgentControl turns Tailscale off, and only then moves the clone to libvirt's NAT. A clone of a baseline that is on your tailnet therefore never reaches Tailscale's servers with the original's identity. If Tailscale can't be stopped, the clone stays without network and the run asks for your attention.
  - The VM uses libvirt's NAT only while it is provisioned and your setup command runs. Restarting a provisioned VM never turns the network back on.
  - It then moves to `agentcontrol-isolated`, a host-only network that AgentControl creates, where the VM can reach only your host. The move is tried live first; if that doesn't give a working address, the VM is rebooted on the new network.
  - "Internet while agents work" keeps the NAT and needs your typed `approve`.
- **Screen:** the Project tab shows the VM's own console, refreshed about once a second. Your clicks go in as absolute mouse events, and your typing and keys through libvirt (a US key map). Each is recorded in the audit log, but not the text you type. Web, terminal and desktop previews also run inside the VM.
- **Lifecycle:**
  - The run page's Virtual machine panel shows state, clone, limits, network and address, with Shut down and Start buttons.
  - The VM shuts down when the run ends (unless a preview starts) and is removed with its overlay when you apply or discard the branch.

**Setup on your server**
```
# your user needs libvirt access, /dev/kvm, and an SSH key authorized in the baseline for archdev.
# By default AgentControl uses ai-arch's owner key ~/.ssh/ai-arch-dev_ed25519 (else ~/.ssh/id_ed25519).
python3 agent-autonomy/app.py --vm-baseline ~/ai-arch/vms/ai-arch-baseline-with-tailscale.qcow2
#   optional: --vm-template ai-arch-dev  --vm-ssh-key ~/.ssh/ai-arch-dev_ed25519  --vm-user archdev  --vm-opencode /path/to/opencode
#             --vm-storage DIR   (where clone disks go; default: agentcontrol-runs next to the baseline)
```
**Where the clone's disk goes.** QEMU runs as its own user (`libvirt-qemu` on Zorin/Ubuntu), so it must be able to enter every folder above the clone's disk. By default each run's overlay disk, firmware variables and definition go in `agentcontrol-runs/<run>` next to your baseline, because your existing VMs already boot from there. AgentControl's own state folder keeps only the SSH and socket files. If you choose another folder with `--vm-storage` and starting fails with "Permission denied", either pick a folder QEMU can reach or allow it to pass through, once: `sudo setfacl -m u:libvirt-qemu:x /home/you /home/you/that-folder`.
The option is disabled in New run, with the reason, until this works: libvirt at `qemu:///system`, `/dev/kvm`, the baseline, the template domain, the key, your OpenCode binary, and `models.json`. To try the whole thing once (it boots a VM and needs internet the first time):
```
cd agent-autonomy && AGENTCONTROL_VM_TESTS=1 AGENTCONTROL_VM_BASELINE=~/ai-arch/vms/ai-arch-baseline-with-tailscale.qcow2 \
  python3 -m unittest tests.test_vm_e2e
```
That test checks:
- the agent's file comes back through SSH
- there is no internet inside after setup
- the agent user has no sudo
- Tailscale is off in the clone
- a console frame is shown and a click works
- Apply removes the VM
- the baseline file is unchanged

## Auto mode

Choose **Auto** in New run to let AgentControl pick between one agent and a team.
While you write the brief, New run shows what Auto would do and why
(`POST /api/mode/preview`). The rules come first; the first matching row wins:

| # | When | Auto does |
|---|---|---|
| 1 | The project is not a git repository with a commit | One agent |
| 2 | The prompt limit is below 3 | One agent |
| 3 | The brief names fewer than 2 areas of work (UI, API, storage, CLI, tests, docs, packaging) or list items | One agent |
| 4 | One model slot, no verification command, and fewer than 4 parts | One agent (extra agents would mostly wait on the model) |
| 5 | Otherwise | Asks Hermes for a team plan |

If Hermes then proposes one agent, or cannot produce a usable plan, Auto runs one agent without asking you. That is an ordinary run, and it is recorded in the activity and audit logs. **A team never starts without your approval:** when Hermes proposes several agents, you get the same plan review as in a team run, where you can still choose one agent. The run page says what Auto chose and why. Choosing **One agent** or **A team** yourself always skips Auto.

## Model server, usage, and the optional gateway

AgentControl can watch the model server your agents use (for example your local
llama-server). Describe it in `agent-autonomy/state/models.json`, or pass
`--models FILE`. An ai-arch `ai-arch.json` also works as-is and becomes one
endpoint named `ai-arch`.

```json
{
  "default": "local",
  "endpoints": [
    {"id": "local", "url": "http://127.0.0.1:8080", "model": "", "slots": 1}
  ]
}
```

- `url` is where llama-server listens. `model` is optional; if set, AgentControl warns when the server does not list it.
- `slots` is how many requests the server should get at once. Match llama-server's `-np`. The M0 benchmark showed `-np 1` gives no extra throughput for parallel requests, so 1 is right today.
- `api_key_ref` is optional and names a file in ai-arch's secret store (`~/.local/share/ai-arch/secrets`, mode 600). The key is never written to AgentControl's files or shown in the dashboard.
- A provider marked `"paid": true` (with `cost_per_mtok_in`/`cost_per_mtok_out`) can be listed but can never be the default. Nothing needs a paid provider.
- With no `models.json`, all of this is off and AgentControl behaves as before.

When an endpoint is configured:

- **Health.** Check connections includes the model server. Before each Hermes decision and before each new OpenCode prompt, AgentControl checks that the server answers. If it does not, the run pauses with *Model server … is not responding. Nothing was sent*. Start the server and press **Resume**; the unsent prompt goes out then.
- **Usage.** Token counts are recorded per call: Hermes from its `stream-json` result, and OpenCode from its own message totals. The run page shows **Model usage** per agent. `GET /api/models?run=<id>` returns the endpoints, their health and queue, usage totals, and recent calls (`&check=1` re-checks health now).

**Optional gateway.** Start AgentControl with `--gateway-port 8768` to open a
local, OpenAI-compatible gateway in front of the model server (loopback only).
Then point your agents at it instead of at llama-server:

- OpenCode: set your provider's `baseURL` to `http://127.0.0.1:8768/agent/opencode/v1`.
- Hermes: set the model base URL in your Hermes profile to `http://127.0.0.1:8768/agent/hermes/v1`.

The gateway forwards each request unchanged and streams the reply back. It:

- lets at most `slots` requests through at once and queues the rest, with Hermes planning ahead of coding requests
- records every call with its queue time and tokens against the active run
- adds the server key from `api_key_ref` if one is set, so agents never see it
- marks a stream that ends without `[DONE]` as *incomplete*

This follows the design of ai-arch's `aid` gateway. It is optional; without it, AgentControl still records usage from what Hermes and OpenCode report.

## Specialist agents: tester, reviewer, researcher

Besides coders, Hermes can bring in a specialist, **only when the work needs one**. It can do this in a team plan (you approve the plan as usual), or, in a one-agent run, as a single `delegate` turn (at most 3 per run). The roles are declared in `agents.py`; a new role later is one more entry there.

| Role | Runs as | Works in | May change | Enforced by AgentControl |
|---|---|---|---|---|
| **Tester** | OpenCode | its own branch | test files, and files its task names | A turn that changes anything else is **not merged** and is dropped from its branch; it is retried with the reason. Your approvals apply as for coders. |
| **Reviewer** | OpenCode | a copy of the merged result | nothing | Its prompts switch off OpenCode's write, edit, patch, bash and web tools. Any permission it asks for is **refused for you** and logged. Anything it leaves behind is discarded. Its findings (file, line, severity, suggestion) go to Hermes, which decides whether a coder fixes them. |
| **Researcher** | Hermes CLI | an empty scratch folder | nothing | **Each question waits for your typed `approve`** in Approvals. It runs Hermes with only the toolsets you name, never `--yolo`, and with limits on turns and time. Its cited report goes to Hermes and dependent tasks, marked as untrusted web content, and every source URL is in the audit log. |

Notes:
- A researcher task in a team plan holds back only the tasks that depend on it. Declining a question is reported to Hermes, which carries on without it.
- OpenCode's own `plan` agent is **not** used for the reviewer: our M12 spike showed it still writes files when your OpenCode config allows edits. The per-prompt tool switch does hold (see `spikes/opencode_agent_probe.py`).

**Sharing one GPU.** At most `slots + 1` agents work at once (so one can generate while another runs tools or tests); `--max-parallel-agents N` overrides this. Only one researcher runs at a time, and a research call takes a model slot while it runs, because Hermes calls the model server directly.

**Enabling the researcher.** AgentControl never guesses Hermes toolset names. Run the probe on your server:
```
python3 agent-autonomy/spikes/hermes_research_probe.py            # lists your Hermes toolsets
python3 agent-autonomy/spikes/hermes_research_probe.py --try web  # optional: one real research call, asks first
```
Then start AgentControl with `--research-toolsets <names>`, for example `--research-toolsets web`. Until then, the researcher is shown as unavailable, with the reason, and Hermes is not offered it.

On the ai-arch server (Hermes v0.21.4), the probe lists `web` (search and scraping) and `browser` (browser automation), and every flag the researcher uses is present. The chosen setting there is `--research-toolsets web,browser`.
- `web` only reads.
- `browser` can also click, fill in and submit forms on the sites it visits. The research approval card says so whenever `browser` is configured.
- Each question still waits for your typed `approve`.

## Paid models (optional), spend caps and usage

Everything works with no paid provider. If you want one, for example OpenRouter for Hermes's planning, list it in `models.json` next to your local model:

```json
{
  "default": "local",
  "monthly_cap": 20,
  "endpoints": [
    {"id": "local", "url": "http://127.0.0.1:8080", "slots": 1},
    {"id": "router", "url": "https://openrouter.ai/api", "model": "anthropic/claude-sonnet", "paid": true,
     "api_key_ref": "openrouter", "cost_per_mtok_in": 3, "cost_per_mtok_out": 15, "report_cost": true, "slots": 4}
  ]
}
```

Put the key in ai-arch's secret store: `~/.local/share/ai-arch/secrets/openrouter` (mode 600). It is added only by the gateway and never reaches agents, logs or the dashboard.

Then:
- **New run → Models.** Pick a model per role. Every role defaults to your local model. A paid choice needs a **spend cap for the run** and the typed `approve`.
- **The gateway is the only way out for paid calls,** so the caps hold. Start AgentControl with `--gateway-port 8768`:
  - **OpenCode on this machine:** add a provider named `agentcontrol` to your OpenCode config, with `baseURL` `http://127.0.0.1:8768/agent/opencode/v1` and one model entry per endpoint id (`"local"`, `"router"`). AgentControl names the model in each prompt. **Container runs** get this provider automatically.
  - **Hermes:** add a provider to your Hermes `config.yaml` whose base URL is `http://127.0.0.1:8768/agent/hermes/v1`, and start AgentControl with `--hermes-provider <its name>`. AgentControl then passes `--provider <name> -m <endpoint id>` for the roles you chose. Check first with the probe that your Hermes has these flags.
- **Caps:**
  - The gateway refuses a paid call that the run did not choose.
  - When the run's cap or the monthly cap is reached, the next paid call is refused and the run pauses. On the run page you can **raise the cap** (typed `approve`) or **go back to your local model**, then Resume.
  - At most one call already in flight can go over the cap.
  - The gateway asks streams to include token counts, and uses the provider's own reported cost when it gives one (`report_cost`, OpenRouter's usage accounting). Otherwise it computes cost from the registry prices.
- **Usage** (sidebar) lists calls, tokens and spend this month or for all time, by run, agent and model. Local calls always show $0. `GET /api/usage?period=month|all` returns the same.

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
