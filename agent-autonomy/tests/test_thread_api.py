"""Authenticated read model routes over a durable test journal."""
import json
from pathlib import Path
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import handler
import conversation as cv
import test_workflow as workflow
from test_conversation import run, step, packet


class ThreadAPITests(unittest.TestCase):
    def setUp(self):
        self.helper = workflow.WorkflowTests()
        self.helper.setUp()
        self.controller, _ = self.helper.controller([])
        # Keep this fixture journal quiescent: no execution or background lifecycle writes.
        self.controller.shutdown.set()
        for worker in self.controller.threads.values():
            worker.join(2)
        self.store = self.controller.store
        self.project = str(self.controller.s.project)
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), handler(self.controller, 'test-key'))
        self.server_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.server_thread.start()
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.url = 'http://127.0.0.1:' + str(self.server.server_port)

    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.server_thread.join(2)
        self.helper.tearDown()

    def raw(self, path, authorized=True):
        request = urllib.request.Request(self.url + path, headers={'Authorization': 'Bearer test-key'} if authorized else {})
        with self.opener.open(request) as response:
            self.assertEqual(response.headers['Cache-Control'], 'no-store')
            self.assertEqual(response.headers['X-Content-Type-Options'], 'nosniff')
            self.assertEqual(response.headers['X-Frame-Options'], 'DENY')
            return response.read()

    def get(self, path, **query):
        return json.loads(self.raw(path + ('?' + urllib.parse.urlencode(query) if query else '')))

    def save_run(self, ident='single', **fields):
        value = run(ident, project=self.project, **fields)
        self.store.put('runs', value)
        return value

    def counts(self):
        with self.store.connection() as c:
            names = [row[0] for row in c.execute("SELECT name FROM sqlite_master WHERE type='table'")]
            return {name: c.execute('SELECT COUNT(*) FROM "' + name.replace('"', '""') + '"').fetchone()[0] for name in names}

    def test_auth_and_error_codes(self):
        for endpoint in ('/api/channels', '/api/thread'):
            with self.assertRaises(urllib.error.HTTPError) as error:self.raw(endpoint, authorized=False)
            self.assertEqual(error.exception.code, 401)
        for query, code in [({'session': 'missing'}, 404), ({'session': ''}, 404),
                            ({'channel': 'main', 'session': 'single'}, 400), ({'channel': 'other'}, 400),
                            ({'channel': ''}, 400), ({'before': 'invalid'}, 400), ({'before': ''}, 400)]:
            with self.subTest(query=query), self.assertRaises(urllib.error.HTTPError) as error:self.get('/api/thread', **query)
            self.assertEqual(error.exception.code, code)

    def test_channel_counts_active_waiting_and_updated(self):
        self.save_run('old', status='completed', created='2026-09-29', ended='2026-09-29')
        self.save_run(pending=[packet()], team={'state': 'proposed'})
        s = step('research', agent='researcher-1', status='awaiting_approval', request={'fingerprint': 'fp', 'question': 'Docs'}, created='2026-09-30T13:00:00+00:00')
        self.store.put('steps', s)
        self.store.put_capability({'id': 'cap1', 'run': 'single', 'created': run()['created'], 'state': 'awaiting_fetch'})
        self.store.put_capability({'id': 'cap2', 'run': 'single', 'created': run()['created'], 'state': 'proposed'})
        self.store.put_capability({'id': 'cap3', 'run': 'single', 'created': run()['created'], 'state': 'installed'})
        self.store.event('single', 'goal', 'Build CLI')
        with self.store.connection() as c:c.execute("UPDATE events SET created='2026-09-30T12:30:00+00:00'")
        result = self.get('/api/channels')
        self.assertEqual(result['project'], self.project)
        self.assertEqual(result['channels'], [{'id': 'main', 'kind': 'project', 'title': Path(self.project).name,
            'sessions': 2, 'active_session': 'single', 'waiting': 5, 'updated': s['created']}])
        thread = self.get('/api/thread')
        self.assertEqual(thread['live'], {'session': 'single', 'phase': 'code', 'status': 'coding'})

    def populate_paging(self):
        expected = set()
        for i in range(3):
            ident = f'r{i}'
            self.save_run(ident, created=f'2026-09-2{i}T12:00:00+00:00', status='completed', ended=f'2026-09-2{i}T12:59:00+00:00')
            expected.update(('run:' + ident, 'out:' + ident))
            self.store.put('steps', step('s'+str(i), run=ident, created=f'2026-09-2{i}T12:01:00+00:00'))
            expected.add('turn:s'+str(i))
            with self.store.connection() as c:
                for j in range(220):
                    # Equal-second event ties exercise source_seq, not merely timestamps.
                    cur = c.execute('INSERT INTO events(run,created,kind,detail) VALUES(?,?,?,?)', (ident, f'2026-09-2{i}T12:02:00+00:00', 'control', str(j)))
                    expected.add('ev:' + str(cur.lastrowid))
            self.store.event(ident, 'Hermes request', 'PRIVATE')
            self.store.event(ident, 'OpenCode tool', 'PRIVATE')
        return expected

    def test_paging_every_message_once_stable_order_and_session_metadata(self):
        expected = self.populate_paging()
        before = None;pages = [];seen = set()
        while True:
            result = self.get('/api/thread', limit=100, **({'before': before} if before else {}))
            self.assertLessEqual(len(result['messages']), 100)
            self.assertEqual({s['id'] for s in result['sessions']}, {m['session'] for m in result['messages']})
            sessions = {s['id']: s for s in result['sessions']}
            order = [cv.position(sessions[m['session']], m) for m in result['messages']]
            self.assertEqual(order, sorted(order))
            for m in result['messages']:
                self.assertNotIn(m['id'], seen);seen.add(m['id'])
            repeat = self.get('/api/thread', limit=100, **({'before': before} if before else {}))
            self.assertEqual(result, repeat)
            pages.insert(0, result)
            before = result['before']
            if before is None:break
        self.assertEqual(seen, expected)
        positions = []
        for page in pages:
            sessions = {s['id']: s for s in page['sessions']}
            positions.extend(cv.position(sessions[m['session']], m) for m in page['messages'])
        self.assertEqual(positions, sorted(positions))
        self.assertEqual(pages[0]['live'], {'session': None, 'phase': None, 'status': None})
        # Appending to the newest session does not shift an older cursor boundary.
        old_page = self.get('/api/thread', before=pages[-1]['before'], limit=100)
        self.store.event('r2', 'control', 'New change')
        self.assertEqual(self.get('/api/thread', before=pages[-1]['before'], limit=100), old_page)

    def test_known_stubs_and_new_event(self):
        self.save_run();self.store.event('single', 'goal', 'Build CLI');self.store.put('steps', step())
        result = self.get('/api/thread')
        known = ','.join(m['id'] + ':' + str(m['rev']) for m in result['messages'])
        stubs = self.get('/api/thread', known='malformed,x:bad,' + known)
        self.assertTrue(all(set(m) == {'id', 'rev', 'same'} and m['same'] for m in stubs['messages']))
        self.store.event('single', 'user instruction', 'Add tests')
        self.store.update('steps', 'step1', result='Updated result')
        result = self.get('/api/thread', known=known)
        full = [m for m in result['messages'] if not m.get('same')]
        self.assertEqual({m['kind'] for m in full}, {'note', 'turn'})
        self.assertEqual(next(m for m in full if m['kind'] == 'turn')['detail']['result_tail'], 'Updated result')

    def test_read_only_state_bytes_counts_audit_and_rows(self):
        self.save_run();self.store.put('steps', step());self.store.event('single', 'goal', 'Build CLI')
        self.store.audit_append('single', {'action': 'created', 'actor': 'you'})
        counts = self.counts();audit = self.store.audit('single')
        def rows():
            with self.store.connection() as c:
                return {name:list(c.execute('SELECT * FROM ' + name)) for name in ('runs', 'steps', 'events', 'reviews', 'capabilities', 'audit', 'agents')}
        before_rows = rows();state = self.raw('/api/state')
        for _ in range(2):self.get('/api/channels');self.get('/api/thread')
        self.assertEqual(self.raw('/api/state'), state)
        self.assertEqual(self.counts(), counts);self.assertEqual(rows(), before_rows)
        self.assertEqual(self.store.audit('single'), audit)

    def test_other_project_and_legacy_membership(self):
        self.save_run('here', status='completed')
        other = run('other', project='/other', status='completed')
        self.store.put('runs', other)
        self.store.put('runs', run('legacy', project=None, status='completed'))
        self.store.put('runs', run('active_elsewhere', project='/other'))
        room = self.get('/api/thread')
        self.assertEqual({s['id'] for s in room['sessions']}, {'here', 'active_elsewhere'})
        focused = self.get('/api/thread', session='other')
        self.assertEqual([s['id'] for s in focused['sessions']], ['other'])
        self.assertEqual(self.get('/api/channels')['channels'][0]['sessions'], 2)

    def test_limit_clamping_empty_room_and_known_entry_cap(self):
        empty = self.get('/api/thread')
        self.assertEqual((empty['sessions'], empty['messages'], empty['before']), ([], [], None))
        self.assertIsNone(self.get('/api/channels')['channels'][0]['updated'])
        self.save_run()
        with self.store.connection() as c:
            c.executemany('INSERT INTO events(run,created,kind,detail) VALUES(?,?,?,?)', [('single', run()['created'], 'control', str(i)) for i in range(610)])
        for value, expected in [('0', 1), ('-10', 1), ('999', 500), ('bad', 200)]:
            self.assertEqual(len(self.get('/api/thread', limit=value)['messages']), expected)
        m = self.get('/api/thread', limit=1)['messages'][0]
        known = ','.join(['a:1']*2000 + [m['id'] + ':' + str(m['rev'])])
        self.assertNotIn('same', self.get('/api/thread', limit=1, known=known)['messages'][0])

    def test_public_single_and_team_shapes(self):
        self.save_run('single', status='completed', summary='CLI complete', ended='2026-09-30T12:05:00+00:00')
        self.store.put('steps', step())
        self.store.event('single', 'goal', 'Build CLI')
        self.store.event('single', 'Hermes decision', {'summary': 'Implement CLI', 'action': 'code', 'plan': ['Build', 'Test'], 'title': 'CLI', 'prompt': 'PRIVATE'})
        self.save_run('team', mode='team', created='2026-09-30T13:00:00+00:00', status='awaiting_approval', team={'state': 'proposed', 'proposal': {'agents': [{'name': 'coder-1', 'role': 'coder'}], 'tasks': [{'id': 'cli', 'title': 'Implement CLI'}]}, 'warnings': []})
        self.store.event('team', 'team proposal', 'CLI team')
        result = self.get('/api/thread')
        self.assertEqual([s['mode'] for s in result['sessions']], ['single', 'team'])
        proposal = next(m for m in result['messages'] if m['kind'] == 'proposal')
        self.assertEqual(proposal['action']['endpoint'], '/api/control')
        self.assertNotIn('PRIVATE', json.dumps(result))
        # A temporary sample supports the required handoff report without a second store.
        Path('/tmp/ac-thread-sample.json').write_text(json.dumps(result, indent=2))
