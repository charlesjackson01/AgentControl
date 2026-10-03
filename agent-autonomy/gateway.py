"""Optional model gateway (M5): one local OpenAI-compatible door in front of the model server.

Point OpenCode and Hermes at it instead of at llama-server directly:
    http://127.0.0.1:<port>/agent/opencode/v1     (OpenCode provider baseURL)
    http://127.0.0.1:<port>/agent/hermes/v1       (Hermes base_url)
The path names the caller, so every request is queued by priority through the broker
(Hermes planning before coding), limited to the endpoint's `slots`, and its token usage is
recorded against the active run. Requests are forwarded unchanged and responses are
streamed back as they arrive. The key for the model server, if any, is added here from the
ai-arch secret store, so agents never see it. Follows the design of ai-arch's `aid`
gateway (queue, cancellation, usage metering, health), in Python instead of Qt/D-Bus.

M12: a request whose "model" is an endpoint id goes to that endpoint (the rest go to the
default). A paid endpoint is used only when `authorize` allows it for the run (your per-run,
per-role choice and spend caps): this gateway is the single place paid calls leave from, so
the caps hold. Each endpoint has its own slots, so a remote provider never waits on your GPU.

Loopback only. Standard library only.
"""
import http.client
import os
import socketserver
import json
import re
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import models

GENERATE = {'/v1/chat/completions', '/v1/completions', '/v1/embeddings'}
MAX_BODY = 32 * 1024 * 1024
HOP_HEADERS = {'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers',
               'transfer-encoding', 'upgrade', 'host', 'content-length', 'authorization',
               'accept-encoding'}  # keep replies uncompressed so usage can be read from the stream
AGENT = re.compile(r'^/agent/([a-z0-9][a-z0-9_-]{0,39})(/v1/.*)$')


def cost_from(payload):
    """Cost a provider reported for this call (OpenRouter's usage accounting puts it in usage.cost)."""
    usage = payload.get('usage') if isinstance(payload, dict) else None
    value = usage.get('cost') if isinstance(usage, dict) else None
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0 else None


def route(broker, body):
    """(endpoint, body): a request naming an endpoint id as its model goes there, with the model
    rewritten to that endpoint's own model name; everything else goes to the default endpoint."""
    try:
        payload = json.loads(body) if body else None
    except ValueError:
        payload = None
    if isinstance(payload, dict) and isinstance(payload.get('model'), str):
        chosen = next((e for e in broker.endpoints if e['id'] == payload['model']), None)
        if chosen:
            if chosen['model']:
                payload['model'] = chosen['model']
            if chosen['paid'] and payload.get('stream'):
                # Streams carry token counts only when asked; the spend cap needs them.
                payload['stream_options'] = {**(payload.get('stream_options') if isinstance(payload.get('stream_options'), dict) else {}), 'include_usage': True}
            if chosen.get('report_cost'):
                payload['usage'] = {**(payload.get('usage') if isinstance(payload.get('usage'), dict) else {}), 'include': True}
            return chosen, json.dumps(payload).encode()
    return broker.endpoint(), body


def usage_from(payload):
    """(tokens_in, tokens_out) from an OpenAI `usage` object or llama-server `timings`."""
    if not isinstance(payload, dict):
        return None, None
    usage = payload.get('usage')
    if isinstance(usage, dict) and ('prompt_tokens' in usage or 'completion_tokens' in usage):
        return usage.get('prompt_tokens'), usage.get('completion_tokens')
    timings = payload.get('timings')
    if isinstance(timings, dict) and ('prompt_n' in timings or 'predicted_n' in timings):
        return timings.get('prompt_n'), timings.get('predicted_n')
    return None, None


class SseUsage:
    """Watches a streamed response for the chunk that carries usage, without buffering the stream."""

    def __init__(self):
        self.buffer = b''
        self.tokens = (None, None)
        self.cost = None
        self.model = ''
        self.done = False  # saw data: [DONE]; a stream that closes without it was cut off

    def feed(self, data):
        self.buffer = (self.buffer + data)[-65536:]
        *lines, self.buffer = self.buffer.split(b'\n')
        for line in lines:
            line = line.strip()
            if line in (b'data: [DONE]', b'data:[DONE]'):
                self.done = True
                continue
            if not line.startswith(b'data:'):
                continue
            try:
                payload = json.loads(line[5:])
            except ValueError:
                continue
            found = usage_from(payload)
            if found != (None, None):
                self.tokens = found
            if cost_from(payload) is not None:
                self.cost = cost_from(payload)
            if isinstance(payload, dict) and payload.get('model'):
                self.model = str(payload['model'])[:200]


