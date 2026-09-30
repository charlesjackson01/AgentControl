"""End to end (M7): a two-agent team run on a real `opencode serve`, killed mid-run and resumed.

The model is a scripted OpenAI-compatible server (as in spikes/opencode_worktree_probe.py): for
each prompt it asks OpenCode to write the file named after CREATE, then finishes. Hermes is
scripted too. Everything else is real: OpenCode sessions per worktree, directory-scoped calls,
git worktrees, integration merges, the journal, and a controller restart.

Skipped unless an OpenCode binary is available (OPENCODE_BIN or `opencode` on PATH).
"""
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from engine import Controller, Settings
from test_team import FakeTeamManager, proposal
from test_workflow import complete
from test_workspaces import make_repo

OPENCODE = os.environ.get('OPENCODE_BIN') or shutil.which('opencode')


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class ScriptedModel:
    """Writes the file named in the latest user prompt, slowly enough to be interrupted."""

    def __init__(self, delay):
        self.lock, self.requests, self.creates = threading.Lock(), 0, []
        model = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *args):
                pass

            def do_GET(self):
                body = json.dumps({'data': [{'id': 'm', 'object': 'model'}]}).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                messages = request.get('messages', [])
                with model.lock:
                    model.requests += 1
                if not request.get('tools'):
                    chunks = [{'delta': {'content': 'Title'}, 'finish_reason': None}, {'delta': {}, 'finish_reason': 'stop'}]
                elif messages and messages[-1].get('role') == 'tool':
                    chunks = [{'delta': {'content': 'Done.'}, 'finish_reason': None}, {'delta': {}, 'finish_reason': 'stop'}]
                else:
                    last_user = next(m for m in reversed(messages) if m.get('role') == 'user')
                    text = json.dumps(last_user.get('content'))
                    name = re.search(r'CREATE (\S+?)(?:\\\\n|\\n|"|\s)', text).group(1)
                    with model.lock:
                        model.creates.append(name)
                    time.sleep(delay)
                    args = json.dumps({'filePath': name, 'content': f'created for {name}\n'})
                    chunks = [{'delta': {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': f'call_{name}', 'type': 'function',
                               'function': {'name': 'write', 'arguments': args}}]}, 'finish_reason': None},
                              {'delta': {}, 'finish_reason': 'tool_calls'}]
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Transfer-Encoding', 'chunked')
                self.end_headers()
                for chunk in chunks + [None]:
                    payload = '[DONE]' if chunk is None else json.dumps({'id': 'x', 'object': 'chat.completion.chunk', 'created': 0,
                                                                         'model': 'm', 'choices': [{'index': 0, **chunk}]})
                    data = f'data: {payload}\n\n'.encode()
                    self.wfile.write(f'{len(data):x}\r\n'.encode() + data + b'\r\n')
                self.wfile.write(b'0\r\n\r\n')

        self.port = free_port()
        self.server = ThreadingHTTPServer(('127.0.0.1', self.port), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


@unittest.skipUnless(OPENCODE and Path(OPENCODE).exists(), 'needs an OpenCode binary (set OPENCODE_BIN)')
class RealOpenCodeTeamTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.repo = make_repo(root)
        self.model = ScriptedModel(delay=4)
        home = root / 'home'
        (home / '.config' / 'opencode').mkdir(parents=True)
        (home / '.config' / 'opencode' / 'opencode.json').write_text(json.dumps({
            'provider': {'mock': {'npm': '@ai-sdk/openai-compatible', 'name': 'Mock',
                                  'options': {'baseURL': f'http://127.0.0.1:{self.model.port}/v1', 'apiKey': 'x'},
                                  'models': {'m': {'name': 'm', 'tool_call': True}}}},
            'model': 'mock/m', 'small_model': 'mock/m',
            'permission': {'edit': 'allow', 'bash': 'allow', 'external_directory': 'allow'}}))
        port = free_port()
        env = dict(os.environ, HOME=str(home), XDG_CONFIG_HOME=str(home / '.config'))
        self.server = subprocess.Popen([OPENCODE, 'serve', '--port', str(port)], cwd=self.repo, env=env,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        self.url = f'http://127.0.0.1:{port}'
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        until = time.monotonic() + 90
        while time.monotonic() < until:
            try:
                opener.open(self.url + '/global/health', timeout=2)
                break
            except OSError:
                time.sleep(.3)
        else:
            self.fail('opencode serve did not start')
        self.settings = Settings(self.repo, root / 'state', opencode_url=self.url, poll=.2, notifications=False, run_timeout=600)
        self.controllers = []

    def tearDown(self):
        for c in self.controllers:
            c.shutdown.set()
            for thread in list(c.threads.values()):
                thread.join(5)
            c.preview.close()
        self.server.terminate()
        try:
            self.server.wait(10)
        except subprocess.TimeoutExpired:
            self.server.kill()
        self.model.server.shutdown()
        self.temp.cleanup()

    def controller(self, manager):
        c = Controller(self.settings, None, manager)
        health = c.check()
        self.assertTrue(health['ready'], health['message'])
        self.controllers.append(c)
        return c

    def wait(self, condition, timeout=120):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            if condition():
                return
            time.sleep(.2)
        self.fail('timed out')

    def test_two_agents_killed_mid_run_and_resumed(self):
        c = self.controller(FakeTeamManager([proposal()], []))
        run = c.new('Build an API and a UI', mode='team', team_size=2)
        ident = run['id']
        self.wait(lambda: c.store.get('runs', ident)['status'] == 'awaiting_approval')
        c.control(ident, 'approve_team')
        # Both agents are mid-task (the model is still "thinking") when the controller dies.
        self.wait(lambda: len(self.model.creates) == 2)
        self.assertEqual(sorted(self.model.creates), ['api.py', 'ui.html'])
        c.shutdown.set()
        c.threads[ident].join(10)
        self.assertEqual(c.store.get('runs', ident)['status'], 'interrupted')

        restarted = self.controller(FakeTeamManager([], [complete()]))
        self.assertEqual(restarted.store.get('runs', ident)['status'], 'interrupted')
        restarted.control(ident, 'resume')
        self.wait(lambda: restarted.store.get('runs', ident)['status'] in ('completed', 'failed', 'blocked', 'attention', 'limit_reached'), 240)
        result = restarted.store.get('runs', ident)
        self.assertEqual(result['status'], 'completed', result['summary'])
        # No prompt was sent twice: the model saw exactly one request to create each file.
        self.assertEqual(sorted(self.model.creates), ['api.py', 'ui.html', 'wire.txt'])
        self.assertEqual({t['status'] for t in result['team']['tasks']}, {'done'})
        ws = result['workspace']
        sessions = {name: a['session'] for name, a in result['team']['agents'].items()}
        self.assertEqual(len(set(sessions.values())), 2)
        integration = Path(ws['integration']['dir'])
        for name in ('api.py', 'ui.html', 'wire.txt'):
            self.assertEqual((integration / name).read_text(), f'created for {name}\n')
        # Each file was committed by the agent that wrote it, on its own branch.
        author = lambda name: subprocess.run(['git', 'log', '--no-merges', '--format=%an', '--', name], cwd=integration,
                                             capture_output=True, text=True, check=True).stdout.split('\n')[0]
        self.assertEqual([author(n) for n in ('api.py', 'ui.html', 'wire.txt')],
                         ['coder-1 (AgentControl)', 'coder-2 (AgentControl)', 'coder-1 (AgentControl)'])
        self.assertFalse((self.repo / 'api.py').exists(), 'your checkout is untouched until Apply')
        # W2: the journal holds each agent's state changes, including the restart, ending with finished.
        restarted.lifecycle.flush()
        changes = [json.loads(e['detail']) for e in reversed(restarted.store.latest_events(ident, 'agent state'))]
        for name in ('hermes', 'coder-1', 'coder-2'):
            mine = [(d['from'], d['to']) for d in changes if d['agent'] == name]
            self.assertEqual(mine[0][0], None, f'{name} joined')
            self.assertIn('needs_attention', [to for _, to in mine], f'{name} was interrupted by the kill')
            self.assertEqual(mine[-1][1], 'finished', f'{name} ended finished')
            self.assertTrue(all(a != b for a, b in mine), 'only real changes are recorded')
        for name in ('coder-1', 'coder-2'):
            self.assertIn('working', [d['to'] for d in changes if d['agent'] == name], f'{name} was seen working')


    def test_installed_skill_reaches_the_agent_on_its_next_turn(self):
        from test_capabilities import write_skill
        library = Path(self.temp.name) / 'library'
        write_skill(library / 'pdf')
        self.settings.skills_library = library
        code = lambda name: {'action': 'code', 'title': name, 'summary': 's', 'prompt': f'CREATE {name}'}
        c = self.controller(FakeTeamManager([], [code('one.txt'), code('two.txt'), complete()]))
        run = c.new('Build it')
        self.wait(lambda: c.store.steps(run['id']) and c.store.steps(run['id'])[-1]['status'] == 'running')
        item = c.propose_capability(run['id'], 'coder-1', {'type': 'library', 'name': 'pdf-tools'})
        c.decide_capability(item['id'], 'approve')
        self.wait(lambda: c.store.get('runs', run['id'])['status'] in ('completed', 'failed', 'attention', 'blocked'), 240)
        result = c.store.get('runs', run['id'])
        self.assertEqual(result['status'], 'completed', result['summary'])
        agent_dir = result['workspace']['agents']['coder-1']['dir']
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        names = lambda folder: {s.get('name') for s in json.load(opener.open(f'{self.url}/skill?directory={urllib.parse.quote(str(folder))}'))}
        # Reloaded before the second turn, so OpenCode now offers the skill in that agent's directory only.
        self.assertIn('skills reloaded', [e['kind'] for e in c.store.events(run['id'])])
        self.assertIn('pdf-tools', names(agent_dir))
        self.assertNotIn('pdf-tools', names(self.repo), 'your checkout does not get the skill')
        # The session survived the reload: both turns finished in the same OpenCode session.
        self.assertEqual(sorted(self.model.creates), ['one.txt', 'two.txt'])
        self.assertEqual(len({s['status'] for s in c.store.steps(run['id'])}), 1)

if __name__ == '__main__':
    unittest.main()
