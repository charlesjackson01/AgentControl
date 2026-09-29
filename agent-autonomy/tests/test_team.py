"""Team runs (M7): proposal, your approval, parallel tasks in worktrees, retries, review, resume."""
import copy
import json
from pathlib import Path
import re
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from engine import Controller, ReviewConflict, Settings
import planner
import workspaces
from test_workflow import complete
from test_workspaces import make_repo, sh


def proposal(**changes):
    value = {'mode': 'multi', 'reason': 'API and UI are independent',
             'agents': [{'id': 'api', 'role': 'coder', 'responsibility': 'Backend'},
                        {'id': 'ui', 'role': 'coder', 'responsibility': 'Frontend'}],
             'tasks': [{'id': 't1', 'title': 'API', 'agent': 'api', 'depends_on': [], 'files': ['api.py'], 'prompt': 'CREATE api.py'},
                       {'id': 't2', 'title': 'UI', 'agent': 'ui', 'depends_on': [], 'files': ['ui.html'], 'prompt': 'CREATE ui.html'},
                       {'id': 't3', 'title': 'Wire', 'agent': 'api', 'depends_on': ['t1', 't2'], 'files': ['wire.txt'], 'prompt': 'CREATE wire.txt'}]}
    value.update(changes)
    return value


class FakeTeamAPI:
    """OpenCode with one session per agent, each bound to its own directory."""

    def __init__(self):
        self.sessions = {}
        self.prompts = []
        self.pending_items = []
        self.decisions = []
        self.hold = False
        self.aborts = []
        self.on_submit = self.create_file
        self.error_for = set()

    def health(self):
        return {'healthy': True}

    @staticmethod
    def create_file(session, text):
        match = re.search(r'CREATE (\S+)', text)
        if match:
            (Path(session['directory']) / match.group(1)).write_text(f"made by {session['title']}\n")

    def pending(self, session, directory=None):
        assert directory == self.sessions[session]['directory'], 'approvals must be read in the agent directory'
        return copy.deepcopy([p for p in self.pending_items if p['sessionID'] == session])

    def respond(self, session, request, action, answers=None, directory=None):
        assert directory == self.sessions[session]['directory']
        self.decisions.append((session, request['id'], action))
        self.pending_items = [p for p in self.pending_items if p['id'] != request['id']]
        return True

    def request(self, path, method='GET', data=None, directory=None):
        if path == '/session' and method == 'POST':
            sid = f'ses_{len(self.sessions) + 1}'
            self.sessions[sid] = {'directory': str(directory), 'title': data['title'], 'messages': [], 'busy': False}
            return {'id': sid}
        parts = path.split('/')
        if path == '/session/status':
            return {sid: {'type': 'busy'} for sid, s in self.sessions.items() if s['busy']}
        sid = parts[2]
        session = self.sessions[sid]
        if path.endswith('/prompt_async'):
            assert str(directory) == session['directory'], 'prompts must go to the agent directory'
            text = data['parts'][0]['text']
            self.prompts.append((sid, text))
            session['messages'].append({'info': {'id': data['messageID'], 'role': 'user'}, 'parts': data['parts']})
            info = {'id': f'a{len(self.prompts)}', 'role': 'assistant', 'parentID': data['messageID'], 'time': {}, 'finish': 'stop'}
            if any(key in text for key in self.error_for):
                info['error'] = {'name': 'ProviderError'}
            session['messages'].append({'info': info, 'parts': [{'type': 'text', 'text': 'Done.'}]})
            self.on_submit(session, text)
            session['busy'] = self.hold
            if not self.hold:
                info['time']['completed'] = 1
            return None
        if path.endswith('/message'):
            return copy.deepcopy(session['messages'])
        if path.endswith('/abort'):
            self.aborts.append(sid)
            self.finish(sid)
            return True
        raise AssertionError(path)

    def finish(self, sid=None):
        for key, session in self.sessions.items():
            if sid in (None, key):
                session['busy'] = False
                for m in session['messages']:
                    if m['info']['role'] == 'assistant':
                        m['info']['time']['completed'] = 1


class FakeTeamManager:
    def __init__(self, proposals, decisions):
        self.proposals, self.decisions = list(proposals), list(decisions)
        self.json_calls, self.calls = [], []

    def inspect(self):
        return {}

    def run_json(self, prompt, cancel):
        self.json_calls.append(prompt)
        item = self.proposals.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    def decide(self, prompt, cancel):
        self.calls.append(prompt)
        return self.decisions.pop(0)


