"""End to end (M12) on a real `opencode serve`: a coder on a per-run "paid" model routed through
AgentControl's gateway (cost recorded, key added upstream only), then a reviewer Hermes delegates,
which gets no change tools: a write it attempts never lands.

Real: OpenCode, its per-prompt model and tools switches, the gateway, the journal, worktrees.
Scripted: both models (test_team_e2e.ScriptedModel) and Hermes. Skipped without an OpenCode binary.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import gateway
from engine import Controller, Settings
from test_specialists import ResearchManager
from test_team_e2e import OPENCODE, ScriptedModel, free_port
from test_workflow import coding, complete
from test_workspaces import make_repo


@unittest.skipUnless(OPENCODE and Path(OPENCODE).exists(), 'needs an OpenCode binary (set OPENCODE_BIN)')
class RolesOnRealOpenCode(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.repo = make_repo(root)
        self.local, self.paid = ScriptedModel(delay=0), ScriptedModel(delay=0)
        secrets = root / 'aiarch' / 'secrets'
        secrets.mkdir(parents=True)
        (secrets / 'router-key').write_text('sk-e2e')
        os.chmod(secrets / 'router-key', 0o600)
        self.old = os.environ.get('AIARCH_DATA_DIR')
        os.environ['AIARCH_DATA_DIR'] = str(root / 'aiarch')
        state = root / 'state'
        state.mkdir()
        (state / 'models.json').write_text(json.dumps({'default': 'local', 'endpoints': [
            {'id': 'local', 'url': f'http://127.0.0.1:{self.local.port}', 'model': 'm'},
            {'id': 'router', 'url': f'http://127.0.0.1:{self.paid.port}', 'model': 'm', 'paid': True, 'api_key_ref': 'router-key',
             'cost_per_mtok_in': 3.0, 'cost_per_mtok_out': 15.0, 'slots': 2}]}))
        self.settings = Settings(self.repo, state, poll=.2, notifications=False, run_timeout=600, research_toolsets=('web',))
        self.gateway_port = free_port()
        home = root / 'home'
        (home / '.config' / 'opencode').mkdir(parents=True)
        model = {'name': 'm', 'tool_call': True}
        (home / '.config' / 'opencode' / 'opencode.json').write_text(json.dumps({
            'provider': {'mock': {'npm': '@ai-sdk/openai-compatible', 'name': 'Local', 'models': {'m': model},
                                  'options': {'baseURL': f'http://127.0.0.1:{self.local.port}/v1', 'apiKey': 'x'}},
                         'agentcontrol': {'npm': '@ai-sdk/openai-compatible', 'name': 'AgentControl', 'models': {'router': model, 'local': model},
                                          'options': {'baseURL': f'http://127.0.0.1:{self.gateway_port}/agent/opencode/v1', 'apiKey': 'none'}}},
            'model': 'mock/m', 'small_model': 'mock/m',
            'permission': {'edit': 'allow', 'bash': 'allow', 'external_directory': 'allow'}}))
        port = free_port()
        env = dict(os.environ, HOME=str(home), XDG_CONFIG_HOME=str(home / '.config'))
        self.server = subprocess.Popen([OPENCODE, 'serve', '--port', str(port)], cwd=self.repo, env=env,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        self.url = f'http://127.0.0.1:{port}'
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        until = time.monotonic() + 90
        while time.monotonic() < until:
            try:
                opener.open(self.url + '/global/health', timeout=2)
                break
            except OSError:
                time.sleep(.3)
        else:
            self.fail('opencode serve did not start')
        self.settings.opencode_url = self.url
        self.c = None
        self.gw = None

    def tearDown(self):
        if self.c:
            self.c.shutdown.set()
            for thread in list(self.c.threads.values()):
                thread.join(5)
            self.c.preview.close()
        if self.gw:
            self.gw.shutdown()
            self.gw.server_close()
        self.server.terminate()
        try:
            self.server.wait(10)
        except subprocess.TimeoutExpired:
            self.server.kill()
        for m in (self.local, self.paid):
            m.server.shutdown()
        if self.old is None:
            os.environ.pop('AIARCH_DATA_DIR', None)
        else:
            os.environ['AIARCH_DATA_DIR'] = self.old
        self.temp.cleanup()

    def test_paid_coder_and_read_only_reviewer(self):
        review = {'action': 'delegate', 'role': 'reviewer', 'summary': 'Review it', 'title': 'Review api.py',
                  'prompt': 'Review api.py for bugs. CREATE stray.txt'}
        manager = ResearchManager([], [coding('CREATE api.py'), review, complete()])
        c = self.c = Controller(self.settings, None, manager)
        self.assertTrue(c.check()['ready'])
        self.gw = gateway.serve(c.broker, c.store.usage_add, lambda: next((r['id'] for r in c.store.runs() if r['status'] not in
                                ('completed', 'failed', 'stopped', 'blocked', 'limit_reached')), None), self.gateway_port, authorize=c.authorize_paid)
        threading.Thread(target=self.gw.serve_forever, daemon=True).start()
        c.gateway_info = {'port': self.gateway_port}
        run = c.new('Build an API', models={'coder': 'router'}, spend_cap=1.0, confirm='approve')
        ident = run['id']
        until = time.monotonic() + 240
        while time.monotonic() < until and c.store.get('runs', ident)['status'] not in ('completed', 'failed', 'blocked', 'attention', 'limit_reached'):
            time.sleep(.3)
        result = c.store.get('runs', ident)
        steps = c.store.steps(ident)
        detail = [(s.get('role'), s['status'], s.get('result', '')[:200]) for s in steps]
        self.assertEqual(result['status'], 'completed', f"{result['summary']} {detail}")
        # The coder's turn went to the "paid" model through the gateway, and cost was recorded.
        self.assertEqual(self.paid.creates, ['api.py'])
        paid_rows = [u for u in c.store.usage(ident) if u['source'] == 'gateway' and u['endpoint'] == 'router' and u['status'] == 'ok']
        self.assertTrue(paid_rows, c.store.usage(ident))   # (the scripted model reports no tokens, so cost is 0 here; see test_paid)
        self.assertFalse([u for u in c.store.usage(ident) if u['source'] == 'gateway' and u['endpoint'] == 'local'], 'the coder never used the local model')
        self.assertTrue((Path(result['workspace']['integration']['dir']) / 'api.py').exists())
        # The reviewer ran on your local model and had no way to write: its attempted write never landed.
        self.assertEqual([s.get('role') or 'coder' for s in steps], ['coder', 'reviewer'])
        self.assertIn('stray.txt', self.local.creates, 'the scripted reviewer did try to write')
        reviewer_dir = Path(result['workspace']['agents']['reviewer-1']['dir'])
        self.assertFalse((reviewer_dir / 'stray.txt').exists())
        self.assertFalse((Path(result['workspace']['integration']['dir']) / 'stray.txt').exists())
        self.assertEqual(c.spend_status(result)['cap'], 1.0)


if __name__ == '__main__':
    unittest.main()
