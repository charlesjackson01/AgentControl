#!/bin/bash
# ISO download, IPv4-forced, from confirmed-good official mirrors.
DIR=/home/charlesjackson/ai-arch/iso
cd "$DIR" || exit 1
ISO="archlinux-2026.08.01-x86_64.iso"
EXPECTED="4e82dced1c4fd3e498b22a853f8db2a4d262d32b97e7e07d97390d9e425ffe5e"
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
SOURCES=(
  "https://mirror.arizona.edu/archlinux/iso/latest/$ISO"
  "https://arch.mirror.gws.fc.com/archlinux/iso/latest/$ISO"
  "https://mirror.math.princeton.edu/pub/archlinux/iso/latest/$ISO"
)
ok=""
for url in "${SOURCES[@]}"; do
  echo "=== [$(date -u +%FT%TZ)] trying: $url"
  curl -4 -fSL --retry 5 --retry-delay 10 --retry-connrefused \
       --max-time 3600 -A "$UA" "$url" -o "$ISO.part"
  rc=$?
  if [ $rc -eq 0 ] && [ -s "$ISO.part" ]; then
    sz=$(stat -c%s "$ISO.part")
    echo "download ok rc=$rc size=$sz"
    if [ "$sz" -lt 1000000000 ]; then
      echo "size too small ($sz), not a full ISO; continuing to next source"
      continue
    fi
    mv "$ISO.part" "$ISO"
    ok="$url"
    break
  fi
  echo "attempt failed rc=$rc, sleeping 15s"
  sleep 15
done
if [ -z "$ok" ]; then
  echo "=== ALL DOWNLOAD SOURCES FAILED ==="
  exit 1
fi
echo "=== downloaded from: $ok ==="
echo "=== SHA256 verify (expected $EXPECTED) ==="
actual=$(sha256sum "$ISO" | awk '{print $1}')
echo "actual: $actual"
if [ "$actual" = "$EXPECTED" ]; then
  echo "SHA256 VERIFY: PASS"
  echo "=== GPG verify (.sig, key imported earlier) ==="
  if gpg --verify "$ISO.sig" "$ISO" 2>gpg-verify.err; then
    echo "GPG VERIFY: PASS"
    echo "=== ISO DOWNLOAD + VERIFY: SUCCESS ==="
  else
    echo "GPG VERIFY: FAIL (see gpg-verify.err)"
    cat gpg-verify.err
  fi
else
  echo "SHA256 VERIFY: FAIL"
  exit 1
fi
