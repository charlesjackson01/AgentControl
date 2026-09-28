# AI-Arch AI Layer — Service Interfaces & Runtime

**Status: Stage D (2026-08-27).** Authoritative for the L3 AI service layer:
configuration model, D-Bus contracts, gateway behavior, context handling,
agent runtime, and RAG. Layer boundaries: `docs/ARCHITECTURE.md`. Security:
`docs/SECURITY.md`.

All services: user-session systemd services, C++/Qt6, KDE Frameworks
(`KDBusService`, `KConfig`, `KNotification`; `KWallet` from Stage E —
Stage D uses `configd`'s 0600 local secret store). Bus: session bus.
Names: `org.aiarch.<Service>`. Object path per service: `/org/aiarch/<Service>`.
Each service is unique-activation (`KDBusService::ActivationMode::Unique`).

## 1. Design principles

1. **Client-only.** The desktop never hosts inference. The backend is a
   user-configured OpenAI-compatible endpoint (host `llama-server`, LAN box,
   or cloud) — the owner decision that generalized the 2026-08-26 pivot.
2. **One egress for bytes to the model** (`aid`) and **one egress for context
   into prompts** (`contextd`). Every other component that "needs the model"
   goes through `aid`.
3. **One hand on the system** (`permd`). The gateway can *request* tools;
   only `permd` *executes* them (ARCHITECTURE.md A3).
4. **Degrade, never block.** Missing `configd` ⇒ apps show "AI unavailable";
   missing backend ⇒ `offline` status with diagnostics; missing KWin
   introspection ⇒ contextd falls back to "focused app title only".
5. **Small surfaces.** Six services, each with one narrow contract. No
   cross-service D-Bus calls beyond the map below.

Cross-service call map (who calls whom):

```
apps ──▶ configd, aid, permd, contextd, agentsd, ragd   (any app may call any service it shows)
aid ──▶ configd (endpoint, ai_enabled), contextd (scope for request), permd (tool calls)
agentsd ──▶ aid (chat; aid owns the tool loop, §5), configd
ragd ──▶ aid (embeddings via /v1/embeddings), configd
contextd ──▶ configd (privacy/exclusions), cooperating apps' org.aiarch.ContextProvider
permd ──▶ configd (policy defaults), KNotification, (polkit for privileged ops)
```

No other edges. In particular: `aid` never calls `agentsd` or `ragd`;
`permd` never calls `aid`; `agentsd` never calls `permd` or `contextd`
directly (tool calls are resolved by `aid` inside the loop, §5).

## 2. Endpoint & backend model

- Wire protocol: **OpenAI-compatible** (`/v1/chat/completions`,
  `/v1/models`, `/v1/embeddings`), `stream: true` for chat. This is the
  contract that makes "change the endpoint" a config edit, not a rebuild.
- llama.cpp `llama-server`: `--api-key` optional; `--parallel 1` (host
  reality, documented); slot control via `/v1/models` list + model reload
  (`POST /v1/model` where supported; otherwise "unload = stop server" is a
  user action, surfaced read-only).
- Health: `GET /v1/models` with 2 s timeout ⇒ `connected`/`offline`;
  latency sampled on the ping. `degraded` = reachable but last chat failed
  with a backend error, or queue depth > 0 and oldest wait > 30 s.
- Auth: API key held in `configd`'s secret store (ref
  `ai-arch/endpoint-key`; 0600 file in Stage D, KWallet in Stage E —
  SECURITY.md §8), sent as `Authorization: Bearer`, masked everywhere
  else. No key ever in logs.
- Timeouts: connect 5 s; per-request default 600 s (configurable);
  streaming: 30 s between chunks ⇒ abort + `chatError`.

## 3. Configuration model

**File:** `~/.config/ai-arch/ai-arch.json` (user) overrides
`/etc/xdg/ai-arch/ai-arch.json` (distro defaults) key-wise. **Sole writer:**
`configd` (apps/KCM call its D-Bus methods; direct file edits are read and
re-serialized on next change, with a warning signal). Legacy
`/etc/ai-arch/llama-server.json` is read as last fallback and imported into
the JSON on first `configd` start (migration, one-way, logged).

