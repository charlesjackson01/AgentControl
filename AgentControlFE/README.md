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
involved. The API base lives in `src/lib/api.ts`: it is a relative `/api` in
both dev and preview (`vite preview` inherits the same proxy), so the app is
always single-origin. Set `VITE_API_BASE` only when the BE lives on another
host; requests then go cross-origin and the BE's CORS applies.

## Runtime config (`.env` / `.env.local` — never commit these)

| Variable | Purpose | Example |
| --- | --- | --- |
| `VITE_API_BASE` | Override the API base. Leave unset to use the relative `/api` proxy. | `http://192.168.1.20:3001` |
| `VITE_AUTH_TOKEN` | Bearer token sent with every request as `Authorization: Bearer <token>`. Leave empty for unauthenticated use. | `sk-xxxx` |
| `AGENTCONTROL_API_TARGET` | Where the dev/preview proxy forwards `/api` (config-only, not in the bundle). Defaults to `http://localhost:3001`. | `http://localhost:3101` |

> Copy `.env.example` to `.env.local` and fill in values; the file is gitignored.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with HMR on :5173 |
| `npm run build` | `tsc -b` + production bundle to `dist/` |
| `npm run preview` | Serve the built `dist/` on :4173 with the same `/api` proxy (no HMR) |
| `npm run serve` | `build` + `preview` bound to `100.110.232.85:4173` (a machine-specific Tailscale address; edit for your host) |
| `npm run typecheck` | `tsc -b --noEmit` |
| `npm run lint` | Oxlint |
| `npm test` | Hermetic parser parity, SKILL.md export round trip, tool selection, skill and note search, and prompt-size message tests (Node 22.6+) |

## Skills and notes

The Skill Library editor loads built-in tools from `GET /api/tools`. Select up to
16 per skill, review their read/write effects, and remove selected tools with
their chips. Existing declarations unavailable in the current registry stay
attached until explicitly removed. Import previews show recognized SKILL.md
`tools:` entries and identify declarations the backend will ignore.

Library search also matches the tools a skill declares (e.g. `csv_summary`).
A skill's view dialog can **Export** it as `<id>.md` — a SKILL.md file with
`name`, `description`, `tag` and `tools` frontmatter that Import SKILL.md reads
back (frontmatter values are not unquoted, so line breaks fold to a space and a
`#` that would start a comment is written as a fullwidth `＃`) — and
**Duplicate** it as "<name> (copy)" through the regular create API. Built-in
skills (those with a `source`) say that editing them stops future built-in
upgrades; duplicate one to customize it.

The agent form lists the tools the selected skills grant and a prompt-size line
from `POST /api/prompt-budget` (debounced; stale or failed requests are ignored):
whether the instructions and skills fit the endpoint's context window in full,
which skills go in as short summaries the agent reads with `get_skill`, or that
runs will be rejected. A chat turn's run audit marks skills that were sent as
summaries.

**Notes** lists shared notes written by agents, newest update first. Search
covers titles, tags, authors, and visible snippets; open a note for its full
body. Deletion requires confirmation and permanently removes the shared note.
Agent-written note content is displayed as text, without rendering HTML.

## Backend

Every agent runs on an endpoint configured in **Settings** — llama.cpp / vLLM
(OpenAI-compatible) or OpenRouter. There is no hosted-model fallback. Backend
environment variables (`HOST`, `PORT`, `AGENTCONTROL_AUTH_TOKEN`, …) are
documented in [`../AgentControlBE/README.md`](../AgentControlBE/README.md).

## Secret handling

| Variable | Purpose |
| --- | --- |
| `AGENTCONTROL_SECRET` | Vault master key for endpoint (apiKey) storage on the **backend**. The OpenRouter/llama.cpp `apiKey` entered in Settings is write-only — the FE holds no key, and reads expose only `apiKeySet`. Without it, the BE keeps a random key in `data/vault.key` — DPAPI-wrapped on Windows, stored unencrypted (with a warning) elsewhere. |

## Workspace data

`AgentControlBE/data/store.example.json` is the seed template: copy it to
`data/store.json` to start from the example workspace, or delete `data/store.json`
to reseed on next boot. Everything else under `data/` is gitignored and machine-local.
