"""M9.1 physical-device fixture: real HTTP/controller, existing fakes, disposable data.

Run from the repository root:
    python3 agent-autonomy/tests/device_fixture.py --port 8767
A LAN/tailnet bind requires an explicit --host address. No real project/state paths are accepted.
"""
import argparse
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import secrets
import shlex
import sys
import tempfile
import threading
import time
from urllib.request import Request, urlopen

sys.path[:0] = [str(Path(__file__).resolve().parent), str(Path(__file__).resolve().parents[1])]
from app import handler
from engine import Controller, Settings
from test_team import FakeTeamAPI, FakeTeamManager
from test_workflow import coding, complete
from test_workspaces import make_repo


KEY_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'


def fixture_key(value):
    if not isinstance(value, str) or not 4 <= len(value) <= 64 or any(not c.isprintable() or c.isspace() for c in value):
        raise ValueError('Key must be 4–64 printable characters with no spaces')
    return value


class DeviceFixture:
    def __init__(self, host='127.0.0.1', port=0, key=None):
        self.host, self.port = host, port
        self.key = fixture_key(key) if key is not None else ''.join(secrets.choice(KEY_ALPHABET) for _ in range(8))
        self.root = self.project = None
        self.controller = self.server = self.temp = None
        self.server_thread = self.growth_thread = None
        self.stop_growth = threading.Event()
        self.api = FakeTeamAPI()
        self.api_lock = threading.RLock()
        self.live_session = None
        self.url = ''

    def read(self, path):
        request = Request(self.url + path, headers={'Authorization': 'Bearer ' + self.key})
        with urlopen(request, timeout=5) as response:
            return json.load(response)

    def start(self):
        try:
            self.temp = tempfile.TemporaryDirectory(prefix='agentcontrol-device-')
            self.root = Path(self.temp.name)
            self.project = make_repo(self.root)
            settings = Settings(self.project, self.root / 'state', poll=.1, notifications=False,
                                run_timeout=7200, step_timeout=7200, manager_timeout=30, verify_timeout=15,
                                projects_root=self.root)
            self.api.on_submit = self._submitted
            # Lock mutation/read of the existing fake's message list, not controller state.
            fake_request = self.api.request
            def locked_request(*args, **kwargs):
                with self.api_lock:
                    return fake_request(*args, **kwargs)
            self.api.request = locked_request
            manager = FakeTeamManager([], [coding('CREATE device-example.txt'),
                                          coding('Keep the fixture terminal open for device checks.'), complete()])
            self.controller = Controller(settings, self.api, manager)
            self.controller.check()
            base = handler(self.controller, self.key)
            class QuietHandler(base):
                def log_message(self, *_args):
                    pass
            self.server = ThreadingHTTPServer((self.host, self.port), QuietHandler)
            self.server_thread = threading.Thread(target=self.server.serve_forever,
                                                  kwargs={'poll_interval': .1}, daemon=True)
            self.server_thread.start()
            self.url = 'http://' + self.host + ':' + str(self.server.server_port)
            body = {'goal': 'Device checks: inspect a completed turn, live output, a critical permission and a question.',
                    'mode': 'single', 'max_steps': 8, 'run_minutes': 120,
                    'verifier': shlex.join([sys.executable, '-c', 'print("Device fixture verification passed")'])}
            request = Request(self.url + '/api/runs', data=json.dumps(body).encode(), method='POST',
                              headers={'Authorization': 'Bearer ' + self.key, 'Content-Type': 'application/json'})
            with urlopen(request, timeout=10) as response:
                self.run = json.load(response)['id']
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                data = self.read('/api/thread?channel=main&limit=200')
                waiting = [m for m in data['messages'] if m['action'] and m['kind'] != 'outcome']
                steps = self.controller.store.steps(self.run)
                if (len(waiting) == 2 and self.live_session and
                        any(s.get('verified') and s.get('evidence', {}).get('diff') for s in steps)):
                    self.growth_thread = threading.Thread(target=self._grow, daemon=True)
                    self.growth_thread.start()
                    return self
                if self.controller.store.get('runs',self.run)['status'] in ('failed','blocked','stopped','completed'):
                    break
                self.stop_growth.wait(.05)
            raise RuntimeError('Device fixture prerequisites timed out: '+repr({'status':self.controller.store.get('runs',self.run)['status'],'summary':self.controller.store.get('runs',self.run)['summary'],'waiting':len(waiting),'live':bool(self.live_session),'steps':[(s.get('status'),s.get('verified'),bool((s.get('evidence') or {}).get('diff'))) for s in steps]}))
        except BaseException:
            self.close()
            raise

    def _submitted(self, session, text):
        self.api.create_file(session, text)
        if len(self.api.prompts) == 1:
            session['messages'][-1]['parts'] = [{'type': 'text', 'text': 'Created the disposable example file. Verification follows.'}]
            return
        self.api.hold = True
        self.live_session = self.api.prompts[-1][0]
        session['messages'][-1]['parts'] = [{'type': 'text', 'text': 'Live device-test output. Both requests below are simulated; no destructive command runs.'}]
        self.api.pending_items = [
            {'kind': 'permission', 'id': 'device-critical', 'sessionID': self.live_session,
             'permission': 'bash', 'patterns': ['rm -rf generated-build/'],
             'metadata': {'command': 'rm -rf generated-build/',
                          'description': 'Simulated cleanup of generated build artifacts. This fixture never executes it.'}},
            {'kind': 'question', 'id': 'device-question', 'sessionID': self.live_session,
             'questions': [{'header': 'Storage', 'question': 'Which example storage format should the test use?',
                            'options': [{'label': 'JSON', 'description': 'A disposable local file'},
                                        {'label': 'SQLite', 'description': 'A disposable local database'}],
                            'custom': True, 'multiple': False}]},
        ]

    def _grow(self):
        number = 0
        while not self.stop_growth.wait(3):
            number += 1
            with self.api_lock:
                session = self.api.sessions.get(self.live_session)
                if not session or not session['busy']:
                    return
                # Bounded fake output; the engine records it through its normal polling/transcript path.
                parts = session['messages'][-1]['parts']
                if len(parts) >= 61:
                    del parts[1]
                parts.append({'type': 'text', 'text': f'Device fixture output {number}: waiting for your review.'})

    def close(self):
        self.stop_growth.set()
        if self.growth_thread:
            self.growth_thread.join(5)
        if self.controller:
            self.controller.shutdown.set()
            with self.api_lock:
                self.api.hold = False
                self.api.finish()
            for thread in list(self.controller.threads.values()):
                thread.join(10)
            self.controller.preview.close()
        if self.server:
            self.server.shutdown()
            self.server.server_close()
        if self.server_thread:
            self.server_thread.join(5)
        if self.temp:
            self.temp.cleanup()
        self.controller = self.server = self.temp = None

    def __enter__(self):
        return self.start()

    def __exit__(self, *_args):
        self.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='127.0.0.1', help='Explicit LAN/tailnet IPv4 address to allow phone access; default loopback only')
    parser.add_argument('--port', type=int, default=8767)
    def key_argument(value):
        try:
            return fixture_key(value)
        except ValueError as error:
            raise argparse.ArgumentTypeError(str(error)) from error
    parser.add_argument('--key', type=key_argument, help='Optional throwaway key: 4–64 printable characters, no spaces')
    args = parser.parse_args()
    with DeviceFixture(args.host, args.port, key=args.key) as fixture:
        print('Device-test URL: ' + fixture.url + '/chat', flush=True)
        print('Throwaway test key: ' + fixture.key, flush=True)
        print('Disposable data only. Ctrl+C stops the fixture and removes its project/state.', flush=True)
        try:
            while not fixture.stop_growth.wait(1):
                pass
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
