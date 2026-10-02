# Handoff M9: Parity and cutover

**From:** Opus (architecture) → **To:** Codex (implementation)
**Branch:** `feature/chat-first-redesign`. Commit and push only there; **never merge into `main`**.
**Prerequisites:** M8 is **accepted** (the review is at the end of `docs/handoffs/M8_PHONE_AND_ACCESSIBILITY.md`).
Start from `2741085` or later.
**Read first, in this order:**
1. `CURRENT_STATE.md`
2. `docs/REDESIGN_ARCHITECTURE.md` (binding; D3, §3, §5.1 and §12)
3. `README.md`, the "What you see" section, which is the parity source named in `docs/CHAT-FIRST-PLAN.md` §5
4. `docs/DEVICE_CHECKLIST.md`
5. this file

**Size:** Part A about 2 days. Part B about 1 day, **after the owner's sign-off**.

## 0. Two parts with an owner gate between them

| Part | What | May start |
|---|---|---|
| **0** | The M8 carry-over (N1 below): the rail disclosure for X > N. **Its own commit, first** | now |
| **A** | Parity audit: `docs/PARITY_CHECKLIST.md` with evidence, plus a chat-only real-server walkthrough. **No product code changes.** | now |
| **B** | Cutover: `/` serves the chat UI, `/classic` the classic UI | **only after** the owner records gates G1–G3 (§4) in `CURRENT_STATE.md` |

**After Part 0 and Part A, stop and report.** Do not begin Part B on your own judgement, even if Part A finds no gaps.

## 1. Outcome

- **Part A** gives the owner a truthful, evidenced picture of what the chat UI does natively, what it reaches through
  `/classic`, and what it intentionally leaves out.
- **Part B** makes the chat UI the default at `/`. The classic UI stays fully working at `/classic`.
  - **Retiring classic is a separate, later decision** (`docs/CHAT-FIRST-PLAN.md` §5). It is not part of M9.

## 2. Hard rules

1. **Part A changes no product code** (Part 0 is the only code change before the gates): no Python, chat, classic or test changes. Its only outputs are
   `docs/PARITY_CHECKLIST.md`, the report and the status documents.
2. **Part B is routing and links only.**
   - D3 authorises exactly the route swap.
   - The only server change is the `do_GET` entry routing in `app.py` (§5.1).
   - There is no API, schema, engine, journal, adapter or permission change, no change to the classic UI's code, and
     no change to the preview origin, SSE or auth.
3. **Every accepted M1–M8 contract holds:**
   - server authority, the M5.0 invariant, the decision bodies and the write lock
   - the proposed/live roster distinction
   - Workspace read-only and privacy boundaries
   - the footer budgets and the M8 accessibility and contrast results
   - the request pattern
4. **Classic keeps working** (invariant 9). Its suites stay green.
5. **Out of scope:**
   - native surfaces, unless G2 chooses "before cutover"; in that case a separate surfaces handoff runs first, and
     M9 Part B waits for it
   - retiring classic
   - R1 persistent bots (architecture §12.1)
   - the in-flight skill-fetch race (the D7 boundary)
   - backend test robustness
   - any new feature

## 2a. Part 0: M8 carry-over (separate commit, before Part A)

**N1 (M8 review): the rail disclosure for X > N.**

- **The problem.** `model.railSessions` shows the note whenever X ≠ N. When the rail lists **more** sessions than the
  server's total, it renders a false "Showing 2 of 1 session". This happens when a cached thread session is no longer
  in `channel_runs`, for example another project's session that has since finished. It also shows in the M8 matrix's
  `*-text-zoom` renders, whose fixture has 2 runs and a total of 1.
- **The owner-approved behaviour (2026-10-01):**
  - shown **only while history is incomplete (X < N)**
  - hidden otherwise, which **includes X > N**
- **The fix.** Change the condition to `sessions.length < total`. Make no other change to the counts, the union,
  paging or the data sources.
- **Tests.**
  - Add a regression for X > N (no disclosure) that fails on `2741085`.
  - Keep the X = N and X < N assertions unchanged.
  - Re-run the full suites, and inspect one `text-zoom` render.
- **Scope: approved by the owner, 2026-10-02, as M9 Part 0.** When X > N, hide the disclosure. Do not change the underlying counts, the union, pagination or the data sources. No other file or assertion changes.

## 3. Part A: parity audit (docs and evidence only)

### 3.1 `docs/PARITY_CHECKLIST.md`

**Rows.** One row for each of:
1. **every bullet** of README "What you see" (15 bullets)
2. **every classic view:** Mission, Workspace, Runs, Approvals, Activity, New run, Project, Skills and Usage; plus
   Settings, Switch project and the classic keyboard shortcuts (for example `t` for a full-screen terminal)
3. **every capability M5 §2.7 left in classic:**
   - rule revocation
   - paid models
   - the stuck watch
   - internet during work
   - skill removal or rollback
   - proposing skills from the library
   - preview, container and VM controls
4. **interactive surfaces** (preview frame and ticket, program input, VM, desktop and generic frames, input)

**Columns:**

| Column | What it holds |
|---|---|
| Classic location | where it lives in classic |
| Chat location | where it lives in chat, as a route or element |
| Status | exactly one of: **Native** · **Linked to classic** (states the exact link: "More → Usage", "Open in classic pop-out", "Open classic dashboard") · **Intentionally not ported** (cites the decision: D4 themes, and so on) · **Missing** |
| Evidence | for Native, a passing test name **and** a screenshot or real-server step; for Linked, the link's test |
| Notes | anything else |

**Honesty rules:**
- Never mark a row Native because a classic link exists.
- Never mark a row Native from emulation alone, where the owner's device checklist covers it.
- A row whose behaviour differs from classic must say how. For example: approvals appear once in the room rather than
  as a banner; Workspace surfaces are metadata only, with a pop-out link.

**A summary at the top:**
- counts by status
- the **Missing** list
- the **Linked to classic** list, which is what the owner accepts as reachable through `/classic` after cutover

### 3.2 Chat-only real-server walkthrough

Use `app.py` with the existing fakes and a disposable git project, through `/chat` only. Run, and record the requests
and results of:
1. start a session
2. approve a critical permission with the typed confirm
3. answer a question
4. a team proposal: approve
5. watch a coder's Workspace grow
6. Verify now
7. Apply
8. a follow-up session via "Reply in session"

**Throughout:**
- zero classic page loads, except where a row is "Linked"
- the M5.0 invariant holds at each step
- record the GET and POST counts per step

Every Native row in §3.1 that this walkthrough exercises cites its step.

### 3.3 Cutover-readiness findings (document only)

List every place that assumes `/` serves classic:
- **Known:** `chat/workspace.js` builds the pop-out link as `/?popout=…&run=…`. After the swap this would open the
  chat UI.
- Classic's own pop-out uses `location.pathname`, so it keeps working at `/classic`. Confirm by inspection.
- Search `chat/*`, the classic files, `README.md`, `agent-autonomy/README.md` and the tests for further cases, and list
  each one with its file and line.