```jsonc
{
  "version": 1,
  "ai_enabled": true,                 // global kill switch
  "endpoint": {
    "url": "http://192.168.122.1:8080",
    "model": "qwen3-27b",
    "api_key_ref": "ai-arch/endpoint-key",   // secret ref, never the key
    "timeout_ms": 600000,
    "max_tokens_default": 1024
  },
  "privacy": {
    "prefer_local": true,             // diagnostic preference, advisory
    "log_retention_days": 30,
    "content_logging": false,         // request/response bodies: off by default
    "excluded_paths": ["~/.ssh", "~/.gnupg", "~/.config/keepassxc", "/etc", "/boot"]
  },
  "permissions": {
    "defaults": { "readonly": "allow", "low": "ask", "sensitive": "ask", "critical": "confirm" },
    "grants": [ /* per-tool remembers, see SECURITY.md §4 */ ]
  }
}
```

`ai-gen` (generalized, still python3 stdlib) reads the same file (user →
distro → legacy) and gains `--model`, `--max-tokens`, `--system`, `--list`
(model list via `/v1/models`), `--json`. It remains the zero-dependency
smoke-test path for the endpoint.

## 4. D-Bus contracts

Signatures: `a{sv}` maps where noted. Errors: `org.aiarch.Error.{Unavailable,
Disabled, NotConfigured, PermissionDenied, Backend, Timeout, Cancelled,
ValidationError}`.

### 4.1 `org.aiarch.Config` (configd), `/org/aiarch/Config`

Properties are **scalar** (not structs): QML reads them through
`org.freedesktop.DBus.Properties` and a struct property is opaque there.
The normative wire contract is `dbus/org.aiarch.Config.xml`; T3
(`tests/contract/check_contracts.py`) diffs it against the live bus.

| Kind | Member | Signature | Notes |
|------|--------|-----------|-------|
| prop | `AiEnabled` | `b` | kill switch, mirrors config |
| prop | `EndpointUrl` | `s` | |
| prop | `Model` | `s` | |
| prop | `ApiKeyRef` | `s` | secret ref, never the key |
| prop | `TimeoutMs` | `u` | |
| prop | `MaxTokensDefault` | `u` | |
| prop | `PreferLocal` | `b` | |
| prop | `LogRetentionDays` | `i` | |
| prop | `ContentLogging` | `b` | |
| prop | `ExcludedPaths` | `as` | |
| prop | `PermDefaultReadonly` / `PermDefaultLow` / `PermDefaultSensitive` / `PermDefaultCritical` | `s` | allow/ask/confirm, one property per class |
| prop | `Version` | `i` | config schema version |
| meth | `SetAiEnabled(enabled b)` | | cascades: aid cancels in-flight, permd stops new grants |
| meth | `SetEndpoint(url s, model s)` | | triggers a health ping, emits `Changed` |
| meth | `SetApiKey(key s)` | | stores in `configd`'s secret store (0600 file in Stage D; KWallet in Stage E — SECURITY.md §8), never echoed |
| meth | `SetPrivacy(section s, value v)` | | validated subset (privacy.*) |
| meth | `SetPermissionDefault(class s, mode s)` | | |
| meth | `TestEndpoint()` → `i result, s model, i latency_ms` | | `GET /v1/models`; 0 = ok, 1 = unreachable, 2 = not configured |
| sig | `Changed()` / `ChangedSection(section s)` | | section: `endpoint`, `privacy`, `permissions`, `ai_enabled`, `reloaded` |
| sig | `FileReplaced(path s)` | | user config file replaced externally (inode change) |

### 4.2 `org.aiarch.AI` (aid / gateway), `/org/aiarch/AI`

Scalar properties as in §4.1; normative contract: `dbus/org.aiarch.AI.xml`.

