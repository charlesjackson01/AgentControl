"""Agent containers (M10): flags, runtime detection, lifecycle, network cut-off, and refusals."""
import json
import os
from pathlib import Path
import socketserver
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from adapters.opencode import OpenCode
from engine import Controller, Settings
import permissions
from proc import process
import sandbox
from test_team import FakeTeamAPI, FakeTeamManager
from test_workflow import complete
from test_workspaces import make_repo

SPEC = {'image': 'img', 'cpus': 2, 'memory_gb': 4, 'network': 'none', 'run_root': '/s/worktrees/r1', 'git_dir': '/repo/.git',
        'home': '/s/containers/r1/home', 'config': '/s/containers/r1/opencode.json', 'sockets': '/s/containers/r1/sock',
        'workdir': '/s/worktrees/r1/coder-1', 'rootless': True, 'uid': 1000, 'gid': 1000}


class FlagTests(unittest.TestCase):
    def test_container_is_locked_down(self):
        args = sandbox.create_args('docker', 'agentcontrol-r1', SPEC)
        joined = ' '.join(args)
        for flag in ('--cap-drop ALL', '--security-opt no-new-privileges', '--pids-limit 512', '--cpus 2', '--memory 4g',
                     '--read-only', '--network none', '--init'):
            self.assertIn(flag, joined)
        self.assertIn('/repo/.git:/repo/.git:ro', args)
        self.assertIn('/s/worktrees/r1:/s/worktrees/r1:rw', args)
        self.assertIn(f"/s/containers/r1/opencode.json:{sandbox.HOME}/.config/opencode/opencode.json:ro", args)
        self.assertFalse(any(a in ('-p', '--publish', '-P', '--privileged') or a.startswith('--publish') for a in args))
        self.assertNotIn('--user', args, 'rootless Docker maps container root to you')
        self.assertEqual(args[-7:-1], ['python3', f'{sandbox.INSIDE}/bridge.py', 'serve', '/s/worktrees/r1/coder-1', sandbox.SOCKETS, '4096'])

    def test_runtime_specific_user_mapping_and_setup_network(self):
        podman = sandbox.create_args('podman', 'n', {**SPEC, 'network': 'bridge'})
        self.assertIn('--userns=keep-id', podman)
        self.assertIn('podman', podman[podman.index('--network') + 1])
        rootful = sandbox.create_args('docker', 'n', {**SPEC, 'rootless': False})
        self.assertEqual(rootful[rootful.index('--user') + 1], '1000:1000', 'never root inside with a rootful daemon')

    def test_detect_and_usable(self):
        def fake(outputs):
            return lambda argv, timeout=60: outputs.get(argv[1], (1, '', 'missing'))
        rootless = sandbox.detect('docker', runner=fake({'info': (0, '["name=seccomp","name=rootless"]|29.0', ''), 'image': (0, '', '')}))
        self.assertEqual((rootless['runtime'], rootless['rootless'], rootless['image']), ('docker', True, True))
        self.assertEqual(sandbox.usable(rootless), '')
        rootful = sandbox.detect('docker', runner=fake({'info': (0, '["name=seccomp"]|29.0', ''), 'image': (0, '', '')}))
        self.assertIn('runs as root', sandbox.usable(rootful))
        self.assertEqual(sandbox.usable(rootful, allow_rootful=True), '')
        podman = sandbox.detect('podman', runner=fake({'info': (0, 'true|5.2', ''), 'image': (1, '', 'no image')}))
        self.assertEqual((podman['rootless'], podman['image']), (True, False))
        self.assertIn('--build-agent-image', sandbox.usable(podman))
        self.assertIn('podman', sandbox.detect('podman', runner=fake({}))['error'])

    def test_opencode_config_never_widens_your_permissions(self):
        default = sandbox.opencode_config('qwen')
        self.assertEqual(default['permission']['bash'], 'ask')
        self.assertEqual(default['model'], 'agentcontrol/qwen')
        self.assertIn(f':{sandbox.MODEL_PORT}/agent/opencode/v1', default['provider']['agentcontrol']['options']['baseURL'])
        mine = sandbox.opencode_config('qwen', {'edit': 'allow', 'bash': {'git status': 'allow', '*': 'ask'}})
        self.assertEqual((mine['permission']['edit'], mine['permission']['webfetch']), ('allow', 'ask'))
        with tempfile.TemporaryDirectory() as temp:
            cfg = Path(temp) / 'opencode.json'
            cfg.write_text(json.dumps({'permission': {'bash': 'deny'}}))
            self.assertEqual(sandbox.host_permission(cfg), {'bash': 'deny'})

    def test_long_state_paths_use_a_short_socket_folder(self):
        self.assertTrue(str(sandbox.sockets_dir('/s', 'r1')).startswith('/s/containers/r1'))
        long = '/very' + '/long' * 30
        self.assertTrue(str(sandbox.sockets_dir(long, 'r1')).startswith('/tmp/agentcontrol-'))

    def test_editing_agent_configuration_is_critical(self):
        for target in ('opencode.json', 'sub/opencode.jsonc', '.opencode/skills/x/SKILL.md'):
            with self.subTest(target):
                risk = permissions.classify({'kind': 'permission', 'permission': 'edit', 'patterns': [target]})
                self.assertEqual(risk['level'], 'R3')
        self.assertEqual(permissions.classify({'kind': 'permission', 'permission': 'edit', 'patterns': ['src/app.py']})['level'], 'R2')


