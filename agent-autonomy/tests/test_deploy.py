"""The systemd user-service installer (daily use): run for real against a temporary HOME, with
stand-ins for systemctl, opencode, tailscale and sudo that only record how they were called."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

DEPLOY = Path(__file__).resolve().parents[1] / 'deploy'
INSTALL = DEPLOY / 'install-user-services.sh'
RECORDER = '#!/bin/sh\necho "{name} $*" >> "$HOME/calls.log"\n'


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name) / 'home'
        self.project = Path(self.temp.name) / 'my project'.replace(' ', '-')
        self.bin = Path(self.temp.name) / 'bin'
        for folder in (self.home, self.project, self.bin):
            folder.mkdir()
        for name in ('systemctl', 'sudo', 'loginctl'):
            (self.bin / name).write_text(RECORDER.format(name=name))
        (self.bin / 'opencode').write_text('#!/bin/sh\nexit 0\n')
        (self.bin / 'tailscale').write_text('#!/bin/sh\necho 100.64.1.2\n')
        for tool in self.bin.iterdir():
            tool.chmod(0o755)
        self.env = {'HOME': str(self.home), 'USER': 'me', 'PATH': f'{self.bin}:/usr/bin:/bin'}

    def tearDown(self):
        self.temp.cleanup()

    def install(self, *args):
        done = subprocess.run(['bash', str(INSTALL), *args], env=self.env, capture_output=True, text=True, timeout=60)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        return done.stdout

    def calls(self):
        log = self.home / 'calls.log'
        return log.read_text().splitlines() if log.exists() else []

    def test_install_renders_units_and_settings_and_starts_both_services(self):
        out = self.install('--project', str(self.project), '--no-check')
        units = self.home / '.config' / 'systemd' / 'user'
        dashboard = (units / 'agentcontrol.service').read_text()
        opencode = (units / 'agentcontrol-opencode.service').read_text()
        for text in (dashboard, opencode):
            self.assertNotRegex(text, r'@[A-Z_]+@', 'every placeholder is filled in')
            self.assertIn('Restart=on-failure', text)
        self.assertIn(f"ExecStart={shutil.which('python3', path=self.env['PATH'])} ", dashboard)
        self.assertIn('/agent-autonomy/app.py $AGENTCONTROL_ARGS', dashboard)
        self.assertIn(f'ExecStart={self.bin / "opencode"} serve --hostname 127.0.0.1 --port 45381', opencode)
        self.assertIn(f'WorkingDirectory={self.project}', opencode)
        settings = self.home / '.config' / 'agentcontrol' / 'agentcontrol.env'
        text = settings.read_text()
        self.assertIn(f'--host 100.64.1.2 --port 8766 --project {self.project} --opencode http://127.0.0.1:45381', text)
        self.assertIn('--research-toolsets web', text)
        self.assertIn(f'PATH="{self.env["PATH"]}"', text, 'tools are found under systemd')
        self.assertEqual(oct(settings.stat().st_mode & 0o777), '0o600')
        self.assertEqual(self.calls()[:3], ['systemctl --user daemon-reload',
                                            'systemctl --user enable --now agentcontrol-opencode.service',
                                            'systemctl --user enable --now agentcontrol.service'])
        self.assertIn('sudo loginctl enable-linger me', out, 'the sudo step is printed for you to run')
        self.assertFalse(any(c.startswith('sudo') for c in self.calls()), 'the installer never runs sudo')

    def test_your_settings_are_kept_on_reinstall_and_uninstall(self):
        self.install('--project', str(self.project), '--no-check')
        settings = self.home / '.config' / 'agentcontrol' / 'agentcontrol.env'
        settings.write_text(settings.read_text().replace('--port 8766', '--port 9000'))
        self.install('--no-check')   # an update needs no --project
        self.assertIn('--port 9000', settings.read_text())
        self.assertIn(f'WorkingDirectory={self.project}', (self.home / '.config/systemd/user/agentcontrol-opencode.service').read_text())
        self.install('--uninstall')
        self.assertFalse((self.home / '.config/systemd/user/agentcontrol.service').exists())
        self.assertTrue(settings.exists(), 'your settings stay')
        self.assertIn('systemctl --user disable --now agentcontrol.service agentcontrol-opencode.service', self.calls())

    def test_dry_run_changes_nothing(self):
        out = self.install('--project', str(self.project), '--dry-run')
        self.assertIn('+ systemctl --user enable --now agentcontrol.service', out)
        self.assertFalse((self.home / '.config').exists())
        self.assertEqual([c for c in self.calls() if not c.startswith('loginctl show-user')], [], 'only the read-only linger check ran')

    def test_first_install_needs_a_project(self):
        done = subprocess.run(['bash', str(INSTALL), '--no-check'], env=self.env, capture_output=True, text=True, timeout=60)
        self.assertNotEqual(done.returncode, 0)
        self.assertIn('--project', done.stderr)

    @unittest.skipUnless(shutil.which('systemd-analyze'), 'systemd-analyze is not installed')
    def test_rendered_units_are_valid_systemd(self):
        self.install('--project', str(self.project), '--no-check')
        units = [str(self.home / '.config/systemd/user' / name) for name in ('agentcontrol.service', 'agentcontrol-opencode.service')]
        # System mode parses the files without a running user manager; it reports problems as "<file>:<line>: ...".
        done = subprocess.run(['systemd-analyze', 'verify', *units], capture_output=True, text=True, timeout=60)
        problems = [line for line in (done.stdout + done.stderr).splitlines() if any(u in line for u in units)]
        self.assertEqual(problems, [])
        broken = Path(units[0])
        broken.write_text(broken.read_text().replace('Restart=on-failure', 'Restart=bogus'))
        done = subprocess.run(['systemd-analyze', 'verify', units[0]], capture_output=True, text=True, timeout=60)
        self.assertIn('bogus', done.stdout + done.stderr, 'the check really parses the file')


if __name__ == '__main__':
    unittest.main()
