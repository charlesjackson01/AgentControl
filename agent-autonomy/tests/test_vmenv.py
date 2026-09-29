"""Agent VMs (M13), without KVM: the domain definition, console conversion and keys, the file
snapshots over SSH (the VM side runs here for real on a local folder), and libvirt calls
checked against a scripted virsh."""
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock
import xml.etree.ElementTree as ET
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import vmenv
from test_workspaces import make_repo

TEMPLATE = (Path(__file__).resolve().parents[2] / 'ai-arch' / 'vms' / 'ai-arch-dev.xml').read_text()


def decode_png(png):
    width, height = vmenv.png_size(png)
    pos, idat = 8, b''
    while pos < len(png):
        length = int.from_bytes(png[pos:pos + 4], 'big')
        kind = png[pos + 4:pos + 8]
        if kind == b'IDAT':
            idat += png[pos + 8:pos + 8 + length]
        pos += 12 + length
    raw = zlib.decompress(idat)
    stride = width * 3 + 1
    return width, height, [raw[r * stride + 1:(r + 1) * stride] for r in range(height)]


class DomainTests(unittest.TestCase):
    def test_template_becomes_a_locked_down_kvm_clone(self):
        xml, notes = vmenv.domain_xml(TEMPLATE, 'agentcontrol-run1', '/vms/run1/disk.qcow2', '/vms/run1', 2, 4, 'default')
        root = ET.fromstring(xml)
        self.assertEqual((root.get('type'), root.find('name').text), ('kvm', 'agentcontrol-run1'))
        self.assertIsNone(root.find('uuid'))
        self.assertEqual(root.find('cpu').get('mode'), 'host-passthrough')
        self.assertEqual((root.find('vcpu').text, root.find('memory').text), ('2', str(4 * 1024 * 1024)))
        disks = root.findall('devices/disk')
        self.assertEqual([d.find('source').get('file') for d in disks], ['/vms/run1/disk.qcow2'])
        ifaces = root.findall('devices/interface')
        self.assertEqual(len(ifaces), 1)
        self.assertEqual(ifaces[0].find('source').attrib, {'network': 'default'})
        self.assertIsNone(ifaces[0].find('mac'), 'libvirt gives the clone its own MAC')
        for graphics in root.findall('devices/graphics'):
            self.assertEqual(graphics.get('listen'), '127.0.0.1')
        self.assertTrue(any(i.get('type') == 'tablet' for i in root.findall('devices/input')))
        self.assertEqual(root.findall('devices/filesystem') + root.findall('devices/hostdev'), [])
        self.assertTrue(root.find('os/nvram').text.startswith('/vms/run1/'))

    def test_isolated_network_has_no_forwarding(self):
        net = ET.fromstring(vmenv.isolated_network_xml())
        self.assertIsNone(net.find('forward'))
        self.assertEqual(net.find('name').text, vmenv.ISOLATED)

    def test_lease_parsing(self):
        out = (' Name       MAC address          Protocol     Address\n'
               '-------------------------------------------------------\n'
               ' vnet3      52:54:00:aa:bb:cc    ipv4         192.168.122.77/24\n')
        self.assertEqual(vmenv.parse_lease(out), '192.168.122.77')
        self.assertIsNone(vmenv.parse_lease(out, '192.168.231.'))


