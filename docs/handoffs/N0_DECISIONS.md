# N0 decisions: persistent agents (pending owner approval)

**Status:** every decision below is **Pending**. The recommendations are Opus's (2026-10-03). **None is approved until the owner
records approval here,** decision by decision.
Architecture: `docs/PERSISTENT_AGENTS_ARCHITECTURE.md`. Inputs: `docs/inputs/agentcontrol-ui-handoff1.md` (behaviour) and
`docs/inputs/agentcontrol-ui.html` (visual reference).

**How to approve:** reply with, for example, "Approve P-1, P-11 (a), P-12, P-13, P-14", or with changes. Opus records each
approval (or refusal) in the table below and in `CURRENT_STATE.md`, and amends `docs/REDESIGN_ARCHITECTURE.md` only for the
approved items. If you approve only the five decisions that gate N1, N1 can start; the rest gate N2 onwards.

## Summary

| # | Decision | Kind of authorisation | Gates | Status |
|---|---|---|---|---|
| P-1 | Scope: several milestones; no sample records | Product scope | N1 | **Pending** |
| P-2 | New journal tables by append-only migrations | **Database migration** | N2, N3, N4 | **Pending** |
| P-3 | Text-only reply path for Primary and Direct | **New execution path, security** | N3 | **Pending** |
| P-4 | Primary is a new agent record; Hermes stays the orchestrator | Product and architecture | N2, N3 | **Pending** |
| P-5 | Conversations exempt from the one-active-run rule | **Concurrency** | N3 | **Pending** |
| P-6 | Recorded engine type plus free-text display role | **Engine change (N5), security** | N2, N5 | **Pending** |
| P-7 | Membership advisory in N2, binding in N5 | **Engine change** | N2, N5 | **Pending** |
| P-8 | Tool policy per agent and permission type: ask or deny; no allow | **Permission semantics, security** | N2, N5 | **Pending** |
| P-9 | Project folders inside the projects root (nested), git kept | **Security (filesystem)** | N2 | **Pending** |
| P-10 | Memory: three scopes, written by you only, bounded | **Privacy, security** | N4, N5 | **Pending** |
| P-11 | Dark-only near-black tokens; system font stacks | Design and invariant amendment | N1 | **Pending** |
| P-12 | Authorised re-baselining of N1 layout assertions | Test policy | N1 | **Pending** |
| P-13 | Vocabulary and routes | Contract amendment | N1 | **Pending** |
| P-14 | The handoff text wins over the mock; mock code not reused | Product | N1 | **Pending** |
| P-15 | The journal is the source of truth; nothing written into project folders | **Security, persistence** | N2 | **Pending** |

Also for approval: **the milestone sequence** N1 → N2 → N3 → N4 → N5 → N6 (→ N7 optional; N-ORCH separate) in architecture §15.

---

## P-1. Scope and sample data

**Question.** How is a handoff that calls itself "presentation only", but requires persistence and real conversations,
delivered?

**Proposed.** As a specification spanning bounded milestones (architecture §15).
- N1 is presentation-only, and every unbuilt capability shows an honest "not available yet" state in plain words (no milestone
  codes in UI copy).
- The sample agents and projects (Grok, Atlas, Codex, Muse, Sentinel, AgentControl, Parking lot model, Hermes local) stay in
  the mock. They are **never** seeded as records or shown as data.

**Alternatives.**
- One large milestone: unbounded and hard to review.
- Presentation only with mock data: breaks invariant 3 and misrepresents the product.

**Consequences.**
- The handoff's acceptance items are met progressively (architecture §15).
- After N1, the Primary, Agents, Workspace and Memory areas are visible but not yet functional.

**Gates:** N1. **Status:** Pending.

## P-2. New persistent records (database migrations)

**Question.** May the journal gain new tables, beyond D6's single, explicitly non-precedent index?

**Proposed.** Amend invariant 1:
- The journal stays the single source of truth.
- Only the tables listed in architecture §4 may be added, each through one append-only migration in the milestone that needs it:
  - `_v8` in N2: `agents`, `projects`, `memberships`, `skill_assignments`, `tool_policies`
  - `_v9` in N3: `threads`, `messages`
  - `_v10` in N4: `memory`
- No existing table, column or row changes. No backfill writes to runs.
- Configuration changes are audited in the existing chain with `run = NULL`. Approving P-2 approves the table list in
  principle; each milestone's handoff restates its exact migration for your confirmation before work starts.

**Alternatives.**
- Files in project folders (rejected in P-15).
- A separate database file: splits the source of truth and breaks atomic audit.
- No persistence: the handoff's acceptance can't be met.