### 3.4 Part A report, then stop

Append the Part A report to this file:
- the checklist summary
- the walkthrough table
- the readiness findings
- the suites, re-run to show nothing changed after Part 0: Python 423, classic 82/82, chat 240/240 (239 plus Part 0's regression), browser matrix green

Update `CURRENT_STATE.md` to "M9 Part A complete; awaiting owner gates G1–G3". Push, and **stop.**

## 4. Owner gates (recorded by the owner, not by Codex)

| Gate | Decision | Where it is recorded |
|---|---|---|
| **G1** | Parity sign-off: the owner accepts the checklist, including every Linked to classic and Missing row, as sufficient for the chat UI to become the default at `/` | `CURRENT_STATE.md` and this file |
| **G2** | Interactive surfaces: **(a)** cut over with surfaces reached through the classic pop-out (Opus's recommendation: classic stays at `/classic`, and the link opens a standalone pop-out), or **(b)** write and complete a native-surfaces handoff first | the same |
| **G3** | **Cleared by the owner, 2026-10-02:** "G3 cleared — iPhone 17 Pro / Safari passed; I accept Android Chrome as not performed." Android Chrome is an accepted, untested gap |

If any gate is refused, Opus writes the corrective handoff. Part B does not start.

**Gate status (updated 2026-10-02, recorded from the owner):**

| Gate | Status |
|---|---|
| **G1** | **Cleared by the owner, 2026-10-02.** The owner accepts Part A's checklist (`1025518`): the 17 native features, the 54 classic-linked features and the one intentionally unported feature (themes, D4). Classic stays accessible at `/classic` for everything not yet in the new interface. The owner also approved keeping C1, so existing and bookmarked classic pop-outs keep working |
| **G2** | **Approved: (a).** Switch to chat first, and keep classic pop-outs for interactive surfaces. Native surfaces come later, under their own handoff |
| **G3** | **Cleared by the owner, 2026-10-02.** iPhone 17 Pro / Safari passed; Android Chrome accepted as not performed. Exact owner decision is appended below |

**Part B was blocked until the owner explicitly recorded G3 as cleared; that happened on 2026-10-02 (see the
appended owner decision). All three gates are now settled and Part B is authorised within §5–§7.**

## 5. Part B: cutover (only after G1–G3)

### 5.1 Routing (`app.py`, `do_GET` only)

| Path | Serves |
|---|---|
| `/` | the chat UI's `index.html` |
| `/chat`, `/chat/` | the chat UI (kept as aliases, so existing bookmarks work) |
| `/classic`, `/classic/` | the classic `index.html`. The trailing slash fixes M1 polish item 5, which today returns 401 JSON |
| `/` **with a `popout` query parameter** | the classic `index.html` (**compatibility rule, added by the M9 Part A review**). A classic tab or pop-out window opened at `/` before the cutover builds pop-out URLs from `location.pathname`, so it opens `/?popout=…&run=…`. Bookmarked pop-outs use the same form. Both must keep reaching classic's pop-out view rather than the chat room |
| `/chat/*.css`, `/chat/*.js` | unchanged (the same allow-list) |
| classic assets (`/app.js`, `/app.css`, `/themes.css`, `/workspace.js`, `/workspace.css`) | unchanged, at their root paths |
| `/api/*`, SSE, auth, the preview origin and the security headers | unchanged |

### 5.2 Links

- `chat/workspace.js`: the pop-out href becomes `/classic?popout=<agent>&run=<run>`. Encode it exactly as today.
- Fix any further case §3.3 found in chat files. **Do not change classic code.** If classic itself needs a change to
  work at `/classic`, stop and report.
- Chat links to `/classic` are unchanged.

### 5.3 Docs

- `README.md`: "Start" and "What you see" describe the chat UI at `/`, and the classic dashboard at `/classic` with
  what it still covers (the Linked rows).
- `agent-autonomy/README.md`: the same, where it names URLs.
- Architecture §5.1 (routes) and the change log.

### 5.4 Tests

- **The compatibility rule.** `/?popout=coder-1&run=<id>` returns the classic HTML, and plain `/` returns the chat HTML. The
  route test asserts both.

- **Python.** Update `tests/test_chat_routes.py` route expectations, the only Python test change authorised:
  - `/` returns the chat HTML
  - `/chat` and `/chat/` are aliases
  - `/classic` and `/classic/` return the classic HTML
  - the asset allow-lists and the security headers are unchanged
  - unauthenticated `/api/*` is still 401

  Every other Python test passes unchanged.
- **Classic** `test_ui.cjs` is 82/82, unchanged.
- **Chat DOM.** Only the pop-out href assertions change, to the exact new href. Name each one.
- **Browser:**
  - a smoke test that loads `/` (chat signs in and renders the room) and `/classic` (classic renders)
  - the pop-out link opening `/classic?popout=…` with HTTP 200 and classic's pop-out view
  - the full M8 matrix still green
- **Real server:** repeat §3.2's walkthrough at `/`, plus a classic smoke at `/classic` with the same stored key
  (the shared-key semantics).

## 6. Files

| Part | Files |
|---|---|
| 0 | `agent-autonomy/chat/model.js` (the one condition), `agent-autonomy/tests/test_chat_ui.cjs` (the new regression), this file, `CURRENT_STATE.md` |
| A | `docs/PARITY_CHECKLIST.md` (**new**), this file, `CURRENT_STATE.md` |
| B | `agent-autonomy/app.py` (§5.1 `do_GET` entry routing only), `agent-autonomy/chat/workspace.js` (the href), any chat file §3.3 identifies (links only), `agent-autonomy/tests/test_chat_routes.py`, `test_chat_ui.cjs` (the href assertions), `chat_screenshots.cjs` (the smoke), `README.md`, `agent-autonomy/README.md`, `docs/REDESIGN_ARCHITECTURE.md`, `docs/PARITY_CHECKLIST.md` (status after cutover), this file, `CURRENT_STATE.md` |

## 7. Acceptance

**Part 0:** the new regression fails on `2741085` and passes after the fix. The suites pass, with no other assertion
changed.

**Part A:**
1. The checklist covers every §3.1 row with honest status and evidence.
2. The walkthrough is recorded.
3. The readiness findings are listed.
4. No product file changed (`git diff --name-only` shows docs only).
5. The suites pass unchanged.

**Part B:**
1. The diff is limited to §6 B.
2. Python is 423, with only `test_chat_routes` expectations changed. Classic is 82/82. Chat passes, with only the href
   assertions changed. The browser matrix and smoke pass.
3. The real-server walkthrough at `/` and the classic smoke at `/classic` are recorded.
4. `main` is untouched. Merging to `main` remains the owner's separate decision.

## 8. When you finish each part

Append its report to this file, update `CURRENT_STATE.md`, and push to `feature/chat-first-redesign`. No PR and no
merge unless the owner asks.

If this handoff conflicts with `docs/REDESIGN_ARCHITECTURE.md`, stop and record the conflict instead of choosing silently.

---

## Earlier Part 0 progress (superseded by the completion report below)

Started from a clean `feature/chat-first-redesign` at `2741085`, pulled to `c6f12db`.
The one-condition N1 fix and its new DOM regression are prepared. No commit or push has been made.
Part A's independent source inventory has been read; its checklist and real-server walkthrough have not begun,
and Part B has not begun.

**Binding-specification conflict:** §2a's “No other file or assertion changes” conflicts with the existing
`M3.1 rail counts use the M6 session union and current count wording` test, which explicitly requires
“Showing 3 of 2 sessions” at `agent-autonomy/tests/test_chat_ui.cjs:320`. An asynchronous owner question requests
permission to replace only this superseded X > N assertion with absence. All X = N, X < N, union/count and paging
assertions are to stay unchanged. The assertion remains unchanged until the owner replies.

| Check | Current result / evidence |
|---|---|
| Baseline N1 proof | 239/240; only the new regression fails, `true !== false` for disclosure presence. Product files match `2741085`. `/tmp/ac-m9-0-before.log` |
| Fixed chat | New N1 regression passes; 239/240 because the older contradictory X > N assertion now fails. `/tmp/ac-m9-0-chat.log` |
| Classic | 82/82. `/tmp/ac-m9-0-classic.log` |
| Browser | 672 combinations + 51 regressions pass, 1,139 screenshots. `/tmp/ac-m9-0-browser.log`; `/tmp/chat-shots-m9-0/`. Inspected `composerBasic-text-zoom-dark.png` |
| Python first full run | 423 tests, 2 failures, skipped=3, 429.412 s. `/tmp/ac-m9-0-python-attempt1.log` |
| Combined isolation | Both failed in 5.392 s. `/tmp/ac-m9-0-python-isolated.log` |
| Individual lifecycle | Passed in 3.382 s. `/tmp/ac-m9-0-lifecycle-isolated2.log` |
| Individual VM console | Failed in 2.544 s: asynchronous push interleaved with the expected console tail. `/tmp/ac-m9-0-vm-isolated2.log` |
| Python second full run | 423 tests, same 2 failures, skipped=3, 416.287 s. `/tmp/ac-m9-0-python.log` |

The exact protected failures are
`test_agents.ControllerLifecycleTests.test_a_turn_records_join_work_approval_and_finish`
(`idle → finished` sampled instead of `working → finished`) and
`test_vm.VMRunTests.test_console_input_is_checked_and_audited` (background script/push interleaves with
click/type/key). These are documented pre-existing races, not changed in M9. The unchanged environment skips are
`test_container_e2e.ContainerRunE2E.test_agent_works_in_a_locked_down_container`,
`test_preview.DesktopTests.test_desktop_preview_shows_frames_and_accepts_input`, and
`test_vm_e2e.VMRunE2E.test_agent_works_in_a_kvm_clone`.

`git diff --check` passes. The only changed files are the two permitted Part 0 code/test files, this handoff and
`CURRENT_STATE.md`. Backend, classic, routes, approval/privacy/D7 contracts and gates are unchanged. The in-flight
skill-fetch race and persistent bots R1 remain excluded.

## Part 0 completion report — 2026-10-02

**N1 complete.** `model.railSessions` now shows the disclosure only when `sessions.length < total`.
No union, count, pagination or data-source code changed. No backend, classic, route, approval, privacy or D7
semantics changed. Part A begins only after this standalone Part 0 commit; Part B remains unstarted.

The new regression is
`M9 N1 cached sessions exceeding the server total do not show an incomplete-history disclosure`.
It verifies two unchanged rail entries with server total one, no disclosure, unchanged history cursor and
no paging control or POST. With product files byte-identical to `2741085`, it fails on disclosure presence
(`true !== false`; 239/240). After the fix it passes.

### Exact owner-authorized earlier-test exception

The owner approved this single exception to §2a on 2026-10-02, after the contradictory older assertion was
reported. In `M3.1 rail counts use the M6 session union and current count wording`, only the `total === 2`
(X = 3 > N = 2) branch changed:

Original:

```js
else assert.equal(h.document.querySelector('#session-list + .muted').textContent,'Showing 3 of '+total+' sessions');
```

Replacement:

```js
else assert.equal(!!h.document.querySelector('#session-list + .muted'),false);
```

Its X = N and X < N assertions, rail entries, totals and refreshes remain unchanged. The existing M6/M8 paging
and server-count assertions remain unchanged. No other earlier assertion was modified.

### Verification

| Suite | Result | Evidence |
|---|---|---|
| Baseline regression proof | 239/240, only new N1 regression fails | `/tmp/ac-m9-0-before.log` |
| Final chat DOM | **240/240** | `/tmp/ac-m9-0-chat-approved.log` |
| Final classic DOM | **82/82** | `/tmp/ac-m9-0-classic-approved.log` |
| Browser matrix | **672 combinations + 51 regressions**, 1,139 screenshots | `/tmp/ac-m9-0-browser.log`, `/tmp/chat-shots-m9-0/` |
| Final Python | **423 tests, OK (skipped=3), 258.358 s** | `/tmp/ac-m9-0-python-final.log` |

Commands are the unchanged full Python discovery, `test_ui.cjs`, `test_chat_ui.cjs`, and
`chat_screenshots.cjs /tmp/chat-shots-m9-0` with `NODE_PATH=/tmp/ac-tests/node_modules` for Node.
Actual text-zoom renders inspected: `teamProposed-text-zoom-light.png`,
`workspaceLive-text-zoom-light.png`, and `composerBasic-text-zoom-dark.png`.

### Python timing-failure comparison

The first two full runs failed the same two protected tests (423 tests, failures=2, skipped=3):
429.412 s in `/tmp/ac-m9-0-python-attempt1.log`, then 416.287 s in
`/tmp/ac-m9-0-python-attempt2.log`.

- `test_agents.ControllerLifecycleTests.test_a_turn_records_join_work_approval_and_finish`: sampled
  `('coder-1', 'idle', 'finished')` instead of `('coder-1', 'working', 'finished')`. This is the same
  0.5-second sampling race documented in `CURRENT_STATE.md`, reproduced on pre-redesign `af4da89`, and recorded
  in the M7 final and M8 Part E reports.
- `test_vm.VMRunTests.test_console_input_is_checked_and_audited`: a background `script` or `push` interleaved
  with the expected last three `click`, `type`, `key` log entries. This matches the asynchronous VM push failure
  in M7's fourth full run and M8 Part B's first full run (their appended reports).

Combined isolation initially repeated both (5.392 s, `/tmp/ac-m9-0-python-isolated.log`). Individual lifecycle
passed (3.382 s, `/tmp/ac-m9-0-lifecycle-isolated2.log`); individual VM repeated its push/log race
(2.544 s, `/tmp/ac-m9-0-vm-isolated2.log`). The next combined isolation passed both in **6.941 s**
(`/tmp/ac-m9-0-python-isolated3.log`), followed by the passing full run above, run without other suites alongside.
Every result is reported; no protected code, wait, runtime configuration or skip was changed.

The three unchanged skips are:
`test_container_e2e.ContainerRunE2E.test_agent_works_in_a_locked_down_container`,
`test_preview.DesktopTests.test_desktop_preview_shows_frames_and_accepts_input`, and
`test_vm_e2e.VMRunE2E.test_agent_works_in_a_kvm_clone`. The OpenCode trio ran and passed.

Before commit, inspected status, diff stat, file names and whitespace. Exactly the four Part 0 scope files
changed: `chat/model.js`, `tests/test_chat_ui.cjs`, this handoff and `CURRENT_STATE.md`.
The in-flight skill-fetch race and R1 remain excluded. Owner gates are unchanged: G2 choice (a) recorded;
G1 and G3 pending.

## Part A completion report — 2026-10-02

**M9 Part A complete; awaiting owner gates G1–G3.** G2 choice (a) is already recorded; G1 and G3 remain pending.
Part 0 was completed, verified, committed and pushed separately as **`568534e`** before Part A began.
This Part A commit changes only `docs/PARITY_CHECKLIST.md`, this handoff and `CURRENT_STATE.md`.
Part B, the route cutover, native surfaces, classic retirement and any merge into `main` remain unstarted.

### Checklist summary

[The complete parity checklist](../PARITY_CHECKLIST.md) contains **72 feature/view/facet rows**:
**17 Native · 54 Linked to classic · 1 Intentionally not ported · 0 Missing**.
It covers every one of the 15 README bullets, every required classic view (12 rows including Settings,
Switch project and keyboard shortcuts), all M5 §2.7 functionality, six interactive-surface facets,
18 additional classic-only actions and 11 explicit native subsets.

The README rows classify six core features Native, eight full features Linked, and themes intentionally not
ported under D4. Composite/classic-view rows identify their native subsets separately. Each Native row has
an exact freshly passing test plus actual screenshot or real-server-step evidence. Each Linked row cites its
link test. The summary lists all 54 Linked rows and states how to reach them.

**Missing list: empty with the documented fallbacks.** This is not full native parity and does not clear G1.
All six More labels open the same `/classic` entry, without selecting a view. Users must then choose the classic
view. Paid models/watch/internet have explicit Settings fallback links. Workspace uses the existing standalone
classic root pop-out today; no native frames, tickets or input are implied. Physical-device behavior is not
claimed Native from emulation.

### Chat-only walkthrough

Real `app.py` handler/controller, existing test fakes, one disposable git project, one browser page and server.
S1 is a UI-created single-agent session for the critical permission and question. W4 finishes S1 using the
existing fake and starts/approves a Team session S2 through chat; W5–W7 use S2. W8 creates its follow-up S3.
All session creation and decisions use the real UI and existing endpoints, with no direct journal seeding.
Apply touches only the disposable project's base branch; AgentControl's `main` remains untouched.

GET counts are actual server observations, checked against browser API fetches. Initial boot and separate
Auto-preview evidence are outside the eight steps. The harness stops recurring browser reads after live boot
and calls the existing refresh cycle after the fake records its update, keeping counts reproducible without
any product refresh modification. The checklist contains every GET path/count and exact recorded POST shape.

| Step | Requests: GET total (API) / POST | Recorded result and complete-thread invariant `(waiting, actions excluding outcomes, outcomes, cards)` |
|---|---|---|
| W1 Start session | **8 (8) / 1** | Real `/api/runs`; R3 request recorded; `(1,1,0,1)` |
| W2 Critical approval | **3 (3) / 1** | Blank word sends no POST; typed displayed `approve`, Cancel initially focused; journal confirmed receipt; `(0,0,0,0)` |
| W3 Question | **6 (6) / 1** | JSON answer confirmed by server; pending `(1,1,0,1)` → recorded `(0,0,0,0)` |
| W4 Team proposal | **21 (20) / 2** | Extra `/api/runs`, then `/api/control approve_team`; coder-2 absent from live roster before approval, recorded after; pending `(1,1,1,2)` → recorded `(0,0,1,1)` |
| W5 Growing coder Workspace | **8 (6) / 0** | Two ordinary refreshes grow recorded transcript. Opening adds **0 GET / 0 POST**; escaped tool output stays in Workspace, reasoning absent; `(0,0,1,1)` |
| W6 Verify now | **10 (10) / 1** | Recorded outcome status/time shows passed; journal/manual verification agrees; `(0,0,1,1)` |
| W7 Apply | **3 (3) / 1** | Confirmation, Cancel focus; recorded applied workspace and API/UI/wire files in disposable base checkout; `(0,0,1,1)` |
| W8 Reply in session | **8 (8) / 1** | Recorded S3 `parent_run=S2` and inherited Team settings; new proposal waiting; `(1,1,1,2)` |

**8/8 passed; 67 GET (64 API), 8 POST; zero classic document loads, zero page errors.**
The other three GETs are `/favicon.ico` (one W4, two W5). Every before/after checkpoint and pending question/team
checkpoint has `before=null`, `waiting=actionable non-outcome messages`, and `cards=waiting+0/1 outcome`.
The existing newest terminal outcome can coexist with an active session; the walkthrough preserves it.
No browser-manufactured receipt, waiting-count change or verification success is used as evidence.

Additional real-server checks passed:
- **E1 Auto explanation:** 2 GET / 1 POST using existing mode preview; actual explanation screenshot.
- **L1 More links:** all six label/href pairs are exactly `/classic`.
- **L2 Settings links:** both fallback anchors are exactly `/classic`.

Evidence: `/tmp/ac-m9-real-check.log`, `/tmp/ac-m9-real-results.json`, temporary scripts
`/tmp/ac-m9-real-server.py` and `/tmp/ac-m9-real-check.cjs` (outside git). Screenshot evidence includes
`/tmp/ac-m9-critical-dialog.png`, `/tmp/ac-m9-auto-preview.png`, `/tmp/ac-m9-proposed-team.png`,
`/tmp/ac-m9-live-workspace-desktop.png`, `/tmp/ac-m9-live-workspace-phone.png` and `/tmp/ac-m9-apply-dialog.png`.
Raw tool output and reasoning sentinel checks distinguish Workspace-only material from the accepted bounded
M3 public `result_tail`, whose existing projection remains unchanged.

### Readiness findings

The complete source/line inventory is in the checklist's **Cutover-readiness findings** section.
The only identified chat product href needing the later routing swap is `chat/workspace.js:5`, used by its
header at `:23` and surface section at `:101`: `/?popout=…&run=…`. Classic's own `workspace.js:337` uses
`location.pathname`, so it retains `/classic` without a classic-code edit.

The search also found these root/classic assumptions, all unchanged:
- Current entry routing: `app.py:74–77`.
- Exact chat pop-out assertions: `tests/test_chat_ui.cjs:1049,1185`.
- Root/classic route expectations: `tests/test_chat_routes.py:33–36`.
- Classic-only mock pathname/pop-out: `tests/test_ui.cjs:28,1303`.
- Classic mock root entry/navigation: `tests/screenshots.cjs:276,282`.
- Printed address/classic feature descriptions: `README.md:24,35–79`.
- Root address and classic-start tutorial: `agent-autonomy/README.md:12–20,44–51`.
- Further classic UI descriptions: project switching `:90`, Mission/default phone tabs `:119,132`, Workspace
  tabs/shortcuts/splits/surfaces/windows/pop-outs `:136,155,165,172,190,203`, Approvals `:224`, themes/keys `:365`,
  skill library/git/removal `:455,472`, model usage `:642`, paid selectors/caps/Usage `:711,717,720`, watch `:732`,
  Project preview `:768` and named follow-up control `:791`.

Root-relative assets/API/SSE and the separate preview-origin ticket URLs are intentional and remain unchanged.
Part B owns routing/href/README corrections; this report implements none of them.

### Fresh final verification

| Suite / check | Result | Evidence |
|---|---|---|
| Full Python | **423, OK (skipped=3), 319.958 s**, first Part A attempt | `/tmp/ac-m9-a-python.log` |
| Classic DOM | **82/82** unchanged | `/tmp/ac-m9-a-classic.log` |
| Chat DOM | **240/240** unchanged after Part 0 | `/tmp/ac-m9-a-chat.log` |
| Full browser matrix | **672 combinations + 51 regressions**, **1,139 screenshots** | `/tmp/ac-m9-a-browser.log`, `/tmp/chat-shots-m9-a/` |
| Real-server walkthrough | **8/8**, plus E1/L1/L2 | `/tmp/ac-m9-real-check.log`, `/tmp/ac-m9-real-results.json` |
| Checklist consistency | **72 classified rows**, 15 README, 12 views; exact tests and real screenshot paths resolved | read-only temporary check |

Commands: `python3 -m unittest discover -s agent-autonomy/tests`; with
`NODE_PATH=/tmp/ac-tests/node_modules`, `node agent-autonomy/tests/test_ui.cjs`,
`node agent-autonomy/tests/test_chat_ui.cjs`,
`node agent-autonomy/tests/chat_screenshots.cjs /tmp/chat-shots-m9-a`, and
`node /tmp/ac-m9-real-check.cjs`. Socket/Chromium checks used the approved execution permissions.
No runtime setting, protected test or skip changed.

The three unchanged skips are `test_container_e2e.ContainerRunE2E.test_agent_works_in_a_locked_down_container`,
`test_preview.DesktopTests.test_desktop_preview_shows_frames_and_accepts_input`, and
`test_vm_e2e.VMRunE2E.test_agent_works_in_a_kvm_clone`. The OpenCode trio ran and passed.
Part A had no Python failures. Part 0's two failed full attempts, exact lifecycle/VM races, comparison to
established M7/M8 flakiness, isolated results and final passing 423-test run are preserved in its report above.

Fresh matrix footer measurements: **57 px idle / 105 px waiting**, portrait conversation minimum **70.0829%**,
landscape **58.3333%**. **1,624** accessibility audits have zero findings; **52** contrast pairs pass;
**32** keyboard workflows and **4** reduced-motion/forced-colors cases pass. Actual desktop/phone live Workspace,
critical review, proposed team, Apply, Auto, historical diff/failed verification and researcher-log renders
were inspected. Browser emulation does not fill the physical-device checklist.

### Scope, exceptions and stop

Before commit, inspected status, diff stat, names and whitespace. The Part A diff is **exactly three docs**:
`docs/PARITY_CHECKLIST.md`, this handoff and `CURRENT_STATE.md`. No product, Python, classic, test, schema,
engine or API file changes. D7 and all accepted M1–M8 contracts remain intact.

The only earlier assertion replacement is the separately committed, explicitly owner-approved Part 0 M3.1
X > N exception; its original and replacement are reproduced in the Part 0 completion report. No Part A test
assertion was changed or weakened.

**Stopped after Part A.** G1 parity and G3 physical-device checklist remain owner decisions; G2 choice (a) is
already recorded. Interactive surfaces remain in classic and require a later native-surfaces handoff.
The in-flight skill-fetch race stays intentionally excluded, and persistent bots remain future R1.
Classic retirement, route cutover and merging into `main` have not been performed.

## Review of Part 0 and Part A — 2026-10-02 (Opus)

**Verdict: Part 0 (`568534e`) and Part A (`1025518`) accepted.**
- Nothing is blocking.
- One **should-fix is a Part B specification amendment** (C1, already written into §5.1 and §5.4). It does not change
  Part A.
- **G1 can now be decided by the owner.** G3 remains pending.

### Re-run in the review environment (at `1025518`)

| Suite | Result |
|---|---|
| Python, full | **423, OK (skipped=6)**, 132 s, **first attempt, no failures** |
| Classic DOM | **82/82** |
| Chat DOM | **240/240** |
| Browser matrix | **672 combinations + 51 regressions, 1,139 screenshots**. Inspected `active-text-zoom-light`: both sessions are listed and the false "Showing 2 of 1 session" is gone |

**The Part A diff is documentation only:** `docs/PARITY_CHECKLIST.md`, this file and `CURRENT_STATE.md`. No product,
test, Python or classic file changed.

### Part 0 (N1): verified

- **The fix.** The product change is exactly one condition in `model.railSessions`, from `sessions.length!==total` to
  `sessions.length<total`. The union, the counts, pagination and the data sources are untouched.
- **The new regression.** `M9 N1 cached sessions exceeding the server total…` covers two listed sessions with a server
  total of one. It asserts:
  - the server count is still 1
  - the cursor is still null
  - there is no disclosure and no paging control
  - there are no POSTs

  Codex shows it failing on `2741085` (239/240).
- **The test exception was followed exactly.** Only the `total === 2` branch (X = 3 > N = 2) of the M3.1 rail test
  changed, from the old false "Showing 3 of 2 sessions" to absence. The owner approved it on 2026-10-02. In the same
  test, the X < N assertions ("Showing 31 of 47", "Showing 3 of 47") and the X = N branch are byte-identical. The M6
  and M8 paging and count tests are unchanged.

### Part A (parity checklist): verified

- **Classification.** All **72** rows parse to one status each: **17 Native, 54 Linked to classic, 1 Intentionally not
  ported, 0 Missing**. That covers 15 README rows, 12 views, 10 M5 §2.7 capabilities, 6 surface facets, 18 further
  classic-only actions and 11 native subsets.
- **The classifications are accurate, and conservative where they should be:**
  - R02 (live terminal) and R12 (Mission control) are **Linked**, not Native. Classic's `t` full-screen, Copy, token
    cards and model queue have no chat equivalent, even though a native subset exists (N01, N07).
  - The Native README rows (R01, R03, R05, R06, R07 and R10) match what M3–M8 actually delivered and accepted.
    R03 states its difference from classic: a room card instead of banners. Audit browsing (C01) and oversized review
    (C02) are split out as Linked.
  - R15 Themes is "Intentionally not ported" under D4.
  - "Missing: none" holds **only because** every gap has a classic fallback. The checklist says so explicitly, and does
    not claim full native parity.
- **The evidence is real.**
  - All 30 cited test codes (T01–T30) and P1/P2 resolve to tests that pass in my run. Six M5 names are generated at
    run time; I confirmed each one in the PASS output.
  - The screenshots and real-server steps are named.
- **Linked fallbacks work, and are honestly described.**
  - All six More items, both Settings fallbacks, the room's "Open classic dashboard" and the truncated-review link go
    to `/classic`, which Part B keeps.
  - The Workspace pop-out works today. Part B changes its href.
  - **Discoverability is generic rather than deep.** Every link lands on classic's last-used view, and the user then
    picks the named view. The checklist states this. A real deep link would need a classic code change (a `?view=`
    parameter), which M9 forbids. That makes it a G1 consideration, not a defect.
- **The walkthrough is sufficient.**
  - W1–W8 cover start, a critical typed approval, a question, team approval with the proposed/live separation,
    Workspace growth with zero extra reads, Verify now, Apply and Reply in session.
  - They used the real `app.py`, Controller, journal and git, and UI-created sessions with no seeding.
  - Each step records exact GET and POST counts. The M5.0 invariant holds before and after every step. There are zero
    classic loads and zero page errors.
  - Deny with redirection, Discard, research and skills are not repeated here, but each already has accepted
    real-server evidence from the M5 review (21 cases), and the Native rows cite their DOM tests.
- **Readiness inventory.**
  - Codex's list matches my inspection: the only chat href to change is `chat/workspace.js:5` (used at `:23` and
    `:101`).
  - I also verified that classic's assets are root-absolute (`/app.css`, `/app.js` …), so `/classic/` resolves them,
    and that classic never navigates to `/`. Its only `window.open` calls are the preview-origin ticket and its
    `location.pathname` pop-out.
  - **No critical workflow becomes unreachable after the proposed cutover.**
    - Every Linked feature stays at `/classic`.
    - Chat's links already point there.
    - Part B fixes the pop-out link.
    - API, SSE, auth and the preview origin are unchanged.
- **Python timing failures.** Part 0's two failed full attempts hit `test_agents…join_work_approval_and_finish` (the
  documented 0.5 s sampling race, reproduced on pre-redesign `af4da89`) and `test_vm…console_input` (the asynchronous
  push race seen in M7 and M8).
  - M9 changed one JavaScript condition and docs, and no Python or backend file, so these cannot be M9 effects.
  - Part A's full run passed first time, and so did mine.

