#!/bin/bash
# Phase 0 KVM / libvirt readiness probe (read-only where possible)
OUT=/home/charlesjackson/ai-arch/recon/probe2-kvm.txt
mkdir -p "$(dirname "$OUT")"
{
echo "=== /dev/kvm (before) ==="
ls -la /dev/kvm 2>&1
echo "=== kvm modules in /proc/modules ==="
grep -E '^kvm' /proc/modules || echo "no kvm in /proc/modules"
echo "=== /dev/kvm via find ==="
find /dev -name 'kvm*' 2>/dev/null || true
echo "=== modules available (kvm_amd) ==="
modinfo kvm_amd 2>&1 | head -5
echo "=== libvirt daemon ==="
systemctl is-active libvirtd 2>&1
systemctl is-enabled libvirtd 2>&1
echo "=== virsh connection (as user, no sudo) ==="
virsh list --all 2>&1 | head -20
echo "=== virsh with sudo ==="
sudo virsh list --all 2>&1 | head -20
echo "=== libvirt URI / sockets ==="
ls -la /var/run/libvirt/libvirt-sock* 2>&1
echo "=== sudo -n check ==="
sudo -n true 2>&1 && echo "passwordless sudo: YES" || echo "passwordless sudo: NO"
echo "=== ovmf firmware ==="
ls -la /usr/share/ovmf 2>&1 | head
ls -la /usr/share/edk2 2>&1 | head
echo "=== arch iso present? ==="
ls -la /home/charlesjackson/*.iso /var/lib/libvirt/images/*.iso 2>&1 | head
echo "=== libvirt images dir ==="
ls -la /var/lib/libvirt/images 2>&1 | head
echo "=== END ==="
} > "$OUT" 2>&1
echo "wrote $OUT"