class PlannerTests(unittest.TestCase):
    def test_valid_proposal_maps_agents_to_coder_names(self):
        plan, problems, warnings = planner.validate(proposal(), 3, 8)
        self.assertEqual((problems, warnings), ([], []))
        self.assertEqual(plan['agents']['coder-1']['label'], 'api')
        self.assertEqual([t['agent'] for t in plan['tasks']], ['coder-1', 'coder-2', 'coder-1'])
        self.assertEqual([t['id'] for t in planner.ready(plan['tasks'])], ['t1', 't2'])

    def test_problems_are_reported(self):
        tasks = proposal()['tasks']
        cases = {
            'unknown agent': proposal(tasks=[{**tasks[0], 'agent': 'ghost'}]),
            'cycle': proposal(tasks=[{**tasks[0], 'depends_on': ['t2']}, {**tasks[1], 'depends_on': ['t1']}]),
            'dangling': proposal(tasks=[{**tasks[0], 'depends_on': ['t9']}]),
            'no prompt': proposal(tasks=[{**tasks[0], 'prompt': ''}]),
            'role': proposal(agents=[{'id': 'api', 'role': 'researcher', 'responsibility': 'x'}], tasks=[tasks[0]]),
            'single with two': proposal(mode='single'),
            'too many agents': proposal(agents=[{'id': f'a{n}', 'role': 'coder', 'responsibility': 'x'} for n in range(4)]),
            'duplicate task': proposal(tasks=[tasks[0], tasks[0]]),
        }
        for name, value in cases.items():
            with self.subTest(name):
                plan, problems, _ = planner.validate(value, 3, 8)
                self.assertIsNone(plan)
                self.assertTrue(problems)
        self.assertTrue(planner.validate(proposal(), 3, 2)[1], 'too many tasks for the prompt limit')
        self.assertEqual(planner.validate('nope')[1], ['the proposal is not a JSON object'])

    def test_unordered_shared_files_are_a_warning(self):
        tasks = proposal()['tasks']
        _, problems, warnings = planner.validate(proposal(tasks=[{**tasks[0], 'files': ['app.py']}, {**tasks[1], 'files': ['app.py']}]), 3, 8)
        self.assertEqual(problems, [])
        self.assertIn('may conflict', warnings[0])
        _, _, ordered = planner.validate(proposal(tasks=[{**tasks[0], 'files': ['app.py']}, {**tasks[1], 'files': ['app.py'], 'depends_on': ['t1']}]), 3, 8)
        self.assertEqual(ordered, [])

    def test_failed_tasks_block_their_dependents(self):
        plan = planner.validate(proposal(), 3, 8)[0]
        plan['tasks'][1]['status'] = 'failed'
        changed = planner.block_dependents(plan['tasks'])
        self.assertEqual([t['id'] for t in changed], ['t3'])


