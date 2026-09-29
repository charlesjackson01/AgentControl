#!/bin/bash
# Download + verify official Arch ISO 2026.08.01
# official-sha256sums.txt already fetched into $DIR (from mirror, cross-checked
# against archlinux.org/releng/releases/2026.08.01/)
DIR=/home/charlesjackson/ai-arch/iso
cd "$DIR" || exit 1
ISO=archlinux-2026.08.01-x86_64.iso
{
echo "=== [$(date -u +%FT%TZ)] expected sha256 (official) ==="
grep -F "$ISO" official-sha256sums.txt | tee expected.sha256
echo "=== [$(date -u +%FT%TZ)] fetch .sig ==="
curl -fsSL --max-time 120 "https://archlinux.org/releng/releases/2026.08.01/$ISO.sig" -o "$ISO.sig" 2>&1 \
  || curl -fsSL --max-time 120 "https://mirror.arizona.edu/archlinux/iso/latest/$ISO.sig" -o "$ISO.sig" 2>&1
ls -la "$ISO.sig" 2>&1
echo "=== [$(date -u +%FT%TZ)] fetch release signing key (fingerprint 0x54449A5C short) ==="
export GNUPGHOME=$(mktemp -d); chmod 700 "$GNUPGHOME"
gpg --batch --keyserver hkps://keyserver.ubuntu.com --recv-keys 0x54449A5C 2>&1 | tail -3
echo "--- key details ---"
gpg --list-keys --fingerprint 2>&1
echo "=== [$(date -u +%FT%TZ)] download ISO (official archlinux.org/iso/) ==="
curl -fSL --retry 3 --retry-delay 5 --max-time 5400 "https://archlinux.org/iso/$ISO" -o "$ISO"
rc=$?
echo "download rc=$rc size=$(stat -c%s "$ISO" 2>/dev/null)"
[ $rc -ne 0 ] && { echo "DOWNLOAD FAILED"; exit 1; }
echo "=== [$(date -u +%FT%TZ)] verify SHA256 ==="
sha256sum -c expected.sha256 2>&1
echo "=== [$(date -u +%FT%TZ)] verify GPG signature ==="
gpg --verify "$ISO.sig" "$ISO" 2>&1 | tail -8
echo "=== DONE [$(date -u +%FT%TZ)] ==="
} 2>&1 | tee "$DIR/iso-verify.log"
tail -1 "$DIR/iso-verify.log"
