"""End to end (M10): a run whose agent works inside a real container.

Real: the container runtime, the agent image, OpenCode inside the container, the Unix-socket
bridge, AgentControl's per-run model gateway, worktrees, verification inside the container,
the network cut, and a desktop preview drawn and clicked inside the container.
Scripted: the model (as in test_team_e2e) and Hermes.

Opt-in, because it creates containers: set AGENTCONTROL_CONTAINER_TESTS=1 (and DOCKER_HOST if
your daemon is not the default). The agent image must be built.
"""
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from engine import Controller, Settings
import sandbox
from test_team import FakeTeamManager
from test_team_e2e import ScriptedModel
from test_workflow import complete
from test_workspaces import make_repo

ENABLED = os.environ.get('AGENTCONTROL_CONTAINER_TESTS') == '1'
INFO = sandbox.detect() if ENABLED else {}


@unittest.skipUnless(ENABLED and INFO.get('runtime') and INFO.get('image'), 'set AGENTCONTROL_CONTAINER_TESTS=1 with a runtime and the agent image')
class ContainerRunE2E(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir='/tmp')
        root = Path(self.temp.name)
        self.repo = make_repo(root)
        self.model = ScriptedModel(delay=0)
        state = root / 'state'
        state.mkdir()
        (state / 'models.json').write_text(json.dumps({'endpoints': [{'id': 'scripted', 'url': f'http://127.0.0.1:{self.model.port}', 'model': 'm'}]}))
        self.settings = Settings(self.repo, state, poll=.2, notifications=False, run_timeout=600,
                                 allow_rootful_containers=not INFO.get('rootless'))
        self.c = None

    def tearDown(self):
        if self.c:
            self.c.shutdown.set()
            for thread in list(self.c.threads.values()):
                thread.join(10)
            for run in self.c.store.runs():
                if run.get('container'):
                    sandbox.Sandbox(run['container']['runtime']).remove(run['container']['name'])
            for server in list(self.c.run_gateways.values()):
                server.shutdown()
                server.server_close()
            self.c.preview.close()
        self.model.server.shutdown()
        self.temp.cleanup()

    def wait(self, condition, timeout=180):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            if condition():
                return
            time.sleep(.3)
        self.fail('timed out')

    def test_agent_works_in_a_locked_down_container(self):
        check = "python3 -c \"import pathlib,sys; sys.exit(0 if pathlib.Path('hello.txt').exists() else 1)\""
        c = self.c = Controller(self.settings, None, FakeTeamManager([], [{'action': 'code', 'title': 't', 'summary': 's', 'prompt': 'CREATE hello.txt'}, complete()]))
        c.health = {'ready': True, 'message': 'container test', 'agents': {}}  # no OpenCode on the host is needed
        run = c.new('Say hello', check, isolation='container', cpus=1, memory_gb=2, network='none',
                    preview={'mode': 'desktop', 'command': 'sleep 600', 'width': 320, 'height': 240})
        ident = run['id']
        # OpenCode inside asks before editing (your approval rules apply in the container too); approve as you would.
        self.wait(lambda: bool(c.state(ident)['inbox']) or c.store.get('runs', ident)['status'] in ('failed', 'attention'), 150)
        inbox = c.state(ident)['inbox']
        if inbox:
            self.assertEqual((inbox[0]['permission'], inbox[0]['risk']['level']), ('edit', 'R2'))
            c.review(ident, 'permission', inbox[0]['request_id'], inbox[0]['fingerprint'], 'approve')
        try:
            self.wait(lambda: c.store.get('runs', ident)['status'] in ('completed', 'failed', 'attention', 'blocked'), 150)
        except AssertionError:
            box = c.store.get('runs', ident)['container']
            logs = sandbox.run_cli([box['runtime'], 'logs', '--tail', '40', box['name']])
            steps = [(x['status'], x.get('result', '')[:200]) for x in c.store.steps(ident)]
            self.fail(f'timed out; model requests={self.model.requests} usage={c.store.usage(ident)} steps={steps}\n'
                      + '\n'.join(f"{e['kind']}: {e['detail'][:200]}" for e in c.store.events(ident)[-12:])
                      + '\nCONTAINER LOGS:\n' + '\n'.join(l for l in (logs[1] + logs[2]).splitlines() if 'models.dev' not in l)[-3000:])
        result = c.store.get('runs', ident)
        events = [f"{e['kind']}: {e['detail'][:200]}" for e in c.store.events(ident)]
        if result['status'] != 'completed':
            logs = sandbox.run_cli([result['container']['runtime'], 'logs', '--tail', '60', result['container']['name']])
            self.fail(f"{result['summary']}\n" + '\n'.join(events[-15:]) + '\nCONTAINER LOGS:\n' + (logs[1] + logs[2])[-4000:])
        ws, box = result['workspace'], result['container']
        # The agent wrote in its worktree (through OpenCode inside the container), your checkout is untouched.
        self.assertEqual((Path(ws['integration']['dir']) / 'hello.txt').read_text(), 'created for hello.txt\n')
        self.assertFalse((self.repo / 'hello.txt').exists())
        self.assertEqual(self.model.creates, ['hello.txt'])
        usage = c.store.usage_summary(ident)['by_agent']
        self.assertIn('opencode', usage, 'model calls went through the run gateway and were recorded')
        runtime = sandbox.Sandbox(box['runtime'])
        self.assertEqual(runtime.state(box['name']), 'running', 'kept running for the preview')
        # No internet inside.
        code, out, err = runtime.exec(box['name'], ['python3', '-c', "import urllib.request; urllib.request.urlopen('https://example.com', timeout=5)"],
                                      ws['integration']['dir'], 30)
        self.assertNotEqual(code, 0)
        self.assertEqual(runtime.networks(box['name']), ['none'])
        # Locked down.
        code, out, _ = runtime.exec(box['name'], ['sh', '-c', 'grep CapEff /proc/self/status; touch /usr/x 2>&1 || true'], '/', 30)
        self.assertIn('0000000000000000', out)
        self.assertIn('Read-only file system', out)
        # The desktop preview runs in the container: a real frame, and clicks go through.
        self.wait(lambda: c.preview.status()['state'] == 'running', 60)
        frame = c.preview.frame()
        self.assertTrue(frame.startswith(b'\x89PNG'))
        c.preview.click(10, 10)
        c.preview.stop()
        code, out, _ = runtime.exec(box['name'], ['sh', '-c', 'pgrep -x sleep || echo none'], '/', 30)
        self.assertIn('none', out, 'stopping the preview ends it inside the container')
        c.control(ident, 'apply')
        self.assertEqual(runtime.state(box['name']), 'missing')
        self.assertTrue((self.repo / 'hello.txt').exists())


if __name__ == '__main__':
    unittest.main()
