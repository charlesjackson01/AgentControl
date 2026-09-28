#!/usr/bin/env bash
# Layer 10-devtools — core dev toolchain (Arch official repos).
# Runs as root inside the installed VM. Idempotent; no secrets.
# Arch is rolling-release: versions track the mirror; versions first
# applied are recorded in the benchmark/smoke reports.
set -euo pipefail

pacman --noconfirm -S --needed rust python python-pip cmake gcc make
