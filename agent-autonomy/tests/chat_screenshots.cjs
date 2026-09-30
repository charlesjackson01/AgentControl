/* Offline M1/M3 browser matrix. Images stay in /tmp; CHROMIUM_PATH overrides discovery. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright-core');
const fx = require('./fixtures.cjs');
const root = path.resolve(__dirname,'../chat');
const out = process.argv[2] || '/tmp/chat-shots';
const browserRoots = ['/opt/pw-browsers',path.join(process.env.HOME || '/tmp','.cache/ms-playwright')];
const candidates = ['/opt/pw-browsers/chromium'];
for (const base of browserRoots) if (fs.existsSync(base)) for (const dir of fs.readdirSync(base).filter(name=>name.startsWith('chromium-'))) for (const platform of ['chrome-linux64','chrome-linux']) candidates.push(path.join(base,dir,platform,'chrome'));
const executablePath = process.env.CHROMIUM_PATH || candidates.find(p=>fs.existsSync(p) && fs.statSync(p).isFile());
const empty = fx.fixture();Object.assign(empty,{runs:[],run:null,inbox:[],agents:[]});
const active = fx.richActive();active.agents=[{name:'hermes',type:'orchestrator',state:'idle'},{name:'coder-1',type:'coder',state:'waiting_on_you',task:'Run tests'}];
const team=fx.clone(active);team.run.mode='team';team.agents.push({name:'coder-2',type:'coder',state:'working',task:'Build the CLI'},{name:'reviewer-1',type:'reviewer',state:'idle'});
(async()=>{
 fs.mkdirSync(out,{recursive:true});const browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});let count=0;
 const composerCases={composerIdle:fx.composerFixture('new'),composerNote:fx.composerFixture('active'),composerPaused:fx.composerFixture('paused'),composerFollow:fx.composerFixture('finished'),composerBasic:fx.composerFixture('new'),composerAdvanced:fx.composerFixture('new'),composerStop:fx.composerFixture('active')};
 const measurements=[];
 try {for(const [name,state] of Object.entries({empty,active,completed:fx.richCompleted(),team,threadActive:active,threadTeam:team,threadLong:fx.richCompleted(),...Object.fromEntries(Object.entries(composerCases).map(([name,f])=>[name,f.state]))}))for(const [size,[width,height]] of Object.entries({desktop:[1440,900],laptop:[1024,768],phone:[390,844]}))for(const colorScheme of ['light','dark']){
  const pages=composerCases[name] ? [composerCases[name].thread] : name==='threadLong' ? fx.threadLong() : [name==='empty' ? fx.threadResponse([],[]) : name==='threadTeam'||name==='team' ? fx.threadTeam() : name==='completed' ? fx.threadSingle() : fx.threadActive()];
  const page=await browser.newPage({viewport:{width,height},colorScheme,...(size==='phone'?{isMobile:true,hasTouch:true}:{})});const errors=[];page.on('pageerror',err=>errors.push(err.message));
  await page.route('**/*',async route=>{const url=new URL(route.request().url());if(url.pathname.startsWith('/api/')){assert.equal(route.request().headers().authorization,'Bearer test-key');if(url.pathname==='/api/workspace/preflight')return route.fulfill({contentType:'application/json',body:JSON.stringify(fx.composerPreflight)});if(url.pathname==='/api/sandbox')return route.fulfill({contentType:'application/json',body:JSON.stringify(state.sandbox || {unavailable:'No runtime',models_configured:false})});if(url.pathname==='/api/events')return route.fulfill({status:503,body:'unavailable'});if(url.pathname==='/api/channels')return route.fulfill({contentType:'application/json',body:JSON.stringify(fx.threadChannels(pages[0],pages[0].messages.filter(m=>m.action && m.kind!=='outcome').length))});if(url.pathname==='/api/thread'){if(url.searchParams.get('session')==='bogus')return route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({error:'Unknown session'})});const cursor=url.searchParams.get('before');return route.fulfill({contentType:'application/json',body:JSON.stringify(cursor==='long:250'?pages[1]:cursor==='long:50'?pages[2]:pages[0])});}return route.fulfill({contentType:'application/json',body:JSON.stringify(url.searchParams.get('run')==='bogus'?{...state,run:null,agents:[]}:state)});}const file=url.pathname==='/chat'? 'index.html':url.pathname.slice('/chat/'.length);assert(!file.includes('/'));return route.fulfill({path:path.join(root,file),contentType:{'.html':'text/html','.js':'text/javascript','.css':'text/css'}[path.extname(file)]});});
  await page.addInitScript(()=>localStorage.setItem('ac-dashboard-key','test-key'));await page.goto('http://agentcontrol.test/chat');await page.locator('#live').waitFor();if(name!=='empty' && pages[0].messages.length)await page.locator('#thread-items > article').first().waitFor({state:'attached'});
  const overflow=()=>page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  const result=page.locator('[data-message="turn:2"] > .message > details');if(await result.count()){await result.locator(':scope > summary').click();assert.equal(await overflow(),false,'Long result token overflow');await result.locator(':scope > summary').click();await page.evaluate(()=>{const timeline=document.getElementById('timeline');timeline.scrollTop=timeline.scrollHeight;});}
  if(name==='composerNote'){await page.locator('#composer').fill('@');await page.locator('#composer-options:not([hidden])').waitFor();assert(!(await page.locator('#composer-options').textContent()).includes('hermes'));}
  if(name==='composerFollow'){await page.locator('[data-reply]').click();await page.waitForFunction(()=>document.getElementById('composer-target').textContent.startsWith('Follow-up'));}
  if(name==='composerBasic'||name==='composerAdvanced'){await page.locator('#composer-settings').click();await page.locator('#settings-sheet:not([hidden])').waitFor();if(name==='composerAdvanced')await page.locator('#settings-advanced > summary').click();}
  if(name==='composerStop'){await page.locator('#session-menu > summary').click();await page.locator('[data-session-control="stop"]').click();await page.locator('#stop-dialog[open]').waitFor();assert.equal(await page.evaluate(()=>document.activeElement.id),'cancel-stop');}
  if(size==='phone' && (name==='composerNote'||name==='composerPaused'))assert.equal(await page.locator('#composer-target').evaluate(node=>node.scrollWidth<=node.clientWidth),true,'Note target must be fully visible');
  if(size==='phone'){const heights=await page.evaluate(()=>({footer:document.getElementById('room-footer').getBoundingClientRect().height,waiting:document.querySelector('#waiting .waiting-strip')?.getBoundingClientRect().height || 0,timeline:document.getElementById('timeline').getBoundingClientRect().height,viewport:innerHeight}));measurements.push({name,colorScheme,...heights});assert(heights.footer <= (heights.waiting?120:72),`${name} footer ${heights.footer}`);assert(heights.waiting<=40 && (!heights.waiting || heights.waiting>=32),`${name} waiting row ${heights.waiting}`);if(heights.waiting){const baseline=await page.evaluate(()=>{const textTop=node=>{const range=document.createRange();range.selectNodeContents(node);return range.getBoundingClientRect().top;};return Math.abs(textTop(document.getElementById('waiting-pointer'))-textTop(document.querySelector('#waiting a')));});assert(baseline<1,`${name} waiting text/link misaligned by ${baseline}px`);}assert(heights.timeline>=heights.viewport*.65,`${name} timeline ${heights.timeline}`);}
  assert.equal(await page.evaluate(()=>[...document.querySelectorAll('body *')].some(node=>node.textContent.includes('youOpen'))),false,`${name}/${size}/${colorScheme} joined waiting link`);
  assert.equal(await overflow(),false,`${name}/${size}/${colorScheme} overflow`);
  if(size==='phone' && name.startsWith('thread')){const newest=page.locator('[data-message]:not([hidden])').last();assert(await newest.isVisible());const box=await newest.boundingBox();const area=await page.locator('#timeline').boundingBox();assert(box.y<area.y+area.height && box.y+box.height>area.y,'Newest message clipped out of timeline');if(state.inbox.length)assert(await page.locator('#waiting').isVisible());}
  if(name==='composerIdle' && size==='phone'){await page.locator('#composer').fill(Array.from({length:10},()=>"A full line of a growing draft").join('\n'));const inputHeight=await page.locator('#composer').evaluate(node=>({height:node.getBoundingClientRect().height,line:parseFloat(getComputedStyle(node).lineHeight)}));assert(inputHeight.height<=Math.min(6*inputHeight.line+16,height*.4));await page.locator('#composer').fill('');await page.setViewportSize({width,height:480});await page.waitForFunction(()=>Math.abs(document.getElementById('app').getBoundingClientRect().height-visualViewport.height)<1);const keyboard=await page.locator('#room-footer').boundingBox();assert(keyboard.y+keyboard.height<=480,'Composer must remain above the emulated keyboard viewport');await page.screenshot({path:path.join(out,`composerKeyboard-phone-${colorScheme}.png`)});count++;await page.setViewportSize({width,height});await page.waitForFunction(()=>Math.abs(document.getElementById('app').getBoundingClientRect().height-visualViewport.height)<1);}
  await page.screenshot({animations:'disabled',path:path.join(out,`${name}-${size}-${colorScheme}.png`)});count++;
  if(state.run && name!=='threadLong' && !composerCases[name]){await page.evaluate(id=>location.hash='#/s/'+id,state.run.id);await page.locator('#context:not([hidden])').waitFor();assert.equal(await overflow(),false);await page.screenshot({animations:'disabled',path:path.join(out,`${name}-${size}-${colorScheme}-context.png`)});count++;await page.locator('#close-context').click();}
  if(size==='phone' && !composerCases[name]){await page.locator('#open-rail').click();assert.equal(await page.locator('#rail').isVisible(),true);assert.equal(await overflow(),false);await page.screenshot({animations:'disabled',path:path.join(out,`${name}-${size}-${colorScheme}-drawer.png`)});count++;await page.keyboard.press('Escape');assert.equal(await page.locator('#rail').isVisible(),false);}
  assert.deepEqual(errors,[]);await page.close();
 }
 for(const width of [1024,390])for(const stale of [true,false]){
  const page=await browser.newPage({viewport:{width,height:844},colorScheme:'light'});
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname==='/api/events')return route.fulfill({status:503,body:'unavailable'});
   if(url.pathname==='/api/agents')throw Error('Unexpected roster fetch');
   if(url.pathname==='/api/channels')return route.fulfill({contentType:'application/json',body:JSON.stringify(fx.threadChannels(fx.threadActive(),1))});
   if(url.pathname==='/api/thread')return route.fulfill({status:url.searchParams.get('session')==='bogus'?404:200,contentType:'application/json',body:JSON.stringify(url.searchParams.get('session')==='bogus'?{error:'Unknown session'}:fx.threadActive())});
   if(url.pathname==='/api/state')return route.fulfill({contentType:'application/json',body:JSON.stringify(url.searchParams.get('run')==='bogus'?{...active,run:null,agents:[]}:active)});
   const file=url.pathname==='/chat'?'index.html':url.pathname.slice('/chat/'.length);
   return route.fulfill({path:path.join(root,file),contentType:{'.html':'text/html','.js':'text/javascript','.css':'text/css'}[path.extname(file)]});
  });
  await page.addInitScript(stale=>{localStorage.setItem('ac-dashboard-key','test-key');if(stale)localStorage.setItem('acx-context-open','true');},stale);
  await page.goto('http://agentcontrol.test/chat'+(stale?'#/':'#/s/bogus'));
  await page.locator('#session-list a').first().waitFor({state:'attached'});
  assert.equal(await page.evaluate(()=>location.hash),'#/');
  assert.equal(await page.evaluate(()=>document.elementFromPoint(innerWidth/2,innerHeight/2)?.id==='scrim'),false);
  if(stale){
   await page.evaluate(()=>location.hash='#/s/run_test');await page.locator('#context:not([hidden])').waitFor();
   await page.goBack();await page.waitForFunction(()=>location.hash==='#/' && document.getElementById('scrim').hidden && document.getElementById('context').hidden);
  }
  await page.screenshot({path:path.join(out,`regression-${width}-${stale?'scrim':'bogus'}.png`)});count++;await page.close();
 }
 fs.writeFileSync(path.join(out,'footer-measurements.json'),JSON.stringify(measurements,null,2));
 }finally{await browser.close();}console.log(`${count} screenshots; 84 state/viewport/appearance combinations and 4 regression cases passed`);
})().catch(error=>{console.error(error);process.exitCode=1;});