### Findings

**Blocking:** none.

**Should fix (in Part B; the spec is now amended), C1: pop-out compatibility at `/`.**
- **The problem.** A classic tab or pop-out window that is already open at `/` when the server switches builds its
  pop-out URLs from `location.pathname`, so it opens `/?popout=…`. Bookmarked pop-outs use the same form. After a
  plain swap, all of these would land in the chat room instead of classic's pop-out.
- **The fix.** Part B now serves classic for `/` **when the `popout` query parameter is present** (§5.1), with a route
  test (§5.4). This is routing-only and within D3. Chat's own link still moves to `/classic?popout=`.

**Optional (G1 considerations; no action unless the owner wants it):**
- **O1. Classic deep links.** More items land on classic's last view, not the named one. Fixing that needs a
  classic-side `?view=` parameter, which is a classic code change and needs an owner decision.
- **O2. No sign-out control in chat** (C14). Signing out today means classic Connections → Forget key, which works
  because the key is shared. On a shared device, chat users may expect a visible sign-out after cutover.

### What remains for the gates

**G1, parity sign-off (owner).** Read the "Linked to classic" list at the top of `docs/PARITY_CHECKLIST.md`: 54 rows.
The most user-visible are:
- full-screen terminal and Copy
- the Mission dashboard and model queue
- project switching and creation
- paid models, the stuck watch and internet during work (start-time options)
- Usage
- full Activity and audit browsing, and rule revocation
- skill proposal and removal
- run search across projects
- container and VM lifecycle
- all interactive surfaces (the approved G2 choice)

