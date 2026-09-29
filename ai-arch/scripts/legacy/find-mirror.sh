#!/bin/bash
# Find an official Arch mirror that is actually reachable from this host.
# Prints one line per mirror: RESOLVE/CONN status + HTTP code for the ISO.
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
ISO="archlinux-2026.08.01-x86_64.iso"
MIRRORS="
mirror.arizona.edu
arch.mirror.gws.fc.com
mirror.math.princeton.edu
mirror.23mz.com
arch.mirror.constant.com
mirror.misaka.one
mirror.kodcloud.com
mirror.frasr.at
mirror.netzwerk-muenchen.de
ftp.stu.edu
mirror.27c3.org
archlinux.mirrors.uk2.net
mirror.de.leaseweb.com
mirror.ox.ac.uk
archmirror.clueless.net
mirrors.sonic.net
mirror.novage.com
arch.mirror.futur.fi
mirror.jakumo.be
mirror.pitod.gift
"
for m in $MIRRORS; do
  ip=$(getent hosts "$m" 2>/dev/null | awk '{print $1}' | head -1)
  if [ -z "$ip" ]; then
    printf "%-30s NO-DNS\n" "$m"; continue
  fi
  code=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 6 --max-time 12 -A "$UA" \
    "https://$m/archlinux/iso/latest/$ISO" 2>/dev/null)
  printf "%-30s ip=%-18s http=%s\n" "$m" "$ip" "${code:-ERR}"
done
echo "=== archlinux.org/iso direct, several UA/http variants ==="
for variant in "http1.1" "http2"; do
  :
done
curl -s -o /dev/null -w "archlinux.org http1.1 code=%{http_code}\n" --connect-timeout 6 --max-time 15 -A "$UA" "https://archlinux.org/iso/$ISO" 2>&1
curl -s -o /dev/null -w "archlinux.org releng code=%{http_code}\n" --connect-timeout 6 --max-time 15 -A "$UA" "https://archlinux.org/releng/releases/2026.08.01/$ISO" 2>&1
curl -s -o /dev/null -w "geo.mirror.pkgbuild.com code=%{http_code}\n" --connect-timeout 8 --max-time 15 -A "$UA" "https://geo.mirror.pkgbuild.com/archlinux/iso/latest/$ISO" 2>&1
