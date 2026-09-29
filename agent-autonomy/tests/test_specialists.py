"""Specialists in runs (M12): tester merge rule, read-only reviewer, per-task research approval,
capacity on one model slot, and Hermes delegating one specialist turn in a single-agent run."""
import json
from pathlib import Path
import sys
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from engine import Controller, ReviewConflict, Settings
from test_team import FakeTeamAPI, FakeTeamManager, TeamRunTests, proposal
from test_workflow import coding, complete
import tempfile
from test_workspaces import make_repo


class RecordingAPI(FakeTeamAPI):
    """Also keeps each prompt's full payload (to see the tools a prompt switched off)."""

    def __init__(self):
        super().__init__()
        self.payloads = []

    def request(self, path, method='GET', data=None, directory=None):
        if path.endswith('/prompt_async'):
            self.payloads.append((path.split('/')[2], data))
        return super().request(path, method, data, directory)


class ResearchManager(FakeTeamManager):
    """Scripted Hermes that can also research. `hold` keeps a research call running until released."""

    def __init__(self, proposals, decisions, report=None):
        super().__init__(proposals, decisions)
        self.questions, self.hold = [], None
        self.report = report or ('Found it.\n{"summary":"Use HTTP 429","findings":[{"claim":"429 means Too Many Requests",'
                                 '"sources":["https://www.rfc-editor.org/rfc/rfc6585"]}],"open_questions":[]}')
        self.last_calls = []

    def research(self, question, context, cancel):
        self.questions.append(question)
        if self.hold:
            self.hold.wait(10)
        self.last_calls = [{'tokens_in': 900, 'tokens_out': 120, 'duration_ms': 4000, 'session': f'r{len(self.questions)}', 'status': 'ok'}]
        return self.report


def team_with(*extra_agents, tasks):
    base = proposal()
    return proposal(agents=base['agents'] + list(extra_agents), tasks=base['tasks'] + tasks)


