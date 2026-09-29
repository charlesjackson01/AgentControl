"""Durable run journal: SQLite with WAL, JSON documents, and versioned migrations."""
import contextlib
from datetime import datetime, timezone
import json
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


# Append new migrations here; never edit an applied one. Index + 1 = schema version.
MIGRATIONS = [_v1]


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

    def steps(self, run):
        """Steps in turn order."""
        with self.connection() as c:
            rows = [json.loads(row[0]) for row in c.execute('SELECT value FROM steps WHERE run=? ORDER BY rowid', (run,))]
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

    def reviews(self, run):
        with self.connection() as c:
            return [json.loads(r[0]) for r in c.execute('SELECT value FROM reviews WHERE run=? ORDER BY rowid DESC', (run,))]
