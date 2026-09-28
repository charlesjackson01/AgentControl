#!/bin/bash
OUT=/home/charlesjackson/ai-arch/recon/probe8-final.txt
mkdir -p "$(dirname "$OUT")"
{
echo "=== PRECISE svm flag check (standalone word only) ==="
flagsline=$(grep -m1 '^flags' /proc/cpuinfo)
# split into words and test exact token
echo "$flagsline" | tr ' ' '\n' | grep -x 'svm' >/dev/null 2>&1 && echo "EXACT 'svm' token: PRESENT" || echo "EXACT 'svm' token: ABSENT (only svm_lock etc.)"
echo "$flagsline" | tr ' ' '\n' | grep -E '^svm.*' | sort -u
echo
echo "=== systemd-detect-virt (expect: none) ==="
systemd-detect-virt 2>&1
echo
echo "=== installed hypervisor / VM tooling ==="
for t in qemu-system-x86_64 virt-install virsh vboxmanage vmrun VBoxManage virt-manager cloud-localds; do
  printf "%-22s " "$t"; command -v "$t" >/dev/null 2>&1 && echo "$(command -v $t)" || echo "NOT INSTALLED"
done
echo
echo "=== qemu version ==="
qemu-system-x86_64 --version 2>&1 | head -1
echo
echo "=== PCI virtualization vendor devices (QEMU 1af4 / VMware 15ad / RedHat 1b36) ==="
sudo lspci -nn 2>&1 | grep -iE "1af4|15ad|1b36" || echo "(none — consistent with bare metal)"
echo
echo "=== /sys/hypervisor ==="
cat /sys/hypervisor/type 2>&1 || echo "(no /sys/hypervisor)"
echo
echo "=== IOMMU (for later GPU passthrough) ==="
sudo dmesg 2>&1 | grep -iE "AMD-Vi|iommu" | head -6
echo
echo "=== free resources for sizing ==="
free -h | head -2
echo "disk:"; df -h /home 2>&1 | tail -1
echo
echo "=== tailscale on host (remote access path) ==="
command -v tailscale >/dev/null 2>&1 && tailscale ip -4 2>&1 | head -2 || echo "tailscale: NOT on host"
echo
echo "=== done ==="
} 2>&1 | tee "$OUT"
tail -1 "$OUT"
