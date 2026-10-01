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

## M7 completion report — 2026-10-01 (Codex)

### Commits and sequencing

- **Standalone Part A:** `fb8c90f68d87f596f35db16a5e5c23074073d1cc`, `Align team plans with accepted decision state`.
  S1 was tested, inspected and committed before any Workspace implementation. The preceding Part A report
  records the failing regressions against `7134ada` and its complete verification.
- **Final M7, Parts B–D:** the commit containing this report, titled `Add read-only agent Workspaces`.
  Its hash is reported separately in the owner reply and is available in the branch log.
- Started in `~/AgentControl` on `feature/chat-first-redesign`; the tree was clean before and after the
  fast-forward pull to `0878af1`. B's full verification gate passed before C began, and C's full gate passed
  before D began. No M8/M9 implementation, PR or merge was performed.

### Implementation

`#/w/<run>/<agent>` is decoded and validated, and requires a session in this project's history and an agent
recorded in that session. Turns, member rows and assigned task rows link into it; proposed-only members have
no Workspace link. Back/Escape restore the previous room route and focus. Unknown routes retain Back and the
handoff's exact error text; 401/sign-out remove all rendered Workspace material.

The existing M6 selected-session reader moved to `core` and is shared by members and Workspace. Active data
uses the established live snapshot with zero extra requests. Historical data uses one generation-guarded GET
per selection, retaining M6's status-change refresh and explicit Retry. A new regression exposed the inherited
focus guard dropping a live snapshot when Workspace opened during its read. The client now accepts that
active snapshot independently of room focus, preserving the epoch guard and adding no request. This is a
Workspace read-path fix; no server, lifecycle or engine semantics changed.

Latest follows new agent turns; selecting a turn pins it. Stages copy classic's helper semantics, symbols,
actors and screen-reader states. Prompts are escaped and bounded to 8,000 characters. The terminal copies
classic's ordered transcript/fallback but allows only text and tool entries. Tool statuses include completed;
output starts open for running/error tools. Scrolling up pauses follow, Jump resumes it, and keyed updates
preserve focus, open disclosures, pinned scroll, tool identity and file rows.

Selected-turn files are bounded to 50, with recorded partial counts and omitted count. Diffs preserve the
classic line prefixes and truncation notice. Verification uses classic wording, recorded exit codes and
collapsed output. Research logs bound summaries to 2,000 characters and sources to eight plain-text entries.
Hermes shows only its latest 40 decisions/JSON repairs and permitted parsed fields, never Hermes requests.
Surfaces show recorded metadata, filtered by agent, with one section link to the existing standalone classic
pop-out. There are no frames, tickets, images, input controls or Workspace POSTs.

Desktop uses the specified context-slot pane and keeps the room title, composer and waiting recovery link
usable at 1440 and 1200 px. Laptop uses an overlay; phone uses a full-screen sheet with the room footer hidden.
The sticky Back header covers the pane top while scrolling. Long `<pre>` lines scroll internally at 390/320 px.
Raw `/api/state` step material remains within the open agent/turn Workspace. All recorded strings are escaped;
output URLs remain text. Reasoning, unknown transcript types and `tool_results` are excluded. M3's existing
bounded public `/api/thread` turn details, M5 decisions and waiting counts remain unchanged.

### Verification gates

Commands ran from the repository; `NODE_PATH=/tmp/ac-tests/node_modules` supplies the existing test-only
dependencies. Socket/Chromium commands ran with the approved local execution permissions.

| Gate | Python, unchanged | Classic DOM | Chat DOM | Browser |
|---|---|---|---|---|
| A, before its commit | 423, OK, 3 skips, 256.079 s | 82/82 | 173/173 | 222 combinations + 6 regressions; 306 screenshots |
| B, before C | 423, OK, 3 skips, 257.249 s | 82/82 | 183/183 | 240 combinations + 6 regressions; 350 screenshots |
| C, before D | 423, OK, 3 skips, 257.483 s | 82/82 | 199/199 | 258 combinations + 6 regressions; 398 screenshots |
| Final D/M7 | 423, OK, 3 skips, 259.153 s | 82/82 | 215/215 | 276 combinations + 7 regressions; 441 screenshots |

- Python: `python3 -m unittest discover -s agent-autonomy/tests`.
- Classic: `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_ui.cjs`.
- Chat: `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_chat_ui.cjs`.
- Browser: `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/chat_screenshots.cjs /tmp/chat-shots-m7d`;
  earlier gate directories are `/tmp/chat-shots-m7a`, `/tmp/chat-shots-m7b`, `/tmp/chat-shots-m7c`.
