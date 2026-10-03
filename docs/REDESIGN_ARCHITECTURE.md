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
| D7 | **Approved by the owner, 2026-09-30, limited exactly to `M5_0_ACTIONABILITY.md` Part B.** Two guards in `engine.py`: (1) `decide_research` refuses when its owning session is finished or stopping; (2) `fetch_capability` refuses when its owning session is finished. Each refusal happens **before** anything is written, audited, downloaded or otherwise acted on. This does **not** authorise any broader lifecycle, approval, skill, research, API, schema or engine change; any such need requires a new owner decision. |

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
   Step material (transcript, tool output, diff, verification output, prompt) renders only inside a Workspace,
   from `/api/state`, never in the room, panel or rail; reasoning is never rendered anywhere.
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
   classic UI  (/classic)      chat UI  (/, /chat)
   index.html app.js …         agent-autonomy/chat/*
```

The chat UI **reads** through `/api/state` (M1) and then `/api/channels` and `/api/thread` (M2+).
It **writes** only through the existing POST endpoints.

## 5. Routing and files

### 5.1 Server routes (`agent-autonomy/app.py`, `do_GET`)

| Path | Serves | When |
|---|---|---|
| `/` | `agent-autonomy/chat/index.html` | default after M9 Part B |
| `/` with a `popout` query parameter | classic `index.html` | C1 compatibility for existing classic tabs and bookmarked pop-outs |
| `/classic`, `/classic/` | classic `index.html` | permanently until separately authorised retirement |
| `/chat`, `/chat/` | `agent-autonomy/chat/index.html` | retained aliases |
| `/chat/<name>.css`, `/chat/<name>.js` | a file in `agent-autonomy/chat/` | from M1 |

- A chat asset name must match `^[a-z0-9][a-z0-9-]*\.(css|js)$`: no slashes, no dots besides the extension.
- The resolved path must be a file inside `agent-autonomy/chat/`. Anything else returns 404.
- Content types are fixed: `text/css; charset=utf-8` and `text/javascript; charset=utf-8`.
- The static routes need no key, like the classic assets. Every `/api/*` route still does.
- Classic asset paths are absolute (`/app.css`), so `/classic` needs no other change.
- Chat Workspace pop-outs use `/classic?popout=<encoded agent>&run=<encoded session>`. Classic's own
  pathname-based links and bookmarked root pop-outs keep working. API, SSE, key and preview-origin rules are unchanged.

### 5.2 Frontend tree

```
agent-autonomy/chat/
  index.html      markup: sign-in, shell regions; loads the scripts below with defer, in order
  tokens.css      design tokens only (colour, type, space, radius, shadow, motion); light + dark
  chat.css        layout and components; uses var(--token) only, no raw colour literals
  core.js         AC.core: key storage, api(), live stream (SSE via fetch) + polling fallback, store;
                  shared, generation-guarded M6 selected-session reader
  model.js        AC.model: pure view-model adapters (channels, sessions, members, presence)
                  members come from /api/state `agents` (the selected run); no separate /api/agents call
  thread.js       AC.thread: server-projected timeline, keyed cards and history cache
  decisions.js    AC.decisions: M5 room decisions and server-authoritative reconciliation
  composer.js     AC.composer: M4 composer and decision aliases
  members.js      AC.members: recorded team panel, shared selected-session data, keyed rendering
  workspace.js    AC.workspace: read-only agent turns, classic stages, terminal, changes, verification,
                  recorded Hermes/researcher logs and surface metadata; no reads or POSTs of its own
  shell.js        AC.shell: rendering of the rail, room, context panel and Workspace; hash router; boot
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

Step material (transcript, tool output, diff, verification output, prompt) renders only inside a Workspace,
from `/api/state`, never in the room, panel or rail; reasoning is never rendered anywhere.
The accepted M3 bounded public `/api/thread` turn projection is preserved. M7 does not expand those room details
or read raw steps into the room. Active Workspace data comes from the established live snapshot; historical
Workspace data shares M6's one guarded selected-session GET. Opening an active Workspace during that live read
does not drop the arriving snapshot or add a read. Hermes requests remain in classic and Activity, never in the
chat Workspace; its log contains only recorded decisions and JSON repairs.

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

Actionable = the session accepts decisions (not finished, not stopping), except outcomes (M2.1 rule).
`channels.waiting` counts exactly the actionable non-outcome items of the active session. Items waiting by state
in a session that no longer accepts decisions carry `detail.expired`. Research and skill items retain their
recorded status/state and show "Not decided before the session ended" in place of the waiting status.

M5 actionable messages carry bounded review material (`detail.review`) and `review_truncated`; truncated items
can be refused, but not approved, in the room. Review inputs are limited to the M5 handoff's explicit fields,
and disappear when an item is no longer actionable. Question and proposal bounds remain unchanged; file lists
have at most 50 paths. The actionable outcome alone gains its bounded branch and change summary.
The actionable outcome carries bounded `detail.verification {status, created, ended}`, so each on-demand
verification changes its `rev`. No verification output, command or exit code is included in this field.

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
| `Hermes request` (the full manager prompt), `connection retry`, `agent state`, `watch`, per-tool `OpenCode tool`, `notification`, `notification error` | *omitted* or folded | | remain in Activity (More) and classic; chat Workspace permits only the recorded material specified above, never Hermes requests |

Any event kind not listed maps to a quiet `system` message and is **never silently dropped**. A unit test
collects every `store.event(<run>, '<kind>', …)` literal in `agent-autonomy/*.py` and fails if a kind has no mapping.

## 7. Composer semantics (M4 and M5)

The composer is the only way to talk to the system. Its target is always visible in the placeholder and on every sent item.

| Room state | Enter sends | Existing endpoint |
|---|---|---|
| no active session | **new session** (goal); a "Settings" sheet holds verifier, limits, mode, isolation, models, preview; last-used values are remembered under `acx-` keys | `POST /api/runs` |
| "Reply in session" chosen on a finished session | **follow-up session** with `parent_run` and that session's settings | `POST /api/runs` |
| active session | **note to Hermes**; `@agent` aims it at one agent | `POST /api/control {action:"instruction", agent?}` |
| paused / interrupted | note, plus a Resume chip | same, plus `{action:"resume"}` |
| a run is active in another project | disabled, with the reason | none |

- **Slash commands** are aliases only, with no new capability:
  - M4: `/pause`, `/resume`, `/stop` (asks for confirmation), `/check <text>`, `/title <text>` and `/help`.
  - Available in M5, with the other decision controls: `/verify`, `/apply`, `/discard`, `/team approve`,
    `/team single` and `/team repropose <text>`, acting on the room's current actionable item through the same controls
    and confirmations. A missing item produces an inline error and no write.
- **`@` suggestions** come from the run's real agent names.
- A server error is shown inline and the draft is kept.
- **Hermes does not "reply" to notes.** It reads them at the next turn boundary, and the UI says so.

M5 decisions use the action's allow-listed existing endpoint, fields and choices. The sole owner-authorized
endpoint exception is Reject for an actionable awaiting-fetch skill: its `/api/skills/fetch` action permits
`/api/skills/decide {id, action:'reject'}`. No other endpoint substitution is authorized.
The only decision-related browser state is a transient card status tied to message id and `rev`. Clicking
does not change messages, receipts, markers or waiting counts; recorded server revisions supply those changes.
Decisions and composer writes share one flight lock. Delivery uncertainty requires a fresh server read before
the same card can offer another decision, as specified in the M5 handoff.

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

  The Team/Members tab shows the live roster from `state.agents`, the proposed roster from `run.team.proposal`
  (never as live members), team-state wording from classic `renderTeam()`, and the task graph from `run.team.tasks`.
  The panel has no decision controls; team decisions stay on the room card.
  A team plan is pending only while the session accepts decisions (not terminal and not stopping).
  Never-approved agents stay under a proposed-team heading even after the session stops or finishes.
  Active details use the live state snapshot. A selected historical session has one guarded memory-only read per
  selection, refetched only when its recorded status changes. Room links share the ten-page locate budget.
  The rail's session list is the union of `state.runs` and the sessions in the loaded thread cache; live run status
  wins on duplicate ids. Rail paging loads the room's existing cache, and the note reports “Showing X of N sessions”.
  Connections shows per-service recorded health and uses the existing `/api/check` under the shared write lock.

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
  - visible inset focus rings in both appearances, and a keyboard path to every action
  - a first-focusable skip link to the conversation; roving arrow-key context tabs and Workspace turn toolbar
  - modal dialogs/drawers/sheets trap focus, make the background inert, start on Cancel/Close and restore the opener
  - the read-only terminal supports arrow/Page/Home/End scrolling and reachable Jump to latest
  - WCAG AA contrast in both appearances, computed from all text/status tokens against every neutral surface
  - control boundaries and focus colour meet 3:1; text and special warning/accent pairs meet 4.5:1
  - polite stable connection/waiting announcements, labelled landmarks/lists and sequential headings
  - reduced motion disables animations, transitions and smooth scrolling; forced colours retain focus/selection
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
  - from 768 to 1199 px: room with a rail drawer and a centred context overlay, at most 560 px wide (M8)
  - below 768 px: the room only, with the rail as a drawer and the context panel as a bottom sheet

  There is no page-level horizontal scrolling at desktop, laptop, tablet, portrait/landscape phone or 320 px.
  Every interactive touch target is at least 40 × 40 px on tablet and phone sizes. Dialogs and sheets are
  centred cards at 768–1199 px; portrait-phone decision sheets retain their bottom-sheet presentation.
- **Workspace (`#/w/<runId>/<agent>`):** at ≥ 1200 px, a right pane in the context slot, widened to
  `min(960px, 100vw − rail − 420px)`, with at least 420 px for the room alongside. At normal text size,
  the waiting strip stays on one line and the composer chip remains untruncated at 1200 and 1440 px. From 768–1199 px it is a room overlay;
  below 768 px it is a full-screen sheet and the room footer is hidden. Back to room and Escape restore the
  prior room route and opening focus. No page overflow at 390 or 320 px; long lines scroll within their `<pre>`.
  M4's footer budgets hold when the sheet is closed. Workspace has no decisions or input; waiting links return
  to the authoritative room cards.
- **M8 reflow:** the existing type-token ratios follow root text zoom; at a doubled root font size, views
  reflow without page overflow or clipped controls and the composer remains reachable. At 844 × 390, the
  idle footer is ≤ 72 px, waiting footer ≤ 112 px and conversation ≥ 45%. Portrait budgets remain unchanged.
  Phone footers, sheets and Workspace navigation respect safe-area insets. Native OS keyboard behaviour is
  still owner-run device verification, not a browser-emulation claim.
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

### 12.1 Beyond M9: long-term roadmap (recorded, not authorised)

**R1: Persistent bots** (the owner's direction, recorded 2026-10-01).

**The goal.** Bots become persistent, first-class entities that are:
- created, configured, reused and organised independently of projects and execution backends
- configured with a role or type, a model, instructions and skills, and default permissions
- usable across sessions and projects
- groupable (for example, into teams)
- runnable on more than one runtime (OpenCode, Hermes, future adapters)

**Today.** An agent exists only inside a run:
- `store.agents(run)` holds rows `{id: "<run>:<name>", run, name, type, model, created}`
- the types come from `agents.py`
- team plans create per-run agents
- OpenCode sessions are per run and agent

**What R1 needs** (each part needs its own owner decision; none is authorised by M1–M9):
- a persistent bot entity and schema (a new decision beyond D6)
- an engine binding of a bot to a run (a per-run instance that records `bot_id`)
- CRUD APIs
- a runtime-agnostic adapter interface
- journal attribution by bot
- a read-only mapping of historical per-run agents to anonymous bots

**Invariants that still apply.** Invariant 6 still holds: no client or bot may act as the person. Approvals stay the
person's.

**Guardrails for M8 and M9, so that R1 stays possible:**
- the UI derives agent identity only through the model helpers (`agentLabel`, members); it never hard-codes names
  beyond the existing `coder-1` fallback
- `#/w/<run>/<agent>` stays meaningful as "a bot's instance in a session"
- `#/b/…` is reserved for a future bot page
- the vocabulary (§11) defers the choice between "bot" and "agent" to R1

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
- 2026-09-30 (M3.1 review):
  - M3 and M3.1 accepted.
  - For M4: the slash commands are split between M4 (run controls, `/check`, `/title`, `/help`) and M5 (decisions).
  - The idle composer is a single line. Phone footer budgets at 390 × 844 are ≤ 72 px idle and ≤ 120 px with the waiting row.
  - Paid models, the stuck watch and internet-during-work stay in classic until a later milestone.
- 2026-09-30 (M4 review):
  - M4 needs M4.1 corrections before acceptance: title, goal checks and `allow_dirty` are per-session and never remembered;
    only a leading `@agent` targets a note, and every other `@word` is literal. This corrects the M4 handoff's mention rules.
  - The M5 prerequisite is defined in `M5_0_ACTIONABILITY.md`: actionable means the session accepts decisions (not
    finished, not stopping), outcomes excepted. `channels.waiting` must count exactly the actionable non-outcome items.
  - D7 (engine guards) was raised for the owner.
- 2026-09-30 (owner decision): **D7 approved**, limited exactly to the two M5.0 Part B guards (research approval refused
  for finished or stopping sessions; skill fetch refused for finished sessions; both before any write, audit, download or
  other effect). No broader engine, lifecycle, approval, skill, research, API or schema change is authorised.
- 2026-09-30: M4.1: only a leading @agent targets a note; other @words are literal. Title,
  goal checks and allow_dirty are per-session and never remembered.
- 2026-09-30 (M4.1 review): M4 and M4.1 accepted. `M5_0_ACTIONABILITY.md` was re-checked against `581b382` and remains
  accurate; it gained only execution details (starting point, exact label placement, test baselines). D7 is unchanged.
- 2026-09-30 (M5.0 completion): Actionable = the session accepts decisions (not finished, not stopping), except
  outcomes (M2.1 rule). `channels.waiting` counts exactly the actionable non-outcome items of the active session.
  Items waiting by state in a session that no longer accepts decisions carry `detail.expired`. D7 adds exactly
  the two pre-effect refusals in `decide_research` and `fetch_capability`; the in-flight skill-fetch race remains
  outside its scope. M5 decision controls have not begun.
- 2026-10-01 (M5.0 review):
  - M5.0 accepted (Parts A and B; D7 within its boundary).
  - The full M5 handoff is `docs/handoffs/M5_DECISIONS.md`. Its Part A extends the read-only projection with bounded
    review material for actionable items (the same fields classic shows) and `review_truncated`. Truncated items can be
    refused, but not approved, in the room.
  - Decision state is shown only from recorded server state. The only browser state is a transient per-card status, tied to message id and `rev`.
- 2026-10-01 (M5 Part A): the read-only projection adds the handoff's bounded permission and proposed-skill review
  inputs, actionable outcome branch summary, and `review_truncated`. Historical messages and the accepted M5.0
  actionability predicates are unchanged. Part B must refuse room approvals when review material is truncated
  or unsupported, preserving the classic fallback and safe refusal paths.
- 2026-10-01 (M5 Part B): room cards expose the handoff's permission, question, team, research, skill and outcome
  decisions using existing endpoints. `/verify`, `/apply`, `/discard` and `/team` act on current actionable items.
  Only transient delivery status is browser state; decisions, receipts and waiting counts remain server-authoritative.
  Truncated or unsupported review prevents approval and preserves classic review and safe refusals.
  The owner authorized exactly the awaiting-fetch skill Reject exception from `/api/skills/fetch` to
  `/api/skills/decide`; the accepted read-model action shape is unchanged. D7 is unchanged, and the in-flight
  skill-fetch race remains intentionally out of scope.
- 2026-10-01 (M5 review):
  - M5 accepted (Parts A and B). D7 is unchanged, and the skill-Reject endpoint exception is confined to its five
    conditions.
  - **Rule clarified:** the card's new-`rev` rule requires every recorded decision to produce a `rev` the room has not
    seen. The read model must guarantee it. On-demand verification did not (finding F1). M6 Part A adds bounded
    `detail.verification {status, created, ended}` to the actionable outcome.
  - The next milestone is **M6, Members and team** (`docs/handoffs/M6_MEMBERS_AND_TEAM.md`).
    - Its scope is unchanged from §12.
    - It shows the live roster from `state.agents`, and the proposed roster from `run.team.proposal`, never as live
      members.
    - It adds the team-plan states, the task graph, Connections detail and rail sessions (the union of `state.runs`
      and the loaded thread sessions).
    - It adds no decision controls: team decisions stay on the room card (§10). It adds no API, schema or engine change.
- 2026-10-01 (M6 Part A): the actionable outcome projects only bounded verification status and times, making fast
  on-demand verification observable through the existing new-`rev` reconciliation. Successful decision aliases
  clear the composer draft; errors retain it. Decision semantics and D7 are unchanged.
- 2026-10-01 (M6): recorded members, separate proposed roster, classic team-plan wording, vertical task groups and
  latest-turn links are implemented. Historical details are guarded reads; the live snapshot stays on the active
  session. Connections checks share write locking. The rail grows with loaded history and retains keyed focus.
  No backend execution, API, schema, classic or M5 decision semantics changed. The owner authorized only the
  superseded M3.1 rail-test rewrite required by the session union and new count wording, in addition to Part A O1.
  D7 and the intentionally excluded in-flight skill-fetch race remain unchanged.
- 2026-10-01 (M6 review):
  - M6 accepted (Part A and the rest). No backend, API, schema, `decisions.js` or classic change. D7 is unchanged.
  - **Rule clarified:** every team-plan or panel notion of "pending" uses M5.0's `accepts_decisions` (not terminal
    **and** not `run.stop`). A roster that was never approved is always labelled as proposed. This is finding S1,
    fixed in M7 Part A.
  - The live `/api/state` read follows the active session. Historical sessions use the one guarded selected-session
    read. This is accepted.
  - The next milestone is **M7, Workspaces** (`docs/handoffs/M7_WORKSPACES.md`).
    - **Scope decision (architect):** M7 delivers a native, read-only and POST-free Workspace: turns, classic stages,
      the terminal transcript, changes and verification, and the Hermes and researcher logs.
    - Its data is the existing `/api/state`: live for the active session, and the shared M6 selected-session read for
      others. It adds no new reads.
    - Surfaces use §12's interim, the classic pop-out link (`/?popout=<agent>&run=<id>`). Native surface viewing and
      input (the preview ticket and iframe, program input, VM, desktop and generic frames, input POSTs) need their own
      handoff before M9.
    - Step material (transcripts, tool output, diffs, verification output, prompts) may render only inside a
      Workspace. Reasoning is never rendered anywhere.
- 2026-10-01 (M7 Part A): S1 aligns team-panel pending state with M5.0's not-terminal/not-stopping predicate.
  Stopping plans show their recorded lifecycle state, and every never-approved roster remains explicitly proposed.
  No backend or room decision semantics changed; optional M6 polish is deferred.
- 2026-10-01 (M7): native read-only Workspaces implement turns, classic stages, terminal text/tools, changes,
  verification and recorded Hermes/researcher logs. The live snapshot and shared M6 historical reader remain
  the only data sources. Raw step material stays within the open Workspace; reasoning and Hermes requests are
  excluded. Surfaces show metadata and the existing standalone classic pop-out link. Native surfaces and input
  need their own handoff before M9; M8 and M9 remain unstarted. Backend, schema, classic, M5 decisions and D7
  are unchanged. The owner authorized exactly the superseded M3 turn-link assertion and the isolation assertion
  that also rejected the new `/chat/workspace.js` asset; no other earlier assertion was rewritten.
- 2026-10-01 (M7 review):
  - M7 accepted (Part A S1 and the read-only Workspaces). No Python, API, schema, classic or `decisions.js` change.
    D7 is unchanged.
  - Workspaces are POST-free. Step material renders only inside them, reasoning is never rendered, and interactive
    surfaces stay in the classic pop-out.
  - The next milestone is **M8, Phone and accessibility** (`docs/handoffs/M8_PHONE_AND_ACCESSIBILITY.md`). It
    covers:
    - the scheduled M3 deferrals: focus after Load earlier, partial-session divider counts, and live refresh of the
      fallback view
    - M6 P1–P4, M7 Q1–Q2 and M5 O2
    - the small-screen pass, adding tablet and landscape viewports
    - keyboard and focus
    - screen readers, tested contrast, and motion
    - the final matrix
  - **Native phone-keyboard testing stays deferred.** It becomes an owner-run device checklist
    (`docs/DEVICE_CHECKLIST.md`) as an M9 sign-off input.
  - Added §12.1, the long-term roadmap: **R1 persistent bots**, recorded and not authorised. It is not part of M8.

- **2026-10-01, M8 implemented; awaiting review.** Parts A–E retain the accepted M1–M7 contracts. Keyboard paths,
  modal focus/inert, stable polite announcements, token contrast, reduced motion and forced colours are tested.
  The seven-size/light-dark matrix also covers actual doubled text and emulated safe-area insets. Native iOS/Android
  keyboard and VoiceOver/TalkBack checks remain owner-run via `docs/DEVICE_CHECKLIST.md` before M9; they are not
  claimed by browser emulation and are not an M8 acceptance gate. M9 remains unstarted. Interactive surfaces
  still use the classic pop-out; the D7 in-flight skill-fetch race and persistent bots remain deferred.
- 2026-10-02 (M8 review):
  - M8 accepted (Parts A–E). No Python, API, classic or decision-semantics change. The only `decisions.js` change is
    the O2 key-fact fallback.
  - The border tokens changed for 3:1 control contrast (light `#85858f`, dark `#777984`).
  - **Rule clarified:** the rail's "Showing X of N sessions" appears **only while X < N** (the owner's approval). The
    X > N case is finding N1, fixed in M9 Part 0.
  - The next milestone is **M9, Parity and cutover** (`docs/handoffs/M9_PARITY_AND_CUTOVER.md`). Part A is an
    evidenced parity checklist (docs only).
  - Part B, the cutover, waits for the owner's gates:
    - **G1:** parity
    - **G2:** surfaces before or after cutover
    - **G3:** the device checklist
  - Under D3, Part B changes only the `do_GET` routing (`/` → chat, `/chat` as an alias, `/classic` and `/classic/` →
    classic) and the chat pop-out href (→ `/classic?popout=`).
  - Retiring classic and merging into `main` remain separate owner decisions.
- 2026-10-02 (owner decisions):
  - **M8 rail assertions confirmed.** All three P2 rewrites stand. They cover only the completed-history wording
    (X = N). Incomplete-history, pagination and session-count checks are unchanged.
  - **N1 approved as M9 Part 0.** The rail hides its disclosure when X > N. Counts and pagination are unchanged.
  - **M9 G2: choice (a).** Cut over first, with interactive surfaces through the classic pop-out. Native surfaces need
    their own later handoff.
  - **G1 and G3 are pending.** M9 Part B (the cutover) stays blocked until the owner explicitly clears both.
- 2026-10-02 (M9 Part 0 and Part A review):
  - Accepted. N1 is a one-condition fix, with the owner-approved X > N test exception only. The parity checklist has 72
    rows: 17 Native, 54 Linked, 1 Not ported, 0 Missing.
  - **Part B spec amended (C1):** `/` with a `popout` query parameter keeps serving classic, so open classic windows and
    bookmarked pop-outs survive the cutover.
  - **G1 is ready for the owner.** G3 is pending. G2 is (a).
- 2026-10-02 (owner decision): **G1 cleared.** Parity is accepted at 17 Native, 54 Linked to classic and 1 not ported.
  Classic stays accessible at `/classic`, and the C1 pop-out compatibility is approved. G2 (a) stands. **G3 is
  pending, and M9 Part B is not authorised.**
- 2026-10-02 (G3 round 1):
  - **Failed** on the owner's devices. The causes:
    - **Composer:** inputs under 16 px trigger iOS focus zoom, and the layout and sheets do not follow the visual
      viewport's offset.
    - **Approvals and Workspaces:** they cannot be found on mobile.
    - **Screen reader and light/dark:** not performed.
  - The corrective handoff is `docs/handoffs/M9_1_DEVICE_CORRECTIONS.md`.
  - **Rules added:**
    - every text-entry control is ≥ 16 px, and page zoom is never disabled
    - the app and phone sheets follow `visualViewport` (height **and** offset) while not pinch-zoomed
    - approvals and Workspaces each have a visible mobile entry: links and status only, never a second decision
      surface
  - G3 is pending, and M9 Part B is not authorised.
- 2026-10-02 (M9.1 review):
  - Not yet accepted. M9.1a is required for:
    - **fixture isolation:** the fixture's `projects_root` must be its temporary folder
    - **zoom:** while pinch-zoomed, the viewport variables freeze at their unzoomed values
    - **reliable focus return** from ⋯ → Workspaces
  - **Rule clarified:** the device fixture must not be able to reach or modify any real project, including through
    classic's project switching.
  - G3 is pending, and M9 Part B is not authorised.
- 2026-10-02 (M9.1 re-review): **The M9.1 implementation is accepted** at `fd3c4d3`. The fixture is confined to its
  temporary folder, pinch-zoom freezes the viewport variables, and focus return is reliable (10/10). Physical-device
  checks are **Not performed**. G3 is pending, and M9 Part B is not authorised.
- 2026-10-02 (owner decision): **G3 cleared.**
  - iPhone 17 Pro / Safari passed. Android Chrome was accepted as not performed (no device), an accepted untested gap.
  - With G1 cleared and G2 (a) approved, **M9 Part B is authorised** under D3, exactly per the M9 handoff §5:
    routing, the C1 compatibility rule, the pop-out href and docs.
  - Merging into `main` and retiring classic are not authorised.
- 2026-10-02 (M9 Part B implementation): under D3 and the recorded G1–G3 clearance, `/` serves chat, `/chat`
  remains an alias, `/classic` and `/classic/` serve classic, and C1 root `popout` queries still serve classic.
  Chat Workspace links use `/classic?popout=…`. No API, schema, engine, journal, approval, auth, preview-origin
  or classic-code changes. Android Chrome remains the owner's accepted untested gap. Await Opus review;
  merging into main and retiring classic remain separate decisions.
- 2026-10-03 (M9 Part B review): **M9 is accepted.** Routes, C1 compatibility, the `/classic?popout=` Workspace link,
  docs and tests verified independently, with no Blocking or Should-fix findings. Merging into `main`, retiring classic,
  native surfaces (G2) and R1 remain separate owner decisions.
- 2026-10-03 (N0 proposal): `docs/PERSISTENT_AGENTS_ARCHITECTURE.md` proposes the N series that would realise §12.1 R1,
  with 15 decisions pending in `docs/handoffs/N0_DECISIONS.md`. **Nothing in this contract is amended by the proposal.**
  Each amendment (invariants 1, 2 and 8 as scoped there, D4, §11) applies only once the owner approves its decision.
