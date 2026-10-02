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
| **G3** | Device checks: the owner ran `docs/DEVICE_CHECKLIST.md` on iOS Safari and Android Chrome, and either all rows pass or the owner accepts the listed failures | the same, with the filled-in table |

If any gate is refused, Opus writes the corrective handoff. Part B does not start.

**Gate status (2026-10-02, recorded from the owner):**

| Gate | Status |
|---|---|
| **G1** | **Pending.** It needs Part A's checklist |
| **G2** | **Owner's stated choice: (a).** Switch to chat first, and keep classic pop-outs for interactive surfaces. Native surfaces come later, under their own handoff |
| **G3** | **Pending.** The owner runs `docs/DEVICE_CHECKLIST.md` on physical devices |

**Part B stays blocked** until the owner explicitly records G1 and G3 as cleared. G2's choice alone does not unblock
it, and neither does any Codex or Opus judgement.

## 5. Part B: cutover (only after G1–G3)

### 5.1 Routing (`app.py`, `do_GET` only)

| Path | Serves |
|---|---|
| `/` | the chat UI's `index.html` |
| `/chat`, `/chat/` | the chat UI (kept as aliases, so existing bookmarks work) |
| `/classic`, `/classic/` | the classic `index.html`. The trailing slash fixes M1 polish item 5, which today returns 401 JSON |
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
