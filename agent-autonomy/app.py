#!/usr/bin/env python3
"""Local and Tailscale dashboard for the autonomous controller."""
import argparse
import fcntl
import gzip
import hmac
import json
import os
import queue
import select
import socket
from pathlib import Path
import secrets
import signal
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import agents as agent_registry
from engine import Controller, ReviewConflict, Settings, TERMINAL
import gateway
from adapters import jev as jev_api
import workspaces

ROOT = Path(__file__).resolve().parent
MAX_EVENT_STREAMS = 12       # each open dashboard tab holds one thread
KEEPALIVE_SECONDS = 15       # comment lines keep proxies and phones from dropping an idle stream


def parse_known(text):
    """'step_1:123,step_2:456' -> {'step_1': 123, ...}: the turn revisions the dashboard already holds."""
    known = {}
    for item in text.split(',')[:2000]:
        ident, _, rev = item.rpartition(':')
        if ident and rev.isdigit():
            known[ident] = int(rev)
    return known


def handler(controller, key):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            # Never log credentials or goal text.
            if self.command != 'GET' or urllib.parse.urlsplit(self.path).path != '/api/state':
                print(f'{self.client_address[0]} {self.command} {urllib.parse.urlsplit(self.path).path}', flush=True)

        def reply(self, code, value, content_type='application/json'):
            raw = value if isinstance(value, bytes) else value.encode() if isinstance(value, str) else json.dumps(value).encode()
            # Large JSON (a run's transcripts) compresses about tenfold; worth it over Tailscale to a phone.
            packed = content_type == 'application/json' and len(raw) > 16384 and 'gzip' in self.headers.get('Accept-Encoding', '')
            if packed:
                raw = gzip.compress(raw, 5)
            self.send_response(code)
            self.send_header('Content-Type', content_type)
            if packed:
                self.send_header('Content-Encoding', 'gzip')
                self.send_header('Vary', 'Accept-Encoding')
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
            if path.path in ('/classic', '/classic/') or (path.path == '/' and
                    'popout' in urllib.parse.parse_qs(path.query, keep_blank_values=True)):
                return self.reply(200, (ROOT / 'index.html').read_text(), 'text/html; charset=utf-8')
            if path.path in ('/', '/chat', '/chat/'):
                return self.reply(200, (ROOT / 'chat' / 'index.html').read_bytes(), 'text/html; charset=utf-8')
            if path.path.startswith('/chat/'):
                import re
                name = path.path[len('/chat/'):]
                chat_root = (ROOT / 'chat').resolve()
                asset = (chat_root / name).resolve()
                if (re.fullmatch(r'[a-z0-9][a-z0-9-]*\.(css|js|woff2)', name)
                        and asset.parent == chat_root and asset.is_file()):
                    kind = 'font/woff2' if name.endswith('.woff2') else 'text/css; charset=utf-8' if name.endswith('.css') else 'text/javascript; charset=utf-8'
                    return self.reply(200, asset.read_bytes(), kind)
                return self.reply(404, {'error': 'Not found'})
            assets = {'/themes.css': 'text/css; charset=utf-8', '/app.css': 'text/css; charset=utf-8', '/app.js': 'text/javascript; charset=utf-8',
                      '/workspace.css': 'text/css; charset=utf-8', '/workspace.js': 'text/javascript; charset=utf-8'}
            if path.path in assets:
                return self.reply(200, (ROOT / path.path[1:]).read_text(), assets[path.path])
            if not self.allowed():
                return self.reply(401, {'error': 'Enter the dashboard key printed in your server terminal.'})
            if path.path == '/api/events':
                return self.stream_events()
            if path.path == '/api/audit':
                ident = urllib.parse.parse_qs(path.query).get('run', [''])[0] or None
                intact, broken_at = controller.store.audit_verify()
                return self.reply(200, {'entries': controller.store.audit(ident), 'chain_intact': intact, 'broken_at': broken_at})
            if path.path == '/api/workspace/preflight':
                info = workspaces.git_info(controller.s.project)
                return self.reply(200, {k: info[k] for k in ('is_repo', 'usable', 'reason', 'branch', 'subdir')} |
                                  {'changes': info['changes'][:50], 'untracked': info['untracked'][:50],
                                   'dirty_count': len(info['changes']) + len(info['untracked'])})
            if path.path == '/api/usage':
                period = (urllib.parse.parse_qs(path.query).get('period') or ['month'])[0]
                return self.reply(200, controller.usage_report(period))
            if path.path == '/api/sandbox':
                if urllib.parse.parse_qs(path.query).get('check'):
                    controller.sandbox_info(refresh=True)
                return self.reply(200, controller.sandbox_status())
            if path.path == '/api/skills':
                ident = urllib.parse.parse_qs(path.query).get('run', [''])[0]
                run = None
                if ident:
                    try:
                        run = controller.store.get('runs', ident)
                    except KeyError:
                        return self.reply(404, {'error': 'Unknown run'})
                return self.reply(200, controller.skills_status(run))
            if path.path == '/api/models':
                ident = urllib.parse.parse_qs(path.query).get('run', [''])[0] or None
                if urllib.parse.parse_qs(path.query).get('check'):
                    for endpoint in controller.broker.endpoints:
                        controller.broker.health(endpoint['id'], max_age=0)
                return self.reply(200, {**controller.models_status(), 'usage': controller.store.usage_summary(ident),
                                        'calls': controller.store.usage(ident, limit=100)})
            if path.path == '/api/agents':
                ident = urllib.parse.parse_qs(path.query).get('run', [''])[0]
                try:
                    run = controller.store.get('runs', ident)
                except KeyError:
                    return self.reply(404, {'error': 'Unknown run'})
                return self.reply(200, {'run': ident, 'agents': controller.agents(run), 'types': agent_registry.types()})
            if path.path in ('/api/channels', '/api/thread'):
                import conversation
                query = urllib.parse.parse_qs(path.query, keep_blank_values=True)
                try:
                    if path.path == '/api/channels':
                        return self.reply(200, conversation.channels(controller))
                    return self.reply(200, conversation.thread(
                        controller, channel=query.get('channel', [None])[0],
                        session_id=query.get('session', [None])[0], before=query.get('before', [None])[0],
                        limit=query.get('limit', [200])[0], known=parse_known(query.get('known', [''])[0])))
                except KeyError:
                    return self.reply(404, {'error': 'Unknown session'})
                except ValueError as exc:
                    return self.reply(400, {'error': str(exc)})
            if path.path == '/api/state':
                query = urllib.parse.parse_qs(path.query)
                return self.reply(200, controller.state(query.get('run', [''])[0], (query.get('scope') or ['current'])[0],
                                                        known=parse_known((query.get('known') or [''])[0])))
            if path.path == '/api/projects/browse':
                try:
                    return self.reply(200, controller.browse_projects((urllib.parse.parse_qs(path.query).get('path') or [''])[0]))
                except ValueError as exc:
                    return self.reply(400, {'error': str(exc)})
            if path.path == '/api/preview/output':
                since = urllib.parse.parse_qs(path.query).get('since', ['0'])[0]
                return self.reply(200, controller.preview.output(int(since) if since.isdigit() else 0))
            if path.path == '/api/vm/screen':
                ident = (urllib.parse.parse_qs(path.query).get('run') or [''])[0]
                try:
                    return self.reply(200, controller.vm_console(ident), 'image/png')
                except (ValueError, KeyError, RuntimeError) as exc:
                    return self.reply(409, {'error': str(exc)})
            if path.path == '/api/surface/frame':
                query = urllib.parse.parse_qs(path.query)
                try:
                    return self.reply(200, controller.surface_frame((query.get('run') or [''])[0], (query.get('id') or [''])[0]), 'image/png')
                except KeyError:
                    return self.reply(404, {'error': 'No such surface'})
                except (ValueError, RuntimeError) as exc:
                    return self.reply(409, {'error': str(exc)})
            if path.path == '/api/preview/frame':
                try:
                    return self.reply(200, controller.preview.frame(), 'image/png')
                except ValueError as exc:
                    return self.reply(409, {'error': str(exc)})
            self.reply(404, {'error': 'Not found'})

        def client_gone(self):
            """True once the browser has closed the stream (the socket reads as EOF), so a closed tab
            frees its slot within a second instead of at the next keepalive."""
            try:
                readable, _, _ = select.select([self.connection], [], [], 0)
                return bool(readable) and self.connection.recv(1, socket.MSG_PEEK) == b''
            except (OSError, ValueError):
                return True

        def stream_events(self):
            """Server-Sent Events: small change notices; the dashboard re-reads /api/state on each."""
            subscriber = controller.events.subscribe(limit=MAX_EVENT_STREAMS)
            if subscriber is None:
                return self.reply(503, {'error': 'Too many live connections; this tab will poll instead.'})
            try:
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('X-Accel-Buffering', 'no')
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.end_headers()
                self.close_connection = True
                self.wfile.write(f'retry: 3000\nevent: hello\ndata: {json.dumps({"seq": controller.events.seq})}\n\n'.encode())
                self.wfile.flush()
                quiet = 0.0
                while not controller.shutdown.is_set():
                    try:
                        event = subscriber.get(timeout=1)
                    except queue.Empty:
                        if self.client_gone():
                            break
                        quiet += 1
                        if quiet >= KEEPALIVE_SECONDS:
                            self.wfile.write(b': keepalive\n\n')
                            self.wfile.flush()
                            quiet = 0
                        continue
                    quiet = 0
                    self.wfile.write(f'id: {event["seq"]}\nevent: change\ndata: {json.dumps(event)}\n\n'.encode())
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass  # the tab closed or the network dropped
            finally:
                controller.events.unsubscribe(subscriber)

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
                                         body.get('goal_checks'), body.get('run_minutes'), body.get('parent_run'), body.get('title'), body.get('preview'),
                                         allow_dirty=body.get('allow_dirty') is True, setup=body.get('setup', ''),
                                         mode=body.get('mode', 'single'), **({'team_size': body['team_size']} if 'team_size' in body else {}),
                                         isolation=body.get('isolation', 'host'), cpus=body.get('cpus', 4), memory_gb=body.get('memory_gb', 8),
                                         network=body.get('network', 'setup'), confirm=body.get('confirm'),
                                         models=body.get('models'), spend_cap=body.get('spend_cap'), watch=body.get('watch') is True)
                    return self.reply(201, {'id': run['id']})
                if self.path == '/api/preview/ticket':
                    return self.reply(200, {'ticket': controller.preview.issue_ticket(), 'port': controller.preview.listen_port})
                if self.path == '/api/preview':
                    return self.reply(200, controller.preview_action(body['run'], body['action'], body))
                if self.path == '/api/skills/propose':
                    # Always your request: an API caller cannot claim to be Hermes.
                    return self.reply(200, controller.propose_capability(body['run'], body.get('agent', 'coder-1'), body.get('source'), 'you'))
                if self.path == '/api/skills/decide':
                    return self.reply(200, controller.decide_capability(body['id'], body.get('action')))
                if self.path == '/api/skills/remove':
                    return self.reply(200, controller.remove_capability(body['id']))
                if self.path == '/api/skills/fetch':
                    return self.reply(200, controller.fetch_capability(body['id']))
                if self.path == '/api/mode/preview':
                    steps = body.get('max_steps', 8)
                    checks = [c for c in (body.get('goal_checks') or []) if isinstance(c, str)][:20]
                    verifier = str(body.get('verifier') or '')[:2000]
                    return self.reply(200, controller.auto_decision(str(body.get('goal', ''))[:12000], checks, verifier.split(),
                                                                    steps if type(steps) is int else 8))
                if self.path == '/api/surface/input':
                    extra = {k: body[k] for k in ('x', 'y', 'width', 'height', 'text', 'key', 'button') if k in body}
                    try:
                        return self.reply(200, controller.surface_input(body['run'], str(body.get('id', '')), body.get('action'), **extra))
                    except KeyError:
                        return self.reply(404, {'error': 'No such surface'})
                if self.path == '/api/vm/input':
                    extra = {k: body[k] for k in ('x', 'y', 'width', 'height', 'text', 'key', 'button') if k in body}
                    return self.reply(200, controller.vm_input(body['run'], body.get('action'), **extra))
                if self.path == '/api/models/set':
                    cap = body.get('spend_cap')
                    return self.reply(200, controller.set_models(body['run'], body.get('models') or {}, cap, body.get('confirm', '')))
                if self.path == '/api/research/decide':
                    return self.reply(200, controller.decide_research(body['run'], body['step'], body.get('action'),
                                                                      body.get('fingerprint', ''), body.get('confirm', '')))
                if self.path == '/api/projects/select':
                    return self.reply(200, controller.select_project(str(body.get('path', ''))))
                if self.path == '/api/projects/create':
                    return self.reply(201, controller.create_project(str(body.get('name', ''))))
                if self.path == '/api/control':
                    return self.reply(200, controller.control(body['run'], body['action'], body.get('text', ''), body.get('agent')))
                if self.path == '/api/review':
                    # The API always acts as the person; automatic rule approvals only happen inside the engine.
                    result = controller.review(body['run'], body['kind'], body['request_id'],
                                               body['fingerprint'], body['action'], body.get('answers'), body.get('redirect'),
                                               confirm=body.get('confirm'), remember=body.get('remember') is True)
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


