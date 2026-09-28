import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import sys
import tempfile
import threading
import time
import unittest
import unittest.mock
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from preview import PreviewManager, desktop_missing, validate_spec
from app import handler, preview_handler
from engine import Controller, Settings
from test_workflow import FakeAPI, FakeManager, coding, complete

DEMO = Path(__file__).resolve().parents[2] / 'demo_app'


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class PreviewTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.project = Path(self.temp.name) / 'project'
        self.project.mkdir()
        self.manager = PreviewManager(self.project, idle_seconds=0)
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), preview_handler(self.manager, 8766))
        self.manager.listen_port = self.server.server_port
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.manager.close()
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()

    def wait(self, condition, timeout=10):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            if condition():
                return
            time.sleep(.05)
        self.fail('Timed out waiting for preview condition')

    def request(self, path, cookie=None, method='GET'):
        c = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=10)
        c.request(method, path, headers={'Cookie': cookie} if cookie else {})
        r = c.getresponse()
        body = r.read()
        c.close()
        return r, body

    def session(self):
        r, _ = self.request('/__ac/enter?ticket=' + self.manager.issue_ticket())
        self.assertEqual(r.status, 302)
        cookie = r.getheader('Set-Cookie')
        self.assertIn('HttpOnly', cookie)
        self.assertIn('SameSite=Strict', cookie)
        return cookie.split(';')[0]


class SpecTests(PreviewTestCase):
    def test_validation_rejects_shell_ports_and_escapes(self):
        self.assertIsNone(validate_spec({'mode': 'none'}, self.project))
        self.assertIsNone(validate_spec(None, self.project))
        self.assertEqual(validate_spec({'mode': 'cli', 'command': 'python3 app.py "a b"'}, self.project)['argv'], ['python3', 'app.py', 'a b'])
        for bad in ({'mode': 'web', 'command': 'npm run dev', 'port': 80}, {'mode': 'web', 'command': 'x', 'port': '5173'},
                    {'mode': 'static', 'path': '../outside'}, {'mode': 'static', 'path': '/etc'}, {'mode': 'cli', 'command': ''},
                    {'mode': 'desktop', 'command': 'app', 'width': 10, 'height': 10}, {'mode': 'shell', 'command': 'ls'}):
            with self.assertRaises(ValueError, msg=bad):
                validate_spec(bad, self.project)

    def test_preview_port_needs_a_one_time_ticket(self):
        (self.project / 'index.html').write_text('<h1>Hello</h1>')
        self.manager.start('run1', {'mode': 'static', 'path': '.'})
        r, _ = self.request('/')
        self.assertEqual(r.status, 401)
        ticket = self.manager.issue_ticket()
        r, _ = self.request('/__ac/enter?ticket=' + ticket)
        self.assertEqual(r.status, 302)
        r, _ = self.request('/__ac/enter?ticket=' + ticket)
        self.assertEqual(r.status, 403, 'a ticket works once')
        self.assertIn('frame-ancestors', r.getheader('Content-Security-Policy'))


class StaticTests(PreviewTestCase):
    def test_static_serves_files_and_refuses_escapes_symlinks_and_secrets(self):
        site = self.project / 'site'
        site.mkdir()
        (site / 'index.html').write_text('<h1>Todo</h1>')
        (site / 'app.js').write_text('console.log(1)')
        (site / 'secret_token.txt').write_text('nope')
        (site / '.env').write_text('KEY=1')
        (self.project / 'outside.txt').write_text('outside')
        os.symlink(self.project / 'outside.txt', site / 'link.txt')
        self.manager.start('run1', {'mode': 'static', 'path': 'site'})
        cookie = self.session()
        r, body = self.request('/', cookie)
        self.assertEqual((r.status, body), (200, b'<h1>Todo</h1>'))
        self.assertIn('frame-ancestors http://127.0.0.1:8766', r.getheader('Content-Security-Policy'))
        r, _ = self.request('/app.js', cookie)
        self.assertEqual(r.status, 200)
        self.assertIn('javascript', r.getheader('Content-Type'))
        for path in ('/../outside.txt', '/%2e%2e/outside.txt', '/link.txt', '/secret_token.txt', '/.env'):
            r, _ = self.request(path, cookie)
            self.assertEqual(r.status, 404, path)

    def test_static_file_target_serves_that_file(self):
        (self.project / 'page.html').write_text('<p>one page</p>')
        self.manager.start('run1', {'mode': 'static', 'path': 'page.html'})
        r, body = self.request('/', self.session())
        self.assertEqual(body, b'<p>one page</p>')


