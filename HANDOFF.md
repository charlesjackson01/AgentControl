# AgentControl — Handoff for Claude (Opus)

> **Read this first.** This is a working, tested app. The bar is: keep the
> existing tests green (`npm test` in `AgentControlBE`, 54 passing), keep
> typecheck green in both packages, and make additive changes. Prefer small,
> verified, committed steps over big rewrites. Every claim below is grounded in
> the current tree at commit `43faced`.

## What this is

A local dashboard + control plane for running **agents** against **your own
model endpoints** (llama.cpp / vLLM via OpenAI-compatible, or OpenRouter). There
is **no hosted-model fallback** — every agent is bound to an endpoint. One agent
is the `isPrimary` "Team Lead"; its endpoint is the workspace default.

Two packages, no database:

- **`AgentControlBE`** — Fastify 5 + TypeScript API. State is a JSON store plus an
  AES-256-GCM key vault, both under `data/` (gitignored except the seed example).
- **`AgentControlFE`** — React 19 + TypeScript + Vite 8 console.

## Repo layout

```
.gitignore
AgentControlBE/            # Fastify API
  src/app.ts               # route definitions + all business logic (read this)
  src/upstream.ts          # endpoint chat calls, model discovery, per-endpoint timeout
  src/tools.ts             # built-in workspace tools (server-side execution)
  src/store.ts             # JSON store load/save
  src/vault.ts             # endpoint apiKey encryption (AES-256-GCM)
  src/db/seed.ts           # seed skills + reconcile-missing logic
  src/shared/types.ts      # shared types
  src/app.test.ts          # vitest suite (hermetic, no network)
  data/store.example.json  # committed seed shape of the store
AgentControlFE/            # React console
  src/lib/api.ts           # all API calls (thin fetch wrappers) — the FE contract
  src/lib/types.ts         # FE types (frozen contract with BE)
  src/pages/*              # Agents, AgentChat, SkillLibrary, Projects, Settings, Bootstrap
  src/components/*         # AppShell, AgentForm, SettingsDrawer, dialogs
```

## How to run (verified)

Two terminals. Ports: **BE 3001**, **FE dev 5173**, **FE preview 4173**.

```bash
# Terminal 1 — backend
cd AgentControlBE
npm install
npm run dev        # tsx watch, http://127.0.0.1:3001

# Terminal 2 — frontend
cd AgentControlFE
npm install
npm run dev        # Vite, http://localhost:5173
```

- **Dev:** the FE sends `/api/*` to Vite's dev proxy → `http://localhost:3101`
  (see `AgentControlFE/vite.config.ts`). Same-origin, so **no CORS** in dev.
- **Preview/prod:** `npm run serve` builds and serves on `100.110.232.85:4173`;
  the preview inherits the same proxy, so it also stays same-origin.
- **Auth:** set `AGENTCONTROL_AUTH_TOKEN` on the BE (loopback-only by default;
  required if you bind `0.0.0.0`). On the FE set `VITE_AUTH_TOKEN` in
  `.env.local` (embedded in the bundle at build). Leave both empty for local
  unauthenticated use.
- **Fresh start:** copy `AgentControlBE/data/store.example.json` → `store.json`,
  or delete `store.json` to reseed on next boot.

### Verify it works (run these before claiming a change is done)

```bash
cd AgentControlBE && npm run typecheck && npm test          # expect 54 passing
cd AgentControlFE && npm run typecheck && npm run build     # expect clean
```

## Architecture

**Backend (Fastify):** single process, in-memory store + file persistence.
Key invariants that tests enforce:

- Every agent **requires** an `endpointId` (400 otherwise).
- **Exactly one** agent is `isPrimary` (the Team Lead). Creating a second primary
  or deleting the primary → **409**. The primary's endpoint is the workspace
  default endpoint.
- **Runs** (`POST /api/agents/:id/runs`) assemble multi-turn context: system
  prompt + the agent's last **10 successful** runs as user/assistant pairs + the
  new input. **Failed runs are excluded.** A context-budget check runs **before**
  the upstream call (commit `40d728a`).
- **Tools:** the BE executes built-in workspace tools server-side during a run
  (commit `19dc871`) and records an audit array on the run:
  `toolCalls?: { name, arguments, resultChars, ok }[]`. Unknown tool names are
  recorded with `ok:false` and do **not** crash the run.
- **Endpoints:** `DELETE` returns `{ ok, reassignedAgents }` and moves attached
  agents to the Team Lead's endpoint; deleting the Team Lead's own endpoint → 409.
  Per-endpoint live model discovery: `GET /api/endpoints/:id/models`,
  `POST /api/endpoints/:id/test`. Per-endpoint `timeoutMs` (default 30000) for
  slow reasoning models.