def build_agent_image(a):
    """Build the agent image with your OpenCode binary. Prints the exact command first."""
    import shutil
    import subprocess
    import sandbox
    info = sandbox.detect(a.container_runtime)
    if not info['runtime']:
        print(info['error'])
        return 1
    binary = a.opencode_binary or (Path(shutil.which('opencode')).resolve() if shutil.which('opencode') else None)
    if not binary or not Path(binary).is_file():
        print('Could not find your opencode binary; pass --opencode-binary /path/to/opencode')
        return 1
    command = sandbox.build_command(info['runtime'], Path(binary).resolve())
    print('$ ' + ' '.join(command), flush=True)
    if not info['rootless']:
        print(f"Note: {info['runtime']} runs as root here. Agent containers are refused unless you use rootless Docker/Podman "
              'or start AgentControl with --allow-rootful-containers.', flush=True)
    return subprocess.run(command).returncode


def active_run(controller):
    """The run model calls through the gateway are counted against (one active run at a time today)."""
    return next((r['id'] for r in controller.store.runs() if r['status'] not in TERMINAL), None)


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
    p.add_argument('--skills-library', type=Path, default=Path(os.environ.get('AGENTCONTROL_SKILLS', '~/agentcontrol/skills')),
                   help='Folder of skills you curate (each a folder with SKILL.md)')
    p.add_argument('--research-toolsets', default='', help='Hermes toolsets the researcher may use, comma-separated (see spikes/hermes_research_probe.py). Empty: no researcher')
    p.add_argument('--jev-key', default='', help='Name of your TypeSafe Jev key in the ai-arch secret store (e.g. typesafe); enables the optional stuck watch')
    p.add_argument('--jev-model', default=None, help='Jev model id to use (default: the pinned version the probe was checked with)')
    p.add_argument('--jev-stuck-threshold', type=float, default=0.8, help='Jev probability that counts as a high check (two in a row flag an agent)')
    p.add_argument('--hermes-provider', default='', help="A provider in your Hermes config.yaml whose base_url is this gateway; lets Hermes use a per-run model (see README)")
    p.add_argument('--max-parallel-agents', type=int, default=None, help='Agents that may work at once (default: model slots + 1)')
    p.add_argument('--vm-baseline', type=Path, default=None, help='ai-arch baseline qcow2 that VM runs clone (read-only); unset = no VM runs')
    p.add_argument('--vm-template', default='ai-arch-dev', help='libvirt domain whose definition VM runs start from (never modified)')
    p.add_argument('--vm-uri', default='qemu:///system')
    p.add_argument('--vm-ssh-key', type=Path, default=None,
                   help="Private key authorized for the baseline's admin user (default: ~/.ssh/ai-arch-dev_ed25519, else ~/.ssh/id_ed25519)")
    p.add_argument('--vm-user', default='archdev', help="The baseline's admin user (sudo) used only to provision each clone")
    p.add_argument('--vm-opencode', type=Path, default=None, help='OpenCode binary copied into VMs (default: the one on PATH)')
    p.add_argument('--vm-storage', type=Path, default=None,
                   help="folder for the clones' disks; QEMU must be able to reach it (default: agentcontrol-runs next to the baseline)")
    p.add_argument('--container-runtime', choices=('podman', 'docker'), default=None, help='Container runtime for isolated runs (default: whichever is found)')
    p.add_argument('--allow-rootful-containers', action='store_true',
                   help='Allow agent containers on a root-owned Docker daemon (not recommended; use rootless Docker or Podman)')
    p.add_argument('--build-agent-image', action='store_true', help='Build the agent container image, then exit')
    p.add_argument('--opencode-binary', type=Path, default=None, help='OpenCode binary to put in the agent image (default: the one on PATH)')
    p.add_argument('--models', type=Path, default=None, help='Model registry JSON (default: state/models.json; an ai-arch.json also works)')
    p.add_argument('--gateway-port', type=int, default=int(os.environ.get('AGENTCONTROL_GATEWAY_PORT', '0')),
                   help='Serve the local model gateway on this loopback port (0 = off)')
    p.add_argument('--preview-idle-minutes', type=float, default=30, help='Stop an unused preview after this many minutes')
    p.add_argument('--projects-root', type=Path, default=None,
                   help='Folder the dashboard may browse and create projects in (default: your home folder)')
    a = p.parse_args()
    if a.jev_key and jev_api.key_ref_problem(a.jev_key):
        p.error(jev_api.key_ref_problem(a.jev_key))
    if not 0.5 <= a.jev_stuck_threshold < 1:
        p.error('--jev-stuck-threshold must be at least 0.5 and below 1')
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
                 preview_idle=max(0, a.preview_idle_minutes) * 60, models=a.models,
                 skills_library=a.skills_library, container_runtime=a.container_runtime,
                 allow_rootful_containers=a.allow_rootful_containers,
                 research_toolsets=tuple(t.strip() for t in a.research_toolsets.split(',') if t.strip()),
                 jev_key_ref=a.jev_key, jev_threshold=a.jev_stuck_threshold, **({'jev_model': a.jev_model} if a.jev_model else {}),
                 max_parallel_agents=a.max_parallel_agents, hermes_provider=a.hermes_provider,
                 vm_baseline=a.vm_baseline.expanduser() if a.vm_baseline else None, vm_template=a.vm_template, vm_uri=a.vm_uri,
                 vm_ssh_key=a.vm_ssh_key.expanduser() if a.vm_ssh_key else None, vm_user=a.vm_user, vm_opencode=a.vm_opencode,
                 vm_storage=a.vm_storage.expanduser() if a.vm_storage else None,
                 projects_root=a.projects_root.expanduser() if a.projects_root else None)
    if a.build_agent_image:
        return build_agent_image(a)
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
    gateway_server = None
    if a.gateway_port:
        try:
            gateway_server = gateway.serve(controller.broker, controller.store.usage_add, lambda: active_run(controller), a.gateway_port,
                                           authorize=controller.authorize_paid)
            controller.gateway_info = {'port': gateway_server.server_port, 'url': f'http://127.0.0.1:{gateway_server.server_port}/agent/<name>/v1'}
            threading.Thread(target=gateway_server.serve_forever, daemon=True).start()
        except OSError as exc:
            print(f'Model gateway disabled: cannot bind 127.0.0.1:{a.gateway_port}: {exc}.')
    print(f'Model gateway: {controller.gateway_info["url"] if gateway_server else "off"}', flush=True)
    print(f'AgentControl: http://{a.host}:{server.server_port}\nProject: {controller.s.project}\nOpenCode: {a.opencode}\nHermes profile: {a.profile or "current"}\nLive preview port: {controller.preview.listen_port or "off"}\nDashboard key: {key}', flush=True)
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
        if gateway_server:
            gateway_server.shutdown()
        for run_gateway in list(controller.run_gateways.values()):
            run_gateway.shutdown()
        for machine in list(controller.vms.values()):
            machine.close_tunnel()   # VMs keep running; Resume reconnects
        server.server_close()
        for thread in list(controller.threads.values()):
            thread.join(timeout=5)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