class WebTests(PreviewTestCase):
    def test_web_preview_waits_for_port_proxies_and_strips_frame_headers(self):
        port = free_port()
        (self.project / 'index.html').write_text('<h1>Served</h1>')
        (self.project / 'server.py').write_text(
            'import http.server,sys\n'
            'class H(http.server.SimpleHTTPRequestHandler):\n'
            '    def end_headers(self):\n'
            '        self.send_header("X-Frame-Options","DENY")\n'
            '        self.send_header("Content-Security-Policy","default-src \'self\'; frame-ancestors \'none\'")\n'
            '        super().end_headers()\n'
            '    def do_POST(self):\n'
            '        n=int(self.headers["Content-Length"]);data=self.rfile.read(n)\n'
            '        self.send_response(200);self.send_header("Content-Length",str(len(data)));self.end_headers();self.wfile.write(data)\n'
            'print("starting", flush=True)\n'
            'http.server.ThreadingHTTPServer(("127.0.0.1",int(sys.argv[1])),H).serve_forever()\n')
        status = self.manager.start('run1', {'mode': 'web', 'command': f'{sys.executable} server.py {port}', 'port': port})
        self.assertEqual(status['state'], 'starting')
        self.wait(lambda: self.manager.status()['state'] == 'running')
        cookie = self.session()
        r, body = self.request('/', cookie)
        self.assertEqual((r.status, body), (200, b'<h1>Served</h1>'))
        self.assertIsNone(r.getheader('X-Frame-Options'))
        policies = r.getheader('Content-Security-Policy')
        self.assertNotIn("frame-ancestors 'none'", policies)
        self.assertIn('frame-ancestors http://127.0.0.1:8766', policies)
        c = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=10)
        c.request('POST', '/echo', body=b'payload', headers={'Cookie': cookie, 'Content-Length': '7'})
        self.assertEqual(c.getresponse().read(), b'payload')
        c.close()
        self.assertIn('starting', self.manager.output(0)['text'])
        pid = self.manager.status()['pid']
        self.manager.stop()
        self.wait(lambda: not Path(f'/proc/{pid}').exists() or 'zombie' in Path(f'/proc/{pid}/status').read_text().lower())
        r, _ = self.request('/', cookie)
        self.assertEqual(r.status, 503)

    def test_web_preview_that_never_listens_fails_clearly(self):
        port = free_port()
        self.manager.start('run1', {'mode': 'web', 'command': f'{sys.executable} -c "import sys; sys.exit(3)"', 'port': port})
        self.wait(lambda: self.manager.status()['state'] == 'failed')
        self.assertIn('status 3', self.manager.status()['error'])


class CliTests(PreviewTestCase):
    def test_cli_runs_in_a_pty_and_accepts_input(self):
        shutil.copytree(DEMO, self.project / 'demo_app')
        self.manager.start('run1', {'mode': 'cli', 'command': f'{sys.executable} demo_app/todo.py --file {self.project}/t.json list'})
        self.wait(lambda: self.manager.status()['state'] == 'exited')
        self.assertIn('[process exited with status 0]', self.manager.output(0)['text'])
        self.manager.start('run1', {'mode': 'cli', 'command': f'{sys.executable} -i -q'})
        self.wait(lambda: '>>>' in self.manager.output(0)['text'])
        self.manager.send_input('print(6 * 7)\n')
        self.wait(lambda: '42' in self.manager.output(0)['text'])
        first = self.manager.output(0)
        later = self.manager.output(first['offset'])
        self.assertEqual(later['text'], '')
        self.manager.send_input('\x04')
        self.wait(lambda: self.manager.status()['state'] == 'exited')
        with self.assertRaisesRegex(ValueError, 'not running'):
            self.manager.send_input('x')

    def test_stop_ends_the_whole_process_group(self):
        marker = self.project / 'child.pid'
        self.manager.start('run1', {'mode': 'cli', 'command': f'{sys.executable} -c "import subprocess,sys,time; p=subprocess.Popen([sys.executable,\'-c\',\'import time; time.sleep(60)\']); open(\'{marker}\',\'w\').write(str(p.pid)); time.sleep(60)"'})
        self.wait(marker.exists)
        child = int(marker.read_text())
        self.manager.stop()
        self.wait(lambda: not Path(f'/proc/{child}').exists() or 'zombie' in Path(f'/proc/{child}/status').read_text().lower())
        self.assertEqual(self.manager.status()['state'], 'idle')

    def test_idle_preview_is_stopped(self):
        now = [0.0]
        manager = PreviewManager(self.project, idle_seconds=60, clock=lambda: now[0])
        try:
            manager.start('run1', {'mode': 'cli', 'command': f'{sys.executable} -c "import time; time.sleep(60)"'})
            now[0] = 30
            self.assertFalse(manager.check_idle())
            manager.output(0)  # looking at the preview counts as activity
            now[0] = 80
            self.assertFalse(manager.check_idle())
            now[0] = 200
            self.assertTrue(manager.check_idle())
            self.assertEqual(manager.status()['state'], 'idle')
            self.assertIn('idle minutes', manager.status()['error'])
        finally:
            manager.close()