class WorkspaceTeamTests(unittest.TestCase):
    def test_add_agent_and_sync_from_integration(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = make_repo(temp)
            ws = workspaces.create(workspaces.git_info(repo), Path(temp) / 'wt', 'run1')
            one = Path(ws['agents']['coder-1']['path'])
            (one / 'a.txt').write_text('a')
            workspaces.commit_turn(one, 'a')
            workspaces.integrate(ws, 'coder-1')
            workspaces.add_agent(ws, 'coder-2')
            two = Path(ws['agents']['coder-2']['path'])
            self.assertTrue((two / 'a.txt').exists(), 'a new agent starts from the merged work')
            self.assertEqual(sh(two, 'branch', '--show-current'), 'agentcontrol/run1/coder-2')
            (two / 'b.txt').write_text('b')
            workspaces.commit_turn(two, 'b')
            workspaces.integrate(ws, 'coder-2')
            self.assertEqual(workspaces.sync_agent(ws, 'coder-1')['status'], 'updated')
            self.assertTrue((one / 'b.txt').exists())
            self.assertEqual(workspaces.sync_agent(ws, 'coder-1')['status'], 'current')


class TeamRunTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.repo = make_repo(root)
        self.settings = Settings(self.repo, root / 'state', poll=.01, notifications=False, run_timeout=60)
        self.api = FakeTeamAPI()
        self.controllers = []

    def tearDown(self):
        for c in self.controllers:
            c.shutdown.set()
            for thread in list(c.threads.values()):
                thread.join(3)
            c.preview.close()
        self.temp.cleanup()

    def controller(self, proposals, decisions):
        manager = FakeTeamManager(proposals, decisions)
        c = Controller(self.settings, self.api, manager)
        c.check()
        self.controllers.append(c)
        return c, manager

    def wait(self, condition, timeout=8):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            if condition():
                return
            time.sleep(.01)
        self.fail('timed out')

    def run_of(self, c, ident):
        return c.store.get('runs', ident)

    def done(self, c, ident):
        self.wait(lambda: self.run_of(c, ident)['status'] in ('completed', 'failed', 'blocked', 'stopped', 'limit_reached', 'attention'))
        return self.run_of(c, ident)

    def awaiting(self, c, ident):
        self.wait(lambda: self.run_of(c, ident)['status'] == 'awaiting_approval')
        return self.run_of(c, ident)

    def test_team_plans_waits_for_you_runs_in_parallel_and_completes(self):
        check = f"{sys.executable} -c \"import pathlib,sys; sys.exit(0 if all(pathlib.Path(f).exists() for f in ['api.py','ui.html','wire.txt']) else 1)\""
        c, manager = self.controller([proposal()], [complete()])
        self.api.hold = True
        run = c.new('Build an API and a UI', check, mode='team', team_size=2)
        waiting = self.awaiting(c, run['id'])
        self.assertEqual(waiting['team']['state'], 'proposed')
        self.assertIn('Hermes proposes 2 agents and 3 tasks', waiting['summary'])
        self.assertIn('at most 2 agents', manager.json_calls[0])
        time.sleep(.1)
        self.assertEqual(self.api.prompts, [], 'nothing is sent before you approve')
        self.assertEqual(c.agents(waiting)[0]['state'], 'waiting_on_you')
        c.control(run['id'], 'approve_team')
        # t1 and t2 run at the same time, each in its own worktree and session.
        self.wait(lambda: len(self.api.prompts) == 2)
        ws = self.run_of(c, run['id'])['workspace']
        self.assertEqual({self.api.sessions[sid]['directory'] for sid, _ in self.api.prompts},
                         {ws['agents']['coder-1']['dir'], ws['agents']['coder-2']['dir']})
        live = {a['name']: a['state'] for a in c.agents(self.run_of(c, run['id']))}
        self.assertEqual((live['coder-1'], live['coder-2']), ('working', 'working'))
        self.assertIn('TEAM CONTEXT', self.api.prompts[0][1])
        self.api.hold = False
        self.api.finish()
        result = self.done(c, run['id'])
        self.assertEqual(result['status'], 'completed', result['summary'])
        tasks = {t['id']: t for t in result['team']['tasks']}
        self.assertEqual({t['status'] for t in tasks.values()}, {'done'})
        # t3 started only after t1 and t2 merged, on a worktree that already had both.
        wire_prompt = next(text for _, text in self.api.prompts if 'CREATE wire.txt' in text)
        self.assertEqual(len(self.api.prompts), 3)
        self.assertTrue((Path(ws['agents']['coder-1']['dir']) / 'ui.html').exists())
        self.assertIn('coder-1 (api)', wire_prompt)
        integ = Path(ws['integration']['dir'])
        self.assertEqual(sorted(p.name for p in integ.iterdir() if p.suffix in ('.py', '.html', '.txt') and p.name != 'app.py'),
                         ['api.py', 'ui.html', 'wire.txt'])
        self.assertFalse((self.repo / 'api.py').exists(), 'your checkout is untouched until Apply')
        context = json.loads(manager.calls[0].split('WORKFLOW CONTEXT:\n', 1)[1])
        self.assertEqual([t['status'] for t in context['team']['tasks']], ['done', 'done', 'done'])
        self.assertEqual({a['name']: a.get('label') for a in c.store.agents(run['id']) if a['type'] == 'coder'},
                         {'coder-1': 'api', 'coder-2': 'ui'})
        self.assertIn('team approved', [e['action'] for e in c.store.audit(run['id'])])
        c.control(run['id'], 'apply')
        self.assertTrue((self.repo / 'wire.txt').exists())

    def test_you_can_run_it_as_a_single_agent(self):
        c, manager = self.controller([proposal()], [{'action': 'code', 'title': 'All', 'summary': 's', 'prompt': 'CREATE all.txt'}, complete()])
        run = c.new('Build it', mode='team')
        self.awaiting(c, run['id'])
        c.control(run['id'], 'single_agent')
        result = self.done(c, run['id'])
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(list(result['workspace']['agents']), ['coder-1'])
        self.assertEqual(len(self.api.sessions), 1)
        self.assertEqual(result['team']['state'], 'single')

    def test_ask_again_sends_your_note_and_is_bounded(self):
        c, manager = self.controller([proposal(), proposal(), proposal()], [complete()])
        run = c.new('Build it', mode='team')
        self.awaiting(c, run['id'])
        c.control(run['id'], 'repropose', 'Put the UI and the API in one agent.')
        self.wait(lambda: len(manager.json_calls) == 2 and self.run_of(c, run['id'])['status'] == 'awaiting_approval')
        self.assertIn('Put the UI and the API in one agent.', manager.json_calls[1])
        with self.assertRaises(ValueError):
            c.control(run['id'], 'repropose', '')
        c.control(run['id'], 'repropose', 'Again.')
        self.wait(lambda: len(manager.json_calls) == 3 and self.run_of(c, run['id'])['status'] == 'awaiting_approval')
        with self.assertRaises(ValueError):
            c.control(run['id'], 'repropose', 'One more.')
        c.control(run['id'], 'stop')
        self.assertEqual(self.done(c, run['id'])['status'], 'stopped')

    def test_unusable_proposals_can_only_run_single(self):
        c, manager = self.controller([{'mode': 'multi'}, RuntimeError('Hermes did not return JSON')],
                                     [{'action': 'code', 'title': 'All', 'summary': 's', 'prompt': 'CREATE all.txt'}, complete()])
        run = c.new('Build it', mode='team')
        waiting = self.awaiting(c, run['id'])
        self.assertEqual(waiting['team']['state'], 'unusable')
        self.assertIn('Hermes did not return JSON', waiting['team']['problems'][0])
        self.assertIn('These problems must be fixed', manager.json_calls[1])
        with self.assertRaises(ValueError):
            c.control(run['id'], 'approve_team')
        c.control(run['id'], 'single_agent')
        self.assertEqual(self.done(c, run['id'])['status'], 'completed')

    def test_conflicting_tasks_are_retried_with_a_resolution_prompt(self):
        tasks = proposal()['tasks'][:2]
        tasks = [{**tasks[0], 'files': ['shared.txt'], 'prompt': 'WRITE shared from api'},
                 {**tasks[1], 'files': ['shared.txt'], 'prompt': 'WRITE shared from ui'}]

        def act(session, text):
            folder = Path(session['directory'])
            if 'Resolve every conflict' in text:
                self.assertIn('<<<<<<<', (folder / 'shared.txt').read_text())
                (folder / 'shared.txt').write_text('api and ui\n')
            elif 'WRITE shared' in text:
                (folder / 'shared.txt').write_text(text.split('WRITE ', 1)[1].split('\n', 1)[0] + '\n')

        self.api.on_submit = act
        c, _ = self.controller([proposal(tasks=tasks)], [complete()])
        run = c.new('Share a file', mode='team')
        waiting = self.awaiting(c, run['id'])
        self.assertIn('may conflict', waiting['team']['warnings'][0])
        c.control(run['id'], 'approve_team')
        result = self.done(c, run['id'])
        self.assertEqual(result['status'], 'completed', result['summary'])
        attempts = sorted(t['attempts'] for t in result['team']['tasks'])
        self.assertEqual(attempts, [1, 2])
        self.assertEqual((Path(result['workspace']['integration']['dir']) / 'shared.txt').read_text(), 'api and ui\n')

    def test_retries_are_bounded_and_dependents_are_blocked(self):
        self.api.error_for = {'CREATE ui.html'}
        c, manager = self.controller([proposal()], [{'action': 'blocked', 'summary': 'The UI task keeps failing.'}])
        run = c.new('Build it', mode='team')
        self.awaiting(c, run['id'])
        c.control(run['id'], 'approve_team')
        result = self.done(c, run['id'])
        self.assertEqual(result['status'], 'blocked')
        tasks = {t['id']: t for t in result['team']['tasks']}
        self.assertEqual((tasks['t2']['status'], tasks['t2']['attempts']), ('failed', 3))
        self.assertEqual((tasks['t1']['status'], tasks['t3']['status']), ('done', 'blocked'))
        self.assertEqual(sum('CREATE ui.html' in text for _, text in self.api.prompts), 3)
        self.assertFalse(any('CREATE wire.txt' in text for _, text in self.api.prompts))
        context = json.loads(manager.calls[0].split('WORKFLOW CONTEXT:\n', 1)[1])
        self.assertEqual({t['id']: t['status'] for t in context['team']['tasks']}, {'t1': 'done', 't2': 'failed', 't3': 'blocked'})

    def test_review_phase_can_send_a_fix_to_a_named_agent(self):
        fix = {'action': 'code', 'title': 'Polish UI', 'summary': 's', 'prompt': 'CREATE polish.css', 'agent': 'coder-2'}
        c, _ = self.controller([proposal()], [fix, complete()])
        run = c.new('Build it', mode='team')
        self.awaiting(c, run['id'])
        c.control(run['id'], 'approve_team')
        result = self.done(c, run['id'])
        self.assertEqual(result['status'], 'completed')
        last = c.store.steps(run['id'])[-1]
        self.assertEqual(last['agent'], 'coder-2')
        self.assertTrue((Path(result['workspace']['integration']['dir']) / 'polish.css').exists())

    def test_approvals_from_any_agent_reach_you_and_go_back_to_that_agent(self):
        c, _ = self.controller([proposal()], [complete()])
        self.api.hold = True
        run = c.new('Build it', mode='team')
        self.awaiting(c, run['id'])
        c.control(run['id'], 'approve_team')
        self.wait(lambda: len(self.api.prompts) == 2)
        coder2 = self.run_of(c, run['id'])['team']['agents']['coder-2']['session']
        self.api.pending_items = [{'kind': 'permission', 'id': 'per_9', 'sessionID': coder2, 'permission': 'bash', 'patterns': ['npm test']}]
        self.wait(lambda: bool(c.state(run['id'])['inbox']))
        packet = c.state(run['id'])['inbox'][0]
        self.assertEqual(packet['agent'], 'coder-2')
        self.assertEqual({a['name']: a['state'] for a in c.agents(self.run_of(c, run['id']))}['coder-2'], 'waiting_on_you')
        c.review(run['id'], 'permission', 'per_9', packet['fingerprint'], 'approve')
        self.assertEqual(self.api.decisions, [(coder2, 'per_9', 'approve')])
        self.assertIn('coder-2', [e.get('actor') for e in c.store.audit(run['id']) if e['action'] == 'requested'])
        self.api.hold = False
        self.api.finish()
        self.assertEqual(self.done(c, run['id'])['status'], 'completed')

    def test_restart_mid_run_resumes_without_resending(self):
        c, _ = self.controller([proposal()], [])
        self.api.hold = True
        run = c.new('Build it', mode='team')
        self.awaiting(c, run['id'])
        c.control(run['id'], 'approve_team')
        self.wait(lambda: len(self.api.prompts) == 2)
        c.shutdown.set()
        c.threads[run['id']].join(3)
        restarted, _ = self.controller([], [complete()])
        self.assertEqual(self.run_of(restarted, run['id'])['status'], 'interrupted')
        restarted.control(run['id'], 'resume')
        time.sleep(.2)
        self.assertEqual(len(self.api.prompts), 2, 'running tasks are reconciled, not resent')
        self.api.hold = False
        self.api.finish()
        result = self.done(restarted, run['id'])
        self.assertEqual(result['status'], 'completed', result['summary'])
        self.assertEqual(len(self.api.prompts), 3)

    def test_restart_while_waiting_for_approval_does_not_propose_again(self):
        c, manager = self.controller([proposal()], [])
        run = c.new('Build it', mode='team')
        self.awaiting(c, run['id'])
        c.shutdown.set()
        c.threads[run['id']].join(3)
        restarted, again = self.controller([], [complete()])
        restarted.control(run['id'], 'resume')
        self.awaiting(restarted, run['id'])
        self.assertEqual(again.json_calls, [])
        restarted.control(run['id'], 'approve_team')
        self.assertEqual(self.done(restarted, run['id'])['status'], 'completed')

    def test_stop_aborts_every_working_agent(self):
        c, _ = self.controller([proposal()], [])
        self.api.hold = True
        run = c.new('Build it', mode='team')
        self.awaiting(c, run['id'])
        c.control(run['id'], 'approve_team')
        self.wait(lambda: len(self.api.prompts) == 2)
        c.control(run['id'], 'stop')
        self.assertEqual(self.done(c, run['id'])['status'], 'stopped')
        self.assertEqual(sorted(self.api.aborts), sorted({sid for sid, _ in self.api.prompts}))

    def test_team_runs_need_git_and_a_valid_size(self):
        c, _ = self.controller([], [])
        with self.assertRaises(ValueError):
            c.new('Build it', mode='team', team_size=9)
        plain = Path(self.temp.name) / 'plain'
        plain.mkdir()
        self.settings.project = plain
        other, _ = self.controller([], [])
        with self.assertRaises(ValueError) as refused:
            other.new('Build it', mode='team')
        self.assertIn('git project', str(refused.exception))


if __name__ == '__main__':
    unittest.main()