- Logs: `/tmp/ac-m7a-python.log`, `/tmp/ac-m7b-python.log`, `/tmp/ac-m7c-python.log`, final
  `/tmp/ac-m7d-python.log`, and the corresponding `*-chat.log`, `*-classic.log`, `*-browser.log`.

The final chat suite contains **48 new M7 regressions** above the 167 accepted M6 tests. These include 9,984
stage-state combinations evaluated from classic, exact route/pop-out shapes, zero extra active reads, shared
historical reads, 401/sign-out clearing, read-only controls, keyed focus/disclosures/scroll, turn following,
all material bounds, surface filtering, source escaping and sentinel guards. All earlier M5 actionability,
server-authoritative reconciliation, network/stale decision and complete paged waiting/card tests pass.
The full Python suite includes the unchanged 51 projection and 19 HTTP tests, including both exact D7 guards.
No Python test was added or modified.

Regression proof from an isolated archive of **Part A `fb8c90f`**, with only the expanded chat tests/fixtures
copied in: B **172/183**, C **172/199**, final B–D **172/215**. All 42 post-A feature tests fail there, along
with the authorized replacement of the old turn-link assertion. Part A's existing 173-test behavior is otherwise
preserved. The live-read/focus regression also failed on the inherited guard with Workspace already implemented
(**214/215**), then passed after its correction (**215/215**). Logs are
`/tmp/ac-m7b-before-fb8c90f.log`, `/tmp/ac-m7c-before-fb8c90f.log`, `/tmp/ac-m7d-before-fb8c90f.log`,
and `/tmp/ac-m7-live-focus-before.log`.

B's first full Python run hit three unchanged specialist timeouts (423 tests, three failures, three skips):
`test_specialists.SpecialistRunTests.test_capacity_follows_the_model_slots`,
`test_specialists.SpecialistRunTests.test_declined_research_is_reported_and_not_retried`, and
`test_specialists.SpecialistRunTests.test_research_waits_for_typed_approval_and_feeds_the_coder`.
All three passed together in isolation in 2.409 s, then the full suite passed in 257.249 s. Logs:
`/tmp/ac-m7b-python-first.log` and `/tmp/ac-m7b-timing-rerun.log`. No protected code or test was changed.

The first final D Python run took 529.406 s and failed in three unchanged tests: the paid-model prompt test
below (its fixed wait elapsed before a prompt arrived), the explicit-mode wait, and permission-scope setup
(`podman image inspect agentcontrol-agent:1` timed out after 60 s). Exact tests:
- `test_paid.PaidModelTests.test_coder_prompt_names_its_model_and_the_gateway_routes_it_with_the_key`
- `test_modes.AutoRunTests.test_your_explicit_choice_is_never_overridden`
- `test_workflow.WorkflowTests.test_permission_scope_cannot_be_widened_by_api`

The first isolated cohort rerun passed mode and permission scope but still failed paid (132.396 s); the second
passed paid but failed the two workflow waits (86.207 s). Read-only `podman image exists` and formatted
`podman image inspect` probes returned successfully; no runtime configuration was changed. Preserved logs:
`/tmp/ac-m7d-python-first.log`, `/tmp/ac-m7d-isolated-rerun-first.log`,
`/tmp/ac-m7d-isolated-rerun-second.log`. A third isolated round passed paid but hit both workflow waits and
the mode fixture's existing teardown race (`Directory not empty: state`), 123.419 s;
`/tmp/ac-m7d-isolated-rerun-third.log` preserves it. Each original failing test passed in an isolated round.
The second full run failed in two other unchanged tests (423 tests, one failure, one error, three skips,
430.850 s): `test_capabilities.TeamSkillTests.test_skill_loads_are_auto_approved_only_for_the_agent_it_was_installed_for`
hit the same 60-second Podman image-inspection timeout, and
`test_workflow.WorkflowTests.test_invalid_question_answers_are_rejected` hit its fixed workflow wait.
Both passed together in isolation in 5.314 s. Logs: `/tmp/ac-m7d-python-second.log` and
`/tmp/ac-m7d-isolated-new-failures.log`.