| Kind | Member | Signature | Notes |
|------|--------|-----------|-------|
| prop | `State` | `s` | `offline` \| `degraded` \| `connected` |
| prop | `EndpointUrl` | `s` | |
| prop | `Model` | `s` | |
| prop | `LatencyMs` | `i` | last `/v1/models` ping |
| prop | `QueueDepth` | `i` | |
| prop | `ActiveRequests` | `i` | |
| prop | `FailedRequests` | `i` | |
| prop | `QueuePaused` | `b` | |
| prop | `UsageToday` / `UsageMonth` | `x` | tokens (64-bit), from usage.db |
| prop | `UsageTodayCost` / `UsageMonthCost` | `d` | 0 until pricing rates land with the KCM (Stage E) |
| meth | `Chat(req a{sv})` → `r request_id` | req: `app s, chat_id s, messages a{sv} (role, content), model s?, max_tokens i?, temperature d?, tools a{sv}?, context_scope s?, max_steps i? (default 8; enforced by aid)` | queued; see §5 lifecycle |
| meth | `Cancel(request_id s)` | | |
| meth | `Models()` → `a{sv}` | from `/v1/models` |
| meth | `ReloadModel(model s)` | | |
| meth | `UnloadModel()` | | |
| meth | `SetDefaultModel(model s)` | writes config via configd |
| meth | `TestModel(model s)` → `i latency_ms` | one-token completion |
| meth | `Diagnostics()` → `a{sv}` | endpoint reachability, DNS/TCP/TLS steps, last error, queue snapshot |
| meth | `UsageRange(start t, end t)` → `a{sv}` | per-day/per-model buckets |
| meth | `Logs(app s, n i)` → `a{sv}` | recent request log entries (respects content_logging) |
| meth | `PauseQueue()` / `ResumeQueue()` | | |
| sig | `StatusUpdated()` | generic property-changed (all props above) | |
| sig | `StatusChanged(state s)` | | |
| sig | `ChatDelta(request_id s, delta s)` | streamed tokens |
| sig | `ChatDone(request_id s, reply s, tool_calls a{sv}, usage a{sv})` | final content + tool calls requested + token counts |
| sig | `ChatError(request_id s, code s, message s)` | | |
| sig | `RequestUpdated(request_id s, state s)` | queued/streaming/done/error/cancelled |

### 4.3 `org.aiarch.Permits` (permd), `/org/aiarch/Permits`

| Kind | Member | Signature | Notes |
|------|--------|-----------|-------|
| meth | `Request(tool s, args a{sv}, request_id s, purpose s)` → `s decision, s confirm_id` | decision: `allowed` (with confirm_id for audit) or `denied`/`pending`; R3 returns `pending` until modal answer |
| meth | `Respond(confirm_id s, allow b, remember b)` | | |
| meth | `Grant(tool s, args_pattern a{sv}, scope s)` / `Revoke(tool s)` | remembers |
| meth | `Policy()` → `a{sv}` | defaults + grants, for Diagnostics |
| sig | `PermissionRequested(confirm_id s, tool s, args a{sv}, purpose s, class s)` | KNotification shows what/why/impact |
| sig | `PermissionDecided(confirm_id s, allow b)` | |
| sig | `Audited(entry a{sv})` | append-only event |

Tool registry and executor details: `docs/SECURITY.md` §4.

### 4.4 `org.aiarch.Context` (contextd), `/org/aiarch/Context`

| Kind | Member | Signature | Notes |
|------|--------|-----------|-------|
| prop | `Available` | `a{sv}` | desktop-side: focused `{app, window_title, workspace}`, open windows, session app list, system info — **not** sent to any backend |
| prop | `Exposed` | `a{sv}` | what the *current* default scope will add to prompts |
| prop | `Pinned` | `a{sv}` | user-pinned context items |
| prop | `Exclusions` | `as` | from config |
| meth | `SetExposed(key s, exposed b)` | per-source opt-in (focused-content, open-files, session-apps, system-info) |
| meth | `Pin(item a{sv})` / `Unpin(item_id s)` | |
| meth | `AttachFile(path s)` / `AttachDataset(id s)` | explicit attachments for the next request |
| meth | `Resolve(scope s, request_id s)` → `a{sv}` | **only method aid calls**; returns the vetted context block for one request (applies opt-ins, pins, attachments, exclusions) |
| sig | `AvailableChanged()` / `ExposedChanged()` / `PinnedChanged()` | |

