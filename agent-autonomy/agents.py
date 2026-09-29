"""Agent registry and per-run agent identities.

Every run has named agents with a stable identity (id, role, runtime, model) recorded in the
journal. Their live state is *derived* from the run, its turns, and pending approvals, which
the journal already holds, so it can never disagree with the run itself and runs recorded
before agents existed are shown the same way without rewriting history.
Standard library only.
"""
from dataclasses import asdict, dataclass, field

TERMINAL = {'completed', 'blocked', 'failed', 'stopped', 'limit_reached'}


@dataclass(frozen=True)
class AgentType:
    id: str
    role: str
    runtime: str
    description: str
    tools: tuple = field(default_factory=tuple)


# Built-in agent types. New roles (tester, researcher, ui, ...) are added here in later milestones.
TYPES = {
    'orchestrator': AgentType('orchestrator', 'Orchestrator', 'hermes-cli',
                              'Plans each turn, writes the prompt, and reviews the evidence.', ('todo',)),
    'coder': AgentType('coder', 'Coder', 'opencode',
                       'Writes and edits code in the project through an OpenCode session.'),
}

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


def agent_for_event(kind):
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
    last = steps[-1] if steps else None
    if agent['type'] == 'orchestrator':
        if run.get('phase') == 'manager' and status in ('planning', 'reviewing'):
            return 'working', 'Planning the next turn' if steps else 'Planning the first turn'
        return 'idle', ''
    mine = last if last and last.get('agent', 'coder-1') == agent['name'] else None
    if mine and mine.get('status') in ('prepared', 'dispatching', 'running', 'waiting'):
        if pending:
            return 'waiting_on_you', mine.get('title', '')
        return 'working', mine.get('title', '')
    if status == 'reviewing' and run.get('phase') == 'verify':
        return 'idle', 'AgentControl is verifying the last turn'
    return 'idle', ''


def describe(agents, run, steps, pending, events=()):
    """Agents for the API: identity + type info + derived state + simple counters."""
    counts = {}
    for event in events:
        name = agent_for_event(event.get('kind', ''))
        counts[name] = counts.get(name, 0) + 1
    result = []
    for agent in agents:
        kind = TYPES.get(agent['type'])
        state, task = live_state(agent, run, steps, [p for p in pending if p.get('run') == run['id']])
        own = [s for s in steps if s.get('agent', 'coder-1') == agent['name']] if agent['type'] == 'coder' else []
        tools = sum(1 for s in own for part in (s.get('transcript') or []) if part.get('type') == 'tool')
        result.append({**agent, 'role': kind.role if kind else agent['type'], 'runtime': kind.runtime if kind else 'unknown',
                       'description': kind.description if kind else '', 'tools': list(kind.tools) if kind else [],
                       'state': state, 'task': task,
                       'stats': {'turns': len(own) if agent['type'] == 'coder' else run.get('decision_count', 0),
                                 'tool_calls': tools, 'activity': counts.get(agent['name'], 0)}})
    return result


def types():
    return [asdict(t) | {'tools': list(t.tools)} for t in TYPES.values()]