Then record one of two answers in `CURRENT_STATE.md` and this file:
- **"G1 cleared"**, accepting the linked fallbacks, the one intentional omission (themes) and the two optional
  considerations above as they are
- **the rows to bring native first**, in which case Opus writes the corrective handoff

**G3, physical devices (owner).**
- Run `docs/DEVICE_CHECKLIST.md` on a **real iPhone with Safari** and a **real Android phone with Chrome**, in light
  and dark appearance.
- Use a test project with a current session, a pending critical permission and a Workspace with terminal output.
- Fill in the results table: device, OS and browser versions, and the six columns (composer, Settings, typed confirm,
  terminal, rotation, screen reader), with notes for any failure.
- Record **"G3 cleared"**, or list the failures you accept. Opus can review any failures first.

**Then Part B.** Only after both are recorded may Codex start Part B (G2 (a) is already recorded):
- the routing, including C1's compatibility rule
- the pop-out href
- the README updates

Merging into `main` and retiring classic remain separate decisions.

## Owner decision — G1 cleared (2026-10-02)

The owner approved **G1, feature parity**, on the basis of `docs/PARITY_CHECKLIST.md` at `1025518`:
- **17 Native**
- **54 Linked to classic**
- **1 Intentionally not ported** (themes, D4)

Along with it:
- **Classic stays accessible** at `/classic` for every function not yet brought into the new interface. Retiring
  classic remains a separate, later decision.
