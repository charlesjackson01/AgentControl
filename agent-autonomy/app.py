#!/usr/bin/env python3
"""Local and Tailscale dashboard for the autonomous controller."""
import argparse
import fcntl
import hmac
import json
import os
from pathlib import Path
import secrets
import signal
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from engine import Controller, ReviewConflict, Settings

ROOT = Path(__file__).resolve().parent


def handler(controller, key):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            # Never log credentials or goal text.
            if self.command != 'GET' or self.path != '/api/state':
                print(f'{self.client_address[0]} {self.command} {urllib.parse.urlsplit(self.path).path}', flush=True)

        def reply(self, code, value, content_type='application/json'):
            raw = value if isinstance(value, bytes) else value.encode() if isinstance(value, str) else json.dumps(value).encode()
            self.send_response(code)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(raw)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('X-Frame-Options', 'DENY')
            self.end_headers()
            try:
                self.wfile.write(raw)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def allowed(self):
            value = self.headers.get('Authorization', '')
            return hmac.compare_digest(value, 'Bearer ' + key)

        def do_GET(self):
            path = urllib.parse.urlsplit(self.path)
            if path.path == '/':
                return self.reply(200, (ROOT / 'index.html').read_text(), 'text/html; charset=utf-8')
            assets = {'/themes.css': 'text/css; charset=utf-8', '/app.css': 'text/css; charset=utf-8', '/app.js': 'text/javascript; charset=utf-8'}
            if path.path in assets:
                return self.reply(200, (ROOT / path.path[1:]).read_text(), assets[path.path])
            if not self.allowed():
                return self.reply(401, {'error': 'Enter the dashboard key printed in your server terminal.'})
            if path.path == '/api/state':
                selected = urllib.parse.parse_qs(path.query).get('run', [''])[0]
                return self.reply(200, controller.state(selected))
            if path.path == '/api/preview/output':
                since = urllib.parse.parse_qs(path.query).get('since', ['0'])[0]
                return self.reply(200, controller.preview.output(int(since) if since.isdigit() else 0))
            if path.path == '/api/preview/frame':
                try:
                    return self.reply(200, controller.preview.frame(), 'image/png')
                except ValueError as exc:
                    return self.reply(409, {'error': str(exc)})
            self.reply(404, {'error': 'Not found'})

        def do_POST(self):
            if not self.allowed():
                return self.reply(401, {'error': 'Dashboard key required'})
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if size < 0 or size > 40000:
                    return self.reply(413, {'error': 'Request too large'})
                body = json.loads(self.rfile.read(size) or '{}')
                if not isinstance(body, dict):
                    raise ValueError('JSON object required')
                if self.path == '/api/check':
                    threading.Thread(target=controller.check, daemon=True).start()
                    return self.reply(202, {'ok': True})
                if self.path == '/api/runs':
                    run = controller.new(body.get('goal', ''), body.get('verifier', ''), body.get('max_steps', 8),
                                         body.get('goal_checks'), body.get('run_minutes'), body.get('parent_run'), body.get('title'), body.get('preview'))
                    return self.reply(201, {'id': run['id']})
                if self.path == '/api/preview/ticket':
                    return self.reply(200, {'ticket': controller.preview.issue_ticket(), 'port': controller.preview.listen_port})
                if self.path == '/api/preview':
                    return self.reply(200, controller.preview_action(body['run'], body['action'], body))
                if self.path == '/api/control':
                    return self.reply(200, controller.control(body['run'], body['action'], body.get('text', '')))
                if self.path == '/api/review':
                    result = controller.review(body['run'], body['kind'], body['request_id'],
                                               body['fingerprint'], body['action'], body.get('answers'), body.get('redirect'))
                    return self.reply(200 if result['state'] == 'confirmed' else 202, result)
                return self.reply(404, {'error': 'Not found'})
            except ReviewConflict as exc:
                return self.reply(409, {'error': str(exc)})
            except (ValueError, KeyError, TypeError) as exc:
                return self.reply(400, {'error': str(exc)})
            except Exception as exc:
                return self.reply(500, {'error': str(exc)})
    return Handler