class ConsoleTests(unittest.TestCase):
    def test_ppm_becomes_png_with_the_same_pixels(self):
        pixels = bytes([255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30, 40, 50, 60, 70, 80, 90])
        ppm = b'P6\n# from qemu\n3 2\n255\n' + pixels
        width, height, rows = decode_png(vmenv.ppm_to_png(ppm))
        self.assertEqual((width, height), (3, 2))
        self.assertEqual(b''.join(rows), pixels)
        with self.assertRaises(vmenv.VMError):
            vmenv.ppm_to_png(b'P6\n3 2\n255\n' + pixels[:5])

    def test_us_key_map(self):
        self.assertEqual(vmenv.keys_for('a'), ['KEY_A'])
        self.assertEqual(vmenv.keys_for('A'), ['KEY_LEFTSHIFT', 'KEY_A'])
        self.assertEqual(vmenv.keys_for('7'), ['KEY_7'])
        self.assertEqual(vmenv.keys_for('!'), ['KEY_LEFTSHIFT', 'KEY_1'])
        self.assertEqual(vmenv.keys_for(' '), ['KEY_SPACE'])
        self.assertIsNone(vmenv.keys_for('é'))


class Recorder:
    """A scripted CLI: answers by the first words of a command, records every call."""

    def __init__(self, answers=None):
        self.calls, self.answers = [], answers or {}

    def __call__(self, argv, timeout=120, input=None):
        self.calls.append(argv)
        words = argv[3:] if argv[:1] == ['virsh'] else argv
        for prefix, answer in self.answers.items():
            if ' '.join(words).startswith(prefix):
                return answer(argv) if callable(answer) else answer
        return 0, b'', b''


class DetectTests(unittest.TestCase):
    def test_reasons_come_in_order(self):
        with tempfile.TemporaryDirectory() as temp:
            base, key = Path(temp) / 'base.qcow2', Path(temp) / 'id'
            kvm = Path(temp) / 'kvm'
            have = lambda name: '/usr/bin/' + name
            info = vmenv.detect('qemu:///system', base, 'ai-arch-dev', key, Recorder(), lambda n: None, kvm)
            self.assertIn('virsh and qemu-img', info['reason'])
            self.assertIn('/dev/kvm', vmenv.detect('qemu:///system', base, 'ai-arch-dev', key, Recorder(), have, kvm)['reason'])
            kvm.write_text('')
            denied = Recorder({'version': (1, b'', b'permission denied')})
            self.assertIn('libvirt group', vmenv.detect('qemu:///system', base, 'ai-arch-dev', key, denied, have, kvm)['reason'])
            self.assertIn('--vm-baseline', vmenv.detect('qemu:///system', base, 'ai-arch-dev', key, Recorder(), have, kvm)['reason'])
            base.write_text('')
            self.assertIn('template domain', vmenv.detect('qemu:///system', base, 'nope', key,
                                                          Recorder({'dominfo': (1, b'', b'')}), have, kvm)['reason'])
            self.assertIn('--vm-ssh-key', vmenv.detect('qemu:///system', base, 'ai-arch-dev', key, Recorder(), have, kvm)['reason'])
            key.write_text('')
            self.assertEqual(vmenv.detect('qemu:///system', base, 'ai-arch-dev', key, Recorder(), have, kvm)['reason'], '')