- **C1 is approved.** `/` with a `popout` query keeps serving classic, so existing and bookmarked classic pop-outs keep
  working after the cutover.
- **G2 stays approved:** the chat becomes the default, and interactive surfaces stay available through classic.
- **G3 is pending.** The owner's physical-device verification (`docs/DEVICE_CHECKLIST.md`) is not complete. **Part B
  is not authorised** and must not start until the owner records G3 as cleared.

## G3 round 1: failed, and a corrective handoff (2026-10-02)

**The owner's physical-device results:**
- the composer field does not stay visible
- no approvals or Workspace entry point was found in chat
- rotation passed
- the screen reader and light/dark mode were not performed

**Opus's investigation** (detail in `docs/handoffs/M9_1_DEVICE_CORRECTIONS.md` §0):
- **Composer:** an implementation defect. Text inputs are 15 px, which triggers iOS focus zoom. The layout ignores
  `visualViewport.offsetTop`, and the phone sheets are anchored under the keyboard. M8's emulated keyboard test could
  not catch either.
- **Approvals:** a missing prerequisite (no pending approval), plus a discoverability gap. By design, chat has no
  Approvals section, and nothing says where approvals appear when none is waiting.
- **Workspaces:** present but undiscoverable on mobile. The links are inside collapsed turn Details and behind Session
  details; the rail members have none.
