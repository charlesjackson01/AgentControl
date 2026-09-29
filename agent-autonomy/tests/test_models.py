"""Model registry, health, slot broker, gateway, and usage (M5).
The upstream model server is ai-arch's scripted mock endpoint (ai-arch/tests/mock-endpoint)."""
import importlib.util
import json
import os
from pathlib import Path
import socket
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
import app
import gateway
import models
from adapters.hermes import usage_of
from engine import Controller, Settings
from journal import Store
from test_workflow import FakeAPI, FakeManager, coding, complete

MOCK = Path(__file__).resolve().parents[2] / 'ai-arch' / 'tests' / 'mock-endpoint' / 'server.py'
spec = importlib.util.spec_from_file_location('ai_arch_mock_endpoint', MOCK)
mock = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mock)


class CountingMock(mock.Handler):
    """The ai-arch mock, counting how many completions run at the same time."""
    lock = threading.Lock()
    current = 0
    peak = 0
    order = []

    def log_message(self, *args):
        pass

    def do_POST(self):
        cls = type(self)
        with cls.lock:
            cls.current += 1
            cls.peak = max(cls.peak, cls.current)
            cls.order.append(self.headers.get('X-Test-Name', ''))
        try:
            super().do_POST()
        finally:
            with cls.lock:
                cls.current -= 1


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def opener():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


class RegistryTests(unittest.TestCase):
    def test_parses_registry_and_defaults(self):
        reg = models.parse_registry({'endpoints': [{'id': 'local', 'url': 'http://127.0.0.1:8080/', 'slots': 2, 'model': 'qwen'}]})
        self.assertEqual(reg['default'], 'local')
        self.assertEqual(reg['endpoints'][0]['url'], 'http://127.0.0.1:8080')
        self.assertEqual((reg['endpoints'][0]['slots'], reg['endpoints'][0]['paid']), (2, False))

    def test_an_ai_arch_config_becomes_one_endpoint(self):
        aiarch = json.loads((MOCK.parents[2] / 'src' / 'etc' / 'ai-arch.json').read_text())
        reg = models.parse_registry(aiarch)
        self.assertEqual(reg['default'], 'ai-arch')
        self.assertEqual(reg['endpoints'][0]['api_key_ref'], 'ai-arch/endpoint-key')
        self.assertEqual(reg['endpoints'][0]['slots'], 1)

    def test_invalid_registries_are_refused(self):
        bad = [{'endpoints': [{'id': 'x', 'url': 'ftp://h'}]},
               {'endpoints': [{'id': 'x', 'url': 'http://h', 'slots': 0}]},
               {'endpoints': [{'id': 'x', 'url': 'http://h'}, {'id': 'x', 'url': 'http://g'}]},
               {'endpoints': [{'id': 'Bad Id', 'url': 'http://h'}]},
               {'default': 'nope', 'endpoints': [{'id': 'x', 'url': 'http://h'}]},
               {'endpoints': [{'id': 'x', 'url': 'http://h', 'cost_per_mtok_in': -1}]}]
        for data in bad:
            with self.subTest(data), self.assertRaises(models.RegistryError):
                models.parse_registry(data)

    def test_a_paid_provider_cannot_be_the_default(self):
        with self.assertRaises(models.RegistryError):
            models.parse_registry({'endpoints': [{'id': 'openrouter', 'url': 'https://openrouter.ai/api', 'paid': True}]})
        reg = models.parse_registry({'default': 'local', 'endpoints': [{'id': 'local', 'url': 'http://h'},
                                                                        {'id': 'openrouter', 'url': 'https://o', 'paid': True, 'cost_per_mtok_out': 2}]})
        self.assertEqual(models.cost(reg['endpoints'][1], 0, 1_000_000), 2.0)
        self.assertEqual(models.cost(reg['endpoints'][0], 5_000, 5_000), 0.0)

    def test_missing_file_means_model_features_off(self):
        with tempfile.TemporaryDirectory() as temp:
            reg = models.load_registry(Path(temp) / 'models.json')
            self.assertEqual(reg['endpoints'], [])
            self.assertFalse(models.Broker(reg).configured)
            (Path(temp) / 'bad.json').write_text('{nope')
            with self.assertRaises(models.RegistryError):
                models.load_registry(Path(temp) / 'bad.json')


