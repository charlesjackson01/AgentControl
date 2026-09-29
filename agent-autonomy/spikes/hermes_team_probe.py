#!/usr/bin/env python3
"""M0 spike: can Hermes (on your local model) write a valid team proposal?

Asks Hermes, the same way AgentControl's engine does (one-shot `hermes chat`,
your profile, JSON only), to split a goal into agents and a task dependency
graph. Every answer is checked against the proposal schema: required fields,
known agents, no dangling or circular dependencies. Runs several trials to
estimate reliability and reports timing. Nothing is executed or written in
your project; Hermes only plans.

    python3 hermes_team_probe.py --profile ai-arch-dev --trials 3
    python3 hermes_team_probe.py --goal "Build a REST API with tests and a web UI" --json
"""
import argparse
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import Hermes, Settings, process  # noqa: E402  (reuse the engine's exact invocation)

DEFAULT_GOAL = ('Build a small Python command-line todo app in demo_app/ with add, list, done and delete commands, '
                'JSON storage, unittest tests, and a short README. Also add a tiny static HTML page that lists tasks.')

PROMPT = '''You are Hermes, planning work for a TEAM of coding agents supervised by AgentControl.
Split the goal into agents and tasks. Prefer the smallest team that helps: 1 agent if the work is sequential.
Tasks that touch the same files must depend on each other. Do not call tools. Return ONE JSON object only:
{"mode":"single|multi","reason":"why this team size",
 "agents":[{"id":"short-id","role":"coder|tester|researcher|ui|...","responsibility":"one sentence","capabilities":["..."]}],
 "tasks":[{"id":"t1","title":"...","agent":"agent id","depends_on":["task ids"],"files":["paths it will touch"],"acceptance":"how to verify"}],
 "estimated_parallelism":1}
GOAL:
'''


def validate(p):
    """Return a list of problems; empty means the proposal is usable."""
    problems = []
    if not isinstance(p, dict):
        return ['not a JSON object']
    if p.get('mode') not in ('single', 'multi'):
        problems.append('mode must be single or multi')
    agents, tasks = p.get('agents'), p.get('tasks')
    if not isinstance(agents, list) or not agents:
        return problems + ['agents must be a non-empty list']
    if not isinstance(tasks, list) or not tasks:
        return problems + ['tasks must be a non-empty list']
    agent_ids = set()
    for a in agents:
        if not isinstance(a, dict) or not all(isinstance(a.get(k), str) and a.get(k).strip() for k in ('id', 'role', 'responsibility')):
            problems.append(f'agent missing id/role/responsibility: {a}')
        else:
            agent_ids.add(a['id'])
    task_ids = [t.get('id') for t in tasks if isinstance(t, dict)]
    if len(set(task_ids)) != len(task_ids):
        problems.append('duplicate task ids')
    graph = {}
    for t in tasks:
        if not isinstance(t, dict) or not isinstance(t.get('id'), str) or not isinstance(t.get('title'), str):
            problems.append(f'task missing id/title: {t}')
            continue
        if t.get('agent') not in agent_ids:
            problems.append(f'task {t["id"]} assigned to unknown agent {t.get("agent")!r}')
        deps = t.get('depends_on', [])
        if not isinstance(deps, list) or any(d not in task_ids for d in deps):
            problems.append(f'task {t["id"]} depends on unknown tasks {deps}')
            deps = [d for d in deps if d in task_ids] if isinstance(deps, list) else []
        graph[t['id']] = deps
    visiting, done = set(), set()

    def cyclic(node):
        if node in done:
            return False
        if node in visiting:
            return True
        visiting.add(node)
        found = any(cyclic(d) for d in graph.get(node, []))
        visiting.discard(node)
        done.add(node)
        return found
    if any(cyclic(n) for n in graph):
        problems.append('dependency cycle')
    if p.get('mode') == 'single' and len(agent_ids) > 1:
        problems.append('mode single but more than one agent')
    return problems


