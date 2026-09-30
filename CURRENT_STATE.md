# Current state

**Last updated:** 2026-09-30, by Opus (architecture and planning session).
**Rule:** every session that changes the redesign updates this file before it pushes. Keep it short and true.
History belongs in git, and rules belong in `docs/REDESIGN_ARCHITECTURE.md`.

## Where things are

| | |
|---|---|
| Working branch | `feature/chat-first-redesign`. All redesign work goes here; **never merge into `main`** |
| `main` | `9c20d73`, untouched by the redesign |
| Backend source | merged from `claude/gifted-fermi-rcas2a` @ `967aa85` in merge commit `af4da89` (61 commits: engine M0–M13, Workspaces W0–W6, Jev stuck watch) |
| Architecture (binding) | `docs/REDESIGN_ARCHITECTURE.md` |
| Detailed plan and rationale | `docs/CHAT-FIRST-PLAN.md` |
| Handoffs | `docs/handoffs/`. The next one is **`M1_APP_SHELL.md`** |
| Earlier design docs | `docs/MULTI-AGENT-PLAN.md`, `docs/UI-UX-AUDIT.md`, `docs/W7LiveEvents.md`, `docs/M0-SPIKE-REPORT.md` |

## Redesign progress

| Milestone | Status | Owner | Notes |
|---|---|---|---|
| Planning: decisions D1–D5 | ✅ done | Opus | recorded in the architecture doc §2 |
| D1 backend merge | ✅ done | Opus | `af4da89`; tree = `967aa85` + redesign docs |
| **M1 App shell** | ⏭ ready to start | Astra | `docs/handoffs/M1_APP_SHELL.md` |
| M2 Thread read model | not started | | may run in parallel with M1; handoff not written yet |
| M3–M9 | not started | | see architecture §12 |

No redesign UI code exists yet. `agent-autonomy/chat/` does not exist.

## Test baseline (at `af4da89`, verified 2026-09-30)

| Suite | Command | Result |
|---|---|---|
| Backend (Python) | `python3 -m unittest discover -s agent-autonomy/tests` | **347 tests, OK (6 skipped)**, about 2 min |
| Classic DOM | `NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/test_ui.cjs` | **82/82 passed** |
| Classic screenshots | `NODE_PATH=… node agent-autonomy/tests/screenshots.cjs [outdir]` | optional; not run this session |

DOM test dependencies (test-only, installed outside the repo):
`npm install --prefix /tmp/ac-tests --no-save linkedom cssom playwright-core`.
Chromium is preinstalled at `/opt/pw-browsers`.

## The app today (classic UI)

- **Server:** `agent-autonomy/app.py`, standard-library HTTP. It serves the dashboard at `/`, and every `/api/*` route needs `Authorization: Bearer <dashboard key>`.
  - The key is in `agent-autonomy/state/dashboard.key`, which is gitignored.
  - Live updates: `GET /api/events` (SSE change notices), then re-read `GET /api/state`.
- **Engine:** `agent-autonomy/engine.py` (`Controller`). Hermes plans each turn, and OpenCode agents carry it out. It supports:
  - team runs, specialists, approvals with R0–R3 risk levels and a hash-chained audit
  - containers and VMs, preview surfaces, skills, models, the gateway and spend caps
- **Journal:** `agent-autonomy/journal.py`, SQLite in WAL mode at `agent-autonomy/state/autonomy.sqlite3`.
- **Classic frontend:** `index.html`, `app.js` (about 2.4k lines), `workspace.js`, `app.css` (about 5.3k), `workspace.css` and `themes.css`,
  with the Mac, Terminal and XP themes. The redesign does not modify it until M9.
- **Run it:** `python3 agent-autonomy/app.py --host 127.0.0.1 --port 8766 --project <dir> --opencode <url> --profile <hermes profile>`.
  Real runs need a Hermes CLI and an OpenCode server; the UI renders without them.

## Known issues and open questions

- The redesign milestones M1–M9 reuse the "M" prefix that the engine's history uses for M0–M13. They are unrelated, and
  the architecture doc §12 says so.
- W7 (live Hermes streaming) is still tabled. Until it exists, Hermes appears in the room only when a decision lands.
- Multiple concurrent runs are not supported by the backend (one active run). The chat UI must reflect that honestly.
- For M2: if paging a project-scoped thread across sessions proves costly, architecture §6.1 allows temporarily
  backing `main` with the latest `parent_run` chain behind the same API.

## Next step

Astra executes **`docs/handoffs/M1_APP_SHELL.md`**. When it is done, Astra updates this file and appends a completion
report to the handoff. Opus then reviews it and writes the M2 handoff (thread read model). M2 can also be written
earlier and run in parallel, because it touches only the backend read path.
