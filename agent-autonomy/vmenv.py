"""Per-run virtual machines on KVM (M13), cloned from an ai-arch baseline.

A run with isolation 'vm' gets its own VM: a thin qcow2 overlay of your baseline (the baseline
itself is only ever read) and a libvirt domain built from your ai-arch-dev definition, switched
to KVM. AgentControl reaches it only over SSH:

  * one SSH connection carries api.sock -> OpenCode in the VM (127.0.0.1:4096) and the VM's
    127.0.0.1:8080 -> the run's model gateway socket, exactly like a container run
  * files move as snapshots over SSH. Your host worktrees stay the source of truth; the VM
    never mounts your disk, and what comes back is checked (regular files only, no paths out)
  * previews run in the VM through SshRunner (the ContainerRunner interface), and its own
    console is shown with `virsh screenshot` and driven with QEMU mouse events and send-key

Agents run as an unprivileged 'agent' user without sudo. Provisioning (first boot, as your
baseline's admin user) stops Tailscale so a clone never appears on your tailnet as the
original VM. Network: the libvirt NAT only for provisioning and your setup command, then the
host-only network 'agentcontrol-isolated'.

Everything here runs `virsh`, `qemu-img` and `ssh`; nothing is sent to a VM you did not start
from AgentControl. Standard library only.
"""
import io
import json
import os
from pathlib import Path, PurePosixPath
import shlex
import shutil
import struct
import subprocess
import tarfile
import tempfile
import time
import xml.etree.ElementTree as ET
import zlib

from proc import process

AGENT_USER = 'agent'
OPENCODE_PORT = 4096
MODEL_PORT = 8080
SETUP_NETWORK = 'default'
ISOLATED = 'agentcontrol-isolated'
PACKAGES = ('git', 'python', 'tar', 'xorg-server-xvfb', 'xdotool', 'imagemagick', 'procps-ng')
DISPLAY = ':90'
MAX_TREE = 512 * 1024 * 1024          # a snapshot larger than this is refused rather than copied


KEY_CANDIDATES = ('~/.ssh/ai-arch-dev_ed25519', '~/.ssh/id_ed25519')   # ai-arch's owner key first (ai-arch/docs/ACCESS.md)


class VMError(RuntimeError):
    pass


def default_key():
    """The first SSH key that exists: ai-arch's owner key, else your usual one."""
    for candidate in KEY_CANDIDATES:
        if Path(candidate).expanduser().is_file():
            return Path(candidate).expanduser()
    return Path(KEY_CANDIDATES[0]).expanduser()


def run_cli(argv, timeout=120, input=None):
    try:
        done = subprocess.run(argv, capture_output=True, timeout=timeout, input=input, check=False)
    except FileNotFoundError:
        return 127, b'', f'{argv[0]} is not installed'.encode()
    except subprocess.TimeoutExpired:
        return 124, b'', f'{argv[0]} timed out'.encode()
    return done.returncode, done.stdout, done.stderr


def _text(data):
    return data.decode(errors='replace') if isinstance(data, bytes) else str(data or '')


# ---- can this machine run agent VMs? -----------------------------------------
def detect(uri, baseline, template, key, cli=run_cli, which=shutil.which, kvm='/dev/kvm'):
    """What is present, and the first reason VMs cannot be used ('' when they can)."""
    info = {'uri': uri, 'baseline': str(baseline or ''), 'template': template, 'key': str(key or ''),
            'kvm': Path(kvm).exists(), 'virsh': bool(which('virsh')), 'qemu_img': bool(which('qemu-img')),
            'ssh': bool(which('ssh')), 'version': '', 'reason': ''}
    def reason():
        if not info['virsh'] or not info['qemu_img']:
            return 'virsh and qemu-img are needed (install libvirt and qemu).'
        if not info['kvm']:
            return '/dev/kvm is missing: enable virtualization (SVM/VT-x) and load kvm_amd or kvm_intel.'
        if not info['ssh']:
            return 'The ssh client is needed.'
        code, out, err = cli(['virsh', '-c', uri, 'version', '--daemon'], 30)
        if code:
            return f'libvirt at {uri} is not reachable: {_text(err).strip()[:300]} (is your user in the libvirt group?)'
        info['version'] = _text(out).strip().splitlines()[0] if _text(out).strip() else ''
        if not baseline or not Path(baseline).expanduser().is_file():
            return 'No baseline disk: start AgentControl with --vm-baseline /path/to/ai-arch-baseline-with-tailscale.qcow2'
        code, _, err = cli(['virsh', '-c', uri, 'dominfo', template], 30)
        if code:
            return f'The template domain {template!r} was not found in libvirt (--vm-template).'
        if not key or not Path(key).expanduser().is_file():
            return f'The SSH key {key} was not found (--vm-ssh-key); it must be authorized in the baseline.'
        return ''
    info['reason'] = reason()
    return info


