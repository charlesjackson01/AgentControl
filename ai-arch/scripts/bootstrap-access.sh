#!/bin/bash
# One-time access bootstrap for the installed AI-Arch VM.
# Usage (run as root inside VM):  bash bootstrap-access.sh /tmp/ai-arch-owner.pub
# Adds owner pubkey to root + grants archdev passwordless sudo.
set -e
PUBKEY_FILE="${1:?path to owner pubkey file (inside VM)}"

# 1) root authorized_keys
mkdir -p /root/.ssh
chmod 700 /root/.ssh
umask 077
cp "$PUBKEY_FILE" /root/.ssh/authorized_keys
chown -R 0:0 /root/.ssh
chmod 600 /root/.ssh/authorized_keys

# 2) archdev passwordless sudo
printf 'archdev ALL=(ALL) NOPASSWD: ALL\n' > /etc/sudoers.d/archdev
chmod 440 /etc/sudoers.d/archdev
chown 0:0 /etc/sudoers.d/archdev

# 3) cleanup + verify
rm -f "$PUBKEY_FILE"
echo "--- root .ssh ---"; ls -la /root/.ssh
echo "--- sudoers.d ---"; ls -la /etc/sudoers.d
echo "--- root authorized key fingerprint ---"
ssh-keygen -lf /root/.ssh/authorized_keys
echo "BOOTSTRAP_DONE"
