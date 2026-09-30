"""Projects: browse folders under your home and create new project folders from the dashboard.

Browsing lists folders only, never outside the root (your home unless --projects-root says
otherwise); hidden folders and links that lead outside are left out. A new project is a new
folder directly in the root with a git repository and an empty first commit, so branch runs,
teams, containers and VMs work on it straight away. The chosen project is remembered in
state/project.json and used after a restart instead of --project. Standard library only.
"""
import json
from pathlib import Path
import re
import shutil
import subprocess

NAME = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
MAX_ENTRIES = 500


def _inside(root, path):
    root, path = Path(root).resolve(), Path(path).resolve()
    return path == root or root in path.parents


def resolve(root, path):
    """The real folder for a path the dashboard sent, or ValueError. Relative paths are taken from the root."""
    root = Path(root).resolve()
    candidate = Path(path).expanduser() if path else root
    if not candidate.is_absolute():
        candidate = root / candidate
    real = candidate.resolve()
    if not _inside(root, real):
        raise ValueError(f'Only folders inside {root} can be used.')
    if not real.is_dir():
        raise ValueError(f'{real} is not a folder.')
    return real


def is_git(folder):
    return (Path(folder) / '.git').exists()


def browse(root, path=''):
    """The folders in one folder under the root, with which ones are git projects."""
    root = Path(root).resolve()
    folder = resolve(root, path)
    entries = []
    try:
        children = sorted(folder.iterdir(), key=lambda p: p.name.lower())
    except PermissionError as exc:
        raise ValueError(f'{folder} cannot be read.') from exc
    for child in children:
        if child.name.startswith('.') or not child.is_dir():
            continue
        try:
            real = child.resolve()
        except OSError:
            continue
        if not _inside(root, real):
            continue   # a link that leads outside the root
        entries.append({'name': child.name, 'path': str(real), 'git': is_git(real)})
        if len(entries) >= MAX_ENTRIES:
            break
    return {'root': str(root), 'path': str(folder), 'parent': str(folder.parent) if folder != root else None,
            'git': is_git(folder), 'entries': entries, 'truncated': len(entries) >= MAX_ENTRIES}


def _git(folder, *args):
    done = subprocess.run(['git', *args], cwd=folder, capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
    if done.returncode:
        raise RuntimeError(f"git {args[0]} failed: {(done.stderr or done.stdout).strip()[-300:]}")
    return done.stdout.strip()


def create(root, name):
    """A new folder <root>/<name> with a git repository and an empty first commit."""
    name = (name or '').strip()
    if not NAME.match(name) or set(name) <= {'.'}:
        raise ValueError('Use 1–64 letters, digits, dots, dashes or underscores, starting with a letter or digit.')
    root = Path(root).resolve()
    folder = root / name
    if folder.exists():
        raise ValueError(f'{folder} already exists. Pick it with Browse instead.')
    folder.mkdir(mode=0o755)
    try:
        _git(folder, 'init', '-q')
        _git(folder, 'symbolic-ref', 'HEAD', 'refs/heads/main')
        identity = []
        if not subprocess.run(['git', 'config', 'user.email'], cwd=folder, capture_output=True, text=True).stdout.strip():
            identity = ['-c', 'user.name=AgentControl', '-c', 'user.email=agentcontrol@localhost']
        _git(folder, *identity, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--allow-empty', '-m', f'Start {name}')
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)   # nothing half-made is left behind
        raise
    return folder


def load_choice(data):
    """The project you last chose in the dashboard, if it still exists."""
    try:
        path = Path(json.loads((Path(data) / 'project.json').read_text())['path'])
    except (OSError, ValueError, KeyError, TypeError):
        return None
    return path if path.is_dir() else None


def save_choice(data, path):
    target = Path(data) / 'project.json'
    temp = target.with_suffix('.tmp')
    temp.write_text(json.dumps({'path': str(path)}))
    temp.replace(target)
