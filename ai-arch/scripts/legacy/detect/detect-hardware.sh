#!/usr/bin/env bash
# ============================================================================
# AI-Arch Phase 0 — System & Hardware Detection
#
# STRICTLY READ-ONLY.
# - Installs nothing, changes no configuration, touches no running service.
# - Never reads secret files (presence/stat only).
# - Output is written to ~/ai-arch/state/ as raw evidence for the reports.
#
# Usage: bash detect-hardware.sh
# ============================================================================
set -u

H="${HOME:-/home/charlesjackson}"
OUT="$H/ai-arch/state"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"

SUDO=""
if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  SUDO="sudo"
fi

F_SYSTEM="$OUT/01-system-$TS.txt"
F_STORAGE="$OUT/02-storage-gpu-net-$TS.txt"
F_SERVICES="$OUT/03-services-containers-$TS.txt"
F_TOOLCHAIN="$OUT/04-toolchain-python-models-$TS.txt"

# ---------------------------------------------------------------------------
# 01 — OS, kernel, virtualization, CPU, memory, sessions
# ---------------------------------------------------------------------------
{
  echo "AI-ARCH PHASE 0 RECON — generated $TS (UTC) — READ-ONLY AUDIT"
  echo "SUDO (passwordless): ${SUDO:-unavailable}"
  echo
  echo "===== DATE / UPTIME ====="
  date -u
  uptime
  echo
  echo "===== UNAME ====="
  uname -a
  echo
  echo "===== OS-RELEASE ====="
  cat /etc/os-release 2>&1
  echo
  echo "===== ARCH-LINUX CHECK ====="
  ls -la /etc/arch-release 2>&1
  echo
  echo "===== ID ====="
  id
  echo
  echo "===== VIRTUALIZATION ====="
  systemd-detect-virt; echo "systemd-detect-virt exit=$?"
  if [ -e /.dockerenv ]; then echo "/.dockerenv PRESENT (containerized)"; else echo "/.dockerenv absent"; fi
  echo
  echo "===== DMI ====="
  for f in sys_vendor product_name product_version board_name bios_vendor bios_version chassis_type; do
    v="$(cat /sys/class/dmi/id/$f 2>/dev/null)" && printf '%s: %s\n' "$f" "$v"
  done
  echo
  echo "===== CPU (lscpu) ====="
  lscpu 2>&1
  echo
  echo "===== CPU FEATURES (relevant to AI) ====="
  grep -m1 'model name' /proc/cpuinfo
  grep -m1 flags /proc/cpuinfo | tr ' ' '\n' | grep -E '^(avx2?|avx512[a-z]*|fma|f16c|bmi1|bmi2|vaes|vpclmulqdq|amx[a-z]*)$' | sort -u | tr '\n' ' '
  echo
  nproc
  echo
  echo "===== MEMORY ====="
  free -h
  echo
  echo "===== ACTIVE SESSIONS ====="
  who
  echo
  echo "===== TMUX SESSIONS ====="
  tmux ls 2>&1
} > "$F_SYSTEM" 2>&1

# ---------------------------------------------------------------------------
# 02 — Storage, disks, GPU, network
# ---------------------------------------------------------------------------
{
  echo "===== DISK USAGE ====="
  df -h
  echo
  echo "===== BLOCK DEVICES ====="
  lsblk 2>&1
  echo
  echo "===== MOUNTS (key) ====="
  findmnt -n -o TARGET,FSTYPE,SIZE,USED 2>&1 | head -30
  echo
  echo "===== AI RELEVANT STORAGE SIZES (du, may take a moment) ====="
  du -sh "$H/models" 2>/dev/null
  du -sh "$H/.cache/huggingface" 2>/dev/null
  du -sh "$H/.cache/llama.cpp" 2>/dev/null
  du -sh "$H/llama.cpp" 2>/dev/null
  du -sh /data 2>/dev/null
  echo
  echo "===== DOCKER DISK ====="
  docker system df 2>&1
  echo
  echo "===== /data SUBDIRS ====="
  ls -la /data 2>&1
  echo
  echo "===== PCI: DISPLAY / GPU ====="
  lspci 2>&1 | grep -Ei 'vga|3d|display|nvidia|amd|matrox|cirrus|qxl|virtio'
  echo
  echo "===== PCI: FULL ====="
  lspci 2>&1
  echo
  echo "===== GPU DEVICES ====="
  ls -l /dev/nvidia* 2>&1
  ls -l /dev/dri 2>&1
  echo
  echo "===== NVIDIA-SMI ====="
  nvidia-smi 2>&1
  echo
  echo "===== NVIDIA DRIVER ====="
  cat /proc/driver/nvidia/version 2>&1
  lsmod 2>&1 | grep -Ei 'nvidia|amdgpu' || echo "no GPU kernel modules loaded"
  echo
  echo "===== ROCm ====="
  rocm-smi 2>&1 | head -20 || echo "rocm-smi not available"
  echo
  echo "===== CUDA TOOLKIT ====="
  which nvcc 2>&1
  nvcc --version 2>&1
  ls /usr/local 2>/dev/null | grep -i cuda || echo "no /usr/local/cuda*"
  echo
  echo "===== NETWORK ADDRESSES ====="
  ip -brief addr 2>&1
  echo
  echo "===== NETWORK ROUTES ====="
  ip route 2>&1
} > "$F_STORAGE" 2>&1

