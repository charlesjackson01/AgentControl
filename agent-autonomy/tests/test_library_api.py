"""N2 real HTTP contracts, classic compatibility and unchanged execution."""
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import secrets
import sys
import tempfile
import threading
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path[:0]=[str(Path(__file__).resolve().parents[1]),str(Path(__file__).resolve().parent)]
from app import handler
from engine import Controller, Settings
from test_workflow import FakeAPI, FakeManager, coding, complete
from test_workspaces import make_repo

POSTS=['/api/library/agents/create','/api/library/agents/update','/api/library/agents/archive',
       '/api/library/skills/assign','/api/library/policy','/api/projects/create',
       '/api/projects/register','/api/projects/members']


class LibraryAPITests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='ac-n2-http-');self.root=Path(self.temp.name)
        self.repo=make_repo(self.root);self.key=secrets.token_urlsafe(12)
        skills=self.root/'skills';(skills/'docs').mkdir(parents=True)
        (skills/'docs'/'SKILL.md').write_text('---\nname: docs\ndescription: Read docs\ntools: [read, bash]\n---\nDocumentation')
        self.c=Controller(Settings(self.repo,self.root/'state',poll=.01,notifications=False,projects_root=self.root,skills_library=skills),FakeAPI(self.repo),FakeManager([complete()]))
        self.c.check();base=handler(self.c,self.key)
        class Quiet(base):
            def log_message(self,*args):pass
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Quiet)
        self.worker=threading.Thread(target=self.server.serve_forever,kwargs={'poll_interval':.01},daemon=True);self.worker.start()
        self.url='http://127.0.0.1:'+str(self.server.server_port)

    def tearDown(self):
        self.c.shutdown.set()
        for thread in self.c.threads.values():thread.join(5)
        self.c.preview.close();self.server.shutdown();self.server.server_close();self.worker.join(5)
        root=self.root;self.temp.cleanup();self.assertFalse(root.exists())

    def request(self,path,body=None,auth=True):
        headers={'Content-Type':'application/json'}
        if auth:headers['Authorization']='Bearer '+self.key
        request=Request(self.url+path,data=json.dumps(body).encode() if body is not None else None,headers=headers)
        with urlopen(request,timeout=10) as response:
            self.assertEqual(response.headers['Cache-Control'],'no-store')
            self.assertEqual(response.headers['X-Content-Type-Options'],'nosniff')
            self.assertEqual(response.headers['X-Frame-Options'],'DENY')
            return json.load(response)

    def refusal(self,path,body=None,status=400,auth=True):
        with self.assertRaises(HTTPError) as caught:self.request(path,body,auth)
        self.assertEqual(caught.exception.code,status);result=json.load(caught.exception);caught.exception.close();self.assertTrue(result['error']);return result

    def agent(self):
        return self.request('/api/library/agents/create',{'kind':'specialist','name':'Reader','engine_type':'reviewer','model':None,'display_role':'Reviews changes','instructions':'PRIVATE-API-INSTRUCTIONS'})

    def test_every_new_endpoint_requires_bearer_key_and_object(self):
        for path in ['/api/library','/api/projects']:
            with self.subTest(path=path):self.refusal(path,status=401,auth=False)
        for path in POSTS:
            with self.subTest(path=path):
                self.refusal(path,{},401,False)
                self.refusal(path,[])
        self.assertEqual(self.request('/api/library')['agents'],[])
        self.assertEqual(self.request('/api/projects')['projects'],[])

    def test_all_new_operations_and_skill_projection(self):
        a=self.agent()
        self.request('/api/library/agents/update',{'id':a['id'],'display_role':'Updated'})
        self.request('/api/library/agents/create',{'kind':'primary','name':'Primary'})
        created=self.request('/api/projects/create',{'name':'Human project name','path':'one/two','members':[a['id']]})
        self.assertEqual(created['project'],str(self.root/'one'/'two'))
        listing=self.request('/api/projects');project=listing['projects'][0]
        self.assertEqual(project['members'],[a['id']]);self.assertTrue(project['current'])
        self.request('/api/library/skills/assign',{'agent':a['id'],'skill':'docs','assigned':True})
        self.request('/api/library/policy',{'agent':a['id'],'permission':'bash','mode':'deny'})
        result=self.request('/api/library')['agents'][0]
        self.assertEqual(result['skills'],['docs']);self.assertEqual(result['tool_policy'],{'bash':'deny'})
        self.assertEqual(self.request('/api/skills')['library'][0]['tools'],['read','bash'])
        self.refusal('/api/projects/members',{'project':project['id'],'remove':[a['id']]})
        (self.root/'folder').mkdir();registered=self.request('/api/projects/register',{'path':'folder'})
        self.request('/api/projects/members',{'project':registered['id'],'add':[a['id']]})
        self.request('/api/library/agents/archive',{'id':a['id']})
        self.assertTrue(self.request('/api/library')['agents'][0]['archived'])
        self.assertTrue(all(p['member_count']==0 for p in self.request('/api/projects')['projects']))
        self.assertFalse((self.root/'one'/'two'/'team.json').exists())
        self.assertNotIn('PRIVATE-API-INSTRUCTIONS',json.dumps(self.request('/api/audit')))

    def test_new_project_refuses_during_run_but_membership_is_advisory(self):
        a=self.agent()
        record=self.request('/api/projects/register',{'path':str(self.repo)})
        self.c.api.hold=True
        self.c.manager.decisions=[coding('CREATE held.txt'),complete()]
        run=self.c.new('Held advisory membership test')
        self.refusal('/api/projects/create',{'name':'Refused','path':'must-not-exist','members':[a['id']]})
        self.assertFalse((self.root/'must-not-exist').exists())
        self.assertEqual(len(self.c.store.record_list('projects')),1)
        self.request('/api/projects/members',{'project':record['id'],'add':[a['id']],'remove':[]})
        self.assertEqual(self.request('/api/projects')['projects'][0]['members'],[a['id']])
        self.assertNotIn(a['id'],[item['name'] for item in self.c.store.agents(run['id'])])

    def test_paid_endpoint_requires_typed_confirmation_before_metadata_changes(self):
        self.c.broker.endpoints.append({'id':'paid-fixture','paid':True})
        before=self.c.store.audit(None)
        body={'kind':'specialist','name':'Paid specialist','engine_type':'reviewer','model':'paid-fixture','instructions':'PRIVATE-PAID-INSTRUCTIONS'}
        self.refusal('/api/library/agents/create',body)
        self.assertEqual(self.c.store.record_list('library_agents'),[])
        self.assertEqual(self.c.store.audit(None),before)
        result=self.request('/api/library/agents/create',{**body,'confirm':'approve'})
        self.assertEqual(result['model'],'paid-fixture')
        self.refusal('/api/library/agents/update',{'id':result['id'],'model':'paid-fixture','confirm':'wrong'})
        visible=self.request('/api/library')
        self.assertEqual(visible['models'],[{'id':'paid-fixture','paid':True}])
        self.assertNotIn('PRIVATE-PAID-INSTRUCTIONS',json.dumps(self.c.store.audit(None)))

    def test_legacy_name_only_creation_and_classic_paths_remain_compatible(self):
        result=self.request('/api/projects/create',{'name':'legacy'})
        self.assertEqual(result,{'project':str(self.root/'legacy'),'git':True})
        record=self.request('/api/projects')['projects'][0]
        self.assertEqual(record['name'],'legacy');self.assertEqual(record['members'],[])
        for path in ['/classic','/classic/','/?popout=coder-1']:
            with urlopen(self.url+path,timeout=5) as response:self.assertEqual(response.status,200)

    def test_validation_refuses_before_files_records_and_audit(self):
        a=self.agent();before=len(self.c.store.audit())
        for path,body in [('/api/library/policy',{'agent':a['id'],'permission':'bash','mode':'allow'}),
                          ('/api/library/agents/update',{'id':a['id'],'engine_type':'orchestrator'}),
                          ('/api/projects/create',{'name':'No','path':'no','members':[]}),
                          ('/api/projects/create',{'name':'No','path':'../outside','members':[a['id']]}),
                          ('/api/library/skills/assign',{'agent':a['id'],'skill':'missing','assigned':True})]:
            with self.subTest(path=path):self.refusal(path,body)
        self.assertFalse((self.root/'no').exists());self.assertEqual(self.c.store.record_list('projects'),[])
        self.assertEqual(len(self.c.store.audit()),before)

    def test_membership_is_advisory_and_run_uses_historical_per_run_agents(self):
        a=self.agent();self.request('/api/projects/create',{'name':'Run','path':'run','members':[a['id']]})
        run=self.request('/api/runs',{'goal':'The engine still uses its original agents','mode':'single'})
        deadline=time.monotonic()+10
        while self.c.store.get('runs',run['id'])['status'] not in ('completed','failed','blocked'):
            if time.monotonic()>deadline:self.fail('Unchanged fake-backed run timed out')
            time.sleep(.01)
        recorded=self.c.store.agents(run['id'])
        self.assertEqual({r['name'] for r in recorded},{'hermes','coder-1'})
        self.assertTrue(all(r.get('agent_id') is None for r in recorded))
        self.assertEqual(self.request('/api/state')['agents'][1]['name'],'coder-1')
        data=self.request('/api/thread?channel=main&limit=500')
        self.assertTrue(all(m['actor'] in ('you','hermes','coder-1','agentcontrol') for m in data['messages']))
