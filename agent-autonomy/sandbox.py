"""Agent containers (M10): a run's agents work inside one container instead of on your host.

The container runs an OpenCode server (via container/bridge.py) for all of the run's agents.
It has no network while agents work: AgentControl reaches OpenCode, and OpenCode reaches the
model server through AgentControl's gateway, over Unix sockets in a folder shared with the host.
It is created with every capability dropped, no-new-privileges, a read-only root filesystem,
process/CPU/memory limits, and only the run's worktrees (read-write) and the repository's
.git (read-only) mounted, at the same paths as on the host.

Rootless Docker or Podman is required; a root-owned daemon is refused unless you override it.
Everything goes through the docker/podman command line. Standard library only.
"""
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import time

from proc import process

HERE = Path(__file__).resolve().parent
BRIDGE = HERE / 'container' / 'bridge.py'
DOCKERFILE = HERE / 'container' / 'Dockerfile'
IMAGE = 'agentcontrol-agent:1'
INSIDE = '/agentcontrol'           # fixed paths inside the container
HOME = INSIDE + '/home'
SOCKETS = INSIDE + '/sock'
OPENCODE_PORT, MODEL_PORT = 4096, 8080
NETWORKS = ('setup', 'none', 'internet')
DEFAULT_PERMISSION = {'edit': 'ask', 'bash': 'ask', 'webfetch': 'ask', 'external_directory': 'ask', 'doom_loop': 'ask'}


class SandboxError(RuntimeError):
    pass


def run_cli(argv, timeout=60):
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
    except FileNotFoundError as exc:
        raise SandboxError(f'{argv[0]} is not installed') from exc
    except subprocess.TimeoutExpired as exc:
        raise SandboxError(f'{argv[0]} {argv[1]} timed out') from exc
    return result.returncode, result.stdout.strip(), result.stderr.strip()


def detect(prefer=None, image=IMAGE, runner=run_cli):
    """Which runtime is usable, whether it is rootless, and whether the agent image exists."""
    found = {'runtime': None, 'rootless': False, 'version': '', 'image': False, 'error': ''}
    for cli in ([prefer] if prefer else ['podman', 'docker']):
        if not shutil.which(cli) and runner is run_cli:
            continue
        try:
            if cli == 'podman':
                code, out, err = runner([cli, 'info', '--format', '{{.Host.Security.Rootless}}|{{.Version.Version}}'])
                if code:
                    raise SandboxError(err or out)
                rootless, version = (out.split('|') + [''])[:2]
                rootless = rootless.strip().lower() == 'true'
            else:
                code, out, err = runner([cli, 'info', '--format', '{{json .SecurityOptions}}|{{.ServerVersion}}'])
                if code:
                    raise SandboxError(err or out)
                options, version = (out.split('|', 1) + [''])[:2]
                rootless = 'rootless' in options
        except SandboxError as exc:
            found['error'] = f'{cli}: {str(exc)[-300:]}'
            continue
        code, _, _ = runner([cli, 'image', 'inspect', image])
        return {'runtime': cli, 'rootless': rootless, 'version': version.strip(), 'image': code == 0, 'error': ''}
    if not found['error']:
        found['error'] = 'Neither podman nor docker is installed'
    return found


def usable(info, allow_rootful=False):
    """'' when containers can be used, else the reason."""
    if not info.get('runtime'):
        return info.get('error') or 'No container runtime found'
    if not info.get('rootless') and not allow_rootful:
        return (f"{info['runtime']} runs as root on this machine. Agent containers need rootless Docker or Podman "
                '(see the README), or start AgentControl with --allow-rootful-containers.')
    if not info.get('image'):
        return f'The agent image {IMAGE} is not built yet. Run: python3 agent-autonomy/app.py --build-agent-image'
    return ''


def build_command(runtime, opencode_binary, image=IMAGE):
    """The image build command, run only when you ask for it."""
    return [runtime, 'build', '-t', image, '-f', str(DOCKERFILE), '--build-arg', f'OPENCODE={Path(opencode_binary).name}',
            str(Path(opencode_binary).parent)]


