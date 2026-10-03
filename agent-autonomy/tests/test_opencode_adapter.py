"""The OpenCode adapter scopes every call by directory (M0 finding: status, approvals,
and replies are only visible or accepted with the session's own directory)."""
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from adapters.opencode import OpenCode
from engine import Settings


class Capture(BaseHTTPRequestHandler):
    seen = []
    pending = []

    def log_message(self, *a):
        pass

    def _reply(self, body):
        raw = json.dumps(body).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        Capture.seen.append(('GET', url.path, urllib.parse.parse_qs(url.query).get('directory', [None])[0]))
        self._reply(Capture.pending if url.path in ('/permission', '/question') else {})

    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length') or 0))
        url = urllib.parse.urlsplit(self.path)
        Capture.seen.append(('POST', url.path, urllib.parse.parse_qs(url.query).get('directory', [None])[0]))
        self._reply(True)


class DirectoryScopingTests(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Capture)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.temp = tempfile.TemporaryDirectory()
        self.project = Path(self.temp.name) / 'project'
        self.project.mkdir()
        self.api = OpenCode(Settings(self.project, Path(self.temp.name) / 'state', opencode_url=f'http://127.0.0.1:{self.server.server_port}'))
        Capture.seen, Capture.pending = [], []

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()

    def test_single_mode_calls_use_the_project_folder_as_before(self):
        self.api.request('/session/status')
        self.api.pending('ses_1')
        self.api.respond('ses_1', {'id': 'per_1', 'kind': 'permission'}, 'approve')
        self.assertTrue(Capture.seen)
        self.assertEqual({d for _, _, d in Capture.seen}, {str(self.project)})

    def test_worktree_agent_calls_carry_its_own_directory(self):
        worktree = '/work/agent-a'
        self.api.request('/session/status', directory=worktree)
        self.api.request('/session/ses_1/prompt_async', 'POST', {'parts': []}, directory=worktree)
        self.api.pending('ses_1', directory=worktree)
        self.api.respond('ses_1', {'id': 'per_1', 'kind': 'permission'}, 'approve', directory=worktree)
        self.api.respond('ses_1', {'id': 'que_1', 'kind': 'question'}, 'answer', [['yes']], directory=worktree)
        self.api.respond('ses_1', {'id': 'que_2', 'kind': 'question'}, 'reject', directory=worktree)
        paths = {p for _, p, _ in Capture.seen}
        self.assertTrue({'/session/status', '/permission', '/question', '/permission/per_1/reply',
                         '/question/que_1/reply', '/question/que_2/reject'} <= paths)
        self.assertEqual({d for _, _, d in Capture.seen}, {worktree})

    def test_pending_filters_to_the_agents_session(self):
        Capture.pending = [{'id': 'p1', 'sessionID': 'ses_a'}, {'id': 'p2', 'sessionID': 'ses_b'}]
        found = self.api.pending('ses_a', directory='/work/agent-a')
        self.assertEqual([p['id'] for p in found if p['kind'] == 'permission'], ['p1'])


class UnreachableServerTests(unittest.TestCase):
    def test_a_stopped_server_is_named_with_how_to_start_it(self):
        import socket
        with socket.socket() as probe:   # a port nothing listens on
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        with tempfile.TemporaryDirectory() as temp:
            api = OpenCode(Settings(Path(temp), Path(temp) / 'state', opencode_url=f'http://127.0.0.1:{port}'))
            with self.assertRaises(RuntimeError) as caught:
                api.health()
        message = str(caught.exception)
        self.assertIn(f'OpenCode is not reachable at http://127.0.0.1:{port}', message)
        self.assertIn(f'opencode serve --port {port}', message)
        self.assertNotIn('urlopen error', message)


if __name__ == '__main__':
    unittest.main()
