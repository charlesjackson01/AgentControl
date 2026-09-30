const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {parseHTML} = require('linkedom');
const {fixture,richActive,richCompleted,clone} = require('./fixtures.cjs');
const root = path.resolve(__dirname,'../chat');
const model = require(path.join(root,'model.js'));
const tick = ()=>new Promise(resolve=>setImmediate(resolve));
async function harness(state = fixture(), options = {}) {
  const {window,document} = parseHTML(fs.readFileSync(path.join(root,'index.html'),'utf8'));
  const local = new Map(options.key === false ? [] : [['ac-dashboard-key','test-key']]), session = new Map();
  const storage = map=>({getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)});
  Object.defineProperty(window,'localStorage',{value:storage(local),writable:true,configurable:true}); Object.defineProperty(window,'sessionStorage',{value:storage(session),writable:true,configurable:true});
  if(options.storageDenied) for(const name of ['localStorage','sessionStorage']) Object.defineProperty(window,name,{configurable:true,get(){throw Error('Storage denied');}});
  window.location = {hash:options.hash || '#/',replace(hash){this.hash=hash;}};
  if(options.contextOpen) local.set('acx-context-open','true');
  const timers = new Map(), calls = []; let next = 0, streamWake;
  const context = vm.createContext({window,document,console,TextDecoder,AbortController,Date,URL,encodeURIComponent,decodeURIComponent,
    setTimeout:(fn,delay)=>{const id=++next;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id),
    fetch:async(url,request)=>{
      calls.push({url,request}); assert.equal(request.headers.Authorization,'Bearer test-key');
      if (url === '/api/events') {
        if (options.streamUnauthorized) return {ok:false,status:401,json:async()=>({error:'Stream key rejected'})};
        if (!options.stream) return {ok:false,status:503};
        return {ok:true,status:200,body:{getReader:()=>({read:()=>new Promise(resolve=>{streamWake=resolve;})})}};
      }
      if (options.unauthorized) return {ok:false,status:401,json:async()=>({error:'Key rejected by server'})};
      if (options.fail) return {ok:false,status:500,json:async()=>({error:'Backend unavailable'})};
      if (options.hold && url.startsWith('/api/state')) await new Promise(resolve=>{options.release=resolve;});
      return {ok:true,status:200,json:async()=>{const result=clone(state);if(url.endsWith('run=bogus')) result.run=null;return result;}};
    }});
  for (const file of ['core.js','model.js','shell.js']) vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context);
  await tick();
  async function runTimers(delay) {const pending=[...timers].filter(([,t])=>t.delay===delay);for(const [id,t] of pending){timers.delete(id);t.fn();}await tick();}
  return {window,document,core:window.AC.core,shell:window.AC.shell,local,session,timers,calls,runTimers,options,emit:async text=>{streamWake({done:false,value:new TextEncoder().encode(text)});await tick();},drop:async()=>{streamWake({done:true});await tick();}};
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
  assert.equal(h.document.querySelector('#context').hidden,false);assert.equal(h.document.querySelector('.focused').dataset.session,'run_test');assert.match(h.calls.at(-1).url,/scope=current&run=run_test/);
  h.shell.setContext(false);assert.equal(h.local.get('acx-context-open'),'false');
  h.window.location.hash='#/unknown';h.shell.route();assert.equal(h.window.location.hash,'#/');
});
test('unknown fresh session recovers and uses only state',async()=>{
  const h=await harness(richActive(),{hash:'#/s/bogus'});
  assert.equal(h.window.location.hash,'#/');assert.equal(h.core.getState().focused,'');
  assert.equal(h.document.querySelectorAll('#session-list a').length,2);
  assert.match(h.document.querySelector('#banner-text').textContent,/That session is not in this project's history/);
  assert.equal(h.document.querySelector('#context').hidden,true);assert.equal(h.document.querySelector('#scrim').hidden,true);
  h.document.querySelector('#dismiss-error').click();assert.equal(h.document.querySelector('#banner').hidden,true);
  const n=h.calls.length;await h.core.refresh();assert.equal(h.calls.length,n+1);
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
test('waiting pointer and disabled composer, no decision controls',async()=>{
  const h=await harness();assert.match(h.document.querySelector('#waiting').textContent,/1 requests waiting/);assert.equal(h.document.querySelector('#waiting a').getAttribute('href'),'/classic');
  assert(h.document.querySelector('#composer').hasAttribute('disabled'));assert.match(h.document.querySelector('#composer').getAttribute('placeholder'),/Messaging from this view is coming soon/);
  assert.equal(h.document.querySelectorAll('[id*="approve"], [id*="deny"]').length,0);
  const done=await harness(richCompleted());assert.equal(done.document.querySelector('#waiting').textContent,'');
});
test('API strings cannot inject markup',async()=>{
  const state=fixture();const attack='<img src=x onerror=alert(1)>';state.project='/tmp/'+attack;state.runs[0].title=attack;state.run.summary=attack;state.run.goal=attack;state.agents=[{name:attack,state:'working',task:attack}];state.health.agents.hermes.label=attack;
  const h=await harness(state,{hash:'#/s/run_test'});assert.equal(h.document.querySelectorAll('img').length,0);assert.match(h.document.querySelector('#timeline').textContent,/<img/);
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
(async()=>{let failed=0;for(const [name,fn] of tests){try{await fn();console.log('PASS',name);}catch(error){failed++;console.error('FAIL',name,error);}}console.log(`${tests.length-failed}/${tests.length} chat tests passed`);process.exitCode=failed?1:0;})();
