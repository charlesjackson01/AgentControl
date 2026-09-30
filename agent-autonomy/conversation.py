"""Read-only conversation projection. No conversation state is stored.

Pure project_session()/session()/position() are independent of the controller.
Gather walks one session at a time, with 5,000-event SELECT batches. V1 materialises
one session's non-omitted messages, never the whole project's event history.
Unknown event kinds deliberately fall back to a bounded, quiet system message.
"""
import base64
import binascii
import json
from pathlib import Path
import re
import zlib

from agents import role_of, TERMINAL

FOLD = 'FOLD'
OMIT = 'OMIT'
MAPPING = {
    'goal': 'goal', 'user instruction': 'note', 'goal check added': 'note',
    'Hermes decision': 'decision', 'Hermes JSON repaired': FOLD,
    'Hermes request': OMIT, 'team proposal': 'proposal',
}
for _kind in ('OpenCode prompt', 'OpenCode tool', 'OpenCode result', 'OpenCode needs input',
              'verification', 'file changes', 'integration', 'session', 'submission uncertain',
              'approval decision', 'approval resolved', 'approval failed', 'approval delivery uncertain',
              'approval confirmation pending', *TERMINAL):
    MAPPING[_kind] = FOLD
for _kind in ('agent state', 'watch', 'connection retry', 'notification', 'notification error'):
    MAPPING[_kind] = OMIT
for _kind in ('team started', 'task started', 'task done', 'task failed', 'task retry', 'task blocked',
              'team tasks finished', 'delegated', 'auto mode', 'proposal rejected', 'delegation refused', 'review findings'):
    MAPPING[_kind] = 'progress'
for _kind in ('research requested', 'research started', 'research report', 'research failed', 'research interrupted'):
    MAPPING[_kind] = 'research'
for _kind in ('skill requested', 'skill installed', 'skill rejected', 'skill removed', 'skill request refused',
              'skills reloaded', 'skills reload failed'):
    MAPPING[_kind] = 'skill'
for _kind in ('attention', 'recovery', 'completion rejected', 'apply conflict', 'watch alert',
              'tester change refused', 'reviewer change discarded', 'read-only refusal', 'vm files refused'):
    MAPPING[_kind] = 'alert'
for _kind in ('control', 'vm', 'container', 'setup', 'preview', 'workspace', 'model warning', 'spend cap',
              'applied', 'discarded', 'verification (on demand)', 'watch unavailable', 'rule not applied',
              'refusal not applied', 'abort error'):
    MAPPING[_kind] = 'system'
OMITTED = {k for k, v in MAPPING.items() if v == OMIT}
FOLDED = {k for k, v in MAPPING.items() if v == FOLD}
# These small folded records carry presentation flags/receipts, not OpenCode output.
ANNOTATIONS = {'OpenCode prompt', 'Hermes JSON repaired', 'submission uncertain', 'approval decision', 'approval resolved',
               'approval failed', 'approval delivery uncertain', 'approval confirmation pending'}
EVENT_BATCH = 5000
RISK_FIELDS = ('level', 'label', 'class', 'decision', 'remember_allowed', 'reasons', 'impact')
PRIVATE_FIELDS = {'reasoning', 'private_reasoning', 'transcript', 'activity', 'prompt', 'output', 'raw', 'tool_output'}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


class Bounds:
    def __init__(self):
        self.truncated = False

    def text(self, value, limit=4000, tail=False):
        text = '' if value is None else str(value)
        if len(text) > limit:
            self.truncated = True
            return ('…' + text[-(limit - 1):]) if tail else (text[:limit - 1] + '…')
        return text

    def value(self, value, limit=4000, count=50, depth=0):
        if isinstance(value, str):
            return self.text(value, limit)
        if depth >= 8 and isinstance(value, (dict, list, tuple)):
            self.truncated = True
            return None
        if isinstance(value, dict):
            if value.get('type') == 'reasoning':
                return None
            items = [(k, v) for k, v in value.items() if k not in PRIVATE_FIELDS]
            if len(items) > count:
                self.truncated = True
            return {self.text(k, limit): self.value(v, limit, count, depth + 1) for k, v in items[:count]}
        if isinstance(value, (list, tuple)):
            value = [v for v in value if not (isinstance(v, dict) and v.get('type') == 'reasoning')]
            if len(value) > count:
                self.truncated = True
            return [self.value(v, limit, count, depth + 1) for v in value[:count]]
        return value

    def fields(self, source, fields, **kwargs):
        return {k: self.value(source[k], **kwargs) for k in fields if k in source}


