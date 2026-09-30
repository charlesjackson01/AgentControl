# Chat-first redesign: architecture and plan (draft for approval)

Date: 2026-09-30. Status: **planning only**. No UI code has been written.

## 0. Repository state (verified before planning)

| Ref | Commit | Notes |
|---|---|---|
| `feature/chat-first-redesign` (local + origin) | `9c20d73` | working tree clean, in sync with origin |
| `main` | `9c20d73` | same commit |
| `add-ai-arch` | `9c20d73` | same commit |
| `claude/gifted-fermi-rcas2a` | `967aa85` | **70 commits ahead**, 0 behind; merge-base is `9c20d73` |

**The finding that shapes everything else.** The "working backend systems" exist only on
`claude/gifted-fermi-rcas2a`, not on `feature/chat-first-redesign`:

- On the redesign branch today: `engine.py` (1,003 lines), `app.py` (148), a 353-line `app.js`, 41 tests.
- On `gifted-fermi`: M0–M13 and Workspaces W0–W6 plus Jev, about 28.5k added lines. That covers:
  - the adapters (Hermes, OpenCode, Jev)
  - the journal with migrations, the SSE event bus, and agent lifecycle events
  - permissions (R0–R3 risk classes and the hash-chained audit), team runs, specialists, skills
  - models, the gateway and spend caps, containers, VMs, preview surfaces, projects and workspaces
  - `python3 -m unittest discover -s agent-autonomy/tests`: **347 tests, OK (6 skipped)**, run in a scratch worktree.

`gifted-fermi` is a strict descendant of `9c20d73`. The only commit on the redesign branch beyond
that base is the one adding this plan, so **merging `967aa85` into `feature/chat-first-redesign` is
conflict-free**: nothing is rewritten, and `main` stays untouched.
This plan assumes that merge has been done (see §9, decision D1). Everything below refers to code at `967aa85`.

---

## 1. What "chat-first" means here

AgentControl is already conversational underneath:

- You write a goal.
- Hermes answers with decisions (`summary`, `plan`, `title`, `prompt`).
- Agents do turns and ask you for approvals and answers.
- You send steering notes (`control(action='instruction')`, optionally aimed at one agent).
- A finished run can be followed up (`parent_run`).

Today that conversation is spread over nine pages. The UI/UX audit (`docs/UI-UX-AUDIT.md`) found:

- one approval shown up to five times
- Pause/Stop in four places
- an overloaded sidebar
- colliding vocabulary

**Chat-first = one thread is the primary surface.** Everything that happens in a run appears in time
order as messages, from you, Hermes, the agents and AgentControl. The things you must act on (approvals,
team proposals, research requests, skill installs, Apply) are inline cards in that thread. A single
composer at the bottom is the only way to talk to the system. Detail (the live terminal, diffs, preview,
agent panes, audit) opens *beside* the thread. It is never a separate destination you have to navigate to.

**What it is not.** It is not a chatbot, and Hermes does not reply to each message you send:

- Your note is read at the next turn boundary. The UI says exactly that ("Hermes reads this before the next turn").
- The UI never makes up an assistant reply.
- Hermes messages appear when a real decision lands. Live Hermes streaming is W7, which is tabled.
- Until then, a status line derived from `run.phase` shows "Hermes is planning…".

## 2. Invariants (non-negotiable; the redesign must not weaken any)

1. **The journal is the single source of truth.** The thread is a *projection* of `runs`, `steps`,
   `events`, `reviews`, `agents` and `capabilities`. It has no new table and no second copy of state.
2. **The approval path is unchanged.** The existing rules still hold:
   - `POST /api/review` with the displayed fingerprint
   - server-side revalidation
   - the typed `approve` word for critical requests
   - `remember` only where `risk.remember_allowed`
   - deny + redirect
   - no automatic resend
   - duplicate taps are idempotent
3. **No private model reasoning** is stored or shown (the same rule as `verify.transcript`).
4. **No fabricated output.** Every message maps to a journal record.
5. **The API acts as the person.** No new endpoint lets a client claim to be Hermes or a rule.
6. **The dashboard key and preview-origin separation** stay as they are.
7. **No new runtime dependencies.** The server stays standard-library Python, and the client stays vanilla JS with no build step.
   This matches the whole codebase and the linkedom/playwright test harness.

## 3. Architecture

```
            journal (SQLite, unchanged)
                     │
   Store.listener ──►├── EventBus ── SSE /api/events   (unchanged: change notices only)
                     │
             ┌───────┴────────┐
   /api/state (unchanged)   conversation.py  (NEW, pure, read-only projection)
             │                 │
   classic UI (kept)     GET /api/thread   (NEW, read-only, cursor-paged)
                               │
                        chat UI (NEW: chat.js / chat.css, same tokens)
```

