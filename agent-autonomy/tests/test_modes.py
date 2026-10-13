"""Auto mode (M8): the decision table, and your choice always winning."""
import json
from pathlib import Path
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import app
import modes
import test_team
from test_team import proposal
from test_workflow import complete

TEAM_BRIEF = 'Build a REST API with SQLite storage, a web UI page that lists items, unittest tests, and a README.'
TINY_BRIEF = 'Fix the typo in the greeting.'
VERIFY = 'test -f all.txt -o -f fix.txt'


class DecisionTableTests(unittest.TestCase):
    def decide(self, goal=TEAM_BRIEF, **kw):
        options = {'goal_checks': (), 'verifier': ['python3', '-m', 'unittest'], 'max_steps': 8, 'git_usable': True, 'slots': 1, **kw}
        return modes.decide(goal, **options)

    def test_rows_in_order(self):
        cases = [
            ('not git', dict(git_usable=False), 'single', 1),
            ('prompt limit', dict(max_steps=2), 'single', 2),
            ('one area', dict(goal=TINY_BRIEF), 'single', 3),
            ('one slot, no verifier, few parts', dict(goal='Add an API endpoint and a UI page.', verifier=[]), 'single', 4),
            ('several parts with a verifier', {}, 'team', 5),
            ('two slots, no verifier', dict(goal='Add an API endpoint and a UI page.', verifier=[], slots=2), 'team', 5),
            ('many parts even without a verifier', dict(verifier=[]), 'team', 5),
        ]
        for name, kw, mode, rule in cases:
            with self.subTest(name):
                decision = self.decide(**kw)
                self.assertEqual((decision['mode'], decision['rule']), (mode, rule), decision['reasons'])
                self.assertTrue(decision['reasons'])

    def test_first_matching_row_wins(self):
        self.assertEqual(self.decide(git_usable=False, max_steps=1)['rule'], 1)
        self.assertEqual(self.decide(goal=TINY_BRIEF, max_steps=1)['rule'], 2)

    def test_parts_come_from_areas_list_items_and_goal_checks(self):
        areas, items = modes.parts('Build it:\n- storage\n- export\n1. import', ['The README explains usage'])
        self.assertEqual(len(items), 3)
        self.assertIn('documentation', areas)
        listed = self.decide(goal='Do these:\n- one\n- two\n- three')
        self.assertEqual((listed['mode'], listed['signals']['list_items']), ('team', 3))

    def test_team_reason_promises_approval(self):
        self.assertIn('never starts without your approval', ' '.join(self.decide()['reasons']))


