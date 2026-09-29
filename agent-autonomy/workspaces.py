"""Git worktrees for runs (M6): each run works on its own branches, never in your checkout.

Layout for run <id>:
  agentcontrol/<id>/integration   the merged result; verification runs here
  agentcontrol/<id>/<agent>       one branch + worktree per agent (coder-1 in single mode)
Worktrees live under AgentControl's state folder. After each turn the agent's changes are
committed on its branch and merged into integration; a conflict leaves integration untouched
and is reported. Your branch changes only when you press Apply (a merge commit, clean tree only).

Internal commits and merges disable repository hooks and use an AgentControl identity, so
they need no git configuration and never run project code. Apply uses your normal git setup.
Standard library only.
"""
import os
from pathlib import Path
import re
import shutil
import subprocess

BRANCH_PREFIX = 'agentcontrol'
IDENTITY = ['-c', 'user.name=AgentControl', '-c', 'user.email=agentcontrol@localhost']
INTERNAL = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'merge.autoStash=false'] + IDENTITY
MAX_DIFF = 28_000


class WorkspaceError(RuntimeError):
    pass


def git(cwd, *args, internal=True, check=True, timeout=120):
    env = dict(os.environ, GIT_TERMINAL_PROMPT='0', LC_ALL='C', GIT_EDITOR='true')
    argv = ['git'] + (INTERNAL if internal else []) + list(args)
    try:
        result = subprocess.run(argv, cwd=str(cwd), capture_output=True, text=True, timeout=timeout, env=env,
                                stdin=subprocess.DEVNULL)
    except FileNotFoundError as exc:
        raise WorkspaceError('git is not installed') from exc
    except subprocess.TimeoutExpired as exc:
        raise WorkspaceError(f'git {args[0]} timed out') from exc
    if check and result.returncode:
        raise WorkspaceError(f"git {' '.join(args[:3])} failed: {(result.stderr or result.stdout).strip()[-800:]}")
    return result


def _out(cwd, *args, **kw):
    return git(cwd, *args, **kw).stdout.strip()


def git_info(project):
    """What a run needs to know about the project's repository. Never raises."""
    project = Path(project).resolve()
    info = {'is_repo': False, 'usable': False, 'reason': '', 'toplevel': '', 'subdir': '', 'branch': '', 'head': '',
            'changes': [], 'untracked': [], 'merging': False}
    try:
        top = git(project, 'rev-parse', '--show-toplevel', check=False)
    except WorkspaceError as exc:
        return {**info, 'reason': str(exc)}
    if top.returncode:
        return {**info, 'reason': 'not a git repository'}
    toplevel = Path(top.stdout.strip()).resolve()
    info.update(is_repo=True, toplevel=str(toplevel), subdir='' if project == toplevel else project.relative_to(toplevel).as_posix())
    info['branch'] = git(toplevel, 'symbolic-ref', '--short', '-q', 'HEAD', check=False).stdout.strip()
    info['head'] = git(toplevel, 'rev-parse', '-q', '--verify', 'HEAD', check=False).stdout.strip()
    info['merging'] = bool(git(toplevel, 'rev-parse', '-q', '--verify', 'MERGE_HEAD', check=False).stdout.strip())
    status = git(toplevel, 'status', '--porcelain=v1', '-z', '--untracked-files=all', check=False).stdout
    entries = [e for e in status.split('\0') if e]
    skip = False
    for entry in entries:
        if skip:  # the second path of a rename
            skip = False
            continue
        code, path = entry[:2], entry[3:]
        if code[0] in 'RC':
            skip = True
        (info['untracked'] if code == '??' else info['changes']).append(path)
    if not info['head']:
        info['reason'] = 'the repository has no commits yet'
    elif not info['branch']:
        info['reason'] = 'HEAD is detached; check out a branch first'
    elif info['merging']:
        info['reason'] = 'a merge is in progress; finish or abort it first'
    else:
        info['usable'] = True
    return info


def branches(run_id, agents):
    return {'integration': f'{BRANCH_PREFIX}/{run_id}/integration', **{a: f'{BRANCH_PREFIX}/{run_id}/{a}' for a in agents}}


def create(info, root, run_id, agents=('coder-1',), base=None):
    """Create the integration and agent branches and worktrees at `base` (default: HEAD)."""
    if not info.get('usable'):
        raise WorkspaceError('Cannot create a worktree: ' + (info.get('reason') or 'unknown repository state'))
    if not re.fullmatch(r'[a-z0-9-]{1,40}', run_id) or any(not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,39}', a) for a in agents):
        raise WorkspaceError('Invalid run or agent name for a branch')
    top = Path(info['toplevel'])
    base = base or info['head']
    root = Path(root) / run_id
    names = branches(run_id, agents)
    made = []
    try:
        for key, branch in names.items():
            path = root / key
            git(top, 'worktree', 'add', '-q', '-b', branch, str(path), base)
            made.append((branch, path))
    except WorkspaceError:
        for branch, path in made:
            git(top, 'worktree', 'remove', '--force', str(path), check=False)
            git(top, 'branch', '-D', branch, check=False)
        raise
    sub = info['subdir']

    def entry(key):
        path = root / key
        return {'branch': names[key], 'path': str(path), 'dir': str(path / sub) if sub else str(path)}

    return {'mode': 'worktree', 'toplevel': str(top), 'subdir': sub, 'base': base, 'base_branch': info['branch'],
            'integration': entry('integration'), 'agents': {a: entry(a) for a in agents}, 'turns': []}


