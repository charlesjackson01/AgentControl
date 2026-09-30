# AgentControl chat-first redesign: architecture contract

**Status:** authoritative. Approved decisions D1–D5, 2026-09-30.
**Audience:** every agent or person implementing the redesign. It is the stable interface between planning (Opus) and implementation (Astra).
**Companions:**
- `docs/CHAT-FIRST-PLAN.md`: rationale, audit findings, risks
- `CURRENT_STATE.md`: what is true right now
- `docs/handoffs/`: one task per milestone

If this file and the plan disagree, **this file wins**. Changing a rule here needs the owner's approval; record it in §12.

---

## 1. Goal

Replace AgentControl's page-per-feature dashboard with one chat-first interface, where the mental model is:

```
Project  →  conversation / channels  →  sessions (runs) and tasks underneath
```

and **not** `Run → separate conversation`. A project is a persistent, Slack-like room where you, Hermes and the
agents work. Runs appear inside it as **sessions**: milestones with a start, turns and an outcome. Deep technical
inspection lives in **Workspaces**, opened from the room and never instead of it.

The priorities, in order:
1. chat-first interaction
2. Slack-like project and team communication
3. team formation
4. agent presence
5. progressive disclosure
6. Workspaces for deep inspection

## 2. Decisions (binding)

| # | Decision |
|---|---|
| D1 | The redesign is built on the merged backend from `claude/gifted-fermi-rcas2a` (merge `af4da89`). **Never merge into `main`** as part of this work. |
| D2 | Conversations are **project-scoped**. A run is a *session* inside the project room, not its own conversation. The frontend addresses *channels*, never raw run chains, so the backing model can change without a frontend rewrite. |
| D3 | The new UI is an **isolated frontend** with its own entry and files. It reuses the backend APIs and execution state, and shares **no JavaScript or CSS** with the classic UI. Routes: `/chat` during development, and `/` after parity (M9). The classic UI stays at `/classic`, and at `/` until M9. |
| D4 | **No theme system** in the new UI: Mac, Terminal and XP are not ported. There is one design language (§9), built on design tokens so theming *could* return later. |
| D5 | A read-only `/api/thread` (and `/api/channels`) presentation layer over the journal is approved. It changes no orchestration. |
| D6 | **Approved by the owner, 2026-09-30.** One index, `events_run_id ON events(run, id)`, added by one append-only `journal.py` migration (`_v7`) in M2.1 (`M2_1_CORRECTIONS.md` Part B). It adds no table, no column and no data change. This is a **narrow exception** to invariant 1's no-migration rule, not a precedent: any other schema change, including other indexes, needs its own owner decision. |

## 3. Invariants (never weakened)

1. **The journal is the single source of truth.** The SQLite journal (`agent-autonomy/journal.py`) holds it. Thread,
   channel and presence data are *derived* per request. There is no new table and no cached copy of state, and
   no schema migration is needed for the redesign.
   - **The single exception is D6:** the `events(run, id)` index (`_v7`), approved by the owner on 2026-09-30.
   - It does not permit further migrations. Any other schema change needs a new owner decision recorded in §2.
2. **No orchestration change.** `engine.py` run logic, the adapters (`adapters/`), `permissions.py`, `planner.py`,
   `roles.py`, `sandbox.py`, `vmenv.py`, the gateway and the lifecycle are not modified by redesign milestones.
   A bug found there is reported, not fixed in passing.
3. **No fabricated messages.** Every item shown in the thread maps to a journal record (a run, step, event,
   review, capability or agent). The UI never writes text in Hermes's or an agent's voice. Status lines that the UI
   derives (for example "Hermes is planning…" from `run.phase`) are styled as system status, not as messages.
4. **No private reasoning.** The rule of `verify.transcript` and the W7 constraints holds: reasoning parts are never stored, sent or shown.
5. **Approvals use the existing system unchanged.** The new UI uses the same endpoints and rules:
   - `POST /api/review` with the displayed `fingerprint`, which the server revalidates
   - the typed confirm word (`permissions.CONFIRM_WORD`) for critical requests
   - `remember` only when `risk.remember_allowed`
   - deny + redirect, and no automatic resend
   - a duplicate tap is idempotent, and a 409 means the request changed and must be re-read

   The same holds for `/api/research/decide`, `/api/skills/decide` and the team decisions via `/api/control`.
