# AgentControl × AI-ARCH: audit and multi-agent plan (approved 2026-09-29)

## Context
You want AgentControl to grow from one Hermes→OpenCode coding loop into a self-hosted AI workstation:
- Hermes proposes, assembles and supervises teams of specialized agents.
- Agents get skills and tools under your control.
- Agents share your local Qwen/RTX 3090 model server.
- Agents run in isolated environments, some of them graphical.
- The dashboard becomes mission control.

You asked for an audit of both codebases and a plan for approval before major development. Sources:
- AgentControl: branch `claude/gifted-fermi-rcas2a`.
- ai-arch: `ai-arch/` on branch `add-ai-arch`, 217 files.

What was verified:
- Read the code, the ADRs and the captured host state.
- Scanned ai-arch for secrets. There are none; the `tskey-` hits are documentation placeholders, and `preseed/archinstall-creds.json` is gitignored.
- Did **not** compile ai-arch's C++/Qt code here (no Qt6), and did not run your VMs.

---

## 1. AgentControl today: assessment

**Shape:**
- Python standard library only, about 2,000 lines.
- `engine.py`: the controller, journal, adapters and evidence.
- `app.py`: the HTTP API, dashboard key, preview listener.
- `preview.py`: the live preview.
- Vanilla JS dashboard.
- 62 Python tests and 25 DOM tests, plus a Chromium screenshot/end-to-end harness.

**How a run works (`engine.py`):**
- `Controller._drive()` loops: Hermes decides → `_dispatch()` sends to OpenCode → `_watch()` polls messages and approvals → `_verify()` snapshots and runs the verifier → Hermes again.
- Hermes is called as a fresh one-shot CLI process per decision (`Hermes.decide`) and returns strict JSON (`code|complete|blocked`).
- OpenCode is one HTTP session per run (`OpenCode` class): `prompt_async`, message polling, permission and question replies.
- Durable state: `Store` holds SQLite tables `runs`, `steps`, `events`, `reviews`, with JSON blobs and WAL.
  - Restart turns active runs into `interrupted`.
  - Resume reconciles by message ID; prompts are never replayed.
- Evidence: `snapshot()`/`evidence()` hash and diff up to 100 text files. This is not git-based.
- Verification is an argv subprocess (`process()`) in the project folder.
- Limits:
  - prompt cap (1–20)
  - wall time (up to 2h)
  - 3 consecutive failures
  - 3 corrections
  - decision cap
- Approvals are fingerprinted and revalidated, never auto-resent, and include deny + redirect.

**Structural limits the vision will hit:**
1. **One active run globally.** `new()` refuses a second run; one thread per run.
2. **One agent per run.** There is no agent identity. "OpenCode" is hard-wired into `step`, `_watch` and the UI.
3. **`Controller` is a monolith.** Orchestration, the OpenCode adapter, the Hermes adapter, verification and push are all in one class, so new runtimes and strategies can't plug in cleanly.
4. **Evidence is snapshot-diff on the live folder.** It can't isolate concurrent writers; it needs git worktrees.
5. **Live updates are polling.** Browser to API is 1–10s; engine to OpenCode is 1s.
6. **Small bug found:** `Store.runs()` orders by `rowid`, and `INSERT OR REPLACE` changes the rowid. The most recently *updated* run jumps to the top of history. This needs fixing in the journal refactor.

---

## 2. ai-arch: what is real vs. documented

| Area | Status | Evidence |
|---|---|---|
| Unattended Arch VM build: preseed → 7-phase `scripts/build-ai-arch-vm.sh` → 15-check verify | **Implemented and proven** (T2 build 15/15) | ROADMAP Phase 1, CHANGELOG |
| Layer mechanism: `profile/layers/NN-*/install.sh`+`verify.sh` | **Implemented and proven** | `docs/LAYERS.md` |
| `20-ai-client`: VM → host `llama-server` config + `ai-gen` | **Implemented and proven** (live completion in build) | benchmark 2026-08-26 |
| `30-hermes`: Hermes 0.21.5 pinned + gateway service + headless Chromium (`agent-browser`) in the VM | **Written, not proven.** Build proof, live verify and gateway persistence are all unchecked | ROADMAP Phase 2 |
| KDE desktop layers 30/31/32 | Proven, then **shelved** (ADR-0008) | `profile/layers-archived/` |
| `aid` model gateway, C++/Qt6: queue with 1 in-flight, SSE streaming, cancel, usage metering, request log, health | **Implemented code + Qt unit tests** (not compiled in this audit) | `src/services/aid/*`, `src/tests/t_gateway.cpp` |
| `configd` + 0600 secret store; config merge user→distro→legacy | **Implemented + tests** | `src/services/configd`, `common/` |
| `permd` (permissions), `agentsd` (agents), `contextd`, `ragd` | **Spec only.** D-Bus XML is marked "Stage E contract: not implemented" | `dbus/*.xml`, `docs/AI-ARCHITECTURE.md` |
| Security model: R0–R3 classes, tool registry schema, decision flow, audit, "impact text comes from the registry, not the model" | **Designed (doc)**, not enforced anywhere | `docs/SECURITY.md` |
| Mock OpenAI endpoint with failure scripts (ok, slow, fail-midstream, bad-json, tool-call, injection) | **Implemented** (stdlib Python) | `tests/mock-endpoint/server.py` |
| VM lifecycle management API, container isolation, remote-desktop tooling | **Not present.** The VM XML has VNC on localhost only, and build/snapshots are scripts | `vms/ai-arch-dev.xml` |

