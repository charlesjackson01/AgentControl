#!/bin/bash
OUT=/home/charlesjackson/ai-arch/recon/probe4-kvm-dbg.txt
mkdir -p "$(dirname "$OUT")"
{
echo "=== running kernel vs modules ==="
uname -r
ls /lib/modules/ 2>&1
echo "=== modinfo kvm / kvm_amd ==="
modinfo kvm 2>&1 | head -6
modinfo kvm_amd 2>&1 | head -6
echo "=== dmesg kvm-related ==="
sudo dmesg 2>&1 | grep -iE "kvm|svm|hypervisor|npt|avic" | tail -40
echo "=== /proc/cpuinfo svm + flags sample ==="
grep -m1 -o 'svm' /proc/cpuinfo
grep -m1 flags /proc/cpuinfo | tr ' ' '\n' | grep -iE '^(svm|vmx|npt|la57|avx512|avx2)$'
echo "=== /dev/cpu_dma_latency or any other hyp hints ==="
cat /sys/module/kvm/version 2>&1
echo "=== boot cmdline ==="
cat /proc/cmdline
echo "=== dmidecode product (read-only) ==="
sudo dmidecode -s system-product-name 2>&1
sudo dmidecode -s system-manufacturer 2>&1
echo "=== done ==="
} 2>&1 | tee "$OUT"
tail -1 "$OUT"
