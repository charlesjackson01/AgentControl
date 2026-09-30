"""Independent evidence: what the agent actually changed, and what it said while doing it.

snapshot() and evidence() compare bounded text snapshots of the project; they do not trust
an agent's own report. transcript() keeps an ordered, bounded view of OpenCode's output.
"""
import difflib
import hashlib
import os
from pathlib import Path


def transcript(messages, max_parts=300, max_chars=80_000):
    """Ordered, bounded view of OpenCode's text and tool parts for the live terminal."""
    parts = []
    for message in messages:
        for part in message.get('parts', []):
            kind = part.get('type')
            if kind == 'text' and part.get('text'):
                parts.append({'type': 'text', 'text': str(part['text'])[-8000:]})
            elif kind == 'tool':
                state = part.get('state') or {}
                given = state.get('input') or {}
                status = state.get('status', '')
                summary = given.get('command') or given.get('filePath') or given.get('path') or given.get('pattern') or given.get('url') or state.get('title') or ''
                if status == 'error':
                    output = state.get('error', '')
                elif status == 'completed':
                    output = state.get('output', '')
                else:
                    # Some tools stream partial output through metadata while running.
                    output = (state.get('metadata') or {}).get('output', '')
                parts.append({'type': 'tool', 'id': str(part.get('id') or part.get('callID') or ''), 'tool': str(part.get('tool', 'tool')),
                              'status': str(status), 'title': str(state.get('title', ''))[:300], 'summary': str(summary)[:500],
                              'output': str(output or '')[-3000:]})
    total, kept = 0, []
    for item in reversed(parts[-max_parts:]):
        size = len(item.get('text', '')) + len(item.get('output', '')) + len(item.get('summary', ''))
        if kept and total + size > max_chars:
            break
        total += size
        kept.append(item)
    kept.reverse()
    return kept, len(parts) - len(kept)


SKIP_DIRS = {'.git', '.hermes', '.venv', 'venv', 'node_modules', '__pycache__', '.pytest_cache',
             'agent-autonomy', 'trial-autonomy', 'trial-dashboard', 'dist', 'build'}
TEXT_SUFFIXES = {'.py', '.js', '.ts', '.tsx', '.jsx', '.json', '.html', '.css', '.md', '.txt', '.toml', '.yaml', '.yml', '.qml', '.cpp', '.h', '.sh'}


def snapshot(project):
    files = {}
    omitted = 0
    budget = 120_000
    for root, dirs, names in os.walk(project, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and not d.startswith('.') and not (Path(root) / d).is_symlink())
        for name in sorted(names):
            path = Path(root) / name
            relative = path.relative_to(project).as_posix()
            low = name.lower()
            if path.is_symlink() or low.startswith('.') or low == 'dashboard.py' or any(x in low for x in ('credential', 'secret', 'private_key', 'auth.json')):
                continue
            if path.suffix.lower() not in TEXT_SUFFIXES:
                continue
            if len(files) >= 100 or budget <= 0:
                omitted += 1
                continue
            try:
                size = path.stat().st_size
                # Bound memory and do not read binary/large files into the manager context.
                if size > 150_000:
                    omitted += 1
                    continue
                raw = path.read_bytes()
                value = raw.decode('utf-8')
            except (OSError, UnicodeError):
                continue
            head = value[:min(12_000, budget)]
            budget -= len(head)
            files[relative] = {'sha256': hashlib.sha256(raw).hexdigest(), 'text': head, 'truncated': len(head) < len(value)}
    return {'files': files, 'omitted_files': omitted}


def evidence(before, after):
    old, new = before.get('files', {}), after.get('files', {})
    changes = []
    diffs = []
    file_stats = []
    for path in sorted(set(old) | set(new)):
        a, b = old.get(path), new.get(path)
        if a and b and a['sha256'] == b['sha256']:
            continue
        changes.append(path)
        diff = '\n'.join(difflib.unified_diff((a or {}).get('text', '').splitlines(), (b or {}).get('text', '').splitlines(), fromfile=path+' (before)', tofile=path+' (after)', lineterm=''))
        diffs.append(diff)
        lines = diff.splitlines()
        file_stats.append({'path': path, 'change': 'new' if a is None else 'deleted' if b is None else 'modified',
                           'added': sum(line.startswith('+') for line in lines[2:]),
                           'removed': sum(line.startswith('-') for line in lines[2:]),
                           'partial': bool((a or {}).get('truncated') or (b or {}).get('truncated'))})
    full = '\n\n'.join(diffs)
    return {'changed_files': changes, 'diff': full[:28_000], 'diff_truncated': len(full) > 28_000,
            'omitted_files': after.get('omitted_files', 0), 'file_stats': file_stats}
