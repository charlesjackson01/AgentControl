"""M9.1 device prerequisites use the real server and disposable state only."""
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from urllib.parse import urlencode

sys.path[:0] = [str(Path(__file__).resolve().parent), str(Path(__file__).resolve().parents[1])]
from device_fixture import DeviceFixture
from test_workflow import coding, complete
from test_workspaces import make_repo


class DeviceFixtureTests(unittest.TestCase):
    def test_short_readable_default_key(self):
        from device_fixture import KEY_ALPHABET
        for _ in range(100):
            key = DeviceFixture().key
            self.assertEqual(len(key), 8)
            self.assertTrue(set(key) <= set(KEY_ALPHABET))
            self.assertFalse(set(key) & set('0o1l'))

    def test_explicit_key_is_preserved(self):
        self.assertEqual(DeviceFixture(key='Device-123!').key, 'Device-123!')

    def test_non_ascii_keys_are_refused_before_fixture_setup(self):
        from device_fixture import fixture_key
        for value in ['cléé', 'abcd😀', 'abcd\u200b', '漢字漢字']:
            with self.subTest(value=value), self.assertRaisesRegex(ValueError,'ASCII'):
                fixture_key(value)

    def test_invalid_keys_are_refused(self):
        for key in ['', 'abc', 'a' * 65, 'has space', 'abcd\n', 'abcd\t', 'abcd\x00']:
            with self.subTest(key=repr(key)), self.assertRaises(ValueError):
                DeviceFixture(key=key)

    def test_cli_key_validation(self):
        import subprocess
        for key in ['abc', 'has space', 'a' * 65]:
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('device_fixture.py')), '--key', key], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn('4–64 printable ASCII characters with no spaces', result.stderr)

    def test_real_chat_and_two_actionable_requests_are_isolated_and_cleaned(self):
        # A disposable stand-in for the owner's home makes the old default-root escape
        # reproducible without browsing or modifying any real user project.
        with tempfile.TemporaryDirectory(prefix='device-outside-') as home, patch('engine.Path.home', return_value=Path(home)):
            self.check_fixture(Path(home))

    def check_fixture(self, home):
        outside = make_repo(home)
        original = {p.relative_to(outside): p.read_bytes() for p in outside.rglob('*') if p.is_file()}
        fixture = DeviceFixture(host='127.0.0.1', port=0)
        try:
            fixture.start()
            root = fixture.root
            with urlopen(fixture.url + '/chat', timeout=5) as response:
                self.assertEqual(response.status, 200)
            def read(path):
                request = Request(fixture.url + path, headers={'Authorization': 'Bearer ' + fixture.key})
                with urlopen(request, timeout=5) as response:
                    return json.load(response)
            def post(path, body):
                request = Request(fixture.url + path, data=json.dumps(body).encode(), method='POST',
                                  headers={'Authorization': 'Bearer ' + fixture.key, 'Content-Type': 'application/json'})
                with urlopen(request, timeout=5) as response:
                    return json.load(response)
            def refused(path, body=None):
                with self.assertRaises(HTTPError) as caught:
                    read(path) if body is None else post(path, body)
                self.assertEqual(caught.exception.code, 400)
                caught.exception.close()
            def wait_for(predicate):
                deadline = time.monotonic() + 10
                while not predicate():
                    if time.monotonic() >= deadline:
                        self.fail('Timed out waiting for recorded fixture state')
                    time.sleep(.02)
            thread = read('/api/thread?channel=main&limit=200')
            pending = [m for m in thread['messages'] if m['kind'] == 'request' and m['action']]
            critical = [m for m in pending if m['detail']['kind'] == 'permission' and m['detail']['risk']['level'] == 'R3']
            questions = [m for m in pending if m['detail']['kind'] == 'question']
            self.assertEqual(len(critical), 1)
            self.assertEqual(len(questions), 1)
            self.assertEqual(read('/api/channels')['channels'][0]['waiting'], 2)
            self.assertIsNone(thread['before'])
            with self.subTest(case='server projects_root'):
                self.assertEqual(Path(read('/api/state')['projects_root']).resolve(), root.resolve())
            with urlopen(fixture.url + '/classic', timeout=5) as response:
                self.assertEqual(response.status, 200)
            # The real classic UI uses these same authenticated server endpoints.
            post('/api/control', {'run': fixture.run, 'action': 'stop'})
            wait_for(lambda: read('/api/state')['run']['status'] in ('stopped', 'completed', 'failed', 'blocked'))
            fixture.controller.threads[fixture.run].join(5)
            (root / 'escape').symlink_to(outside, target_is_directory=True)
            paths = [str(outside), '../' + home.name + '/repo', str(root / 'escape'), 'escape', '..']
            for bad in paths:
                with self.subTest(case='outside browse', path=bad):
                    refused('/api/projects/browse?' + urlencode({'path': bad}))
                with self.subTest(case='outside select', path=bad):
                    refused('/api/projects/select', {'path': bad})
                    self.assertEqual(read('/api/state')['project'], str(fixture.project))
            for bad in [str(home / 'outside-created'), '../outside-created', 'escape/new-project', 'escape']:
                with self.subTest(case='outside create', name=bad):
                    refused('/api/projects/create', {'name': bad})
                    self.assertFalse((home / 'outside-created').exists())
                    self.assertFalse((outside / 'new-project').exists())
            listing = read('/api/projects/browse')
            self.assertEqual(listing['root'], str(root))
            self.assertNotIn('escape', [item['name'] for item in listing['entries']])
            allowed = post('/api/projects/create', {'name': 'allowed-project'})
            self.assertEqual(allowed['project'], str(root / 'allowed-project'))
            self.assertTrue(allowed['git'])
            for path in ['repo', str(fixture.project)]:
                self.assertEqual(post('/api/projects/select', {'path': path})['project'], str(fixture.project))
            (root / 'inside').symlink_to(root / 'allowed-project', target_is_directory=True)
            self.assertEqual(post('/api/projects/select', {'path': 'inside'})['project'], allowed['project'])
            # A subsequent normal run uses the selected allowed project. The existing
            # fake coder writes through its actual engine-assigned directory.
            fixture.controller.manager.decisions[:0] = [coding('CREATE isolated-write.txt'), complete()]
            run = post('/api/runs', {'goal': 'Write an isolated fixture file', 'mode': 'single'})
            wait_for(lambda: any((Path(s['directory']) / 'isolated-write.txt').exists() for s in list(fixture.api.sessions.values())))
            self.assertEqual(read('/api/state?run=' + run['id'])['run']['project'], allowed['project'])
            self.assertTrue(all(Path(s['directory']).resolve().is_relative_to(root.resolve()) for s in fixture.api.sessions.values()))
            self.assertEqual({p.relative_to(outside): p.read_bytes() for p in outside.rglob('*') if p.is_file()}, original)
            self.assertFalse((home / 'outside-created').exists())
            self.assertFalse((home / 'escape').exists())
        finally:
            fixture.close()
        self.assertFalse(root.exists(), 'Shutdown must remove all temporary fixture state and project files')
