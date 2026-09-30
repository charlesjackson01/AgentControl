#!/usr/bin/env python3
"""M0 spike: can one OpenCode server run several agents in separate git worktrees?

Fully isolated: creates a temporary git repo with two worktrees, a scripted
mock model (no real model, no network, no cost), and an `opencode serve` with
its own temporary HOME and config. It never touches your OpenCode setup,
sessions, or projects. Checks:
  1. sessions accept ?directory=<worktree>
  2. two agents prompted at once each write only into their own worktree
  3. whether the model receives overlapping requests (so AgentControl must cap them)
  4. whether /session/status, pending approvals, and approval replies are scoped
     per directory (so the adapter must pass ?directory= on every call)

    python3 opencode_worktree_probe.py [--opencode /path/to/opencode]
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class Mock:
    """OpenAI-compatible streaming model: first asks OpenCode to write agent.txt, then finishes."""
    def __init__(self):
        self.lock, self.active, self.max_active = threading.Lock(), 0, 0
        mock = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *a):
                pass

            def do_GET(self):
                body = json.dumps({'data': [{'id': 'm', 'object': 'model'}]}).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                req = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                with mock.lock:
                    mock.active += 1
                    mock.max_active = max(mock.max_active, mock.active)
                try:
                    msgs = json.dumps(req.get('messages', []))
                    if not req.get('tools'):
                        chunks = [{'delta': {'content': 'Probe'}, 'finish_reason': None}, {'delta': {}, 'finish_reason': 'stop'}]
                    elif '"role": "tool"' not in msgs:
                        who = 'agent-a' if 'AGENT-A' in msgs else 'agent-b'
                        args = json.dumps({'filePath': 'agent.txt', 'content': f'written by {who}\n'})
                        chunks = [{'delta': {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'call_1', 'type': 'function',
                                   'function': {'name': 'write', 'arguments': args}}]}, 'finish_reason': None},
                                  {'delta': {}, 'finish_reason': 'tool_calls'}]
                        time.sleep(1.5)  # keep requests open long enough to overlap
                    else:
                        chunks = [{'delta': {'content': 'Done.'}, 'finish_reason': None}, {'delta': {}, 'finish_reason': 'stop'}]
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/event-stream')
                    self.send_header('Transfer-Encoding', 'chunked')
                    self.end_headers()
                    for c in chunks + [None]:
                        payload = '[DONE]' if c is None else json.dumps({'id': 'x', 'object': 'chat.completion.chunk', 'created': 0, 'model': 'm', 'choices': [{'index': 0, **c}]})
                        data = f'data: {payload}\n\n'.encode()
                        self.wfile.write(f'{len(data):x}\r\n'.encode() + data + b'\r\n')
                    self.wfile.write(b'0\r\n\r\n')
                finally:
                    with mock.lock:
                        mock.active -= 1

        self.port = free_port()
        self.server = ThreadingHTTPServer(('127.0.0.1', self.port), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


def call(base, path, method='GET', body=None, directory=None):
    if directory:
        path += ('&' if '?' in path else '?') + 'directory=' + urllib.parse.quote(str(directory))
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, method=method, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as exc:
        return exc.code, None
    except (urllib.error.URLError, OSError):
        return 0, None  # not listening yet


def wait(condition, timeout=60):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if condition():
            return True
        time.sleep(.3)
    return False


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--opencode', default=shutil.which('opencode') or 'opencode')
    a = p.parse_args()
    version = subprocess.run([a.opencode, '--version'], capture_output=True, text=True).stdout.strip()
    results = {'opencode_version': version}
    root = Path(tempfile.mkdtemp(prefix='oc-probe-'))
    server = None
    try:
        repo = root / 'repo'
        repo.mkdir()
        git = ['git', '-c', 'user.email=probe@local', '-c', 'user.name=probe']
        subprocess.run(['git', 'init', '-q'], cwd=repo, check=True)
        (repo / 'README.md').write_text('# probe\n')
        subprocess.run(git + ['add', '.'], cwd=repo, check=True)
        subprocess.run(git + ['commit', '-qm', 'init'], cwd=repo, check=True)
        worktrees = {name: root / name for name in ('wt-a', 'wt-b')}
        for name, path in worktrees.items():
            subprocess.run(['git', 'worktree', 'add', '-q', str(path), '-b', name], cwd=repo, check=True)

        mock = Mock()
        home = root / 'home'
        (home / '.config' / 'opencode').mkdir(parents=True)

        def configure(permission):
            (home / '.config' / 'opencode' / 'opencode.json').write_text(json.dumps({
                'provider': {'mock': {'npm': '@ai-sdk/openai-compatible', 'name': 'Mock',
                                      'options': {'baseURL': f'http://127.0.0.1:{mock.port}/v1', 'apiKey': 'x'},
                                      'models': {'m': {'name': 'm', 'tool_call': True}}}},
                'model': 'mock/m', 'small_model': 'mock/m', 'permission': {'edit': permission, 'bash': permission}}))

        def serve():
            port = free_port()
            env = dict(os.environ, HOME=str(home), XDG_CONFIG_HOME=str(home / '.config'))
            proc = subprocess.Popen([a.opencode, 'serve', '--port', str(port)], cwd=repo, env=env,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            base = f'http://127.0.0.1:{port}'
            if not wait(lambda: call(base, '/session')[0] == 200, 90):
                raise RuntimeError('opencode serve did not start')
            return proc, base

        # Checks 1-3: concurrent agents in separate worktrees, edits auto-allowed.
        configure('allow')
        server, base = serve()
        sessions = {}
        for name, path in worktrees.items():
            _, s = call(base, '/session', 'POST', {'title': name}, directory=path)
            sessions[name] = s['id']
            results[f'session_directory_{name}'] = s.get('directory') == str(path)
        threads = [threading.Thread(target=call, args=(base, f'/session/{sessions[n]}/prompt_async', 'POST',
                   {'parts': [{'type': 'text', 'text': ('AGENT-A' if n == 'wt-a' else 'AGENT-B') + ': create agent.txt'}]}), kwargs={'directory': worktrees[n]})
                   for n in worktrees]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        wait(lambda: all((p / 'agent.txt').exists() for p in worktrees.values()), 90)
        results['agent_a_wrote_only_its_worktree'] = (worktrees['wt-a'] / 'agent.txt').read_text().strip() == 'written by agent-a' if (worktrees['wt-a'] / 'agent.txt').exists() else False
        results['agent_b_wrote_only_its_worktree'] = (worktrees['wt-b'] / 'agent.txt').read_text().strip() == 'written by agent-b' if (worktrees['wt-b'] / 'agent.txt').exists() else False
        results['main_checkout_untouched'] = not (repo / 'agent.txt').exists()
        results['max_overlapping_model_requests'] = mock.max_active
        os.killpg(server.pid, 15)
        server.wait(10)

        # Check 4: scoping of status, approvals, and replies.
        configure('ask')
        (worktrees['wt-b'] / 'agent.txt').unlink(missing_ok=True)
        server, base = serve()
        _, s = call(base, '/session', 'POST', {'title': 'perm'}, directory=worktrees['wt-b'])
        call(base, f'/session/{s["id"]}/prompt_async', 'POST', {'parts': [{'type': 'text', 'text': 'AGENT-B: create agent.txt'}]}, directory=worktrees['wt-b'])
        wait(lambda: len(call(base, '/permission', directory=worktrees['wt-b'])[1] or []) > 0, 60)
        pending_scoped = call(base, '/permission', directory=worktrees['wt-b'])[1] or []
        results['pending_approvals_visible_without_directory'] = len(call(base, '/permission')[1] or [])
        results['pending_approvals_visible_with_directory'] = len(pending_scoped)
        results['busy_status_visible_without_directory'] = s['id'] in (call(base, '/session/status')[1] or {})
        results['busy_status_visible_with_directory'] = s['id'] in (call(base, '/session/status', directory=worktrees['wt-b'])[1] or {})
        if pending_scoped:
            rid = pending_scoped[0]['id']
            results['reply_without_directory_http'] = call(base, f'/permission/{rid}/reply', 'POST', {'reply': 'once'})[0]
            results['reply_with_directory_http'] = call(base, f'/permission/{rid}/reply', 'POST', {'reply': 'once'}, directory=worktrees['wt-b'])[0]
            results['write_after_approval'] = wait(lambda: (worktrees['wt-b'] / 'agent.txt').exists(), 30)
    finally:
        if server and server.poll() is None:
            os.killpg(server.pid, 15)
        shutil.rmtree(root, ignore_errors=True)
    print(json.dumps(results, indent=2))
    scoped = not results.get('busy_status_visible_without_directory') and results.get('busy_status_visible_with_directory')
    print('\nVerdict:', 'worktree sessions work; the adapter must pass ?directory= on status, approval, and reply calls'
          if scoped else 'see the results above')


if __name__ == '__main__':
    main()