class TreeSyncTests(unittest.TestCase):
    """The host side is vmenv.pack/unpack_into; the VM side (SYNC_IN/SYNC_OUT) runs here on a folder."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.host = make_repo(root)
        (self.host / '.gitignore').write_text('node_modules/\n')
        (self.host / 'app.py').write_text('print(1)\n')
        (self.host / 'old.txt').write_text('old\n')
        subprocess.run(['git', '-C', str(self.host), 'add', '-A'], check=True)
        subprocess.run(['git', '-C', str(self.host), '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'files'], check=True)
        self.vm = root / 'vm' / 'work'

    def tearDown(self):
        self.temp.cleanup()

    def vm_side(self, script, data=None):
        return subprocess.run([sys.executable, '-c', script, str(self.vm)], input=data, capture_output=True, check=True).stdout

    def test_round_trip_mirrors_edits_and_deletions_but_not_ignored_files(self):
        (self.host / 'draft.txt').write_text('untracked but not ignored\n')
        self.vm_side(vmenv.SYNC_IN, vmenv.pack(self.host))
        self.assertEqual((self.vm / 'app.py').read_text(), 'print(1)\n')
        self.assertTrue((self.vm / 'draft.txt').exists())
        self.assertTrue((self.vm / '.git').is_dir(), 'agents get a git repo of their own')
        # The agent works in the VM: edits, adds, deletes, and installs dependencies.
        (self.vm / 'app.py').write_text('print(2)\n')
        (self.vm / 'new.py').write_text('x = 1\n')
        (self.vm / 'old.txt').unlink()
        (self.vm / 'node_modules').mkdir()
        (self.vm / 'node_modules' / 'big.js').write_text('ignored')
        result = vmenv.unpack_into(self.vm_side(vmenv.SYNC_OUT), self.host)
        self.assertEqual((self.host / 'app.py').read_text(), 'print(2)\n')
        self.assertEqual((self.host / 'new.py').read_text(), 'x = 1\n')
        self.assertFalse((self.host / 'old.txt').exists())
        self.assertFalse((self.host / 'node_modules').exists(), 'ignored files stay in the VM')
        self.assertEqual(result['refused'], [])
        self.assertIn('old.txt', result['removed'])
        # The next push mirrors a host-side deletion, and keeps the VM's ignored files.
        (self.host / 'new.py').unlink()
        self.vm_side(vmenv.SYNC_IN, vmenv.pack(self.host))
        self.assertFalse((self.vm / 'new.py').exists())
        self.assertTrue((self.vm / 'node_modules' / 'big.js').exists())

    def test_what_comes_back_cannot_escape_the_worktree(self):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w') as tar:
            for name, kind in (('../escape.txt', tarfile.REGTYPE), ('link', tarfile.SYMTYPE), ('.git/config', tarfile.REGTYPE),
                               ('/etc/passwd', tarfile.REGTYPE), ('ok.txt', tarfile.REGTYPE)):
                info = tarfile.TarInfo(name)
                info.type = kind
                if kind == tarfile.SYMTYPE:
                    info.linkname = '/etc/shadow'
                    tar.addfile(info)
                else:
                    info.size = 2
                    tar.addfile(info, io.BytesIO(b'hi'))
            body = json.dumps(['ok.txt', 'app.py', 'old.txt', 'README.md', '.gitignore']).encode()
            info = tarfile.TarInfo('.agentcontrol-manifest')
            info.size = len(body)
            tar.addfile(info, io.BytesIO(body))
        result = vmenv.unpack_into(buffer.getvalue(), self.host)
        self.assertEqual(sorted(result['refused']), sorted(['../escape.txt', 'link', '.git/config', '/etc/passwd']))
        self.assertEqual((self.host / 'ok.txt').read_text(), 'hi')
        self.assertFalse((self.host.parent / 'escape.txt').exists())
        self.assertFalse((self.host / 'link').exists())

    def test_installed_skills_are_kept_when_the_vm_does_not_have_them(self):
        skill = self.host / '.opencode' / 'skills' / 'pdf'
        skill.mkdir(parents=True)
        (skill / 'SKILL.md').write_text('---\nname: pdf\n---\n')
        self.vm_side(vmenv.SYNC_IN, vmenv.pack(self.host))
        shutil.rmtree(self.vm / '.opencode')
        vmenv.unpack_into(self.vm_side(vmenv.SYNC_OUT), self.host, keep=['.opencode/skills/pdf'])
        self.assertTrue((skill / 'SKILL.md').exists())


class MachineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name) / 'run1'

    def tearDown(self):
        self.temp.cleanup()

    def test_create_uses_an_overlay_of_the_baseline_and_defines_the_clone(self):
        cli = Recorder({'dumpxml': (0, TEMPLATE.encode(), b'')})
        vm = vmenv.VirtualMachine('qemu:///system', 'agentcontrol-run1', self.base, '/keys/id', cli=cli)
        vm.create('/vms/baseline.qcow2', 'ai-arch-dev', 2, 4, 'default')
        qemu = next(c for c in cli.calls if c[0] == 'qemu-img')
        self.assertIn('-b', qemu)
        self.assertEqual(qemu[-1], str(self.base / 'disk.qcow2'))
        self.assertIn(['virsh', '-c', 'qemu:///system', 'define', str(self.base / 'domain.xml')], cli.calls)
        self.assertNotIn('ai-arch-dev.qcow2', (self.base / 'domain.xml').read_text(), 'the original disk is never used')

    def test_disk_and_firmware_go_to_the_storage_folder_qemu_can_reach(self):
        storage = Path(self.temp.name) / 'vms' / 'agentcontrol-runs' / 'run1'
        cli = Recorder({'dumpxml': (0, TEMPLATE.encode(), b''), 'domstate': (0, b'shut off', b'')})
        vm = vmenv.VirtualMachine('qemu:///system', 'agentcontrol-run1', self.base, '/keys/id', cli=cli, storage=storage)
        vm.create('/vms/baseline.qcow2', 'ai-arch-dev', 2, 4, 'default')
        self.assertEqual(next(c for c in cli.calls if c[0] == 'qemu-img')[-1], str(storage / 'disk.qcow2'))
        xml = (storage / 'domain.xml').read_text()
        self.assertIn(str(storage / 'disk.qcow2'), xml)
        self.assertIn(str(storage / 'agentcontrol-run1_VARS.fd'), xml)
        self.assertNotIn(str(self.base), xml, "AgentControl's private folder is not handed to QEMU")
        self.assertEqual(vm.known_hosts, self.base / 'known_hosts')
        vm.remove()
        self.assertFalse(storage.exists())
        self.assertFalse(self.base.exists())

    def test_a_permission_denied_start_says_how_to_fix_it(self):
        cli = Recorder({'domstate': (0, b'shut off', b''),
                        'start': (1, b'', b"error: Cannot access storage file '/home/me/tmp/disk.qcow2' (as uid:64055, gid:109): Permission denied")})
        vm = vmenv.VirtualMachine('qemu:///system', 'vm1', self.base, '/keys/id', cli=cli, storage='/home/me/tmp')
        with self.assertRaisesRegex(vmenv.VMError, '--vm-storage') as caught:
            vm.start()
        self.assertIn('setfacl -m u:libvirt-qemu:x', str(caught.exception))

    def test_waiting_for_ssh_says_what_went_wrong(self):
        no_lease = Recorder({'domifaddr': (0, b'', b'')})
        vm = vmenv.VirtualMachine('qemu:///system', 'vm1', self.base, '/keys/id', cli=no_lease)
        with self.assertRaisesRegex(vmenv.VMError, 'no address from libvirt'):
            vm.wait_address(timeout=.5)
        refused = Recorder({'domifaddr': (0, b' vnet0 52:54:00:aa:bb:cc ipv4 192.168.122.77/24\n', b''),
                            'ssh': (255, b'', b'archdev@192.168.122.77: Permission denied (publickey).')})
        vm = vmenv.VirtualMachine('qemu:///system', 'vm1', self.base, '/keys/id', cli=refused)
        with self.assertRaisesRegex(vmenv.VMError, 'refused the SSH key /keys/id') as caught:
            vm.wait_address(timeout=.5)
        self.assertIn('--vm-ssh-key', str(caught.exception))

    def test_the_ai_arch_owner_key_is_preferred(self):
        home = Path(self.temp.name) / 'home'
        (home / '.ssh').mkdir(parents=True)
        with mock.patch.dict(os.environ, {'HOME': str(home)}):
            (home / '.ssh' / 'id_ed25519').write_text('k')
            self.assertEqual(vmenv.default_key(), home / '.ssh' / 'id_ed25519')
            (home / '.ssh' / 'ai-arch-dev_ed25519').write_text('k')
            self.assertEqual(vmenv.default_key(), home / '.ssh' / 'ai-arch-dev_ed25519')

    def test_network_switch_falls_back_to_a_reboot(self):
        states = iter(['running', 'stopped', 'stopped', 'running'])
        leases = {'n': 0}

        def lease(argv):
            leases['n'] += 1
            return 0, (b' vnet0 52:54:00:aa:bb:cc ipv4 192.168.231.20/24\n' if leases['n'] > 1 else b''), b''
        cli = Recorder({'domiflist': (0, b' Interface Type Source Model MAC\n----\n vnet0 network default virtio 52:54:00:aa:bb:cc\n', b''),
                        'update-device': (1, b'', b'Operation not supported: cannot change network'),
                        'domstate': lambda a: (0, next(states, 'running').replace('stopped', 'shut off').encode(), b''),
                        'dumpxml': (0, vmenv.domain_xml(TEMPLATE, 'x', '/d', '/n', 1, 1, 'default')[0].encode(), b''),
                        'domifaddr': lease, 'ssh': (0, b'', b'')})
        vm = vmenv.VirtualMachine('qemu:///system', 'agentcontrol-run1', self.base, '/keys/id', cli=cli)
        vm.base.mkdir(parents=True)
        ip, how = vm.switch_network(vmenv.ISOLATED, '192.168.231.')
        self.assertEqual((ip, how), ('192.168.231.20', 'reboot'))
        self.assertIn(f"network='{vmenv.ISOLATED}'".replace("'", '"'), (self.base / 'domain.xml').read_text().replace("'", '"'))

    def test_console_input_goes_through_libvirt(self):
        cli = Recorder()
        vm = vmenv.VirtualMachine('qemu:///system', 'vm1', self.base, '/keys/id', cli=cli)
        vm.click(639, 399, 640, 400)
        vm.type_text('Hi!')
        vm.press('Return')
        commands = [c[3:] for c in cli.calls]
        self.assertEqual(commands[0], ['qemu-monitor-command', 'vm1', '--hmp', 'mouse_move 32767 32767'])
        self.assertEqual(commands[1][-1], 'mouse_button 1')
        self.assertIn(['send-key', 'vm1', 'KEY_LEFTSHIFT', 'KEY_H'], commands)
        self.assertIn(['send-key', 'vm1', 'KEY_LEFTSHIFT', 'KEY_1'], commands)
        self.assertEqual(commands[-1], ['send-key', 'vm1', 'KEY_ENTER'])

    def test_provisioning_keeps_the_clone_off_the_tailnet_and_agents_without_sudo(self):
        script = vmenv.provision_script(['/home/me/proj/state/worktrees/r1'])
        self.assertIn('systemctl disable --now tailscaled', script)
        self.assertIn(f'useradd -m -s /bin/bash {vmenv.AGENT_USER}', script)
        self.assertNotIn('sudoers', script)
        self.assertNotIn('NOPASSWD', script)
        self.assertIn('for d in /home/me/proj/state/worktrees/r1;', script)
        self.assertIn("'/tmp/a b'", vmenv.provision_script(['/tmp/a b']), 'unusual paths are quoted')

    def test_ssh_runner_marks_preview_processes(self):
        vm = vmenv.VirtualMachine('qemu:///system', 'vm1', self.base, '/keys/id')
        vm.address = '192.168.231.20'
        runner = vmenv.SshRunner(vm, self.base)
        argv = runner.wrap(['python3', 'app.py'], '/work', {'DISPLAY': ':90'}, tty=True)
        self.assertEqual(argv[0], 'ssh')
        self.assertIn('-tt', argv)
        self.assertIn(f'{vmenv.AGENT_USER}@192.168.231.20', argv)
        self.assertIn('AGENTCONTROL_PREVIEW=1', argv[-1])
        self.assertTrue(argv[-1].startswith('cd /work && env '))


if __name__ == '__main__':
    unittest.main()