class SecretTests(unittest.TestCase):
    def test_reads_ai_arch_secret_refs_only_when_private(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'ai-arch_endpoint-key'
            path.write_text('sk-test\n')
            os.chmod(path, 0o600)
            self.assertEqual(models.read_secret('ai-arch/endpoint-key', temp), 'sk-test')
            os.chmod(path, 0o644)
            with self.assertRaises(models.RegistryError):
                models.read_secret('ai-arch/endpoint-key', temp)
            with self.assertRaises(models.RegistryError):
                models.read_secret('missing', temp)
            self.assertEqual(models.read_secret('', temp), '')
            # '../' is sanitised, so a ref cannot leave the secret store.
            with self.assertRaises(models.RegistryError):
                models.read_secret('../outside', temp)


class BrokerTests(unittest.TestCase):
    def broker(self, slots=1):
        return models.Broker(models.parse_registry({'endpoints': [{'id': 'local', 'url': 'http://127.0.0.1:1', 'slots': slots}]}))

    def test_one_slot_queues_and_planning_goes_first(self):
        broker, order, release = self.broker(), [], threading.Event()

        def use(name, role, hold=None):
            with broker.slot(agent=name, role=role):
                order.append(name)
                if hold:
                    hold.wait(5)

        first = threading.Thread(target=use, args=('coder-1', 'coder', release))
        first.start()
        while not order:
            time.sleep(.005)
        threads = []
        for n, (name, role) in enumerate((('coder-2', 'coder'), ('coder-3', 'coder'), ('hermes', 'orchestrator')), start=1):
            threads.append(threading.Thread(target=use, args=(name, role)))
            threads[-1].start()
            deadline = time.monotonic() + 5
            while len(broker.status()[0]['queued']) < n and time.monotonic() < deadline:
                time.sleep(.005)  # enqueue in a known order, even on a loaded machine
        status = broker.status()[0]
        self.assertEqual([t['agent'] for t in status['in_flight']], ['coder-1'])
        self.assertEqual([t['agent'] for t in status['queued']], ['hermes', 'coder-2', 'coder-3'])
        release.set()
        for t in [first] + threads:
            t.join(5)
        self.assertEqual(order, ['coder-1', 'hermes', 'coder-2', 'coder-3'])
        self.assertEqual(broker.status()[0]['queued'], [])

    def test_slots_limit_concurrency(self):
        broker, lock, state = self.broker(slots=2), threading.Lock(), {'now': 0, 'peak': 0}

        def use():
            with broker.slot(agent='coder'):
                with lock:
                    state['now'] += 1
                    state['peak'] = max(state['peak'], state['now'])
                time.sleep(.05)
                with lock:
                    state['now'] -= 1

        threads = [threading.Thread(target=use) for _ in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(5)
        self.assertEqual(state['peak'], 2)

    def test_timeout_and_cancel_leave_the_queue(self):
        broker = self.broker()
        with broker.slot(agent='a'):
            with self.assertRaises(TimeoutError):
                with broker.slot(agent='b', timeout=.1):
                    pass
            with self.assertRaises(InterruptedError):
                with broker.slot(agent='c', cancel=lambda: True):
                    pass
            self.assertEqual(broker.status()[0]['queued'], [])
        with broker.slot(agent='d') as ticket:
            self.assertGreaterEqual(ticket['queued_ms'], 0)

    def test_health_is_cached_and_status_hides_keys(self):
        calls = []
        broker = models.Broker(models.parse_registry({'endpoints': [{'id': 'local', 'url': 'http://h', 'api_key_ref': 'ai-arch/k'}]}),
                               prober=lambda e: calls.append(1) or {'state': 'online', 'latency_ms': 3, 'models': [], 'error': '', 'checked': time.time()})
        broker.health()
        broker.health()
        self.assertEqual(len(calls), 1)
        broker.health(max_age=0)
        self.assertEqual(len(calls), 2)
        status = broker.status()[0]
        self.assertTrue(status['has_key'])
        self.assertNotIn('api_key_ref', status)


class MockServerCase(unittest.TestCase):
    def setUp(self):
        CountingMock.current = CountingMock.peak = 0
        CountingMock.order = []
        self.upstream = ThreadingHTTPServer(('127.0.0.1', 0), CountingMock)
        threading.Thread(target=self.upstream.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{self.upstream.server_port}'

    def tearDown(self):
        self.upstream.shutdown()
        self.upstream.server_close()


class ProbeTests(MockServerCase):
    def test_online_wrong_model_and_offline(self):
        online = models.probe({'id': 'm', 'url': self.url, 'model': 'mock-model', 'api_key_ref': ''})
        self.assertEqual((online['state'], online['models'][:1]), ('online', ['mock-model']))
        wrong = models.probe({'id': 'm', 'url': self.url, 'model': 'qwen-27b', 'api_key_ref': ''})
        self.assertEqual(wrong['state'], 'wrong_model')
        offline = models.probe({'id': 'm', 'url': f'http://127.0.0.1:{free_port()}', 'model': '', 'api_key_ref': ''}, timeout=1)
        self.assertEqual(offline['state'], 'offline')
        self.assertTrue(offline['error'])


class GatewayTests(MockServerCase):
    def setUp(self):
        super().setUp()
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.temp.name) / 'j.sqlite3')
        self.broker = models.Broker(models.parse_registry({'endpoints': [{'id': 'local', 'url': self.url, 'slots': 1, 'model': 'mock-model'}]}))
        self.server = gateway.serve(self.broker, self.store.usage_add, lambda: 'run1', 0)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()
        super().tearDown()

    def chat(self, agent='opencode', script='ok', name=''):
        body = json.dumps({'model': 'mock-model', 'stream': True, 'messages': [{'role': 'user', 'content': 'hi'}]}).encode()
        request = urllib.request.Request(f'{self.base}/agent/{agent}/v1/chat/completions', body,
                                         {'Content-Type': 'application/json', 'X-AIARCH-Script': script, 'X-Test-Name': name})
        with opener().open(request, timeout=20) as response:
            return response.status, response.read().decode()

    def test_streams_through_and_records_usage(self):
        status, text = self.chat()
        self.assertEqual(status, 200)
        self.assertIn('"Hello"', text)
        self.assertIn('data: [DONE]', text)
        rows = self.store.usage('run1')
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual((row['agent'], row['source'], row['tokens_in'], row['tokens_out'], row['status'], row['cost']),
                         ('opencode', 'gateway', 8, 5, 'ok', 0.0))

    def test_model_list_passes_through_without_a_slot_or_usage(self):
        with opener().open(f'{self.base}/agent/hermes/v1/models', timeout=5) as response:
            self.assertEqual(json.load(response)['data'][0]['id'], 'mock-model')
        self.assertEqual(self.store.usage('run1'), [])

    def test_one_slot_means_one_request_upstream_at_a_time(self):
        self.addCleanup(setattr, mock, 'SLOW_DELAY', mock.SLOW_DELAY)
        mock.SLOW_DELAY = 0.05
        results = []
        threads = [threading.Thread(target=lambda n=n: results.append(self.chat(script='slow', name=str(n)))) for n in range(3)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(20)
        self.assertEqual(len(results), 3)
        self.assertEqual(CountingMock.peak, 1)
        rows = self.store.usage('run1')
        self.assertEqual(len(rows), 3)
        self.assertTrue(any(r['queued_ms'] > 0 for r in rows))

    def test_broken_stream_is_recorded(self):
        # fail-midstream closes without [DONE]. The agent sees what arrived, the call is
        # recorded as incomplete, and the slot is free for the next request.
        status, text = self.chat(script='fail-midstream')
        self.assertNotIn('[DONE]', text)
        self.assertEqual(self.store.usage('run1')[-1]['status'], 'incomplete')
        self.assertEqual(self.chat()[0], 200)
        self.assertEqual(self.store.usage('run1')[-1]['status'], 'ok')

    def test_offline_model_server_gives_a_clear_error(self):
        self.upstream.shutdown()
        self.upstream.server_close()
        with self.assertRaises(urllib.error.HTTPError) as err:
            self.chat()
        self.assertEqual(err.exception.code, 502)
        self.assertIn('is not responding', json.load(err.exception)['error']['message'])
        self.assertEqual(self.store.usage('run1')[-1]['status'], 'offline')
        self.upstream = ThreadingHTTPServer(('127.0.0.1', 0), CountingMock)  # tearDown shuts down a serving instance
        threading.Thread(target=self.upstream.serve_forever, daemon=True).start()

    def test_only_loopback_binding(self):
        with self.assertRaises(ValueError):
            gateway.serve(self.broker, self.store.usage_add, lambda: None, 0, host='0.0.0.0')

    def test_usage_parsers(self):
        self.assertEqual(gateway.usage_from({'usage': {'prompt_tokens': 3, 'completion_tokens': 4}}), (3, 4))
        self.assertEqual(gateway.usage_from({'timings': {'prompt_n': 7, 'predicted_n': 9}}), (7, 9))
        self.assertEqual(gateway.usage_from({'choices': []}), (None, None))
        self.assertEqual(usage_of({'type': 'result', 'exit_code': 0, 'session_id': 's1', 'duration_ms': 25085,
                                   'tokens': {'input': 3493, 'output': 1200, 'total': 4693}}),
                         {'tokens_in': 3493, 'tokens_out': 1200, 'duration_ms': 25085, 'session': 's1', 'model': '', 'status': 'ok'})


class ControllerModelTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        (root / 'project').mkdir()
        (root / 'state').mkdir()
        (root / 'state' / 'models.json').write_text(json.dumps({'endpoints': [{'id': 'local', 'url': 'http://127.0.0.1:1', 'model': 'qwen'}]}))
        self.health = {'state': 'online', 'latency_ms': 4, 'models': ['qwen'], 'error': ''}
        self.settings = Settings(root / 'project', root / 'state', poll=.01, notifications=False, run_timeout=30)
        self.api = FakeAPI(root / 'project')
        self.manager = FakeManager([coding(), complete()])
        self.manager.last_calls = [{'tokens_in': 100, 'tokens_out': 20, 'duration_ms': 900, 'status': 'ok'}]
        self.c = Controller(self.settings, self.api, self.manager)
        self.c.broker.prober = lambda e: {**self.health, 'checked': time.time()}

    def tearDown(self):
        self.c.shutdown.set()
        for thread in list(self.c.threads.values()):
            thread.join(2)
        self.c.preview.close()
        self.temp.cleanup()

    def wait(self, condition, timeout=5):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            if condition():
                return
            time.sleep(.01)
        self.fail('timed out')

    def test_check_reports_the_model_server(self):
        health = self.c.check()
        self.assertTrue(health['ready'])
        self.assertEqual(health['agents']['model']['state'], 'ready')
        self.health = {'state': 'offline', 'latency_ms': None, 'models': [], 'error': 'connection refused'}
        health = self.c.check()
        self.assertFalse(health['ready'])
        self.assertIn('not responding', health['message'])
        with self.assertRaises(ValueError):
            self.c.new('Build a thing')

    def test_offline_model_pauses_before_anything_is_sent_and_resume_continues(self):
        self.c.check()

        def drop(n):
            self.health = {'state': 'offline', 'latency_ms': None, 'models': [], 'error': 'connection refused'}
            self.c.broker.health_cache.clear()

        self.api.on_submit = drop
        run = self.c.new('Build a thing')
        self.wait(lambda: self.c.store.get('runs', run['id'])['status'] == 'attention')
        stopped = self.c.store.get('runs', run['id'])
        self.assertIn('Nothing was sent to Hermes', stopped['summary'])
        self.assertEqual(len(self.api.prompts), 1)
        self.health = {'state': 'online', 'latency_ms': 4, 'models': ['qwen'], 'error': ''}
        self.c.broker.health_cache.clear()
        self.c.control(run['id'], 'resume')
        self.wait(lambda: self.c.store.get('runs', run['id'])['status'] == 'completed')

    def test_offline_model_before_coding_keeps_the_prompt_unsent(self):
        self.c.check()
        original = self.manager.decide

        def decide(prompt, cancel):
            result = original(prompt, cancel)
            self.health = {'state': 'offline', 'latency_ms': None, 'models': [], 'error': 'down'}
            self.c.broker.health_cache.clear()
            return result

        self.manager.decide = decide
        run = self.c.new('Build a thing')
        self.wait(lambda: self.c.store.get('runs', run['id'])['status'] == 'attention')
        self.assertIn('Nothing was sent to OpenCode', self.c.store.get('runs', run['id'])['summary'])
        self.assertEqual(self.api.prompts, [])
        self.assertEqual(self.c.store.steps(run['id'])[-1]['status'], 'prepared')

    def test_usage_from_hermes_and_opencode_is_recorded(self):
        self.c.check()

        def tokens(n):
            self.api.messages[-1]['info'].update(tokens={'input': 1000, 'output': 150, 'reasoning': 50, 'cache': {'read': 0, 'write': 0}},
                                                 cost=0, modelID='qwen', providerID='llama')

        self.api.on_submit = tokens
        run = self.c.new('Build a thing')
        self.wait(lambda: self.c.store.get('runs', run['id'])['status'] == 'completed')
        summary = self.c.store.usage_summary(run['id'])
        self.assertEqual(summary['by_agent']['hermes']['calls'], 2)
        self.assertEqual(summary['by_agent']['hermes']['tokens_in'], 200)
        self.assertEqual((summary['by_agent']['coder-1']['tokens_in'], summary['by_agent']['coder-1']['tokens_out']), (1000, 200))
        self.assertEqual(summary['total']['cost'], 0)
        snapshot = self.c.state(run['id'])
        self.assertEqual(snapshot['usage']['total']['calls'], 3)
        self.assertEqual(snapshot['models']['endpoints'][0]['id'], 'local')

    def test_models_api_needs_the_key(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), app.handler(self.c, 'k'))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = f'http://127.0.0.1:{server.server_port}/api/models?check=1'
        try:
            with self.assertRaises(urllib.error.HTTPError) as denied:
                opener().open(url)
            self.assertEqual(denied.exception.code, 401)
            with opener().open(urllib.request.Request(url, headers={'Authorization': 'Bearer k'})) as response:
                body = json.load(response)
            self.assertTrue(body['configured'])
            self.assertEqual(body['endpoints'][0]['health']['state'], 'online')
            self.assertEqual(body['usage']['total']['calls'], 0)
        finally:
            server.shutdown()
            server.server_close()

    def test_a_broken_registry_is_reported_not_fatal(self):
        (self.settings.data / 'models.json').write_text('{"endpoints": [{"url": "ftp://x"}]}')
        c = Controller(self.settings, self.api, self.manager)
        try:
            health = c.check()
            self.assertFalse(health['ready'])
            self.assertIn('Model registry', health['message'])
            self.assertFalse(c.broker.configured)
        finally:
            c.preview.close()


if __name__ == '__main__':
    unittest.main()
