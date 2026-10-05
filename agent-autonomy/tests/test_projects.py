"""Projects from the dashboard: browsing folders under the projects root, creating a new project
(folder + git + first commit), switching the project for new runs without a restart, and run
history per project."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from engine import Controller, Settings
import projects
from test_workflow import FakeAPI, FakeManager, complete


class BrowseAndCreateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'home'
        (self.root / 'alpha' / 'src').mkdir(parents=True)
        (self.root / 'beta').mkdir()
        (self.root / 'beta' / '.git').mkdir()
        (self.root / '.config').mkdir()
        (self.root / 'notes.txt').write_text('x')
        outside = Path(self.temp.name) / 'elsewhere'
        outside.mkdir()
        (self.root / 'escape').symlink_to(outside)
        (self.root / 'shortcut').symlink_to(self.root / 'alpha')

    def tearDown(self):
        self.temp.cleanup()

    def test_browse_lists_folders_under_the_root_only(self):
        listing = projects.browse(self.root)
        names = [e['name'] for e in listing['entries']]
        self.assertEqual(names, ['alpha', 'beta', 'shortcut'], 'no files, no hidden folders, no links out')
        self.assertEqual({e['name']: e['git'] for e in listing['entries']}['beta'], True)
        self.assertIsNone(listing['parent'], 'the root has no way up')
        inner = projects.browse(self.root, str(self.root / 'alpha'))
        self.assertEqual((inner['parent'], [e['name'] for e in inner['entries']]), (str(self.root), ['src']))
        for bad in (str(Path(self.temp.name) / 'elsewhere'), str(self.root / 'escape'), str(self.root / '..'), '/', str(self.root / 'notes.txt')):
            with self.assertRaises(ValueError, msg=bad):
                projects.browse(self.root, bad)

    def test_create_makes_a_git_project_with_a_first_commit(self):
        with mock.patch.dict(os.environ, {'HOME': str(self.root), 'GIT_CONFIG_NOSYSTEM': '1'}):   # no git identity set
            folder = projects.create(self.root, 'my-app')
        self.assertEqual(folder, (self.root / 'my-app').resolve())
        git = lambda *a: subprocess.run(['git', *a], cwd=folder, capture_output=True, text=True).stdout.strip()
        self.assertEqual(git('rev-parse', '--abbrev-ref', 'HEAD'), 'main')
        self.assertEqual(git('log', '--format=%s'), 'Start my-app')
        self.assertEqual(git('status', '--porcelain'), '')
        with self.assertRaisesRegex(ValueError, 'already exists'):
            projects.create(self.root, 'my-app')
        for bad in ('', '../up', '.hidden', '..', 'x' * 65, 'with space'):
            with self.assertRaises(ValueError, msg=bad):
                projects.create(self.root, bad)
        self.assertFalse((self.root / 'up').exists())

    def test_the_choice_is_remembered_only_while_the_folder_exists(self):
        state = Path(self.temp.name) / 'state'
        state.mkdir()
        self.assertIsNone(projects.load_choice(state))
        projects.save_choice(state, self.root / 'alpha')
        self.assertEqual(projects.load_choice(state), self.root / 'alpha')
        projects.save_choice(state, self.root / 'gone')
        self.assertIsNone(projects.load_choice(state))


class SwitchingProjectsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'home'
        self.first = self.root / 'first'
        self.first.mkdir(parents=True)
        self.state = Path(self.temp.name) / 'state'
        self.state.mkdir()
        self.controllers = []

    def tearDown(self):
        for c in self.controllers:
            c.shutdown.set()
            for thread in list(c.threads.values()):
                thread.join(3)
            c.preview.close()
        self.temp.cleanup()

    def controller(self, decisions=()):
        settings = Settings(self.first, self.state, poll=.01, notifications=False, projects_root=self.root)
        c = Controller(settings, FakeAPI(self.first), FakeManager(list(decisions)))
        c.check()
        self.controllers.append(c)
        return c

    def finish(self, c, ident):
        until = time.monotonic() + 10
        while c.store.get('runs', ident)['status'] not in ('completed', 'failed', 'blocked', 'attention'):
            if time.monotonic() > until:
                self.fail('timed out')
            time.sleep(.02)

    def test_switch_create_and_history_per_project(self):
        c = self.controller([complete()])
        run = c.new('Do it')
        self.finish(c, run['id'])
        self.assertEqual(c.store.get('runs', run['id'])['project'], str(self.first.resolve()))
        with mock.patch.dict(os.environ, {'GIT_CONFIG_NOSYSTEM': '1'}):
            made = c.create_project('second')
        second = str((self.root / 'second').resolve())
        self.assertEqual((made['project'], made['git'], str(c.s.project)), (second, True, second))
        self.assertEqual(str(c.preview.project), second, 'previews follow the project')
        self.assertEqual(c.state()['runs'], [], 'history shows this project only')
        everything = c.state(scope='all')['runs']
        self.assertEqual([(r['id'], r['project']) for r in everything], [(run['id'], str(self.first.resolve()))])
        self.assertEqual(c.state(run['id'])['run']['id'], run['id'], 'a run from another project still opens')
        with self.assertRaisesRegex(ValueError, 'Switch to that project'):
            c.new('Follow up', parent_run=run['id'])
        # Remembered across a restart, over the --project the service was started with.
        again = self.controller()
        self.assertEqual(str(again.s.project), second)

    def test_no_switching_while_a_run_is_active(self):
        c = self.controller()
        other = self.root / 'other'
        other.mkdir()
        c.store.put('runs', {'id': 'r1', 'created': time.time(), 'goal': 'busy', 'title': 'Busy run', 'status': 'coding',
                             'stop': False, 'pending': [], 'project': str(self.first.resolve())})
        with self.assertRaisesRegex(ValueError, 'Busy run'):
            c.select_project(str(other))
        with self.assertRaisesRegex(ValueError, 'before creating a project'):
            c.create_project('third')
        self.assertFalse((self.root / 'third').exists())
        self.assertEqual(c.s.project, self.first.resolve())
        with self.assertRaisesRegex(ValueError, 'Only folders inside'):
            c.browse_projects(str(Path(self.temp.name)))


if __name__ == '__main__':
    unittest.main()
