"""Hermes replies must be one JSON object; a malformed reply gets exactly one repair request."""
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from adapters.hermes import Hermes
from engine import Controller, Settings
from test_workflow import FakeAPI, FakeManager, coding, complete

HELP = '--quiet --query --toolsets --max-turns --query-file'
GOOD = json.dumps({'action': 'complete', 'summary': 'All done.'})
BROKEN = '{"action": "complete", "summary": "All done."'  # missing the closing brace, as seen in M0


class RepairTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        (root / 'project').mkdir()
        self.hermes = Hermes(Settings(root / 'project', root / 'state'))

    def tearDown(self):
        self.temp.cleanup()

    def test_valid_reply_needs_no_repair(self):
        with patch('adapters.hermes.process', side_effect=[(0, HELP, ''), (0, GOOD, '')]) as mocked:
            self.assertEqual(self.hermes.decide('goal', lambda: False)['action'], 'complete')
        self.assertEqual(mocked.call_count, 2)
        self.assertIsNone(self.hermes.last_repair)

    def test_malformed_then_valid_reply_is_repaired_once(self):
        prompts = []
        def fake(argv, *a, **k):
            if '--help' in argv:
                return 0, HELP, ''
            prompts.append(Path(argv[argv.index('--query-file') + 1]).read_text())
            return (0, BROKEN, '') if len(prompts) == 1 else (0, GOOD, '')
        with patch('adapters.hermes.process', side_effect=fake):
            result = self.hermes.decide('Original goal text', lambda: False)
        self.assertEqual(result['summary'], 'All done.')
        self.assertEqual(len(prompts), 2)
        self.assertIn('Original goal text', prompts[1])
        self.assertIn('NOT VALID JSON', prompts[1])
        self.assertIn(BROKEN, prompts[1])
        self.assertIn('line 1', self.hermes.last_repair)

    def test_second_malformed_reply_fails_as_before(self):
        with patch('adapters.hermes.process', side_effect=[(0, HELP, ''), (0, BROKEN, ''), (0, 'still not json', '')]) as mocked:
            with self.assertRaisesRegex(RuntimeError, 'did not return the requested JSON decision'):
                self.hermes.decide('goal', lambda: False)
        self.assertEqual(mocked.call_count, 3, 'exactly one repair attempt, never more')

    def test_valid_json_with_a_bad_decision_is_not_retried(self):
        with patch('adapters.hermes.process', side_effect=[(0, HELP, ''), (0, json.dumps({'action': 'dance'}), '')]) as mocked:
            with self.assertRaisesRegex(RuntimeError, 'action code, complete, or blocked'):
                self.hermes.decide('goal', lambda: False)
        self.assertEqual(mocked.call_count, 2)


class RepairIsJournaledTests(unittest.TestCase):
    def test_run_records_when_hermes_needed_a_repair(self):
        class RepairingManager(FakeManager):
            def decide(self, prompt, cancel):
                self.last_repair = "Expecting ',' delimiter at line 4 column 9" if not self.calls else None
                return super().decide(prompt, cancel)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'project').mkdir()
            c = Controller(Settings(root / 'project', root / 'state', poll=.01, notifications=False, run_timeout=30),
                           FakeAPI(root / 'project'), RepairingManager([coding(), complete()]))
            c.check()
            try:
                run = c.new('Build something')
                for _ in range(500):
                    if c.store.get('runs', run['id'])['status'] in ('completed', 'failed', 'blocked'):
                        break
                    time.sleep(.01)
                self.assertEqual(c.store.get('runs', run['id'])['status'], 'completed')
                kinds = [e['kind'] for e in c.store.events(run['id'])]
                self.assertEqual(kinds.count('Hermes JSON repaired'), 1)
            finally:
                c.shutdown.set()
                c.preview.close()


if __name__ == '__main__':
    unittest.main()
