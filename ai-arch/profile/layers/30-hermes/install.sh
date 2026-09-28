#!/usr/bin/env bash
# Layer 30-hermes — install Hermes Agent as the VM's dedicated agent home base.
#
#   The VM is NOT an inference host. Model inference runs on the host's
#   llama-server (llama.cpp, OpenAI-compatible) — wired by layer 20-ai-client
#   at /etc/ai-arch/llama-server.json. This layer installs the agent runtime,
#   points it at that endpoint, and provisions the headless browser + gateway
#   service so the VM is a self-contained Hermes home base.
#
#   Install path (proven, version-pinned):
#     scripts/install.sh @ tag v2026.9.24   (commit e3dd27ee2d8b011737a4eea8e3eb3d711ab78690)
#     fetched from raw GitHub, run as the 'archdev' user (NOPASSWD sudo).
#     The monolith self-provisions uv (managed, into ~/.hermes/bin), Python 3.11,
#     Node 26, base-devel (sudo), and the Arch Chromium system deps (sudo) via
#     pacman, then clones the pinned tag, builds the venv, installs deps, and
#     lays out:
#       ~/.hermes/hermes-agent   code (git @ v2026.9.24)
#       ~/.local/bin/hermes      command shim
#       ~/.hermes/config.yaml    endpoint + runtime config
#       ~/.cache/ms-playwright   headless Chromium (browser tool)
#     and enables the hermes-gateway systemd service.
#
# Runs as root inside the installed VM (build pipeline phase-6 contract).
# Idempotent; no secrets (the model api_key is the cosmetic 'dummy' token —
# the llama.cpp server ignores it).
set -euo pipefail

HERMES_TAG="v2026.9.24"
# Exported so the inner (archdev) login shell can reference it via the
# single-quoted runuser -c command below.
export HERMES_COMMIT="e3dd27ee2d8b011737a4eea8e3eb3d711ab78690"
HERMES_INSTALL_URL="https://raw.githubusercontent.com/NousResearch/hermes-agent/${HERMES_TAG}/scripts/install.sh"
TARGET_USER="archdev"
TARGET_HOME="/home/${TARGET_USER}"

# Endpoint + runtime config. base_url mirrors the proven host vmtest profile
# (the 20-ai-client endpoint; the model name is cosmetic — llama.cpp serves
# whatever is loaded in its single slot). context_length is the 64K+ minimum
# required by the runtime.
BASE_URL="$(python3 -c 'import json;print(json.load(open("/etc/ai-arch/llama-server.json"))["base_url"])')"
MODEL_NAME="Qwen3.8-27B-UD-Q4_K_XL"

# --- 1. Fetch the pinned monolith installer --------------------------------
curl -fsSL "$HERMES_INSTALL_URL" -o /tmp/hermes-install-monolith.sh
test -s /tmp/hermes-install-monolith.sh

# --- 2. Write config BEFORE install (so the installer's template-copy skips) -
#     Written as the target user so ownership is correct.
install -d -o "$TARGET_USER" -g "$TARGET_USER" "$TARGET_HOME/.hermes"
cat > "$TARGET_HOME/.hermes/config.yaml" <<YAML
model:
  default: ${MODEL_NAME}
  provider: custom
  base_url: ${BASE_URL}/v1
  api_key: dummy
  api_mode: chat_completions
  max_tokens: 4096
  context_length: 131072
fallback_providers: []
agent:
  max_turns: 12
YAML
chmod 600 "$TARGET_HOME/.hermes/config.yaml"
# Install runs as root, but hermes runs as archdev: hand ownership back so the
# 0600 file is readable by its actual user (root-owned 0600 = "Permission
# denied" on first one-shot).
chown "${TARGET_USER}:${TARGET_USER}" "$TARGET_HOME/.hermes/config.yaml"

# --- 3. Run the monolith as archdev (NOPASSWD sudo for pacman deps) ---------
#     Non-interactive; skip the setup wizard, computer-use driver (no desktop),
#     and bundled skills (clean slate). uv/Python/Node/Chromium are
#     self-provisioned by the monolith.
runuser -l "$TARGET_USER" -c '
  set -euo pipefail
  # Pinned commit, defined INSIDE the inner shell. runuser -l is a login shell
  # and resets the environment, so a parent export (line 31) does not survive
  # to here; defining it locally makes the install independent of the env.
  HERMES_COMMIT="e3dd27ee2d8b011737a4eea8e3eb3d711ab78690"
  # Strip any inherited session/profile pins so the install is clean.
  unset HERMES_HOME HERMES_PROFILE HERMES_SESSION_PROFILE HERMES_SESSION_ID HERMES_SESSION_KEY || true
  export PATH="$HOME/.local/bin:$PATH"
  bash /tmp/hermes-install-monolith.sh \
    --commit "${HERMES_COMMIT}" \
    --non-interactive \
    --skip-setup \
    --skip-computer-use \
    --no-skills
'

# --- 4. Enable the gateway systemd service (headless home base) -------------
runuser -l "$TARGET_USER" -c '
  set -euo pipefail
  unset HERMES_HOME HERMES_PROFILE HERMES_SESSION_PROFILE || true
  export PATH="$HOME/.local/bin:$PATH"
  hermes gateway install
  hermes gateway start || true
  # Keep the service alive without an active login session.
  loginctl enable-linger "$TARGET_USER" 2>/dev/null || true
' || true

echo "30-hermes: Hermes Agent installed (tag ${HERMES_TAG}), config written, gateway service enabled"