def gateway_handler(broker, record, active_run=lambda: None, roles=None, slot_timeout=600, authorize=None):
    """`record(dict)` stores one usage row. `roles` maps agent name -> role for priority.
    `authorize(run, agent, endpoint)` returns '' to allow a paid endpoint, else the reason it is refused."""
    roles = roles or {'hermes': 'orchestrator'}

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, fmt, *args):
            pass  # request bodies are prompts; never log them

        def fail(self, code, message):
            raw = json.dumps({'error': {'message': message, 'type': 'agentcontrol_gateway'}}).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(raw)))
            self.send_header('Connection', 'close')
            self.end_headers()
            self.close_connection = True
            try:
                self.wfile.write(raw)
            except OSError:
                pass

        def do_GET(self):
            self.forward()

        def do_POST(self):
            self.forward()

        def forward(self):
            unix = isinstance(self.server, socketserver.UnixStreamServer)  # a run container's socket (M10)
            if not unix and not self.client_address[0].startswith('127.') and self.client_address[0] != '::1':
                return self.fail(403, 'The model gateway only accepts local connections.')
            parsed = urllib.parse.urlsplit(self.path)
            match = AGENT.match(parsed.path)
            agent, path = (match.group(1), match.group(2)) if match else ('unknown', parsed.path)
            if not path.startswith('/v1/'):
                return self.fail(404, 'Use /agent/<name>/v1/... or /v1/...')
            if not broker.configured:
                return self.fail(503, 'No model endpoint is configured in AgentControl.')
            length = int(self.headers.get('Content-Length') or 0)
            if length > MAX_BODY:
                return self.fail(413, 'Request body is too large.')
            body = self.rfile.read(length) if length else b''
            endpoint, body = route(broker, body) if self.command == 'POST' else (broker.endpoint(), body)
            if self.command == 'POST' and path in GENERATE:
                run = active_run()
                if endpoint['paid']:
                    refusal = authorize(run, agent, endpoint) if authorize else 'Paid endpoints need a run that allows them.'
                    if refusal:
                        record({'run': run, 'agent': agent, 'source': 'gateway', 'endpoint': endpoint['id'], 'status': 'refused'})
                        return self.fail(402, refusal)
                try:
                    with broker.slot(endpoint['id'], agent=agent, role=roles.get(agent, 'coder'), timeout=slot_timeout) as ticket:
                        self.relay(endpoint, path, parsed.query, body, agent, run, ticket['queued_ms'])
                except TimeoutError as exc:
                    record({'run': run, 'agent': agent, 'source': 'gateway', 'endpoint': endpoint['id'], 'status': 'queue_timeout'})
                    self.fail(503, str(exc))
            else:
                self.relay(endpoint, path, parsed.query, body, agent, None, None)

        def relay(self, endpoint, path, query, body, agent, run, queued_ms):
            started = time.monotonic()
            target = urllib.parse.urlsplit(endpoint['url'])
            conn_class = http.client.HTTPSConnection if target.scheme == 'https' else http.client.HTTPConnection
            conn = conn_class(target.hostname, target.port, timeout=endpoint['timeout_ms'] / 1000)
            headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP_HEADERS}
            status, tokens, model, reported = 'ok', (None, None), '', None
            try:
                key = models.read_secret(endpoint['api_key_ref'])
                if key:
                    headers['Authorization'] = 'Bearer ' + key
                headers['Content-Length'] = str(len(body))
                conn.request(self.command, target.path.rstrip('/') + path + ('?' + query if query else ''), body=body, headers=headers)
                upstream = conn.getresponse()
            except (OSError, http.client.HTTPException, models.RegistryError) as exc:
                if run is not None or queued_ms is not None:
                    record({'run': run, 'agent': agent, 'source': 'gateway', 'endpoint': endpoint['id'], 'status': 'offline',
                            'queued_ms': queued_ms, 'duration_ms': round((time.monotonic() - started) * 1000)})
                conn.close()
                return self.fail(502, f"Model server {endpoint['id']} at {endpoint['url']} is not responding: {exc}")
            streaming = 'text/event-stream' in (upstream.getheader('Content-Type') or '')
            watcher = SseUsage() if streaming else None
            collected = []
            try:
                self.send_response(upstream.status)
                for name, value in upstream.getheaders():
                    if name.lower() not in HOP_HEADERS:
                        self.send_header(name, value)
                length = upstream.getheader('Content-Length')
                if length and not streaming:
                    self.send_header('Content-Length', length)
                else:
                    self.send_header('Connection', 'close')
                    self.close_connection = True
                self.end_headers()
                while True:
                    chunk = upstream.read1(65536) if hasattr(upstream, 'read1') else upstream.read(65536)
                    if not chunk:
                        break
                    if watcher:
                        watcher.feed(chunk)
                    elif sum(len(c) for c in collected) < 4 * 1024 * 1024:
                        collected.append(chunk)
                    self.wfile.write(chunk)
                    self.wfile.flush()
                if upstream.status >= 400:
                    status = f'http_{upstream.status}'
            except (BrokenPipeError, ConnectionResetError):
                status = 'cancelled'  # the agent went away; closing upstream frees the slot
            except (OSError, http.client.HTTPException):
                status = 'interrupted'
            finally:
                conn.close()
            if watcher:
                tokens, model, reported = watcher.tokens, watcher.model, watcher.cost
                if status == 'ok' and not watcher.done:
                    status = 'incomplete'
            elif collected:
                try:
                    payload = json.loads(b''.join(collected))
                    tokens, model, reported = usage_from(payload), str(payload.get('model') or '')[:200], cost_from(payload)
                except (ValueError, AttributeError):
                    pass
            if run is not None or queued_ms is not None:
                record({'run': run, 'agent': agent, 'source': 'gateway', 'endpoint': endpoint['id'],
                        'model': model or endpoint['model'], 'tokens_in': tokens[0], 'tokens_out': tokens[1],
                        'duration_ms': round((time.monotonic() - started) * 1000), 'queued_ms': queued_ms, 'status': status,
                        'cost': (reported if reported is not None and endpoint['paid'] else models.cost(endpoint, tokens[0], tokens[1]))})

    return Handler


class UnixGateway(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def serve_unix(broker, record, run_id, path, authorize=None):
    """The gateway for one run container: a Unix socket in the run's folder, which is the
    container's only way to reach the model server. Usage is always recorded against that run."""
    if os.path.exists(path):
        os.unlink(path)
    server = UnixGateway(path, gateway_handler(broker, record, lambda: run_id, authorize=authorize))
    os.chmod(path, 0o660)
    return server


def serve(broker, record, active_run, port, host='127.0.0.1', authorize=None):
    if host not in ('127.0.0.1', 'localhost', '::1'):
        raise ValueError('The model gateway binds to loopback only')
    return ThreadingHTTPServer((host, port), gateway_handler(broker, record, active_run, authorize=authorize))