def add_agent(ws, agent):
    """Give a new agent its own branch and worktree, starting from the current integration head."""
    if agent in ws['agents']:
        return ws
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,39}', agent):
        raise WorkspaceError('Invalid agent name for a branch')
    integ = ws['integration']
    head = _out(integ['path'], 'rev-parse', 'HEAD')
    run_root = Path(integ['path']).parent
    branch = f"{integ['branch'].rsplit('/', 1)[0]}/{agent}"
    path = run_root / agent
    git(ws['toplevel'], 'worktree', 'add', '-q', '-b', branch, str(path), head)
    sub = ws['subdir']
    ws['agents'][agent] = {'branch': branch, 'path': str(path), 'dir': str(path / sub) if sub else str(path)}
    return ws


def sync_agent(ws, agent):
    """Bring an agent's branch up to date with integration before its next task, so it builds on
    the other agents' merged work. Returns {'status': current|updated|conflict, 'files'}."""
    mine, integ = ws['agents'][agent], ws['integration']
    if _merging(mine['path']):
        return {'status': 'conflict', 'files': git(mine['path'], 'diff', '--name-only', '--diff-filter=U', check=False).stdout.split()}
    head = _out(integ['path'], 'rev-parse', 'HEAD')
    if git(mine['path'], 'merge-base', '--is-ancestor', head, 'HEAD', check=False).returncode == 0:
        return {'status': 'current', 'files': []}
    merged = git(mine['path'], 'merge', '--no-edit', '-m', 'Update from integration', integ['branch'], check=False)
    if merged.returncode:
        files = git(mine['path'], 'diff', '--name-only', '--diff-filter=U', check=False).stdout.split()
        return {'status': 'conflict', 'files': files}
    return {'status': 'updated', 'files': []}


def _merging(path):
    return bool(git(path, 'rev-parse', '-q', '--verify', 'MERGE_HEAD', check=False).stdout.strip())


def commit_turn(path, message, author='coder-1'):
    """Commit everything the agent changed. Returns {'status': committed|unchanged|unresolved, 'commit', 'files'}."""
    git(path, 'add', '-A')
    merging = _merging(path)
    if merging:
        # A conflict handed to the agent: refuse to commit files that still hold markers.
        marked = git(path, 'grep', '--cached', '-l', '-E', '-e', '^(<<<<<<<|>>>>>>>) ', check=False).stdout.split()
        if marked:
            return {'status': 'unresolved', 'commit': _out(path, 'rev-parse', 'HEAD'), 'files': marked}
    elif git(path, 'diff', '--cached', '--quiet', check=False).returncode == 0:
        return {'status': 'unchanged', 'commit': _out(path, 'rev-parse', 'HEAD'), 'files': []}
    git(path, 'commit', '-q', '--no-verify', '--author', f'{author} (AgentControl) <{author}@agentcontrol.local>',
        '-m', message[:2000])
    return {'status': 'committed', 'commit': _out(path, 'rev-parse', 'HEAD'), 'files': []}


def integrate(ws, agent):
    """Merge the agent's branch into integration. On conflict integration is left untouched, and the
    agent's worktree gets integration merged in with conflict markers for the agent to resolve."""
    integ, mine = ws['integration'], ws['agents'][agent]
    before = _out(integ['path'], 'rev-parse', 'HEAD')
    merged = git(integ['path'], 'merge', '--no-ff', '--no-edit', '-m', f'Integrate {agent}', mine['branch'], check=False)
    if merged.returncode:
        files = git(integ['path'], 'diff', '--name-only', '--diff-filter=U', check=False).stdout.split()
        git(integ['path'], 'merge', '--abort', check=False)
        if _out(integ['path'], 'rev-parse', 'HEAD') != before:
            raise WorkspaceError('Integration branch changed during an aborted merge')
        handoff = git(mine['path'], 'merge', '--no-ff', '--no-edit', '-m', 'Merge integration', integ['branch'], check=False)
        return {'status': 'conflict', 'files': files or ['(unknown)'], 'commit': before,
                'handed_to_agent': handoff.returncode != 0}
    after = _out(integ['path'], 'rev-parse', 'HEAD')
    if after == before:
        return {'status': 'unchanged', 'files': [], 'commit': after}
    # Keep the agent on the merged result so its next turn starts from it.
    git(mine['path'], 'merge', '--ff-only', '-q', integ['branch'], check=False)
    return {'status': 'merged', 'files': [], 'commit': after}