# ---- the domain definition ---------------------------------------------------------
def _relocate(path, vm_dir):
    if path and not Path(path).exists() and vm_dir:
        candidate = Path(vm_dir).expanduser() / Path(path).name
        if candidate.exists():
            return str(candidate)
    return path


def domain_xml(template_xml, name, overlay, nvram_dir, cpus, memory_gb, network, vm_dir=None):
    """Your template domain turned into a run VM: KVM with host CPU, its own disk overlay and
    firmware variables, the chosen limits and network, a tablet for clicks, displays on
    127.0.0.1 only, and no shared host folders or passed-through devices."""
    root = ET.fromstring(template_xml)
    root.set('type', 'kvm')
    root.attrib.pop('id', None)
    root.find('name').text = name
    for tag in ('uuid', 'title', 'description', 'seclabel', 'cputune', 'numatune'):
        for node in root.findall(tag):
            root.remove(node)
    for cpu in root.findall('cpu'):
        root.remove(cpu)
    ET.SubElement(root, 'cpu', {'mode': 'host-passthrough', 'check': 'none'})
    for tag, value in (('vcpu', str(int(cpus))), ('memory', str(int(memory_gb) * 1024 * 1024)), ('currentMemory', str(int(memory_gb) * 1024 * 1024))):
        node = root.find(tag)
        if node is None:
            node = ET.SubElement(root, tag)
        node.text = value
        node.attrib = {'placement': 'static'} if tag == 'vcpu' else {'unit': 'KiB'}
    for node in root.findall('memoryBacking'):
        root.remove(node)
    notes = []
    nvram = root.find('os/nvram')
    if nvram is not None:
        source = _relocate((nvram.text or '').strip(), vm_dir)
        template = source if source and Path(source).exists() else nvram.get('template', '')
        if not template or not Path(template).exists():
            notes.append(f'NVRAM template not found ({source or template}); the firmware may fall back to EFI/BOOT/BOOTX64.EFI')
        nvram.set('template', template)
        nvram.text = str(Path(nvram_dir) / f'{name}_VARS.fd')
    loader = root.find('os/loader')
    if loader is not None and loader.text:
        loader.text = _relocate(loader.text.strip(), vm_dir)
    devices = root.find('devices')
    kept = False
    for disk in list(devices.findall('disk')):
        if disk.get('device') == 'disk' and not kept:
            source = disk.find('source')
            source.attrib.clear()
            source.set('file', str(overlay))
            for child in list(disk):
                if child.tag in ('backingStore', 'alias'):
                    disk.remove(child)
            kept = True
        else:
            devices.remove(disk)
    if not kept:
        raise VMError('The template domain has no disk to clone.')
    for tag in ('filesystem', 'hostdev', 'redirdev', 'smartcard', 'shmem', 'channel'):
        for node in devices.findall(tag):
            devices.remove(node)   # no host folders, devices, or guest-agent channels in an agent VM
    interfaces = devices.findall('interface')
    for extra in interfaces[1:]:
        devices.remove(extra)
    if interfaces:
        iface = interfaces[0]
        iface.attrib = {'type': 'network'}
        for child in list(iface):
            if child.tag not in ('model',):
                iface.remove(child)
        ET.SubElement(iface, 'source', {'network': network})
    else:
        iface = ET.SubElement(devices, 'interface', {'type': 'network'})
        ET.SubElement(iface, 'source', {'network': network})
        ET.SubElement(iface, 'model', {'type': 'virtio'})
    for graphics in devices.findall('graphics'):
        graphics.attrib = {'type': graphics.get('type', 'vnc'), 'port': '-1', 'autoport': 'yes', 'listen': '127.0.0.1'}
        for child in list(graphics):
            graphics.remove(child)
        ET.SubElement(graphics, 'listen', {'type': 'address', 'address': '127.0.0.1'})
    if not devices.findall('graphics'):
        graphics = ET.SubElement(devices, 'graphics', {'type': 'vnc', 'port': '-1', 'autoport': 'yes', 'listen': '127.0.0.1'})
        ET.SubElement(graphics, 'listen', {'type': 'address', 'address': '127.0.0.1'})
    if not devices.findall('video'):
        video = ET.SubElement(devices, 'video')
        ET.SubElement(video, 'model', {'type': 'virtio'})
    if not any(i.get('type') == 'tablet' for i in devices.findall('input')):
        ET.SubElement(devices, 'input', {'type': 'tablet', 'bus': 'usb'})
    for node in devices.iter():
        for child in list(node):
            if child.tag == 'alias':
                node.remove(child)
    for tag in ('serial', 'console'):
        for node in devices.findall(tag):
            source = node.find('source')
            if source is not None:
                node.remove(source)
            node.attrib.pop('tty', None)
    return ET.tostring(root, encoding='unicode'), notes


