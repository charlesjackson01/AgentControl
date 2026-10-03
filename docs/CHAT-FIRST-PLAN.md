# Chat-first redesign: detailed plan and rationale

Date: 2026-09-30. **Status: approved (D1–D5).** Planning only. No redesign UI code exists yet.

This document explains *why*. The binding *what* lives in `docs/REDESIGN_ARCHITECTURE.md`: the invariants,
routes, API contracts, message mapping, composer, design language and milestones. Where they differ, the
architecture doc wins. The live status is in `CURRENT_STATE.md`, and the tasks are in `docs/handoffs/`.

---

## 1. Repository history that shaped the plan

When planning started, `feature/chat-first-redesign`, `main` and `add-ai-arch` were all at `9c20d73`. That commit has
only the early engine: about 1,000 lines, 41 tests and a 353-line dashboard.

The real AgentControl lived on `claude/gifted-fermi-rcas2a` (`967aa85`), 61 commits ahead and 0 behind. It added:
- engine milestones M0–M13 and Workspaces W0–W6
- the adapters, the migrated journal, the SSE event bus and agent lifecycle events
- R0–R3 approvals with a hash-chained audit, teams, specialists and skills
- models, the gateway and spend caps, containers, VMs, preview surfaces and projects
- 347 passing tests

A chat-first UI needs that backend underneath it, so **D1 merged it** into the redesign branch (`af4da89`).
It was conflict-free, because the only other commit was this plan. `main` was not touched.
After the merge: 347 backend tests OK (6 skipped) and 82/82 classic DOM checks.

## 2. Why chat-first

AgentControl is already a conversation underneath:
- You give a goal.
- Hermes answers with decisions (`summary`, `plan`, `title`).
- Agents do turns and ask you things.
- You steer with notes (`control(action='instruction')`, optionally aimed at one agent).
- Finished work can be continued (`parent_run`).

The classic UI spreads that conversation over nine pages. The UI/UX audit (`docs/UI-UX-AUDIT.md`) found:

| Audit finding | How the redesign answers it |
|---|---|
| 1.1: one approval shown up to 5×; Pause/Stop in 4 places; agents viewable in 3 places | one request card in the room plus one pinned pointer; controls in one menu plus slash commands; agents live in Members and Workspaces |
| 1.2: sidebar overloaded; services listed as "agents" | the rail is project → channels → sessions → members; services collapse into one Connections line |
| 1.3: the truncated brief used as the title | sessions use `title`, falling back to the goal's first line; the brief sits behind disclosure |
| 1.4: colliding words ("workspace", "prompt"/"turn", "OpenCode"/"coder-1") | fixed vocabulary (architecture §11) |
| 1.5 and §3: the theme switcher everywhere; about 6.7k lines of per-theme CSS | D4: one token-based design language, no themes |
| §2 New run: a 1,900 px form | a composer plus a Settings sheet with Advanced collapsed |
| §2 Phone: approvals below the fold | the phone layout puts the waiting pointer and actions first (M8) |

## 3. Decisions and their reasons

**D1: build on the merged backend.** Without it there is nothing to be chat-first *over*, and rebuilding it
would break the brief ("do not redesign or replace working backend systems"). We merged rather than rebasing,
so the shared branch history was never rewritten.

**D2: project-scoped conversation (a Slack-like room).** The owner's mental model is
`Project → conversation/channels → runs/tasks underneath`. Runs become **sessions** inside a persistent room.
- **Why not one conversation per run chain?** A room per chain fragments the project exactly the way pages do
  today. You would hunt for the right conversation instead of the right page.
- **Why this is cheap:** `Controller.state()` already filters runs by `run_project`. So the `main` channel can be
  project-scoped from the start, and `parent_run` survives as a *reply relation* ("continues ‹session›").
- **The safety valve:** the frontend addresses **channels** through `/api/channels` and `/api/thread?channel=`.
  If cross-session paging is costly, M2 may back `main` with the latest chain for a while, without any change to the frontend.
- **Later:** more channels (per team, per topic) are a server-side addition.

