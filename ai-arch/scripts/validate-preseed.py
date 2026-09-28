#!/usr/bin/env python3
"""T0 validation: frozen preseed vs archinstall 4.4 parse rules (extracted from ISO source)."""
import json, re, sys, uuid, subprocess

cfg = json.load(open('preseed/archinstall-config.json'))
errors = []

# --- top-level fields valid in 4.4 ArchConfig.from_config ---
VALID_TOP = {'version','script','locale_config','archinstall-language','disk_config',
             'profile_config','mirror_config','network_config','bootloader_config',
             'app_config','auth_config','swap','hostname','kernels','ntp','packages',
             'pacman_config','timezone','services','custom_commands','!root-password','users'}
for k in cfg:
    if k not in VALID_TOP:
        errors.append(f'unknown top-level key: {k}')

# --- locale_config ---
lc = cfg.get('locale_config', {})
assert lc.get('sys_lang') == 'en_US' and lc.get('sys_enc') == 'UTF-8' and lc.get('kb_layout') == 'us', 'locale bad'

# --- network_config: NicType('iso') ---
assert cfg['network_config']['type'] == 'iso', 'nic type bad'

# --- mirror_config: custom_servers[{url}] ---
# Pinned mirror set (2026-08-26): rackspace primary, arizona fallback.
# Order matters: arizona proved flaky (TCP stalls) from the lab network.
_mirror_urls = [s['url'] for s in cfg['mirror_config']['custom_servers']]
assert _mirror_urls[0] == 'https://mirror.rackspace.com/archlinux/$repo/os/$arch', 'primary mirror bad'
assert 'https://mirror.arizona.edu/archlinux/$repo/os/$arch' in _mirror_urls, 'fallback mirror missing'

# --- bootloader_config ---
bc = cfg['bootloader_config']
assert bc['bootloader'] == 'Systemd-boot' and bc['uki'] is False and bc['removable'] is False, 'bootloader bad'

# --- swap: ZramConfiguration {enabled: bool} ---
assert isinstance(cfg['swap']['enabled'], bool) and cfg['swap']['enabled'] is False, 'swap bad'

# --- services / packages ---
assert set(cfg['services']) == {'sshd','tailscaled'}, f"services: {cfg['services']}"
assert {'openssh','git','curl','sudo','tailscale'} <= set(cfg['packages']), f"packages: {cfg['packages']}"

# --- disk_config geometry (4.4 DiskLayoutConfiguration.parse_arg rules) ---
dc = cfg['disk_config']
assert dc['config_type'] == 'manual_partitioning', 'config_type bad'
MB = 1024*1024
def size_bytes(s):
    v, u = s['value'], s['unit']
    mult = {'B':1,'kB':1000,'MB':10**6,'GB':10**9,'TB':10**12,'KiB':1024,'MiB':1024**2,'GiB':1024**3,'TiB':1024**4}[u]
    assert s['sector_size'] == {'value':512,'unit':'B'}, f'sector_size bad: {s["sector_size"]}'
    return v*mult

DISK_TOTAL = 120*1024**3  # qcow2 virtual size 120 GiB
gpt_end = DISK_TOTAL - MB  # 1 MiB reserved for backup GPT header
parts = dc['device_modifications'][0]['partitions']
assert dc['device_modifications'][0]['device'] == '/dev/vda'
assert dc['device_modifications'][0]['wipe'] is True
prev_end = 0
for i, p in enumerate(parts):
    for f in ('obj_id','status','type','start','size','fs_type','mount_options','flags'):
        assert f in p, f'part {i} missing {f}'
    uuid.UUID(p['obj_id'])  # obj_id must be a real UUID (parse_arg stores as _obj_id)
    assert p['status'] == 'create', f'part {i} status {p["status"]}'
    assert p['type'] == 'primary', f'part {i} type {p["type"]}'
    assert p['fs_type'] in ('fat32','ext4','linux-swap'), f'part {i} fs {p["fs_type"]}'
    for fl in p['flags']:
        assert fl.lower() in ('boot','bls_boot','esp','linux-home','swap'), f'bad flag {fl}'
    start, length = size_bytes(p['start']), size_bytes(p['size'])
    assert start % MB == 0 and length % MB == 0, f'part {i} not 1MiB-aligned: {start},{length}'
    if i == 0:
        assert start >= MB, 'first partition must start >= 1 MiB'
    assert start >= prev_end, f'part {i} overlaps previous'
    end = start + length
    prev_end = end
    print(f"  part{i+1}: start={start//MB} MiB, len={length//MB} MiB, end={end//MB} MiB, fs={p['fs_type']}, mp={p['mountpoint']}, flags={p['flags']}")
last_end = prev_end
assert last_end <= gpt_end, f'last partition ({last_end//MB} MiB) crosses GPT backup header ({gpt_end//MB} MiB)'
print(f"  geometry OK: {len(parts)} partitions, last ends at {last_end//MB} MiB < gpt_end {gpt_end//MB} MiB")

mps = [(p['fs_type'], p['mountpoint']) for p in parts]
assert mps == [('fat32','/boot'),('linux-swap',None),('ext4','/')], f'mountpoint map: {mps}'
assert parts[0]['flags'] == ['boot','esp'], 'ESP flags'

# --- custom_commands: bash -n syntax check ---
for i, cmd in enumerate(cfg['custom_commands']):
    r = subprocess.run(['bash','-n'], input=cmd, text=True, capture_output=True)
    assert r.returncode == 0, f'custom_command {i} syntax: {r.stderr}'
print(f"  {len(cfg['custom_commands'])} custom_commands: bash -n OK")

# --- key blob == owner key (material + comment) ---
owner = open('/home/charlesjackson/.ssh/ai-arch-dev_ed25519.pub').read().strip()
owner_material = owner.split()[1]
found = [c for c in cfg['custom_commands'] if 'authorized_keys' in c and '>' in c]
for c in found:
    blob = re.search(r"echo 'ssh-ed25519 (\S+) (\S+)'", c).groups()
    assert blob[0] == owner_material, 'KEY MATERIAL MISMATCH'
    assert blob[1] == owner.split()[2], f'key comment mismatch: {blob[1]}'
root_inject = [c for c in found if '/root/.ssh/authorized_keys' in c]
archdev_inject = [c for c in found if '/home/archdev/.ssh/authorized_keys' in c]
assert len(root_inject) == 1 and len(archdev_inject) == 1, f'root={len(root_inject)} archdev={len(archdev_inject)}'
assert 'chown archdev:archdev' in archdev_inject[0], 'archdev key not chowned'
assert 'chmod 600' in archdev_inject[0], 'archdev authorized_keys not 600'
archdev_mkdir = [c for c in cfg['custom_commands'] if c.startswith('mkdir -p /home/archdev/.ssh')]
assert len(archdev_mkdir) == 1 and 'chmod 700' in archdev_mkdir[0] and 'umask 077' in archdev_mkdir[0], 'archdev .ssh dir setup bad'
sudoers = [c for c in cfg['custom_commands'] if 'sudoers' in c]
assert len(sudoers) == 1 and 'NOPASSWD' in sudoers[0] and 'chmod 440' in sudoers[0]
assert 'install.sh' not in json.dumps(cfg) and '| sh' not in json.dumps(cfg), 'tailscale curl|sh staging still present!'
print('  key injection: root + archdev OK (material+comment == owner key); sudoers OK; no curl|sh staging')

if errors:
    print('ERRORS:', errors)
    sys.exit(1)
print('PRESEED VALIDATION: PASS')