def isolated_network_xml(name=ISOLATED):
    """A host-only libvirt network: your host can reach the VM (SSH), the VM reaches nothing else."""
    return (f"<network><name>{name}</name><bridge name='virbr-agentctl' stp='on' delay='0'/>"
            "<ip address='192.168.231.1' netmask='255.255.255.0'><dhcp><range start='192.168.231.10' end='192.168.231.250'/></dhcp></ip></network>")


def parse_lease(text, network_prefix=None):
    """The IPv4 address from `virsh domifaddr --source lease` output."""
    for line in _text(text).splitlines():
        parts = line.split()
        if len(parts) >= 4 and parts[2] == 'ipv4':
            ip = parts[3].split('/')[0]
            if not network_prefix or ip.startswith(network_prefix):
                return ip
    return None


# ---- the console ------------------------------------------------------------------
def ppm_to_png(data):
    """A binary PPM (what `virsh screenshot` writes for QEMU) as PNG bytes, without any library."""
    if data[:8] == b'\x89PNG\r\n\x1a\n':
        return data
    if data[:2] != b'P6':
        raise VMError('The console screenshot is not a PPM image')
    fields, pos = [], 2
    while len(fields) < 3:
        while data[pos:pos + 1].isspace():
            pos += 1
        if data[pos:pos + 1] == b'#':
            pos = data.index(b'\n', pos) + 1
            continue
        end = pos
        while not data[end:end + 1].isspace():
            end += 1
        fields.append(int(data[pos:end]))
        pos = end
    width, height, maxval = fields
    pos += 1
    if maxval != 255:
        raise VMError('Only 8-bit console screenshots are supported')
    stride = width * 3
    pixels = data[pos:pos + stride * height]
    if len(pixels) != stride * height:
        raise VMError('The console screenshot is truncated')
    raw = b''.join(b'\x00' + pixels[row * stride:(row + 1) * stride] for row in range(height))

    def chunk(kind, body):
        return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 6)) + chunk(b'IEND', b''))


def png_size(png):
    return struct.unpack('>II', png[16:24])


_SHIFTED = {'!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
            '_': 'MINUS', '+': 'EQUAL', '{': 'LEFTBRACE', '}': 'RIGHTBRACE', '|': 'BACKSLASH', ':': 'SEMICOLON',
            '"': 'APOSTROPHE', '<': 'COMMA', '>': 'DOT', '?': 'SLASH', '~': 'GRAVE'}
_PLAIN = {' ': 'SPACE', '-': 'MINUS', '=': 'EQUAL', '[': 'LEFTBRACE', ']': 'RIGHTBRACE', '\\': 'BACKSLASH', ';': 'SEMICOLON',
          "'": 'APOSTROPHE', ',': 'COMMA', '.': 'DOT', '/': 'SLASH', '`': 'GRAVE', '\n': 'ENTER', '\t': 'TAB'}
NAMED_KEYS = {'Return': 'KEY_ENTER', 'Escape': 'KEY_ESC', 'Tab': 'KEY_TAB', 'BackSpace': 'KEY_BACKSPACE',
              'Up': 'KEY_UP', 'Down': 'KEY_DOWN', 'Left': 'KEY_LEFT', 'Right': 'KEY_RIGHT', 'Delete': 'KEY_DELETE'}


