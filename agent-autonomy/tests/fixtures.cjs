/* Shared simulated /api/state payloads for DOM tests and screenshots.
   Nothing here is real run data; it only exercises the interface. */
const clone = value => JSON.parse(JSON.stringify(value));

function fixture(question = false) {
  const run = {
    id: 'run_test', goal: 'Exercise the dashboard with simulated data.', created: '2026-09-28T16:00:00Z',
    deadline: 1790613000, time_limit_seconds: 1800, max_steps: 6, status: 'waiting', phase: 'code', session: 'ses_test',
    pause: false, stop: false, summary: 'A test permission is waiting.', verifier: ['python3', '-m', 'unittest'],
    instructions: [], decision_count: 1, goal_checks: [{criterion: 'Persist a saved task', status: 'pending', evidence: null}],
  };
  const request = {
    run: run.id, goal: run.goal, sessionID: run.session, kind: question ? 'question' : 'permission', id: 'req_test',
    request_id: 'req_test', fingerprint: 'fingerprint-original', permission: 'bash', patterns: ['python3 -m unittest'],
    context: {input: {command: 'python3 -m unittest'}}, metadata: {}, receipt: null,
  };
  if (question) request.questions = [{header: 'Storage', question: 'Which format?', options: [
    {label: 'JSON', description: 'Use a local file'}, {label: 'SQLite', description: 'Use a database'}], custom: true}];
  return {
    version: '5.0', product: 'AgentControl', profile: 'test-profile', project: '/tmp/project', opencode_url: 'http://127.0.0.1:4096',
    health: {ready: true, message: 'Test services ready', agents: {hermes: {state: 'ready', label: 'CLI ready; model unchecked'}, opencode: {state: 'ready', label: 'API reachable'}}},
    limits: {max_run_seconds: 7200}, capabilities: {}, runs: [{...run, prompt_count: 1}], run,
    steps: [{id: 'step_test', number: 1, title: 'Implement task storage', created: run.created, status: 'running',
      prompt: 'Save tasks to JSON.', result: 'Preparing the tests.',
      activity: [{created: run.created, kind: 'read', detail: 'tasks.py', status: 'completed'}]}],
    inbox: [request], reviews: [], events: [],
  };
}

const longGoal = 'Build a small Python command-line todo app in demo_app/. It must add tasks, list tasks, mark tasks done, and save them to a JSON file. Use only the Python standard library. Include meaningful unittest tests. Finish when the tests pass and a short usage README is present.';

function transcript(extra = 0) {
  const parts = [
    {type: 'text', text: 'I will start by reading the existing module and tests.'},
    {type: 'tool', id: 't1', tool: 'read', status: 'completed', summary: 'demo_app/todo.py', output: 'import json\nimport sys\n...'},
    {type: 'tool', id: 't2', tool: 'edit', status: 'completed', summary: 'demo_app/todo.py', output: 'Applied 1 edit.'},
    {type: 'text', text: 'Storage now writes atomically through a temporary file. Running the tests next.'},
    {type: 'tool', id: 't3', tool: 'bash', status: 'running', summary: "python3 -m unittest discover -s demo_app -p 'test_*.py'", output: 'test_add (test_todo.TodoTests) ... ok\ntest_done (test_todo.TodoTests) ... ok'},
  ];
  for (let i = 0; i < extra; i++) parts.push({type: 'text', text: `Progress line ${i + 1}: checking edge cases for empty task lists.`});
  return parts;
}