- **The screen reader and light/dark** are not performed, so they are not passes.

**Next:** Codex implements M9.1 (Parts A–C). Then the owner re-runs the device checklist. **G3 stays pending and Part B
stays unauthorised** until the owner records G3 as cleared.

## G3 round 2 — owner-reported pass (2026-10-02)

The owner ran `docs/DEVICE_CHECKLIST.md` round 2 with the isolated device fixture (`fd3c4d3`, over the tailnet) and
reported **"Checklist passed!"**. Every round-2 cell is recorded as Pass on that report. Device models and versions
were not supplied.

**Part B (the cutover) is still not authorised.** It may start only after the owner explicitly records **"G3 cleared"**
(G1 is cleared, and G2 (a) is approved).

**Correction (2026-10-02).** The owner clarified that round 2 used **only an iPhone 17 Pro with Safari**. The Android
Chrome rows are recorded as **Not performed**, not Pass. G3 remains pending, and Part B remains unauthorised, until
the owner either tests Android Chrome or explicitly accepts it as not performed, and records "G3 cleared".

**Update (2026-10-02).** The owner stated they have **no Android device**, so Android Chrome cannot be tested. G3 can
be cleared only by the owner explicitly accepting Android Chrome as not performed and recording "G3 cleared". Until
then G3 stays pending, and Part B stays unauthorised.

