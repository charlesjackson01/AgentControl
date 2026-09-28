#!/bin/bash
# Phase 0 host environment probe (read-only)
OUT=/home/charlesjackson/ai-arch/recon/probe1.txt
mkdir -p "$(dirname "$OUT")"
{
echo "=== OS ==="
head -4 /etc/os-release
uname -m
echo "=== VIRT ==="
echo "virt: $(systemd-detect-virt 2>&1)"
echo "container: $(systemd-detect-virt --container 2>&1)"
ls -la /dev/kvm 2>&1
echo "vmx:$(grep -c vmx /proc/cpuinfo) svm:$(grep -c svm /proc/cpuinfo)"
lsmod 2>/dev/null | grep -E 'kvm|qemu' || echo "no kvm/qemu modules"
echo "=== RESOURCES ==="
free -h | head -3
df -h / /home 2>/dev/null
nproc
echo "=== VIRT TOOLS ==="
for t in qemu-system-x86_64 qemu-img virt-install virsh vboxmanage vmrun podman docker; do
  command -v $t >/dev/null 2>&1 && echo "$t: $(command -v $t)" || echo "$t: MISSING"
done
echo "=== LIBVIRT ==="
ls -la /var/run/libvirt 2>&1 | head -5
echo "=== NETWORK ==="
ip -brief addr 2>/dev/null || ifconfig -a 2>/dev/null | grep -E '^[a-z]|inet'
echo "=== DOCKER ==="
docker ps --format '{{.Names}} {{.Ports}}' 2>&1 | head -20
echo "=== END ==="
} > "$OUT" 2>&1
echo "wrote $OUT"
