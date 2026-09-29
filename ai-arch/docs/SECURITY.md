# AI-Arch Security & Permission Model

**Status: Stage D (2026-08-27).** Authoritative for the AI layer's security
model: threat model, permission classes, tool registry, audit, and context
privacy. Service interfaces: `docs/AI-ARCHITECTURE.md`. Layer boundaries:
`docs/ARCHITECTURE.md`.

## 1. Threat model

**Trust assumptions.**
- The **local user (archdev / the owner) is the trusted principal.**
  Single-user desktop (D5: no multi-user story).
- The **backend is untrusted output.** Any endpoint — local or cloud — can
  be compromised, or produce prompt-injected content (from a document the
  user attached, a web page, another file's contents). Model output is
  data, not commands.
- **Endpoint confidentiality matters** (API keys), **availability is
  best-effort**, **integrity of local files is critical**.

**Threats addressed:**

| # | Threat | Primary defense |
|---|--------|-----------------|
| T1 | Model instructs an unwanted file write / command | permission classes + user confirmation + audit (§3–5) |
| T2 | Prompt injection escalates (e.g., "send my SSH keys to…") | exclusions (§6), no network egress from tools except the configured endpoint (§7), R3 typing |
| T3 | Hostile/misconfigured endpoint reads config | key in `configd`'s secret store only; config never sent; only `messages` + vetted context go out (§6) |
| T4 | Malicious tool arguments (path traversal, `; rm -rf`) | argument schema validation in permd before execution (§4) |
| T5 | AI layer failure takes down the desktop | AI-off guarantee (ARCHITECTURE.md §2); services are user-session, never required by L2 |
| T6 | Audit tampering to hide an action | append-only table + monotonic sequence (§5) |
| T7 | Credential theft via logs | keys never logged; content logging off by default (§5, §7) |

**Explicitly out of scope** (documented, not silently ignored): physical
access, multi-user, sandboxed untrusted local apps (that's the OS's job),
and the security of the user's own backend server.

## 2. Design rules

1. **The model cannot grant itself permission.** Tool calls only arrive via
   `aid` → `permd.Request`; there is no D-Bus path by which a model reply
   writes policy.
2. **Only `permd` executes.** `aid` requests; `agentsd` orchestrates;
   `contextd` exposes. No other L3 service has an executor, and no L4 app
   executes on the model's behalf outside its own documented scope (e.g.,
   the assistant app itself never shells out because of a model reply).
3. **Executors run as the desktop user.** No service runs as root.
   Privileged operations (package install, firewall change) go through
   `polkit` agent prompts — the user sees the OS-level prompt, not ours.
4. **Deny is the default for anything unknown.** An unregistered tool id,
   a malformed argument, or a missing policy entry ⇒ `denied` + audit
   entry. Failures never default to allow.
5. **The kill switch beats everything.** `ai_enabled: false` ⇒ gateway
   refuses new requests, cancels in-flight, `permd` stops accepting new
   `Request`s (pending confirmations are denied).
6. **Every permission-relevant event is audited**, including denials and
   validation failures (the "why did it do that?" record).

## 3. Permission classes

Four classes, matching the Stage D brief. The class is a property of the
**tool**, fixed in the registry — a model cannot request a higher class.

| Class | Shorthand | Meaning | Default | Example tools |
|-------|-----------|---------|---------|---------------|
| `readonly` | **R0** | Inspect; no state change | **allow** (auto, audited) | `files.list`, `files.read`, `processes.list`, `logs.tail`, `system.status` |
| `low` | **R1** | Reversible, user-visible, non-sensitive | **ask** unless granted | `apps.launch`, `workspaces.create`, `desktop.set_wallpaper`, `files.move` (within workspace) |
| `sensitive` | **R2** | Changes files/config, runs commands, touches app data | **ask** (with what/why/impact), remember-per-tool allowed | `files.write`, `files.delete`, `commands.run`, `packages.install`, `browser.open`, `settings.modify` |
| `critical` | **R3** | Destructive / privileged / irreversible | **confirm** (modal, blocking), never remembered | `files.delete_recursive`, `commands.run_privileged` (→polkit), `security.modify` (firewall/users/keys), `system.reset` |