## Owner decision: G3 cleared, Part B authorised (2026-10-02)

**The owner's words:** "G3 cleared — iPhone 17 Pro / Safari passed; I accept Android Chrome as not performed."

**All gates are now settled:**
- **G1:** cleared
- **G2:** (a) approved
- **G3:** cleared, with Android Chrome an accepted untested gap

**Codex may now implement Part B**, exactly as specified in §5, within §6's Part B files and §7's Part B acceptance:
- `do_GET` routing: `/` → chat; `/chat` and `/chat/` as aliases; `/classic` and `/classic/` → classic
- **C1:** `/` with a `popout` query keeps serving classic
- the chat pop-out href becomes `/classic?popout=…`
- the README and architecture route updates
- the route, DOM and browser tests and the real-server walkthrough at `/`

**Not authorised:** merging into `main`, retiring classic, native surfaces, and anything beyond §5. Opus reviews Part B
before anything further.

**Known accepted risk:** Android Chrome's keyboard behaviour (`interactive-widget=resizes-content`) has only been
verified in Chromium emulation, not on a physical Android device.

## Part B completion report — 2026-10-02 (Codex)

**Cutover complete and verified under D3 and the owner's recorded G1–G3 decisions.**
Await Opus review. No merge into main, classic retirement, native surfaces or next milestone.

### Start and exact implementation scope

Started with a clean `feature/chat-first-redesign` at `c7865c9`, then pulled `--ff-only` to `ae4bcb8`, containing
the owner decision **“G3 cleared — iPhone 17 Pro / Safari passed; I accept Android Chrome as not performed.”**
Read CURRENT_STATE, the architecture, both READMEs, DEVICE_CHECKLIST, the M9 handoff and the Part A inventory.
G1 accepts the existing parity; G2 (a) keeps classic pop-outs; G3 is the owner's clearance, not a Codex claim of
device verification. Android Chrome stays **Not performed**, an accepted untested gap.

The only server change is the entry condition in `app.py.do_GET`:

- Plain `/` serves the chat HTML; `/chat` and `/chat/` remain aliases.
- `/classic` and `/classic/` serve the original classic HTML, publicly as before.
- Root with a `popout` query parameter serves classic, including empty parameter values. Query presence is parsed
  without changing the query or redirecting, preserving old tabs and bookmarked classic pop-outs (C1).
- Chat asset allow-list, classic root assets, API/auth, security headers, SSE and preview origin are unchanged.

The sole chat product change is `workspace.popout`'s prefix from `/?popout=` to `/classic?popout=`. Agent/session
encoding, target and rel remain identical. No other chat href needed correction in Part A's inventory.
Classic's own `location.pathname`-based pop-out code remains untouched and works at `/classic`; the C1 route
also preserves classic tabs opened at root before the cutover.

Both READMEs describe the room at `/`, retained aliases and classic at `/classic`, with honest classic-only
runtime/preview controls, skills management, Usage, paid models, full history and themes. Architecture §5.1 and
its change log now describe the implemented routes. The parity checklist records cutover status without changing
its **72 rows: 17 Native / 54 Linked / one intentionally not ported / zero Missing**.

### Tests and authorised earlier assertion changes

`test_chat_routes.py` is the **only Python test file changed**. Its four existing tests now assert chat root,
aliases, both classic forms and C1 compatibility, including unrelated root queries, empty/encoded `popout`
presence; both HTML forms retain the same security headers. Existing asset allow-list refusals and API-key
checks are unchanged; added checks confirm all five root classic assets retain their bytes and MIME types.
Focused result: **four tests OK, 4.144 s**, `/tmp/ac-m9b-routes.log`.

Exactly two earlier Chat DOM assertions change, only their exact href strings:

1. **`M7 B header uses recorded researcher, role, task, since and exact classic pop-out link`**:
   `/?popout=researcher-1&run=run_test` → `/classic?popout=researcher-1&run=run_test`.
2. **`M7 D surfaces have metadata and one section pop-out, with no native controls or frames`**:
   `/?popout=coder-1&run=run_test` → `/classic?popout=coder-1&run=run_test`.

All their other assertions, every other chat assertion, all classic tests, and all other Python tests remain
unchanged. The accepted post-M9.1 baseline has **424 Python tests and 255 chat tests**, superseding this
handoff's original pre-M9.1 counts of 423/240; Part B adds no Python/DOM test case.

The browser script adds a fatal **five-case cutover smoke** using the existing isolated fixture's real HTTP
server/controller. It signs in at `/`, renders the room at desktop and phone sizes, opens `/classic` with the
same remembered key, clicks the actual chat Workspace pop-out link and checks HTTP 200/classic's standalone
terminal, opens an equivalent root compatibility URL, and checks `/classic/`. Zero browser POSTs/page errors;
shutdown removes the disposable fixture. Every earlier matrix assertion and fatal check is unchanged.
`--cutover-only` allows a focused run; the full command also runs the smoke before the existing matrix.

Two initial runs of the **new** smoke failed because its selectors assumed a nonexistent Workspace-header id
and then a visible classic pop-out tab bar. Corrected the new test to click the existing pop-out link and inspect
the visible standalone terminal; classic intentionally hides its tab bar in pop-out mode. No product or earlier
test was changed to resolve these harness mistakes. The third focused run passed **five cases**,
`/tmp/ac-m9b-smoke3.log`, `/tmp/chat-shots-m9b-smoke3/cutover-smoke.json`.

### Real server at `/`, then classic with the shared key

Harnesses: `/tmp/ac-m9b-real-server.py` and `/tmp/ac-m9b-real-check.cjs`; actual `app.handler`/Controller,
existing workflow/team fakes, one disposable git project/state, and three browser-created sessions.
No owner project/state or runtime configuration was touched. Each step's fully paged invariant checks
`before == null`, **waiting == actionable non-outcomes**, **cards == actions + outcomes**, outcomes ≤ 1.