6. **The API acts as the person.** No endpoint lets a client claim to be Hermes, an agent or a rule.
7. **Security stays as it is:**
   - the Bearer dashboard key on every `/api/*` route
   - the preview port is a separate origin that never sees the key
   - responses keep the headers from `reply()` (`nosniff`, `X-Frame-Options: DENY`, `no-store`)
   - nothing is logged that contains goal text or credentials
8. **No new runtime dependencies.** The server stays standard-library Python. The client is vanilla JS and CSS with
   **no build step, no framework, no CDN and no web fonts**. It must work offline on a tailnet.
   Test-only npm packages (`linkedom`, `cssom`, `playwright-core`) stay test-only.
9. **The classic UI keeps working** until parity sign-off (M9). The classic test suites stay green at every commit.

## 4. System layers

```
            SQLite journal  (runs · steps · events · reviews · agents · audit · usage · capabilities)
                  │  Store.listener
                  ├──────────────► EventBus ──► GET /api/events  (SSE change notices; unchanged)
                  │
   ┌──────────────┼───────────────────────────────┐
   │ existing     │                               │ NEW, read-only (M2)
   │ GET /api/state, /api/agents, /api/audit,     │ agent-autonomy/conversation.py  (pure functions)
   │ /api/usage, /api/skills, /api/models …       │ GET /api/channels
   │ POST /api/runs, /api/control, /api/review,   │ GET /api/thread
   │ /api/research/decide, /api/skills/*, …       │
   └──────────────┬───────────────────────────────┘
                  │  same key, same origin
      ┌───────────┴────────────┐
   classic UI  (/, /classic)   chat UI  (/chat → / at M9)
   index.html app.js …         agent-autonomy/chat/*
```

The chat UI **reads** through `/api/state` (M1) and then `/api/channels` and `/api/thread` (M2+).
It **writes** only through the existing POST endpoints.

## 5. Routing and files

### 5.1 Server routes (`agent-autonomy/app.py`, `do_GET`)

| Path | Serves | When |
|---|---|---|
| `/` | classic `index.html` | until M9, then chat |
| `/classic` | classic `index.html` | from M1, permanently until classic is retired |
| `/chat`, `/chat/` | `agent-autonomy/chat/index.html` | from M1 |
| `/chat/<name>.css`, `/chat/<name>.js` | a file in `agent-autonomy/chat/` | from M1 |

- A chat asset name must match `^[a-z0-9][a-z0-9-]*\.(css|js)$`: no slashes, no dots besides the extension.
- The resolved path must be a file inside `agent-autonomy/chat/`. Anything else returns 404.
- Content types are fixed: `text/css; charset=utf-8` and `text/javascript; charset=utf-8`.
- The static routes need no key, like the classic assets. Every `/api/*` route still does.
- Classic asset paths are absolute (`/app.css`), so `/classic` needs no other change.

### 5.2 Frontend tree

```
agent-autonomy/chat/
  index.html      markup: sign-in, shell regions; loads the scripts below with defer, in order
  tokens.css      design tokens only (colour, type, space, radius, shadow, motion); light + dark
  chat.css        layout and components; uses var(--token) only, no raw colour literals
  core.js         AC.core: key storage, api(), live stream (SSE via fetch) + polling fallback, store
  model.js        AC.model: pure view-model adapters (channels, sessions, members, presence)
                  members come from /api/state `agents` (the selected run); no separate /api/agents call
  shell.js        AC.shell: rendering of the rail, room, context panel; hash router; boot
  (later) thread.js, composer.js, cards.js, members.js, workspace.js
```

**Conventions**, chosen so the existing DOM-test style works (`tests/test_ui.cjs` runs scripts in `node:vm` with linkedom):
- **Classic scripts, not ES modules.** Each file attaches to one global namespace, `window.AC = window.AC || {}`.
- **Pure functions stay pure.** Anything that turns data into data (adapters, labels, time formatting) lives in
  `model.js` or at the top of its file. Each file ends with
  `if (typeof module !== 'undefined' && module.exports) module.exports = {...}`, so Node tests can `require` it.
- **No imports from classic.** Do not load `/app.js` or `/workspace.js`, and do not read their globals.
  If a classic helper is needed (for example `esc`, `relTime` or the transcript renderer), **copy** it into the chat files.
  Note where it came from in a one-line comment. Duplication during migration is accepted; entanglement is not.
