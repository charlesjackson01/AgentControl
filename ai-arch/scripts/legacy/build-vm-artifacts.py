#!/usr/bin/env python3
#
# SUPERSEDED — do not run (Phase 0, kept for history).
#
# The canonical, reproducible build path is scripts/build-ai-arch-vm.sh
# (Phase 1), which renders per-build artifacts into build/<name>/ from
# preseed/archinstall-config.json + vms/ai-arch-dev.xml (the deployed,
# proven domain XML). Running this script overwrites
# preseed/archinstall-config.json (with custom_commands: []) — the current
# frozen preseed is self-sufficient by design; do not clobber it.
#
"""Build all ai-arch-dev artifacts: qcow2, archinstall preseed, NoCloud seed ISO, VM XML.

Design (all verified against the actual ISO's archinstall 4.4 source):
- ISO boots with systemd-boot + cloud-init (NoCloud) + sshd; root autologin on tty1.
- NoCloud seed (2nd SATA disk, volid=cidata) injects the OWNER's public key into the
  live ISO so we can SSH in and drive the install hands-free.
- archinstall runs: --config (layout/net/bootloader) --creds (root+user pw) --silent.
- custom_commands (runs in chroot during install, before genfstab) hardens sshd and
  installs the owner key for the INSTALLED system.
- NIC: virtio on libvirt 'default' NAT; DHCP with a MAC reservation -> 192.168.122.50.
- network_config type "iso" = copy the ISO's DHCP systemd-networkd config (robust,
  no hardcoded iface name).
"""
import json, os, subprocess, shutil, sys

ROOT = "/home/charlesjackson/ai-arch"
VMS = os.path.join(ROOT, "vms")
PRE = os.path.join(ROOT, "preseed")
os.makedirs(VMS, exist_ok=True)
os.makedirs(PRE, exist_ok=True)

MAC = "52:54:00:12:34:56:78"
VM_IP = "192.168.122.50"
DISK = os.path.join(VMS, "ai-arch-dev.qcow2")
SEED = os.path.join(VMS, "seed-ai-arch-dev.iso")
XML = os.path.join(VMS, "ai-arch-dev.xml")
OVMF_VARS = os.path.join(VMS, "OVMF_VARS-ai-arch-dev.fd")
SERIAL = os.path.join(VMS, "ai-arch-dev-serial.log")
ISO = os.path.join(ROOT, "iso", "archlinux-2026.08.01-x86_64.iso")

root_pw = open("/tmp/ai-arch-rootpw.txt").read().strip()
user_pw = open("/tmp/ai-arch-userpw.txt").read().strip()
owner_pub = open(os.path.expanduser("~/.ssh/ai-arch-dev_ed25519.pub")).read().strip()

# ---------------------------------------------------------------- 1. qcow2
if not os.path.exists(DISK):
    subprocess.run(["qemu-img", "create", "-f", "qcow2", DISK, "120G"], check=True)
print("disk ok:", DISK)

# ---------------------------------------------------------------- 2. OVMF vars copy
if not os.path.exists(OVMF_VARS):
    shutil.copy("/usr/share/OVMF/OVMF_VARS_4M.fd", OVMF_VARS)
print("ovmf vars ok")

# ---------------------------------------------------------------- 3. archinstall config
# Post-install script executed INSIDE the chroot (target mounted at /mnt, so
# chroot-absolute paths) by archinstall's run_custom_user_commands() right after
# user creation / package install, before genfstab.
POST = r"""#!/bin/bash
# ai-arch-dev Phase 0 post-install (runs in chroot during archinstall)
set -euo pipefail
echo "[post] ai-arch-dev post-install start"
# --- owner SSH key for the admin user ---
mkdir -p /home/archdev/.ssh
echo '{owner_pub}' > /home/archdev/.ssh/authorized_keys
chmod 700 /home/archdev/.ssh
chmod 600 /home/archdev/.ssh/authorized_keys
chown -R archdev:archdev /home/archdev/.ssh
# --- owner key for root (break-glass only; root SSH stays disabled) ---
mkdir -p /root/.ssh
echo '{owner_pub}' > /root/.ssh/authorized_keys
chmod 700 /root/.ssh
chmod 600 /root/.ssh/authorized_keys
# --- sshd hardening: key-based auth only ---
cat >> /etc/ssh/sshd_config.d/99-ai-arch-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
X11Forwarding no
EOF
chmod 600 /etc/ssh/sshd_config.d/99-ai-arch-hardening.conf
systemctl enable sshd.service || true
echo "[post] ai-arch-dev post-install done"
""".replace("{owner_pub}", owner_pub)