def keys_for(char):
    """Linux key names for one character on a US layout, or None if it cannot be typed."""
    if char.isascii() and char.isalpha():
        return (['KEY_LEFTSHIFT'] if char.isupper() else []) + [f'KEY_{char.upper()}']
    if char.isdigit():
        return [f'KEY_{char}']
    if char in _PLAIN:
        return [f'KEY_{_PLAIN[char]}']
    if char in _SHIFTED:
        return ['KEY_LEFTSHIFT', f'KEY_{_SHIFTED[char]}']
    return None


# ---- moving files over SSH -------------------------------------------------------------
# Runs inside the VM as the agent: unpack a snapshot, mirror deletions, record it in the VM's own git.
SYNC_IN = r'''
import io, json, os, subprocess, sys, tarfile
root = sys.argv[1]
os.makedirs(root, exist_ok=True)
data = sys.stdin.buffer.read()
with tarfile.open(fileobj=io.BytesIO(data)) as tar:
    manifest = json.loads(tar.extractfile('.agentcontrol-manifest').read())
    for member in tar.getmembers():
        if member.name != '.agentcontrol-manifest' and member.isfile():
            tar.extract(member, root)
git = ['git', '-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=AgentControl', '-c', 'user.email=agentcontrol@localhost']
if not os.path.isdir(os.path.join(root, '.git')):
    subprocess.run(git + ['init', '-q'], check=True)
listed = subprocess.run(git + ['ls-files', '-z', '-co', '--exclude-standard'], capture_output=True, check=True).stdout.split(b'\0')
keep = set(manifest)
for name in (n.decode() for n in listed if n):
    if name not in keep and not any(name.startswith(p) for p in ('.opencode/skills/',)):
        try:
            os.remove(os.path.join(root, name))
        except FileNotFoundError:
            pass
subprocess.run(git + ['add', '-A'], check=True)
subprocess.run(git + ['commit', '-q', '--allow-empty', '-m', 'AgentControl snapshot'], check=True)
'''

# Runs inside the VM as the agent: the tracked and unignored files, as a tar on stdout.
SYNC_OUT = r'''
import io, json, os, subprocess, sys, tarfile
root = sys.argv[1]
names = [n.decode() for n in subprocess.run(['git', '-C', root, 'ls-files', '-z', '-co', '--exclude-standard'],
                                             capture_output=True, check=True).stdout.split(b'\0') if n]
names = [n for n in names if os.path.isfile(os.path.join(root, n)) and not os.path.islink(os.path.join(root, n))]
buffer = io.BytesIO()
with tarfile.open(fileobj=buffer, mode='w') as tar:
    for name in names:
        tar.add(os.path.join(root, name), arcname=name, recursive=False)
    body = json.dumps(names).encode()
    info = tarfile.TarInfo('.agentcontrol-manifest')
    info.size = len(body)
    tar.addfile(info, io.BytesIO(body))
sys.stdout.buffer.write(buffer.getvalue())
'''


def listed_files(folder):
    """Tracked and unignored files of a host worktree (what a snapshot carries)."""
    out = subprocess.run(['git', '-C', str(folder), 'ls-files', '-z', '-co', '--exclude-standard'], capture_output=True, check=True).stdout
    return [n.decode() for n in out.split(b'\0') if n and (Path(folder) / n.decode()).is_file() and not (Path(folder) / n.decode()).is_symlink()]


def pack(folder):
    names = listed_files(folder)
    buffer, total = io.BytesIO(), 0
    with tarfile.open(fileobj=buffer, mode='w') as tar:
        for name in names:
            total += (Path(folder) / name).stat().st_size
            if total > MAX_TREE:
                raise VMError(f'The worktree is larger than {MAX_TREE // 2**20} MB; it is not copied into the VM.')
            tar.add(str(Path(folder) / name), arcname=name, recursive=False)
        body = json.dumps(names).encode()
        info = tarfile.TarInfo('.agentcontrol-manifest')
        info.size = len(body)
        tar.addfile(info, io.BytesIO(body))
    return buffer.getvalue()


def _safe_name(name):
    path = PurePosixPath(name)
    return not path.is_absolute() and '..' not in path.parts and path.parts and path.parts[0] != '.git'


