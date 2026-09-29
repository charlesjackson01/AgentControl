#!/bin/bash
# Retry ISO download from official mirror (mirror.arizona.edu is an official
# Arch mirror; sha256 cross-verified against archlinux.org releng page).
DIR=/home/charlesjackson/ai-arch/iso
cd "$DIR" || exit 1
ISO=archlinux-2026.08.01-x86_64.iso
{
echo "=== [$(date -u +%FT%TZ)] fetch .sig from official mirror ==="
curl -fsSL --max-time 120 "https://mirror.arizona.edu/archlinux/iso/latest/$ISO.sig" -o "$ISO.sig" \
  || curl -fsSL --max-time 120 "https://archlinux.org/releng/releases/2026.08.01/$ISO.sig" -o "$ISO.sig"
ls -la "$ISO.sig" 2>&1
echo "=== [$(date -u +%FT%TZ)] retry download from official mirror ==="
curl -fSL --retry 3 --retry-delay 5 --max-time 5400 \
  "https://mirror.arizona.edu/archlinux/iso/latest/$ISO" -o "$ISO"
rc=$?
echo "download rc=$rc size=$(stat -c%s "$ISO" 2>/dev/null)"
[ $rc -ne 0 ] && { echo "MIRROR DOWNLOAD FAILED"; exit 1; }
echo "=== [$(date -u +%FT%TZ)] verify SHA256 ==="
sha256sum -c expected.sha256 2>&1
echo "=== [$(date -u +%FT%TZ)] verify GPG signature (key 0x54449A5C already in GNUPGHOME? rebuild) ==="
export GNUPGHOME=$(mktemp -d); chmod 700 "$GNUPGHOME"
gpg --batch --keyserver hkps://keyserver.ubuntu.com --recv-keys 0x54449A5C 2>&1 | tail -2
gpg --verify "$ISO.sig" "$ISO" 2>&1 | tail -8
echo "=== DONE [$(date -u +%FT%TZ)] ==="
} 2>&1 | tee "$DIR/iso-verify2.log"
tail -1 "$DIR/iso-verify2.log"
