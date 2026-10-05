"""Capabilities (M9): OpenCode skills, checked before an agent ever sees them.

A skill is a folder with SKILL.md (frontmatter: name, description) plus helper files. OpenCode
loads project skills from `.opencode/skills/<name>/` in the agent's directory, and asks
permission ("skill") each time one is loaded.

Sources: your local library folder, or a git repository pinned to a commit. Content is always
inspected here first (size, file count, no symlinks or escaping paths, a valid name) and
hashed; you approve an exact version, and trust is per hash, so a changed skill is reviewed
again. Installing copies the folder into one agent's worktree; removing it is the rollback.
Skill text is data: it is shown to you escaped and never treated as instructions here.
Standard library only.
"""
import hashlib
import permissions
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess

NAME = re.compile(r'^[a-z0-9][a-z0-9-]{0,63}$')
MAX_FILES = 50
MAX_TOTAL = 512 * 1024
MAX_FILE = 256 * 1024
SCRIPT_SUFFIXES = {'.sh', '.bash', '.zsh', '.py', '.js', '.mjs', '.cjs', '.ts', '.rb', '.pl', '.php', '.ps1', '.bat', '.cmd', '.exe', '.bin', '.so'}
SKILLS_DIR = Path('.opencode') / 'skills'


class CapabilityError(ValueError):
    pass


