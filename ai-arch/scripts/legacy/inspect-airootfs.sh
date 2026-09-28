#!/bin/bash
# Extract AIROOTFS.SFS (live root) and find the archiso autoinstall hook.
cd /home/charlesjackson/ai-arch/iso || exit 1
ISO=archlinux-2026.08.01-x86_64.iso
OUT=/home/charlesjackson/ai-arch/recon/iso-autoinst.txt
mkdir -p /tmp/airoot
{
echo "=== extract AIROOTFS.SFS ==="
isoinfo -i "$ISO" -x "/ARCH/X86_64/AIROOTFS.SFS" > /tmp/airoot/AIROOTFS.SFS 2>/tmp/airoot/ex.err || xorriso -osirrox on -indev "$ISO" -extract /arch/x86_64/AIROOTFS.SFS /tmp/airoot/AIROOTFS.SFS 2>&1
ls -la /tmp/airoot/
echo "=== unsquashfs (partial, boot-related) ==="
unsquashfs -f -d /tmp/airoot/root -p "arch/boot" /tmp/airoot/AIROOTFS.SFS 2>&1 | tail -5
unsquashfs -f -d /tmp/airoot/root -p "etc/archiso" /tmp/airoot/AIROOTFS.SFS 2>&1 | tail -5
echo "=== grep for autoinst ==="
grep -rn "autoinst" /tmp/airoot/root 2>/dev/null
echo "=== archiso script ==="
find /tmp/airoot/root -name "archiso" -o -name "*.sh" -path "*boot*" 2>/dev/null | head
} > "$OUT" 2>&1
tail -40 "$OUT"
