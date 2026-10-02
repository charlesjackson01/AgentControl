"""M9.1 device prerequisites use the real server and disposable state only."""
import json
from pathlib import Path
import sys
import unittest
from urllib.request import Request, urlopen

sys.path[:0] = [str(Path(__file__).resolve().parent), str(Path(__file__).resolve().parents[1])]
from device_fixture import DeviceFixture


class DeviceFixtureTests(unittest.TestCase):
    def test_real_chat_and_two_actionable_requests_are_isolated_and_cleaned(self):
        fixture = DeviceFixture(host='127.0.0.1', port=0)
        try:
            fixture.start()
            root = fixture.root
            with urlopen(fixture.url + '/chat', timeout=5) as response:
                self.assertEqual(response.status, 200)
            def read(path):
                request = Request(fixture.url + path, headers={'Authorization': 'Bearer ' + fixture.key})
                with urlopen(request, timeout=5) as response:
                    return json.load(response)
            thread = read('/api/thread?channel=main&limit=200')
            pending = [m for m in thread['messages'] if m['kind'] == 'request' and m['action']]
            critical = [m for m in pending if m['detail']['kind'] == 'permission' and m['detail']['risk']['level'] == 'R3']
            questions = [m for m in pending if m['detail']['kind'] == 'question']
            self.assertEqual(len(critical), 1)
            self.assertEqual(len(questions), 1)
            self.assertEqual(read('/api/channels')['channels'][0]['waiting'], 2)
            self.assertIsNone(thread['before'])
        finally:
            fixture.close()
        self.assertFalse(root.exists(), 'Shutdown must remove all temporary fixture state and project files')
