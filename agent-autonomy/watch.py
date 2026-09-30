"""Stuck-agent watch (J): asks TypeSafe's Jev whether a coder looks stuck. Advisory only.

After a coder's turn settles, and while a turn runs longer than `interval`, the watch sends Jev the
run's goal, the turn's title and the end of that turn's recorded transcript (the text and tool
parts AgentControl already stores; reasoning is never recorded), and asks two typed questions:
the probability the agent is stuck, and which pattern it most resembles.

Each check is appended to the journal as a 'watch' event naming the agent. An agent reads as
"possibly stuck" after two high checks in a row. The first time that happens you get a push
notification, and Hermes sees a note in its next decision. The watch never pauses, stops,
prompts or approves anything: Hermes and you decide what to do.

It runs only for runs you switched it on for (it sends run data to TypeSafe), only when a Jev
key is configured, within a per-run call budget, and not once the monthly spend cap is reached.
A failure records one "watch unavailable" event per run and the run carries on as if the watch
were off. Standard library only.
"""
import json
import threading
import time

from adapters import jev as jev_api
import agents as agent_registry

KIND = 'watch'
MAX_CALLS = 60                 # per run
TAIL_PARTS = 40
TAIL_CHARS = 12_000
WATCHED_ROLES = ('coder', 'tester')

STUCK = ('The agent is stuck: it keeps repeating the same actions or hitting the same errors, '
         'without making progress toward its task.')
PATTERNS = {
    'repeating_failure': 'The same failure recurs after each attempt.',
    'undo_redo': 'The agent keeps undoing and redoing the same change.',
    'tool_errors': 'Tools keep failing (bad commands, missing files, wrong paths).',
    'waiting_or_idle': 'The agent is waiting or doing nothing useful.',
    'progressing': 'Each attempt changes the outcome; the agent is making progress.',
}
QUESTIONS = {'stuck': jev_api.noul(STUCK), 'pattern': jev_api.choice(PATTERNS)}
LABELS = {'repeating_failure': 'the same failure keeps recurring', 'undo_redo': 'undoing and redoing the same change',
          'tool_errors': 'tools keep failing', 'waiting_or_idle': 'waiting or idle', 'progressing': 'progressing'}


def tail(parts, max_parts=TAIL_PARTS, max_chars=TAIL_CHARS):
    """The end of a turn's transcript as plain text, newest last, within the size limits."""
    lines = []
    for part in (parts or [])[-max_parts:]:
        if part.get('type') == 'tool':
            head = f"[{part.get('tool', 'tool')} {part.get('status', '')}] {part.get('summary') or part.get('title') or ''}".rstrip()
            output = (part.get('output') or '').strip()
            lines.append(head + ('\n' + output[-800:] if output else ''))
        elif part.get('type') == 'text' and part.get('text'):
            lines.append(part['text'].strip()[-1500:])
    text = '\n\n'.join(lines)
    return text[-max_chars:]


def state_text(run, step, earlier):
    """What Jev reads: the goal, the task, recent verification outcomes and the transcript tail."""
    results = [f"turn {s['number']}: {(s.get('verification') or {}).get('status', 'not verified')}" for s in earlier[-3:]]
    return '\n'.join([
        'An AI coding agent is working on a task. Judge only from this record.',
        'Goal: ' + run['goal'][:2000],
        f"Current task (turn {step['number']}): {step.get('title', '')[:300]}",
        'Earlier turns by this agent: ' + ('; '.join(results) if results else 'none'),
        '',
        'End of the current turn (oldest first):',
        tail(step.get('transcript')) or '(nothing recorded yet)',
    ])


def checks(events):
    """{agent: [check, ...]} oldest first, from 'watch' events (newest first, as the journal returns them)."""
    found = {}
    for event in reversed(events):
        try:
            detail = json.loads(event['detail'])
        except (TypeError, ValueError):
            continue
        if isinstance(detail, dict) and detail.get('agent') and 'probability' in detail:
            found.setdefault(detail['agent'], []).append({**detail, 'created': event['created']})
    return found


def summary(agent_checks):
    """What the dashboard and Hermes see for one agent: the latest check and whether it looks stuck."""
    if not agent_checks:
        return None
    last = agent_checks[-1]
    suspected = len(agent_checks) >= 2 and all(c.get('high') for c in agent_checks[-2:])
    return {'probability': last['probability'], 'pattern': last.get('pattern'), 'label': LABELS.get(last.get('pattern'), ''),
            'confidence': last.get('confidence'), 'at': last['created'], 'step': last.get('step'), 'suspected': suspected,
            'checks': len(agent_checks)}


