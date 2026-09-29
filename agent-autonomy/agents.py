"""Agent registry and per-run agent identities.

Every run has named agents with a stable identity (id, role, runtime, model) recorded in the
journal. Their live state is *derived* from the run, its turns, and pending approvals, which
the journal already holds, so it can never disagree with the run itself and runs recorded
before agents existed are shown the same way without rewriting history.
Standard library only.
"""
from dataclasses import asdict, dataclass, field
import json

TERMINAL = {'completed', 'blocked', 'failed', 'stopped', 'limit_reached'}


@dataclass(frozen=True)
class AgentType:
    """One role. Adding a specialist later means adding one entry here (and its prompt in roles.py).

    workspace  own-branch       its own worktree; turns are merged into integration
               test-branch      its own worktree; a turn merges only if it changed test files (roles.py)
               review-snapshot  its own worktree brought up to the merged result; never merged
               scratch          a folder with no project files (state/research/...)
    edits      allowed | tests-only | none
    weight     how much of the model/GPU budget it takes while working (scheduler capacity)
    """
    id: str
    role: str
    runtime: str
    description: str
    tools: tuple = field(default_factory=tuple)
    workspace: str = 'own-branch'
    edits: str = 'allowed'
    priority: str = 'coder'
    weight: int = 1
    max_concurrent: int = 3
    approval_per_task: bool = False
    needs_git: bool = False


# OpenCode tools a read-only agent must not be offered (M12 spike: per-prompt "tools" withholds them;
# OpenCode's own "plan" agent does not, when your config allows edits).
CHANGE_TOOLS = ('write', 'edit', 'patch', 'multiedit', 'apply_patch', 'bash', 'todowrite', 'task', 'webfetch')

TYPES = {
    'orchestrator': AgentType('orchestrator', 'Orchestrator', 'hermes-cli',
                              'Plans each turn, writes the prompt, and reviews the evidence.', ('todo',),
                              workspace='scratch', edits='none', priority='orchestrator'),
    'coder': AgentType('coder', 'Coder', 'opencode',
                       'Writes and edits code in the project through an OpenCode session.'),
    'tester': AgentType('tester', 'Tester', 'opencode',
                        'Writes and runs tests on its own branch; only test files are merged.',
                        workspace='test-branch', edits='tests-only', max_concurrent=1, needs_git=True),
    'reviewer': AgentType('reviewer', 'Reviewer', 'opencode',
                          'Reads the merged changes and reports findings. Cannot edit files or run commands.',
                          ('read', 'grep', 'glob', 'list'), workspace='review-snapshot', edits='none', max_concurrent=1, needs_git=True),
    'researcher': AgentType('researcher', 'Researcher', 'hermes-cli',
                            'Looks things up on the web with Hermes and returns a cited report. Each task needs your approval.',
                            ('web',), workspace='scratch', edits='none', priority='background', max_concurrent=1,
                            approval_per_task=True),
}
SPECIALISTS = ('tester', 'reviewer', 'researcher')


def role_of(name):
    """The role behind an agent name: coder-2 -> coder, reviewer-1 -> reviewer, hermes -> orchestrator."""
    if name == 'hermes':
        return 'orchestrator'
    base = str(name or 'coder-1').rsplit('-', 1)[0]
    return base if base in TYPES else 'coder'


def type_of(name):
    return TYPES[role_of(name)]


# Which agent produced an activity entry, by event kind. Unlisted kinds belong to AgentControl itself.
EVENT_AGENT = {
    'Hermes request': 'hermes', 'Hermes decision': 'hermes', 'Hermes JSON repaired': 'hermes',
    'OpenCode prompt': 'coder-1', 'OpenCode tool': 'coder-1', 'OpenCode result': 'coder-1',
    'OpenCode needs input': 'coder-1', 'submission uncertain': 'coder-1', 'session': 'coder-1',
}


def default_agents(run, profile=''):
    """The agents a single-agent run has: Hermes orchestrating and one OpenCode coder."""
    return [
        {'id': f"{run['id']}:hermes", 'run': run['id'], 'name': 'hermes', 'type': 'orchestrator',
         'model': f'Hermes profile {profile}' if profile else 'Hermes default profile', 'created': run['created']},
        {'id': f"{run['id']}:coder-1", 'run': run['id'], 'name': 'coder-1', 'type': 'coder',
         'model': "OpenCode server's configured model", 'created': run['created']},
    ]


