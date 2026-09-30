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
  window.matchMedia=()=>({matches:!!options.coarse});
  // linkedom's select.value has no setter; mirror the browser for dynamic Settings forms.
  Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return (this.querySelector('option[selected]') || this.querySelector('option'))?.value || '';},set(value){for(const option of this.querySelectorAll('option')){if(option.value===String(value))option.setAttribute('selected','');else option.removeAttribute('selected');}}});
  let activeElement=null;Object.defineProperty(document,'activeElement',{get:()=>activeElement,configurable:true});window.HTMLElement.prototype.focus=function(){activeElement=this;};
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
      if(url==='/api/workspace/preflight')return {ok:true,status:200,json:async()=>clone(options.preflight || fx.composerPreflight)};
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
      if(url.startsWith('/api/channels'))return {ok:true,status:200,json:async()=>clone(options.channels || fx.threadChannels(publicThread,options.thread ? publicThread.messages.filter(m=>m.action && m.kind!=='outcome').length : state.inbox?.length || 0))};
      if(url.startsWith('/api/thread')) {const query=new URL(url,'http://test').searchParams;if(query.get('session')==='bogus')return {ok:false,status:404,json:async()=>({error:'Unknown session'})};return {ok:true,status:200,json:async()=>clone(publicThread)};}
      if (options.hold && url.startsWith('/api/state')) await new Promise(resolve=>{options.release=resolve;});
      return {ok:true,status:200,json:async()=>{const result=clone(state);if(url.endsWith('run=bogus')) result.run=null;return result;}};
    }});
  for (const file of ['core.js','model.js','thread.js','composer.js','shell.js']) vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context);
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
test('waiting pointer and room composer, no decision controls',async()=>{
  const h=await harness();assert.equal(h.document.querySelector('#waiting-pointer').textContent,'! 1 waiting for you');assert.equal(h.document.querySelector('#waiting a').getAttribute('href'),'/classic');
  assert(!h.document.querySelector('#composer').hasAttribute('disabled'));assert.match(h.document.querySelector('#composer').getAttribute('placeholder'),/Message Hermes/);
  assert.equal(h.document.querySelectorAll('[id*="approve"], [id*="deny"]').length,0);
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
  for(const file of fs.readdirSync(root))assert(!/\/(?:app\.js|workspace\.js|app\.css|themes\.css|workspace\.css)/.test(fs.readFileSync(path.join(root,file),'utf8')),file);
});
test('M3 kinds, progressive detail, roles, receipts and unknown kinds',async()=>{
  const data=fx.threadTeam();data.messages.push(fx.threadMessage('alert:1','alert','Needs attention',{reason:'Check integration'}),fx.threadMessage('unknown:1','future_kind','Recorded future event',{raw:'PRIVATE'}));
  const h=await harness(richActive(),{thread:data});const content=h.timeline.textContent;
  for(const label of ['turn 1','✕ failed','✓ passed','submission uncertain','Team plan · 2 agents · 2 tasks','Team proposal waiting','coder-2','Awaiting confirmation · by you','3 updates','research ·','Python testing','Needs attention','Recorded future event','→ @coder-2','Redirect after denying request p0']) assert(content.includes(label),label);
  assert(!content.includes('PRIVATE'));assert(h.timeline.querySelector('[data-message="unknown:1"] .quiet'));
  const details=h.timeline.querySelector('[data-message="turn:1"] details');assert(!details.open);details.open=true;
  assert(details.textContent.includes('todo.py'));assert(details.textContent.includes('Tests failed'));assert(details.textContent.includes('Inspect in classic'));
  for(const selector of ['[data-message="ev:2"] ol','[data-message="ev:5"] dl','[data-message="turn:r"] dl','[data-message="cap:1"] dl','[data-message="req:permission:p2"] dl'])assert(h.timeline.querySelector(selector),selector);
  data.messages.find(m=>m.id==='req:permission:p2').detail.receipt.actor='automatic local rule';data.messages.find(m=>m.id==='req:permission:p2').rev++;await h.core.refresh();assert(h.timeline.textContent.includes('Awaiting confirmation · by automatic local rule'));
  const single=await harness(richCompleted(),{thread:fx.threadSingle()});assert(single.timeline.textContent.includes('Workspace open'));assert(single.timeline.textContent.includes('apply blocked: Working tree changed'));
});
test('M3 actions link once to classic without controls or fingerprints',async()=>{
  for(const data of [fx.threadSingle(),fx.threadActive(),fx.threadTeam()]){
    const h=await harness(fixture(),{thread:data});
    for(const message of data.messages.filter(m=>m.action)){const node=h.timeline.querySelector(`[data-message="${message.id}"]`);assert.equal(node.querySelectorAll('a[href="/classic"]').length,1);assert(node.textContent.includes('Waiting for you'));}
    for(const node of h.timeline.querySelectorAll('button,a'))assert(!/\b(?:Approve|Deny|Apply|Discard|Verify|Reject|Answer)\b/i.test(node.textContent),node.textContent);
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
test('M3.1 rail discloses the real shown and total session counts only when capped',async()=>{
  const state=fixture();state.runs=Array.from({length:30},(_,i)=>({...state.run,id:'rail:'+i}));
  const channels=fx.threadChannels(fx.threadActive(),1);channels.channels[0].sessions=47;
  const h=await harness(state,{channels});assert.equal(h.document.querySelectorAll('#session-list a').length,30);
  const note=h.document.querySelector('#session-list + .muted');assert(note);assert.equal(note.textContent,'Showing 30 of 47 sessions · older sessions are in the room history');
  state.runs=state.runs.slice(0,2);await h.core.refresh();assert.equal(h.document.querySelector('#session-list + .muted').textContent,'Showing 2 of 47 sessions · older sessions are in the room history');
  for(const total of [2,1]){channels.channels[0].sessions=total;await h.core.refresh();assert.equal(h.document.querySelector('#session-list + .muted'),null);}
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
  for(const command of ['verify','apply','discard','team'])assert.match(composerHelpers.parseSlash('/'+command).error,/not available here/);
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
test('M4 slash suggestions/help are local and deferred decisions never send',async()=>{
  const h=await composerHarness('paused');type(h,'/');assert(!h.document.querySelector('#composer-options').hidden);assert.deepEqual([...h.document.querySelectorAll('#composer-options button')].map(n=>n.textContent),['/pause','/resume','/stop','/check','/title','/help']);
  type(h,'/help');await h.composer.submit();assert.equal(posts(h).length,0);assert(!h.document.querySelector('#composer-options').hidden);
  for(const text of ['/mystery','/verify','/apply','/discard','/team approve','/check','/pause extra']){type(h,text);await h.composer.submit();assert.equal(posts(h).length,0);assert.equal(h.document.querySelector('#composer').value,text);assert(h.document.querySelector('#composer-status').textContent);if(/verify|apply|discard|team/.test(text))assert(!h.document.querySelector('#composer-classic').hidden);}
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

(async()=>{let failed=0;for(const [name,fn] of tests){try{await fn();console.log('PASS',name);}catch(error){failed++;console.error('FAIL',name,error);}}console.log(`${tests.length-failed}/${tests.length} chat tests passed`);process.exitCode=failed?1:0;})();