@unittest.skipIf(desktop_missing(), 'desktop preview tools are not installed')
class DesktopTests(PreviewTestCase):
    def test_desktop_preview_shows_frames_and_accepts_input(self):
        command = shutil.which('xclock') or shutil.which('xeyes')
        if not command:
            self.skipTest('no small X11 program available')
        self.manager.start('run1', {'mode': 'desktop', 'command': command, 'width': 640, 'height': 400})
        self.wait(lambda: self.manager.status()['state'] == 'running')
        time.sleep(1)
        png = self.manager.frame()
        self.assertTrue(png.startswith(b'\x89PNG'))
        self.manager.click(10, 10)
        self.manager.key('Escape')
        self.manager.type_text('hello')
        with self.assertRaises(ValueError):
            self.manager.key('rm -rf')
        self.manager.stop()
        with self.assertRaisesRegex(ValueError, 'not running'):
            self.manager.frame()


class DesktopToolMessageTests(unittest.TestCase):
    def test_missing_tools_are_named(self):
        with tempfile.TemporaryDirectory() as temp:
            manager = PreviewManager(temp)
            try:
                with unittest.mock.patch('preview.desktop_missing', return_value=['xdotool']):
                    with self.assertRaisesRegex(ValueError, 'xdotool'):
                        manager.start('run1', {'mode': 'desktop', 'command': 'app'})
            finally:
                manager.close()


class ControllerPreviewTests(unittest.TestCase):
    def test_completed_run_starts_its_preview_and_api_controls_it(self):
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / 'project'
            project.mkdir()
            (project / 'index.html').write_text('<h1>Done</h1>')
            settings = Settings(project, Path(temp) / 'state', poll=.01, notifications=False, step_timeout=5, manager_timeout=5, verify_timeout=5, run_timeout=30)
            c = Controller(settings, FakeAPI(project), FakeManager([coding(), complete()]))
            c.check()
            try:
                run = c.new('Make a page', preview={'mode': 'static', 'path': '.'})
                self.assertEqual(run['preview'], {'mode': 'static', 'path': '.'})
                deadline = time.monotonic() + 5
                while c.store.get('runs', run['id'])['status'] != 'completed' and time.monotonic() < deadline:
                    time.sleep(.02)
                status = c.state(run['id'])['preview']
                self.assertEqual((status['state'], status['run'], status['mode']), ('running', run['id'], 'static'))
                self.assertIn('preview', [e['kind'] for e in c.store.events(run['id'])])
                c.preview_action(run['id'], 'config', {'preview': {'mode': 'cli', 'command': f'{sys.executable} -c "print(input())"'}})
                c.preview_action(run['id'], 'start', {})
                c.preview_action(run['id'], 'input', {'text': 'echo me\n'})
                deadline = time.monotonic() + 5
                while 'echo me\r\necho me' not in c.preview.output(0)['text'] and time.monotonic() < deadline:
                    time.sleep(.05)
                self.assertIn('echo me\r\necho me', c.preview.output(0)['text'])
                c.preview.run = 'a-different-run'
                with self.assertRaisesRegex(ValueError, 'another run'):
                    c.preview_action(run['id'], 'input', {'text': 'x'})
                c.preview_action(run['id'], 'start', {})
                with self.assertRaisesRegex(ValueError, 'Unknown preview action'):
                    c.preview_action(run['id'], 'shell', {})
            finally:
                c.shutdown.set()
                c.preview.close()

    def test_preview_http_routes_require_the_dashboard_key(self):
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / 'project'
            project.mkdir()
            settings = Settings(project, Path(temp) / 'state', poll=.01, notifications=False)
            c = Controller(settings, FakeAPI(project), FakeManager([]))
            server = ThreadingHTTPServer(('127.0.0.1', 0), handler(c, 'k'))
            threading.Thread(target=server.serve_forever, daemon=True).start()
            base = f'http://127.0.0.1:{server.server_port}'
            try:
                for path in ('/api/preview/output', '/api/preview/frame'):
                    with self.assertRaises(urllib.error.HTTPError) as caught:
                        urllib.request.urlopen(base + path)
                    self.assertEqual(caught.exception.code, 401)
                request = urllib.request.Request(base + '/api/preview/ticket', data=b'{}', method='POST', headers={'Authorization': 'Bearer k'})
                self.assertIn('ticket', json.load(urllib.request.urlopen(request)))
                request = urllib.request.Request(base + '/api/preview/output?since=0', headers={'Authorization': 'Bearer k'})
                self.assertEqual(json.load(urllib.request.urlopen(request))['status']['state'], 'idle')
            finally:
                server.shutdown()
                server.server_close()
                c.preview.close()


if __name__ == '__main__':
    unittest.main()
