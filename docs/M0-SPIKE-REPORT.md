# M0 spike report

Milestone M0 of `docs/MULTI-AGENT-PLAN.md`: integration housekeeping and measurements before any multi-agent code. No product behavior changed in M0.

## Summary

| Question | Result | Where measured |
|---|---|---|
| Can ai-arch join AgentControl without side effects? | **Yes.** It was merged as the `ai-arch/` subproject (217 files, unchanged), the retired `dashboard.py` was not reintroduced, and all 62 Python + 25 DOM tests still pass | This repo |
| Can one OpenCode server run several agents in separate git worktrees? | **Yes** (OpenCode 1.18.33) | Cloud container, real `opencode serve` + scripted mock model |
| Does OpenCode serialize model requests across sessions? | **No.** 2 agents produced 2 overlapping model requests, so AgentControl's broker must enforce the llama-server slot limit | Same |
| Are status and approvals scoped per worktree? | **Yes, and this is critical.** Without `?directory=`, a busy worktree agent looks idle, its approval is invisible, and replying returns 404 | Same |
| Is KVM available? | **Yes**, after you enabled SVM: `kvm_amd` loaded, `/dev/kvm` present, `virt-host-validate` PASS | Your server (your output, 2026-09-29) |
| How fast does an ai-arch VM boot under KVM? | **13.2 s to DHCP address and SSH banner.** TCG is documented at 30–60 s to network, and up to 2 min | Your server, 2026-09-29 |
| How many agents can share llama-server at useful speed? | **One at a time with today's `-np 1`.** Aggregate output is flat at ~56 tok/s, so extra agents queue. About 3.6 GB of VRAM is free | Your server, 2026-09-29 |
| Can Hermes on your local Qwen write a valid team proposal? | **2 of 3 valid, 27–58 s each.** The failure was a JSON syntax slip (missing `}`), not a bad plan | Your server, 2026-09-29 |

## 1. ai-arch merge

- The `add-ai-arch` branch was cut from the original `main` and changes nothing outside `ai-arch/`. It was merged with `--no-ff` into `claude/gifted-fermi-rcas2a`.
- Kept as a subproject with its own README, ADRs, scripts and tests. Nothing in it was modified.
- Secret scan: none found. The `tskey-` strings are documentation placeholders, and `preseed/archinstall-creds.json` is gitignored.
- **Note for the move:** the VM definition (`ai-arch/vms/ai-arch-dev.xml`) points at `/home/charlesjackson/ai-arch/vms/…` for its disk, firmware (`OVMF_CODE_4M.fd`) and NVRAM. If the folder moved to `~/AgentControl/ai-arch/`, check that `virsh start ai-arch-dev` still works. `kvm_boot_probe.py --vm-dir` handles the new location for its throwaway VM.
- **Note for evidence capture:** if you point an AgentControl run at the AgentControl repo itself, ai-arch's files now count toward the 100-file snapshot limit. Point runs at the project you want built. M6 (git worktrees) removes that limit.

## 2. OpenCode: several agents, one server, separate worktrees

Reproduce with `agent-autonomy/spikes/opencode_worktree_probe.py`. It is fully isolated: temporary repo and config, scripted model, no cost.

Results with OpenCode 1.18.33:

```json
{
  "session_directory_wt-a": true,
  "session_directory_wt-b": true,
  "agent_a_wrote_only_its_worktree": true,
  "agent_b_wrote_only_its_worktree": true,
  "main_checkout_untouched": true,
  "max_overlapping_model_requests": 2,
  "pending_approvals_visible_without_directory": 0,
  "pending_approvals_visible_with_directory": 1,
  "busy_status_visible_without_directory": false,
  "busy_status_visible_with_directory": true,
  "reply_without_directory_http": 404,
  "reply_with_directory_http": 200,
  "write_after_approval": true
}
```

**Consequences for the design** (to be applied in M1 and M7):
1. **One OpenCode server is enough.** Every agent gets its own session created with `?directory=<its worktree>`. A server per agent is not needed; that was the fallback in the plan.
2. **The adapter must pass the agent's directory on every call:** `prompt_async`, `/session/status`, `/permission`, `/question`, and the replies. Today's engine calls these without it, which is fine for the single project folder but would silently lose worktree agents' approvals.
   - Session IDs are global and messages can be read without the directory, but status and approvals cannot.
3. **Concurrency control is AgentControl's job.** OpenCode sends model requests from different sessions at the same time. The model broker (M5) must cap in-flight requests to the llama-server slot count.
4. The approval path is intact in worktrees. An agent waits, the request is visible when you ask for its directory, and a directory-scoped reply resumes it. So the existing approval UI carries over to multi-agent without weakening.