### 3.1 Backend: additive and read-only

**`agent-autonomy/conversation.py` (new, about 300 lines, standard library only).**
- `thread(run, steps, events, reviews, inbox, agents, capabilities) -> [Message]` is a pure function. It
  holds no state and does no I/O, so it can be unit-tested with fixtures the way `agents.describe` is.
- Each message has a **stable id** derived from its source:
  - `ev:<event id>`
  - `turn:<step id>`
  - `req:<kind>:<request_id>`
  - `cap:<id>`
  - `run:<id>:outcome`

  That lets the client patch in place instead of re-rendering.
- A message has this shape: `{id, at, actor, kind, run, agent?, body, refs, action?, rev}`.
  - `actor` is `you | hermes | <agent name> | agentcontrol`.
  - `action` is present only on actionable cards. It carries exactly the fields the existing
    endpoint needs (for example the review packet with its fingerprint).
  - `rev` is a checksum, the same idea as W3's step `rev`, so unchanged messages are sent as stubs.
- Noise events (`connection retry`, per-tool `OpenCode tool` lines, `agent state`) are **folded**
  into their turn card, not shown as messages. The mapping is §4.

**`GET /api/thread?run=<id>&chain=1&before=<cursor>&known=<id:rev,…>` (new) in `app.py`.**
- It is read-only and requires the dashboard key.
- `chain=1` walks `parent_run` links, so a follow-up conversation reads as one thread with run dividers.
- It is cursor-paged. This matters because `/api/state` today returns only the **last 100 events**
  (`Store.events(limit=100)`), so a long run's history is cut off. The thread endpoint pages by event id instead.
- It needs one small `Store` helper, `events_before(run, id, limit)`. It is a read and needs no migration.

Nothing else changes on the server. The client keeps using the existing write endpoints:
- `/api/runs` (new goal, or follow-up via `parent_run`)
- `/api/control` (instruction, pause, resume, stop, verify, apply, goal_check, title, team decisions)
- `/api/review`, `/api/research/decide` and `/api/skills/*`

The live channel is the existing SSE `change` notice. It triggers a delta fetch of `/api/thread` with `known=`.

**Why the projection is server-side and not in the browser.** The thread must survive the 100-event
cap, stay consistent between the phone and the desktop, and get testable, deterministic mapping in
the existing 347-test Python harness. The classic UI and `/api/state` are untouched either way.

### 3.2 Frontend: a new shell, reused parts

- **New files:** `chat.js`, `chat.css`, and the markup in `index.html`, or `chat.html` (decision D3).
  The classic UI stays reachable at `/?ui=classic` until parity sign-off (C7). The static asset
  whitelist in `app.py` gets the new file names (a one-line change).
- **Reused, not rewritten:**
  - `makeTerm` (the live transcript terminal)
  - review-packet rendering and the confirm-word handling
  - `workspace.js` panes (for "open agent" beside the thread)
  - surface frames (preview, VM, desktop)
  - the diff renderer and key storage

  Where they are tangled with page globals in `app.js`, extract them into a small shared module
  **without changing behaviour**. The classic UI's DOM tests must stay green.
- **Styling:** tokens only. The audit (§3, "Across themes") found about 6,700 lines of per-theme component CSS.
  The chat UI is built on the `themes.css` token layer (colour, font, radius, border) with one shared
  component layout. Theme chrome (the XP frame, the Terminal status line) is a thin optional layer (decision D4).

### 3.3 Layout

```
┌ rail ────────┬ thread ──────────────────────────────┬ context (collapsible) ┐
│ project ▾    │ ── Run: Todo CLI (completed) ──────── │ [Agents] [Terminal]    │
│ conversations│ you: Build a todo CLI…                │ [Preview] [Changes]    │
│  • Todo CLI  │ hermes: Plan: 1) storage 2) CLI …     │                        │
│  • …         │ ▸ coder-1 · turn 1 · 3 files · ✓ tests│  live terminal of the  │
│              │ ⚠ coder-1 wants to run `npm i` [Review]│  selected turn/agent   │
│ connections● │ hermes: complete — evidence …         │                        │
│              │ [Apply to main] [Discard]             │                        │
│              ├───────────────────────────────────────┤                        │
│              │ ⚠ 1 request waiting            (pinned)│                        │
│              │ [ message Hermes · @coder-2 · /  ]  ⏎ │                        │
└──────────────┴───────────────────────────────────────┴────────────────────────┘
```

- **Rail.** It holds the project switcher, the conversations (run chains, newest first, with the
  existing `runs`/`scope` data) and one compact **Connections** dot. That is audit 1.2.
- **Thread.** One run divider per run in the chain. Turn cards are collapsed to one line by default,
  and expand in place into Plan → Prompt → Code → Verify.
