# AgentControl — Backend

Fastify + TypeScript API for AgentControl. No database: state lives in a JSON
store plus an encrypted key vault under `data/`.

## Commands

```sh
npm install
npm run dev      # tsx watch on http://127.0.0.1:3001
npm run build    # tsc -> dist/
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
| `HOSTED_BASE_URL` / `HOSTED_API_KEY` | *(unset)* | Transport for runs on hosted models (`endpointId: null`). Without it, hosted runs record a clear failure. |
| `HOSTED_TIMEOUT_MS` | `30000` | Default upstream timeout for hosted runs. |

Per-endpoint upstream timeout is configurable on the endpoint itself
(`timeoutMs`, defaults to `30000`), which matters for slow reasoning models.

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
so no extra CORS config is needed for a different host. **Frontend support for
sending the bearer token is not wired up yet**, so leave the token unset until
that lands, or the FE will get 401s.

## Data at rest

- `data/store.json` — workspace state. **No secrets.**
- `data/vault.enc` — endpoint API keys, AES-256-GCM.
- `data/vault.key` — DPAPI-wrapped master key (Windows).

`data/` is gitignored except `data/store.example.json`, which is the committed
shape of the store.

## API surface

- `GET /api/models`, `GET /api/skills`, `GET /api/projects`, `GET /api/settings`
- Agents: `GET/POST /api/agents`, `GET/PUT/DELETE /api/agents/:id`
- Runs: `POST/GET /api/agents/:id/runs` (newest-first, capped at 50)
- Endpoints: `GET/POST /api/endpoints`, `PATCH/DELETE /api/endpoints/:id`
  (`DELETE` returns `{ ok, reassignedAgents }`, moving attached agents to hosted),
  `GET /api/endpoints/:id/models`, `POST /api/endpoints/:id/test`