Cooperating apps (the nine AI apps, and later stock apps that opt in)
implement `org.aiarch.ContextProvider` on their own connection:
`ProvideContext()` → `a{sv}` (e.g., assistant: current conversation
summary; file manager: active folder/file list). contextd discovers
providers by interface, calls them only when the source is exposed, and
never passes their output through the gateway — only into `Resolve()`.

**Default scope** (Stage D §6): focused window metadata (title/app/
workspace) only. No content. Everything else is opt-in per source, per the
KCM Privacy page (Stage A §12.3).

### 4.5 `org.aiarch.Agents` (agentsd), `/org/aiarch/Agents`

| Kind | Member | Signature | Notes |
|------|--------|-----------|-------|
| meth | `List()` → `a{sv}` | | |
| meth | `Get(id s)` → `a{sv}` | definition: name, prompt, model override, tools (allowlist), guardrails, `trigger` (manual/schedule/event; schedule+event deferred to Stage E), `max_steps` |
| meth | `Create(def a{sv})` / `Update(id s, def a{sv})` / `Delete(id s)` | |
| meth | `Run(id s, input a{sv})` → `s run_id` | |
| meth | `Stop(run_id s)` | |
| meth | `Runs(limit i)` → `a{sv}` | history: status, steps, duration, tokens |
| sig | `AgentUpdated(id s)` / `RunUpdated(run_id s, state s, step s)` | |

Agent execution: `agentsd` builds the request from the agent definition +
guardrail-wrapped tool allowlist → `aid.Chat(tools=…, max_steps=…)` →
**`aid` owns the model interaction loop** (§5: resolves tool calls via
`permd`, enforces `max_steps`, streams deltas, records usage). `agentsd`
owns agent-level orchestration only: it observes `RunUpdated`/`ChatDone`,
handles stop/enable/disable (stop ⇒ `aid.Cancel`), and keeps run history.
Every loop iteration emits `RunUpdated`. Agent definitions carry
`trigger` (`manual | schedule | event`) and schedule fields in the
contract; **scheduling implementation is deferred to Stage E** (the
contract field is reserved now). A workflow is an agent whose `prompt`
field is a fixed pipeline definition (input schema → steps → output
schema); no other differences (ARCHITECTURE.md A9).

### 4.6 `org.aiarch.Rag` (ragd), `/org/aiarch/Rag`

| Kind | Member | Signature | Notes |
|------|--------|-----------|-------|
| meth | `List()` → `a{sv}` | datasets: id, name, docs, vectors, last index |
| meth | `Create(name s)` / `Remove(id s)` | |
| meth | `AddDocuments(id s, paths as)` → `s job_id` | chunk + embed async |
| meth | `RemoveDocument(id s, path s)` | |
| meth | `Reindex(id s)` → `s job_id` | on embedding-model change |
| meth | `Query(id s, q s, k i)` → `a{sv}` | top-k with scores + source paths |
| sig | `DatasetUpdated(id s)` / `IndexProgress(job_id s, pct i)` | |

Storage: SQLite per dataset (`~/.local/share/ai-arch/rag/<id>.db`),
vectors as BLOB, brute-force cosine (dataset sizes here are small; a native
vector DB would be a dependency we don't need). Chunking: 512 tokens, 64
overlap, text + markdown; PDFs via `pandoc` if present (else skipped,
reported). Embeddings via `aid`'s `/v1/embeddings` (single egress, principle
1) with the model's embedding model; if the endpoint lacks embeddings,
ragd reports `embeddings_unavailable` and RAG Tools shows the state
(unresolved Q4, ARCHITECTURE.md §10).

## 5. Gateway request lifecycle (`aid`)

