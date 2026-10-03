# Persistent agents: N0 architecture proposal

**Status:** **Proposed** (N0, 2026-10-03, Opus). On 2026-10-03 the owner approved **P-1, P-11 (a), P-12, P-13, P-14 and the
milestone sequence**, recorded as D8–D12 and §12.2 in `docs/REDESIGN_ARCHITECTURE.md`. **Everything else here is not binding.**
P-2 to P-10 and P-15 are pending, and a recommendation in this document is not an approval.

**Inputs**

| Input | Role |
|---|---|
| `docs/inputs/agentcontrol-ui-handoff1.md` | Behavioural specification: what the product must do |
| `docs/inputs/agentcontrol-ui.html` | Visual reference only. It is not served, and none of its code is reused (see §12 and P-14) |
| The revised gap audit (2026-10-03), summarised in §3 | What already exists on `main` at `d1f4733` |
| `docs/REDESIGN_ARCHITECTURE.md` | The binding contract this proposal would amend, but only where an approved decision says so |

Companion documents:
- `docs/handoffs/N0_DECISIONS.md`: the 15 decisions, each one pending the owner's approval
- `docs/handoffs/N1_SHELL_AND_NAVIGATION.md`: draft N1 handoff, not authorised
- `docs/PERSISTENT_AGENTS_ACCEPTANCE.md`: acceptance criteria and regression requirements for the N series

## 1. Goals

1. **One persistent primary agent** for everyday conversation, independent of projects. It survives every project switch.
2. **Reusable specialist agents** that the user creates and configures by hand, before and apart from any project.
3. **Project teams** assembled from existing library agents. There is no team catalogue.
4. **Three separate memory scopes:** primary, specialist and project. They are never blended.
5. **A shared skill catalogue**, with per-agent assignment and *separate* tool permissions.
6. **Existing approval gates, execution infrastructure and classic compatibility are kept.**
7. **Native orchestration comes later**, designed in its own architecture milestone (N-ORCH).
8. **Everyday conversation never blocks active development.** The Primary and Direct reply path is separate from coding runs.

## 2. What exists today (verified on `main`)

| Area | Existing implementation | Reused for |
|---|---|---|
| Runs, turns, team sessions | `engine.Controller` (`new`, `control`, `review`), Hermes planner (`planner.py`), OpenCode sessions per run and agent | Team-thread sessions, unchanged until N5 |
| Approvals | `POST /api/review` (fingerprint, typed confirmation for critical requests, remembered approvals per run), research, skill and team decisions; room cards in chat | Every tool request, in every milestone |
| Project folders | `projects.create` (one folder name under the projects root, with git init and a first commit), `browse` (folders only, symlink-safe), `select_project` (refused while a run is active) | N1 native project UI; N2 extends creation |
| Model registry | `models.Broker` (endpoints, slots, priority `background`, health), gateway, usage table, paid-model confirmation and monthly cap | Model pickers; the Primary and Direct reply path |
| Skills | `capabilities.py` library validation and hashing; `trusted_skills`; per-run, per-agent install through `propose_capability` | The catalogue; installing assigned skills (N5) |
| Permissions | `permissions.REGISTRY` and `classify`; per-prompt tool withholding (`engine.py:2751–2753`); read-only refusal path (`Controller.review`) | Tool policy (P-8) |
| Read model | `conversation.py`, `/api/channels` (one `main` channel), `/api/thread` | The team thread, unchanged |
| Chat frontend | `agent-autonomy/chat/*` (isolated, vanilla); asset allow-list by filename pattern (`app.py`: flat `[a-z0-9-]+.(css\|js)` files) | N1 adds flat files without Python changes |

## 3. Why this cannot be presentation-only

The handoff calls its pass "presentation and interaction". Its Model and Acceptance sections, however, require:
- new persistent records: library agents, project membership, skill assignments, tool policies and memory
- real conversations: Primary and Direct replies
- directory creation at a chosen path

None of these exist on `main`, and agents exist only inside runs (`journal.py` `_v2`; `agents.default_agents`). The handoff is therefore delivered as a **specification spanning bounded milestones** (P-1).
- **N1** is presentation-only, and it uses honest "not available yet" states instead of sample data.
- **N2 onwards** add records and behaviour, each under its own approved decisions.