The third full run had five unchanged timing failures (423 tests, five failures, three skips, 408.406 s):
- `test_agents.ControllerLifecycleTests.test_a_turn_records_join_work_approval_and_finish` (the documented lifecycle sampling assertion)
- `test_capabilities.SkillRunTests.test_content_changed_after_review_is_not_installed`
- `test_capabilities.SkillRunTests.test_discard_rolls_back_every_install`
- `test_capabilities.SkillRunTests.test_first_install_needs_review_then_the_same_version_is_trusted`
- `test_capabilities.SkillRunTests.test_git_skills_you_add_are_fetched_for_review_hermes_ones_wait_for_you`

The four skill failures hit their fixed eight-second prompt waits; teardown then removed a fixture before its
delayed background worker finished. All five passed together in isolation in 3.681 s. Logs:
`/tmp/ac-m7d-python-third.log` and `/tmp/ac-m7d-isolated-third-failures.log`.
The fourth full run had four failures and two teardown errors (423 tests, three skips, 343.971 s):
- `test_vm.VMRunTests.test_console_input_is_checked_and_audited`: an asynchronous VM push appended to the fake's input log before the suffix assertion
- `test_workflow.WorkflowTests.test_cannot_complete_with_failed_verifier`: fixed workflow wait
- `test_workflow.WorkflowTests.test_changed_request_cannot_be_approved_from_old_window`: fixed workflow wait, then `Directory not empty: state` in teardown
- `test_workflow.WorkflowTests.test_changed_tool_input_invalidates_displayed_permission`: the same wait and teardown race

All four passed together in isolation in 6.313 s. Logs:
`/tmp/ac-m7d-python-fourth.log` and `/tmp/ac-m7d-isolated-fourth-failures.log`.
The fifth unchanged full run passed: **423 tests, OK (skipped=3), 259.153 s**, with no other shell checks
alongside it. `/tmp/ac-m7d-python.log` preserves the successful result. Every failing test above passed in an
isolated round and in this final full run. No protected code, test, runtime setting or skip was changed.

The same three environment-gated tests are skipped (the OpenCode trio ran):
- `test_container_e2e.ContainerRunE2E.test_agent_works_in_a_locked_down_container`
- `test_preview.DesktopTests.test_desktop_preview_shows_frames_and_accepts_input`
- `test_vm_e2e.VMRunE2E.test_agent_works_in_a_kvm_clone`

### Actual render inspection

Inspected the standalone A stopping/expired images named above, plus these final renders under
`/tmp/chat-shots-m7d/`:
- `workspaceLive-desktop-light.png`, `workspaceLive-compact-desktop-light.png`, `workspaceLive-phone-light.png`, `workspaceLive-narrow-phone-dark.png`:
  native terminal, long internal output scroll, Jump, escaping and phone layout.
- `workspaceHistorical-desktop-light.png`, `workspaceHistorical-phone-dark.png`: older session, prefix diff,
  partial files, truncated preview and failed verification.
- `workspaceReviewer-phone-dark.png`, `workspaceResearcher-phone-light.png`, `workspaceHermes-phone-light.png`:
  read-only reviewer actor, bounded plain-source research and recorded reply-only Hermes log.
- `workspaceSurfaces-phone-dark.png`, `workspaceNoOutput-phone-light.png`, `workspaceNoTurns-desktop-dark.png`:
  metadata-only surfaces and explicit empty states.
- `teamStopping-phone-light.png`, `teamExpired-desktop-dark.png`, `teamRunning-desktop-dark.png`,
  `singleMembers-desktop-light.png`: never-approved proposed roster versus recorded running members.

The matrix also checks laptop, light/dark, 1200 px room usability, 40 px phone targets, no page overflow,
screen-reader-only stage state, waiting links, all prior dialogs and a browser-held live-read race.
With Workspace closed, footer measurements remain **57 px idle / 105 px waiting**, waiting row **40 px**,
and conversation at least **70.1%** of the 390 × 844 viewport. These are recorded in
`/tmp/chat-shots-m7d/footer-measurements.json`. Native OS keyboard testing remains M8.

### Real app.py check

`NODE_PATH=/tmp/ac-tests/node_modules node /tmp/ac-m7-real-check.cjs` passes against actual `app.py` and
`Controller`, workflow `FakeManager`/decisions, team `FakeTeamAPI`, and a disposable git project. The check
temporarily stops only core's existing delivery timers while counting, then probes its normal live refresh:
- Opening a running coder Workspace: **zero extra requests**.
- Fake OpenCode transcript grows to three recorded entries across the live read; that refresh sends exactly
  the established `/api/state`, `/api/channels`, `/api/thread` GETs, with no independent Workspace read.
