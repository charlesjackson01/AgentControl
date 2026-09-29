"""Durable run journal: SQLite with WAL, JSON documents, and versioned migrations."""
import contextlib
from datetime import datetime, timezone
import hashlib
import json
import zlib
from pathlib import Path
import sqlite3
import threading


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def _v1(c):
    """The original schema (AgentControl v4/v5)."""
    c.executescript('''
        CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS steps (id TEXT PRIMARY KEY, run TEXT NOT NULL, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, run TEXT NOT NULL, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, run TEXT, created TEXT, kind TEXT, detail TEXT);''')


def _v2(c):
    """Per-run agent identities (M3)."""
    c.execute('CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, run TEXT NOT NULL, value TEXT NOT NULL)')


def _v3(c):
    """Append-only, hash-chained audit log of permission decisions (M4)."""
    c.execute('''CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, run TEXT, created TEXT NOT NULL,
                 entry TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL)''')


def _v4(c):
    """Model usage per call: who, which endpoint, tokens, time, and cost (M5)."""
    c.execute('''CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY AUTOINCREMENT, run TEXT, agent TEXT, source TEXT,
                 endpoint TEXT, model TEXT, created TEXT NOT NULL, tokens_in INTEGER, tokens_out INTEGER,
                 duration_ms INTEGER, queued_ms INTEGER, status TEXT, cost REAL, ref TEXT)''')
    c.execute('CREATE UNIQUE INDEX IF NOT EXISTS usage_ref ON usage(ref) WHERE ref IS NOT NULL')
    c.execute('CREATE INDEX IF NOT EXISTS usage_run ON usage(run)')


def _v5(c):
    """Capabilities (M9): skill install proposals and installs, and the exact versions you trusted."""
    c.executescript('''
        CREATE TABLE IF NOT EXISTS capabilities (id TEXT PRIMARY KEY, run TEXT, created TEXT NOT NULL, value TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS capabilities_run ON capabilities(run);
        CREATE TABLE IF NOT EXISTS trusted_skills (hash TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT, approved TEXT NOT NULL);''')


def _v6(c):
    """Usage by period (M12 cost reporting and the monthly spend cap)."""
    c.execute('CREATE INDEX IF NOT EXISTS usage_created ON usage(created)')


# Append new migrations here; never edit an applied one. Index + 1 = schema version.
MIGRATIONS = [_v1, _v2, _v3, _v4, _v5, _v6]
USAGE_FIELDS = ('run', 'agent', 'source', 'endpoint', 'model', 'tokens_in', 'tokens_out', 'duration_ms', 'queued_ms', 'status', 'cost', 'ref')
GENESIS = '0' * 64


def audit_hash(prev_hash, run, created, entry_json):
    return hashlib.sha256('\n'.join((prev_hash, run or '', created, entry_json)).encode()).hexdigest()