def unpack_into(data, folder, keep=()):
    """Mirror a snapshot from the VM into a host worktree. Only regular files with plain relative
    paths are written (links, devices and paths out of the folder are refused and reported); files
    the snapshot no longer has are removed, except paths in `keep` (for example installed skills)."""
    if len(data) > MAX_TREE * 2:
        raise VMError('The snapshot from the VM is too large.')
    folder = Path(folder)
    refused, written = [], []
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        member = tar.getmember('.agentcontrol-manifest')
        manifest = [n for n in json.loads(tar.extractfile(member).read()) if isinstance(n, str)]
        for member in tar.getmembers():
            if member.name == '.agentcontrol-manifest':
                continue
            if not member.isfile() or not _safe_name(member.name):
                refused.append(member.name)
                continue
            target = folder / member.name
            if target.resolve().parent != target.parent.resolve() or not str(target.resolve()).startswith(str(folder.resolve()) + os.sep):
                refused.append(member.name)
                continue
            content = tar.extractfile(member).read()
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.is_symlink():
                target.unlink()
            if not target.exists() or target.read_bytes() != content:
                target.write_bytes(content)
            target.chmod(0o755 if member.mode & 0o111 else 0o644)
            written.append(member.name)
    wanted = {n for n in manifest if _safe_name(n)}
    removed = []
    for name in listed_files(folder):
        if name not in wanted and not any(name.startswith(k.rstrip('/') + '/') or name == k for k in keep):
            (folder / name).unlink(missing_ok=True)
            removed.append(name)
    return {'written': len(written), 'removed': removed, 'refused': refused}