def evidence(path, old, new, subdir=''):
    """Changes between two commits, in the same shape as verify.evidence()."""
    scope = ['--', subdir] if subdir else []
    if old == new:
        return {'changed_files': [], 'diff': '', 'diff_truncated': False, 'omitted_files': 0, 'file_stats': []}
    kinds = {}
    for line in _out(path, 'diff', '--name-status', '--no-renames', old, new, *scope).splitlines():
        code, _, name = line.partition('\t')
        kinds[name] = {'A': 'new', 'D': 'deleted'}.get(code[:1], 'modified')
    stats = []
    for line in _out(path, 'diff', '--numstat', '--no-renames', old, new, *scope).splitlines():
        added, removed, name = line.split('\t', 2)
        binary = added == '-'
        stats.append({'path': name, 'change': kinds.get(name, 'modified'), 'added': None if binary else int(added),
                      'removed': None if binary else int(removed), 'partial': False})
    diff = _out(path, 'diff', '--no-color', '--no-renames', old, new, *scope)
    return {'changed_files': [s['path'] for s in stats], 'diff': diff[:MAX_DIFF], 'diff_truncated': len(diff) > MAX_DIFF,
            'omitted_files': 0, 'file_stats': stats}


def summary(ws):
    """Branch state for the dashboard: commits and size of the change since the base."""
    integ = ws['integration']
    if not Path(integ['path']).exists():
        head = _out(ws['toplevel'], 'rev-parse', '-q', '--verify', integ['branch'], check=False)
    else:
        head = _out(integ['path'], 'rev-parse', 'HEAD')
    if not head:
        return {'exists': False}
    count = _out(ws['toplevel'], 'rev-list', '--count', '--no-merges', f"{ws['base']}..{head}", check=False)
    stat = _out(ws['toplevel'], 'diff', '--shortstat', ws['base'], head, check=False)
    return {'exists': True, 'head': head, 'commits': int(count or 0), 'shortstat': stat}


def check(ws):
    """Missing worktree paths (empty when all are present)."""
    listed = _out(ws['toplevel'], 'worktree', 'list', '--porcelain', check=False)
    known = {Path(line[9:]).resolve() for line in listed.splitlines() if line.startswith('worktree ')}
    wanted = [ws['integration']] + list(ws['agents'].values())
    return [w['path'] for w in wanted if Path(w['path']).resolve() not in known or not Path(w['path']).is_dir()]


def apply_ready(ws):
    """Why Apply cannot run right now ('' when it can)."""
    info = git_info(ws['toplevel'])
    if not info['is_repo']:
        return 'the project is no longer a git repository'
    if info['merging']:
        return 'a merge is in progress in your checkout'
    if info['branch'] != ws['base_branch']:
        return f"your checkout is on {info['branch'] or 'a detached HEAD'}; switch to {ws['base_branch']} first"
    if info['changes']:
        return f"your checkout has uncommitted changes ({', '.join(info['changes'][:5])}); commit or stash them first"
    return ''


def apply(ws, message):
    """Merge the integration branch into your branch with a merge commit. Your hooks run as usual."""
    reason = apply_ready(ws)
    if reason:
        raise WorkspaceError('Cannot apply: ' + reason)
    top = ws['toplevel']
    before = _out(top, 'rev-parse', 'HEAD')
    identity = [] if _out(top, 'config', 'user.email', internal=False, check=False) else IDENTITY
    result = git(top, *identity, 'merge', '--no-ff', '-m', message[:2000], ws['integration']['branch'], internal=False, check=False)
    if result.returncode:
        files = git(top, 'diff', '--name-only', '--diff-filter=U', check=False).stdout.split()
        git(top, 'merge', '--abort', internal=False, check=False)
        return {'status': 'conflict', 'files': files, 'commit': before,
                'error': (result.stderr or result.stdout).strip()[-600:]}
    return {'status': 'applied', 'commit': _out(top, 'rev-parse', 'HEAD'), 'files': []}


def remove_worktrees(ws):
    top = ws['toplevel']
    for w in [ws['integration']] + list(ws['agents'].values()):
        git(top, 'worktree', 'remove', '--force', w['path'], check=False)
        if Path(w['path']).exists():
            shutil.rmtree(w['path'], ignore_errors=True)
    git(top, 'worktree', 'prune', check=False)


def discard(ws):
    remove_worktrees(ws)
    for branch in [ws['integration']['branch']] + [a['branch'] for a in ws['agents'].values()]:
        git(ws['toplevel'], 'branch', '-D', branch, check=False)
