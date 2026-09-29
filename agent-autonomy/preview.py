"""Live project preview: runs the user's saved preview command and shows it safely.

Four modes:
  web      run a dev server on 127.0.0.1:<port>; AgentControl proxies it on a separate origin
  static   serve a folder or HTML file from the project; nothing is executed
  cli      run a program in a pseudo-terminal; the dashboard sends keystrokes and reads output
  desktop  run a GUI program inside Xvfb; the dashboard shows screenshots and forwards input

Commands only come from what the user saved on a run. They are argv lists (no shell),
run in the project folder, and live in their own process group so Stop ends everything.
"""
import errno
import fcntl
import html
import http.client
import mimetypes
import os
from pathlib import Path
import pty
import secrets
import shlex
import shutil
import signal
import socket
import struct
import subprocess
import termios
import threading
import time
import urllib.parse

from sandbox import UnixHTTPConnection

MODES = ('web', 'static', 'cli', 'desktop')
DESKTOP_TOOLS = ('Xvfb', 'xdotool', 'import')
BUFFER_LIMIT = 200_000
SECRET_WORDS = ('credential', 'secret', 'private_key', 'auth.json', '.env')
DESKTOP_KEYS = {'Return', 'Escape', 'Tab', 'BackSpace', 'Delete', 'Up', 'Down', 'Left', 'Right', 'Home', 'End',
                'Page_Up', 'Page_Down', 'space', 'ctrl+c', 'ctrl+v', 'ctrl+a', 'ctrl+z', 'alt+F4', 'F5', 'F11'}
HOP_HEADERS = {'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers',
               'transfer-encoding', 'upgrade', 'content-length', 'host'}


def validate_spec(spec, project):
    """Normalize a saved preview spec, or return None when no preview is configured."""
    if spec in (None, '', {}):
        return None
    if not isinstance(spec, dict):
        raise ValueError('Preview settings must be an object')
    mode = spec.get('mode') or 'none'
    if mode == 'none':
        return None
    if mode not in MODES:
        raise ValueError('Preview mode must be web, static, cli, or desktop')
    result = {'mode': mode}
    command = spec.get('command') or ''
    if not isinstance(command, str) or len(command) > 2000:
        raise ValueError('Preview command must be text of at most 2,000 characters')
    if mode != 'static':
        try:
            argv = shlex.split(command)
        except ValueError as exc:
            raise ValueError(f'Preview command could not be parsed: {exc}')
        if not argv:
            raise ValueError('Enter the command that starts the preview')
        result.update(command=command.strip(), argv=argv)
    if mode == 'cli':
        args = spec.get('args') or ''
        if not isinstance(args, str) or len(args) > 1000:
            raise ValueError('Preview arguments must be text of at most 1,000 characters')
        try:
            result['argv'] = argv + shlex.split(args)
        except ValueError as exc:
            raise ValueError(f'Preview arguments could not be parsed: {exc}')
        if args.strip():
            result['args'] = args.strip()
    if mode == 'web':
        port = spec.get('port')
        if type(port) is not int or not 1024 <= port <= 65535:
            raise ValueError('Web preview port must be a number from 1024 to 65535')
        result['port'] = port
    if mode == 'static':
        raw = spec.get('path') or '.'
        if not isinstance(raw, str) or len(raw) > 500 or Path(raw).is_absolute():
            raise ValueError('Static preview path must be a folder or file inside the project')
        root = Path(project).resolve()
        target = (root / raw).resolve()
        if target != root and root not in target.parents:
            raise ValueError('Static preview path must stay inside the project')
        result['path'] = raw.strip() or '.'
    if mode == 'desktop':
        width, height = spec.get('width', 1280), spec.get('height', 800)
        if type(width) is not int or type(height) is not int or not (320 <= width <= 3840 and 240 <= height <= 2160):
            raise ValueError('Desktop screen size must be between 320×240 and 3840×2160')
        result.update(width=width, height=height)
    return result


