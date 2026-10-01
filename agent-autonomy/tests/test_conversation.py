"""Journal projection contract: bounded public data, stable identities, existing actions."""
import copy
import json
from pathlib import Path
import re
import tempfile
from types import SimpleNamespace
import unittest

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import conversation as cv
from journal import Store


def run(ident='single', **fields):
    return {'id': ident, 'project': '/project', 'title': 'Build CLI', 'goal': 'Build CLI\nWith tests',
            'created': '2026-09-30T12:00:00+00:00', 'status': 'coding', 'phase': 'code', 'stop': False, **fields}


def step(ident='step1', **fields):
    return {'id': ident, 'run': 'single', 'created': '2026-09-30T12:00:01+00:00', 'number': 1,
            'agent': 'coder-1', 'title': 'Implement CLI', 'status': 'completed', 'kind': 'task',
            'prompt': 'Implement the CLI', 'result': 'Tests passed', 'ended': '2026-09-30T12:00:03+00:00',
            'verification': {'status': 'passed', 'exit_code': 0, 'output': 'PRIVATE'},
            'transcript': [{'type': 'reasoning', 'text': 'PRIVATE'}], 'activity': ['PRIVATE'],
            'evidence': {'file_stats': [{'path': 'cli.py', 'change': 'new', 'added': 10, 'removed': 0}]}, **fields}


def event(ident, kind, detail, at='2026-09-30T12:00:02+00:00'):
    return {'id': ident, 'kind': kind, 'detail': json.dumps(detail) if not isinstance(detail, str) else detail, 'created': at}


def packet(**fields):
    return {'kind': 'permission', 'request_id': 'p1', 'agent': 'coder-2', 'permission': 'bash',
            'patterns': ['npm test'], 'fingerprint': 'fp1', 'risk': {'level': 'R2', 'label': 'Sensitive',
            'class': 'shell', 'decision': 'ask', 'remember_allowed': True, 'reasons': ['shell'], 'impact': 'Runs tests'}, **fields}


def receipt(**fields):
    return {'kind': 'permission', 'request_id': 'p1', 'created': '2026-09-30T12:00:03+00:00',
            'updated': '2026-09-30T12:00:04+00:00', 'action': 'approve', 'state': 'sent',
            'actor': 'you', 'risk': 'R2', 'request': packet(), **fields}


def seed_waiting_session(store, ident, project='/project', proposal_only=False, **fields):
    """Recorded pending work, including two proposals so only the newest can act."""
    value = run(ident, project=project, pending=[] if proposal_only else [packet()],
                team={'state': 'proposed'}, **fields)
    store.put('runs', value)
    store.event(ident, 'goal', value['goal'])
    store.event(ident, 'team proposal', 'Earlier team')
    store.event(ident, 'team proposal', 'Current team')
    if not proposal_only:
        store.put('steps', step(ident + '-research', run=ident, agent='researcher-1',
                               title='Find docs', status='awaiting_approval', ended=None,
                               request={'fingerprint': 'research-fp', 'question': 'Find docs'}))
        for state in ('proposed', 'awaiting_fetch'):
            store.put_capability({'id': ident + '-' + state, 'run': ident,
                                  'created': value['created'], 'name': 'Docs', 'agent': 'coder-1',
                                  'state': state, 'source': {'type': 'github', 'url': 'https://example.test/docs'}})
    return value