def run_hermes(hermes, settings, prompt, max_turns=4, log_path=None):
    caps = hermes.inspect()
    argv = hermes.prefix() + ['chat', '--quiet', '--toolsets', 'todo', '--max-turns', str(max_turns)]
    if caps['--oneshot']:
        argv.append('--oneshot')
    if caps['--ignore-rules']:
        argv.append('--ignore-rules')
    if caps['stream-json']:
        argv += ['--format', 'stream-json']
    with tempfile.TemporaryDirectory(prefix='probe-') as temp:
        path = Path(temp) / 'query.txt'
        path.write_text(prompt)
        argv += ['--query-file', str(path)] if caps['--query-file'] else ['--query', prompt]
        code, out, err = process(argv, settings.project, settings.manager_timeout, env=dict(os.environ, HERMES_TUI='0', NO_COLOR='1'))
    if log_path:
        # Keep everything Hermes printed: the terminal summary alone hides why it failed.
        log_path.write_text(f'COMMAND: {argv}\nEXIT: {code}\nCAPABILITIES: {caps}\n\n--- STDOUT ---\n{out}\n\n--- STDERR ---\n{err}\n')
    if code:
        raise RuntimeError(f'hermes exited {code}. Last stdout: {out.strip()[-700:]!r}. Last stderr: {err.strip()[-700:]!r}'
                           + (f'. Full output: {log_path}' if log_path else ''))
    if caps['stream-json']:
        results = [json.loads(line) for line in out.splitlines() if line.strip().startswith('{') and '"type"' in line]
        results = [r for r in results if isinstance(r, dict) and r.get('type') == 'result']
        out = results[-1].get('text', '') if results else out
    text = re.sub(r'\x1b\[[0-9;]*[A-Za-z]', '', out).strip()
    match = re.search(r'\{.*\}', text, re.S)  # tolerate code fences around the object
    return json.loads(match.group(0) if match else text), text


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--hermes', default=os.environ.get('HERMES_BIN', 'hermes'))
    p.add_argument('--profile', default=os.environ.get('HERMES_PROFILE', 'ai-arch-dev'))
    p.add_argument('--goal', default=DEFAULT_GOAL)
    p.add_argument('--trials', type=int, default=3)
    p.add_argument('--timeout', type=int, default=900, help='seconds per Hermes call')
    p.add_argument('--max-turns', type=int, default=4, help='same as the engine (4); raise it to test whether turns run out')
    p.add_argument('--logs', default='hermes-probe-logs', help='folder for full Hermes output per trial')
    p.add_argument('--json', action='store_true')
    a = p.parse_args()
    logs = Path(a.logs).resolve()
    logs.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='hermes-probe-') as work:
        settings = Settings(project=Path(work), data=Path(work) / 'state', hermes=a.hermes, profile=a.profile, manager_timeout=a.timeout)
        hermes = Hermes(settings)
        trials = []
        for i in range(a.trials):
            start = time.monotonic()
            try:
                proposal, raw = run_hermes(hermes, settings, PROMPT + a.goal, a.max_turns, logs / f'trial-{i + 1}.log')
                problems = validate(proposal)
                trials.append({'ok': not problems, 'seconds': round(time.monotonic() - start, 1), 'problems': problems,
                               'mode': proposal.get('mode'), 'agents': [x.get('id') for x in proposal.get('agents', []) if isinstance(x, dict)],
                               'tasks': len(proposal.get('tasks', [])), 'proposal': proposal})
            except Exception as exc:
                trials.append({'ok': False, 'seconds': round(time.monotonic() - start, 1), 'problems': [str(exc)[:600]]})
            t = trials[-1]
            if not a.json:
                print(f"trial {i + 1}: {'VALID' if t['ok'] else 'INVALID'} in {t['seconds']}s"
                      + (f" · mode={t.get('mode')} agents={t.get('agents')} tasks={t.get('tasks')}" if 'mode' in t else '')
                      + (f"\n  problems: {t['problems']}" if t['problems'] else ''))
    valid = sum(t['ok'] for t in trials)
    if a.json:
        print(json.dumps({'goal': a.goal, 'valid': valid, 'trials': trials}, indent=2))
    else:
        print(f'\n{valid}/{len(trials)} proposals valid. Full Hermes output per trial: {logs}/')


if __name__ == '__main__':
    main()