- **Approvals: one surface.** The card sits inline at its place in time. A **pinned strip above the
  composer** appears while anything is waiting and jumps to it. That is audit 1.1 (five surfaces become one card plus one pointer).
- **Controls.** Pause, Resume and Stop are in exactly one place, the run divider's menu.
  The same actions are also available as `/pause` and `/stop`.
- **Context panel.** It has four tabs:
  - **Agents:** the existing mission cards, compact
  - **Terminal:** the selected turn or agent, live
  - **Preview:** surfaces
  - **Changes:** the diff and Apply

  It replaces the Mission, Workspace, Project and Runs-detail pages.
- **Phone.** Thread only, with the pinned approval strip first. Its actions are visible without scrolling
  (audit §2 Phone). The context panel becomes a bottom sheet, and the rail becomes a drawer.
- **Secondary pages move to "More":** Skills, Usage, Audit/Activity and Settings (including the theme). Those pages are kept, not redesigned.

## 4. Message taxonomy (journal to thread)

| Source | Message kind | Actor | Rendering / action |
|---|---|---|---|
| event `goal`; run created | `goal` | you | your brief; the settings are summarised in one line |
| event `user instruction` | `note` | you | "→ @coder-2" if aimed; "read before next turn" until the next `Hermes decision` |
| event `goal check added` | `note` | you | the check text |
| event `Hermes decision` | `decision` | hermes | `summary`, `plan` as a list, and the next turn's `title` |
| event `Hermes JSON repaired` | folded into decision | — | small "repaired" marker |
| step (turn) + its `OpenCode *` events + `file changes` + `verification` | `turn` | agent | one-line card: agent, turn N, files ±, verify ✓/✗, tokens; expands to stages; "Open in terminal" |
| `run.pending` / inbox packet | `request` | agent | **actionable**: approve / deny+redirect / answer; typed confirm for critical; receipt state from `reviews` |
| event `approval decision`/`resolved`/`failed`/`delivery uncertain` | folded into request | — | receipt line on the same card |
| event `team proposal` (+ `run.team`) | `proposal` | hermes | **actionable**: approve team / single agent / re-propose |
| events `team started`, `task *`, `integration`, `delegated` | `progress` | agentcontrol | compact line; task graph lives in the context panel |
| research request (`research_requests`) + events `research *` | `research` | researcher-N | **actionable** (typed approval) then the report |
| capability proposals + events `skill *` | `skill` | agentcontrol | **actionable** approve/reject; install/remove log |
| events `attention`, `recovery`, `submission uncertain`, `apply conflict` | `alert` | agentcontrol | warning styling + the one relevant action (Resume/Stop) |
| events `control` | `system` | agentcontrol | quiet line ("Paused by you") |
| run terminal status + `summary` + `workspace` | `outcome` | agentcontrol | **actionable** Apply / Discard / Verify now / Follow up |
| events `vm`, `container`, `setup`, `preview`, `workspace`, `model warning`, `spend cap`, `watch *` | `system` | agentcontrol | quiet line; details in the context panel |
| `connection retry`, `agent state`, `OpenCode tool` (per tool), `notification*` | **not shown** | — | folded or omitted; they stay in Activity under More |

Any kind that is not in the table falls back to a quiet `system` line. It is never dropped silently.
A unit test enumerates every `store.event(...)` kind in the codebase and fails if one is not mapped.

## 5. Composer semantics

The composer's meaning follows the run state. The state is always shown in the placeholder, so a message is never ambiguous:

| State | Enter sends | Endpoint |
|---|---|---|
| no run in this conversation | **new goal**; "Settings" opens a sheet (verifier, limits, mode, isolation, models, preview); defaults are remembered | `POST /api/runs` |
| run active (`planning`, `running`, `waiting`…) | **note to Hermes**; `@agent` targets one agent | `POST /api/control {action:'instruction', agent?}` |
| paused / interrupted | note, plus a "Resume" chip | same, plus `control resume` |
| terminal (`completed`, `blocked`, `failed`…) | **follow-up goal**, inheriting the parent's verifier and settings | `POST /api/runs {parent_run}` |
| another project's run is active | disabled, with the reason (the backend allows one active run) | — |

**Slash commands** are thin aliases for existing actions. They add no new capability:

- `/pause`, `/resume`, `/stop` (with confirmation), `/verify`, `/apply`
- `/check <text>` (goal check), `/title <text>`, `/team approve|single|repropose`

**Mentions.** `@` suggests only the agent names the run actually has (from `/api/agents`).

The New-run form's 1,900 px of fields becomes a basic sheet plus a collapsed "Advanced" section (audit §2 New run).
Unavailable options (container, VM) show as one greyed line with "why?".

## 6. Vocabulary (fixed once, used everywhere; audit 1.4)

