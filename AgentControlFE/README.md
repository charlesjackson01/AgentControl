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
forwards to `http://localhost:3001` — requests are same-origin, so no CORS is
involved. The API base lives in `src/lib/api.ts`:

- dev: relative `/api` (via the proxy)
- prod: `http://<window hostname>:3001` — follows however the app was opened
  (localhost, LAN IP, Tailscale IP); override with `VITE_API_BASE`

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

Endpoint keys entered in the UI (Settings → Endpoints) are **not** stored in
`store.json`. They live in an encrypted vault (`data/vault.enc`, AES-256-GCM):

- Set `AGENTCONTROL_SECRET` to derive the vault master key from the environment
  — recommended for deployments.
- Without it, Windows uses a DPAPI-protected `data/vault.key` (current user
  only). Non-Windows (or DPAPI failure) falls back to a plain key file with a
  startup warning.

The browser never sees endpoint keys and never calls endpoint `baseUrl`
directly — all upstream calls (model discovery, chat completions) are proxied
server-side.

## Workspace data

`AgentControlBE/data/store.example.json` is the seed template: copy it to
`data/store.json` to start from the example workspace, or delete `data/store.json`
to reseed on next boot. Everything else under `data/` (`store.json`,
`vault.enc`, `vault.key`) is gitignored and machine-local.