**Host facts captured by ai-arch (`state/`, `recon/`, `benchmarks/`):**
- **Machine:** Ryzen 9 5950X (32 threads), **125 GiB RAM**, RTX 3090 24 GB. **About 21.2 GB of VRAM is already used by llama-server.**
- **llama-server:**
  - Qwen3.8-27B Q4_K_XL, `-c 128000`, q4_0 KV cache, speculative decoding
  - **`-np 1` (a single slot)**
  - about **44 tokens/s warm**
- **KVM was unavailable when ai-arch was built** (`kvm_amd`: "Operation not supported" despite the `svm` CPU flag), so every VM ran on software emulation (TCG, builds ~2h). **Update 2026-09-29: SVM enabled and KVM confirmed on your host.** Your output shows `kvm_amd` loaded, `/dev/kvm` present, and `virt-host-validate`: device exists + accessible = PASS. ai-arch's own ADR-0001 says switching is one knob (`domain type='kvm'`), so the VM tier is now a real option. Still to measure in M0: KVM boot time of the existing baseline VM.
- **Docker 29 is installed and heavily used**, and your user is in the `docker` group. Podman is absent.
- Hermes needs a **context floor of at least 64K**; the proven config uses 131072.

**Reality check.** ai-arch today is:
- a reliable **VM build system**
- a proven **model-client pattern**
- a well-designed **permission/security model on paper**
- a tested C++ **gateway**

It is **not** a VM manager or an agent runtime.

---

## 3. Integration proposal: what to reuse