**Canonical shorthand (used throughout the docs):** R0 = `readonly`,
R1 = `low`, R2 = `sensitive`, R3 = `critical`. This table is the single
definition; all other documents reference it.

**Decision flow** for `permd.Request(tool, args, purpose)`:

```
1. tool registered?            no ⇒ denied(unknown_tool), audit
2. args validate vs schema?    no ⇒ denied(invalid_args), audit
3. class = registry[tool].class
4. policy:
   - readonly            ⇒ allowed (audit)
   - low  + grant match  ⇒ allowed (audit)
   - low  no grant       ⇒ ask: KNotification (what/why/impact), Remember option
   - sensitive           ⇒ ask: KNotification (what/why/impact), Remember option
   - critical            ⇒ modal dialog (blocking the agent step),
                           "what / why / impact" + typed action name or polkit re-auth;
                           timeout (60 s) ⇒ denied
5. respond (allow/deny/remember) ⇒ execute (if allowed) or denied, audit
```

**Confirmation content requirement** (Stage D §5): every ask/confirm shows
(1) *what* — tool + concrete arguments in plain language ("Delete 14 files
in ~/Documents/invoices"), (2) *why* — the `purpose` string from the
agent's step, (3) *impact* — from the registry entry ("irreversible;
files go to Trash" vs "permanent"). Impact text is **authored in the
registry, not generated by the model** — the model supplies `purpose`
(data), the registry supplies the impact statement (trusted).

**Remember semantics:** a `Remember` stores a grant = `{tool, args_pattern,
scope, class, created}` in `permissions.grants` (via configd). Patterns are
exact-match or per-argument regex (e.g., `files.write` under
`~/Documents/**`). Grants for `critical` **cannot be stored** (rule 3 of
the class table); the UI does not offer the button. Grants are listed and
revocable in AI Diagnostics → Audit and in the KCM Privacy page.

## 4. Tool registry & executors

Registry: `/usr/share/ai-arch/tools.json` (distro) +
`~/.config/ai-arch/tools-user.json` (user additions, validated). Entry:

```jsonc
{
  "id": "files.write",
  "class": "sensitive",
  "name": "Write file",
  "description": "Create or overwrite a text file",
  "impact": "Overwrites existing content. Reversible only if a backup exists.",
  "args": {                       // JSON-Schema subset: type, pattern, enum, max
    "path":   { "type": "string", "pattern": "^(/|~/).+$" },
    "content":{ "type": "string", "max_bytes": 1048576 }
  },
  "executor": "builtin:files.write",
  "limits": { "max_calls_per_request": 20 }
}
```

Builtin executors (Stage D foundation ships the R0 set + `files.*` +
`commands.run`; the rest land with the apps in Stage E; R-codes per §3):

- `files.list`, `files.read`, `files.write`, `files.move`, `files.delete`
  (→Trash), `files.delete_recursive` (R3; Trash with typed confirmation)
- `commands.run` — **whitelisted interpreter only** (`/bin/sh -c` with an
  argument length cap, 60 s timeout, output capped at 64 KiB, runs in the
  user's shell env, **no TTY**). R3 for anything matching the privileged
  pattern list (`sudo`, `pkexec`, package managers, `usermod`, `iptables`…);
  otherwise R2.
- `processes.list`, `system.status`, `logs.tail` (systemd journal, user
  scope, last N lines)
- `apps.launch` (`.desktop` names only), `workspaces.create`,
  `desktop.set_wallpaper`, `settings.modify` (KConfig keys via allowlist),
  `packages.install` (R3, polkit), `browser.open` (URL via xdg-open,
  http/https only)
- `context.attach_file` (R1; routes through contextd, not raw read)
- `rag.query` (R0; routes through ragd)

**Validation (rule 4, T4):** every argument checked against its schema
before the decision; path arguments canonicalized and checked against
exclusions + workspace containment where applicable; `commands.run`
arguments scanned for the privileged pattern list. A validation failure is
`denied` + audited with the failing field — never executed "best effort".

## 5. Audit

- Store: `~/.local/share/ai-arch/audit.db`, table
  `events(seq INTEGER PRIMARY KEY AUTOINCREMENT, ts, actor, tool, args_json,
  purpose, decision, detail, request_id)`. `actor` = `user`, `agent:<id>`,
  `workflow:<id>`, `app:<name>`, or `system` (kill switch, policy change).
- **Append-only**: no UPDATE/DELETE in code; the file is the record.
  Retention: `log_retention_days` applies to request logs, **not** audit
  (audit keeps everything; Diagnostics offers "export range" for
  off-machine review).
- Emits `org.aiarch.Permits.Audited` for live consumers (Diagnostics).
- Policy changes, grant add/revoke, kill-switch toggles, and config
  endpoint changes are all audit events too (the config surface is where
  an attacker's persistent access would live).

## 6. Context privacy

The model may only ever see what `contextd.Resolve()` returns (AI-ARCHITECTURE.md §4.4):

- **Available vs exposed.** "Available" is what the desktop *knows*
  (focused window, open windows, session apps, system info); "Exposed" is
  what the *user opted in* to add to prompts. Default exposed set: focused
  window **metadata only** (app, title, workspace) — no content, no file
  paths, no clipboard, no URLs.
- **Exclusions** (hard, system list always present, user-extensible):
  `~/.ssh`, `~/.gnupg`, `~/.config/keepassxc`, `~/.local/share/kwallet5|6`,
  `/etc`, `/boot`, `~/.config/QPasswords`. Files under an excluded path can
  never be attached or read by a tool, any class — checked in the executor,
  not just in contextd (defense in depth).
- **Cooperating apps** expose only what their `ContextProvider` returns
  (each app's provider output is listed in the KCM Privacy page as its own
  opt-in source — "AI Assistant conversation summary", "File Manager active
  folder", …).
- **Logging of egress:** `aid` logs, per request, the *keys* sent
  (`context: focused_window.metadata, attachments: 1 file`), never values
  unless `content_logging: true`.
- **No ambient snooping:** no periodic scraping of windows/clipboard by
  L3; context is gathered per request, at request time, from the session
  state that exists then.

## 7. Network egress

- L3 opens **exactly one kind of outbound connection**: HTTP(S) to the
  configured endpoint URL (plus its DNS). Tools cannot open other sockets;
  `browser.open` delegates to the user's browser (user-visible, user's
  choice) and only http/https.
- No telemetry, no update checks, no crash reporting from the AI layer.
- The endpoint URL is shown in full in the KCM + Control Center +
  Diagnostics (it's the user's own config, not a secret; the key is).

## 8. Secrets

- API keys live in **`configd`'s local secret store** (the only intake
  path is `SetApiKey`): Stage D — 0600 files under
  `~/.local/share/ai-arch/secrets/`, named by the config ref
  (`ai-arch/endpoint-key` sanitized to a flat filename); Stage E —
  KWallet `ai-arch/` folder behind the same interface and ref. Never in
  the JSON config, any log, any D-Bus property, or a process env
  (`aid` receives the header per-request from `configd`).
- The Stage D store is deliberately simple and dependency-free
  (suitable for the development/headless VM); KWallet integration is the
  Stage E production target, not a Stage D prerequisite.
- Legacy `llama-server.json` (20-ai-client) contains no secret today
  (keyless local server) — migration preserves that property.

## 9. AI-off security posture

With all `aiarch-*` services stopped (or `ai_enabled: false`):
no L3 process exists that can be prompt-injected (there is no process);
no tool can execute (permd is the only executor and it is stopped);
no context leaves the machine (contextd stopped; no other egress exists in
L3/L4 by design); config/audit files are inert data. This is asserted by
the reliability suite (TESTING.md §7), not just claimed.

## 10. Security tests (summary; details in TESTING.md §6)

1. **Permission matrix:** every tool × every class × (default, granted,
   denied, remembered, kill-switch-on) — automated via D-Bus against the
   real permd.
2. **Injection scenarios:** mock endpoint scripted to emit tool calls
   (read excluded path; `commands.run` with `;` chaining; unregistered
   tool; oversized args) — all must be denied/validated, all audited.
3. **Egress test:** with a fake endpoint that tries to make the client
   connect elsewhere (e.g., via a `url` override in a "model" reply) —
   assert the client ignores model-influenced config; only the user's
   configd-set endpoint is used.
4. **Audit integrity:** sequence monotonic, no gaps, no update paths in
   the code (static check), export works.
5. **Kill switch:** toggled mid-request ⇒ in-flight cancelled, pending
   confirmations denied, new requests refused; toggled back ⇒ normal.
6. **AI-off suite:** services masked ⇒ desktop verification suite passes
   100% (panel, launcher, windows, notifications, quick settings, KRunner).

## 11. Decisions

| # | Decision | Alternatives | Why rejected |
|---|----------|--------------|--------------|
| S1 | 4 fixed risk classes, class owned by the registry (not the model, not the app) | per-app self-declared risk; per-request dynamic scoring | the brief's model; dynamic scoring is un-auditable and gameable by the very output we don't trust |
| S2 | permd as separate service = process boundary for execution | in-gateway executor | hostile-backend containment (ARCHITECTURE.md A3) |
| S3 | `commands.run` = whitelisted shell, no TTY, capped | full shell with TTY; or no exec at all | "general-purpose desktop" needs some exec (the brief lists it); TTY/caps keep the worst cases out; R3 gating for privileged patterns |
| S4 | impact text authored in registry, purpose from model | model-generated impact text | the untrusted party cannot describe its own impact |
| S5 | audit append-only SQLite, never auto-pruned | journalctl (pruned by size); flat logs | tamper-evidence + queryability; journalctl retention is not under our control |
| S6 | context: per-request gather, default metadata-only, hard exclusion list | ambient context cache; per-app opt-in only | deliberate privacy (Stage D §6); the hard list is checked in executors too (defense in depth) |

## 12. Risks

| Risk | Mitigation |
|------|------------|
| `commands.run` is a broad surface even with caps | R2 default ask + 60 s timeout + no TTY + privileged-pattern R3; registry limits `max_calls_per_request`; revisit after Stage E usage data |
| Exclusion list incomplete (new secret stores appear) | system list lives in one place in code + tests assert known stores are covered; user-extensible |
| Stage E KWallet dependency (wallet locked at service start) | Stage D's 0600 store removes the dependency until then; in Stage E services require the session's wallet unlocked (true for a logged-in desktop) |
| Prompt injection via attached documents remains possible *in the model's reasoning* (it can still *try* bad tools) | it can only *try* what permd gates; the gate is the control, not the model's behavior |
| polkit prompts for R3 may be confusing ("why two prompts?") | our modal explains what/why/impact and says the system will ask again; documented in KCM |

## 13. Unresolved questions

1. **Trash vs permanent for `files.delete`**: current plan = user Trash
   (recoverable) even for R3 non-recursive; recursive = permanent after
   typed confirmation. Confirm with owner (data-recovery preference).
2. **Grant scope UI**: KCM shows grants as a list with one-tap revoke
   (planned); per-pattern editing (regex) is power-user — defer to Stage E
   polish.
3. **`browser.open` allow/deny domains**: no domain policy now (http/https
   only). If the owner wants a blocklist, it's a registry `limits` addition
   — open.
