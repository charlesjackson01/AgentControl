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
const {clone,fixture}=require('./fixtures.cjs');
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
 const context=vm.createContext({document,window,console,URL,Blob,Date,Map,Set,JSON,Math,Number,String,Array,Object,module:undefined,
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
   else result={ok:true};
   return {status:200,ok:true,json:async()=>clone(result)};
  }});
 vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],context);
 vm.runInContext(source,context);await tick();
 assert.equal(document.getElementById('auth-error').textContent,'','Initial render must not throw');
 const click=async selector=>{const e=document.querySelector(selector);assert(e,selector);e.click();await tick();};
 return {document,state,calls,storage,context,click,poll:async()=>{await intervals[0]();await tick()}};
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
(async()=>{let failed=0;for(const [name,fn]of tests){try{await fn();console.log('PASS '+name)}catch(error){failed++;console.error('FAIL '+name);console.error(error)}}console.log(`${tests.length-failed}/${tests.length} UI checks passed (DOM only; no rendered layout).`);process.exitCode=failed?1:0})();
