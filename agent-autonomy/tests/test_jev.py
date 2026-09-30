"""J: the Jev adapter and the stuck watch. A fake Jev serves the reply format the J0 probe saw on the
real API; the watch is advisory, opt-in, budgeted, and never changes a run."""
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from adapters import jev as jev_api
import agents as agent_registry
import watch as watch_mod
from engine import Controller, Settings
from test_workflow import FakeAPI, FakeManager, coding, complete

KEY = 'ts-secret-key-123'
# The reply the probe received from api.typesafe.ai on 2026-09-30, for the probe's three questions.
PROBED = {'model': 'jev-1.13.0', 'answers': {
    'stuck': {'type': 'noul', 'noul': 0.93},
    'pattern': {'type': 'choice', 'choice': 'repeating_failure', 'confidence': 1.0,
                'probabilities': {'repeating_failure': 1.0, 'tool_errors': 0.0, 'undo_redo': 0.0, 'progressing': 0.0}},
    'progress': {'type': 'score', 'score': 0.71, 'confidence': 0.7, 'legend': {'0': 'a', '1': 'b', '2': 'c', '3': 'd'},
                 'probabilities': {'0': 0.3, '1': 0.7, '2': 0.0, '3': 0.0}}},
    'usage': {'input_tokens': 502, 'output_tokens': 87}}


class FakeJev:
    """Answers each request from `self.replies` (status, body), repeating the last one."""

    def __init__(self):
        self.requests = []
        self.replies = [(200, None)]
        self.stuck = [0.93]
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                fake.requests.append({'auth': self.headers.get('Authorization'), 'body': body, 'path': self.path})
                n = len(fake.requests) - 1
                status, reply = fake.replies[min(n, len(fake.replies) - 1)]
                if reply is None:
                    p = fake.stuck[min(n, len(fake.stuck) - 1)]
                    reply = {'model': 'jev-1.13.0', 'usage': {'input_tokens': 1000, 'output_tokens': 20}, 'answers': {
                        'stuck': {'type': 'noul', 'noul': p},
                        'pattern': {'type': 'choice', 'choice': 'repeating_failure' if p >= .5 else 'progressing', 'confidence': .9,
                                    'probabilities': {}}}}
                data = json.dumps(reply).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('x-typesafe-request-id', f'req_{n}')
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.url = f'http://127.0.0.1:{self.server.server_port}/v1/systemone'
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def secret_dir(root, key=KEY):
    folder = Path(root) / 'secrets'
    folder.mkdir(mode=0o700, exist_ok=True)
    (folder / 'typesafe').write_text(key)
    (folder / 'typesafe').chmod(0o600)
    return folder


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.fake = FakeJev()
        self.client = jev_api.Jev('typesafe', self.fake.url, secret_dir=secret_dir(self.temp.name))

    def tearDown(self):
        self.fake.close()
        self.temp.cleanup()

    def test_request_uses_only_the_probed_fields_and_the_reply_is_parsed(self):
        questions = {'stuck': jev_api.noul('Stuck?'), 'pattern': jev_api.choice({'repeating_failure': 'a', 'tool_errors': 'b',
                                                                                'undo_redo': 'c', 'progressing': 'd'}),
                     'progress': jev_api.score(['a', 'b', 'c', 'd'])}
        self.fake.replies = [(200, PROBED)]
        answers, info = self.client.ask('some state', questions)
        sent = self.fake.requests[0]
        self.assertEqual(sent['auth'], 'Bearer ' + KEY)
        self.assertEqual(set(sent['body']), {'model', 'state', 'questions'})
        self.assertEqual(sent['body']['model'], jev_api.MODEL)
        self.assertEqual(sent['body']['questions']['stuck'], {'type': 'noul', 'instructions': 'Stuck?'})
        self.assertEqual(sent['body']['questions']['progress']['criteria'], ['a', 'b', 'c', 'd'])
        self.assertEqual(answers['stuck'], {'probability': 0.93})
        self.assertEqual((answers['pattern']['choice'], answers['pattern']['confidence']), ('repeating_failure', 1.0))
        self.assertEqual(answers['progress'], {'score': 0.71, 'confidence': 0.7})
        self.assertEqual((info['tokens_in'], info['tokens_out'], info['request_id']), (502, 87, 'req_0'))
        self.assertAlmostEqual(info['cost'], 502 * 42 / 1e9)

    def test_http_errors_malformed_replies_and_no_key_return_none_without_leaking_the_key(self):
        q = {'stuck': jev_api.noul('x')}
        self.fake.replies = [(422, {'detail': [{'msg': 'Field required', 'input': 'Bearer ' + KEY}]})]
        answers, info = self.client.ask('s', q)
        self.assertIsNone(answers)
        self.assertIn('HTTP 422', info['error'])
        self.assertNotIn(KEY, info['error'])
        for bad in ({'answers': {}}, {'answers': {'stuck': {'type': 'noul', 'noul': 1.7}}}, ['not', 'an', 'object']):
            self.fake.replies = [(200, bad)]
            self.fake.requests.clear()
            answers, info = self.client.ask('s', q)
            self.assertIsNone(answers, bad)
            self.assertIn('not understood', info['error'])
        choice = {'pick': jev_api.choice({'a': 'A'})}
        self.fake.replies = [(200, {'answers': {'pick': {'type': 'choice', 'choice': 'zzz', 'confidence': 1}}})]
        self.assertIsNone(self.client.ask('s', choice)[0], 'an option that was not offered is refused')
        missing = jev_api.Jev('nope', self.fake.url, secret_dir=Path(self.temp.name) / 'secrets')
        answers, info = missing.ask('s', q)
        self.assertIsNone(answers)
        self.assertIn('not found', info['error'])
        offline = jev_api.Jev('typesafe', 'http://127.0.0.1:9/v1/systemone', secret_dir=Path(self.temp.name) / 'secrets', timeout=2)
        self.assertIn('could not be reached', offline.ask('s', q)[1]['error'])


