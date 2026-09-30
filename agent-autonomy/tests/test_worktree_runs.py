"""Runs on git projects work in their own worktree (M6), driven through the real controller."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import app
from engine import Controller, Settings
import workspaces
from test_workflow import FakeAPI, FakeManager, coding, complete
from test_workspaces import make_repo, sh

CHECK_FEATURE = f"{sys.executable} -c \"import pathlib,sys; sys.exit(0 if pathlib.Path('feature.txt').exists() else 1)\""


class WorktreeRunTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.repo = make_repo(root)
        self.settings = Settings(self.repo, root / 'state', poll=.01, notifications=False, run_timeout=60)
        self.api = FakeAPI(self.repo)
        self.controllers = []

    def tearDown(self):
        for c in self.controllers:
            c.shutdown.set()
            for thread in list(c.threads.values()):
                thread.join(3)
            c.preview.close()
        self.temp.cleanup()

    def controller(self, decisions):
        manager = FakeManager(decisions)
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

    def done(self, c, ident):
        self.wait(lambda: c.store.get('runs', ident)['status'] in ('completed', 'failed', 'blocked', 'stopped', 'limit_reached', 'attention'))
        return c.store.get('runs', ident)

    def coder_dir(self, c, ident):
        return Path(c.store.get('runs', ident)['workspace']['agents']['coder-1']['dir'])

    def test_run_works_on_its_branch_and_apply_lands_it(self):
        c, _ = self.controller([coding(), complete()])
        holder = {}
        self.api.on_submit = lambda n: (self.coder_dir(c, holder['id']) / 'feature.txt').write_text('done\n')
        run = c.new('Add a feature', CHECK_FEATURE)
        holder['id'] = run['id']
        result = self.done(c, run['id'])
        self.assertEqual(result['status'], 'completed', result['summary'])
        ws = result['workspace']
        # Every OpenCode call carried the coder worktree, never your checkout.
        dirs = {d for _, d in self.api.directories}
        self.assertEqual(dirs, {ws['agents']['coder-1']['dir']})
        self.assertIn(ws['agents']['coder-1']['dir'], self.api.prompts[0]['parts'][0]['text'])
        # Your checkout is untouched; the verifier passed in the integration worktree.
        self.assertFalse((self.repo / 'feature.txt').exists())
        self.assertEqual(workspaces.git_info(self.repo)['changes'], [])
        step = c.store.steps(run['id'])[0]
        self.assertEqual(step['verification']['status'], 'passed')
        self.assertEqual(step['integration']['status'], 'merged')
        self.assertEqual(step['evidence']['changed_files'], ['feature.txt'])
        status = c.state(run['id'])['workspace']
        self.assertEqual((status['state'], status['commits'], status['apply_blocked']), ('open', 1, ''))
        # Apply merges into main with a merge commit and removes the worktrees.
        c.control(run['id'], 'apply')
        self.assertEqual((self.repo / 'feature.txt').read_text(), 'done\n')
        self.assertTrue(sh(self.repo, 'log', '-1', '--format=%s').startswith('AgentControl: '))
        self.assertFalse(Path(ws['integration']['path']).exists())
        self.assertEqual(c.state(run['id'])['workspace']['state'], 'applied')
        self.assertIn('applied to branch', [e['action'] for e in c.store.audit(run['id'])])
        with self.assertRaises(ValueError):
            c.control(run['id'], 'apply')

    def test_uncommitted_changes_need_explicit_consent(self):
        c, _ = self.controller([coding(), complete()])
        (self.repo / 'README.md').write_text('local edit\n')
        with self.assertRaises(ValueError) as refused:
            c.new('Add a feature')
        self.assertIn('README.md', str(refused.exception))
        self.assertEqual(c.store.runs(), [])
        self.assertEqual(sh(self.repo, 'branch', '--list', 'agentcontrol/*'), '')
        run = c.new('Add a feature', allow_dirty=True)
        self.assertEqual(run['workspace']['dirty_at_start'], ['README.md'])
        # The agent starts from the last commit, and your edit stays yours.
        self.assertEqual((self.coder_dir(c, run['id']) / 'README.md').read_text(), '# demo\n')
        self.assertEqual((self.repo / 'README.md').read_text(), 'local edit\n')
        self.done(c, run['id'])
        self.assertIn('uncommitted', c.state(run['id'])['workspace']['apply_blocked'])

    def test_conflict_reaches_hermes_and_is_resolved_next_turn(self):
        c, manager = self.controller([coding(), coding('Resolve the conflict.', 'correction'), complete()])
        holder = {}

        def act(n):
            ws = c.store.get('runs', holder['id'])['workspace']
            coder = Path(ws['agents']['coder-1']['dir'])
            if n == 1:
                (coder / 'app.py').write_text('def greet():\n    return "coder"\n')
                # Meanwhile another writer changed the same line on integration.
                integ = Path(ws['integration']['path'])
                (integ / 'app.py').write_text('def greet():\n    return "other"\n')
                sh(integ, 'commit', '-q', '-am', 'other writer')
            else:
                self.assertIn('<<<<<<<', (coder / 'app.py').read_text())
                (coder / 'app.py').write_text('def greet():\n    return "coder and other"\n')

        self.api.on_submit = act
        run = c.new('Change the greeting')
        holder['id'] = run['id']
        result = self.done(c, run['id'])
        self.assertEqual(result['status'], 'completed', result['summary'])
        first, second = c.store.steps(run['id'])
        self.assertEqual((first['integration']['status'], first['integration']['files']), ('conflict', ['app.py']))
        self.assertEqual(first['verification']['status'], 'failed')
        context = json.loads(manager.calls[1].split('WORKFLOW CONTEXT:\n', 1)[1])
        self.assertEqual(context['workspace']['last_integration']['status'], 'conflict')
        self.assertIn('conflict markers', context['workspace']['note'])
        self.assertEqual(second['integration']['status'], 'merged')
        integ = Path(result['workspace']['integration']['path'])
        self.assertIn('coder and other', (integ / 'app.py').read_text())

    def test_setup_runs_once_in_each_worktree(self):
        c, _ = self.controller([coding(), complete()])
        run = c.new('Add a feature', setup='touch setup.ok')
        result = self.done(c, run['id'])
        ws = result['workspace']
        self.assertTrue(ws['setup_done'])
        self.assertTrue((Path(ws['integration']['dir']) / 'setup.ok').exists())
        self.assertTrue((Path(ws['agents']['coder-1']['dir']) / 'setup.ok').exists())
        self.assertFalse((self.repo / 'setup.ok').exists())

    def test_missing_worktree_on_resume_needs_attention(self):
        c, _ = self.controller([coding(), complete()])
        self.api.hold = True
        run = c.new('Add a feature')
        self.wait(lambda: len(self.api.prompts) == 1)
        c.shutdown.set()
        c.threads[run['id']].join(3)
        workspaces.remove_worktrees(c.store.get('runs', run['id'])['workspace'])
        restarted, _ = self.controller([complete()])
        self.assertEqual(restarted.store.get('runs', run['id'])['status'], 'interrupted')
        restarted.control(run['id'], 'resume')
        result = self.done(restarted, run['id'])
        self.assertEqual(result['status'], 'attention')
        self.assertIn('worktree is missing', result['summary'])
        self.assertFalse((self.repo / 'feature.txt').exists())

    def test_follow_up_continues_from_an_unapplied_branch_and_discard_cleans_up(self):
        c, _ = self.controller([coding(), complete(), coding(), complete()])
        holder = {}
        self.api.on_submit = lambda n: (self.coder_dir(c, holder['id']) / f'part{n}.txt').write_text('x\n')
        parent = c.new('Part one')
        holder['id'] = parent['id']
        self.done(c, parent['id'])
        child = c.new('Part two', parent_run=parent['id'])
        holder['id'] = child['id']
        self.assertTrue((self.coder_dir(c, child['id']) / 'part1.txt').exists())
        self.done(c, child['id'])
        c.control(parent['id'], 'discard_workspace')
        self.assertEqual(c.state(parent['id'])['workspace'], {'state': 'discarded'})
        self.assertNotIn(f"agentcontrol/{parent['id']}/", sh(self.repo, 'branch', '--list', 'agentcontrol/*'))

    def test_non_git_projects_keep_working_in_the_folder(self):
        plain = Path(self.temp.name) / 'plain'
        plain.mkdir()
        self.settings.project = plain
        self.api = FakeAPI(plain)
        c, _ = self.controller([coding(), complete()])
        run = c.new('Add a feature')
        self.assertEqual(run['workspace'], {'mode': 'folder', 'reason': ''})
        self.done(c, run['id'])
        self.assertEqual({d for _, d in self.api.directories}, {None})
        self.assertIsNone(c.state(run['id'])['workspace'])

    def test_preflight_api(self):
        c, _ = self.controller([])
        (self.repo / 'new.txt').write_text('x')
        server = ThreadingHTTPServer(('127.0.0.1', 0), app.handler(c, 'k'))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            request = urllib.request.Request(f'http://127.0.0.1:{server.server_port}/api/workspace/preflight', headers={'Authorization': 'Bearer k'})
            body = json.load(urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request))
        finally:
            server.shutdown()
            server.server_close()
        self.assertEqual((body['usable'], body['branch'], body['untracked'], body['dirty_count']), (True, 'main', ['new.txt'], 1))


if __name__ == '__main__':
    unittest.main()
