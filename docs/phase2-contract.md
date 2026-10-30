# Phase 2 M1 API contract (BE-P2-1)

Types: `AgentControlBE/src/shared/types.ts`, section "Phase 2" (hand-copy to the FE as in Phase 1).
Errors are Fastify's shape, `{ statusCode, error, message, reason? }`: `message` is the plain-language text, `error` is only the HTTP status phrase (e.g. "Request Error", "Internal Server Error"), and 409/410 and other errors below 500 may add a machine-readable `reason`. The FE shows `message` and branches on `reason`; it never shows `error`.
Routes below land in BE-P2-17 (and earlier tasks); shapes are fixed now so the FE can build on fake data.

## What changed in BE-P2-1 (live now)
- `Agent.vm: AgentVm` on every agent (load and create fill defaults: browser false, gvisor inherit, env [], packages [], image gen 0 base).
- `FileChange.change` adds `'deleted'` (no bytes/modifiedAt then).
- `ChatMessage.kind` adds `'run'` (with `scriptRunId` + `scriptRun: ChatRunSummary`) and `'permission'` (with `permissionRequestId`). Both are role `assistant` with `authorAgentId`.
- Limits: 4096 MB RAM, 600 s, 10240 MB personal; the bot and group file quota is now 10 GB. `/sandbox` limits show the new values.
- `settings.vm` (server side). `GET/PATCH /api/settings` keep returning only `autoRun/notify/telemetry`.
- Naming: `ScriptRunStatus`, `ScriptRun`, `ScriptRunSummary` (Phase 1's `RunStatus`/`AgentRun` are model turns and unchanged).

**Image sizes (BE-P2-3, measured 2026-10-27, Podman 5.4.2 rootless, linux/amd64, version 1.0.0):** `botvm` 430.7 MB (430,668,054 bytes); `botvm-browser` 1343.4 MB (1,343,351,114 bytes, includes botvm; full Chromium 403 MB, no headless shell binary, just a link to full Chromium; down from 1628.7 MB with the real headless shell). `SHARED_IMAGE_APPROX_BYTES` uses 431 MB and 1343 MB. Shared images are never counted in a bot's 10 GB. Launch: `channel: 'chromium'` (new headless mode) with `--no-sandbox` is the recommended launch (`CHROMIUM_LAUNCH_OPTIONS`); a bare `chromium.launch()` from Python or Node also works, because the headless-shell path Playwright defaults to is a symlink to the same full Chromium (no size change). Bot-facing text: `BROWSER_LAUNCH_NOTE` (for `run_script`'s `browser` description in BE-P2-16 and `browser-basics` in BE-P2-15).

## Per bot
| Method | Path | 200 | Errors |
|---|---|---|---|
| GET | `/api/agents/:id/vm` (alias `/sandbox` keeps its Phase 1 shape for one release) | `VmInfo` | 404 |
| PATCH | `/api/agents/:id/vm` | `VmInfo` | 400 unknown key / `limits` / `egress` ("Home network access isn't available in Phase 2") / reserved env name (message from `envNameProblem`); 400 `permissions.browser:true` in M1 |
| POST | `/api/agents/:id/vm/start` · `/stop` | `VmInfo` | 409 files_missing |
| POST | `/api/agents/:id/vm/reset` `{confirm:true}` | `VmInfo` (M1: recreates the container, removes the tools and opt volumes and the bot image layer, clears `vm.packages`; keeps workspace, inputs, memory, BOT.md, env vars and run history; no backup until M3) | 400 no confirm, 409 run active |
| GET | `/api/agents/:id/vm/tools` | `VmToolsInfo` | 404 |
| POST | `/api/agents/:id/vm/tools/rebuild` · `/rollback` | `ScriptRun` (kind tool_build) | 409 run active, 409 no previous generation |
| GET | `/api/agents/:id/export` | zip stream | |
| GET | `/api/agents/:id/script-runs?before=<runId>&limit=50` | `{ runs: ScriptRunSummary[], hasMore }` newest first (the Phase 1 `/api/agents/:id/runs` model-turn route is unchanged) | |
| GET | `/api/runs/:runId` | `ScriptRun` | 404 |
| GET | `/api/runs/:runId/output?stream=stdout\|stderr` | text/plain full log | 404, 410 log evicted |
| POST | `/api/runs/:runId/stop` | `ScriptRun` | 409 not active |
| GET | `/api/runs/:runId/undo/preview` | `UndoPreview` | 409 `UndoConflict{statusCode, error, message, reason:'run_active'}`, 410 `UndoGone{statusCode, error, message, reason}` (show `message`; `error` is the status phrase) |
| POST | `/api/runs/:runId/undo` `UndoRequest{force?}` | `UndoResult` | 409 `UndoConflict` (`run_active`, or `conflicts` with the list), 410 `UndoGone{statusCode, error, message, reason}` (show `message`; `error` is the status phrase) |

