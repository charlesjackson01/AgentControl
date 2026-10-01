# Handoff M7: Workspaces

**From:** Opus (architecture) → **To:** Codex (implementation)
**Branch:** `feature/chat-first-redesign`. Commit and push only there; **never merge into `main`**.
**Prerequisites:** M6 is **accepted** (the review is at the end of `docs/handoffs/M6_MEMBERS_AND_TEAM.md`). Start from
`7134ada` or later.
**Read first, in this order:**
1. `CURRENT_STATE.md`
2. `docs/REDESIGN_ARCHITECTURE.md` (binding; §1, §3, §5.2, §10, §11 and §12)
3. the M6 review (finding S1 and polish items P1–P4)
4. this file

**Size:** about 4 days. **Implementation order:**
1. **Part A**, its own commit first: the M6 carry-over (S1).
2. **Part B:** route, data and the workspace shell.
3. **Part C:** turns, stages and the terminal.
4. **Part D:** changes, verification, the recorded logs and surfaces.

Parts B–D may share commits, but **each part must pass the full suites before the next starts**.

---

## 1. Outcome

From the room you can open **one agent's Workspace in one session** and inspect what it actually did. It is read-only
and comes entirely from recorded state:

- the agent's **turns**, with the classic four **stages** (Plan, Prompt, Code, Verify)
- a **terminal** of the selected turn's recorded transcript, text and tool calls with their output. While the turn
  runs, it updates live from the reads the room already makes
- the turn's **changes**: changed files, the captured diff, and its verification result
- for Hermes and researchers, which have no live stream: their **recorded log**, as classic shows it
- the session's **surfaces** (preview, VM, desktop) with their state, opened through classic's standalone pop-out

A Workspace is **opened from the room and never replaces it** (architecture §1).
- It has no decision controls: waiting items link back to their room cards.
- It sends **no POST of any kind.**

**Scope decision (architect, recorded in the change log).** Architecture §12 lists surfaces in M7, with "interim: link
to classic pop-out".
- M7 delivers the **native** terminal, stages and changes, and uses the **interim link** for surfaces.
- Native surface viewing and input (the preview origin ticket, program input, VM, desktop and generic frames, and
  keyboard or mouse input) are write paths with their own security review. They need their **own handoff before M9**.
- Do not implement any surface frame, input, ticket or iframe in M7.

## 2. Hard rules

1. **No API, schema, engine, journal, adapter or classic change.**
   - M7 is client-only. It reads only `/api/state` (the live read and the M6 selected-session read), plus `/api/thread`
     for room links that already exist.
   - **No Python file changes.** If something else seems needed, stop and report it.
2. **No POSTs from a Workspace.** Stop, Pause, notes, decisions, surface start or stop, preview tickets and surface or
   VM input stay where they are: the room, the composer, or classic.
3. **The Workspace is the only chat surface that may render step material.** That means `steps[].transcript`,
   `transcript_omitted`, `activity`, `result`, `evidence` (`diff`, `diff_truncated`, `file_stats`), `verification`
   (`status`, `exit_code`, `output`) and the turn `prompt`.
   - It renders them only for the open agent and turn, and only from `/api/state`. That is the data, with the key,
     that classic's Workspace already shows.
   - The room, the Members panel and the rail keep M6's rule: no step material.
