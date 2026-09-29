"""Model endpoints: registry, health checks, and a slot broker (M5).

The registry uses ai-arch's endpoint keys (url, model, api_key_ref, timeout_ms) so both
projects can describe the same model server, plus `slots`: how many requests the server
should get at once (llama-server `-np`). Keys are never stored here: `api_key_ref` names a
file in ai-arch's 0600 secret store, and the key is only read when a request is forwarded.

The broker is a priority queue in front of each endpoint. It is used by the optional
gateway (gateway.py), which is the only place AgentControl sees individual model requests.
Nothing here needs a paid provider: an empty registry simply turns these features off.
Standard library only.
"""
import contextlib
import heapq
import itertools
import json
import os
from pathlib import Path
import re
import threading
import time
import urllib.error
import urllib.request

# Lower runs first. Hermes plans in short bursts that the whole run waits on,
# so a planning request goes ahead of queued coding requests.
PRIORITY = {'orchestrator': 0, 'coder': 1, 'background': 2}
HEALTH_MAX_AGE = 5.0
ID_PATTERN = re.compile(r'^[a-z0-9][a-z0-9_-]{0,39}$')


class RegistryError(ValueError):
    pass


def _endpoint(raw, fallback_id):
    if not isinstance(raw, dict):
        raise RegistryError('Each endpoint must be an object')
    ident = str(raw.get('id') or fallback_id)
    url = str(raw.get('url') or '').rstrip('/')
    if not ID_PATTERN.match(ident):
        raise RegistryError(f'Endpoint id {ident!r} must be lowercase letters, digits, - or _')
    if not re.match(r'^https?://[^\s/]+', url):
        raise RegistryError(f'Endpoint {ident}: url must start with http:// or https://')
    slots = raw.get('slots', 1)
    if not isinstance(slots, int) or isinstance(slots, bool) or not 1 <= slots <= 16:
        raise RegistryError(f'Endpoint {ident}: slots must be a whole number from 1 to 16')
    costs = [raw.get('cost_per_mtok_in', 0), raw.get('cost_per_mtok_out', 0)]
    if any(not isinstance(c, (int, float)) or isinstance(c, bool) or c < 0 for c in costs):
        raise RegistryError(f'Endpoint {ident}: costs must be zero or positive numbers')
    return {'id': ident, 'url': url, 'model': str(raw.get('model') or ''), 'api_key_ref': str(raw.get('api_key_ref') or ''),
            'slots': slots, 'timeout_ms': int(raw.get('timeout_ms') or 600000),
            'paid': bool(raw.get('paid', False)), 'cost_per_mtok_in': float(costs[0]), 'cost_per_mtok_out': float(costs[1])}


def parse_registry(data):
    """Accept AgentControl's registry ({version, default, endpoints: [...]}) or an ai-arch.json
    file ({endpoint: {...}}), which becomes one endpoint named 'ai-arch'."""
    if not isinstance(data, dict):
        raise RegistryError('The model registry must be a JSON object')
    if 'endpoints' not in data and isinstance(data.get('endpoint'), dict):
        data = {'default': 'ai-arch', 'endpoints': [{**data['endpoint'], 'id': 'ai-arch'}]}
    raw = data.get('endpoints', [])
    if not isinstance(raw, list):
        raise RegistryError('endpoints must be a list')
    endpoints = [_endpoint(item, f'endpoint-{n + 1}') for n, item in enumerate(raw)]
    ids = [e['id'] for e in endpoints]
    if len(set(ids)) != len(ids):
        raise RegistryError('Endpoint ids must be unique')
    default = data.get('default') or (ids[0] if ids else None)
    if default is not None and default not in ids:
        raise RegistryError(f'Default endpoint {default!r} is not in the list')
    if default and next(e for e in endpoints if e['id'] == default)['paid']:
        raise RegistryError('The default endpoint must not be a paid provider. Pick a local model as the default.')
    return {'default': default, 'endpoints': endpoints}


def load_registry(path):
    """The registry at `path`, or an empty one (all model features off) if the file is absent."""
    path = Path(path).expanduser() if path else None
    if not path or not path.exists():
        return {'default': None, 'endpoints': [], 'source': str(path) if path else None}
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise RegistryError(f'{path} is not valid JSON: {exc.msg} at line {exc.lineno}') from exc
    return {**parse_registry(data), 'source': str(path)}


def secrets_dir():
    """ai-arch's secret store (aiarch_paths.cpp): $AIARCH_DATA_DIR/secrets or ~/.local/share/ai-arch/secrets."""
    base = os.environ.get('AIARCH_DATA_DIR') or str(Path.home() / '.local/share/ai-arch')
    return Path(base) / 'secrets'


def read_secret(ref, directory=None):
    """The value for an api_key_ref, named as ai-arch names it ([A-Za-z0-9._-], others become _).
    Refuses files that other users can read."""
    if not ref:
        return ''
    name = ''.join(c if c.isalnum() or c in '._-' else '_' for c in ref)
    path = Path(directory or secrets_dir()) / name
    if not path.is_file():
        raise RegistryError(f'Secret {ref!r} was not found in the ai-arch secret store')
    if path.stat().st_mode & 0o077:
        raise RegistryError(f'Secret {ref!r} is readable by other users; run chmod 600 on it')
    return path.read_text().strip()