**Consequences.**
- Older builds keep working on a newer journal and ignore the new tables (`journal.migrate()` applies only
  `MIGRATIONS[version:]`, verified).
- Each table needs `Store` methods and tests.
- Back up the journal before N2.
- `messages` grows without limit until a later retention policy.

**Gates:** N2, N3, N4. **Status:** Pending.

## P-3. Reply path for Primary and Direct (new execution path)

**Question.** With no orchestrator in this pass, what produces Primary and Direct replies, while keeping everyday conversation
apart from coding runs?

**Proposed.** Option (a): a new `conversations.py` service. One reply is one **text-only** chat request to the agent's
registry endpoint through `models.Broker`, at the lowest priority (`background`), with usage, cost and the monthly cap recorded
as for runs.
- **No tool definitions:** no files, worktree, subprocess or skills.
- **Context:** the agent's instructions, that scope's memory (N4), a bounded thread window and the message.
- **Recording:** replies are stored as agent-attributed model output; reasoning fields are discarded; failures are recorded
  without invented text.

**Alternatives.**
- (b) Hermes CLI one-shot (`adapters/hermes.py` `_ask`). It works without a registry, but Hermes's own profile state lives
  outside AgentControl and could blend memory scopes, and it runs a CLI with the `todo` toolset.
- (c) An OpenCode session per agent. Tool-using, needs a folder and approvals: deferred to N-ORCH.
- (d) Defer replies until N-ORCH.

**Consequences.**
- No tool can run in these threads, so the approval gates are not involved and approval behaviour is unchanged.
- Invariant 3 holds (recorded model output) and invariant 4 holds (no reasoning stored).
- **It requires a configured model registry (Q1).** Without one, Primary and Direct show "Set up a model endpoint".
- A paid endpoint needs the typed confirmation, counts toward the monthly cap, and receives memory and messages.
- On a single local slot, replies queue behind coding turns. They never pre-empt them.

**Gates:** N3. **Status:** Pending.

## P-4. Who Primary is, and where Hermes sits

**Proposed.**
- Primary is a new `agents` record of kind `primary`, exactly one. The user sets it up on first visit: name (default "Primary"),
  model and instructions. It is not seeded and not created per project.
- **Hermes stays the system orchestrator** of team sessions, unchanged. It is shown as system status, is not a library row,
  is not selectable as a member, and is not Primary's runtime.
- Primary may be **recorded** as a project member (the handoff makes it optional). Until N-ORCH that grants nothing beyond being
  listed, and its pill opens the Primary thread.

**Alternatives.**
- Primary = Hermes made persistent. This conflates the planner with the conversation, and Hermes's profile memory is outside
  AgentControl.
- Primary created automatically with defaults.

**Consequences.**
- The sample "Grok" is a *model choice*. An outside provider brings the paid-model rules (Q2).
- Primary's behaviour inside team sessions is deferred to N-ORCH.

**Gates:** N2 (record), N3 (thread). **Status:** Pending.

## P-5. Concurrency

**Proposed.**
- The **one-active-coding-run rule in `Controller.new` is unchanged.**
- Primary and Direct replies are not runs. They are exempt from that rule and use their own lock, never `Controller.lock`.
  They continue across project switches and while a run is active, paused or waiting for approval.
- At most one pending reply per thread and two in total, all cancellable.
- They must never block `Controller.new`, `control`, `review`, approvals or project switching.

**Alternatives.**
- Make conversations runs: they would block, and be blocked by, coding work.
- Allow several coding runs: deferred to N-ORCH.

**Consequences.**
- Contention for model slots (they run at the lowest priority).
- A new lock and tests proving they don't interfere.
- Project switching is still refused during an active *coding* run, as today.

**Gates:** N3. **Status:** Pending.

## P-6. Role model (security; engine change in N5)

**Proposed.**
- Every specialist stores an `engine_type` from `coder`, `tester`, `reviewer` or `researcher` (`orchestrator` excluded). That
  field alone decides edit rights, worktree mode and tool withholding.
- A free-text `display_role` ("Research", "Builder", "Design", "Ops") is shown in the UI. Primary has no engine type.
- From N5 the engine reads the recorded type, **never** `agents.role_of(name)`.
- Historical per-run agents are not mapped into the library. R1's "anonymous bot mapping" is dropped.

**Alternatives.** Free-text roles inferred by the engine. Rejected: today an unknown name maps to `coder`, which has editing
tools.

