# Phase 2 M1 API contract (BE-P2-1)

Types: `AgentControlBE/src/shared/types.ts`, section "Phase 2" (hand-copy to the FE as in Phase 1).
Errors stay `{ error: string }` with plain-language text; 409/410 add `reason`.
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
| POST | `/api/agents/:id/vm/reset` `{confirm:true}` | `VmInfo` | 400 no confirm, 409 run active |
| GET | `/api/agents/:id/vm/tools` | `ToolManifest & {packages, image}` | |
| POST | `/api/agents/:id/vm/tools/rebuild` · `/rollback` | `ScriptRun` (kind tool_build) | 409 run active, 409 no previous generation |
| GET | `/api/agents/:id/export` | zip stream | |
| GET | `/api/agents/:id/runs?before=<runId>&limit=50` | `{ runs: ScriptRunSummary[], hasMore }` newest first | |
| GET | `/api/runs/:runId` | `ScriptRun` | 404 |
| GET | `/api/runs/:runId/output?stream=stdout\|stderr` | text/plain full log | 404, 410 log evicted |
| POST | `/api/runs/:runId/stop` | `ScriptRun` | 409 not active |
| GET | `/api/runs/:runId/undo/preview` | `UndoPreview` | 409 `UndoConflict{reason:'run_active'}`, 410 `UndoGone` |
| POST | `/api/runs/:runId/undo` `UndoRequest{force?}` | `UndoResult` | 409 `UndoConflict` (`run_active`, or `conflicts` with the list), 410 `UndoGone{reason}` |

## Global
| Method | Path | 200 |
|---|---|---|
| GET | `/api/vm/host` | `VmHostInfo` |
| GET/PATCH | `/api/vm/settings` | `VmSettingsView` (PATCH `VmSettingsPatch`, bounds in `SNAPSHOT_BUDGET_BOUNDS`, `BACKUP_KEEP_BOUNDS`) |
| GET/POST | `/api/vm/probe` | last probe per check / re-check |
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