def agent_for_event(kind, detail=None):
    """Which agent an activity entry belongs to: the agent the event names (tool calls, prompts,
    approvals and sessions of team runs name theirs), else the default for that kind of event."""
    if isinstance(detail, str) and detail[:1] in '[{':
        try:
            detail = json.loads(detail)
        except ValueError:
            pass
    if isinstance(detail, dict) and detail.get('agent'):
        return str(detail['agent'])
    if isinstance(detail, list) and detail and isinstance(detail[0], dict) and detail[0].get('agent'):
        return str(detail[0]['agent'])
    if kind == 'session' and isinstance(detail, str) and ': ' in detail:
        return detail.split(': ', 1)[0]   # "coder-2: ses_…"
    return EVENT_AGENT.get(kind, 'agentcontrol')


def live_state(agent, run, steps, pending):
    """(state, current task) for one agent, from the run's recorded state."""
    status = run.get('status')
    if status in TERMINAL:
        return ('finished' if status == 'completed' else status), ''
    if status == 'paused' or (run.get('pause') and status not in ('interrupted', 'attention')):
        return 'paused', ''
    if status in ('interrupted', 'attention'):
        return 'needs_attention', run.get('summary', '')
    if agent['type'] == 'orchestrator':
        if status == 'awaiting_approval':
            return 'waiting_on_you', 'Waiting for your decision on the team plan'
        if run.get('phase') == 'manager' and status in ('planning', 'reviewing'):
            if run.get('mode') == 'team' and (run.get('team') or {}).get('state') == 'proposing':
                return 'working', 'Proposing a team'
            return 'working', 'Planning the next turn' if steps else 'Planning the first turn'
        return 'idle', ''
    # Each coder follows its own latest turn; several can be working at once in a team run.
    mine = next((s for s in reversed(steps) if s.get('agent', 'coder-1') == agent['name']), None)
    if mine and mine.get('status') == 'awaiting_approval':
        return 'waiting_on_you', 'Waiting for your approval: ' + mine.get('title', '')
    if mine and mine.get('status') in ('prepared', 'dispatching', 'running', 'waiting'):
        if any(p.get('agent', 'coder-1') == agent['name'] for p in pending):
            return 'waiting_on_you', mine.get('title', '')
        return 'working', mine.get('title', '')
    if status == 'reviewing' and run.get('phase') == 'verify':
        return 'idle', 'AgentControl is verifying the last turn'
    return 'idle', ''


def states(agents, run, steps, pending):
    """{name: (state, task)} for a run's agents, the same states describe() reports."""
    mine = [p for p in pending if p.get('run', run['id']) == run['id']]
    return {a['name']: live_state(a, run, steps, mine) for a in agents}


def transitions(previous, current):
    """State changes between two {name: (state, task)} maps, as lifecycle event details.
    An agent missing from `previous` has just joined (from None). Agents that left are ignored:
    agents are never removed from a run."""
    changes = []
    for name, (state, task) in current.items():
        before = previous.get(name)
        if before is None or before[0] != state:
            changes.append({'agent': name, 'from': before[0] if before else None, 'to': state, 'task': task})
    return changes


def describe(agents, run, steps, pending, events=(), lifecycle=None):
    """Agents for the API: identity + type info + derived state + simple counters.
    `lifecycle` maps an agent to its latest recorded 'agent state' event; `since` is that event's
    time only while it still matches the derived state, so it can never contradict it."""
    lifecycle = lifecycle or {}
    counts = {}
    for event in events:
        name = agent_for_event(event.get('kind', ''), event.get('detail'))
        counts[name] = counts.get(name, 0) + 1
    result = []
    for agent in agents:
        kind = TYPES.get(agent['type'])
        state, task = live_state(agent, run, steps, [p for p in pending if p.get('run') == run['id']])
        own = [s for s in steps if s.get('agent', 'coder-1') == agent['name']] if agent['type'] != 'orchestrator' else []
        tools = sum(1 for s in own for part in (s.get('transcript') or []) if part.get('type') == 'tool')
        result.append({**agent, 'role': kind.role if kind else agent['type'], 'runtime': kind.runtime if kind else 'unknown',
                       'description': kind.description if kind else '', 'tools': list(kind.tools) if kind else [],
                       'state': state, 'task': task,
                       'since': (lifecycle.get(agent['name']) or {}).get('created') if (lifecycle.get(agent['name']) or {}).get('to') == state else None,
                       'stats': {'turns': len(own) if agent['type'] != 'orchestrator' else run.get('decision_count', 0),
                                 'tool_calls': tools, 'activity': counts.get(agent['name'], 0)}})
    return result


def types():
    return [asdict(t) | {'tools': list(t.tools)} for t in TYPES.values()]
