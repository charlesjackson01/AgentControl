# Projects — implementation handoff (draft)

Status: APPROVED FOR IMPLEMENTATION (2026-10-12). Skills work merged to
master (PR #5). D-P1, D-P2, D-P3 confirmed as recommended — see below.

Progress (2026-10-13): Part 0 on master (PR #6). Part 1 routes in PR #7.
Part 1 chat page, Part 2 and Part 3 on `feat/projects-chat` (stacked on PR #7
and PR #8); see "Implementation notes" at the end.

## Goal

Projects becomes a real feature instead of a hardcoded frontend stub. A
project has a folder owned by AgentControl, a team of agents, and its own
chat. The Primary agent assembles or extends the team when a prompt needs
specialties the project doesn't have.

## Workflow (owner-approved, 2026-10-12)

1. Click New Project, give it a name. AgentControl creates its folder.
2. Optional: add agents — pick from the library or create specialists.
   The team may be left empty.
3. Open Project Chat — the project's conversation opens with Primary
   available.
4. User enters a prompt describing what to build or accomplish.
5. Primary checks the team:
   - Team assembled: Primary evaluates members and assigns tasks.
   - No team: Primary analyzes the prompt and creates project-scoped
     specialists, then assigns tasks.
   - Team missing a specialty: Primary recommends adding another agent.
6. Work begins — agents communicate, delegate, and report progress in the
   project chat while the user oversees.

## Decisions (all confirmed by owner, 2026-10-12)

- D-P1: Primary's team picks and new-specialist creations are shown to
  the user for confirmation before tasks are assigned (matches the
  repo's approval-gate culture). Recommended: yes, confirm-first.
- D-P2: Project-scoped specialists are library agents flagged
  `projectId` (visible in the library, tagged to the project) vs. hidden
  private agents. Recommended: library agents with a project tag, so
  they're reusable and auditable.
- D-P3: Project chat scope. Notes stay workspace-wide for now; project
  chat is a separate message thread per project, not a notes scope.
  Recommended: yes, defer per-project notes to a later milestone.

## Data model

Project (shared/types.ts) becomes:

```
interface Project {
  id: string
  name: string
  desc: string
  folder: string          // absolute path under the projects root
  teamAgentIds: string[]  // empty allowed
  createdAt: string
  updatedAt: string
}
```

- Projects root: `AC_PROJECTS_DIR` env var, default
  `~/.agentcontrol/projects`. Folder name: slugified project name,
  collision-suffixed. Created with `mkdir -p` on project create; never
  deleted on project delete (folder removal is an explicit user action
  in a later milestone).
- Store: add `projectChats: Record<projectId, ProjectMessage[]>` or a
  flat `projectMessages` array — pick flat, mirrors `runs`.
- ProjectMessage: `{ id, projectId, author: 'user' | agentId, text,
  createdAt, kind?: 'message' | 'team-update' | 'task-assignment' }`.
- Agent gets optional `projectId?: string` (D-P2).

## Backend (app.ts, store.ts, seed.ts)

- `GET /api/projects` — already exists; shape changes (add folder,
  teamAgentIds). Bump store schema version; migrate legacy rows
  (folder = root + slug, teamAgentIds = []).
- `POST /api/projects` — `{ name, desc?, teamAgentIds? }`. Validates
  name (non-empty, unique), creates the folder, returns the project.
- `PATCH /api/projects/:id` — rename (does NOT move the folder), desc,
  teamAgentIds.
- `DELETE /api/projects/:id` — removes the record and its chat; leaves
  the folder on disk.
- `GET /api/projects/:id/messages` and
  `POST /api/projects/:id/messages` — chat read/append.
- Team assembly (the interesting part):
  `POST /api/projects/:id/team-plan` with the user's prompt. Runs the
  Primary agent (same upstream path as agent runs) with a fixed
  assembler prompt: given the prompt + library roster (name, role,
  description, skills), return JSON `{ add: [agentId...], create:
  [{name, role, instructions, reason}...], tasks: [{agentId,
  task}...] }`. Validate strictly; on parse failure return a clear
  error, no partial writes.
  - `create` entries become real library agents flagged with projectId
    (D-P2), using Primary's endpoint/model defaults.
  - This endpoint returns a PLAN; it does not mutate. A follow-up
    `POST /api/projects/:id/team-plan/apply` commits it (D-P1).
- Task assignment itself stays simple for this milestone: tasks are
  posted into the project chat as `task-assignment` messages and each
  assigned agent is run via the existing run path with the task as
  input; outputs post back to the chat. No new orchestrator.

## Frontend

- Projects.tsx: replace the hardcoded array with `GET /api/projects`;
  tiles show name, desc, team count, folder (mono), updated. Empty
  state + error state via States.tsx.
- New Project dialog: name (required), desc, agent multi-picker from
  the library (empty allowed). Calls POST, then navigates to the chat.
- Project chat page `/projects/:id`: thread view (reuse AgentChat
  patterns), composer, team strip listing members with add/remove.
  "Ask Primary to build a team" button appears when the team is empty
  or the user clicks it; renders the plan as a confirm card (add /
  create / tasks) with Apply / Cancel.
- nav.ts unchanged (Projects already in nav).

## Tests

- BE: project CRUD incl. folder creation, legacy migration, team-plan
  JSON validation (fixture upstream like existing run tests), apply
  semantics, chat append/read.
- FE: keep the existing contract-comment style; projects list renders
  from API, New Project flow, plan confirm card.

## Out of scope (later milestones)

- Inter-agent delegation loops / real orchestration.
- Per-project notes scope.
- Folder browsing UI and folder deletion.
- Budgets/schedules per project.

## Sequencing

1. Merge skills-library work first (blocks this).
2. Part 0: data model + store migration + CRUD + folder creation.
3. Part 1: project chat endpoints + FE chat page.
4. Part 2: team-plan assembler + confirm card + apply.
5. Part 3: polish, empty states, screenshots, HANDOFF.md update.

## Implementation notes (feat/projects-chat)

What was built, where it differs in detail from the plan above:

- `POST /api/projects/:id/team-plan` takes `{ messageId }` (a user message
  in the project chat, whose text is the prompt) or `{ prompt }`, and returns
  `{ plan, replyTo? }`. It writes nothing, for every kind of plan. Primary is
  called on its own endpoint and model with no tools and temperature 0.2; the
  answer is parsed leniently and validated strictly (unknown or duplicate
  agents, names that collide with existing agents, unknown skills and
  oversized lists are dropped with plain-language warnings; injected fields
  are ignored). Invalid output is a 502, no Primary a 409.
- `POST /api/projects/:id/team-plan/apply` takes the confirmed plan back with
  an optional selection (`add` ids, `create`/`tasks` indexes), validates it
  again as untrusted input, then records Primary's reply (a `message`), a
  `team-update`, and one `task-assignment` per task. Cancel is client-side.
  Every plan, including one that only assigns tasks, waits for Apply (D-P1).
- Created specialists are library agents with `projectId` on Primary's
  endpoint and model (D-P2); deleting the project untags them.
- Tasks run one at a time per project through the same run path as agent
  chat; each result is a `message` from the assignee with `taskId`, `runId`
  and `taskStatus`. Failed tasks can be retried
  (`POST /api/projects/:id/tasks/:messageId/retry`); tasks interrupted by a
  restart are marked failed on startup. Project task runs only see earlier
  runs of the same project as history and never appear in the agent's own
  chat; runs are kept 50 per agent per scope.
- Frontend: `/projects/:id` with the team strip ("Ask Primary to build a
  team" while the team is empty), the plan confirm card, task rows with
  status and Retry, and polling while tasks run. Screenshots in
  `docs/projects-screenshots/`.