def preview_handler(manager, dashboard_port):
    """Requests on the preview port: a separate origin that never sees the dashboard key."""
    class PreviewHandler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, fmt, *args):
            pass

        def handle_one_request(self):
            try:
                super().handle_one_request()
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True

        def _serve(self):
            manager.serve(self, dashboard_port)

        do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = _serve
    return PreviewHandler


def _interrupt(signum, frame):
    raise KeyboardInterrupt


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--host', default=os.environ.get('DASHBOARD_HOST', '127.0.0.1'))
    p.add_argument('--port', type=int, default=int(os.environ.get('DASHBOARD_PORT', '8766')))
    p.add_argument('--project', type=Path, default=ROOT.parent)
    p.add_argument('--opencode', default=os.environ.get('OPENCODE_URL', 'http://127.0.0.1:45381'))
    p.add_argument('--profile', default=os.environ.get('HERMES_PROFILE', 'ai-arch-dev'))
    p.add_argument('--hermes', default=os.environ.get('HERMES_BIN', 'hermes'))
    p.add_argument('--target', default='push')
    p.add_argument('--no-notifications', action='store_true')
    p.add_argument('--doctor', action='store_true', help='Check connections and CLI flags; do not run a model')
    p.add_argument('--preview-port', type=int, default=None, help='Port for live previews (default: dashboard port + 1)')
    p.add_argument('--no-preview', action='store_true', help='Disable the live preview listener')
    p.add_argument('--preview-idle-minutes', type=float, default=30, help='Stop an unused preview after this many minutes')
    a = p.parse_args()
    project = a.project.expanduser().resolve()
    if not project.is_dir():
        p.error(f'Project directory does not exist: {project}')
    data = ROOT / 'state'
    data.mkdir(exist_ok=True, mode=0o700)
    # Prevent two controllers from monitoring / writing the same journal.
    lockfile = (data / 'controller.lock').open('a')
    try:
        fcntl.flock(lockfile, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        p.error('Another controller is running from this folder. Stop that process first.')
    s = Settings(project=project, data=data, opencode_url=a.opencode, hermes=a.hermes,
                 profile=a.profile, push_target=a.target, notifications=not a.no_notifications,
                 password=os.environ.get('OPENCODE_SERVER_PASSWORD', ''), username=os.environ.get('OPENCODE_SERVER_USERNAME', 'opencode'),
                 preview_idle=max(0, a.preview_idle_minutes) * 60)
    controller = Controller(s)
    if a.doctor:
        status = controller.check()
        print(json.dumps(status, indent=2))
        return 0 if status['ready'] else 1
    keyfile = data / 'dashboard.key'
    if not keyfile.exists():
        fd = os.open(keyfile, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as f:
            f.write(secrets.token_urlsafe(24))
    key = keyfile.read_text().strip()
    try:
        server = ThreadingHTTPServer((a.host, a.port), handler(controller, key))
    except OSError as exc:
        print(f'Cannot bind {a.host}:{a.port}: {exc}\nStop the old dashboard on this port or choose --port 8767.')
        return 1
    preview_server = None
    if not a.no_preview:
        preview_port = a.preview_port if a.preview_port is not None else (server.server_port + 1 if a.port else 0)
        try:
            preview_server = ThreadingHTTPServer((a.host, preview_port), preview_handler(controller.preview, server.server_port))
            controller.preview.listen_port = preview_server.server_port
            threading.Thread(target=preview_server.serve_forever, daemon=True).start()
        except OSError as exc:
            print(f'Live preview disabled: cannot bind {a.host}:{preview_port}: {exc}. Use --preview-port to choose another.')
    print(f'AgentControl: http://{a.host}:{server.server_port}\nProject: {project}\nOpenCode: {a.opencode}\nHermes profile: {a.profile or "current"}\nLive preview port: {controller.preview.listen_port or "off"}\nDashboard key: {key}', flush=True)
    threading.Thread(target=controller.check, daemon=True).start()
    # Treat `kill` like Ctrl+C so previews and their child processes are cleaned up.
    signal.signal(signal.SIGTERM, _interrupt)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopping controller. Any submitted OpenCode task may still be running; use Resume after restarting to reconcile it.', flush=True)
    finally:
        controller.shutdown.set()
        controller.preview.close()
        if preview_server:
            preview_server.shutdown()
        server.server_close()
        for thread in list(controller.threads.values()):
            thread.join(timeout=5)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
