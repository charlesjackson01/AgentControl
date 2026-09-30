#!/usr/bin/env python3
"""M12 spike: can AgentControl choose an OpenCode agent and a model per prompt?

Fully isolated (temporary repo, HOME and config, two scripted mock models, no network, no cost).
Checks against a real `opencode serve`:
  1. prompt_async with "agent": "plan" (OpenCode's built-in read-only agent): are edit tools
     offered to the model, and does a requested write land, even with edit permission "allow"?
  2. prompt_async with "tools": {name: false}: are those tools withheld from the model?
  3. prompt_async with "model": {"providerID", "modelID"}: does the request reach that provider
     instead of the default one?

    python3 opencode_agent_probe.py [--opencode /path/to/opencode]
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class Mock:
    """Streams a `write` tool call for probe.txt on the first turn, then finishes. Records tool names."""

    def __init__(self, name):
        self.name, self.requests = name, []
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
                tools = [t.get('function', {}).get('name') for t in req.get('tools') or []]
                messages = req.get('messages', [])
                if tools:
                    mock.requests.append(tools)
                if not tools:
                    chunks = [{'delta': {'content': 'Title'}, 'finish_reason': None}, {'delta': {}, 'finish_reason': 'stop'}]
                elif messages and messages[-1].get('role') == 'tool':
                    chunks = [{'delta': {'content': 'Done.'}, 'finish_reason': None}, {'delta': {}, 'finish_reason': 'stop'}]
                else:
                    args = json.dumps({'filePath': 'probe.txt', 'content': f'written via {mock.name}\n'})
                    chunks = [{'delta': {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'call_1', 'type': 'function',
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


def provider(port, label):
    return {'npm': '@ai-sdk/openai-compatible', 'name': label,
            'options': {'baseURL': f'http://127.0.0.1:{port}/v1', 'apiKey': 'x'},
            'models': {'m': {'name': 'm', 'tool_call': True}}}


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--opencode', default=os.environ.get('OPENCODE_BIN') or shutil.which('opencode'))
    a = p.parse_args()
    if not a.opencode:
        raise SystemExit('No opencode binary; pass --opencode')
    local, other = Mock('local'), Mock('other')
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        repo = root / 'repo'
        repo.mkdir()
        subprocess.run(['git', 'init', '-q'], cwd=repo, check=True)
        home = root / 'home'
        (home / '.config' / 'opencode').mkdir(parents=True)
        (home / '.config' / 'opencode' / 'opencode.json').write_text(json.dumps({
            'provider': {'local': provider(local.port, 'Local'), 'agentcontrol': provider(other.port, 'Other')},
            'model': 'local/m', 'small_model': 'local/m',
            'permission': {'edit': 'allow', 'bash': 'allow', 'external_directory': 'allow'}}))
        port = free_port()
        env = dict(os.environ, HOME=str(home), XDG_CONFIG_HOME=str(home / '.config'))
        server = subprocess.Popen([a.opencode, 'serve', '--port', str(port)], cwd=repo, env=env,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        base = f'http://127.0.0.1:{port}'

        def call(path, method='GET', data=None):
            req = urllib.request.Request(base + path + ('&' if '?' in path else '?') + 'directory=' + urllib.request.quote(str(repo)),
                                         data=json.dumps(data).encode() if data is not None else None, method=method,
                                         headers={'Content-Type': 'application/json'})
            with opener.open(req, timeout=30) as r:
                body = r.read()
                return json.loads(body) if body else None

        try:
            until = time.monotonic() + 90
            while True:
                try:
                    opener.open(base + '/global/health', timeout=2)
                    break
                except OSError:
                    if time.monotonic() > until:
                        raise SystemExit('opencode serve did not start')
                    time.sleep(.3)

            def turn(extra):
                sid = call('/session', 'POST', {'title': 'probe'})['id']
                call(f'/session/{sid}/prompt_async', 'POST', {'messageID': 'msg_' + uuid.uuid4().hex, 'parts': [{'type': 'text', 'text': 'write probe.txt'}], **extra})
                until = time.monotonic() + 60
                while time.monotonic() < until:
                    busy = call('/session/status') or {}
                    msgs = call(f'/session/{sid}/message')
                    done = [m for m in msgs if m['info']['role'] == 'assistant' and m['info'].get('time', {}).get('completed')]
                    if sid not in busy and done:
                        return msgs
                    time.sleep(.3)
                return call(f'/session/{sid}/message')

            (repo / 'probe.txt').unlink(missing_ok=True)
            before = len(local.requests)
            msgs = turn({'agent': 'plan'})
            tools = local.requests[before] if len(local.requests) > before else []
            wrote = (repo / 'probe.txt').exists()
            agent_used = next((m['info'].get('agent') for m in msgs if m['info']['role'] == 'assistant'), None)
            print(json.dumps({'check': 'agent plan', 'agent_recorded': agent_used, 'edit_tools_offered': sorted(set(tools) & {'write', 'edit', 'patch', 'multiedit', 'bash'}),
                              'file_written': wrote}))

            (repo / 'probe.txt').unlink(missing_ok=True)
            before = len(local.requests)
            off = {name: False for name in ('write', 'edit', 'patch', 'multiedit', 'bash', 'apply_patch', 'todowrite', 'task')}
            turn({'tools': off})
            tools = local.requests[before] if len(local.requests) > before else []
            print(json.dumps({'check': 'per-prompt tools off', 'tools_offered': sorted(tools), 'file_written': (repo / 'probe.txt').exists()}))

            (repo / 'probe.txt').unlink(missing_ok=True)
            before_local, before_other = len(local.requests), len(other.requests)
            turn({'model': {'providerID': 'agentcontrol', 'modelID': 'm'}})
            print(json.dumps({'check': 'per-prompt model', 'requests_to_default': len(local.requests) - before_local,
                              'requests_to_chosen': len(other.requests) - before_other,
                              'file_written': (repo / 'probe.txt').read_text().strip() if (repo / 'probe.txt').exists() else None}))
        finally:
            server.terminate()
            try:
                server.wait(10)
            except subprocess.TimeoutExpired:
                server.kill()
            local.server.shutdown()
            other.server.shutdown()


if __name__ == '__main__':
    main()