def decoded(value):
    if isinstance(value, str) and value[:1] in ('{', '['):
        try:
            return json.loads(value)
        except ValueError:
            pass
    return value


def record_text(value, bounds=None):
    b = bounds or Bounds()
    if isinstance(value, dict):
        if value.get('type') == 'reasoning':
            return ''
        for key in ('summary', 'text', 'question', 'title', 'message', 'status', 'name'):
            if isinstance(value.get(key), str):
                return value[key]
        return canonical(b.value(value))
    if isinstance(value, list):
        return canonical(b.value(value))
    return value


def message(run, ident, at, actor, kind, text, detail=None, refs=None, action=None, bounds=None):
    b = bounds or Bounds()
    result = {'id': ident, 'at': at or run.get('created', ''), 'session': run['id'],
              'actor': actor, 'kind': kind, 'text': b.text(text, 2000),
              'refs': refs or {}, 'detail': detail or {}, 'action': action}
    if b.truncated:
        result['detail']['truncated'] = True
    return result


def revision(msg):
    return {**msg, 'rev': zlib.crc32(canonical(msg).encode())}


def session(run):
    b = Bounds()
    goal = (run.get('goal') or '').splitlines()
    return {'id': run['id'], 'title': b.text(run.get('title') or (goal[0][:80] if goal else ''), 2000),
            'status': run.get('status'), 'created': run.get('created'), 'ended': run.get('ended'),
            'parent': run.get('parent_run'), 'mode': run.get('mode', 'single'), 'summary': b.text(run.get('summary', ''), 2000)}


def position(run, msg):
    if msg['kind'] == 'session_start':
        rank = 0
    elif msg['kind'] == 'goal':
        rank = 1
    elif msg['kind'] == 'outcome':
        rank = 4
    elif msg.get('action') is not None or msg['detail'].get('pending'):
        rank = 3
    else:
        rank = 2
    seq = msg['refs'].get('event', msg['detail'].get('number', 0))
    # The final stable id resolves equal source numbers across source types.
    return (run.get('created', ''), run['id'], msg['at'], rank, int(seq or 0), msg['id'])


def request_message(run, packet, receipt, at, pending):
    b = Bounds()
    ident = packet.get('request_id') or packet.get('id') or packet.get('requestID') or ''
    kind = packet.get('kind', (receipt or {}).get('kind', 'permission'))
    patterns = b.value(packet.get('patterns', []), count=10)
    questions = b.value(packet.get('questions', []), count=10)
    text = (str(packet.get('permission', '')) + (' · ' + str(patterns[0]) if patterns else '')) if kind == 'permission' else (questions[0].get('header', '') if questions and isinstance(questions[0], dict) else '')
    detail = {'kind': kind, 'permission': b.value(packet.get('permission')), 'patterns': patterns,
              'risk': b.fields(packet.get('risk') or {}, RISK_FIELDS), 'receipt': None}
    if kind == 'question':
        detail['questions'] = questions
    if receipt:
        detail['receipt'] = b.fields(receipt, ('action', 'state', 'actor', 'risk', 'created', 'updated', 'redirect'))
    action = None
    if pending:
        detail['pending'] = True
        if packet.get('fingerprint'):
            action = {'endpoint': '/api/review', 'fields': {'run': run['id'], 'kind': kind, 'request_id': ident, 'fingerprint': packet['fingerprint']}}
        else:
            detail['refresh_needed'] = True
    return message(run, f'req:{kind}:{ident}', at, packet.get('agent', 'coder-1'), 'request', text, detail, action=action, bounds=b)