| ai-arch component | Use in AgentControl | How |
|---|---|---|
| `docs/SECURITY.md` R0–R3 classes, tool-registry schema, deny-by-default, registry-authored impact text, append-only audit | **Adopt as the permission model** | Re-implement in Python (`permissions.py`), feeding the **existing approvals UI**. No D-Bus. |
| `aid` gateway design: single egress, queue, cancellation, usage metering, health | **Adopt the design** for the model broker | Python port inside AgentControl. Running Qt/D-Bus services on the host would add a Qt6 build and session-bus dependency for little gain. |
| `ai-arch.json` config schema (endpoint, `api_key_ref`, privacy.excluded_paths, permission defaults) and the secret-ref pattern | **Adopt as the model/endpoint registry format** | The same keys, so ai-arch and AgentControl can share one config |
| `tests/mock-endpoint/server.py` | **Reuse directly** in AgentControl tests | Deterministic multi-agent and broker tests, including failure modes |
| VM build pipeline + layers + Tailscale/SSH model | **Keep as the heavy isolation tier** (full OS, system packages, desktop apps) | Becomes an `EnvProvider` later. Practical only once KVM is enabled. |
| `30-hermes` layer (Hermes + `agent-browser` in a VM) | Candidate **browser/research agent host** | Finish its build proof first (ai-arch's own ROADMAP) |
| `agentsd` D-Bus spec | Reference for API naming only | Not ported as a service |
| KDE layers, QML apps | Not used now | Stay shelved and recoverable |

**Where ai-arch lives:** keep it as the `ai-arch/` subproject with its own README, ADRs and tests. Merge `add-ai-arch` into the working branch.

That branch was cut from the old `main` and still contains `dashboard.py`. The merge must keep the version-5 AgentControl files and take only `ai-arch/`.

---

## 4. Proposed modular architecture

All of it stays Python standard library. Each module has one job and a test file.

```
agent-autonomy/
  engine.py        Controller: run lifecycle only; picks a Strategy (single | team)
  journal.py       SQLite store + versioned migrations (runs, steps, events, reviews,
                   + agents, tasks, task_deps, capabilities, installs, usage, event seq)
  adapters/
    opencode.py    OpenCode runtime adapter (existing class, one session per agent)
    hermes.py      Hermes planner adapter (decide, propose_team, review)
    base.py        AgentRuntime interface: start, send, transcript, pending, abort, usage
  agents.py        Agent registry: AgentType (role, runtime, model, tools, skills, permissions)
                   + AgentInstance (id, run, task, state, workspace, session, usage, history)
  planner.py       Team proposal + task DAG schema, validation, Auto-mode heuristics
  scheduler.py     DAG executor: global/run/endpoint concurrency, resource checks, budgets,
                   bounded retries, resume from journal
  workspaces.py    git worktree per task, integration branch, merge + conflict detection
                   (snapshot evidence kept as a fallback for non-git projects)
  verify.py        Existing verification + per-task and integration verification
  models.py        Endpoint registry + broker: slot semaphores per endpoint, priorities,
                   usage and cost records (cost only for paid providers)
  permissions.py   R0–R3 policy, grants, audit; the single gate for every sensitive action
  capabilities.py  Skill/tool registry, discovery, compatibility checks, install proposals,
                   install log + rollback
  sandbox.py       EnvProvider: HostProcess (today) | DockerEnv (shared per run) | VMEnv (ai-arch)
  events.py        In-process event bus + SSE stream (/api/events), with polling fallback
  preview.py       Unchanged; its Xvfb + screenshot + xdotool code is reused for agent GUIs
```

**Key design decisions:**
- **Single-agent mode is today's loop, unchanged,** wrapped as `SingleStrategy`. Multi-agent is `TeamStrategy`. Auto mode chooses between them. Existing tests keep guarding single mode.
- **One OpenCode server with many sessions.** Each agent gets its own session and its own worktree directory.
  - This must be spiked first (M0) to confirm per-session directory support in your OpenCode version.
  - The fallback is one lightweight OpenCode server process per worktree, sharing the same model endpoint.
- **Model sharing.** All agents call the same llama-server; the broker enforces `slots` concurrency.
  - With `-np 1`, the team works in parallel on *tools and verification* but model turns queue.
  - Real parallel generation needs `-np 2`. Each slot then needs **≥64K context for Hermes**, and the KV cache headroom on the 3090 must be measured. That happens in M0; I won't guess it.
- **Decision engine.** Start with transparent rules plus Hermes judgment:
  - number of independent tasks
  - file overlap
  - model slots
  - budget
  - RAM

  It stays optional and swappable (a `Classifier` interface). No new dependency.
- **Isolation, as tiers matched to the need:**
  1. **Process.** Today's default and fastest.
  2. **Shared Docker environment per run.** One long-lived container that all of the run's agents share, with per-agent worktrees mounted, CPU/RAM limits, network off or on an allowlist, and optional Xvfb for browser/GUI via the existing preview desktop code. Docker is already on your host.
  3. **ai-arch VM** for full-OS tasks, desktop apps, and anything you want fully away from the host. It is practical now that SVM is on (pending the KVM check). Use **one shared "team VM" per run or project**, cloned from an ai-arch baseline qcow2 snapshot, not built from scratch (~minutes, not ~2h). Agents inside it get their own worktrees and users.

  Not a VM per agent. Docker (tier 2) stays the lighter default for coding-only teams. The VM is chosen when a task needs a full desktop or system-level changes.
- **Event-driven UI.** SSE from `ThreadingHTTPServer`, with no new dependency; polling stays as the fallback. The engine keeps polling OpenCode, because OpenCode's own event stream can be adopted per-adapter later.
- **Human control is absolute.**
  - Every install, credential use, external network access, or R2/R3 tool goes through `permissions.py`, which feeds the existing approvals inbox.
  - Team proposals need approval.
  - Auto-launch only happens for workflow types you've pre-approved, within limits.
  - Skill instructions are treated as untrusted data, and their manifests are validated.

---

## 5. Roadmap (each milestone ships and is testable on its own)

| # | Milestone | Done when |
|---|---|---|
| **M0** | **Spikes + integration housekeeping** (no product features): merge `add-ai-arch` safely; OpenCode multi-session/per-directory spike; llama-server `-np 2` memory/throughput benchmark with ≥64K per slot; **confirm KVM after the SVM change and time a KVM boot of the ai-arch baseline VM** (vs TCG); check the Hermes CLI can emit a team-proposal JSON | A written spike report with measured numbers (including VM boot time on KVM); all existing tests green |
| **M1** | **Refactor, no behavior change** (plus two fixes the spikes justified): split `journal`, `adapters/`, `verify` out of `engine.py`; migrations; fix the `rowid` ordering bug; **a directory-aware OpenCode adapter** (M0 finding: status, approvals and replies need `?directory=`); **one bounded JSON-repair retry for Hermes calls** (M0: 1 in 3 malformed on large replies) | All 62 + 25 tests pass unchanged; new tests for directory scoping and JSON repair; screenshots identical |
| **M2** | **Event bus + SSE** with polling fallback | Dashboard live over SSE; polling path still tested |
| **M3** | **Agent identity in single mode**: registry, `agents` table, the single run shown as agent "coder-1" | Journal + API expose agents; no UX regression |
| **M4** | **Permissions gate (R0–R3 + audit)**, ported from ai-arch SECURITY.md, used by the existing approvals | Permission matrix tests (deny unknown, never remember R3, audit on every decision) |
| **M5** | **Model broker + scheduler**: endpoint registry (ai-arch.json schema), slot limits, priorities, usage records | Mock-endpoint tests: N agents vs 1 slot queue correctly; usage recorded |
| **M6** | **Worktrees + integration verification** (git projects) | Concurrent writers isolated; conflicts detected and reported to Hermes; verification on the integration branch |
| **M7** | **Team proposals + task DAG + multi-agent mode** (coding agents first); proposal approval UI; bounded retries; resume after restart | A two-agent run on the demo project with the mock endpoint, killed mid-run and resumed |
| **M8** | **Auto mode** (heuristics + Hermes, with override) | Decision table tests; the user override always wins |
| **M9** | **Capabilities**: skill/tool registry, discovery, install proposals → approvals, install log + rollback, per-agent permissions | Install/rollback tests in a throwaway prefix; untrusted skills need approval |
| **M10** | **DockerEnv**: shared per-run container, limits, network policy, in-container Xvfb with takeover via the preview desktop surface | Run a team inside a container; GUI app visible and clickable |
| **M11** | **Mission control UI**: team overview + per-agent view reusing the board/terminal; mobile layout | Screenshot matrix across all themes/widths; existing views unchanged |
| **M12** | New roles and runtimes: research/browser (Hermes `agent-browser`), OpenRouter provider (optional key ref), cost reporting | Runs with no paid provider configured stay fully functional |
| **M13** | **VMEnv** (ai-arch on KVM): clone a baseline qcow2 into a per-run team VM, start/stop, SSH exec, VNC takeover in the dashboard, resource caps (vCPU/RAM). Can move ahead of M11 if the M0 numbers are good | End-to-end on your host |

The ordering follows your instruction: architecture and integration (M0–M9) come before the big dashboard work (M11). Each milestone is a separate commit series and ends with a check-in.

---

## 6. Must be preserved (regression checklist)
- The single-agent Hermes→OpenCode loop and its JSON decision contract.
- Durable SQLite journal; interrupted → Resume without replaying prompts.
- Approvals: fingerprint revalidation, no automatic resend, deny + redirect, the uncertain/awaiting states, the decision history.
- Pause (at a boundary), Resume, Stop (with an abort confirmation), steering notes, goal checks, follow-up runs, run titles, Verify now.
- Limits: prompt cap, time limit, 3-failure stop, correction cap, decision cap.
- Independent verification; "review only" labeling when no verifier is set.
- Live OpenCode terminal, the horizontal Plan → Prompt → Code → Verify board, the turn rail.
- Project tab live preview in all four modes, the preview-port isolation, the one-time tickets.
- Mac/Terminal/XP themes, phone layout, Tailscale binding, dashboard key, push notifications via Hermes.
- No new runtime dependency beyond the Python standard library, except optional ones: Docker for the container tier, and the preview tools.

## 7. Risks, security, hardware limits
- **GPU is the bottleneck.**
  - Single slot today, and about 3 GB of VRAM free.
  - More slots split the KV cache, and Hermes needs ≥64K per slot.
  - Parallel generation raises total throughput but slows each agent.
  - Realistic target on the 3090: **2 concurrent model streams**, possibly 3 with a smaller context. To be measured in M0.
- **Planning quality.** Team decomposition by a local 27B model may be unreliable. Mitigations: a strict JSON schema, validation, human approval of proposals, and a small default team (2–3).
- **KVM is fixed** (confirmed). Remaining VM costs:
  - RAM: 8 GiB per VM by default, against 125 GiB total.
  - Disk: 120 GiB qcow2 by default. Use thin clones from the baseline.
  - The libvirt/KVM group permissions for the AgentControl user.
- **The `docker` group is root-equivalent.** Recommend rootless Docker or podman for agent containers; never mount the Docker socket into agent environments.
- **Prompt injection via skills, web pages and repos.** Treat skill text as data, validate manifests, deny unknown tools by default, and require approval for installs, network access and credentials.
- **Runaway loops and cost.** Global and per-run budgets, bounded retries, a kill switch, and paid providers off by default with spend caps.
- **Concurrency correctness.** One SQLite writer thread (WAL), idempotent scheduler steps, and journal-driven resume.
- **Git worktrees:**
  - Non-git projects fall back to snapshots (with no parallel writers).
  - Merge conflicts escalate to Hermes, then to you.
- **Network exposure.** SSE and the preview ports must stay on the tailnet. HTTPS via `tailscale serve` breaks plain-HTTP preview frames, which is documented.
- **Branch divergence.** `add-ai-arch` was cut from the old `main`, so the merge must not bring back `dashboard.py` or the old dashboard.

## Verification approach (for every milestone)
- Existing suites: `python3 -m unittest discover -s agent-autonomy/tests` and `node tests/test_ui.cjs`.
- New module tests using ai-arch's mock endpoint, for deterministic multi-agent and broker tests.
- The Chromium screenshot and end-to-end harness (`tests/screenshots.cjs`, the preview end-to-end pattern) for UI milestones.
- Live checks on your server where hardware matters: llama-server slots, KVM, Docker. I'll give you exact commands, since this cloud container has no GPU and no access to your host.

## M0 findings so far (2026-09-29)
- **Hermes works when llama-server is up.** `hermes --profile ai-arch-dev chat --quiet -q "…pong"` returned `pong` in 20 s, exit 0. The first probe failure was only because llama-server was stopped. **Lesson for M5:** the model broker must health-check the endpoint before dispatching and report "model server offline" clearly, instead of letting Hermes fail after minutes.
- **Hermes CLI features relevant to later milestones** (from `hermes chat --help` on your server):
  - `--in DIR` and `--worktree`: run a Hermes agent scoped to a directory or worktree (useful for research/browser agents in M12).
  - `-s/--skills`: preload skills per session (a candidate provisioning path for M9 capabilities).
  - `-t/--toolsets`: per-agent tool restriction (M4/M9 per-agent permissions).
  - `-m/--model`, `--provider` (user-defined providers in config.yaml): per-agent model selection (M5/M12).
  - `--run-budget SECONDS`, `--max-turns`: hard per-agent limits (M7).
  - `--safe-mode`, `--ignore-user-config`: a reproducible and restricted agent profile.
  - `--format stream-json`: structured events (M2 live activity).
  - `--yolo` exists: AgentControl must **never** pass it (permission bypass).
- **Team-proposal probe, measured on your server: 2 of 3 valid, 27–58 s each.**
  - Both valid proposals chose `mode: single` with a sound reason ("tightly sequential; one coder avoids coordination overhead"). So Hermes's own mode judgment is usable for Auto mode (M8), alongside the rule-based checks.
  - The invalid one was a **JSON syntax slip**: the model omitted the closing `}` after each task object. The plan content itself was fine.
  - The Hermes `result` event includes `tokens` (input/output) and `duration_ms`. That is free usage data for the broker (M5).
- **Consequences:**
  - **M1 adds a bounded JSON-repair retry** for every Hermes call: at most one retry, feeding back the parse error ("return the corrected JSON only"). Today a single malformed Hermes decision fails the whole run (`_work` catches it and ends the run as failed). This fixes that existing fragility as well as the planner.
  - **M7 keeps teams small by default** and validates every proposal: known agents, no dangling or circular dependencies. Evaluating llama-server's grammar-constrained JSON output for planning calls goes into M5, as an option only.
- **Slots benchmark, measured on your server (`-np 1`, 131072 ctx, model `Qwen3.8-27B-Uncensored-Q4_K_M`):**

  | Agents | Wall | Aggregate | Per request |
  |---|---|---|---|
  | 1 | 4.5 s | 56.9 tok/s | 56.9 |
  | 2 | 9.1 s | 56.2 tok/s | 55.1 / 28.1 |
  | 3 | 13.8 s | 55.5 tok/s | 54.9 / 18.5 / 27.3 |

  - Aggregate throughput is flat, so extra agents strictly queue.
  - VRAM is 20,932 / 24,576 MiB, so about 3.6 GB is free.
  - **Consequences for M5/M7:**
    - Default to **1 concurrent model stream**. Parallel agents only help when time goes to tools, tests and verification rather than generation.
    - Auto mode must account for this: with one slot, multi-agent pays off only for tool-heavy or independent-verification work.
    - `-np 2` is optional and untested; try it only if you want to measure it.
- **VM files:** ai-arch was *copied*, not moved. Both `~/ai-arch/vms/` (which the libvirt definitions point to) and `~/AgentControl/ai-arch/vms/` exist, so the lab VM paths are intact.
- **KVM boot probe, measured on your server:** a throwaway overlay of `ai-arch-baseline-with-tailscale.qcow2` booted with `domain type="kvm"`, CPU `host-passthrough`, 4 vCPU, 8 GiB. It had a **DHCP address and SSH banner (OpenSSH 10.5) at 13.2 s** and was cleaned up afterwards.
  - The documented TCG figure is 30–60 s to network, and up to 2 min before a VM counts as down, so KVM is several times faster.
  - **Consequence:** the VM tier (M13) is practical: cloning a baseline takes seconds and boot about 13 s.
  - ai-arch's own domain XML still pins a TCG-only CPU model. Switching the ai-arch build pipeline to KVM is a separate ai-arch ADR, outside AgentControl's milestones.

**M0 complete.** All five spike questions are answered with measurements.

---

## M1 execution plan (for approval)

Goal: restructure `engine.py` for multi-agent work **without changing behavior**, plus the two fixes M0 justified.

1. **Record M0 in the repo.** Fill the measured numbers into `docs/M0-SPIKE-REPORT.md` (Hermes 2/3 at 27–58 s, slots table, VRAM, KVM 13.2 s), and sync `docs/MULTI-AGENT-PLAN.md` with this plan file.
2. **`journal.py`**: move `Store` out of `engine.py` unchanged, then:
   - add a `schema_version` table and a migration runner (v1 = today's schema)
   - fix run ordering: order by the `created` timestamp instead of `rowid`, so updating a run no longer reorders history
3. **`adapters/opencode.py`**: move the `OpenCode` class.
   - Add an optional `directory` per call. It is appended as `?directory=` to `prompt_async`, `/session/status`, `/permission`, `/question` and the replies, as M0 proved necessary.
   - Single mode passes `None`, so today's requests are byte-identical.
4. **`adapters/hermes.py`**: move the `Hermes` class and split it:
   - a generic `run_json(prompt)`, the exact invocation plus the parsing now in `decide()`
   - `decide()`, which keeps today's validation
   - `run_json` gets **one bounded repair retry**: on a JSON parse failure, re-ask once with the parse error and "return only the corrected JSON". A second failure raises exactly as today.
5. **`verify.py`**: move `snapshot`, `evidence`, `transcript` and the verifier call, unchanged.
6. **`engine.py`** keeps `Controller` and imports the modules. Names `engine.X` stay re-exported, so `app.py`, the tests and the spikes are unaffected.

**Verification:**
- The full existing suites pass unmodified: 48 workflow + 14 preview Python tests, and 25 DOM tests.
- New tests:
  - OpenCode calls with `directory` hit the scoped URLs; without it they are unchanged (via FakeAPI/an HTTP capture).
  - A malformed-then-valid Hermes reply succeeds with one retry; malformed twice fails as before.
  - Run ordering is stable after updates.
  - Migrations run on an existing v4/v5 journal file without data loss (a copy of a real schema).
- The screenshot harness matrix is unchanged, with 0 warnings.
- Commit per step; push to `claude/gifted-fermi-rcas2a`.

## Decisions needed from you (after approval)
1. OK to merge `add-ai-arch` into the working branch as the `ai-arch/` subproject, dropping the old `dashboard.py` it carries?
2. Willing to try restarting llama-server with `-np 2` (and a larger `-c`) for the M0 benchmark?
3. ~~Enable SVM / confirm KVM~~ Done and confirmed (2026-09-29).
4. For container isolation: are rootless Docker (or podman) acceptable? The alternative is limiting agents to process isolation.

**Status:** M0 complete (see `docs/M0-SPIKE-REPORT.md`). M1 approved and in progress.