/* A richer active run for screenshots: two turns, the second one live. */
function richActive() {
  const state = fixture();
  Object.assign(state.run, {goal: longGoal, summary: 'Add atomic save and reload', decision_count: 2,
    verifier: ['python3', '-m', 'unittest', 'discover', '-s', 'demo_app'], instructions: [{time: '2026-09-28T16:03:00Z', text: 'Keep the storage format simple.'}],
    goal_checks: [{criterion: 'Add, list, and complete tasks from the command line.', status: 'pending', evidence: null},
      {criterion: 'Save tasks to JSON and reload them.', status: 'pending', evidence: null}]});
  state.runs = [{...state.run, goal: longGoal.slice(0, 120), prompt_count: 2},
    {id: 'run_old', goal: 'Describe the files in this project.', status: 'completed', created: '2026-09-27T10:00:00Z', prompt_count: 1}];
  state.steps = [
    {id: 'step_1', number: 1, title: 'Create the todo module and tests', created: '2026-09-28T16:00:30Z', ended: '2026-09-28T16:04:00Z', status: 'finished',
      prompt: 'Create demo_app/todo.py with add, list, and done commands. Add unittest tests.', result: 'Created todo.py and test_todo.py.',
      activity: [{created: '2026-09-28T16:01:00Z', kind: 'write', detail: 'demo_app/todo.py', status: 'completed'}],
      transcript: [{type: 'tool', id: 'a', tool: 'write', status: 'completed', summary: 'demo_app/todo.py', output: ''},
        {type: 'tool', id: 'b', tool: 'write', status: 'completed', summary: 'demo_app/test_todo.py', output: ''},
        {type: 'text', text: 'Created todo.py and test_todo.py.'}],
      verified: true, verification: {status: 'passed', exit_code: 0, argv: ['python3', '-m', 'unittest'], output: 'Ran 4 tests in 0.01s\n\nOK'},
      evidence: {changed_files: ['demo_app/todo.py', 'demo_app/test_todo.py'], file_stats: [
        {path: 'demo_app/todo.py', change: 'added', added: 64, removed: 0, partial: false},
        {path: 'demo_app/test_todo.py', change: 'added', added: 41, removed: 0, partial: false}],
        diff: '--- /dev/null\n+++ demo_app/todo.py\n@@ -0,0 +1,3 @@\n+import json\n+import sys\n+TASKS = "tasks.json"\n--- /dev/null\n+++ demo_app/test_todo.py\n@@ -0,0 +1,2 @@\n+import unittest\n+import todo'},
      hermes_verdict: {action: 'continue', summary: 'Tests pass; saving is not atomic yet.'}},
    {id: 'step_2', number: 2, title: 'Add atomic save and reload', created: '2026-09-28T16:05:00Z', status: 'running',
      prompt: 'Make save() write through a temporary file and os.replace. Add a reload test.', result: 'Storage now writes atomically through a temporary file.',
      activity: [{created: '2026-09-28T16:05:20Z', kind: 'edit', detail: 'demo_app/todo.py', status: 'completed'}], transcript: transcript()},
  ];
  state.inbox[0].goal = longGoal;
  state.events = [
    {id: 1, created: '2026-09-28T16:00:00Z', kind: 'goal', detail: longGoal},
    {id: 2, created: '2026-09-28T16:00:20Z', kind: 'Hermes decision', detail: JSON.stringify({action: 'continue', title: 'Create the todo module and tests', summary: 'Start with the module.'})},
    {id: 3, created: '2026-09-28T16:04:00Z', kind: 'verification', detail: JSON.stringify({status: 'passed', output: 'OK'})},
    {id: 4, created: '2026-09-28T16:05:30Z', kind: 'OpenCode tool', detail: JSON.stringify({tool: 'edit', status: 'completed', title: 'demo_app/todo.py'})},
  ];
  return state;
}