def project_session(run, steps=(), events=(), reviews=(), capabilities=(), annotations=(), workspace=None, actionable_outcome=False):
    """Pure projection of one journal session. Inputs are never mutated."""
    start = session(run)
    start_bounds = Bounds()
    start['title'] = start_bounds.text(run.get('title') or start['title'], 2000)
    messages = [message(run, 'run:' + run['id'], run.get('created'), 'agentcontrol', 'session_start', start['title'],
                        {k: start[k] for k in ('title', 'mode', 'parent')}, bounds=start_bounds)]
    terminal = run.get('status') in TERMINAL
    events = sorted(events, key=lambda e: e['id'])
    annotations = sorted([*annotations, *(e for e in events if e['kind'] in ANNOTATIONS)], key=lambda e: e['id'])
    newest_proposal = max((e['id'] for e in events if e['kind'] == 'team proposal'), default=None)
    research_steps = [s for s in steps if role_of(s.get('agent')) == 'researcher']
    research_events = {s['id']: [] for s in research_steps}
    standalone = []
    for event in events:
        if MAPPING.get(event['kind']) != 'research':
            standalone.append(event)
            continue
        data = decoded(event['detail'])
        step_ref = data.get('step') if isinstance(data, dict) else None
        matching = next((s for s in research_steps if step_ref in (s['id'], s.get('number'))), None) if step_ref is not None else None
        if matching is None and step_ref is None:
            matching = next((s for s in reversed(research_steps) if s.get('created', '') <= event['created'] and (not s.get('ended') or event['created'] <= s['ended'])), None)
        if matching:
            research_events[matching['id']].append(event)
        else:
            standalone.append(event)
    repaired_ids = set()
    for annotation in annotations:
        if annotation['kind'] == 'Hermes JSON repaired':
            target = next((e for e in events if e['kind'] == 'Hermes decision' and e['id'] > annotation['id']), None)
            if target:
                repaired_ids.add(target['id'])
    for event in standalone:
        kind = MAPPING.get(event['kind'], 'system')
        if kind in (OMIT, FOLD):
            continue
        b = Bounds()
        # Goals and notes are recorded verbatim strings, even when they look like JSON.
        data = event['detail'] if kind in ('goal', 'note') else decoded(event['detail'])
        detail = {}
        actor = 'you' if kind in ('goal', 'note') else 'hermes' if kind in ('decision', 'proposal') else 'agentcontrol'
        text = record_text(data, b)
        if kind == 'note' and isinstance(data, str):
            aimed = re.match(r'^Note for ([^:]+): ([\s\S]*)$', data)
            redirect = re.match(r'^User denied OpenCode request (.+?)\. Redirection: ([\s\S]*)$', data)
            if aimed:
                detail['to'], text = b.text(aimed[1]), aimed[2]
            elif redirect:
                detail['redirect_for'], text = b.text(redirect[1]), redirect[2]
        elif kind == 'decision':
            if isinstance(data, dict):
                text = data.get('summary', '')
                detail = b.fields(data, ('action', 'title', 'role', 'question'))
                detail['plan'] = b.value(data.get('plan', []), limit=300, count=12)
            else:
                detail['raw'] = True
            if event['id'] in repaired_ids:
                detail['repaired'] = True
        elif isinstance(data, dict):
            detail = b.value(data)
            if event['kind'] == 'review findings':
                actor = data.get('agent', 'agentcontrol')
            elif kind == 'research':
                actor = data.get('agent', 'agentcontrol')
        action = None
        team = run.get('team') or {}
        if kind == 'proposal' and event['id'] == newest_proposal and team.get('state') == 'proposed' and not terminal:
            proposal = team.get('proposal') or {}
            detail['proposal'] = {'agents': b.value(proposal.get('agents', []), limit=300, count=8),
                                  'tasks': b.value(proposal.get('tasks', []), limit=300, count=20)}
            detail['warnings'] = b.value(team.get('warnings', []), limit=300, count=20)
            action = {'endpoint': '/api/control', 'fields': {'run': run['id']}, 'choices': ['approve_team', 'single_agent', 'repropose']}
        messages.append(message(run, 'ev:' + str(event['id']), event['created'], actor, kind, text, detail,
                                {'event': event['id']}, action, b))
    for step in steps:
        b = Bounds()
        files = (step.get('evidence') or {}).get('file_stats') or []
        verification = step.get('verification') or {}
        detail = b.fields(step, ('number', 'status', 'kind', 'ended'))
        detail.setdefault('kind', 'task')
        detail.setdefault('ended', None)
        detail.update({'verification': b.fields(verification, ('status', 'exit_code')),
                       'files': [b.fields(f, ('path', 'change', 'added', 'removed')) for f in files[:50]],
                       'files_omitted': max(0, len(files) - 50), 'result_tail': b.text(step.get('result', ''), 1000, tail=True),
                       'prompt': b.text(step.get('prompt', ''), 2000)})
        if len(files) > 50:
            b.truncated = True
        # A legacy string event has no explicit step id: use its recorded time and the latest turn.
        for event in annotations:
            if event['kind'] != 'submission uncertain':
                continue
            data = decoded(event['detail'])
            target = data.get('step') if isinstance(data, dict) else None
            if target is None:
                prompt = next((e for e in reversed(annotations) if e['kind'] == 'OpenCode prompt' and e['id'] < event['id']), None)
                prompt_data = decoded(prompt['detail']) if prompt else None
                if isinstance(prompt_data, dict):
                    target = prompt_data.get('step')
            if target is None:
                candidates = [s for s in steps if s.get('created', '') <= event['created']]
                target = max(candidates, key=lambda s: (s.get('created', ''), s.get('number', 0)), default={}).get('id')
            if target in (step['id'], step.get('number')):
                detail['uncertain'] = True
        actor = step.get('agent', 'coder-1')
        kind = 'research' if role_of(actor) == 'researcher' else 'turn'
        action = None
        if kind == 'research':
            mine = research_events[step['id']]
            detail['events'] = [{'kind': e['kind'], 'created': e['created'], 'text': b.text(record_text(decoded(e['detail']), b), 2000)} for e in mine[-10:]]
            if len(mine) > 10:
                b.truncated = True
            request = step.get('request') or {}
            if request:
                detail['request'] = b.fields(request, ('question', 'why', 'toolsets', 'max_turns', 'seconds'))
            if step.get('status') == 'awaiting_approval' and request:
                action = {'endpoint': '/api/research/decide', 'fields': {'run': run['id'], 'step': step['id'], 'fingerprint': request.get('fingerprint', '')},
                          'choices': ['approve', 'reject'], 'confirm_required': True}
        messages.append(message(run, 'turn:' + step['id'], step.get('created'), actor, kind, step.get('title', ''), detail,
                                {'step': step['id'], 'agent': actor}, action, b))
    receipts = {(r['kind'], r['request_id']): r for r in reviews}
    pending = run.get('pending', []) if not terminal and not run.get('stop') else []
    pending_keys = set()
    end_at = max(t for t in [run.get('created', ''),
                             *(e['created'] for e in [*events, *annotations]),
                             *(s.get(k) for s in steps for k in ('created', 'ended')),
                             *(r.get(k) for r in reviews for k in ('created', 'updated')),
                             *(c.get('created') for c in capabilities)] if t)
    for packet in pending:
        ident = packet.get('request_id') or packet.get('id') or packet.get('requestID') or ''
        key = (packet.get('kind', 'permission'), ident)
        if key not in pending_keys:
            messages.append(request_message(run, packet, receipts.get(key), end_at, True))
            pending_keys.add(key)
    for key, receipt in receipts.items():
        if key not in pending_keys:
            packet = {**receipt.get('request', {}), 'kind': key[0], 'request_id': key[1]}
            messages.append(request_message(run, packet, receipt, receipt.get('created'), False))
    # Receipts primarily come from reviews. Fold matching event fields without duplicating a request.
    for msg in messages:
        if msg['kind'] != 'request':
            continue
        ident = msg['id'].split(':', 2)[2]
        for event in annotations:
            if not event['kind'].startswith('approval '):
                continue
            data = decoded(event['detail'])
            if isinstance(data, dict) and data.get('request_id') == ident:
                b = Bounds()
                receipt = msg['detail'].get('receipt') or {}
                msg['detail']['receipt'] = {**b.fields(data, ('action', 'state', 'actor', 'risk', 'created', 'updated', 'redirect')), **receipt}
                if b.truncated:
                    msg['detail']['truncated'] = True
    for item in capabilities:
        b = Bounds()
        detail = b.fields(item, ('name', 'agent', 'state', 'source', 'requested_by', 'risk', 'reasons'))
        action = None
        if item.get('state') == 'awaiting_fetch':
            action = {'endpoint': '/api/skills/fetch', 'fields': {'id': item['id']}}
        elif item.get('state') == 'proposed':
            action = {'endpoint': '/api/skills/decide', 'fields': {'id': item['id']}, 'choices': ['approve', 'reject']}
        messages.append(message(run, 'cap:' + item['id'], item.get('created'), 'agentcontrol', 'skill', item.get('name', ''), detail, action=action, bounds=b))
    if terminal:
        b = Bounds()
        detail = b.fields(run, ('status', 'ended'))
        ws = run.get('workspace')
        if ws:
            detail['workspace'] = b.fields(workspace, ('state', 'apply_blocked', 'error')) if workspace is not None else {'state': 'discarded' if ws.get('discarded') else 'applied' if ws.get('applied') else 'open'}
        choices = []
        if actionable_outcome:
            state = (detail.get('workspace') or {}).get('state')
            if state == 'open':
                if not (detail['workspace'].get('apply_blocked')):
                    choices.append('apply')
                choices.append('discard_workspace')
            if run.get('verifier') and (run.get('manual_verification') or {}).get('status') != 'running':
                choices.append('verify')
        action = {'endpoint': '/api/control', 'fields': {'run': run['id']}, 'choices': choices} if choices else None
        messages.append(message(run, 'out:' + run['id'], run.get('ended'), 'agentcontrol', 'outcome', run.get('summary', ''), detail, action=action, bounds=b))
    return sorted(messages, key=lambda m: position(run, m))


