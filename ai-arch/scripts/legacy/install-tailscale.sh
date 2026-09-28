#!/bin/bash
# AI-Arch: install Tailscale in the VM (owner remote access).
# Run as root:  /root/install-tailscale.sh
# The node joins the tailnet with an auth key; if no key is provided,
# print the magiclink URL for one-time owner approval.
set -e

if ! command -v tailscaled >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi

systemctl enable tailscaled
systemctl restart tailscaled

TS_AUTH_KEY="${TAILSCALE_AUTH_KEY:-}"
if [ -n "$TS_AUTH_KEY" ]; then
  tailscale up --auth-key="$TS_AUTH_KEY" --hostname=ai-arch-dev --accept-routes=false --advertise-tags=
else
  # No key: print the login URL for the owner to approve (one-time).
  # Valid ~4 minutes.
  tailscale up --hostname=ai-arch-dev
  sleep 5
fi

echo "--- tailscale status ---"
tailscale status
echo "TUNNEL_SETUP_DONE"