# ---- one run's VM -------------------------------------------------------------------------------
class VirtualMachine:
    def __init__(self, uri, name, base, key, admin='archdev', cli=run_cli, storage=None):
        # base: AgentControl's own files (SSH known_hosts); storage: the clone's disk, firmware
        # variables and definition, which QEMU (another user) must be able to reach.
        self.uri, self.name, self.base = uri, name, Path(base)
        self.storage = Path(storage) if storage else self.base
        self.key, self.admin, self.cli = str(Path(key).expanduser()), admin, cli
        self.known_hosts = self.base / 'known_hosts'
        self.tunnel = None
        self.address = None

    # libvirt
    def virsh(self, *args, timeout=120, check=True, input=None):
        code, out, err = self.cli(['virsh', '-c', self.uri, *args], timeout, input)
        if check and code:
            raise VMError(f"virsh {args[0]} failed: {(_text(err) or _text(out)).strip()[:500]}")
        return _text(out)

    def state(self):
        code, out, _ = self.cli(['virsh', '-c', self.uri, 'domstate', self.name], 30)
        if code:
            return 'missing'
        return {'running': 'running', 'shut off': 'stopped', 'paused': 'paused'}.get(_text(out).strip(), _text(out).strip() or 'missing')

    def ensure_isolated_network(self):
        code, _, _ = self.cli(['virsh', '-c', self.uri, 'net-info', ISOLATED], 30)
        if code:
            with tempfile.NamedTemporaryFile('w', suffix='.xml', delete=False) as f:
                f.write(isolated_network_xml())
            try:
                self.virsh('net-define', f.name)
            finally:
                os.unlink(f.name)
        info = self.virsh('net-info', ISOLATED, check=False)
        if 'Active:' in info and 'yes' not in info.split('Active:')[1].splitlines()[0]:
            self.virsh('net-start', ISOLATED)

    def create(self, baseline, template, cpus, memory_gb, network, vm_dir=None):
        self.base.mkdir(parents=True, exist_ok=True)
        self.storage.mkdir(parents=True, exist_ok=True)
        overlay = self.storage / 'disk.qcow2'
        code, _, err = self.cli(['qemu-img', 'create', '-q', '-f', 'qcow2', '-F', 'qcow2', '-b', str(Path(baseline).expanduser().resolve()), str(overlay)], 120)
        if code:
            raise VMError(f'qemu-img could not create the overlay: {_text(err).strip()[:300]}')
        source = self.virsh('dumpxml', '--inactive', template)
        xml, notes = domain_xml(source, self.name, overlay, self.storage, cpus, memory_gb, network, vm_dir)
        (self.storage / 'domain.xml').write_text(xml)
        self.virsh('define', str(self.storage / 'domain.xml'))
        return notes

    def start(self):
        if self.state() != 'running':
            try:
                self.virsh('start', self.name)
            except VMError as exc:
                if 'Permission denied' in str(exc):
                    raise VMError(f'{exc} -- QEMU runs as its own user and must be able to enter every folder above '
                                  f'{self.storage}. Start AgentControl with --vm-storage pointing to a folder it can reach '
                                  '(next to your baseline works when your existing VMs boot from there), or allow it once: '
                                  f'sudo setfacl -m u:libvirt-qemu:x <each parent folder of {self.storage}>') from exc
                raise

    def stop(self, timeout=60):
        if self.state() != 'running':
            return
        self.close_tunnel()
        self.virsh('shutdown', self.name, check=False)
        until = time.monotonic() + timeout
        while time.monotonic() < until and self.state() == 'running':
            time.sleep(1)
        if self.state() == 'running':
            self.virsh('destroy', self.name, check=False)

    def remove(self):
        self.close_tunnel()
        if self.state() != 'missing':
            self.virsh('destroy', self.name, check=False)
            self.virsh('undefine', self.name, '--nvram', check=False)
        shutil.rmtree(self.storage, ignore_errors=True)
        shutil.rmtree(self.base, ignore_errors=True)

    def network(self):
        for line in self.virsh('domiflist', self.name, check=False).splitlines()[2:]:
            parts = line.split()
            if len(parts) >= 5:
                return {'target': parts[0], 'network': parts[2], 'mac': parts[4]}
        return {}

    def lease(self, prefix=None):
        return parse_lease(self.virsh('domifaddr', self.name, '--source', 'lease', check=False), prefix)

    def wait_address(self, timeout=180, prefix=None):
        until = time.monotonic() + timeout
        ip, error = None, ''
        while time.monotonic() < until:
            ip = self.lease(prefix)
            if ip:
                ok, error = self._ssh_ok(ip)
                if ok:
                    self.address = ip
                    return ip
            time.sleep(1)
        if not ip:
            raise VMError(f'The VM got no address from libvirt\'s DHCP within {timeout} s'
                          f"{f' (expected {prefix}*)' if prefix else ''}. Look at its screen: "
                          f'virsh -c {self.uri} screenshot {self.name} /tmp/{self.name}.ppm')
        if 'Permission denied' in error or 'publickey' in error:
            raise VMError(f'The VM is at {ip}, but it refused the SSH key {self.key} for {self.admin}: {error} '
                          '-- start AgentControl with --vm-ssh-key set to the key authorized in the baseline '
                          '(ai-arch uses ~/.ssh/ai-arch-dev_ed25519), and --vm-user if the admin user is not archdev.')
        raise VMError(f'The VM is at {ip}, but SSH as {self.admin} did not work within {timeout} s: {error or "no answer"}')

    def _ssh_ok(self, ip):
        code, _, err = self.cli(self.ssh_argv(self.admin, ip) + ['true'], 20)
        return code == 0, _text(err).strip()[-300:]

    def switch_network(self, network, prefix):
        """Move the VM to another libvirt network. Live first (link down, new network, link up, new
        lease); if that does not give a working address, shut down, change the config, and boot."""
        iface = self.network()
        self.close_tunnel()
        try:
            if not iface:
                raise VMError('no interface')
            self.virsh('domif-setlink', self.name, iface['target'], 'down')
            xml = f"<interface type='network'><mac address='{iface['mac']}'/><source network='{network}'/><model type='virtio'/></interface>"
            path = self.base / 'iface.xml'
            path.write_text(xml)
            self.virsh('update-device', self.name, str(path), '--live', '--config')
            self.virsh('domif-setlink', self.name, iface['target'], 'up')
            return self.wait_address(60, prefix), 'live'
        except VMError:
            self.stop(90)
            root = ET.fromstring(self.virsh('dumpxml', '--inactive', self.name))
            source = root.find("devices/interface/source")
            source.attrib = {'network': network}
            (self.storage / 'domain.xml').write_text(ET.tostring(root, encoding='unicode'))
            self.virsh('define', str(self.storage / 'domain.xml'))
            self.start()
            return self.wait_address(180, prefix), 'reboot'

    # SSH
    def ssh_argv(self, user, ip=None, extra=()):
        return ['ssh', '-i', self.key, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
                '-o', f'UserKnownHostsFile={self.known_hosts}', '-o', 'ConnectTimeout=8', '-o', 'LogLevel=ERROR',
                *extra, f'{user}@{ip or self.address}']

    def remote(self, argv, cwd=None, env=None):
        prefix = f'cd {shlex.quote(str(cwd))} && ' if cwd else ''
        assigns = ' '.join(f'{k}={shlex.quote(str(v))}' for k, v in (env or {}).items())
        return prefix + (f'env {assigns} ' if assigns else '') + shlex.join([str(a) for a in argv])

    def exec(self, argv, cwd, timeout, cancel=None, user=AGENT_USER):
        """A command in the VM, as the agent unless said otherwise. Same result shape as proc.process."""
        return process(self.ssh_argv(user) + [self.remote(argv, cwd)], Path(tempfile.gettempdir()), timeout, cancel or (lambda: False))

    def run_script(self, script, user=None, timeout=900, input=None):
        code, out, err = self.cli(self.ssh_argv(user or self.admin) + ['bash', '-s'], timeout, script.encode() if input is None else input)
        return code, _text(out), _text(err)

    def copy_in(self, local, remote, user=None):
        code, _, err = self.cli(['scp', '-q', '-i', self.key, '-o', 'BatchMode=yes', '-o', f'UserKnownHostsFile={self.known_hosts}',
                                 '-o', 'StrictHostKeyChecking=accept-new', str(local), f'{user or self.admin}@{self.address}:{remote}'], 600)
        if code:
            raise VMError(f'Copying {Path(local).name} into the VM failed: {_text(err).strip()[:300]}')

    def open_tunnel(self, api_sock, model_sock):
        """api.sock -> OpenCode in the VM; VM 127.0.0.1:8080 -> the run gateway. Restarted when it drops."""
        if self.tunnel and self.tunnel.poll() is None:
            return
        Path(api_sock).unlink(missing_ok=True)
        self.tunnel = subprocess.Popen(self.ssh_argv(AGENT_USER, extra=('-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15',
                                                                       '-o', 'StreamLocalBindUnlink=yes',
                                                                       '-L', f'{api_sock}:127.0.0.1:{OPENCODE_PORT}',
                                                                       '-R', f'127.0.0.1:{MODEL_PORT}:{model_sock}')),
                                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        until = time.monotonic() + 15
        while time.monotonic() < until and not Path(api_sock).exists():
            if self.tunnel.poll() is not None:
                raise VMError('The SSH tunnel to the VM closed: ' + _text(self.tunnel.stderr.read()).strip()[:300])
            time.sleep(.1)

    def close_tunnel(self):
        if self.tunnel and self.tunnel.poll() is None:
            self.tunnel.terminate()
            try:
                self.tunnel.wait(5)
            except subprocess.TimeoutExpired:
                self.tunnel.kill()
        self.tunnel = None

    # files
    def push_tree(self, host_dir, vm_dir):
        code, out, err = self.cli(self.ssh_argv(AGENT_USER) + ['python3', '-c', shlex.quote(SYNC_IN), shlex.quote(str(vm_dir))], 600, pack(host_dir))
        if code:
            raise VMError(f'Copying the worktree into the VM failed: {_text(err).strip()[-400:]}')

    def pull_tree(self, vm_dir, host_dir, keep=()):
        code, out, err = self.cli(self.ssh_argv(AGENT_USER) + ['python3', '-c', shlex.quote(SYNC_OUT), shlex.quote(str(vm_dir))], 600)
        if code:
            raise VMError(f'Copying the agent\'s work out of the VM failed: {_text(err).strip()[-400:]}')
        return unpack_into(out, host_dir, keep)

    # console
    def screenshot(self):
        path = self.base / 'screen.ppm'
        self.virsh('screenshot', self.name, str(path), timeout=30)
        png = ppm_to_png(path.read_bytes())
        path.unlink(missing_ok=True)
        return png

    def click(self, x, y, width, height, button=1):
        # QEMU's USB tablet is absolute: 0..0x7fff across the screen.
        ax, ay = int(x * 0x7fff / max(1, width - 1)), int(y * 0x7fff / max(1, height - 1))
        for command in (f'mouse_move {ax} {ay}', f'mouse_button {1 << (button - 1)}', 'mouse_button 0'):
            self.virsh('qemu-monitor-command', self.name, '--hmp', command, timeout=15)

    def type_text(self, text):
        for char in text[:500]:
            keys = keys_for(char)
            if keys:
                self.virsh('send-key', self.name, *keys, timeout=15)

    def press(self, name):
        code = NAMED_KEYS.get(name)
        if not code:
            raise ValueError(f'Unknown key {name}')
        self.virsh('send-key', self.name, code, timeout=15)


def provision_script(user_dirs, packages=PACKAGES):
    """First boot, as your baseline's admin user: keep the clone off your tailnet, create the
    unprivileged agent user, install what agents and previews need, and make the run's folders."""
    dirs = ' '.join(shlex.quote(str(d)) for d in user_dirs)
    return f'''set -e
sudo systemctl disable --now tailscaled.service >/dev/null 2>&1 || true
id {AGENT_USER} >/dev/null 2>&1 || sudo useradd -m -s /bin/bash {AGENT_USER}
sudo install -d -m 700 -o {AGENT_USER} -g {AGENT_USER} /home/{AGENT_USER}/.ssh /home/{AGENT_USER}/.config/opencode
sudo install -m 600 -o {AGENT_USER} -g {AGENT_USER} "$HOME/.ssh/authorized_keys" /home/{AGENT_USER}/.ssh/authorized_keys
missing=""
for p in {' '.join(packages)}; do pacman -Qi "$p" >/dev/null 2>&1 || missing="$missing $p"; done
if [ -n "$missing" ]; then sudo pacman -Sy --noconfirm --needed $missing >/dev/null; fi
for d in {dirs}; do sudo install -d -o {AGENT_USER} -g {AGENT_USER} "$d"; done
echo provisioned
'''


class SshRunner:
    """The ContainerRunner interface over SSH, so the run's live preview works inside its VM.
    Preview processes are marked with AGENTCONTROL_PREVIEW=1 and stopped by that mark."""

    display = DISPLAY

    def __init__(self, vm, sockets):
        self.vm = vm
        self.preview_socket = Path(sockets) / 'preview.sock'
        self.relay = None

    def wrap(self, argv, cwd, env=None, tty=False, detach=False):
        command = self.vm.remote(argv, cwd, {'AGENTCONTROL_PREVIEW': '1', **(env or {})})
        if detach:
            command = f'nohup {command} >/dev/null 2>&1 &'
        return self.vm.ssh_argv(AGENT_USER, extra=('-tt',) if tty else ()) + [command]

    def run(self, argv, env=None, timeout=10):
        return subprocess.run(self.wrap(argv, '/', env), capture_output=True, timeout=timeout, check=False, stdin=subprocess.DEVNULL)

    def exists(self, path):
        return self.run(['test', '-e', path]).returncode == 0

    def port_open(self, port):
        probe = f"import socket; socket.create_connection(('127.0.0.1', {int(port)}), timeout=.5)"
        return self.run(['python3', '-c', probe]).returncode == 0

    def start_relay(self, port):
        if self.relay and self.relay.poll() is None:
            self.relay.terminate()
        self.preview_socket.unlink(missing_ok=True)
        self.relay = subprocess.Popen(self.vm.ssh_argv(AGENT_USER, extra=('-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'StreamLocalBindUnlink=yes',
                                                                         '-L', f'{self.preview_socket}:127.0.0.1:{int(port)}')),
                                      stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        until = time.monotonic() + 5
        while not self.preview_socket.exists() and time.monotonic() < until:
            time.sleep(.05)

    def kill(self):
        if self.relay and self.relay.poll() is None:
            self.relay.terminate()
        script = ("for p in /proc/[0-9]*; do tr '\\0' '\\n' < $p/environ 2>/dev/null | grep -qx 'AGENTCONTROL_PREVIEW=1' "
                  "&& [ ${p#/proc/} != $$ ] && kill -TERM ${p#/proc/} 2>/dev/null; done; true")
        subprocess.run(self.vm.ssh_argv(AGENT_USER) + [script], capture_output=True, timeout=15, check=False, stdin=subprocess.DEVNULL)