def encode_cursor(pos):
    return base64.urlsafe_b64encode(canonical({'v': 1, 'position': pos}).encode()).decode().rstrip('=')


def decode_cursor(cursor):
    if not cursor or len(cursor) > 2048:
        raise ValueError('Malformed cursor')
    try:
        data = json.loads(base64.b64decode(cursor + '=' * (-len(cursor) % 4), altchars=b'-_', validate=True))
        p = data['position']
        if data.get('v') != 1 or not isinstance(p, list) or len(p) != 6 or not all(isinstance(p[i], str) for i in (0, 1, 2, 5)) or type(p[3]) is not int or type(p[4]) is not int or not 0 <= p[3] <= 4:
            raise ValueError()
        return tuple(p)
    except (ValueError, KeyError, TypeError, binascii.Error, UnicodeError):
        raise ValueError('Malformed cursor') from None


def channel_runs(controller):
    project = str(controller.s.project)
    return sorted([r for r in controller.store.runs() if controller.run_project(r) == project or r.get('status') not in TERMINAL],
                  key=lambda r: (r.get('created', ''), r['id']), reverse=True)


def read_events(store, run, exclude):
    before = None
    while True:
        batch = store.events_page(run, before, EVENT_BATCH, tuple(sorted(exclude)))
        yield from batch
        if len(batch) < EVENT_BATCH:
            return
        before = batch[-1]['id']


