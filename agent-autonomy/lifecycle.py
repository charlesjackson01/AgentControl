"""Agent lifecycle events.

Agent state is derived from the run, its turns and its pending approvals (agents.live_state). This
tracker records each *change* of that derived state as an 'agent state' event in the journal, so
the events can never disagree with what the dashboard shows, and no run logic has to remember to
emit them. It only reads the journal and appends events; it never starts, stops or changes an agent.

Writes only mark a run dirty; one background thread recomputes dirty runs at most every
`interval` seconds, so the per-second transcript rewrites of a busy run cost little and nothing
runs on the writing thread. Standard library only.
"""
import json
import threading

import agents as agent_registry

KIND = 'agent state'
TERMINAL = agent_registry.TERMINAL
WATCHED = ('run', 'step', 'agent')


class StopEvent(threading.Event):
    """A threading.Event that also wakes listeners when set, so a waiting tracker stops at once."""
    def __init__(self):
        super().__init__()
        self.listeners = []

    def set(self):
        super().set()
        for wake in self.listeners:
            wake()


class Lifecycle:
    def __init__(self, store, profile='', interval=.5, shutdown=None):
        self.store = store
        self.profile = profile
        self.interval = interval
        self.shutdown = shutdown or threading.Event()
        self.lock = threading.Lock()
        self.work = threading.Lock()   # one computation at a time (the thread or a test's flush)
        self.dirty = set()
        self.known = {}                # run id -> {agent: (state, task)} last recorded
        self.wake = threading.Event()
        self.thread = None
        if hasattr(self.shutdown, 'listeners'):
            self.shutdown.listeners.append(self.wake.set)

    def start(self):
        if not self.thread:
            self.thread = threading.Thread(target=self._loop, name='agent-lifecycle', daemon=True)
            self.thread.start()

    def changed(self, kind, run):
        """Store listener hook: note that a run's state may have changed."""
        if kind in WATCHED and run:
            with self.lock:
                self.dirty.add(run)
            self.wake.set()

    def _loop(self):
        while not self.shutdown.is_set():
            self.wake.wait()
            if self.shutdown.is_set():
                break
            self.wake.clear()
            self.flush()
            self.shutdown.wait(self.interval)

    def flush(self):
        """Record the transitions of every dirty run now. Returns the events written."""
        with self.work:
            with self.lock:
                runs, self.dirty = self.dirty, set()
            written = []
            for ident in runs:
                try:
                    written += self._update(ident)
                except KeyError:
                    self.known.pop(ident, None)   # the run is gone
                except Exception:
                    pass  # lifecycle events are best effort; the derived state stays correct regardless
            return written

    def latest(self, ident):
        """{agent: {'to', 'from', 'task', 'created'}} from the latest recorded event per agent."""
        found = {}
        for event in self.store.latest_events(ident, KIND):
            try:
                detail = json.loads(event['detail'])
            except (TypeError, ValueError):
                continue
            name = detail.get('agent') if isinstance(detail, dict) else None
            if name and name not in found:
                found[name] = {**detail, 'created': event['created']}
        return found

    def _update(self, ident):
        run = self.store.get('runs', ident)
        recorded = self.store.agents(ident) or agent_registry.default_agents(run, self.profile)
        pending = [] if run['status'] in TERMINAL else [{**p, 'run': ident} for p in run.get('pending', [])]
        now = agent_registry.states(recorded, run, self.store.steps(ident), pending)
        if ident not in self.known:
            last = {name: (d.get('to'), d.get('task', '')) for name, d in self.latest(ident).items()}
            if run['status'] in TERMINAL and not last:
                # A finished run with no lifecycle history (older runs): never add history to it.
                self.known[ident] = now
                return []
            self.known[ident] = last
        changes = agent_registry.transitions(self.known[ident], now)
        for change in changes:
            self.store.event(ident, KIND, change)
        self.known[ident] = now
        return changes