function richCompleted() {
  const state = richActive();
  Object.assign(state.run, {status: 'completed', phase: 'manager', summary: 'The todo app works and its tests pass.', ended: '2026-09-28T16:12:00Z'});
  state.runs[0].status = 'completed';
  state.inbox = [];
  Object.assign(state.steps[1], {status: 'finished', ended: '2026-09-28T16:10:00Z', verified: true,
    transcript: transcript().map(p => p.status === 'running' ? {...p, status: 'completed', output: p.output + '\n\nRan 5 tests in 0.02s\n\nOK'} : p),
    verification: {status: 'passed', exit_code: 0, argv: ['python3', '-m', 'unittest'], output: 'Ran 5 tests in 0.02s\n\nOK'},
    evidence: {changed_files: ['demo_app/todo.py'], file_stats: [{path: 'demo_app/todo.py', change: 'modified', added: 12, removed: 3, partial: false}],
      diff: '--- demo_app/todo.py\n+++ demo_app/todo.py\n@@ -10,3 +10,12 @@\n-    open(path, "w").write(data)\n+    tmp = path + ".tmp"\n+    os.replace(tmp, path)'}});
  state.reviews = [{run: 'run_test', kind: 'permission', request_id: 'req_test', action: 'approve', state: 'confirmed', updated: '2026-09-28T16:06:00Z', request: clone(fixture().inbox[0])}];
  return state;
}

function empty() {
  const state = fixture();
  Object.assign(state, {runs: [], run: null, steps: [], inbox: [], reviews: [], events: []});
  return state;
}

module.exports = {clone, fixture, richActive, richCompleted, empty, transcript, longGoal};

/* M3 public thread fixtures, shaped like conversation.py's test journals.
   In particular, decided requests retain coder-2 and stored receipt actors. */
