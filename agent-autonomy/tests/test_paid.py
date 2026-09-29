"""Optional paid models (M12): chosen per run and per role, with the typed confirmation and a spend
cap, enforced at the gateway (the only place paid calls leave from), and reported as cost.

The two upstreams are ai-arch's scripted mock endpoint: one plays your local llama-server, the
other a paid provider. Nothing here reaches the internet."""
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import gateway
from engine import Controller, Settings
from test_models import mock, opener
from test_workflow import FakeAPI, FakeManager, coding, complete


class RecordingMock(mock.Handler):
    """Keeps what each upstream received: the model asked for and whether a key came with it."""
    seen = []

    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(length)
        type(self).seen.append({'port': self.server.server_port, 'model': json.loads(raw).get('model'),
                                'auth': self.headers.get('Authorization'), 'usage': json.loads(raw).get('usage')})
        self.rfile = __import__('io').BytesIO(raw)
        self.headers.replace_header('Content-Length', str(len(raw)))
        super().do_POST()


class PaidModelTests(unittest.TestCase):
    def setUp(self):
        RecordingMock.seen = []
        self.local = ThreadingHTTPServer(('127.0.0.1', 0), RecordingMock)
        self.paid = ThreadingHTTPServer(('127.0.0.1', 0), RecordingMock)
        for server in (self.local, self.paid):
            threading.Thread(target=server.serve_forever, daemon=True).start()
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        (root / 'project').mkdir()
        secrets = root / 'aiarch' / 'secrets'
        secrets.mkdir(parents=True)
        (secrets / 'router-key').write_text('sk-test-secret\n')
        os.chmod(secrets / 'router-key', 0o600)
        self.old_data = os.environ.get('AIARCH_DATA_DIR')
        os.environ['AIARCH_DATA_DIR'] = str(root / 'aiarch')
        (root / 'state').mkdir()
        (root / 'state' / 'models.json').write_text(json.dumps({'default': 'local', 'monthly_cap': 50, 'endpoints': [
            {'id': 'local', 'url': f'http://127.0.0.1:{self.local.server_port}', 'model': 'mock-model'},
            {'id': 'router', 'url': f'http://127.0.0.1:{self.paid.server_port}', 'model': 'vendor/big-model', 'paid': True,
             'api_key_ref': 'router-key', 'cost_per_mtok_in': 3.0, 'cost_per_mtok_out': 15.0, 'slots': 4}]}))
        self.settings = Settings(root / 'project', root / 'state', poll=.01, notifications=False, run_timeout=60)
        self.api = FakeAPI(root / 'project')
        self.c = None
        self.servers = []

    def tearDown(self):
        if self.c:
            self.c.shutdown.set()
            for thread in list(self.c.threads.values()):
                thread.join(3)
            self.c.preview.close()
        for server in self.servers + [self.local, self.paid]:
            server.shutdown()
            server.server_close()
        if self.old_data is None:
            os.environ.pop('AIARCH_DATA_DIR', None)
        else:
            os.environ['AIARCH_DATA_DIR'] = self.old_data
        self.temp.cleanup()

    def controller(self, decisions=None):
        self.api.hold = True
        self.c = Controller(self.settings, self.api, FakeManager(decisions or [coding(), complete()]))
        self.c.check()
        return self.c

    def serve(self, run_id):
        server = gateway.serve(self.c.broker, self.c.store.usage_add, lambda: run_id, 0, authorize=self.c.authorize_paid)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.servers.append(server)
        self.c.gateway_info = {'port': server.server_port}
        return f'http://127.0.0.1:{server.server_port}'

    def chat(self, base, model, agent='opencode'):
        body = json.dumps({'model': model, 'stream': True, 'messages': [{'role': 'user', 'content': 'hi'}]}).encode()
        request = urllib.request.Request(f'{base}/agent/{agent}/v1/chat/completions', body, {'Content-Type': 'application/json'})
        with opener().open(request, timeout=20) as response:
            return response.status, response.read().decode()

    def test_paid_choice_needs_confirmation_and_a_cap(self):
        c = self.controller()
        self.serve(None)
        options = c.model_options()
        self.assertEqual([e['id'] for e in options['endpoints']], ['router'])
        self.assertEqual(options['unavailable']['coder'], '')
        self.assertIn('--hermes-provider', options['unavailable']['orchestrator'])
        with self.assertRaisesRegex(ValueError, 'spend cap'):
            c.new('Build it', models={'coder': 'router'}, confirm='approve')
        with self.assertRaisesRegex(ValueError, 'type approve'):
            c.new('Build it', models={'coder': 'router'}, spend_cap=1.0)
        with self.assertRaisesRegex(ValueError, 'Unknown model endpoint'):
            c.new('Build it', models={'coder': 'elsewhere'})
        with self.assertRaisesRegex(ValueError, 'gateway'):
            c.new('Build it', models={'orchestrator': 'router'}, spend_cap=1.0, confirm='approve')
        run = c.new('Build it', models={'coder': 'router', 'reviewer': 'local'}, spend_cap=0.5, confirm='approve')
        self.assertEqual((run['models'], run['spend_cap']), ({'coder': 'router'}, 0.5))
        self.assertTrue(any(e['action'] == 'models chosen' for e in c.store.audit(run['id'])))

    def test_no_gateway_means_no_other_models_for_host_opencode(self):
        c = self.controller()
        self.assertIn('--gateway-port', c.model_options()['unavailable']['coder'])
        self.assertEqual(c.model_options('container')['unavailable']['coder'], '')

    def test_coder_prompt_names_its_model_and_the_gateway_routes_it_with_the_key(self):
        c = self.controller()
        base = self.serve(None)
        run = c.new('Build it', models={'coder': 'router'}, spend_cap=1.0, confirm='approve')
        until = time.monotonic() + 5
        while not self.api.prompts and time.monotonic() < until:
            time.sleep(.02)
        self.assertEqual(self.api.prompts[0]['model'], {'providerID': 'agentcontrol', 'modelID': 'router'})
        self.servers[-1].shutdown()
        base = self.serve(run['id'])
        status, text = self.chat(base, 'router')
        self.assertEqual(status, 200)
        paid = [s for s in RecordingMock.seen if s['port'] == self.paid.server_port]
        self.assertEqual((paid[0]['model'], paid[0]['auth']), ('vendor/big-model', 'Bearer sk-test-secret'))
        row = c.store.usage(run['id'])[-1]
        self.assertEqual((row['endpoint'], row['tokens_in'], row['tokens_out']), ('router', 8, 5))
        self.assertAlmostEqual(row['cost'], 8 / 1e6 * 3 + 5 / 1e6 * 15)
        self.assertNotIn('sk-test-secret', json.dumps(c.store.usage(run['id'])) + json.dumps(c.state(run['id'])))
        # The local model is untouched and free.
        self.chat(base, 'mock-model')
        local = [s for s in RecordingMock.seen if s['port'] == self.local.server_port]
        self.assertEqual((local[0]['model'], local[0]['auth']), ('mock-model', None))
        self.assertEqual(c.store.usage(run['id'])[-1]['cost'], 0.0)

    def test_paid_calls_are_refused_unless_the_run_chose_them(self):
        c = self.controller()
        self.serve(None)
        run = c.new('Build it')
        base = self.serve(run['id'])
        with self.assertRaises(urllib.error.HTTPError) as err:
            self.chat(base, 'router')
        self.assertEqual(err.exception.code, 402)
        self.assertIn('did not allow router', json.load(err.exception)['error']['message'])
        self.assertEqual([s for s in RecordingMock.seen if s['port'] == self.paid.server_port], [], 'nothing reached the provider')
        self.assertEqual(c.store.usage(run['id'])[-1]['status'], 'refused')

    def test_the_cap_pauses_the_run_and_raising_it_needs_the_confirmation(self):
        c = self.controller()
        self.serve(None)
        run = c.new('Build it', models={'coder': 'router'}, spend_cap=0.01, confirm='approve')
        base = self.serve(run['id'])
        c.store.usage_add({'run': run['id'], 'agent': 'opencode', 'source': 'gateway', 'endpoint': 'router', 'cost': 0.011})
        with self.assertRaises(urllib.error.HTTPError) as err:
            self.chat(base, 'router')
        self.assertEqual(err.exception.code, 402)
        state = c.store.get('runs', run['id'])
        self.assertTrue(state['pause'])
        self.assertIn('Spend cap reached ($0.0110 of $0.01)', state['summary'])
        self.assertEqual(c.spend_status(state)['run'], 0.011)
        with self.assertRaisesRegex(ValueError, 'type approve'):
            c.set_models(run['id'], spend_cap=0.05)
        c.set_models(run['id'], spend_cap=0.05, confirm='approve')
        self.assertEqual(self.chat(base, 'router')[0], 200)
        # Switching the role back to your local model needs no confirmation and removes the cap.
        c.set_models(run['id'], models={'coder': None})
        self.assertEqual((c.store.get('runs', run['id'])['models'], c.store.get('runs', run['id'])['spend_cap']), ({}, None))

    def test_monthly_cap_applies_across_runs(self):
        c = self.controller()
        self.serve(None)
        run = c.new('Build it', models={'coder': 'router'}, spend_cap=100, confirm='approve')
        base = self.serve(run['id'])
        c.store.usage_add({'run': 'older-run', 'agent': 'opencode', 'source': 'gateway', 'endpoint': 'router', 'cost': 50.0})
        with self.assertRaises(urllib.error.HTTPError) as err:
            self.chat(base, 'router')
        self.assertIn('Monthly spend cap reached', json.load(err.exception)['error']['message'])

    def test_usage_report_and_reported_cost(self):
        c = self.controller()
        self.serve(None)
        run = c.new('Build it', models={'coder': 'router'}, spend_cap=1, confirm='approve')
        base = self.serve(run['id'])
        self.chat(base, 'router')
        self.chat(base, 'mock-model')
        report = c.usage_report('month')
        by_endpoint = {r['endpoint']: r for r in report['rows'] if r['run'] == run['id']}
        self.assertTrue(by_endpoint['router']['paid'])
        self.assertFalse(by_endpoint['local']['paid'])
        self.assertEqual(report['total']['calls'], 2)
        self.assertEqual(report['monthly_cap'], 50)
        self.assertEqual(gateway.cost_from({'usage': {'prompt_tokens': 1, 'cost': 0.0021}}), 0.0021)
        self.assertIsNone(gateway.cost_from({'usage': {'cost': 'free'}}))
        watcher = gateway.SseUsage()
        watcher.feed(b'data: {"usage":{"prompt_tokens":3,"completion_tokens":2,"cost":0.5}}\n\ndata: [DONE]\n\n')
        self.assertEqual((watcher.tokens, watcher.cost, watcher.done), ((3, 2), 0.5, True))

    def test_hermes_uses_the_chosen_model_through_its_gateway_provider(self):
        self.settings.hermes_provider = 'agentcontrol'
        c = self.controller()
        self.serve(None)
        run = c.new('Build it', models={'orchestrator': 'router'}, spend_cap=1, confirm='approve')
        until = time.monotonic() + 5
        while not c.manager.calls and time.monotonic() < until:
            time.sleep(.02)
        self.assertEqual(c.manager.routes, {'orchestrator': ['--provider', 'agentcontrol', '-m', 'router']})


if __name__ == '__main__':
    unittest.main()
