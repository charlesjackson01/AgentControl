# Bot VMs: install, gVisor, Windows storage, disk, and the security suite

Each bot runs its scripts in its own rootless Podman container (its "VM"). This page covers how to set that up on each OS, how to add gVisor, what can lose data on Windows, how the disk grows and how to compact it, and how the §13 security checks are tested.

AgentControl never installs anything system-wide by itself. The Settings › VMs page and the VM tab list the setup steps still missing (`setupSteps`), and they're re-checked on "Re-check now".

## 1. Install per OS

### Linux (native, no machine)

1. Install Podman from your distribution's packages (4.x or newer; tested with 5.4.2): `sudo apt install podman` (Debian/Ubuntu) or `sudo dnf install podman` (Fedora). See https://podman.io/docs/installation.
2. Run AgentControl as a regular user so Podman is **rootless** (the VM tab asks for this if the engine runs as root). Rootless needs subuid/subgid ranges for your user (`grep $USER /etc/subuid /etc/subgid`); see the rootless tutorial linked from the setup step.
3. Build the shared images: `cd AgentControlBE && npm run vm:images`. This builds `botvm`, `botvm-browser` and the internet firewall helper `egressd-nft` from pinned sources (`vm/README.md`). Without `egressd-nft`, runs that use the internet fail with `proxy_unavailable`; build only that one with `npm run vm:images -- --only egressd-nft` (the setup step shows the same hint).
4. Optional, for memory/CPU/process limits: rootless Podman enforces them only with cgroups v2 and the systemd cgroup manager with delegated controllers. Where limits aren't enforced, runs are blocked with `limits_unenforced` (the VM tab says why).

**No setuid or setgid files.** From image version 1.0.1, `botvm` and `botvm-browser` strip every setuid/setgid bit as their last root build step (the Debian base ships `passwd`, `chsh`, `chfn`, `gpasswd`, `newgrp`, `su`, `mount`, `umount`, and setgid `chage`, `expiry`, `unix_chkpwd`), and the build fails if any remain. Bots never had a way to use them (no-new-privileges, no capabilities); this removes them anyway. After an update that changes the image version (1.0.0 → 1.0.1 here), AgentControl rebuilds the images itself when it starts (Settings › VMs shows the "bot images" setup step while it works, then the firewall helper step). Until they're built, runs fail with `image_missing` and "AgentControl needs to rebuild its bot images: … Open Settings › VMs and run setup to rebuild them." If the rebuild fails (for example with no internet), the step shows the last build line; retry from Settings › VMs, or run `npm run vm:images` (plus `--connection agentcontrol` on Mac/Windows) yourself. Each bot's own layer is rebuilt on its next run. Packages a bot installs with apt in its own layer aren't stripped.

Bot files stay in the AgentControl data folder; tool volumes live in Podman's storage. Lost tool volumes can be rebuilt from each bot's tool manifest.

### macOS

1. Install Podman for Mac (Podman Desktop or `brew install podman`).
2. AgentControl creates and starts its **own** machine, `agentcontrol` (6 GB memory, 4 CPUs, 60 GB disk). It never uses or changes `podman-machine-default`. You can also create it yourself: `podman machine init agentcontrol --cpus 4 --memory 6144 --disk-size 60 && podman machine start agentcontrol`.
3. Build the images into that machine: `npm run vm:images -- --connection agentcontrol`.

Bot files stay on the Mac (APFS data folder) and are shared into the machine; tool volumes live in the machine.

### Windows

