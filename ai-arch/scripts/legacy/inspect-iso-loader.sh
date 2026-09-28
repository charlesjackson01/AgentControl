#!/bin/bash
# Inspect the ISO's systemd-boot loader entries (Rock Ridge names).
cd /home/charlesjackson/ai-arch/iso || exit 1
ISO=archlinux-2026.08.01-x86_64.iso
OUT=/home/charlesjackson/ai-arch/recon/iso-loader.txt
{
echo "=== ISO9660 names (LOADER) ==="
isoinfo -i "$ISO" -f 2>/dev/null | grep -i "LOADER"
echo
echo "=== RockRidge names (LOADER) ==="
isoinfo -i "$ISO" -f -R 2>/dev/null | grep -i "LOADER"
echo
for f in $(isoinfo -i "$ISO" -f -R 2>/dev/null | grep -E "^/LOADER" | grep -v ":"); do
  echo "########## $f ##########"
  isoinfo -i "$ISO" -x "$f" 2>/dev/null
  echo
done
} > "$OUT" 2>&1
cat "$OUT"
