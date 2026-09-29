#!/bin/bash
OUT=/home/charlesjackson/ai-arch/recon/probe9-access-path.txt
mkdir -p "$(dirname "$OUT")"
{
echo "=== host LAN IPs ==="
ip -4 -brief addr show 2>&1
echo
echo "=== tailscale status (host) ==="
tailscale status 2>&1 | head -25
echo
echo "=== host firewall ==="
sudo ufw status verbose 2>&1 | head -15
echo "--- nftables summary ---"
sudo nft list ruleset 2>&1 | head -40
echo
echo "=== listening TCP ports (host, relevant) ==="
ss -tlnp 2>&1 | grep -E ":(22|2222|2376|8080)\b" || echo "(none of 22/2222/2376/8080 listening)"
echo
echo "=== libvirt default network detail ==="
sudo virsh net-dumpxml default 2>&1
echo
echo "=== host sshd config (allow password? root?) ==="
grep -E "^(PermitRootLogin|PasswordAuthentication|PubkeyAuthentication|Port)" /etc/ssh/sshd_config 2>&1 || echo "(no explicit settings — defaults)"
echo
echo "=== host user ==="
whoami
id
echo
echo "=== done ==="
} 2>&1 | tee "$OUT"
tail -1 "$OUT"
