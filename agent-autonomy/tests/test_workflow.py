import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import transcript, Controller, Hermes, OpenCode, OpenCodeHTTPError, ReviewConflict, Settings, Store, review_packet, validate_answers, snapshot, evidence
from app import handler
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import urllib.request
import urllib.error


def coding(prompt='Create the requested file.', kind='task'):
    return {'action': 'code', 'title': 'Implement feature', 'summary': 'Implement the next part.', 'kind': kind, 'prompt': prompt, 'plan': ['Implement', 'Verify']}


def complete():
    return {'action': 'complete', 'summary': 'The requested functionality and tests are present.'}


class FakeManager:
    def __init__(self, decisions):
        self.decisions = decisions
        self.calls = []
        self.hold = None

    def inspect(self):
        return {}

    def decide(self, prompt, cancel):
        self.calls.append(prompt)
        if self.hold:
            while not self.hold.wait(.01):
                if cancel():
                    from engine import Stopped
                    raise Stopped()
        if not self.decisions:
            raise RuntimeError('No fake decisions remaining')
        return self.decisions.pop(0)


class FakeAPI:
    def __init__(self, project):
        self.project = project
        self.messages = []
        self.busy = False
        self.hold = False
        self.prompts = []
        self.aborts = 0
        self.offline = False
        self.error = None
        self.on_submit = None
        self.pending_items = []
        self.decisions = []
        self.keep_pending = False
        self.respond_error = None
        self.directories = []  # every directory= passed by the engine (worktree runs, M6)

    def health(self):
        return {'healthy': True, 'version': 'test'}

    def pending(self, session, directory=None):
        self.directories.append(('pending', directory))
        return copy.deepcopy([p for p in self.pending_items if p.get('sessionID') == session])

    def respond(self, session, request, action, answers=None, directory=None):
        self.directories.append(('respond', directory))
        self.decisions.append((session, request['id'], action, answers))
        if self.respond_error:
            raise self.respond_error
        if not self.keep_pending:
            self.pending_items = [p for p in self.pending_items if p['id'] != request['id']]
        return True

    def request(self, path, method='GET', data=None, directory=None):
        self.directories.append((path.rsplit('/', 1)[-1], directory))
        if self.offline:
            raise OSError('Connection lost')
        if path == '/session' and method == 'POST':
            return {'id': 'ses_test'}
        if path.endswith('/prompt_async'):
            self.prompts.append(copy.deepcopy(data))
            self.messages += [{'info': {'id': data['messageID'], 'role': 'user'}, 'parts': data['parts']}]
            assistant = {'info': {'id': 'a'+str(len(self.prompts)), 'role': 'assistant', 'parentID': data['messageID'], 'time': {}, 'finish': 'stop'},
                         'parts': [{'type': 'text', 'text': 'Implementation done.'}]}
            if self.error:
                assistant['info']['error'] = self.error
            self.messages.append(assistant)
            if self.on_submit:
                self.on_submit(len(self.prompts))
            self.busy = self.hold
            if not self.hold:
                assistant['info']['time']['completed'] = 1
            return None
        if path.endswith('/message'):
            return copy.deepcopy(self.messages)
        if path == '/session/status':
            return {'ses_test': {'type': 'busy'}} if self.busy else {}
        if path.endswith('/abort'):
            self.aborts += 1
            self.finish()
            return True
        raise AssertionError((method, path))

    def finish(self):
        self.busy = False
        if self.messages:
            self.messages[-1]['info']['time']['completed'] = 1


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.project = self.root / 'project'
        self.project.mkdir()
        self.settings = Settings(self.project, self.root / 'state', poll=.01, notifications=False,
                                 step_timeout=5, manager_timeout=5, verify_timeout=5, run_timeout=30)
        self.api = FakeAPI(self.project)
        self.controllers = []

    def tearDown(self):
        for controller in self.controllers:
            controller.shutdown.set()
            for thread in controller.threads.values():
                thread.join(2)
        self.temp.cleanup()

    def controller(self, decisions):
        manager = FakeManager(decisions)
        c = Controller(self.settings, self.api, manager)
        c.check()
        self.controllers.append(c)
        return c, manager

    def wait(self, condition, timeout=5):
        until = time.monotonic()+timeout
        while time.monotonic()<until:
            if condition():
                return
            time.sleep(.01)
        self.fail('Timed out waiting for workflow condition')

    def done(self, c, ident):
        self.wait(lambda: c.store.get('runs', ident)['status'] in ('completed','failed','blocked','stopped','limit_reached','attention'))
        return c.store.get('runs', ident)

    def test_goal_to_prompt_to_verification_to_completion(self):
        c, manager = self.controller([coding('Write useful.py and verify it.'), complete()])
        self.api.on_submit = lambda n: (self.project/'useful.py').write_text('print("ok")\n')
        run = c.new('Build a useful script', f'{sys.executable} useful.py')
        result = self.done(c, run['id'])
        self.assertEqual(result['status'], 'completed', result)
        self.assertEqual(len(self.api.prompts), 1)
        step = c.store.steps(run['id'])[0]
        self.assertEqual(step['prompt'], self.api.prompts[0]['parts'][0]['text'])
        self.assertEqual(step['verification']['status'], 'passed')
        self.assertIn('useful.py', manager.calls[1])
        self.assertIn('print(\\"ok\\")', manager.calls[1])

    def test_failed_verification_triggers_correction_same_session(self):
        c, manager = self.controller([coding(), coding('Fix the failing exit status.', 'correction'), complete()])
        self.api.on_submit = lambda n: (self.project/'verify.py').write_text('raise SystemExit(%d)\n' % (1 if n==1 else 0))
        run = c.new('Build feature', f'{sys.executable} verify.py')
        result = self.done(c, run['id'])
        self.assertEqual(result['status'], 'completed', result)
        self.assertEqual(len(self.api.prompts), 2)
        self.assertNotEqual(self.api.prompts[0]['messageID'], self.api.prompts[1]['messageID'])
        self.assertEqual(c.store.steps(run['id'])[0]['verification']['status'], 'failed')

    def test_cannot_complete_with_failed_verifier(self):
        c, _ = self.controller([coding(), complete(), {'action':'blocked','summary':'Verification still fails.'}])
        run = c.new('Feature', f'{sys.executable} -c "raise SystemExit(1)"')
        self.assertEqual(self.done(c, run['id'])['status'], 'blocked')
        self.assertTrue(any(e['kind']=='completion rejected' for e in c.store.events(run['id'])))

    def test_pause_allows_current_step_finish_but_prevents_next(self):
        self.api.hold = True
        c, manager = self.controller([coding(), coding('Second task'), complete()])
        run = c.new('Two tasks')
        self.wait(lambda: len(self.api.prompts)==1)
        c.control(run['id'], 'pause')
        self.api.finish()
        self.wait(lambda: c.store.get('runs',run['id'])['status']=='paused')
        self.assertEqual(len(manager.calls), 1)
        c.control(run['id'], 'instruction', 'Keep this small.')
        self.api.hold = False
        c.control(run['id'], 'resume')
        self.assertEqual(self.done(c,run['id'])['status'], 'completed')
        self.assertIn('Keep this small.', manager.calls[1])

    def test_new_instruction_discards_stale_unsubmitted_decision(self):
        c, manager = self.controller([coding('OLD'), coding('NEW'), complete()])
        manager.hold = threading.Event()
        run = c.new('A feature')
        self.wait(lambda: len(manager.calls)==1)
        c.control(run['id'], 'instruction', 'Use the new requirement')
        manager.hold.set()
        self.assertEqual(self.done(c,run['id'])['status'], 'completed')
        self.assertEqual(len(self.api.prompts), 1)
        self.assertTrue(self.api.prompts[0]['parts'][0]['text'].startswith('NEW'))

    def test_stop_aborts_only_managed_session(self):
        self.api.hold=True
        c, _ = self.controller([coding()])
        run=c.new('Feature')
        self.wait(lambda: len(self.api.prompts)==1)
        c.control(run['id'],'stop')
        self.assertEqual(self.done(c,run['id'])['status'],'stopped')
        self.assertEqual(self.api.aborts,1)

    def test_step_limit_is_enforced(self):
        c,_=self.controller([coding(),coding('Too much work')])
        run=c.new('Feature',max_steps=1)
        self.assertEqual(self.done(c,run['id'])['status'],'limit_reached')
        self.assertEqual(len(self.api.prompts),1)

    def test_three_failed_steps_stop_even_if_model_calls_them_new_tasks(self):
        c,_=self.controller([coding(),coding(),coding(),coding()])
        run=c.new('Feature', f'{sys.executable} -c "raise SystemExit(1)"')
        self.assertEqual(self.done(c,run['id'])['status'],'blocked')
        self.assertEqual(len(self.api.prompts),3)

    def test_idle_with_only_old_message_does_not_complete_current_step(self):
        self.api.messages=[{'info':{'id':'old','role':'assistant','parentID':'old_request','time':{'completed':1},'finish':'stop'},'parts':[{'type':'text','text':'Old success'}]}]
        self.api.hold=True
        c,_=self.controller([coding()])
        run=c.new('New feature')
        self.wait(lambda: len(self.api.prompts)==1)
        self.api.busy=False  # brief idle before the new reply is complete
        time.sleep(.1)
        self.assertEqual(c.store.get('runs',run['id'])['status'],'coding')
        self.assertEqual(c.store.steps(run['id'])[0]['status'],'running')
        c.control(run['id'],'stop')
        self.done(c,run['id'])

    def test_restart_reconciles_without_replaying_prompt(self):
        self.api.hold=True
        c,_=self.controller([coding()])
        run=c.new('Feature')
        self.wait(lambda: len(self.api.prompts)==1)
        c.shutdown.set()
        c.threads[run['id']].join(2)
        self.api.finish()
        restarted,manager=self.controller([complete()])
        self.assertEqual(restarted.store.get('runs',run['id'])['status'],'interrupted')
        restarted.control(run['id'],'resume')
        self.assertEqual(self.done(restarted,run['id'])['status'],'completed')
        self.assertEqual(len(self.api.prompts),1)

    def test_connection_loss_is_attention_and_resume_does_not_replay(self):
        self.api.hold=True
        c,_=self.controller([coding(),complete()])
        run=c.new('Feature')
        self.wait(lambda: len(self.api.prompts)==1)
        self.api.offline=True
        self.assertEqual(self.done(c,run['id'])['status'],'attention')
        c.threads[run['id']].join(2)
        self.api.offline=False
        self.api.finish()
        c.control(run['id'],'resume')
        self.assertEqual(self.done(c,run['id'])['status'],'completed')
        self.assertEqual(len(self.api.prompts),1)

    def test_timeout_attempts_abort_and_reports_failure(self):
        self.settings.step_timeout=.1
        self.api.hold=True
        c,_=self.controller([coding()])
        run=c.new('Feature')
        self.assertEqual(self.done(c,run['id'])['status'],'failed')
        self.assertEqual(self.api.aborts,1)

    def test_reject_overlapping_runs(self):
        self.api.hold=True
        c,_=self.controller([coding()])
        run=c.new('First')
        with self.assertRaises(ValueError): c.new('Second')
        c.control(run['id'],'stop')
        self.done(c,run['id'])

    def test_manager_uses_supported_cli_flags_and_json_terminal_result(self):
        helper=Hermes(self.settings)
        helptext='--quiet --query --toolsets --max-turns --query-file --oneshot --ignore-rules stream-json'
        terminal=json.dumps({'type':'result','exit_code':0,'text':json.dumps(complete())})+'\n'
        with patch('adapters.hermes.process',side_effect=[(0,helptext,''),(0,terminal,'')]) as mocked:
            result=helper.decide('A goal with `literal text`',lambda:False)
        self.assertEqual(result['action'],'complete')
        argv=mocked.call_args_list[1].args[0]
        self.assertIn('--query-file',argv)
        self.assertIn('--profile',argv)
        self.assertNotIn('--yolo',argv)

    def test_opencode_error_cannot_be_reported_as_completed(self):
        self.api.error={'name':'ProviderError','message':'Provider rejected request'}
        c,_=self.controller([coding(),complete(),{'action':'blocked','summary':'Provider error needs attention.'}])
        run=c.new('Feature')
        self.assertEqual(self.done(c,run['id'])['status'],'blocked')
        self.assertEqual(c.store.steps(run['id'])[0]['status'],'failed')

    def test_full_http_cli_and_notification_path(self):
        fake=self.api
        project=self.project
        class OpenCodeHTTP(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_GET(self):
                parsed=urllib.parse.urlsplit(self.path)
                assert urllib.parse.parse_qs(parsed.query)['directory']==[str(project)]
                if parsed.path=='/global/health': data=fake.health()
                elif parsed.path=='/path': data={'directory':str(project)}
                elif parsed.path in ('/permission','/question'): data=[]
                else: data=fake.request(parsed.path)
                self.send_response(200);self.end_headers();self.wfile.write(json.dumps(data).encode())
            def do_POST(self):
                path=urllib.parse.urlsplit(self.path).path
                data=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                value=fake.request(path,'POST',data)
                self.send_response(204 if value is None else 200);self.end_headers()
                if value is not None: self.wfile.write(json.dumps(value).encode())
        server=ThreadingHTTPServer(('127.0.0.1',0),OpenCodeHTTP)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        binary=self.root/'hermes-stub'
        pushlog=self.root/'push.log'
        binary.write_text('#!'+sys.executable+'\n'+'''import json,sys,pathlib
args=sys.argv[1:]
if '--help' in args:
 print('--quiet --toolsets --query --max-turns --query-file --oneshot --ignore-rules stream-json')
elif 'send' in args:
 with pathlib.Path(__file__).with_name('push.log').open('a') as f:f.write(args[-1]+'\\n')
else:
 p=pathlib.Path(args[args.index('--query-file')+1]).read_text()
 context=json.loads(p.split('WORKFLOW CONTEXT:\\n')[1])
 decision={'action':'complete','summary':'File and verifier confirmed.'} if context['step_history'] else {'action':'code','summary':'Implement the file.','title':'Create file','prompt':'Create useful.py.'}
 print(json.dumps({'type':'result','exit_code':0,'text':json.dumps(decision)}))
''')
        binary.chmod(0o700)
        self.settings.hermes=str(binary)
        self.settings.opencode_url='http://127.0.0.1:'+str(server.server_port)
        self.settings.notifications=True
        fake.on_submit=lambda n:(project/'useful.py').write_text('print("works")\n')
        c=Controller(self.settings)
        self.controllers.append(c)
        try:
            self.assertTrue(c.check()['ready'])
            run=c.new('Implement useful.py', f'{sys.executable} useful.py')
            self.assertEqual(self.done(c,run['id'])['status'],'completed')
            self.wait(lambda:pushlog.exists() and 'Completed.' in pushlog.read_text())
            self.assertEqual(len(fake.prompts),1)
        finally:
            server.shutdown();server.server_close()

    def test_http_auth_and_goal_submission(self):
        c,_=self.controller([coding(),complete()])
        server=ThreadingHTTPServer(('127.0.0.1',0),handler(c,'test-key'))
        thread=threading.Thread(target=server.serve_forever,daemon=True)
        thread.start()
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        url='http://127.0.0.1:'+str(server.server_port)
        try:
            with self.assertRaises(urllib.error.HTTPError) as err:
                opener.open(url+'/api/state')
            self.assertEqual(err.exception.code,401)
            request=urllib.request.Request(url+'/api/runs',data=json.dumps({'goal':'Feature'}).encode(),headers={'Authorization':'Bearer test-key','Content-Type':'application/json'})
            with opener.open(request) as response:
                ident=json.load(response)['id']
            self.assertEqual(self.done(c,ident)['status'],'completed')
        finally:
            server.shutdown()
            server.server_close()

    def review_run(self, question=False):
        self.api.hold=True
        packet={'kind':'permission','id':'per_1','sessionID':'ses_test','permission':'bash',
                'patterns':['python3 -m unittest'], 'metadata':{'description':'Run the project tests'},'always':['python3 *']}
        if question:
            packet={'kind':'question','id':'que_1','sessionID':'ses_test','questions':[{'header':'Storage','question':'Where should tasks be stored?',
                'options':[{'label':'JSON','description':'A file next to the app'},{'label':'SQLite','description':'A small database'}], 'custom':False}]}
        self.api.pending_items=[packet]
        c,_=self.controller([coding(),complete()])
        run=c.new('Implement the todo app')
        self.wait(lambda: bool(c.state()['inbox']))
        return c,run,c.state()['inbox'][0]

    def submit_review(self,c,run,packet,action='approve',answers=None):
        return c.review(run['id'],packet['kind'],packet['request_id'],packet['fingerprint'],action,answers)

    def test_permission_approve_once_and_workflow_resumes(self):
        c,run,packet=self.review_run()
        receipt=self.submit_review(c,run,packet)
        self.assertEqual(receipt['state'],'confirmed')
        self.assertEqual(self.api.decisions,[('ses_test','per_1','approve',None)])
        self.assertFalse(c.state()['inbox'])
        self.api.finish()
        self.assertEqual(self.done(c,run['id'])['status'],'completed')

    def test_permission_rejection_is_recorded(self):
        c,run,packet=self.review_run()
        receipt=self.submit_review(c,run,packet,'reject')
        self.assertEqual(receipt['action'],'reject')
        self.assertEqual(c.state()['reviews'][0]['actor'],'You, via dashboard')
        self.assertEqual(self.api.decisions[0][2],'reject')

    def test_changed_request_cannot_be_approved_from_old_window(self):
        c,run,packet=self.review_run()
        self.api.pending_items[0]['patterns']=['a different command']
        with self.assertRaises(ReviewConflict): self.submit_review(c,run,packet)
        self.assertEqual(self.api.decisions,[])

    def test_changed_tool_input_invalidates_displayed_permission(self):
        c,run,packet=self.review_run()
        assistant=self.api.messages[-1]
        native=self.api.pending_items[0]
        native['tool']={'messageID':assistant['info']['id'],'callID':'call_1'}
        assistant['parts'].append({'type':'tool','tool':'bash','callID':'call_1',
            'state':{'input':{'command':'python3 -m unittest'}}})
        displayed=review_packet(native,self.api.messages)
        self.assertEqual(displayed['context']['input']['command'],'python3 -m unittest')
        assistant['parts'][-1]['state']['input']['command']='changed-command'
        with self.assertRaises(ReviewConflict): self.submit_review(c,run,displayed)
        self.assertFalse(self.api.decisions)

    def test_removed_or_foreign_request_is_rejected(self):
        c,run,packet=self.review_run()
        self.api.pending_items[0]['sessionID']='ses_elsewhere'
        with self.assertRaises(ReviewConflict): self.submit_review(c,run,packet)
        self.assertEqual(self.api.decisions,[])

    def test_double_tap_sends_only_one_decision(self):
        c,run,packet=self.review_run()
        first=self.submit_review(c,run,packet)
        second=self.submit_review(c,run,packet)
        self.assertEqual(first['state'],second['state'])
        self.assertEqual(len(self.api.decisions),1)

    def test_http_success_without_resolution_shows_waiting_confirmation(self):
        c,run,packet=self.review_run()
        self.api.keep_pending=True
        receipt=self.submit_review(c,run,packet)
        self.assertEqual(receipt['state'],'sent')
        self.assertEqual(c.state()['inbox'][0]['receipt']['state'],'sent')

    def test_uncertain_reply_is_not_retried(self):
        c,run,packet=self.review_run()
        self.api.respond_error=TimeoutError('lost reply')
        first=self.submit_review(c,run,packet)
        second=self.submit_review(c,run,packet)
        self.assertEqual(first['state'],'uncertain')
        self.assertEqual(second['state'],'uncertain')
        self.assertEqual(len(self.api.decisions),1)

    def test_uncertain_decision_survives_restart_without_replay(self):
        c,run,packet=self.review_run()
        self.api.respond_error=TimeoutError('lost reply')
        self.submit_review(c,run,packet)
        c.shutdown.set()
        for thread in c.threads.values(): thread.join(2)
        restarted,_=self.controller([complete()])
        result=self.submit_review(restarted,run,packet)
        self.assertEqual(result['state'],'uncertain')
        self.assertEqual(len(self.api.decisions),1)

    def test_question_answer_can_be_sent_from_dashboard(self):
        c,run,packet=self.review_run(question=True)
        result=self.submit_review(c,run,packet,'answer',[['JSON']])
        self.assertEqual(result['state'],'confirmed')
        self.assertEqual(self.api.decisions[0][-1],[['JSON']])

    def test_invalid_question_answers_are_rejected(self):
        c,run,packet=self.review_run(question=True)
        for answers in ([],[[]],[['JSON','SQLite']],[['Something else']]):
            with self.assertRaises(ValueError): self.submit_review(c,run,packet,'answer',answers)
        self.assertFalse(self.api.decisions)

    def test_permission_scope_cannot_be_widened_by_api(self):
        c,run,packet=self.review_run()
        with self.assertRaises(ValueError): self.submit_review(c,run,packet,'always')
        self.assertFalse(self.api.decisions)

    def test_permission_adapter_modern_and_legacy_routes(self):
        client=OpenCode(self.settings)
        packet={'kind':'permission','id':'per_1','sessionID':'ses_test'}
        with patch.object(client,'request',return_value=True) as request:
            client.respond('ses_test',packet,'approve')
            self.assertEqual(request.call_args.args,('/permission/per_1/reply','POST',{'reply':'once'}))
        with patch.object(client,'request',side_effect=[OpenCodeHTTPError('POST','/permission/per_1/reply',404,'Not found'),True]) as request, patch.object(client,'pending',return_value=[packet]):
            client.respond('ses_test',packet,'reject')
            self.assertEqual(request.call_args.args,('/session/ses_test/permissions/per_1','POST',{'response':'reject'}))

    def test_legacy_fallback_stops_when_request_changes(self):
        client=OpenCode(self.settings)
        packet={'kind':'permission','id':'per_1','sessionID':'ses_test','patterns':['original']}
        changed={**packet,'patterns':['changed']}
        with patch.object(client,'request',side_effect=OpenCodeHTTPError('POST','/permission/per_1/reply',404,'Not found')) as request, patch.object(client,'pending',return_value=[changed]):
            with self.assertRaises(ReviewConflict): client.respond('ses_test',packet,'approve')
            self.assertEqual(request.call_count,1)

    def test_question_adapter_answer_and_reject_routes(self):
        client=OpenCode(self.settings)
        packet={'kind':'question','id':'que_1','sessionID':'ses_test'}
        with patch.object(client,'request',return_value=True) as request:
            client.respond('ses_test',packet,'answer',[['JSON'],['first','second']])
            self.assertEqual(request.call_args.args,('/question/que_1/reply','POST',{'answers':[['JSON'],['first','second']]}))
            client.respond('ses_test',packet,'reject')
            self.assertEqual(request.call_args.args,('/question/que_1/reject','POST',{}))

    def test_goal_checks_time_limit_and_followup_context(self):
        self.settings.run_timeout=7200
        c,manager=self.controller([coding(),complete(),coding(),complete()])
        first=c.new('Build a small app',goal_checks=['Save and reload tasks'],run_minutes=30)
        self.assertEqual(first['time_limit_seconds'],1800)
        self.assertEqual(self.done(c,first['id'])['status'],'completed')
        self.assertEqual(c.store.get('runs',first['id'])['goal_checks'][0]['status'],'pending')
        second=c.new('Extend the app',parent_run=first['id'],goal_checks=['Add a due date'])
        self.assertEqual(self.done(c,second['id'])['status'],'completed')
        context=json.loads(manager.calls[2].split('WORKFLOW CONTEXT:\n')[1])
        self.assertEqual(context['parent_run_context']['id'],first['id'])
        self.assertEqual(context['goal_checks'][0]['criterion'],'Add a due date')

    def test_invalid_new_run_limits_and_checks_are_rejected(self):
        c,_=self.controller([coding()])
        for checks in ('invented',[{}],[''],['x'*1001],['x']*21):
            with self.assertRaises(ValueError): c.new('Goal',goal_checks=checks)
        for minutes in (0,True,121,1.5):
            with self.assertRaises(ValueError): c.new('Goal',run_minutes=minutes)
        self.assertFalse(self.api.prompts)

    def test_goal_check_added_midrun_is_saved_and_forwarded(self):
        self.api.hold=True
        c,manager=self.controller([coding(),complete()])
        run=c.new('Build an app')
        self.wait(lambda:len(self.api.prompts)==1)
        c.control(run['id'],'goal_check','Preserve existing tasks on reload')
        self.api.finish()
        result=self.done(c,run['id'])
        self.assertEqual(result['goal_checks'][0]['criterion'],'Preserve existing tasks on reload')
        self.assertIn('Additional goal check',manager.calls[-1])

    def test_deny_redirect_is_saved_once_before_dispatch(self):
        c,run,packet=self.review_run()
        original=self.api.respond
        def respond(*args,**kwargs):
            self.assertIn('Use the standard library',c.store.get('runs',run['id'])['instructions'][-1]['text'])
            return original(*args,**kwargs)
        self.api.respond=respond
        arguments=(run['id'],packet['kind'],packet['request_id'],packet['fingerprint'],'reject',None,'Use the standard library')
        receipt=c.review(*arguments)
        c.review(*arguments)
        self.assertTrue(receipt['redirect_saved'])
        self.assertEqual(len(self.api.decisions),1)
        self.assertEqual(len(c.store.get('runs',run['id'])['instructions']),1)

    def test_stale_denial_cannot_add_a_redirection(self):
        c,run,packet=self.review_run()
        with self.assertRaises(ReviewConflict): c.review(run['id'],'permission',packet['request_id'],'stale','reject',redirect='Use another approach')
        self.assertFalse(c.store.get('runs',run['id'])['instructions'])

    def test_retry_failed_denial_updates_redirect_without_duplicates(self):
        c,run,packet=self.review_run()
        self.api.respond_error=OpenCodeHTTPError('POST','/permission/per_1/reply',400,'rejected')
        arguments=(run['id'],'permission',packet['request_id'],packet['fingerprint'],'reject')
        with self.assertRaises(OpenCodeHTTPError): c.review(*arguments,redirect='First note')
        self.api.respond_error=None
        c.review(*arguments,redirect='Revised note')
        notes=c.store.get('runs',run['id'])['instructions']
        self.assertEqual(len(notes),1)
        self.assertIn('Revised note',notes[0]['text'])

    def test_file_stats_report_actual_captured_changes(self):
        (self.project/'changed.py').write_text('--old\n')
        (self.project/'removed.py').write_text('removed\n')
        before=snapshot(self.project)
        (self.project/'changed.py').write_text('++new\nextra\n')
        (self.project/'removed.py').unlink()
        (self.project/'added.py').write_text('added\n')
        stats={item['path']:item for item in evidence(before,snapshot(self.project))['file_stats']}
        self.assertEqual((stats['changed.py']['added'],stats['changed.py']['removed']),(2,1))
        self.assertEqual(stats['added.py']['change'],'new')
        self.assertEqual(stats['removed.py']['change'],'deleted')

    def test_step_records_transcript_and_planning_context(self):
        c, manager = self.controller([coding('Write useful.py.'), complete()])
        run = c.new('Build a useful script')
        self.done(c, run['id'])
        step = c.store.steps(run['id'])[0]
        self.assertEqual(step['transcript'][-1], {'type':'text','text':'Implementation done.'})
        self.assertEqual(step['plan_summary'], 'Implement the next part.')
        self.assertEqual(step['plan'], ['Implement', 'Verify'])
        self.assertEqual(step['kind'], 'task')

    def test_verify_now_runs_saved_command_only_at_a_safe_boundary(self):
        c, manager = self.controller([coding(), complete()])
        self.api.on_submit = lambda n: (self.project/'ok.py').write_text('print(1)\n')
        run = c.new('Build ok.py', f'{sys.executable} ok.py')
        self.done(c, run['id'])
        c.control(run['id'], 'verify')
        self.wait(lambda: c.store.get('runs', run['id'])['manual_verification']['status'] != 'running')
        result = c.store.get('runs', run['id'])['manual_verification']
        self.assertEqual((result['status'], result['exit_code']), ('passed', 0))
        self.assertIn('verification (on demand)', [e['kind'] for e in c.store.events(run['id'])])
        (self.project/'ok.py').write_text('raise SystemExit(3)\n')
        c.control(run['id'], 'verify')
        self.wait(lambda: c.store.get('runs', run['id'])['manual_verification']['status'] != 'running')
        self.assertEqual(c.store.get('runs', run['id'])['manual_verification']['exit_code'], 3)

    def test_verify_now_is_refused_during_work_or_without_a_command(self):
        c, manager = self.controller([coding(), complete()])
        self.api.hold = True
        run = c.new('Build something', f'{sys.executable} -c pass')
        self.wait(lambda: c.store.get('runs', run['id'])['status'] == 'coding')
        with self.assertRaisesRegex(ValueError, 'paused or finished'):
            c.control(run['id'], 'verify')
        self.api.hold = False
        self.api.finish()
        self.done(c, run['id'])
        c.store.update('runs', run['id'], verifier=[])
        with self.assertRaisesRegex(ValueError, 'no verification command'):
            c.control(run['id'], 'verify')

    def test_run_title_is_optional_validated_and_editable(self):
        c, manager = self.controller([coding(), complete()])
        with self.assertRaisesRegex(ValueError, '120'):
            c.new('Goal', title='x' * 121)
        run = c.new('A long goal that needs a short name', title='  Todo   app ')
        self.assertEqual(run['title'], 'Todo app')
        self.assertEqual(c.state(run['id'])['runs'][0]['title'], 'Todo app')
        c.control(run['id'], 'title', 'Renamed')
        self.assertEqual(c.store.get('runs', run['id'])['title'], 'Renamed')
        self.done(c, run['id'])
        self.assertTrue(c.state()['capabilities']['verify_now'])

    def test_agent_readiness_is_independent_and_does_not_claim_model_online(self):
        c,_=self.controller([])
        with patch.object(self.api,'health',side_effect=OSError('Offline')):
            status=c.check()
        self.assertFalse(status['ready'])
        self.assertEqual(status['agents']['opencode']['state'],'unavailable')
        self.assertEqual(status['agents']['hermes']['label'],'CLI ready; model unchecked')

    def test_review_api_requires_auth_and_returns_stale_conflict(self):
        c,run,packet=self.review_run()
        server=ThreadingHTTPServer(('127.0.0.1',0),handler(c,'review-key'))
        threading.Thread(target=server.serve_forever,daemon=True).start()
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        payload={'run':run['id'],'kind':'permission','request_id':'per_1','fingerprint':'stale','action':'approve'}
        url='http://127.0.0.1:'+str(server.server_port)+'/api/review'
        try:
            req=urllib.request.Request(url,data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'})
            with self.assertRaises(urllib.error.HTTPError) as err: opener.open(req)
            self.assertEqual(err.exception.code,401)
            req.add_header('Authorization','Bearer review-key')
            with self.assertRaises(urllib.error.HTTPError) as err: opener.open(req)
            self.assertEqual(err.exception.code,409)
            payload['fingerprint']=packet['fingerprint']
            req=urllib.request.Request(url,data=json.dumps(payload).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer review-key'})
            with opener.open(req) as response:
                self.assertEqual(response.status,200)
                self.assertEqual(json.load(response)['state'],'confirmed')
            self.assertEqual(len(self.api.decisions),1)
        finally: server.shutdown();server.server_close()


class TranscriptTests(unittest.TestCase):
    def test_parts_keep_order_and_running_tool_output(self):
        messages=[{'info':{'id':'a1'},'parts':[
            {'type':'text','text':'Reading files.'},
            {'type':'tool','id':'t1','tool':'read','state':{'status':'completed','input':{'filePath':'todo.py'},'output':'x=1'}},
            {'type':'reasoning','text':'hidden'},
            {'type':'tool','id':'t2','tool':'bash','state':{'status':'running','input':{'command':'python3 -m unittest'},'metadata':{'output':'test_add ... ok'}}},
            {'type':'tool','id':'t3','tool':'edit','state':{'status':'error','input':{'filePath':'a.py'},'error':'denied'}}]}]
        parts,omitted=transcript(messages)
        self.assertEqual(omitted,0)
        self.assertEqual([p['type'] for p in parts],['text','tool','tool','tool'])
        self.assertEqual(parts[1]['summary'],'todo.py')
        self.assertEqual((parts[2]['status'],parts[2]['summary'],parts[2]['output']),('running','python3 -m unittest','test_add ... ok'))
        self.assertEqual(parts[3]['output'],'denied')
        self.assertNotIn('hidden',json.dumps(parts))

    def test_transcript_is_bounded_from_the_start(self):
        messages=[{'info':{},'parts':[{'type':'text','text':f'line {i} '+'x'*1000} for i in range(400)]}]
        parts,omitted=transcript(messages,max_parts=300,max_chars=50_000)
        self.assertLessEqual(sum(len(p['text']) for p in parts),50_000)
        self.assertTrue(parts[-1]['text'].startswith('line 399'))
        self.assertEqual(omitted,400-len(parts))

    def test_controller_files_are_not_project_evidence(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'agent-autonomy').mkdir();(root/'agent-autonomy'/'app.py').write_text('x')
            (root/'main.py').write_text('y')
            self.assertEqual(list(snapshot(root)['files']),['main.py'])


if __name__=='__main__':
    unittest.main()