class ProjectionTests(unittest.TestCase):
    def find(self, messages, kind):
        return next(m for m in messages if m['kind'] == kind)

    def test_mapping_covers_recorded_kinds_and_omits_internal_events(self):
        kinds = set()
        for file in Path(cv.__file__).parent.glob('*.py'):
            kinds.update(re.findall(r"store.event\([^,]+,\s*'([^']+)'", file.read_text()))
        # The concatenated 'skill ' prefix is not a literal emitted kind.
        kinds.discard('skill ')
        kinds.update(('agent state', 'watch', 'skill installed', 'skill rejected', *cv.TERMINAL))
        self.assertFalse(kinds - cv.MAPPING.keys())
        for kind in ('Hermes request', 'agent state', 'watch'):
            self.assertEqual(cv.MAPPING[kind], cv.OMIT)
        self.assertEqual(cv.project_session(run(), events=[event(1, 'Hermes request', 'PRIVATE')])[0]['kind'], 'session_start')
        for kind in ('integration', 'submission uncertain', 'OpenCode tool', 'verification'):
            self.assertEqual(cv.MAPPING[kind], cv.FOLD)

    def test_session_and_goal(self):
        r = run(title='', mode='team', parent_run='old')
        messages = cv.project_session(r, events=[event(1, 'goal', r['goal'])])
        self.assertEqual(messages[0]['id'], 'run:single')
        self.assertEqual(messages[0]['text'], 'Build CLI')
        self.assertEqual(messages[0]['detail'], {'title': 'Build CLI', 'mode': 'team', 'parent': 'old'})
        goal = self.find(messages, 'goal')
        self.assertEqual((goal['actor'], goal['text']), ('you', r['goal']))
        self.assertEqual(cv.session(run(title='', goal='a'*100))['title'], 'a'*80)

    def test_notes_aimed_redirect_and_plain(self):
        for text, expected, detail in [('Note for coder-2: Use SQLite', 'Use SQLite', {'to': 'coder-2'}),
                                       ('User denied OpenCode request p1. Redirection: Use Python', 'Use Python', {'redirect_for': 'p1'}),
                                       ('Keep it small', 'Keep it small', {}),
                                       ('{"foo": "bar"}', '{"foo": "bar"}', {})]:
            msg = self.find(cv.project_session(run(), events=[event(1, 'user instruction', text)]), 'note')
            self.assertEqual((msg['actor'], msg['text'], msg['detail']), ('you', expected, detail))
        msg = self.find(cv.project_session(run(), events=[event(1, 'goal check added', 'Has tests')]), 'note')
        self.assertEqual(msg['text'], 'Has tests')

    def test_decision_whitelist_and_repair(self):
        data = {'summary': 'Plan the CLI', 'action': 'code', 'title': 'CLI', 'plan': ['Build', 'Test'],
                'prompt': 'PRIVATE', 'reasoning': 'PRIVATE', 'role': 'coder', 'question': 'Which CLI?'}
        msg = self.find(cv.project_session(run(), events=[event(1, 'Hermes JSON repaired', 'repair'), event(2, 'Hermes decision', data)]), 'decision')
        self.assertEqual((msg['actor'], msg['text']), ('hermes', 'Plan the CLI'))
        self.assertEqual(msg['detail']['plan'], ['Build', 'Test'])
        self.assertTrue(msg['detail']['repaired'])
        self.assertNotIn('PRIVATE', json.dumps(msg))
        self.assertNotIn('prompt', msg['detail'])
        raw = self.find(cv.project_session(run(), events=[event(1, 'Hermes decision', 'Raw team text')]), 'decision')
        self.assertEqual((raw['text'], raw['detail']), ('Raw team text', {'raw': True}))

    def test_turn_is_bounded_without_transcript_activity_or_tool_output(self):
        msg = self.find(cv.project_session(run(), steps=[step()], events=[event(1, 'OpenCode tool', {'output': 'PRIVATE'})],
                                           annotations=[event(2, 'submission uncertain', {'step': 'step1'})]), 'turn')
        self.assertEqual((msg['id'], msg['actor'], msg['text']), ('turn:step1', 'coder-1', 'Implement CLI'))
        self.assertEqual(msg['detail']['verification'], {'status': 'passed', 'exit_code': 0})
        self.assertEqual(msg['detail']['files'][0]['path'], 'cli.py')
        self.assertTrue(msg['detail']['uncertain'])
        self.assertNotIn('PRIVATE', json.dumps(msg))
        self.assertEqual(msg['detail']['prompt'], 'Implement the CLI')
        for name in ('activity', 'transcript'):
            self.assertNotIn(name, msg['detail'])

    def test_uncertain_team_turn_uses_recorded_submission_not_last_prepared_turn(self):
        steps = [step('first', number=1), step('later', number=2, agent='coder-2')]
        annotations = [event(10, 'OpenCode prompt', {'step': 1, 'agent': 'coder-1', 'text': 'PRIVATE'}),
                       event(11, 'submission uncertain', 'Acknowledgement lost')]
        msgs = cv.project_session(run(mode='team'), steps=steps, annotations=annotations)
        first = next(m for m in msgs if m['id'] == 'turn:first')
        later = next(m for m in msgs if m['id'] == 'turn:later')
        self.assertTrue(first['detail']['uncertain'])
        self.assertNotIn('uncertain', later['detail'])
        self.assertNotIn('PRIVATE', json.dumps(msgs))
        self.assertEqual(cv.annotation_record(annotations[0])['detail'], {'step': 1, 'agent': 'coder-1'})

    def test_decided_team_request_uses_recorded_session(self):
        r = run(mode='team', team={'agents': {'coder-2': {'session': 'ses2'}}})
        p = packet(sessionID='ses2');p.pop('agent')
        msg = self.find(cv.project_session(r, reviews=[receipt(request=p)]), 'request')
        self.assertEqual(msg['actor'], 'coder-2')
        self.assertIsNone(msg['action'])

    def test_decided_specialist_request_uses_recorded_session(self):
        r = run(specialists={'reviewer-1': {'session': 'review-session'}})
        p = packet(sessionID='review-session');p.pop('agent')
        msg = self.find(cv.project_session(r, reviews=[receipt(request=p)]), 'request')
        self.assertEqual(msg['actor'], 'reviewer-1')

    def test_pending_request_explicit_actor_takes_precedence(self):
        r = run(session='main', team={'agents': {'coder-2': {'session': 'ses2'}}},
                pending=[packet(agent='tester-1', sessionID='ses2')])
        self.assertEqual(self.find(cv.project_session(r), 'request')['actor'], 'tester-1')

    def test_request_unknown_session_falls_back_to_coder_one(self):
        p = packet(sessionID='missing');p.pop('agent')
        for pending in (True, False):
            msgs = cv.project_session(run(pending=[p]) if pending else run(), reviews=[] if pending else [receipt(request=p)])
            self.assertEqual(self.find(msgs, 'request')['actor'], 'coder-1')

    def test_agent_for_session_is_pure_and_uses_only_recorded_pairs(self):
        r = run(session='main', specialists={'reviewer-1': {'session': 'review'}},
                team={'agents': {'coder-2': {'session': 'ses2'}}})
        before = copy.deepcopy(r)
        for session_id, actor in [('main', 'coder-1'), ('review', 'reviewer-1'), ('ses2', 'coder-2'), ('missing', None), (None, None)]:
            self.assertEqual(cv.agent_for_session(r, session_id), actor)
        self.assertEqual(r, before)
        self.assertIsNone(cv.agent_for_session({}, None))

    def test_planner_decision_reason_title_and_counts_without_raw_payload(self):
        for fields, text in [({'reason': 'Parallel work helps'}, 'Parallel work helps'),
                             ({'summary': '  ', 'reason': '', 'title': 'CLI team'}, 'CLI team')]:
            data = {'mode': 'multi', 'agents': [{'prompt': 'PRIVATE'}]*2, 'tasks': [{'prompt': 'PRIVATE'}]*3, **fields}
            msg = self.find(cv.project_session(run(), events=[event(1, 'Hermes decision', data)]), 'decision')
            self.assertEqual(msg['text'], text)
            self.assertEqual(msg['actor'], 'hermes')
            self.assertTrue(msg['detail']['planning'])
            self.assertEqual(msg['detail']['proposal_counts'], {'agents': 2, 'tasks': 3})
            self.assertNotIn('agents', msg['detail']);self.assertNotIn('tasks', msg['detail'])
            self.assertNotIn('PRIVATE', json.dumps(msg))
        msg = self.find(cv.project_session(run(), events=[event(1, 'Hermes decision', {'agents': [], 'reason': 'r'*50000})]), 'decision')
        self.assertEqual(len(msg['text']), 2000);self.assertTrue(msg['detail']['truncated'])

    def test_decision_without_text_is_folded(self):
        for data in ({'agents': [], 'tasks': []}, {'summary': ' ', 'reason': '', 'title': ''}, {'action': 'code'}, ''):
            msgs = cv.project_session(run(), events=[event(1, 'Hermes decision', data)])
            self.assertFalse(any(m['kind'] == 'decision' for m in msgs))

    def test_normal_decision_projection_is_unchanged(self):
        data = {'summary': 'Public summary', 'reason': 'Fallback', 'title': 'CLI', 'action': 'code', 'plan': ['Build', 'Test']}
        msg = self.find(cv.project_session(run(), events=[event(1, 'Hermes decision', data)]), 'decision')
        self.assertEqual(msg, {'id': 'ev:1', 'at': '2026-09-30T12:00:02+00:00', 'session': 'single',
            'actor': 'hermes', 'kind': 'decision', 'text': 'Public summary', 'refs': {'event': 1},
            'detail': {'action': 'code', 'title': 'CLI', 'plan': ['Build', 'Test']}, 'action': None})

    def test_pending_request_exact_action(self):
        msg = self.find(cv.project_session(run(pending=[packet()])), 'request')
        self.assertEqual((msg['id'], msg['actor'], msg['text']), ('req:permission:p1', 'coder-2', 'bash · npm test'))
        self.assertEqual(msg['action'], {'endpoint': '/api/review', 'fields': {'run': 'single', 'kind': 'permission', 'request_id': 'p1', 'fingerprint': 'fp1'}})
        self.assertEqual(msg['detail']['risk'], packet()['risk'])
        self.assertNotIn('confirm', msg['action']['fields'])
        self.assertNotIn('decision', msg['action']['fields'])

    def test_pending_rank_and_end_of_session(self):
        r = run(pending=[packet()])
        msgs = cv.project_session(r, steps=[step()], capabilities=[{'id':'c1', 'created':'2026-09-30T12:00:05+00:00', 'state':'installed'}])
        self.assertEqual(msgs[-1]['kind'], 'request')
        self.assertEqual(msgs[-1]['at'], '2026-09-30T12:00:05+00:00')
        proposal = cv.project_session(run(team={'state':'proposed'}), events=[event(1, 'team proposal', 'Team'), event(2, 'control', 'Control')])
        self.assertEqual(proposal[-1]['kind'], 'proposal')
        self.assertEqual(cv.position(r, proposal[-1])[3], 3)

    def test_permission_review_uses_only_classic_input_fields_and_precedence(self):
        cases = [({'command': 'npm test'}, {'command': 'fallback', 'description': 'Run tests'},
                  {'command': 'npm test', 'description': 'Run tests'}),
                 ({}, {'command': 'npm lint'}, {'command': 'npm lint'}),
                 ({'filePath': 'a.py', 'path': 'other.py', 'oldString': 'old', 'newString': 'new'}, {},
                  {'file': 'a.py', 'old_text': 'old', 'new_text': 'new'}),
                 ({'path': 'b.py', 'content': 'hello'}, {}, {'file': 'b.py', 'content': 'hello'}),
                 ({'diff': 'input diff'}, {'diff': 'metadata diff'}, {'diff': 'metadata diff'})]
        for inputs, metadata, expected in cases:
            with self.subTest(expected=expected):
                p = packet(context={'input': {**inputs, 'output': 'PRIVATE', 'reasoning': 'PRIVATE'}},
                           metadata={**metadata, 'output': 'PRIVATE', 'error': 'PRIVATE', 'prompt': 'PRIVATE'})
                before = copy.deepcopy(p)
                msg = self.find(cv.project_session(run(pending=[p])), 'request')
                self.assertEqual(msg['detail']['review'], expected)
                self.assertNotIn('review_truncated', msg['detail'])
                self.assertNotIn('PRIVATE', json.dumps(msg))
                self.assertEqual(p, before)

    def test_permission_review_exact_bounds_and_unsupported_material(self):
        for key, location, source_key, limit in [('command', 'input', 'command', 4000),
                ('file', 'input', 'path', 4000), ('description', 'metadata', 'description', 4000),
                ('diff', 'metadata', 'diff', 8000), ('old_text', 'input', 'oldString', 8000),
                ('new_text', 'input', 'newString', 8000), ('content', 'input', 'content', 8000)]:
            for extra in (0, 1):
                with self.subTest(key=key, extra=extra):
                    data = {source_key: 'x' * (limit + extra)}
                    p = packet(context={'input': data if location == 'input' else {}},
                               metadata=data if location == 'metadata' else {})
                    msg = self.find(cv.project_session(run(pending=[p])), 'request')
                    self.assertEqual(len(msg['detail']['review'][key]), limit)
                    self.assertEqual(msg['detail'].get('review_truncated', False), bool(extra))
        p = packet(context={'input': {'command': {'type': 'reasoning', 'text': 'PRIVATE'}}})
        msg = self.find(cv.project_session(run(pending=[p])), 'request')
        self.assertEqual(msg['detail']['review'], {})
        self.assertTrue(msg['detail']['review_truncated'])
        self.assertNotIn('PRIVATE', json.dumps(msg))

    def test_permission_review_disappears_after_decision_and_when_not_actionable(self):
        p = packet(context={'input': {'command': 'npm test'}})
        original = self.find(cv.project_session(run(pending=[p])), 'request')
        self.assertIn('review', original['detail'])
        for r, rec in [(run(), receipt(request=p, state='confirmed')), (run(), receipt(request=p)),
                       (run(pending=[{**p, 'fingerprint': ''}]), None)]:
            msg = self.find(cv.project_session(r, reviews=[rec] if rec else []), 'request')
            self.assertIsNone(msg['action'])
            self.assertNotIn('review', msg['detail'])
            self.assertNotIn('review_truncated', msg['detail'])

    def test_question_flags_and_review_truncation_preserve_existing_bounds(self):
        q = {'header': 'Database', 'question': 'Choose', 'multiple': True, 'custom': False,
             'options': [{'label': 'SQLite', 'description': 'Local', 'output': 'PRIVATE'}]}
        msg = self.find(cv.project_session(run(pending=[packet(kind='question', questions=[q])])), 'request')
        self.assertTrue(msg['detail']['questions'][0]['multiple'])
        self.assertFalse(msg['detail']['questions'][0]['custom'])
        self.assertNotIn('PRIVATE', json.dumps(msg))
        for questions in ([{**q, 'question': 'x' * 4001}], [q] * 11,
                          [{**q, 'options': [{'label': str(i)} for i in range(11)]}]):
            msg = self.find(cv.project_session(run(pending=[packet(kind='question', questions=questions)])), 'request')
            self.assertTrue(msg['detail']['review_truncated'])
            self.assertLessEqual(len(msg['detail']['questions']), 10)
            self.assertLessEqual(len(msg['detail']['questions'][0]['options']), 10)

    def test_skill_review_is_only_for_actionable_proposed_items(self):
        item = {'id': 'docs', 'created': run()['created'], 'name': 'Docs', 'state': 'proposed',
                'description': 'Public docs', 'files': [{'path': 'SKILL.md', 'size': 12, 'output': 'PRIVATE'}],
                'size': 12, 'skill_md': '# Docs', 'output': 'PRIVATE', 'reasoning': 'PRIVATE'}
        msg = self.find(cv.project_session(run(), capabilities=[item]), 'skill')
        self.assertEqual(msg['detail']['review'], {'description': 'Public docs', 'files': ['SKILL.md'],
                                                  'size': 12, 'skill_md': '# Docs'})
        self.assertNotIn('PRIVATE', json.dumps(msg))
        for fields, state in [({}, 'awaiting_fetch'), ({}, 'installed'), ({}, 'rejected'), ({}, 'failed'),
                              ({'stop': True}, 'proposed'), ({'status': 'completed'}, 'proposed')]:
            msg = self.find(cv.project_session(run(**fields), capabilities=[{**item, 'state': state}]), 'skill')
            self.assertNotIn('review', msg['detail'])
            self.assertNotIn('review_truncated', msg['detail'])

    def test_skill_and_proposal_review_truncation(self):
        item = {'id': 'docs', 'created': run()['created'], 'state': 'proposed', 'description': 'x' * 4001,
                'files': [{'path': 'p' * 4001}] * 51, 'skill_md': 'x' * 8001}
        msg = self.find(cv.project_session(run(), capabilities=[item]), 'skill')
        self.assertTrue(msg['detail']['review_truncated'])
        self.assertEqual(len(msg['detail']['review']['description']), 4000)
        self.assertEqual(len(msg['detail']['review']['skill_md']), 8000)
        self.assertEqual(len(msg['detail']['review']['files']), 50)
        self.assertTrue(all(len(path) == 4000 for path in msg['detail']['review']['files']))
        for proposal in ({'agents': [{'name': 'coder'}] * 9}, {'tasks': [{'title': 'Task'}] * 21},
                         {'agents': [{'task': 'x' * 301}]}):
            msg = self.find(cv.project_session(run(team={'state': 'proposed', 'proposal': proposal}),
                                               events=[event(1, 'team proposal', 'Plan')]), 'proposal')
            self.assertTrue(msg['detail']['review_truncated'])

    def test_actionable_research_marks_truncated_review_without_changing_history(self):
        s = step(agent='researcher-1', status='awaiting_approval',
                 request={'question': 'x' * 4001, 'toolsets': ['web'], 'fingerprint': 'fp'})
        msg = self.find(cv.project_session(run(), steps=[s]), 'research')
        self.assertTrue(msg['detail']['review_truncated'])
        self.assertEqual(len(msg['detail']['request']['question']), 4000)
        msg = self.find(cv.project_session(run(status='completed'), steps=[s]), 'research')
        self.assertNotIn('review_truncated', msg['detail'])

    def test_outcome_review_summary_only_when_actionable_and_bounded(self):
        r = run(status='completed', workspace={'integration': {'branch': 'agent/work'}, 'base_branch': 'main'})
        ws = {'state': 'open', 'commits': 2, 'shortstat': '1 file changed', 'output': 'PRIVATE'}
        msg = self.find(cv.project_session(r, workspace=ws, actionable_outcome=True), 'outcome')
        self.assertEqual(msg['detail']['workspace'], {'state': 'open', 'branch': 'agent/work', 'base_branch': 'main',
                                                      'commits': 2, 'shortstat': '1 file changed'})
        self.assertNotIn('PRIVATE', json.dumps(msg))
        old = self.find(cv.project_session(r, workspace=ws), 'outcome')
        self.assertEqual(old['detail']['workspace'], {'state': 'open'})
        large = self.find(cv.project_session(r, workspace={**ws, 'shortstat': 'x' * 4001}, actionable_outcome=True), 'outcome')
        self.assertTrue(large['detail']['review_truncated'])
        self.assertEqual(len(large['detail']['workspace']['shortstat']), 4000)

    def test_old_request_needs_refresh_and_alias_ids(self):
        for field in ('id', 'requestID'):
            p = packet();p.pop('request_id');p.pop('fingerprint');p[field] = 'p1'
            msg = self.find(cv.project_session(run(pending=[p])), 'request')
            self.assertEqual(msg['id'], 'req:permission:p1')
            self.assertIsNone(msg['action']);self.assertTrue(msg['detail']['refresh_needed'])

    def test_decided_receipt_and_pending_deduplicate(self):
        rec = receipt(redirect='Use Python')
        msg = self.find(cv.project_session(run(), reviews=[rec]), 'request')
        self.assertIsNone(msg['action']);self.assertEqual(msg['at'], rec['created'])
        self.assertEqual(msg['detail']['receipt']['redirect'], 'Use Python')
        for state in ('dispatching', 'sent'):
            msgs = cv.project_session(run(pending=[packet()]), reviews=[receipt(state=state)])
            requests = [m for m in msgs if m['kind'] == 'request']
            self.assertEqual(len(requests), 1);self.assertIsNotNone(requests[0]['action'])
            self.assertEqual(requests[0]['detail']['receipt']['state'], state)
        msg = self.find(cv.project_session(run(), reviews=[rec], annotations=[event(1, 'approval resolved', {'request_id': 'p1', 'state': 'stale'})]), 'request')
        self.assertEqual(msg['detail']['receipt']['state'], 'sent')

    def test_question_and_terminal_or_stopped_requests(self):
        p = packet(kind='question', questions=[{'header': 'Database?', 'question': 'Choose one', 'options': []}])
        msg = self.find(cv.project_session(run(pending=[p])), 'request')
        self.assertEqual(msg['text'], 'Database?');self.assertEqual(msg['action']['fields']['kind'], 'question')
        for fields in ({'stop': True}, {'status': 'completed'}):
            self.assertFalse(any(m['kind'] == 'request' for m in cv.project_session(run(pending=[p], **fields))))

    def test_team_proposal_only_newest_is_actionable(self):
        r = run(mode='team', team={'state': 'proposed', 'proposal': {'agents': [{'name': 'coder-1'}], 'tasks': [{'title': 'CLI'}]}, 'warnings': ['May conflict']})
        events = [event(1, 'team proposal', 'First proposal'), event(2, 'team proposal', 'Updated proposal')]
        msgs = [m for m in cv.project_session(r, events=events) if m['kind'] == 'proposal']
        self.assertIsNone(msgs[0]['action']);self.assertEqual(msgs[1]['actor'], 'hermes')
        self.assertEqual(msgs[1]['action']['choices'], ['approve_team', 'single_agent', 'repropose'])
        self.assertEqual(msgs[1]['detail']['proposal']['tasks'][0]['title'], 'CLI')
        self.assertEqual(msgs[1]['detail']['warnings'], ['May conflict'])
        for state in ('approved', 'unusable'):
            r['team']['state'] = state
            self.assertTrue(all(m['action'] is None for m in cv.project_session(r, events=events)))
        r['team']['state'] = 'proposed';r['status'] = 'completed'
        self.assertTrue(all(m['action'] is None for m in cv.project_session(r, events=events)))

    def test_research_step_action_and_events(self):
        s = step(agent='researcher-1', status='awaiting_approval', request={'question': 'Find docs', 'why': 'Use docs', 'toolsets': ['web'], 'max_turns': 3, 'seconds': 60, 'fingerprint': 'fp'})
        events = [event(1, 'research requested', {'step': 1, 'question': 'Find docs'}), event(2, 'research report', {'step': 'step1', 'summary': 'Found docs'})]
        msgs = cv.project_session(run(), steps=[s], events=events)
        msg = self.find(msgs, 'research')
        self.assertEqual((msg['id'], msg['actor'], msg['text']), ('turn:step1', 'researcher-1', 'Implement CLI'))
        self.assertEqual(msg['action']['fields'], {'run': 'single', 'step': 'step1', 'fingerprint': 'fp'})
        self.assertTrue(msg['action']['confirm_required']);self.assertEqual(len(msg['detail']['events']), 2)
        self.assertEqual(msg['detail']['request']['question'], 'Find docs')
        s['status'] = 'completed'
        self.assertIsNone(self.find(cv.project_session(run(), steps=[s], events=events), 'research')['action'])
        standalone = self.find(cv.project_session(run(), events=[event(1, 'research failed', {'agent': 'researcher-2', 'text': 'Failed'})]), 'research')
        self.assertEqual((standalone['actor'], standalone['text']), ('researcher-2', 'Failed'))

    def test_skills_actions_and_log(self):
        for state, endpoint in [('awaiting_fetch', '/api/skills/fetch'), ('proposed', '/api/skills/decide'), ('installed', None)]:
            msg = self.find(cv.project_session(run(), capabilities=[{'id': 'c1', 'created': run()['created'], 'name': 'Docs', 'state': state, 'agent': 'coder-1', 'source': 'repo', 'requested_by': 'hermes', 'risk': 'R2', 'reasons': ['docs']}]), 'skill')
            self.assertEqual((msg['id'], msg['actor'], msg['text']), ('cap:c1', 'agentcontrol', 'Docs'))
            self.assertEqual(msg['detail']['state'], state)
            self.assertEqual(msg['action']['endpoint'] if msg['action'] else None, endpoint)
        msg = self.find(cv.project_session(run(), events=[event(1, 'skill installed', 'Docs')]), 'skill')
        self.assertEqual((msg['actor'], msg['text']), ('agentcontrol', 'Docs'))

    def test_research_actions_expire_without_rewriting_recorded_state(self):
        for fields in ({}, *({'status': status} for status in sorted(cv.TERMINAL)), {'stop': True}):
            for status, request in [('awaiting_approval', {'fingerprint': 'fp', 'question': 'Docs'}),
                                    ('awaiting_approval', {}), ('approved', {'question': 'Docs'}),
                                    ('finished', {}), ('failed', {}), ('rejected', {})]:
                with self.subTest(run=fields, step=status, request=request):
                    r = run(**fields)
                    s = step(agent='researcher-1', status=status, request=request)
                    before = copy.deepcopy((r, s))
                    msg = self.find(cv.project_session(r, steps=[s]), 'research')
                    accepts = not fields.get('stop') and fields.get('status') not in cv.TERMINAL
                    self.assertEqual(msg['action'] is not None, accepts and status == 'awaiting_approval' and bool(request))
                    self.assertEqual(msg['detail'].get('expired', False), not accepts and status == 'awaiting_approval')
                    self.assertEqual(msg['detail']['status'], status)
                    self.assertEqual((r, s), before)

    def test_skill_actions_expire_without_rewriting_recorded_state(self):
        for fields in ({}, *({'status': status} for status in sorted(cv.TERMINAL)), {'stop': True}):
            for state in ('proposed', 'awaiting_fetch', 'installed', 'rejected', 'failed'):
                with self.subTest(run=fields, state=state):
                    r = run(**fields)
                    item = {'id': 'docs', 'created': r['created'], 'state': state, 'name': 'Docs', 'agent': 'coder-1'}
                    before = copy.deepcopy((r, item))
                    msg = self.find(cv.project_session(r, capabilities=[item]), 'skill')
                    accepts = not fields.get('stop') and fields.get('status') not in cv.TERMINAL
                    waiting = state in ('proposed', 'awaiting_fetch')
                    self.assertEqual(msg['action'] is not None, accepts and waiting)
                    self.assertEqual(msg['detail'].get('expired', False), not accepts and waiting)
                    self.assertEqual(msg['detail']['state'], state)
                    self.assertEqual((r, item), before)

    def test_stopping_proposal_and_requests_are_not_actionable(self):
        events = [event(1, 'team proposal', 'Old team'), event(2, 'team proposal', 'Current team')]
        for stop in (False, True):
            messages = cv.project_session(run(stop=stop, pending=[packet()], team={'state': 'proposed'}), events=events)
            proposals = [m for m in messages if m['kind'] == 'proposal']
            self.assertIsNone(proposals[0]['action'])
            self.assertEqual(proposals[1]['action'] is not None, not stop)
            self.assertEqual(sum(m['kind'] == 'request' and m['action'] is not None for m in messages), int(not stop))

    def test_progress_alert_and_system(self):
        for event_kind, kind in [('task done', 'progress'), ('attention', 'alert'), ('control', 'system')]:
            msg = self.find(cv.project_session(run(), events=[event(1, event_kind, 'Recorded text')]), kind)
            self.assertEqual((msg['actor'], msg['text']), ('agentcontrol', 'Recorded text'))
        msg = self.find(cv.project_session(run(), events=[event(1, 'review findings', {'agent': 'reviewer-1', 'summary': 'Looks good'})]), 'progress')
        self.assertEqual(msg['actor'], 'reviewer-1')

    def test_unknown_event_is_safe_system_message(self):
        msg = self.find(cv.project_session(run(), events=[event(1, 'future event', {'summary': 'Public', 'reasoning': 'PRIVATE', 'transcript': ['PRIVATE'], 'parts': [{'type': 'reasoning', 'text': 'PRIVATE'}, {'type': 'text', 'text': 'Public'}]})]), 'system')
        self.assertEqual((msg['id'], msg['text']), ('ev:1', 'Public'))
        self.assertNotIn('PRIVATE', json.dumps(msg))
        self.assertEqual(msg['detail']['parts'], [{'type': 'text', 'text': 'Public'}])

    def test_outcome_choices(self):
        r = run(status='completed', ended='2026-09-30T12:01:00+00:00', summary='Done', verifier=['python3'], workspace={'toplevel': '/project'})
        for ws, expected in [({'state': 'open', 'apply_blocked': ''}, ['apply', 'discard_workspace', 'verify']),
                              ({'state': 'open', 'apply_blocked': 'dirty'}, ['discard_workspace', 'verify']),
                              ({'state': 'applied'}, ['verify']), ({'state': 'discarded'}, ['verify'])]:
            msg = self.find(cv.project_session(r, workspace=ws, actionable_outcome=True), 'outcome')
            self.assertEqual((msg['id'], msg['actor'], msg['text']), ('out:single', 'agentcontrol', 'Done'))
            self.assertEqual(msg['action']['choices'], expected)
        r['verifier'] = []
        self.assertIsNone(self.find(cv.project_session(r, workspace={'state': 'applied'}, actionable_outcome=True), 'outcome')['action'])
        r['verifier'] = ['true'];r['manual_verification'] = {'status': 'running'}
        self.assertIsNone(self.find(cv.project_session(r, workspace={'state': 'applied'}, actionable_outcome=True), 'outcome')['action'])
        self.assertIsNone(self.find(cv.project_session(r, workspace={'state': 'open'}), 'outcome')['action'])

    def test_bounds_on_strings_and_lists(self):
        huge = 'x'*50000
        r = run(status='completed', summary=huge, title=huge)
        s = step(result=huge, prompt=huge, evidence={'file_stats': [{'path': huge} for _ in range(70)]})
        msgs = cv.project_session(r, steps=[s], events=[event(1, 'user instruction', huge), event(2, 'Hermes decision', {'summary': huge, 'plan': [huge]*15})])
        for kind in ('session_start', 'outcome', 'turn', 'note', 'decision'):
            msg = self.find(msgs, kind)
            self.assertTrue(msg['detail']['truncated']);self.assertLessEqual(len(msg['text']), 2000)
        turn = self.find(msgs, 'turn')['detail']
        self.assertEqual(len(turn['files']), 50);self.assertEqual(turn['files_omitted'], 20)
        self.assertEqual(len(turn['prompt']), 2000);self.assertEqual(len(turn['result_tail']), 1000)
        self.assertTrue(turn['result_tail'].startswith('…'))
        decision = self.find(msgs, 'decision')['detail']
        self.assertEqual(len(decision['plan']), 12);self.assertEqual(len(decision['plan'][0]), 300)

    def test_ids_revisions_and_purity(self):
        r, steps, events = run(), [step(), step('step2', number=2)], [event(1, 'goal', 'Build')]
        before = copy.deepcopy((r, steps, events))
        a = [cv.revision(m) for m in cv.project_session(r, steps, events)]
        self.assertEqual(a, [cv.revision(m) for m in cv.project_session(r, steps, events)])
        self.assertEqual((r, steps, events), before)
        steps[1]['result'] = 'Updated'
        b = {m['id']: cv.revision(m)['rev'] for m in cv.project_session(r, steps, events)}
        self.assertEqual([m['id'] for m in a if m['rev'] != b[m['id']]], ['turn:step2'])
        for m in a:
            rev = m.pop('rev');self.assertEqual(rev, cv.zlib.crc32(cv.canonical(m).encode()))

    def test_cursor_validation_and_round_trip(self):
        pos = cv.position(run(), cv.project_session(run())[0])
        self.assertEqual(cv.decode_cursor(cv.encode_cursor(pos)), pos)
        for value in ('', 'bad', cv.base64.urlsafe_b64encode(b'[]').decode(), cv.base64.urlsafe_b64encode(b'{"v":1,"position":[]}').decode(), 'x'*3000):
            with self.assertRaises(ValueError):cv.decode_cursor(value)


class ReaderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tmp.name)/'journal.sqlite3')
        self.controller = SimpleNamespace(store=self.store, s=SimpleNamespace(project=Path('/project')), run_project=lambda r:r.get('project'))
        self.workspace_calls = []
        def workspace(r):
            self.workspace_calls.append(r['id']);return {'state': 'open', 'apply_blocked': ''}
        self.controller.workspace_status = workspace

    def tearDown(self):
        self.tmp.cleanup()

    def test_outcome_review_uses_the_existing_single_workspace_read(self):
        for ident, created in [('old', '2026-09-29'), ('new', '2026-09-30')]:
            self.store.put('runs', run(ident, created=created, status='completed', ended=created,
                workspace={'integration': {'branch': 'agent/' + ident}, 'base_branch': 'main'}))
        calls = []
        def workspace(r):
            calls.append(r['id'])
            return {'state': 'open', 'commits': 2, 'shortstat': '1 file changed'}
        self.controller.workspace_status = workspace
        for fields in ({}, {'limit': 1}, {'session_id': 'new'}, {'session_id': 'old'}):
            calls.clear()
            messages = cv.thread(self.controller, **fields)['messages']
            self.assertLessEqual(len(calls), 1)
            for msg in messages:
                if msg['kind'] == 'outcome':
                    self.assertEqual('branch' in msg['detail']['workspace'], msg['session'] == 'new')
                    if msg['session'] == 'new':
                        self.assertEqual(msg['detail']['workspace']['commits'], 2)

    def test_expiry_changes_revisions_once_and_revalidates_known_messages(self):
        seed_waiting_session(self.store, 'single')
        original = {m['id']: m for m in cv.thread(self.controller)['messages']}
        waiting_ids = [ident for ident, m in original.items() if m['kind'] in ('research', 'skill')]
        self.assertEqual(len(waiting_ids), 3)
        for fields in ({'stop': True}, {'status': 'completed', 'stop': False}):
            with self.subTest(run=fields):
                self.store.update('runs', 'single', **fields)
                expired = {m['id']: m for m in cv.thread(self.controller,
                    known={ident: m['rev'] for ident, m in original.items()})['messages']}
                for ident in waiting_ids:
                    self.assertIsNone(expired[ident]['action'])
                    self.assertTrue(expired[ident]['detail']['expired'])
                    self.assertNotEqual(expired[ident]['rev'], original[ident]['rev'])
                revalidated = {m['id']: m for m in cv.thread(self.controller,
                    known={ident: expired[ident]['rev'] for ident in waiting_ids})['messages']}
                for ident in waiting_ids:
                    self.assertEqual(revalidated[ident], {'id': ident, 'rev': expired[ident]['rev'], 'same': True})
                    if fields.get('status') == 'completed':
                        self.assertEqual(expired[ident]['rev'], stopped[ident]['rev'])
                stopped = expired

    def test_waiting_matches_all_paged_actions_across_projects_and_session_states(self):
        cases = [('active', {}, False, False, 5), ('leftovers', {}, True, False, 5),
                 ('stopping', {'stop': True}, True, False, 0),
                 ('no-active', None, True, False, 0), ('proposal', {}, True, True, 1)]
        for name, active_fields, leftovers, proposal_only, expected in cases:
            store = Store(Path(self.tmp.name) / (name + '.sqlite3'))
            if leftovers:
                for project in ('/project', '/other'):
                    seed_waiting_session(store, 'old-' + Path(project).name, project,
                                         status='completed', created='2026-09-29', ended='2026-09-29T12:05:00+00:00',
                                         verifier=['true'], workspace={'toplevel': project})
            if active_fields is not None:
                seed_waiting_session(store, 'active', proposal_only=proposal_only, **active_fields)
            for project in ('/project', '/other'):
                with self.subTest(case=name, project=project):
                    controller = SimpleNamespace(store=store, s=SimpleNamespace(project=Path(project)),
                        run_project=lambda r:r.get('project'), workspace_status=self.controller.workspace_status)
                    with store.connection() as c:
                        before_rows = {t:list(c.execute('SELECT * FROM ' + t)) for t in ('runs', 'steps', 'events', 'capabilities', 'audit')}
                    messages = [];cursor = None;pages = 0
                    while True:
                        page = cv.thread(controller, channel='main', before=cursor, limit=2)
                        messages.extend(page['messages']);pages += 1
                        cursor = page['before']
                        if cursor is None:break
                        self.assertLess(pages, 30, 'cursor walk must terminate')
                    self.assertGreater(pages, 1)
                    self.assertEqual(len(messages), len({m['id'] for m in messages}))
                    actionable = [m for m in messages if m['kind'] != 'outcome' and m['action'] is not None]
                    waiting = cv.channels(controller)['channels'][0]['waiting']
                    self.assertEqual(waiting, len(actionable))
                    self.assertEqual(waiting, expected)
                    self.assertTrue(all(m['session'] == 'active' for m in actionable))
                    if leftovers:
                        self.assertTrue(any(m['kind'] == 'outcome' and m['action'] is not None for m in messages))
                        expired = [m for m in messages if m['session'].startswith('old-') and m['kind'] in ('research', 'skill')]
                        self.assertEqual(len(expired), 3)
                        self.assertTrue(all(m['detail'].get('expired') and m['action'] is None for m in expired))
                    with store.connection() as c:
                        self.assertEqual({t:list(c.execute('SELECT * FROM ' + t)) for t in before_rows}, before_rows)

    def test_waiting_counts_only_unique_actionable_packets_and_recorded_proposals(self):
        self.store.put('runs', run(pending=[packet(), packet(), packet(request_id='refresh', fingerprint=None),
                                           packet(request_id='refresh', fingerprint='later')], team={'state': 'proposed'}))
        self.store.put('steps', step(status='awaiting_approval', request={'question': 'Not research'}))
        for expected in (1, 2):
            messages = cv.thread(self.controller)['messages']
            self.assertEqual(cv.channels(self.controller)['channels'][0]['waiting'], expected)
            self.assertEqual(sum(m['kind'] != 'outcome' and m['action'] is not None for m in messages), expected)
            self.store.event('single', 'team proposal', 'Recorded team')
            self.store.event('single', 'control', 'More recent event')

    def test_events_page_order_exclusion_and_sql_values(self):
        for kind in ('goal', 'control', "x') OR 1=1 --", 'control'):
            self.store.event('single', kind, kind)
        self.store.event('other', 'control', 'other')
        page = self.store.events_page('single', limit=2, exclude_kinds=("x') OR 1=1 --",))
        self.assertEqual([e['id'] for e in page], [4, 2])
        self.assertEqual([e['id'] for e in self.store.events_page('single', before_id=2)], [1])
        self.assertEqual(set(page[0]), {'id', 'kind', 'detail', 'created'})

    def test_workspace_read_at_most_once_and_only_on_page(self):
        for i in range(3):
            self.store.put('runs', run(str(i), status='completed', created=f'2026-09-30T12:0{i}:00+00:00', ended=f'2026-09-30T12:0{i}:59+00:00', workspace={'toplevel': '/project'}, verifier=['true']))
        result = cv.thread(self.controller)
        self.assertEqual(self.workspace_calls, ['2'])
        outcomes = [m for m in result['messages'] if m['kind'] == 'outcome']
        self.assertTrue(all(m['action'] is None for m in outcomes[:-1]))
        self.assertEqual(outcomes[-1]['action']['choices'], ['apply', 'discard_workspace', 'verify'])
        self.workspace_calls.clear()
        cv.thread(self.controller, limit=1)
        self.assertEqual(self.workspace_calls, ['2'])
        self.workspace_calls.clear()
        cv.thread(self.controller, before=cv.encode_cursor(cv.position(run('0'), {'kind':'session_start','at':'2026-09-30T12:00:00+00:00','refs':{},'detail':{},'id':'run:0'})))
        self.assertEqual(self.workspace_calls, [])

    def test_gather_stops_before_reading_older_sessions(self):
        self.store.put('runs', run('old', created='2026-09-29'))
        self.store.put('runs', run('new'))
        original = self.store.steps
        seen = []
        def steps(ident):
            seen.append(ident);return original(ident)
        self.store.steps = steps
        cv.thread(self.controller, limit=1)
        self.assertEqual(seen, ['new', 'old'])  # one lookahead to prove an older page exists
        self.assertEqual(self.workspace_calls, [])

    def test_channels_reads_one_event_row_and_only_active_steps_and_capabilities(self):
        self.store.put('runs', run('old', created='2026-09-29', status='completed'))
        self.store.put('runs', run('active', pending=[packet()]))
        self.store.put('steps', step('old-step', run='old', created='2099-01-01'))
        self.store.put('steps', step('research', run='active', agent='researcher-1', status='awaiting_approval',
                                     request={'question': 'Docs'}, created='2026-09-30T13:00:00+00:00'))
        self.store.put_capability({'id': 'c1', 'run': 'active', 'created': run()['created'], 'state': 'proposed'})
        self.store.event('old', 'control', 'Recorded')
        with self.store.connection() as c:c.execute("UPDATE events SET created='2026-09-30T12:30:00+00:00'")
        calls = {'events': [], 'steps': [], 'capabilities': []}
        events_page, steps, capabilities = self.store.events_page, self.store.steps, self.store.capabilities
        def counted_events(ident, before_id=None, limit=500, exclude_kinds=()):
            calls['events'].append((ident, before_id, limit));return events_page(ident, before_id, limit, exclude_kinds)
        def counted_steps(ident):
            calls['steps'].append(ident);return steps(ident)
        def counted_capabilities(ident, limit=200):
            calls['capabilities'].append(ident);return capabilities(ident, limit)
        self.store.events_page, self.store.steps, self.store.capabilities = counted_events, counted_steps, counted_capabilities
        result = cv.channels(self.controller)['channels'][0]
        self.assertEqual(result['updated'], '2026-09-30T13:00:00+00:00')
        self.assertEqual(result['waiting'], 3)
        self.assertCountEqual(calls['events'], [('active', None, 1), ('old', None, 1)])
        self.assertEqual(calls['steps'], ['active']);self.assertEqual(calls['capabilities'], ['active'])

    def test_gather_uses_one_event_scan_per_batch_and_strips_prompt_annotations(self):
        r = self.store.put('runs', run())
        with self.store.connection() as c:
            c.executemany('INSERT INTO events(run,created,kind,detail) VALUES(?,?,?,?)',
                          [('single', run()['created'], 'control', str(i)) for i in range(5010)])
        self.store.event('single', 'OpenCode prompt', {'step': 1, 'agent': 'coder-2', 'text': 'PRIVATE'})
        self.store.event('single', 'submission uncertain', 'Acknowledgement lost')
        self.store.event('single', 'OpenCode tool', 'PRIVATE')
        self.store.event('single', 'Hermes request', 'PRIVATE')
        calls = [];original = self.store.events_page
        def events_page(ident, before_id=None, limit=500, exclude_kinds=()):
            calls.append((ident, before_id, limit, set(exclude_kinds)))
            return original(ident, before_id, limit, exclude_kinds)
        self.store.events_page = events_page
        bundle = next(cv.gather(self.controller, [r]))
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0][:3], ('single', None, 5000))
        self.assertIsNotNone(calls[1][1])
        for call in calls:self.assertEqual(call[3], cv.OMITTED | (cv.FOLDED - cv.ANNOTATIONS))
        self.assertEqual(len(bundle['events']), 5010)
        self.assertEqual(len(bundle['annotations']), 2)
        prompt = next(e for e in bundle['annotations'] if e['kind'] == 'OpenCode prompt')
        self.assertEqual(prompt['detail'], {'step': 1, 'agent': 'coder-2'})
        self.assertNotIn('PRIVATE', json.dumps(bundle))

    def test_many_events_are_not_silently_capped(self):
        self.store.put('runs', run())
        with self.store.connection() as c:
            c.executemany('INSERT INTO events(run,created,kind,detail) VALUES(?,?,?,?)', [('single', run()['created'], 'control', str(i)) for i in range(5010)])
        seen = set();before = None
        while True:
            result = cv.thread(self.controller, limit=500, before=before)
            for msg in result['messages']:
                self.assertNotIn(msg['id'], seen);seen.add(msg['id'])
            before = result['before']
            if before is None:break
        self.assertEqual(len(seen), 5011)
