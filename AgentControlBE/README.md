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
- Runs: `POST/GET /api/agents/:id/runs` (newest-first, capped at 50), `DELETE /api/agents/:id/runs` (clear chat history).
  `POST` assembles multi-turn context: system prompt + the agent's last 10 successful
  runs as user/assistant pairs + the new input (failed runs excluded).
- Endpoints: `GET/POST /api/endpoints`, `PATCH/DELETE /api/endpoints/:id`
  (`DELETE` returns `{ ok, reassignedAgents }`, moving attached agents to the
  Team Lead's endpoint; deleting the Team Lead's own endpoint → 409),
  `GET /api/endpoints/:id/models`, `POST /api/endpoints/:id/test`

## Skills and tools

The library ships six unchanged vendored skills and ten AgentControl skills.
`GET /api/tools` serves canonical declarations for 16 built-in tools across
workspace, notes, time, math, text, and data modules. Skills declare tool names;
only attached registry tools are offered to the model and allowed to execute.
Legacy unknown declarations remain stored but are not executable. SKILL.md
imports accept inline or block `tools:` lists, ignore comments outside quotes,
and return unknown names in `ignoredTools`.

Text tools accept `@input` (current user message) and `@note:<id or title>`.
Note references require the `read_note` capability. JSON/CSV references select
the first fenced block when present. Tools operate locally: they cannot access
files, execute code, contact services, or schedule reminders. Output is bounded;
tool results redact configured endpoint keys and the API auth token.

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
