"""M9 entry cutover preserves classic, pop-outs and API authentication."""
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from app import handler, ROOT
import test_workflow as workflow


class ChatRoutesTests(unittest.TestCase):
    def setUp(self):
        # Reuse workflow setup/settings without inheriting its test cases.
        self.helper = workflow.WorkflowTests()
        self.helper.setUp()
        self.controller, _ = self.helper.controller([])
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), handler(self.controller, 'test-key'))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.url = 'http://127.0.0.1:' + str(self.server.server_port)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)
        self.helper.tearDown()

    def get(self, path):
        return self.opener.open(self.url + path)

    def test_entries_and_security_headers(self):
        for path in ('/', '/?run=example', '/?notpopout=coder-1', '/chat', '/chat/'):
            with self.subTest(path=path), self.get(path) as response:
                self.assertEqual(response.read(), (ROOT / 'chat/index.html').read_bytes())
                self.assertEqual(response.headers['Content-Type'], 'text/html; charset=utf-8')
                self.assertEqual(response.headers['X-Content-Type-Options'], 'nosniff')
                self.assertEqual(response.headers['X-Frame-Options'], 'DENY')
                self.assertEqual(response.headers['Cache-Control'], 'no-store')
        for path in ('/classic', '/classic/', '/classic?popout=coder-1&run=example',
                     '/?popout=coder-1&run=example', '/?run=example&popout=',
                     '/?%70opout=coder-1&run=example'):
            with self.subTest(path=path), self.get(path) as response:
                self.assertEqual(response.read(), (ROOT / 'index.html').read_bytes())
                self.assertEqual(response.headers['Content-Type'], 'text/html; charset=utf-8')
                self.assertEqual(response.headers['X-Content-Type-Options'], 'nosniff')
                self.assertEqual(response.headers['X-Frame-Options'], 'DENY')
                self.assertEqual(response.headers['Cache-Control'], 'no-store')

    def test_assets(self):
        for asset in (ROOT / 'chat').iterdir():
            if asset.suffix not in ('.css', '.js'):
                continue
            with self.subTest(asset=asset.name), self.get('/chat/' + asset.name + '?v=1') as response:
                self.assertEqual(response.read(), asset.read_bytes())
                kind = 'text/css' if asset.suffix == '.css' else 'text/javascript'
                self.assertEqual(response.headers['Content-Type'], kind + '; charset=utf-8')
        for name in ('app.js', 'app.css', 'themes.css', 'workspace.js', 'workspace.css'):
            with self.subTest(asset=name), self.get('/' + name) as response:
                self.assertEqual(response.read(), (ROOT / name).read_bytes())
                kind = 'text/css' if name.endswith('.css') else 'text/javascript'
                self.assertEqual(response.headers['Content-Type'], kind + '; charset=utf-8')

    def test_invalid_assets(self):
        for path in ('../app.py', '%2e%2e/app.py', 'x.py', 'sub/x.js', '.hidden.js', 'missing.js', 'core.js/extra', 'index.html'):
            with self.subTest(path=path), self.assertRaises(urllib.error.HTTPError) as error:
                self.get('/chat/' + path)
            self.assertEqual(error.exception.code, 404)

    def test_api_still_requires_key(self):
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.get('/api/state')
        self.assertEqual(error.exception.code, 401)
        request = urllib.request.Request(self.url + '/api/state', headers={'Authorization': 'Bearer test-key'})
        with self.opener.open(request) as response:
            self.assertEqual(response.status, 200)
