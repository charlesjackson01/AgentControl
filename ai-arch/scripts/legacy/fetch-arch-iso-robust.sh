#!/bin/bash
# Robust official Arch ISO downloader: tries multiple official sources in
# order with retries. Verifies SHA256 + GPG at the end.
DIR=/home/charlesjackson/ai-arch/iso
cd "$DIR" || exit 1
ISO=archlinux-2026.08.01-x86_64.iso
UA="Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0"
SOURCES=(
  "https://archlinux.org/iso/$ISO"
  "https://mirror.arizona.edu/archlinux/iso/latest/$ISO"
  "https://arch.mirror.gws.fc.com/archlinux/iso/latest/$ISO"
  "https://mirror.23mz.com/archlinux/iso/latest/$ISO"
  "https://mirror.math.princeton.edu/pub/archlinux/iso/latest/$ISO"
)
{
echo "=== [$(date -u +%FT%TZ)] fetch .sig (official) ==="
for sigurl in \
  "https://mirror.arizona.edu/archlinux/iso/latest/$ISO.sig" \
  "https://arch.mirror.gws.fc.com/archlinux/iso/latest/$ISO.sig" \
  "https://archlinux.org/releng/releases/2026.08.01/$ISO.sig"; do
  echo "--- trying: $sigurl"
  curl -fsSL --max-time 60 -A "$UA" "$sigurl" -o "$ISO.sig" 2>&1 | tail -2
  if [ -s "$ISO.sig" ]; then echo "sig OK from $sigurl"; break; fi
done
ls -la "$ISO.sig" 2>&1
echo "=== [$(date -u +%FT%TZ)] robust ISO download ==="
ok=""
for url in "${SOURCES[@]}"; do
  echo "--- trying: $url"
  for attempt in 1 2 3; do
    curl -fSL --retry 2 --retry-delay 3 --max-time 5400 -A "$UA" "$url" -o "$ISO.part" 2>&1 | tail -3
    rc=$?
    if [ $rc -eq 0 ] && [ -s "$ISO.part" ]; then
      size=$(stat -c%s "$ISO.part")
      echo "downloaded from $url size=$size"
      # quick size sanity (ISO ~1.5GB; accept >1.2GB)
      if [ "$size" -gt 1200000000 ]; then
        mv "$ISO.part" "$ISO"
        ok="$url"
        break 2
      fi
      echo "size too small ($size), retrying..."
    else
      echo "attempt $attempt failed rc=$rc, sleeping 10s"
      sleep 10
    fi
  done
  rm -f "$ISO.part"
done
[ -z "$ok" ] && { echo "ALL SOURCES FAILED"; exit 1; }
echo "=== [$(date -u +%FT%TZ)] verify SHA256 (official hash) ==="
sha256sum -c expected.sha256 2>&1
sha_rc=$?
echo "=== [$(date -u +%FT%TZ)] verify GPG signature ==="
export GNUPGHOME=$(mktemp -d); chmod 700 "$GNUPGHOME"
gpg --batch --keyserver hkps://keyserver.ubuntu.com --recv-keys 0x54449A5C 2>&1 | tail -2
gpg --verify "$ISO.sig" "$ISO" 2>&1 | tail -8
echo "=== DONE source=$ok sha_rc=$sha_rc [$(date -u +%FT%TZ)] ==="
} 2>&1 | tee "$DIR/iso-verify3.log"
tail -1 "$DIR/iso-verify3.log"
