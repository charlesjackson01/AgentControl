"""Run a subprocess without a shell, with a timeout and cancellation, in its own process group."""
import os
import signal
import subprocess
import tempfile
import time

from errors import Stopped


def process(argv, cwd, timeout, cancel=lambda: False, env=None):
    """No shell interpolation; stop only the process group started here."""
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        p = subprocess.Popen(argv, cwd=str(cwd), stdin=subprocess.DEVNULL,
                             stdout=stdout, stderr=stderr, env=env, start_new_session=True)
        until = time.monotonic() + timeout
        try:
            while p.poll() is None:
                if cancel():
                    raise Stopped()
                if time.monotonic() >= until:
                    raise TimeoutError(f'Command timed out after {timeout:g}s: {argv[0]}')
                time.sleep(0.1)
            stdout.seek(0)
            stderr.seek(0)
            return p.returncode, stdout.read(2_000_000).decode(errors='replace'), stderr.read(100_000).decode(errors='replace')
        finally:
            if p.poll() is None:
                os.killpg(p.pid, signal.SIGTERM)
                try:
                    p.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(p.pid, signal.SIGKILL)
                    p.wait(timeout=3)
