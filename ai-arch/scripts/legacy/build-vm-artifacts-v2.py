#!/usr/bin/env python3
#
# SUPERSEDED — do not run (Phase 0, kept for history).
#
# Replaced by scripts/build-ai-arch-vm.sh (Phase 1), which renders
# per-build artifacts into build/<name>/ from
# preseed/archinstall-config.json + vms/ai-arch-dev.xml (the canonical,
# deployed domain XML). Running this script overwrites
# preseed/archinstall-config.json with custom_commands: [], which is NOT
# self-sufficient (no access injection, no Tailscale). Do not clobber the
# frozen preseed.
#
"""Build ai-arch-dev artifacts (v2) — schema verified against the ISO's archinstall 4.4 source.

Deliverables:
  vms/ai-arch-dev.qcow2          120G virtio system disk (sparse)
  vms/OVMF_VARS-ai-arch-dev.fd   per-VM UEFI variable store
  vms/seed-ai-arch-dev.iso       NoCloud seed (volid=cidata): root SSH key + hostname + marker
  preseed/archinstall-config.json  manual_partitioning layout (obj_id/dev_path present on every part)
  preseed/archinstall-creds.json   !root-password + !users[archdev]
  vms/ai-arch-dev.xml            libvirt domain (type=qemu/TCG, OVMF, 8GiB/4cpu, virtio, serial)

Design notes (verified):
- Live ISO ships cloud-init + NoCloud + archinstall 4.4 + sshd + systemd-networkd(DHCP).
- No KVM on this host (kernel rejects kvm_amd) -> QEMU runs TCG; install is slow but works.
- Seed is minimal: it only gives root SSH key access + sets hostname. archinstall config/creds
  are scp'd in after we SSH in and confirm the live env is healthy (controllable, debuggable).
- archinstall parse_args does DIRECT key access on partition['obj_id'] and partition['dev_path']
  (device.py L179/L185) -> both MUST be present on every partition dict.
"""
import json, os, subprocess, shutil, sys, uuid

ROOT  = "/home/charlesjackson/ai-arch"
VMS   = os.path.join(ROOT, "vms")
PRE   = os.path.join(ROOT, "preseed")
for d in (VMS, PRE):
    os.makedirs(d, exist_ok=True)

MAC   = "52:54:00:12:34:56:78"
DISK  = os.path.join(VMS, "ai-arch-dev.qcow2")
SEED  = os.path.join(VMS, "seed-ai-arch-dev.iso")
XML   = os.path.join(VMS, "ai-arch-dev.xml")
OVMF_VARS = os.path.join(VMS, "OVMF_VARS-ai-arch-dev.fd")
SERIAL= os.path.join(VMS, "ai-arch-dev-serial.log")
ISO   = os.path.join(ROOT, "iso", "archlinux-2026.08.01-x86_64.iso")

def read_pw(path):
    v = open(path).read().strip()
    assert v, f"empty password file {path}"
    return v

root_pw = read_pw("/tmp/ai-arch-rootpw.txt")
user_pw = read_pw("/tmp/ai-arch-userpw.txt")
owner_pub = open(os.path.expanduser("~/.ssh/ai-arch-dev_ed25519.pub")).read().strip()

# ---------------------------------------------------------------- 1. qcow2
if not os.path.exists(DISK):
    subprocess.run(["qemu-img", "create", "-f", "qcow2", DISK, "120G"], check=True)
print("disk ok:", DISK, os.path.getsize(DISK), "bytes (sparse)")

# ---------------------------------------------------------------- 2. OVMF vars
if not os.path.exists(OVMF_VARS):
    shutil.copy("/usr/share/OVMF/OVMF_VARS_4M.fd", OVMF_VARS)
print("ovmf vars ok")

# ---------------------------------------------------------------- 3. archinstall config
def part(pid, start_v, start_u, size_v, size_u, fs, mp, flags):
    return {
        "obj_id": pid,
        "status": "create",
        "type": "primary",
        "start": {"unit": start_u, "value": start_v,
                  "sector_size": {"unit": "B", "value": 512}},
        "size":  {"unit": size_u,  "value": size_v,
                  "sector_size": {"unit": "B", "value": 512}},
        "fs_type": fs,
        "mountpoint": mp,
        "mount_options": [],
        "flags": flags,
        "dev_path": None,
    }