1. Install WSL 2 (`wsl --install`, https://learn.microsoft.com/windows/wsl/install) and Podman for Windows.
2. AgentControl creates its machine `agentcontrol`, which is the WSL distro `podman-agentcontrol`, and starts it. It turns on a sparse disk where WSL supports it (`wsl --manage podman-agentcontrol --set-sparse true`).
3. Build the images into the machine: `npm run vm:images -- --connection agentcontrol`.
4. AgentControl starts its storage helper `ac-storaged` in the machine (no network; not reachable by bots). All file work goes through it.

Live bot files are **inside WSL** at `/var/lib/agentcontrol/` (see §3). Nightly backups go to `%LOCALAPPDATA%\AgentControl\backups\`.

> **Untested here:** the Windows and macOS paths have no test machine yet (M3 decision 1). The `@win`/`@mac` tests exist but have never run; see §6.

## 2. gVisor (runsc)

gVisor adds a user-space kernel between bot scripts and the host kernel. It's optional: Settings › VMs has a global mode (`auto`, `force_on`, `force_off`) and each bot can override it. In `auto`, AgentControl uses gVisor when the compatibility probe passes and the standard runtime otherwise; the VM tab shows **gVisor · Active**, **Not installed** or **Incompatible, fell back** with the failing check.

AgentControl never installs gVisor. To add it:

- **Linux:** install `runsc` from the gVisor apt repository (https://gvisor.dev/docs/user_guide/install/) or the release binary into `/usr/local/bin`, then register it with Podman in `~/.config/containers/containers.conf`:

  ```toml
  [engine.runtimes]
  runsc = ["/usr/local/bin/runsc"]
  ```

  (Use `/usr/bin/runsc` if the package put it there.) Then press "Re-check now".
- **macOS / Windows:** install `runsc` **inside the machine**: `podman machine ssh agentcontrol`, install the binary as above, and add the same `[engine.runtimes]` entry to the machine's `containers.conf`. Then "Re-check now".

The probe runs our exact setup with runsc (start, bind-mount ownership with the chosen uid mapping, snapshot mount type, no network, an egress CONNECT, limits, python3 and node, Chromium if a bot has Browser on) in under 30 s, so a runsc that can't handle idmapped mounts or Chromium on your kernel shows up as **Incompatible** instead of breaking runs. With `force_on` and a failing probe, runs fail with a clear message instead of falling back.

## 3. Windows: where files live and what can lose them

Bot files (workspace, shared inputs, memory, BOT.md), group folders, snapshots and tool volumes live on the ext4 disk of the WSL distro `podman-agentcontrol` at `/var/lib/agentcontrol/`. AgentControl's own metadata (bots, chats, run records, settings) stays in its Windows data folder. "Open in Explorer" opens `\\wsl.localhost\podman-agentcontrol\var\lib\agentcontrol\bots\<slug>\workspace`; treat it as read-only, since edits there bypass undo and quota checks.

**Data-loss risks:**

| Event | Effect | Mitigation |
|---|---|---|
| `podman machine rm agentcontrol`, `podman machine reset`, uninstalling Podman Desktop with "remove machines", `wsl --unregister podman-agentcontrol`, a WSL reset | **All live bot files, tools and snapshots are deleted** | dedicated machine name; nightly backups; a warning here and on Settings › VMs; Reset VM in AgentControl never touches the machine |
| VHDX corruption (hard power-off during writes, disk full on the Windows drive) | partial or total loss | ext4 journaling; the 3 GB floor; a Windows-drive free-space check before growth; backups |
| Windows reinstall or a new PC | machine gone | restore from backups (copy the `backups` folder) |

**Backups** are on by default on Windows: nightly at 3:00 AM local, before Reset VM and before machine or base upgrades, plus "Back up now". Each bot gets a `tar.zst` of its personal data and tool manifest; 7 daily backups are kept, and they count against the Windows drive, not the bot's 10 GB.

**Safety net:** the volume holds `/var/lib/agentcontrol/.ac-volume-id`, which must match AgentControl's saved volume id. If it's missing or different, AgentControl shows **Bot files missing**: chats keep working, runs and file writes are blocked, and the VM tab offers **Restore from backup** or **Start empty** (confirmed). It never re-initializes silently.

## 4. Disk growth

- The machine's 60 GB is the **initial** size, not a ceiling.
- **macOS:** the machine disk is a sparse image and uses host space only as it fills. At 80 % (48 GB) the VM tab and Settings › VMs offer "Grow disk to 90 GB" (then 120, 180…), which runs `podman machine stop`, `podman machine set --disk-size N` and `podman machine start` after checking the Mac's free space. A disk can grow but never shrink.
- **Windows:** the distro lives in a dynamically expanding VHDX (WSL's maximum, 1 TB by default), so it grows without a resize. AgentControl treats 60 GB as its managed budget and offers the same "raise to 90 GB…" step at 80 % (a setting change plus a Windows-drive free-space check).
- **Linux:** files use the host disk directly.
- **Floors (all OSes):** new runs are blocked below 3 GB free (`low_disk`); undo snapshots are evicted while less than 5 GB is free.
- Quotas aren't reservations: N bots × 10 GB can exceed the disk. Settings › VMs shows allocated vs used and warns past 2× the disk.

## 5. Compacting (Windows)

Space freed inside WSL isn't returned to Windows automatically. With a sparse VHDX (set up by AgentControl where WSL supports it) freed space is returned over time. Otherwise, compact by hand:

1. Close AgentControl (or stop its server) so nothing is writing.
2. Back up first ("Back up now" on Settings › VMs).
3. In PowerShell: `wsl --shutdown`.
4. Either turn sparse on and let WSL reclaim: `wsl --manage podman-agentcontrol --set-sparse true`, or compact the VHDX with `diskpart` as administrator:

   ```
   select vdisk file="%LOCALAPPDATA%\containers\podman\machine\wsl\wsldist\agentcontrol\ext4.vhdx"
   attach vdisk readonly
   compact vdisk
   detach vdisk
   ```

   (Check the actual path with `podman machine inspect agentcontrol`; it depends on the Podman version.) `Optimize-VHD -Path <path> -Mode Full` does the same where Hyper-V tools are installed.
5. Start AgentControl again; it starts the machine and checks the volume marker.

macOS sparse images shrink on their own as files are deleted inside the machine; there's no compact step.

## 6. Security suite (§13)

Every §13 boundary is mapped to its tests in `AgentControlBE/src/security-coverage.ts`; `security-coverage.test.ts` (a plain test) fails if a referenced test is renamed or removed, if a row loses its Linux test, or if a gap below goes missing from this page.

**Tags and how to run them:**

- plain tests: `npm test` (fakes only; the engine guard fails any plain test that calls podman or docker).
- `@vm` (`*.vm.test.ts`): `AC_VM_TESTS=1 npx vitest run` with the `botvm` image in the engine's store. Run one `AC_VM_TESTS=1` run per Podman store at a time. A throwaway store: `PODMAN_ARGS="--root <dir>/root --runroot <dir>/runroot"` plus `XDG_DATA_HOME`, and a `podman` wrapper with the same `--root/--runroot` first on `PATH` for code that calls the CLI directly.
- `@win` (`security.win.test.ts`) and `@mac` (`security.mac.test.ts`): only on that OS with `AC_WIN_TESTS=1` / `AC_MAC_TESTS=1` and the `agentcontrol` machine running. Skipped everywhere else; nightly, not merge gates.

| §13 row | Linux tests | Mac / Windows |
|---|---|---|
| Bot ↔ bot | `isolation.vm` (3 bots: workspace, tools volume, env, processes, network; foreign mounts refused; distinct uids with idmap), `security.vm` (another bot's snapshots not mounted or findable), `egress.vm` (credential bound to its bot's network), `isolation` (symlinks) | `@mac`/`@win` two bots in the machine |
| Script → host files | `isolation.vm`/`podman-runner.vm` (EROFS, nothing reaches the host), `security.vm` (a symlink a script makes isn't followed by the BE), `files`, `file-tools`, `undo`, `backup-archive` (traversal, symlinks, crafted records and names) | |
| Script → memory/profile | `podman-runner.vm` (no memory or BOT.md), `isolation.vm` (`/bot/shared`, `/bot/skills` EROFS), `security.vm` (product mounts), `security` (mount list) | |
| Script → network | `egress.vm`: under `always`, 192.168/10/172.16, 100.64/10, `fd7a:115c:a1e0::/48`, this computer, the BE, loopback, the model server and metadata get 403 with their reason; direct TCP/UDP fail; the firewall still refuses loopback, 10/8 and metadata with the proxy's rules out of the way (at once: an ICMP reject, so the proxy answers 502 without waiting out its connect timeout); `egress-rules` | `@mac`/`@win` this computer's LAN and Tailscale addresses |
| Resources | `podman-runner.vm` (OOM at 5 GB, fork bomb at 256, 200 MB output cap, timeout), `security.vm` (full /tmp → ENOSPC, failed run), `snapshot-budget.vm` (personal quota), `run-service` (3 GB floor) | |
| Privilege | `security.vm` (mount, unshare, raw and packet sockets, setuid, capsh fail; all capability sets 0; NoNewPrivs 1; no setuid or setgid file in the bot container or in the `botvm` / `botvm-browser` images), `vm-images` (the strip step is each image's last root step), `bot-env.vm` (uid 1000, read-only root, no network) | |
| Engine and storage helper | `security.vm` (no engine socket, no DOCKER_HOST/CONTAINER_HOST, no `ac-storaged` name, mounts only under `/bot`, `/home/bot`, `/opt`) | `@win` `ac-storaged` has no network and isn't reachable |
| Secrets | `security.vm` (the server's GITHUB_TOKEN, TS_AUTHKEY, LLM and endpoint keys in neither `env`, `/proc/1/environ`, the engine's Config.Env nor the runner log), `bot-env.vm`, `egress.vm` (proxy credential never in records), `bot-env`/`bot-env-routes` (reserved names) | |
| Permissions | `permission-routes` (confirm header, 409 on replay, bot side gets `user_only`), `permission-gate`, `permission-gate.vm`, `security` (no model tool answers a permission) | |
| Windows data volume | `files-missing` (missing or foreign marker, missing folder → `files_missing`; runs and writes blocked) | `@win` marker read through the helper |

**Gaps (not automated, or not run on this machine):**

- Distinct host uids need idmapped mounts; on keep-id hosts (rootless here) that test skips and all bots share the user's uid on the host.
- OOM and fork-bomb limits need cgroup limits; on rootless cgroupfs hosts (this dev box) those tests skip with the probe's reason and runs need AC_ALLOW_UNLIMITED_RUNS=1.
- A real full machine disk is not filled; the 3 GB floor is tested with a fake free-space reading and the full-disk check fills only the 512 MB /tmp.
- gvproxy on Mac and Windows: the @mac/@win network tests have never run (no Mac or Windows test machine).
- ac-storaged runs only on Windows: the @win test has never run.
- A real wsl --unregister followed by files_missing and restore needs a throwaway Windows machine; manual only.
- gVisor (runsc) runs of the suite depend on the host: with AC_VM_GVISOR=force_on on a host where runsc passes the probe.

**Manual check for the Windows volume** (on a throwaway machine only): Back up now → `wsl --unregister podman-agentcontrol` → start AgentControl: the VM tab shows Bot files missing, runs and writes are refused → Restore from backup → files and tools are back.