def _port_open(port):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=.5):
            return True
    except OSError:
        return False


def desktop_missing():
    return [tool for tool in DESKTOP_TOOLS if not shutil.which(tool)]


def _kill_group(proc, grace=3.0):
    if not proc or proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return
    try:
        proc.wait(grace)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait(2)


class PreviewManager:
    def __init__(self, project, idle_seconds=1800, clock=time.monotonic):
        self.project = Path(project).resolve()
        self.cwd = self.project  # where the current preview runs: the project, or a run's integration worktree (M6)
        self.runner = None       # set when the preview runs inside the run's container (M10)
        self.idle_seconds = idle_seconds
        self.clock = clock
        self.lock = threading.RLock()
        self.listen_port = None
        self.on_change = None  # optional callback when the preview state changes (live dashboard updates)
        self.generation = 0
        self.proc = self.xvfb = None
        self.master = None
        self.display = None
        self.spec = None
        self.run = ''
        self.state = 'idle'
        self.started = None
        self.exit_code = None
        self.error = ''
        self.buffer = bytearray()
        self.offset = 0
        self.tickets = {}
        self.sessions = {}
        self.last_activity = clock()
        self.closed = threading.Event()
        threading.Thread(target=self._idle_watch, daemon=True).start()

    @property
    def state(self):
        return self._state

    @state.setter
    def state(self, value):
        changed = getattr(self, '_state', None) != value
        self._state = value
        if changed and self.on_change:
            try:
                self.on_change()
            except Exception:
                pass

    # ---- lifecycle -------------------------------------------------------
    def start(self, run, spec, cwd=None, runner=None):
        cwd = Path(cwd).resolve() if cwd else self.project
        spec = validate_spec(spec, cwd)
        if not spec:
            raise ValueError('This run has no preview configured')
        if spec['mode'] == 'desktop' and desktop_missing():
            raise ValueError('Desktop preview needs ' + ', '.join(desktop_missing()) + ' installed on the server')
        with self.lock:
            self.stop()
            self.generation += 1
            generation = self.generation
            self.spec, self.run, self.error, self.exit_code = spec, run, '', None
            self.cwd = cwd
            self.runner = runner
            self.buffer, self.offset = bytearray(), 0
            self.started = time.time()
            self.touch()
            mode = spec['mode']
            if mode == 'static':
                self.state = 'running'
                self._log(f'Serving {spec["path"]} from {"the project folder" if cwd == self.project else "the run branch (" + str(cwd) + ")"}.\n')
                return self.status()
            self.state = 'starting'
            env = {**os.environ, 'AGENTCONTROL_PREVIEW': '1'}
            try:
                if mode == 'cli':
                    self._start_cli(env, generation)
                elif mode == 'web':
                    if self._port_open(spec['port']):
                        self.state = 'failed'
                        self.error = (f'Port {spec["port"]} is already in use, so the preview would show some other program. '
                                      'Stop whatever is using it (perhaps an earlier preview) or choose another port.')
                        return self.status()
                    env.update(PORT=str(spec['port']), HOST='127.0.0.1')
                    if runner:
                        runner.start_relay(spec['port'])
                    self._start_piped(env, generation)
                    threading.Thread(target=self._wait_for_port, args=(generation,), daemon=True).start()
                else:
                    self._start_desktop(env, generation)
            except OSError as exc:
                self.state, self.error = 'failed', f'Could not start the preview: {exc}'
                self._kill_all()
                return self.status()
            if mode != 'web':
                self.state = 'running'
            self._log(f'$ {spec["command"]}{" " + spec["args"] if spec.get("args") else ""}'
                      f'{"   (inside the run container)" if runner else ""}\n')
        return self.status()

    def _start_cli(self, env, generation):
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 100, 0, 0))
        env.update(TERM='dumb', COLUMNS='100', LINES='32', PYTHONUNBUFFERED='1')
        try:
            argv, cwd = self._argv(env, tty=True)
            self.proc = subprocess.Popen(argv, cwd=cwd, stdin=slave, stdout=slave, stderr=slave,
                                         env=env, start_new_session=True, close_fds=True)
        finally:
            os.close(slave)
        self.master = master
        threading.Thread(target=self._read_fd, args=(master, generation), daemon=True).start()
        threading.Thread(target=self._wait_exit, args=(self.proc, generation), daemon=True).start()

    def _start_piped(self, env, generation):
        argv, cwd = self._argv(env)
        self.proc = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                     stderr=subprocess.STDOUT, env=env, start_new_session=True, close_fds=True)
        threading.Thread(target=self._read_fd, args=(self.proc.stdout.fileno(), generation), daemon=True).start()
        threading.Thread(target=self._wait_exit, args=(self.proc, generation), daemon=True).start()

    def _argv(self, env, tty=False):
        """The command and host working folder; inside the container only the preview's own variables are passed."""
        if not self.runner:
            return self.spec['argv'], self.cwd
        keys = ('PORT', 'HOST', 'DISPLAY', 'TERM', 'COLUMNS', 'LINES', 'PYTHONUNBUFFERED')
        return self.runner.wrap(self.spec['argv'], self.cwd, {k: env[k] for k in keys if k in env}, tty=tty), Path(__file__).resolve().parent

    def _port_open(self, port):
        return self.runner.port_open(port) if self.runner else _port_open(port)

    def _start_desktop(self, env, generation):
        if self.runner:
            return self._start_container_desktop(env, generation)
        display = next((n for n in range(90, 190) if not Path(f'/tmp/.X11-unix/X{n}').exists() and not Path(f'/tmp/.X{n}-lock').exists()), None)
        if display is None:
            raise OSError('no free X display number')
        size = f'{self.spec["width"]}x{self.spec["height"]}x24'
        self.xvfb = subprocess.Popen(['Xvfb', f':{display}', '-screen', '0', size, '-nolisten', 'tcp'], stdin=subprocess.DEVNULL,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        socket_path = Path(f'/tmp/.X11-unix/X{display}')
        deadline = time.monotonic() + 10
        while not socket_path.exists():
            if self.xvfb.poll() is not None or time.monotonic() > deadline:
                raise OSError('the virtual display (Xvfb) did not start')
            time.sleep(.05)
        self.display = f':{display}'
        env['DISPLAY'] = self.display
        self._start_piped(env, generation)

    def _start_container_desktop(self, env, generation):
        size = f'{self.spec["width"]}x{self.spec["height"]}x24'
        display = self.runner.display
        self.xvfb = subprocess.Popen(self.runner.wrap(['Xvfb', display, '-screen', '0', size, '-nolisten', 'tcp'], '/'),
                                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        deadline = time.monotonic() + 15
        while not self.runner.exists(f'/tmp/.X11-unix/X{display[1:]}'):
            if self.xvfb.poll() is not None or time.monotonic() > deadline:
                raise OSError('the virtual display (Xvfb) did not start in the container')
            time.sleep(.2)
        self.display = display
        env['DISPLAY'] = display
        self._start_piped(env, generation)

    def stop(self):
        with self.lock:
            was = self.state
            self.generation += 1
            self._kill_all()
            if was in ('starting', 'running'):
                self.state = 'idle'
                self._log('\n[preview stopped]\n')
        return self.status()

    def _kill_all(self):
        if self.runner:
            # Stopping `docker exec` does not stop the program inside; end the marked preview processes there.
            self.runner.kill()
        _kill_group(self.proc)
        _kill_group(self.xvfb)
        if self.proc and self.proc.stdout:
            self.proc.stdout.close()
        if self.master is not None:
            try:
                os.close(self.master)
            except OSError:
                pass
        self.proc = self.xvfb = self.master = self.display = None

    def close(self):
        self.closed.set()
        self.stop()

    def restart(self, run=None, spec=None):
        return self.start(run or self.run, spec or self.spec)

    # ---- background threads ----------------------------------------------
    def _read_fd(self, fd, generation):
        while True:
            try:
                chunk = os.read(fd, 4096)
            except OSError as exc:
                if exc.errno in (errno.EIO, errno.EBADF):
                    return
                raise
            if not chunk:
                return
            with self.lock:
                if generation != self.generation:
                    return
                self._append(chunk)

    def _wait_exit(self, proc, generation):
        code = proc.wait()
        with self.lock:
            if generation != self.generation:
                return
            self.exit_code = code
            self.state = 'exited' if code == 0 or self.spec['mode'] == 'cli' else 'failed'
            if self.state == 'failed' and not self.error:
                self.error = f'The preview command exited with status {code}. See the process log.'
            self._log(f'\n[process exited with status {code}]\n')
            _kill_group(self.xvfb)
            self.xvfb = None

    def _wait_for_port(self, generation):
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            with self.lock:
                if generation != self.generation or self.state != 'starting':
                    return
            if not self._port_open(self.spec['port']):
                time.sleep(.25)
                continue
            with self.lock:
                if generation == self.generation and self.state == 'starting':
                    self.state = 'running'
                    self._log(f'[listening on port {self.spec["port"]}]\n')
            return
        with self.lock:
            if generation == self.generation and self.state == 'starting':
                self.state, self.error = 'failed', f'Nothing answered on port {self.spec["port"]} within 60 seconds.'
                self._kill_all()

    def _idle_watch(self):
        while not self.closed.wait(15):
            self.check_idle()

    def check_idle(self):
        """Stop a preview nobody has looked at for idle_seconds. Returns True when it stopped one."""
        with self.lock:
            idle = self.clock() - self.last_activity
            if self.state in ('starting', 'running') and self.idle_seconds and idle > self.idle_seconds:
                self.stop()
                self.error = f'Stopped after {round(self.idle_seconds / 60)} idle minutes. Start it again when you need it.'
                return True
        return False

    # ---- output and input --------------------------------------------------
    def _append(self, chunk):
        self.buffer += chunk
        self.offset += len(chunk)
        if len(self.buffer) > BUFFER_LIMIT:
            del self.buffer[:len(self.buffer) - BUFFER_LIMIT]

    def _log(self, text):
        self._append(text.encode())

    def touch(self):
        self.last_activity = self.clock()

    def output(self, since=0):
        with self.lock:
            self.touch()
            start = self.offset - len(self.buffer)
            since = max(start, min(int(since), self.offset))
            data = bytes(self.buffer[since - start:])
            return {'offset': self.offset, 'from': since, 'truncated': since == start and start > 0,
                    'text': data.decode('utf-8', 'replace'), 'status': self.status()}

    def send_input(self, text):
        if not isinstance(text, str) or len(text) > 4000:
            raise ValueError('Input must be text of at most 4,000 characters')
        with self.lock:
            if not self.spec or self.spec['mode'] != 'cli' or self.state != 'running' or self.master is None:
                raise ValueError('The command-line preview is not running')
            self.touch()
            os.write(self.master, text.encode())

    def _desktop(self, *args):
        with self.lock:
            if not self.spec or self.spec['mode'] != 'desktop' or not self.display:
                raise ValueError('The desktop preview is not running')
            self.touch()
            env = {**os.environ, 'DISPLAY': self.display}
            runner = self.runner
        if runner:
            return runner.run(list(args), {'DISPLAY': self.display})
        return subprocess.run(args, env=env, capture_output=True, timeout=10, check=False)

    def click(self, x, y, button=1):
        if not all(type(v) is int for v in (x, y, button)) or button not in (1, 2, 3) or x < 0 or y < 0:
            raise ValueError('Click needs whole-number coordinates and button 1, 2, or 3')
        x, y = min(x, self.spec['width'] - 1), min(y, self.spec['height'] - 1)
        self._desktop('xdotool', 'mousemove', '--sync', str(x), str(y), 'click', str(button))

    def type_text(self, text):
        if not isinstance(text, str) or not 1 <= len(text) <= 1000:
            raise ValueError('Typed text must be 1–1,000 characters')
        self._desktop('xdotool', 'type', '--delay', '15', '--', text)

    def key(self, name):
        if name not in DESKTOP_KEYS:
            raise ValueError('That key is not supported')
        self._desktop('xdotool', 'key', name)

    def frame(self):
        result = self._desktop('import', '-silent', '-window', 'root', 'png:-')
        if result.returncode != 0 or not result.stdout:
            raise ValueError('Could not capture the virtual display')
        return result.stdout

    def status(self):
        with self.lock:
            spec = self.spec or {}
            return {'state': self.state, 'run': self.run, 'mode': spec.get('mode'), 'command': spec.get('command', ''), 'args': spec.get('args', ''),
                    'port': spec.get('port'), 'path': spec.get('path'), 'width': spec.get('width'), 'height': spec.get('height'),
                    'started': self.started, 'exit_code': self.exit_code, 'error': self.error, 'offset': self.offset,
                    'listen_port': self.listen_port, 'cwd': str(self.cwd) if self.cwd != self.project else '', 'pid': self.proc.pid if self.proc and self.proc.poll() is None else None}

    # ---- preview origin: tickets, sessions, static files, web proxy --------
    def issue_ticket(self):
        with self.lock:
            now = time.time()
            self.tickets = {t: exp for t, exp in self.tickets.items() if exp > now}
            ticket = secrets.token_urlsafe(24)
            self.tickets[ticket] = now + 60
            return ticket

    def redeem(self, ticket):
        with self.lock:
            expiry = self.tickets.pop(ticket or '', 0)
            if expiry < time.time():
                return None
            token = secrets.token_urlsafe(32)
            now = time.time()
            self.sessions = {t: exp for t, exp in self.sessions.items() if exp > now}
            self.sessions[token] = now + 12 * 3600
            return token

    def session_ok(self, cookie_header):
        cookies = dict(part.strip().split('=', 1) for part in (cookie_header or '').split(';') if '=' in part)
        token = cookies.get('ac_preview', '')
        with self.lock:
            return bool(token) and self.sessions.get(token, 0) > time.time()

    def serve(self, handler, dashboard_port):
        """Answer one request on the preview listener (a separate origin from the dashboard)."""
        url = urllib.parse.urlsplit(handler.path)
        host = (handler.headers.get('Host') or '127.0.0.1').rsplit(':', 1)[0]
        ancestors = f"frame-ancestors http://{host}:{dashboard_port} https://{host}:{dashboard_port}"
        if url.path == '/__ac/enter':
            token = self.redeem(urllib.parse.parse_qs(url.query).get('ticket', [''])[0])
            if not token:
                return self._page(handler, 403, 'This preview link expired. Open the preview again from AgentControl.', ancestors)
            handler.send_response(302)
            handler.send_header('Location', '/')
            handler.send_header('Set-Cookie', f'ac_preview={token}; Path=/; HttpOnly; SameSite=Strict')
            handler.send_header('Content-Security-Policy', ancestors)
            handler.send_header('Content-Length', '0')
            handler.end_headers()
            return
        if not self.session_ok(handler.headers.get('Cookie')):
            return self._page(handler, 401, 'Open this preview from the AgentControl Project tab.', ancestors)
        with self.lock:
            spec, state = self.spec, self.state
            self.touch()
        if not spec or state not in ('running', 'starting') or spec['mode'] not in ('web', 'static'):
            return self._page(handler, 503, 'No web or static preview is running. Start one from the Project tab.', ancestors)
        if spec['mode'] == 'static':
            return self._static(handler, spec, url.path, ancestors)
        return self._proxy(handler, spec, ancestors)

    def _page(self, handler, code, message, ancestors):
        body = f'<!doctype html><meta charset="utf-8"><title>Preview</title><body style="font:15px system-ui;padding:24px">{html.escape(message)}</body>'.encode()
        handler.send_response(code)
        handler.send_header('Content-Type', 'text/html; charset=utf-8')
        handler.send_header('Content-Length', str(len(body)))
        handler.send_header('Content-Security-Policy', ancestors)
        handler.send_header('Cache-Control', 'no-store')
        handler.end_headers()
        if handler.command != 'HEAD':
            handler.wfile.write(body)

    def _static(self, handler, spec, path, ancestors):
        base = (self.cwd / spec['path'])
        root, index = (base.parent, base.name) if base.is_file() else (base, 'index.html')
        relative = urllib.parse.unquote(path).lstrip('/')
        if not relative or relative.endswith('/'):
            relative += index
        parts = Path(relative).parts
        if any(p in ('..', '') or p.startswith('.') or any(w in p.lower() for w in SECRET_WORDS) for p in parts):
            return self._page(handler, 404, 'Not found.', ancestors)
        current = root
        for part in parts:
            current = current / part
            if current.is_symlink():
                return self._page(handler, 404, 'Not found.', ancestors)
        candidate = current.resolve()
        if candidate.is_dir():
            candidate = candidate / 'index.html'
        project_root = root.resolve()
        if project_root not in candidate.parents or not candidate.is_file() or candidate.stat().st_size > 20_000_000:
            return self._page(handler, 404, 'Not found.', ancestors)
        body = candidate.read_bytes()
        handler.send_response(200)
        handler.send_header('Content-Type', mimetypes.guess_type(candidate.name)[0] or 'application/octet-stream')
        handler.send_header('Content-Length', str(len(body)))
        handler.send_header('Content-Security-Policy', ancestors)
        handler.send_header('Cache-Control', 'no-store')
        handler.end_headers()
        if handler.command != 'HEAD':
            handler.wfile.write(body)

    def _proxy(self, handler, spec, ancestors):
        length = int(handler.headers.get('Content-Length') or 0)
        body = handler.rfile.read(length) if 0 < length <= 50_000_000 else None
        headers = {k: v for k, v in handler.headers.items() if k.lower() not in HOP_HEADERS}
        cookies = [c.strip() for c in headers.pop('Cookie', headers.pop('cookie', '')).split(';') if c.strip() and not c.strip().startswith('ac_preview=')]
        if cookies:
            headers['Cookie'] = '; '.join(cookies)
        headers['Host'] = f'127.0.0.1:{spec["port"]}'
        connection = (UnixHTTPConnection(self.runner.preview_socket, timeout=60) if self.runner
                      else http.client.HTTPConnection('127.0.0.1', spec['port'], timeout=60))
        try:
            connection.request(handler.command, handler.path, body=body, headers=headers)
            response = connection.getresponse()
            payload = response.read()
        except OSError as exc:
            return self._page(handler, 502, f'The preview server did not respond: {exc}', ancestors)
        finally:
            connection.close()
        handler.send_response(response.status, response.reason)
        origin = f'http://127.0.0.1:{spec["port"]}'
        for name, value in response.getheaders():
            low = name.lower()
            if low in HOP_HEADERS or low == 'x-frame-options':
                continue
            if low == 'content-security-policy':
                value = '; '.join(d for d in value.split(';') if not d.strip().lower().startswith('frame-ancestors'))
                if not value.strip():
                    continue
            if low == 'location' and value.startswith(origin):
                value = value[len(origin):] or '/'
            handler.send_header(name, value)
        handler.send_header('Content-Security-Policy', ancestors)
        handler.send_header('Content-Length', str(len(payload)))
        handler.end_headers()
        if handler.command != 'HEAD':
            handler.wfile.write(payload)