- The finished turn renders its real git `proof.txt` diff line by line and recorded passed verification,
  exit code zero and `VERIFIED-REAL-PROOF` output, collapsed initially.
- A second active session makes the first historical; the room members panel and repeated Workspace opens
  share **exactly one** selected-session GET.
- Exact `/?popout=coder-1&run=<id>` standalone classic entry returns **HTTP 200**.
- **Zero browser/server POSTs** throughout. Fully paged waiting is zero, actionable non-outcomes zero,
  one actionable outcome and one decision card; `waiting = actions`, `cards = actions + outcomes`.

Evidence: `/tmp/ac-m7-real-check.log`, `/tmp/ac-m7-real-results.json`, disposable server helper
`/tmp/ac-m7-real-server.py`; screenshots `/tmp/ac-m7-real-live-desktop.png`,
`/tmp/ac-m7-real-finished-desktop.png`, `/tmp/ac-m7-real-historical-phone.png` (phone inspected).
Temporary check helpers and screenshots are not repository changes.

### Earlier assertions and scope

Part A rewrote **none**. The owner explicitly authorized only these two superseded Part B assertions:
1. **`M3 kinds, progressive detail, roles, receipts and unknown kinds`**: `Inspect in classic` is replaced by
   `Open workspace`, with the exact recorded turn Workspace href. All existing public prompt/file/result-tail
   assertions remain.
2. **`tokens and isolation guards`**: the classic-asset exclusion still rejects classic assets, while allowing
   the new `/chat/workspace.js` asset. Token checks and the rest of the isolation guard remain.

No other earlier assertion was rewritten or weakened. Changes are confined to §8: no Python, backend API,
schema, engine, classic UI, `decisions.js`, `composer.js` or token-file change. Before the final commit,
`git status`, `git diff --stat`, `git diff --name-only` and `git diff --check` were inspected: all 13 changed
files are permitted, with no whitespace errors. Part A was inspected separately before its commit.
`main` and `origin/main` remain at `9c20d73`. No unresolved specification question remains.

**Deferrals:** native surface viewing and keyboard/mouse/program/VM/desktop input, iframe/ticket mechanisms
need a separate handoff before M9. Native phone OS keyboard testing remains M8. M6 P1–P4 and optional M5 polish
were not implemented. The **intentionally excluded in-flight skill-fetch race** is unchanged: a fetch accepted
earlier can finish downloading after its session becomes finished; no post-fetch guard, cleanup or lifecycle
change was added. D7 still authorizes exactly its two pre-effect guards. M8/M9 and a main merge remain unstarted.

## Architecture, correctness, security and UX review — 2026-10-01 (Opus)

**Verdict: M7 accepted (Part A `fb8c90f` and Parts B–D `9b97b51`).**
- Nothing is blocking, and nothing must be fixed before M8.
- The optional polish below is folded into the M8 handoff (`docs/handoffs/M8_PHONE_AND_ACCESSIBILITY.md`).

Reviewed: `0878af1..9b97b51`. I reviewed Part A and Parts B–D separately, then their integration.

### Re-run in the review environment (at `9b97b51`)