function threadMessage(id,kind,text,detail={},extra={}) {
  return {id,rev:1,at:'2026-09-28T16:00:00Z',session:'run_test',actor:kind==='goal'||kind==='note' ? 'you' : kind==='decision'||kind==='proposal' ? 'hermes' : 'agentcontrol',kind,text,refs:{},detail,action:null,...extra};
}
function threadResponse(messages,sessions,before=null,live={session:null,phase:null,status:null}) {
  return {channel:'main',project:'/tmp/project',sessions,messages,before,live};
}
function threadSession(id='run_test',extra={}) {return {id,title:'Todo CLI',status:'completed',created:'2026-09-28T16:00:00Z',ended:'2026-09-28T16:12:00Z',parent:null,mode:'single',summary:'The todo app works.',...extra};}
function threadSingle() {
  const s=threadSession();
  return threadResponse([
    threadMessage('run:run_test','session_start',s.title,{title:s.title,mode:'single',parent:null}),
    threadMessage('ev:1','goal',longGoal),
    threadMessage('ev:2','decision','Start with storage.',{title:'Create the module',plan:['Read the module','Add tests'],repaired:true}),
    threadMessage('turn:1','turn','Create the module',{number:1,status:'finished',kind:'task',ended:s.ended,prompt:'Create the todo module.',verification:{status:'failed',exit_code:1},files:[{path:'todo.py',change:'added',added:64,removed:0}],files_omitted:0,result_tail:'Tests failed.'},{actor:'coder-1'}),
    threadMessage('turn:2','turn','Fix reload',{number:2,status:'finished',kind:'task',ended:s.ended,prompt:'Fix reload and test it.',verification:{status:'passed',exit_code:0},files:[{path:'todo.py',change:'modified',added:12,removed:3}],files_omitted:0,result_tail:'Tests pass. '+ 'x'.repeat(300),uncertain:true},{actor:'coder-1'}),
    threadMessage('req:permission:p1','request','bash · python3 -m unittest',{kind:'permission',permission:'bash',patterns:['python3 -m unittest'],risk:{level:'R1',label:'Low risk',class:'low',reasons:['Local tests']},receipt:{actor:'You, via dashboard',action:'approve',state:'sent',created:s.created,updated:s.ended}},{actor:'coder-1'}),
    threadMessage('out:run_test','outcome',s.summary,{status:s.status,ended:s.ended,workspace:{state:'open',apply_blocked:'Working tree changed'}},{action:{endpoint:'/api/control',fields:{run:s.id},choices:['discard_workspace','verify']}})
  ],[s]);
}
function threadActive() {
  const result=threadSingle(),s=result.sessions[0];s.status='waiting';s.ended=null;
  result.messages=result.messages.filter(m=>!['outcome','request'].includes(m.kind));
  result.messages.push(threadMessage('ev:3','note','Keep the format simple.',{to:'coder-2'}),threadMessage('ev:4','note','Use local tests.',{redirect_for:'p0'}),threadMessage('req:permission:p1','request','bash · python3 -m unittest',{kind:'permission',permission:'bash',patterns:['python3 -m unittest'],risk:{level:'R1',label:'Low risk',class:'low',reasons:['Local tests']},receipt:null,pending:true},{actor:'coder-1',action:{endpoint:'/api/review',fields:{run:s.id,kind:'permission',request_id:'p1',fingerprint:'NEVER-SHOW-FINGERPRINT'}}}));
  result.messages.find(m=>m.kind==='request').detail.review={command:'python3 -m unittest'};
  result.live={session:s.id,phase:'code',status:'waiting'};return result;
}
function threadTeam() {
  const result=threadActive(),s=result.sessions[0];s.mode='team';s.title='Team todo CLI';
  result.messages[0].detail.mode='team';
  const decision=result.messages.find(m=>m.kind==='decision');Object.assign(decision.detail,{planning:true,proposal_counts:{agents:2,tasks:2}});
  const pending=result.messages.pop();
  result.messages.push(threadMessage('ev:5','proposal','Build with two agents.',{proposal:{agents:[{name:'coder-1',role:'coder',task:'Storage'},{name:'coder-2',role:'coder',task:'CLI'}],tasks:[{id:'storage',title:'Implement storage',agent:'coder-1',depends_on:[]},{id:'cli',title:'Implement CLI',agent:'coder-2',depends_on:['storage']}]},warnings:['Review integration']},{action:{endpoint:'/api/control',fields:{run:s.id},choices:['approve_team','single_agent','repropose']}}),
    threadMessage('req:permission:p2','request','bash · python3 -m unittest',{kind:'permission',permission:'bash',patterns:['python3 -m unittest'],risk:{level:'R1',label:'Low risk',class:'low'},receipt:{actor:'you',action:'approve',state:'sent',created:s.created,updated:s.created}},{actor:'coder-2'}),
    threadMessage('ev:6','progress','Team started'),threadMessage('ev:7','progress','Storage task started'),threadMessage('ev:8','system','Workspace ready'),
    threadMessage('turn:r','research','Check the documentation',{number:3,status:'finished',kind:'research',request:{question:'Which storage format?',why:'Check compatibility',toolsets:['web'],max_turns:2,seconds:60},events:[{kind:'research started',created:s.created,text:'Reading docs'},{kind:'research result',created:s.created,text:'JSON is supported'}]},{actor:'researcher-1'}),
    threadMessage('cap:1','skill','Python testing',{name:'Python testing',agent:'coder-2',state:'proposed',source:'local library',risk:{level:'R1',label:'Low risk'},reasons:['Needed for tests']},{action:{endpoint:'/api/skills/decide',fields:{id:'1'},choices:['approve','reject']}}),pending);
  result.messages.find(m=>m.id==='cap:1').detail.review={description:'Testing helpers',files:['SKILL.md'],size:32,skill_md:'# Python testing\nRun unittest.'};
  return result;
}
function threadLong() {
  const sessions=[threadSession('long-0',{title:'First session',created:'2026-09-26T16:00:00Z'}),threadSession('long-1',{title:'Second session',created:'2026-09-27T16:00:00Z',parent:'long-0'}),threadSession('long-2',{title:'Newest session',parent:'long-1'})];
  const messages=[];
  for(const s of sessions){
    const extra={session:s.id,at:s.created};messages.push(threadMessage('run:'+s.id,'session_start',s.title,{parent:s.parent,mode:s.mode},extra),threadMessage('goal:'+s.id,'goal','Build '+s.title,{},extra));
    for(let i=0;i<147;i++) messages.push(threadMessage('long:'+s.id+':'+i,'decision','Recorded update '+i,{title:'Continue'},extra));
    messages.push(threadMessage('out:'+s.id,'outcome',s.summary,{status:s.status,workspace:{state:'applied'}},extra));
  }
  const page=(start,end,before)=>threadResponse(messages.slice(start,end),sessions.filter(s=>messages.slice(start,end).some(m=>m.session===s.id)),before);
  return [page(250,450,'long:250'),page(50,250,'long:50'),page(0,50,null)];
}
function threadChannels(thread,waiting=0) {return {project:thread.project,channels:[{id:'main',kind:'project',title:'project',sessions:thread.sessions.length,active_session:thread.live.session,waiting,updated:thread.messages.at(-1)?.at || null}]};}
Object.assign(module.exports,{threadMessage,threadResponse,threadSession,threadSingle,threadActive,threadTeam,threadLong,threadChannels});

