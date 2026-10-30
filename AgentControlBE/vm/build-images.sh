#!/usr/bin/env bash
# BE-P2-3: build and tag the shared bot images (plan §2.2):
#   localhost/agentcontrol/botvm:<BOTVM_VERSION>          (~431 MB)
#   localhost/agentcontrol/botvm-browser:<BOTVM_VERSION>  (~1.34 GB, FROM botvm; full Chromium; the headless-shell path is a link to it)
#   localhost/agentcontrol/egressd-nft:<BOTVM_VERSION>    (FROM botvm + nftables: the egress proxy's firewall helper, BE-P2-13)
# Versions come from vm/images/versions.env. Nothing is pushed anywhere.
#
# Usage: vm/build-images.sh [--engine podman|docker] [--only botvm|botvm-browser|egressd-nft] [--connection NAME]
#                           [--podman-arg ARG]... [--dry-run]
#   --connection: podman --connection (e.g. the agentcontrol machine on Mac/Windows).
#   --podman-arg: extra global podman option, repeatable (e.g. --podman-arg --root=/x).
#                 PODMAN_ARGS (whitespace-separated) is read first; both go before the subcommand.
#   --dry-run:    print the commands instead of running them (used by the tests).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
engine="podman"
only=""
connection=""
dry_run=0
podman_args=()
if [[ -n "${PODMAN_ARGS:-}" ]]; then read -r -a podman_args <<<"$PODMAN_ARGS"; fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --engine) engine="${2:?--engine needs podman or docker}"; shift 2 ;;
    --only) only="${2:?--only needs botvm, botvm-browser or egressd-nft}"; shift 2 ;;
    --connection) connection="${2:?--connection needs a name}"; shift 2 ;;
    --podman-arg) podman_args+=("${2:?--podman-arg needs a value}"); shift 2 ;;
    --podman-arg=*) podman_args+=("${1#--podman-arg=}"); shift ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

case "$engine" in podman|docker) ;; *) echo "engine must be podman or docker" >&2; exit 2 ;; esac
case "$only" in ""|botvm|botvm-browser|egressd-nft) ;; *) echo "--only must be botvm, botvm-browser or egressd-nft" >&2; exit 2 ;; esac
if [[ -n "$connection" && "$engine" != "podman" ]]; then echo "--connection needs --engine podman" >&2; exit 2; fi
if [[ ${#podman_args[@]} -gt 0 && "$engine" != "podman" ]]; then echo "--podman-arg/PODMAN_ARGS need --engine podman" >&2; exit 2; fi
if [[ "$connection" == "podman-machine-default" ]]; then echo "refusing podman-machine-default; AgentControl uses its own machine" >&2; exit 2; fi

# shellcheck source=images/versions.env
set -a; source "$here/images/versions.env"; set +a

registry="localhost/agentcontrol"
base_ref="$registry/botvm:$BOTVM_VERSION"
browser_ref="$registry/botvm-browser:$BOTVM_VERSION"
nft_ref="$registry/egressd-nft:$BOTVM_VERSION"

cmd=("$engine")
[[ ${#podman_args[@]} -gt 0 ]] && cmd+=("${podman_args[@]}")
[[ -n "$connection" ]] && cmd+=(--connection "$connection")

run() {
  if [[ $dry_run -eq 1 ]]; then local out; out="$(printf '%q ' "$@")"; printf '%s\n' "${out% }"; else "$@"; fi
}

build_base() {
  run "${cmd[@]}" build \
    --file "$here/images/botvm/Containerfile" \
    --tag "$base_ref" \
    --build-arg "BASE_IMAGE=$BASE_IMAGE" \
    --build-arg "BOTVM_VERSION=$BOTVM_VERSION" \
    --build-arg "PYTHON_VERSION=$PYTHON_VERSION" \
    --build-arg "NODE_VERSION=$NODE_VERSION" \
    --build-arg "NODE_SHA256_X64=$NODE_SHA256_X64" \
    --build-arg "NODE_SHA256_ARM64=$NODE_SHA256_ARM64" \
    "$here/images/botvm"
}

build_browser() {
  run "${cmd[@]}" build \
    --file "$here/images/botvm-browser/Containerfile" \
    --tag "$browser_ref" \
    --build-arg "BOTVM_IMAGE=$base_ref" \
    --build-arg "BOTVM_VERSION=$BOTVM_VERSION" \
    --build-arg "PLAYWRIGHT_VERSION=$PLAYWRIGHT_VERSION" \
    "$here/images/botvm-browser"
}

build_nft() {
  run "${cmd[@]}" build \
    --file "$here/images/egressd-nft/Containerfile" \
    --tag "$nft_ref" \
    --build-arg "BOTVM_IMAGE=$base_ref" \
    --build-arg "BOTVM_VERSION=$BOTVM_VERSION" \
    "$here/images/egressd-nft"
}

# Smoke check (§14 BE-P2-3 acceptance): python3, node (and chromium) run as uid 1000.
# The browser smoke checks the headless-shell path is only a link to full Chromium (no
# headless shell installed), then, from Python and from Node, launches headless both bare
# (`chromium.launch()`, what bot-written scripts do) and with channel 'chromium' + --no-sandbox
# (the recommended launch), loads a data:/about:blank page and requires a HeadlessChrome UA.
smoke() {
  local ref="$1"; shift
  run "${cmd[@]}" run --rm --network none --read-only --tmpfs /tmp:rw,size=512m --shm-size 512m --cap-drop ALL --security-opt no-new-privileges "$ref" \
    bash -c 'test "$(id -u)" = 1000 && python3 --version && node --version'"$*"
}

# No single quotes inside these: they go in single quotes in the smoke's bash -c.
browser_py='from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    for name, kw in (("bare", {}), ("channel", {"channel": "chromium", "headless": True, "args": ["--no-sandbox"]})):
        b = p.chromium.launch(**kw)
        pg = b.new_page()
        pg.goto("data:text/html,<title>ok</title>")
        ua = pg.evaluate("navigator.userAgent")
        assert pg.title() == "ok" and "HeadlessChrome/" in ua, ua
        print("python", name, b.version, "HeadlessChrome")
        b.close()'
browser_js='const { chromium } = require("playwright");
(async () => {
  for (const [name, kw] of [["bare", {}], ["channel", { channel: "chromium", headless: true, args: ["--no-sandbox"] }]]) {
    const b = await chromium.launch(kw);
    const pg = await b.newPage();
    await pg.goto("about:blank");
    const ua = await pg.evaluate(() => navigator.userAgent);
    if (!ua.includes("HeadlessChrome/")) throw new Error(ua);
    console.log("node", name, b.version(), "HeadlessChrome");
    await b.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });'
browser_smoke=" && h=\$(ls /opt/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux*/chrome-headless-shell) && f=\$(ls /opt/ms-playwright/chromium-*/chrome-linux*/chrome) && test -L \"\$h\" && test \"\$(readlink -f \"\$h\")\" = \"\$(readlink -f \"\$f\")\" && echo \"headless shell: link to \$f\" && python3 -c '$browser_py' && node -e '$browser_js'"

if [[ -z "$only" || "$only" == "botvm" ]]; then
  build_base
  smoke "$base_ref"
fi
if [[ -z "$only" || "$only" == "botvm-browser" ]]; then
  build_browser
  smoke "$browser_ref" "$browser_smoke"
fi
if [[ -z "$only" || "$only" == "egressd-nft" ]]; then
  build_nft
  # nft runs (no capabilities needed to print its version; AgentControl adds NET_ADMIN only to load rules).
  run "${cmd[@]}" run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint nft "$nft_ref" --version
fi