Recheck on your server with **your** OpenCode version:
```bash
python3 ~/AgentControl/agent-autonomy/spikes/opencode_worktree_probe.py
```

## 3. KVM (confirmed) and VM boot time (pending)

Your output after enabling SVM:
- `svm` present on all 32 threads, and `kvm_amd` loaded.
- `/dev/kvm` exists (group `kvm` with an ACL).
- `virt-host-validate`: device exists, PASS; device accessible, PASS.

Findings from the VM definition that the probe works around:
- **The CPU is pinned to a TCG-only feature list** (`EPYC` + 3dnow, la57, mpx, pcommit…). Under KVM on a 5950X this will not start. The probe uses `host-passthrough`. Updating ai-arch's own build pipeline for KVM is a separate, later ai-arch ADR, not an M0 change.
- The domain type is `qemu` (TCG). ADR-0001 already says KVM is "one knob" (`type='kvm'`).

**Measured on your server:** a throwaway overlay of `ai-arch-baseline-with-tailscale.qcow2` (4 vCPU, 8 GiB) booted with `domain type="kvm"` and CPU `host-passthrough`.

```json
{"seconds_to_dhcp_address": 13.2, "seconds_to_ssh_banner": 13.2, "ssh_banner": "SSH-2.0-OpenSSH_10.5", "notes": [], "cleaned_up": true}
```

The documented TCG figure is 30–60 s to network, and up to 2 min before a VM counts as down, so KVM is several times faster. Conclusions:
- **The VM tier (M13) is practical.** Clone a baseline and boot it in about 13 s.
- ai-arch was *copied* into AgentControl, not moved. `~/ai-arch/vms/` (which libvirt uses) and `~/AgentControl/ai-arch/vms/` both exist, so the lab VM's paths are intact.

Re-run: `python3 kvm_boot_probe.py --baseline ~/ai-arch/vms/ai-arch-baseline-with-tailscale.qcow2 --vm-dir ~/ai-arch/vms --run`

## 4. Model slots (pending): the key hardware number

**Measured on your server** (`-np 1`, 131072 context per slot, model `Qwen3.8-27B-Uncensored-Q4_K_M`, 256 tokens per request):

| Agents at once | Wall | Aggregate | Per request (tok/s) |
|---|---|---|---|
| 1 | 4.5 s | 56.9 tok/s | 56.9 |
| 2 | 9.1 s | 56.2 tok/s | 55.1, 28.1 |
| 3 | 13.8 s | 55.5 tok/s | 54.9, 18.5, 27.3 |

VRAM: 20,932 / 24,576 MiB used (about 3.6 GB free).

**Conclusions:**
- Aggregate throughput is flat, so a second or third agent waits for the model; it doesn't run alongside.
  - The model broker (M5) defaults to 1 concurrent model stream.
  - Multi-agent mode helps only when agents spend time in tools, tests and verification rather than generation. Auto mode (M8) accounts for this.
- `-np 2` was not tested. It would split the KV cache, and Hermes needs ≥64K context per slot, with only ~3.6 GB free. It stays optional.

Re-run: `python3 slots_bench.py --url http://127.0.0.1:8080 --concurrency 1 2 3`

## 5. Hermes team proposals (pending)

```bash
cd ~/AgentControl/agent-autonomy/spikes
python3 hermes_team_probe.py --profile ai-arch-dev --trials 3
```
**Measured on your server:** 2 of 3 proposals valid, taking 26.7 s (invalid), 47.6 s and 57.5 s.
- Both valid proposals chose `mode: single`, with one coder and 4–5 ordered tasks. The reason given was sound: "tightly sequential; one coder avoids coordination overhead and file conflicts". So Hermes's own mode judgment is usable for Auto mode.
- The invalid proposal was a **JSON syntax slip**: the closing `}` was missing after each task object. The plan itself was fine.
- Hermes's `stream-json` result includes token counts and `duration_ms`, which is free usage data for the model broker.
- The first attempt failed only because llama-server was not running. Hermes then printed just a session ID after 5 minutes, which is why the broker (M5) must health-check the model server first.

**Consequences:**
- **M1 adds one bounded JSON-repair retry** to every Hermes call. Today a single malformed decision ends a whole run as failed.
- M7 validates every proposal and keeps teams small.

## Tests after M0
- `python3 -m unittest discover -s agent-autonomy/tests`: OK
- `node agent-autonomy/tests/test_ui.cjs`: 25/25
- Probes were exercised against a real `opencode serve`, simulated 1-slot and 2-slot servers, a fake Hermes, and the real `ai-arch-dev.xml`.

## Status
**M0 complete. Every question is answered with a measurement.** M1 (the no-behavior-change refactor) adds the `?directory=`-aware OpenCode adapter from §2 and the Hermes JSON-repair retry from §5.
