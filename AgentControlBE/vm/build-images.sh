#!/usr/bin/env bash
# BE-P2-3: build and tag the shared bot images (plan §2.2):
#   localhost/agentcontrol/botvm:<BOTVM_VERSION>          (~250 MB)
#   localhost/agentcontrol/botvm-browser:<BOTVM_VERSION>  (~1.1 GB, FROM botvm)
# Versions come from vm/images/versions.env. Nothing is pushed anywhere.
#
# Usage: vm/build-images.sh [--engine podman|docker] [--only botvm|botvm-browser] [--connection NAME] [--dry-run]
#   --connection: podman --connection (e.g. the agentcontrol machine on Mac/Windows).
#   --dry-run:    print the commands instead of running them (used by the tests).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
engine="podman"
only=""
connection=""
dry_run=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --engine) engine="${2:?--engine needs podman or docker}"; shift 2 ;;
    --only) only="${2:?--only needs botvm or botvm-browser}"; shift 2 ;;
    --connection) connection="${2:?--connection needs a name}"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

case "$engine" in podman|docker) ;; *) echo "engine must be podman or docker" >&2; exit 2 ;; esac
case "$only" in ""|botvm|botvm-browser) ;; *) echo "--only must be botvm or botvm-browser" >&2; exit 2 ;; esac
if [[ -n "$connection" && "$engine" != "podman" ]]; then echo "--connection needs --engine podman" >&2; exit 2; fi
if [[ "$connection" == "podman-machine-default" ]]; then echo "refusing podman-machine-default; AgentControl uses its own machine" >&2; exit 2; fi

# shellcheck source=images/versions.env
set -a; source "$here/images/versions.env"; set +a

registry="localhost/agentcontrol"
base_ref="$registry/botvm:$BOTVM_VERSION"
browser_ref="$registry/botvm-browser:$BOTVM_VERSION"

cmd=("$engine")
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

# Smoke check (§14 BE-P2-3 acceptance): python3, node (and chromium) run as uid 1000.
smoke() {
  local ref="$1"; shift
  run "${cmd[@]}" run --rm --network none --read-only --tmpfs /tmp:rw,size=512m --shm-size 512m --cap-drop ALL --security-opt no-new-privileges "$ref" \
    bash -c 'test "$(id -u)" = 1000 && python3 --version && node --version'"$*"
}

if [[ -z "$only" || "$only" == "botvm" ]]; then
  build_base
  smoke "$base_ref"
fi
if [[ -z "$only" || "$only" == "botvm-browser" ]]; then
  build_browser
  smoke "$browser_ref" ' && python3 -c "from playwright.sync_api import sync_playwright as p; b=p().start().chromium.launch(args=[\"--no-sandbox\"]); print(b.version); b.close()"'
fi
