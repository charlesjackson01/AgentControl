/* DOM-level tests; no browser rendering, remote services, models, or messages.
   Run with linkedom installed as a test-only dependency (see README). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {parseHTML} = require('linkedom');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'app.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const unit=require(path.join(root,'app.js'));
const {clone,fixture,richActive,richCompleted,transcript}=require('./fixtures.cjs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function harness(state=fixture(),savedTheme='mac') {
 const {window,document}=parseHTML(html);
 // linkedom intentionally has no layout, focus management, or native dialogs.
 for(const d of document.querySelectorAll('dialog')) {d.showModal=function(){this.open=true;this.setAttribute('open','')};d.close=function(){this.open=false;this.removeAttribute('open')}}
 for(const e of document.querySelectorAll('*'))e.scrollIntoView=()=>{};
 document.getElementById('verify-enabled').checked=true;
 // Select value is read-only in linkedom, unlike browsers.
 for(const s of document.querySelectorAll('select'))Object.defineProperty(s,'value',{value:s.querySelector('option')?.value || '',writable:true});
 const storage=new Map([['ac-theme',savedTheme]]),calls=[],intervals=[];
 const context=vm.createContext({TextDecoder,TextEncoder,AbortController,location:{protocol:'http:',hostname:'100.1.2.3'},document,window,console,URL,Blob,Date,Map,Set,JSON,Math,Number,String,Array,Object,module:undefined,
  sessionStorage:{getItem:()=> 'test-dashboard-key',setItem:()=>{}},
  localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},
  setInterval:fn=>intervals.push(fn),clearTimeout:()=>{},setTimeout:()=>1,
  fetch:async(url,options)=>{
   const body=options.body?JSON.parse(options.body):null;calls.push({url,method:options.method,body});
   let result;
   if(url.startsWith('/api/state'))result=clone(state);
   else if(url==='/api/review'){
    const p=state.inbox.find(p=>p.request_id===body.request_id);
    assert(p);assert.equal(body.fingerprint,p.fingerprint);
    result={...body,request:clone(p),state:'confirmed',updated:runTime(),redirect_saved:!!body.redirect};
    state.reviews.unshift(result);state.inbox=state.inbox.filter(x=>x!==p);state.run.status='coding';
   }else if(url==='/api/control'){
    if(body.action==='stop'){state.run.status='stopped';state.inbox=[]}
    if(body.action==='instruction')state.run.instructions.push({text:body.text});
    if(body.action==='goal_check')state.run.goal_checks.push({criterion:body.text,status:'pending'});
    result=state.run;
   }else if(url==='/api/runs'){result={id:'new_run'};state.run={...state.run,id:'new_run',goal:body.goal,status:'planning',goal_checks:body.goal_checks.map(criterion=>({criterion,status:'pending'}))};state.inbox=[];state.steps=[];state.runs=[{...state.run,prompt_count:0}];}
   else if(url==='/api/events'&&state.stream){
    const s=state.stream;
    return {status:200,ok:true,body:{getReader:()=>({read:()=>s.chunks.length?Promise.resolve({value:new TextEncoder().encode(s.chunks.shift()),done:false}):new Promise(r=>{s.wake=()=>{s.wake=null;r(s.chunks.length?{value:new TextEncoder().encode(s.chunks.shift()),done:false}:{done:true})}})})}};
   }
   else if(url==='/api/preview/ticket')result={ticket:'tkt',port:9999};
   else if(url.startsWith('/api/preview/output'))result={offset:(state.previewOutput||'').length,from:Number(url.split('since=')[1]||0),text:(state.previewOutput||'').slice(Number(url.split('since=')[1]||0)),status:state.preview};
   else if(url==='/api/preview'){
    if(body.action==='config')state.run.preview=body.preview.mode==='none'?null:body.preview;
    if(['start','restart'].includes(body.action))state.preview={...state.preview,state:'running',run:body.run,mode:state.run.preview.mode,started:1790600000,offset:0,width:640,height:400};
    if(body.action==='stop')state.preview={...state.preview,state:'idle'};
    result=state.preview;
   }
   else result={ok:true};
   return {status:200,ok:true,json:async()=>clone(result)};
  }});
 vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],context);
 vm.runInContext(source,context);await tick();
 assert.equal(document.getElementById('auth-error').textContent,'','Initial render must not throw');
 const click=async selector=>{const e=document.querySelector(selector);assert(e,selector);e.click();await tick();};
 return {document,state,calls,storage,context,click,poll:async()=>{await context.refresh();await tick()}};
}
function runTime(){return '2026-09-28T16:01:00Z'}
const tests=[];
function test(name,fn){tests.push([name,fn])}
test('run layout renders real fixture data without the old hero',async()=>{
 const h=await harness();assert.match(h.document.title,/\(1\) AgentControl/);
 assert.match(h.document.getElementById('run-header').textContent,/Exercise the dashboard/);
 assert.match(h.document.getElementById('inline-approvals').textContent,/python3 -m unittest/);
 assert(!h.document.getElementById('metric-stage'));
 assert(!h.document.body.textContent.includes('Stay close to the work'));
 assert.match(h.document.getElementById('goal-checks').textContent,/0 of 1 verified/);
 assert.match(h.document.getElementById('agent-list').textContent,/model unchecked/);
});
test('theme changes persist and retain steering drafts without network writes',async()=>{
 const h=await harness(fixture(),'terminal');assert.equal(h.document.documentElement.dataset.theme,'terminal');
 h.document.getElementById('steering').value='Keep the storage format simple.';
 for(const name of ['xp','mac','terminal']){await h.click(`[data-theme="${name}"]`);assert.equal(h.storage.get('ac-theme'),name)}
 assert.equal(h.document.getElementById('steering').value,'Keep the storage format simple.');
 assert.equal(h.calls.filter(c=>c.method==='POST').length,0);
});
test('approve once uses the displayed request and records confirmation',async()=>{
 const h=await harness();await h.click('#inline-approvals [data-intent="approve"]');
 assert(h.document.getElementById('review-dialog').open);
 assert.equal(h.calls.filter(c=>c.url==='/api/review').length,0);
 await h.click('#approve-review');
 assert.equal(h.calls.find(c=>c.url==='/api/review').body.action,'approve');
 assert.match(h.document.getElementById('review-feedback').textContent,/Approved once/);
 assert.equal(h.state.inbox.length,0);assert.equal(h.document.title,'AgentControl');
 assert.match(h.document.getElementById('inline-approvals').textContent,/Approved once/);
});
test('deny and redirect transmits the exact entered note',async()=>{
 const h=await harness();await h.click('#inline-approvals [data-intent="reject"]');
 h.document.getElementById('redirect-note').value='Use the standard library instead.';
 await h.click('#deny-review');const request=h.calls.find(c=>c.url==='/api/review').body;
 assert.equal(request.action,'reject');assert.equal(request.redirect,'Use the standard library instead.');
 assert.match(h.document.getElementById('inline-approvals').textContent,/Redirection saved/);
});
test('polling preserves question drafts and custom answers submit',async()=>{
 const h=await harness(fixture(true));await h.click('#inline-approvals [data-intent="answer"]');
 h.document.getElementById('custom-0').value='Keep a JSON file beside the app';
 h.document.querySelector('[data-custom-choice="0"]').checked=true;
 // linkedom does not implement :checked from the property; mirror the native attribute in this harness.
 h.document.querySelector('[data-custom-choice="0"]').setAttribute('checked','');
 await h.poll();assert.equal(h.document.getElementById('custom-0').value,'Keep a JSON file beside the app');
 await h.click('#approve-review');
 assert.deepEqual(h.calls.find(c=>c.url==='/api/review').body.answers,[['Keep a JSON file beside the app']]);
});
test('changed request disables stale approval controls',async()=>{
 const h=await harness();await h.click('#inline-approvals [data-intent="approve"]');
 h.state.inbox[0].fingerprint='changed-fingerprint';h.state.inbox[0].patterns=['different command'];
 await h.poll();assert.equal(h.document.getElementById('approve-review').disabled,true);
 assert.match(h.document.getElementById('review-feedback').textContent,/action changed/);
 assert.equal(h.calls.filter(c=>c.url==='/api/review').length,0);
});
test('Stop opens confirmation before sending a control request',async()=>{
 const h=await harness();await h.click('#run-header [data-action="stop"]');
 assert(h.document.getElementById('stop-dialog').open);assert.equal(h.calls.filter(c=>c.method==='POST').length,0);
 await h.click('#confirm-stop');assert.equal(h.calls.find(c=>c.url==='/api/control').body.action,'stop');
 assert(!h.document.getElementById('stop-dialog').open);
});
test('new run submits manual checks, limits, and follow-up context',async()=>{
 const state=fixture();state.run.status='completed';state.runs[0].status='completed';state.inbox=[];
 const h=await harness(state);await h.click('#run-header [data-action="followup"]');
 h.document.getElementById('goal').value='Extend the saved tasks';await h.click('[data-action="new-check"]');
 h.document.querySelector('#new-checks textarea').value='Preserve saved tasks';h.document.getElementById('run-minutes').value='15';
 await h.document.getElementById('new-form').onsubmit({preventDefault(){}});await tick();
 const request=h.calls.find(c=>c.url==='/api/runs').body;
 assert.deepEqual(request.goal_checks,['Preserve saved tasks']);assert.equal(request.run_minutes,15);assert.equal(request.parent_run,'run_test');
});
test('shortcuts ignore editable targets and modifier keys',async()=>{
 const h=await harness();
 for(const target of [h.document.getElementById('steering'),h.document.getElementById('key')])assert(unit.ignoresShortcut({target}));
 const target=h.document.body;
 for(const modifier of ['altKey','ctrlKey','metaKey','shiftKey'])assert(unit.ignoresShortcut({target,[modifier]:true}));
 assert(!unit.ignoresShortcut({target}));
});
test('file and budget summaries use recorded values without invented counts',()=>{
 assert.deepEqual(unit.fileStats([{evidence:{changed_files:['tasks.py']}}]),[{path:'tasks.py',change:'changed',added:null,removed:null,partial:true}]);
 assert.equal(unit.budget({created:'2026-09-28T16:00:00Z',ended:'2026-09-28T16:02:00Z',time_limit_seconds:1800}).used,120);
 assert.equal(unit.verificationLabel({verification:{status:'passed'}}),'Verification passed');
 assert.equal(unit.esc('<script>'), '&lt;script&gt;');
});
test('styles parse and every component color uses a defined theme token',()=>{
 const CSSOM=require('cssom');
 const tokens=fs.readFileSync(path.join(root,'themes.css'),'utf8'),styles=fs.readFileSync(path.join(root,'app.css'),'utf8');
 assert(CSSOM.parse(tokens).cssRules.length);assert(CSSOM.parse(styles).cssRules.length);
 assert(!/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(styles));
 const defined=new Set([...tokens.matchAll(/(--ac-[\w-]+)\s*:/g)].map(m=>m[1]));
 for(const m of styles.matchAll(/var\((--ac-[\w-]+)/g))assert(defined.has(m[1]),m[1]);
 for(const width of ['1279px','1099px','699px'])assert(styles.includes(width));
 assert(styles.includes('prefers-reduced-motion:reduce'));
});
test('workflow board shows four stages and the live terminal for the latest turn',async()=>{
 const h=await harness(richActive());const d=h.document;
 for(const name of ['plan','prompt','code','verify'])assert(d.getElementById('stage-'+name).className.includes('stage-'+name));
 assert.match(d.getElementById('stage-code').className,/waiting/);
 assert.match(d.getElementById('stage-plan').className,/done/);
 assert.equal(d.querySelectorAll('.turn-chip').length,2);
 assert.match(d.getElementById('term-title').textContent,/turn 2/);
 assert.match(d.getElementById('term-body').textContent,/python3 -m unittest discover/);
 assert.match(d.getElementById('term-held').textContent,/python3 -m unittest/);
 assert.equal(d.querySelectorAll('#inline-approvals .approval-card').length,1);
});
test('turn rail switches the board and can return to the latest turn',async()=>{
 const h=await harness(richActive());const d=h.document;
 await h.click('[data-turn="step_1"]');
 assert.match(d.getElementById('term-title').textContent,/turn 1/);
 assert.match(d.getElementById('stage-verify-body').textContent,/Ran 4 tests/);
 await h.poll();assert.match(d.getElementById('term-title').textContent,/turn 1/,'a pinned turn survives polling');
 await h.click('[data-turn="latest"]');assert.match(d.getElementById('term-title').textContent,/turn 2/);
});
test('terminal appends new output without rebuilding earlier lines',async()=>{
 const h=await harness(richActive());const d=h.document;
 const first=d.querySelector('#term-body [data-entry="0"]');
 h.state.steps[1].transcript=transcript(3);await h.poll();
 assert.equal(d.querySelector('#term-body [data-entry="0"]'),first);
 assert.equal(d.querySelectorAll('#term-body .term-entry').length,8);
 assert.match(d.getElementById('term-body').textContent,/Progress line 3/);
});
test('steps recorded before transcripts fall back to activity and result',async()=>{
 const h=await harness();const text=h.document.getElementById('term-body').textContent;
 assert.match(text,/read tasks\.py/);assert.match(text,/Preparing the tests/);
 assert.deepEqual(unit.transcriptOf({activity:[],result:''}),[]);
});
test('planning pseudo-turn appears while Hermes chooses the next prompt',async()=>{
 const state=richActive();state.inbox=[];state.run.status='reviewing';state.run.phase='manager';Object.assign(state.steps[1],{status:'finished',verified:true});
 const h=await harness(state);assert.equal(h.document.querySelectorAll('.turn-chip').length,3);
 assert.match(h.document.getElementById('stage-plan').className,/active/);
 assert.match(h.document.getElementById('stage-plan-body').textContent,/Turn 3/);
});
test('stored key skips the sign-in screen and remember saves to local storage',async()=>{
 const h=await harness();const d=h.document;
 assert(d.getElementById('auth').classList.contains('hidden'));assert(!d.getElementById('app').classList.contains('hidden'));
 d.getElementById('key').value='new-key';d.getElementById('remember-key').checked=true;
 await d.getElementById('auth-form').onsubmit({preventDefault(){}});
 assert.equal(h.storage.get('ac-dashboard-key'),'new-key');
});
test('unsupported controls stay hidden and disabled states explain themselves',async()=>{
 const h=await harness();const d=h.document;
 assert([...d.querySelectorAll('[data-capability="verify_now"]')].every(e=>e.classList.contains('hidden')));
 assert(!d.body.textContent.includes('unavailable'));
 assert.match(d.getElementById('start-reason').textContent,/Finish or stop the active run/);
 assert.equal(d.getElementById('start-run').disabled,true);
 const state=richCompleted();state.capabilities={verify_now:true,run_titles:true};
 const c=await harness(state);assert(!c.document.querySelector('#verification [data-action="verify-now"]').disabled);
 assert(c.document.querySelector('[data-action="rename"]'));
 assert.equal(c.document.getElementById('inline-approvals').textContent.trim(),'','finished runs do not show stale receipts');
 await c.click('#verification [data-action="verify-now"]');
 assert.equal(c.calls.find(x=>x.url==='/api/control').body.action,'verify');
});
test('question mark opens help and filters narrow runs and activity',async()=>{
 const state=richActive();state.runs.push(...[1,2,3,4].map(i=>({id:'r'+i,goal:'Older goal '+i,status:'completed',created:'2026-09-20T10:00:00Z',prompt_count:1})));
 const h=await harness(state);const d=h.document;
 h.context.handleShortcut({key:'?',target:d.body,preventDefault(){}});assert(d.getElementById('help-dialog').open);
 assert(!d.getElementById('run-filter-row').classList.contains('hidden'));
 d.getElementById('run-filter').value='older goal 2';h.context.renderRecentRuns([]);
 assert.equal(d.querySelectorAll('#recent-runs .recent-run').length,1);
 d.getElementById('event-search').value='verification';h.context.renderActivity();
 assert.equal(d.querySelectorAll('#activity-list .event').length,1);
});
test('polling speeds up while coding, slows when hidden, and backs off when offline',async()=>{
 const h=await harness(richActive());const run=code=>vm.runInContext(code,h.context);
 assert.equal(run('nextDelay()'),1000);
 h.document.hidden=true;assert.equal(run('nextDelay()'),10000);h.document.hidden=false;
 assert.equal(run('connected=false;failures=3;nextDelay()'),16000);
 assert.equal(run('failures=9;nextDelay()'),30000);
 assert.equal(unit.relTime('2026-09-28T16:00:00Z',Date.parse('2026-09-28T16:10:00Z')),'10 min ago');
 assert.equal(unit.runTitle({goal:'word '.repeat(60)},20),'word word word word…');
});
function previewState(mode='cli',run='run_test'){const s=richCompleted();s.run.preview=mode==='web'?{mode,command:'npm run dev',port:5173}:mode==='static'?{mode,path:'site'}:mode==='desktop'?{mode,command:'xclock',width:640,height:400}:{mode,command:'python3 demo_app/todo.py list'};s.preview={state:'running',run,mode,command:s.run.preview.command||'',port:s.run.preview.port,path:s.run.preview.path,width:640,height:400,started:1790600000,offset:12,listen_port:9999,error:''};s.previewOutput='[ ] 1. milk\n';s.capabilities={preview_modes:['web','static','cli','desktop'],preview_missing:[]};return s}
test('project tab shows a running command-line preview and sends typed input',async()=>{
 const h=await harness(previewState('cli'));const d=h.document;
 await h.click('.nav [data-view="project"]');await tick();await tick();
 assert(!d.getElementById('view-project').classList.contains('hidden'));
 assert(!d.getElementById('preview-cli').classList.contains('hidden'));
 assert(d.getElementById('preview-web').classList.contains('hidden'));
 assert.match(d.getElementById('preview-term-body').textContent,/1\. milk/);
 assert.match(d.getElementById('preview-controls').textContent,/Running/);
 d.getElementById('preview-input').value='add eggs';
 await d.getElementById('preview-input-form').onsubmit({preventDefault(){}});
 assert.deepEqual(h.calls.filter(c=>c.url==='/api/preview').at(-1).body,{run:'run_test',action:'input',text:'add eggs\n'});
 await h.click('[data-preview-key]');assert.equal(h.calls.filter(c=>c.url==='/api/preview').at(-1).body.text,'\u0003');
 d.getElementById('preview-args').value='add "Buy milk"';
 await d.getElementById('preview-args-form').onsubmit({preventDefault(){}});
 assert.deepEqual(h.calls.filter(c=>c.url==='/api/preview').at(-1).body,{run:'run_test',action:'restart',args:'add "Buy milk"'});
 assert.equal(unit.stripAnsi('\u001b[32mok\u001b[0m\r\n'),'ok\n');
});
test('web preview loads through a one-time ticket on the preview port',async()=>{
 const h=await harness(previewState('web'));const d=h.document;
 await h.click('.nav [data-view="project"]');await tick();await tick();
 assert(!d.getElementById('preview-web').classList.contains('hidden'));
 assert.match(d.getElementById('preview-frame').getAttribute('src')||d.getElementById('preview-frame').src,/:9999\/__ac\/enter\?ticket=tkt/);
 assert(h.calls.some(c=>c.url==='/api/preview/ticket'));
 await h.click('[data-preview-width="390px"]');assert.equal(d.getElementById('preview-frame').style.width,'390px');
});
test('project tab offers start when stopped and saves preview settings',async()=>{
 const state=previewState('static');state.preview={state:'idle',offset:0};
 const h=await harness(state);const d=h.document;
 await h.click('.nav [data-view="project"]');
 assert.match(d.getElementById('preview-empty').textContent,/not running/);
 await h.click('[data-action="preview-start"]');
 assert.equal(h.calls.filter(c=>c.url==='/api/preview').at(-1).body.action,'start');
 d.getElementById('cfg-preview-mode').value='web';d.getElementById('cfg-preview-command').value='npm run dev';d.getElementById('cfg-preview-port').value='5173';
 await h.click('[data-action="preview-save"]');
 assert.deepEqual(h.calls.filter(c=>c.url==='/api/preview').at(-1).body.preview,{mode:'web',command:'npm run dev',port:5173});
});
test('desktop clicks are mapped back to the virtual screen size',async()=>{
 const h=await harness(previewState('desktop'));const d=h.document;
 await h.click('.nav [data-view="project"]');
 const img=d.getElementById('preview-screen');img.getBoundingClientRect=()=>({left:100,top:50,width:320,height:200});
 h.context.screenClick({clientX:260,clientY:150,button:0});await tick();
 assert.deepEqual(h.calls.filter(c=>c.url==='/api/preview').at(-1).body,{run:'run_test',action:'click',x:320,y:200,button:1});
});
test('new-run form submits the preview spec and completion opens the Project tab',async()=>{
 const state=richActive();state.inbox=[];state.run.status='coding';state.run.preview={mode:'cli',command:'python3 x.py'};state.capabilities={preview_modes:['web','static','cli'],preview_missing:['Xvfb']};
 const h=await harness(state);const d=h.document;
 assert(d.querySelector('#new-preview-mode option[value="desktop"]').disabled);
 state.run.status='completed';state.runs[0].status='completed';state.preview={state:'running',run:'run_test',mode:'cli',offset:0};
 await h.poll();assert(!d.getElementById('view-project').classList.contains('hidden'),'completion opens the preview');
 const next=await harness(Object.assign(richCompleted(),{runs:[]}));
 await next.click('[data-action="followup"]');
 next.document.getElementById('goal').value='Another goal';next.document.getElementById('new-preview-mode').value='web';
 next.document.getElementById('new-preview-command').value='python3 -m http.server 8123';next.document.getElementById('new-preview-port').value='8123';
 await next.document.getElementById('new-form').onsubmit({preventDefault(){}});await tick();
 assert.deepEqual(next.calls.find(c=>c.url==='/api/runs').body.preview,{mode:'web',command:'python3 -m http.server 8123',port:8123});
});
test('live stream switches the dashboard from polling to pushed updates',async()=>{
 const state=richActive();state.stream={chunks:['retry: 3000\nevent: hello\ndata: {"seq":1}\n\n'],wake:null};
 const h=await harness(state);const run=code=>vm.runInContext(code,h.context);
 for(let i=0;i<6;i++)await tick();
 assert.equal(run('live.state'),'live');
 assert.equal(run('nextDelay()'),15000,'polling becomes a slow safety net while live');
 assert.match(h.document.getElementById('last-updated').textContent,/· live/);
 const before=h.calls.filter(c=>c.url.startsWith('/api/state')).length;
 state.steps[1].transcript.push({type:'text',text:'Pushed line from the stream'});
 state.stream.chunks.push('id: 2\nevent: change\ndata: {"seq":2,"kind":"step","run":"run_test"}\n\n');state.stream.wake();
 for(let i=0;i<6;i++)await tick();
 assert(h.calls.filter(c=>c.url.startsWith('/api/state')).length>before,'a change notice triggers a state refresh');
 assert.match(h.document.getElementById('term-body').textContent,/Pushed line from the stream/);
 state.stream.wake();for(let i=0;i<4;i++)await tick();
 assert.equal(run('live.state'),'off','a closed stream falls back to polling');
 assert.match(h.document.getElementById('last-updated').textContent,/· polling/);
});
test('without a stream the dashboard keeps polling as before',async()=>{
 const h=await harness(richActive());for(let i=0;i<4;i++)await tick();
 assert.equal(vm.runInContext('live.state',h.context),'off');
 assert.equal(vm.runInContext('nextDelay()',h.context),1000);
 assert.match(h.document.getElementById('last-updated').textContent,/· polling/);
});
test('a notice during a refresh is not lost',async()=>{
 const h=await harness(richActive());const run=code=>vm.runInContext(code,h.context);
 const count=()=>h.calls.filter(c=>c.url.startsWith('/api/state')).length;
 const before=count();
 const first=run('refresh()');run('refresh()');run('refresh()');  // two notices arrive while the first refresh is in flight
 await first;for(let i=0;i<6;i++)await tick();
 assert.equal(count()-before,2,'one follow-up refresh covers every notice that arrived meanwhile');
});
const risk=(cls,level,extra={})=>({class:cls,level,label:{low:'Low',sensitive:'Sensitive',critical:'Critical'}[cls],permission:'bash',impact:'Runs a shell command in the project folder.',reasons:[],decision:cls==='critical'?'confirm':'ask',remember_allowed:cls!=='critical',...extra});
function riskFixture(cls){const s=fixture();s.permissions={confirm_word:'approve',labels:{low:'Low',sensitive:'Sensitive',critical:'Critical'}};
 s.inbox[0].risk=cls==='critical'?risk('critical','R3',{reasons:['runs with administrator rights']}):risk('sensitive','R2');return s}
test('critical requests show their reasons and need the typed word before sending',async()=>{
 const h=await harness(riskFixture('critical'));
 assert.match(h.document.getElementById('inline-approvals').textContent,/R3 · Critical/);
 assert.match(h.document.getElementById('inline-approvals').textContent,/administrator rights/);
 await h.click('#inline-approvals [data-intent="approve"]');
 assert(!h.document.getElementById('remember-rule'),'critical approvals cannot be remembered');
 await h.click('#approve-review');
 assert.equal(h.calls.filter(c=>c.url==='/api/review').length,0);
 assert.match(h.document.getElementById('review-feedback').textContent,/Type approve/);
 h.document.getElementById('confirm-word').value='approve';
 await h.click('#approve-review');
 const body=h.calls.find(c=>c.url==='/api/review').body;
 assert.equal(body.confirm,'approve');assert.equal(body.remember,undefined);
});
test('sensitive approvals can be remembered for identical requests',async()=>{
 const h=await harness(riskFixture('sensitive'));
 await h.click('#inline-approvals [data-intent="approve"]');
 assert.match(h.document.getElementById('review-body').textContent,/R2 · Sensitive/);
 assert(!h.document.getElementById('confirm-word'));
 h.document.getElementById('remember-rule').checked=true;
 await h.click('#approve-review');
 assert.equal(h.calls.find(c=>c.url==='/api/review').body.remember,true);
});
test('requests without a recorded risk still render and approve',async()=>{
 const h=await harness();
 assert.match(h.document.getElementById('inline-approvals').textContent,/Risk class not recorded/);
 await h.click('#inline-approvals [data-intent="approve"]');await h.click('#approve-review');
 const body=h.calls.find(c=>c.url==='/api/review').body;assert.equal(body.confirm,undefined);assert.equal(body.remember,undefined);
});
test('approvals view lists remembered rules with revoke and the audit chain',async()=>{
 const s=riskFixture('sensitive');
 s.run.grants=[{id:'g1',permission:'bash',match:'npm test',class:'sensitive',level:'R2',revoked:false},{id:'g0',permission:'bash',match:'old',class:'low',level:'R1',revoked:true}];
 s.audit=[{seq:1,run:'run_test',created:'2026-09-28T16:00:30Z',action:'requested',actor:'coder-1',risk:'R2',permission:'bash',target:'npm test'}];
 s.audit_chain={intact:true,broken_at:null};
 const h=await harness(s);await h.click('[data-view="approvals"]');
 const rules=h.document.getElementById('rule-list');
 assert.match(rules.textContent,/npm test/);assert(!rules.textContent.includes('old'));
 assert.match(h.document.getElementById('audit-list').textContent,/Audit chain intact/);
 assert.match(h.document.getElementById('audit-list').textContent,/requested/);
 await h.click('[data-action="revoke-rule"]');
 const call=h.calls.find(c=>c.url==='/api/control');
 assert.deepEqual([call.body.action,call.body.text],['revoke_rule','g1']);
 h.state.audit_chain={intact:false,broken_at:7};await h.poll();
 assert.match(h.document.getElementById('audit-list').textContent,/broken at entry 7/);
});
test('model server and usage appear only when configured',async()=>{
 let h=await harness();
 assert.equal(h.document.getElementById('model-usage').textContent.trim(),'');
 assert(!h.document.getElementById('agent-list').textContent.includes('Model server'));
 const s=fixture();
 s.health.agents.model={state:'ready',label:'local online · 12 ms'};
 s.models={configured:true,endpoints:[{id:'local',url:'http://127.0.0.1:8080',slots:1,default:true,in_flight:[{agent:'opencode'}],queued:[{agent:'hermes',role:'orchestrator'}],health:{state:'online'}}],gateway:{port:8768}};
 s.usage={total:{calls:3,tokens_in:12500,tokens_out:900,cost:0},by_agent:{hermes:{calls:2,tokens_in:2500,tokens_out:400,queued_ms:3000},'coder-1':{calls:1,tokens_in:10000,tokens_out:500,queued_ms:0}}};
 h=await harness(s);
 assert.match(h.document.getElementById('agent-list').textContent,/Model server/);
 assert.match(h.document.getElementById('agent-list').textContent,/local online/);
 const panel=h.document.getElementById('model-usage').textContent;
 assert.match(panel,/1 of 1 busy · 1 waiting \(hermes\)/);
 assert.match(panel,/gateway on/);
 assert.match(panel,/2 calls · 2500 in · 400 out · waited 3 s/);
 assert.match(panel,/10k in/);
 assert.match(panel,/no spend/);
 h.state.usage.total.cost=0.0123;await h.poll();
 assert.match(h.document.getElementById('model-usage').textContent,/\$0\.0123/);
});
(async()=>{let failed=0;for(const [name,fn]of tests){try{await fn();console.log('PASS '+name)}catch(error){failed++;console.error('FAIL '+name);console.error(error)}}console.log(`${tests.length-failed}/${tests.length} UI checks passed (DOM only; no rendered layout).`);process.exitCode=failed?1:0})();
