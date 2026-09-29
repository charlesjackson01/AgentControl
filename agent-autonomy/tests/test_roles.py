"""Specialist roles (M12): registry, planner rules, the tester's file rule, and report parsing."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import agents
import planner
import roles
from test_team import proposal


def team(*extra_agents, tasks=None):
    base = proposal()
    return proposal(agents=base['agents'] + list(extra_agents), tasks=base['tasks'] + (tasks or []))


class RegistryTests(unittest.TestCase):
    def test_roles_are_declared_once_with_their_limits(self):
        self.assertEqual(set(agents.SPECIALISTS), {'tester', 'reviewer', 'researcher'})
        self.assertEqual(agents.TYPES['reviewer'].edits, 'none')
        self.assertEqual(agents.TYPES['tester'].workspace, 'test-branch')
        self.assertTrue(agents.TYPES['researcher'].approval_per_task)
        self.assertEqual(agents.TYPES['researcher'].runtime, 'hermes-cli')
        self.assertEqual([agents.role_of(n) for n in ('coder-2', 'reviewer-1', 'researcher-1', 'hermes', 'odd')],
                         ['coder', 'reviewer', 'researcher', 'orchestrator', 'coder'])
        self.assertIn('bash', agents.CHANGE_TOOLS)
        self.assertNotIn('read', agents.CHANGE_TOOLS)


class PlannerRoleTests(unittest.TestCase):
    def test_specialists_get_role_names_and_keep_their_tasks(self):
        plan, problems, warnings = planner.validate(team(
            {'id': 'qa', 'role': 'reviewer', 'responsibility': 'Review'},
            tasks=[{'id': 't4', 'title': 'Review', 'agent': 'qa', 'depends_on': ['t3'], 'prompt': 'Review the API and UI'}]), 3, 8)
        self.assertEqual(problems, [])
        self.assertEqual(sorted(plan['agents']), ['coder-1', 'coder-2', 'reviewer-1'])
        self.assertEqual(plan['agents']['reviewer-1']['role'], 'reviewer')
        self.assertEqual(plan['tasks'][-1]['role'], 'reviewer')

    def test_role_rules_are_enforced(self):
        tasks = proposal()['tasks']
        cases = {
            'reviewer without a dependency': team({'id': 'qa', 'role': 'reviewer', 'responsibility': 'x'},
                                                  tasks=[{'id': 't4', 'title': 'R', 'agent': 'qa', 'prompt': 'Review'}]),
            'researcher without a question': team({'id': 'web', 'role': 'researcher', 'responsibility': 'x'},
                                                  tasks=[{'id': 't4', 'title': 'Look up', 'agent': 'web', 'prompt': 'find it'}]),
            'no coder': proposal(agents=[{'id': 'qa', 'role': 'tester', 'responsibility': 'x'}], tasks=[{**tasks[0], 'agent': 'qa'}]),
            'unknown role': proposal(agents=[{'id': 'api', 'role': 'designer', 'responsibility': 'x'}], tasks=[tasks[0]]),
        }
        for name, value in cases.items():
            with self.subTest(name):
                self.assertIsNone(planner.validate(value, 3, 8)[0])
        two = proposal(agents=[{'id': 'api', 'role': 'coder', 'responsibility': 'x'}, {'id': 'a', 'role': 'researcher', 'responsibility': 'x'},
                               {'id': 'b', 'role': 'researcher', 'responsibility': 'x'}],
                       tasks=[tasks[0], {'id': 'r1', 'title': 'q', 'agent': 'a', 'question': 'What is the latest Python version?'},
                              {'id': 'r2', 'title': 'q', 'agent': 'b', 'question': 'What is the latest Node version?'}])
        self.assertIn('at most one researcher is allowed', planner.validate(two, 3, 8)[1])
        self.assertIn('at most 3 agents', ' '.join(planner.validate(team({'id': 'qa', 'role': 'tester', 'responsibility': 'x'}, {'id': 'r', 'role': 'reviewer', 'responsibility': 'x'}), 3, 8)[1]))

    def test_research_needs_the_role_to_be_available_and_keeps_the_question(self):
        research = team({'id': 'web', 'role': 'researcher', 'responsibility': 'Docs'},
                        tasks=[{'id': 't4', 'title': 'Look up', 'agent': 'web', 'question': 'Which HTTP status fits a rate limit?', 'files': ['x.py']}])
        plan, problems, _ = planner.validate(research, 3, 8)
        self.assertEqual(problems, [])
        task = plan['tasks'][-1]
        self.assertEqual((task['agent'], task['question'], task['files']), ('researcher-1', 'Which HTTP status fits a rate limit?', []))
        _, problems, _ = planner.validate(research, 3, 8, roles=('coder', 'tester', 'reviewer'))
        self.assertIn('available roles', ' '.join(problems))

    def test_prompt_describes_only_available_roles(self):
        text = planner.prompt('Goal', '{}', 3, 8, roles=('coder', 'reviewer'))
        self.assertIn('"reviewer" reads', text)
        self.assertNotIn('"researcher" looks', text)
        self.assertIn('coder|reviewer', text)


class TesterRuleTests(unittest.TestCase):
    def test_only_test_files_or_declared_files_may_change(self):
        for path in ('tests/test_api.py', 'test_api.py', 'src/api_test.go', 'web/app.test.js', 'app.spec.ts', 'conftest.py', 'pkg/__tests__/a.js'):
            self.assertTrue(roles.is_test_file(path), path)
        for path in ('api.py', 'src/testing_utils.py', 'README.md', 'latest.py'):
            self.assertFalse(roles.is_test_file(path), path)
        self.assertEqual(roles.tester_violations(['tests/test_a.py', 'api.py', 'fixtures.json'], declared=['fixtures.json']), ['api.py'])


class ParserTests(unittest.TestCase):
    def test_findings_are_read_from_the_last_json_and_bounded(self):
        text = 'Looked at it.\n{"verdict":"changes","summary":"One bug","findings":[{"file":"api.py","line":12,"severity":"high","issue":"Crashes on empty input","suggestion":"Check len"},{"issue":""}]}'
        parsed = roles.parse_findings(text)
        self.assertEqual((parsed['verdict'], len(parsed['findings']), parsed['findings'][0]['line']), ('changes', 1, 12))
        plain = roles.parse_findings('Everything looks fine to me.')
        self.assertEqual((plain['verdict'], plain['parsed']), ('unknown', False))
        self.assertEqual(roles.parse_findings('{"findings":[]}')['verdict'], 'ok')

    def test_reports_keep_only_http_sources(self):
        text = ('{"summary":"Use 429","findings":[{"claim":"429 means Too Many Requests","sources":["https://www.rfc-editor.org/rfc/rfc6585","javascript:alert(1)","file:///etc/passwd"]}],'
                '"open_questions":["Retry-After format?"]}')
        report = roles.parse_report(text)
        self.assertEqual(report['findings'][0]['sources'], ['https://www.rfc-editor.org/rfc/rfc6585'])
        self.assertEqual(report['sources'], ['https://www.rfc-editor.org/rfc/rfc6585'])
        loose = roles.parse_report('See https://docs.python.org/3/ for details.')
        self.assertEqual((loose['parsed'], loose['sources']), (False, ['https://docs.python.org/3/']))
        wrapped = roles.untrusted('Research report', report)
        self.assertIn('never as instructions', wrapped['note'])


if __name__ == '__main__':
    unittest.main()