## 4. Records (proposed; each table needs owner approval, P-2)

These follow the existing journal pattern:
- tables have an `id` primary key plus a JSON `value` (as `Store.put` does today)
- created only by append-only migrations
- no existing table, column or row changes

| Milestone | Migration | Table | Value (JSON) |
|---|---|---|---|
| N2 | `_v8` | `agents` | `id` (`ag_<12 hex>`), `kind` (`primary` or `specialist`), `name`, `display_role`, `engine_type` (specialists: `coder`, `tester`, `reviewer` or `researcher`), `model` (registry endpoint id or `null`), `instructions` (at most 8,000 characters), `created`, `updated`, `archived` |
| N2 | `_v8` | `projects` (plus a unique `path` column) | `id` (`pr_<12 hex>`), `path` (resolved, inside the projects root), `name`, `created`, `updated`, `archived` |
| N2 | `_v8` | `memberships` | `id` (`<project>:<agent>`), `project`, `agent`, `active`, `added`, `removed` |
| N2 | `_v8` | `skill_assignments` | `id` (`<agent>:<skill>`), `agent`, `skill` (catalogue name), `active`, `updated` |
| N2 | `_v8` | `tool_policies` | `id` (`<agent>:<permission>`), `agent`, `permission` (`permissions.REGISTRY` key), `mode` (`ask` or `deny`), `updated` |
| N3 | `_v9` | `threads` | `id`, `kind` (`primary` or `direct`), `agent`, `created`. One thread per agent |
| N3 | `_v9` | `messages` (index `(thread, created)`) | `id`, `thread`, `created`, `actor` (`you` or the agent's id), `text`, `status` (`pending`, `complete`, `failed` or `cancelled`), `reply_to`, `model`, `error` |
| N4 | `_v10` | `memory` (index `(scope, owner)`) | `id`, `scope` (`primary`, `specialist` or `project`), `owner` (agent or project id), `text` (at most 2,000 characters), `created`, `updated`, `author` (`you`), `source` |

**Rules that apply to every new table:**
- Exactly one non-archived `primary` agent. It is created by the user when Primary is first set up and is never seeded.
- Archiving keeps the record so history stays attributable. There is no hard delete, except for memory text (§9).
- Configuration changes go to the existing hash-chained `audit` with `run = NULL` (`audit_hash` already accepts that).
  Entries record what changed, never message or memory text.
- Conversation usage goes to the existing `usage` table with `run = NULL`, `agent = <agent id>` and `source = conversation`.
- Message and memory text is never copied into `events` and never logged (invariant 7).
- SSE change notices use the existing `EventBus` (new kinds `library`, `thread` and `memory`). Clients re-read, as they do today.

**Downgrade behaviour (verified):** `journal.migrate()` applies only `MIGRATIONS[version:]`. An older build opening a newer journal
applies nothing, keeps working on the existing tables and ignores the new ones. The new features disappear, but the data is kept.

## 5. Three kinds of conversation

| Kind | Backing | Scope | Who replies |
|---|---|---|---|
| **Primary thread** | `threads`/`messages` (N3) | Not tied to any project. It survives project switches | The primary agent, via the reply path (§6) |
| **Direct thread** (one per library agent) | `threads`/`messages` (N3) | Not tied to any project. It exists before the agent joins any project | That agent, via the reply path (§6) |
| **Team thread** (one per project) | The existing project room: the `main` channel from `conversation.py`, built from runs | The active project | Today: Hermes plans sessions and OpenCode agents work. From N5: limited to the project's members |

**Separation guarantees, each tested:**
- A Direct or Primary message never appears in `/api/thread`, `/api/state`, the team thread or classic.
- A team-thread item never appears in a Direct or Primary thread.
- A member pill in the team composer *opens that agent's Direct thread*. It never posts to the team.
- The existing in-text `@agent` note (`/api/control` `instruction`, routed through Hermes) stays a team-thread feature.
- Primary memory reaches a project only when the user explicitly sends it there (§9).

## 6. Reply path for Primary and Direct (P-3, P-5)

A new module, `agent-autonomy/conversations.py`, holds one service separate from the `Controller` run loop.

- **One reply equals one model call.** The request goes to the agent's configured registry endpoint through `models.Broker`:
  - its existing slot and priority queue, at the lowest priority (`background`)
  - its health checks
  - secret references, cost recording and the monthly spend cap, as the gateway applies them to runs
- **Text only.** No tool definitions are sent: no files, no worktree, no subprocess, no skill loading. No tool can run, so no
  approval gate is needed in these threads, and approval behaviour is unchanged by construction.
- **Context, assembled server-side:**
  - the agent's `instructions`
  - that scope's memory (N4): Primary memory for Primary, that specialist's memory for a Direct thread
  - a bounded window of that thread's recent messages
  - the new message

  It never includes project files, project context, other threads or run data.
- **Recorded output.** The reply is stored as a message with the agent as actor and the model id (invariant 3 holds: it is a
  journal record, not text the UI writes in the agent's voice). Only the reply content is stored. Reasoning fields that some
  endpoints return (`reasoning`, `reasoning_content`) are discarded and never shown (invariant 4).
- **Failures** are recorded as `failed`, with a bounded error label and no invented text. "Retry" makes a new attempt for the
  same user message. "Cancel" stops a pending reply.
- **Concurrency:**
  - The service has its own lock and is not a run.
  - It is not subject to the one-active-run rule in `Controller.new`.
  - It never takes `Controller.lock` and is unaffected by project switches.
  - At most one pending reply per thread, and at most two in flight in total.
  - It must never block `Controller.new`, `control`, `review`, approvals or project switching.
- **Hardware note.** On a single-slot local model, replies wait behind coding turns because they use the lowest priority. They
  never pre-empt or slow a run. An outside endpoint chosen for Primary does not compete for the slot.
- **Paid endpoints.** Choosing a paid endpoint for an agent needs the typed confirmation (`permissions.CONFIRM_WORD`). It is
  covered by the monthly cap. The memory and messages in context are then sent to that provider, and the UI says so.
- **Prerequisite:** a configured model registry. Without one, Primary and Direct say "Set up a model endpoint" and stay
  unavailable (open question Q1).

Native tool-using conversations, agents speaking up in team threads, and Primary taking part in team sessions are out of
scope. They belong to N-ORCH (§16).

## 7. Team sessions, membership and binding (P-6, P-7)

- **N1–N4:** the team thread behaves exactly as today's project room. Hermes plans, and agents are created per run.
- **N2:** membership is recorded but advisory. The UI says plainly that sessions still choose agents automatically.
- **N5** (engine change; needs an approved exception to invariant 2): a session started in a project with members is bound to
  them.
  - Single mode uses one chosen coder-type member. Team mode limits Hermes's proposal to members and their engine types
    (`planner.validate` roles and roster), capped at `planner.MAX_AGENTS` (3, a hardware limit).
  - Each run agent record gains `agent_id`. Branch and session names stay `coder-1` and so on.
  - The member's model goes through the existing per-prompt routing (`_route_for`).
  - The member's instructions are added to each turn prompt, labelled as coming from your library.
  - Assigned skills are proposed at session start as your own requests: trusted hashes install, the rest raise the existing
    skill cards.
  - Tool policy is enforced (§8).
  - Specialist memory and project context are added within bounded budgets (§9).
  - The engine reads the **recorded `engine_type`**. It never infers a role from a name (`agents.role_of` maps unknown names
    to `coder`, which would offer editing tools to a read-only agent called, say, "Atlas").
- Old runs are untouched. A membership change made during an active session applies from the next session.

## 8. Skills and tool permissions (P-8)

- **Catalogue:** the existing library folder (`skill_library()`, validated and hashed, with trust by hash). It is shared and
  never installed on every agent automatically.
- **Assignment (N2)** records `agent ↔ skill`. Assignment never changes a tool policy and grants nothing by itself. Skills
  install per session from N5, through the existing review-and-trust path. Text-only Primary and Direct threads do not load
  skills.
- **Tool policy (N2 stores it; N5 enforces it)** is keyed by agent and **permission type** (the `permissions.REGISTRY` keys:
  `bash`, `edit`, `write`, `webfetch`, `skill`, …, plus `research`). This is the only key the existing gate can enforce exactly.
  - **ask** (the default, the same as today): the request goes to the existing approval gate unchanged.
  - **deny**: the tool is withheld per prompt where OpenCode supports it (the existing `payload['tools']` mechanism). Any
    request of that type is refused automatically before it reaches you, through the existing refusal path, and recorded in
    the audit. Deny is strictly more restrictive than today.
  - **allow** is not offered. Any future "allow" (N7) would be limited to low and sensitive classes, never critical, re-checked
    when matched, and given its own security review.
- **Showing permissions on a skill.** A skill may declare the permission types it uses in an optional `tools:` frontmatter
  field (N2, read-only parsing, validated against the registry). A Skills card shows the declared types and each assigned
  agent's mode for them. Without a declaration, it says "Tools not declared". This satisfies the handoff's "assignment and
  tool permission can differ on the same skill".
- **Limit, which must be shown honestly.** On host runs, OpenCode uses the permission block of the user's own OpenCode config
  (README, `sandbox.host_permission`), so a type the host config sets to `allow` never reaches AgentControl's gate.
  AgentControl can make a policy *stricter* (deny, by withholding the tool) but cannot turn a host `allow` into "ask". The N2
  Configure screen reads `host_permission()` and warns per type: "OpenCode is configured to allow this without asking."

## 9. Memory scopes (P-10)

| Scope | Owner | Read by | Written by |
|---|---|---|---|
| Primary | the primary agent | Primary replies only | You (N4) |
| Specialist | each library agent | That agent's Direct replies (N4) and its turns in team sessions (N5) | You (N4) |
| Project | each project | That project's team sessions (Hermes context and members' prompts, N5); visible to members | You (N4), including an explicit, audited "Send to project" copy from Primary |

- **Never copied automatically between scopes.** There is never one blended panel: each scope is shown on its own object and in
  Settings.
- **Limits:** at most 2,000 characters per entry and 200 entries per owner. Inclusion in prompts follows a stated budget.
- **Deleting an entry removes its text.** The audit keeps metadata only.
- **Agents never write memory** in N4–N6. Entries proposed by agents would need an approval card in a later milestone.
- **No claim of secret scanning.** The UI warns against storing credentials. Entries go to the agent's model provider,
  including paid ones when chosen.

## 10. Projects and directories (P-9, P-15)

- **The project directory must be inside the projects root** (`Controller.projects_root()`, which defaults to the home folder,
  so the handoff's `~/lots/austin` is valid when the root is home).
  - A relative path of 1–4 segments, each matching `projects.NAME`.
  - Missing intermediate folders inside the root are created.
  - The target must not exist yet.
  - Symlink escapes are refused (the existing `_inside` check).
  - Git init and a first commit are kept: worktrees, team runs and Apply depend on them.
- **Existing folders** inside the root can be registered as projects (Browse, then "Use as project"). This is how current users
  get project records. Nothing is created silently.
- **Membership, assignments, policies and memory live in the journal.** Nothing (`team.json`, `room.md`) is written into
  project folders, so there is no diff or Apply noise and agents cannot edit their own membership (P-15).
- **One active project at a time remains a backend rule.** Switching is refused during an active coding run (unchanged), and
  never because of a conversation.
- **Projects are identified by id.** Historical runs attach read-only by comparing `run.project` with the record's `path`.
  Moving a folder detaches its history; relocating is a later feature.

## 11. Navigation shell and routes (P-13)

**Desktop layout:** a 76px rail, a 300px secondary panel and the main stage.
- The rail lists Primary, Agents, Projects, Workspace, Skills and Settings, with the AC mark (which opens Primary) and an
  avatar placeholder (there are no user accounts; it opens Settings).
- From 720 to 1199px the secondary panel is an overlay drawer. Below 720px the rail becomes a bottom bar and the panel opens as
  a sheet over the stage.

| Route | Meaning |
|---|---|
| `#/` | The Projects team thread in N1 (unchanged meaning). Whether to make it Primary is decided when N3 ships |
| `#/primary`, `#/agents`, `#/agents/<id>`, `#/projects`, `#/workspace`, `#/skills`, `#/settings` | The six sections (`#/agents/<id>` from N2) |
| `#/s/<id>` | Session focus in the team thread (unchanged) |
| `#/w/<run>/<agent>` | **Turn details** (today's per-agent "Workspace", renamed). The pop-out stays `/classic?popout=` |

`#/agents/<id>` replaces architecture §12.1's reserved `#/b/…`. Server routes (`/`, `/chat`, `/classic`, C1) are unchanged.

## 12. Visual system (P-11, P-14)

- **The handoff's near-black palette** (`#070708`, `#101012`, `#161618`) becomes the token set, **dark-only** (P-11 (a),
  approved as D9). White active pills and send button with black text.
- **Fonts:** system stacks that *name* Inter and IBM Plex Mono first (`Inter, ui-sans-serif, system-ui, …`;
  `"IBM Plex Mono", ui-monospace, …`). Nothing is downloaded: no CDN, no web fonts (invariant 8). The asset allow-list would not
  serve font files without a Python change anyway.
- **Accessibility minimums are kept** and override the mock:
  - text contrast at least 4.5:1; the mock's `--faint` (about 3:1) is not used for text
  - essential control boundaries and focus indicators at least 3:1; the 7% white borders are decorative only
  - 40×40px touch targets on tablet and phone, and 16px inputs
  - labelled controls, real dialogs with focus traps, Escape and focus return
  - no page overflow at 320px and 390px; reduced motion and forced colours supported
- **The mock's code is not reused.** It loads fonts from a CDN, builds markup from unescaped input with `innerHTML`, hard-codes
  messages in agents' voices, and uses `alert()`. The chat keeps its existing escaping (`e()`, `model.esc`).

## 13. Invariants: kept and proposed amendments

| Contract item | Proposal | Decision |
|---|---|---|
| Inv. 1: the journal is the single source of truth; no migrations beyond D6 | **Amend:** the journal stays the single source of truth; the new tables in §4 are allowed, one approved migration per milestone | P-2 |
| Inv. 2: no orchestration change | **Amend for N5 only:** session-start binding, recorded-type tool withholding and policy refusal (`engine.py`), and the roster limit (`planner.py`). N3's new `conversations.py` modifies no listed module | P-6, P-7, P-8, P-10 |
| Inv. 3: no fabricated messages | Kept. Replies are recorded model output; N1 uses honest empty states; sample records are never seeded | P-1 |
| Inv. 4: no private reasoning | Kept. Reasoning fields are discarded on the reply path | P-3 |
| Inv. 5: approvals unchanged | Kept. "Deny" adds automatic refusal (stricter only); "allow" is not offered | P-8 |
| Inv. 6: the API acts as the person | Kept. Policy refusals are engine-internal, like today's read-only refusals; `send` posts as you; only the service records agent replies | P-3, P-8 |
| Inv. 7: security | Kept. No conversation or memory text in logs; the N6 file tree is confined and secret-filtered | P-3, P-10 |
| Inv. 8: no new runtime dependencies | Kept. System font stacks; no CDN | P-11 |
| Inv. 9: classic keeps working | Kept for the whole N series. Classic stays unchanged at `/classic`, and its 82 tests stay green | — |
| D2: channels added server-side | Kept. The team thread is the `main` channel; Primary and Direct are separate thread APIs, not project channels | — |
| D4: one design language following system light/dark | **Amended:** dark-only (approved as D9; effective when N1 ships) | P-11 |
| §11 vocabulary | **Amended** (approved as D11): "agent" is adopted; "Workspace" is the project directory; per-agent inspection becomes "Turn details" | P-13 |
| §12.1 R1 | Realised by the N series. R1's anonymous mapping of historical per-run agents is dropped; its runtime-agnostic adapter moves to N-ORCH | P-6 |

## 14. Compatibility and data migration

- **Classic** is unchanged and does not see library, thread or memory records. Sessions bound in N5 still appear in classic as
  runs (with an additive `agent_id`).
- **The API** only grows. New endpoints are named in each milestone's handoff. `/api/projects/create` stays compatible with
  today's name-only request. `/api/state` gains no conversation data.
- **Routes:** `#/`, `#/s/…`, `#/w/…`, `/`, `/chat`, `/classic` and C1 keep working.
- **Data:** each migration is append-only (`_v8`–`_v10`). Runs, agents, events and audit rows are never rewritten. Back up
  `state/autonomy.sqlite3` before upgrading to N2 (stop the server, or use SQLite's backup, because the journal uses WAL).
- **Existing users** register their current project explicitly in N2. Nothing is created silently. Historical per-run agents
  stay as they are and keep their Turn details.

## 15. Milestone sequence (bounded; each needs its own authorisation)

| # | Milestone | Kind | Gating decisions | Handoff acceptance items it satisfies |
|---|---|---|---|---|
| **N1** | Shell and navigation | UI only | P-1, P-11, P-12, P-13, P-14 | The name stays AgentControl; Primary reachable from the rail; usable at 1280px and 390px; no team catalogue; approval gates still fire |
| **N2** | Library, projects and membership records | Backend, persistence and UI | P-2, P-4, P-6, P-8 (stored only), P-9, P-15 | Creating an agent adds a library entry and creates no project; creating a project creates the directory, stores membership and opens the team thread; skill assignment and tool permission can differ |
| **N3** | Primary and Direct conversations | New service, persistence and UI | P-2, P-3, P-4, P-5 | Primary is not cleared by a project switch; Direct replies never appear in a project transcript |
| **N4** | Memory scopes | Persistence and UI; used by replies | P-2, P-10 | Primary, specialist and project memory are separate |
| **N5** | Binding to execution | Engine exception | P-6, P-7, P-8 (enforced), P-10 (in sessions) | Teams act as their membership; deny is enforced; gates still fire |
| **N6** | Workspace file tree and preview | Backend (read-only, confined) and UI | P-9, P-13 | The Workspace is the project directory, with no fake list |
| **N7** | Limited "allow" (optional) | Security | P-8 extension | — |
| **N-ORCH** | Native orchestration | Architecture only | Separate | — |

**Why this order differs from the audit draft.** The owner asked that everyday conversation be separate and not blocking, so
Primary and Direct (N3) and memory (N4) now come before engine binding (N5). They need no exception to invariant 2. N6 is
independent and can be scheduled anywhere after N1.

## 16. Native orchestration boundary (N-ORCH, not designed here)

N-ORCH owns:
- a shared runtime adapter interface
- tool-using Primary and Direct agents, whose requests must use today's approval packets (`fingerprint`, risk class, `/api/review`)
- agents taking turns in team threads, and Primary taking part in team sessions
- more than one active coding run
- any replacement for the Hermes and OpenCode paths

Its precondition is that the approval packet format and the per-run audit stay compatible, so the existing gate and classic keep
working.

## 17. Risks

| Risk | Mitigation |
|---|---|
| Role inferred from a name gives a read-only agent editing tools | Recorded `engine_type`; N5 regression test (a reviewer called "Atlas" is never offered `CHANGE_TOOLS`) |
| Leaks between memory scopes | Context assembled server-side per scope; tests per scope; no shared panel |
| Direct or Primary items appearing in the team room or in classic | Separate tables and APIs (not runs); tests across `/api/thread`, `/api/state` and classic |
| A conversation blocking development | A separate service and lock, lowest model priority, global and per-thread limits, tests that it never blocks `new`, `control` or `review` |
| A single GPU slot delaying replies | Documented; an outside endpoint is optional and subject to the paid rules |
| Host OpenCode `allow` bypassing "ask" | Shown per type in Configure (§8); deny withholds the tool |
| Path identity of projects | Ids plus a read-only path match; relocation later |
| Test churn in N1 | P-12: an explicit list; behaviour and accessibility assertions are never removed |
| Classic drift | Classic is unchanged; its 82 tests are required at every milestone |
| Growth of the `messages` table | Paging; a retention policy in a later milestone |
| Copying mock code (script injection, CDN fonts) | P-14; escaping tests with hostile names in N1 |
| Users who need a light appearance | Accepted by the owner with P-11 (a); forced colours kept |

## 18. Open questions for the owner

- **Q1.** Does your deployment run with a model registry (`--models` or `state/models.json`)? The N3 reply path depends on it.
- **Q2.** Which endpoint should Primary use by default: the local default endpoint, or an outside provider (the "Grok" in the
  sample), with the paid-model rules?
- **Q3.** What is your projects root (`--projects-root`)? The default is the home folder, which decides how project paths
  display.
