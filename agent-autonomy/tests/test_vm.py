"""VM runs (M13) through the engine, with a stand-in VM: a local folder plays the VM's disk, and the
real snapshot scripts move files in and out of it. OpenCode "inside the VM" writes only there, so
the work reaches your worktree only through the copy back."""
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from engine import Controller, Settings
from proc import process
import vmenv
from test_team import FakeTeamAPI, FakeTeamManager
from test_workflow import complete
from test_workspaces import make_repo


class FakeVM:
    def __init__(self, root, live_switch=True):
        self.root, self.live_switch = Path(root), live_switch
        self.status, self.address, self.network_name = 'missing', None, None
        self.log, self.scripts, self.copied = [], [], []
        self.tunnel_open = False

    def inside(self, path):
        return self.root / str(path).lstrip('/')

    def state(self):
        return self.status

    def ensure_isolated_network(self):
        self.log.append(('isolated network',))

    def create(self, baseline, template, cpus, memory_gb, network, vm_dir=None):
        self.log.append(('create', cpus, memory_gb, network))
        self.status, self.network_name = 'stopped', network
        return []

    def start(self):
        self.log.append(('start', self.network_name))
        self.status = 'running'

    def stop(self, timeout=60):
        self.log.append(('stop',))
        self.status = 'stopped'

    def remove(self):
        self.log.append(('remove',))
        self.status = 'missing'

    def wait_address(self, timeout=180, prefix=None):
        self.address = '192.168.231.20' if self.network_name == vmenv.ISOLATED else '192.168.122.20'
        return self.address

    def switch_network(self, network, prefix):
        self.log.append(('switch', network))
        self.network_name = network
        return self.wait_address(), 'live' if self.live_switch else 'reboot'

    def run_script(self, script, user=None, timeout=900, input=None):
        self.scripts.append((user, script))
        return 0, 'provisioned', ''

    def copy_in(self, local, remote, user=None):
        self.copied.append((local, remote))

    def open_tunnel(self, api_sock, model_sock):
        self.tunnel_open = True

    def close_tunnel(self):
        self.tunnel_open = False

    def push_tree(self, host_dir, vm_dir):
        self.log.append(('push', str(host_dir)))
        subprocess.run([sys.executable, '-c', vmenv.SYNC_IN, str(self.inside(vm_dir))], input=vmenv.pack(host_dir), check=True)

    def pull_tree(self, vm_dir, host_dir, keep=()):
        self.log.append(('pull', str(host_dir)))
        out = subprocess.run([sys.executable, '-c', vmenv.SYNC_OUT, str(self.inside(vm_dir))], capture_output=True, check=True).stdout
        return vmenv.unpack_into(out, host_dir, keep)

    def exec(self, argv, cwd, timeout, cancel=None, user=vmenv.AGENT_USER):
        self.log.append(('exec', str(cwd), tuple(argv)))
        return process(argv, self.inside(cwd), timeout, cancel or (lambda: False))

    def screenshot(self):
        return vmenv.ppm_to_png(b'P6\n2 1\n255\n' + bytes(6))

    def click(self, x, y, width, height, button=1):
        self.log.append(('click', x, y, width, height))

    def type_text(self, text):
        self.log.append(('type', text))

    def press(self, name):
        self.log.append(('key', name))


class VMRunTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.repo = make_repo(root)
        state = root / 'state'
        state.mkdir()
        (state / 'models.json').write_text(json.dumps({'endpoints': [{'id': 'local', 'url': 'http://127.0.0.1:1', 'model': 'qwen'}]}))
        binary = root / 'opencode'
        binary.write_text('#!/bin/sh\n')
        self.settings = Settings(self.repo, state, poll=.01, notifications=False, run_timeout=60,
                                 vm_baseline=root / 'base.qcow2', vm_opencode=binary)
        self.vm = FakeVM(root / 'vmdisk')
        self.host_api, self.inside = FakeTeamAPI(), FakeTeamAPI()
        self.inside.on_submit = self.write_in_vm
        self.c = None

    def write_in_vm(self, session, text):
        match = re.search(r'CREATE (\S+)', text)
        if match:
            target = self.vm.inside(session['directory']) / match.group(1)
            target.write_text(f"made in the VM for {session['title']}\n")

    def tearDown(self):
        if self.c:
            self.c.shutdown.set()
            for thread in list(self.c.threads.values()):
                thread.join(3)
            for server in list(self.c.run_gateways.values()):
                server.shutdown()
                server.server_close()
            self.c.preview.close()
        self.temp.cleanup()

    def controller(self, decisions, reason=''):
        c = self.c = Controller(self.settings, self.host_api, FakeTeamManager([], decisions))
        c.broker.prober = lambda e: {'state': 'online', 'latency_ms': 1, 'models': ['qwen'], 'error': '', 'checked': time.time()}
        c.vm_detect = lambda *a: {'reason': reason, 'kvm': True, 'version': 'libvirt 10'}
        c.vm_factory = lambda run: self.vm
        c.container_api_factory = lambda run: self.inside
        c.check()
        return c

    def done(self, ident, timeout=10):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            run = self.c.store.get('runs', ident)
            if run['status'] in ('completed', 'failed', 'blocked', 'attention', 'stopped'):
                return run
            time.sleep(.02)
        self.fail('timed out')

    def test_the_agent_works_in_the_vm_and_its_work_comes_back_through_ssh(self):
        check = f"{sys.executable} -c \"import pathlib,sys; sys.exit(0 if pathlib.Path('a.txt').exists() else 1)\""
        c = self.controller([{'action': 'code', 'title': 't', 'summary': 's', 'prompt': 'CREATE a.txt'}, complete()])
        run = c.new('Build it', check, isolation='vm', cpus=2, memory_gb=4, network='setup')
        result = self.done(run['id'])
        self.assertEqual(result['status'], 'completed', result['summary'])
        ws = result['workspace']
        self.assertEqual(self.host_api.prompts, [], 'nothing goes to the OpenCode on your host')
        # Created on the setup network, provisioned, then moved to the host-only network before any prompt.
        self.assertEqual(self.vm.log[0], ('isolated network',))
        self.assertEqual(self.vm.log[1], ('create', 2, 4, vmenv.SETUP_NETWORK))
        order = [e[0] for e in self.vm.log]
        self.assertLess(order.index('switch'), next(i for i, e in enumerate(self.vm.log) if e[0] == 'pull'))
        provision = self.vm.scripts[0][1]
        self.assertIn('tailscaled', provision)
        self.assertIn(Path(ws['integration']['path']).parent.as_posix(), provision)
        self.assertEqual(self.vm.copied[0][1], '/tmp/opencode')
        # The file was written inside the VM and reached the worktree only through the copy back.
        agent_dir = Path(ws['agents']['coder-1']['dir'])
        self.assertEqual((self.vm.inside(agent_dir) / 'a.txt').read_text().split(' for ')[0], 'made in the VM')
        self.assertTrue((Path(ws['integration']['dir']) / 'a.txt').exists())
        # The verifier ran inside the VM, on the integration folder.
        verify = [e for e in self.vm.log if e[0] == 'exec']
        self.assertEqual(verify[0][1], ws['integration']['dir'])
        self.assertEqual(result['vm']['state'], 'stopped', 'stopped when the run ended')
        self.assertEqual(result['vm']['network_state'], 'none')
        # The clone's disk lives next to the baseline (QEMU can reach it), not in AgentControl's state folder.
        self.assertEqual(result['vm']['storage'], str(self.settings.vm_baseline.resolve().parent / 'agentcontrol-runs' / run['id']))
        actions = [e['action'] for e in c.store.audit(run['id'])]
        self.assertIn('vm created', actions)
        self.assertIn('vm network cut', actions)
        c.control(run['id'], 'apply')
        self.assertEqual(self.vm.log[-1], ('remove',))
        self.assertEqual(c.store.get('runs', run['id'])['vm']['state'], 'removed')

    def test_internet_while_working_keeps_the_nat_and_needs_confirmation(self):
        c = self.controller([{'action': 'code', 'title': 't', 'summary': 's', 'prompt': 'CREATE a.txt'}, complete()])
        with self.assertRaisesRegex(ValueError, 'type approve'):
            c.new('Build it', isolation='vm', network='internet')
        run = c.new('Build it', isolation='vm', network='internet', confirm='approve')
        self.assertEqual(self.done(run['id'])['status'], 'completed')
        self.assertNotIn('switch', [e[0] for e in self.vm.log])

    def test_the_disk_folder_can_be_chosen(self):
        self.settings.vm_storage = Path(self.temp.name) / 'vmdisks'
        c = self.controller([complete()])
        run = c.new('Build it', isolation='vm', network='none')
        self.assertEqual(run['vm']['storage'], str(Path(self.temp.name) / 'vmdisks' / run['id']))
        self.done(run['id'])

    def test_unavailable_vms_are_refused_with_the_reason(self):
        c = self.controller([], reason='/dev/kvm is missing: enable virtualization')
        with self.assertRaisesRegex(ValueError, '/dev/kvm is missing'):
            c.new('Build it', isolation='vm')
        self.assertIn('/dev/kvm', c.state()['vm_env']['unavailable'])

    def test_console_input_is_checked_and_audited(self):
        c = self.controller([{'action': 'code', 'title': 't', 'summary': 's', 'prompt': 'CREATE a.txt'}, complete()])
        run = c.new('Build it', isolation='vm', network='none')
        self.done(run['id'])
        c.control(run['id'], 'container_start')
        until = time.monotonic() + 5
        while self.vm.status != 'running' and time.monotonic() < until:
            time.sleep(.02)
        self.assertTrue(c.vm_console(run['id']).startswith(b'\x89PNG'))
        c.vm_input(run['id'], 'click', x=10, y=5, width=640, height=400)
        c.vm_input(run['id'], 'type', text='ls')
        c.vm_input(run['id'], 'key', key='Return')
        with self.assertRaisesRegex(ValueError, 'inside the screen'):
            c.vm_input(run['id'], 'click', x=900, y=5, width=640, height=400)
        self.assertEqual(self.vm.log[-3:], [('click', 10, 5, 640, 400), ('type', 'ls'), ('key', 'Return')])
        audit = [e['action'] for e in c.store.audit(run['id'])]
        self.assertEqual(audit.count('vm console type'), 1)
        self.assertNotIn('ls', json.dumps([e for e in c.store.audit(run['id']) if e['action'] == 'vm console type']), 'what you type is not logged')


if __name__ == '__main__':
    unittest.main()