class WatchHelperTests(unittest.TestCase):
    def test_tail_keeps_the_end_of_the_turn_within_limits(self):
        parts = [{'type': 'tool', 'tool': 'bash', 'status': 'error', 'summary': f'pytest {n}', 'output': 'KeyError ' * 200} for n in range(60)]
        parts.append({'type': 'text', 'text': 'Trying again.'})
        text = watch_mod.tail(parts)
        self.assertLessEqual(len(text), watch_mod.TAIL_CHARS)
        self.assertTrue(text.endswith('Trying again.'))
        self.assertIn('[bash error] pytest 59', text)
        self.assertNotIn('pytest 5\n', text)

    def test_an_agent_is_suspected_only_after_two_high_checks_in_a_row(self):
        mk = lambda high: {'probability': .9 if high else .2, 'high': high, 'pattern': 'repeating_failure', 'created': 't'}
        self.assertIsNone(watch_mod.summary([]))
        self.assertFalse(watch_mod.summary([mk(True)])['suspected'])
        self.assertFalse(watch_mod.summary([mk(True), mk(False)])['suspected'])
        self.assertTrue(watch_mod.summary([mk(False), mk(True), mk(True)])['suspected'])
        self.assertEqual(watch_mod.summary([mk(True), mk(True)])['label'], 'the same failure keeps recurring')


class ControllerWatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        (root / 'project').mkdir()
        self.fake = FakeJev()
        env = mock.patch.dict(os.environ, {'AIARCH_DATA_DIR': str(root)})
        env.start()
        self.addCleanup(env.stop)
        secret_dir(root)
        self.api = FakeAPI(root / 'project')
        self.settings = Settings(root / 'project', root / 'state', poll=.01, notifications=False, step_timeout=5, manager_timeout=5,
                                 verify_timeout=5, run_timeout=30, jev_key_ref='typesafe', jev_url=self.fake.url)
        self.controllers = []

    def tearDown(self):
        for c in self.controllers:
            c.shutdown.set()
            for thread in c.threads.values():
                thread.join(2)
        self.fake.close()
        self.temp.cleanup()

    def controller(self, decisions, settings=None):
        c = Controller(settings or self.settings, self.api, FakeManager(decisions))
        c.check()
        c.pushes = []
        c._push = lambda ident, message: c.pushes.append(message)
        self.controllers.append(c)
        return c

    def done(self, c, ident):
        import time
        until = time.monotonic() + 8
        while time.monotonic() < until:
            run = c.store.get('runs', ident)
            if run['status'] in agent_registry.TERMINAL or run['status'] == 'attention':
                return run
            time.sleep(.02)
        self.fail('run did not finish')

    def test_the_watch_needs_a_key_and_your_typed_confirmation(self):
        plain = self.controller([], Settings(self.settings.project, self.settings.data, poll=.01, notifications=False))
        self.assertFalse(plain.state()['watch']['available'])
        with self.assertRaisesRegex(ValueError, 'Jev key'):
            plain.new('Goal', watch=True, confirm='approve')
        plain.shutdown.set()
        c = self.controller([])
        self.assertTrue(c.state()['watch']['available'])
        with self.assertRaisesRegex(ValueError, 'type approve'):
            c.new('Goal', watch=True)

    def test_a_looping_coder_is_flagged_after_two_high_checks_and_the_run_is_never_changed(self):
        self.fake.stuck = [0.95]
        c = self.controller([coding('Fix it.'), coding('Fix it again.', 'correction'), complete()])
        run = c.new('Make the tests pass', watch=True, confirm='approve')
        self.assertEqual(c.store.audit(run['id'])[-1]['action'], 'stuck watch on')
        result = self.done(c, run['id'])
        self.assertEqual(result['status'], 'completed', 'the watch never stops or pauses a run')
        self.assertEqual(len(self.api.prompts), 2, 'the watch never sends a prompt')
        self.assertEqual(len(self.fake.requests), 2, 'one check per settled coder turn')
        sent = self.fake.requests[0]['body']
        self.assertIn('Make the tests pass', sent['state'])
        self.assertIn('Implementation done.', sent['state'], 'the end of the recorded transcript is sent')
        self.assertEqual(set(sent['questions']), {'stuck', 'pattern'})
        checks = c.store.latest_events(run['id'], 'watch')
        self.assertEqual(len(checks), 2)
        alerts = c.store.latest_events(run['id'], 'watch alert')
        self.assertEqual(len(alerts), 1, 'one alert when the agent first looks stuck')
        stuck = [m for m in c.pushes if 'possibly stuck' in m]
        self.assertEqual(len(stuck), 1, c.pushes)
        self.assertIn('"watch"', c.manager.calls[-1], 'Hermes sees the watch note in its next decision')
        coder = next(a for a in c.state(run['id'])['agents'] if a['name'] == 'coder-1')
        self.assertTrue(coder['watch']['suspected'])
        self.assertEqual(coder['watch']['probability'], 0.95)
        usage = [u for u in c.store.usage(run['id']) if u['source'] == 'jev']
        self.assertEqual(len(usage), 2)
        self.assertAlmostEqual(usage[0]['cost'], 1000 * 42 / 1e9)
        everything = json.dumps([c.state(run['id']), c.store.events(run['id'], 500), c.store.usage(run['id']), c.store.audit(run['id'])])
        self.assertNotIn(KEY, everything)

    def test_a_progressing_coder_is_not_flagged_and_no_check_without_opt_in(self):
        self.fake.stuck = [0.2]
        c = self.controller([coding(), coding('More.', 'correction'), complete()])
        run = c.new('Goal', watch=True, confirm='approve')
        self.done(c, run['id'])
        self.assertEqual(c.store.latest_events(run['id'], 'watch alert'), [])
        coder = next(a for a in c.state(run['id'])['agents'] if a['name'] == 'coder-1')
        self.assertFalse(coder['watch']['suspected'])
        self.assertNotIn('"watch"', c.manager.calls[-1])
        before = len(self.fake.requests)
        other = self.controller([coding(), complete()])
        plain = other.new('Goal without the watch')
        self.done(other, plain['id'])
        self.assertEqual(len(self.fake.requests), before, 'nothing is sent unless you switched the watch on')
        self.assertIsNone(next(a for a in other.state(plain['id'])['agents'] if a['name'] == 'coder-1')['watch'])

    def test_an_unreachable_jev_is_reported_once_and_the_run_carries_on(self):
        self.fake.replies = [(500, {'detail': 'boom'})]
        c = self.controller([coding(), coding('Again.', 'correction'), complete()])
        run = c.new('Goal', watch=True, confirm='approve')
        self.assertEqual(self.done(c, run['id'])['status'], 'completed')
        notes = c.store.latest_events(run['id'], 'watch unavailable')
        self.assertEqual(len(notes), 1)
        self.assertIn('HTTP 500', notes[0]['detail'])
        self.assertEqual(c.store.latest_events(run['id'], 'watch'), [])

    def test_budget_spend_cap_and_turning_it_off_stop_the_calls(self):
        c = self.controller([])
        run = c.new('Goal', watch=True, confirm='approve')
        step = {'id': 's1', 'run': run['id'], 'number': 1, 'agent': 'coder-1', 'title': 't', 'status': 'running',
                'transcript': [{'type': 'text', 'text': 'working'}]}
        c.store.put('steps', step)
        with mock.patch.object(watch_mod, 'MAX_CALLS', 2):
            self.assertIsNotNone(c.watch.check(run['id'], 's1'))
            self.assertIsNotNone(c.watch.check(run['id'], 's1'))
            self.assertIsNone(c.watch.check(run['id'], 's1'))
        self.assertEqual(len(self.fake.requests), 2)
        with mock.patch.object(c, 'spend_status', return_value={'run': 0, 'cap': None, 'month': 5.0, 'monthly_cap': 5.0}):
            self.assertIsNone(c.watch.check(run['id'], 's1'))
        self.assertEqual(len(self.fake.requests), 2)
        c.control(run['id'], 'watch_off')
        self.assertFalse(c.store.get('runs', run['id'])['watch'])
        self.assertIsNone(c.watch.check(run['id'], 's1'))
        self.assertEqual(len(self.fake.requests), 2)
        self.assertEqual(c.store.audit(run['id'])[-1]['action'], 'stuck watch off')

    def test_a_long_running_turn_is_checked_mid_turn(self):
        import time
        c = self.controller([])
        c.watch.interval, c.watch.poll = 0.5, 0.02
        # A run record the engine is not driving, so the fake turn below is left as written.
        c.store.put('runs', {'id': 'long1', 'created': '2026-09-30T00:00:00+00:00', 'goal': 'Goal', 'status': 'running',
                             'watch': True, 'pending': [], 'stop': False, 'pause': False})
        c.store.put('steps', {'id': 's2', 'run': 'long1', 'number': 1, 'agent': 'coder-1', 'title': 't', 'status': 'running',
                              'started': time.time() - 1000, 'transcript': [{'type': 'text', 'text': 'still going'}]})
        stop = threading.Event()
        thread = threading.Thread(target=c.watch.loop, args=(stop,), daemon=True)
        thread.start()
        until = time.monotonic() + 3
        while time.monotonic() < until and not c.store.latest_events('long1', 'watch'):
            time.sleep(.02)
        time.sleep(.3)   # many polls, but the turn was checked less than one interval ago
        stop.set()
        thread.join(2)
        found = c.store.latest_events('long1', 'watch')
        self.assertEqual(len(found), 1, 'at most one check per interval of a long turn')
        self.assertEqual(json.loads(found[0]['detail'])['when'], 'long turn')

if __name__ == '__main__':
    unittest.main()
