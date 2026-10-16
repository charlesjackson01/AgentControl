# AgentControl — Backend

Fastify + TypeScript API for AgentControl. No database: state lives in a JSON
store plus an encrypted key vault under `data/`.

## Commands

```sh
npm install
npm run dev      # tsx watch on http://127.0.0.1:3001
npm run build    # tsc -> dist/ and copy SKILL.md seeds (cross-platform)
npm start        # node dist/index.js
npm test         # vitest (hermetic, no network)
npm run typecheck
```

## Configuration (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address. Loopback only by default. |
| `PORT` | `3001` | Listen port. |
| `CORS_ORIGINS` | *(reflect request origin)* | Comma-separated allowlist to pin CORS. |
| `AGENTCONTROL_AUTH_TOKEN` | *(unset)* | When set, every `/api/*` call requires `Authorization: Bearer <token>` (401 otherwise). `/health` stays open. |
| `AGENTCONTROL_DATA_DIR` | `<cwd>/data` | Directory holding `store.json` and the vault. |
| `AGENTCONTROL_PROJECTS_DIR` | `<data dir>/projects` | Root for project folders (created on project create, kept on delete). |
| `AGENTCONTROL_SECRET` | *(unset)* | Master key for the vault (`sha256(secret)`). When unset, a random key is kept DPAPI-wrapped in `vault.key`. |

Per-endpoint upstream timeout is configurable on the endpoint itself
(`timeoutMs`, defaults to `30000`), which matters for slow reasoning models.
Every agent runs on an endpoint — there is no hosted-model fallback.

## Remote access (Tailscale / LAN)