class AutoRunTests(test_team.TeamRunTests):
    """Reuses the team harness (git project, multi-session fake OpenCode, scripted Hermes)."""

    def test_auto_asks_hermes_and_a_team_still_waits_for_you(self):
        c, manager = self.controller([proposal()], [{'action': 'code', 'title': 'All', 'summary': 's', 'prompt': 'CREATE all.txt'}, complete()])
        run = c.new(TEAM_BRIEF, VERIFY, mode='auto')
        self.assertEqual((run['mode'], run['auto']['rule']), ('team', 5))
        waiting = self.awaiting(c, run['id'])
        self.assertEqual(waiting['team']['state'], 'proposed')
        time.sleep(.1)
        self.assertEqual(self.api.prompts, [], 'Auto never starts a team by itself')
        c.control(run['id'], 'single_agent')  # your override wins
        result = self.done(c, run['id'])
        self.assertEqual((result['status'], list(result['workspace']['agents'])), ('completed', ['coder-1']))

    def test_auto_runs_single_when_hermes_says_one_agent_is_enough(self):
        one = proposal(mode='single', agents=[{'id': 'dev', 'role': 'coder', 'responsibility': 'Everything'}],
                       tasks=[{'id': 't1', 'title': 'All', 'agent': 'dev', 'depends_on': [], 'prompt': 'CREATE all.txt'}])
        c, manager = self.controller([one], [{'action': 'code', 'title': 'All', 'summary': 's', 'prompt': 'CREATE all.txt'}, complete()])
        run = c.new(TEAM_BRIEF, VERIFY, mode='auto')
        seen = set()
        self.wait(lambda: seen.add(self.run_of(c, run['id'])['status']) or self.run_of(c, run['id'])['status'] == 'completed')
        self.assertNotIn('awaiting_approval', seen)
        result = self.run_of(c, run['id'])
        self.assertEqual(result['team']['state'], 'single')
        self.assertIn('auto: single agent', [e['action'] for e in c.store.audit(run['id'])])
        self.assertEqual(len(self.api.sessions), 1)

    def test_auto_falls_back_to_single_when_no_usable_plan(self):
        c, manager = self.controller([{'mode': 'multi'}, {'mode': 'multi'}],
                                     [{'action': 'code', 'title': 'All', 'summary': 's', 'prompt': 'CREATE all.txt'}, complete()])
        run = c.new(TEAM_BRIEF, VERIFY, mode='auto')
        result = self.done(c, run['id'])
        self.assertEqual((result['status'], result['team']['state']), ('completed', 'single'))
        self.assertIn('could not produce a usable team plan', ' '.join(e['detail'] for e in c.store.events(run['id']) if e['kind'] == 'auto mode'))

    def test_auto_skips_hermes_for_clear_single_cases(self):
        c, manager = self.controller([], [{'action': 'code', 'title': 'Fix', 'summary': 's', 'prompt': 'CREATE fix.txt'}, complete()])
        run = c.new(TINY_BRIEF, VERIFY, mode='auto')
        self.assertEqual((run['mode'], run['auto']['rule'], run['team']), ('single', 3, None))
        self.assertEqual(self.done(c, run['id'])['status'], 'completed')
        self.assertEqual(manager.json_calls, [])

    def test_your_explicit_choice_is_never_overridden(self):
        c, manager = self.controller([], [{'action': 'code', 'title': 'All', 'summary': 's', 'prompt': 'CREATE all.txt'}, complete()])
        run = c.new(TEAM_BRIEF, VERIFY, mode='single')
        self.assertIsNone(run['auto'])
        self.assertEqual(self.done(c, run['id'])['status'], 'completed')
        self.assertEqual(manager.json_calls, [], 'single means single, whatever the brief looks like')
        c2, manager2 = self.controller([proposal()], [])
        team = c2.new(TINY_BRIEF, mode='team')
        self.assertEqual(self.awaiting(c2, team['id'])['team']['state'], 'proposed', 'team means a plan, even for a tiny brief')
        c2.control(team['id'], 'stop')

    def test_preview_api_shows_what_auto_would_do(self):
        c, _ = self.controller([], [])
        server = ThreadingHTTPServer(('127.0.0.1', 0), app.handler(c, 'k'))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = f'http://127.0.0.1:{server.server_port}/api/mode/preview'
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        body = json.dumps({'goal': TEAM_BRIEF, 'verifier': VERIFY, 'max_steps': 6}).encode()
        try:
            with self.assertRaises(urllib.error.HTTPError) as denied:
                opener.open(urllib.request.Request(url, body, {'Content-Type': 'application/json'}))
            self.assertEqual(denied.exception.code, 401)
            request = urllib.request.Request(url, body, {'Content-Type': 'application/json', 'Authorization': 'Bearer k'})
            decision = json.load(opener.open(request))
            self.assertEqual((decision['mode'], decision['rule']), ('team', 5))
            request = urllib.request.Request(url, json.dumps({'goal': TINY_BRIEF}).encode(), {'Content-Type': 'application/json', 'Authorization': 'Bearer k'})
            self.assertEqual(json.load(opener.open(request))['mode'], 'single')
        finally:
            server.shutdown()
            server.server_close()


# Only the Auto tests here; the inherited team tests already run in test_team.py.
for name in [n for n in vars(test_team.TeamRunTests) if n.startswith('test_')]:
    if name not in vars(AutoRunTests):
        setattr(AutoRunTests, name, None)

if __name__ == '__main__':
    unittest.main()