pids = [str(uuid.uuid4()) for _ in range(3)]
config = {
    "archinstall-language": "English",
    "debug": False,
    "silent": True,
    "hostname": "ai-arch-dev",
    "timezone": "UTC",
    "ntp": True,
    "kernels": ["linux"],
    "locale_config": {"sys_lang": "en_US", "sys_enc": "UTF-8", "kb_layout": "us"},
    "mirror_config": {
        "custom_servers": [
            {"url": "https://mirror.arizona.edu/archlinux/$repo/os/$arch"}
        ]
    },
    "network_config": {"type": "iso"},
    "disk_config": {
        "config_type": "manual_partitioning",
        "device_modifications": [
            {
                "device": "/dev/vda",
                "wipe": True,
                "partitions": [
                    part(pids[0], 1,    "MiB", 512,  "MiB", "fat32",      "/boot", ["esp"]),
                    part(pids[1], 513,  "MiB", 4,    "GiB", "linux-swap", None,    []),
                    part(pids[2], 4613, "MiB", 115,  "GiB", "ext4",       "/",     []),
                ],
            }
        ],
    },
    "bootloader_config": {"bootloader": "Systemd-boot", "uki": False, "removable": False},
    "swap": {"enabled": False},
    "services": ["sshd"],
    "packages": ["openssh", "git", "curl"],
    "pacman_config": {"parallel_downloads": 4},
    "custom_commands": [],
}
cfg_path = os.path.join(PRE, "archinstall-config.json")
json.dump(config, open(cfg_path, "w"), indent=2)
print("config ok:", cfg_path)

# ---------------------------------------------------------------- 4. creds
creds = {
    "!root-password": root_pw,
    "!users": [
        {"username": "archdev", "!password": user_pw, "sudo": True,
         "groups": ["wheel", "users"]}
    ],
}
creds_path = os.path.join(PRE, "archinstall-creds.json")
json.dump(creds, open(creds_path, "w"), indent=2)
os.chmod(creds_path, 0o600)
print("creds ok:", creds_path)

# ---------------------------------------------------------------- 5. NoCloud seed (minimal)
seed_dir = os.path.join(VMS, "seed-src")
shutil.rmtree(seed_dir, ignore_errors=True)
os.makedirs(seed_dir)
open(os.path.join(seed_dir, "meta-data"), "w").write(
    "instance-id: ai-arch-dev-20260823\nlocal-hostname: ai-arch-dev\n")
open(os.path.join(seed_dir, "vendor-data"), "w").write("# empty vendor-data\n")
user_data = (
    "#cloud-config\n"
    "disable_root: false\n"
    "preserve_hostname: false\n"
    "hostname: ai-arch-dev\n"
    "users:\n"
    "  - name: root\n"
    "    shell: /bin/bash\n"
    "    ssh_authorized_keys:\n"
    f"      - {owner_pub}\n"
    "runcmd:\n"
    "  - [ bash, -c, 'echo ai-arch-dev cloud-init runcmd $(date -u +%FT%TZ) > /run/ai-arch-cloudinit-ran' ]\n"
)
open(os.path.join(seed_dir, "user-data"), "w").write(user_data)
subprocess.run(
    ["genisoimage", "-output", SEED, "-volid", "cidata", "-joliet", "-rock", seed_dir], check=True, capture_output=True)
print("seed iso ok:", SEED, os.path.getsize(SEED), "bytes")

# ---------------------------------------------------------------- 6. VM XML (TCG / no KVM)
xml = f"""<domain type='qemu'>
  <name>ai-arch-dev</name>
  <title>AI-Arch Phase 0: disposable Arch Linux dev VM (TCG)</title>
  <memory unit='GiB'>8</memory>
  <currentMemory unit='GiB'>8</currentMemory>
  <vcpu placement='static'>4</vcpu>
  <os>
    <loader readonly='yes' secure='no'>/usr/share/OVMF/OVMF_CODE_4M.fd</loader>
    <nvram template='/usr/share/OVMF/OVMF_VARS_4M.fd'>{OVMF_VARS}</nvram>
    <boot dev='cdrom'/>
    <boot dev='hd'/>
  </os>
  <features>
    <acpi/>
    <apic/>
  </features>
  <cpu mode='host-model'/>
  <clock offset='utc'/>
  <on_poweroff>destroy</on_poweroff>
  <on_reboot>restart</on_reboot>
  <on_crash>destroy</on_crash>
  <devices>
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2'/>
      <source file='{DISK}'/>
      <target dev='vda' bus='virtio'/>
    </disk>
    <disk type='file' device='cdrom'>
      <driver name='qemu' type='raw'/>
      <source file='{ISO}'/>
      <target dev='sda' bus='sata'/>
      <readonly/>
    </disk>
    <disk type='file' device='cdrom'>
      <driver name='qemu' type='raw'/>
      <source file='{SEED}'/>
      <target dev='sdb' bus='sata'/>
      <readonly/>
    </disk>
    <interface type='network'>
      <mac address='{MAC}'/>
      <source network='default'/>
      <model type='virtio'/>
    </interface>
    <serial type='file'>
      <source path='{SERIAL}'/>
      <target port='0'/>
    </serial>
    <console type='pty'>
      <target type='serial' port='0'/>
    </console>
    <input type='tablet' bus='usb'/>
    <graphics type='vnc' port='-1' listen='127.0.0.1'/>
    <video>
      <model type='virtio' vram='16384' heads='1' primary='yes'/>
    </video>
  </devices>
</domain>
"""
open(XML, "w").write(xml)
print("vm xml ok:", XML)
print("MAC:", MAC)
print("ALL ARTIFACTS BUILT")