// M3.1 receipts use the recorded engine actions and delivery states.
function threadReceipts() {
  const receipts = [
    {action:'approve',state:'confirmed',actor:'You, via dashboard'},
    {action:'reject',state:'confirmed',actor:'You, via dashboard',redirect:'Use a safe command instead.'},
    {action:'answer',state:'confirmed',actor:'You, via dashboard'},
    {action:'approve',state:'sent',actor:'You, via dashboard'},
    {action:'reject',state:'uncertain',actor:'automatic local rule'},
    {action:'answer',state:'failed',actor:'You, via dashboard'},
    {action:'approve',state:'dispatching',actor:'You, via dashboard'},
    {action:'answer',state:'resolved',actor:'You, via dashboard'},
    {action:'reject',state:'recorded custom state',actor:'<local rule>'}
  ];
  return threadResponse(receipts.map((receipt,i)=>threadMessage('receipt:'+i,'request','Recorded request '+i,{receipt},{actor:'coder-2'})),[threadSession()]);
}
Object.assign(module.exports,{threadReceipts});

// M4 room/controller states and read-only Settings integrations.
function composerFixture(kind='new') {
  const state=kind==='new'?empty():richActive();
  state.capabilities.preview_modes=['web','static','cli','desktop'];
  state.sandbox={unavailable:'No container runtime installed',models_configured:false};
  state.vm_env={unavailable:'KVM unavailable on this server',models_configured:false};
  let thread=kind==='new'?threadResponse([],[]):threadActive();
  if(kind==='paused' || kind==='interrupted'){state.run.status=kind;state.runs[0].status=kind;state.run.pause=kind==='paused';thread.live.status=kind;thread.sessions[0].status=kind;}
  if(kind==='finished'){state.run.status='completed';state.runs[0].status='completed';state.run.mode='single';state.run.title='Finished parent';state.run.project=state.project;thread=threadSingle();}
  if(kind==='other'){state.runs[0].project='/tmp/another-project';thread=threadResponse([],[]);}
  state.agents=[{name:'hermes',type:'orchestrator'},{name:'coder-1',type:'coder'},{name:'coder-2',type:'coder'},{name:'reviewer-1',type:'reviewer'}];
  return {state,thread,channels:threadChannels(thread,kind==='new'||kind==='finished'||kind==='other'?0:1)};
}
const composerPreflight={is_repo:true,usable:true,dirty_count:0,changes:[],untracked:[],reason:'',branch:'main'};
const composerErrors={validation:{error:'Supply a valid goal check'},unauthorized:{error:'Connect again with the dashboard key'}};
Object.assign(module.exports,{composerFixture,composerPreflight,composerErrors});