def migrate(c):
    """Bring a journal up to the latest schema. Journals from before versioning report 0 and get v1,
    which only creates tables that do not exist yet, so existing data is untouched."""
    version = c.execute('PRAGMA user_version').fetchone()[0]
    for number, step in enumerate(MIGRATIONS[version:], start=version + 1):
        step(c)
        c.execute(f'PRAGMA user_version = {number}')
    return c.execute('PRAGMA user_version').fetchone()[0]


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        # Optional callback(kind, run_id) after every write; the controller wires it to the event bus.
        self.listener = None
        with self.connection() as c:
            c.execute('PRAGMA journal_mode=WAL')
            migrate(c)

    @contextlib.contextmanager
    def connection(self):
        with self.lock:
            c = sqlite3.connect(self.path, timeout=10)
            try:
                yield c
                c.commit()
            finally:
                c.close()

    def _changed(self, kind, run):
        if self.listener:
            try:
                self.listener(kind, run)
            except Exception:
                pass  # live updates are best effort; never fail a journal write because of them

    def put(self, table, value):
        assert table in ('runs', 'steps')
        with self.connection() as c:
            # An upsert updates the row in place. INSERT OR REPLACE deleted and
            # re-inserted it, which moved updated runs and steps out of order.
            if table == 'runs':
                c.execute('INSERT INTO runs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
                          (value['id'], json.dumps(value)))
            else:
                c.execute('INSERT INTO steps VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET run=excluded.run, value=excluded.value',
                          (value['id'], value['run'], json.dumps(value)))
        self._changed('run' if table == 'runs' else 'step', value['id'] if table == 'runs' else value['run'])
        return value

    def get(self, table, ident):
        assert table in ('runs', 'steps')
        with self.connection() as c:
            row = c.execute(f'SELECT value FROM {table} WHERE id=?', (ident,)).fetchone()
        if not row:
            raise KeyError(ident)
        return json.loads(row[0])

    def update(self, table, ident, **changes):
        with self.lock:
            item = self.get(table, ident)
            item.update(changes)
            return self.put(table, item)

    def discard_prepared_step(self, ident):
        with self.connection() as c:
            item = json.loads(c.execute('SELECT value FROM steps WHERE id=?', (ident,)).fetchone()[0])
            if item['status'] != 'prepared':
                raise ValueError('Only an unsubmitted draft may be discarded')
            c.execute('DELETE FROM steps WHERE id=?', (ident,))
        self._changed('step', item.get('run'))

    def runs(self):
        """Newest run first, by creation time (journals written before v2 may have shuffled rowids)."""
        with self.connection() as c:
            rows = [json.loads(row[0]) for row in c.execute('SELECT value FROM runs ORDER BY rowid DESC')]
        return sorted(rows, key=lambda r: r.get('created', ''), reverse=True)

    def steps(self, run, revisions=False):
        """Steps in turn order. With `revisions`, each step carries `rev`, a checksum of its stored
        row, so a client can tell which turns changed since it last asked (W3 deltas)."""
        with self.connection() as c:
            raw = [row[0] for row in c.execute('SELECT value FROM steps WHERE run=? ORDER BY rowid', (run,))]
        rows = [json.loads(text) | ({'rev': zlib.crc32(text.encode())} if revisions else {}) for text in raw]
        return sorted(rows, key=lambda s: s.get('number', 0))

    def step_count(self, run):
        with self.connection() as c:
            return c.execute('SELECT COUNT(*) FROM steps WHERE run=?', (run,)).fetchone()[0]

    def event(self, run, kind, detail):
        if not isinstance(detail, str):
            detail = json.dumps(detail, ensure_ascii=False)
        with self.connection() as c:
            c.execute('INSERT INTO events(run,created,kind,detail) VALUES(?,?,?,?)', (run, now(), kind, detail))
        self._changed('event', run)

    def events(self, run, limit=100):
        with self.connection() as c:
            rows = c.execute('SELECT id,created,kind,detail FROM events WHERE run=? ORDER BY id DESC LIMIT ?', (run, limit)).fetchall()
        return [dict(zip(('id', 'created', 'kind', 'detail'), r)) for r in reversed(rows)]

    def latest_events(self, run, kind, limit=300):
        """The most recent events of one kind for a run, newest first."""
        with self.connection() as c:
            rows = c.execute('SELECT id,created,kind,detail FROM events WHERE run=? AND kind=? ORDER BY id DESC LIMIT ?',
                             (run, kind, limit)).fetchall()
        return [dict(zip(('id', 'created', 'kind', 'detail'), r)) for r in rows]

    def review(self, run, kind, request):
        key = f'{run}:{kind}:{request}'
        with self.connection() as c:
            row = c.execute('SELECT value FROM reviews WHERE id=?', (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def save_review(self, item):
        key = f"{item['run']}:{item['kind']}:{item['request_id']}"
        with self.connection() as c:
            c.execute('INSERT INTO reviews VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET run=excluded.run, value=excluded.value',
                      (key, item['run'], json.dumps(item)))
        self._changed('review', item['run'])
        return item

    def audit_append(self, run, entry):
        """Append one audit entry. Each entry's hash covers the previous hash, so an edited,
        removed, or reordered entry breaks the chain (see audit_verify). There is no update or delete."""
        entry_json = json.dumps(entry, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
        created = now()
        with self.connection() as c:
            last = c.execute('SELECT hash FROM audit ORDER BY seq DESC LIMIT 1').fetchone()
            prev = last[0] if last else GENESIS
            digest = audit_hash(prev, run, created, entry_json)
            seq = c.execute('INSERT INTO audit(run,created,entry,prev_hash,hash) VALUES(?,?,?,?,?)',
                            (run, created, entry_json, prev, digest)).lastrowid
        self._changed('audit', run)
        return {'seq': seq, 'run': run, 'created': created, **entry}

    def audit(self, run=None, limit=500):
        with self.connection() as c:
            query = 'SELECT seq,run,created,entry FROM audit' + (' WHERE run=?' if run else '') + ' ORDER BY seq DESC LIMIT ?'
            rows = c.execute(query, ((run,) if run else ()) + (limit,)).fetchall()
        return [{'seq': s, 'run': r, 'created': t, **json.loads(e)} for s, r, t, e in reversed(rows)]

    def audit_verify(self):
        """(True, None) if the whole chain is intact, else (False, first bad seq)."""
        prev = GENESIS
        with self.connection() as c:
            for seq, run, created, entry, prev_hash, digest in c.execute('SELECT seq,run,created,entry,prev_hash,hash FROM audit ORDER BY seq'):
                if prev_hash != prev or audit_hash(prev, run, created, entry) != digest:
                    return False, seq
                prev = digest
        return True, None

    def usage_add(self, record):
        """Record one model call. A `ref` (e.g. an OpenCode message id) makes the write idempotent."""
        values = [record.get(k) for k in USAGE_FIELDS]
        with self.connection() as c:
            c.execute(f'INSERT OR IGNORE INTO usage(created,{",".join(USAGE_FIELDS)}) VALUES (?{",?" * len(USAGE_FIELDS)})',
                      [record.get('created') or now()] + values)
        self._changed('usage', record.get('run'))

    def usage(self, run=None, limit=200):
        with self.connection() as c:
            query = f'SELECT id,created,{",".join(USAGE_FIELDS)} FROM usage' + (' WHERE run=?' if run else '') + ' ORDER BY id DESC LIMIT ?'
            rows = c.execute(query, ((run,) if run else ()) + (limit,)).fetchall()
        return [dict(zip(('id', 'created') + USAGE_FIELDS, r)) for r in reversed(rows)]

    def usage_summary(self, run=None):
        """Totals and per-agent totals for a run (or everything)."""
        with self.connection() as c:
            where, args = (' WHERE run=?', (run,)) if run else ('', ())
            rows = c.execute('SELECT agent, COUNT(*), COALESCE(SUM(tokens_in),0), COALESCE(SUM(tokens_out),0), COALESCE(SUM(duration_ms),0),'
                             ' COALESCE(SUM(queued_ms),0), COALESCE(SUM(cost),0) FROM usage' + where + ' GROUP BY agent ORDER BY agent', args).fetchall()
        keys = ('calls', 'tokens_in', 'tokens_out', 'duration_ms', 'queued_ms', 'cost')
        by_agent = {agent or 'unknown': dict(zip(keys, values)) for agent, *values in rows}
        total = {k: sum(a[k] for a in by_agent.values()) for k in keys}
        total['cost'] = round(total['cost'], 6)
        return {'total': total, 'by_agent': by_agent}

    def usage_period(self, since=None):
        """Usage since a timestamp (or ever), by run, agent and endpoint, for the cost report."""
        where, args = (' WHERE created >= ?', (since,)) if since else ('', ())
        with self.connection() as c:
            rows = c.execute('SELECT run, agent, endpoint, COUNT(*), COALESCE(SUM(tokens_in),0), COALESCE(SUM(tokens_out),0),'
                             ' COALESCE(SUM(cost),0), MIN(created), MAX(created) FROM usage' + where
                             + ' GROUP BY run, agent, endpoint ORDER BY MAX(created) DESC', args).fetchall()
        keys = ('run', 'agent', 'endpoint', 'calls', 'tokens_in', 'tokens_out', 'cost', 'first', 'last')
        return [dict(zip(keys, r)) for r in rows]

    def spend(self, run=None, since=None):
        """Money spent on paid calls, for one run and/or since a timestamp."""
        clauses, args = ['cost > 0'], []
        if run:
            clauses.append('run = ?')
            args.append(run)
        if since:
            clauses.append('created >= ?')
            args.append(since)
        with self.connection() as c:
            return round(c.execute('SELECT COALESCE(SUM(cost),0) FROM usage WHERE ' + ' AND '.join(clauses), args).fetchone()[0], 6)

    def put_capability(self, item):
        with self.connection() as c:
            c.execute('INSERT INTO capabilities VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
                      (item['id'], item.get('run'), item['created'], json.dumps(item)))
        self._changed('capability', item.get('run'))
        return item

    def capability(self, ident):
        with self.connection() as c:
            row = c.execute('SELECT value FROM capabilities WHERE id=?', (ident,)).fetchone()
        if not row:
            raise KeyError(ident)
        return json.loads(row[0])

    def capabilities(self, run=None, limit=200):
        with self.connection() as c:
            query = 'SELECT value FROM capabilities' + (' WHERE run=?' if run else '') + ' ORDER BY created DESC, rowid DESC LIMIT ?'
            return [json.loads(r[0]) for r in c.execute(query, ((run,) if run else ()) + (limit,))]

    def trust(self, digest, name, source):
        with self.connection() as c:
            c.execute('INSERT OR IGNORE INTO trusted_skills VALUES (?,?,?,?)', (digest, name, source, now()))

    def trusted(self, digest):
        with self.connection() as c:
            return c.execute('SELECT 1 FROM trusted_skills WHERE hash=?', (digest,)).fetchone() is not None

    def put_agent(self, agent):
        with self.connection() as c:
            c.execute('INSERT INTO agents VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET run=excluded.run, value=excluded.value',
                      (agent['id'], agent['run'], json.dumps(agent)))
        self._changed('agent', agent['run'])
        return agent

    def agents(self, run):
        """A run's agents in the order they joined."""
        with self.connection() as c:
            return [json.loads(r[0]) for r in c.execute('SELECT value FROM agents WHERE run=? ORDER BY rowid', (run,))]

    def reviews(self, run):
        with self.connection() as c:
            return [json.loads(r[0]) for r in c.execute('SELECT value FROM reviews WHERE run=? ORDER BY rowid DESC', (run,))]