def sockets_dir(data, run_id):
    """Where the run's sockets live. Unix socket paths are limited to about 100 characters,
    so a long state path falls back to a short private folder under /tmp."""
    preferred = Path(data) / 'containers' / run_id / 'sock'
    if len(str(preferred / 'model.sock')) < 100:
        return preferred
    return Path('/tmp') / f'agentcontrol-{os.getuid()}' / run_id


def opencode_config(model, permission=None, extra_models=()):
    """OpenCode inside the container: our relay as its only model provider, and your host
    permission rules (or 'ask' for everything that changes things). Never more than your host allows.
    `extra_models` are endpoint ids a run may pick per role (M12); the gateway routes them and enforces caps."""
    rules = dict(DEFAULT_PERMISSION)
    if isinstance(permission, dict):
        rules.update(permission)
    elif isinstance(permission, str):
        rules = permission
    return {'provider': {'agentcontrol': {'npm': '@ai-sdk/openai-compatible', 'name': 'AgentControl',
                                          'options': {'baseURL': f'http://127.0.0.1:{MODEL_PORT}/agent/opencode/v1', 'apiKey': 'none'},
                                          'models': {m: {'name': m, 'tool_call': True} for m in [model, *extra_models]}}},
            'model': f'agentcontrol/{model}', 'small_model': f'agentcontrol/{model}', 'permission': rules,
            'autoupdate': False, 'share': 'disabled'}


def host_permission(path=None):
    """The permission block of your own OpenCode config, if it has one."""
    for candidate in ([Path(path)] if path else [Path.home() / '.config' / 'opencode' / 'opencode.json',
                                                 Path.home() / '.config' / 'opencode' / 'opencode.jsonc']):
        try:
            text = candidate.read_text()
        except OSError:
            continue
        try:
            return json.loads(text).get('permission')
        except (json.JSONDecodeError, AttributeError):
            return None
    return None


def create_args(runtime, name, spec):
    """Every flag of the container, in one place (tested). spec: image, cpus, memory_gb, network,
    run_root, git_dir, home, config, sockets, workdir, rootless, uid, gid."""
    net = 'none' if spec['network'] == 'none' else ('podman' if runtime == 'podman' else 'bridge')
    args = [runtime, 'create', '--name', name, '--init', '--label', 'agentcontrol=1',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '--pids-limit', '512', '--cpus', str(spec['cpus']), '--memory', f"{spec['memory_gb']}g",
            '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=1g', '--network', net,
            '-v', f"{spec['run_root']}:{spec['run_root']}:rw",
            '-v', f"{spec['git_dir']}:{spec['git_dir']}:ro",
            '-v', f"{spec['home']}:{HOME}:rw",
            '-v', f"{spec['config']}:{HOME}/.config/opencode/opencode.json:ro",
            '-v', f"{BRIDGE}:{INSIDE}/bridge.py:ro",
            '-v', f"{spec['sockets']}:{SOCKETS}:rw",
            '-e', f'HOME={HOME}', '-e', f'XDG_CONFIG_HOME={HOME}/.config', '-e', f'XDG_DATA_HOME={HOME}/.local/share',
            '-e', f'XDG_CACHE_HOME={HOME}/.cache', '-e', 'OPENCODE_DISABLE_AUTOUPDATE=1',
            '-w', spec['workdir']]
    if runtime == 'podman':
        args += ['--userns=keep-id']
    elif not spec.get('rootless'):
        args += ['--user', f"{spec['uid']}:{spec['gid']}"]  # rootful override: never root inside
    args += [spec['image'], 'python3', f'{INSIDE}/bridge.py', 'serve', spec['workdir'], SOCKETS, str(OPENCODE_PORT), str(MODEL_PORT)]
    return args