class Watch:
    """Runs the checks for a Controller. `client` is an adapters.jev.Jev, or None when no key is configured."""

    def __init__(self, controller, client, threshold=0.8, interval=600, poll=30):
        self.c = controller
        self.client = client
        self.threshold = threshold
        self.interval = interval
        self.poll = poll
        self.lock = threading.Lock()
        self.busy = set()           # step ids with a check in flight
        self.unavailable = set()    # runs that already recorded "watch unavailable"

    @property
    def available(self):
        return self.client is not None

    def enabled(self, run):
        return bool(self.client and run and run.get('watch'))

    def summaries(self, run_id):
        found = checks(self.c.store.latest_events(run_id, KIND, 200))
        return {agent: summary(items) for agent, items in found.items()}

    def _calls(self, run_id):
        return sum(1 for _ in self.c.store.latest_events(run_id, KIND, MAX_CALLS + 1))

    def _blocked(self, run):
        """Why no call may be made now, or ''."""
        if self._calls(run['id']) >= MAX_CALLS:
            return f'the watch used its {MAX_CALLS} checks for this run'
        status = self.c.spend_status(run)
        if status['monthly_cap'] is not None and status['month'] >= status['monthly_cap']:
            return f"the monthly spend cap is reached (${status['month']:.4f} of ${status['monthly_cap']:.2f})"
        if run.get('spend_cap') is not None and status['run'] >= run['spend_cap']:
            return f"this run's spend cap is reached (${status['run']:.4f} of ${run['spend_cap']:.2f})"
        return ''

    def _off(self, run_id, reason):
        if run_id in self.unavailable:
            return
        self.unavailable.add(run_id)
        self.c.store.event(run_id, 'watch unavailable', f'Stuck watch skipped: {reason}. The run carries on without it.')

    def check(self, run_id, step_id, when='settled'):
        """One check of one turn. Returns the recorded check, or None. Never raises into the run."""
        with self.lock:
            if step_id in self.busy:
                return None
            self.busy.add(step_id)
        try:
            return self._check(run_id, step_id, when)
        except Exception as exc:   # the watch must never break a run
            self._off(run_id, f'an internal error ({type(exc).__name__}: {exc})')
            return None
        finally:
            with self.lock:
                self.busy.discard(step_id)

    def _check(self, run_id, step_id, when):
        run = self.c.store.get('runs', run_id)
        if not self.enabled(run):
            return None
        step = self.c.store.get('steps', step_id)
        agent = step.get('agent', 'coder-1')
        role = step.get('role') or agent_registry.role_of(agent)
        if role not in WATCHED_ROLES or not step.get('transcript'):
            return None
        reason = self._blocked(run)
        if reason:
            self._off(run_id, reason)
            return None
        earlier = [s for s in self.c.store.steps(run_id) if s.get('agent', 'coder-1') == agent and s['number'] < step['number']]
        answers, info = self.client.ask(state_text(run, step, earlier), QUESTIONS)
        self.c.store.usage_add({'run': run_id, 'agent': agent, 'source': 'jev', 'endpoint': 'jev', 'model': info['model'],
                                'tokens_in': info['tokens_in'], 'tokens_out': info['tokens_out'], 'duration_ms': info['duration_ms'],
                                'status': 'ok' if answers else 'error', 'cost': info['cost'] if answers else 0.0,
                                'ref': 'jev:' + info['request_id'] if info['request_id'] else None})
        if answers is None:
            self._off(run_id, info['error'])
            return None
        before = summary(checks(self.c.store.latest_events(run_id, KIND, 200)).get(agent, []))
        probability = answers['stuck']['probability']
        record = {'agent': agent, 'step': step_id, 'turn': step['number'], 'when': when,
                  'probability': round(probability, 4), 'high': probability >= self.threshold,
                  'pattern': answers['pattern']['choice'], 'confidence': round(answers['pattern']['confidence'], 4),
                  'model': info['model']}
        self.c.store.event(run_id, KIND, record)
        after = summary(checks(self.c.store.latest_events(run_id, KIND, 200)).get(agent, []))
        if after and after['suspected'] and not (before and before['suspected']):
            note = f"{agent} is possibly stuck ({probability:.2f}, {after['label']}). Advisory from Jev; nothing was changed."
            self.c.store.event(run_id, 'watch alert', {'agent': agent, 'text': note})
            self.c._push(run_id, note)
        return record

    def context(self, run_id):
        """Notes for Hermes about agents that look stuck, or None."""
        flagged = {agent: s for agent, s in self.summaries(run_id).items() if s and s['suspected']}
        if not flagged:
            return None
        return {'note': ('An automatic watch (TypeSafe Jev, advisory) judged these agents likely stuck on their last two checks. '
                         'Consider a different approach, a smaller step, or asking the person. It may be wrong.'),
                'agents': {a: {'probability': s['probability'], 'pattern': s['label']} for a, s in flagged.items()}}

    def loop(self, stop, pending=('running', 'waiting')):
        """Background: check turns that have run longer than `interval`, at most once per interval each."""
        last = {}
        while not stop.wait(self.poll):
            if not self.client:
                continue
            try:
                for run in self.c.store.runs()[:5]:
                    if not self.enabled(run) or run['status'] in agent_registry.TERMINAL:
                        continue
                    for step in self.c.store.steps(run['id']):
                        if step['status'] not in pending or not step.get('started'):
                            continue
                        age = time.time() - step['started']
                        if age >= self.interval and time.time() - last.get(step['id'], 0) >= self.interval:
                            last[step['id']] = time.time()
                            self.check(run['id'], step['id'], when='long turn')
            except Exception:
                continue
