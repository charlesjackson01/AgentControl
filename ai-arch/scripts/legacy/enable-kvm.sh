#!/bin/bash
# Enable KVM for AMD: load module, persist, verify /dev/kvm + libvirtd
OUT=/home/charlesjackson/ai-arch/recon/probe3-kvm-enable.txt
mkdir -p "$(dirname "$OUT")"
{
echo "=== load kvm_amd ==="
sudo modprobe kvm_amd 2>&1 || echo "modprobe kvm_amd FAILED (rc=$?)"
echo "=== persist (modules-load.d) ==="
echo "kvm_amd" | sudo tee /etc/modules-load.d/kvm-amd.conf >/dev/null && echo persisted
echo "=== /dev/kvm after ==="
ls -la /dev/kvm 2>&1
echo "=== libvirtd ==="
sudo systemctl is-active libvirtd 2>&1
sudo virsh version 2>&1 | head -4
echo "=== libvirt networks ==="
sudo virsh net-list --all 2>&1
echo "=== existing VMs ==="
sudo virsh list --all 2>&1
echo "=== OVMF firmware ==="
ls -la /usr/share/OVMF/ 2>&1 | head
echo "=== done ==="
} 2>&1 | tee "$OUT"
tail -1 "$OUT"
