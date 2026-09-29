#!/bin/bash
cd /home/charlesjackson/ai-arch/iso || exit 1
ISO=archlinux-2026.08.01-x86_64.iso
OUT=/home/charlesjackson/ai-arch/recon/iso-loader2.txt
# isoinfo -x wants the ISO9660 path WITHOUT the ;1 suffix
for f in \
  "/LOADER/LOADER.CONF" \
  "/LOADER/ENTRIES/01_ARCHISO_LINUX.CONF" \
  "/LOADER/ENTRIES/02_ARCHISO_SPEECH_LINUX.CONF" \
  "/LOADER/ENTRIES/03_ARCHISO_MEMTEST86_X64.CONF" \
  "/ARCH/VERSION" \
  "/EFI/BOOT/BOOTX64.EFI" ; do
  echo "########## $f ##########"
  isoinfo -i "$ISO" -x "$f" 2>/dev/null | head -60
  echo
done | tee "$OUT"
echo "=== VERSION ==="
isoinfo -i "$ISO" -x "/ARCH/VERSION" 2>/dev/null