| Suite | Result |
|---|---|
| Python, full | **423 tests, OK (skipped=6)**, 142 s. These are the same six environment gates as in the earlier reviews (3 in Codex's environment); **no Python file changed** |
| Classic DOM | **82/82** |
| Chat DOM | **215/215** |
| Browser matrix | **276 combinations + 7 regressions, 441 screenshots**. Footer measurements with the Workspace closed: **57 px idle, 105 px with the waiting row (40 px)** |

`git diff 0878af1..9b97b51` touches **no** `*.py` file, and not `decisions.js`, `composer.js`, `tokens.css` or any
classic file (`app.js`, `workspace.js`, `index.html`). D7 is unchanged.

**New tests against the code they protect:**

| Tests | Run against | Result |
|---|---|---|
| Part A | the `7134ada` chat files | **168/173**. The five failures are exactly the three stopping-helper tests and the two roster DOM tests |
| Parts B–D | the `fb8c90f` chat files, with an inert `workspace.js` stub | **173/215**. 42 Workspace tests fail. Codex measured 172 with the superseded turn-link assertion included; the one-test difference comes from the stub |

**The documented retries.** Codex needed five full Python runs to get a clean one.
- Every failure was in an unchanged backend test with fixed waits, or the Podman image-inspect timeout:
  `test_specialists`, `test_paid`, `test_modes`, `test_workflow`, `test_capabilities`, `test_vm` and `test_agents`
  (the known sampling case).
- Each passed in isolation, and the fifth full run passed. My single full run passed first time.
- These are the pre-existing timing hazards already listed in `CURRENT_STATE.md`. M7 changed no Python and no
  backend file, so they cannot be M7 regressions.
- The volume of retries is worth the owner's attention as **backend test robustness**, outside the redesign.

**Changed earlier assertions.** Part A rewrote none. Two were changed under the owner's explicit authorisation, and
both are genuinely superseded:
1. **The M3 turn link.** "Inspect in classic" became "Open workspace", with the exact recorded href. The public
   prompt, file and result-tail checks are kept.
2. **The isolation guard.** It now admits the new `/chat/workspace.js`, and still rejects every classic asset.

### Part A: verified

- **The predicate.** `teamFromRun` now treats a plan as pending only when the session is **not terminal and not
  `run.stop`**, which is M5.0's `accepts_decisions`.
  - A stopping session reads "Not decided · the session is stopping".
  - A terminal session keeps "Not decided before the session ended".
- **The roster.**
  - A never-approved roster is always under **"Proposed team · never approved"**, in the separate `proposed-members`
    list. It is never in the live list or the rail.
  - "Decide in the room" and the rail's "Team plan pending" appear only when pending.
- **Renders inspected.** `teamStopping-phone-light` shows the live Hermes, the stopping wording, then the labelled
  proposed list with no link.
- **Team-decision semantics unchanged.** The diff is two lines in `model.js` and `members.js`. The room card, the
  endpoints and the waiting count are untouched.

### Parts B–D: verified

- **Routing.**
  - `parseRoute` accepts only `#/w/<run>/<agent>` with decodable values that contain no slash or control character.
  - Back and Escape restore the previous room route and its opener. Decision and stop dialogs keep Escape priority,
    because their handlers check `defaultPrevented`.
  - **A session from another project is refused.** The server's `/api/state` opens any run by id, so the client's
    `belongsToProject` refuses it with "That session is not in this project's history."
  - An unknown agent gets the handoff's exact message.
  - Sign-out or 401 clears the Workspace and its rendered material.
- **Data and freshness.**
  - The active session uses the live snapshot, with zero extra requests. Codex's real server confirmed that only the
    established three GETs ran while the transcript grew across reads.
  - Historical sessions use the M6 reader, which moved to `core.selectedSession` and is shared by the panel and the
    Workspace: exactly one GET, no polling, refetch only when the status changes, and Retry.
  - `core.js` also drops the stale `requested === focused` guard on the live snapshot. M6 already made that read
    follow the active session, so the guard could only discard a valid read; a regression proves it.
  - Opening a Workspace calls `core.focus(id, false)`, so no refresh is triggered.
- **Records are faithful.**
  - Turns are `steps` filtered by agent (`coder-1` by default) in number order.
  - Latest follows new turns, and picking a turn pins it.
  - `stageStates`, `planningNext`, `STAGES`, `stageHead`, `TOOL_SYMBOL`, `transcriptOf`, `verificationLabel`,
    `SURFACE_LABEL` and the surface filter are copied from classic, and each copy is marked with its source.
  - The prompt is bounded to 8,000 characters.
  - Files are bounded to 50, and `partial` is shown.
  - The diff keeps its line prefixes, and the truncation notice is shown.
  - Verification shows its label, exit code and collapsed output.
  - Researchers get summaries bounded to 2,000 characters and up to 8 plain-text sources.
  - Hermes gets the newest 40 decisions and JSON repairs, with only the parsed `action`, `title` and `summary`.
    `Hermes request` is never shown. Engine check: `Hermes decision` stores `run_json`'s parsed object, and the
    repair event is a one-line notice.
- **Revisions.** The Workspace is re-rendered through M6's keyed `patch`:
  - tool entries are keyed by `id`, text entries by index, files by path, and disclosures by id
  - new entries append, and changed ones update in place
  - if the server trims the head of a transcript, index-keyed text rows update their content rather than duplicating
  - open disclosures, focus and pinned scroll survive (tested)
- **Links.**
  - Room turns link to `#/w/<session>/<refs.agent || actor>`.
  - Member rows link to their Workspace ("Open log" for Hermes). Proposed agents have no link.
  - Task rows link only when the task's agent is a live member.
  - Links from the Workspace into the room ("Go to waiting item") close the Workspace first, then use M6's locate
    path.
- **Missing or unavailable data is shown honestly:** "Loading Workspace…", the server error with Retry, "No turns
  yet.", "No output yet.", "Changes appear when the turn ends.", "No captured text changes", "Not verified yet" and
  "No surfaces for this agent."

### Privacy and security: verified

- **No reasoning.** `terminalEntries` keeps only `text` and `tool` entries, and `tool_results` is never read. The
  store itself never contains reasoning: `verify.transcript()` keeps only text and tool parts.
- **Escaping.**
  - Every recorded string reaches the DOM through `esc()` in a template that `patch` parses, and diff lines are
    escaped one by one.
  - Nothing becomes a link, and no `img`, `iframe` or input exists.
  - I checked the renders: the `<img src=x onerror=…>` payload shows as literal text in the terminal, the file list
    and the diff (`workspaceLive-desktop-light`, `workspaceHistorical-phone-dark`).
- **The sentinel tests genuinely cross the boundary.** The fixtures put these into real `state.steps` and
  `state.events`:
  - `REASONING-SENTINEL` and `UNKNOWN-SENTINEL` transcript entries
  - `TOOLRESULTS-SENTINEL`
  - another agent's transcript, prompt and surfaces
  - `HERMES-REQUEST-SENTINEL`
  - attack strings in the prompt, the output, file paths, the diff, the task, the branch and surface notes

  The tests assert:
  - none of these reach `#timeline`, `#context` or `#rail` while the Workspace is open
  - the Workspace excludes reasoning, unknown entries, `tool_results` and other agents' material
  - no `img` element is created
  - closing the Workspace empties it
- **Read-only.**
  - `workspace.js` contains no `post` call and no `[data-decision]`.
  - Surfaces are metadata plus one `target="_blank" rel="noopener noreferrer"` link to `/?popout=<agent>&run=<id>`.
  - Codex's real server recorded **zero POSTs**, and the pop-out URL returned 200.
  - Interactive preview, program, VM and desktop input remain in the classic pop-out, as decided.

### Integration: verified

- **M3:** paging, keyed rendering and deep links are unchanged. Locating a session is suspended while the Workspace
  is open.
- **M4 and M4.1:** the composer is untouched. Content stays literal. The footer is 57/105 px, and the conversation
  takes at least 70.1% of the screen.
- **M5.0 and M5:** decisions, receipts and reconciliation are untouched. Real-server invariant: waiting equals
  actionable non-outcomes, and cards equal actions plus outcomes.
- **M6:** members, the proposed/live distinction, the task graph, Connections and the rail are unchanged apart from
  the added links. The reader moved without behaviour change, and every M6 test passes.

### Rendered UI (inspected)

| Render | What it shows |
|---|---|
| `workspaceLive-desktop-light` | The room stays usable on the left with the Workspace pane on the right: stages, the terminal with "5 earlier entries were not kept", a running tool with open output, the literal attack text, internal horizontal scroll, Jump to latest, empty changes |
| `workspaceLive-phone-light` | A full-screen sheet with a sticky Back; the terminal scrolls internally |
| `workspaceHistorical-phone-dark` | Changed files including the escaped path, (partial), "Preview truncated", the prefixed diff, "Verification failed · Exit code 1", collapsed output, surfaces |
| `teamStopping-phone-light` | As described under Part A |

### Findings

**Blocking:** none.

**Should fix before M8:** none.

**Optional polish** (scheduled in the M8 handoff):

- **Q1.** At 1440 px with a Workspace open, the room column narrows to about 320 px.
  - The waiting strip wraps onto two lines, and the composer's target chip truncates ("Note → Herm…").
  - The room is still usable, but this is M8's small-screen and layout pass.
- **Q2.** The Workspace header (agent, stages) scrolls away; only Back is sticky. A compact sticky line
  ("coder-1 (API) · ● Working · Turn 2") would help on phones.
- **M6's P1–P4 and M5's O2** remain open, and are folded into M8.

### Next milestone

**M8, Phone and accessibility:** see `docs/handoffs/M8_PHONE_AND_ACCESSIBILITY.md`. I took the scope from §12
("small-screen layout pass, keyboard, contrast, rendered screenshot matrix"), plus every item earlier reviews
scheduled for M8.

- **Native phone-keyboard testing stays deferred**, as the owner instructed. M8 writes a device checklist for the
  owner instead of requiring it.
- **Persistent bots** are recorded as a long-term roadmap item (architecture §13). M8 does not touch them.

Delivery is documentation only, on `feature/chat-first-redesign`. There is no PR and no merge into `main`.
