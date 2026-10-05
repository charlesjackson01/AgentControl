"""Disposable real app/Controller harness for the committed N2 chat walkthrough."""
import io, json, secrets, sys, tempfile, threading, time, traceback
from pathlib import Path
from http.server import ThreadingHTTPServer
sys.path[:0] = [str(Path(__file__).resolve().parent), str(Path(__file__).resolve().parents[1])]
import app
from engine import Controller, Settings
from test_workflow import FakeManager, coding, complete
from test_team import FakeTeamAPI, FakeTeamManager, proposal
from test_workspaces import make_repo

class Fixture:
    def __init__(self):
        self.c=self.server=self.temp=None
        self.reads=[];self.posts=[]
    def wait(self, predicate):
        until=time.monotonic()+45
        while time.monotonic()<until:
            if predicate(): return
            time.sleep(.01)
        raise AssertionError('Fixture timed out')
    def setup(self):
        self.temp=tempfile.TemporaryDirectory(prefix='agentcontrol-n2-walkthrough-')
        self.root=Path(self.temp.name);self.repo=make_repo(self.root);self.key=secrets.token_urlsafe(16)
        skills=self.root/'skills';(skills/'docs').mkdir(parents=True)
        (skills/'docs'/'SKILL.md').write_text('---\nname: docs\ndescription: Read documentation\ntools: [read, bash]\n---\nFixture documentation')
        settings=Settings(self.repo,self.root/'state',poll=.03,notifications=False,run_timeout=600,step_timeout=300,manager_timeout=45,verify_timeout=20,projects_root=self.root,skills_library=skills)
        self.api=FakeTeamAPI();self.api.hold=True
        self.manager=FakeTeamManager([proposal(),proposal()],[coding('CREATE first.txt'),complete(),complete(),complete(),complete(),complete()])
        def on_submit(session,text):
            self.api.create_file(session,text)
            if len(self.api.prompts)==1:
                sid=self.api.prompts[0][0]
                self.api.pending_items=[{'kind':'permission','id':'per-m9-critical','sessionID':sid,'permission':'bash','patterns':['rm -rf generated-build/'],'metadata':{'command':'rm -rf generated-build/','description':'Clean generated build artifacts'}}]
        self.api.on_submit=on_submit
        self.c=Controller(settings,self.api,self.manager);self.c.check()
        base=app.handler(self.c,self.key);fixture=self
        class Handler(base):
            def do_GET(self):
                fixture.reads.append(self.path);super().do_GET()
            def do_POST(self):
                raw=self.rfile.read(int(self.headers.get('Content-Length',0)));fixture.posts.append({'path':self.path,'body':json.loads(raw) if raw else None})
                source=self.rfile;self.rfile=io.BytesIO(raw)
                try:super().do_POST()
                finally:self.rfile=source
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        threading.Thread(target=self.server.serve_forever,daemon=True).start()
        return {'url':'http://127.0.0.1:'+str(self.server.server_port),'project':str(self.repo),'root':str(self.root),'key':self.key}
    def report(self):
        runs=self.c.store.runs()
        return {'reads':self.reads[:],'posts':self.posts[:],'prompts':len(self.api.prompts),'files':sorted(p.name for p in self.repo.iterdir() if p.is_file()),'runs':[{'id':r['id'],'status':r['status'],'parent':r.get('parent_run'),'team':(r.get('team') or {}).get('state'),'workspace':self.c.workspace_status(r).get('state'),'verification':(r.get('manual_verification') or {}).get('status'),'reviews':[{'action':v['action'],'state':v['state'],'answers':v.get('answers')} for v in self.c.store.reviews(r['id'])],'audit':[a['action'] for a in self.c.store.audit(r['id'])]} for r in runs]}
    def question(self):
        sid=self.api.prompts[0][0]
        self.api.pending_items=[{'kind':'question','id':'que-m9-storage','sessionID':sid,'questions':[{'header':'Storage','question':'Where should tasks be stored?','options':[{'label':'JSON','description':'File'},{'label':'SQLite','description':'Database'}],'custom':True,'multiple':False}]}]
        self.wait(lambda:any(p.get('id')=='que-m9-storage' for p in self.c.state()['inbox']))
        return {'ok':True}
    def grow(self):
        sid=self.api.prompts[1][0];run=self.c.store.runs()[0]
        assistant=self.api.sessions[sid]['messages'][-1]
        assistant['parts']=[{'type':'reasoning','text':'M9-PRIVATE-REASONING-SENTINEL'},{'type':'text','text':'M9-LIVE-TRANSCRIPT-1'},{'type':'tool','id':'m9-tool','tool':'bash','state':{'status':'running','input':{'command':'python3 -m unittest'},'metadata':{'output':'M9 escaped terminal output <img src=x onerror=alert(1)>'}}}]
        self.wait(lambda:any('M9-LIVE-TRANSCRIPT-1' in str(s.get('transcript',[])) for s in self.c.store.steps(run['id'])))
        return {'run':run['id'],'agent':'coder-1'}
    def grow_more(self):
        sid=self.api.prompts[1][0];run=self.c.store.runs()[0]
        self.api.sessions[sid]['messages'][-1]['parts'].append({'type':'text','text':'M9-LIVE-TRANSCRIPT-2'})
        self.wait(lambda:any('M9-LIVE-TRANSCRIPT-2' in str(s.get('transcript',[])) for s in self.c.store.steps(run['id'])))
        return {'ok':True}
    def finish(self):
        run=self.c.store.runs()[0];self.api.hold=False;self.api.finish()
        self.wait(lambda:self.c.store.get('runs',run['id'])['status'] in ('completed','failed','blocked','attention','stopped','limit_reached'))
        result=self.c.store.get('runs',run['id'])
        assert result['status']=='completed', (result['status'],result['summary'])
        return {'run':run['id'],'status':result['status']}
    def close(self):
        if self.c:
            self.c.shutdown.set();self.api.hold=False;self.api.finish()
            for t in list(self.c.threads.values()):t.join(3)
            self.c.preview.close()
        if self.server:self.server.shutdown();self.server.server_close()
        if self.temp:self.temp.cleanup()
    def command(self,item):
        name=item['command']
        if name in ('setup','report','question','grow','grow_more','finish'):return getattr(self,name)()
        if name=='ready_critical':self.wait(lambda:any(p.get('id')=='per-m9-critical' for p in self.c.state()['inbox']));return {'ok':True}
        if name=='ready_proposal':self.wait(lambda:(self.c.store.runs()[0].get('team') or {}).get('state')=='proposed');return {'ok':True}
        if name=='prepare_unchanged':
            self.manager=FakeManager([coding('CREATE advisory-check.txt'),complete()]);self.c.manager=self.manager
            return {'ok':True}
        if name=='register_folder':
            import projects
            folder=projects.create(self.root,'existing-folder');return {'path':str(folder)}
        if name=='unchanged_run':
            run=self.c.store.runs()[0];agents=self.c.store.agents(run['id'])
            return {'run':run['id'],'agents':[a['name'] for a in agents]}
        if name=='hold':self.api.hold=True;return {'ok':True}
        if name=='ready_team':self.wait(lambda:len(self.api.prompts)>=3);return {'ok':True}
        if name=='verified':self.wait(lambda:(self.c.store.runs()[0].get('manual_verification') or {}).get('status')=='passed');return {'ok':True}
        if name=='close':self.close();self.c=self.server=self.temp=None;return {'ok':True}
        raise AssertionError(name)
f=Fixture()
try:
    for line in sys.stdin:
        try:print('@@'+json.dumps(f.command(json.loads(line))),flush=True)
        except Exception as e:traceback.print_exc(file=sys.stderr);print('@@'+json.dumps({'fixture_error':str(e)}),flush=True)
finally:f.close()
