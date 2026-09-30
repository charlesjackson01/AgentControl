"""W6: preview surfaces. Describing a run's surfaces reuses the preview and VM status and never starts
anything; providers can be added, and input to them is audited and needs the dashboard key."""
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import app
import surfaces
from engine import Controller, Settings
from test_workflow import FakeAPI, FakeManager

RUN = {'id': 'r1', 'created': '2026-09-29T00:00:00+00:00'}


def describe(run, preview=None, vm=None):
    return surfaces.default_registry().describe(run, {'preview': preview or {}, 'vm': vm})


class DescribeTests(unittest.TestCase):
    def test_each_preview_mode_becomes_one_surface_pointing_at_existing_endpoints(self):
        cases = {'web': ('web', None, None), 'static': ('web', None, None), 'cli': ('terminal', None, 'preview'), 'desktop': ('desktop', 'preview', 'preview')}
        for mode, (kind, frame, send) in cases.items():
            run = {**RUN, 'preview': {'mode': mode, 'command': 'python3 app.py'}}
            [item] = describe(run, {'run': 'r1', 'state': 'running'})
            self.assertEqual((item['kind'], item['frame'], item['input'], item['state'], item['provider']), (kind, frame, send, 'running', 'preview'), mode)
            self.assertEqual(item['agents'], 'all', 'the preview belongs to the whole run')

    def test_a_preview_belonging_to_another_run_reads_as_idle_and_not_interactive(self):
        run = {**RUN, 'preview': {'mode': 'desktop', 'command': 'app'}}
        [item] = describe(run, {'run': 'other', 'state': 'running'})
        self.assertEqual((item['state'], item['interactive']), ('idle', False))

    def test_no_preview_no_vm_no_run_means_no_surfaces(self):
        self.assertEqual(describe(RUN), [])
        self.assertEqual(describe({**RUN, 'preview': {'mode': 'none'}}), [])
        self.assertEqual(surfaces.default_registry().describe(None, {}), [])

    def test_the_vm_console_is_a_surface_only_while_the_vm_runs(self):
        self.assertEqual(describe(RUN, vm={'live': 'stopped', 'name': 'ac-r1'}), [])
        [item] = describe(RUN, vm={'live': 'running', 'name': 'ac-r1'})
        self.assertEqual((item['id'], item['kind'], item['frame'], item['input'], item['interactive']), ('vm', 'vm-console', 'vm', 'vm', True))

    def test_a_failing_provider_is_skipped(self):
        class Broken(surfaces.SurfaceProvider):
            kind = 'broken'
            def describe(self, run, ctx):
                raise RuntimeError('boom')
        registry = surfaces.default_registry()
        registry.register(Broken())
        self.assertEqual(registry.describe({**RUN, 'preview': {'mode': 'web', 'command': 'x'}}, {}), [
            {**describe({**RUN, 'preview': {'mode': 'web', 'command': 'x'}})[0]}])


class FakeBrowser(surfaces.SurfaceProvider):
    """Stands in for a later provider (a browser session) that serves its own frames."""
    kind = 'browser-session'

    def __init__(self):
        self.inputs = []

    def describe(self, run, ctx):
        return [surfaces.surface('browser', 'browser-session', 'Researcher browser', 'running', interactive=True,
                                 frame='surface', input='surface', agents=['researcher-1'])]

    def frame(self, run, surface_id):
        return b'\x89PNG fake'

    def input(self, run, surface_id, action, **fields):
        self.inputs.append((action, fields))
        return {'ok': True}


class ControllerSurfaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        (root / 'project').mkdir()
        self.c = Controller(Settings(root / 'project', root / 'state', poll=.01, notifications=False), FakeAPI(root / 'project'), FakeManager([]))
        self.run = {'id': 'r1', 'created': RUN['created'], 'goal': 'g', 'status': 'completed', 'pending': [], 'stop': False, 'pause': False,
                    'summary': '', 'preview': {'mode': 'web', 'command': 'python3 -m http.server', 'port': 8000}}
        self.c.store.put('runs', self.run)
        self.browser = self.c.surfaces.register(FakeBrowser())
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), app.handler(self.c, 'k'))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.c.shutdown.set()
        self.c.preview.close()
        self.temp.cleanup()

    def call(self, path, body=None, key='k'):
        headers = {'Authorization': f'Bearer {key}'} if key else {}
        if body is not None:
            headers['Content-Type'] = 'application/json'
        request = urllib.request.Request(self.base + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
        return urllib.request.urlopen(request)

    def test_state_lists_surfaces_and_describing_starts_nothing(self):
        state = self.c.state('r1')
        self.assertEqual([(s['id'], s['kind']) for s in state['surfaces']], [('preview', 'web'), ('browser', 'browser-session')])
        self.assertEqual(self.c.preview.status()['state'], 'idle', 'describing never starts a preview')

    def test_a_provider_serves_frames_and_takes_audited_input_through_the_generic_route(self):
        self.assertEqual(self.call('/api/surface/frame?run=r1&id=browser').read(), b'\x89PNG fake')
        reply = json.load(self.call('/api/surface/input', {'run': 'r1', 'id': 'browser', 'action': 'type', 'text': 'secret words'}))
        self.assertEqual(reply, {'ok': True})
        self.assertEqual(self.browser.inputs, [('type', {'text': 'secret words'})])
        audit = self.c.store.audit('r1')
        self.assertEqual(audit[-1]['action'], 'surface type')
        self.assertNotIn('secret words', json.dumps(audit), 'the text you type is not recorded')

    def test_the_generic_route_needs_the_key_and_refuses_unknown_or_builtin_surfaces(self):
        with self.assertRaises(urllib.error.HTTPError) as denied:
            self.call('/api/surface/frame?run=r1&id=browser', key=None)
        self.assertEqual(denied.exception.code, 401)
        with self.assertRaises(urllib.error.HTTPError) as missing:
            self.call('/api/surface/frame?run=r1&id=nope')
        self.assertEqual(missing.exception.code, 404)
        with self.assertRaises(urllib.error.HTTPError) as builtin:
            self.call('/api/surface/frame?run=r1&id=preview')
        self.assertEqual(builtin.exception.code, 404, 'the preview keeps its own endpoints')
        with self.assertRaises(urllib.error.HTTPError) as bad:
            self.call('/api/surface/input', {'run': 'r1', 'id': 'browser', 'action': 'launch'})
        self.assertEqual(bad.exception.code, 400)
        self.assertEqual(self.browser.inputs, [])


if __name__ == '__main__':
    unittest.main()