# ---------------------------------------------------------------------------
# 03 — systemd, running AI services, containers
# ---------------------------------------------------------------------------
{
  echo "===== SYSTEMD VERSION ====="
  systemctl --version 2>&1 | head -1
  echo
  echo "===== FAILED UNITS ====="
  systemctl --failed --no-pager 2>&1
  echo
  echo "===== ENABLED UNIT FILES ====="
  systemctl list-unit-files --state=enabled --no-pager 2>&1
  echo
  echo "===== RUNNING SERVICE COUNT ====="
  systemctl list-units --type=service --state=running --no-pager 2>&1 | wc -l
  echo
  echo "===== /boot ====="
  ls -la /boot 2>&1
  echo
  echo "===== PROCESS TABLE (ps aux) ====="
  ps aux 2>&1
  echo
  echo "===== LLAMA-SERVER FULL COMMAND LINE ====="
  ps -eo pid,user,etime,args 2>/dev/null | grep -E 'llama-server|ollama serve|api_server|streamlit|hermes-webui|http.server' | grep -v grep
  echo
  echo "===== LISTENING SOCKETS (with process owners) ====="
  $SUDO ss -tlnp 2>&1
  echo
  echo "===== LLAMA-SERVER API (model registration) ====="
  curl -s --max-time 5 http://127.0.0.1:8080/v1/models 2>&1 | head -c 2000
  echo
  echo "===== OLLAMA TAGS ====="
  curl -s --max-time 5 http://127.0.0.1:11434/api/tags 2>&1 | head -c 2000
  echo
  echo "===== DOCKER CONTAINERS ====="
  docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' 2>&1
  echo
  echo "===== DOCKER UNHEALTHY ====="
  docker ps --filter health=unhealthy --format '{{.Names}}: {{.Status}}' 2>&1
  echo "(none if empty)"
} > "$F_SERVICES" 2>&1

# ---------------------------------------------------------------------------
# 04 — Toolchains, Python environments, models, security-relevant state
# ---------------------------------------------------------------------------
{
  echo "===== PACKAGE MANAGERS ====="
  for c in apt dpkg zypper dnf pacman; do
    if command -v "$c" >/dev/null 2>&1; then echo "$c: $("$c" --version 2>&1 | head -1)"; else echo "$c: ABSENT"; fi
  done
  echo
  echo "===== DEVELOPMENT TOOLS ====="
  for c in git git-lfs python3 pip uv uvx pipx gcc g++ clang cmake make ninja rustc cargo docker podman buildah jupyter ollama llama-server llama-cli llama-bench vllm tmux htop curl wget ssh; do
    if command -v "$c" >/dev/null 2>&1; then
      printf '%s: ' "$c"
      "$c" --version 2>&1 | head -1
    else
      echo "$c: ABSENT"
    fi
  done
  echo
  echo "===== PYTHON ENVS ====="
  /usr/bin/python3 --version 2>&1
  echo "PATH python: $(command -v python3) ($(python3 --version 2>&1))"
  ls "$H/.hermes/hermes-agent/venv/bin/python"* 2>&1
  echo
  echo "===== PYTHON AI PACKAGES (system) ====="
  /usr/bin/python3 -m pip list 2>/dev/null | grep -Ei '^(torch|torchaudio|torchvision|transformers|datasets|accelerate|peft|safetensors|sentence-transformers|vllm|llama|jupyter|ipykernel|streamlit|fastapi|uvicorn|httpx|openai|anthropic|grpcio|numpy|scipy|pandas|scikit-learn|onnxruntime|bitsandbytes|flash|deepspeed)' || echo "(none matched)"
  echo
  echo "===== PYTHON AI PACKAGES (hermes venv) ====="
  "$H/.hermes/hermes-agent/venv/bin/python" -m pip list 2>/dev/null | grep -Ei '^(torch|transformers|vllm|llama|jupyter|streamlit|fastapi|uvicorn|httpx|openai|anthropic|numpy|scipy|pandas|scikit-learn)' || echo "(none matched)"
  echo
  echo "===== TORCH CUDA CHECK (system python) ====="
  /usr/bin/python3 -c "import torch; print('torch', torch.__version__, 'cuda_available:', torch.cuda.is_available(), 'device_count:', torch.cuda.device_count())" 2>&1 | head -5
  echo
  echo "===== JUPYTER ====="
  which jupyter jupyter-notebook jupyter-lab 2>&1
  echo
  echo "===== MODEL STORE: ~/models ====="
  ls -lah "$H/models" 2>&1
  echo
  echo "===== MODEL STORE OWNERSHIP ANOMALIES ====="
  find "$H/models" -maxdepth 1 -not -user "$USER" -ls 2>&1
  echo
  echo "===== LLAMA.CPP CACHE ====="
  ls -lah "$H/.cache/llama.cpp" 2>&1
  echo
  echo "===== LLAMA.CPP BUILD ====="
  ls -lah "$H/llama.cpp/build/bin" 2>&1 | head -15
  echo
  echo "===== HF HUB CACHE (top-level) ====="
  du -sh "$H/.cache/huggingface/hub"/* 2>/dev/null | sort -rh | head -20
  echo
  echo "===== /data/jwt (PRESENCE ONLY — CONTENT NEVER READ) ====="
  stat /data/jwt 2>&1
  echo
  echo "===== SSH DIR (filenames only) ====="
  ls -la "$H/.ssh" 2>&1
  echo
  echo "===== SUDO PRIVILEGES ====="
  $SUDO -ln 2>&1 | head -10
} > "$F_TOOLCHAIN" 2>&1

echo "Recon complete. Files written:"
ls -la "$OUT"/0*-"$TS".txt