config = {
    "archinstall-language": "English",
    "debug": False,
    "silent": True,
    "hostname": "ai-arch-dev",
    "timezone": "UTC",
    "ntp": True,
    "kernels": ["linux"],
    "locale_config": {
        "sys_lang": "en_US",
        "sys_enc": "UTF-8",
        "kb_layout": "us",
    },
    "mirror_config": {
        "custom_servers": [
            {"url": "https://mirror.arizona.edu/archlinux/$repo/os/$arch"}
        ]
    },
    "network_config": {
        "type": "iso"
    },
    "disk_config": {
        "config_type": "default_layout",
        "device_modifications": [
            {
                "device": "/dev/vda",
                "wipe": True,
                "partitions": [
                    {
                        "status": "create",
                        "type": "primary",
                        "start": {"unit": "MiB", "sector_size": {"unit": "B", "value": 512}, "value": 1},
                        "size": {"unit": "MiB", "sector_size": {"unit": "B", "value": 512}, "value": 512},
                        "fs_type": "fat32",
                        "mountpoint": "/boot",
                        "flags": ["esp"],
                        "mount_options": [],
                    },
                    {
                        "status": "create",
                        "type": "primary",
                        "start": {"unit": "MiB", "sector_size": {"unit": "B", "value": 512}, "value": 513},
                        "size": {"unit": "GiB", "sector_size": {"unit": "B", "value": 512}, "value": 4},
                        "fs_type": "linux-swap",
                        "mountpoint": None,
                        "flags": [],
                        "mount_options": [],
                    },
                    {
                        "status": "create",
                        "type": "primary",
                        "start": {"unit": "MiB", "sector_size": {"unit": "B", "value": 512}, "value": 4613},
                        "size": {"unit": "GiB", "sector_size": {"unit": "B", "value": 512}, "value": 115},
                        "fs_type": "ext4",
                        "mountpoint": "/",
                        "flags": [],
                        "mount_options": [],
                    },
                ],
            }
        ],
    },
    "bootloader_config": {
        "bootloader": "Systemd-boot",
        "uki": False,
        "removable": False,
    },
    "swap": {"enabled": False},
    "services": ["sshd"],
    "packages": ["openssh", "git", "curl"],
    "pacman_config": {"parallel_downloads": 4},
    "custom_commands": [POST],
}
cfg_path = os.path.join(PRE, "archinstall-config.json")
json.dump(config, open(cfg_path, "w"), indent=2)
print("config ok:", cfg_path)

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

# ---------------------------------------------------------------- 4. NoCloud seed
seed_dir = os.path.join(VMS, "seed-src")
shutil.rmtree(seed_dir, ignore_errors=True)
os.makedirs(seed_dir)
open(os.path.join(seed_dir, "meta-data"), "w").write(
    "instance-id: ai-arch-dev-20260823\nlocal-hostname: ai-arch-dev\n")
open(os.path.join(seed_dir, "vendor-data"), "w").write("# empty vendor-data\n")
user_data = (
    "#cloud-config\n"
    "preserve_hostname: true\n"
    "ssh_pwauth: true\n"
    "disable_root: false\n"
    "users:\n"
    "  - name: root\n"
    "    shell: /bin/bash\n"
    f"    ssh_authorized_keys:\n"
    f"      - {owner_pub}\n"
    "runcmd:\n"
    "  - [ bash, -c, 'echo ai-arch-dev live image up > /run/ai-arch-live-up' ]\n"
)
open(os.path.join(seed_dir, "user-data"), "w").write(user_data)
subprocess.run(
    ["genisoimage", "-output", SEED, "-volid", "cidata", "-joliet", "-rock",
     "-no-emul-boot", seed_dir], check=True, capture_output=True)
print("seed iso ok:", SEED, os.path.getsize(SEED))

# ---------------------------------------------------------------- 5. VM XML
xml = f"""<domain type='qemu'>
  <name>ai-arch-dev</name>
  <title>AI-Arch Phase 0: disposable Arch Linux dev VM</title>
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
    <disk type='file' device='disk'>
      <driver name='qemu' type='raw'/>
      <source file='{SEED}'/>
      <target dev='sdb' bus='sata'/>
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
      <model type='cirrus' vram='16384' heads='1' primary='yes'/>
    </video>
  </devices>
</domain>
"""
open(XML, "w").write(xml)
print("vm xml ok:", XML)
print("MAC:", MAC, "IP:", VM_IP)
print("ALL ARTIFACTS BUILT")
