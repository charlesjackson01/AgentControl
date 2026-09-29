"""Agent identity (M3): every run records its agents, and their live state follows the run."""
import json
from pathlib import Path
import sqlite3
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
import agents
import app
from engine import Controller, Settings
from journal import MIGRATIONS, Store
from test_workflow import FakeAPI, FakeManager, coding, complete

RUN = {'id': 'r1', 'created': '2026-09-29T00:00:00+00:00', 'pause': False, 'summary': ''}
HERMES, CODER = agents.default_agents(RUN)


def state(agent, run_changes, steps=(), pending=()):
    return agents.live_state(agent, {**RUN, **run_changes}, list(steps), list(pending))


class LiveStateTests(unittest.TestCase):
    def test_orchestrator_works_while_planning_and_idles_while_coding(self):
        self.assertEqual(state(HERMES, {'status': 'planning', 'phase': 'manager'}), ('working', 'Planning the first turn'))
        self.assertEqual(state(HERMES, {'status': 'reviewing', 'phase': 'manager'}, [{'number': 1}])[0], 'working')
        self.assertEqual(state(HERMES, {'status': 'coding', 'phase': 'code'})[0], 'idle')

    def test_coder_works_on_its_turn_and_waits_on_approvals(self):
        turn = {'agent': 'coder-1', 'status': 'running', 'title': 'Add storage'}
        self.assertEqual(state(CODER, {'status': 'coding', 'phase': 'code'}, [turn]), ('working', 'Add storage'))
        self.assertEqual(state(CODER, {'status': 'waiting', 'phase': 'code'}, [turn], [{'kind': 'permission'}]),
                         ('waiting_on_you', 'Add storage'))
        self.assertEqual(state(CODER, {'status': 'planning', 'phase': 'manager'}, [{**turn, 'status': 'finished'}])[0], 'idle')

    def test_turns_recorded_before_agents_existed_belong_to_coder_1(self):
        legacy_turn = {'status': 'running', 'title': 'Old turn'}  # no 'agent' field
        self.assertEqual(state(CODER, {'status': 'coding', 'phase': 'code'}, [legacy_turn]), ('working', 'Old turn'))

    def test_run_level_states_apply_to_every_agent(self):
        for agent in (HERMES, CODER):
            self.assertEqual(state(agent, {'status': 'completed'})[0], 'finished')
            self.assertEqual(state(agent, {'status': 'stopped'})[0], 'stopped')
            self.assertEqual(state(agent, {'status': 'paused'})[0], 'paused')
            self.assertEqual(state(agent, {'status': 'interrupted', 'summary': 'Restarted'}), ('needs_attention', 'Restarted'))

    def test_activity_is_attributed_to_the_agent_that_produced_it(self):
        self.assertEqual(agents.agent_for_event('Hermes decision'), 'hermes')
        self.assertEqual(agents.agent_for_event('OpenCode tool'), 'coder-1')
        self.assertEqual(agents.agent_for_event('verification'), 'agentcontrol')


class ControllerAgentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        (root / 'project').mkdir()
        self.settings = Settings(root / 'project', root / 'state', poll=.01, notifications=False, run_timeout=30, profile='ai-arch-dev')
        self.api = FakeAPI(root / 'project')
        self.manager = FakeManager([coding(), complete()])
        self.c = Controller(self.settings, self.api, self.manager)
        self.c.check()

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

    def by_name(self, run):
        return {a['name']: a for a in self.c.agents(self.c.store.get('runs', run['id']))}

    def test_a_run_records_hermes_and_coder_1(self):
        self.api.hold = True
        run = self.c.new('Build a thing')
        recorded = self.c.store.agents(run['id'])
        self.assertEqual([(a['name'], a['type']) for a in recorded], [('hermes', 'orchestrator'), ('coder-1', 'coder')])
        self.assertEqual(recorded[0]['model'], 'Hermes profile ai-arch-dev')
        self.wait(lambda: self.c.store.steps(run['id']) and self.c.store.steps(run['id'])[-1]['status'] == 'running')
        self.assertEqual(self.c.store.steps(run['id'])[0]['agent'], 'coder-1')
        live = self.by_name(run)
        self.assertEqual((live['coder-1']['state'], live['coder-1']['task']), ('working', 'Implement feature'))
        self.assertEqual(live['hermes']['state'], 'idle')
        self.assertEqual((live['coder-1']['role'], live['coder-1']['runtime']), ('Coder', 'opencode'))
        self.api.hold = False
        self.api.finish()
        self.wait(lambda: self.c.store.get('runs', run['id'])['status'] == 'completed')
        live = self.by_name(run)
        self.assertEqual({a['state'] for a in live.values()}, {'finished'})
        self.assertEqual(live['coder-1']['stats']['turns'], 1)
        self.assertEqual(live['hermes']['stats']['turns'], 2)
        self.assertGreater(live['hermes']['stats']['activity'], 0)

    def test_hermes_shows_as_working_while_it_plans(self):
        self.manager.hold = threading.Event()
        run = self.c.new('Build a thing')
        self.wait(lambda: self.by_name(run)['hermes']['state'] == 'working')
        self.assertEqual(self.by_name(run)['coder-1']['state'], 'idle')
        self.manager.hold.set()

    def test_state_and_api_expose_agents(self):
        run = self.c.new('Build a thing')
        self.wait(lambda: self.c.store.get('runs', run['id'])['status'] == 'completed')
        snapshot = self.c.state(run['id'])
        self.assertEqual([a['name'] for a in snapshot['agents']], ['hermes', 'coder-1'])
        self.assertEqual({t['id'] for t in snapshot['agent_types']}, {'orchestrator', 'coder'})
        server = ThreadingHTTPServer(('127.0.0.1', 0), app.handler(self.c, 'k'))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f'http://127.0.0.1:{server.server_port}/api/agents?run='
        try:
            with self.assertRaises(urllib.error.HTTPError) as denied:
                urllib.request.urlopen(base + run['id'])
            self.assertEqual(denied.exception.code, 401)
            ok = json.load(urllib.request.urlopen(urllib.request.Request(base + run['id'], headers={'Authorization': 'Bearer k'})))
            self.assertEqual([a['state'] for a in ok['agents']], ['finished', 'finished'])
            with self.assertRaises(urllib.error.HTTPError) as missing:
                urllib.request.urlopen(urllib.request.Request(base + 'nope', headers={'Authorization': 'Bearer k'}))
            self.assertEqual(missing.exception.code, 404)
        finally:
            server.shutdown()
            server.server_close()

    def test_runs_from_before_agents_existed_are_shown_without_rewriting_history(self):
        legacy = {'id': 'old', 'created': '2026-08-01T00:00:00+00:00', 'goal': 'Old run', 'status': 'completed',
                  'summary': 'done', 'pending': [], 'stop': False, 'decision_count': 3}
        self.c.store.put('runs', legacy)
        self.assertEqual([a['name'] for a in self.c.agents(legacy)], ['hermes', 'coder-1'])
        self.assertEqual(self.c.store.agents('old'), [], 'reading must not write agents into old runs')

    def test_agent_changes_are_published_live(self):
        subscriber = self.c.events.subscribe()
        self.api.hold = True
        run = self.c.new('Build a thing')
        kinds = set()
        while not subscriber.empty():
            event = subscriber.get_nowait()
            if event['run'] == run['id']:
                kinds.add(event['kind'])
        self.assertIn('agent', kinds)
        self.api.hold = False
        self.api.finish()


class MigrationTests(unittest.TestCase):
    def test_v1_journal_gains_the_agents_table(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'j.sqlite3'
            with sqlite3.connect(path) as c:
                MIGRATIONS[0](c)
                c.execute('PRAGMA user_version = 1')
                c.execute('INSERT INTO runs VALUES (?,?)', ('old', json.dumps({'id': 'old', 'created': 'x'})))
            store = Store(path)
            self.assertEqual(store.agents('old'), [])
            store.put_agent({'id': 'old:hermes', 'run': 'old', 'name': 'hermes', 'type': 'orchestrator'})
            self.assertEqual(len(store.agents('old')), 1)
            self.assertEqual(store.get('runs', 'old')['created'], 'x')
            with sqlite3.connect(path) as c:
                self.assertEqual(c.execute('PRAGMA user_version').fetchone()[0], 2)


if __name__ == '__main__':
    unittest.main()
