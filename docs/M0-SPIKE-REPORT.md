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
| How fast does an ai-arch VM boot under KVM? | **Pending**: run `kvm_boot_probe.py` | Your server |
| How many agents can share llama-server at useful speed? | **Pending**: run `slots_bench.py` with `-np 1`, then `-np 2` | Your server |
| Can Hermes on your local Qwen write a valid team proposal? | **Pending**: run `hermes_team_probe.py` | Your server |

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

Measure boot time without touching your VMs. It uses a throwaway overlay on a baseline image, then deletes it:
```bash
cd ~/AgentControl/agent-autonomy/spikes
ls ~/AgentControl/ai-arch/vms/*.qcow2 ~/ai-arch/vms/*.qcow2 2>/dev/null     # find your baseline images
python3 kvm_boot_probe.py --baseline <path>/ai-arch-baseline-with-theme.qcow2 --vm-dir <that same dir>   # dry run
python3 kvm_boot_probe.py --baseline <path>/ai-arch-baseline-with-theme.qcow2 --vm-dir <that same dir> --run
```
It reports seconds to a DHCP address and to the SSH banner. ai-arch documents TCG at "30–60 s to network", and says never to call a TCG VM down before 2 minutes.

## 4. Model slots (pending): the key hardware number

With `-np 1` today, agents queue for the model. To test real parallelism:
```bash
cd ~/AgentControl/agent-autonomy/spikes
python3 slots_bench.py --url http://127.0.0.1:8080 --concurrency 1 2 3 | tee np1.txt
nvidia-smi --query-gpu=memory.used,memory.total --format=csv | tee -a np1.txt
# then restart llama-server in its tmux session with two slots, keeping >=64K context each for Hermes:
#   same flags as now, but  -np 2 -c 262144   (2 x 131072); if it runs out of VRAM, try -c 196608 (2 x 98304)
python3 slots_bench.py --url http://127.0.0.1:8080 --concurrency 1 2 3 | tee np2.txt
nvidia-smi --query-gpu=memory.used,memory.total --format=csv | tee -a np2.txt
```
Checked here against simulated 1-slot and 2-slot servers:
- With 1 slot, aggregate throughput stays flat and each extra agent waits.
- With 2 slots, it doubles for 2 agents.

On the 3090, the real gain will be smaller because the slots share one GPU. That is exactly what this measures. Restore your usual flags afterwards if `-np 2` doesn't pay off.

## 5. Hermes team proposals (pending)

```bash
cd ~/AgentControl/agent-autonomy/spikes
python3 hermes_team_probe.py --profile ai-arch-dev --trials 3
```
It uses the engine's exact Hermes invocation and validates:
- the schema: mode, agents, tasks
- that every task belongs to a known agent
- that no dependency points at a missing task, and there are no cycles

It executes nothing. With the fake Hermes here, the validator accepted a correct two-agent plan and rejected one with a dependency cycle. Your result tells us how much validation and retry the planner (M7) needs from a local 27B model.

## Tests after M0
- `python3 -m unittest discover -s agent-autonomy/tests`: OK
- `node agent-autonomy/tests/test_ui.cjs`: 25/25
- Probes were exercised against a real `opencode serve`, simulated 1-slot and 2-slot servers, a fake Hermes, and the real `ai-arch-dev.xml`.

## Next
Paste the three pending outputs (KVM boot, slots, Hermes). Then M1 (the no-behavior-change refactor) starts. It will add the `?directory=`-aware OpenCode adapter from finding 2 above.
