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
 const composerCases={composerIdle:fx.composerFixture('new'),composerNote:fx.composerFixture('active'),composerPaused:fx.composerFixture('paused'),composerFollow:fx.composerFixture('finished'),composerBasic:fx.composerFixture('new'),composerAdvanced:fx.composerFixture('new'),composerStop:fx.composerFixture('active'),composerLiteral:fx.composerFixture('active'),composerTarget:fx.composerFixture('active'),composerCleanSettings:fx.composerFixture('new'),composerRestored:fx.composerFixture('finished')};
 const decisionCases=Object.fromEntries([['decisionCritical','critical'],['decisionQuestion','question'],['decisionTeam','proposal'],['decisionResearch','research'],['decisionInstall','skillInstall'],['decisionApply','outcome'],['decisionSent','low'],['decision409','low']].map(([name,kind])=>[name,fx.decisionFixture(kind)]));
 const measurements=[];
 try {for(const [name,state] of Object.entries({empty,active,completed:fx.richCompleted(),team,threadActive:active,threadTeam:team,threadLong:fx.richCompleted(),...Object.fromEntries(Object.entries({...composerCases,...decisionCases}).map(([name,f])=>[name,f.state]))}))for(const [size,[width,height]] of Object.entries({desktop:[1440,900],laptop:[1024,768],phone:[390,844]}))for(const colorScheme of ['light','dark']){
  const pages=decisionCases[name] ? [decisionCases[name].thread] : composerCases[name] ? [composerCases[name].thread] : name==='threadLong' ? fx.threadLong() : [name==='empty' ? fx.threadResponse([],[]) : name==='threadTeam'||name==='team' ? fx.threadTeam() : name==='completed' ? fx.threadSingle() : fx.threadActive()];
  const page=await browser.newPage({viewport:{width,height},colorScheme,...(size==='phone'?{isMobile:true,hasTouch:true}:{})});const errors=[];page.on('pageerror',err=>errors.push(err.message));
  await page.route('**/*',async route=>{const url=new URL(route.request().url());if(url.pathname.startsWith('/api/')){assert.equal(route.request().headers().authorization,'Bearer test-key');if(route.request().method()==='POST')return route.fulfill({status:name==='decision409'?409:200,contentType:'application/json',body:JSON.stringify(name==='decision409'?{error:'The requested action changed. Review the current request.'}:{ok:true})});if(url.pathname==='/api/workspace/preflight')return route.fulfill({contentType:'application/json',body:JSON.stringify(fx.composerPreflight)});if(url.pathname==='/api/sandbox')return route.fulfill({contentType:'application/json',body:JSON.stringify(state.sandbox || {unavailable:'No runtime',models_configured:false})});if(url.pathname==='/api/events')return route.fulfill({status:503,body:'unavailable'});if(url.pathname==='/api/channels')return route.fulfill({contentType:'application/json',body:JSON.stringify(fx.threadChannels(pages[0],pages[0].messages.filter(m=>m.action && m.kind!=='outcome').length))});if(url.pathname==='/api/thread'){if(url.searchParams.get('session')==='bogus')return route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({error:'Unknown session'})});const cursor=url.searchParams.get('before');return route.fulfill({contentType:'application/json',body:JSON.stringify(cursor==='long:250'?pages[1]:cursor==='long:50'?pages[2]:pages[0])});}return route.fulfill({contentType:'application/json',body:JSON.stringify(url.searchParams.get('run')==='bogus'?{...state,run:null,agents:[]}:state)});}const file=url.pathname==='/chat'? 'index.html':url.pathname.slice('/chat/'.length);assert(!file.includes('/'));return route.fulfill({path:path.join(root,file),contentType:{'.html':'text/html','.js':'text/javascript','.css':'text/css'}[path.extname(file)]});});
  await page.addInitScript(name=>{localStorage.setItem('ac-dashboard-key','test-key');if(name==='composerCleanSettings'||name==='composerRestored')localStorage.setItem('acx-settings',JSON.stringify({verifier:'V1',max_steps:4,mode:'single',title:'Old title',goal_checks:['Old check'],allow_dirty:true}));},name);await page.goto('http://agentcontrol.test/chat');await page.locator('#live').waitFor();if(name!=='empty' && pages[0].messages.length)await page.locator('#thread-items > article').first().waitFor({state:'attached'});
  const overflow=()=>page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  const result=page.locator('[data-message="turn:2"] > .message > details');if(await result.count()){await result.locator(':scope > summary').click();assert.equal(await overflow(),false,'Long result token overflow');await result.locator(':scope > summary').click();await page.evaluate(()=>{const timeline=document.getElementById('timeline');timeline.scrollTop=timeline.scrollHeight;});}
  if(name==='empty'||name==='composerIdle'){assert.equal(await page.locator('.empty p').textContent(),'Write a goal below to start the first session.');assert.equal(await page.locator('.empty a').count(),0);}
  if(name==='composerLiteral'){await page.locator('#composer').fill('Pin @types/node to v20');assert.equal(await page.locator('#composer-target').textContent(),'Note → Hermes');assert.equal(await page.locator('#composer-options').isVisible(),false);}
  if(name==='composerTarget'){await page.locator('#composer').fill('@coder-2 hi');assert.equal(await page.locator('#composer-target').textContent(),'Note → @coder-2');}
  if(name==='composerCleanSettings'||name==='composerRestored'){
    if(name==='composerRestored'){await page.locator('[data-reply]').click();await page.waitForFunction(()=>document.getElementById('composer-target').textContent.startsWith('Follow-up'));await page.locator('#composer-settings').click();await page.locator('#setting-verifier').fill('Edited follow-up verifier');await page.locator('#setting-title').fill('Cancelled title');await page.locator('#add-goal-check').click();await page.locator('[data-check="0"]').fill('Cancelled check');await page.locator('#close-settings').click();await page.locator('#cancel-follow-up').click();assert.equal(await page.locator('#composer-target').textContent(),'New session');}
    await page.locator('#composer-settings').click();await page.locator('#settings-sheet:not([hidden])').waitFor();assert.equal(await page.locator('#setting-verifier').inputValue(),'V1');assert.equal(await page.locator('#setting-title').inputValue(),'');assert.equal(await page.locator('[data-check]').count(),0);assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('acx-settings'))),{verifier:'V1',max_steps:4,mode:'single'});
  }
  if(name==='composerNote'){await page.locator('#composer').fill('@');await page.locator('#composer-options:not([hidden])').waitFor();assert(!(await page.locator('#composer-options').textContent()).includes('hermes'));}
  if(name==='composerFollow'){await page.locator('[data-reply]').click();await page.waitForFunction(()=>document.getElementById('composer-target').textContent.startsWith('Follow-up'));}
  if(name==='composerBasic'||name==='composerAdvanced'){await page.locator('#composer-settings').click();await page.locator('#settings-sheet:not([hidden])').waitFor();if(name==='composerAdvanced')await page.locator('#settings-advanced > summary').click();}
  if(name==='composerStop'){await page.locator('#session-menu > summary').click();await page.locator('[data-session-control="stop"]').click();await page.locator('#stop-dialog[open]').waitFor();assert.equal(await page.evaluate(()=>document.activeElement.id),'cancel-stop');}
  if(decisionCases[name]) {
    const actionable=pages[0].messages.find(m=>m.action), card=page.locator('[data-message="'+actionable.id+'"]');
    if(size==='phone' && pages[0].messages.some(m=>m.action && m.kind!=='outcome')) {
      await page.locator('#waiting-pointer').click();await page.waitForFunction(id=>document.querySelector('[data-message="'+id+'"]').classList.contains('focused'),actionable.id);
      const box=await card.boundingBox(), area=await page.locator('#timeline').boundingBox();assert(box.y<area.y+area.height && box.y+box.height>area.y,'Waiting pointer must reveal the actionable card');
    }
    for(const label of await card.locator('[data-decision]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-label'))))assert(label.includes(actionable.text));
    if(['decisionCritical','decisionResearch','decisionInstall'].includes(name))assert(await card.locator('.review-detail').evaluate(node=>node.open));
    if(name==='decisionCritical'||name==='decisionResearch'){await page.screenshot({animations:'disabled',path:path.join(out,`${name}-${size}-${colorScheme}-review.png`)});count++;}
    if(['decisionCritical','decisionResearch','decisionApply'].includes(name)) {
      await card.locator('[data-decision="'+(name==='decisionApply'?'apply':'approve')+'"]').click();await page.locator('#decision-dialog[open]').waitFor();
      assert(await page.evaluate(()=>document.activeElement.hasAttribute('data-cancel-decision')));
      if(name!=='decisionApply')assert((await page.locator('#decision-dialog').textContent()).includes(state.permissions.confirm_word));
      if(size==='phone'){const sheet=await page.locator('#decision-dialog').boundingBox(), header=await page.locator('#room-header').boundingBox();assert(sheet.y>=header.y+header.height,'Bottom sheet must not cover the room header');assert(Math.abs(sheet.y+sheet.height-height)<1,'Dialog must sit at the phone bottom');assert(Math.abs(sheet.width-width)<1 && sheet.x===0,'Phone sheet must span the viewport');}
    }
    if(name==='decisionSent'||name==='decision409') {await card.locator('[data-decision="approve"]').click();await page.waitForFunction(([id,text])=>document.querySelector('[data-message="'+id+'"] .decision-status').textContent===text,[actionable.id,name==='decisionSent'?'Sent · waiting for AgentControl to record it':'The requested action changed. Review the current request.']);assert.equal(await page.locator('#waiting-pointer').textContent(),'! 1 waiting for you');}
    if(size==='phone') {
      for(const selector of ['.decision-buttons > button','#decision-dialog[open] button'])for(const box of await page.locator(selector).evaluateAll(nodes=>nodes.filter(node=>node.getClientRects().length).map(node=>({height:node.getBoundingClientRect().height,width:node.getBoundingClientRect().width,parent:node.parentElement.getBoundingClientRect().width})))){assert(box.height>=40,'Decision target must be at least 40 px');assert(Math.abs(box.width-box.parent)<1,'Phone decision buttons must span their row');}
      for(const height of await page.locator('.decision-question label,.decision-remember').evaluateAll(nodes=>nodes.filter(node=>node.getClientRects().length).map(node=>node.getBoundingClientRect().height)))assert(height>=40,'Phone answer and remember labels must provide a 40 px target');
    }
  }
  if(size==='phone' && (name==='composerNote'||name==='composerPaused'||name==='composerTarget'||name==='composerLiteral'))assert.equal(await page.locator('#composer-target').evaluate(node=>node.scrollWidth<=node.clientWidth),true,'Note target must be fully visible');
  if(size==='phone'){const heights=await page.evaluate(()=>({footer:document.getElementById('room-footer').getBoundingClientRect().height,waiting:document.querySelector('#waiting .waiting-strip')?.getBoundingClientRect().height || 0,timeline:document.getElementById('timeline').getBoundingClientRect().height,viewport:innerHeight}));measurements.push({name,colorScheme,...heights});assert(heights.footer <= (heights.waiting?120:72),`${name} footer ${heights.footer}`);assert(heights.waiting<=40 && (!heights.waiting || heights.waiting>=32),`${name} waiting row ${heights.waiting}`);if(heights.waiting){const baseline=await page.evaluate(()=>{const textTop=node=>{const range=document.createRange();range.selectNodeContents(node);return range.getBoundingClientRect().top;};return Math.abs(textTop(document.getElementById('waiting-pointer'))-textTop(document.querySelector('#waiting a')));});assert(baseline<1,`${name} waiting text/link misaligned by ${baseline}px`);}assert(heights.timeline>=heights.viewport*.65,`${name} timeline ${heights.timeline}`);}
  assert.equal(await page.evaluate(()=>[...document.querySelectorAll('body *')].some(node=>node.textContent.includes('youOpen'))),false,`${name}/${size}/${colorScheme} joined waiting link`);
  assert.equal(await overflow(),false,`${name}/${size}/${colorScheme} overflow`);
  if(size==='phone' && name.startsWith('thread')){const newest=page.locator('[data-message]:not([hidden])').last();assert(await newest.isVisible());const box=await newest.boundingBox();const area=await page.locator('#timeline').boundingBox();assert(box.y<area.y+area.height && box.y+box.height>area.y,'Newest message clipped out of timeline');if(state.inbox.length)assert(await page.locator('#waiting').isVisible());}
  if(name==='composerIdle' && size==='phone'){await page.locator('#composer').fill(Array.from({length:10},()=>"A full line of a growing draft").join('\n'));const inputHeight=await page.locator('#composer').evaluate(node=>({height:node.getBoundingClientRect().height,line:parseFloat(getComputedStyle(node).lineHeight)}));assert(inputHeight.height<=Math.min(6*inputHeight.line+16,height*.4));await page.locator('#composer').fill('');await page.setViewportSize({width,height:480});await page.waitForFunction(()=>Math.abs(document.getElementById('app').getBoundingClientRect().height-visualViewport.height)<1);const keyboard=await page.locator('#room-footer').boundingBox();assert(keyboard.y+keyboard.height<=480,'Composer must remain above the emulated keyboard viewport');await page.screenshot({path:path.join(out,`composerKeyboard-phone-${colorScheme}.png`)});count++;await page.setViewportSize({width,height});await page.waitForFunction(()=>Math.abs(document.getElementById('app').getBoundingClientRect().height-visualViewport.height)<1);}
  await page.screenshot({animations:'disabled',path:path.join(out,`${name}-${size}-${colorScheme}.png`)});count++;
  if(name==='decisionQuestion' && size==='phone') {
    await page.locator('#composer').fill('/apply');await page.locator('#composer').press('Control+Enter');await page.waitForFunction(()=>document.getElementById('composer-status').textContent==='Nothing to apply here');
    const budget=await page.evaluate(()=>({footer:document.getElementById('room-footer').getBoundingClientRect().height,timeline:document.getElementById('timeline').getBoundingClientRect().height,viewport:innerHeight}));assert(budget.footer<=120 && budget.timeline>=budget.viewport*.65,'M5 command errors must preserve the waiting footer budget');assert.equal(await overflow(),false);await page.screenshot({path:path.join(out,`decisionCommandError-phone-${colorScheme}.png`)});count++;
    const notice=await page.locator('#composer-status').boundingBox(), pointer=await page.locator('#waiting-pointer').boundingBox();assert(notice.y+notice.height<=pointer.y,'Command errors must not cover the waiting pointer');await page.locator('#waiting-pointer').click();assert(await page.locator('[data-message="m5:question"]').evaluate(node=>node.classList.contains('focused')));
  }
  if(state.run && name!=='threadLong' && !composerCases[name] && !decisionCases[name]){await page.evaluate(id=>location.hash='#/s/'+id,state.run.id);await page.locator('#context:not([hidden])').waitFor();assert.equal(await overflow(),false);await page.screenshot({animations:'disabled',path:path.join(out,`${name}-${size}-${colorScheme}-context.png`)});count++;await page.locator('#close-context').click();}
  if(size==='phone' && !composerCases[name] && !decisionCases[name]){await page.locator('#open-rail').click();assert.equal(await page.locator('#rail').isVisible(),true);assert.equal(await overflow(),false);await page.screenshot({animations:'disabled',path:path.join(out,`${name}-${size}-${colorScheme}-drawer.png`)});count++;await page.keyboard.press('Escape');assert.equal(await page.locator('#rail').isVisible(),false);}
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
 }finally{await browser.close();}console.log(`${count} screenshots; 156 state/viewport/appearance combinations and 6 regression cases passed`);
})().catch(error=>{console.error(error);process.exitCode=1;});
