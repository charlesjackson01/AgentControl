import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from journal import MIGRATIONS, Store

# The schema written by AgentControl v4/v5 before journals were versioned.
LEGACY_SCHEMA = '''
CREATE TABLE runs (id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE steps (id TEXT PRIMARY KEY, run TEXT NOT NULL, value TEXT NOT NULL);
CREATE TABLE reviews (id TEXT PRIMARY KEY, run TEXT NOT NULL, value TEXT NOT NULL);
CREATE TABLE events (id INTEGER PRIMARY KEY, run TEXT, created TEXT, kind TEXT, detail TEXT);
'''


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'autonomy.sqlite3'

    def tearDown(self):
        self.temp.cleanup()

    def test_updating_an_older_run_keeps_newest_first_order(self):
        s = Store(self.path)
        s.put('runs', {'id': 'A', 'created': '2026-09-01T00:00:00+00:00'})
        s.put('runs', {'id': 'B', 'created': '2026-09-02T00:00:00+00:00'})
        s.update('runs', 'A', status='completed')
        self.assertEqual([r['id'] for r in s.runs()], ['B', 'A'])

    def test_updating_an_earlier_step_keeps_turn_order(self):
        s = Store(self.path)
        for n in (1, 2, 3):
            s.put('steps', {'id': f's{n}', 'run': 'A', 'number': n})
        s.update('steps', 's1', verified=True)
        s.update('steps', 's2', status='finished')
        self.assertEqual([x['number'] for x in s.steps('A')], [1, 2, 3])
        self.assertTrue(s.steps('A')[0]['verified'])

    def test_updated_reviews_keep_their_position(self):
        s = Store(self.path)
        for rid in ('r1', 'r2'):
            s.save_review({'run': 'A', 'kind': 'permission', 'request_id': rid, 'state': 'sent'})
        s.save_review({'run': 'A', 'kind': 'permission', 'request_id': 'r1', 'state': 'confirmed'})
        self.assertEqual([r['request_id'] for r in s.reviews('A')], ['r2', 'r1'])
        self.assertEqual(s.review('A', 'permission', 'r1')['state'], 'confirmed')

    def test_new_journal_is_stamped_with_the_latest_version(self):
        Store(self.path)
        with sqlite3.connect(self.path) as c:
            self.assertEqual(c.execute('PRAGMA user_version').fetchone()[0], len(MIGRATIONS))

    def test_unversioned_v5_journal_migrates_without_data_loss(self):
        with sqlite3.connect(self.path) as c:
            c.executescript(LEGACY_SCHEMA)
            c.execute('INSERT INTO runs VALUES (?,?)', ('old', json.dumps({'id': 'old', 'created': '2026-08-01T00:00:00+00:00', 'goal': 'kept'})))
            c.execute('INSERT INTO steps VALUES (?,?,?)', ('s1', 'old', json.dumps({'id': 's1', 'run': 'old', 'number': 1})))
            c.execute('INSERT INTO events(run,created,kind,detail) VALUES (?,?,?,?)', ('old', 'x', 'goal', 'kept'))
        s = Store(self.path)
        self.assertEqual(s.get('runs', 'old')['goal'], 'kept')
        self.assertEqual(len(s.steps('old')), 1)
        self.assertEqual(s.events('old')[0]['detail'], 'kept')
        with sqlite3.connect(self.path) as c:
            self.assertEqual(c.execute('PRAGMA user_version').fetchone()[0], len(MIGRATIONS))
        Store(self.path)  # reopening is a no-op
        self.assertEqual(len(s.runs()), 1)


if __name__ == '__main__':
    unittest.main()