- **CORS:** `allowedMethods = GET, HEAD, PUT, POST, OPTIONS, PATCH, DELETE` —
  PUT/DELETE are allowed (there is a test for the cross-origin preflight).

**Frontend (React):** all data flows through `src/lib/api.ts` (no local
persistence, no key vault — the server store is the source of truth). Pages:
Agents (list + chat-first detail), Skill Library (search/filter/detail/import),
Projects, Settings (endpoints + keys), Bootstrap (empty-store onboarding).

**API surface** (condensed — full routes in `AgentControlBE/src/app.ts`):

```
GET /health                                   # open, no auth
GET /api/models  GET /api/skills  GET /api/projects  GET /api/settings
GET/POST /api/agents                          GET/PUT/DELETE /api/agents/:id
POST/GET /api/agents/:id/runs                 DELETE /api/agents/:id/runs   # clear history
GET/POST /api/endpoints                       PATCH/DELETE /api/endpoints/:id
GET /api/endpoints/:id/models                 POST /api/endpoints/:id/test
GET/POST/PATCH/DELETE /api/skills(:id)        POST /api/skills/import
```

## State as of `43faced` (what's done, with SHAs)

| Area | Commit(s) |
| --- | --- |
| Required endpoints + primary Team Lead agent | `906f4fc`, FE `61583a7` |
| Agent `role` field | BE `317039b`, FE `befefb6` |
| Fresh installs seed zero agents | BE `162f607`, FE `222c2b6` |
| CORS allows PUT/DELETE (cross-origin preflight test) | FE `423d62e` |
| Multi-turn chat context + clear-history route | BE `57245e3` |
| Auth token + loopback default + per-endpoint timeout | BE `bef9298` |
| Bearer auth, env.example, README | `8632cdf` |
| Runs capped at 50, hermetic vitest suite | BE `e6d4553` |
| Skill library CRUD + SKILL.md import | BE `eaaa6cb`, FE `1ace7c8` |
| Context budget before upstream calls | BE `40d728a` |
| Audit fields on run records | BE `7a166ff` |
| System prompt disclosure on chat turns | FE `9675169` |
| Production preview serving + relative API base | FE `c17e541`, `d7c5849`, `3ae54cf` |
| **Tool execution loop (BE) + tool-call audit in chat (FE)** | BE `19dc871`, FE `43faced` |
| **Skill Library search / tag filter / detail view** | FE `0d751a3` |

## What's genuinely open (verify before touching)

1. **FE README is stale.** `AgentControlFE/README.md` says the dev proxy targets
   `:3001`, but `vite.config.ts` actually proxies to `:3101`. It also still
   documents "hosted agents" (`HOSTED_BASE_URL` / `HOSTED_API_KEY`), which the BE
   **no longer has** — every agent needs an endpoint now. Fix the README to match
   the code, not the other way around.
2. **Seeded model catalog.** `store.example.json` still seeds a `models` array
   (Claude/GPT/Llama/etc.) even though per-endpoint live discovery exists
   (`endpointModels`). Decide: keep it as a display-only fallback, or remove it
   so model choices come from `GET /api/endpoints/:id/models`. This was an
   original goal ("replace seeded catalog with live discovery") and is only
   *partially* done.
3. **No CI.** There is no `.github/workflows` in the tree. A minimal workflow
   running BE `typecheck`+`test` and FE `typecheck`+`build` on push is a low-risk
   win.
4. **`role` field surfacing.** BE has it (`317039b`); confirm the FE AgentForm
   actually lets you set/read it end-to-end before calling it done.

## Gotchas / conventions (operational, learned the hard way)

- **Redaction in tooling.** When a secret is passed through a CLI that echoes
  output, it may come back as a literal `[REDACTED]` placeholder. Don't assume
  the value you *see* is the value that was *sent*. Verify lengths.
- **Windows Git credential manager (GCM) under non-interactive SSH** intercepts
  before the `store` helper and can't persist there. The reliable push form is a
  token-embedded URL. (Already configured on this machine's `rogxboxallyx`.)
- **Tokens are gitignored.** `.gitignore` covers `.env`, `data/*` (except the
  example), `*.log`, `node_modules/`, `dist/`. Don't commit `store.json`, the
  vault, or a token. `data/vault.key` is DPAPI-wrapped and machine-bound.
- **Tests are hermetic** — no network. If you add a feature, add a hermetic test
  for its invariants (especially the 409 primary / 400 endpointId / tool-audit
  paths).
- **Keep the FE contract frozen** (`src/lib/types.ts`). Additive changes are fine;
  breaking renames ripple across every page.

## Suggested next task (if you want one)

Close open item #2 (live model discovery as the single source of truth for model
choice) **or** add the CI workflow (#3). Both are additive, verifiable, and low
risk. Pick one, run the full verify block above, and commit with a message that
matches the existing `type(scope): summary` convention.