- **Storage keys:**
  - The sign-in key is **shared** with classic (`ac-dashboard-key` in `localStorage`/`sessionStorage`, same semantics),
    so signing in once works for both UIs on the same origin.
  - Any other chat preference uses the prefix `acx-` (for example `acx-context-open`) and must never collide with classic's `ac-` keys.
- **Escaping:** every string from the API is HTML-escaped before it reaches `innerHTML`, or set with `textContent`.
- **Client routing** is hash-based, so the server needs one route:
  - `#/` is the project room (the default)
  - `#/s/<runId>` focuses a session
  - `#/w/<runId>/<agent>` opens a Workspace (M7)

  Unknown hashes fall back to `#/`.

## 6. Conversation model

### 6.1 Entities

| Entity | Backing data (today) | Notes |
|---|---|---|
| **Project** | `state.project` (the controller's current project; switched with `POST /api/projects/select`) | one active project at a time (backend rule) |
| **Channel** | v1: exactly one, `main`, the project room. It holds every run where `Controller.run_project(run) == project`, plus the active run | future channels (per team, per topic) are added **server-side only**, and the frontend renders whatever `/api/channels` returns |
| **Session** | one run | shown inside a channel as a session block: title, status, time span, outcome |
| **Reply chain** | `run.parent_run` | a follow-up session shows "continues ‹session›" and links back. It is a relation *between* sessions, not a separate conversation |
| **Task** | `run.team.tasks[]` (team runs) and steps (turns) | shown inside their session |
| **Member** | Hermes (orchestrator) plus the run's agents (`/api/agents`, `state.agents`) | with presence (§8) |

**Why project scope is cheap.** `state()` already filters runs by `run_project`. The `parent_run` chain is kept as a
*relation*. It is not the unit of conversation. If paging across sessions proves hard in M2, the server may
temporarily back `main` with only the latest chain, **as long as the API shape below stays the same**.

### 6.2 `GET /api/channels` (M2; read-only; key required)

```json
{"project": "/home/me/ac-demo",
 "channels": [{"id": "main", "kind": "project", "title": "ac-demo", "sessions": 12,
               "active_session": "run_abc" | null, "waiting": 1, "updated": "2026-09-30T14:00:00+00:00"}]}
```

### 6.3 `GET /api/thread` (M2; read-only; key required)

Query parameters:
- `channel=main`, or `session=<runId>` for one session only (used by Workspaces and deep links)
- `before=<cursor>` (optional; older page)
- `limit=<n>` (default 200, maximum 500 messages)
- `known=<id:rev,…>` (optional; unchanged messages come back as `{id, rev, same: true}`, as W3 does for steps)

```json
{"channel": "main", "project": "/home/me/ac-demo",
 "sessions": [{"id": "run_abc", "title": "Todo CLI", "status": "completed", "created": "…", "ended": "…",
               "parent": null, "mode": "single|team", "summary": "…"}],
 "messages": [Message, …],          // oldest → newest within the page
 "before": "<opaque cursor>" | null, // null = no older messages
 "live": {"session": "run_abc" | null, "phase": "manager|code|verify" | null, "status": "…"}}
```

**Message** (every field comes from the journal; `rev` is a checksum of the serialised message):

```json
{"id": "ev:1234 | turn:<stepId> | req:<kind>:<requestId> | cap:<id> | out:<runId> | run:<runId>",
 "rev": 123456789, "at": "ISO-8601", "session": "run_abc",
 "actor": "you | hermes | coder-1 | reviewer-1 | researcher-1 | agentcontrol",
 "kind": "session_start | goal | note | decision | turn | request | proposal | research | skill | progress | alert | system | outcome",
 "text": "plain text, already bounded", "refs": {"step": "…", "agent": "…", "event": 1234},
 "detail": {…kind-specific, bounded…},
 "action": null | {"endpoint": "/api/review", "fields": {…exactly what the existing endpoint needs…}}}
```

- **Ids are stable** across calls and pages, so the client patches in place.
- A **cursor** is opaque to the client. Server-side it encodes a (session created, session id, event id) position.
  Events are paged with a new read-only helper, `Store.events_page(run, before_id, limit, exclude_kinds)`. No migration is needed.
- `action` is present only while the item is actionable. For a request, it carries the review packet with its
  `fingerprint`, taken from the same source as `state.inbox`.
- The projection lives in **`agent-autonomy/conversation.py`**. Its projection functions are pure, with no I/O, and are
  unit-tested with fixtures. One thin `gather()` in the same module reads inputs through existing **read-only** `Store` and
  `Controller` methods only, and `app.py` calls it. The detailed, normative event mapping is `conversation.MAPPING`,
  specified in `docs/handoffs/M2_THREAD_READ_MODEL.md` §5.3. The table below is its summary.
- `/api/state` stays **byte-identical** for the same journal. The classic UI depends on it.

### 6.4 Journal → message mapping (normative)

| Source | `kind` | `actor` | Notes |
|---|---|---|---|
| run created | `session_start` | agentcontrol | the session divider; carries title, mode, parent |
| event `goal` | `goal` | you | |
| event `user instruction`, `goal check added` | `note` | you | `detail.to` = agent if aimed; UI shows "read before next turn" until the next decision |
| event `Hermes decision` (+ `Hermes JSON repaired` folded) | `decision` | hermes | `summary`, `plan`, next `title`; the prompt is omitted (it appears in the turn) |
| step + its `OpenCode prompt/tool/result/needs input`, `file changes`, `verification*` | `turn` | step agent | one message per step; tool events are **folded**, never separate messages |
| pending request (`run.pending` / inbox) + `approval *` events | `request` | agent | actionable while pending; receipts fold in |
| `team proposal` + `run.team` | `proposal` | hermes | actionable: `approve_team`, `single_agent`, `repropose` |
| `team started`, `task *`, `integration`, `delegated`, `team tasks finished`, `auto mode` | `progress` | agentcontrol | compact |
| research request + `research *` | `research` | researcher-N | actionable (typed approval), then the report |
| capability proposals + `skill *` | `skill` | agentcontrol | actionable approve/reject |
| `attention`, `recovery`, `submission uncertain`, `apply conflict`, `completion rejected`, `watch alert` | `alert` | agentcontrol | |
| run terminal status + `summary` + `workspace` | `outcome` | agentcontrol | actionable: Apply / Discard / Verify now / Reply in session |
| `control`, `vm`, `container`, `setup`, `preview`, `workspace`, `model warning`, `spend cap`, `applied`, `discarded`, `notification`… | `system` | agentcontrol | quiet line |
| `Hermes request` (the full manager prompt), `connection retry`, `agent state`, `watch`, per-tool `OpenCode tool`, `notification`, `notification error` | *omitted* or folded | | still visible in Activity (More) and Workspaces |

Any event kind not listed maps to a quiet `system` message and is **never silently dropped**. A unit test
collects every `store.event(<run>, '<kind>', …)` literal in `agent-autonomy/*.py` and fails if a kind has no mapping.

## 7. Composer semantics (M4)

The composer is the only way to talk to the system. Its target is always visible in the placeholder and on every sent item.

| Room state | Enter sends | Existing endpoint |
|---|---|---|
| no active session | **new session** (goal); a "Settings" sheet holds verifier, limits, mode, isolation, models, preview; last-used values are remembered under `acx-` keys | `POST /api/runs` |
| "Reply in session" chosen on a finished session | **follow-up session** with `parent_run` and that session's settings | `POST /api/runs` |
| active session | **note to Hermes**; `@agent` aims it at one agent | `POST /api/control {action:"instruction", agent?}` |
| paused / interrupted | note, plus a Resume chip | same, plus `{action:"resume"}` |
| a run is active in another project | disabled, with the reason | none |

- **Slash commands** are aliases only, with no new capability:
  `/pause`, `/resume`, `/stop` (asks for confirmation), `/verify`, `/apply`, `/check <text>`, `/title <text>` and `/team approve|single|repropose`.
- **`@` suggestions** come from the run's real agent names.
- A server error is shown inline and the draft is kept.
- **Hermes does not "reply" to notes.** It reads them at the next turn boundary, and the UI says so.

## 8. Presence and team formation

- **Presence states** come straight from `agents.py`: `working`, `waiting_on_you`, `needs_attention`, `paused`, `idle`,
  `finished`, `failed`, `stopped`, `blocked`, `limit_reached`, plus `task` and `since`.
- Every state shows a symbol plus a label, **never colour alone**. For example: ● Working, ! Waiting on you, ✓ Finished, ■ Stopped.
- **Members list:** Hermes first, then the agents in the order they joined. Specialists are marked by role.
  Service health (`state.health.agents`: Hermes CLI, OpenCode API, model server) is shown as one **Connections**
  indicator, not as members.
- **Team formation** is the existing flow and is not re-implemented:
  - Auto mode preview (`POST /api/mode/preview`)
  - the Hermes team proposal (`run.team`, the `team proposal` event)
  - the decision via `/api/control`

  The room shows the proposal as a card. The Members panel shows the proposed roster before approval and the live roster after it.

## 9. Design language (single, token-based)

The direction: the simplicity of modern AI chat apps, with restrained macOS polish. It is calm, dense enough for
real work, and the content comes first.

- **Tokens** (`chat/tokens.css`) are the only place a colour, font, size, radius, shadow or duration is defined.
  `chat.css` uses `var(--…)` only, and a test enforces that it contains no hex, `rgb(`, `hsl(` or named-colour literals.
- **Appearance** follows the system through `prefers-color-scheme`, with light and dark token sets.
  There is **no theme switcher** and no per-theme component CSS.
- **Type** uses the system stack: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif`.
  Monospace uses `ui-monospace, "SF Mono", Menlo, Consolas, monospace`. The scale is 12 / 13 / 15 / 17 / 22.
- **Space** follows a 4 px base: 4, 8, 12, 16, 24, 32. Radii are 8, 12 and 16. Borders are hairlines.
  Shadows are only for floating layers. There are no cards inside cards.
- **Colour:** neutral surfaces, **one** accent for primary actions and focus, and semantic colours for success,
  warning and danger (always with a symbol).
- **Motion** is 120–200 ms ease-out for opening and closing only. `prefers-reduced-motion` turns it off.
- **Progressive disclosure:** collapsed by default and one line per item, with detail on demand in place or in the
  context panel. A secondary control lives in a menu, not on the surface.
- **Accessibility:**
  - landmarks (`nav`, `main`, `aside`)
  - visible focus, and a keyboard path to every action
  - WCAG AA contrast in both appearances
  - touch targets of at least 40 px on phones

## 10. Layout

```
┌ rail (260) ───────┬ room ──────────────────────────────────┬ context (360, collapsible) ┐
│ ac-demo  ▾        │ # ac-demo · 1 session active            │ Session · Members · Changes │
│ CHANNELS          │ ── Todo CLI · completed · 14:02 ───────  │ …                           │
│  # ac-demo      1 │ you: Build a todo CLI…                   │                             │
│ SESSIONS          │ hermes: Plan: storage, CLI, README       │                             │
│  ● Todo CLI       │ ▸ coder-1 · turn 1 · 3 files · ✓         │                             │
│  ✓ Storage tests  │ ! coder-1 wants to run `npm i`  [Review] │                             │
│ MEMBERS           │ ── outcome: completed [Apply] [Reply]    │                             │
│  ● hermes         ├─────────────────────────────────────────┤                             │
│  ! coder-1        │ ! 1 request waiting                 (↓)  │                             │
│ ◦ Connections     │ [ Message Hermes…  @agent  /command ]  ⏎ │                             │
└───────────────────┴─────────────────────────────────────────┴─────────────────────────────┘
```

- **Widths:**
  - at 1200 px and wider: three columns
  - from 768 to 1199 px: rail + room, with the context panel as an overlay
  - below 768 px: the room only, with the rail as a drawer and the context panel as a bottom sheet

  There is no horizontal scrolling at 390 px.
- **One place per control:**
  - An approval appears **once** in the room, plus one pinned "waiting" pointer above the composer.
  - Pause, Resume and Stop live in the active session's header menu, and are also available as slash commands.
- **Secondary pages** go under **More**: Skills, Usage, Activity/Audit and Settings.
  Until they are rebuilt, they may link to `/classic`.

## 11. Vocabulary (UI copy)

| Use | Meaning | Avoid |
|---|---|---|
| project | the folder AgentControl works on | |
| room / channel | a project conversation (`# name`) | |
| session | one run inside a room | "run" in headings (fine in details) |
| turn | one unit of agent work (a step) | "prompt" |
| agent | the actor (`coder-1`, `reviewer-1`); Hermes is the orchestrator | "OpenCode" as an actor (it is a runtime) |
| request | something an agent asks you (a permission or a question) | "approval" as a noun for the request |
| note | what you send to Hermes during a session | "instruction" in UI copy |
| Workspace | the deep-inspection view for an agent or session | using it for the git worktree |
| branch | the git worktree a session works in | |
| Connect | the sign-in action | "Connect to workspace" |

## 12. Milestones

Redesign milestones are numbered **M1–M9**. They are unrelated to the engine's historical M0–M13 in the git history.
Each milestone has one handoff file, `docs/handoffs/M<n>_<NAME>.md`, written before work starts.

| # | Name | Scope (summary) | Depends on |
|---|---|---|---|
| **M1** | App shell | `/chat` + `/classic` routes; isolated frontend skeleton; sign-in; live data layer; rail (project, channels, sessions, members); room with session blocks; context panel slot; tokens; responsive frame | none |
| **M2** | Thread read model | `conversation.py`, `GET /api/channels`, `GET /api/thread`, `Store.events_page`, mapping tests | none (parallel with M1) |
| **M3** | Room timeline | render `/api/thread`: session blocks, messages, collapsed turns, live deltas, paging up | M1, M2 |
| **M4** | Composer | new session, notes, `@agent`, reply in session, slash commands, settings sheet | M3 |
| **M5** | Actionable cards | requests (full review flow), team proposal, research, skills, outcome (Apply/Discard/Verify); pinned waiting pointer | M3 |
| **M6** | Members and team | presence, roster, team formation panel, task graph, Connections | M1 (richer after M3) |
| **M7** | Workspaces | deep inspection per agent/session: live terminal, turn stages, diff, surfaces (preview, VM, desktop); interim: link to classic pop-out | M3 |
| **M8** | Phone and accessibility | small-screen layout pass, keyboard, contrast, rendered screenshot matrix | M5, M7 |
| **M9** | Parity and cutover | parity checklist vs classic; `/` → chat, `/classic` → classic; README | all; owner sign-off |

**Change log of this contract**
- 2026-09-30: created with decisions D1–D5 (Opus planning session).
- 2026-09-30 (M1 review):
  - `conversation.py` may contain one read-only `gather()` beside its pure projection functions.
  - `Hermes request` and `watch` events are omitted from the thread.
  - `conversation.MAPPING` (M2 handoff §5.3) is the normative mapping.
  - The chat shell takes members from `/api/state` and does not call `/api/agents` (see `M1_1_CORRECTIONS.md`).
  - Overlays (the scrim) follow the panels actually showing, never a saved preference.
- 2026-09-30 (M1.1 + M2 review):
  - M1.1 and M2 accepted; M2.1 corrections required before M3.
  - Pending M2.1: decided requests are attributed through the recorded session id.
  - Pending M2.1: the actionable outcome is the channel's newest terminal session, independent of page and view.
    This replaces M2 handoff §5.9's per-page rule.
  - Pending M2.1: planner-shaped Hermes decisions use their recorded `reason`/`title`, or are folded, never shown empty.
  - D6 (the events index) was raised for the owner.
  - M3 consumes `/api/channels` and `/api/thread` for all room and timeline content; `/api/state` only for members,
    Connections, the rail session list and the context panel.
- 2026-09-30 (owner decision):
  - **D6 approved:** the `events(run, id)` index, as the single `_v7` migration in M2.1 Part B.
  - It is a narrow exception to invariant 1, and no other schema change is authorised.

- 2026-09-30 (M2.1 completion):
  - M2.1: decided requests are attributed via the recorded session id.
  - The actionable outcome is the channel's newest terminal session, independent of page and view.
  - Planner-shaped Hermes decisions use recorded `reason`/`title` or are folded.
  - D6: `events_run_id` index added as migration `_v7`; no other schema changes.
- 2026-09-30 (M2.1 review): M2.1 accepted. The M3 handoff was checked against the final API and gained §2.1
  (the final API behaviour to rely on).
- 2026-09-30 (M3 review):
  - The M3 architecture is accepted: the room is built on `/api/channels` and `/api/thread` only, with a page-lifetime read cache.
  - M3.1 corrections are required before M4: receipt labels follow classic `receiptLabel` semantics; stale action
    markers are revalidated only by bounded (≤ 10-page) re-reads, never cleared by the client; the waiting line is separate.
  - M5 must reconcile `/api/thread` actions on finished sessions with `/api/channels.waiting`.