def probe(endpoint, timeout=3.0, secret_dir=None):
    """GET <url>/v1/models. Returns a health dict; never raises."""
    started = time.monotonic()
    headers = {}
    try:
        key = read_secret(endpoint.get('api_key_ref'), secret_dir)
        if key:
            headers['Authorization'] = 'Bearer ' + key
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(urllib.request.Request(endpoint['url'] + '/v1/models', headers=headers), timeout=timeout) as response:
            body = json.loads(response.read() or b'{}')
        models = [m.get('id') for m in body.get('data', []) if isinstance(m, dict)]
        state = 'online'
        error = ''
        if endpoint.get('model') and models and endpoint['model'] not in models:
            state, error = 'wrong_model', f"Server is up but does not list the configured model {endpoint['model']}"
        return {'state': state, 'latency_ms': round((time.monotonic() - started) * 1000), 'models': models[:10],
                'error': error, 'checked': time.time()}
    except (OSError, ValueError, urllib.error.URLError, RegistryError) as exc:
        reason = getattr(exc, 'reason', None) or exc
        return {'state': 'offline', 'latency_ms': None, 'models': [], 'error': str(reason)[:300], 'checked': time.time()}


class Broker:
    """Per-endpoint slot limits with a priority queue, plus cached health checks."""

    def __init__(self, registry=None, prober=probe):
        self.registry = registry or {'default': None, 'endpoints': []}
        self.prober = prober
        self.lock = threading.Condition()
        self.seq = itertools.count()
        self.waiting = {e['id']: [] for e in self.endpoints}
        self.active = {e['id']: {} for e in self.endpoints}
        self.health_cache = {}
        self.on_change = None

    @property
    def endpoints(self):
        return self.registry['endpoints']

    @property
    def configured(self):
        return bool(self.endpoints)

    def endpoint(self, ident=None):
        ident = ident or self.registry.get('default')
        found = next((e for e in self.endpoints if e['id'] == ident), None)
        if found is None:
            raise KeyError(f'No model endpoint {ident!r}')
        return found

    def health(self, ident=None, max_age=HEALTH_MAX_AGE):
        endpoint = self.endpoint(ident)
        cached = self.health_cache.get(endpoint['id'])
        if cached and time.time() - cached['checked'] < max_age:
            return cached
        result = self.prober(endpoint)
        self.health_cache[endpoint['id']] = result
        self._changed()
        return result

    def _changed(self):
        if self.on_change:
            try:
                self.on_change()
            except Exception:
                pass

    @contextlib.contextmanager
    def slot(self, ident=None, agent='unknown', role='coder', cancel=None, timeout=None):
        """Wait for a free slot (highest priority first, then first come), hold it for the block.
        Yields a ticket with the time spent queued. Raises TimeoutError or InterruptedError."""
        endpoint = self.endpoint(ident)
        key = endpoint['id']
        ticket = {'id': next(self.seq), 'agent': agent, 'role': role, 'priority': PRIORITY.get(role, PRIORITY['background']),
                  'queued': time.time(), 'started': None}
        entry = (ticket['priority'], ticket['id'], ticket)
        deadline = time.monotonic() + timeout if timeout else None
        with self.lock:
            heapq.heappush(self.waiting[key], entry)
        self._changed()
        try:
            with self.lock:
                while True:
                    if self.waiting[key][0][1] == ticket['id'] and len(self.active[key]) < endpoint['slots']:
                        heapq.heappop(self.waiting[key])
                        ticket['started'] = time.time()
                        self.active[key][ticket['id']] = ticket
                        self.lock.notify_all()
                        break
                    if cancel and cancel():
                        raise InterruptedError('Cancelled while waiting for a model slot')
                    if deadline and time.monotonic() > deadline:
                        raise TimeoutError(f'No model slot on {key} within {timeout:.0f} s')
                    self.lock.wait(0.1)
        except BaseException:
            with self.lock:
                self.waiting[key] = [e for e in self.waiting[key] if e[1] != ticket['id']]
                heapq.heapify(self.waiting[key])
                self.lock.notify_all()
            self._changed()
            raise
        self._changed()
        try:
            yield {**ticket, 'queued_ms': round((ticket['started'] - ticket['queued']) * 1000)}
        finally:
            with self.lock:
                self.active[key].pop(ticket['id'], None)
                self.lock.notify_all()
            self._changed()

    def status(self):
        """For the dashboard: each endpoint's settings (never its key), health, and queue."""
        result = []
        with self.lock:
            for e in self.endpoints:
                queue = [t for _, _, t in sorted(self.waiting[e['id']])]
                result.append({**{k: e[k] for k in ('id', 'url', 'model', 'slots', 'paid')},
                               'has_key': bool(e['api_key_ref']), 'default': e['id'] == self.registry.get('default'),
                               'health': self.health_cache.get(e['id']),
                               'in_flight': [{'agent': t['agent'], 'since': t['started']} for t in self.active[e['id']].values()],
                               'queued': [{'agent': t['agent'], 'role': t['role'], 'since': t['queued']} for t in queue]})
        return result


def cost(endpoint, tokens_in, tokens_out):
    """Spend for paid providers; local endpoints are free (0)."""
    if not endpoint or not endpoint.get('paid'):
        return 0.0
    return round((tokens_in or 0) / 1e6 * endpoint['cost_per_mtok_in'] + (tokens_out or 0) / 1e6 * endpoint['cost_per_mtok_out'], 6)