4. **Never reasoning.** `verify.transcript()` stores only `text` and `tool` parts. Still, render **only** those two
   entry types (and classic's `activity`/`result` fallback, §5.3). Drop any other entry type, including `reasoning`.
   Never render `tool_results`.
5. **Escape everything.**
   - All recorded strings reach the DOM through `textContent` or `esc()`.
   - Nothing becomes a link. A URL in the output stays text.
   - Use no `innerHTML` with recorded content unescaped.
6. **No second source of truth and no new polling.**
   - **The active session** uses the live snapshot `core` already keeps (its steps include transcripts).
   - **A historical session** uses M6's selected-session read: one GET per selection, memory-only and generation-guarded.
     **Share it; never issue a second concurrent read of the same session.**
   - Do not add a timer, a `known=` loop or a separate stream.
7. **Never colour alone; tokens only.** Stages, statuses and diff lines carry symbols or prefixes and labels.
8. **The M4 footer budgets and every earlier milestone's tests hold.** No earlier assertion may be rewritten except
   those Part A names (§3.2). List each rewrite in the completion report.
9. **Copying classic helpers is allowed, importing them is not** (architecture §5.2). For example: `transcriptOf`,
   `stageStates`, `STAGES`, `TOOL_SYMBOL`, `diffHTML` semantics, `SURFACE_LABEL`. Mark each copy with a one-line
   comment naming its source.

## 3. Part A: M6 carry-over (separate commit, first)

### 3.1 S1: the team plan respects "stopping", and the expired roster is labelled

The problem is in the M6 review, finding S1.

- **Pending.** In `model.teamFromRun`, a plan is pending only when the session **accepts decisions**: not terminal
  **and** not `run.stop`. That is M5.0's `accepts_decisions`.
- **Wording.**

  | Session | Plan in `proposing`, `proposed` or `unusable` | Summary |
  |---|---|---|
  | stopping (`run.stop` and not terminal) | not pending | "Not decided · the session is stopping" |
  | stopped or finished (terminal) | expired | "Not decided before the session ended" (unchanged) |

- **The rail** shows "Team plan pending" only when pending.
- **A never-approved roster** (state `proposed`, not pending) renders only under the heading **"Proposed team · never
  approved"**, in the existing separate `proposed-members` list. It never appears without a "proposed" label.
- "Decide in the room" appears only when pending, as today.

### 3.2 Part A tests

- **Helpers** (one case each):
  - `{status:'awaiting_approval', stop:true}` with `proposed`, `proposing` or `unusable`: not pending, the stopping
    wording
  - terminal with `proposed`: expired
- **DOM:**
  - Stopping: no "Decide in the room", no rail "Team plan pending", and the roster under "Proposed team · never
    approved".
  - Finished: the same heading. The live list never contains a proposed-only agent.
- **Rewrites.** Only assertions in the M6 tests that pin the old expired or stopping rendering may be rewritten.
  Name each one in the report.
- **Optional polish** (P1–P4), at your discretion. Each needs its own test, and must not change any other assertion:
  - P1: the verification line gets the recorded relative time
  - P2: the rail note is hidden when X = N, if no owner-approved test pins it; otherwise leave it
  - P3: "since 2d ago"
  - P4: task-id alignment

## 4. Part B: route, data and the workspace shell

### 4.1 Route and entry points

- **Route:** `#/w/<runId>/<agent>` (architecture §5.2). Both parts are URI-decoded and validated.
  - An unknown session shows "That session is not in this project's history." with **Back to room**.
  - An agent not in that session's recorded `agents` shows "No recorded agent named ‹agent› in this session." with
    **Back to room**.
  - Neither case fetches anything beyond §4.2.
- **Entry points.** All are plain links; none sends anything.
  1. **Room turn messages.** Replace the M3 "Inspect in classic" link with **"Open workspace"** →
     `#/w/<session>/<actor>`. Use the turn's recorded agent (`refs.agent`, else `actor`).
  2. **Members panel rows** (M6) gain "Open workspace" for every non-Hermes live member. Hermes gets "Open log".
     Proposed agents get none.
  3. **Task rows** (M6) gain "Workspace" for the task's agent, only when that agent is a live member.
- **Back and close.**
  - "Back to room" and Escape return to the previous room route (`#/` or `#/s/<id>`).
  - Focus goes back to the element that opened the Workspace, when it still exists; otherwise to the session's room
    block.
- **Rail and room selection.** Opening a Workspace selects its session, as `#/s/<id>` does. The M6 selected-session
  read and the context panel therefore work unchanged.

### 4.2 Data (no new reads)

- **The active session** (`channels.active_session === runId`): use `core.getState().state`, which already holds
  `run`, `agents`, `steps` (full) and `surfaces`. **Zero extra requests.**
- **Any other session:** use M6's selected-session data (`members` loader, the result of `GET
  /api/state?scope=current&run=<id>`).
  - Expose it read-only (for example `members.getState().data`), or move the loader into `core` and have both use it.
  - Every M6 test must pass unchanged.
  - **Exactly one GET per selection,** shared by the panel and the Workspace (tested).
- **Live updates** arrive through the existing refresh path (SSE notices plus polling fallback). Re-render the open
  Workspace on every snapshot change, with keyed updates (§5.4).
- **Sign-out or 401:** close the Workspace and drop its rendered material.

### 4.3 Layout

| Width | Workspace |
|---|---|
| ≥ 1200 px | a right-hand pane in the context-panel slot, widened to `min(960px, 60vw)`. The room stays visible and usable on the left; the context panel is hidden while the Workspace is open |
| 768–1199 px | an overlay over the room, with **Back to room** |
| < 768 px | a full-screen sheet, with **Back to room** in its header. The room footer is not shown under it, so the M4 budgets apply to the room only, unchanged |

- **No horizontal page scroll** at 390 px (or 320 px).
- Long lines scroll **inside** their own `<pre>` (`overflow-x: auto`), never the page.

### 4.4 Header

Each field shows only when recorded:

| Field | Source |
|---|---|
| Name | `agentLabel()` from M6 ("coder-1 (API)", "Hermes") |
| Role | `role` |
| Presence | symbol + label, from that session's `agents[]` |
| Task | `task` |
| Since | `since` |
| Branch | `run.workspace.agents[name].branch` |
| Where | classic `renderWsHead` wording: a researcher's "scratch folder · no project files"; "in container" when `run.isolation === 'container'` |
| Waiting | when the member is `waiting_on_you`: "Go to waiting item", the M6 locate path, which closes a phone sheet first |
| Classic link | "Open in classic pop-out" → `/?popout=<agent URI-encoded>&run=<runId URI-encoded>`, `target="_blank"`, `rel="noopener noreferrer"` |

## 5. Part C: turns, stages and the terminal (coders, testers and reviewers)

### 5.1 Turns

- **Source.** The agent's turns are `steps` where `(step.agent || 'coder-1') === agent`, in `number` order.
- **The turn picker** has one button per turn ("#n", `title` = the turn title) plus **Latest**, which is the default
  and follows new turns. Picking a turn pins it until you choose Latest again.
- **Researchers and Hermes** use §6.2 instead.

### 5.2 Stages

Copy classic `STAGES` and `stageStates(run, step, isLast, pending, next)`, including `planningNext(run, steps)`, exactly.

| Stage | Who | State shown |
|---|---|---|
| Plan | Hermes | ✓ done, ▶ In progress, ! Waiting on you, × Failed, ○ pending: classic `stageHead` marks and notes, each with an `sr-only` state |
| Prompt | Hermes → OpenCode | same |
| Code | OpenCode; for a reviewer "OpenCode · read-only"; in a team, "· ‹agent›" | same |
| Verify | AgentControl | same |

- `pending` is that agent's actionable request messages in the loaded room cache, the same predicate M6 uses for its
  waiting link. It is a count only, with no controls.
- **The Prompt stage** has a disclosure "Prompt sent to OpenCode", showing `step.prompt`, bounded to 8,000 characters
  with "…truncated".

### 5.3 Terminal

- **Entries** come from a copy of classic `transcriptOf(step)`:
  - `step.transcript` when it is an array
  - otherwise `activity` entries mapped to tool entries, plus `result` as a final text entry
- **Render only** `type: 'text'` and `type: 'tool'`.

| Entry | Rendering |
|---|---|
| text | a plain paragraph in the terminal (`white-space: pre-wrap`) |
| tool | one line: classic `TOOL_SYMBOL[tool]` (default `•`), the tool name (omitted for `bash`, as classic does), `summary` or `title`, and the status as a label (`running`, `completed`, `error`, …). `output`, when non-empty, goes in a `<details>` beneath. It is **collapsed by default, except** while the tool is `running` or ended in `error` |

- `transcript_omitted > 0` shows "N earlier entries were not kept" at the top.
- **Follow.**
  - While following the latest turn, keep the view scrolled to the end as entries arrive.
  - When you scroll up, show **"Jump to latest"** and stop auto-scrolling. Jumping resumes it.
  - A pinned older turn never auto-scrolls.
- **Semantics.**
  - The terminal is `role="log"` with `aria-live="off"`, so output never floods screen readers.
  - One `role="status"` line states "Turn n · ‹status label›", from classic's terminal status: active, waiting,
    failed or done.
- **Empty states:**
  - "No output yet." for a turn that is live with no entries
  - "No turns yet." for an agent with no steps

### 5.4 Keyed updates

Re-render without losing scroll, focus or open disclosures:
- Key the turn buttons by step id.
- Key terminal entries by `id` for tool entries, or by index for text entries.
- Key file rows by path.
- Append new entries; update a changed entry in place.

## 6. Part D: changes, verification, recorded logs and surfaces

### 6.1 Changes and verification (selected turn)

- **Files.** List `evidence.file_stats` as "path · change +added/−removed".
  - `partial` adds "(partial)".
  - Bound the list to 50 entries, with "…and N more".
- **Diff.** Show `evidence.diff` in a `<pre>` with classic `diffHTML` semantics: each line keeps its leading `+`, `-`
  or `@@`. Classes may tint lines, but **the prefix is the signal**.
  - `diff_truncated` shows "Preview truncated".
  - When there is no diff: "No captured text changes".
- **Verification.**
  - `verification.status` uses classic `verificationLabel` wording: "Verification passed", "Verification failed",
    "Review only" (for `not configured`) or "Not verified yet".
  - Add `exit_code` when present.
  - `output` goes in a collapsed `<details>`, server-bounded.
- **Live runs.** While a turn is live with no evidence yet: "Changes appear when the turn ends."

### 6.2 Recorded logs (Hermes and researchers)

These are copies of classic `renderWsLog`, with one tightening for Hermes.

- **Researcher.** For each of its steps:
  - the question (`question || title`) and the status label
  - `report.summary`, bounded to 2,000 characters
  - up to 8 `report.sources`, as **plain text**
  - classic's note: "The researcher runs Hermes once per approved question; its report is recorded when that call
    ends. There is no live stream."
- **Hermes.**
  - Show the newest 40 `Hermes decision` and `Hermes JSON repaired` events from that session's `events`, each as
    `action · title · summary` from the parsed JSON (else the bounded text), with its time.
  - **Do not render `Hermes request`** (the full manager prompt). It stays in classic and in Activity, consistent with
    architecture §6.4.
  - Add classic's note that Hermes runs as one call per decision.

### 6.3 Surfaces (interim, read-only)

- **Source.** The session's `surfaces` where `agents === 'all'` or the list includes this agent.
- **Each surface shows:**
  - `title`
  - its kind, through a copy of classic `SURFACE_LABEL` (an unknown kind shows the raw text)
  - its state as a label
  - `note`, as plain monospace text
- **One link for the section:** "Open in classic pop-out" (the same href as §4.4), with the hint "Live view and input
  are in the classic pop-out for now."
- **No** `<img>`, `<iframe>`, frame fetch, ticket, Start, Stop or input. When there are no surfaces: "No surfaces for
  this agent."

## 7. Tests

**Pure helpers** (exported from `workspace.js`):
- `transcriptOf` fallback order
- entry filtering (`reasoning` and unknown types dropped)
- `stageStates` against a table built from classic for every step status, live or finished, pending, and `next`
- the verification label, the file-list bound, and the surface label fallback
- the agent's turn selection and following Latest

**DOM:**
1. **Route.** A valid route opens the Workspace. An unknown session or agent shows its message and Back. Back and
   Escape restore the route and focus.
2. **Entry points.** Room turn "Open workspace", the Members panel (with no link for proposed agents), task rows, and
   no remaining "Inspect in classic" on turn messages.
3. **Data.**
   - The active session makes **zero** extra requests.
   - A historical session makes **exactly one** GET, shared with the M6 panel.
   - On 401 or sign-out, the Workspace closes and no material remains in the DOM.
4. **No POSTs** while the Workspace is open, through every button and link inside it (capture all fetches).
   **No `[data-decision]`** inside it.
5. **Terminal.**
   - text and tool rendering, output disclosures (open while running or on error), and the omitted note
   - Follow, then scroll up, then Jump to latest; a pinned turn does not move
   - live updates keep focus and open disclosures (keyed)
6. **Privacy and escaping.**
   - Fixtures include a `reasoning` entry with `REASONING-SENTINEL`, and a tool output containing
     `<img src=x onerror=alert(1)>`.
   - The sentinel never appears.
   - The markup renders as text, with no `img` element created.
   - `tool_results` with `TOOLRESULTS-SENTINEL` never appears.
   - The room, panel and rail still never show any step sentinel (M6's guard, unchanged).
7. **Stages, changes, verification, recorded logs and surfaces,** as specified, including that `Hermes request` text
   never renders, and the exact pop-out href.
8. **Guards:** tokens only, no classic assets, and every M1–M6 test passes, with only Part A's named rewrites.

**Browser matrix:** at desktop, laptop and phone, in light and dark, plus a narrow phone (320 px):
- a coder's Workspace with a live turn (a long tool output, an error tool, Jump to latest showing)
- a finished turn with a diff and a failed verification
- a reviewer's Workspace
- a researcher's log
- Hermes's log
- the surfaces list
- an unknown-agent route
- Part A's stopping and expired team plans

Assert:
- no page-level horizontal overflow; `<pre>` scrolls internally
- 40 px targets on phone
- the room's footer budgets are unchanged when the Workspace is closed
- on desktop, the room stays visible beside the Workspace

Inspect and name at least the phone and desktop live-coder images and the phone researcher log in the report.

**Real server check (required):** use `app.py` with the existing workflow and team fakes and a disposable git project.
Record:
- a coder Workspace opened during a running turn, with transcript entries growing across reads, **with no extra
  request beyond the live read**
- the finished turn's real `evidence.diff` and verification
- a historical session's Workspace using the single shared GET
- the pop-out href opening classic's standalone pop-out (an HTTP 200 for `/` with those parameters is enough)
- zero POSTs from the Workspace throughout

**Python:** no new tests; the full suite passes unchanged.

## 8. Files

| File | Change |
|---|---|
| `agent-autonomy/chat/model.js` | Part A only (S1, optional P1–P3) |
| `agent-autonomy/chat/members.js` | Part A (expired or stopping roster heading, optional P4); Part B (entry-point links; expose or share the selected-session data) |
| `agent-autonomy/chat/workspace.js` | **new**, `AC.workspace`: pure helpers plus mount and render |
| `agent-autonomy/chat/thread.js` | Part B: the turn-message "Open workspace" link replaces "Inspect in classic" |
| `agent-autonomy/chat/shell.js`, `core.js` | the route, open and close, focus return, layout state. `core.js` only if the selected-session loader moves there; no new endpoints |
| `agent-autonomy/chat/index.html`, `chat.css` | workspace region, script load (cache-busting `?v=7`), styles (tokens only) |
| `agent-autonomy/tests/fixtures.cjs`, `test_chat_ui.cjs`, `chat_screenshots.cjs` | §7 |
| `docs/REDESIGN_ARCHITECTURE.md`, `CURRENT_STATE.md`, this file | contract notes (§9), status, completion report |

**No change** to any Python file, `decisions.js`, `composer.js`, the classic UI or any backend file.

## 9. Contract updates (make them when you finish)

- **§5.2:** `workspace.js` replaces "(later) workspace.js", and §5.2 should say what it does.
- **§3 and §6 note:** "Step material (transcript, tool output, diff, verification output, prompt) renders only inside a
  Workspace, from `/api/state`, never in the room, panel or rail; reasoning is never rendered anywhere."
- **§10:** the Workspace layout by width.
- **The change log:** M7 is native for the terminal, stages, changes and logs. Surfaces use the classic pop-out link,
  and native surfaces need their own handoff before M9.

## 10. Acceptance

1. `python3 -m unittest discover -s agent-autonomy/tests` passes, unchanged; report skipped tests by name.
   - Baseline: **423, OK** (6 skipped in the review environment, 3 with OpenCode).
   - An unchanged timing-sensitive test that fails intermittently is rerun and recorded, never modified.
2. `test_ui.cjs` passes 82/82. `test_chat_ui.cjs` passes (167 existing tests plus the new ones, with only Part A's
   named rewrites). `chat_screenshots.cjs` passes, with the budgets.
3. Part A is its own commit. Its new tests fail on `7134ada` and pass after it; record both runs. Run the Part B–D
   tests against the Part A commit too, and record that they fail.
4. The diff touches only the files in §8.
5. The real server check (§7) is recorded.

## 11. When you finish

1. Append a completion report to this file:
   - the commits
   - test commands and counts (with skipped tests named)
   - the screenshots inspected
   - the real server check
   - every rewritten assertion
   - deviations and open questions
2. Update `CURRENT_STATE.md`. Push to `feature/chat-first-redesign`. No PR and no merge unless the owner asks.

Two deferrals remain out of scope and must stay recorded:
- the in-flight skill-fetch race (D7 boundary)
- native phone-keyboard testing (M8)

If this handoff conflicts with `docs/REDESIGN_ARCHITECTURE.md`, stop and record the conflict instead of choosing silently.

---

## Part A completion — 2026-10-01 (Codex)

S1 is implemented independently before any Workspace work. Team plans are pending only when their session is
not terminal and not stopping. Undecided stopping plans show “Not decided · the session is stopping”; terminal
plans retain “Not decided before the session ended”. Never-approved rosters always remain in the separate
proposed list under “Proposed team · never approved”, with no room decision link or rail pending marker.
No live member is manufactured and no backend, room action or waiting-count behavior changes. P1–P4 are deferred.

Regression proof against an isolated archive of **7134ada**: **168/173** chat tests pass. Three new stopping-helper
cases and both new roster DOM checks fail; the existing terminal predicate guard passes before and after.
After the fix, **173/173** pass. No earlier assertion was rewritten for Part A.

Verification:
- `python3 -m unittest discover -s agent-autonomy/tests`: **423, OK (skipped=3)**, 256.079 s.
- `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_ui.cjs`: **82/82**.
- `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_chat_ui.cjs`: **173/173**.
- `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/chat_screenshots.cjs /tmp/chat-shots-m7a`:
  **222 combinations + 6 regressions**, **306 screenshots**; both new plan states, desktop/laptop/phone,
  light/dark and 320 px checks. Footer, overflow, privacy and target assertions pass.

Actual renders inspected: `/tmp/chat-shots-m7a/teamStopping-phone-light.png` and
`/tmp/chat-shots-m7a/teamExpired-desktop-dark.png`. Proposed agents remain clearly labelled and separate.

Environment skips (OpenCode tests ran):
- `test_container_e2e.ContainerRunE2E.test_agent_works_in_a_locked_down_container`
- `test_preview.DesktopTests.test_desktop_preview_shows_frames_and_accepts_input`
- `test_vm_e2e.VMRunE2E.test_agent_works_in_a_kvm_clone`

The owner authorized exactly two additional earlier-test exceptions for Part B: the superseded M3
“Inspect in classic” assertion and the isolation assertion that currently also rejects `/chat/workspace.js`.
Those assertions are unchanged in Part A. They will be listed with their exact test names in the final report.
The in-flight skill-fetch race and native phone-keyboard testing remain deferred.

The standalone Part A commit contains this report and is titled `Align team plans with accepted decision state`.
Its hash will be recorded in the final M7 report. Parts B–D begin only after this verified commit.
