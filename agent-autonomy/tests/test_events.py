"""Live updates: the event bus and the /api/events Server-Sent Events stream."""
import http.client
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import app
from engine import Controller, Settings
from events import EventBus
from test_workflow import FakeAPI, FakeManager, coding, complete


class BusTests(unittest.TestCase):
    def test_subscribers_get_ordered_notices(self):
        bus = EventBus()
        q = bus.subscribe()
        bus.publish('run', 'r1')
        bus.publish('step', 'r1')
        first, second = q.get_nowait(), q.get_nowait()
        self.assertEqual((first['kind'], second['kind']), ('run', 'step'))
        self.assertLess(first['seq'], second['seq'])

    def test_slow_subscriber_drops_notices_instead_of_blocking(self):
        bus = EventBus(queue_size=2)
        q = bus.subscribe()
        for _ in range(5):
            bus.publish('event', 'r1')  # must not block the publisher
        self.assertEqual(q.qsize(), 2)

    def test_limit_and_unsubscribe(self):
        bus = EventBus()
        a = bus.subscribe(limit=1)
        self.assertIsNone(bus.subscribe(limit=1))
        bus.unsubscribe(a)
        self.assertIsNotNone(bus.subscribe(limit=1))


class StreamTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        (root / 'project').mkdir()
        self.c = Controller(Settings(root / 'project', root / 'state', poll=.01, notifications=False, run_timeout=30),
                            FakeAPI(root / 'project'), FakeManager([coding(), complete()]))
        self.c.check()
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), app.handler(self.c, 'k'))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.c.shutdown.set()
        for thread in list(self.c.threads.values()):
            thread.join(2)
        self.c.preview.close()
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()

    def open_stream(self, key='k'):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=10)
        conn.request('GET', '/api/events', headers={'Authorization': 'Bearer ' + key} if key else {})
        return conn, conn.getresponse()

    @staticmethod
    def read_event(response):
        """Read one SSE block and return (event name, data dict)."""
        name, data = None, None
        while True:
            line = response.fp.readline().decode().rstrip('\n')
            if line.startswith('event: '):
                name = line[7:]
            elif line.startswith('data: '):
                data = json.loads(line[6:])
            elif line == '' and name:
                return name, data

    def test_stream_requires_the_dashboard_key(self):
        conn, response = self.open_stream(key=None)
        self.assertEqual(response.status, 401)
        conn.close()

    def test_run_activity_arrives_as_change_notices(self):
        conn, response = self.open_stream()
        self.assertEqual(response.status, 200)
        self.assertIn('text/event-stream', response.getheader('Content-Type'))
        self.assertEqual(self.read_event(response)[0], 'hello')
        run = self.c.new('Build something')
        kinds = set()
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and not {'run', 'step', 'event'} <= kinds:
            name, data = self.read_event(response)
            self.assertEqual(name, 'change')
            if data['run'] == run['id']:
                kinds.add(data['kind'])
        self.assertTrue({'run', 'step', 'event'} <= kinds, kinds)
        conn.close()

    def test_connection_cap_answers_503_so_the_tab_falls_back_to_polling(self):
        held = [self.open_stream() for _ in range(app.MAX_EVENT_STREAMS)]
        for _, response in held:
            self.assertEqual(response.status, 200)
        conn, response = self.open_stream()
        self.assertEqual(response.status, 503)
        conn.close()
        for c, r in held:
            r.close()  # http.client keeps the socket open while the response object holds it
            c.close()
        # Closed tabs give their slots back quickly (not only at the 15 s keepalive).
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and self.c.events.count():
            time.sleep(.05)
        self.assertEqual(self.c.events.count(), 0)
        conn, response = self.open_stream()
        self.assertEqual(response.status, 200)
        conn.close()

    def test_stream_closes_when_the_controller_shuts_down(self):
        conn, response = self.open_stream()
        self.read_event(response)
        self.c.shutdown.set()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and self.c.events.count():
            time.sleep(.05)
        self.assertEqual(self.c.events.count(), 0)
        conn.close()


if __name__ == '__main__':
    unittest.main()
