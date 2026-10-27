#!/bin/sh
# BE-P2-3: make a bare Playwright `chromium.launch()` (no `channel`) work in botvm-browser.
# Playwright's default headless Chromium is the headless shell, which this image does not
# install (`--no-shell`). Point the path Playwright looks for,
#   $PLAYWRIGHT_BROWSERS_PATH/chromium_headless_shell-<rev>/chrome-headless-shell-linux*/chrome-headless-shell,
# at the full Chromium binary. Playwright passes plain `--headless`, which full Chromium
# (>= 132) runs as the new headless mode, so a bare launch and `channel: 'chromium'` start
# the same binary the same way. Revisions come from both Playwright drivers (Python and Node)
# and must agree. Runs as root at build time; fails the build if anything is off.
set -eu
root="${PLAYWRIGHT_BROWSERS_PATH:?PLAYWRIGHT_BROWSERS_PATH is not set}"
py_json="$(python3 -c 'import os, playwright; print(os.path.join(os.path.dirname(playwright.__file__), "driver", "package", "browsers.json"))')"
node_json=/usr/local/lib/node_modules/playwright/node_modules/playwright-core/browsers.json
rev() { python3 -c 'import json, sys; print(next(b["revision"] for b in json.load(open(sys.argv[1]))["browsers"] if b["name"] == sys.argv[2]))' "$1" "$2"; }
full_rev="$(rev "$py_json" chromium)"
shell_rev="$(rev "$py_json" chromium-headless-shell)"
if [ "$(rev "$node_json" chromium)" != "$full_rev" ] || [ "$(rev "$node_json" chromium-headless-shell)" != "$shell_rev" ]; then
  echo "Python and Node Playwright disagree on Chromium revisions" >&2; exit 1
fi
case "$(uname -m)" in
  x86_64) full_dir=chrome-linux64; shell_dir=chrome-headless-shell-linux64 ;;
  aarch64|arm64) full_dir=chrome-linux-arm64; shell_dir=chrome-headless-shell-linux-arm64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
full="$root/chromium-$full_rev/$full_dir/chrome"
[ -x "$full" ] || { echo "full Chromium not found at $full" >&2; exit 1; }
dest="$root/chromium_headless_shell-$shell_rev"
[ ! -e "$dest" ] || { echo "$dest already exists (was the headless shell installed?)" >&2; exit 1; }
mkdir -p "$dest/$shell_dir"
# Relative, so it stays valid wherever the browsers dir is mounted.
ln -s "../../chromium-$full_rev/$full_dir/chrome" "$dest/$shell_dir/chrome-headless-shell"
# Same markers `playwright install` leaves: installed, host dependencies checked (the full
# Chromium's, installed with --with-deps). Playwright re-checks deps after 30 days and
# ignores that it cannot rewrite the marker on the read-only rootfs.
touch "$dest/INSTALLATION_COMPLETE" "$dest/DEPENDENCIES_VALIDATED"
[ "$(readlink -f "$dest/$shell_dir/chrome-headless-shell")" = "$(readlink -f "$full")" ]
echo "$dest/$shell_dir/chrome-headless-shell -> $full"
