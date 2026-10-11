# AgentControl (frontend)

React 19 + TypeScript + Vite console for managing agents, projects, skills, and
self-hosted model endpoints. Talks to the Fastify backend in `../AgentControlBE`.

## Development

Run the backend and the frontend in two terminals:

```bash
# terminal 1 — backend (http://localhost:3001)
cd ../AgentControlBE
npm run dev

# terminal 2 — frontend (http://localhost:5173)
npm run dev
```

In dev the FE sends `/api/*` to Vite's dev proxy (see `vite.config.ts`), which
forwards to `http://localhost:3001` (the BE's default `PORT`; override with
`AGENTCONTROL_API_TARGET`) — requests are same-origin, so no CORS is
involved. The API base lives in `src/lib/api.ts`:

- dev: relative `/api` (via the proxy)
- prod: `http://<window hostname>:3001` — follows however the app was opened
  (localhost, LAN IP, Tailscale IP); override with `VITE_API_BASE`

## Runtime config (`.env` / `.env.local` — never commit these)

| Variable | Purpose | Example |
| --- | --- | --- |
| `VITE_API_BASE` | Override the API base (dev: relative `/api` via the proxy; prod: the backend host). | `http://192.168.1.20:3001` |
| `VITE_AUTH_TOKEN` | Bearer token sent with every request as `Authorization: Bearer <token>`. Leave empty for unauthenticated use. | `sk-xxxx` |
| `AGENTCONTROL_API_TARGET` | Where the dev/preview proxy forwards `/api` (config-only, not in the bundle). Defaults to `http://localhost:3001`. | `http://localhost:3101` |

> Copy `.env.example` to `.env.local` and fill in values; the file is gitignored.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with HMR on :5173 |
| `npm run build` | `tsc -b` + production bundle to `dist/` |
| `npm run preview` | Serve the built `dist/` (no proxying, no HMR) |
| `npm run typecheck` | `tsc -b --noEmit` |
| `npm run lint` | Oxlint |

## Backend environment

Hosted agents (no endpoint attached) run against an OpenAI-compatible chat
service configured on the **backend**:

| Variable | Purpose |
| --- | --- |
| `HOSTED_BASE_URL` | OpenAI-compatible base URL for hosted agents, e.g. `https://api.openai.com/v1` or an internal gateway. Runs fail with a clear error when unset. |
| `HOSTED_API_KEY` | Bearer key sent to `HOSTED_BASE_URL`. |

## Secret handling

| Variable | Purpose |
| --- | --- |
| `AGENTCONTROL_SECRET` | Vault master key for endpoint (apiKey) storage on the **backend**. The OpenRouter/llama.cpp `apiKey` entered in Settings is write-only — the FE holds no key, and reads expose only `apiKeySet`. Without it, the BE falls back to DPAPI on Windows. |

## Workspace data

`AgentControlBE/data/store.example.json` is the seed template: copy it to
`data/store.json` to start from the example workspace, or delete `data/store.json`
to reseed on next boot. Everything else under `data/` is gitignored and machine-local.