```
Chat() ─▶ validate (schema, ai_enabled, config present)
        ─▶ queue (FIFO per model; queue_depth visible)
        ─▶ contextd.Resolve(scope)      (if context_scope set)
        ─▶ HTTP POST /v1/chat/completions (stream)
        ─▶ ChatDelta* → (tool_calls? → permd.Request per call →
             allowed: permd executes, result appended, loop;
             denied: "denied by user" appended, loop)
             [aid owns this loop; repeats until final answer or
              max_steps (default 8) ⇒ forced final answer; agentsd
              observes only]
        ─▶ ChatDone / ChatError
        ─▶ usage.db write + log line (content only if content_logging)
```

- **Cancellation:** `Cancel()` aborts the HTTP stream, cancels queued
  items, denies pending tool confirmations, emits `ChatError(Cancelled)`.
- **Retries:** connect/DNS failures retry once after 1 s; mid-stream
  failures do not retry (content already delivered).
- **Concurrency:** default 1 in-flight per model (matches `-np 1`); the
  queue is the user-facing mechanism (Inference Manager shows it).
- **Logs:** one line per request: ts, app, model, tokens in/out, latency,
  error code; body only if `content_logging: true`.

## 6. Usage metering & Monitoring

`usage.db` (SQLite): `(ts, app, model, tokens_in, tokens_out, est_cost)`.
Cost estimate = configurable per-1M-token rates (default 0 for local
endpoints; KCM Privacy page documents it). The `org.aiarch.AI` usage
properties (`UsageToday`/`UsageMonth`, 64-bit) and the `UsageRange`
method back the Monitoring app (today/month, per-app, per-model).

## 7. Decisions

| # | Decision | Alternatives | Why rejected |
|---|----------|--------------|--------------|
| I1 | OpenAI-compatible HTTP as the only backend protocol | native llama.cpp IPC; per-backend adapters | one contract ⇒ endpoint is a config knob; adapters multiply test surface for marginal gain |
| I2 | Single JSON config, `configd` sole writer | KConfig (`rc`-style) per service; each service reads its own file | one kill switch + one KCM + one migration; rc-format split would give 6 sources of truth. KConfig still used internally per service |
| I3 | JSON over KConfig-on-disk for the file format | pure KConfig | KCM + ai-gen + future scripts all parse JSON natively; KConfig parsing in python is not stdlib |
| I4 | SQLite for all service state | flat JSON files | queries (usage ranges, audit tail) and crash-safety (WAL) matter; volumes are small |
| I5 | `contextd.Resolve()` per request, not per-app push | apps fetch context themselves | deliberate privacy boundary (principle 4, Stage D §6) |
| I6 | Workflows = agents with fixed pipelines | separate workflow service | one runtime/permission/audit path (A9) |
| I7 | Brute-force cosine vectors in SQLite | sqlite-vec / hnswlib / a vector DB | dataset scale (personal docs) makes a dependency unjustified; reindex is cheap |

## 8. Risks

| Risk | Mitigation |
|------|------------|
| Stream parsing bugs (chunked SSE edge cases) | contract tests against the mock endpoint incl. mid-stream cut (TESTING.md) |
| Queue starvation when owner's interactive session holds the single slot | queue depth + wait visible in Inference Manager; `QueuePaused` default-able; documented etiquette (20-ai-client) |
| Embeddings endpoint missing on host | ragd degrades with explicit state (unresolved Q4) |
| Secret storage in headless test sessions | Stage D's store is the 0600 file itself (no KWallet dependency until Stage E, SECURITY.md §8) |
| Interface drift as apps evolve | interface XML in `dbus/` is the single source; contract tests assert it |

## 9. Unresolved questions

1. Cost rates for cloud endpoints: hard-code a small table in config defaults
   (current plan) vs. user-entered rates in KCM. Default plan: user-entered,
   zero default.
2. `ReloadModel` semantics differ across llama.cpp versions; need to verify
   against the host server before Model Manager's "change model" ships
   (Stage E task).
3. Conversation persistence format (`conversations.db`): one row per
   message (planned) — confirm no need for branching/regeneration UI before
   locking the schema.
