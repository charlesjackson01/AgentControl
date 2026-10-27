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
| GET | `/api/runs/:runId/undo/preview` | `UndoPreview` | 409 `UndoConflict{reason:'run_active'}`, 410 `UndoGone` (both error bodies: text in `message`) |
| POST | `/api/runs/:runId/undo` `UndoRequest{force?}` | `UndoResult` | 409 `UndoConflict` (`run_active`, or `conflicts` with the list), 410 `UndoGone{reason}` (both error bodies: text in `message`) |

**Undo preview (additive, agreed 2026-10-27):** each `changes[]` entry may carry `beforeBytes?`/`afterBytes?` (number, or null for the side that doesn't exist: added files have `beforeBytes:null`, deleted files `afterBytes:null`) and `groupName?` beside `groupId`; `conflicts[]` may carry `groupName?`. `UndoPreview.budget?: {usedBytes, limitBytes}` mirrors the bot's snapshot budget from VmInfo. For a 410 with `reason:'machine_restored'` the `message` text is exactly "This bot's computer was restored from a backup, so this run can't be undone." (`UNDO_MACHINE_RESTORED_TEXT`); the FE shows the body's `message` as is. File reads by later runs aren't tracked in M1.

**Run cards and file scopes (additive, agreed 2026-10-27):** `ChatRunSummary` may carry `scriptName?` (argv[1] or argv[0]; the card title, with `name`, the skill, as its source), `durationMs?`, `runtime?` and, for undo runs, `undoOfName?` (the reversed run's script name, else skill), so a card renders from the message alone and fetches `GET /api/runs/:id` only when the details or full output are opened. `ScriptRunUndo.changedBytes?` is set with `reason:'too_large'`. Each `FileChange` (run `filesChanged`, activity) may carry `root?: 'agent'|'group'` plus `groupId?`/`groupName?` for root `group`, the same shape as `UndoPreview`; `path` is relative to that folder, with no string prefix. A missing `root` means `agent` (Phase 1 shape). Run messages carry a short plain `content` for previews, built by `runMessageContent()` (src/run-messages.ts) from the summary and updated with it: "Running report.py" / "Queued report.py" while active, "Ran report.py" on success, "Ran report.py (failed)" / "(timed out)" / "(stopped)" / "(denied)" otherwise, "Ran report.py (undone)" once undone, and for an undo run "Undoing report.py" while active, "Undid report.py" on success, "Undo of report.py (failed)" otherwise. The name is `scriptName`, else `name`. Full output opens in a dialog in M1.

**VM tab meters (agreed 2026-10-27):** memory is `usage.memoryMb` of `limits.memoryMb`; bot files & tools is `usage.personalBytes` (always the sum of `usage.breakdown`) of `usage.personalQuotaBytes`; undo snapshots is `usage.snapshots.bytes` of `budgetBytes` (separate, not in the 10 GB); per run shows `limits`. `VmInfo.runsHasMore` says whether older runs exist beyond `VmInfo.runs`; the script-runs list returns `hasMore` on every page. The bot files & tools meter groups `tools`, `opt` and `imageLayer` as "tools and packages". `ScriptRunSummary` may carry `files?: {added, modified, deleted}` (the split of `filesChangedCount`) and `network?`. Start empty for `files_missing` is M3, alongside Restore; M1 only explains the state.

## Global
| Method | Path | 200 |
|---|---|---|
| GET | `/api/vm/host` | `VmHostInfo` |
| GET/PATCH | `/api/vm/settings` | `VmSettingsView` (PATCH `VmSettingsPatch`, bounds in `SNAPSHOT_BUDGET_BOUNDS`, `BACKUP_KEEP_BOUNDS`) |
| GET/POST | `/api/vm/probe` | `VmProbeResult` (last result / re-check) |
| POST | `/api/vm/machine/grow` `{toGb}` | `VmHostInfo`; 409 runs active, 400 low host disk |
| GET | `/api/vm/export` | archive stream |

## Live events: `GET /api/events` (SSE, M1)
- Frame: `id: <n>` · `event: <type>` · `data: <LiveEvent JSON>`. Types: `run.updated` (full run + `summary` + `messageId`), `run.output` (chunk), `vm.updated`. `permission.*` are M2.
- Catch-up: `Last-Event-ID` header (or `?lastEventId=`); replay from a ring of the last 1000. Too old → first frame `event: reset`, then re-fetch active runs and VM info.
- Heartbeat: `: ping` every 15 s; `retry: 3000` on connect.
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