def frontmatter(text):
    """name/description from a SKILL.md YAML header (the small subset skills use)."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != '---':
        return {}
    values, key, block = {}, None, []
    for line in lines[1:]:
        if line.strip() == '---':
            break
        match = re.match(r'^([A-Za-z_][\w-]*):\s*(.*)$', line)
        if match and not line.startswith((' ', '\t')):
            if key and block:
                values[key] = ' '.join(block).strip()
            key, value = match.group(1), match.group(2).strip()
            block = []
            if value in ('|', '>', '|-', '>-'):
                continue
            values[key] = value.strip('"\'')
            key = None
        elif key and line.strip():
            block.append(line.strip())
    if key and block:
        values[key] = ' '.join(block).strip()
    header = lines[1:next((i for i, line in enumerate(lines[1:], 1) if line.strip() == '---'), len(lines))]
    for index, line in enumerate(header):
        match = re.match(r'^tools:\s*(.*)$', line)
        if not match:
            continue
        raw = match.group(1).strip()
        if raw.startswith('[') and raw.endswith(']'):
            tools = [part.strip().strip("\"'") for part in raw[1:-1].split(',')] if raw[1:-1].strip() else []
        elif not raw:
            tools = []
            for entry in header[index+1:]:
                if not entry.strip() or entry.lstrip().startswith('#'):
                    continue
                if not entry.startswith((' ', '\t', '-')):
                    break
                item = re.match(r'^\s*-\s+(.+?)\s*$', entry)
                if not item:
                    raise CapabilityError('tools must be a list of permission types')
                tools.append(item.group(1).strip("\"'"))
        else:
            raise CapabilityError('tools must be a list of permission types')
        unknown = next((tool for tool in tools if tool not in permissions.REGISTRY), None)
        if unknown is not None:
            raise CapabilityError(f'Unknown tool permission type: {unknown}')
        values['tools'] = list(dict.fromkeys(tools))
    return values


def inspect(folder):
    """Validate a skill folder. Returns name, description, files, size, hash, risk and reasons."""
    folder = Path(folder)
    if folder.is_symlink() or not folder.is_dir():
        raise CapabilityError(f'{folder.name}: not a folder')
    skill_md = folder / 'SKILL.md'
    if not skill_md.is_file() or skill_md.is_symlink():
        raise CapabilityError(f'{folder.name}: SKILL.md is missing')
    files, total, reasons, digest = [], 0, [], hashlib.sha256()
    root = folder.resolve()
    for current, dirs, names in os.walk(folder, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d != '.git')
        for d in dirs:
            if (Path(current) / d).is_symlink():
                raise CapabilityError(f'{folder.name}: symbolic links are not allowed ({d})')
        for name in sorted(names):
            path = Path(current) / name
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode):
                raise CapabilityError(f'{folder.name}: symbolic links are not allowed ({name})')
            if not stat.S_ISREG(info.st_mode):
                raise CapabilityError(f'{folder.name}: only regular files are allowed ({name})')
            relative = path.relative_to(folder).as_posix()
            if root not in path.resolve().parents:
                raise CapabilityError(f'{folder.name}: {relative} is outside the skill folder')
            if info.st_size > MAX_FILE:
                raise CapabilityError(f'{folder.name}: {relative} is larger than {MAX_FILE // 1024} KB')
            total += info.st_size
            files.append({'path': relative, 'size': info.st_size})
            if len(files) > MAX_FILES:
                raise CapabilityError(f'{folder.name}: more than {MAX_FILES} files')
            if total > MAX_TOTAL:
                raise CapabilityError(f'{folder.name}: larger than {MAX_TOTAL // 1024} KB in total')
            data = path.read_bytes()
            digest.update(relative.encode() + b'\0' + data + b'\0')
            executable = bool(info.st_mode & 0o111)
            if path.suffix.lower() in SCRIPT_SUFFIXES or executable or data.startswith(b'#!'):
                reasons.append(f'contains a script or program: {relative}')
            elif b'\0' in data[:4096]:
                reasons.append(f'contains a binary file: {relative}')
    text = skill_md.read_text(errors='replace')
    meta = frontmatter(text)
    name = meta.get('name', '')
    if not NAME.match(name):
        raise CapabilityError(f'{folder.name}: SKILL.md needs a name of lowercase letters, digits and dashes (got {name!r})')
    description = meta.get('description', '')
    if len(description) > 1024:
        raise CapabilityError(f'{name}: the description is longer than 1,024 characters')
    return {'name': name, 'description': description, 'files': files, 'size': total, 'hash': digest.hexdigest(),
            'risk': 'sensitive' if reasons else 'low', 'reasons': reasons, 'skill_md': text[:20000],
            **({'tools': meta['tools']} if 'tools' in meta else {})}


def library(path):
    """Every skill folder in your library, valid or not (with the reason)."""
    path = Path(path).expanduser()
    if not path.is_dir():
        return []
    entries = []
    for folder in sorted(p for p in path.iterdir() if p.is_dir() and not p.name.startswith('.')):
        try:
            entries.append({**inspect(folder), 'folder': folder.name, 'error': ''})
        except (CapabilityError, OSError) as exc:
            entries.append({'folder': folder.name, 'name': folder.name, 'error': str(exc)})
    return entries


def _git(cwd, *args, timeout=120):
    env = dict(os.environ, GIT_TERMINAL_PROMPT='0', LC_ALL='C', GIT_LFS_SKIP_SMUDGE='1')
    safe = ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.ext.allow=never', '-c', 'submodule.recurse=false',
            '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false']
    try:
        result = subprocess.run(['git'] + safe + list(args), cwd=str(cwd), capture_output=True, text=True,
                                timeout=timeout, env=env, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired as exc:
        raise CapabilityError('git timed out while fetching the skill') from exc
    if result.returncode:
        raise CapabilityError(f"git {args[0]} failed: {(result.stderr or result.stdout).strip()[-400:]}")
    return result.stdout.strip()


def check_git_source(url, ref, subpath=''):
    url, ref, subpath = str(url or '').strip(), str(ref or '').strip(), str(subpath or '').strip().strip('/')
    remote = re.match(r'^(https://|ssh://)[^\s]+$', url) or re.match(r'^[\w.-]+@[\w.-]+:[\w./~-]+$', url)
    local = url.startswith('/') and Path(url).exists()
    if not (remote or local):
        raise CapabilityError('Use an https:// or ssh git URL, or an absolute path to a repository on this machine')
    if not re.fullmatch(r'[\w./-]{1,200}', ref) or ref.startswith('-') or '..' in ref:
        raise CapabilityError('Give a branch, tag or commit to pin the skill to')
    if subpath and (not re.fullmatch(r'[\w./-]{1,300}', subpath) or '..' in Path(subpath).parts):
        raise CapabilityError('The folder inside the repository must be a plain relative path')
    return url, ref, subpath


def fetch_git(url, ref, subpath, destination):
    """Clone into a quarantine folder at `ref`, without hooks, submodules or LFS. Returns
    (skill folder, resolved commit)."""
    url, ref, subpath = check_git_source(url, ref, subpath)
    destination = Path(destination)
    if destination.exists():
        shutil.rmtree(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    _git(destination.parent, 'clone', '--quiet', '--no-checkout', '--no-recurse-submodules', '--', url, str(destination))
    commit = _git(destination, 'rev-parse', '--verify', '--quiet', f'{ref}^{{commit}}')
    _git(destination, 'checkout', '--quiet', '--detach', commit)
    folder = destination / subpath if subpath else destination
    if destination.resolve() not in [folder.resolve()] + list(folder.resolve().parents):
        raise CapabilityError('The skill folder is outside the repository')
    return folder, commit


def target(agent_dir, name):
    return Path(agent_dir) / SKILLS_DIR / name


def install(source_folder, agent_dir, name):
    """Copy a checked skill into one agent's directory. Refuses to overwrite anything."""
    destination = target(agent_dir, name)
    legacy = Path(agent_dir) / '.opencode' / 'skill' / name
    if destination.exists() or legacy.exists():
        raise CapabilityError(f'A skill called {name} already exists in this agent\'s project')
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source_folder, destination, symlinks=True, ignore=shutil.ignore_patterns('.git'))
    return destination


def remove(agent_dir, name):
    """Delete an installed skill (the rollback). Returns True if it was there."""
    destination = target(agent_dir, name)
    if destination.is_dir() and not destination.is_symlink():
        shutil.rmtree(destination)
        return True
    return False
