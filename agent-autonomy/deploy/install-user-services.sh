#!/usr/bin/env bash
# Run OpenCode and the AgentControl dashboard as systemd *user* services: they start at boot
# (with lingering enabled) and restart on failure. Never runs sudo; prints the one sudo command
# that start-at-boot-without-login needs.
#
#   agent-autonomy/deploy/install-user-services.sh --project ~/myproject      install or update
#   ... --dry-run          show every action without doing it
#   ... --uninstall        stop and remove the services (keeps your settings file and run history)
# Options: --host ADDR (default: your Tailscale IPv4, else 127.0.0.1), --opencode-port N (45381),
#          --no-check (skip the connection check before the dashboard starts)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
UNITS="$HOME/.config/systemd/user"
CONFIG_DIR="$HOME/.config/agentcontrol"
ENV_FILE="$CONFIG_DIR/agentcontrol.env"
PROJECT="" HOST="" OC_PORT=45381 DRY=0 UNINSTALL=0 CHECK=1

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --opencode-port) OC_PORT="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --no-check) CHECK=0; shift ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

run() { echo "+ $*"; [ "$DRY" = 1 ] || "$@"; }

if [ "$UNINSTALL" = 1 ]; then
  run systemctl --user disable --now agentcontrol.service agentcontrol-opencode.service || true
  run rm -f "$UNITS/agentcontrol.service" "$UNITS/agentcontrol-opencode.service"
  run systemctl --user daemon-reload
  echo "Removed the services. Kept $ENV_FILE and the run history in $REPO/agent-autonomy/state."
  exit 0
fi

PYTHON="$(command -v python3 || true)"
[ -n "$PYTHON" ] || { echo "python3 was not found." >&2; exit 1; }
"$PYTHON" -c 'import sys; sys.exit(sys.version_info < (3, 10))' || { echo "AgentControl needs Python 3.10 or newer." >&2; exit 1; }
OPENCODE="$(command -v opencode || true)"
[ -n "$OPENCODE" ] || { echo "opencode was not found on PATH. Install it or add its folder to PATH, then run this again." >&2; exit 1; }
OPENCODE="$(readlink -f "$OPENCODE")"

render() {  # render TEMPLATE DEST: replace @NAME@ with the values below
  local template="$1" dest="$2"
  echo "+ write $dest"
  [ "$DRY" = 1 ] && return 0
  mkdir -p "$(dirname "$dest")"
  R_PROJECT="$PROJECT" R_REPO="$REPO" R_PYTHON="$PYTHON" R_OPENCODE="$OPENCODE" R_OC_PORT="$OC_PORT" \
  R_HOST="$HOST" R_PATH="$PATH" R_VM_ARGS="${VM_ARGS:-}" "$PYTHON" - "$template" "$dest" <<'PY'
import os, sys
text = open(sys.argv[1]).read()
for key, value in os.environ.items():
    if key.startswith('R_'):
        text = text.replace('@' + key[2:] + '@', value)
open(sys.argv[2], 'w').write(text)
PY
}

if [ -f "$ENV_FILE" ]; then
  echo "Keeping your settings in $ENV_FILE"
else
  [ -n "$PROJECT" ] || { echo "First install: say which project to work on, with --project /path/to/project" >&2; exit 2; }
  PROJECT="$(cd "$PROJECT" && pwd)"
  if [ -z "$HOST" ]; then
    HOST="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
    HOST="${HOST:-127.0.0.1}"
  fi
  VM_ARGS=""
  BASELINE="$HOME/ai-arch/vms/ai-arch-baseline-with-tailscale.qcow2"
  [ -f "$BASELINE" ] && VM_ARGS=" --vm-baseline $BASELINE"
  render "$HERE/agentcontrol.env.example" "$ENV_FILE"
  [ "$DRY" = 1 ] || chmod 600 "$ENV_FILE"
fi
if [ -z "$PROJECT" ]; then   # updating: take the project from the settings file
  PROJECT="$(sed -n 's/.*--project \([^ "]*\).*/\1/p' "$ENV_FILE" | head -n1)"
fi

render "$HERE/agentcontrol-opencode.service" "$UNITS/agentcontrol-opencode.service"
render "$HERE/agentcontrol.service" "$UNITS/agentcontrol.service"
run systemctl --user daemon-reload
run systemctl --user enable --now agentcontrol-opencode.service

if [ "$CHECK" = 1 ] && [ "$DRY" = 0 ]; then
  echo "Waiting for OpenCode on 127.0.0.1:$OC_PORT ..."
  for _ in $(seq 1 30); do
    "$PYTHON" -c "import socket,sys; socket.create_connection(('127.0.0.1', $OC_PORT), 1)" 2>/dev/null && break
    sleep 1
  done
  set -a; . "$ENV_FILE"; set +a
  echo "+ app.py --doctor"
  # shellcheck disable=SC2086  # the flags are meant to split, as systemd splits them
  if ! OUT="$("$PYTHON" "$REPO/agent-autonomy/app.py" $AGENTCONTROL_ARGS --doctor 2>&1)"; then
    echo "$OUT"
    if grep -q 'Another controller is running' <<<"$OUT"; then
      echo "A dashboard is still running from a terminal. Stop it (Ctrl+C there), then run this again." >&2
      exit 1
    fi
    echo "The connection check found problems (above). The dashboard starts anyway and shows them."
  else
    echo "Connection check passed."
  fi
fi

run systemctl --user enable --now agentcontrol.service

KEY="$REPO/agent-autonomy/state/dashboard.key"
echo
echo "AgentControl runs as a service."
echo "  Dashboard key:  cat $KEY"
echo "  Status:         systemctl --user status agentcontrol agentcontrol-opencode"
echo "  Logs:           journalctl --user -u agentcontrol -f"
echo "  Settings:       $ENV_FILE  (then: systemctl --user restart agentcontrol)"
if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo no)" != "yes" ]; then
  echo
  echo "To start at boot without logging in, run once:  sudo loginctl enable-linger $USER"
fi