**Consequences.**
- "Design" and "Ops" need a user-chosen engine type.
- A researcher still needs configured toolsets and per-task approval.
- **N5 regression test:** a reviewer named "Atlas" is never offered `CHANGE_TOOLS`.

**Gates:** N2 (stored), N5 (enforced). **Status:** Pending.

## P-7. How strongly membership binds (engine change)

**Proposed.**
- **N2:** membership is recorded and **advisory**, labelled honestly ("Sessions still choose agents automatically").
- **N5** (exception to invariant 2 for `engine.py` and `planner.py` only):
  - Single mode uses one chosen coder-type member.
  - Team mode limits Hermes's proposal to members and their engine types, up to `MAX_AGENTS` (3).
  - Run agent records gain `agent_id`.
  - Each member's model, instructions, assigned skills (through the existing trust path), tool policy and memory apply.

**Alternatives.**
- Advisory forever.
- Binding in N2. That puts an engine change into the persistence milestone.

**Consequences.**
- Planner tests change in N5.
- Projects with more than 3 specialists: Hermes picks at most 3 of them.
- Membership changes apply from the next session.

**Gates:** N2, N5. **Status:** Pending.

## P-8. Tool permission semantics (security)

**Proposed.**
- Policy is keyed by **(agent, permission type)**, using the `permissions.REGISTRY` keys plus `research`. Modes are **ask**
  (the default, identical to today: the existing gate) and **deny**. Deny withholds the tool per prompt and refuses requests of
  that type automatically, before they reach you, through the existing refusal path, with an audit entry.
- **"Allow" is not offered.** A later N7 may propose a limited allow: low and sensitive classes only, never critical,
  re-checked when matched, with its own security review.
- Skills may declare the types they use in an optional `tools:` frontmatter field (read-only parsing). A skill card shows each
  assigned agent's mode for those types.
- Assignment never changes policy.

**Alternatives.**
- Key by skill: the gate cannot enforce it exactly, because skills are not tools.
- Key by agent and skill: ambiguous when skills overlap.
- Offer allow now: weakens "Nothing is approved automatically by default" (`permissions.py`).

**Consequences.**
- The handoff's acceptance ("assignment and tool permission can differ") is met.
- **Deviation from the handoff:** its sample "Workspace files: allow" is shown as Ask until N7 is approved.
- **Honest limit:** on host runs OpenCode applies the user's own OpenCode permission config, so a type it sets to `allow` never
  reaches the gate. AgentControl can tighten (deny), not convert allow into ask, and Configure warns per type
  (`sandbox.host_permission()`).
- Denying `edit` makes a coder effectively read-only; the UI explains this.

**Gates:** N2 (stored), N5 (enforced). **Status:** Pending.

## P-9. Project directories (filesystem security)

**Proposed.**
- The directory is a relative path of 1–4 segments **inside the projects root**, each segment matching `projects.NAME`.
- Missing intermediate folders inside the root are created. The target must not exist. Symlink escapes are refused (`_inside`).
- Git init and a first commit are kept.
- Existing folders inside the root can be registered as projects.
- Paths outside the root are refused.
- **N1 changes nothing here:** it uses today's single-name `POST /api/projects/create`.

**Alternatives.**
- Arbitrary paths starting with `~`: a filesystem write anywhere the server user can reach.
- No git: breaks worktrees, team runs and Apply.

**Consequences.**
- `projects.create` and its tests change in N2.
- Paths display relative to the root (Q3).

**Gates:** N2. **Status:** Pending.

## P-10. Memory policy (privacy)

**Proposed.**
- Three separate scopes (architecture §9), written **only by you** in N4–N6. Agents never write memory.
- Limits: 2,000 characters per entry and 200 entries per owner, plus a stated budget for inclusion in prompts.
- Deleting removes the text; the audit keeps metadata only. Memory text is never logged.
- Primary memory goes only into Primary replies. Specialist memory goes into that agent's Direct replies (N4) and its session
  turns (N5). Project context goes into that project's sessions (N5) and is visible to members.
- "Send to project" is an explicit, audited copy.

**Alternatives.**
- Memory proposed by agents (needs an approval card; later).
- One shared store: forbidden by the handoff.

**Consequences.**
- Memory is sent to the agent's model provider, which may be paid or outside.
- There is no claim of secret scanning; the UI warns against storing credentials.
- Including memory in sessions needs N5's engine exception.

**Gates:** N4, N5. **Status:** Pending.

## P-11. Visual system and fonts (amends D4 and the reading of invariant 8)