The default `HOST=127.0.0.1` means the API is reachable only from the machine
it runs on. To use the web app from another device — e.g. over Tailscale at
`100.110.232.85` — bind all interfaces **and set a token**, since a public bind
exposes the API (including stored keys' use) to the network:

```powershell
$env:HOST = '0.0.0.0'
$env:AGENTCONTROL_AUTH_TOKEN = '<long-random-string>'   # recommended
npm run dev
```

Then point the frontend at it, e.g. `VITE_API_BASE=http://100.110.232.85:3001`
(and restart the Vite dev server). CORS reflects the request origin by default,
so no extra CORS config is needed for a different host. The frontend sends the
token when `VITE_AUTH_TOKEN` is set in its `.env.local`.

## Data at rest

- `data/store.json` — workspace state. **No secrets.**
- `data/vault.enc` — endpoint API keys, AES-256-GCM.
- `data/vault.key` — DPAPI-wrapped master key (Windows).

`data/` is gitignored except `data/store.example.json`, which is the committed
shape of the store.

## API surface

- `GET /api/skills`, `GET /api/projects`, `GET /api/settings`. There is no global
  model catalog: model choice comes from `GET /api/endpoints/:id/models`.
- Agents: `GET/POST /api/agents`, `GET/PUT/DELETE /api/agents/:id`. Every agent
  requires an `endpointId` (400 otherwise); exactly one agent is `isPrimary`
  (the Team Lead) and its endpoint is the workspace default. Creating a second
  primary or deleting the primary → 409.
- Runs: `POST/GET /api/agents/:id/runs` (the agent's own chat, newest-first, capped at 50), `DELETE /api/agents/:id/runs` (clear chat history).
  `POST` assembles multi-turn context: system prompt + the agent's last 10 successful
  runs as user/assistant pairs + the new input (failed runs excluded). Project task
  runs are kept apart: they never show in or count against the agent's chat (50
  kept per agent per project), and clearing the chat leaves them.
- Projects: `GET/POST /api/projects`, `PATCH/DELETE /api/projects/:id`,
  `GET/POST /api/projects/:id/messages`. `POST /api/projects/:id/team-plan`
  `{ messageId } | { prompt }` asks the Team Lead for a plan and returns
  `{ plan, replyTo? }` without writing anything; `POST /api/projects/:id/team-plan/apply`
  `{ plan, replyTo?, add?, create?, tasks?, round? }` validates the plan again and
  commits the accepted part (reply, team update, task assignments), then runs the
  tasks one at a time per project. Apply may carry `round` after a review (at most
  5 rounds per request; a `verdict` of `done` or `ask` with no tasks closes the
  request). `POST /api/projects/:id/review` `{ promptId }` asks Primary to review a
  settled round and returns `{ plan, replyTo, round }` without writing anything
  (409 when the round is still open or the request is closed). Work controls:
  `POST .../work/pause`, `/work/resume`, `/work/stop`;
  `POST .../tasks/:messageId/cancel` (also cancels non-done dependents) and
  `/retry` (failed or cancelled). `GET /api/projects/:id/runs/:runId` returns one
  project task `AgentRun` (404 for chat-only runs or another project's run; never
  exposes vault secrets). User messages may include `mentions` (agent ids); tagging
  team members (not Primary) queues one direct task per tagged member.
- `POST /api/prompt-budget` `{ endpointId, skillIds, instructions? }` →
  `{ contextWindow, responseReserve, estimatedTokens, mode, summarizedSkillIds, toolNames }`:
  the prompt plan a run would use (see *Skills that don't fit* below), without
  calling the endpoint. The agent form uses it to show the prompt size.
- Endpoints: `GET/POST /api/endpoints`, `PATCH/DELETE /api/endpoints/:id`
  (`DELETE` returns `{ ok, reassignedAgents }`, moving attached agents to the
  Team Lead's endpoint; deleting the Team Lead's own endpoint → 409),
  `GET /api/endpoints/:id/models`, `POST /api/endpoints/:id/test`

## Skills and tools

The library ships six vendored skills (bodies unchanged; only their `tools:`
frontmatter is ours) and twelve AgentControl skills, and every one of them
declares tools. `GET /api/tools` serves canonical declarations for 24 built-in
tools across workspace, notes, time, math, text, and data modules. Skills declare tool names;
only attached registry tools are offered to the model and allowed to execute.
Legacy unknown declarations remain stored but are not executable. SKILL.md
imports accept inline or block `tools:` lists, ignore comments outside quotes,
and return unknown names in `ignoredTools`.

Text tools accept `@input` (current user message) and `@note:<id or title>`.
Note references require the `read_note` capability. JSON/CSV references select
the first fenced block when present. Tools operate locally: they cannot access
files, execute code, contact services, or schedule reminders. Output is bounded;
tool results redact configured endpoint keys and the API auth token, and text
pulled in by `@input`/`@note:` is redacted before a tool sees it, so counts and
match flags cannot probe a stored secret. Conventional placeholder keys for
local servers (`EMPTY`, `none`, `ollama`, …) and values under 3 characters are
not treated as secrets.

`get_skill` and `read_note` return long text in pages (pass `nextOffset` to
continue). Both redact the whole text before paging, so a secret that straddles
a page edge is still caught; every tool that clips user-written text redacts it
first for the same reason. `encode_text` redacts decoded text and never renders
bytes that are not valid UTF-8 (it returns their count and sha256 instead).

Seed skills a store already holds are upgraded once when their shipped
definition changes (`seed-skill-upgrade-v2`, `seed-skill-upgrade-v3`), but only
while they still match the previous definition exactly (body sha256 and tool
list); a skill you edited, cleared or deleted is left as it is. To customize a
built-in skill and keep receiving upgrades of the original, duplicate it in the
Skill Library. Caveat: a vendored skill whose tools you cleared looks the same
as one shipped without tools, so v3 gives it its new tools once.

### Skills that don't fit

A run puts each attached skill's full text in the system prompt whenever the
prompt plus the 4,096-token reply reserve fits the endpoint's context window
(estimated at 4 chars per token); that prompt is the same, byte for byte, as
before summaries existed. Only a prompt that would not fit has its largest
skills sent as short summaries (name, description, and an instruction to call
`get_skill`), summarizing until 1,024 tokens of headroom are also free, and
`get_skill` is offered so the model reads a summarized skill when it needs it.
A summary plan that would not be smaller than the full prompt is not used.
When the planner adds `get_skill` itself, it reads only the agent's own
skills. `get_skill` and `read_note` size each page to the room the run has left,
so a page is never cut mid-JSON; when there is no room they say so. The run
audit records each skill's `mode` (`full` or `summary`). A run is rejected with
413 only when even the summarized prompt plus the reply reserve exceeds the
window; the message gives the numbers.

`save_note` creates or updates shared workspace notes. Only the creating agent
may replace a note; other agents may append body text. Limits are four writes
per run, 200 notes per workspace, 20,000 characters per body, ten tags of up to
40 characters, and titles up to 160 characters. Read-only tools never write.

- `GET /api/notes`: summaries with snippets and author names.
- `GET /api/notes/:id`: full note body and provenance.
- `DELETE /api/notes/:id`: user deletion (204), or 500 if persistence fails.

These routes use the same bearer authentication as other API routes. Notes
survive restart, while seed migration tracking preserves edited skills and
keeps deleted seeds deleted. Workspace snapshots are replaced atomically after
vault writes succeed. The two files are not a database transaction.

See [recovery and verification notes](../docs/skills-library-recovery.md) for
the recovered state, tool/skill inventory, review findings, and smoke test.