| Term | Meaning |
|---|---|
| **conversation** | a chain of runs linked by `parent_run` |
| **run** | one goal, from start to outcome |
| **turn** | one unit of agent work (a `step`); never "prompt" in the UI |
| **agent** | the actor (`coder-1`, `reviewer-1`); "OpenCode" and "Hermes CLI" are *runtimes*, shown only in details |
| **request** | something an agent asks you (a permission or a question) |
| **note** | what you send to Hermes during a run |
| **branch** | the git worktree; the word "workspace" is retired from the UI |
| **Connect** | the sign-in button |

## 7. Milestones

Each milestone ends with tests green (Python and DOM), a screenshot review, and a commit on
`feature/chat-first-redesign`. The classic UI keeps working after every milestone.

| # | Scope | Acceptance |
|---|---|---|
| **C0** | D1–D5 decided; `967aa85` merged into the redesign branch | `git log` shows `967aa85` as an ancestor; 347 tests OK |
| **C1** | `conversation.py` + `GET /api/thread` (paging, `chain`, `known` deltas) + `Store.events_before` | unit tests per message kind; "every event kind mapped" test; stable ids across calls; >100-event run pages correctly; `/api/state` byte-identical for the same journal |
| **C2** | chat shell, read-only: rail, thread, run dividers, turn cards, SSE → delta fetch; `/?ui=chat` | linkedom DOM tests from `tests/fixtures.cjs`; renders single, team, completed, interrupted fixtures |
| **C3** | composer: goal / note / follow-up, `@agent`, slash commands, settings sheet | each state in §5 hits the right endpoint with the right body; server errors shown inline, draft kept |
| **C4** | actionable cards: request (full review flow), proposal, research, skill, outcome (Apply/Discard/Verify); pinned waiting strip | fingerprint sent unchanged; critical needs typed word; `remember` only when allowed; duplicate tap sends once; 409 shows "request changed, refresh" |
| **C5** | context panel: agents, live terminal (reused `makeTerm`), preview/surfaces, changes/diff | live terminal follows new output; opening an agent from a card focuses it; no duplicate approval surface anywhere |
| **C6** | phone layout, keyboard, a11y (status never colour-only, contrast), "More" pages linked | screenshot matrix at phone/laptop/desktop; approvals actionable above the fold on phone |
| **C7** | parity pass vs classic (checklist from `README.md` "What you see"); make chat the default at `/`; classic at `/?ui=classic` | parity checklist signed off by you; classic removal is a separate, later decision |

C1 is the only milestone that touches Python, and it only adds code. It is also the natural first
implementation session, because it does not depend on any visual decision.

## 8. Explicitly out of scope

- Any change to `engine.py` run logic, adapters, permissions, the journal schema, the gateway, sandboxes or VMs.
- W7 (live Hermes streaming). The thread is designed so `Hermes stream` events slot in later as a live
  `decision` draft, but nothing depends on it.
- Multiple concurrent runs. The backend allows one active run, and the UI reflects that honestly.
- Merging anything into `main`.

## 9. Decisions needed from you

| # | Decision | Recommendation |
|---|---|---|
| **D1** | Base: merge `claude/gifted-fermi-rcas2a` (`967aa85`) into `feature/chat-first-redesign`? | **Yes.** It merges without conflicts (the only extra commit is this plan) and leaves `main` untouched. Without it there is no backend to be chat-first *over*. |
| **D2** | Conversation unit: a run chain via `parent_run` (proposed), or one thread per project? | Run chain. It maps onto existing data and keeps context bounded. |
| **D3** | Entry point: the same `index.html` with `?ui=`, or a separate `chat.html`? | Same `index.html`, so there is one key/auth flow and one URL to bookmark. |
| **D4** | Themes in the new UI: all three, or Mac (light/dark) + Terminal first with XP chrome later? | Mac + Terminal as tokens first; XP chrome after C7. |
| **D5** | Does `/api/thread` belong in this redesign (the small additive backend change in C1), or must the chat UI use only `/api/state`? | Add it. Without paging, a long run's thread is truncated at 100 events. |

## 10. Risks

- **Thread noise on long team runs.** Mitigation: folding (§4), collapsed turn cards, and a filter chip "only things for me".
- **Composer ambiguity.** Mitigation: the state-driven placeholder, and the recipient shown on every sent note.
- **Duplicate logic between the classic and chat UIs during the transition.** Mitigation: shared helpers are
  extracted once in C2 and C4, and the classic DOM tests guard behaviour.
- **Payload size on phones.** Mitigation: `known=` deltas plus gzip, already in `reply()`, and paging.
- **The shared branch history.** D1 should happen before any UI work lands on the redesign branch. Until then
  the merge is conflict-free; every later commit makes integrating `gifted-fermi` harder.