class UnixTransportTests(unittest.TestCase):
    def test_opencode_adapter_speaks_http_over_a_unix_socket(self):
        seen = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                seen.append(self.path)
                body = json.dumps({'healthy': True}).encode()
                self.send_response(200)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        with tempfile.TemporaryDirectory(dir='/tmp') as temp:
            path = os.path.join(temp, 'api.sock')
            server = socketserver.ThreadingUnixStreamServer(path, Handler)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            try:
                api = OpenCode(Settings(Path(temp), Path(temp)), socket_path=path, project='/work/coder-1')
                self.assertEqual(api.health(), {'healthy': True})
                self.assertEqual(seen, ['/global/health?directory=%2Fwork%2Fcoder-1'])
            finally:
                server.shutdown()
                server.server_close()


class FakeSandbox:
    """Records what AgentControl asks the container runtime to do; commands 'inside' run on the host."""

    def __init__(self, log):
        self.log = log
        self.containers = {}

    def state(self, name):
        return self.containers.get(name, {}).get('state', 'missing')

    def create(self, name, spec):
        self.log.append(('create', spec['network']))
        self.containers[name] = {'state': 'created', 'spec': spec, 'networks': [] if spec['network'] == 'none' else ['bridge']}

    def start(self, name):
        self.log.append(('start',))
        self.containers[name]['state'] = 'running'
        sockets = Path(self.containers[name]['spec']['sockets'])
        (sockets / 'ready').write_text('1')

    def wait_ready(self, name, sockets, timeout=120):
        assert (Path(sockets) / 'ready').exists()

    def stop(self, name):
        self.log.append(('stop',))
        self.containers[name]['state'] = 'exited'

    def remove(self, name):
        self.log.append(('remove',))
        self.containers.pop(name, None)

    def networks(self, name):
        return self.containers[name]['networks']

    def disconnect(self, name):
        self.log.append(('disconnect',))
        self.containers[name]['networks'] = []

    def exec(self, name, argv, cwd, timeout, cancel=lambda: False):
        self.log.append(('exec', list(argv), str(cwd), list(self.containers[name]['networks'])))
        return process(argv, cwd, timeout, cancel)


class ContainerRunTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.repo = make_repo(root)
        state = root / 'state'
        state.mkdir()
        (state / 'models.json').write_text(json.dumps({'endpoints': [{'id': 'local', 'url': 'http://127.0.0.1:1', 'model': 'qwen'}]}))
        self.settings = Settings(self.repo, state, poll=.01, notifications=False, run_timeout=60)
        self.host_api = FakeTeamAPI()
        self.inside = FakeTeamAPI()
        self.log = []
        self.inside.on_submit = self.record_prompt
        self.controllers = []

    def record_prompt(self, session, text):
        self.log.append(('prompt',))
        FakeTeamAPI.create_file(session, text)

    def tearDown(self):
        for c in self.controllers:
            c.shutdown.set()
            for thread in list(c.threads.values()):
                thread.join(3)
            for server in list(c.run_gateways.values()):
                server.shutdown()
                server.server_close()
            c.preview.close()
        self.temp.cleanup()

    def controller(self, decisions, info=None):
        manager = FakeTeamManager([], decisions)
        c = Controller(self.settings, self.host_api, manager)
        c.broker.prober = lambda e: {'state': 'online', 'latency_ms': 1, 'models': ['qwen'], 'error': '', 'checked': time.time()}
        info = info or {'runtime': 'docker', 'rootless': True, 'version': '29', 'image': True, 'error': ''}
        c.sandbox_info = lambda refresh=False: info  # no real container runtime in unit tests
        self.box = FakeSandbox(self.log)
        c.sandbox_factory = lambda runtime: self.box
        c.container_api_factory = lambda run: self.inside
        c.check()
        self.controllers.append(c)
        return c

    def wait(self, condition, timeout=8):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            if condition():
                return
            time.sleep(.01)
        self.fail('timed out')

    def done(self, c, ident):
        self.wait(lambda: c.store.get('runs', ident)['status'] in ('completed', 'failed', 'blocked', 'attention', 'stopped'))
        return c.store.get('runs', ident)

    def test_a_run_works_inside_its_container_and_is_cleaned_up(self):
        check = f"{sys.executable} -c \"import pathlib,sys; sys.exit(0 if pathlib.Path('a.txt').exists() else 1)\""
        c = self.controller([{'action': 'code', 'title': 't', 'summary': 's', 'prompt': 'CREATE a.txt'}, complete()])
        run = c.new('Build it', check, isolation='container', cpus=2, memory_gb=4, network='setup')
        result = self.done(c, run['id'])
        self.assertEqual(result['status'], 'completed', result['summary'])
        self.assertEqual(self.host_api.prompts, [], 'nothing goes to the OpenCode on your host')
        self.assertEqual(len(self.inside.prompts), 1)
        ws = result['workspace']
        self.assertEqual(self.log[0], ('create', 'none'), 'no setup command: no network at all')
        spec = self.box_spec = next(iter(self.box.containers.values()))['spec']
        self.assertEqual((spec['cpus'], spec['memory_gb'], spec['workdir']), (2, 4, ws['agents']['coder-1']['dir']))
        self.assertTrue(spec['git_dir'].endswith('/.git'))
        verify = [e for e in self.log if e[0] == 'exec']
        self.assertEqual(verify[0][2], ws['integration']['dir'], 'the verifier runs in the container')
        self.assertEqual(result['container']['state'], 'stopped', 'stopped when the run ended')
        cfg = json.loads((Path(result['container']['base']) / 'opencode.json').read_text())
        self.assertEqual(cfg['model'], 'agentcontrol/qwen')
        c.control(run['id'], 'apply')
        self.assertEqual(self.log[-1], ('remove',))
        self.assertFalse(Path(result['container']['base']).exists())
        actions = [e['action'] for e in c.store.audit(run['id'])]
        self.assertIn('container created', actions)
        self.assertIn('container removed', actions)

    def test_setup_gets_network_which_is_cut_before_the_first_prompt(self):
        c = self.controller([{'action': 'code', 'title': 't', 'summary': 's', 'prompt': 'CREATE a.txt'}, complete()])
        run = c.new('Build it', isolation='container', network='setup', setup='true')
        result = self.done(c, run['id'])
        self.assertEqual(result['status'], 'completed', result['summary'])
        kinds = [e[0] for e in self.log]
        self.assertEqual(self.log[0], ('create', 'bridge'))
        setups = [e for e in self.log if e[0] == 'exec' and e[1] == ['true']]
        self.assertEqual(len(setups), 2, 'setup runs in the integration and coder worktrees')
        self.assertTrue(all(e[3] == ['bridge'] for e in setups), 'setup has the network')
        self.assertLess(kinds.index('disconnect'), kinds.index('prompt'), 'network is cut before any agent is prompted')
        self.assertIn('container network cut', [e['action'] for e in c.store.audit(run['id'])])

    def test_network_none_means_setup_runs_offline_and_internet_needs_confirmation(self):
        c = self.controller([{'action': 'code', 'title': 't', 'summary': 's', 'prompt': 'CREATE a.txt'}, complete()])
        run = c.new('Build it', isolation='container', network='none', setup='true')
        self.done(c, run['id'])
        self.assertEqual(self.log[0], ('create', 'none'))
        self.assertNotIn(('disconnect',), self.log)
        with self.assertRaises(ValueError) as refused:
            c.new('Other', isolation='container', network='internet')
        self.assertIn('type approve', str(refused.exception))

    def test_internet_while_working_stays_connected(self):
        c = self.controller([{'action': 'code', 'title': 't', 'summary': 's', 'prompt': 'CREATE a.txt'}, complete()])
        run = c.new('Build it', isolation='container', network='internet', confirm='approve')
        self.done(c, run['id'])
        self.assertEqual(self.log[0], ('create', 'bridge'))
        self.assertNotIn(('disconnect',), self.log)

    def test_containers_are_refused_when_not_safe_or_not_ready(self):
        cases = [({'runtime': 'docker', 'rootless': False, 'image': True, 'error': ''}, 'runs as root'),
                 ({'runtime': 'docker', 'rootless': True, 'image': False, 'error': ''}, 'not built'),
                 ({'runtime': None, 'rootless': False, 'image': False, 'error': 'Neither podman nor docker is installed'}, 'Neither')]
        for info, message in cases:
            with self.subTest(message):
                c = self.controller([], info)
                with self.assertRaises(ValueError) as refused:
                    c.new('Build it', isolation='container')
                self.assertIn(message, str(refused.exception))
        (self.settings.data / 'models.json').unlink()
        c = self.controller([])
        with self.assertRaises(ValueError) as refused:
            c.new('Build it', isolation='container')
        self.assertIn('models.json', str(refused.exception))

    def test_resume_recreates_a_missing_container_and_stop_is_refused_while_working(self):
        c = self.controller([{'action': 'code', 'title': 't', 'summary': 's', 'prompt': 'CREATE a.txt'}])
        self.inside.hold = True
        run = c.new('Build it', isolation='container')
        self.wait(lambda: len(self.inside.prompts) == 1)
        with self.assertRaises(ValueError):
            c.control(run['id'], 'container_stop')
        c.shutdown.set()
        c.threads[run['id']].join(3)
        self.box.containers.clear()  # removed outside AgentControl
        restarted = self.controller([complete()])
        self.box.containers.clear()
        restarted.control(run['id'], 'resume')
        self.wait(lambda: ('create', 'none') in self.log[1:])
        self.inside.hold = False
        self.inside.finish()
        self.assertEqual(self.done(restarted, run['id'])['status'], 'completed')


if __name__ == '__main__':
    unittest.main()