// M5 public decision records; none is an optimistic client decision.
function decisionMessages() {
  const review={endpoint:'/api/review',fields:{run:'run_test',kind:'permission',request_id:'low',fingerprint:'NEVER-SHOW-FINGERPRINT'}};
  const low=threadMessage('m5:low','request','bash · npm test',{kind:'permission',permission:'bash',patterns:['npm test'],risk:{level:'R1',label:'Low risk',decision:'allow',remember_allowed:true},review:{command:'npm test'}},{actor:'coder-1',action:review});
  const critical=clone(low);Object.assign(critical,{id:'m5:critical',text:'bash · remove generated build files'});critical.action.fields.request_id='critical';Object.assign(critical.detail,{patterns:['rm -r build/'],risk:{level:'R3',label:'Critical',decision:'confirm',remember_allowed:false,reasons:['Deletes generated files']},review:{command:'rm -r build/',description:'Remove only generated build files',diff:'- generated build output'}});
  const question=threadMessage('m5:question','request','Storage · Which format?',{kind:'question',questions:[{header:'Storage',question:'Which format?',multiple:false,custom:true,options:[{label:'JSON',description:'Local file'},{label:'SQLite',description:'Database'}]}]},{actor:'coder-2',action:{endpoint:'/api/review',fields:{...review.fields,kind:'question',request_id:'question'}}});
  const multiple=clone(question);multiple.id='m5:multiple';multiple.action.fields.request_id='multiple';Object.assign(multiple.detail.questions[0],{multiple:true,custom:false});
  const proposal=threadTeam().messages.find(m=>m.kind==='proposal');proposal.id='m5:proposal';
  const research=threadMessage('m5:research','research','Check storage compatibility',{status:'awaiting_approval',request:{question:'Which storage format is supported?',why:'Check the public documentation',toolsets:['web'],max_turns:2,seconds:60}},{actor:'researcher-1',action:{endpoint:'/api/research/decide',fields:{run:'run_test',step:'research',fingerprint:'NEVER-SHOW-FINGERPRINT'},choices:['approve','reject'],confirm_required:true}});
  const skillFetch=threadMessage('m5:fetch','skill','Python testing',{state:'awaiting_fetch',name:'Python testing',agent:'coder-2',source:'https://example.test/testing',risk:{level:'R1',label:'Low risk'},reasons:['Needed for tests']},{action:{endpoint:'/api/skills/fetch',fields:{id:'fetch'}}});
  const skillInstall=clone(threadTeam().messages.find(m=>m.kind==='skill'));skillInstall.id='m5:install';skillInstall.action.fields.id='install';
  const outcome=threadMessage('m5:outcome','outcome','Tests pass; storage works.',{status:'completed',workspace:{state:'open',branch:'agent/storage',base_branch:'main',commits:2,shortstat:'2 files changed, 20 insertions(+), 3 deletions(-)'}},{session:'run_done',action:{endpoint:'/api/control',fields:{run:'run_done'},choices:['apply','discard_workspace','verify']}});
  const truncated=clone(low);truncated.id='m5:truncated';truncated.action.fields.request_id='truncated';truncated.detail.review_truncated=true;truncated.detail.review.command='x'.repeat(3999)+'…';
  return {low,critical,question,multiple,proposal,research,skillFetch,skillInstall,outcome,truncated};
}
function decisionFixture(name='all') {
  const state=richActive();state.permissions={confirm_word:'CONFIRM-TEST'};
  const catalogue=decisionMessages(), messages=name==='all' ? Object.values(catalogue) : [catalogue[name]];
  const sessions=[threadSession('run_test',{status:'waiting',ended:null,mode:'team'})];
  const outcome=messages.find(m=>m.kind==='outcome');if(outcome)sessions.unshift(threadSession('run_done',{title:'Storage work',created:'2026-09-27T16:00:00Z'}));
  const pending=messages.some(m=>m.kind!=='outcome');
  if(!pending){state.run.status='completed';state.runs[0].status='completed';}
  const start=s=>threadMessage('run:'+s.id,'session_start',s.title,{mode:s.mode},{session:s.id,at:s.created});
  const thread=threadResponse([...sessions.filter(s=>s.id==='run_done').map(start),...messages.filter(m=>m.kind==='outcome'),...sessions.filter(s=>s.id==='run_test').map(start),...messages.filter(m=>m.kind!=='outcome')],sessions,null,{session:pending?'run_test':null,phase:pending?'code':null,status:pending?'waiting':null});
  return {state,thread,channels:threadChannels(thread,messages.filter(m=>m.action && m.kind!=='outcome').length)};
}
Object.assign(module.exports,{decisionMessages,decisionFixture});
