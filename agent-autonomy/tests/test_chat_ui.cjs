const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {parseHTML} = require('linkedom');
const fx = require('./fixtures.cjs');
const {fixture,richActive,richCompleted,clone} = fx;
const thread = require(path.join(__dirname,'../chat/thread.js'));
const root = path.resolve(__dirname,'../chat');
const model = require(path.join(root,'model.js'));
const tick = ()=>new Promise(resolve=>setImmediate(resolve));
async function harness(state = fixture(), options = {}) {
  const {window,document} = parseHTML(fs.readFileSync(path.join(root,'index.html'),'utf8'));
  const local = new Map(options.key === false ? [] : [['ac-dashboard-key','test-key']]), session = new Map();
  for(const [k,v] of Object.entries(options.local || {}))local.set(k,v);
  for(const [k,v] of Object.entries(options.session || {}))session.set(k,v);
  window.matchMedia=()=>({matches:!!options.coarse});if(options.width)window.matchMedia=query=>({matches:query.includes('min-width: 1200px')?options.width>=1200:query.includes('max-width: 1199px')?options.width<1200:false});
  window.visualViewport=options.visualViewport || null;
  // linkedom's select.value has no setter; mirror the browser for dynamic Settings forms.
  Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return (this.querySelector('option[selected]') || this.querySelector('option'))?.value || '';},set(value){for(const option of this.querySelectorAll('option')){if(option.value===String(value))option.setAttribute('selected','');else option.removeAttribute('selected');}}});
  let activeElement=null;Object.defineProperty(document,'activeElement',{get:()=>activeElement,configurable:true});window.HTMLElement.prototype.focus=function(){if(activeElement!==this){activeElement=this;this.dispatchEvent(new window.Event('focusin',{bubbles:true}));}};
  // Reflect tabindex=0 and native focusability (linkedom incorrectly treats zero as absent).
  Object.defineProperty(window.HTMLElement.prototype,'tabIndex',{configurable:true,get(){const value=this.getAttribute('tabindex');return value!==null?Number(value):this.matches('button,input,textarea,select,summary,a[href]')?0:-1;},set(value){this.setAttribute('tabindex',String(value));}});
  // Reflect disclosure state, like the browser (linkedom lacks details.open).
  Object.defineProperty(Object.getPrototypeOf(document.createElement('details')),'open',{configurable:true,get(){return this.hasAttribute('open');},set(value){if(value)this.setAttribute('open','');else this.removeAttribute('open');}});
  const storage = map=>({getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)});
  Object.defineProperty(window,'localStorage',{value:storage(local),writable:true,configurable:true}); Object.defineProperty(window,'sessionStorage',{value:storage(session),writable:true,configurable:true});
  if(options.storageDenied) for(const name of ['localStorage','sessionStorage']) Object.defineProperty(window,name,{configurable:true,get(){throw Error('Storage denied');}});
  window.location = {hash:options.hash || '#/',replace(hash){this.hash=hash;}};
  if(options.contextOpen) local.set('acx-context-open','true');
  let publicThread=options.thread || (state.run?.status === 'completed' ? fx.threadSingle() : fx.threadActive());
  if(!state.run)publicThread=fx.threadResponse([],[]);
  if(!options.thread && state.runs?.some(s=>s.id==='run_old')) {const old=fx.threadSession('run_old',{created:'2026-09-27T10:00:00Z',title:'Describe the files'});publicThread.sessions.unshift(old);publicThread.messages.unshift(fx.threadMessage('run:run_old','session_start',old.title,{}, {session:old.id,at:old.created}));}
  const timers = new Map(), calls = []; let next = 0, streamWake;
  const context = vm.createContext({window,document,console,TextDecoder,AbortController,Date,URL,encodeURIComponent,decodeURIComponent,
    setTimeout:(fn,delay)=>{const id=++next;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id),
    fetch:async(url,request)=>{
      calls.push({url,request}); assert.equal(request.headers.Authorization,'Bearer test-key');
      if(request.method==='POST' && options.post){const result=await options.post(url,JSON.parse(request.body));if(result?.throws)throw Error(result.throws);return {ok:!result?.error,status:result?.status || (result?.error?400:200),json:async()=>clone(result || {ok:true})};}
      if(url==='/api/workspace/preflight') {if(options.holdPreflight)await new Promise(resolve=>{options.releasePreflight=resolve;});return {ok:true,status:200,json:async()=>clone(options.preflight || fx.composerPreflight)};}
      if(url==='/api/sandbox')return {ok:true,status:200,json:async()=>clone(state.sandbox || {unavailable:'No runtime',models_configured:false})};
      if(url==='/api/mode/preview')return {ok:true,status:200,json:async()=>({mode:'single',reasons:['Small goal']})};
      if (url === '/api/events') {
        if (options.streamUnauthorized) return {ok:false,status:401,json:async()=>({error:'Stream key rejected'})};
        if (!options.stream) return {ok:false,status:503};
        return {ok:true,status:200,body:{getReader:()=>({read:()=>new Promise(resolve=>{streamWake=resolve;})})}};
      }
      if (options.unauthorized || options.unauthorizedPath && url.startsWith(options.unauthorizedPath)) return {ok:false,status:401,json:async()=>({error:'Key rejected by server'})};
      if (options.fail) return {ok:false,status:500,json:async()=>({error:'Backend unavailable'})};
      if(options.respond) {const result=await options.respond(url,request);if(result!==undefined)return {ok:!result.error,status:result.error?404:200,json:async()=>clone(result)};}
      if(url.startsWith('/api/projects/browse'))return {ok:true,status:200,json:async()=>clone(options.browse || {root:'/tmp',path:'/tmp',parent:null,entries:[]})};
      if(url==='/api/skills')return {ok:true,status:200,json:async()=>clone(options.skills || {library_path:'/tmp/skills',library:[],installs:[],log:[]})};
      if(url.startsWith('/api/channels'))return {ok:true,status:200,json:async()=>clone(options.channels || fx.threadChannels(publicThread,options.thread ? publicThread.messages.filter(m=>m.action && m.kind!=='outcome').length : state.inbox?.length || 0))};
      if(url.startsWith('/api/thread')) {const query=new URL(url,'http://test').searchParams;if(query.get('session')==='bogus')return {ok:false,status:404,json:async()=>({error:'Unknown session'})};return {ok:true,status:200,json:async()=>clone(publicThread)};}
      if (options.hold && url.startsWith('/api/state')) await new Promise(resolve=>{options.release=resolve;});
      return {ok:true,status:200,json:async()=>{const result=clone(state);if(url.endsWith('run=bogus')) result.run=null;return result;}};
    }});
  for (const file of ['core.js','model.js','thread.js','decisions.js','composer.js','members.js','workspace.js','sections.js','shell.js'].filter(file=>fs.existsSync(path.join(root,file)))) vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context);
  await tick();await tick();
  async function runTimers(delay) {const pending=[...timers].filter(([,t])=>t.delay===delay);for(const [id,t] of pending){timers.delete(id);t.fn();}await tick();}
  return {window,document,composer:window.AC.shell.composer,core:window.AC.core,shell:window.AC.shell,local,session,timers,calls,runTimers,options,publicThread,timeline:document.querySelector('#timeline'),emit:async text=>{streamWake({done:false,value:new TextEncoder().encode(text)});await tick();},drop:async()=>{streamWake({done:true});await tick();}};
}
const tests = [];
const test = (name,fn)=>tests.push([name,fn]);
test('sign-in and shared storage semantics',async()=>{
  const h=await harness(fixture(),{key:false}); assert.equal(h.document.querySelector('#sign-in').hidden,false);assert.equal(h.calls.length,0);
  h.core.connect(' test-key ',false);await tick();assert.equal(h.session.get('ac-dashboard-key'),'test-key');assert.equal(h.local.has('ac-dashboard-key'),false);assert.equal(h.document.querySelector('#app').hidden,false);
  h.core.connect('test-key',true);await tick();assert.equal(h.local.get('ac-dashboard-key'),'test-key');assert.equal(h.session.has('ac-dashboard-key'),false);
});
test('storage getter failures still allow session connection',async()=>{const h=await harness(fixture(),{storageDenied:true});assert.equal(h.core.getState().authenticated,false);h.core.connect('test-key',true);await tick();assert.equal(h.document.querySelector('#app').hidden,false);});
test('401 returns server error to sign-in and clears stored key',async()=>{
  const h=await harness(fixture(),{unauthorized:true});assert.equal(h.document.querySelector('#app').hidden,true);assert.match(h.document.querySelector('#sign-in-error').textContent,/Key rejected by server/);assert.equal(h.local.size,0);
});
test('sessions ordered, deep links focus and open context',async()=>{
  const h=await harness(richActive());const rail=[...h.document.querySelectorAll('#session-list a')];assert.match(rail[0].getAttribute('href'),/run_test/);
  const timeline=[...h.document.querySelectorAll('[data-session]')];assert.equal(timeline[0].dataset.session,'run_old');
  h.window.location.hash='#/s/run_test';h.shell.route();await h.runTimers(0);
  assert.equal(h.document.querySelector('#context').hidden,false);assert.equal(h.document.querySelector('.focused [data-session]').dataset.session,'run_test');assert(h.calls.some(c=>/scope=current&run=run_test/.test(c.url)));
  h.shell.setContext(false);assert.equal(h.local.get('acx-context-open'),'false');
  h.window.location.hash='#/unknown';h.shell.route();assert.equal(h.window.location.hash,'#/');
});
test('unknown fresh session recovers and never fetches agents',async()=>{
  const h=await harness(richActive(),{hash:'#/s/bogus'});
  assert.equal(h.window.location.hash,'#/');assert.equal(h.core.getState().focused,'');
  assert.equal(h.document.querySelectorAll('#session-list a').length,2);
  assert.match(h.document.querySelector('#banner-text').textContent,/That session is not in this project's history/);
  assert.equal(h.document.querySelector('#context').hidden,true);assert.equal(h.document.querySelector('#scrim').hidden,true);
  h.document.querySelector('#dismiss-error').click();assert.equal(h.document.querySelector('#banner').hidden,true);
  const n=h.calls.length;await h.core.refresh();assert.equal(h.calls.length,n+3);
  assert.equal(h.calls.filter(c=>c.url.startsWith('/api/agents')).length,0);
});
test('stale link and failed refresh preserve later live updates',async()=>{
  const state=richActive(), options={stream:true};const h=await harness(state,options);
  h.window.location.hash='#/s/bogus';h.shell.route();await h.runTimers(0);
  options.fail=true;await h.core.refresh();options.fail=false;
  state.runs[0].title='Updated session';await h.emit('event: change\ndata: {}\n\n');await h.runTimers(0);
  assert.match(h.document.querySelector('#session-list').textContent,/Updated session/);
  assert.equal(h.calls.filter(c=>c.url.startsWith('/api/agents')).length,0);
});
test('saved context and return to room leave no scrim',async()=>{
  const h=await harness(richActive(),{contextOpen:true});
  for(const id of ['scrim','context'])assert.equal(h.document.getElementById(id).hidden,true);
  h.window.location.hash='#/s/run_test';h.shell.route();await h.runTimers(0);
  assert.equal(h.document.getElementById('context').hidden,false);
  h.window.location.hash='#/';h.shell.route();
  for(const id of ['scrim','context'])assert.equal(h.document.getElementById(id).hidden,true);
});
test('every presence state has a symbol and label, Hermes first',async()=>{
  const states=['working','waiting_on_you','needs_attention','paused','idle','finished','failed','stopped','blocked','limit_reached'];
  const state=fixture();state.agents=states.map((state,i)=>({name:'coder-'+i,type:'coder',state,task:'Task '+i,since:'2026-09-28T16:00:00Z'}));state.agents.push({name:'hermes',state:'working',type:'orchestrator'});
  const h=await harness(state);const members=model.membersFromState(state);assert.equal(members[0].name,'hermes');for(const member of members){assert(member.symbol);assert.match(h.document.querySelector('#rail').textContent,new RegExp(member.stateLabel));}
  h.window.location.hash='#/s/run_test';h.shell.route();await h.runTimers(0);h.document.querySelector('#members-tab').click();assert.match(h.document.querySelector('#context').textContent,/Task 9/);
});
test('waiting pointer and room composer, controls only on actionable messages',async()=>{
  const h=await harness();assert.equal(h.document.querySelector('#waiting-pointer').textContent,'! 1 waiting for you');assert.equal(h.document.querySelector('#waiting a').getAttribute('href'),'/classic');
  assert(!h.document.querySelector('#composer').hasAttribute('disabled'));assert.match(h.document.querySelector('#composer').getAttribute('placeholder'),/Message Hermes/);
  assert.equal(h.document.querySelectorAll('[data-decision="approve"]').length,1);
  assert.equal(h.document.querySelectorAll('[data-message]:not(:has(.waiting-state)) [data-decision]').length,0);
  const done=await harness(richCompleted());assert.equal(done.document.querySelector('#waiting').textContent,'');
});
test('API strings cannot inject markup',async()=>{
  const state=fixture();const attack='<img src=x onerror=alert(1)>';state.project='/tmp/'+attack;state.runs[0].title=attack;state.run.summary=attack;state.run.goal=attack;state.agents=[{name:attack,state:'working',task:attack}];state.health.agents.hermes.label=attack;
  const h=await harness(state,{hash:'#/s/run_test'});assert.equal(h.document.querySelectorAll('img').length,0);assert.match(h.document.querySelector('#context').textContent,/<img/);
});
test('change bursts coalesce and a mid-refresh change has one trailing refresh',async()=>{
  const options={stream:true};const h=await harness(fixture(),options);const initial=h.calls.filter(c=>c.url.startsWith('/api/state')).length;
  await h.emit('event: hello\ndata: {}\n\nevent: change\ndata: {}\n\nevent: change\ndata: {}\n\n');await h.runTimers(0);assert.equal(h.calls.filter(c=>c.url.startsWith('/api/state')).length,initial+1);
  options.hold=true;h.core.scheduleRefresh();await h.runTimers(0);h.core.handleEventBlock('event: change\ndata: {}');await h.runTimers(0);options.hold=false;options.release();await tick();await h.runTimers(0);assert.equal(h.calls.filter(c=>c.url.startsWith('/api/state')).length,initial+3);
});
test('503 polls active every 2s and idle every 10s, with retry',async()=>{
  const h=await harness();assert.match(h.document.querySelector('#live').textContent,/Reconnecting/);assert([...h.timers.values()].some(t=>t.delay===2000));const n=h.calls.length;await h.runTimers(2000);assert(h.calls.length>n);
  const idle=await harness(richCompleted());assert([...idle.timers.values()].some(t=>t.delay===10000));assert([...idle.timers.values()].some(t=>t.delay===1000));
});
test('stream drops recover and stream 401 signs out',async()=>{
  const h=await harness(fixture(),{stream:true});assert.equal(h.core.getState().live,'Live');await h.emit('event: change\r\ndata: {}\r\n\r\n');await h.runTimers(0);await h.drop();assert.equal(h.core.getState().live,'Reconnecting…');assert([...h.timers.values()].some(t=>t.delay===2000));h.core.stop();assert.equal([...h.timers].length,0);
  const rejected=await harness(fixture(),{streamUnauthorized:true});assert.equal(rejected.core.getState().authenticated,false);assert.match(rejected.document.querySelector('#sign-in-error').textContent,/Stream key rejected/);
});
test('dismissible API errors',async()=>{
  const h=await harness(fixture(),{fail:true});assert.equal(h.document.querySelector('#banner').hidden,false);assert.match(h.document.querySelector('#banner-text').textContent,/Backend unavailable/);h.document.querySelector('#dismiss-error').click();assert.equal(h.document.querySelector('#banner').hidden,true);
});
test('pure model functions preserve state and terminal semantics',()=>{
  const state=richActive(),before=JSON.stringify(state);const channels=model.channelsFromState(state);assert.equal(channels[0].title,'project');assert.equal(channels[0].sessions,2);assert.equal(channels[0].waiting,1);assert.equal(model.waitingFromState(state).runs[0],'run_test');assert.equal(model.connectionsFromState(state).items.length,2);assert.equal(JSON.stringify(state),before);
  for(const status of ['completed','blocked','failed','stopped','limit_reached','paused','interrupted'])assert.equal(model.sessionsFromState({runs:[{id:'a',status,goal:'x'}]})[0].active,['paused','interrupted'].includes(status));
  assert.equal(model.sessionsFromState({runs:[{goal:'x'.repeat(90)+'\nignored'}]})[0].title.length,80);assert.equal(model.membersFromState({})[0].stateLabel,'Idle');assert.equal(model.timeLabel('bad'),'Unknown time');assert.equal(model.relTime('bad'),'');assert.equal(model.esc('<&"\''),'&lt;&amp;&quot;&#39;');
});
test('tokens and isolation guards',()=>{
  const css=fs.readFileSync(path.join(root,'chat.css'),'utf8'),tokens=fs.readFileSync(path.join(root,'tokens.css'),'utf8');assert(!/#(?:[0-9a-f]{3,8})\b|\brgba?\(|\bhsla?\(|(?:^|[: ,])(?:white|black|red|blue|gray|grey|transparent|currentColor)(?=[; ,}])/i.test(css));
  for(const [,token] of css.matchAll(/var\((--[\w-]+)\)/g))assert(tokens.includes(token+':'),token);
  for(const file of fs.readdirSync(root))assert(!/\/(?:app\.js|app\.css|themes\.css|workspace\.css)|(?<!\/chat)\/workspace\.js/.test(fs.readFileSync(path.join(root,file),'utf8')),file);
});
test('M3 kinds, progressive detail, roles, receipts and unknown kinds',async()=>{
  const data=fx.threadTeam();data.messages.push(fx.threadMessage('alert:1','alert','Needs attention',{reason:'Check integration'}),fx.threadMessage('unknown:1','future_kind','Recorded future event',{raw:'PRIVATE'}));
  const h=await harness(richActive(),{thread:data});const content=h.timeline.textContent;
  for(const label of ['turn 1','✕ failed','✓ passed','submission uncertain','Team plan · 2 agents · 2 tasks','Team proposal waiting','coder-2','Awaiting confirmation · by you','3 updates','research ·','Python testing','Needs attention','Recorded future event','→ @coder-2','Redirect after denying request p0']) assert(content.includes(label),label);
  assert(!content.includes('PRIVATE'));assert(h.timeline.querySelector('[data-message="unknown:1"] .quiet'));
  const details=h.timeline.querySelector('[data-message="turn:1"] details');assert(!details.open);details.open=true;
  assert(details.textContent.includes('todo.py'));assert(details.textContent.includes('Tests failed'));assert(!details.querySelector('[data-workspace-link]'));const workspaceLink=h.timeline.querySelector('[data-message="turn:1"] .message > [data-workspace-link]');assert.equal(workspaceLink.textContent,'Open turn details');assert.equal(workspaceLink.getAttribute('href'),'#/w/run_test/coder-1');
  for(const selector of ['[data-message="ev:2"] ol','[data-message="ev:5"] dl','[data-message="turn:r"] dl','[data-message="cap:1"] dl','[data-message="req:permission:p2"] dl'])assert(h.timeline.querySelector(selector),selector);
  data.messages.find(m=>m.id==='req:permission:p2').detail.receipt.actor='automatic local rule';data.messages.find(m=>m.id==='req:permission:p2').rev++;await h.core.refresh();assert(h.timeline.textContent.includes('Awaiting confirmation · by automatic local rule'));
  const single=await harness(richCompleted(),{thread:fx.threadSingle()});assert(single.timeline.textContent.includes('Workspace open'));assert(single.timeline.textContent.includes('apply blocked: Working tree changed'));
});
test('M3 actions link once to classic; M5 controls are scoped and hide fingerprints',async()=>{
  for(const data of [fx.threadSingle(),fx.threadActive(),fx.threadTeam()]){
    const h=await harness(fixture(),{thread:data});
    for(const message of data.messages.filter(m=>m.action)){const node=h.timeline.querySelector(`[data-message="${message.id}"]`);assert.equal(node.querySelectorAll('a[href="/classic"]').length,1);assert(node.textContent.includes('Waiting for you'));}
    for(const node of h.timeline.querySelectorAll('[data-decision]'))assert(data.messages.find(m=>m.id===node.closest('[data-message]').dataset.message)?.action);
    assert.equal(h.timeline.querySelectorAll('[data-message]:not(:has(.waiting-state)) [data-decision]').length,0);
    assert(!h.document.toString().includes('NEVER-SHOW-FINGERPRINT'));assert(h.calls.every(c=>c.request.method==='GET' || c.url==='/api/events'));
  }
});
test('M3 plain text escapes text, notes, plans, files and result tails',async()=>{
  const data=fx.threadActive(),attack='<img src=x onerror=alert(1)> **x**';
  for(const message of data.messages){message.text=attack;message.detail.raw='PRIVATE RAW';message.detail.reasoning='PRIVATE REASONING';}
  data.messages.find(m=>m.kind==='decision').detail.plan=[attack];
  const turn=data.messages.find(m=>m.kind==='turn');turn.detail.prompt=attack;turn.detail.files[0].path=attack;turn.detail.result_tail=attack;
  const h=await harness(fixture(),{thread:data});assert.equal(h.timeline.querySelectorAll('img,strong').length,0);assert(h.timeline.textContent.includes(attack));assert(!h.timeline.textContent.includes('PRIVATE'));assert.equal(h.timeline.querySelector('pre').textContent,attack);
});
test('M3 stub and revision merge keeps unchanged DOM and disclosure',async()=>{
  const data=fx.threadActive(),h=await harness(fixture(),{thread:data});
  const oldNode=h.timeline.querySelector('[data-message="turn:1"]'), request=h.timeline.querySelector('[data-message="req:permission:p1"]');request.querySelector('details').open=true;
  const oldMessage=h.core.getState().thread.messages['turn:1'];
  h.options.respond=url=>{if(!url.startsWith('/api/thread'))return;return {...data,messages:data.messages.map(m=>m.id==='req:permission:p1' ? {...m,rev:2,action:null,detail:{...m.detail,receipt:{actor:'you',action:'approve',state:'sent'}}} : {id:m.id,rev:m.rev,same:true})};};
  await h.core.refresh();assert.equal(h.timeline.querySelector('[data-message="turn:1"]'),oldNode);assert.equal(h.core.getState().thread.messages['turn:1'],oldMessage);
  const changed=h.timeline.querySelector('[data-message="req:permission:p1"]');assert.notEqual(changed,request);assert(changed.querySelector('details').open);assert.equal(h.timeline.querySelectorAll('[data-message="req:permission:p1"]').length,1);assert(changed.textContent.includes('Awaiting confirmation · by you'));assert(!changed.textContent.includes('Waiting for you'));
});
test('M3 pure merge preserves server order, aged window and moved requests',()=>{
  const s=fx.threadSession(),page=messages=>fx.threadResponse(messages,[s]);
  const a=fx.threadMessage('a','goal','a'),b=fx.threadMessage('b','request','b'),c=fx.threadMessage('c','note','c'),d=fx.threadMessage('d','turn','d');
  let cache=thread.mergeNewest(thread.emptyCache(),page([a,b,c]));cache=thread.mergeNewest(cache,page([c,{...b,rev:2},d]));assert.deepEqual(cache.ids,['a','c','b','d']);
  assert.equal(cache.messages.a,a);assert.equal(cache.messages.b.rev,2);
  cache=thread.prependOlder(cache,page([a]));assert.equal(cache.ids.length,4);
});
test('M3 refresh walks a 250-message gap to overlap and resets after five pages',async()=>{
  const s=fx.threadSession(),message=i=>fx.threadMessage('gap:'+i,'decision','Update '+i),page=(start,end,before)=>fx.threadResponse(Array.from({length:end-start},(_,i)=>message(start+i)),[s],before);
  const h=await harness(fixture(),{thread:page(0,200,null)});
  h.options.respond=url=>{if(!url.startsWith('/api/thread'))return;const cursor=new URL(url,'http://test').searchParams.get('before');return cursor==='250' ? page(50,250,'50') : page(250,450,'250');};
  await h.core.refresh();assert.equal(h.core.getState().thread.ids.length,450);assert(h.calls.some(c=>c.url.includes('before=250')));
  let walked=0;h.options.respond=url=>{if(!url.startsWith('/api/thread'))return;const cursor=new URL(url,'http://test').searchParams.get('before');if(cursor)walked++;const n=cursor ? Number(cursor) : 2000;return page(n-200,n,String(n-200));};
  await h.core.refresh();assert.equal(walked,5);assert.equal(h.core.getState().thread.ids.length,1200);assert(!h.core.getState().thread.messages['gap:0']);assert.equal(h.core.getState().thread.before,'800');
});
function geometry(h) {
  const host=h.timeline;let scroll=0,height=1000;
  Object.defineProperties(host,{scrollTop:{configurable:true,get:()=>scroll,set:v=>{scroll=v;}},scrollHeight:{configurable:true,get:()=>height},clientHeight:{configurable:true,get:()=>200}});
  host.getBoundingClientRect=()=>({top:0,bottom:200});
  return {setHeight:v=>{height=v;},setScroll:v=>{scroll=v;host.dispatchEvent(new h.window.Event('scroll'));}};
}
test('M3 paging prepends in order, beginning marker and viewport anchor',async()=>{
  const pages=fx.threadLong(),h=await harness(richCompleted(),{thread:pages[0]});const geo=geometry(h);geo.setScroll(100);
  h.options.respond=url=>{if(!url.startsWith('/api/thread'))return;return new URL(url,'http://test').searchParams.get('before')==='long:250' ? pages[1] : pages[2];};
  geo.setHeight(1300);const old=h.core.getState().thread.ids[0];await h.core.loadOlder();assert.equal(h.core.getState().thread.ids[200],old);
  const count=h.core.getState().thread.ids.length;geo.setHeight(1600);await h.core.loadOlder();assert.equal(h.core.getState().thread.ids.length,count+50);assert.equal(new Set(h.core.getState().thread.ids).size,450);assert.equal(h.timeline.querySelector('[data-collapse="long-0"]').textContent,'Show 149 messages');assert.equal(h.core.getState().thread.before,null);assert(h.timeline.textContent.includes("Beginning of this project's history"));
  // Deterministic layout change during prepend exercises the scrollHeight fallback.
  const pages2=fx.threadLong(),h2=await harness(fixture(),{thread:pages2[0]});const g2=geometry(h2);g2.setScroll(100);
  h2.options.respond=url=>{if(url.startsWith('/api/thread')){g2.setHeight(1400);return pages2[1];}};
  // Observe height before and after actual DOM insertion, as a browser does.
  let measured=0;Object.defineProperty(h2.timeline,'scrollHeight',{get:()=>++measured===1 ? 1000 : 1400});
  await h2.core.loadOlder();assert.equal(h2.timeline.scrollTop,500);
});
test('M3 follows bottom or shows new-message pill while reading history',async()=>{
  const data=fx.threadActive(),h=await harness(fixture(),{thread:data}),geo=geometry(h);geo.setScroll(800);geo.setHeight(1200);
  data.messages.push(fx.threadMessage('new:1','decision','New decision'));await h.core.refresh();assert.equal(h.timeline.scrollTop,1200);assert(h.document.querySelector('#new-messages').hidden);
  geo.setScroll(100);data.messages.push(fx.threadMessage('new:2','decision','Another decision'));await h.core.refresh();assert.equal(h.timeline.scrollTop,100);assert.equal(h.document.querySelector('#new-messages').textContent,'1 new ↓');assert(!h.document.querySelector('#new-messages').hidden);h.document.querySelector('#new-messages').click();assert.equal(h.timeline.scrollTop,1200);
});
test('M3 older sessions collapse, active stays expanded and parent links route',async()=>{
  const pages=fx.threadLong(),h=await harness(fixture(),{thread:pages[0]});h.options.respond=url=>url.startsWith('/api/thread') ? pages[1] : undefined;await h.core.loadOlder();h.options.respond=url=>url.startsWith('/api/thread') ? pages[2] : undefined;await h.core.loadOlder();
  const button=h.timeline.querySelector('[data-collapse="long-0"]');assert.equal(button.getAttribute('aria-expanded'),'false');assert(h.timeline.querySelector('[data-message="long:long-0:0"]').hidden);button.click();assert(!h.timeline.querySelector('[data-message="long:long-0:0"]').hidden);assert.equal(h.timeline.querySelector('[data-collapse="long-2"]').getAttribute('aria-expanded'),'true');assert(h.timeline.querySelector('a[href="#/s/long-0"]'));
  const active=threadSessionActive();assert.equal(thread.sessionCollapsed(active,'newest',{session:active.id}),false);
});
function threadSessionActive(){return fx.threadSession('active',{status:'coding'});}
test('M3 focus pages two pages back and highlights divider',async()=>{
  const pages=fx.threadLong(),options={thread:pages[0]},h=await harness(fixture(),options);
  options.respond=url=>{if(!url.startsWith('/api/thread'))return;const cursor=new URL(url,'http://test').searchParams.get('before');return cursor==='long:250'? pages[1] : cursor==='long:50' ? pages[2] : pages[0];};
  h.window.location.hash='#/s/long-0';h.shell.route();await h.runTimers(0);await tick();await tick();
  assert(h.timeline.querySelector('[data-session="long-0"]').parentNode.classList.contains('focused'));assert.equal(h.calls.filter(c=>c.url.includes('&before=')).length,2);assert(!h.calls.some(c=>c.url.includes('?session=long-0')));
});
test('M3 focus beyond ten pages uses isolated single-session view and back',async()=>{
  const page=fx.threadSingle();page.before='older';const h=await harness(fixture(),{thread:page});let walked=0;
  h.options.respond=url=>{if(!url.startsWith('/api/thread'))return;const query=new URL(url,'http://test').searchParams;if(query.has('session')){const s=fx.threadSession('far');return fx.threadResponse([fx.threadMessage('run:far','session_start',s.title,{}, {session:s.id})],[s]);}if(query.has('before')){walked++;return {...page,before:'older'+walked};}return page;};
  h.window.location.hash='#/s/far';h.shell.route();await h.runTimers(0);for(let i=0;i<15;i++)await tick();
  assert.equal(walked,10);assert(h.timeline.textContent.includes('Viewing one session'));assert(h.timeline.querySelector('a[href="#/"]'));assert(!h.core.getState().thread.messages['run:far']);
  h.window.location.hash='#/';h.shell.route();assert(!h.timeline.textContent.includes('Viewing one session'));
});
test('M3 live phases and pending note hint use thread only',async()=>{
  for(const [phase,label] of [['manager','Hermes is planning…'],['code','Agents are working…'],['verify','Verifying…']])assert.equal(thread.liveLabel({session:'a',phase}),label);
  assert.equal(thread.liveLabel({session:null,phase:'code'}),'');
  const data=fx.threadActive(),h=await harness(fixture(),{thread:data});assert(h.timeline.textContent.includes('Hermes reads this before the next turn'));assert.equal(h.timeline.querySelector('#thread-live').textContent,'Agents are working…');
  data.messages.push(fx.threadMessage('later','decision','Recorded decision'));await h.core.refresh();assert(!h.timeline.textContent.includes('Hermes reads this before the next turn'));data.live.session=null;await h.core.refresh();assert(h.timeline.querySelector('#thread-live').hidden);
});
test('M3 waiting count is from channels and pointer finds first action',async()=>{
  const data=fx.threadActive(),h=await harness(richCompleted(),{thread:data,channels:fx.threadChannels(data,2)});assert.equal(h.document.querySelector('#waiting-pointer').textContent,'! 2 waiting for you');h.document.querySelector('#waiting-pointer').click();await tick();assert(h.timeline.querySelector('[data-message="req:permission:p1"]').classList.contains('focused'));
  h.options.channels.channels[0].waiting=1;await h.core.refresh();assert.equal(h.document.querySelector('#waiting-pointer').textContent,'! 1 waiting for you');assert(!h.document.querySelector('#waiting').textContent.includes('requests'));
});
test('M3 one change refreshes all three endpoints with known and handles their 401',async()=>{
  const h=await harness(fixture(),{stream:true});const n=h.calls.length;await h.emit('event: change\ndata: {}\n\n');await h.runTimers(0);const calls=h.calls.slice(n);assert.equal(calls.length,3);assert(calls.some(c=>c.url.startsWith('/api/thread?channel=main&limit=200&known=')));assert(calls.some(c=>c.url==='/api/channels'));assert(calls.some(c=>c.url.startsWith('/api/state')));assert(!h.calls.some(c=>c.url.startsWith('/api/agents')));
  for(const endpoint of ['/api/thread','/api/channels']){const rejected=await harness(fixture(),{unauthorizedPath:endpoint});assert(!rejected.core.getState().authenticated);assert(!rejected.document.querySelector('#sign-in').hidden);}
});
test('M3 waiting pointer pages for the first action, bounded at ten pages',async()=>{
  const data=fx.threadSingle();data.messages.at(-1).action=null;data.before='earlier';
  const h=await harness(fixture(),{thread:data,channels:fx.threadChannels(data,1)});let reads=0;
  h.options.respond=url=>{if(!url.startsWith('/api/thread'))return;reads++;const older=fx.threadActive();older.messages.at(-1).id='req:permission:p0';return older;};
  const id=await h.core.locateWaiting();assert.equal(id,'req:permission:p0');assert.equal(reads,1);
  const noAction=await harness(fixture(),{thread:data});let bounded=0;
  noAction.options.respond=url=>{if(url.startsWith('/api/thread')){bounded++;return {...data,before:'earlier'+bounded};}};
  assert.equal(await noAction.core.locateWaiting(),null);assert.equal(bounded,10);
});
test('M3 local day boundaries and empty room do not create agent messages',async()=>{
  const messages=[fx.threadMessage('day1','progress','One'),fx.threadMessage('day2','system','Two',{}, {at:'2026-09-29T16:00:00Z'})];
  assert.equal(thread.groupQuiet(messages).length,2);
  const h=await harness(fixture(),{thread:fx.threadResponse(messages,[fx.threadSession()])});assert.equal(h.timeline.querySelectorAll('.day-separator').length,2);
  const empty=await harness(fx.empty());assert.match(empty.timeline.textContent,/A room for your project/);assert.equal(empty.timeline.querySelectorAll('[data-message]').length,0);
});
test('M3 a new terminal outcome revalidates older cached actions through read pages',async()=>{
  const old=fx.threadSingle();old.sessions[0].id='old';old.messages.forEach(m=>{m.id='old:'+m.id;m.session='old';});
  const active=fx.threadActive(), combined=fx.threadResponse([...old.messages,...active.messages],[...old.sessions,...active.sessions],null,active.live);
  const h=await harness(fixture(),{thread:combined});
  const finished=fx.threadSingle();finished.before='older-outcome';let reads=0;
  const retired=clone(old);retired.messages.at(-1).action=null;retired.messages.at(-1).rev++;
  h.options.respond=url=>{if(!url.startsWith('/api/thread'))return;reads++;return url.includes('&before=') ? retired : finished;};
  await h.core.refresh();assert.equal(reads,2);assert.equal(h.core.getState().thread.messages['old:out:run_test'].action,null);
  assert.equal(h.timeline.querySelector('[data-message="old:out:run_test"] a[href="/classic"]'),null);
  assert.equal(h.core.getState().thread.ids.filter(id=>id==='old:out:run_test').length,1);
});
test('M3 grouped quiet disclosure survives prepending into its group',async()=>{
  const s=fx.threadSession(), data=fx.threadResponse([fx.threadMessage('q2','progress','Two'),fx.threadMessage('q3','system','Three')],[s],'older');
  const h=await harness(fixture(),{thread:data});h.timeline.querySelector('.updates').open=true;
  h.options.respond=url=>url.startsWith('/api/thread') ? fx.threadResponse([fx.threadMessage('q1','progress','One')],[s]) : undefined;
  await h.core.loadOlder();assert(h.timeline.querySelector('.updates').open);assert.equal(h.timeline.querySelector('.updates summary').textContent,'3 updates');
});

test('M3.1 exact receipt decisions, delivery labels, actors and redirect',async()=>{
  const h=await harness(fixture(),{thread:fx.threadReceipts()});
  const labels=['Approved once · by you','Denied · by you · redirected','Answered · by you','Awaiting confirmation · by you','Delivery uncertain · by automatic local rule','Delivery failed · by you','Sending decision · by you','Request resolved · by you','recorded custom state · by <local rule>'];
  const actual=[];
  for(const [i,label] of labels.entries()){
    const node=h.timeline.querySelector(`[data-message="receipt:${i}"]`);
    actual.push(node.querySelectorAll('.message > p')[2].textContent);
    assert.equal(node.querySelector('.actor').textContent.trim(),'● coder-2');
  }
  assert.deepEqual(actual,labels);
  const denied=h.timeline.querySelector('[data-message="receipt:1"]');
  const collapsed=[...denied.querySelectorAll('.message > p')].map(p=>p.textContent).join(' ');
  assert.match(collapsed,/Denied/);assert(!/Approved|Confirmed/.test(collapsed));
  assert(!collapsed.includes('Use a safe command instead.'));assert(denied.querySelector('details').textContent.includes('Use a safe command instead.'));
  assert.equal(h.timeline.querySelectorAll('local').length,0);
});
test('M3.1 waiting line separates summary, marker and link in every layout',async()=>{
  const messages=['skill','research','note','request'].map((kind,i)=>fx.threadMessage('layout:'+i,kind,'Summary '+i,{}, {action:{endpoint:'/api/control'}}));
  const h=await harness(fixture(),{thread:fx.threadResponse(messages,[fx.threadSession()])});
  for(const [i,type] of ['quiet','line','bubble','request-card'].entries()){
    const node=h.timeline.querySelector(`[data-message="layout:${i}"] .${type}`),line=node.querySelector(':scope > .waiting-line');
    assert(line,'separate waiting line in '+type);assert.equal(line.textContent,'! Waiting for you · Open in classic dashboard');
    assert.equal(line.querySelector('a').getAttribute('href'),'/classic');
    assert(line.previousElementSibling);assert(!line.previousElementSibling.textContent.includes('Waiting for you'));
  }
});
test('M3.1 rail counts use the M6 session union and current count wording',async()=>{
  const state=fixture();state.runs=Array.from({length:30},(_,i)=>({...state.run,id:'rail:'+i}));
  const channels=fx.threadChannels(fx.threadActive(),1);channels.channels[0].sessions=47;
  const h=await harness(state,{channels});assert.equal(h.document.querySelectorAll('#session-list a').length,31);
  assert(h.document.querySelector('#session-list a[href="#/s/run_test"]'));
  const note=h.document.querySelector('#session-list + .muted');assert(note);assert.equal(note.textContent,'Showing 31 of 47 sessions');
  state.runs=state.runs.slice(0,2);await h.core.refresh();assert.equal(h.document.querySelector('#session-list + .muted').textContent,'Showing 3 of 47 sessions');
  for(const total of [3,2]){channels.channels[0].sessions=total;await h.core.refresh();if(total===3)assert.equal(!!h.document.querySelector('#session-list + .muted'),false);else assert.equal(!!h.document.querySelector('#session-list + .muted'),false);}
});
function revalidationPages(kind='skill') {
  const s=fx.threadSession(), action=fx.threadMessage('stale',kind,'Needs a decision',{state:'proposed'}, {action:{endpoint:'/api/skills/decide'}}), overlap=fx.threadMessage('overlap','decision','Latest recorded update');
  const initial=fx.threadResponse([action,overlap],[s]);
  const newest=fx.threadResponse([overlap],[s],'page:1');
  const retired=fx.threadResponse([{...action,rev:2,action:null}],[s]);
  return {s,action,overlap,initial,newest,retired};
}
test('M3.1 waiting decrease revalidates every older actionable kind from server',async()=>{
  for(const kind of ['skill','proposal','request','research']){
    const p=revalidationPages(kind),channels=fx.threadChannels(p.initial,1),h=await harness(fixture(),{thread:p.initial,channels});
    let reads=0;h.options.respond=url=>{if(!url.startsWith('/api/thread'))return;if(url.includes('&before=')){reads++;return p.retired;}return p.newest;};
    await h.core.refresh();assert.equal(reads,0);assert(h.core.getState().thread.messages.stale.action);
    channels.channels[0].waiting=0;await h.core.refresh();assert.equal(reads,1);
    assert.equal(h.core.getState().thread.messages.stale.action,null);assert.equal(h.core.getState().thread.messages.stale.rev,2);
    assert.equal(h.timeline.querySelector('[data-message="stale"] .waiting-state'),null);
    await h.core.refresh();assert.equal(reads,1);
  }
});
for(const kind of ['skill','outcome'])test('M3.1 '+kind+' revalidation caps at ten pages and trims unverifiable history',async()=>{
  const p=revalidationPages(kind),channels=fx.threadChannels(p.initial,1),h=await harness(fixture(),{thread:p.initial,channels});
  channels.channels[0].waiting=0;
  if(kind==='outcome')p.newest.messages.push(fx.threadMessage('new-outcome','outcome','Finished',{status:'completed'}));
  let reads=0;h.options.respond=url=>{if(!url.startsWith('/api/thread'))return;if(!url.includes('&before='))return p.newest;reads++;return reads===12?p.retired:fx.threadResponse([fx.threadMessage('fetched:'+reads,'decision','Older recorded update')],[p.s],'page:'+(reads+1));};
  await h.core.refresh();assert.equal(reads,10);
  const cache=h.core.getState().thread;assert(!cache.ids.includes('stale'));assert.equal(cache.messages.stale,undefined);assert.equal(cache.before,'page:11');
  assert.deepEqual(Array.from(cache.ids),[...Array.from({length:10},(_,i)=>'fetched:'+(10-i)),...p.newest.messages.map(m=>m.id)]);
  assert.equal(h.timeline.querySelector('[data-message="stale"]'),null);assert(h.timeline.querySelector('#load-earlier'));
  await h.core.loadOlder();assert.equal(reads,11);assert.equal(h.core.getState().thread.before,'page:12');
});
test('M3.1 gap recovery and action revalidation share the ten-page budget',async()=>{
  const p=revalidationPages('outcome'),h=await harness(fixture(),{thread:p.initial});
  const newest=fx.threadResponse([fx.threadMessage('new-outcome','outcome','Finished',{status:'completed'})],[p.s],'page:1');
  let reads=0;h.options.respond=url=>{
    if(!url.startsWith('/api/thread'))return;if(!url.includes('&before='))return newest;
    reads++;return reads===12 ? p.retired : fx.threadResponse([reads===5 ? p.overlap : fx.threadMessage('gap-fetch:'+reads,'decision','Older update')],[p.s],'page:'+(reads+1));
  };
  await h.core.refresh();assert.equal(reads,10);assert.equal(h.core.getState().thread.messages.stale,undefined);assert.equal(h.core.getState().thread.before,'page:11');
});
test('M3.1 unchanged waiting never walks for an actionable finished-session research item',async()=>{
  const p=revalidationPages('research'),channels=fx.threadChannels(p.initial,0),h=await harness(fixture(),{thread:p.initial,channels});
  let reads=0;h.options.respond=url=>{if(!url.startsWith('/api/thread'))return;if(url.includes('&before=')){reads++;return p.retired;}return p.newest;};
  for(let i=0;i<3;i++)await h.core.refresh();assert.equal(reads,0);assert(h.core.getState().thread.messages.stale.action);
});

test('M5.0 expired research and skills retain recorded details without waiting or classic links',async()=>{
  const label='Not decided before the session ended';
  const messages=[fx.threadMessage('expired:research','research','Find docs',{status:'awaiting_approval',expired:true,request:{question:'Public docs',why:'Check compatibility'}}),
    ...['proposed','awaiting_fetch'].map(state=>fx.threadMessage('expired:'+state,'skill','Docs skill',{state,expired:true,agent:'coder-2',source:{type:'github',url:'https://example.test/docs'},reasons:['Docs']}))];
  const h=await harness(richCompleted(),{thread:fx.threadResponse(messages,[fx.threadSession('run_test',{status:'completed'})])});
  for(const msg of messages){
    const node=h.timeline.querySelector(`[data-message="${msg.id}"]`);
    assert(node.textContent.includes(label),msg.id);assert.equal(node.querySelector('.muted').textContent,label);
    assert.equal(node.querySelector('.waiting-line'),null);assert.equal(node.querySelector('a[href="/classic"]'),null);
    assert(node.querySelector('details'));assert(node.textContent.includes(msg.text));
    if(msg.kind==='skill'){assert(node.textContent.includes('coder-2'));assert(!node.querySelector('.message > p').textContent.includes(msg.detail.state));}
    else {assert(node.textContent.includes('research · Find docs'));assert(node.querySelector('details').textContent.includes('Public docs'));assert(!node.textContent.includes('Awaiting approval'));}
  }
});
test('M5.0 server expiry refresh retains research disclosure and removes its stale marker',async()=>{
  const msg=fx.threadMessage('expiry:research','research','Find docs',{status:'awaiting_approval',request:{question:'Public docs'}},{action:{endpoint:'/api/research/decide'}});
  const data=fx.threadResponse([msg],[fx.threadSession()]),channels=fx.threadChannels(data,1),h=await harness(fixture(),{thread:data,channels});
  const node=h.timeline.querySelector('[data-message="expiry:research"]');node.querySelector('details').open=true;
  msg.action=null;msg.detail.expired=true;msg.rev++;channels.channels[0].waiting=0;
  await h.core.refresh();
  const updated=h.timeline.querySelector('[data-message="expiry:research"]');assert(updated.querySelector('details').open);
  assert.equal(updated.querySelector('.muted').textContent,'Not decided before the session ended');
  assert.equal(updated.querySelector('.waiting-line'),null);assert.equal(updated.querySelector('a[href="/classic"]'),null);
});

const composerHelpers=require(path.join(root,'composer.js'));
async function composerHarness(kind='new',options={}) {const f=fx.composerFixture(kind);return harness(f.state,{thread:f.thread,channels:f.channels,...options});}
const posts=h=>h.calls.filter(c=>c.request.method==='POST').map(c=>({url:c.url,body:JSON.parse(c.request.body)}));
function type(h,text){const input=h.document.querySelector('#composer');input.value=text;input.dispatchEvent(new h.window.Event('input',{bubbles:true}));}
function key(h,name,extra={},target=h.document.querySelector('#composer')){const event=new h.window.Event('keydown',{bubbles:true,cancelable:true});Object.assign(event,{key:name,...extra});target.dispatchEvent(event);return event;}
function setting(h,name,value,event='input'){const node=h.document.querySelector('#setting-'+name);node.value=String(value);node.dispatchEvent(new h.window.Event(event,{bubbles:true}));}
test('M4 states, chips, pauses and project/connection blockers preserve drafts',async()=>{
  for(const [kind,chip,disabled] of [['new','New session',false],['finished','New session',false],['paused','Note → Hermes',false],['interrupted','Note → Hermes',false],['other','New session',true]]){
    const h=await composerHarness(kind);type(h,'Unsent text');assert.equal(h.document.querySelector('#composer-target').textContent,chip);assert.equal(h.document.querySelector('#composer').disabled,disabled);assert.equal(h.document.querySelector('#send-message').disabled,disabled);
    if(kind==='paused'||kind==='interrupted')assert(!h.document.querySelector('#resume-session').hidden);
    if(kind==='other'){assert.match(h.document.querySelector('#composer-blocked').textContent,/another-project/);await h.composer.submit();assert.equal(posts(h).length,0);}
  }
  const f=fx.composerFixture('new'),h=await harness(f.state,{thread:f.thread,channels:f.channels});type(h,'Keep this draft');
  const active=fx.composerFixture('paused');Object.assign(f.state,active.state);Object.assign(f.thread,active.thread);Object.assign(f.channels,active.channels);await h.core.refresh();assert.equal(h.document.querySelector('#composer-target').textContent,'Note → Hermes');assert.equal(h.document.querySelector('#composer').value,'Keep this draft');
  f.thread.live.session=null;f.channels.channels[0].active_session=null;f.state.run.status='completed';f.state.runs[0].status='completed';await h.core.refresh();assert.equal(h.document.querySelector('#composer-target').textContent,'New session');assert.equal(h.document.querySelector('#composer').value,'Keep this draft');
});
test('M4 pure helpers whitelist bodies and round-trip parent settings',()=>{
  assert.deepEqual(composerHelpers.runBody('Goal'),{goal:'Goal'});
  assert.deepEqual(composerHelpers.noteBody('r','Keep it simple',[]),{run:'r',action:'instruction',text:'Keep it simple'});
  assert.deepEqual(composerHelpers.runBody('Goal',{models:{},spend_cap:8,confirm:'approve',watch:true,max_steps:5,network:'none',cpus:2},{id:'bad'}).models,undefined);
  assert.throws(()=>composerHelpers.runBody('Goal',{isolation:'vm',network:'internet'}),/classic/);
  assert.deepEqual(composerHelpers.followUpDefaults({verifier:['python','folder with space',"a'b"],max_steps:4,mode:'team'}),{verifier:"python 'folder with space' 'a'\\''b'",max_steps:4,mode:'team'});
  for(const command of ['verify','apply','discard','team approve','team single','team repropose Smaller plan'])assert.equal(composerHelpers.parseSlash('/'+command).error,'');
});
test('M4 new session sends only goal and remembered/changed settings',async()=>{
  const h=await composerHarness('new');type(h,'Build a local tool');await h.composer.submit();assert.deepEqual(posts(h),[{url:'/api/runs',body:{goal:'Build a local tool'}}]);assert.equal(h.document.querySelector('#composer').value,'');assert.equal(h.document.querySelector('#composer-status').textContent,'Sent · it will appear in the room');assert.equal(h.timeline.querySelectorAll('[data-message]').length,0);
  const configured=await composerHarness('new',{local:{'acx-settings':JSON.stringify({verifier:'python3 -m unittest',max_steps:5,mode:'single'}),'goal':'Never prefill me'}});
  assert.equal(configured.document.querySelector('#composer').value,'');await configured.composer.openSettings();setting(configured,'title','A tool');setting(configured,'run_minutes',15);type(configured,'Goal');await configured.composer.submit();
  assert.deepEqual(posts(configured).at(-1),{url:'/api/runs',body:{goal:'Goal',verifier:'python3 -m unittest',max_steps:5,mode:'single',title:'A tool',run_minutes:15}});assert(!Object.hasOwn(JSON.parse(configured.local.get('acx-settings')),'title'));
});
test('M4 all finished outcomes offer follow-up and inherit exact parent fields',async()=>{
  for(const status of ['completed','blocked','failed','stopped','limit_reached']){const f=fx.composerFixture('finished');f.thread.messages.find(m=>m.kind==='outcome').detail.status=status;f.thread.sessions[0].status=status;const finished=await harness(f.state,{thread:f.thread,channels:f.channels});assert.equal(finished.timeline.querySelectorAll('[data-reply]').length,1,status+' must offer Reply');}
  const h=await composerHarness('finished');const links=h.timeline.querySelectorAll('[data-reply]');assert.equal(links.length,1);
  links[0].click();await tick();assert.match(h.document.querySelector('#composer-target').textContent,/Follow-up · Finished parent/);assert.match(h.document.querySelector('#composer').placeholder,/Reply in Finished parent/);
  await h.composer.openSettings();assert.equal(h.document.querySelector('#setting-max_steps').value,'6');assert.equal(h.document.querySelector('#setting-verifier').value,'python3 -m unittest discover -s demo_app');
  type(h,'Add search');await h.composer.submit();assert.deepEqual(posts(h).at(-1),{url:'/api/runs',body:{goal:'Add search',parent_run:'run_test',verifier:'python3 -m unittest discover -s demo_app',max_steps:6,mode:'single'}});assert(!h.timeline.textContent.includes('Add search'));
  await h.composer.reply('run_test');type(h,'Keep my text');key(h,'Escape');assert.equal(h.document.querySelector('#composer-target').textContent,'New session');assert.equal(h.document.querySelector('#composer').value,'Keep my text');
  const active=await composerHarness('paused');await active.composer.reply('run_test');assert.equal(active.document.querySelector('#composer-target').textContent,'Note → Hermes');assert.equal(posts(active).length,0);
});
test('M4 Hermes and leading @agent routing use exact bodies and preserve later tokens',async()=>{
  const h=await composerHarness('paused');type(h,'Read the README');await h.composer.submit();assert.deepEqual(posts(h).at(-1),{url:'/api/control',body:{run:'run_test',action:'instruction',text:'Read the README'}});
  type(h,'@coder-1 @coder-2 Check the CLI');assert.equal(h.document.querySelector('#composer-target').textContent,'Note → @coder-1');await h.composer.submit();assert.deepEqual(posts(h).at(-1),{url:'/api/control',body:{run:'run_test',action:'instruction',agent:'coder-1',text:'@coder-2 Check the CLI'}});
  type(h,'@unknown Check this');assert.equal(h.document.querySelector('#composer-target').textContent,'Note → Hermes');await h.composer.submit();assert.deepEqual(posts(h).at(-1).body,{run:'run_test',action:'instruction',text:'@unknown Check this'});
});
test('M4 mentions use active-session agents even when the focused session is older',async()=>{
  const f=fx.composerFixture('paused'),h=await harness(f.state,{thread:f.thread,channels:f.channels});
  const old={...f.state.run,id:'old',status:'completed'};f.state.run=old;f.state.agents=[{name:'old-agent',type:'coder'}];
  h.options.respond=url=>{if(url==='/api/state?scope=current&run=run_test')return {...f.state,run:{...old,id:'run_test',status:'paused'},agents:[{name:'coder-2',type:'coder'}]};};
  await h.core.refresh();await tick();type(h,'@coder-2 Check');await h.composer.submit();assert.equal(posts(h).at(-1).body.agent,'coder-2');assert(!posts(h).at(-1).body.text.includes('@'));
});
test('M4 server-only appearance, one refresh, stable status and follow to bottom',async()=>{
  let release;const h=await composerHarness('paused',{post:()=>({ok:true})}),before=h.timeline.innerHTML,node=h.document.querySelector('#composer-status');
  const data=clone(h.publicThread);data.messages.push(fx.threadMessage('server:note','note','A server recorded note',{to:'coder-2'},{actor:'you'}));
  h.options.respond=async url=>{if(url.startsWith('/api/thread')){await new Promise(resolve=>{release=resolve;});return data;}};
  const geo=geometry(h);geo.setScroll(100);const n=h.calls.length;type(h,'A server recorded note');await h.composer.submit();
  assert.equal(h.timeline.innerHTML,before);assert.equal(h.document.querySelector('#composer').value,'');assert.equal(h.document.querySelector('#composer-status'),node);assert.equal(node.textContent,'Sent · it will appear in the room');
  assert.equal(h.calls.slice(n).filter(c=>c.request.method==='GET').length,3);assert.equal(geo? h.timeline.scrollTop:0,1000);release();await tick();await tick();assert(h.timeline.querySelector('[data-message="server:note"]'));assert.equal(h.timeline.querySelectorAll('[data-message="server:note"]').length,1);assert(h.timeline.textContent.includes('Hermes reads this before the next turn'));await h.runTimers(3000);assert(node.hidden);assert.equal(h.document.querySelector('#composer-status'),node);
});
test('M4 server and network errors preserve the draft, and POST 401 signs out',async()=>{
  for(const result of [{error:'Supply a valid goal check'},{throws:'Network lost'}]){
    const h=await composerHarness('paused',{post:()=>result});type(h,'Retain this text');const before=h.timeline.innerHTML;await h.composer.submit();assert.equal(h.document.querySelector('#composer').value,'Retain this text');assert.equal(h.timeline.innerHTML,before);assert.equal(h.document.querySelector('#composer-status').textContent,result.error || result.throws);
  }
  const h=await composerHarness('paused',{post:()=>({error:'Key expired',status:401})});type(h,'Private draft');await h.composer.submit();assert(!h.core.getState().authenticated);assert.equal(h.local.has('ac-dashboard-key'),false);assert.equal(h.document.querySelector('#sign-in-error').textContent,'Key expired');
});
test('M4 single-flight submission locks Send through preparation and POST',async()=>{
  let release;const h=await composerHarness('paused',{post:()=>new Promise(resolve=>{release=()=>resolve({ok:true});})});type(h,'Send exactly once');const pending=h.composer.submit();h.composer.submit();key(h,'Enter');h.document.querySelector('#send-message').click();assert.equal(posts(h).length,1);assert(h.document.querySelector('#send-message').disabled);assert.equal(h.document.querySelector('#composer-status').textContent,'Sending…');release();await pending;
  let ready;const idle=await composerHarness('new');idle.options.preflight={...fx.composerPreflight};idle.options.respond=undefined;
  idle.options.post=()=>new Promise(resolve=>{ready=()=>resolve({id:'new'});});type(idle,'One new session');const starting=idle.composer.submit();idle.composer.submit();await tick();assert.equal(posts(idle).length,1);ready();await starting;
});
test('M4 pause, resume and chip are exact aliases; menu errors stay inline',async()=>{
  const h=await composerHarness('paused');type(h,'/pause');await h.composer.submit();type(h,'/resume');await h.composer.submit();h.document.querySelector('#resume-session').click();await tick();assert.deepEqual(posts(h).map(c=>c.body),[{run:'run_test',action:'pause'},{run:'run_test',action:'resume'},{run:'run_test',action:'resume'}]);
  h.document.querySelector('[data-session-control="resume"]').click();await tick();assert.equal(posts(h).at(-1).body.action,'resume');h.options.post=()=>({error:'Cannot resume this session'});h.document.querySelector('[data-session-control="resume"]').click();await tick();assert.equal(h.document.querySelector('#control-error').textContent,'Cannot resume this session');
});
test('M4 Stop always confirms, starts focus on Cancel, and Cancel/Escape send nothing',async()=>{
  const h=await composerHarness('paused');type(h,'/stop');await h.composer.submit();const dialog=h.document.querySelector('#stop-dialog');assert(dialog.hasAttribute('open'));assert.equal(h.document.activeElement.id,'cancel-stop');assert(dialog.textContent.includes('cannot be resumed'));assert.equal(posts(h).length,0);
  h.document.querySelector('#cancel-stop').click();assert(!dialog.hasAttribute('open'));assert.equal(posts(h).length,0);assert.equal(h.document.querySelector('#composer').value,'/stop');
  h.document.querySelector('[data-session-control="stop"]').click();assert(dialog.hasAttribute('open'));key(h,'Escape',{},h.document.querySelector('#cancel-stop'));assert(!dialog.hasAttribute('open'));assert.equal(posts(h).length,0);
  await h.composer.submit();h.document.querySelector('#confirm-stop').click();await tick();assert.deepEqual(posts(h),[{url:'/api/control',body:{run:'run_test',action:'stop'}}]);assert(!dialog.hasAttribute('open'));assert.equal(h.document.querySelector('#composer').value,'');assert.equal(h.document.activeElement.id,'composer');
});
test('M4 /check and /title route active and finished-focused sessions exactly',async()=>{
  const h=await composerHarness('paused');for(const text of ['/check Save and reload','/title Storage session']){type(h,text);await h.composer.submit();}assert.deepEqual(posts(h).map(c=>c.body),[{run:'run_test',action:'goal_check',text:'Save and reload'},{run:'run_test',action:'title',text:'Storage session'}]);
  const done=await composerHarness('finished');done.core.focus('run_test');await done.runTimers(0);type(done,'/title New name');await done.composer.submit();assert.deepEqual(posts(done).at(-1).body,{run:'run_test',action:'title',text:'New name'});
  type(done,'/check Not active');const n=posts(done).length;await done.composer.submit();assert.equal(posts(done).length,n);assert.match(done.document.querySelector('#composer-status').textContent,/no active session/);
});
test('M4 slash suggestions/help are local; M5 aliases need an actionable item',async()=>{
  const h=await composerHarness('paused');type(h,'/');assert(!h.document.querySelector('#composer-options').hidden);assert.deepEqual([...h.document.querySelectorAll('#composer-options button')].map(n=>n.textContent),['/pause','/resume','/stop','/check','/title','/help','/verify','/apply','/discard','/team']);
  type(h,'/help');await h.composer.submit();assert.equal(posts(h).length,0);assert(!h.document.querySelector('#composer-options').hidden);
  for(const text of ['/mystery','/verify','/apply','/discard','/team approve','/check','/pause extra']){type(h,text);await h.composer.submit();assert.equal(posts(h).length,0);assert.equal(h.document.querySelector('#composer').value,text);assert(h.document.querySelector('#composer-status').textContent);}
});
test('M4 mention list supports arrows, Enter and Escape with active-descendant',async()=>{
  const h=await composerHarness('paused');type(h,'@');const list=h.document.querySelector('#composer-options');assert(!list.hidden);assert(!list.textContent.includes('hermes'));assert.equal(h.document.querySelector('#composer').getAttribute('aria-activedescendant'),'composer-option-0');key(h,'ArrowDown');assert.equal(h.document.querySelector('#composer').getAttribute('aria-activedescendant'),'composer-option-1');key(h,'Enter');assert.equal(h.document.querySelector('#composer').value,'@coder-2 ');assert(list.hidden);assert.equal(h.document.querySelector('#composer-target').textContent,'Note → @coder-2');assert.equal(posts(h).length,0);
  type(h,'@');key(h,'Escape');assert(list.hidden);assert.equal(h.document.querySelector('#composer').getAttribute('aria-activedescendant'),null);
});
test('M4 key rules distinguish fine/touch pointers, modifiers and composition',async()=>{
  for(const coarse of [false,true]){
    const h=await composerHarness('paused',{coarse});type(h,'A draft');assert.equal(key(h,'Enter',{shiftKey:true}).defaultPrevented,false);assert.equal(key(h,'Enter',{isComposing:true}).defaultPrevented,false);assert.equal(posts(h).length,0);
    const enter=key(h,'Enter');await tick();assert.equal(enter.defaultPrevented,!coarse);assert.equal(posts(h).length,coarse?0:1);
    for(const modifier of ['ctrlKey','metaKey']){type(h,'A modifier draft');key(h,'Enter',{[modifier]:true});await tick();}assert.equal(posts(h).length,coarse?2:3);
  }
});
test('M4 Basic/Advanced Settings and unavailability reasons disclose progressively',async()=>{
  const h=await composerHarness('new');await h.composer.openSettings();assert(!h.document.querySelector('#settings-sheet').hidden);assert(h.document.querySelector('#settings-basic'));assert(!h.document.querySelector('#settings-advanced').open);
  assert(h.document.querySelector('input[value="container"]').disabled);assert(h.document.querySelector('input[value="vm"]').disabled);assert(h.document.querySelector('#isolation-options').textContent.includes('No container runtime installed'));assert(h.document.querySelector('#isolation-options').textContent.includes('KVM unavailable on this server'));assert.equal(h.document.querySelectorAll('#isolation-options details').length,2);assert(!h.document.querySelector('option[value="internet"]'));assert(h.document.querySelector('#settings-sheet').textContent.includes('Paid models and the stuck watch: set them in the classic dashboard'));
  assert(h.document.querySelector('#isolated-fields').hidden);setting(h,'mode','team','change');assert(!h.document.querySelector('#team-size-field').hidden);assert.equal(h.document.querySelector('#setting-team_size').value,'3');
  h.document.querySelector('#add-goal-check').click();const check=h.document.querySelector('[data-check="0"]');check.value='Reload saved data';check.dispatchEvent(new h.window.Event('input',{bubbles:true}));h.document.querySelector('[data-remove-check="0"]').click();assert.equal(h.document.querySelectorAll('[data-check]').length,0);
  key(h,'Escape',{},h.document.querySelector('#close-settings'));assert(h.document.querySelector('#settings-sheet').hidden);assert.equal(h.document.activeElement.id,'composer');
});
test('M4 preflight blocks dirty start until explicit acknowledgement',async()=>{
  const h=await composerHarness('new',{preflight:{...fx.composerPreflight,dirty_count:3}});type(h,'A dirty-folder goal');await h.composer.submit();assert.equal(posts(h).length,0);assert.equal(h.document.querySelector('#composer').value,'A dirty-folder goal');assert(!h.document.querySelector('#settings-sheet').hidden);assert(h.document.querySelector('#settings-advanced').open);assert(h.document.querySelector('#dirty-folder').textContent.includes('3'));assert(!h.document.querySelector('#allow-dirty').checked);
  h.document.querySelector('#allow-dirty').checked=true;await h.composer.submit();assert.deepEqual(posts(h).at(-1).body,{goal:'A dirty-folder goal',allow_dirty:true});assert(!h.document.querySelector('#allow-dirty').checked);assert(!JSON.parse(h.local.get('acx-settings')).allow_dirty);
});
test('M4 Auto previews before sending and preview shapes match classic',async()=>{
  const h=await composerHarness('new');await h.composer.openSettings();type(h,'A small goal');setting(h,'mode','auto','change');await tick();assert(h.document.querySelector('#mode-preview').textContent.includes('Auto would use one agent. Small goal'));
  assert.deepEqual(posts(h).at(-1),{url:'/api/mode/preview',body:{goal:'A small goal',goal_checks:[],verifier:'',max_steps:8}});await h.composer.submit();assert.equal(posts(h).at(-1).url,'/api/runs');assert.equal(posts(h).at(-1).body.mode,'auto');
  for(const [mode,values,expected] of [['web',{command:'python3 -m http.server',port:'8080'},{mode:'web',command:'python3 -m http.server',port:8080}],['static',{path:'site/index.html'},{mode:'static',path:'site/index.html'}],['cli',{command:'python3 app.py',args:'--help'},{mode:'cli',command:'python3 app.py',args:'--help'}],['desktop',{command:'xterm',width:'1200',height:'700'},{mode:'desktop',command:'xterm',width:1200,height:700}]]){
    const p=await composerHarness('new');await p.composer.openSettings();const select=p.document.querySelector('#preview-mode');select.value=mode;select.dispatchEvent(new p.window.Event('change',{bubbles:true}));for(const [name,value] of Object.entries(values)){const node=p.document.querySelector('#preview-'+name);node.value=value;node.dispatchEvent(new p.window.Event('input',{bubbles:true}));}type(p,'Preview goal');await p.composer.submit();assert.deepEqual(posts(p).at(-1).body.preview,expected);
  }
});
test('M4 connections retry is an existing POST and forbidden fields never leave chat',async()=>{
  const f=fx.composerFixture('new');f.state.health.ready=false;const h=await harness(f.state,{thread:f.thread,channels:f.channels});type(h,'Blocked goal');assert(h.document.querySelector('#send-message').disabled);assert.equal(h.document.querySelector('#composer-blocked').textContent,'Connections are not ready');h.document.querySelector('#check-connections').click();await tick();assert.deepEqual(posts(h),[{url:'/api/check',body:{}}]);
  const p=await composerHarness('new',{local:{'acx-settings':JSON.stringify({mode:'single',models:{coder:'paid'},spend_cap:8,confirm:'approve',watch:true,network:'internet'})},session:{'acx-draft':'Restore only the unsent draft'}});assert.equal(p.document.querySelector('#composer').value,'Restore only the unsent draft');await p.composer.submit();const body=posts(p).at(-1).body;for(const field of ['models','spend_cap','confirm','watch'])assert(!Object.hasOwn(body,field));assert.notEqual(body.network,'internet');assert.equal(p.session.has('acx-draft'),false);assert(!p.local.has('acx-draft'));
});

test('M4 available isolation and all changed Basic/Advanced values send their exact shapes',async()=>{
  const f=fx.composerFixture('new');f.state.sandbox={unavailable:'',models_configured:true};f.state.vm_env={unavailable:'',models_configured:true};
  const h=await harness(f.state,{thread:f.thread,channels:f.channels});await h.composer.openSettings();
  const container=h.document.querySelector('input[value="container"]');assert(!container.disabled);container.checked=true;container.dispatchEvent(new h.window.Event('change',{bubbles:true}));assert(!h.document.querySelector('#isolated-fields').hidden);
  setting(h,'network','none','change');setting(h,'cpus',2);setting(h,'memory_gb',4);setting(h,'setup','npm ci');setting(h,'mode','team','change');setting(h,'team_size',2);setting(h,'max_steps',4);setting(h,'run_minutes',20);
  h.document.querySelector('#add-goal-check').click();const check=h.document.querySelector('[data-check="0"]');check.value='Persist changes';check.dispatchEvent(new h.window.Event('input',{bubbles:true}));type(h,'A team goal');await h.composer.submit();
  assert.deepEqual(posts(h).at(-1).body,{goal:'A team goal',isolation:'container',network:'none',cpus:2,memory_gb:4,setup:'npm ci',mode:'team',team_size:2,max_steps:4,run_minutes:20,goal_checks:['Persist changes']});
});
test('M4 unknown leading token Enter sends ordinary text, and goal check rows stay bounded',async()=>{
  const h=await composerHarness('paused');type(h,'@missing');assert(h.document.querySelector('#composer-options').hidden);key(h,'Enter');await tick();assert.deepEqual(posts(h).at(-1).body,{run:'run_test',action:'instruction',text:'@missing'});
  const idle=await composerHarness('new');await idle.composer.openSettings();for(let i=0;i<21;i++)idle.document.querySelector('#add-goal-check').click();assert.equal(idle.document.querySelectorAll('[data-check]').length,20);assert(idle.document.querySelector('#add-goal-check').disabled);
});

test('M4 remembered Auto makes its explanation visible before a session can start',async()=>{
  const h=await composerHarness('new',{local:{'acx-settings':JSON.stringify({mode:'auto'})}});type(h,'An Auto goal');await h.composer.submit();assert(!h.document.querySelector('#settings-sheet').hidden);assert(h.document.querySelector('#mode-preview').textContent.includes('Auto would'));assert(!posts(h).some(c=>c.url==='/api/runs'));
  h.document.querySelector('#close-settings').click();await h.composer.submit();assert.equal(posts(h).at(-1).url,'/api/runs');assert.equal(posts(h).at(-1).body.mode,'auto');
});

test('M4 active pause flags come from the active server details while an older session is focused',async()=>{
  const f=fx.composerFixture('active');f.thread.live.status='coding';f.thread.sessions[0].status='coding';f.state.runs[0].status='coding';delete f.state.runs[0].pause;
  f.state.run={id:'old',status:'completed',title:'Older session'};f.state.agents=[];
  const h=await harness(f.state,{thread:f.thread,channels:f.channels,respond:url=>url==='/api/state?scope=current&run=run_test'?{...f.state,run:{id:'run_test',status:'coding',pause:true},agents:[{name:'coder-2',type:'coder'}]}:undefined});
  await tick();assert(!h.document.querySelector('#resume-session').hidden);assert.equal(h.document.querySelector('[data-session-control="resume"]').textContent,'Resume');
  h.document.querySelector('#resume-session').click();await tick();assert.deepEqual(posts(h).at(-1).body,{run:'run_test',action:'resume'});
});
test('M4 edits made during submission remain an unsent draft',async()=>{
  let release;const h=await composerHarness('paused',{post:()=>new Promise(resolve=>{release=()=>resolve({ok:true});})});type(h,'The submitted note');const request=h.composer.submit();type(h,'My next note');release();await request;assert.equal(h.document.querySelector('#composer').value,'My next note');assert.equal(h.session.get('acx-draft'),'My next note');assert.equal(posts(h)[0].body.text,'The submitted note');
});

test('M4 an in-flight Auto preview also prevents a concurrent session POST',async()=>{
  let release;const h=await composerHarness('new',{post:(url)=>url==='/api/mode/preview'?new Promise(resolve=>{release=()=>resolve({mode:'single',reasons:['Small goal']});}):({id:'new'})});await h.composer.openSettings();type(h,'Previewed goal');setting(h,'mode','auto','change');assert(h.document.querySelector('#send-message').disabled);await h.composer.submit();assert.equal(posts(h).filter(c=>c.url==='/api/runs').length,0);release();await tick();h.document.querySelector('#close-settings').click();const sending=h.composer.submit();await tick();
  // Sending re-reads the same preview first, so session creation still waits for it.
  assert.equal(posts(h).filter(c=>c.url==='/api/runs').length,0);release();await sending;assert.equal(posts(h).filter(c=>c.url==='/api/runs').length,1);
});


function addCheck(h,text){h.document.querySelector('#add-goal-check').click();const node=h.document.querySelector('[data-check="0"]');node.value=text;node.dispatchEvent(new h.window.Event('input',{bubbles:true}));}
const rememberedKeys=['verifier','max_steps','run_minutes','mode','team_size','isolation','network','cpus','memory_gb','setup','preview'];
function savedSettings(h){return JSON.parse(h.local.get('acx-settings'));}
test('M4.1 session titles and checks clear after success in the same page and after reload',async()=>{
  const h=await composerHarness('new');await h.composer.openSettings();setting(h,'title','Todo CLI v1');addCheck(h,'Persist tasks to JSON');setting(h,'verifier','V1');type(h,'Build the CLI');await h.composer.submit();
  assert.deepEqual(posts(h).at(-1).body,{goal:'Build the CLI',title:'Todo CLI v1',goal_checks:['Persist tasks to JSON'],verifier:'V1'});
  assert.deepEqual(savedSettings(h),{verifier:'V1'});await h.composer.openSettings();assert.equal(h.document.querySelector('#setting-title').value,'');assert.equal(h.document.querySelectorAll('[data-check]').length,0);
  type(h,'Add a web UI');await h.composer.submit();assert.deepEqual(posts(h).at(-1).body,{goal:'Add a web UI',verifier:'V1'});
  const reloaded=await composerHarness('new',{local:{'acx-settings':h.local.get('acx-settings')}});type(reloaded,'Add search');await reloaded.composer.submit();assert.deepEqual(posts(reloaded).at(-1).body,{goal:'Add search',verifier:'V1'});
});
test('M4.1 legacy settings are cleaned on load to exactly the permitted preference keys',async()=>{
  const allowed={verifier:'V1',max_steps:4,run_minutes:20,mode:'team',team_size:2,isolation:'container',network:'none',cpus:2,memory_gb:4,setup:'npm ci',preview:{mode:'static',path:'site'}};
  const legacy={...allowed,title:'Old title',goal_checks:['Old criterion'],allow_dirty:true,goal:'Old goal',models:{},spend_cap:7,confirm:'approve',watch:true};
  const h=await composerHarness('new',{local:{'acx-settings':JSON.stringify(legacy)}});assert.deepEqual(savedSettings(h),allowed);assert.deepEqual(Object.keys(savedSettings(h)).sort(),rememberedKeys.slice().sort());
  await h.composer.openSettings();assert.equal(h.document.querySelector('#setting-title').value,'');assert.equal(h.document.querySelectorAll('[data-check]').length,0);assert(!h.document.querySelector('#allow-dirty').checked);type(h,'Fresh goal');await h.composer.submit();assert.deepEqual(posts(h).at(-1).body,{goal:'Fresh goal',...allowed});
  const internet=await composerHarness('new',{local:{'acx-settings':JSON.stringify({network:'internet',title:'Leaked'})}});assert.deepEqual(savedSettings(internet),{});
});
test('M4.1 failed session creation retains its draft, title and checks until successful retry',async()=>{
  const h=await composerHarness('new',{post:()=>({error:'Server refused the settings'})});await h.composer.openSettings();setting(h,'title','This session');addCheck(h,'This criterion');type(h,'Retain my goal');await h.composer.submit();
  assert.equal(h.document.querySelector('#composer').value,'Retain my goal');await h.composer.openSettings();assert.equal(h.document.querySelector('#setting-title').value,'This session');assert.equal(h.document.querySelector('[data-check]').value,'This criterion');
  h.options.post=()=>({ok:true});await h.composer.submit();assert.deepEqual(posts(h).at(-1).body,{goal:'Retain my goal',title:'This session',goal_checks:['This criterion']});assert.deepEqual(savedSettings(h),{});await h.composer.openSettings();assert.equal(h.document.querySelector('#setting-title').value,'');assert.equal(h.document.querySelectorAll('[data-check]').length,0);
});
test('M4.1 cancelling a follow-up restores preferences and clears per-session fields for both exits',async()=>{
  for(const exit of ['button','Escape']){
    const before={verifier:'V1',max_steps:4,mode:'team',team_size:2,run_minutes:15,preview:{mode:'static',path:'old-site'}};
    const h=await composerHarness('finished',{local:{'acx-settings':JSON.stringify(before)},preflight:{...fx.composerPreflight,dirty_count:2}});
    await h.composer.reply('run_test');await h.composer.openSettings();assert.equal(h.document.querySelector('#setting-verifier').value,'python3 -m unittest discover -s demo_app');setting(h,'verifier','V3');setting(h,'max_steps',9);setting(h,'title','Follow-up title');addCheck(h,'Follow-up criterion');h.document.querySelector('#allow-dirty').checked=true;type(h,'Unsent follow-up draft');h.composer.closeSettings();
    if(exit==='button')h.document.querySelector('#cancel-follow-up').click();else key(h,'Escape');
    assert.equal(h.document.querySelector('#composer-target').textContent,'New session');assert.equal(h.document.querySelector('#composer').value,'Unsent follow-up draft');assert.deepEqual(savedSettings(h),before);await h.composer.openSettings();assert.equal(h.document.querySelector('#setting-verifier').value,'V1');assert.equal(h.document.querySelector('#setting-max_steps').value,'4');assert.equal(h.document.querySelector('#setting-title').value,'');assert.equal(h.document.querySelectorAll('[data-check]').length,0);assert(!h.document.querySelector('#allow-dirty').checked);
    h.options.preflight=fx.composerPreflight;type(h,'A separate new session');await h.composer.submit();assert.deepEqual(posts(h).at(-1).body,{goal:'A separate new session',...before});
  }
});
test('M4.1 a successful unedited follow-up sends parent defaults without remembering them',async()=>{
  const before={verifier:'V1',max_steps:4,mode:'single',run_minutes:15};const h=await composerHarness('finished',{local:{'acx-settings':JSON.stringify(before)}});
  await h.composer.reply('run_test');type(h,'Continue the parent');await h.composer.submit();assert.deepEqual(posts(h).at(-1).body,{goal:'Continue the parent',...before,verifier:'python3 -m unittest discover -s demo_app',max_steps:6,parent_run:'run_test'});assert.deepEqual(savedSettings(h),before);
  type(h,'Independent goal');await h.composer.submit();assert.deepEqual(posts(h).at(-1).body,{goal:'Independent goal',...before});
});
test('M4.1 successful follow-ups remember only explicit Settings changes and clear per-session fields',async()=>{
  const before={verifier:'V1',max_steps:4,mode:'team',team_size:2,run_minutes:15,preview:{mode:'static',path:'old-site'}};
  const h=await composerHarness('finished',{local:{'acx-settings':JSON.stringify(before)}});await h.composer.reply('run_test');await h.composer.openSettings();setting(h,'verifier','V3');setting(h,'run_minutes',25);setting(h,'title','New follow-up');addCheck(h,'Only this follow-up');const preview=h.document.querySelector('#preview-mode');preview.value='none';preview.dispatchEvent(new h.window.Event('change',{bubbles:true}));type(h,'Continue with edits');await h.composer.submit();
  assert.deepEqual(posts(h).at(-1).body,{goal:'Continue with edits',verifier:'V3',max_steps:6,mode:'single',run_minutes:25,title:'New follow-up',goal_checks:['Only this follow-up'],parent_run:'run_test'});
  const expected={verifier:'V3',max_steps:4,mode:'team',team_size:2,run_minutes:25};assert.deepEqual(savedSettings(h),expected);type(h,'A new team goal');await h.composer.submit();assert.deepEqual(posts(h).at(-1).body,{goal:'A new team goal',...expected});
  const reloaded=await composerHarness('new',{local:{'acx-settings':h.local.get('acx-settings')}});type(reloaded,'Reloaded goal');await reloaded.composer.submit();assert.deepEqual(posts(reloaded).at(-1).body,{goal:'Reloaded goal',...expected});
});
test('M4.1 entering any follow-up begins with empty title, checks and dirty acknowledgement',async()=>{
  const h=await composerHarness('finished');await h.composer.openSettings();setting(h,'title','Unsubmitted title');addCheck(h,'Unsubmitted check');h.document.querySelector('#allow-dirty').checked=true;
  await h.composer.reply('run_test');await h.composer.openSettings();assert.equal(h.document.querySelector('#setting-title').value,'');assert.equal(h.document.querySelectorAll('[data-check]').length,0);assert(!h.document.querySelector('#allow-dirty').checked);
});
test('M4.1 literal @ content stays verbatim in the POST and follows the Hermes chip rule',async()=>{
  const h=await composerHarness('paused');const notes=['Pin @types/node to v20','Use the @pytest.fixture decorator','Ask @coder-2 to sync with @coder-1 on the schema','@nobody hello','@types/node is a package','@pytest.fixture is a decorator','@coder-2/path stays literal','@coder-2.fixture stays literal','@hermes hello',' @coder-2 keep it literal  ','Keep  @coder-2\n@types/node  intact  '];
  for(const text of notes){type(h,text);assert.equal(h.document.querySelector('#composer-target').textContent,'Note → Hermes');assert.equal(h.document.querySelector('#composer').placeholder,'Message Hermes…');await h.composer.submit();assert.deepEqual(posts(h).at(-1).body,{run:'run_test',action:'instruction',text});}
  for(const [text,sent] of [['@coder-2 keep it simple','keep it simple'],['@coder-2  keep @coder-1 and @types/node  ',' keep @coder-1 and @types/node  '],['@coder-2\tUse @pytest.fixture','Use @pytest.fixture'],['@coder-2\nKeep @nobody literal','Keep @nobody literal']]){type(h,text);assert.equal(h.document.querySelector('#composer-target').textContent,'Note → @coder-2');await h.composer.submit();assert.deepEqual(posts(h).at(-1).body,{run:'run_test',action:'instruction',text:sent,agent:'coder-2'});}
});
test('M4.1 suggestions open only for a draft-leading token and selection replaces that token',async()=>{
  const h=await composerHarness('paused');for(const text of ['Ask @',' @','@types/','@pytest.','Hello\n@']){type(h,text);assert(h.document.querySelector('#composer-options').hidden,text);assert.equal(h.document.querySelector('#composer').getAttribute('aria-expanded'),'false');}
  type(h,'@cod');assert(!h.document.querySelector('#composer-options').hidden);key(h,'ArrowDown');key(h,'Enter');assert.equal(h.document.querySelector('#composer').value,'@coder-2 ');assert.equal(h.document.querySelector('#composer-target').textContent,'Note → @coder-2');assert.equal(posts(h).length,0);
  type(h,'@coder-2 Coordinate with @');assert(h.document.querySelector('#composer-options').hidden);assert.equal(h.document.querySelector('#composer-target').textContent,'Note → @coder-2');
});
test('M4.1 the empty room invites the composer with no classic start link or fake messages',async()=>{
  const h=await composerHarness('new');const empty=h.timeline.querySelector('.empty');assert.equal(empty.querySelector('h2').textContent,'A room for your project');assert.equal(empty.querySelector('p').textContent,'Write a goal below to start the first session.');assert.equal(empty.querySelectorAll('a').length,0);assert.equal(h.timeline.querySelectorAll('[data-message]').length,0);
});

const decisionHelpers=require(path.join(root,'decisions.js'));
async function decisionHarness(name='all',options={}) {const f=fx.decisionFixture(name),h=await harness(f.state,{thread:f.thread,channels:f.channels,...options});return {...h,f};}
const decisionCard=(h,id)=>h.timeline.querySelector('[data-message="'+id+'"]');
const button=(h,choice,id)=> (id ? decisionCard(h,id) : h.timeline).querySelector('[data-decision="'+choice+'"]');
async function clickDecision(h,choice,id) {const node=button(h,choice,id);assert(node,choice);node.click();await tick();}
async function confirmDecision(h,values={}) {
  const dialog=h.document.querySelector('#decision-dialog');assert(dialog.hasAttribute('open'));
  for(const [name,value] of Object.entries(values)){const input=dialog.querySelector('[name="'+name+'"]');assert(input,name);if(input.type==='checkbox')input.checked=value;else input.value=value;}
  dialog.querySelector('form').dispatchEvent(new h.window.Event('submit',{bubbles:true,cancelable:true}));await tick();await tick();
}
function recordedDecision(f,message,choice) {
  message.rev++;
  if(message.kind==='request') {message.action=null;message.detail.receipt={action:choice,state:'confirmed',actor:'You, via dashboard'};delete message.detail.review;}
  if(message.kind==='proposal')message.action=null;
  if(message.kind==='research') {message.action=null;message.detail.status=choice==='approve'?'running':'skipped';}
  if(message.kind==='skill') {
    message.detail.state=choice==='fetch'?'proposed':choice==='approve'?'installed':'rejected';
    message.action=choice==='fetch' ? {endpoint:'/api/skills/decide',fields:{id:'fetch'},choices:['approve','reject']} : null;
    if(choice==='fetch')message.detail.review={description:'Testing',files:['SKILL.md'],size:12,skill_md:'# Tests'};
  }
  if(message.kind==='outcome') {message.detail.workspace.state=choice==='apply'?'applied':choice==='discard_workspace'?'discarded':'open';message.action=choice==='verify'?{...message.action,choices:['apply','discard_workspace']}:{...message.action,choices:['verify']};}
  if(choice==='verify')f.thread.messages.push(fx.threadMessage('m5:verified','system','verification (on demand) · passed',{}, {session:message.session}));
  f.channels.channels[0].waiting=f.thread.messages.filter(m=>m.action && m.kind!=='outcome').length;
}
test('M5 pure catalogue allows only server actions, choices and known endpoints',()=>{
  const catalogue=fx.decisionMessages();
  for(const message of Object.values(catalogue)) {
    const before=JSON.stringify(message), controls=decisionHelpers.controlsFor(message,{confirm_word:'server-word'});assert(controls.length,message.id);
    assert.deepEqual(decisionHelpers.controlsFor({...message,action:null}),[]);
    assert.deepEqual(decisionHelpers.controlsFor({...message,action:{...message.action,endpoint:'/api/arbitrary'}}),[]);
    assert.equal(decisionHelpers.allowedEndpoint({...message,action:null}),null);assert.equal(JSON.stringify(message),before);
  }
  const proposal=catalogue.proposal;assert.deepEqual(decisionHelpers.controlsFor({...proposal,action:{...proposal.action,choices:['single_agent']}}).map(c=>c.choice),['single_agent']);
  for(const state of ['dispatching','sent','uncertain'])assert.deepEqual(decisionHelpers.controlsFor({...catalogue.low,detail:{...catalogue.low.detail,receipt:{state}}}),[]);
  assert(decisionHelpers.controlsFor(catalogue.critical,{}).find(c=>c.choice==='approve').disabled);
});
test('M5 answer hints mirror single, multiple, custom, duplicate and size rules',()=>{
  const q=fx.decisionMessages().question.detail.questions, multi=fx.decisionMessages().multiple.detail.questions;
  assert.deepEqual(decisionHelpers.answersFrom(q,[['custom answer']]),[['custom answer']]);assert.deepEqual(decisionHelpers.answersFrom(multi,[['JSON','SQLite']]),[['JSON','SQLite']]);
  for(const [questions,answers,error] of [[q,[],/every question/],[q,[[]],/nonempty/],[q,[['   ']],/nonempty/],[q,[['x'.repeat(5001)]],/5,000/],[q,[['JSON','JSON']],/Duplicate/],[q,[['JSON','SQLite']],/one answer/],[multi,[['custom']],/supplied/]])assert.throws(()=>decisionHelpers.answersFrom(questions,answers),error);
  assert.deepEqual(decisionHelpers.answersFrom(q,[['x'.repeat(5000)]]),[['x'.repeat(5000)]]);
});
test('M5 only awaiting-fetch skill Reject can use the authorized endpoint exception',()=>{
  const skill=fx.decisionMessages().skillFetch;
  assert.equal(decisionHelpers.allowedEndpoint(skill,'reject'),'/api/skills/decide');
  assert.equal(decisionHelpers.allowedEndpoint(skill),'/api/skills/fetch');
  assert.equal(decisionHelpers.allowedEndpoint(skill,'fetch'),'/api/skills/fetch');
  assert.deepEqual(decisionHelpers.controlsFor(skill).map(c=>c.choice),['fetch','reject']);
  for(const message of [
    {...skill,kind:'request'},
    {...skill,detail:{...skill.detail,state:'proposed'}},
    {...skill,detail:{...skill.detail,state:'rejected'}},
    {...skill,action:{...skill.action,choices:['fetch']}}
  ])assert.equal(decisionHelpers.allowedEndpoint(message,'reject'),'/api/skills/fetch');
  for(const message of [{...skill,action:null},{...skill,action:{...skill.action,endpoint:'/api/arbitrary'}}]) {
    assert.equal(decisionHelpers.allowedEndpoint(message,'reject'),null);
    assert.throws(()=>decisionHelpers.skillBody(message,'reject'),/classic/);
  }
  assert.deepEqual(decisionHelpers.skillBody(skill,'reject'),{id:'fetch',action:'reject'});
  assert.throws(()=>decisionHelpers.skillBody({...skill,action:{...skill.action,choices:['fetch']}},'reject'),/classic/);
});
test('M5 body helpers exclude unapproved fields and enforce text/confirm rules',()=>{
  const c=fx.decisionMessages(),p={confirm_word:'actual-server-word'};
  assert.deepEqual(decisionHelpers.reviewBody(c.low,'approve',{remember:true,confirm:'ignored',redirect:'ignored',extra:'private'},p),{run:'run_test',kind:'permission',request_id:'low',fingerprint:'NEVER-SHOW-FINGERPRINT',action:'approve',remember:true});
  assert.deepEqual(decisionHelpers.reviewBody(c.critical,'approve',{remember:true,confirm:p.confirm_word},p),{run:'run_test',kind:'permission',request_id:'critical',fingerprint:'NEVER-SHOW-FINGERPRINT',action:'approve',confirm:p.confirm_word});
  assert.throws(()=>decisionHelpers.reviewBody(c.critical,'approve',{confirm:'hard-coded'},p),/actual-server-word/);
  assert.throws(()=>decisionHelpers.researchBody(c.research,'approve',{confirm:'wrong'},p),/actual-server-word/);
  assert.throws(()=>decisionHelpers.controlBody(c.proposal,'repropose',{text:' '}),/note/);assert.throws(()=>decisionHelpers.controlBody(c.proposal,'repropose',{text:'x'.repeat(2001)}),/2,000/);
  assert.throws(()=>decisionHelpers.reviewBody(c.low,'reject',{redirect:'x'.repeat(5001)},p),/5,000/);
  assert.deepEqual(decisionHelpers.skillBody(c.skillFetch,'fetch'),{id:'fetch'});
});
const catalogueCases=[
  ['low','approve',{}, {run:'run_test',kind:'permission',request_id:'low',fingerprint:'NEVER-SHOW-FINGERPRINT',action:'approve'}],
  ['low','approve',{remember:true}, {run:'run_test',kind:'permission',request_id:'low',fingerprint:'NEVER-SHOW-FINGERPRINT',action:'approve',remember:true}],
  ['critical','approve',{confirm:'CONFIRM-TEST'}, {run:'run_test',kind:'permission',request_id:'critical',fingerprint:'NEVER-SHOW-FINGERPRINT',action:'approve',confirm:'CONFIRM-TEST'}],
  ['low','reject',{}, {run:'run_test',kind:'permission',request_id:'low',fingerprint:'NEVER-SHOW-FINGERPRINT',action:'reject'}],
  ['low','reject',{redirect:'Use local tests instead'}, {run:'run_test',kind:'permission',request_id:'low',fingerprint:'NEVER-SHOW-FINGERPRINT',action:'reject',redirect:'Use local tests instead'}],
  ['question','answer',{answers:['JSON']}, {run:'run_test',kind:'question',request_id:'question',fingerprint:'NEVER-SHOW-FINGERPRINT',action:'answer',answers:[['JSON']]}],
  ['question','answer',{answers:['My format']}, {run:'run_test',kind:'question',request_id:'question',fingerprint:'NEVER-SHOW-FINGERPRINT',action:'answer',answers:[['My format']]}],
  ['multiple','answer',{answers:['JSON','SQLite']}, {run:'run_test',kind:'question',request_id:'multiple',fingerprint:'NEVER-SHOW-FINGERPRINT',action:'answer',answers:[['JSON','SQLite']]}],
  ['question','reject',{}, {run:'run_test',kind:'question',request_id:'question',fingerprint:'NEVER-SHOW-FINGERPRINT',action:'reject'}],
  ['proposal','approve_team',{}, {run:'run_test',action:'approve_team'}],
  ['proposal','single_agent',{}, {run:'run_test',action:'single_agent'}],
  ['proposal','repropose',{text:'A smaller plan'}, {run:'run_test',action:'repropose',text:'A smaller plan'}],
  ['research','approve',{confirm:'CONFIRM-TEST'}, {run:'run_test',step:'research',fingerprint:'NEVER-SHOW-FINGERPRINT',action:'approve',confirm:'CONFIRM-TEST'}],
  ['research','reject',{}, {run:'run_test',step:'research',fingerprint:'NEVER-SHOW-FINGERPRINT',action:'reject'}],
  ['skillFetch','fetch',{}, {id:'fetch'}],
  ['skillFetch','reject',{}, {id:'fetch',action:'reject'}, '/api/skills/decide'],
  ['skillInstall','approve',{}, {id:'install',action:'approve'}],
  ['skillInstall','reject',{}, {id:'install',action:'reject'}],
  ['outcome','apply',{}, {run:'run_done',action:'apply'}],
  ['outcome','discard_workspace',{}, {run:'run_done',action:'discard_workspace'}],
  ['outcome','verify',{}, {run:'run_done',action:'verify'}]
];
for(const [name,choice,inputs,expected,expectedEndpoint] of catalogueCases)test('M5 DOM exact '+name+' '+choice+' '+JSON.stringify(inputs),async()=>{
  const h=await decisionHarness(name,{post:async()=>({ok:true})}), message=h.f.thread.messages.find(m=>m.kind!=='session_start'), card=decisionCard(h,message.id), original=JSON.stringify(h.core.getState().thread.messages[message.id]);
  if(inputs.remember)card.querySelector('[data-remember]').checked=true;
  if(inputs.answers)for(const field of card.querySelectorAll('[data-question]')) {
    for(const input of field.querySelectorAll('input[type="radio"],input[type="checkbox"]'))input.checked=inputs.answers.includes(input.value) || input.hasAttribute('data-custom') && inputs.answers.some(value=>!['JSON','SQLite'].includes(value));
    const custom=inputs.answers.find(value=>!['JSON','SQLite'].includes(value));if(custom)field.querySelector('.custom-answer').value=custom;
  }
  const status=card.querySelector('[role="status"]');await clickDecision(h,choice);
  if(h.document.querySelector('#decision-dialog').hasAttribute('open')) {assert(h.document.activeElement.hasAttribute('data-cancel-decision'));await confirmDecision(h,inputs);}
  assert.deepEqual(posts(h),[{url:expectedEndpoint || message.action.endpoint,body:expected}]);
  assert.equal(JSON.stringify(h.core.getState().thread.messages[message.id]),original);
  assert.equal(card.querySelector('[role="status"]'),status);assert.equal(status.textContent,'Sent · waiting for AgentControl to record it');assert(card.querySelector('.waiting-state'));
  assert.equal(h.core.getState().channels.channels[0].waiting,h.f.channels.channels[0].waiting);
  recordedDecision(h.f,message,choice);await h.core.refresh();
  const result=decisionCard(h,message.id);assert.equal(result.querySelector('[role="status"]'),status);assert(!result.textContent.includes('Sent · waiting'));assert.equal(h.core.getState().thread.messages[message.id].rev,2);assert.equal(h.core.getState().channels.channels[0].waiting,h.f.channels.channels[0].waiting);
  if(name==='low' || name==='critical' || name==='question' || name==='multiple')assert(result.textContent.includes(choice==='approve'?'Approved once':choice==='reject'?'Denied':'Answered'));
  if(choice==='verify')assert(h.timeline.textContent.includes('verification (on demand) · passed'));
});
test('M5 no controls on historical, expired, decided or unsupported actions',async()=>{
  const f=fx.decisionFixture('all');for(const message of f.thread.messages.filter(m=>m.action)){message.action=null;message.detail.expired=true;}
  const unknown=fx.decisionMessages().low;unknown.id='m5:unknown';unknown.action.endpoint='/api/not-allowed';f.thread.messages.push(unknown);
  const h=await harness(f.state,{thread:f.thread});assert.equal(h.timeline.querySelectorAll('[data-decision]').length,0);assert.equal(decisionCard(h,'m5:unknown').querySelector('a[href="/classic"]').textContent,'Open in classic dashboard');assert.equal(posts(h).length,0);
});
test('M5 truncation blocks approvals but keeps safe refusal choices',async()=>{
  for(const [name,blocked,safe] of [['low','approve','reject'],['question','answer','reject'],['proposal','approve_team','single_agent'],['research','approve','reject'],['skillInstall','approve','reject'],['outcome','apply','discard_workspace']]) {
    const f=fx.decisionFixture(name),msg=f.thread.messages.find(m=>m.action);msg.detail.review_truncated=true;
    const h=await harness(f.state,{thread:f.thread,channels:f.channels,post:async()=>({ok:true})});assert(button(h,blocked).disabled,name);assert(!button(h,safe).disabled,name);
    assert(decisionCard(h,msg.id).textContent.includes('Too large to review here'));assert.equal(decisionCard(h,msg.id).querySelectorAll('a[href="/classic"]').length,1);
    button(h,blocked).click();await tick();assert.equal(posts(h).length,0);await clickDecision(h,safe);if(h.document.querySelector('#decision-dialog').hasAttribute('open'))await confirmDecision(h);assert.equal(posts(h).length,1);
  }
});
test('M5 critical/research/install evidence opens by default and excludes private values',async()=>{
  for(const name of ['critical','research','skillInstall']) {
    const f=fx.decisionFixture(name),message=f.thread.messages.find(m=>m.action);message.detail.reasoning='PRIVATE';message.detail.output='PRIVATE';if(message.detail.review)Object.assign(message.detail.review,{output:'PRIVATE',reasoning:'PRIVATE'});
    const h=await harness(f.state,{thread:f.thread});const details=h.timeline.querySelector('.review-detail');assert(details.open,name);assert(!h.timeline.textContent.includes('PRIVATE'));assert(!h.document.toString().includes('NEVER-SHOW-FINGERPRINT'));
    const expected=name==='critical'?['rm -r build/','Remove only generated build files','- generated build output']:name==='research'?['Which storage format','Check the public documentation','web','60']:['Testing helpers','SKILL.md','32 bytes','# Python testing'];for(const value of expected)assert(details.textContent.includes(value),value);
  }
});
test('M5 question form requires every answer and offers custom only when allowed',async()=>{
  const h=await decisionHarness('question',{post:async()=>({ok:true})});await clickDecision(h,'answer');assert.equal(posts(h).length,0);assert.match(h.timeline.querySelector('.decision-status').textContent,/nonempty/);assert(h.timeline.querySelector('[data-custom]'));
  const multi=await decisionHarness('multiple');assert.equal(multi.timeline.querySelector('[data-custom]'),null);assert.equal(multi.timeline.querySelectorAll('input[type="checkbox"]').length,2);
});
test('M5 real-server confirm word required, remember follows recorded risk',async()=>{
  const h=await decisionHarness('critical',{post:async()=>({ok:true})});h.f.state.permissions.confirm_word='OWNER-WORD';await h.core.refresh();await clickDecision(h,'approve');assert(h.document.querySelector('#decision-dialog').textContent.includes('OWNER-WORD'));assert.equal(h.timeline.querySelector('[data-remember]'),null);
  await confirmDecision(h,{confirm:'CONFIRM-TEST'});assert.equal(posts(h).length,0);assert.match(h.timeline.querySelector('.decision-status').textContent,/OWNER-WORD/);await confirmDecision(h,{confirm:'OWNER-WORD'});assert.equal(posts(h)[0].body.confirm,'OWNER-WORD');
});
test('M5 2xx with thread held cannot manufacture receipts or waiting changes',async()=>{
  const h=await decisionHarness('low',{post:async()=>({ok:true})}),before=JSON.stringify(h.core.getState().thread),waiting=h.core.getState().channels.channels[0].waiting;let release;
  h.options.respond=async url=>{if(url.startsWith('/api/thread'))return await new Promise(resolve=>{release=()=>resolve(h.f.thread);});};
  await clickDecision(h,'approve');assert.equal(JSON.stringify(h.core.getState().thread),before);assert.equal(h.core.getState().channels.channels[0].waiting,waiting);assert.equal(decisionCard(h,'m5:low').querySelector('.decision-status').textContent,'Sent · waiting for AgentControl to record it');assert(button(h,'approve').closest('.decision-controls').hidden);await clickDecision(h,'approve');assert.equal(posts(h).length,1);
  const message=h.f.thread.messages.find(m=>m.action);recordedDecision(h.f,message,'approve');release();await tick();await tick();assert(decisionCard(h,'m5:low').textContent.includes('Approved once'));h.options.respond=null;await h.core.refresh();assert.equal(h.core.getState().channels.channels[0].waiting,0);
});
test('M5 three successful refreshes require explicit fresh Refresh recovery',async()=>{
  const h=await decisionHarness('low',{post:async()=>({ok:true})});await clickDecision(h,'approve');await h.core.refresh();assert.equal(h.timeline.querySelector('.decision-status').textContent,'Sent · waiting for AgentControl to record it');
  h.options.fail=true;await h.core.refresh();h.options.fail=false;assert.equal(h.timeline.querySelector('.decision-status').textContent,'Sent · waiting for AgentControl to record it');await h.core.refresh();assert.equal(h.timeline.querySelector('.decision-status').textContent,'Not recorded yet.');
  const refresh=h.timeline.querySelector('[data-refresh-decision]');assert(!refresh.hidden);assert(button(h,'approve').closest('.decision-controls').hidden);await h.core.refresh();assert(button(h,'approve').closest('.decision-controls').hidden);refresh.click();await tick();assert(!button(h,'approve').closest('.decision-controls').hidden);assert.equal(h.timeline.querySelector('.decision-status').textContent,'');
});
test('M5 15-second not-recorded timer uses the same Refresh recovery',async()=>{
  const h=await decisionHarness('low',{post:async()=>({ok:true})});await clickDecision(h,'approve');await h.runTimers(15000);assert.equal(h.timeline.querySelector('.decision-status').textContent,'Not recorded yet.');h.timeline.querySelector('[data-refresh-decision]').click();await tick();assert(!button(h,'approve').disabled);
});
test('M5 409 blocks replay until fresh fingerprint arrives',async()=>{
  const h=await decisionHarness('low',{post:async()=>({status:409,error:'The requested action changed. Review the current request.'})});let release;
  h.options.respond=async url=>{if(url.startsWith('/api/thread'))return await new Promise(resolve=>{release=()=>resolve(h.f.thread);});};
  await clickDecision(h,'approve');assert.equal(h.timeline.querySelector('.decision-status').textContent,'The requested action changed. Review the current request.');assert(button(h,'approve').disabled);await clickDecision(h,'approve');assert.equal(posts(h).length,1);
  const message=h.f.thread.messages.find(m=>m.action);message.rev++;message.action.fields.fingerprint='FRESH-FINGERPRINT';release();await tick();await tick();assert(!button(h,'approve').disabled);h.options.respond=null;h.options.post=async()=>({ok:true});await clickDecision(h,'approve');assert.equal(posts(h)[1].body.fingerprint,'FRESH-FINGERPRINT');assert(!h.document.toString().includes('FRESH-FINGERPRINT'));
});
test('M5 400 keeps non-confirm inputs, clears typed confirmation, shows exact error',async()=>{
  const h=await decisionHarness('research',{post:async()=>({error:'The session has ended'})});await clickDecision(h,'approve');await confirmDecision(h,{confirm:'CONFIRM-TEST'});assert.equal(h.timeline.querySelector('.decision-status').textContent,'The session has ended');assert.equal(h.document.querySelector('[name="confirm"]').value,'');
  const deny=await decisionHarness('low',{post:async()=>({error:'Redirection was rejected verbatim'})});await clickDecision(deny,'reject');await confirmDecision(deny,{redirect:'Keep this note'});assert.equal(deny.document.querySelector('[name="redirect"]').value,'Keep this note');assert.equal(deny.timeline.querySelector('.decision-status').textContent,'Redirection was rejected verbatim');
  const team=await decisionHarness('proposal',{post:async()=>({error:'Three proposals have already been tried'})});await clickDecision(team,'repropose');await confirmDecision(team,{text:'Keep my plan note'});assert.equal(team.document.querySelector('[name="text"]').value,'Keep my plan note');
});
test('M5 network uncertainty waits for a fresh read, then permits recovery',async()=>{
  const h=await decisionHarness('low',{post:async()=>({throws:'offline'})});let release;
  h.options.respond=async url=>{if(url.startsWith('/api/thread'))return await new Promise(resolve=>{release=()=>resolve(h.f.thread);});};
  await clickDecision(h,'approve');assert.equal(h.timeline.querySelector('.decision-status').textContent,"Couldn't reach AgentControl. The decision may or may not have been recorded. Checking…");assert(button(h,'approve').closest('.decision-controls').hidden);await clickDecision(h,'approve');assert.equal(posts(h).length,1);
  release();await tick();await tick();assert(!button(h,'approve').closest('.decision-controls').hidden);assert(!button(h,'approve').disabled);h.options.respond=null;h.options.post=async()=>({ok:true});await clickDecision(h,'approve');assert.equal(posts(h).length,2);
});
test('M5 uncertain network response can resolve as a recorded decision without retry',async()=>{
  const h=await decisionHarness('low',{post:async()=>({throws:'connection lost'})});const message=h.f.thread.messages.find(m=>m.action);
  h.options.post=async()=>{recordedDecision(h.f,message,'approve');return {throws:'connection lost'};};await clickDecision(h,'approve');await tick();assert.equal(posts(h).length,1);assert.equal(h.timeline.querySelector('[data-decision="approve"]'),null);assert(h.timeline.textContent.includes('Approved once'));assert.equal(h.core.getState().channels.channels[0].waiting,0);
});
test('M5 in-flight server receipts forbid second decisions despite an action',async()=>{
  for(const state of ['dispatching','sent','uncertain']) {
    const f=fx.decisionFixture('low'),message=f.thread.messages.find(m=>m.action);message.detail.receipt={state,action:'approve',actor:'You, via dashboard'};
    const h=await harness(f.state,{thread:f.thread,channels:f.channels});assert.equal(h.timeline.querySelectorAll('[data-decision]').length,0);assert(h.timeline.textContent.includes(({dispatching:'Sending decision',sent:'Awaiting confirmation',uncertain:'Delivery uncertain'})[state]));assert.equal(posts(h).length,0);
  }
});
test('M5 dialog closes when its decision is recorded elsewhere',async()=>{
  const h=await decisionHarness('critical');await clickDecision(h,'approve');const message=h.f.thread.messages.find(m=>m.action);recordedDecision(h.f,message,'reject');await h.core.refresh();assert(!h.document.querySelector('#decision-dialog').hasAttribute('open'));assert(h.timeline.textContent.includes('This was decided elsewhere or is no longer waiting.'));assert.equal(posts(h).length,0);
});
test('M5 changed material in an open dialog requires re-review',async()=>{
  const h=await decisionHarness('critical');await clickDecision(h,'approve');const message=h.f.thread.messages.find(m=>m.action);message.rev++;message.action.fields.fingerprint='changed';message.detail.review.command='changed command';await h.core.refresh();assert(!h.document.querySelector('#decision-dialog').hasAttribute('open'));assert(h.timeline.textContent.includes('Review the updated item'));assert.equal(posts(h).length,0);
});
test('M5 401 discards decision inputs and returns to sign-in',async()=>{
  const h=await decisionHarness('critical',{post:async()=>({status:401,error:'Connect again with your key'})});await clickDecision(h,'approve');await confirmDecision(h,{confirm:'CONFIRM-TEST'});assert(!h.core.getState().authenticated);assert(!h.document.querySelector('#decision-dialog').hasAttribute('open'));assert.equal(h.document.querySelector('[name="confirm"]'),null);assert.equal(h.local.has('ac-dashboard-key'),false);
});
test('M5 one decision flight disables all cards and composer; double clicks send once',async()=>{
  let release;const h=await decisionHarness('all',{post:async()=>await new Promise(resolve=>{release=()=>resolve({ok:true});})});type(h,'Keep a draft');await clickDecision(h,'approve','m5:low');await clickDecision(h,'approve','m5:low');await h.composer.submit();assert.equal(posts(h).length,1);assert(h.document.querySelector('#send-message').disabled);assert([...h.timeline.querySelectorAll('[data-decision]')].every(node=>node.disabled));assert.equal(decisionCard(h,'m5:low').querySelector('.decision-status').textContent,'Sending your decision…');release();await tick();await tick();assert(!button(h,'reject','m5:install').disabled);
});
test('M5 composer and start preparation also block decisions',async()=>{
  let release;const h=await decisionHarness('low',{post:async()=>await new Promise(resolve=>{release=()=>resolve({ok:true});})});type(h,'Keep this literal note');const task=h.composer.submit();await tick();assert(button(h,'approve').disabled);await clickDecision(h,'approve');assert.equal(posts(h).length,1);release();await task;
  const start=await decisionHarness('outcome',{holdPreflight:true,post:async()=>({ok:true})});type(start,'Start another goal');const preparing=start.composer.submit();await tick();assert(button(start,'verify').disabled);await clickDecision(start,'verify');assert.equal(posts(start).length,0);start.options.holdPreflight=false;start.options.releasePreflight();await preparing;assert.equal(posts(start).length,1);assert.equal(posts(start)[0].url,'/api/runs');assert(!button(start,'verify').disabled);
});
test('M5 complete decision-card count follows waiting plus the server outcome',async()=>{
  for(const name of ['all',...Object.keys(fx.decisionMessages())]) {
    const h=await decisionHarness(name),messages=h.f.thread.messages, count=messages.filter(m=>m.kind==='outcome' && m.action).length;
    assert(count<=1);assert.equal(h.timeline.querySelectorAll('.decision-host[data-actionable]').length,h.f.channels.channels[0].waiting+count,name);
    assert.equal(h.timeline.querySelectorAll('.decision-host[data-actionable] .decision-buttons').length,h.f.channels.channels[0].waiting+count,name);
  }
});
test('M5 waiting pointer prefers the first non-outcome actionable card',async()=>{
  const h=await decisionHarness('all');assert.equal(await h.core.locateWaiting(),'m5:low');h.document.querySelector('#waiting-pointer').click();await tick();assert(decisionCard(h,'m5:low').classList.contains('focused'));
});
test('M5 slash aliases use the exact same controls and confirmations',async()=>{
  for(const [text,name,choice,note] of [['/verify','outcome','verify'],['/apply','outcome','apply'],['/discard','outcome','discard_workspace'],['/team approve','proposal','approve_team'],['/team single','proposal','single_agent'],['/team repropose Keep the team small','proposal','repropose','Keep the team small']]) {
    const h=await decisionHarness(name,{post:async()=>({ok:true})});type(h,text);await h.composer.submit();await tick();
    const dialog=h.document.querySelector('#decision-dialog');if(dialog.hasAttribute('open')){assert.equal(posts(h).length,0);if(note)assert.equal(dialog.querySelector('[name="text"]').value,note);await confirmDecision(h);}
    assert.deepEqual(posts(h).map(p=>p.body),[{run:name==='outcome'?'run_done':'run_test',action:choice,...(note?{text:note}:{})}],text);
    assert.equal(h.document.querySelector('#composer').value,'',text);assert.equal(h.session.has('acx-draft'),false,text);await h.composer.submit();assert.equal(posts(h).length,1,text);
  }
});
test('M5 missing slash targets, extra commands, choice restrictions and truncation never send',async()=>{
  const h=await decisionHarness('low',{post:async()=>({ok:true})});for(const text of ['/verify','/apply','/discard','/team approve','/team single','/team repropose New plan','/team','/team reject','/research','/install','/verify now','/apply extra']){type(h,text);await h.composer.submit();assert.equal(posts(h).length,0,text);assert(h.document.querySelector('#composer-status').textContent,text);}
  const f=fx.decisionFixture('outcome');f.thread.messages.find(m=>m.action).action.choices=['verify'];const restricted=await harness(f.state,{thread:f.thread});type(restricted,'/apply');await restricted.composer.submit();assert.equal(posts(restricted).length,0);assert.equal(restricted.document.querySelector('#composer-status').textContent,'Nothing to apply here');
});
test('M5 dialog focus, Escape, object labels, status identity and outcome wording',async()=>{
  const h=await decisionHarness('outcome',{post:async()=>({ok:true})});for(const [choice,expected] of [['apply','Merge agent/storage into main? 2 commits · 2 files changed, 20 insertions(+), 3 deletions(-). This changes your branch.'],['discard_workspace','Delete agent/storage and its worktrees? This cannot be undone.']]) {
    await clickDecision(h,choice);const dialog=h.document.querySelector('#decision-dialog');assert(dialog.textContent.includes(expected));assert(dialog.querySelector('h2').textContent.includes('agent/storage'));assert(h.document.activeElement.hasAttribute('data-cancel-decision'));key(h,'Escape',{},h.document.activeElement);assert(!dialog.hasAttribute('open'));assert.equal(posts(h).length,0);
  }
  for(const node of h.timeline.querySelectorAll('[data-decision]'))assert(node.getAttribute('aria-label').includes('Tests pass; storage works.'));
  const status=decisionCard(h,'m5:outcome').querySelector('[role="status"]');await clickDecision(h,'verify');assert.equal(decisionCard(h,'m5:outcome').querySelector('[role="status"]'),status);assert.equal(h.document.activeElement,decisionCard(h,'m5:outcome'));
});
test('M5 normalized server team plans expose responsibilities, files, dependencies and research questions',async()=>{
  const f=fx.decisionFixture('proposal'),message=f.thread.messages.find(m=>m.action);
  message.detail.proposal={agents:{'coder-1':{role:'coder',responsibility:'Build API',skills:['testing']},'researcher-1':{role:'researcher',responsibility:'Read docs'}},tasks:[{id:'docs',title:'Look up',agent:'researcher-1',question:'Which status is supported?',files:[]},{id:'api',title:'API',agent:'coder-1',files:['api.py'],depends_on:['docs']}]};
  const h=await harness(f.state,{thread:f.thread,channels:f.channels,post:async()=>({ok:true})});for(const text of ['2 agents · 2 tasks','coder-1','Build API','testing','Which status is supported?','api.py','After docs'])assert(h.timeline.textContent.includes(text),text);await clickDecision(h,'approve_team');assert.deepEqual(posts(h).map(p=>p.body),[{run:'run_test',action:'approve_team'}]);
});
test('M5 skill risk and source accept the real capability record shape',async()=>{
  const f=fx.decisionFixture('skillInstall'),message=f.thread.messages.find(m=>m.action);message.detail.risk='caution';message.detail.source={type:'git',url:'https://example.test/skills',path:'testing'};const h=await harness(f.state,{thread:f.thread});assert(h.timeline.textContent.includes('Risk · caution'));assert(h.timeline.textContent.includes('https://example.test/skills'));
});
test('M5 result arriving during a held POST wins over its later 2xx response',async()=>{
  let release;const h=await decisionHarness('low',{post:async()=>await new Promise(resolve=>{release=()=>resolve({ok:true});})});await clickDecision(h,'approve');const message=h.f.thread.messages.find(m=>m.action);recordedDecision(h.f,message,'approve');await h.core.refresh();assert(h.timeline.textContent.includes('Approved once'));release();await tick();await tick();assert(!h.timeline.textContent.includes('Sent · waiting'));assert.equal(h.timeline.querySelector('[data-decision="approve"]'),null);assert.equal(posts(h).length,1);
});
test('M5 repeated Enter in a confirmation sends exactly once',async()=>{
  let release;const h=await decisionHarness('critical',{post:async()=>await new Promise(resolve=>{release=()=>resolve({ok:true});})});await clickDecision(h,'approve');await confirmDecision(h,{confirm:'CONFIRM-TEST'});await confirmDecision(h,{confirm:'CONFIRM-TEST'});assert.equal(posts(h).length,1);assert(h.document.querySelector('[data-confirm-decision]').disabled);release();await tick();assert(!h.document.querySelector('#decision-dialog').hasAttribute('open'));
});
test('M5 stale refusal decided elsewhere disappears only after its server read',async()=>{
  const h=await decisionHarness('low',{post:async()=>({status:409,error:'This request was already decided'})});h.options.post=async()=>{recordedDecision(h.f,h.f.thread.messages.find(m=>m.action),'reject');return {status:409,error:'This request was already decided'};};await clickDecision(h,'approve');await tick();assert(h.timeline.textContent.includes('Denied'));assert.equal(h.timeline.querySelector('[data-decision="approve"]'),null);assert.equal(h.core.getState().channels.channels[0].waiting,0);assert.equal(posts(h).length,1);
});
test('M5 changed skill and Apply-conflict 400s show recorded fresh material and exact server text',async()=>{
  const h=await decisionHarness('skillInstall',{post:async()=>({ok:true})});h.options.post=async()=>{const message=h.f.thread.messages.find(m=>m.action);message.rev++;message.detail.review.skill_md='# Changed skill';return {error:'The skill changed since it was shown to you. Review the new version.'};};await clickDecision(h,'approve');await tick();assert(h.timeline.textContent.includes('# Changed skill'));assert(!button(h,'approve').disabled);assert.equal(posts(h).length,1);
  const apply=await decisionHarness('outcome',{post:async()=>({error:'Your branch is unchanged. Resolve the merge conflict and try again.'})});await clickDecision(apply,'apply');await confirmDecision(apply);assert.equal(apply.timeline.querySelector('.decision-status').textContent,'Your branch is unchanged. Resolve the merge conflict and try again.');assert.equal(apply.core.getState().thread.messages['m5:outcome'].detail.workspace.state,'open');
});
test('M5 network uncertainty can return an in-flight receipt while waiting remains one',async()=>{
  const h=await decisionHarness('low',{post:async()=>({ok:true})});h.options.post=async()=>{const message=h.f.thread.messages.find(m=>m.action);message.rev++;message.detail.receipt={state:'uncertain',action:'approve',actor:'You, via dashboard'};return {throws:'lost after recording'};};await clickDecision(h,'approve');await tick();assert(h.timeline.textContent.includes('Delivery uncertain · by you'));assert.equal(h.timeline.querySelector('[data-decision="approve"]'),null);assert.equal(h.core.getState().channels.channels[0].waiting,1);assert.equal(h.timeline.querySelectorAll('.decision-host[data-actionable]').length,1);assert.equal(posts(h).length,1);
});
test('M5 complete paged room includes old actionable cards and refreshes them without a count change',async()=>{
  const message=fx.decisionMessages().low,session=fx.threadSession('run_test',{status:'waiting',ended:null}),newest=Array.from({length:200},(_,i)=>fx.threadMessage('m5:new:'+i,'decision','Public update '+i)),page=fx.threadResponse(newest,[session],'older'),old=fx.threadResponse([fx.threadMessage('run:run_test','session_start','Active session'),message],[session]);
  const channels=fx.threadChannels(page,1), h=await harness(fx.decisionFixture('low').state,{thread:page,channels,respond:url=>{if(url.startsWith('/api/thread'))return new URL(url,'http://test').searchParams.has('before')?old:page;},post:async()=>({throws:'offline'})});
  await h.core.loadOlder();assert.equal(h.timeline.querySelectorAll('.decision-host[data-actionable]').length,1);assert.equal(h.core.getState().thread.before,null);assert.equal(await h.core.locateWaiting(),message.id);const initialWalks=h.calls.filter(c=>c.url.includes('before=older')).length;
  await clickDecision(h,'approve',message.id);await tick();assert(h.calls.filter(c=>c.url.includes('before=older')).length>initialWalks);assert(!button(h,'approve',message.id).disabled);assert.equal(h.core.getState().channels.channels[0].waiting,1);assert.equal(h.timeline.querySelectorAll('.decision-host[data-actionable]').length,1);
});
test('M5 on-demand verification uses its recorded system event, including grouped updates',async()=>{
  const h=await decisionHarness('outcome',{post:async()=>({ok:true})});await clickDecision(h,'verify');assert(!h.timeline.textContent.includes('Verification (on demand) · passed'));
  h.f.thread.messages.push(fx.threadMessage('m5:verify-requested','system','Verify now requested.'),fx.threadMessage('m5:verify-result','system','passed',{status:'passed',argv:['python3','-m','unittest'],ended:'2026-09-30T12:00:00Z',output:'PRIVATE'}));await h.core.refresh();assert(h.timeline.textContent.includes('Verification (on demand) · passed'));assert(!h.timeline.textContent.includes('PRIVATE'));assert.equal(h.timeline.querySelectorAll('.decision-host[data-actionable]').length,1);assert.equal(h.core.getState().channels.channels[0].waiting,0);
});
test('M5 unsupported or unavailable review material cannot be approved',async()=>{
  for(const [name,mutate,safe] of [['low',m=>m.detail.review={diff:{reasoning:'PRIVATE'}},'reject'],['question',m=>m.detail.questions=[{question:{reasoning:'PRIVATE'},options:[]}],'reject'],['proposal',m=>m.detail.proposal={agents:[],tasks:[]},'single_agent'],['research',m=>m.detail.request={question:'Only a fragment'},'reject'],['skillInstall',m=>m.detail.review={description:'Missing SKILL.md',files:[],size:0},'reject']]) {
    const f=fx.decisionFixture(name),message=f.thread.messages.find(m=>m.action);mutate(message);const h=await harness(f.state,{thread:f.thread,channels:f.channels,post:async()=>({ok:true})});const approval=h.timeline.querySelector('[data-decision="'+(name==='proposal'?'approve_team':name==='question'?'answer':'approve')+'"]');assert(approval.disabled,name);assert(!button(h,safe).disabled,name);approval.click();await tick();assert.equal(posts(h).length,0);assert(h.timeline.textContent.includes('Cannot review this approval here'));assert(!h.timeline.textContent.includes('PRIVATE'));assert.equal(h.timeline.querySelectorAll('.decision-host[data-actionable]').length,f.channels.channels[0].waiting);
  }
});
test('M6 recorded verification statuses render independently of delivery state',async()=>{
  for(const status of ['running','passed','failed','future-status','constructor']) {
    const f=fx.decisionFixture('outcome'),message=f.thread.messages.find(m=>m.action);
    message.detail.verification={status,created:'2026-10-01T00:00:00Z',output:'PRIVATE',argv:['PRIVATE'],exit_code:0};message.rev++;
    const h=await harness(f.state,{thread:f.thread,channels:f.channels});
    assert(decisionCard(h,message.id).textContent.includes('Verification (on demand) · '+status));assert(!h.timeline.textContent.includes('PRIVATE'));assert.equal(posts(h).length,0);
  }
});
test('M6 a recorded verification revision reconciles Sent without a false timeout',async()=>{
  for(const status of ['running','passed']) {
    const h=await decisionHarness('outcome',{post:async()=>({ok:true})});await clickDecision(h,'verify');
    assert(h.timeline.textContent.includes('Sent · waiting for AgentControl to record it'));assert(!h.timeline.textContent.includes('Verification (on demand)'));
    const message=h.f.thread.messages.find(m=>m.action);message.rev++;message.detail.verification={status,created:'2026-10-01T00:00:00Z',...(status==='passed'?{ended:'2026-10-01T00:00:00.001Z'}:{})};
    if(status==='running')message.action.choices=message.action.choices.filter(c=>c!=='verify');
    await h.core.refresh();assert(!h.timeline.textContent.includes('Sent · waiting'));assert(h.timeline.textContent.includes('Verification (on demand) · '+status));
    for(let i=0;i<3;i++)await h.core.refresh();await h.runTimers(15000);
    assert(!h.timeline.textContent.includes('Not recorded yet.'));assert.equal(posts(h).length,1);assert.equal(h.core.getState().channels.channels[0].waiting,0);
  }
});
test('M6 alias errors preserve drafts and a successful dialog hand-off clears before confirmation',async()=>{
  for(const [name,text,mutate] of [['low','/verify'],['outcome','/apply',m=>m.detail.review_truncated=true],['outcome','/discard',m=>m.action.choices=['verify']]]) {
    const f=fx.decisionFixture(name);if(mutate)mutate(f.thread.messages.find(m=>m.action));const h=await harness(f.state,{thread:f.thread,channels:f.channels});type(h,text);await h.composer.submit();
    assert.equal(h.document.querySelector('#composer').value,text);assert.equal(h.session.get('acx-draft'),text);assert.equal(posts(h).length,0);
  }
  const sent=await decisionHarness('outcome',{post:async()=>({ok:true})});type(sent,'/verify');await sent.composer.submit();await tick();type(sent,'/verify');await sent.composer.submit();assert.equal(sent.document.querySelector('#composer').value,'/verify');assert.equal(sent.session.get('acx-draft'),'/verify');assert.equal(posts(sent).length,1);
  const h=await decisionHarness('outcome');type(h,'/apply');await h.composer.submit();assert(h.document.querySelector('#decision-dialog').hasAttribute('open'));assert.equal(h.document.querySelector('#composer').value,'');assert.equal(h.session.has('acx-draft'),false);assert.equal(posts(h).length,0);
});
test('M5 typed confirmation mirrors the server case/space rule and preserves the supplied body',()=>{
  const c=fx.decisionMessages(),permissions={confirm_word:'server-word'};
  assert.equal(decisionHelpers.reviewBody(c.critical,'approve',{confirm:' SERVER-WORD '},permissions).confirm,' SERVER-WORD ');assert.equal(decisionHelpers.researchBody(c.research,'approve',{confirm:'SERVER-WORD'},permissions).confirm,'SERVER-WORD');
});
test('M5 a decision in the single-session fallback gets its own fresh server read',async()=>{
  const current=fx.threadResponse([fx.threadMessage('newest','decision','Current room update',{}, {session:'new'})],[fx.threadSession('new')],'more'),message=fx.decisionMessages().low;message.session='far';message.action.fields.run='far';
  const far=fx.threadResponse([fx.threadMessage('run:far','session_start','Far active session',{}, {session:'far'}),message],[fx.threadSession('far',{status:'waiting',ended:null})]);
  const h=await harness(fx.decisionFixture('low').state,{hash:'#/s/far',thread:current,channels:fx.threadChannels(current,1),post:async()=>({throws:'offline'}),respond:url=>{if(url.startsWith('/api/thread'))return new URL(url,'http://test').searchParams.get('session')==='far'?far:current;}});
  assert(h.core.getState().single);await clickDecision(h,'approve',message.id);await tick();assert(h.calls.some(c=>c.url.includes('session=far') && c.url.includes('known=')));assert(!button(h,'approve',message.id).disabled);assert.equal(h.core.getState().single.messages[message.id].action.fields.run,'far');assert.equal(posts(h).length,1);
});

const memberModel=()=>require(path.join(root,'model.js'));
async function membersHarness(kind='teamRunning',options={}) {const f=fx.membersFixture(kind),h=await harness(f.state,{thread:f.thread,channels:f.channels,...options});h.f=f;return h;}
async function openMembers(h,id='run_test') {h.window.location.hash='#/s/'+id;h.shell.route();await h.runTimers(0);await tick();await tick();h.document.querySelector('#members-tab').click();await tick();}
const contextText=h=>h.document.querySelector('#context-content').textContent;
const detailCalls=(h,id)=>h.calls.filter(c=>c.url==='/api/state?scope=current&run='+id);
test('M6 roster helpers preserve join order, labels, raw unknown states and activity',()=>{
  const f=fx.membersFixture(),before=JSON.stringify(f.state);f.state.agents[0].state='future_state';
  const list=memberModel().membersFromState(f.state);assert.deepEqual(list.map(a=>a.name),['hermes','coder-2','coder-1','reviewer-1']);assert.equal(list[0].displayName,'Hermes');assert.equal(list[1].displayName,'coder-2 (Tests)');assert.equal(list[1].stateLabel,'future_state');assert.equal(list[1].symbol,'◌');assert.equal(list[0].activity,'3 decisions');assert.equal(list[1].activity,'1 turn · 1 tool call');assert.equal(list[2].activity,'3 turns · 12 tool calls');
  assert.deepEqual(memberModel().membersFromState({agents:[]}),[]);f.state.agents[0].state='waiting_on_you';assert.equal(JSON.stringify(f.state),before);
});
test('M6 team-state helpers match classic wording, Auto, expiry and recorded counts',()=>{
  const m=memberModel(),f=fx.membersFixture('teamProposed');
  for(const [state,text] of [['proposing','Hermes is proposing a team. Nothing runs until you approve it.'],['proposed','Proposed team · not running yet'],['unusable','Hermes could not produce a usable team plan:'],['single','Running with one agent, as chosen'],['approved','Team · 0 of 0 tasks done'],['running','Team · 0 of 0 tasks done'],['review','Hermes reviews the merged result']]) {f.state.run.team.state=state;const plan=m.teamFromRun(f.state.run);assert(JSON.stringify(plan).includes(text),state);assert.equal(plan.pending,['proposing','proposed','unusable'].includes(state));}
  for(const state of ['proposing','proposed','unusable']){f.state.run.team.state=state;f.state.run.status='completed';assert.equal(m.teamFromRun(f.state.run).summary,'Not decided before the session ended');assert(!m.teamFromRun(f.state.run).pending);}
  f.state.run.auto={reasons:['A small goal','Recorded reason']};f.state.run.team.state='single';assert.equal(m.teamFromRun(f.state.run).auto.outcome,'one agent after Hermes’s review');f.state.run.mode='single';assert.equal(m.teamFromRun(f.state.run).auto.outcome,'one agent');f.state.run.mode='team';f.state.run.team.state='proposed';assert.equal(m.teamFromRun(f.state.run).auto.outcome,'a team plan for your approval');
});
test('M6 task helpers match classic depths and explicit statuses, counts and bounds',()=>{
  const m=memberModel(),tasks=fx.membersFixture().state.run.team.tasks;assert.deepEqual(m.taskDepths(tasks),{t1:0,t2:1,t3:1,t4:2,t5:0});assert.deepEqual(m.taskDepths([{id:'a',depends_on:[]},{id:'b',depends_on:['a']},{id:'c',depends_on:['b']}]),{a:0,b:1,c:2});assert.equal(m.taskDepths([{id:'missing',depends_on:['absent']}]).missing,1);assert(Object.values(m.taskDepths([{id:'a',depends_on:['b']},{id:'b',depends_on:['a']}])).every(Number.isFinite));
  for(const [state,label,symbol] of [['waiting','Waiting','◌'],['running','Running','●'],['done','Done','✓'],['failed','Failed','✕'],['blocked','Blocked','!'],['future_state','future_state','◌']])assert.deepEqual(m.taskStatus(state),{label,symbol});
  const run=fx.membersFixture().state.run;run.team.tasks=Array.from({length:53},(_,i)=>({id:'task'+i,title:'x'.repeat(500),status:i<3?'done':'waiting'}));run.team.tasks[0].depends_on=['task51'];run.team.tasks[51].depends_on=['task52'];const graph=m.tasksFromRun(run);assert.equal(graph.done,3);assert.equal(graph.total,53);assert.equal(graph.omitted,3);assert.equal(graph.groups.flatMap(g=>g.tasks).length,50);assert(graph.groups.flatMap(g=>g.tasks).every(t=>t.title.length<=300));assert(graph.groups.find(g=>g.depth===2)?.tasks.some(t=>t.id==='task0'),'hidden tasks still contribute their recorded dependency depth');
});
test('M6 rail union dedupes with live precedence, orders history and counts actual entries',()=>{
  const m=memberModel(),state={runs:[{id:'a',title:'Live title',created:'2026-10-01',status:'coding'}]},cache={sessions:{a:{id:'a',title:'Old title',created:'2026-09-01',status:'completed'},b:{id:'b',title:'Older',created:'2026-09-30',status:'completed'}}};const rail=m.railSessions(state,cache,5);assert.deepEqual(rail.sessions.map(s=>s.id),['a','b']);assert.equal(rail.sessions[0].status,'coding');assert.equal(rail.note,'Showing 2 of 5 sessions');
});
test('M6 proposed agents never become live members and the panel has no decisions',async()=>{
  const h=await membersHarness('teamProposed');await openMembers(h);assert.equal(h.document.querySelector('#members-tab').textContent,'Team');assert.equal(h.document.querySelectorAll('#live-members [data-member]').length,1);assert(!h.document.querySelector('#rail .members').textContent.includes('coder-'));assert(h.document.querySelector('#rail').textContent.includes('Team plan pending'));assert(contextText(h).includes('Proposed team · not running yet'));assert(contextText(h).includes('Build the API'));assert(contextText(h).includes('Proposal 2'));assert.equal(h.document.querySelectorAll('#context [data-decision]').length,0);assert(!/Approve team|Run as one agent|Ask for another plan/.test(contextText(h)));assert.equal(posts(h).length,0);
});
test('M6 every team-plan state, finished expiry and Auto render from recorded state',async()=>{
  for(const [kind,text] of [['teamProposing','Hermes is proposing a team'],['teamProposed','Proposed team · not running yet'],['teamUnusable','Missing task owner'],['teamRunning','Team · 1 of 5 tasks done'],['teamReview','Hermes reviews the merged result'],['teamFinished','Team · 1 of 5 tasks done'],['singleMembers','Members']]) {const h=await membersHarness(kind);await openMembers(h);assert(contextText(h).includes(text),kind);assert.equal(h.document.querySelector('#members-tab').textContent,kind==='singleMembers'?'Members':'Team');}
  for(const state of ['proposing','proposed','unusable']){const f=fx.membersFixture('teamFinished');f.state.run.team.state=state;const h=await harness(f.state,{thread:f.thread,channels:f.channels});await openMembers(h);assert(contextText(h).includes('Not decided before the session ended'));assert.equal(h.document.querySelector('[data-room-link="proposal"]'),null);}
  const h=await membersHarness('teamProposed');h.f.state.run.auto={reasons:['Recorded small goal']};await h.core.refresh();await openMembers(h);assert(contextText(h).includes('Auto mode:'));assert(contextText(h).includes('a team plan for your approval'));assert(contextText(h).includes('Recorded small goal'));
});
test('M6 member details and vertical tasks show statuses, attempts, reasons and labels',async()=>{
  const h=await membersHarness();await openMembers(h);for(const value of ['Hermes','coder-1 (API)','coder-2 (Tests)','3 decisions','3 turns · 12 tool calls','Tasks · 1 of 5 done','Can start now','After step 1','After step 2','✓ Done','● Running','✕ Failed','! Blocked','◌ Waiting','2 tries','A recorded test failed','After t2, t3'])assert(contextText(h).includes(value),value);
  assert.equal(h.document.querySelectorAll('.task-group').length,3);for(const list of h.document.querySelectorAll('.task-group ul'))assert(list.getAttribute('aria-labelledby'));assert.equal(h.document.querySelector('[data-room-link="turn"][data-message-id="turn:api-new"]').getAttribute('aria-label'),'Show the latest turn of task t2: Add API');
});
test('M6 lists bound 50 entries and 300 characters with omitted counts',async()=>{
  const f=fx.membersFixture('teamProposed');f.state.run.team.proposal.agents=Object.fromEntries(Array.from({length:53},(_,i)=>['coder-'+i,{label:'x'.repeat(500),responsibility:'x'.repeat(500)}]));f.state.run.team.warnings=Array.from({length:53},()=> 'w'.repeat(500));const h=await harness(f.state,{thread:f.thread,channels:f.channels});await openMembers(h);assert.equal(h.document.querySelectorAll('[data-proposed]').length,50);assert(contextText(h).includes('…and 3 more'));assert(!contextText(h).includes('x'.repeat(301)));
  const tasks=await membersHarness();tasks.f.state.run.team.tasks=Array.from({length:53},(_,i)=>({id:'t'+i,title:'x'.repeat(500),agent:'coder-1',status:'waiting',steps:[]}));await tasks.core.refresh();await openMembers(tasks);assert.equal(tasks.document.querySelectorAll('[data-task]').length,50);assert(contextText(tasks).includes('…and 3 more'));
});
test('M6 loaded proposal and latest-turn links focus server messages without POSTs',async()=>{
  const proposal=await membersHarness('teamProposed');await openMembers(proposal);proposal.document.querySelector('[data-room-link="proposal"]').click();await tick();await tick();assert(proposal.timeline.querySelector('[data-message="m5:proposal"]').classList.contains('focused'));
  const task=await membersHarness();await openMembers(task);task.document.querySelector('[data-message-id="turn:api-new"]').click();await tick();await tick();assert(task.timeline.querySelector('[data-message="turn:api-new"]').classList.contains('focused'));assert.equal(posts(proposal).length+posts(task).length,0);
});
test('M6 member waiting link selects that actor before the general waiting item',async()=>{
  const h=await membersHarness();const first=clone(fx.decisionMessages().low);first.id='first-other';h.f.thread.messages.splice(1,0,first);h.f.channels.channels[0].waiting=2;await h.core.refresh();await openMembers(h);h.document.querySelector('[data-room-link="waiting"][data-actor="coder-2"]').click();await tick();await tick();assert(h.timeline.querySelector('[data-message="m5:question"]').classList.contains('focused'));assert.equal(posts(h).length,0);
});
test('M6 absent actor waiting item uses the existing waiting pointer fallback',async()=>{
  const h=await membersHarness();h.f.thread.messages.find(m=>m.action).actor='coder-1';await h.core.refresh();await openMembers(h);h.document.querySelector('[data-room-link="waiting"]').click();await tick();await tick();assert(h.timeline.querySelector('[data-message="m5:question"]').classList.contains('focused'));
});
test('M6 phone links close the sheet before revealing proposal and task turns',async()=>{
  for(const [kind,selector,id] of [['teamProposed','[data-room-link="proposal"]','m5:proposal'],['teamRunning','[data-message-id="turn:api-new"]','turn:api-new']]) {const h=await membersHarness(kind,{coarse:true});await openMembers(h);assert(!h.document.querySelector('#context').hidden);h.document.querySelector(selector).click();assert(h.document.querySelector('#context').hidden);await tick();await tick();assert(h.timeline.querySelector('[data-message="'+id+'"]').classList.contains('focused'));}
});
test('M6 room links page existing history within ten reads and fall back to a session',async()=>{
  for(const kind of ['proposal','turn']){
    const f=fx.membersFixture(kind==='proposal'?'teamProposed':'teamRunning'),old=clone(f.thread),target=kind==='proposal'?'m5:proposal':'turn:api-new';f.thread.messages=f.thread.messages.filter(m=>m.id!==target);f.thread.before='target-page';let reads=0;
    const h=await harness(f.state,{thread:f.thread,channels:f.channels,respond:url=>{if(url.includes('before=target-page')){reads++;return old;}}});await openMembers(h);h.document.querySelector('[data-room-link="'+kind+'"]'+(kind==='turn'?'[data-message-id="'+target+'"]':'')).click();await tick();await tick();assert.equal(reads,1);assert(h.timeline.querySelector('[data-message="'+target+'"]').classList.contains('focused'));assert.equal(posts(h).length,0);
  }
  const f=fx.membersFixture('teamProposed');f.thread.messages=f.thread.messages.filter(m=>!m.action);f.thread.before='endless';let reads=0;const h=await harness(f.state,{thread:f.thread,channels:f.channels,respond:url=>{if(url.includes('before=')){reads++;return {...f.thread,before:'endless:'+reads};}}});await openMembers(h);h.document.querySelector('[data-room-link="proposal"]').click();for(let i=0;i<15;i++)await tick();assert.equal(reads,10);assert.equal(h.window.location.hash,'#/s/run_test');assert.equal(posts(h).length,0);
  const waiting=fx.membersFixture();waiting.thread.messages=waiting.thread.messages.filter(m=>!m.action);waiting.thread.before='waiting:older';let waitingReads=0;const w=await harness(waiting.state,{thread:waiting.thread,channels:waiting.channels,respond:url=>{if(url.includes('before=')){waitingReads++;return {...waiting.thread,before:'waiting:older:'+waitingReads};}}});await openMembers(w);const load=w.core.loadOlder;let first=true;w.core.loadOlder=async()=>{const result=await load();if(first){first=false;return false;}return result;};w.document.querySelector('[data-room-link="waiting"]').click();for(let i=0;i<15;i++)await tick();assert.equal(waitingReads,10,'a superseded paging attempt consumes the shared ten-read budget');assert.equal(posts(w).length,0);
});
test('M6 selected-session loader reads once, never polls and refetches only changed status',async()=>{
  const h=await membersHarness(),old=fx.membersFixture('teamFinished');old.state.run.id='older';old.state.agents=[{name:'old-agent',role:'coder',state:'finished'}];h.f.state.runs.push({id:'older',status:'completed',created:'2026-09-01',title:'Older team'});h.f.thread.sessions.push({...old.thread.sessions[0],id:'older'});h.f.thread.messages.unshift(fx.threadMessage('run:older','session_start','Older team',{}, {session:'older'}));h.options.respond=url=>url==='/api/state?scope=current&run=older'?old.state:undefined;
  await h.core.refresh();await openMembers(h,'older');assert.equal(detailCalls(h,'older').length,1);assert(contextText(h).includes('old-agent'));assert(!h.document.querySelector('#live-members').textContent.includes('coder-2 (Tests)'));
  for(let i=0;i<3;i++)await h.core.refresh();assert.equal(detailCalls(h,'older').length,1);h.f.state.runs.find(r=>r.id==='older').status='failed';await h.core.refresh();await tick();assert.equal(detailCalls(h,'older').length,2);await h.core.refresh();assert.equal(detailCalls(h,'older').length,2);
  h.window.location.hash='#/';h.shell.route();await openMembers(h,'older');assert.equal(detailCalls(h,'older').length,3);
});
test('M6 active session uses live data without another detail read',async()=>{
  const h=await membersHarness();await openMembers(h);const count=h.calls.filter(c=>c.url.startsWith('/api/state')).length;h.document.querySelector('#session-tab').click();h.document.querySelector('#members-tab').click();h.shell.render(h.core.getState());assert.equal(h.calls.filter(c=>c.url.startsWith('/api/state')).length,count);assert(contextText(h).includes('coder-1 (API)'));
});
test('M6 stale selected responses are dropped and reads stay single flight',async()=>{
  const h=await membersHarness(),responses={};let pending=0,max=0;
  for(const id of ['old-a','old-b']){h.f.state.runs.push({id,status:'completed',title:id,created:'2026-09-01'});h.f.thread.sessions.push(fx.threadSession(id,{mode:'team'}));h.f.thread.messages.unshift(fx.threadMessage('run:'+id,'session_start',id,{}, {session:id}));}
  h.options.respond=async url=>{const id=new URL(url,'http://test').searchParams.get('run');if(['old-a','old-b'].includes(id)){pending++;max=Math.max(max,pending);const result=await new Promise(resolve=>responses[id]=()=>resolve({...h.f.state,run:{id,mode:'team',team:{state:'single'}},agents:[{name:id,role:'coder',state:'finished'}]}));pending--;return result;}};
  await h.core.refresh();h.window.location.hash='#/s/old-a';h.shell.route();h.document.querySelector('#members-tab').click();await tick();assert(contextText(h).includes('Loading team…'));assert.equal(h.document.querySelector('#members-tab').textContent,'Team');h.window.location.hash='#/s/old-b';h.shell.route();await tick();assert.equal(detailCalls(h,'old-b').length,0);responses['old-a']();await tick();await tick();assert(!contextText(h).includes('old-a'));assert.equal(detailCalls(h,'old-b').length,1);responses['old-b']();await tick();await tick();h.document.querySelector('#members-tab').click();assert(contextText(h).includes('old-b'));assert.equal(max,1);
});
test('M6 selected read errors show server text and Retry is a GET',async()=>{
  const h=await membersHarness();h.f.state.runs.push({id:'older',status:'completed',title:'Older',created:'2026-09-01'});h.f.thread.sessions.push(fx.threadSession('older'));h.f.thread.messages.unshift(fx.threadMessage('run:older','session_start','Older',{}, {session:'older'}));let fail=true;h.options.respond=url=>url==='/api/state?scope=current&run=older'?(fail?{error:'Recorded detail unavailable'}:{...h.f.state,run:{id:'older',mode:'single'},agents:[{name:'history-agent',state:'finished'}]}):undefined;await h.core.refresh();await openMembers(h,'older');assert(contextText(h).includes('Recorded detail unavailable'));fail=false;h.document.querySelector('#retry-team').click();await tick();await tick();assert(contextText(h).includes('history-agent'));assert.equal(detailCalls(h,'older').length,2);assert.equal(posts(h).length,0);
});
test('M6 selected 401 discards memory and returns to sign-in',async()=>{
  const h=await membersHarness();h.f.state.runs.push({id:'older',status:'completed',title:'Older',created:'2026-09-01'});await h.core.refresh();h.options.unauthorizedPath='/api/state?scope=current&run=older';h.window.location.hash='#/s/older';h.shell.route();await tick();await tick();assert(!h.core.getState().authenticated);assert.equal(h.shell.members.getState().data,null);assert.equal(h.local.has('ac-dashboard-key'),false);
});
test('M6 keyed panel and rail items retain focus and scroll through recorded updates',async()=>{
  const h=await membersHarness();await openMembers(h);const link=h.document.querySelector('[data-message-id="turn:api-new"]'),context=h.document.querySelector('#context'),rail=h.document.querySelector('#rail');link.focus();context.scrollTop=140;rail.scrollTop=70;h.f.state.run.team.tasks[1].status='done';h.f.state.agents.find(a=>a.name==='coder-1').task='Next recorded task';await h.core.refresh();assert.equal(h.document.activeElement,link);assert.equal(h.document.querySelector('[data-message-id="turn:api-new"]'),link);assert.equal(context.scrollTop,140);assert.equal(rail.scrollTop,70);h.window.location.hash='#/settings';h.shell.route();const summary=h.document.querySelector('#connections > summary');summary.focus();await h.core.refresh();assert.equal(h.document.activeElement,summary);
});
test('M6 Connections display per-service symbols, labels and exact shared-lock check',async()=>{
  let release;const h=await membersHarness('connections',{post:async()=>new Promise(resolve=>release=()=>resolve({ok:true}))});h.window.location.hash='#/settings';h.shell.route();const c=h.document.querySelector('#connections');for(const value of ['✓ Ready','! Needs attention','OpenCode did not answer','A recorded connection needs attention'])assert(c.textContent.includes(value));c.open=true;h.document.querySelector('#rail-check-connections').click();await tick();assert.equal(h.core.getState().writeOwner,'connections');assert(h.document.querySelector('#send-message').disabled);assert([...h.timeline.querySelectorAll('[data-decision]')].every(n=>n.disabled));h.document.querySelector('#rail-check-connections').click();assert.deepEqual(posts(h),[{url:'/api/check',body:{}}]);release();await tick();await tick();assert.equal(h.core.getState().writeOwner,'');assert(c.open);
});
test('M6 Connections check is disabled by decisions and composer writes and shows errors',async()=>{
  for(const owner of ['decision','composer']){let release;const h=await membersHarness('teamProposed',{post:async()=>new Promise(resolve=>release=()=>resolve({ok:true}))});if(owner==='decision'){h.timeline.querySelector('[data-decision="approve_team"]').click();}else{type(h,'A note');h.composer.submit();}await tick();h.window.location.hash='#/settings';h.shell.route();assert(h.document.querySelector('#rail-check-connections').disabled);h.document.querySelector('#rail-check-connections').click();assert.equal(posts(h).length,1);release();await tick();await tick();}
  const h=await membersHarness('connections',{post:async()=>({error:'Check refused by server'})});h.window.location.hash='#/settings';h.shell.route();h.document.querySelector('#rail-check-connections').click();await tick();await tick();assert.equal(h.document.querySelector('#connections-error').textContent,'Check refused by server');assert.equal(posts(h)[0].url,'/api/check');
});
test('M6 rail paging grows the shared room cache and reports exact X/N counts',async()=>{
  const f=fx.membersHistory(),h=await harness(f.state,{thread:f.thread,channels:f.channels,respond:url=>url.includes('before=members%3Aolder')?f.older:undefined});assert.equal(h.document.querySelectorAll('#session-list a').length,30);assert.equal(h.document.querySelector('#session-count').textContent,'Showing 30 of 35 sessions');h.document.querySelector('#load-earlier-sessions').click();await tick();await tick();assert.equal(h.document.querySelectorAll('#session-list a').length,35);assert.equal(!!h.document.querySelector('#session-count'),false);assert.equal(h.core.getState().thread.sessions['history:34'].id,'history:34');assert.equal(h.document.querySelector('#load-earlier-sessions'),null);assert.equal(posts(h).length,0);
});
test('M6 keyed updates preserve every More link and focus the latest recorded task turn',async()=>{
  const h=await membersHarness();await openMembers(h);const before=[...h.document.querySelectorAll('#section-nav [data-section]')].map(a=>a.textContent);assert.equal(before.length,6);
  const button=h.document.querySelector('[data-message-id="turn:api-new"]');button.focus();h.f.state.run.team.tasks[1].steps.push('api-last');h.f.state.run.team.tasks[1].depends_on=[];h.f.thread.messages.push(fx.threadMessage('turn:api-last','turn','Recorded retry',{number:2,status:'running',files:[]}));await h.core.refresh();assert.deepEqual([...h.document.querySelectorAll('#section-nav [data-section]')].map(a=>a.textContent),before);assert.equal(h.document.activeElement,h.document.querySelector('[data-message-id="turn:api-last"]'));
});
test('M6 explicit empty or missing server agents never create live members',async()=>{
  for(const absent of [false,true]){const f=fx.membersFixture('teamProposed');if(absent)delete f.state.agents;else f.state.agents=[];const h=await harness(f.state,{thread:f.thread,channels:f.channels});await openMembers(h);assert.equal(h.document.querySelectorAll('#live-members [data-member]').length,0);assert.equal(h.document.querySelectorAll('#rail .members [data-member]').length,0);assert(contextText(h).includes('No recorded members'));assert.equal(h.document.querySelectorAll('[data-proposed]').length,2);}
});
test('M6 step transcripts, results and prompts never appear anywhere in the DOM',async()=>{
  for(const kind of ['teamProposing','teamProposed','teamUnusable','teamRunning','teamReview','teamFinished','singleMembers','connections']){const h=await membersHarness(kind);await openMembers(h);for(const sentinel of ['TRANSCRIPT-SENTINEL','RESULT-SENTINEL','PROMPT-SENTINEL'])assert(!h.document.toString().includes(sentinel),kind+sentinel);}
});

// M7 Part A: S1 must match the accepted server actionability predicate.
for(const state of ['proposed','proposing','unusable'])test('M7 S1 '+state+' is not pending in a stopping session',()=>{
  const plan=memberModel().teamFromRun({status:'awaiting_approval',stop:true,team:{state}});
  assert.equal(plan.pending,false);assert.equal(plan.expired,false);assert.equal(plan.summary,'Not decided · the session is stopping');
});
test('M7 S1 terminal proposed plans stay expired',()=>{
  for(const status of ['completed','blocked','failed','stopped','limit_reached']){const plan=memberModel().teamFromRun({status,team:{state:'proposed'}});assert.equal(plan.expired,true);assert.equal(plan.pending,false);assert.equal(plan.summary,'Not decided before the session ended');}
});
for(const kind of ['teamStopping','teamExpired'])test('M7 S1 '+kind+' labels never-approved agents and offers no room decision link',async()=>{
  const f=fx.endedPlan(kind),h=await harness(f.state,{thread:f.thread,channels:f.channels});await openMembers(h);
  assert(contextText(h).includes('Proposed team · never approved'));
  assert(contextText(h).includes(kind==='teamStopping'?'Not decided · the session is stopping':'Not decided before the session ended'));
  assert.equal(h.document.querySelector('[data-room-link="proposal"]'),null);
  assert(!h.document.querySelector('#rail').textContent.includes('Team plan pending'));
  assert.equal(h.document.querySelectorAll('#live-members [data-member]').length,1);
  assert.equal(h.document.querySelectorAll('.proposed-members [data-proposed]').length,2);
  assert(!h.document.querySelector('#live-members').textContent.includes('coder-2'));
  assert.equal(h.document.querySelectorAll('[data-decision]').length,0);assert.equal(posts(h).length,0);
});

// M7 Part B: route, shared data and read-only entry points.
async function wsHarness(kind='workspaceLive',options={}){const f=fx.workspaceFixture(kind),h=await harness(f.state,{thread:f.thread,channels:f.channels,...options});h.f=f;return h;}
async function openWorkspace(h,agent='coder-1',run='run_test'){h.window.location.hash='#/w/'+encodeURIComponent(run)+'/'+encodeURIComponent(agent);h.shell.route();await tick();await tick();}
const wsText=h=>h.document.querySelector('#workspace').textContent;
test('M7 B Workspace route selects its session and recorded agent without an extra active read',async()=>{
  const h=await wsHarness(),before=h.calls.length;await openWorkspace(h);assert.equal(h.document.querySelector('#workspace').hidden,false);assert.equal(h.core.getState().focused,'run_test');assert.equal(h.calls.length,before);assert(wsText(h).includes('coder-1 (API)'));assert(wsText(h).includes('● Working'));assert(wsText(h).includes('agent/api'));assert(wsText(h).includes('in container'));assert.equal(h.document.querySelector('#context').hidden,true);
});
test('M7 B header uses recorded researcher, role, task, since and exact classic pop-out link',async()=>{
  const h=await wsHarness();await openWorkspace(h,'researcher-1');for(const text of ['researcher','Read docs','scratch folder · no project files'])assert(wsText(h).includes(text));const classic=h.document.querySelector('#workspace [data-popout]');assert.equal(classic.getAttribute('href'),'/classic?popout=researcher-1&run=run_test');assert.equal(classic.getAttribute('target'),'_blank');assert.equal(classic.getAttribute('rel'),'noopener noreferrer');assert.equal(posts(h).length,0);
});
test('M7 B unknown session and agent have exact errors and Back without extra endpoints',async()=>{
  const h=await wsHarness();await openWorkspace(h,'not-live');assert(wsText(h).includes('No recorded agent named ‹not-live› in this session.'));assert(h.document.querySelector('#workspace [data-back-room]'));
  h.options.respond=url=>url==='/api/state?scope=current&run=missing'?{...h.f.state,run:null,agents:[]}:undefined;await openWorkspace(h,'coder-1','missing');assert(wsText(h).includes("That session is not in this project's history."));assert.equal(detailCalls(h,'missing').length,1);assert(h.calls.every(c=>['/api/state','/api/channels','/api/thread','/api/events','/api/workspace/preflight','/api/sandbox'].some(path=>c.url.startsWith(path))));
  for(const hash of ['#/w/%ZZ/coder-1','#/w/run_test/','#/w/run_test/coder-1/extra']){h.window.location.hash=hash;h.shell.route();assert.equal(h.window.location.hash,'#/');}
});
test('M7 B room, live members and tasks link into Workspace while proposed agents do not',async()=>{
  const h=await wsHarness();assert(!h.timeline.textContent.includes('Inspect in classic'));const link=h.timeline.querySelector('[data-message="turn:api-new"] a[data-workspace-link]');assert.equal(link.getAttribute('href'),'#/w/run_test/coder-1');
  await openMembers(h);assert.equal(h.document.querySelector('#live-members [data-member="hermes"] [data-workspace-link]').textContent,'Open log');assert.equal(h.document.querySelector('#live-members [data-member="coder-1"] [data-workspace-link]').textContent,'Open turn details');assert.equal(h.document.querySelector('[data-task="t2"] [data-workspace-link]').textContent,'Turn details');
  const f=fx.membersFixture('teamProposed'),p=await harness(f.state,{thread:f.thread,channels:f.channels});await openMembers(p);assert.equal(p.document.querySelectorAll('.proposed-members [data-workspace-link]').length,0);assert.equal(posts(h).length+posts(p).length,0);
});
test('M7 B Back and Escape restore the previous room route and opening focus',async()=>{
  const h=await wsHarness();await openMembers(h);const link=h.document.querySelector('#live-members [data-member="coder-1"] [data-workspace-link]');link.focus();link.click();await tick();assert.equal(h.document.querySelector('#workspace').hidden,false);h.document.querySelector('#workspace [data-back-room]').click();await tick();assert.equal(h.window.location.hash,'#/s/run_test');assert.equal(h.document.activeElement,link);
  h.window.location.hash='#/';h.shell.route();await openWorkspace(h);h.document.dispatchEvent(new h.window.Event('keydown',{bubbles:true}));const event=new h.window.Event('keydown',{bubbles:true});event.key='Escape';h.document.dispatchEvent(event);assert.equal(h.window.location.hash,'#/');assert.equal(h.document.querySelector('#workspace').hidden,true);
});
test('M7 B historical Workspace and members share exactly one guarded GET per selection',async()=>{
  const h=await wsHarness(),old=fx.workspaceFixture('workspaceHistorical');h.f.state.runs.push({id:'older',status:'completed',title:'Older team',created:'2026-09-01'});h.f.thread.sessions.push({...old.thread.sessions[0],id:'older'});h.f.thread.messages.unshift(fx.threadMessage('run:older','session_start','Older team',{}, {session:'older'}));h.options.respond=url=>url==='/api/state?scope=current&run=older'?old.state:undefined;await h.core.refresh();await openMembers(h,'older');await openWorkspace(h,'coder-1','older');assert(wsText(h).includes('Historical recorded task'));assert.equal(detailCalls(h,'older').length,1);h.document.querySelector('[data-back-room]').click();h.window.location.hash='#/s/older';h.shell.route();await tick();h.document.querySelector('#members-tab').click();assert.equal(detailCalls(h,'older').length,1);for(let i=0;i<3;i++)await h.core.refresh();assert.equal(detailCalls(h,'older').length,1);
});
test('M7 B 401 closes Workspace and clears rendered material',async()=>{
  const h=await wsHarness();await openWorkspace(h);h.options.unauthorized=true;await h.core.refresh();assert.equal(h.document.querySelector('#workspace').hidden,true);assert.equal(h.document.querySelector('#workspace').textContent,'');assert.equal(h.core.getState().authenticated,false);
});
test('M7 B waiting header returns to the room through the M6 locate path without POSTs',async()=>{
  const h=await wsHarness('workspaceLive',{coarse:true});await openWorkspace(h,'coder-2');h.document.querySelector('#workspace [data-room-link="waiting"]').click();await tick();await tick();assert.equal(h.document.querySelector('#workspace').hidden,true);assert(h.timeline.querySelector('[data-message="m5:question"]').classList.contains('focused'));assert.equal(posts(h).length,0);assert.equal(h.document.querySelector('#workspace [data-decision]'),null);
});

test('M7 B a classic-readable foreign session is outside the current room history',async()=>{
  const h=await wsHarness();h.options.respond=url=>url==='/api/state?scope=current&run=foreign'?{...h.f.state,run:{id:'foreign',project:'/tmp/foreign'},agents:[{name:'foreign-agent',state:'working'}]}:undefined;
  await openWorkspace(h,'foreign-agent','foreign');assert(wsText(h).includes("That session is not in this project's history."));assert(!wsText(h).includes('foreign-agent'));assert.equal(detailCalls(h,'foreign').length,1);assert.equal(posts(h).length,0);
});

test('M7 B Escape preserves the room Stop confirmation while a Workspace is open',async()=>{
  const h=await wsHarness();await openWorkspace(h);h.document.querySelector('[data-session-control="stop"]').click();assert(h.document.querySelector('#stop-dialog').hasAttribute('open'));const event=new h.window.Event('keydown',{bubbles:true});event.key='Escape';h.document.dispatchEvent(event);assert(!h.document.querySelector('#stop-dialog').hasAttribute('open'));assert.equal(h.document.querySelector('#workspace').hidden,false);assert.equal(posts(h).length,0);
});

const wsHelpers=()=>require(path.join(root,'workspace.js'));
async function turnsHarness(kind='workspaceLive',options={}){const f=fx.workspaceTurns(kind),h=await harness(f.state,{thread:f.thread,channels:f.channels,...options});h.f=f;return h;}
test('M7 C transcript fallback keeps activity order then result, and an array takes precedence',()=>{
  const w=wsHelpers(),step={activity:[{kind:'read',detail:'a',output:'first'},{kind:'bash',detail:'b',status:'completed'}],result:'last',tool_results:['TOOLRESULTS-SENTINEL']};
  assert.deepEqual(w.transcriptOf(step),[{type:'tool',tool:'read',status:'',summary:'a',output:'first'},{type:'tool',tool:'bash',status:'completed',summary:'b',output:''},{type:'text',text:'last'}]);
  step.transcript=[];assert.deepEqual(w.transcriptOf(step),[]);assert.deepEqual(w.transcriptOf(null),[]);
});
test('M7 C terminal filtering drops reasoning and unknown parts without reading tool_results',()=>{
  const w=wsHelpers(),entries=w.terminalEntries(fx.workspaceTurns().state.steps[1]);assert.equal(entries.length,4);assert(entries.every(e=>['tool','text'].includes(e.type)));assert(!JSON.stringify(entries).includes('REASONING-SENTINEL'));assert(!JSON.stringify(entries).includes('TOOLRESULTS-SENTINEL'));
});
test('M7 C every stage-state combination matches a table evaluated from classic',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8'),oracle=vm.createContext({});
  vm.runInContext(source.match(/const ended = new Set\([^\n]+/)[0]+source.slice(source.indexOf('function planningNext('),source.indexOf('const TOOL_SYMBOL')),oracle);
  const w=wsHelpers();let cases=0;
  for(const status of ['prepared','dispatching','running','waiting','finished','completed','failed','awaiting_approval','approved','rejected','researching','interrupted','uncertain'])for(const runStatus of ['coding','paused','interrupted','completed','blocked','failed','stopped','limit_reached'])for(const phase of ['code','verify','manager'])for(const verification of [undefined,{status:'passed'},{status:'failed'},{status:'not configured'}])for(const isLast of [false,true])for(const pending of [[],[{}]])for(const next of [false,true]){
    const run={status:runStatus,phase},step={status,verification};const expected=oracle.stageStates(run,step,isLast,pending,next);assert.deepEqual(w.stageStates(run,step,isLast,pending,next),JSON.parse(JSON.stringify(expected)));cases++;
  }
  assert.equal(cases,9984);
  for(const status of ['coding','completed','blocked','failed','stopped','limit_reached'])for(const phase of ['code','manager'])for(const steps of [[],[{verified:false}],[{verified:true}]])assert.equal(w.planningNext({status,phase},steps),oracle.planningNext({status,phase},steps));
  assert.equal(w.planningNext(null,[]),false);assert.deepEqual(w.STAGES,JSON.parse(JSON.stringify(vm.runInNewContext(source.match(/const STAGES = [^\n]+/)[0]+'STAGES'))));
});
test('M7 C turn selection filters agent, sorts number and follows Latest without mutating steps',()=>{
  const w=wsHelpers(),steps=[{id:'late',number:4},{id:'other',agent:'coder-2',number:2},{id:'early',number:1}],before=JSON.stringify(steps),turns=w.turnsFor(steps,'coder-1');assert.deepEqual(turns.map(s=>s.id),['early','late']);assert.equal(w.selectedTurn(turns).id,'late');assert.equal(w.selectedTurn(turns,'early').id,'early');turns.push({id:'new',number:5});assert.equal(w.selectedTurn(turns).id,'new');assert.equal(w.selectedTurn(turns,'early').id,'early');assert.equal(JSON.stringify(steps),before);
});
test('M7 C latest turn renders recorded text/tools, statuses, safe output and omitted entries',async()=>{
  const h=await turnsHarness();await openWorkspace(h);const terminal=h.document.querySelector('#workspace-terminal');assert.equal(terminal.getAttribute('role'),'log');assert.equal(terminal.getAttribute('aria-live'),'off');assert(wsText(h).includes('5 earlier entries were not kept'));assert(wsText(h).includes('TRANSCRIPT-SENTINEL'));assert(wsText(h).includes('$ python -m unittest'));assert(!wsText(h).includes('$ bash'));assert(wsText(h).includes('› read storage.py'));assert(wsText(h).includes('• mystery Check syntax'));for(const status of ['running','completed','error'])assert(wsText(h).includes(status));
  assert.equal(h.document.querySelector('#workspace-turn-status').textContent,'Turn 2 · active');assert(h.document.querySelector('[data-output-status="running"]').open);assert(h.document.querySelector('[data-output-status="error"]').open);assert(!h.document.querySelector('[data-output-status="completed"]').open);
  assert(wsText(h).includes('<img src=x onerror=alert(1)>'));assert.equal(h.document.querySelector('#workspace img'),null);assert.equal(h.document.querySelector('#workspace a[href="https://example.test/plain-text"]'),null);assert(!wsText(h).includes('OTHER-AGENT-TRANSCRIPT'));assert.equal(posts(h).length,0);
});
test('M7 C raw step sentinels never enter room, members or rail and close removes material',async()=>{
  const h=await turnsHarness();await openMembers(h);await openWorkspace(h);for(const selector of ['#timeline','#context','#rail'])for(const value of ['TRANSCRIPT-SENTINEL','RESULT-SENTINEL','PROMPT-SENTINEL','REASONING-SENTINEL','TOOLRESULTS-SENTINEL'])assert(!h.document.querySelector(selector).textContent.includes(value),selector+':'+value);
  for(const value of ['RESULT-SENTINEL','REASONING-SENTINEL','UNKNOWN-SENTINEL','TOOLRESULTS-SENTINEL'])assert(!wsText(h).includes(value));h.document.querySelector('#workspace [data-back-room]').click();assert.equal(wsText(h),'');
});
test('M7 C Prompt disclosure is escaped, bounded to 8000 characters and retained across reads',async()=>{
  const h=await turnsHarness();h.f.state.steps[1].prompt='<img src=x onerror=alert(1)>'+('z'.repeat(8050));await h.core.refresh();await openWorkspace(h);const prompt=h.document.querySelector('#ws-prompt');assert(!prompt.open);assert.equal(prompt.querySelector('pre').textContent,h.f.state.steps[1].prompt.slice(0,8000)+'…truncated');prompt.open=true;await h.core.refresh();assert.equal(h.document.querySelector('#ws-prompt'),prompt);assert(prompt.open);assert.equal(h.document.querySelector('#workspace img'),null);
});
test('M7 C keyed live updates preserve entry, button, output focus and disclosure state',async()=>{
  const h=await turnsHarness();await openWorkspace(h);const button=h.document.querySelector('[data-ws-turn="ws-live"]'),entry=h.document.querySelector('#ws-entry-ws-live-tool-ws-complete'),output=entry.querySelector('details');output.open=true;output.querySelector('summary').focus();h.f.state.steps[1].transcript[4].output+='\nAdded output';h.f.state.steps[1].transcript.push({type:'text',text:'Later text'});await h.core.refresh();assert.equal(h.document.querySelector('[data-ws-turn="ws-live"]'),button);assert.equal(h.document.querySelector('#ws-entry-ws-live-tool-ws-complete'),entry);assert.equal(entry.querySelector('details'),output);assert(output.open);assert.equal(h.document.activeElement,output.querySelector('summary'));assert(wsText(h).includes('Added output'));assert(wsText(h).includes('Later text'));
});
test('M7 C tools default open on running/error and respect manual state until status changes',async()=>{
  const h=await turnsHarness();await openWorkspace(h);const output=h.document.querySelector('[data-output-status="running"]');output.open=false;await h.core.refresh();assert(!output.open);h.f.state.steps[1].transcript[3].status='error';await h.core.refresh();assert(output.open);h.f.state.steps[1].transcript[3].status='completed';await h.core.refresh();assert(output.open,'Completing a tool must not close an open disclosure');output.open=false;await h.core.refresh();assert(!output.open);
});
test('M7 C latest follows output, scroll-up holds position and Jump resumes without a read',async()=>{
  const h=await turnsHarness();await openWorkspace(h);const term=h.document.querySelector('#workspace-terminal');Object.defineProperties(term,{scrollHeight:{value:900,configurable:true},clientHeight:{value:200,configurable:true}});await h.core.refresh();assert.equal(term.scrollTop,900);term.scrollTop=100;term.dispatchEvent(new h.window.Event('scroll',{bubbles:true}));assert.equal(h.shell.workspace.getState().follow,false);assert(!h.document.querySelector('#ws-jump').hidden);h.f.state.steps[1].transcript.push({type:'text',text:'Growing recorded transcript'});await h.core.refresh();assert.equal(term.scrollTop,100);const n=h.calls.length;h.document.querySelector('#ws-jump').click();assert.equal(term.scrollTop,900);assert(h.document.querySelector('#ws-jump').hidden);assert.equal(h.calls.length,n);
});
test('M7 C pinned turn keeps selection and scroll when new turns arrive until Latest',async()=>{
  const h=await turnsHarness();await openWorkspace(h);h.document.querySelector('[data-ws-turn="ws-first"]').click();const term=h.document.querySelector('#workspace-terminal');Object.defineProperties(term,{scrollHeight:{value:1000,configurable:true},clientHeight:{value:200,configurable:true}});term.scrollTop=70;h.f.state.steps.push({id:'ws-new',agent:'coder-1',number:4,title:'Next recorded turn',status:'running',transcript:[{type:'text',text:'Fourth turn'}]});await h.core.refresh();assert(wsText(h).includes('Earlier recorded turn'));assert(!wsText(h).includes('Fourth turn'));assert.equal(term.scrollTop,70);assert.equal(h.shell.workspace.getState().pinned,'ws-first');h.document.querySelector('[data-ws-latest]').click();assert(wsText(h).includes('Fourth turn'));assert.equal(h.shell.workspace.getState().pinned,'');assert.equal(term.scrollTop,1000);assert.equal(posts(h).length,0);
});
test('M7 C stages include classic symbols and actors, with actionable-only waiting count',async()=>{
  const h=await turnsHarness('workspaceReviewer');await openWorkspace(h,'reviewer-1');assert(wsText(h).includes('OpenCode · read-only · reviewer-1 (Review)'));for(const label of ['Plan','Hermes → OpenCode','AgentControl',': done',': active'])assert(wsText(h).includes(label));
  h.f.state.steps[2].status='waiting';await h.core.refresh();await openWorkspace(h,'coder-2');assert.equal(h.document.querySelector('#workspace-turn-status').textContent,'Turn 3 · waiting');assert(wsText(h).includes('! Code'));assert(wsText(h).includes('Waiting on you'));h.f.thread.messages.find(m=>m.action).action=null;await h.core.refresh();assert.equal(h.document.querySelector('#workspace-turn-status').textContent,'Turn 3 · active');
});
test('M7 C next planning state is recorded and pinned turns keep their own stages',async()=>{
  const h=await turnsHarness();h.f.state.run.phase='manager';h.f.state.steps[1].verified=true;h.f.state.steps[1].status='finished';await h.core.refresh();await openWorkspace(h);assert.equal(h.document.querySelector('#ws-stage-plan').dataset.state,'active');assert.equal(h.document.querySelector('#ws-stage-code').dataset.state,'pending');assert.equal(h.document.querySelector('#workspace-turn-status').textContent,'Turn 2 · done');h.document.querySelector('[data-ws-turn="ws-first"]').click();assert.equal(h.document.querySelector('#ws-stage-plan').dataset.state,'done');
});
test('M7 C no-turn and live no-output states retain Latest without synthetic messages',async()=>{
  const h=await turnsHarness('workspaceNoTurns');await openWorkspace(h);assert(wsText(h).includes('No turns yet.'));assert(h.document.querySelector('[data-ws-latest]'));assert.equal(h.document.querySelector('#workspace-terminal'),null);const output=await turnsHarness('workspaceNoOutput');await openWorkspace(output);assert(output.document.querySelector('#workspace-terminal').textContent.includes('No output yet.'));assert.equal(posts(h).length+posts(output).length,0);
});
test('M7 C every local Workspace button and link stays read-only, and sign-out drops output',async()=>{
  const h=await turnsHarness();await openWorkspace(h);for(const button of [...h.document.querySelectorAll('#workspace button')])button.click();for(const link of [...h.document.querySelectorAll('#workspace a')]){link.click();await tick();}assert.equal(posts(h).length,0);await openWorkspace(h);h.core.connect('',false);assert.equal(h.document.querySelector('#workspace').hidden,true);assert.equal(wsText(h),'');
});
test('M7 C Hermes must be recorded in agents rather than manufactured for Workspace routing',async()=>{
  const h=await turnsHarness();h.f.state.agents=h.f.state.agents.filter(a=>a.name!=='hermes');await h.core.refresh();await openWorkspace(h,'hermes');assert(wsText(h).includes('No recorded agent named ‹hermes› in this session.'));assert.equal(h.document.querySelector('#workspace-turns'),null);
});

async function detailsHarness(kind='workspaceLive',options={}){const f=fx.workspaceDetails(kind),h=await harness(f.state,{thread:f.thread,channels:f.channels,...options});h.f=f;return h;}
test('M7 D verification labels match classic including no command and coding failure',()=>{
  const w=wsHelpers(),source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8'),oracle=vm.runInNewContext(source.slice(source.indexOf('function verificationLabel('),source.indexOf('function fileStats('))+'verificationLabel');
  for(const step of [null,{},...['passed','failed','not configured','running','unknown'].map(status=>({verification:{status}})),{status:'failed'}])assert.equal(w.verificationLabel(step),oracle(step));
});
test('M7 D files are bounded to 50 while retaining recorded partial statistics',()=>{
  const w=wsHelpers(),evidence={file_stats:Array.from({length:53},(_,i)=>({path:'file'+i,change:'changed',added:i,removed:0,partial:i===1}))},before=JSON.stringify(evidence),files=w.fileList(evidence);assert.equal(files.items.length,50);assert.equal(files.omitted,3);assert.equal(files.items[1].partial,true);assert.equal(JSON.stringify(evidence),before);assert.deepEqual(w.fileList(null),{items:[],omitted:0});
});
test('M7 D surfaces use classic labels and raw fallback, filtered by recorded agent access',()=>{
  const w=wsHelpers(),source=fs.readFileSync(path.join(__dirname,'../workspace.js'),'utf8'),labels=vm.runInNewContext(source.match(/const SURFACE_LABEL = [^\n]+/)[0]+'SURFACE_LABEL');for(const [kind,label] of Object.entries(labels))assert.equal(w.surfaceLabel(kind),label);for(const kind of ['unknown-kind','__proto__','constructor'])assert.equal(w.surfaceLabel(kind),kind);const surfaces=fx.workspaceDetails().state.surfaces;assert.deepEqual(w.surfacesFor(surfaces,'coder-1').map(s=>s.id),['web','terminal','vm','desktop','unknown']);assert.deepEqual(w.surfacesFor(surfaces,'researcher-1').map(s=>s.id),['web']);
});
test('M7 D diff preserves classic prefixes and escapes lines rather than interpreting markup',()=>{
  const w=wsHelpers(),attack='<img src=x onerror=alert(1)>',text='@@ -1 +1 @@\n--- a/a\n+++ b/a\n-'+attack+'\n+'+attack+'\n context',html=w.diffHTML(text),{document}=parseHTML('<pre>'+html+'</pre>');assert.equal(document.querySelectorAll('img').length,0);assert.deepEqual([...document.querySelectorAll('.diff-line')].map(n=>n.textContent),text.split('\n'));assert.equal(document.querySelectorAll('.diff-heading').length,3);assert(document.querySelector('.diff-add').textContent.startsWith('+'));assert(document.querySelector('.diff-remove').textContent.startsWith('-'));
});
test('M7 D Hermes helper takes only latest 40 decisions and repairs with bounded fallback text',()=>{
  const w=wsHelpers(),events=fx.workspaceDetails().state.events,calls=w.hermesCalls(events);assert.equal(calls.length,40);assert.equal(calls[0].id,'call-3');assert.equal(calls.at(-1).id,'call-42');assert.equal(calls.at(-1).text,'code · Recorded turn 42 · Manager summary 42');assert(!JSON.stringify(calls.map(c=>c.text)).includes('REASONING-SENTINEL'));assert(!calls.some(c=>c.kind==='Hermes request'));assert.equal(w.hermesCalls([{kind:'Hermes decision',detail:'x'.repeat(6500)+'tail'}])[0].text.length,6000);
});
test('M7 D selected turn shows files, partial counts, diff truncation and failed verification',async()=>{
  const h=await detailsHarness('workspaceHistorical');await openWorkspace(h,'coder-1','older');for(const text of ['storage.py · changed +6/−1','(partial)','Preview truncated','-old storage','+new storage','Verification failed','Exit code 1'])assert(wsText(h).includes(text),text);const output=h.document.querySelector('#workspace-verification details');assert(!output.open);assert(output.textContent.includes('VERIFICATION-SENTINEL'));output.open=true;await h.core.refresh();assert(output.open);assert.equal(h.document.querySelector('#workspace img'),null);assert.equal(posts(h).length,0);
});
test('M7 D file omission and path keys survive updated evidence and preserve focused row',async()=>{
  const h=await detailsHarness();h.f.state.steps[1].evidence={file_stats:Array.from({length:52},(_,i)=>({path:'path-'+i,change:'added',added:1,removed:0}))};await h.core.refresh();await openWorkspace(h);assert.equal(h.document.querySelectorAll('#workspace-changes li').length,50);assert(wsText(h).includes('…and 2 more'));assert(!wsText(h).includes('path-50'));const row=h.document.querySelector('#ws-file-path-3');row.tabIndex=0;row.focus();h.f.state.steps[1].evidence.file_stats.reverse();h.f.state.steps[1].evidence.file_stats[48].added=8;await h.core.refresh();assert.equal(h.document.querySelector('#ws-file-path-3'),row);assert.equal(h.document.activeElement,row);assert(row.textContent.includes('+8/−0'));
});
test('M7 D live changes, empty diff and verification exit code zero are explicit recorded states',async()=>{
  const h=await detailsHarness();await openWorkspace(h);assert(wsText(h).includes('Changes appear when the turn ends.'));assert(wsText(h).includes('No captured text changes'));assert(wsText(h).includes('Not verified yet'));h.f.state.steps[1].verification={status:'passed',exit_code:0,output:'Recorded verifier success'};await h.core.refresh();assert(wsText(h).includes('Verification passed · Exit code 0'));h.f.state.steps[1].verification.status='not configured';await h.core.refresh();assert(wsText(h).includes('Review only'));
});
test('M7 D changing selected turn changes diff and verification solely from that turn',async()=>{
  const h=await detailsHarness('workspaceHistorical');await openWorkspace(h,'coder-1','older');assert(wsText(h).includes('Verification failed'));h.document.querySelector('[data-ws-turn="ws-first"]').click();assert(!wsText(h).includes('Verification failed'));assert(!wsText(h).includes('+new storage'));assert(wsText(h).includes('Not verified yet'));h.document.querySelector('[data-ws-latest]').click();assert(wsText(h).includes('+new storage'));
});
test('M7 D researcher log has question, status, bounded summary and eight plain sources',async()=>{
  const h=await detailsHarness();await openWorkspace(h,'researcher-1');assert(wsText(h).includes('Which storage format is supported?'));assert(wsText(h).includes('finished'));assert(wsText(h).includes('The researcher runs Hermes once per approved question; its report is recorded when that call ends. There is no live stream.'));assert.equal(h.document.querySelector('#workspace-research li > p:nth-child(2)').textContent.length,2000);assert.equal(h.document.querySelectorAll('.workspace-sources li').length,8);assert.equal(h.document.querySelectorAll('.workspace-sources a').length,0);assert(!wsText(h).includes('source/8'));assert.equal(h.document.querySelector('#workspace-terminal'),null);assert(!wsText(h).includes('REASONING-SENTINEL'));
});
test('M7 D Hermes log shows decisions and repairs with time and excludes requests and private fields',async()=>{
  const h=await detailsHarness();await openWorkspace(h,'hermes');assert.equal(h.document.querySelectorAll('#workspace-hermes .workspace-records > li').length,40);assert(wsText(h).includes('code · Recorded turn 42 · Manager summary 42'));assert(wsText(h).includes('Hermes JSON repaired'));assert(wsText(h).includes('Hermes runs as one call per decision.'));assert(h.document.querySelector('#workspace-hermes small').textContent);for(const sentinel of ['HERMES-REQUEST-SENTINEL','REASONING-SENTINEL','HERMES-DECISION-PROMPT-SENTINEL','TRANSCRIPT-SENTINEL'])assert(!wsText(h).includes(sentinel));assert.equal(h.document.querySelector('#workspace-turns'),null);
});
test('M7 D surfaces have metadata and one section pop-out, with no native controls or frames',async()=>{
  const h=await detailsHarness();await openWorkspace(h);for(const text of ['Storage preview','Web','Program','VM screen','Desktop','custom-surface','failed','Live view and input are in the classic pop-out for now.'])assert(wsText(h).includes(text),text);assert(!wsText(h).includes('OTHER-AGENT-SURFACE'));const section=h.document.querySelector('#workspace-surfaces');assert.equal(section.querySelectorAll('a').length,1);assert.equal(section.querySelector('a').getAttribute('href'),'/classic?popout=coder-1&run=run_test');assert.equal(section.querySelector('a').getAttribute('rel'),'noopener noreferrer');assert.equal(section.querySelector('a').getAttribute('target'),'_blank');assert.equal(section.querySelectorAll('button,img,iframe,input,textarea,form,[data-decision]').length,0);assert.equal(posts(h).length,0);assert.equal(h.calls.filter(c=>/preview|ticket|frame|surface/.test(c.url)).length,0);
});
test('M7 D no surfaces and empty Hermes/research logs use exact empty states',async()=>{
  const h=await detailsHarness();h.f.state.surfaces=[];h.f.state.events=[];h.f.state.steps=h.f.state.steps.filter(s=>s.agent!=='researcher-1');await h.core.refresh();await openWorkspace(h,'researcher-1');assert(wsText(h).includes('No questions yet.'));assert(wsText(h).includes('No surfaces for this agent.'));await openWorkspace(h,'hermes');assert(wsText(h).includes('No Hermes calls recorded yet.'));assert(wsText(h).includes('No surfaces for this agent.'));
});
test('M7 D every allowed recorded field is escaped in headers, files, diffs, logs and surfaces',async()=>{
  const h=await detailsHarness('workspaceHistorical'),attack='<img src=x onerror=alert(1)>';h.f.state.agents.find(a=>a.name==='coder-1').task=attack;h.f.state.run.workspace.agents['coder-1'].branch=attack;h.f.state.surfaces[0].title=attack;h.f.state.surfaces[0].kind=attack;h.f.state.surfaces[0].state=attack;h.f.state.steps.find(s=>s.id==='ws-research').question=attack;h.f.state.steps.find(s=>s.id==='ws-research').report.sources=[attack];h.f.state.events.at(-2).detail=JSON.stringify({action:attack,title:attack,summary:attack});await h.core.refresh();for(const agent of ['coder-1','researcher-1','hermes']){await openWorkspace(h,agent,'older');assert(wsText(h).includes(attack));assert.equal(h.document.querySelectorAll('#workspace img, #workspace iframe').length,0);}assert.equal(posts(h).length,0);
});
test('M7 D full Workspace material stays out of room/panel/rail and no independent read or input exists',async()=>{
  const h=await detailsHarness('workspaceHistorical');await openWorkspace(h,'coder-1','older');for(const selector of ['#timeline','#context','#rail'])for(const value of ['TRANSCRIPT-SENTINEL','VERIFICATION-SENTINEL','PROMPT-SENTINEL','+new storage','REASONING-SENTINEL','TOOLRESULTS-SENTINEL'])assert(!h.document.querySelector(selector).textContent.includes(value));const source=fs.readFileSync(path.join(root,'workspace.js'),'utf8');assert(!/\bfetch\s*\(|\bset(?:Timeout|Interval)\s*\(|\bcore\.(?:api|post)\s*\(/.test(source));assert.equal(h.document.querySelector('#workspace [data-decision]'),null);assert.equal(posts(h).length,0);
});

test('M7 live read that began before opening Workspace still updates its active snapshot',async()=>{
  const h=await turnsHarness();h.options.hold=true;const reading=h.core.refresh();await tick();const count=h.calls.length;await openWorkspace(h);assert.equal(h.calls.length,count);h.f.state.steps[1].transcript.push({type:'text',text:'Recorded output from the in-flight live read'});h.options.hold=false;h.options.release();await reading;assert(wsText(h).includes('Recorded output from the in-flight live read'));assert.equal(posts(h).length,0);
});

// M8 Part A: deferred corrections, with unchanged data and decision semantics.
test('M8 A Load earlier focuses the first new message, preserves its old anchor and exposes paging busy state',async()=>{
  const s=fx.threadSession('run_test',{status:'coding',ended:null}),live={session:s.id,phase:'code',status:s.status};
  const initial=fx.threadResponse([fx.threadMessage('current','goal','Current goal')],[s],'earlier',live),older=fx.threadResponse([fx.threadMessage('start','session_start',s.title),fx.threadMessage('first:new','goal','Earlier goal')],[s],'earlier:more',live);
  const h=await harness(fixture(),{thread:initial}),geo=geometry(h);geo.setScroll(100);
  const anchor=h.timeline.querySelector('[data-message="current"]');anchor.getBoundingClientRect=()=>{const top=(h.timeline.querySelector('[data-message="first:new"]')?300:100)-h.timeline.scrollTop;return {top,bottom:top+100};};
  let release;h.options.respond=async url=>{if(url.includes('before=earlier'))return new Promise(resolve=>release=()=>resolve(older));};
  const button=h.document.querySelector('#load-earlier');button.focus();button.click();await tick();
  assert.equal(h.document.querySelector('#load-earlier').getAttribute('aria-busy'),'true');assert.equal(h.document.querySelector('#load-earlier'),button);
  release();await tick();await tick();const first=h.timeline.querySelector('[data-message="first:new"]');assert.equal(h.document.activeElement,first);assert.equal(first.tabIndex,-1);assert.equal(anchor.getBoundingClientRect().top,0);assert.equal(h.document.querySelector('#load-earlier').getAttribute('aria-busy'),'false');
  const unchanged=[...h.core.getState().thread.ids];h.options.respond=url=>{if(url.includes('before='))throw Error('Older read failed');};button.focus();button.click();await tick();await tick();assert.equal(h.document.activeElement,button);assert.deepEqual([...h.core.getState().thread.ids],unchanged);assert.equal(button.getAttribute('aria-busy'),'false');assert.equal(posts(h).length,0);
});
test('M8 A partial dividers avoid undercounts and complete dividers pluralise exact counts',async()=>{
  const pages=fx.threadLong(),h=await harness(richCompleted(),{thread:pages[0]});assert.equal(h.timeline.querySelector('[data-collapse="long-1"]').textContent,'Show messages');
  h.options.respond=url=>url.includes('before=long%3A250')?pages[1]:url.includes('before=long%3A50')?pages[2]:undefined;await h.core.loadOlder();assert.equal(h.timeline.querySelector('[data-collapse="long-0"]').textContent,'Show messages');await h.core.loadOlder();assert.equal(h.timeline.querySelector('[data-collapse="long-0"]').textContent,'Show 149 messages');
  const old=fx.threadSession('old'),current=fx.threadSession(),page=fx.threadResponse([fx.threadMessage('run:old','session_start',old.title,{}, {session:old.id}),fx.threadMessage('one:old','goal','One old message',{}, {session:old.id}),fx.threadMessage('run:current','session_start',current.title)],[old,current]);
  const one=await harness(richCompleted(),{thread:page});assert.equal(one.timeline.querySelector('[data-collapse="old"]').textContent,'Show 1 message');
  page.before='older';page.messages.unshift(fx.threadMessage('older:old','note','Older boundary',{}, {session:old.id}));await one.core.refresh();assert.equal(one.timeline.querySelector('[data-collapse="old"]').textContent,'Show messages');
});
test('M8 A live fallback uses one known-stub read per existing refresh and stops at recorded terminal status',async()=>{
  const s=fx.threadSession('far',{status:'coding',ended:null}),first=fx.threadMessage('far:first','goal','First fallback goal',{}, {session:s.id}),page=fx.threadResponse([first],[s],null,{session:s.id,phase:'code',status:s.status});
  const h=await harness(fixture());h.options.respond=url=>new URL(url,'http://test').searchParams.get('session')==='far'?page:undefined;h.core.focus('far',false);await h.core.locateSession('far');
  const count=h.calls.length,timerDelays=[...h.timers.values()].map(t=>t.delay).sort();page.messages=[{id:first.id,rev:first.rev,same:true},fx.threadMessage('far:next','note','Recorded fallback update',{}, {session:s.id})];await h.core.refresh();
  const calls=h.calls.slice(count);assert.equal(calls.length,4);const read=calls.filter(c=>c.url.startsWith('/api/thread?session=far'));assert.equal(read.length,1);assert.equal(new URL(read[0].url,'http://test').searchParams.get('known'),first.id+':'+first.rev);assert.equal(h.core.getState().single.messages[first.id].text,first.text);assert(h.timeline.textContent.includes('Recorded fallback update'));assert.deepEqual([...h.timers.values()].map(t=>t.delay).sort(),timerDelays);
  s.status='completed';page.live={session:null};await h.core.refresh();assert.equal(h.core.getState().single.sessions.far.status,'completed');const terminalCount=h.calls.length;await h.core.refresh();assert.equal(h.calls.length-terminalCount,3);assert.equal(posts(h).length,0);
});
test('M8 A recorded outcome verification uses ended time or running created time without changing decisions',async()=>{
  const h=await decisionHarness('outcome'),message=h.f.thread.messages.find(m=>m.kind==='outcome');
  for(const status of ['passed','failed','running']){message.detail.verification={status,created:'2026-09-29T12:00:00Z',ended:status==='running'?null:'2026-09-30T12:00:00Z'};message.rev++;await h.core.refresh();const at=message.detail.verification.ended || message.detail.verification.created;assert(decisionCard(h,message.id).textContent.includes('Verification (on demand) · '+status+' · '+h.window.AC.model.relTime(at)));}
  assert.equal(posts(h).length,0);
});
test('M8 A rail disclosure is accurate while incomplete and disappears only at completion including paging',async()=>{
  const f=fx.membersHistory();f.channels.channels[0].sessions=40;f.older.before='members:last';const sessions=Array.from({length:5},(_,i)=>fx.threadSession('history:'+(35+i),{created:new Date(Date.UTC(2026,8,30,0,0,-35-i)).toISOString()})),last=fx.threadResponse(sessions.map(s=>fx.threadMessage('run:'+s.id,'session_start',s.title,{}, {session:s.id,at:s.created})),sessions);
  const h=await harness(f.state,{thread:f.thread,channels:f.channels,respond:url=>url.includes('before=members%3Aolder')?f.older:url.includes('before=members%3Alast')?last:undefined});assert.equal(h.document.querySelector('#session-count').textContent,'Showing 30 of 40 sessions');
  h.document.querySelector('#load-earlier-sessions').click();await tick();await tick();assert.equal(h.document.querySelector('#session-count').textContent,'Showing 35 of 40 sessions');assert.equal(h.document.querySelectorAll('#session-list a').length,35);assert.equal(h.core.getState().thread.before,'members:last');
  h.document.querySelector('#load-earlier-sessions').click();await tick();await tick();assert.equal(!!h.document.querySelector('#session-count'),false);assert.equal(h.document.querySelectorAll('#session-list a').length,40);assert.equal(h.core.getState().channels.channels[0].sessions,40);assert.equal(h.core.getState().thread.before,null);assert.equal(posts(h).length,0);
});
test('M8 A member state time is explicitly labelled since and absent when unrecorded',async()=>{
  const h=await membersHarness(),member=h.f.state.agents.find(a=>a.name==='coder-1');await openMembers(h);assert.equal(h.document.querySelector('#live-members [data-member="coder-1"] small').textContent,'since '+h.window.AC.model.relTime(member.since));delete member.since;await h.core.refresh();assert(!h.document.querySelector('#live-members [data-member="coder-1"]').textContent.includes('since '));
});
test('M8 A task button ids and plain ids reserve the same box for alignment',()=>{
  const {document}=parseHTML(require(path.join(root,'members.js')).panelHTML(fx.membersFixture('teamRunning').state)),sheet=require('cssom').parse(fs.readFileSync(path.join(root,'chat.css'),'utf8').replace(/@container\s*\([^)]*\)/g,'@media all')); // CSSOM predates container rules; browser checks their computed geometry.
  function box(node){const style={};for(const rule of sheet.cssRules)if(rule.selectorText && !rule.selectorText.includes(':') && node.matches(rule.selectorText))for(let i=0;i<rule.style.length;i++){const key=rule.style[i];style[key]=rule.style.getPropertyValue(key);}return {padding:style.padding || '0px',width:style['min-width'] || 'auto',display:style.display || 'inline',basis:style['flex-basis'] || 'auto'};}
  const plain=document.querySelector('.task-title .task-id'),button=document.querySelector('.task-title button');assert(plain && button);assert.deepEqual(box(plain),box(button));assert.notEqual(box(plain).width,'auto');
});
test('M8 A Workspace sticky context follows the recorded selected agent presence and turn',async()=>{
  const h=await turnsHarness();await openWorkspace(h);const context=()=>h.document.querySelector('#workspace > header .workspace-context');assert.equal(context().textContent,'coder-1 (API) · ● Working · Turn 2');assert.equal(context().getAttribute('title'),context().textContent);h.document.querySelector('[data-ws-turn="ws-first"]').click();assert.equal(context().textContent,'coder-1 (API) · ● Working · Turn 1');h.f.state.agents.find(a=>a.name==='coder-1').state='paused';await h.core.refresh();assert.equal(context().textContent,'coder-1 (API) · Ⅱ Paused · Turn 1');assert.equal(posts(h).length,0);
});
test('M8 A permission key facts use only the first pattern after command and file and never an empty paragraph',async()=>{
  const h=await decisionHarness('low'),message=h.f.thread.messages.find(m=>m.action);message.detail.review={};message.detail.patterns=['https://example.test/<img src=x onerror=alert(1)>','Second pattern'];message.rev++;await h.core.refresh();const card=decisionCard(h,message.id);assert.equal(card.querySelector('.decision-facts').textContent,message.detail.patterns[0]);assert.equal(card.querySelectorAll('.decision-facts img,.decision-facts a').length,0);message.detail.patterns=[];message.rev++;await h.core.refresh();assert.equal(!!decisionCard(h,message.id).querySelector('.decision-facts'),false);assert.equal(posts(h).length,0);
});

// M8 Part B: responsive contracts, independent of server state.
test('M8 B truncated room and rail titles retain the full server value',async()=>{
  const f=fx.composerFixture('active'),title='Long title '+('wide-title-'.repeat(100))+'<img src=x>';
  f.thread.sessions[0].title=title;f.state.run.title=title;f.state.runs[0].title=title;
  const channels=fx.threadChannels(f.thread,1);channels.channels[0].title=title;
  const h=await harness(f.state,{thread:f.thread,channels});
  assert.equal(h.document.querySelector('#room-header h1').title,title);assert.equal(h.document.querySelector('#room-header .heading p').title,title);
  assert.equal(h.document.querySelector('#session-list .truncate').title,title);assert.equal(h.document.querySelectorAll('#room-header img,#session-list img').length,0);assert.equal(posts(h).length,0);
});

// M8 Part C: focus behaviour, with no decision/body or server-state changes.
test('M8 C skip link is first, focuses conversation without routing and has no positive tabindex',async()=>{
  const h=await harness(),skip=h.document.querySelector('#skip-conversation'),count=h.calls.length;assert(skip);assert.equal(h.document.querySelector('body a,body input,body button'),skip);assert.equal(skip.textContent,'Skip to conversation');skip.focus();skip.click();assert.equal(h.document.activeElement,h.timeline);assert.equal(h.timeline.tabIndex,-1);assert.equal(h.window.location.hash,'#/');assert.equal(h.calls.length,count);assert.equal(h.document.querySelectorAll('[tabindex]').length,[...h.document.querySelectorAll('[tabindex]')].filter(n=>n.tabIndex<=0).length);
});
test('M8 C context tabs use roving arrows Home and End without another read or write',async()=>{
  const h=await membersHarness();await openMembers(h);const count=h.calls.length;
  for(const [keyName,selected] of [['Home','session'],['ArrowLeft','members'],['ArrowRight','session'],['End','members']]){const old=h.document.querySelector('[role="tab"][aria-selected="true"]');old.focus();key(h,keyName,{},old);assert.equal(h.document.activeElement.id,selected+'-tab');assert.equal(h.document.querySelector('#context-content').getAttribute('aria-labelledby'),selected+'-tab');for(const tab of h.document.querySelectorAll('[role="tab"]'))assert.equal(tab.tabIndex,tab.id===selected+'-tab'?0:-1);}
  assert.equal(h.calls.length,count);assert.equal(posts(h).length,0);
});
test('M8 C Settings traps focus, makes background inert and returns to its opener',async()=>{
  const h=await composerHarness('new'),opener=h.document.querySelector('#composer-settings');opener.focus();opener.click();await tick();await tick();const close=h.document.querySelector('#close-settings'),last=h.document.querySelector('#settings-fields > p a');assert(h.document.activeElement===close,'Focus should be on '+close.id);assert.equal(h.document.querySelector('#room').hasAttribute('inert'),true);last.focus();assert(key(h,'Tab',{},last).defaultPrevented);assert(h.document.activeElement===close,'Focus should be on '+close.id);key(h,'Tab',{shiftKey:true},close);assert(h.document.activeElement===last,'Focus should be on '+last.id);key(h,'Escape',{},last);assert(h.document.querySelector('#settings-sheet').hidden);assert(h.document.activeElement===opener,'Focus should be on '+opener.id);assert.equal(h.document.querySelector('#room').hasAttribute('inert'),false);assert.equal(posts(h).length,0);
});
test('M8 C Stop traps focus with Cancel first and restores the unchanged opener',async()=>{
  const h=await composerHarness('active');h.document.querySelector('#session-menu').open=true;const opener=h.document.querySelector('[data-session-control="stop"]');opener.focus();opener.click();const cancel=h.document.querySelector('#cancel-stop'),confirm=h.document.querySelector('#confirm-stop');assert(h.document.activeElement===cancel,'Focus should be on '+cancel.id);assert(h.document.querySelector('#room').hasAttribute('inert'));key(h,'Tab',{},cancel);assert(h.document.activeElement===confirm,'Focus should be on '+confirm.id);key(h,'Tab',{shiftKey:true},confirm);assert(h.document.activeElement===cancel,'Focus should be on '+cancel.id);key(h,'Escape',{},cancel);assert(h.document.activeElement===opener,'Focus should be on '+opener.id);assert(!h.document.querySelector('#room').hasAttribute('inert'));assert.equal(posts(h).length,0);
});
test('M8 C decision focus trap and Cancel restoration preserve review and confirmation semantics',async()=>{
  const h=await decisionHarness('critical'),opener=button(h,'approve');opener.focus();opener.click();const dialog=h.document.querySelector('#decision-dialog'),cancel=dialog.querySelector('[data-cancel-decision]'),confirm=dialog.querySelector('[name="confirm"]'),submit=dialog.querySelector('[data-confirm-decision]');assert(h.document.activeElement===cancel,'Focus should be on '+cancel.id);assert(h.document.querySelector('#room').hasAttribute('inert'));confirm.focus();key(h,'Tab',{shiftKey:true},confirm);assert(h.document.activeElement===submit,'Focus should be on '+submit.id);key(h,'Tab',{},submit);assert(h.document.activeElement===confirm,'Focus should be on '+confirm.id);cancel.click();assert(h.document.activeElement===opener,'Focus should be on '+opener.id);assert(!dialog.hasAttribute('open'));assert.equal(posts(h).length,0);assert.equal(h.core.getState().channels.channels[0].waiting,1);
});
test('M8 C phone rail and context sheets trap focus and restore visible openers',async()=>{
  const h=await membersHarness('teamRunning',{coarse:true}),railOpen=h.document.querySelector('#open-rail');railOpen.focus();railOpen.click();const close=h.document.querySelector('#close-rail'),last=h.document.querySelector('#refresh-folders');assert(h.document.activeElement===close,'Focus should be on '+close.id);assert(h.document.querySelector('#room').hasAttribute('inert'));last.focus();key(h,'Tab',{},last);assert(h.document.activeElement===close,'Focus should be on '+close.id);key(h,'Escape',{},close);assert.equal(h.document.activeElement.id,'open-rail');assert(!h.document.querySelector('#room').hasAttribute('inert'));
  await openMembers(h);h.document.querySelector('#close-context').click();const opener=h.document.querySelector('#open-context');opener.focus();opener.click();assert.equal(h.document.activeElement.id,'close-context');assert(h.document.querySelector('#room').hasAttribute('inert'));key(h,'Escape',{},h.document.activeElement);assert.equal(h.document.activeElement,h.document.querySelector('#open-context'));assert(h.document.querySelector('#context').hidden);assert(!h.document.querySelector('#room').hasAttribute('inert'));assert.equal(posts(h).length,0);
});
test('M8 C Workspace toolbar arrows and terminal keys navigate recorded material without requests',async()=>{
  const h=await turnsHarness();await openWorkspace(h);const count=h.calls.length,picker=h.document.querySelector('#workspace-turns');assert.equal(picker.getAttribute('role'),'toolbar');const latest=h.document.querySelector('#ws-latest');latest.focus();key(h,'Home',{},latest);assert.equal(h.document.activeElement.dataset.wsTurn,'ws-first');assert.equal(h.shell.workspace.getState().pinned,'');key(h,'ArrowRight',{},h.document.activeElement);assert.equal(h.document.activeElement.dataset.wsTurn,'ws-live');key(h,'End',{},h.document.activeElement);assert(h.document.activeElement===latest,'Focus should be on '+latest.id);assert.equal([...picker.querySelectorAll('button')].filter(n=>n.tabIndex===0).length,1);
  const terminal=h.document.querySelector('#workspace-terminal');Object.defineProperties(terminal,{scrollHeight:{configurable:true,value:1000},clientHeight:{configurable:true,value:200}});terminal.scrollTop=500;terminal.focus();key(h,'Home',{},terminal);assert.equal(terminal.scrollTop,0);assert(!h.document.querySelector('#ws-jump').hidden);key(h,'ArrowDown',{},terminal);assert(terminal.scrollTop>0 && terminal.scrollTop<100);const at=terminal.scrollTop;key(h,'PageDown',{},terminal);assert.equal(terminal.scrollTop,at+200);key(h,'PageUp',{},terminal);assert.equal(terminal.scrollTop,at);key(h,'End',{},terminal);assert.equal(terminal.scrollTop,800);assert.equal(h.calls.length,count);assert.equal(posts(h).length,0);assert.equal(terminal.getAttribute('aria-live'),'off');
});
test('M8 C Workspace Escape focuses its recorded session when the opening link vanished',async()=>{
  const h=await turnsHarness(),opener=h.timeline.querySelector('[data-workspace-link]');opener.focus();opener.click();await tick();await tick();opener.remove();key(h,'Escape',{},h.document.querySelector('[data-back-room]'));assert.equal(h.document.activeElement.dataset.key,'divider:run_test');assert(h.document.querySelector('#workspace').hidden);assert.equal(posts(h).length,0);
});

test('M8 D connection and waiting announcements retain nodes and announce only changed server values',async()=>{
  const h=await decisionHarness('low'),live=h.document.querySelector('#live'),waiting=h.document.querySelector('#waiting-live');assert(waiting,'A dedicated polite waiting announcement is required');assert.equal(live.getAttribute('aria-live'),'polite');assert.equal(waiting.getAttribute('aria-live'),'polite');const first=live.firstChild,waitText=waiting.firstChild;await h.core.refresh();assert(h.document.querySelector('#live')===live);assert(live.firstChild===first);assert(waiting.firstChild===waitText);assert.equal(waiting.textContent,'1 waiting for you');h.f.channels.channels[0].waiting=2;await h.core.refresh();assert.equal(waiting.textContent,'2 waiting for you');assert(waiting.firstChild!==waitText);assert.equal(h.document.querySelectorAll('#live').length,1);h.shell.render({...h.core.getState(),live:'Connected'});assert.equal(live.textContent,'Connected');const changed=live.firstChild;h.shell.render({...h.core.getState(),live:'Connected'});assert(live.firstChild===changed);assert.equal(posts(h).length,0);
});
test('M8 D decorative state symbols are hidden while recorded labels and list semantics remain',async()=>{
  const h=await membersHarness('teamRunning');await openMembers(h);assert.equal(h.document.querySelector('#session-list').getAttribute('role'),'list');assert.equal(h.document.querySelector('#thread-items').getAttribute('role'),'list');assert(h.document.querySelector('#waiting-pointer [aria-hidden="true"]'));assert(h.document.querySelector('#live-members [aria-hidden="true"]'));assert(h.document.querySelector('.task-graph [aria-hidden="true"]'));assert.equal(h.document.querySelector('#context h2').textContent,'Members');assert(h.timeline.querySelector('[data-message] h2'));assert.equal(posts(h).length,0);
});
test('M8 D all token text, boundary and focus colour contrasts meet their measured thresholds',()=>{
  const ratios=fx.contrastReport(fs.readFileSync(path.join(root,'tokens.css'),'utf8'));assert.equal(ratios.length,26);const failures=ratios.filter(v=>v.ratio<v.minimum);assert.deepEqual(failures,[]);
});
test('M8 D sign-in protects the shared key from automatic completion, capitals and spelling',async()=>{
  const h=await harness(fixture(),{key:false}),field=h.document.querySelector('#dashboard-key');assert.equal(field.getAttribute('autocomplete'),'off');assert.equal(field.getAttribute('autocapitalize'),'off');assert.equal(field.getAttribute('spellcheck'),'false');assert.equal(field.type,'password');assert.equal(h.local.size,0);
});
test('M8 D singular rail counts use session without changing counts or pagination',()=>{
  assert.equal(model.railSessions({runs:[]},null,1).note,'Showing 0 of 1 session');assert.equal(model.railSessions({runs:[]},null,2).note,'Showing 0 of 2 sessions');
});

test('M9 N1 cached sessions exceeding the server total do not show an incomplete-history disclosure',async()=>{
  const state=fixture(),channels=fx.threadChannels(fx.threadActive(),0);
  state.runs=[{...state.run,id:'live-project-session'}];channels.channels[0].sessions=1;
  const h=await harness(state,{channels}),snapshot=h.core.getState(),ids=[...h.document.querySelectorAll('#session-list a')].map(a=>a.getAttribute('href'));
  assert.equal(ids.length,2);assert(ids.includes('#/s/live-project-session'));assert(ids.includes('#/s/run_test'));
  assert.equal(snapshot.channels.channels[0].sessions,1);assert.equal(snapshot.thread.before,null);
  assert.equal(!!h.document.querySelector('#session-count'),false);
  assert.equal(!!h.document.querySelector('#load-earlier-sessions'),false);assert.equal(posts(h).length,0);
});

test('M8 E empty final history page retains button focus and cannot trigger another read',async()=>{
  const pages=fx.threadLong(),h=await harness(richCompleted(),{thread:pages[0],respond:url=>url.includes('before=')?{...pages[1],messages:[],before:null}:undefined}),button=h.document.querySelector('#load-earlier'),ids=[...h.core.getState().thread.ids];button.focus();button.click();await tick();await tick();assert(button.isConnected,'An empty page must retain its focus target');assert(h.document.activeElement===button,'Focus stays on the original paging control');assert.equal(button.getAttribute('aria-busy'),'false');assert.equal(button.getAttribute('aria-disabled'),'true');assert.equal(h.core.getState().thread.before,null);assert.deepEqual([...h.core.getState().thread.ids],ids);const reads=h.calls.length;button.click();await tick();assert.equal(h.calls.length,reads);h.document.querySelector('#composer').focus();h.options.respond=url=>url.startsWith('/api/thread')?{...pages[0],before:null}:undefined;await h.core.refresh();assert.equal(!!h.document.querySelector('#load-earlier'),false);assert.equal(posts(h).length,0);
});


test('M9.1 A visual viewport resize and scroll project height and scale-gated top',async()=>{
  const vv=new EventTarget();Object.assign(vv,{width:390,height:844,offsetTop:0,offsetLeft:0,scale:1});
  const h=await harness(fixture(),{visualViewport:vv}),style=h.document.documentElement.style;
  assert.equal(style.getPropertyValue('--viewport-height'),'844px');assert.equal(style.getPropertyValue('--viewport-top'),'0px');
  vv.height=480;vv.offsetTop=260;vv.dispatchEvent(new Event('resize'));
  assert.equal(style.getPropertyValue('--viewport-height'),'480px');assert.equal(style.getPropertyValue('--viewport-top'),'260px');
  vv.offsetTop=180;vv.dispatchEvent(new Event('scroll'));assert.equal(style.getPropertyValue('--viewport-top'),'180px');
  vv.height=240;vv.scale=2;vv.offsetTop=300;vv.dispatchEvent(new Event('scroll'));assert.equal(style.getPropertyValue('--viewport-height'),'480px');assert.equal(style.getPropertyValue('--viewport-top'),'180px');
  vv.scale=1.005;vv.dispatchEvent(new Event('resize'));assert.equal(style.getPropertyValue('--viewport-top'),'300px');
  vv.height=844;vv.scale=1;vv.offsetTop=0;vv.dispatchEvent(new Event('resize'));assert.equal(style.getPropertyValue('--viewport-height'),'844px');assert.equal(style.getPropertyValue('--viewport-top'),'0px');assert.equal(posts(h).length,0);
});
test('M9.1 A viewport changes preserve following newest and a scrolled-up position',async()=>{
  const vv=new EventTarget();Object.assign(vv,{height:844,offsetTop:0,scale:1});const h=await harness(fixture(),{visualViewport:vv}),node=h.timeline;
  let height=400,top=600;Object.defineProperties(node,{scrollHeight:{value:1000,configurable:true},clientHeight:{get:()=>height,configurable:true},scrollTop:{get:()=>top,set:v=>top=Math.min(v,1000-height),configurable:true}});
  // Applying the CSS variable forces a smaller viewport in the browser; simulate that layout here.
  let nextHeight=480;Object.defineProperty(vv,'height',{get(){height=nextHeight-200;return nextHeight;},configurable:true});
  vv.dispatchEvent(new Event('resize'));assert.equal(top,720,'Following keeps the newest message visible');
  top=120;nextHeight=400;vv.dispatchEvent(new Event('resize'));assert.equal(top,120,'Scrolled-up history must not jump to newest');assert.equal(posts(h).length,0);
});
test('M9.1 A missing visualViewport leaves existing layout fallbacks untouched',async()=>{
  const h=await harness();assert.equal(h.document.documentElement.style.getPropertyValue('--viewport-height'),'');assert.equal(h.document.documentElement.style.getPropertyValue('--viewport-top'),'');assert.equal(posts(h).length,0);
});
test('M9.1 A viewport meta enables keyboard layout resize while preserving user zoom',async()=>{
  const h=await harness(),meta=h.document.querySelector('meta[name="viewport"]').content;
  assert.match(meta,/interactive-widget=resizes-content/);assert(!/maximum-scale|user-scalable/.test(meta));
});


test('M9.1 B rail waiting is always findable and exactly matches channel counts',async()=>{
 const h=await decisionHarness('critical');for(const count of [0,1,2]){h.f.channels.channels[0].waiting=count;await h.core.refresh();const line=h.document.querySelector('#rail-waiting');assert(line,'Waiting line remains present');assert.equal(line.textContent,count?'! '+count+' waiting for you':'Nothing is waiting for you');assert.equal(!!line.querySelector('a'),count>0);assert.equal(h.core.getState().channels.channels[0].waiting,count);}assert.equal(h.document.querySelectorAll('#rail [data-decision]').length,0);assert.equal(posts(h).length,0);
});
test('M9.1 B rail waiting uses locateWaiting and reveals the room after closing the phone drawer',async()=>{
 const h=await decisionHarness('critical',{coarse:true});let located=0;h.core.locateWaiting=async()=>{located++;return h.f.thread.messages.find(m=>m.action).id;};h.document.querySelector('#open-rail').click();const link=h.document.querySelector('#rail-waiting a');assert(link);link.click();await tick();assert.equal(located,1);assert(!h.document.querySelector('#app').classList.contains('rail-open'));assert(h.timeline.querySelector('.focused[data-message]'));assert.equal(posts(h).length,0);
});
test('M9.1 B each turn has one visible summary Workspace link with its exact route',async()=>{
 const h=await harness(richCompleted());for(const turn of h.publicThread.messages.filter(m=>m.kind==='turn')){const card=h.timeline.querySelector('[data-message="'+turn.id+'"]'),links=card.querySelectorAll('[data-workspace-link]');assert.equal(links.length,1);assert(!links[0].closest('details'),'Workspace link must be outside Details');assert.equal(links[0].getAttribute('href'),'#/w/'+encodeURIComponent(turn.session)+'/'+encodeURIComponent(turn.refs.agent || turn.actor));assert.equal(links[0].textContent,'Open turn details');}assert.equal(posts(h).length,0);
});
test('M9.1 B rail and session menu link only the active recorded members to their Workspaces',async()=>{
 const h=await membersHarness('teamRunning'),run=h.f.state.run.id;for(const member of h.f.state.agents){const href='#/w/'+encodeURIComponent(run)+'/'+encodeURIComponent(member.name),rail=h.document.querySelector('#rail [data-member="'+member.name+'"] [data-workspace-link]'),menu=[...h.document.querySelectorAll('#session-menu [data-workspace-link]')].find(a=>a.getAttribute('href')===href);assert(rail && menu,member.name+' must have both entry links');assert.equal(rail.getAttribute('href'),href);assert.equal(rail.textContent,member.name==='hermes'?'Open log':'Open turn details');}assert.match(h.document.querySelector('#session-menu').textContent,/Turn details/);assert(!h.document.querySelector('#rail').textContent.includes('youOpen'));assert.equal(h.document.querySelectorAll('#rail [data-decision],#session-menu [data-decision]').length,0);assert.equal(posts(h).length,0);
});
test('M9.1 B proposed-only, stopping and never-approved expired agents get no entry links',async()=>{
 for(const name of ['teamProposed','teamStopping','teamExpired']){const f=name==='teamProposed'?fx.membersFixture(name):fx.endedPlan(name),h=await harness(f.state,{thread:f.thread,channels:f.channels});assert(h.document.querySelector('#rail-waiting'));for(const agent of ['coder-1','coder-2'])assert.equal(h.document.querySelectorAll('#rail a[href$="/'+agent+'"],#session-menu a[href$="/'+agent+'"]').length,0);await openMembers(h);assert.equal(h.document.querySelectorAll('.proposed-members [data-workspace-link]').length,0);assert.equal(posts(h).length,0);}
});
test('M9.1 B empty and quiet rooms explain the existing decision cards without another decision surface',async()=>{
 const guidance='Approvals and questions from agents appear here as cards, with a "waiting for you" bar above the message box.';
 for(const state of [fx.empty(),richCompleted()]){const h=await harness(state);assert(h.timeline.textContent.includes(guidance));assert.equal(h.document.querySelectorAll('.room-guidance [data-decision],.room-guidance button,.room-guidance a').length,0);assert.equal(posts(h).length,0);}
});
test('M9.1 B Workspace navigation from the drawer restores its visible opening link without a write',async()=>{
 const h=await membersHarness('teamRunning',{coarse:true});h.document.querySelector('#open-rail').click();await tick();await tick();const opener=h.document.querySelector('#rail [data-member="coder-1"] [data-workspace-link]');assert(opener);opener.focus();const n=h.calls.length;opener.click();await tick();assert.equal(h.window.location.hash,'#/w/run_test/coder-1');assert(!h.document.querySelector('#app').classList.contains('rail-open'));h.document.querySelector('[data-back-room]').click();await tick();assert(h.document.querySelector('#app').classList.contains('rail-open'));assert(h.document.activeElement===opener);assert.equal(h.calls.length,n);assert.equal(posts(h).length,0);
});

test('M9.1a F2 pinch shrinking freezes both viewport variables and composer sizing until unzoomed',async()=>{
 const vv=new EventTarget();Object.assign(vv,{height:480,offsetTop:80,scale:1});const h=await harness(fixture(),{visualViewport:vv}),style=h.document.documentElement.style,input=h.document.querySelector('#composer');Object.defineProperty(input,'scrollHeight',{value:400,configurable:true});input.value='A multiline draft';input.dispatchEvent(new h.window.Event('input',{bubbles:true}));const inputHeight=input.style.height;
 vv.height=480/2;vv.scale=2;vv.offsetTop=300;vv.dispatchEvent(new Event('resize'));vv.dispatchEvent(new Event('scroll'));assert.equal(style.getPropertyValue('--viewport-height'),'480px');assert.equal(style.getPropertyValue('--viewport-top'),'80px');input.dispatchEvent(new h.window.Event('input',{bubbles:true}));assert.equal(input.style.height,inputHeight,'Editing while zoomed must not use the smaller visible height');
 vv.height=844;vv.scale=1;vv.offsetTop=0;vv.dispatchEvent(new Event('resize'));assert.equal(style.getPropertyValue('--viewport-height'),'844px');assert.equal(style.getPropertyValue('--viewport-top'),'0px');assert.equal(posts(h).length,0);
});
test('M9.1a F3 Back retains the menu opener through subsequent recorded-state renders',async()=>{
 const h=await membersHarness('teamRunning',{coarse:true});h.document.querySelector('#session-menu').open=true;const opener=h.document.querySelector('#menu-workspace-hermes');opener.focus();opener.click();await tick();h.document.querySelector('[data-back-room]').click();await tick();const returning=h.document.querySelector('#menu-workspace-hermes');assert(h.document.activeElement===returning);await h.core.refresh();assert(returning.isConnected,'A refresh must retain the actual focused menu entry');assert(h.document.activeElement===returning);assert(returning===opener);assert(h.document.querySelector('#session-menu').open);assert.equal(posts(h).length,0);
});
test('M9.1a F3 a closed menu or removed Workspace entry returns focus to the visible menu summary',async()=>{
 for(const missing of [false,true]){const h=await membersHarness('teamRunning',{coarse:true});h.document.querySelector('#session-menu').open=true;const opener=h.document.querySelector('#menu-workspace-hermes');opener.focus();opener.click();await tick();h.document.querySelector('#session-menu').open=missing;if(missing){h.f.state.agents=h.f.state.agents.filter(a=>a.name!=='hermes');await h.core.refresh();assert.equal(h.document.querySelector('#menu-workspace-hermes'),null);}h.document.querySelector('[data-back-room]').click();await tick();const summary=h.document.querySelector('#session-menu > summary');assert(summary.isConnected);assert(h.document.activeElement===summary,'Return to the available menu summary, never a hidden/detached entry or session fallback');assert.equal(h.document.querySelector('#session-menu').open,missing);assert.equal(posts(h).length,0);}
});
test('M9.1a F3 returning to a selected session preserves its previously closed context sheet',async()=>{
 const f=fx.membersFixture('teamRunning'),old=fx.threadSession('run_old',{status:'completed',created:'2026-09-27T10:00:00Z'});f.state.runs.push({...old,parent_run:null});f.thread.sessions.unshift(old);f.thread.messages.unshift(fx.threadMessage('run:run_old','session_start',old.title,{}, {session:'run_old',at:old.created}));f.channels.channels[0].sessions=2;const h=await harness(f.state,{thread:f.thread,channels:f.channels,coarse:true,hash:'#/s/run_old'});h.shell.setContext(false);assert(h.document.querySelector('#context').hidden);h.document.querySelector('#session-menu').open=true;const opener=h.document.querySelector('#session-menu [data-workspace-link]');assert(opener);opener.focus();opener.click();await tick();h.document.querySelector('[data-back-room]').click();await tick();assert.equal(h.window.location.hash,'#/s/run_old');assert(h.document.querySelector('#context').hidden,'Back must not open a previously closed modal context');assert.equal(h.local.get('acx-context-open'),'false');assert.equal(posts(h).length,0);
});


// N1: shell, honest placeholders and the only two newly authorised writes.
function section(h,name){h.window.location.hash='#/'+name;h.shell.route();}
test('N1 six icon-labelled navigation items, routes, AC and sign-in avatar',async()=>{
 const h=await harness();for(const id of ['section-nav','bottom-nav'])assert.deepEqual([...h.document.querySelectorAll('#'+id+' [data-section]')].map(n=>n.dataset.section),['primary','agents','projects','workspace','skills','settings']);
 for(const name of ['primary','agents','projects','workspace','skills','settings']){section(h,name);await tick();for(const id of ['section-nav','bottom-nav']){const selected=h.document.querySelector('#'+id+' [aria-current="page"]');assert.equal(selected.dataset.section,name);assert(selected.querySelector('svg'));assert(selected.querySelector('span'));}}
 h.document.querySelector('#ac-mark').click();h.shell.route();assert.equal(h.window.location.hash,'#/primary');h.document.querySelector('#key-avatar').click();assert.equal(h.window.location.hash,'#/settings');assert(h.document.querySelector('#forget-key'));section(h,'unknown');assert.equal(h.window.location.hash,'#/');
});
test('N1 unavailable sections make no requests and create no sample data or agent messages',async()=>{
 const h=await harness(),before=h.calls.length;
 for(const name of ['primary','agents','workspace','settings']){section(h,name);if(name==='settings')h.document.querySelector('[data-setting="Memory"]').click();await tick();const stage=h.document.querySelector('#section-stage');assert.equal(stage.querySelectorAll('.message,[data-message]').length,0);assert.match(stage.textContent,/available yet/i);assert.equal(h.calls.length,before);}
 assert.equal(h.document.querySelectorAll('.memory-scope').length,3);for(const forbidden of ['Grok','Atlas','Codex','Muse','Sentinel','Parking lot model','Hermes local'])assert(!h.document.body.textContent.includes(forbidden));
 section(h,'primary');const input=h.document.querySelector('#primary-composer');assert(input.disabled);assert.equal(input.getAttribute('placeholder'),'Message the primary agent');assert.equal(input.getAttribute('aria-describedby'),'primary-reason');assert.equal(h.document.querySelectorAll('#section-stage .target-chip').length,0);
 section(h,'agents');assert.equal(h.document.querySelector('#panel-search'),null);assert.match(h.document.querySelector('#section-stage').textContent,/Direct conversations: Not available yet/);assert.equal(posts(h).length,0);
});
test('N1 section switching preserves room scroll focus and never reads the thread',async()=>{
 const h=await harness(),input=h.document.querySelector('#composer');input.focus();h.timeline.scrollTop=127;const before=h.calls.filter(c=>c.url.startsWith('/api/thread')).length;section(h,'primary');section(h,'workspace');section(h,'projects');assert.equal(h.document.activeElement,input);assert.equal(h.timeline.scrollTop,127);assert.equal(h.calls.filter(c=>c.url.startsWith('/api/thread')).length,before);
});
test('N1 selected-session focus survives section return without scheduled refresh',async()=>{const h=await harness(richActive(),{hash:'#/s/run_test'});await h.runTimers(0);const before=h.calls.filter(c=>c.url.startsWith('/api/thread')).length;section(h,'primary');section(h,'projects');await h.runTimers(0);assert.equal(h.core.getState().focused,'run_test');assert.equal(h.calls.filter(c=>c.url.startsWith('/api/thread')).length,before);});
test('N1 real skill library only, hostile values escaped, descriptions available and search local',async()=>{
 const attack='<img src=x onerror=alert(1)>',h=await harness(fixture(),{skills:{library_path:'/tmp/'+attack,library:[{name:attack,description:'\u202E'+attack+'x'.repeat(5000),risk:'sensitive',reasons:[attack],trusted:true,error:attack},{name:'quiet',description:'Small',risk:'low'}],installs:[{name:'PRIVATE-INSTALL'}],log:[{name:'PRIVATE-LOG'}]}});
 section(h,'skills');await tick();await tick();assert.equal(h.calls.filter(c=>c.url==='/api/skills').length,1);assert.equal(h.document.querySelectorAll('img').length,0);assert.equal(h.document.querySelectorAll('.skill-card').length,2);assert(h.document.querySelector('#skill-card-0').textContent.includes('x'.repeat(5000)));assert(!h.document.body.textContent.includes('PRIVATE-INSTALL'));assert(!h.document.body.textContent.includes('PRIVATE-LOG'));
 const before=h.calls.length,input=h.document.querySelector('#panel-search');input.value='quiet';input.dispatchEvent(new h.window.Event('input',{bubbles:true}));assert(h.document.querySelector('[data-skill-card="0"]').hidden);assert(!h.document.querySelector('[data-skill-card="1"]').hidden);assert.equal(h.calls.length,before);h.document.querySelector('[data-skill-card="1"]').click();assert.equal(h.document.activeElement.id,'skill-card-1');assert.equal(posts(h).length,0);
});
async function folders(h){h.document.querySelector('#open-rail').click();await tick();await tick();}
test('N1 Projects current pinned, escaped browse, breadcrumb requests and client-only search',async()=>{
 const attack='<img src=x onerror=alert(1)>',h=await harness(fixture(),{browse:{root:'/tmp',path:'/tmp',parent:null,entries:[{name:attack,path:'/tmp/'+attack,git:false},{name:'safe',path:'/tmp/safe',git:true}]}});await folders(h);assert.equal(h.document.querySelectorAll('#project-folders img').length,0);assert(h.document.querySelector('#current-project'));assert.match(h.document.querySelector('#project-folders').textContent,/Team sessions need git/);const before=h.calls.length,input=h.document.querySelector('#panel-search');input.value='safe';input.dispatchEvent(new h.window.Event('input',{bubbles:true}));assert(h.document.querySelector('[data-select-project="0"]').parentElement.hidden);assert.equal(h.calls.length,before);h.document.querySelector('[data-browse-path="/tmp/safe"]').click();await tick();assert(h.calls.some(c=>c.url==='/api/projects/browse?path=%2Ftmp%2Fsafe'));
});
test('N1 project Switch confirms exact path once and preserves server refusal verbatim',async()=>{
 let release;const h=await harness(fixture(),{browse:{root:'/tmp',path:'/tmp',entries:[{name:'safe',path:'/tmp/safe',git:true}]},post:async()=>new Promise(resolve=>release=()=>resolve({error:'Active session: cannot switch <now>.'}))});await folders(h);h.document.querySelector('[data-select-project="0"]').click();assert.equal(posts(h).length,0);assert.match(h.document.querySelector('#project-dialog').textContent,/Switch to safe\?/);assert.match(h.document.querySelector('#project-dialog').textContent,/sessions stay in its history/);h.document.querySelector('#confirm-project').click();h.document.querySelector('#confirm-project').click();await tick();assert.deepEqual(posts(h),[{url:'/api/projects/select',body:{path:'/tmp/safe'}}]);assert.equal(h.core.getState().writeOwner,'project');release();await tick();await tick();assert.equal(h.document.querySelector('#project-dialog-error').textContent,'Active session: cannot switch <now>.');assert(h.document.querySelector('#project-dialog').hasAttribute('open'));assert.equal(h.document.querySelectorAll('#project-dialog img').length,0);
});
test('N1 Create required name, read-only derived directory and exactly one request under lock',async()=>{
 let release;const h=await harness(fixture(),{post:async()=>new Promise(resolve=>release=()=>resolve({error:'Already exists.'}))});await folders(h);h.document.querySelector('#create-project').click();h.document.querySelector('#confirm-project').click();assert.equal(posts(h).length,0);const input=h.document.querySelector('#project-name');input.value='new-project';input.dispatchEvent(new h.window.Event('input',{bubbles:true}));const directory=h.document.querySelector('#project-directory');assert(directory.hasAttribute('readonly'));assert.equal(directory.value,'/tmp/new-project');h.document.querySelector('#confirm-project').click();h.document.querySelector('#confirm-project').click();await tick();assert.deepEqual(posts(h),[{url:'/api/projects/create',body:{name:'new-project'}}]);release();await tick();await tick();assert.equal(h.document.querySelector('#project-dialog-error').textContent,'Already exists.');
});
for(const kind of ['create','select'])test('N1 '+kind+' respects the existing writeOwner',async()=>{
 const h=await harness(fixture(),{browse:{root:'/tmp',entries:[{name:'safe',path:'/tmp/safe',git:true}]}});await folders(h);h.document.querySelector(kind==='create'?'#create-project':'[data-select-project="0"]').click();if(kind==='create')h.document.querySelector('#project-name').value='new';assert(h.core.beginWrite('decision'));h.document.querySelector('#confirm-project').click();await tick();assert.equal(posts(h).length,0);assert.equal(h.core.getState().writeOwner,'decision');h.core.endWrite('decision');
});
test('N1 waiting badges equal channel count in every section and locate the actionable card',async()=>{
 const h=await decisionHarness('critical');let located=0;h.core.locateWaiting=async()=>{located++;return h.f.thread.messages.find(m=>m.action).id;};for(const name of ['primary','agents','projects','workspace','skills','settings']){section(h,name);await tick();assert.equal(h.document.querySelectorAll('[data-locate-waiting]').length,2);for(const button of h.document.querySelectorAll('[data-locate-waiting]'))assert.equal(button.getAttribute('aria-label'),'Projects, 1 waiting for you');}h.document.querySelector('[data-locate-waiting]').click();await tick();assert.equal(h.window.location.hash,'#/');assert.equal(located,1);assert(!h.document.querySelector('#room').hidden);assert(h.timeline.querySelector('.focused[data-message]'));assert.equal(posts(h).length,0);
});
test('N1 Forget confirmation clears both key stores, closes streams and shows sign-in without POST',async()=>{
 const h=await harness(fixture(),{stream:true,session:{'ac-dashboard-key':'test-key'}});section(h,'settings');h.document.querySelector('[data-setting="Sign-in"]').click();h.document.querySelector('#forget-key').click();assert(h.core.getState().authenticated);h.document.querySelector('#confirm-project').click();assert(!h.core.getState().authenticated);assert(!h.local.has('ac-dashboard-key'));assert(!h.session.has('ac-dashboard-key'));assert(!h.document.querySelector('#sign-in').hidden);assert(h.document.querySelector('#app').hidden);assert(h.calls.find(c=>c.url==='/api/events').request.signal.aborted);assert.equal(posts(h).length,0);
});
test('N1 composer has one static Team chip and retains its existing target, mentions and slash parser',async()=>{
 const h=await harness();assert.equal(h.document.querySelector('#team-chip').textContent,'Team');assert.equal(h.document.querySelectorAll('#composer-host [data-member]').length,0);assert(h.document.querySelector('#composer-target'));assert.equal(h.window.AC.composer.parseSlash('/verify').command,'verify');assert(h.window.AC.composer.parseMention('@coder-1 note',h.core.getState().state.agents));
});
test('N1 section reads serialize with refresh and do not become room polling',async()=>{
 const h=await harness();let release;h.options.respond=async url=>url==='/api/skills'?await new Promise(resolve=>release=()=>resolve({library_path:'/tmp/skills',library:[]})):undefined;section(h,'skills');await tick();const reads=h.calls.filter(c=>c.url.startsWith('/api/state')).length,refresh=h.core.refresh();await tick();assert.equal(h.calls.filter(c=>c.url.startsWith('/api/state')).length,reads);release();await refresh;assert.equal(h.calls.filter(c=>c.url==='/api/skills').length,1);assert.equal(h.calls.filter(c=>c.url.startsWith('/api/state')).length,reads+1);section(h,'projects');await h.core.refresh();assert.equal(h.calls.filter(c=>c.url==='/api/skills').length,1);
});
test('N1 keyboard baseline hides the phone bar with both viewports shrinking and resets on orientation',async()=>{
 const vv=new EventTarget();Object.assign(vv,{width:390,height:844,offsetTop:0,scale:1});const h=await harness(fixture(),{visualViewport:vv}),app=h.document.querySelector('#app');h.window.innerHeight=480;vv.height=480;vv.dispatchEvent(new Event('resize'));assert(app.classList.contains('keyboard-open'));vv.height=240;vv.scale=2;vv.dispatchEvent(new Event('resize'));assert(app.classList.contains('keyboard-open'));vv.scale=1;vv.height=844;h.window.innerHeight=844;vv.dispatchEvent(new Event('resize'));assert(!app.classList.contains('keyboard-open'));h.window.innerHeight=390;vv.width=844;vv.height=390;vv.dispatchEvent(new Event('resize'));assert(!app.classList.contains('keyboard-open'));assert.equal(posts(h).length,0);
});
test('N1 project confirmation traps focus, Escape restores its live panel opener and writes nothing',async()=>{
 const h=await harness(fixture(),{coarse:true});await folders(h);const opener=h.document.querySelector('#create-project');opener.focus();opener.click();const dialog=h.document.querySelector('#project-dialog'),cancel=dialog.querySelector('[data-cancel-project]');assert(h.document.activeElement===cancel);const first=dialog.querySelector('#project-name');first.focus();key(h,'Tab',{shiftKey:true},first);assert(h.document.activeElement===cancel);key(h,'Escape',{},cancel);assert(!dialog.hasAttribute('open'));assert(h.document.activeElement===opener,'Actual focus '+h.document.activeElement?.id+' connected '+opener.isConnected+' open '+h.document.querySelector('#app').className);assert.equal(posts(h).length,0);
});
test('N1 skip link targets visible section content without routing or fetching',async()=>{const h=await harness();for(const name of ['primary','agents','workspace','settings']){section(h,name);const reads=h.calls.length;h.document.querySelector('#skip-conversation').click();assert.equal(h.document.activeElement.id,'section-stage');assert(!h.document.activeElement.hidden);assert.equal(h.window.location.hash,'#/'+name);assert.equal(h.calls.length,reads);}});
test('N1 hidden desktop project panel does not browse until first opened and never polls',async()=>{const h=await harness(fixture(),{width:1280,hash:'#/w/run_test/coder-1'});assert.equal(h.calls.filter(c=>c.url.startsWith('/api/projects/browse')).length,0);h.document.querySelector('[data-back-room]').click();await tick();await tick();assert.equal(h.calls.filter(c=>c.url.startsWith('/api/projects/browse')).length,1);await h.core.refresh();await h.core.refresh();assert.equal(h.calls.filter(c=>c.url.startsWith('/api/projects/browse')).length,1);assert.equal(posts(h).length,0);});
(async()=>{let failed=0;for(const [name,fn] of tests){try{await fn();console.log('PASS',name);}catch(error){failed++;console.error('FAIL',name,error);}}console.log(`${tests.length-failed}/${tests.length} chat tests passed`);process.exitCode=failed?1:0;})();
