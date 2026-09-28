#!/bin/bash
cd /home/charlesjackson/ai-arch/iso || exit 1
ISO=archlinux-2026.08.01-x86_64.iso
mkdir -p /tmp/iso-x
for f in loader.conf entries/01-archiso-linux.conf entries/02-archiso-speech-linux.conf entries/03-archiso-memtest86+x64.conf; do
  xorriso -osirrox on -indev "$ISO" -extract "/loader/$f" "/tmp/iso-x/$(echo "$f" | tr '/+' '__')" >/dev/null 2>&1
done
xorriso -osirrox on -indev "$ISO" -extract /arch/VERSION /tmp/iso-x/VERSION >/dev/null 2>&1
echo "=== extracted ==="; ls -la /tmp/iso-x/
for f in /tmp/iso-x/*; do
  echo "########## $f ##########"
  head -c 3000 "$f" | strings | head -40
  echo
done