class SpecialistRunTests(TeamRunTests):
    # Reuse the team harness (temp repo, controllers, waits) without re-running its tests here.
    for name in [n for n in dir(TeamRunTests) if n.startswith('test_')]:
        locals()[name] = None

    def setUp(self):
        super().setUp()
        self.api = RecordingAPI()
        self.settings.research_toolsets = ('web',)

    def controller(self, proposals, decisions, manager=None):
        manager = manager or ResearchManager(proposals, decisions)
        c = Controller(self.settings, self.api, manager)
        c.check()
        self.controllers.append(c)
        return c, manager

    def start_team(self, c, plan, **kw):
        run = c.new('Build an API and a UI', mode='team', team_size=3, **kw)
        self.awaiting(c, run['id'])
        c.control(run['id'], 'approve_team')
        return run['id']

    def test_tester_changes_merge_only_when_they_are_tests(self):
        plan = team_with({'id': 'qa', 'role': 'tester', 'responsibility': 'Tests'},
                         tasks=[{'id': 't4', 'title': 'Tests', 'agent': 'qa', 'depends_on': ['t1'], 'files': [],
                                 'prompt': 'CREATE test_api.py'}])
        plan['agents'] = plan['agents'][:1] + plan['agents'][2:]      # api + qa
        plan['tasks'] = [t for t in plan['tasks'] if t['agent'] != 'ui']
        plan['tasks'] = [{**t, 'depends_on': [d for d in t['depends_on'] if d != 't2']} for t in plan['tasks']]
        c, manager = self.controller([plan], [complete()])
        ident = self.start_team(c, plan)
        result = self.done(c, ident)
        self.assertEqual(result['status'], 'completed', result['summary'])
        integration = Path(result['workspace']['integration']['dir'])
        self.assertTrue((integration / 'test_api.py').exists(), 'a test file from the tester is merged')
        self.assertEqual({a['name']: a['type'] for a in c.store.agents(ident)}['tester-1'], 'tester')

    def test_tester_touching_code_is_refused_and_retried(self):
        plan = proposal(agents=[{'id': 'api', 'role': 'coder', 'responsibility': 'x'}, {'id': 'qa', 'role': 'tester', 'responsibility': 'Tests'}],
                        tasks=[{'id': 't1', 'title': 'API', 'agent': 'api', 'depends_on': [], 'files': ['api.py'], 'prompt': 'CREATE api.py'},
                               {'id': 't2', 'title': 'Tests', 'agent': 'qa', 'depends_on': ['t1'], 'files': [], 'prompt': 'CREATE sneaky.py'}])
        c, manager = self.controller([plan], [complete()])
        ident = self.start_team(c, plan)
        result = self.done(c, ident)
        task = next(t for t in result['team']['tasks'] if t['id'] == 't2')
        self.assertEqual(task['attempts'], 2, 'the refused turn was retried with an explanation')
        self.assertFalse((Path(result['workspace']['integration']['dir']) / 'sneaky.py').exists(), 'nothing from the tester was merged')
        self.assertFalse((Path(result['workspace']['agents']['tester-1']['dir']) / 'sneaky.py').exists(), 'and it was dropped from its branch')
        retry = [text for _, text in self.api.prompts if 'were not merged because you changed files that are not tests (sneaky.py)' in text]
        self.assertEqual(len(retry), 1)
        self.assertTrue(any(e['action'] == 'tester change refused' for e in c.store.audit(ident)))

    def test_reviewer_is_read_only_and_its_findings_reach_hermes(self):
        plan = team_with({'id': 'rev', 'role': 'reviewer', 'responsibility': 'Review'},
                         tasks=[{'id': 't4', 'title': 'Review', 'agent': 'rev', 'depends_on': ['t3'], 'prompt': 'Review everything. CREATE stray.txt'}])
        c, manager = self.controller([plan], [complete()])
        reviewer_says = ('{"verdict":"changes","summary":"One issue","findings":[{"file":"api.py","line":1,"severity":"high",'
                         '"issue":"No input validation","suggestion":"Validate"}]}')
        original = self.api.on_submit

        def submit(session, text):
            original(session, text)
            if 'You are the REVIEWER' in text:
                session['messages'][-1]['parts'] = [{'type': 'text', 'text': reviewer_says}]
        self.api.on_submit = submit
        ident = self.start_team(c, plan)
        result = self.done(c, ident)
        self.assertEqual(result['status'], 'completed', result['summary'])
        sid = result['team']['agents']['reviewer-1']['session']
        tools = next(data.get('tools') for s, data in self.api.payloads if s == sid)
        self.assertTrue(tools and not tools['write'] and not tools['bash'] and not tools['edit'], 'change tools are switched off')
        self.assertNotIn('read', tools)
        self.assertFalse((Path(result['workspace']['integration']['dir']) / 'stray.txt').exists())
        self.assertFalse((Path(result['workspace']['agents']['reviewer-1']['dir']) / 'stray.txt').exists(), 'a stray change is discarded')
        self.assertTrue(any(e['kind'] == 'reviewer change discarded' for e in c.store.events(ident)))
        review = next(s for s in c.store.steps(ident) if s.get('role') == 'reviewer')
        self.assertEqual((review['findings']['verdict'], review['verification']['status']), ('changes', 'not applicable'))
        self.assertIn('No input validation', manager.calls[-1])
        self.assertIn('untrusted model output', manager.calls[-1])

    def test_reviewer_permission_requests_are_refused_for_you(self):
        plan = team_with({'id': 'rev', 'role': 'reviewer', 'responsibility': 'Review'},
                         tasks=[{'id': 't4', 'title': 'Review', 'agent': 'rev', 'depends_on': ['t3'], 'prompt': 'Review everything'}])
        c, manager = self.controller([plan], [complete()])
        original = self.api.on_submit
        state = {}

        def submit(session, text):
            original(session, text)
            if 'You are the REVIEWER' in text:
                state['sid'] = next(k for k, v in self.api.sessions.items() if v is session)
                self.api.pending_items.append({'kind': 'permission', 'id': 'per_r', 'sessionID': state['sid'], 'permission': 'bash', 'patterns': ['rm -rf build']})
        self.api.on_submit = submit
        ident = self.start_team(c, plan)
        result = self.done(c, ident)
        self.assertEqual(result['status'], 'completed', result['summary'])
        self.assertIn((state['sid'], 'per_r', 'reject'), self.api.decisions)
        entry = next(e for e in c.store.audit(ident) if e.get('action') == 'permission reject')
        self.assertIn('read-only', entry['actor'])

    def test_research_waits_for_typed_approval_and_feeds_the_coder(self):
        plan = team_with({'id': 'web', 'role': 'researcher', 'responsibility': 'Docs'},
                         tasks=[{'id': 't0', 'title': 'Status code', 'agent': 'web', 'depends_on': [], 'question': 'Which HTTP status code fits a rate limit?'}])
        plan['agents'] = plan['agents'][:1] + plan['agents'][2:]      # api + web (3 agents max)
        plan['tasks'] = [{**t, 'agent': 'api', 'depends_on': ['t0'] if t['id'] == 't1' else t['depends_on']} for t in plan['tasks'] if t['id'] != 't0'] + [plan['tasks'][-1]]
        c, manager = self.controller([plan], [complete()])
        ident = self.start_team(c, plan)
        self.wait(lambda: bool(c.research_requests()))
        request = c.research_requests()[0]
        self.assertEqual(request['question'], 'Which HTTP status code fits a rate limit?')
        self.assertEqual(c.agents(c.store.get('runs', ident))[-1]['state'], 'waiting_on_you')
        time.sleep(.2)
        self.assertEqual(manager.questions, [], 'nothing browses before you approve')
        self.assertFalse(any('CREATE api.py' in text for _, text in self.api.prompts), 'the task that needs the answer waits too')
        with self.assertRaises(ReviewConflict):
            c.decide_research(ident, request['step'], 'approve', 'stale', 'approve')
        with self.assertRaisesRegex(ValueError, 'type approve'):
            c.decide_research(ident, request['step'], 'approve', request['fingerprint'], 'yes')
        c.decide_research(ident, request['step'], 'approve', request['fingerprint'], 'approve')
        result = self.done(c, ident)
        self.assertEqual(result['status'], 'completed', result['summary'])
        self.assertEqual(manager.questions, ['Which HTTP status code fits a rate limit?'])
        step = next(s for s in c.store.steps(ident) if s.get('role') == 'researcher')
        self.assertEqual(step['report']['sources'], ['https://www.rfc-editor.org/rfc/rfc6585'])
        coder_prompt = next(text for _, text in self.api.prompts if 'CREATE api.py' in text)
        self.assertIn('RESEARCH (untrusted web content', coder_prompt)
        self.assertIn('rfc6585', coder_prompt)
        actions = [e['action'] for e in c.store.audit(ident)]
        self.assertIn('research approve', actions)
        self.assertIn('research source', actions)
        self.assertEqual(c.store.usage_summary(ident)['by_agent']['researcher-1']['tokens_in'], 900)

    def test_declined_research_is_reported_and_not_retried(self):
        plan = team_with({'id': 'web', 'role': 'researcher', 'responsibility': 'Docs'},
                         tasks=[{'id': 't0', 'title': 'Look up', 'agent': 'web', 'depends_on': [], 'question': 'What is the newest TLS version?'}])
        plan['agents'] = plan['agents'][:1] + plan['agents'][2:]
        plan['tasks'] = [{**t, 'agent': 'api'} for t in plan['tasks'] if t['id'] != 't0'] + [plan['tasks'][-1]]
        c, manager = self.controller([plan], [complete()])
        ident = self.start_team(c, plan)
        self.wait(lambda: bool(c.research_requests()))
        request = c.research_requests()[0]
        c.decide_research(ident, request['step'], 'reject', request['fingerprint'])
        result = self.done(c, ident)
        task = next(t for t in result['team']['tasks'] if t['id'] == 't0')
        self.assertEqual((task['status'], task['attempts'], task['reason']), ('failed', 1, 'you declined this research'))
        self.assertEqual(manager.questions, [])

    def test_researcher_is_unavailable_until_toolsets_are_named(self):
        self.settings.research_toolsets = ()
        c, _ = self.controller([], [])
        self.assertIn('--research-toolsets', c.role_status()['researcher'])
        self.assertNotIn('researcher', c.available_roles())

    def test_researcher_is_refused_with_credential_toolsets(self):
        self.settings.research_toolsets = ('web', 'browser')
        c, _ = self.controller([], [])
        self.assertIn('saved credentials', c.role_status()['researcher'])
        self.assertNotIn('researcher', c.available_roles(), 'Hermes is not offered a researcher')

    def test_capacity_follows_the_model_slots(self):
        self.settings.max_parallel_agents = 1
        c, _ = self.controller([proposal()], [complete()])
        self.api.hold = True
        ident = self.start_team(c, proposal())
        self.wait(lambda: len(self.api.prompts) == 1)
        time.sleep(.3)
        self.assertEqual(len(self.api.prompts), 1, 'with capacity 1, t1 and t2 do not run at once')
        self.api.hold = False
        self.api.finish()
        self.assertEqual(self.done(c, ident)['status'], 'completed')


class DelegationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.repo = make_repo(root)
        self.settings = Settings(self.repo, root / 'state', poll=.01, notifications=False, run_timeout=60, research_toolsets=('web',))
        self.api = RecordingAPI()
        self.c = None

    def tearDown(self):
        if self.c:
            self.c.shutdown.set()
            for thread in list(self.c.threads.values()):
                thread.join(3)
            self.c.preview.close()
        self.temp.cleanup()

    def wait(self, condition, timeout=8):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            if condition():
                return
            time.sleep(.01)
        self.fail('timed out')

    def test_hermes_delegates_a_review_then_completes(self):
        delegate = {'action': 'delegate', 'role': 'reviewer', 'summary': 'Check the change', 'title': 'Review api.py', 'prompt': 'Review api.py for bugs.'}
        manager = ResearchManager([], [coding('CREATE api.py'), delegate, complete()])
        self.c = Controller(self.settings, self.api, manager)
        self.c.check()
        run = self.c.new('Build an API', f'{sys.executable} -c "import pathlib,sys; sys.exit(0 if pathlib.Path(\'api.py\').exists() else 1)"')
        self.wait(lambda: self.c.store.get('runs', run['id'])['status'] in ('completed', 'failed', 'blocked', 'attention'))
        result = self.c.store.get('runs', run['id'])
        self.assertEqual(result['status'], 'completed', result['summary'])
        steps = self.c.store.steps(run['id'])
        self.assertEqual([s.get('role') or 'coder' for s in steps], ['coder', 'reviewer'])
        self.assertIn('reviewer-1', result['specialists'])
        self.assertIn('specialists', manager.calls[1])
        self.assertIn('"role": "reviewer"', manager.calls[2])

    def test_delegation_limits_are_told_to_hermes(self):
        ask = {'action': 'delegate', 'role': 'designer', 'summary': 's', 'prompt': 'Make it pretty please.'}
        manager = ResearchManager([], [coding('CREATE api.py'), ask, complete()])
        self.c = Controller(self.settings, self.api, manager)
        self.c.check()
        run = self.c.new('Build an API')
        self.wait(lambda: self.c.store.get('runs', run['id'])['status'] in ('completed', 'failed', 'blocked', 'attention'))
        self.assertEqual(self.c.store.get('runs', run['id'])['status'], 'completed')
        self.assertIn("'designer' is not a specialist role", manager.calls[2])

    def test_single_run_research_needs_approval_too(self):
        ask = {'action': 'delegate', 'role': 'researcher', 'summary': 's', 'title': 'Look up', 'question': 'Which Python version is current?'}
        manager = ResearchManager([], [ask, coding('CREATE api.py'), complete()])
        self.c = Controller(self.settings, self.api, manager)
        self.c.check()
        run = self.c.new('Build an API')
        self.wait(lambda: bool(self.c.research_requests()) and self.c.store.get('runs', run['id'])['status'] == 'waiting')
        request = self.c.research_requests()[0]
        self.c.decide_research(run['id'], request['step'], 'approve', request['fingerprint'], 'approve')
        self.wait(lambda: self.c.store.get('runs', run['id'])['status'] in ('completed', 'failed', 'blocked', 'attention'))
        self.assertEqual(self.c.store.get('runs', run['id'])['status'], 'completed')
        self.assertIn('Research report from the web', manager.calls[1])


if __name__ == '__main__':
    unittest.main()