**D3: an isolated frontend.** The new UI lives in `agent-autonomy/chat/`, is served at `/chat`, and shares no JS or CSS with classic.
- **Why not `?ui=` inside `index.html`?** Classic's `app.js` is about 2.4k lines of page globals, and `app.css` is
  about 5.3k lines of per-theme rules. Toggling inside them would tangle the two UIs and put classic at risk.
- **The accepted cost:** a few small helpers (escaping, time labels, the SSE client) are *copied*.
- **What is shared:** the sign-in key's storage name, so one sign-in works for both.
- **Classic stays usable:** it is at `/` until M9, and at `/classic` from M1 onwards.

**D4: no themes.** There is one premium design language, combining modern AI-app simplicity with restrained macOS polish.
Light and dark follow the system. Every visual value is a token in one file, so theming *could* return
without rewriting components. The team's time goes to interaction, not to maintaining three looks.

**D5: a read-only thread API.** The browser cannot build a durable thread from `/api/state` alone:
- it returns only the **last 100 events** per run
- it returns only 30 runs
- it carries a lot of unrelated state

`conversation.py` is a pure projection with stable message ids, `rev` deltas and cursor paging. It gives
deterministic, testable mapping in the existing Python harness. It writes nothing, adds no table and changes no orchestration.

## 4. What the room must never do

These are restated from the architecture invariants because they drive the UX:
- **It never pretends Hermes answers a note.** Notes are read at the next turn boundary, and the UI says so.
- **It never shows a Hermes message until one exists.** Hermes decisions appear when they land. Until W7
  (tabled), "Hermes is planning…" is a *status* derived from `run.phase`, not a message.
- **It never collects an approval differently.** Every request goes through the existing `/api/review` rules:
  the fingerprint, the typed confirm word for critical requests, `remember` limits and deny + redirect.
- **It never shows reasoning, and never shows text that did not come from the journal.**

## 5. Sequencing rationale

- **M1 (the shell) and M2 (the read model) are independent.** M1 renders real but coarse data from `/api/state`,
  such as sessions, members and presence. M2 builds the thread API without touching any UI. Running both in
  parallel shortens the path to M3.
- **M1 is read-only on purpose.** It proves the isolated entry, sign-in, the live data path, the layout and the
  tokens, with no chance of mis-sending an approval. Anything actionable links to `/classic`.
- **M3 before M4 and M5.** You need to see the thread before you write into it or act inside it.
- **M5 re-implements the approval UI, not the approval logic.** The server's rules are the safety net, and the
  tests assert that the fingerprint is sent unchanged and that duplicate taps send once.
- **M7 (Workspaces) can start as a link** to classic's standalone pop-out (`/?popout=<agent>&run=<id>`), and
  become native afterwards.
- **M9 cutover needs the owner's sign-off** against a parity checklist built from `README.md` "What you see".
  Retiring classic is a separate, later decision.

## 6. Risks

| Risk | Mitigation |
|---|---|
| A long team session floods the room | fold tool events into turns; collapse turns to one line; add a "things for me" filter (M3/M6) |
| Composer ambiguity (goal vs note vs reply) | a state-driven placeholder; the recipient shown on every sent item; "Reply in session" is explicit |
| Copied helpers drift from classic | they are few and small, and each is marked with its source; classic is frozen until M9 anyway |
| Phone payload size | `known=` deltas, gzip (already in `reply()`) and paging |
| The backend allows one active run globally | shown honestly: the composer is disabled with the reason when another project's run is active |
| Engine bugs found while building UI | reported in `CURRENT_STATE.md`, never fixed inside a redesign milestone |

## 7. Decision log

| Date | Decision | By |
|---|---|---|
| 2026-09-30 | D1: merge `claude/gifted-fermi-rcas2a` into `feature/chat-first-redesign`; never into `main` | owner |
| 2026-09-30 | D2: project-scoped rooms; runs are sessions; the channel abstraction hides the backing model | owner |
| 2026-09-30 | D3: isolated frontend at `/chat`; classic at `/` and `/classic` until parity | owner |
| 2026-09-30 | D4: drop the Mac, Terminal and XP themes; one token-based design language | owner |
| 2026-09-30 | D5: read-only `/api/thread` (+ `/api/channels`) over the journal | owner |
| 2026-09-30 | The redesign milestones are renumbered M1–M9, replacing the draft's C0–C7 | Opus |