class Sandbox:
    def __init__(self, runtime, runner=run_cli):
        self.runtime = runtime
        self.runner = runner

    def _cli(self, *args, timeout=60, check=True):
        code, out, err = self.runner([self.runtime] + list(args), timeout)
        if check and code:
            raise SandboxError(f"{self.runtime} {args[0]} failed: {(err or out)[-500:]}")
        return out

    def state(self, name):
        code, out, _ = self.runner([self.runtime, 'inspect', '--format', '{{.State.Status}}', name], 30)
        return out.strip() if code == 0 else 'missing'

    def create(self, name, spec):
        code, out, err = self.runner(create_args(self.runtime, name, spec), 120)
        if code:
            raise SandboxError(f'Could not create the container: {(err or out)[-600:]}')

    def start(self, name):
        self._cli('start', name)

    def stop(self, name):
        self._cli('stop', '-t', '10', name, timeout=60, check=False)

    def remove(self, name):
        self._cli('rm', '-f', name, check=False)

    def disconnect(self, name):
        net = 'podman' if self.runtime == 'podman' else 'bridge'
        self._cli('network', 'disconnect', net, name)

    def networks(self, name):
        code, out, _ = self.runner([self.runtime, 'inspect', '--format', '{{json .NetworkSettings.Networks}}', name], 30)
        try:
            return sorted(json.loads(out)) if code == 0 and out and out != 'null' else []
        except json.JSONDecodeError:
            return []

    def exec_argv(self, name, argv, cwd):
        return [self.runtime, 'exec', '-w', str(cwd), name] + list(argv)

    def exec(self, name, argv, cwd, timeout, cancel=lambda: False):
        return process(self.exec_argv(name, argv, cwd), cwd if Path(cwd).exists() else HERE, timeout, cancel)

    def wait_ready(self, name, sockets, timeout=120):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if (Path(sockets) / 'ready').exists() and (Path(sockets) / 'api.sock').exists():
                return True
            if self.state(name) not in ('running', 'created'):
                code, out, err = self.runner([self.runtime, 'logs', '--tail', '30', name], 30)
                raise SandboxError(f'The container stopped while starting: {(out or err)[-800:]}')
            time.sleep(.3)
        raise SandboxError('OpenCode did not start inside the container within two minutes')


class UnixHTTPConnection(http.client.HTTPConnection):
    """HTTP over a Unix socket (OpenCode in a run container, and web previews running there)."""

    def __init__(self, path, timeout=20):
        super().__init__('localhost', timeout=timeout)
        self.socket_path = str(path)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.socket_path)


PREVIEW_MARK = 'AGENTCONTROL_PREVIEW=1'


class ContainerRunner:
    """Runs a run's live preview inside its container (CLI, desktop, web). Processes are marked
    with AGENTCONTROL_PREVIEW=1 so stopping the preview never touches the agents' OpenCode server."""

    display = ':90'

    def __init__(self, runtime, name, sockets):
        self.runtime, self.name, self.sockets = runtime, name, Path(sockets)
        self.preview_socket = self.sockets / 'preview.sock'

    def wrap(self, argv, cwd, env=None, tty=False, detach=False):
        args = [self.runtime, 'exec', '-i'] + (['-t'] if tty else []) + (['-d'] if detach else []) + ['-w', str(cwd)]
        for key, value in {'AGENTCONTROL_PREVIEW': '1', **(env or {})}.items():
            args += ['-e', f'{key}={value}']
        return args + [self.name] + list(argv)

    def run(self, argv, env=None, timeout=10):
        return subprocess.run(self.wrap(argv, '/', env), capture_output=True, timeout=timeout, check=False, stdin=subprocess.DEVNULL)

    def exists(self, path):
        return self.run(['test', '-e', path]).returncode == 0

    def port_open(self, port):
        probe = f"import socket; socket.create_connection(('127.0.0.1', {int(port)}), timeout=.5)"
        return self.run(['python3', '-c', probe]).returncode == 0

    def start_relay(self, port):
        if self.preview_socket.exists():
            self.preview_socket.unlink()
        subprocess.run(self.wrap(['python3', f'{INSIDE}/bridge.py', 'relay', str(int(port)), f'{SOCKETS}/preview.sock'], '/', detach=True),
                       capture_output=True, timeout=15, check=False, stdin=subprocess.DEVNULL)
        deadline = time.monotonic() + 5
        while not self.preview_socket.exists() and time.monotonic() < deadline:
            time.sleep(.05)

    def kill(self):
        script = (f"for p in /proc/[0-9]*; do tr '\\0' '\\n' < $p/environ 2>/dev/null | grep -qx '{PREVIEW_MARK}' "
                  "&& [ ${p#/proc/} != $$ ] && kill -TERM ${p#/proc/} 2>/dev/null; done; true")
        subprocess.run([self.runtime, 'exec', self.name, 'sh', '-c', script], capture_output=True, timeout=15, check=False,
                       stdin=subprocess.DEVNULL)