**Undo preview (additive, agreed 2026-10-27):** each `changes[]` entry may carry `beforeBytes?`/`afterBytes?` (number, or null for the side that doesn't exist: added files have `beforeBytes:null`, deleted files `afterBytes:null`) and `groupName?` beside `groupId`; `conflicts[]` may carry `groupName?`. `UndoPreview.budget?: {usedBytes, limitBytes}` mirrors the bot's snapshot budget from VmInfo. For a 410 with `reason:'machine_restored'` the `message` text is exactly "This bot's computer was restored from a backup, so this run can't be undone." (`UNDO_MACHINE_RESTORED_TEXT`); the FE shows the body's `message` as is. File reads by later runs aren't tracked in M1.

**Run cards and file scopes (additive, agreed 2026-10-27):** `ChatRunSummary` may carry `scriptName?` (argv[1] or argv[0]; the card title, with `name`, the skill, as its source), `durationMs?`, `runtime?` and, for undo runs, `undoOfName?` (the reversed run's script name, else skill), so a card renders from the message alone and fetches `GET /api/runs/:id` only when the details or full output are opened. `ScriptRunUndo.changedBytes?` is set with `reason:'too_large'`. Each `FileChange` (run `filesChanged`, activity) may carry `root?: 'agent'|'group'` plus `groupId?`/`groupName?` for root `group`, the same shape as `UndoPreview`; `path` is relative to that folder, with no string prefix. A missing `root` means `agent` (Phase 1 shape). Run messages carry a short plain `content` for previews, built by `runMessageContent()` (src/run-messages.ts) from the summary and updated with it: "Running report.py" / "Queued report.py" while active, "Ran report.py" on success, "Ran report.py (failed)" / "(timed out)" / "(stopped)" / "(denied)" otherwise, "Ran report.py (undone)" once undone, and for an undo run "Undoing report.py" while active, "Undid report.py" on success, "Undo of report.py (failed)" otherwise. The name is `scriptName`, else `name`. Full output opens in a dialog in M1.

**VM tab meters (agreed 2026-10-27):** memory is `usage.memoryMb` of `limits.memoryMb`; bot files & tools is `usage.personalBytes` (always the sum of `usage.breakdown`) of `usage.personalQuotaBytes`; undo snapshots is `usage.snapshots.bytes` of `budgetBytes` (separate, not in the 10 GB); per run shows `limits`. `VmInfo.runsHasMore` says whether older runs exist beyond `VmInfo.runs`; the script-runs list returns `hasMore` on every page. The bot files & tools meter groups `tools`, `opt` and `imageLayer` as "tools and packages". `ScriptRunSummary` may carry `files?: {added, modified, deleted}` (the split of `filesChangedCount`) and `network?`. Start empty for `files_missing` is M3, alongside Restore; M1 only explains the state.

**Bot environment (BE-P2-4, additive, approved by Team lead 2026-10-27):**
- New error reasons (Fastify shape via `failWithReason`, show `message`): `POST /vm/start` 409 `engine_missing` (no container engine), 409 `image_missing` (shared `botvm` image not built yet), 409 `files_missing`, 502 on an engine failure; `POST /vm/stop` 409 `files_missing`, 502; `POST /vm/reset` 400 without `{confirm:true}`, 409 `run_active`, 409 `files_missing`, 502.
- Tool builds (service now, routes with BE-P2-8/16/17): `vm_install` 400 bad package name / more than 100, 409 `internet_never` (bot policy), 409 `internet_unavailable` ("Installing system packages needs internet access, which isn't available yet." — M1 builds run with `--network none`), 502 `build_failed`; rebuild 409 `internet_unavailable` when `vm.packages` is non-empty; rollback 409 `no_previous_generation`, 409 `run_active`. Rollback restores the previous generation's package list (generation 0 = the shared base, packages `[]`).
- Env: every `vm.env` entry is passed as `--env NAME=VALUE` on each exec (never the host's environment). `PATH_APPEND` is not set as a variable: its absolute, `:`-separated parts are appended to the image PATH (`/home/bot/.local/bin:/opt/bot/bin:...`). Only the BE-injected `AC_*` values follow.
- Base upgrades: when the shared base version changes, the bot layer is rebuilt as the next generation from the new base on the next start; if that build fails the old layer keeps running. A generation reached by rollback stays on the base it was built on until the next build.
- Container: `ac-bot-<slug>`, uid 1000, read-only root, `--cap-drop ALL`, no-new-privileges, `--network none` (`host` is never allowed; only `none` or `ac-egress-<slug>`), 512 MB `/tmp` tmpfs, volumes `ac-tools-<slug>` → `/home/bot`, `ac-opt-<slug>` → `/opt/bot`; binds `/bot/workspace` (rw), `/bot/shared` (ro), `/bot/groups/<slug>` (rw) per active group.
- **`run_active` vs `runs_active` (approved by Team lead 2026-10-27):** `run_active` (singular) means *this bot's* run is in progress and blocks a per-bot action: `/vm/reset`, tool rollback, and run undo (`UndoConflict`). `runs_active` (plural) is only for the machine-wide `POST /api/vm/machine/grow` check (any bot's run). Both are 409; show `message`, branch on `reason`.
- `VmInfo` placeholders until BE-P2-12 (`runtime` is resolved since BE-P2-8/7; `usage.breakdown.tools/opt/imageLayer` and `usage.snapshots` are filled since BE-P2-10): `runtime.effective` null before the first probe, `usage.memoryMb` 0, `runs` [], `browserState` `absent`.

**Runtime probe and runner (BE-P2-8, additive, approved by Team lead 2026-10-27):**
- `GET /api/vm/probe` (last result; before the first probe an empty result with `checkedAt` null) and `POST /api/vm/probe` (re-check) are live. `POST /api/vm/probe` requires the header `x-agentcontrol-confirm: 1` (`PERMISSION_CSRF_HEADER`); without it **403 `reason:'confirm_required'`**. The probe runs on server start and again when older than 24 h or the engine, runsc or image version changes. It never uses `--network host`.
- `VmProbeResult` gains `standard?: {runtime, version, limitsEnforced, limitsAccepted, checks} | null` (the standard runtime, e.g. crun) and `runscFlags?: string[]` (the `--runtime-flag=...` gVisor needed to start, e.g. `ignore-cgroups`, `network=none`). `checks`/`compatible` stay about gVisor. The `cgroup_limits` check really tests enforcement: a 64 MB / 32-process container must stop a 192 MB allocation and 64 forks, and `memory.max`/`pids.max` are read. If not, it fails with "limits can't be enforced (…details…)". gVisor that only starts with `ignore-cgroups`, or doesn't enforce limits, is not compatible; the bot falls back to the standard runtime. `chromium` is `skipped` until BE-P2-15; `bind_mount` is a real check since BE-P2-5 and `snapshot_mount` since BE-P2-9 (below).
- `VmInfo.runtime` is now resolved from the probe (plan §4 table). It gains `limitsEnforced?: boolean` and `limitsReason?: string` (the standard runtime's reason when the bot runs on it). Runs are **blocked** when the runtime doesn't enforce limits (or the probe hasn't confirmed it yet), approved by Team lead 2026-10-27: the run fails before anything starts with `outcome:'failed'`, `reason:'limits_unenforced'`, `error`: "This computer can't limit bot scripts safely, so scripts can't run here." (`RunScriptResult.reason?` is a new optional field). The block is in the runner (exec layer); no route starts runs yet, so when RunService (BE-P2-12) adds one it answers **409 `reason:'limits_unenforced'`** with the same message. The FE can show it ahead of time from `VmInfo.runtime.limitsEnforced === false`. There is no API or UI switch to allow unlimited runs (a test-only server override exists and is off by default). BE-P2-5 adds a sibling block, **409 `reason:'mounts_unusable'`** ("This computer can't give bot scripts safe access to their files, so scripts can't run here.") when no uid mapping passes the `bind_mount` check; same mapping in BE-12, same override, checked after this one (see Bot folders and isolation).
- `VmInfo.idleStopAt` is set while the container runs: idle stop after 10 min without runs (swept every 60 s). `POST /vm/stop` and `/vm/reset` stop the bot's runs first (outcome `stopped`).
- Runner (`app.vmRunner`, consumed by RunService in BE-P2-12): `RunScriptRequest` gains optional `runId` (passed as `AC_RUN_ID`), `onOutput(stream, chunk)`, `signal` (AbortSignal) and `extraEnv`. `RunScriptResult` gains optional `outcome` (`succeeded|failed|timed_out|stopped`), `error` (plain language: out of memory at the 4 GB limit, the 256-process limit, killed (137), command not found (127), more than 200 MB of output, past its time limit, stopped), `outputBytes`, `outputTruncated`, `runtime`, `oomKilled` and `pidsLimited`. `pidsLimited` comes from `pids.events`; if leftover processes keep the container at its limit so the counters can't be read, the read is retried (0.5, 1, 2 s) and a failed run is counted as hitting the limit. After a run hits the process limit the bot's container is stopped to clear leftover processes (the next run starts it again). stdout/stderr in the result are the last 64 KB. Output stops at 200 MB (the run is stopped); the full log on disk and the 8 KB tails for the model are BE-P2-12. `network: 'on'` fails with "Internet access isn't available yet." The timeout is clamped to 1–600 s. Runs are serialized per bot.
- Engine: `EngineRef.command?` runs a different program with `globalArgs` (e.g. `sudo` with `['-n','podman','--root',…]`), and `BotEnvDeps.runtimeFlags?(agent)` adds gVisor's flags as global args on start, stop and exec.

**gVisor probe and resolution (BE-P2-7, additive, live on `p2/be-7-gvisor`; needs OK):**
- **Needs OK:** `VmInfo.runtime.failedCheck?: ProbeCheckId`: the first failing gVisor check (plan order) whenever runsc is installed and a check failed (statuses `incompatible_fallback`, `required_unavailable`, and also `forced_off` for info). The VM tab can name the check next to `reason` and `checkedAt`. Absent when runsc is missing or passes.
- **Needs OK:** `VmProbeResult.features?: string[]` (the feature set the probe ran with: `[]` or `['chromium']`) and `VmProbeResult.durationMs?: number` (how long the probe took; the target is under 30 s, it logs when over).
- **Needs OK: check order.** `checks` (and `standard.checks`) now come in plan order: `start`, `bind_mount`, `snapshot_mount`, `network`, `cgroup_limits`, `exec`, `chromium`. The first `fail` is the reason. Example on this box: rootless runsc only starts with `ignore-cgroups`, so `cgroup_limits` fails ("limits can't be enforced"). Where idmap is broken and keep-id isn't tried, `bind_mount` fails first.
- **Needs OK: `chromium` check.** It is real when any bot has `permissions.browser` on (not possible in M1; BE-P2-15 turns it on). It starts the `botvm-browser` image hardened and offline (`--network none`, uid 1000, read-only, no caps, the probe's uid mapping) and has Chromium screenshot `about:blank`. Pass message: "Chromium <version> launched and took a screenshot of about:blank". Fail message: "Chromium didn't launch: …". When no bot has the browser on, it is `skipped` with "Not needed: no bot has the browser on." `snapshot_mount` is a real check since BE-P2-9 (see Undo snapshots). The egress CONNECT part of `network` is BE-P2-13.
- **Needs OK: force_on message.** When runsc is missing or a check failed, the run fails and `runtime.reason` is exactly "gVisor is required for <bot> but isn't available (<why>). Turn off Force on or fix gVisor.". `<why>` is the plain name of the first failing check:
  - "the test container didn't start"
  - "bind-mount ownership check failed"
  - "snapshot mount check failed"
  - "network isolation check failed"
  - "limits can't be enforced"
  - "python3/node check failed"
  - "Chromium check failed"

  It can also be "it isn't installed" or "the runtime check hasn't run yet". `incompatible_fallback` keeps the check's full message as `reason`, as before.
- **Needs OK: `reason: 'gvisor_unavailable'` (BE-P2-7 follow-up, additive).** gVisor is required but unavailable when the effective mode is `force_on`, and the probe failed, runsc is missing, or there is no probe result yet. A run then fails before anything starts:
  - `outcome: 'failed'`, `reason: 'gvisor_unavailable'`, `runtime: null`
  - `error`: the force_on message above, the same text as `VmInfo.runtime.reason`.

  It is never a quiet fallback to crun. Only `auto` falls back. The check comes first, before `limits_unenforced` and `mounts_unusable`, and the test-only override doesn't lift it. It runs again when a queued run's turn comes.

  `POST /api/agents/:id/vm/start` answers **409 `reason:'gvisor_unavailable'`** with the same message. No container is created or started on the standard runtime.

  When RunService (BE-P2-12) adds a run route, it answers **409 `reason:'gvisor_unavailable'`**. The FE can show it ahead of time from `VmInfo.runtime.status === 'required_unavailable'`.
- **Triggers and cache.**
  - **When the probe runs:**
    - On server start: the cached result for the current key is used right away, then a fresh probe runs.
    - Every hour: re-probe when the key changed or the result is older than 24 h.
    - When a bot's `gvisor` mode changes (`PATCH /api/agents/:id/vm`): a full re-probe.
    - When a bot's browser permission changes: re-probe only when the feature set changed.
    - On `POST /api/vm/probe`.
  - **Global mode:** `app.vmRuntimeModeChanged()` is the hook for BE-P2-17's `PATCH /api/vm/settings` (that route is not added here).
  - **Cache key:** engine and its global args, engine version, standard runtime, runsc version, botvm image id, feature set, and the browser image id when `chromium` is on.
  - **Storage:** up to 8 results are kept per key in `<data>/vm/runtime-probe.json` (server-only, mode 600, written atomically). AgentControl never installs gVisor. On Mac/Windows the runsc version is read inside the machine (`podman machine ssh <machine> runsc --version`).
- **A runtime change recreates the container (volumes kept).** This happens when a bot's effective runtime changes (crun ↔ runsc, or other runsc flags). The bot's next run recreates its container, even though the run counts as active, because runs are one at a time per bot. Other `ensure` callers still wait for idle. Containers created with runsc flags get a label `io.agentcontrol.runtime-flags`; it is not added when there are no flags, so crun containers keep their hash. Stop and remove use the flags the container was created with. FE impact: none.


## Global
| Method | Path | 200 |
|---|---|---|
| GET | `/api/vm/host` | `VmHostInfo` |
| GET/PATCH | `/api/vm/settings` | `VmSettingsView` (PATCH `VmSettingsPatch`, bounds in `SNAPSHOT_BUDGET_BOUNDS`, `BACKUP_KEEP_BOUNDS`) |
| GET/POST | `/api/vm/probe` | `VmProbeResult` (last result / re-check); POST needs header `x-agentcontrol-confirm: 1`, 403 `reason:'confirm_required'` without it |
| POST | `/api/vm/machine/grow` `{toGb}` | `VmHostInfo`; 409 `reason:'runs_active'` while any run is in progress, 409 `reason:'machine_busy'` while the machine is already being changed, 400 bad `toGb` / Linux / no machine / low host disk, 502 Podman failed |
| GET | `/api/vm/export` | archive stream |

**Host and grow (BE-P2-2, additive, approved by Team lead 2026-10-27):** `GET /api/vm/host` is live. `machine` is null on Linux; `provider` is `native` on Linux, Podman's VM type on Mac/Windows (`libkrun`, `applehv`, `wsl`, `hyperv`), or `docker-desktop` when only Docker is found there. `setupSteps` lists every step for the OS with `done` flags (`install-podman`; Linux `rootless` when the engine runs as root; Mac/Windows `create-machine`, `start-machine`) and is `[]` once all are done. `growOffer` appears at 80 % use; the ladder is 90, 120, then ×1.5 rounded up to 30 GB (180, 270 …), max 2048. `POST /api/vm/machine/grow`: 400 also for a `toGb` that isn't a whole number above the current size, on Linux (no machine) and when the machine is missing; the low-disk check needs `(toGb − current) GB + 3 GB` free on the host drive; **502** when Podman fails to stop/resize/start (message has Podman's last line). Mac resizes the machine (stop, `set --disk-size`, start if it was running); Windows only raises the managed budget. **409 `reason:'runs_active'`** when any run is in progress, because the machine has to stop to grow (checked after the `toGb` checks and before the disk check; the FE shows `message` and branches on `reason`). **409 `reason:'machine_busy'`** when the machine is already being changed (another grow, or the machine being set up or started); try again in a moment. `concurrency` is 1 on Mac/Windows (one shared machine); on Linux it is `min(4, floor((RAM − 4 GB) / 4 GB))`, clamped to at least 1, so small hosts still run one script at a time.

## Live events: `GET /api/events` (SSE, M1)
- Frame: `id: <n>` · `event: <type>` · `data: <LiveEvent JSON>`. Types: `run.updated` (full run + `summary` + `messageId`), `run.output` (chunk), `vm.updated`. `permission.*` are M2.
- Catch-up: `Last-Event-ID` header (or `?lastEventId=`); replay from a ring of the last 1000. Too old (or newer than the server knows) → first frame `event: reset` (`data: {}`), then re-fetch active runs and VM info. The reset frame carries `id: <latest event id>` (same sequence as the other frames), so a client that reconnects with that `Last-Event-ID` right after a reset gets no second reset, only the events after it.
- Heartbeat: `: ping` every 15 s; `retry: 3000` on connect.
- Auth: with `AGENTCONTROL_AUTH_TOKEN` set the route needs `Authorization: Bearer <token>` like every `/api/*` route, so read it with fetch streaming; `EventSource` isn't supported with auth (no token in the URL).
- Filters: `?conversationId=` and/or `?agentId=`.
- New kind `run` chat messages still arrive through the existing messages `?after=` fetch; `run.updated` carries `messageId` so the card can update in place.

## M1 scope notes
- No permission waiting state: a `network:'on'` run fails with "Internet access isn't available yet." (status `failed`). `waiting_permission` and `denied` exist in the type for M2.
- `permissions.browser` stays false in M1 (PATCH true → 400 "The browser arrives in a later update.").
- Backups and restore routes are M3.

## Permissions (M2; shapes fixed now)
| Method | Path | 200 | Errors |
|---|---|---|---|
| GET | `/api/permissions?status=pending&agentId=&conversationId=` | `PermissionListResponse` | |
| POST | `/api/permissions/:requestId` `PermissionAnswer` + header `x-agentcontrol-confirm: 1` (`PERMISSION_CSRF_HEADER`) | `PermissionRequest` | 400 wrong decision for the type, 403 header missing, 404, 409 already resolved |

**Bot folders and isolation (BE-P2-5, on `p2/be-5-mounts`; additive; items 1–6 approved by Team lead 2026-10-28, run block for question 7 approved the same day):**
- **uid mapping (Podman).** Bot uid 1000 must read and write `/bot/workspace` and `/bot/groups/<slug>` while the host files stay owned by the server user. The probe picks the mapping per runtime: `idmap` first (`--userns auto` + `idmap` bind mounts: every bot gets its own subuid range), else `keep-id` (`--userns keep-id:uid=1000,gid=1000`: container uid 1000 is the server user). Rootless Podman can't make idmapped mounts on most hosts (here: crun `mount_setattr … Operation not permitted`; runsc can't start), so `keep-id` is the usual result. `keep-id` works rootless on Linux and inside the Mac/Windows `podman machine` (the files there are owned by the machine's user, which the machine maps to the host user), needs no `chown`/`chmod 777` and no root. Docker: no `--userns`, no change. Named volumes (`ac-tools-<slug>`, `ac-opt-<slug>`) get `U=true` so `/home/bot` and `/opt/bot` follow the mapping; binds never get `U` (it would chown the user's files). The mapping is part of the container config hash: a change recreates the container, volumes kept.
- `VmProbeResult.standard.uidMapping?: 'idmap'|'keep-id'|null` (new, optional); the top-level `uidMapping` (already in the type) is now filled for runsc. `null`: no mapping passed, Docker, or not checked. Until the probe has a result, Podman uses `keep-id`.
- **`bind_mount` check:** a hardened, offline container (uid 1000, read-only root, no caps) gets a temp writable and read-only folder (`.ac-bind-probe-*` in the bots' files folder, removed afterwards). As uid 1000 it modifies a host file, creates, makes a folder, renames, deletes; reads the read-only folder and must get `EROFS` writing to it. On the host the new files must be owned by the server user and the deletes/renames visible. Pass message: `"<mapping>: … (idmap failed: …)"`. Fail: "The bot can't use its folders: …". Skipped when the bots' files aren't on a folder the engine can mount (remote `--connection` without a mountable path; the Windows WSL backend later).
- **Runs are blocked** when no uid mapping passes the probe (Team lead, 2026-10-28), the same way as `limits_unenforced`: the run fails before anything starts with `outcome:'failed'`, `reason:'mounts_unusable'`, `error`: "This computer can't give bot scripts safe access to their files, so scripts can't run here." "Passes" means the `bind_mount` check for the bot's effective runtime (runsc: top-level `checks`; crun/runc/Docker: `standard.checks`) has `status:'pass'`; `fail`, `skipped` (bots' files not on a mountable folder) and no probe result yet all block. The limits block is checked first, so a run that hits both reports `limits_unenforced`. The block is in the runner (exec layer); when RunService (BE-P2-12) adds the run route it answers **409 `reason:'mounts_unusable'`** with the same message. The FE can show it ahead of time from the `bind_mount` check in `VmProbeResult` (or `VmInfo.isolationNote`, which carries the failure message). No API or UI switch; the same test-only server override as `limits_unenforced` (`AC_ALLOW_UNLIMITED_RUNS=1`, off by default) lifts it. The bot's container itself (BotEnv ensure) is not blocked; only script runs.
- `VmInfo.isolationNote` (field already in the type), Podman only: with `keep-id`: "Bots on this computer use the same user ID for their files (separate user IDs need idmapped mounts, which this computer doesn't support). Each bot still only sees its own folders and processes." plus the `bind_mount` failure message if it failed. Absent with `idmap` or Docker.
- **Mount allow-list:** before any engine call (volume, create, start) every mount is checked against the bot's allow-list: `/bot/workspace` (rw) and `/bot/shared` (ro) = the bot's own folders, `/bot/groups/<slug>` (rw) only for groups it's a member of, `/bot/skills` (ro) only if set. Sources are compared by real path (symlinks resolved) and must stay inside the bot's/groups' root. Anything else (another bot's folder, a non-member group, an unknown target, a wrong read-only flag, a duplicate, a missing folder) fails with **500 `reason:'mount_refused'`** and nothing is created. A 500 because it is a server bug, never user input.
- Network: each bot's container has its own network namespace (`--network none`, only `lo`); per-bot egress networks are BE-P2-13.
- Tested @vm (rootless): 3 bots running at once; each sees only its own workspace, tools volume, env and processes; group members share the group folder, a non-member has none; EROFS on `/bot/shared`, `/bot/skills` and the root fs; host ownership unchanged.
- **Gaps:** idmap is implemented but untested on a host that supports it; keep-id on a Mac/Windows `podman machine` is by design, not yet tested there; per-bot host uids only come with idmap; `/bot/skills` isn't mounted by the server yet; overlay snapshot mounts are added since BE-P2-9 (see Undo snapshots); when `WslFs` is selected its files have no host path, so the check is skipped and mounts must come from the machine side (later). Until then a skipped check blocks runs with `mounts_unusable` (remote `--connection` without a mountable path, WSL).

## Files volume (BE-P2-6, live on `p2/be-6-storage`; additive)
- The server keeps a marker file `.ac-volume-id` at the root of the bots' files and its id in `settings.vm.volumeId` (server-only; never served). The first start writes both.
- If the marker is missing, or holds another id, the files are `files_missing`: chats, bots and groups keep working, but every bot or group file route (list, read, upload, write, folder, move, delete) and `PUT /api/conversations/:id/uploads` answer **409 with `reason: 'files_missing'`** and a plain-language message. The bots' file tools give the same message. Nothing is re-created; the state clears on the next start once the right files are back.
- The error body is the existing one plus `reason`: `{ statusCode: 409, error: 'Request Error', message, reason: 'files_missing' }`. Show `message`.
- M1 has no Start empty or Restore (M3).
- Approved decisions (Team lead, 2026-10-27): on `files_missing` **reads are blocked too** (list and read answer the same 409, not just writes), and an **existing marker with no saved id is adopted**: its id is saved to `settings.vm.volumeId` and the files are treated as fine.
- **Known limitations (M1):**
  - `WslFs` is synchronous: each call blocks on one `podman exec` into the machine.
  - `WslFs` isn't selected yet: the server uses `LocalFs` on every OS.
  - File search and skills still read host paths directly, not through the storage backend.

## Undo snapshots (BE-P2-9, on `p2/be-9-snapshots`; additive, items 1–7 approved by Team lead 2026-10-29, gaps accepted for M1)
- **Needs OK: `snapshot_mount` is a real probe check.** On the standard runtime it picks the driver, in this order: `reflink` when the bots' files folder can clone files ("reflink: the bots' files folder can clone files, so no special mount is needed"); `copy` with Docker; `overlay` when a test container's `:O,upperdir=…,workdir=…` mount sends writes to the layer, shows deletes and replaced folders, and commits back correctly ("overlay mount: writes go to the overlay layer and commit back correctly"); otherwise `copy` ("copy: overlay mounts don't work here (…), so snapshots copy files (the first one copies every file)"). All of these are `pass`. On runsc the chosen driver is checked: if it is `overlay` and the mount fails there, the check is `fail` ("The overlay snapshot mount doesn't work: …"), so gVisor is not compatible (force_on: "snapshot mount check failed"). `skipped` only when the bots' files have no host path the engine can mount (WSL / remote).
- **Needs OK:** `VmProbeResult.snapshotDriver` is filled from the standard runtime's pick, and `VmInfo.storage.driver` / the vm-host storage `driver` show it (null before the first probe, or when snapshots are off because the files have no host path).
- **Needs OK: runner result.** `RunScriptResult.filesChanged` is now `FileChange[]` (adds `deleted`, `bytes`, `modifiedAt`, `root`, `groupId`, `groupName`; paths are `workspace/<rel>` or `shared/<rel>` for a group folder) and gains `snapshot?: {id, driver, retainedBytes} | null` (same shape as `ScriptRun.snapshot`). Every outcome (succeeded, failed, timed out, stopped) is committed and undoable. A rename is reported as a delete plus an add. Folders aren't reported, only files and symlinks.
- **Needs OK: new reason `snapshot_failed`.** If the pre-run snapshot can't be taken, the run doesn't start: `outcome:'failed'`, `reason:'snapshot_failed'`, `snapshot:null`, error "The run's undo snapshot couldn't be taken, so the run didn't start: …". RunService (BE-P2-12) maps it to **409 `reason:'snapshot_failed'`**. If finishing the snapshot fails after the run, the run's result stands with `snapshot:null`, `filesChanged:[]`; the snapshot stays pending and is finished before the bot's next run (or on recovery).
- **Needs OK: zones.** A run's snapshot covers the bot's `/bot/workspace` and the `shared/` folder of every group it is a member of (`/bot/groups/<slug>`, key `group-<slug>`). `/bot/shared` (read-only) and the tools/opt volumes are not snapshotted.
- **Needs OK: overlay mounts.** With the `overlay` driver, writable zone mounts become `-v <dir>:<target>:O,upperdir=<snapshots>/<slug>/.overlay/<zone>/upper,workdir=…/work` (plus `,idmap` with idmap). Upper/work dirs must lie inside the bot's own `.overlay` folder, never overlap or repeat (else `mount_refused`). The bot's container is **stopped before and after each run** so the layer can be committed (writes made between runs, e.g. by an exec at idle, are committed into the next run's snapshot). After a switch away from overlay, leftover layers are committed into the next run's snapshot and removed.
- **Needs OK: storage layout** (server-only, not served): `<filesRoot>/snapshots/<slug>/<runId>/{manifest.json, post.json, meta.json, files/<zone>/…}` (reflink/overlay originals of changed files only), `.blobs/<sha256>` (copy driver, content-addressed and shared between runs), `.index.json` (hash index so unchanged files aren't re-read; see the BE-P2-11 mtime-window note for which entries are trusted), `.pending.json` (an unfinished snapshot; finished on the bot's next run, recorded `recovered:true`). Symlinks are recorded, never followed; special files are ignored. File reads use `O_NOFOLLOW`, and a file swapped for a link while it is read fails the snapshot (`snapshot_failed`).
- **Copy driver timing (note for Team lead):** the `copy` driver is close to the 2 s pre-run budget. Measured on the test box: ~1.3 s standalone before the hash-once fix, ~2.0 s under the full parallel test suite; `reflink` 0.78 s. Hosts that fall back to `copy` with large workspaces may exceed 2 s; watch this when RunService (BE-P2-12) adds timing.
- **10k-file timing in tests (CI fix, on `p2/ci-fix`):** the 2 s limits for begin, finish and the second snapshot are enforced only when `CI` isn't set (the box). On CI (GitHub runners measured 2.0–2.4 s) the tests still run and check the changed files, and the times are logged (`[snapshot timing, CI: not enforced] …`) but not enforced. Off CI they are logged too.
- **Gaps:** snapshot budgets, eviction and `usage.snapshots` are BE-P2-10 (below); applying an undo (and `UndoPreview`) is BE-P2-11 (BE-P2-9 only provides the per-run originals); `WslFs` has no snapshots yet (driver null); the overlay driver's @vm tests didn't run for this commit (no Podman on the test box after a reset); `reflink` is only checked with a simulated clone (the box is ext4); a process left running by the bot can still change a file between the pre-run walk and the clone (the file is snapshotted as of the clone).

## Snapshot budgets, eviction and the personal limit (BE-P2-10, on `p2/be-10-budgets`; additive, items 1–8 approved by Team lead 2026-10-30, gaps accepted for M1)
- **Needs OK: budgets.** Per-bot, global and free-disk floor come from `settings.vm.snapshotBudget` (defaults 2048 / 15360 / 5120 MB, `DEFAULT_VM_SETTINGS.snapshotBudget`). Eviction (plan §7.4) runs after every snapshotted run and on a 10-minute sweep, in order: (1) `expired`: a run beyond the bot's last 20 runs **and** older than 7 days; (2) `budget_bot`: the bot's oldest first, never its newest; (3) `budget_global` / `low_disk`: oldest across bots, skipping each bot's newest; (4) when only newest snapshots are left, largest first; (5) `too_large`: a run retaining more than 2× the per-bot budget is dropped right after it finishes. Evicted runs always carry a reason. A busy bot's snapshots aren't evicted until its run ends; copy-driver blobs are collected for every idle bot on each pass.
- **Needs OK: `SnapshotMeta.undo` and `RunScriptResult.undo?: ScriptRunUndo`.** Eviction state is stored in the snapshot's `meta.json` (`{state:'unavailable', reason, at, changedBytes?}`); the run result carries it when the run itself was evicted (e.g. `too_large`). RunService (BE-P2-12) copies it into `ScriptRun.undo`.
- **Needs OK: `undoUnavailableText(undo, botName, perBotBytes)`** gives the plain-language text per reason (`expired`, `budget_bot`, `budget_global`/`low_disk`, `too_large` with the changed GB, `machine_restored`).
- **Needs OK: new run block `personal_quota`.** Before each run the bot's personal usage (workspace, inputs, memory + BOT.md, the tools and opt volumes and its image layer) is checked against the bot quota; over it the run doesn't start: `outcome:'failed'`, `reason:'personal_quota'`, error exactly "Analyst's files and tools use 10.2 of 10 GB. Free space in Files or remove tools in Settings › VM." (bot name and figures filled in). Checked after `limits_unenforced` / `mounts_unusable`. BE-P2-12 maps it to **409 `reason:'personal_quota'`**. If measuring fails the run goes ahead (logged).
- **Needs OK: `BotEnvService.measure(agent)`** → `{tools, opt, imageLayer}` bytes (du of `/home/bot` and `/opt/bot`, only while the container runs; image layer = the bot image size minus the shared base, 0 at generation 0). Parts it can't measure are left out and the last known values are kept. Cached 10 min per bot; never throws.
- **Needs OK: the files quota counts the engine bytes.** Uploads/writes to the bot's folder now count tools + opt + image layer toward the bot quota (413 as before).
- **Needs OK: full group folder is mounted read-only.** A group whose `shared/` folder is at its limit is mounted `ro` into members' containers and left out of snapshot zones until it is under the limit again; `MountAllowList.readonlyGroups?: string[]` lists them (omitted when none).
- **Needs OK: `VmInfo.usage`.** `usage.snapshots` is the bot's retained snapshot bytes; `usage.breakdown.tools/opt/imageLayer` are filled from `measure`; `personalBytes` includes BOT.md. Copy-driver accounting uses each run's `retainedBytes` + its json files (shared blobs counted per run).
- **Needs OK: `app.vmSnapshotBudget`** (decorated; `enforce({gcSlug?})`, `afterRun`, `usage`, `startTimer`) so BE-P2-17's settings PATCH can re-run eviction after a budget change.
- **Follow-up (after approval): records pruned.** An evicted run's record (`<slug>/<runId>/meta.json`, its folder) is removed only when it is outside both the bot's last 20 runs (ranked over every record, kept or evicted) **and** 7+ days old; a record in the last 20 or under 7 days old is kept, so undo for those runs answers "unavailable" with its reason. Kept and undone records are never pruned. Pruning runs on every eviction pass (the 10-minute sweep and after each run). Once pruned, the run's undo answers like a run without a snapshot.
- **Follow-up (after approval): timers always run.** The 10-minute eviction sweep and the 10-minute tools-measurement refresh start whenever the server is ready (no longer only with `probeOnStart`) and stop on close.
- **Gaps:** the run-log hook is exposed but unwired (BE-P2-12); the "< 3 GB free" run block is BE-P2-12; runs without a snapshot don't count toward the last 20; a group folder that overflows during a run is caught at the next container ensure; copy blobs shared between runs are double-counted (over-estimate); settings PATCH re-enforcement is only exposed (BE-P2-17); engine measurement and the @vm tests didn't run (Podman not installed on the test box); the per-run personal check walks the bot folder each time.

## Undo (BE-P2-11, on `p2/be-11-undo`; additive, items 1–9 approved by Team lead 2026-10-30, gaps accepted for M1)
- **Needs OK: new 409 reason `already_undone`.** `UndoConflict.reason` gains `'already_undone'` ("This run was already undone. To bring its changes back, undo the undo."). The undone run stays `undo:{state:'done', at, undoRunId}`; undoing the undo run brings its changes back (the undo run is itself a snapshotted run, "undo of R", `undoOf: R`).
- **Needs OK: 410 for a run without a record.** A run with no snapshot record (never snapshotted, or its record was pruned) answers **410 `reason:'expired'`** with the `expired` text; an evicted run answers 410 with its stored reason and `undoUnavailableText` (e.g. `budget_bot`: "…Analyst's 2 GB…", `machine_restored`).
- **Needs OK: 409 `conflicts` carries the list.** `{statusCode:409, error, message:"N files changed after this run…", reason:'conflicts', conflicts:[{path, root, groupId?, groupName?}]}`. A conflict is a file whose state now differs from what the run left: something is back at a path the run deleted; a link with another target; a file with another size, or (when the mtime changed) other bytes (sha256 against the run's after hash); a file whose group folder no longer exists. Same size and same mtime (to the ms) counts as unchanged, as for snapshots. `force` overwrites the conflicting files the run touched, nothing else. *(Same size and mtime is narrowed by the mtime-window fix below.)*
- **Needs OK: mtime window (fix, 2026-10-30; applies to BE-P2-9 snapshots and the undo conflict check).** Same size and same mtime no longer means "unchanged" by itself: a rewrite of the same length within one timestamp tick keeps both, and the diff and undo were then silently wrong. Each run records a window `meta.window = {startMs, endMs, marginMs}` (server-only): `startMs` is the wall clock before the pre-run walk, `endMs` before the post-run walk, `marginMs` = 2000 (covers 1 s and 2 s mtime resolution). (a) Snapshot diff: a file whose mtime is ≥ `startMs − marginMs` is compared by content (sha256), even with the same size and mtime; with `overlay`, every file the run touched is compared. (b) Hash index: `.index.json` gains `at` (= `endMs`); an entry is trusted only for a file with the same size and mtime whose mtime is < `at − marginMs` (an index without `at` trusts nothing, so every file is re-read once). (c) Undo conflicts: same size and mtime counts as unchanged only when that mtime is < R's `startMs − marginMs`; otherwise the file is compared with R's after hash. Records without a window (taken before this fix) compare every file by content. Files older than the window keep the fast size/mtime check, so only files written around the run are re-read. 10k-file timings (test box, all three drivers under 2 s each for begin and finish; reported with the commit).
- **Needs OK: `failWithReason(status, reason, message, extra?)`** takes `{conflicts?}`; the app error handler adds `conflicts` to the body when it's an array, a reason is set and the status is < 500.
- **Needs OK: `run_active`.** Undo is refused with 409 `run_active` ("Wait for the bot's run to finish first.") while the bot has a run queued or running; the apply itself runs in the bot's run slot (`ContainerRunner.exclusive`), re-checks conflicts there, and blocks the bot's runs until it's done. The preview is allowed during a run (read-only; conflicts may change before apply).
- **Needs OK: apply.** Deletes first (deepest first), then restores; each file is written atomically through the StorageBackend (temp file, exact bytes and mode `& 0o777`, fsync, rename; links never followed, a link planted on the way fails with 400). With the overlay driver the bot's container is stopped first. If a write fails the undo run is still finished (so what was written is itself undoable), R is **not** marked undone, and the error is returned (a partial undo; retry with `force`). Files undo leaves alone are listed in `skipped[{path, root, groupId?, groupName?, why:'group_gone'|'folder'|'original_missing'}]` (only with `force` for `group_gone`).
- **Needs OK: service, no routes yet.** `app.vmUndo: UndoService` with `preview(agent, runId): UndoPreview` (group named per change; `caveats:['internet','tools']`; `budget` from the snapshot usage) and `apply(agent, runId, {force?})` → `{runId, undo, undoRunId, snapshot, filesChanged, undoRunUndo, skipped}`. The routes (`/api/runs/:runId/undo[/preview]`) are BE-P2-17; `ScriptRun` records (`kind:'undo'`, `undoOfRunId`) are BE-P2-12. Undo runs go through the snapshot budget like any run.
- **Needs OK: StorageBackend.** `undo(ref)` stub removed; added `inspect(root, parts, {hash?}) → EntryInfo | null` and `restore(root, parts, RestoreSource)` (`file{from, mode}` | `symlink{target}` | `absent`) on LocalFs, WslFs and acfs (new acfs ops `inspect`, `restore`).
- **Needs OK: snapshot service additions** (server-only): `begin(agent, runId, {zones?, undoOf?})`, `retain` (overlay: keeps the original before the undo writes the real folder), `markUndone`, `hold` (a held run is never evicted), `undoOf` in `meta.json`; `done` records are kept like evicted ones (no files). Crafted records (bad zone, traversal path, bad blob name) are refused with 400 or skipped (`original_missing`).
- **Gaps:** @win not run, and snapshots are off on `WslFs` (driver null), so real undo on Windows waits for WslFs snapshots (the file operations are tested on WslFs in-process); the @vm tests (`undo.vm.test.ts`) didn't run (Podman not installed on the test box), so overlay undo has only in-process coverage; empty folders the run created are left after undo; files in a deleted group are skipped; routes and ScriptRun updates are BE-P2-17/12.

## RunService (BE-P2-12, on `p2/be-12-run-service`; additive, approved by Team lead 2026-10-30: items 2–12 approved, item 1 decided as below)
The routes in "Per bot" (`/script-runs`, `/api/runs/:runId`, `/output`, `/stop`) and `GET /api/events` above are now live, as specified there. `app.vmRuns: RunService` (`start`, `wait`, `get`, `list`, `stop`, `stopAgent`, `undo`, `modelResult`, `recover`) is what `run_script` (BE-P2-16) and the undo routes (BE-P2-17) call; `app.liveEvents` is the bus PermissionGate publishes to in M2.
- **Decided (Team lead 2026-10-30): `queuePosition` is the number of runs ahead, counting running ones.** With 1 at a time (Mac/Windows) the 2nd run shows `queuePosition: 1` ("Queued · 1 ahead"). The `ScriptRun`/`ChatRunSummary` type comments now say so (the old "0 = next" is gone). A run whose bot is busy with an undo also counts the undo as ahead. Set on the record, the card's `ChatRunSummary.queuePosition` and every `run.updated`; dropped once the run starts. The queue is one FIFO for the machine (`VmHostInfo.concurrency` at once); a bot runs one script at a time, so a later run of another bot can start before a bot's 2nd run.
- **Approved: new 409 reason `low_disk`.** Under 3 GiB free (the bots' files / snapshots drive; on Windows the machine's disk) a run is refused before it is recorded: 409 `reason:'low_disk'`, "This computer is almost out of disk space (less than 3 GB free), so scripts can't run until some space is freed." Unknown free space allows the run. The check is repeated when a queued run's turn comes; then the run ends `failed` with that text and `reason:'low_disk'`.
- **Approved: run blocks are 409s with the runner's reason.** `limits_unenforced`, `mounts_unusable`, `personal_quota`, `snapshot_failed` and `gvisor_unavailable` found before queueing (new `ContainerRunner.check(req)`, the same checks `run` makes, without running) → 409 with that `reason` and the runner's message; nothing is recorded. Found at the run's turn (e.g. the snapshot fails) → the run ends `failed` with the message.
- **Approved: `ScriptRun.reason?: string`** (machine-readable, only for those blocks and `low_disk`) and the same `reason` in the model's result.
- **Approved: other start errors.** Unknown bot or chat 404; chat not the bot's DM / a group it's in 400; bad argv/cwd 400 (runner message). `network:'on'` stays a `failed` record ("Internet access isn't available yet."), as in the M1 notes, not an error.
- **Approved: output.** Each run has `data/runs/<slug>/<runId>.{json,stdout.log,stderr.log}`; the logs hold every byte up to the runner's 200 MB stop. `ScriptRun.stdoutTail/stderrTail` are the last 64 KB, the model gets the last 8 KB per stream (`modelResult`). `run.output` events are coalesced: at most one per stream every 200 ms, each up to the last 16 KB written in that window (the full text stays in the log). Logs of runs without a snapshot are removed once a run is outside the bot's last 20 **and** 7+ days old; snapshot runs' logs go with their snapshot (BE-P2-10 run-log hook, now wired). A removed log answers **410 `reason:'log_evicted'`** ("This run's full output is no longer kept…").
- **Approved: stop.** `POST /api/runs/:id/stop` on a queued run ends it at once (`stopped`, "The run was stopped before it started."); on a running run it stops it and waits up to 15 s for the ended record (else returns it still `running`; a `run.updated` follows). Ended run → **409 `reason:'not_active'`**. VM stop/reset also end the bot's queued runs.
- **Approved: restart recovery.** On start, runs left `running` end `failed` "AgentControl stopped while this run was in progress, so it was ended."; runs left `queued` end `failed` "AgentControl restarted before this run started, so it was not run." A snapshot the crash left unfinished is finished first and its files/undo go on the run.
- **Approved: active runs include the queue.** `activeRuns` for VM reset, undo's `run_active`, the snapshot eviction "busy" check and grow's `runs_active` now count runs RunService still has queued, not only the runner's.
- **Approved: chat cards.** Each run gets one kind `run` message (`authorAgentId` = the bot) created when queued and updated in place (`scriptRun` + `content` via `runMessageContent`); the store is saved on status changes only. `ScriptRun.messageId` points at it.
- **Approved: undo state.** A run's `undo` is `available` when it has a snapshot (or the eviction state the runner returned), else `{state:'unavailable'}` without a reason. `get`/`list` show the current state from the snapshot record (evicted later → `unavailable` with its reason); records/cards are updated after the bot's next run. `RunService.undo` records the undo run (`kind:'undo'`, `undoOfRunId`) and marks the run `undone`; a partial undo (BE-P2-11) now carries `undoRun` on its error so the undo run is still recorded (`failed`).
- **Approved: `vm.updated`** is published after every run ends (new `VmInfo.runs` page); `VmInfo.runs`/`runsHasMore` are filled from the same list as `/script-runs`.
- **Follow-ups (after approval):**
  - `GET /api/events` with `AGENTCONTROL_AUTH_TOKEN` set takes the normal `Authorization: Bearer <token>` header (401 without it), like every `/api/*` route; the FE reads the stream with fetch streaming. **`EventSource` isn't supported with auth** (it can't send the header) and no token in the URL is accepted. Without the token, `EventSource` works.
  - Ended run records (`<runId>.json`) are pruned by the same rule as the logs: a record is kept while it's in the bot's last 20 runs or under 7 days old. Older ones are kept too while their snapshot is kept (undo state not `unavailable`), and so is any run a kept run points at (`undoOfRunId`, `undo.undoRunId`). A pruned run's record and logs are removed and it leaves `/script-runs`; `GET /api/runs/:id` answers 404. Pruning runs after each run ends (that bot) and on start (every bot). Chat cards keep their inline summary.
  - A queued run takes a machine slot only once its bot's own slot is free: while the bot is busy (its run, or an undo through the runner's `exclusive`), its queued run doesn't block other bots' runs. The runner tells RunService when a bot's slot changes (`ContainerRunner.onSlotChange`, internal).
- **Gaps:** `run_script`/tools are BE-P2-16 and the undo/tool-build routes BE-P2-17; card undo states change only after the bot's next run or on read; memory use isn't measured; the @vm tests (`run-service.vm.test.ts`) ran on 2026-10-30 with rootless Podman (3 passed); @win/@mac weren't run.

## VM tools in the agent loop (BE-P2-16, on `p2/be-16-vm-tools`; additive, items 1–10 approved by Team lead 2026-10-30)

`run_script` and `vm_install` are built-in tools (category `vm`, effect `write`) in DM and group runs. They call `app.vmRuns` (RunService) and `BotEnvService.vmInstall`; no new routes, and no changes to existing response shapes.

- **`run_script` args:** `argv` (≤ 64 strings) or `script` (bash, ≤ 16,000 chars; becomes `['bash','-c',script]`), `cwd` (`"workspace"` (DM default), `"groups/<slug>[/sub]"`, or `"group:shared[/sub]"` in a group chat; a group run defaults to its group folder), `timeoutSec` (1–600), `network` (`off`|`on`), `browser` (boolean; its description includes `BROWSER_LAUNCH_NOTE` word for word), `why` (≤ 300 chars, shown on the run card). The run gets `agentRunId` = the reply's run id and the reply's conversation (a DM run with no DM yet gets the bot's DM).
- **Result (the model's view):** `{runId, status, exitCode?, error?, reason?, stdout, stderr, outputTruncated, filesChanged (≤ 50, plus filesChangedCount), runtime, durationMs?, note?, outputNote?}` — `RunService.modelResult` (8 KB tails) plus: `outputNote` when the tails don't hold the whole output ("Only the last 8 KB of each stream is shown (N bytes in all); the full output is on the run card."); `note` when the run is still going. The JSON is kept under 20,000 chars by trimming the start of the tails (`outputClipped: true`).
- **Needs OK: offered only when runs can start.** The tools are in the bot's tool list (and the prompt-budget preview) only when the app bound RunService to the store and `runner.check` for a plain DM run passes (engine present, runtime not blocked, mounts usable). Otherwise the model never sees them.
- **Needs OK: browser in M1.** `browser: true` is refused (tool error, no run) with "The browser isn't turned on for this bot (it arrives in a later update), so this script can't use it. Run it without the browser." The M2 browser request card is BE-P2-14.
- **Needs OK: group folders.** `cwd: groups/<slug>` for a group the bot isn't a member of (or an archived/unknown one) is refused before any run: "The folder groups/<slug> isn't available: this bot isn't in that group, so it isn't on its computer." Such groups are also not mounted (`botMounts`), so they aren't under `/bot/groups`.
- **Needs OK: failed runs.** A run that ends `failed`/`timed_out`/`stopped`/`unavailable` still returns its full result to the model, but the tool call and its activity step are `ok:false` ("Couldn't run <name>"). Start refusals (400/404/409 from RunService) return the message as a tool error. Network `on` goes through RunService, which records the runner's `NETWORK_UNAVAILABLE` refusal as an `unavailable` run (card shown) and returns it.
- **Needs OK: waiting and stopping.** `run_script` waits up to 14 min for its run (queue, snapshot, run), then answers with the current state and `note` (the card keeps updating). Its tool timeout is 15 min; `vm_install`'s is 20 min. Stopping the reply (abort) stops its script.
- **Needs OK: file changes.** A script's file changes stay on its run card (`ScriptRun.filesChanged`, undo); they are not added to the reply's `filesChanged`.
- **Needs OK: `vm_install` result.** `{installed, generation, note, logTail?}` (log tail ≤ 2,000 chars). Errors are BotEnvService's (400 bad names, 409 `internet_never`, 409 `internet_unavailable` — always in M1 since builds run with `--network none` —, 502 `build_failed`) as tool errors.
- **Needs OK: `ToolEntry` additions** (server-only): `timeoutMs?` (per-tool limit instead of the 60 s default) and `resultOk?(value)` (a returned value can mark the call failed). `ToolContext` gains `signal?`, `vm?` and `vmWaitMs?` (tests).
- **Tests:** `vm-tools.test.ts` (fake LLM, fake runner, the app's RunService: DM end to end, group default cwd, non-member refused and not mounted, browser/cwd refusals, network on, abort, not offered, vm_install 409, result trimming); `vm-tools.vm.test.ts` (@vm, real runner: DM script writes the workspace and returns 8 KB tails, a group run writes the group folder, a non-member group is refused and absent from `/bot/groups`, network on refused). The BE-P2-12 @vm tests (`run-service.vm.test.ts`) were run on 2026-10-30 with rootless Podman (3 passed).
- **Gaps:** browser runs (M2), real `vm_install` builds (need internet; M2), @win/@mac not run.

## Routes (BE-P2-17, on `p2/be-17-routes`; additive, items 1–7 approved by Team lead 2026-10-30, gaps accepted for M1)

New routes: `GET`/`PATCH /api/vm/settings`, `POST /api/agents/:id/vm/tools/rebuild` · `/rollback`, `GET /api/runs/:runId/undo/preview`, `POST /api/runs/:runId/undo`. The other M1 routes in the tables above were already live (`/vm/host`, `/vm/probe`, `machine/grow`, per-bot `/vm` GET/PATCH, start/stop/reset, `/vm/tools`, `/script-runs`, `/api/runs/:id`, `/output`, `/stop`, the `/sandbox` alias). No existing response shape changes.

- **Needs OK: `GET /api/vm/settings`** returns `VmSettingsView` (`gvisor`, `backups`, `snapshotBudget`); the defaults when nothing is stored. `volumeId` and `machine` are never served. The Phase 1 `/api/settings` stays as it is (no `vm`).
- **Needs OK: `PATCH /api/vm/settings`** takes `VmSettingsPatch`. It's partial (only the keys sent change) and all-or-nothing (any problem → 400, nothing saved). 400 messages: not an object "Send a JSON object, e.g. {"gvisor": "auto"}."; unknown key (including `volumeId`, `machine`, and unknown `backups.*`/`snapshotBudget.*`) `"<key>" can't be changed here.`; `"gvisor" must be "auto", "force_on" or "force_off".`; `"backups" must be an object…`; `"backups.enabled" must be true or false.`; `"backups.time" must be a 24-hour time like "03:00".`; `"backups.keep" must be a whole number from 1 to 30.`; `"snapshotBudget.<key>" must be a whole number of MB from <min> to <max>.` (`SNAPSHOT_BUDGET_BOUNDS`). **New rule:** `perBotMb` can't be above `globalMb` → 400 "The undo budget per bot can't be larger than the total undo budget." A failed save → 500 "Couldn't save the change. Try again." After a save: a changed `gvisor` re-probes (`app.vmRuntimeModeChanged()`); a changed budget runs `app.vmSnapshotBudget.enforce()` at once and publishes `vm.updated` for every bot (new `usage.snapshots.budgetBytes`). In M1 the `backups` values are stored only (backups are M3).
- **Needs OK: tool rebuild/rollback records.** Each call returns a finished `ScriptRun` with `kind:'tool_build'`, `argv:['rebuild']`/`['rollback']`, `cwd:'workspace'`, `why` "Rebuild the bot's tools" / "Go back to the previous version of the bot's tools", `conversationId` = the bot's DM (or `''` when it has none), `exitCode:0` on success. **No chat card** (no message, no `messageId`); the run shows in `/script-runs`, `VmInfo.runs` and `GET /api/runs/:id`, and `/output?stream=stdout` holds the build log (rollback: "Went back to generation N. System packages: …"). The call answers when the build is done (no `queued`/`running` record meanwhile).
- **Needs OK: rebuild/rollback errors.** 404 unknown bot; **409 `run_active`** ("Wait for the bot's run to finish first.") while the bot has a run queued or running or an undo, and ("Wait for the bot's tools to finish building first.") during another build of the same bot — rebuild now has this check too, not only rollback; 409 `no_previous_generation` (rollback); 409 `internet_unavailable` (rebuild with `vm.packages` non-empty — always in M1). These 4xx answers leave **no** run record. A build failure → **502** with the engine's last line in `message` (5xx bodies carry no `reason`, as everywhere) and a **`failed` tool_build record** (`reason:'build_failed'`, `error` = the message, the message as its log). 503 only when the server has no run service.
- **Needs OK: undo route checks.** Preview: 404 unknown run or bot; **409 `run_active`** (`UNDO_RUN_ACTIVE_TEXT`) while the bot has a run queued or running (new: the preview checks this too); 409 `already_undone`; 410 `UndoGone` (e.g. `expired` for a run without a snapshot). `POST …/undo`: body `{}`/none or `{force: boolean}`; 400 "Send a JSON object…", `"force" must be true or false.`, `"<key>" isn't an undo option…`; 404; 409 `run_active`, 409 `conflicts` with `conflicts: UndoConflictItem[]`, 409 `already_undone`; 410 `UndoGone`. 200 `UndoResult {run, undoRun}` (the run now `undone`, and the recorded `kind:'undo'` run).
- **Needs OK: no `vm_install` route.** Installing packages stays a model tool (BE-P2-16); the plan and contract have no user route for it. The VM tab rebuilds/rolls back only.
- **Bots can't reach these routes:** bot containers run with `--network none` and none of these routes is a model tool, so settings, reset, undo, rebuild/rollback (and the M2 permission routes) are user-only.
- **Server-only:** `BuildAppOptions.vmEngine` (test-only engine for the app's own botEnv and runner); `RunService.toolBuild(agentId, action, build)`.
- **Tests:** `vm-routes.test.ts` (fake engine and runner: settings GET/PATCH, every 400 above, all-or-nothing, re-probe/enforce triggers; rebuild/rollback 200 records, no card, listing, log, 409s without records, 502 recorded failed, one build at a time; undo 404/400/409 `run_active`/410); `vm-routes.vm.test.ts` (@vm, the app's own runner, snapshots and undo on rootless Podman: offline rebuild to generation 1 and the container on it, rollback to 0, then `no_previous_generation`; undo preview, 409 `conflicts` with the list, force, `already_undone`; budget PATCH shows in `VmInfo`).
- **Gaps (not M1):** `/api/vm/backups`, `/api/vm/export`, `/api/agents/:id/export` (BE-P2-18, M3) and the permission routes (BE-P2-14, M2) are not added (they 404 for now). A build in progress isn't shown (no `queued`/`running` tool_build record, no `run.*` events while it builds; `vm.updated` follows the end). Runs started while a rebuild is building aren't blocked (they use the old image until the next container recreate); rollback refuses while a run is active. **M2 plan (Team lead 2026-10-30):** before M2 ships real package builds, a run started while the bot's tools are building must queue behind the build instead of using the old image. @win/@mac not run.

## Files missing check (BE-P2-20, on `p2/be-20-files-missing`; additive, Needs OK)

One check now decides `files_missing` for a bot, used by the VM tab and the file routes alike, so they always agree: the files volume marker (BE-P2-6: missing or another id) **or** that bot's `workspace/` folder (or its whole bot folder) is missing.
- **Needs OK: one message.** `VmInfo.state === 'files_missing'` now has `stateMessage` = BE-P2-6's text, word for word: "AgentControl can't find the bots' files, so files and runs are paused to keep anything from being overwritten. Chats still work." (a marker from another setup gives BE-P2-6's mismatch text instead). It replaces "The bot's files folder is missing." The `POST /vm/start` · `/stop` · `/reset` 409 `files_missing` bodies carry the same `message`.
- **Needs OK: per-bot workspace rule.** When a bot's `workspace/` is missing, that bot's file routes (list, shared list, read, write, folder, move, delete), `PUT /api/conversations/:id/uploads` for its DM and its file tools answer the same **409 `reason:'files_missing'`** with the same message. They no longer quietly re-create the folder. Other bots and group files are unaffected (groups use the volume check only).
- **Needs OK: runs and undo.** A run start (RunService, so `run_script` too), undo and undo preview for that bot answer **409 `reason:'files_missing'`** with the same message (the contract already said runs are paused).
- A bot's folder is created only when the bot is created, and at startup if the bot has no folder at all. A bot folder that exists without `workspace/` stays `files_missing` across restarts until the folder is put back.

## M2 contract: PermissionGate, browser add-on, live tool builds (BE-P2-14/15/21, on `p2/be-m2-contract`; additive, every item Needs OK)

Written ahead of the code so the FE can start FE-P2-3/7/9/10 on fake data. Source: `M2_PLAN.md` §3/§4/§5 (approved with the nine §8 defaults) and mockups 01–15. Types are in `AgentControlBE/src/shared/types.ts` (the M1 Phase 2 block plus a new block at the end, "Phase 2 M2 contract"); nothing serves them yet. Errors keep M1's Fastify shape `{statusCode, error, message, reason?}`: show `message`, branch on `reason`, never show `error`. `<Bot>` below is the bot's name. Every item is **Needs OK**.

### Shared types (all three tasks)
- **Needs OK: `ScriptRun` additions.**
  - `status` already has `waiting_permission` (active: it is in `SCRIPT_RUN_ACTIVE`, but **holds no queue slot**, default 7) and `denied`.
  - `waitingFor?: 'permission'|'browser'` (status `waiting_permission` only).
  - `waitingOnRequestId?`: the pending request it waits on. With one pending request per bot, a 2nd run of the same bot waits on the 1st run's request and gets its own card only if that one ends in Allow once or Deny (Always lets it go on).
  - `permissions: ScriptRunPermission[]`, each `{type, decision, requestId?, source?}`. `decision` uses the answer words (`allow_once`/`always`/`enable`/`deny`, plus `timeout`/`pending`). `requestId` is absent when there was no card. `source` is `card` | `policy` (Always, or the browser already on) | `rebuild` (a user Rebuild click, default 1).
  - `hostsContacted?: HostContact[]`, each `{host, port?, ip?, count, blocked, reason?}`. `reason` is one of `home_network` | `tailscale` | `this_computer` | `model_server` | `metadata` | `private_name` | `port` | `reserved` (`HOST_BLOCK_REASONS`). `port` is set when it isn't 443. `ip` is the checked IP, absent for names refused before resolving.
  - `build?: ToolBuildInfo` (kind `tool_build`, below).
  - `queuedReason?` is BE-P2-20's field (`'slot'|'tool_build'`), not added here.
  - `reason?` gains the M2 run reasons in `M2RunReason`.
- **Needs OK: `ChatRunSummary` additions**, so a card renders from the message alone, as in M1: `waitingFor?`, `network?`, `browser?`, `internet?: 'off'|'once'|'always'`, `hostsContacted?` (blocked first, at most 20), `reason?`, `error?`, `build?`.
  - Card meta, Internet row: `off` · "asked" (`waitingFor:'permission'`) · "asks after the browser" (`waitingFor:'browser'` and `network:'on'`) · "on (allowed once)" · "on (always allowed)".
  - Card meta, Browser row: "on" · "asked".
- **Needs OK: `ScriptRunSummary` additions** (history rows): `internet?`, `hosts?` (up to 3 reached names) and `build?`. These are added in the `& {}` part; the `Pick` list is left to BE-P2-20.
- **Needs OK: `PermissionRequest` additions:**
  - `resolvedBy?: 'user'`, set only when the user answered.
  - `closedBy?: 'run_stopped'|'run_ended'`: status `denied` because the run was stopped or ended while the card was pending.
  - `runKind?` and `scriptName?`, for "To run `fetch_rates.py`" or "the tool build".
  - `groupId?`, for "in Q3 report".
  - `internetNext?`: on a browser request, whether an internet card follows ("Next: internet").
  - `hosts?` (the expected hosts) and `why?` were already in the type.
- **Needs OK: screenshot thumbnail (mockup 06).** There is no new field. A browser run's card thumbnail is the first `.png`/`.jpg`/`.webp` in its `filesChanged`, opened through the existing file routes.

### BE-P2-14 PermissionGate
**Routes** (user session only; a call from a bot or a non-session caller → **403 `user_only`**):

| Method | Path | 200 | Errors |
|---|---|---|---|
| GET | `/api/permissions?status=pending&agentId=&conversationId=` | `PermissionListResponse {requests}` newest first (`status` may also be `all`; default `pending`) | 400 bad `status` |
| GET | `/api/permissions/:requestId` | `PermissionRequest` | 404 `not_found` |
| POST | `/api/permissions/:requestId` `PermissionAnswer {decision}` + header `x-agentcontrol-confirm: 1` | the updated `PermissionRequest` | 400 `bad_decision`; 403 `confirm_required`; 403 `user_only`; 404 `not_found`; 409 `already_resolved` (`PermissionAlreadyResolved`, with `request`); 507 `low_disk` (browser `enable`, see BE-P2-15) |

- **Needs OK: decisions.** Internet takes `allow_once` | `always` | `deny`; browser takes `enable` | `deny` (`PERMISSION_DECISIONS`). Anything else → **400 `bad_decision`**: "“<decision>” isn't an answer for an <internet|browser> request."
- **Needs OK: what each answer does** (the request `status` follows):
  - `allow_once` → `allowed_once`: the run gets a credential for that run only; it is revoked when the run ends.
  - `always` → `always`: also sets `agent.vm.internetPolicy='always'` (`vm.updated` follows), and lets the bot's other waiting runs go on.
  - `enable` → `enabled`: sets `agent.vm.permissions.browser=true` and starts setup (BE-P2-15). The run becomes `waitingFor:'browser'`.
  - `deny` → `denied`.
  - No answer by `expiresAt` (createdAt + 10 min, `PERMISSION_TIMEOUT_MS`) → `timeout`.
  - Every resolution publishes `permission.resolved`. `resolvedAt` is always set; `resolvedBy:'user'` only for answers.
- **Needs OK: order (plan §4 flow).** `run_script` / `vm_install` → RunService → PermissionGate. The run is recorded first (`waiting_permission`, a card message `kind:'run'`).
  - The browser is needed and off → a browser request first (`waitingFor:'permission'`). After `enable` the run waits as `waitingFor:'browser'`.
  - The internet is needed and the policy is `ask` → the internet request is raised only once the browser is ready (default 5).
  - With the policy `always` or after `allow_once`, the run queues (`status:'queued'`) for a slot.
  - Policy `never` → no card; the run ends at once `denied`, `reason:'internet_never'`.
  - Only the user can answer. In groups the card is posted in the group conversation under the running bot's name (`authorAgentId`), and the grant belongs to that bot.
- **Needs OK: permission card messages.** Each request gets one `ChatMessage` `{role:'assistant', kind:'permission', permissionRequestId, authorAgentId}`, created with the request and updated in place. It arrives through the messages `?after=` fetch, like run cards. `PermissionRequest.messageId` points at it. Its `content` (previews):
  - pending: "<Bot> wants to use the internet" / "<Bot> wants to use a browser"
  - resolved: "Internet allowed once" / "Internet always allowed for <Bot>" / "Internet denied" / "Internet request expired" / "Browser turned on for <Bot>" / "Browser denied"
- **Needs OK: denied runs.** Status `denied`, no files changed, `undo` unavailable. The `reason`, the card's `error` (shown as is) and what the model is told:

  | `reason` | Card `error` | Model is told |
  |---|---|---|
  | `permission_denied` | "You denied internet access, so this run didn't start. No files changed." (browser: "You denied the browser, so this run didn't start. No files changed.") | "The user declined internet access." / "The user declined the browser." |
  | `permission_timeout` | "No answer in 10 minutes, so this run didn't start. No files changed." | "No answer in 10 minutes." |
  | `internet_never` | "Internet is set to Never for <Bot>, so this run didn't start. Change it in Settings › VM." | "<Bot>'s internet is set to Never." |

- **Needs OK: Stop while waiting.** `POST /api/runs/:id/stop` on a `waiting_permission` run ends it `stopped` ("The run was stopped before it started."). Its pending request ends `denied` with `closedBy:'run_stopped'` (no `resolvedBy`), and the card shows "Run stopped".
- **Needs OK: run end reasons** (`M2RunReason`; the card shows `error` as is):
  - **`network_off`** (status `failed`): the run had `network:'off'` and stderr shows "network is off". Error: "This run was started with the internet off, so connecting failed. <Bot> can run it again with the internet on."
  - **`proxy_unavailable`** (status `failed`, before start): "AgentControl's internet proxy isn't running, so this run couldn't get the internet. Try again; if it keeps failing, re-check in Settings › VM."
  - **`host_blocked`** (status `failed`, new; only when the script failed and the proxy blocked a host). The error by block reason:
    - `tailscale`: "The script tried to reach your Tailscale network. Home network and Tailscale are always blocked in Phase 2."
    - `home_network` / `private_name`: "The script tried to reach your home network. …" (same second sentence)
    - `this_computer`: "…this computer…"
    - `model_server`: "…your model server…"
    - `metadata`: "…a cloud metadata address…"
    - `port`: "The script tried a port other than 80 or 443, which is blocked."

    A run that still succeeds keeps its blocked rows in "Sites used" and gets no error.
  - **Proxy refusal text** (BE-P2-13's body; the script sees it, e.g. `ProxyError: 403 Blocked: …`): "Blocked: <ip or name> is on your <home network|Tailscale network|…>".
  - M1's `internet_unavailable` and the "Internet access isn't available yet." failure are **retired**.
  - `run_script` `network:'on'` and `browser:true` are no longer refused.
- **Needs OK: `run_script` arg `hosts?: string[]`** (≤ 10, display only, never enforced): it fills the card's "Expects to reach" (`PermissionRequest.hosts`). `why` is reused for the card's quote.
- **Events:**
  - `permission.requested {conversationId, request}` and `permission.resolved {conversationId, request}`, already in `LiveEvent`.
  - `run.updated` for every run status change: queued, waiting, running, ended.
  - After an SSE `reset`, re-fetch `GET /api/permissions?status=pending`.
- **Card copy the FE builds** (from the mockups; FE-owned, no API text):
  - pending: "Nothing in this run reaches the internet until you choose."; footer "Public sites only, through AgentControl's proxy. Your home network, Tailscale, this computer and your model server stay blocked."; timer from `expiresAt`.
  - group: "Only you can answer; other bots in this group can't."
  - allowed once: "You allowed this run at <time>. <Bot> asks again next time."
  - always: "<Bot>'s Internet rule is now Always allow. Change it in Settings › VM."
  - denied: "You denied it at <time>. <Bot> was told “The user declined internet access.”"
  - expired: "No answer in 10 minutes, so it counted as Deny (<time>). <Bot> can ask again if you want it to."
  - 409: "This was already answered in another window (<status> at <resolvedAt>)."
  - network error: "Couldn't send your answer: <message>. Try again."

### BE-P2-15 Browser add-on
| Method | Path | 200 | Errors |
|---|---|---|---|
| GET | `/api/vm/browser` | `BrowserAddonInfo` | |
| POST | `/api/vm/browser/retry` `BrowserRetryRequest {agentId?}` | `BrowserAddonInfo` | 404 unknown bot; 409 `nothing_to_retry` ("There's nothing to retry."); 507 `low_disk` |
| DELETE | `/api/vm/browser` + header `x-agentcontrol-confirm: 1` | `BrowserAddonInfo` (`state:'absent'`) | 403 `confirm_required`; 409 `browser_in_use` ("Turn off the browser for every bot first (used by <names>)."); 409 `browser_busy` (download in progress) |
| PATCH | `/api/agents/:id/vm` `{permissions:{browser:true\|false}}` | `VmInfo` | `true` now works (M1's 400 is lifted); 507 `low_disk`; `egress` still 400 `egress_reserved` "Home network access isn't available in Phase 2" |
| POST | `/api/agents` with `browser?: boolean` (`AgentInput`, create only) | as before | same as PATCH `true` (507 `low_disk` creates nothing) |

- **Needs OK: name.** The plan's `BrowserState {state, progress, bytes, totalBytes, error, usedBy}` object is **`BrowserAddonInfo`**, because `BrowserState` is already M1's `'absent'|'downloading'|'ready'|'error'` union (used by `VmInfo.permissions.browserState`, kept in step).
  - `BrowserAddonInfo` = `{state, progress?, bytes?, totalBytes, etaSec?, error?: BrowserError, usedBy: agentId[], readyAt?}`.
  - "Remove download" shows when `state:'ready'` and `usedBy` is empty.
- **Needs OK: per bot, `VmInfo.browser?: BotBrowserInfo`.** It has `{state, setup?, error?, chromium?: {version, checkedAt}}`. The plan's `vm.browser` states are `off` | `setting_up` (waiting for the shared download) | `rebuilding` | `waiting_idle` | `ready` | `error`.
  - `setup: BrowserSetup` is the setup card's steps: `{turnedOnAt, turnedOnBy:'user', requestId?, runId?, download{startedAt?, endedAt?, bytes?, totalBytes?, reused?}, rebuild{runId?, startedAt?, endedAt?}, check{status, at?, message?}, readyAt?}`. From it the FE gets "download 1 min 42 s, rebuild 52 s, Chromium check passed" and "Step 2 of 3".
  - `error: BrowserError {reason:'download_failed'|'low_disk'|'build_failed'|'chromium_check_failed', message, at, neededBytes?, freeBytes?, bytes?}`.
  - `permissions.browser` stays `true` in `error`; the user picks Try again or Turn off.
- **Needs OK: turn-on flow** (from a card `enable`, a VM tab PATCH after the FE's confirm dialog (default 6), or create):
  1. Low-disk check: free space must cover the download (`SHARED_IMAGE_APPROX_BYTES` browser, 1343 MB) plus the 3 GB run floor. If not → 507 `low_disk` ("The download needs about 1.3 GB and this computer has 0.6 GB free. Free some space, then try again.").
  2. The shared `botvm-browser` download (skipped with `reused:true` when present), with `browser.updated` about every 1 s.
  3. A `tool_build` run with `build.via:'browser'`, `base:'browser'`, which keeps the bot's packages and tools.
  4. `waiting_idle`: the container is recreated once the bot's current run ends.
  5. A re-probe with the real `chromium` check for that bot. Then `ready`, and the waiting run carries on (internet card next if the policy is ask).
- **Needs OK: a card `enable` with low disk** still answers 200 (`enabled`), and the setup fails at once with `error.reason:'low_disk'` (mockup 09 shows it as a resolved card). The 507 is only for PATCH, create and retry.
- **Needs OK: setup failures end the waiting run** `failed` (it never started; no files changed):

  | Failure | Run `reason` | Run `error` |
  |---|---|---|
  | Download | `browser_unavailable` | "The browser couldn't be turned on, so this run didn't start." |
  | Low disk | `browser_unavailable` | "The browser couldn't be turned on, so this run didn't start." |
  | Build | `browser_unavailable` | "The browser couldn't be turned on, so this run didn't start." |
  | Check | `chromium_check_failed` | "Chromium didn't start for <Bot>, so this run didn't start." |

  The bot's previous tools generation is kept. Setup error messages (`BrowserError.message`):
  - download: "The Chromium download stopped at <n> MB (<cause>)."
  - check: "Chromium was installed but didn't start (<cause>)." (probe detail, e.g. "libnss3.so missing")
  - build: the build's failure text.
- **Needs OK: retry.** `POST /api/vm/browser/retry {}` restarts a failed shared download. With `{agentId}` it retries that bot's failed step (download, rebuild or check); this is the check-error "Re-check" / "Try again".
- **Needs OK: turning off** (`browser:false`). The bot is rebuilt back onto the base when idle (a `tool_build`, `via:'browser'`, `base:'base'`); during a setup this cancels it. The shared download stays until "Remove download".
- **Needs OK: Never + browser.** The browser runs with `--network none`, so only `file://` pages work. `browser-basics` (a seeded skill) tells the bot this, plus `BROWSER_LAUNCH_NOTE`.
- **Events:**
  - `browser.updated {browser: BrowserAddonInfo}`: new in `LiveEvent`, global, sent to every subscriber whatever the filters.
  - `vm.updated` for every per-bot state change (`VmInfo.browser`).
  - `run.updated` for the waiting run and the rebuild.
  - After `reset`, re-fetch `GET /api/vm/browser`.
- **VM tab copy** (FE-owned, mockups 11–15):
  - downloading: "<bytes> of 1.3 GB · about <etaSec> left"
  - rebuilding: "Step 2 of 3 · rebuild <elapsed>"
  - waiting_idle: "Ready; <Bot>'s VM restarts after the current run finishes."
  - ready: "Chromium <version> · checked <time> · download shared by <n> bots (1.3 GB)"
  - unused download: "The Chromium download (1.3 GB) is still on this computer and no bot uses it."
  - Size copy everywhere: "about 1.3 GB" (default 8).

### BE-P2-21 Live tool builds with Stop
| Method | Path | Answer | Errors |
|---|---|---|---|
| POST | `/api/agents/:id/vm/tools/rebuild` | **202 `ToolBuildAccepted {run}`** (`kind:'tool_build'`, `queued` or `running`; was 200 with a finished run) | 404; 409 `build_active` ("<Bot>'s tools are already building."); 409 `internet_never` ("Set internet to Ask or Always to install packages.") when `vm.packages` is non-empty and the policy is never; 503 `proxy_unavailable` (same text as the run reason); 507 `low_disk` (the M1 run floor) |
| POST | `/api/agents/:id/vm/tools/rollback` | 200 `ScriptRun` (unchanged, still synchronous) | 409 `build_active`, 409 `run_active`, 409 `no_previous_generation` |
| POST | `/api/agents/:id/vm/reset` · `/vm/stop` | as M1 | **409 `build_active`** ("Wait for <Bot>'s tools to finish building, or stop the build.") |
| POST | `/api/runs/:runId/stop` | `ScriptRun` | also for `tool_build`, as in M1 |
| GET | `/api/runs/:runId/output?stream=stdout` | build log (live while running) | as M1 |

- **Needs OK: the record.** Rebuild and `vm_install` builds are `ScriptRun`s with `kind:'tool_build'`. They go `queued` → (`waiting_permission`) → `running` → `succeeded` | `failed` | `timed_out` | `stopped`.
  - `build: ToolBuildInfo {generation, fromGeneration, packages, added, removed?, startedBy:'user'|'bot', via:'rebuild'|'vm_install'|'browser', base, progress?: {step, steps, label}}`.
  - `argv` stays `['rebuild']`; `vm_install` builds use `['vm_install', ...packages]`.
  - `network` is `'on'` when packages need installing.
  - Builds have a 20 min limit (`TOOL_BUILD_TIMEOUT_MS`).
- **Needs OK: internet for builds.** A user Rebuild is its own one-build grant, with no card (default 1): `permissions:[{type:'internet', decision:'allow_once', source:'rebuild'}]`.
  - A `vm_install` under `ask` raises a normal internet card (`runKind:'tool_build'`; resolved title "Internet allowed for the tool build").
  - Under `always`, no card.
  - Under `never`, the tool returns the M1 409 `internet_never` as a tool error, and no record is made.
  - No registry pinning (default 2). Ports 80/443 only (default 3).
- **Needs OK: chat card.** Every build posts a `kind:'run'` card (`ChatRunSummary.kind:'tool_build'` with `build`). It goes in the conversation where `vm_install` was called, or in the bot's DM for a user Rebuild (created if missing).
  - Card name: "Rebuild tools".
  - `content`: "Building <Bot>'s tools (version N)" / "Built <Bot>'s tools (version N)" / "Tool build (failed)" / "(stopped)" / "(timed out)".
  - Meta: "Started by <Bot> (vm_install)" or "Started by you".
  - This replaces M1's "no chat card".
- **Needs OK: live progress.**
  - `run.output` streams the log (M1 coalescing).
  - `run.updated` carries `build.progress` and `hostsContacted` ("Sites used so far") at most once per second, plus every status change.
  - `vm.updated` carries `VmInfo.activeBuild` (`{runId, status, startedAt?, build, internet, hosts}`, the "Building tools" head), and `VmToolsInfo.activeBuild` carries the same.
- **Needs OK: Stop.** `POST /api/runs/:id/stop` on a build ends it `stopped`, `reason:'build_stopped'`, with "Stopped. <Bot> keeps its current tools (version N)." The generation `fromGeneration` is kept, and runs queued after the build (BE-P2-20) then start on it (default 4).
- **Needs OK: failure.**
  - `failed`, `reason:'build_failed'`, "The build failed, so <Bot> keeps its current tools (version N). Nothing else changed." The engine's last line is in the log.
  - A build failure is no longer a 502 on the rebuild route (it answers 202 first). The 502 stays only for `vm_install`'s tool error.
  - Timeout: `timed_out`, "The build took longer than 20 minutes, so <Bot> keeps its current tools (version N)."
- **Card and VM tab copy** (FE-owned):
  - "Stopping keeps the current tools (version N)."
  - "Adding <added> (version N) · <elapsed>. New runs wait for the build, then use the new tools."
  - "Step <step> of <steps> · <label> · internet allowed once for this build"
  - The queued run card ("Queued · after tool build", BE-P2-20).
  - Rebuild and "Go back to version N" are disabled with "Available when the build finishes." while `activeBuild` is set.

### Error and reason summary (M2)
- **400:** `bad_decision`, `egress_reserved`.
- **403:** `confirm_required`, `user_only`.
- **404:** `not_found`.
- **409:**
  - `already_resolved` (+ `request`)
  - `browser_in_use`
  - `browser_busy`
  - `build_active`
  - `run_active`
  - `internet_never`
  - `nothing_to_retry`
- **502:** `build_failed` (`vm_install` tool only).
- **503:** `proxy_unavailable`.
- **507:** `low_disk`.

These are listed in `M2ErrorReason`; 5xx bodies carry no `reason`, as in M1. Run end reasons are listed in `M2RunReason`.

### Open questions
1. **Run events.** The plan lists `run.queued/started/updated/finished`; M1 has only `run.updated` (every status change) and `run.output`. Proposal: keep `run.updated` for all of them, with no new event types. Or should the four names be added as aliases?
2. **Error body.** The plan writes `{error, reason, message}`; M1 sends Fastify's `{statusCode, error, message, reason}` with `message` as the text. Proposal: keep M1.
3. **`internet_never`:** run status `denied` (mockup 08) or `failed` (plan: "fail at once")? Which copy, the plan's "<Bot>'s internet is set to Never." or the mockup's longer line? Proposal: `denied`, with the mockup line on the card and the plan line for the model.
4. **Where "Expects to reach" hosts come from.** Proposal: a new display-only `run_script` arg `hosts?`. Also: is `vm_install`'s card filled from known registries (pypi.org, files.pythonhosted.org, deb mirrors)?
5. **Stop on a waiting run:** the request ends `denied` with `closedBy:'run_stopped'`, or a new status `cancelled`?
6. **Browser `enable` with low disk:** 200 with a failed setup (proposed, as mockup 09 shows), or 507 with the card left pending?
7. **Retry scope.** `/api/vm/browser/retry` is global in the plan, but the check failure is per bot. Proposal: an optional `{agentId}`.
8. **Waiting run on a setup failure.** Mockup 09 says "`snap_dashboard.py` was stopped". Proposal: `failed` with `browser_unavailable` / `chromium_check_failed`, not `stopped`, and the FE keeps the mockup sentence. OK?
9. **Turning the browser off** rebuilds back onto the base (another build). OK, or keep the browser base until the next rebuild?
10. **`POST /api/agents` `browser`** (mockup 15). The plan is silent. Proposal: create only; is the toggle itself consent (no confirm dialog)?
11. **VM Stop during a build.** Mockup 14 disables Stop and Reset; the plan only names rollback/reset for `build_active`. Proposal: `/vm/stop` 409 `build_active` too.
12. **Build progress steps** ("Step 4 of 6 · pip install"): which steps count (pull base, apt, pip, npm, commit, recreate)? Proposal: best effort `build.progress`; the FE hides the step text when absent.
13. **The user Rebuild card's conversation:** the bot's DM (proposed, created if missing), or no card for user rebuilds?
14. **`host_blocked`.** A new run reason and per-reason error lines for failed runs that hit a blocked host (mockup 08 has the Tailscale line only). Are the other lines OK?
15. **The `port` and `reserved` block reasons** are new; the plan's list has neither, though default 3 shows "blocked · port".
16. **Screenshot thumbnail** from the first image in `filesChanged` (no new field). OK?
17. **Rollback** stays synchronous 200 (a tag switch, no download). OK?

### Plan vs mockups (conflicts found)
1. **Resolved IPs for refused names.** Mockups 06 and 08 show "metrics.internal.lan → 10.0.0.12" and "nas.tail1234.ts.net → 100.101.7.3". But plan §5 refuses `*.lan` and `*.ts.net` **before resolving**, so no IP exists. Contract: `ip` is absent for those (the FE shows just the name), and the proxy text names the host instead.
2. **internet_never shown as "Denied"** (mockup 08) vs a run *failure* reason in the plan (question 3).
3. **Mockup 09 "was stopped"** vs the plan's `browser_unavailable` failure reason (question 8).
4. **Mockup 14 disables the VM head's Stop during a build**, while the plan says builds can be stopped. These are compatible: the build's Stop is on its run card and history row, and the disabled one is the VM Stop (question 11).
5. **The plan's `BrowserState` object** clashes with M1's `BrowserState` union; renamed `BrowserAddonInfo`.
6. **The plan's `permissions[].decision` example `'allowed_once'`** (§3) uses the request-status word; the M1 type and this contract use the answer word `allow_once`.
7. **Mockup 08's proxy-down card** shows the meta label "runtime limit while waiting" next to a run that never started. The FE should drop that label; no API impact.
8. **Task ID clash.** The plan's **BE-P2-20 is "Build queue carry-over"**, but this contract file already has a section "Files missing check (BE-P2-20, on `p2/be-20-files-missing`)" from an earlier task. One of them needs a new number.

### Not in this change
No server code: the routes and events above don't exist yet (they 404 / aren't sent). `types.ts` only gains types and optional fields; `tsc --noEmit` passes. `ScriptRun.permissions[].requestId` became optional (no code read it). `queuedReason` is left to BE-P2-20.
