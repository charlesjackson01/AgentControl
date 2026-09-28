#!/bin/bash
OUT=/home/charlesjackson/ai-arch/recon/probe5-kvm-dbg2.txt
mkdir -p "$(dirname "$OUT")"
{
echo "=== uptime ==="
uptime
echo "=== per-CPU svm check (expect nothing printed if all OK) ==="
awk '/^processor/{p=$3} /^flags/{ if ($0 !~ /svm/) print "CPU " p " MISSING svm" }' /proc/cpuinfo
echo "(per-cpu check done)"
echo "=== cpu 23 flags sample ==="
awk '/^processor/{p=$3} /^flags/{ if (p==23) print substr($0,1,200)"..." }' /proc/cpuinfo
echo "=== dmesg full kvm context ==="
sudo dmesg 2>&1 | grep -iB3 -A10 "kvm" | tail -60
echo "=== lsmod kvm/ccp/irqbypass ==="
lsmod 2>&1 | grep -iE "kvm|ccp|irqbypass|authenc" || echo "(none loaded)"
echo "=== try modprobe kvm alone ==="
sudo modprobe -v kvm 2>&1
echo "rc=$?"
echo "=== lsmod after ==="
lsmod 2>&1 | grep -iE "^kvm" || echo "(still none)"
echo "=== try kvm_amd again ==="
sudo modprobe -v kvm_amd 2>&1
echo "rc=$?"
ls -la /dev/kvm 2>&1
echo "=== secure boot ==="
mokutil --sb-state 2>&1 || echo "(mokutil not present)"
echo "=== done ==="
} 2>&1 | tee "$OUT"
tail -1 "$OUT"
