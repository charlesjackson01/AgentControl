"""Git worktrees (M6), against real temporary repositories."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import verify
import workspaces as ws_mod


def sh(cwd, *args):
    return subprocess.run(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', *args], cwd=cwd, check=True,
                          capture_output=True, text=True).stdout.strip()


def make_repo(root):
    repo = Path(root) / 'repo'
    repo.mkdir()
    sh(repo, 'init', '-q', '-b', 'main')
    (repo / 'app.py').write_text('def greet():\n    return "hello"\n')
    (repo / 'README.md').write_text('# demo\n')
    sh(repo, 'add', '-A')
    sh(repo, 'commit', '-q', '-m', 'initial')
    return repo


class Base(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.repo = make_repo(self.temp.name)
        self.state = Path(self.temp.name) / 'state' / 'worktrees'

    def tearDown(self):
        self.temp.cleanup()

    def workspace(self, agents=('coder-1',)):
        return ws_mod.create(ws_mod.git_info(self.repo), self.state, 'run1', agents)


class InfoTests(Base):
    def test_clean_repo(self):
        info = ws_mod.git_info(self.repo)
        self.assertTrue(info['usable'])
        self.assertEqual((info['branch'], info['subdir'], info['changes'], info['untracked']), ('main', '', [], []))

    def test_dirty_untracked_and_subdir(self):
        (self.repo / 'app.py').write_text('changed\n')
        (self.repo / 'sub').mkdir()
        (self.repo / 'sub' / 'new.txt').write_text('x')
        info = ws_mod.git_info(self.repo / 'sub')
        self.assertEqual((info['changes'], info['untracked'], info['subdir']), (['app.py'], ['sub/new.txt'], 'sub'))

    def test_not_a_repo_detached_and_empty(self):
        plain = Path(self.temp.name) / 'plain'
        plain.mkdir()
        self.assertFalse(ws_mod.git_info(plain)['is_repo'])
        sh(self.repo, 'checkout', '-q', '--detach')
        self.assertIn('detached', ws_mod.git_info(self.repo)['reason'])
        empty = Path(self.temp.name) / 'empty'
        empty.mkdir()
        sh(empty, 'init', '-q')
        self.assertIn('no commits', ws_mod.git_info(empty)['reason'])
        with self.assertRaises(ws_mod.WorkspaceError):
            ws_mod.create(ws_mod.git_info(empty), self.state, 'run1')


class LifecycleTests(Base):
    def test_create_commit_integrate_and_evidence(self):
        ws = self.workspace()
        coder = Path(ws['agents']['coder-1']['path'])
        self.assertEqual(sh(coder, 'branch', '--show-current'), 'agentcontrol/run1/coder-1')
        self.assertEqual(ws['base_branch'], 'main')
        self.assertEqual(ws_mod.check(ws), [])
        self.assertEqual(ws_mod.commit_turn(coder, 'nothing')['status'], 'unchanged')
        (coder / 'app.py').write_text('def greet():\n    return "hi"\n')
        (coder / 'notes.txt').write_text('new file\n')
        turn = ws_mod.commit_turn(coder, 'Turn 1')
        self.assertEqual(turn['status'], 'committed')
        result = ws_mod.integrate(ws, 'coder-1')
        self.assertEqual(result['status'], 'merged')
        integ = Path(ws['integration']['path'])
        self.assertEqual((integ / 'notes.txt').read_text(), 'new file\n')
        # Your checkout is untouched.
        self.assertFalse((self.repo / 'notes.txt').exists())
        self.assertEqual(ws_mod.git_info(self.repo)['changes'], [])
        proof = ws_mod.evidence(integ, ws['base'], result['commit'])
        self.assertEqual(set(proof), set(verify.evidence({'files': {}}, {'files': {}})))
        self.assertEqual(sorted(proof['changed_files']), ['app.py', 'notes.txt'])
        stats = {s['path']: s for s in proof['file_stats']}
        self.assertEqual((stats['notes.txt']['change'], stats['notes.txt']['added']), ('new', 1))
        self.assertEqual((stats['app.py']['added'], stats['app.py']['removed']), (1, 1))
        self.assertEqual(ws_mod.summary(ws)['commits'], 1)
        self.assertEqual(ws_mod.integrate(ws, 'coder-1')['status'], 'unchanged')

    def test_evidence_has_no_file_cap(self):
        ws = self.workspace()
        coder = Path(ws['agents']['coder-1']['path'])
        for n in range(150):
            (coder / f'f{n}.txt').write_text(f'{n}\n')
        ws_mod.commit_turn(coder, 'many')
        result = ws_mod.integrate(ws, 'coder-1')
        self.assertEqual(len(ws_mod.evidence(coder, ws['base'], result['commit'])['changed_files']), 150)

    def test_parallel_agents_on_different_files_both_merge(self):
        ws = self.workspace(('coder-1', 'coder-2'))
        a, b = Path(ws['agents']['coder-1']['path']), Path(ws['agents']['coder-2']['path'])
        (a / 'a.txt').write_text('a\n')
        (b / 'b.txt').write_text('b\n')
        ws_mod.commit_turn(a, 'a')
        ws_mod.commit_turn(b, 'b', author='coder-2')
        self.assertEqual(ws_mod.integrate(ws, 'coder-1')['status'], 'merged')
        self.assertEqual(ws_mod.integrate(ws, 'coder-2')['status'], 'merged')
        integ = Path(ws['integration']['path'])
        self.assertTrue((integ / 'a.txt').exists() and (integ / 'b.txt').exists())
        self.assertFalse((a / 'b.txt').exists(), 'agents stay isolated until their next integration')

    def test_same_lines_conflict_leaves_integration_untouched_and_hands_markers_to_agent(self):
        ws = self.workspace(('coder-1', 'coder-2'))
        a, b = Path(ws['agents']['coder-1']['path']), Path(ws['agents']['coder-2']['path'])
        (a / 'app.py').write_text('def greet():\n    return "from a"\n')
        (b / 'app.py').write_text('def greet():\n    return "from b"\n')
        ws_mod.commit_turn(a, 'a')
        ws_mod.commit_turn(b, 'b')
        first = ws_mod.integrate(ws, 'coder-1')
        integ = Path(ws['integration']['path'])
        conflict = ws_mod.integrate(ws, 'coder-2')
        self.assertEqual((conflict['status'], conflict['files']), ('conflict', ['app.py']))
        self.assertEqual(sh(integ, 'rev-parse', 'HEAD'), first['commit'])
        self.assertEqual(sh(integ, 'status', '--porcelain'), '')
        self.assertIn('<<<<<<<', (b / 'app.py').read_text())
        # Markers are never committed; a resolution is.
        self.assertEqual(ws_mod.commit_turn(b, 'still broken')['status'], 'unresolved')
        (b / 'app.py').write_text('def greet():\n    return "from a and b"\n')
        self.assertEqual(ws_mod.commit_turn(b, 'resolved')['status'], 'committed')
        self.assertEqual(ws_mod.integrate(ws, 'coder-2')['status'], 'merged')
        self.assertIn('from a and b', (integ / 'app.py').read_text())

    def test_internal_commits_skip_repository_hooks(self):
        hook = self.repo / '.git' / 'hooks' / 'pre-commit'
        hook.write_text('#!/bin/sh\nexit 1\n')
        os.chmod(hook, 0o755)
        ws = self.workspace()
        coder = Path(ws['agents']['coder-1']['path'])
        (coder / 'x.txt').write_text('x')
        self.assertEqual(ws_mod.commit_turn(coder, 'x')['status'], 'committed')

    def test_subdirectory_projects_work_in_the_same_subdirectory(self):
        (self.repo / 'site').mkdir()
        (self.repo / 'site' / 'index.html').write_text('<p>hi</p>\n')
        sh(self.repo, 'add', '-A')
        sh(self.repo, 'commit', '-q', '-m', 'site')
        ws = ws_mod.create(ws_mod.git_info(self.repo / 'site'), self.state, 'run2')
        self.assertTrue(ws['agents']['coder-1']['dir'].endswith('/coder-1/site'))
        self.assertTrue((Path(ws['agents']['coder-1']['dir']) / 'index.html').exists())


class ApplyTests(Base):
    def finished(self):
        ws = self.workspace()
        coder = Path(ws['agents']['coder-1']['path'])
        (coder / 'feature.txt').write_text('done\n')
        ws_mod.commit_turn(coder, 'feature')
        ws_mod.integrate(ws, 'coder-1')
        return ws

    def test_apply_needs_a_clean_checkout_on_the_base_branch(self):
        ws = self.finished()
        (self.repo / 'README.md').write_text('local edit\n')
        self.assertIn('uncommitted', ws_mod.apply_ready(ws))
        with self.assertRaises(ws_mod.WorkspaceError):
            ws_mod.apply(ws, 'x')
        sh(self.repo, 'checkout', '-q', 'README.md')
        sh(self.repo, 'checkout', '-q', '-b', 'other')
        self.assertIn('switch to main', ws_mod.apply_ready(ws))
        sh(self.repo, 'checkout', '-q', 'main')
        # Untracked files alone do not block Apply.
        (self.repo / 'scratch.txt').write_text('mine')
        self.assertEqual(ws_mod.apply_ready(ws), '')

    def test_apply_makes_a_merge_commit_and_discard_cleans_up(self):
        ws = self.finished()
        result = ws_mod.apply(ws, 'AgentControl: feature')
        self.assertEqual(result['status'], 'applied')
        self.assertEqual((self.repo / 'feature.txt').read_text(), 'done\n')
        self.assertEqual(sh(self.repo, 'log', '-1', '--format=%s'), 'AgentControl: feature')
        self.assertEqual(len(sh(self.repo, 'log', '-1', '--format=%P').split()), 2)
        ws_mod.discard(ws)
        self.assertFalse(Path(ws['integration']['path']).exists())
        self.assertEqual(sh(self.repo, 'branch', '--list', 'agentcontrol/*'), '')
        self.assertNotEqual(ws_mod.check(ws), [])

    def test_apply_conflict_leaves_your_branch_unchanged(self):
        ws = self.workspace()
        coder = Path(ws['agents']['coder-1']['path'])
        (coder / 'app.py').write_text('agent version\n')
        ws_mod.commit_turn(coder, 'agent')
        ws_mod.integrate(ws, 'coder-1')
        (self.repo / 'app.py').write_text('your version\n')
        sh(self.repo, 'commit', '-q', '-am', 'yours')
        before = sh(self.repo, 'rev-parse', 'HEAD')
        result = ws_mod.apply(ws, 'x')
        self.assertEqual((result['status'], result['files']), ('conflict', ['app.py']))
        self.assertEqual(sh(self.repo, 'rev-parse', 'HEAD'), before)
        self.assertEqual(sh(self.repo, 'status', '--porcelain'), '')
        self.assertEqual((self.repo / 'app.py').read_text(), 'your version\n')

    def test_remove_worktrees_keeps_branches(self):
        ws = self.finished()
        ws_mod.remove_worktrees(ws)
        self.assertFalse(Path(ws['agents']['coder-1']['path']).exists())
        self.assertIn('agentcontrol/run1/integration', sh(self.repo, 'branch', '--list', 'agentcontrol/*'))
        self.assertTrue(ws_mod.summary(ws)['exists'])


if __name__ == '__main__':
    unittest.main()