def annotation_record(event):
    if event['kind'] == 'OpenCode prompt':
        data = decoded(event['detail'])
        return {**event, 'detail': {k: data[k] for k in ('step', 'agent') if k in data} if isinstance(data, dict) else {}}
    return event


def gather(controller, runs):
    """Thin, lazy read adapter. At most one session's records are held at a time."""
    for run in runs:
        store = controller.store
        yield {'run': run, 'steps': store.steps(run['id']),
               'events': list(read_events(store, run['id'], OMITTED | FOLDED)),
               'annotations': [annotation_record(e) for e in read_events(store, run['id'], set(MAPPING) - ANNOTATIONS) if e['kind'] in ANNOTATIONS],
               'reviews': store.reviews(run['id']), 'capabilities': store.capabilities(run['id'], limit=2**31 - 1)}


def thread(controller, channel=None, session_id=None, before=None, limit=200, known=None):
    if channel is not None and session_id is not None:
        raise ValueError('Choose channel or session, not both')
    if channel not in (None, 'main'):
        raise ValueError('Unknown channel')
    cursor = decode_cursor(before) if before is not None else None
    try:
        limit = max(1, min(500, int(limit)))
    except (ValueError, TypeError):
        limit = 200
    room_runs = channel_runs(controller)
    runs = [controller.store.get('runs', session_id)] if session_id is not None else room_runs
    active = next((r for r in room_runs if r.get('status') not in TERMINAL), None)
    selected = []
    bundles = {}
    for bundle in gather(controller, [r for r in runs if cursor is None or (r.get('created', ''), r['id']) <= cursor[:2]]):
        run = bundle['run']
        messages = project_session(**bundle)
        eligible = [m for m in messages if cursor is None or position(run, m) < cursor]
        take = min(len(eligible), limit + 1 - len(selected))
        if take:
            selected = [(run, m) for m in eligible[-take:]] + selected
            # Keep only metadata and records for outcomes on the page, not project history.
            bundles[run['id']] = {'run': run}
        if len(selected) > limit:
            break
    older = len(selected) > limit
    selected = selected[-limit:]
    page_ids = {r['id'] for r, _ in selected}
    page_runs = sorted([b['run'] for ident, b in bundles.items() if ident in page_ids], key=lambda r: (r.get('created', ''), r['id']))
    newest_terminal = next((r for r in reversed(page_runs) if r.get('status') in TERMINAL), None)
    workspace_run = next((r for r in reversed(page_runs) if r.get('status') in TERMINAL and r.get('workspace') and not r['workspace'].get('applied') and not r['workspace'].get('discarded')), None)
    workspace = controller.workspace_status(workspace_run) if workspace_run else None
    outcome_updates = {}
    for r in page_runs:
        if r.get('status') in TERMINAL:
            outcome_updates[r['id']] = next(m for m in project_session(r, workspace=workspace if r is workspace_run else None,
                                                                      actionable_outcome=r is newest_terminal) if m['kind'] == 'outcome')
    full = [revision(outcome_updates.get(r['id'], m) if m['kind'] == 'outcome' else m) for r, m in selected]
    known = known or {}
    return {'channel': 'main', 'project': str(controller.s.project), 'sessions': [session(r) for r in page_runs],
            'messages': [{'id': m['id'], 'rev': m['rev'], 'same': True} if known.get(m['id']) == m['rev'] else m for m in full],
            'before': encode_cursor(position(*selected[0])) if older else None,
            'live': {'session': active['id'] if active else None, 'phase': active.get('phase') if active else None, 'status': active.get('status') if active else None}}


def channels(controller):
    runs = channel_runs(controller)
    active = next((r for r in runs if r.get('status') not in TERMINAL), None)
    waiting = 0
    updated = None
    for run in runs:
        steps = controller.store.steps(run['id'])
        latest_event = max((e['created'] for e in read_events(controller.store, run['id'], ())), default=None)
        times = [s.get('created') for s in steps] + [latest_event]
        updated = max([t for t in [updated, *times] if t], default=None)
        if active and run['id'] == active['id'] and not run.get('stop'):
            waiting = len(run.get('pending', [])) + sum(s.get('status') == 'awaiting_approval' and bool(s.get('request')) for s in steps)
            waiting += int((run.get('team') or {}).get('state') == 'proposed')
            waiting += sum(i.get('state') in ('awaiting_fetch', 'proposed') for i in controller.store.capabilities(run['id'], limit=2**31 - 1))
    return {'project': str(controller.s.project), 'channels': [{'id': 'main', 'kind': 'project', 'title': Path(controller.s.project).name,
            'sessions': len(runs), 'active_session': active['id'] if active else None, 'waiting': waiting, 'updated': updated}]}
