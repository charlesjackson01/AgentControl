"""End to end (M13) on your server: a run whose agent works inside a real KVM clone of your ai-arch
baseline. Real: libvirt, the clone and its provisioning, SSH transport and file snapshots, OpenCode
in the VM, the run's model gateway, the network cut, and the console. Scripted: the model and Hermes.

Opt-in (it boots a VM):
    AGENTCONTROL_VM_TESTS=1 AGENTCONTROL_VM_BASELINE=~/ai-arch/vms/ai-arch-baseline-with-tailscale.qcow2 \\
        python3 -m unittest tests.test_vm_e2e           # from agent-autonomy/
Optional: AGENTCONTROL_VM_TEMPLATE (default ai-arch-dev), AGENTCONTROL_VM_SSH_KEY (default ~/.ssh/ai-arch-dev_ed25519, else ~/.ssh/id_ed25519),
OPENCODE_BIN (default: opencode on PATH). The first run installs packages in the clone, so it needs internet.
"""
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from engine import Controller, Settings
import vmenv
from test_team import FakeTeamManager
from test_team_e2e import ScriptedModel
from test_workflow import complete
from test_workspaces import make_repo

ENABLED = os.environ.get('AGENTCONTROL_VM_TESTS') == '1'
BASELINE = Path(os.environ.get('AGENTCONTROL_VM_BASELINE', '')).expanduser() if os.environ.get('AGENTCONTROL_VM_BASELINE') else None
TEMPLATE = os.environ.get('AGENTCONTROL_VM_TEMPLATE', 'ai-arch-dev')
KEY = Path(os.environ['AGENTCONTROL_VM_SSH_KEY']).expanduser() if os.environ.get('AGENTCONTROL_VM_SSH_KEY') else vmenv.default_key()
OPENCODE = os.environ.get('OPENCODE_BIN') or shutil.which('opencode')
INFO = vmenv.detect('qemu:///system', BASELINE, TEMPLATE, KEY) if ENABLED else {'reason': 'disabled'}


@unittest.skipUnless(ENABLED and not INFO['reason'] and OPENCODE, f"set AGENTCONTROL_VM_TESTS=1 on a KVM host ({INFO['reason']})")
class VMRunE2E(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path.home())   # VM paths mirror host paths; keep them short and yours
        root = Path(self.temp.name)
        self.repo = make_repo(root)
        self.model = ScriptedModel(delay=0)
        state = root / 'state'
        state.mkdir()
        (state / 'models.json').write_text(json.dumps({'endpoints': [{'id': 'scripted', 'url': f'http://127.0.0.1:{self.model.port}', 'model': 'm'}]}))
        self.settings = Settings(self.repo, state, poll=.5, notifications=False, run_timeout=1800, vm_baseline=BASELINE,
                                 vm_template=TEMPLATE, vm_ssh_key=KEY, vm_opencode=Path(OPENCODE))
        self.c = None
        self.baseline_mtime = BASELINE.stat().st_mtime

    def tearDown(self):
        if self.c:
            self.c.shutdown.set()
            for thread in list(self.c.threads.values()):
                thread.join(10)
            for run in self.c.store.runs():
                if run.get('vm') and run['vm'].get('state') != 'removed':
                    self.c._vm(run).remove()
            for server in list(self.c.run_gateways.values()):
                server.shutdown()
                server.server_close()
            self.c.preview.close()
        self.model.server.shutdown()
        self.temp.cleanup()

    def wait(self, condition, timeout):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            if condition():
                return
            time.sleep(1)
        self.fail('timed out')

    def test_agent_works_in_a_kvm_clone(self):
        check = "python3 -c \"import pathlib,sys; sys.exit(0 if pathlib.Path('hello.txt').exists() else 1)\""
        c = self.c = Controller(self.settings, None, FakeTeamManager([], [{'action': 'code', 'title': 't', 'summary': 's', 'prompt': 'CREATE hello.txt'}, complete()]))
        c.health = {'ready': True, 'message': 'vm test', 'agents': {}}
        run = c.new('Say hello', check, isolation='vm', cpus=2, memory_gb=4, network='setup')
        ident = run['id']
        terminal = ('completed', 'failed', 'attention', 'blocked')
        # OpenCode in the VM asks before editing if your OpenCode config says so; approve as you would.
        self.wait(lambda: bool(c.state(ident)['inbox']) or c.store.get('runs', ident)['status'] in terminal, 900)
        for request in c.state(ident)['inbox']:
            c.review(ident, 'permission', request['request_id'], request['fingerprint'], 'approve', confirm='approve')
        self.wait(lambda: c.store.get('runs', ident)['status'] in terminal, 600)
        result = c.store.get('runs', ident)
        events = '\n'.join(f"{e['kind']}: {str(e['detail'])[:200]}" for e in c.store.events(ident)[-15:])
        self.assertEqual(result['status'], 'completed', result['summary'] + '\n' + events)
        ws, v = result['workspace'], result['vm']
        self.assertEqual((Path(ws['integration']['dir']) / 'hello.txt').read_text(), 'created for hello.txt\n')
        self.assertFalse((self.repo / 'hello.txt').exists())
        self.assertEqual(v['network_state'], 'none')
        self.assertIn('vm network cut', [e['action'] for e in c.store.audit(ident)])
        # Start it again to look inside: host-only network, no sudo for agents, Tailscale off, a console.
        c.control(ident, 'container_start')
        self.wait(lambda: c.vm_status(c.store.get('runs', ident))['live'] == 'running' and c.store.get('runs', ident)['vm']['state'] == 'running', 300)
        vm = c._vm(c.store.get('runs', ident))
        code, _, _ = vm.exec(['python3', '-c', "import urllib.request; urllib.request.urlopen('https://example.com', timeout=5)"], '/', 60)
        self.assertNotEqual(code, 0, 'no internet from inside')
        code, _, _ = vm.exec(['sudo', '-n', 'true'], '/', 30)
        self.assertNotEqual(code, 0, 'the agent user has no sudo')
        code, out, _ = vm.exec(['systemctl', 'is-active', 'tailscaled'], '/', 30)
        self.assertNotEqual(out.strip(), 'active', 'the clone is not on your tailnet')
        png = c.vm_console(ident)
        self.assertTrue(png.startswith(b'\x89PNG'))
        width, height = vmenv.png_size(png)
        c.vm_input(ident, 'click', x=width // 2, y=height // 2, width=width, height=height)
        c.vm_input(ident, 'key', key='Return')
        c.control(ident, 'container_stop')
        c.control(ident, 'apply')
        self.assertEqual(vm.state(), 'missing')
        self.assertTrue((self.repo / 'hello.txt').exists())
        self.assertEqual(BASELINE.stat().st_mtime, self.baseline_mtime, 'the baseline was only read')


if __name__ == '__main__':
    unittest.main()