**Proposed.**
- Option (a): the handoff's near-black tokens are the **only** appearance (dark-only, `color-scheme: dark`). Forced colours and
  reduced motion stay supported.
- **Fonts:** system stacks naming Inter and IBM Plex Mono first; nothing downloaded.
- **Accessibility minimums override the mock:** text at least 4.5:1, essential boundaries and focus at least 3:1, 40px targets,
  16px inputs.

**Alternatives.**
- (b) Near-black by default, keeping a light variant through tokens (twice the contrast work; closer to D4).
- Bundling Inter and Plex font files locally: needs an amendment to invariant 8 and a Python allow-list change.

**Consequences.**
- D4 is amended.
- The M8 light-appearance rows of the matrix are replaced by dark rows, and the contrast pairs are rebaselined.
- Users who prefer light get dark (option (a)).
- Where Inter or Plex isn't installed, the system font shows.

**Gates:** N1. **Status:** Pending (choose (a) or (b)).

## P-12. Re-baselining tests in N1

**Proposed.**
- N1 may **replace or relocate** only assertions that pin the current shell's geometry and placement:
  - the 260px rail and its Channels, Sessions and Members headings
  - the More list
  - the 768px and 1200px breakpoints
  - footer budgets and conversation ratios
  - the matrix layout dimension
- Each one is listed by name, with before and after, in the completion report.
- **Not authorised:** removing or weakening any *behaviour* assertion (counts, paging, waiting invariants, focus, privacy,
  approvals, POST budgets, escaping), any accessibility minimum, any classic test or any Python test.
- **New numeric limits:**
  - phone portrait: conversation at least 55% with the bottom bar shown
  - phone landscape: conversation at least 45%, idle footer at most 72px, waiting footer at most 112px
  - bottom bar at most 64px, hidden while the on-screen keyboard is open

**Consequences.**
- N1 test churn is bounded and reviewable.
- The M8 and M9 behaviour suite carries over.

**Gates:** N1. **Status:** Pending.

## P-13. Vocabulary and routes (amends §11)

**Proposed.**
- "Agent" is adopted (this settles R1's bot-or-agent choice).
- "Workspace" means the project directory.
- Today's per-agent inspection is renamed **Turn details**. Its route `#/w/<run>/<agent>` and its `/classic?popout=` link are
  kept.
- New routes: `#/primary`, `#/agents[/<id>]`, `#/projects` (the same as `#/`), `#/workspace`, `#/skills`, `#/settings`.
  `#/agents/<id>` supersedes the reserved `#/b/…`.
- **`#/` stays the Projects team thread in N1.** Whether to make it Primary is decided when N3 ships.

**Alternative.** `#/` becomes Primary now. Users would land on a screen that can't do anything yet.

**Consequences.**
- Bookmarks keep working.
- Copy changes across the chat.

**Gates:** N1. **Status:** Pending.

## P-14. Precedence of handoff and mock

**Proposed.**
- Where the handoff text and the mock differ, **the handoff wins**. Examples: under 720px a bottom bar with an overlay panel,
  not the mock's 900px top row with a hidden panel; at least one specialist; no fake file list.
- The mock guides visuals only where the handoff is silent. Where both are silent, the existing contract applies.
- **No mock code is reused:** CDN fonts, unescaped `innerHTML`, hard-coded agent messages, `alert()`, sub-40px targets, 3:1
  text.

**Consequences.**
- N1 must design the parts the mock leaves out:
  - the Create agent form (from N2)
  - the five-part Configure screen (from N2)
  - the Skills Assign picker and policy control (from N2)
  - where approval cards appear (N1: unchanged room cards)

**Gates:** N1. **Status:** Pending.

## P-15. Where membership, assignments, policies and memory are stored

**Proposed.**
- The **journal is the source of truth.** Nothing (`team.json`, `room.md`) is written into project folders.
- Any later read-only export must add its paths to the protected patterns (like `permissions.AGENT_CONFIG`) in the same change.

**Alternative.** Files in project folders. They travel with the folder, but agents with editing tools could rewrite their own
membership or permissions, and the files would appear in every diff and Apply.

**Consequences.**
- Project folders stay unchanged.
- Path identity is handled by project ids (architecture §10).

**Gates:** N2. **Status:** Pending.

---

## Open questions (needed before N3, not before N1)

- **Q1.** Is a model registry configured in your deployment (`--models` or `state/models.json`)?
- **Q2.** Which endpoint should Primary use by default?
- **Q3.** What is your projects root?

## Approval record

| Date | Decision | Outcome | Notes |
|---|---|---|---|
| — | — | — | No approvals recorded yet |