| Step | Observed server-recorded result | GET | POST |
|---|---|---:|---:|
| 1 Start | Single session starts; critical request appears, waiting/action/card = 1 | 8 | 1 |
| 2 Critical permission | Cancel initially focused; empty confirm sends no write; typed word yields confirmed receipt, waiting/action/card = 0 | 3 | 1 |
| 3 Question | JSON answer recorded as confirmed; pending checkpoint = 1, decided checkpoint = 0 | 6 | 1 |
| 4 Team | Proposal shown separately; coder-2 absent before approval, present only after recorded approval; team audit recorded | 21 | 2 |
| 5 Workspace | Opens with zero extra reads, recorded transcript grows, reasoning excluded and tool output confined to Workspace; zero Workspace writes | 8 | 0 |
| 6 Verify | Recorded on-demand verification status/time says passed | 10 | 1 |
| 7 Apply | Confirmed Apply records applied workspace and lands `api.py`, `ui.html`, `wire.txt` | 3 | 1 |
| 8 Reply in session | New session records parent and inherited team mode; waiting/actions = 1, actionable outcome = 1, cards = 2 | 8 | 1 |
| **Eight steps** | **Only `/` document loaded, no classic loads during walkthrough, no page errors** | **67** | **8** |
| Separate classic smoke | `/classic` HTTP 200, Mission renders with the same stored key and no second sign-in | 10 | 0 |

The 67 step GETs comprise **64 API fetches + three SSE reads**; each recorded fetch matches the real handler
log. Exact POST bodies/fingerprints and each before/after checkpoint are in `/tmp/ac-m9b-real-results.json`.
Additional real Auto preview evidence: **two GET / one POST**, recorded explanation only. Startup: **19 GET /
zero POST**, including assets. More and Settings fallback links remain exactly `/classic`.

First walkthrough attempt passed all eight root steps but the added classic smoke failed because the prior
harness used Playwright's one-page implicit context. Changed only the scratch harness to use an explicit shared
browser context; repeated **all eight steps and the same-key classic smoke successfully**. Logs:
`/tmp/ac-m9b-real-check.log`, `/tmp/ac-m9b-real-check-retry.log`. Final normal shutdown removes the disposable
project. These are test-harness corrections, not changes to API/state or assertions to conceal product failures.

Inspected actual root-phone and classic pop-out screenshots under `/tmp/chat-shots-m9b-smoke3/`, then final
`entry-root-desktop.png` and `entry-classic.png` under `/tmp/chat-shots-m9b-full/`, plus
`/tmp/ac-m9b-live-workspace-phone.png`. Root renders the established room; classic retains Mission and its
standalone terminal. Phone Workspace and footer remain usable; no native-device testing is inferred.

### Final verification and publication

| Suite | Actual result / log |
|---|---|
| Python | **424 tests, OK (skipped=3), 390.184 s**, full retry run alone; `python3 -m unittest discover -s agent-autonomy/tests -v`, `/tmp/ac-m9b-full-python-retry.log` |
| Classic DOM | **82/82**, unchanged; `/tmp/ac-m9b-classic.log` |
| Chat DOM | **255/255**, only two exact href replacements; `/tmp/ac-m9b-chat.log` |
| Real route tests | **4/4**, security/assets/aliases/C1; `/tmp/ac-m9b-routes.log` |
| Browser smoke | **5/5**, real HTTP/root/classic/new and old pop-outs/shared key; `/tmp/ac-m9b-smoke3.log` |
| Full browser matrix + smoke | **672 combinations + 66 regressions, 1,168 screenshots**, first full attempt; `/tmp/ac-m9b-full-browser.log`, `/tmp/chat-shots-m9b-full/` |
| Root walkthrough + classic smoke | **8/8 steps and same-key smoke passed**, recorded above |

The full matrix retains the previous 61 regressions and adds five cutover cases. **1,672** accessibility/input-font
audits (minimum 16 px), **52** contrast pairs, **32** keyboard cases and four reduced-motion/forced-colors checks
pass. All **192** phone footer measurements retain **57 px idle / 105 px waiting** in portrait and landscape;
conversation minimums remain **70.0829% portrait / 58.3333% landscape**. No budget or existing assertion weakened.

Python ran alone after all browser/real-server checks ended. First full attempt:
**424 tests, one failure, skipped=3, 260.466 s**, `/tmp/ac-m9b-full-python.log`.
The sole failure is the unchanged `test_vm.VMRunTests.test_console_input_is_checked_and_audited`, line 255:
expected the log's final three entries to be `click(10,5,640,400)`, `type('ls')`, `key('Return')`; observed
`type('ls')`, `key('Return')`, `push(<temporary coder worktree>)`. A background VM push interleaved with the
suffix assertion. This is the same protected-test race recorded in M7, M8 and M9 Part 0, not a routing failure.
The unchanged test passed alone in **1.179 s**, `/tmp/ac-m9b-vm-isolated.log`. Then retried the full suite alone,
`/tmp/ac-m9b-full-python-retry.log`: **424 tests, OK (skipped=3), 390.184 s**. No backend/test/runtime/skip changes
were made to resolve it. The retry also contains nonfatal unclosed-socket ResourceWarnings, with no failures or
background-thread exceptions.
The first full log also has two nonfatal unclosed-socket ResourceWarnings; no workflow timeouts or teardown
exceptions in that run.

The three environment-gated skips are **not passes**:

- `test_container_e2e.ContainerRunE2E.test_agent_works_in_a_locked_down_container` requires
  `AGENTCONTROL_CONTAINER_TESTS=1`, a runtime and image.
- `test_preview.DesktopTests.test_desktop_preview_shows_frames_and_accepts_input`: preview tools are absent.
- `test_vm_e2e.VMRunE2E.test_agent_works_in_a_kvm_clone` requires `AGENTCONTROL_VM_TESTS=1` on a KVM host.

The three real-OpenCode tests ran and passed in both full attempts; they are not counted as skips:
`test_roles_e2e.RolesOnRealOpenCode.test_paid_coder_and_read_only_reviewer`,
`test_team_e2e.RealOpenCodeTeamTest.test_installed_skill_reaches_the_agent_on_its_next_turn`, and
`test_team_e2e.RealOpenCodeTeamTest.test_two_agents_killed_mid_run_and_resumed`.

Before committing inspected `git status`, `git diff --stat`, `git diff --name-only`, `git diff --check` and the
staged scope. Exactly **11 §6 B files**: app entry routing, Workspace href, authorised route/DOM/browser tests,
two READMEs, architecture, parity checklist, CURRENT_STATE and this report. No classic application code,
engine, journal, adapter, schema, permissions, privacy or D7 changes. Main remains untouched. Commit/push
only `feature/chat-first-redesign`, then stop for Opus review. Classic stays supported; no retirement or merge.
Android Chrome remains the owner's accepted untested gap, not a passing test. Native surfaces and persistent
bots remain deferred, as does the intentionally excluded in-flight skill-fetch race.
