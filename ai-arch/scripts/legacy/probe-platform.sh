#!/bin/bash
OUT=/home/charlesjackson/ai-arch/recon/probe7-platform.txt
mkdir -p "$(dirname "$OUT")"
{
echo "=== dmesg DMI / hypervisor / virtualization hints ==="
sudo dmesg 2>&1 | grep -iE "dmi|hypervisor|hyperv|qemu|virtual|vmware|xen|kvm|iommu|amd_iommu" | head -40
echo "=== /sys/firmware/dmi ==="
for f in /sys/class/dmi/id/sys_vendor /sys/class/dmi/id/product_name /sys/class/dmi/id/board_vendor /sys/class/dmi/id/bios_vendor /sys/class/dmi/id/chassis_type; do
  echo "$f: $(cat "$f" 2>&1)"
done
echo "=== PCI vendors (look for QEMU 1af4 / VMware 15ad / virtio) ==="
sudo lspci -nn 2>&1 | grep -iE "1af4|15ad|1b36|virtual|vmware|qemu|red hat" || echo "(no virtualization vendor PCI devices)"
echo "=== lspci count + sample ==="
sudo lspci 2>&1 | head -12
echo "=== /sys/hypervisor ==="
ls -la /sys/hypervisor/ 2>&1; cat /sys/hypervisor/type 2>&1
echo "=== IOMMU state ==="
sudo dmesg 2>&1 | grep -iE "iommu" | head -8
ls /sys/kernel/iommu_groups 2>&1 | head -3
echo "=== systemd-detect-virt ==="
systemd-detect-virt 2>&1
echo "=== done ==="
} 2>&1 | tee "$OUT"
tail -1 "$OUT"
