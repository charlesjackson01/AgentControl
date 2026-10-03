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
const matrixViewports={desktop:[1440,900],'desktop-workspace':[1200,800],laptop:[1024,768],tablet:[768,1024],phone:[390,844],'phone-landscape':[844,390],narrow:[320,640]};
const viewportFilter=process.argv.find(arg=>arg.startsWith('--viewport='))?.slice(11);
if(viewportFilter)assert(Object.hasOwn(matrixViewports,viewportFilter),'Unknown focused-test viewport');
const keyboardOnly=process.argv.includes('--keyboard-only');
const viewports=keyboardOnly?{}:viewportFilter?{[viewportFilter]:matrixViewports[viewportFilter]}:matrixViewports;
const focusMeasurements=[],targetMeasurements=[];
const accessibilityMeasurements=[];
const inputFontMeasurements=[];
// M9 entry smoke uses real routing and the disposable fixture, without request mocks.
async function cutoverSmoke(browser,out){
 const {spawn}=require('node:child_process'),{createInterface}=require('node:readline');
 const child=spawn('python3',[path.resolve(__dirname,'device_fixture.py'),'--port','0'],{stdio:['ignore','pipe','pipe']});
 const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));let url='',key='',stderr='',context;
 child.stderr.on('data',chunk=>stderr+=chunk);
 try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Cutover fixture startup timed out')),45000),lines=createInterface({input:child.stdout});const done=()=>{clearTimeout(timer);lines.close();};child.once('error',error=>{done();reject(error);});child.once('exit',()=>{done();reject(Error('Cutover fixture exited during startup: '+stderr));});lines.on('line',line=>{if(line.startsWith('Device-test URL: '))url=line.slice(17).replace(/\/chat$/,'');if(line.startsWith('Throwaway test key: '))key=line.slice(20);if(url && key){done();resolve();}});});
  context=await browser.newContext({viewport:{width:1440,height:900}});const errors=[],posts=[];context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));context.on('request',request=>{if(request.method()==='POST')posts.push(new URL(request.url()).pathname);});
  const room=await context.newPage(),response=await room.goto(url+'/');assert.equal(response.status(),200);await room.locator('#dashboard-key').fill(key);await room.locator('#remember-key').check();await room.locator('#connect-form button[type="submit"]').click();await room.locator('#waiting-pointer').waitFor();await room.waitForFunction(()=>AC.core.getState().channels?.channels[0].waiting===2);assert.equal(await room.evaluate(()=>localStorage.getItem('ac-dashboard-key')),key);
  await room.screenshot({path:path.join(out,'entry-root-desktop.png')});await room.setViewportSize({width:390,height:844});await room.screenshot({path:path.join(out,'entry-root-phone.png')});await room.setViewportSize({width:1440,height:900});
  const classic=await context.newPage();assert.equal((await classic.goto(url+'/classic')).status(),200);await classic.locator('#app:not(.hidden)').waitFor();await classic.waitForFunction(()=>document.getElementById('mission-agents').children.length>0);assert.equal(await classic.locator('#auth').isVisible(),false);await classic.screenshot({path:path.join(out,'entry-classic.png')});
  // The link itself opens a standalone classic Workspace with the shared stored key.
  await room.locator('#rail [data-member="coder-1"] [data-workspace-link]').click();await room.locator('#workspace-terminal').waitFor();const link=room.locator('#workspace [data-popout]').first();const href=await link.getAttribute('href');assert(href.startsWith('/classic?popout=coder-1&run='));const popupReady=context.waitForEvent('page');await link.click();const popup=await popupReady;await popup.waitForLoadState('domcontentloaded');assert.equal(new URL(popup.url()).pathname,'/classic');await popup.locator('body.popout #app:not(.hidden)').waitFor();await popup.locator('#view-workspace:not(.hidden)').waitFor();await popup.locator('#ws-pane:not(.hidden)').waitFor();assert((await popup.locator('#ws-term-title').textContent()).includes('coder-1'));assert.equal(await popup.locator('#auth').isVisible(),false);assert.equal((await context.request.get(popup.url())).status(),200);await popup.screenshot({path:path.join(out,'entry-popout.png')});
  const compatibility=await context.newPage();assert.equal((await compatibility.goto(url+href.replace('/classic?','/?'))).status(),200);await compatibility.locator('body.popout #view-workspace:not(.hidden)').waitFor();await compatibility.locator('#ws-pane:not(.hidden)').waitFor();assert((await compatibility.locator('#ws-term-title').textContent()).includes('coder-1'));await compatibility.screenshot({path:path.join(out,'entry-popout-compat.png')});
  assert.equal((await classic.goto(url+'/classic/')).status(),200);await classic.locator('#app:not(.hidden)').waitFor();assert.deepEqual(errors,[]);assert.deepEqual(posts,[]);const root=await room.evaluate(()=>AC.core.getState().state.projects_root);assert(root.startsWith('/tmp/agentcontrol-device-'));fs.writeFileSync(path.join(out,'cutover-smoke.json'),JSON.stringify({cases:5,root:'chat',classic:true,trailingSlash:true,popout:href,compatibility:true,sharedKey:true,posts,errors},null,2));await context.close();context=null;child.kill('SIGINT');const result=await exited;assert.equal(result.code,0,stderr);assert(!fs.existsSync(root),'Cutover smoke must remove its disposable fixture');return {cases:5,shots:5};
 }finally{if(context)await context.close();if(child.exitCode===null && child.signalCode===null){child.kill('SIGINT');await exited;}}
}
async function accessibilityAudit(page,name,size){
 const findings=await page.evaluate(()=>{
  const errors=[],all=[...document.querySelectorAll('*')],ids=new Set();
  for(const node of all)if(node.id){if(ids.has(node.id))errors.push('Duplicate id '+node.id);ids.add(node.id);}
  const visible=n=>!n.closest('[hidden],[inert],[aria-hidden="true"]') && n.getClientRects().length && getComputedStyle(n).visibility!=='hidden';
  const text=n=>[...n.childNodes].map(c=>c.nodeType===3?c.textContent:c.nodeType===1 && !c.matches('[aria-hidden="true"]')?text(c):'').join(' ').trim();
  const name=n=>n.getAttribute('aria-label') || (n.getAttribute('aria-labelledby') || '').split(/\s+/).map(id=>document.getElementById(id)).filter(Boolean).map(text).join(' ') || (n.id?[...document.querySelectorAll('label')].filter(l=>l.htmlFor===n.id).map(text).join(' '):'') || (n.closest('label')?text(n.closest('label')):'') || (n.type==='submit'?n.value:'') || text(n);
  for(const n of all.filter(visible)){
   if(n.matches('a[href],button,input:not([type="hidden"]),textarea,select,summary,[tabindex="0"],[role="tab"],[role="toolbar"],[role="tabpanel"],nav,main,aside,[role="dialog"],[role="log"]') && !name(n))errors.push('Unnamed '+(n.id || n.tagName));
   if(n.hasAttribute('tabindex') && Number(n.getAttribute('tabindex'))>0)errors.push('Positive tabindex '+n.id);
  }
  const headings=all.filter(n=>/^H[1-6]$/.test(n.tagName) && visible(n)),regions=new Map();if(headings.filter(n=>n.tagName==='H1').length>1)errors.push('Multiple h1 headings');
  for(const h of headings){const region=h.closest('main,nav,aside,dialog,[role="dialog"]') || document.body,level=Number(h.tagName.slice(1)),previous=regions.get(region);if(previous && level>previous+1 || !previous && level>2)errors.push('Heading jump '+h.textContent.slice(0,60));regions.set(region,level);}
  for(const n of document.querySelectorAll('#live,#waiting-live'))if(n.getAttribute('aria-live')!=='polite' || n.getAttribute('aria-atomic')!=='true')errors.push('Invalid announcement '+n.id);
  if(document.querySelectorAll('#live').length!==1 || document.querySelectorAll('#waiting-live').length!==1)errors.push('Missing stable live regions');
  return errors;
 });
 const inputs=await page.locator('input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]),textarea,select').evaluateAll(nodes=>nodes.filter(n=>n.getClientRects().length && getComputedStyle(n).visibility!=='hidden').map(n=>({id:n.id || n.name || n.className,font:parseFloat(getComputedStyle(n).fontSize)})));
 inputFontMeasurements.push({name,size,inputs});assert(inputs.every(n=>n.font>=16),name+'/'+size+' text entry must compute at least 16 px: '+JSON.stringify(inputs));
 accessibilityMeasurements.push({name,size,findings});assert.deepEqual(findings,[],name+'/'+size+' accessibility audit');
}

// The layout viewport stays fixed: this reproduces keyboard panning, unlike setViewportSize().

async function deviceDiscoveryCases(browser,out){
 const failures=[],records=[];let shots=0;
 for(const [size,[width,height]] of Object.entries({phone:[390,844],'phone-landscape':[844,390]}))for(const colorScheme of ['light','dark']){
  const f=fx.deviceDiscoveryFixture(),page=await browser.newPage({viewport:{width,height},colorScheme}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(4000);
  try{
   await page.route('**/*',async route=>{const u=new URL(route.request().url());assert.notEqual(route.request().method(),'POST','Discoverability adds links only');if(u.pathname.startsWith('/api/'))return route.fulfill({status:u.pathname==='/api/events'?503:200,contentType:'application/json',body:JSON.stringify(u.pathname==='/api/state'?f.state:u.pathname==='/api/channels'?f.channels:u.pathname==='/api/thread'?f.thread:{})});const file=u.pathname==='/chat'?'index.html':u.pathname.slice('/chat/'.length);return route.fulfill({path:path.join(root,file),contentType:{'.html':'text/html','.js':'text/javascript','.css':'text/css'}[path.extname(file)]});});
   await page.addInitScript(()=>localStorage.setItem('ac-dashboard-key','test-key'));await page.goto('http://agentcontrol.test/chat');await page.locator('#room-header h1').waitFor();await page.evaluate(()=>AC.core.stop());const footer=await page.locator('#room-footer').boundingBox();assert(footer.height<= (size==='phone'?120:112));
   await page.locator('#open-rail').click();assert.equal(await page.locator('#rail-waiting').textContent(),'! 2 waiting for you');assert.equal(await page.locator('#rail [data-decision]').count(),0);await layoutCheck(page,'device-waiting-rail',size,width);await page.locator('#rail-waiting').scrollIntoViewIfNeeded();await page.screenshot({animations:'disabled',path:path.join(out,'device-waiting-rail-'+size+'-'+colorScheme+'.png')});shots++;
   const railLink=page.locator('#rail [data-member="coder-1"] [data-workspace-link]');assert.equal(await railLink.getAttribute('href'),'#/w/run_test/coder-1');await railLink.click();await page.locator('#workspace:not([hidden])').waitFor();assert.equal(await page.locator('#app').evaluate(n=>n.classList.contains('rail-open')),false);await page.locator('[data-back-room]').click();await page.locator('#app.rail-open').waitFor();assert(await railLink.evaluate(n=>n===document.activeElement));
   await page.locator('#rail-waiting a').click();await page.waitForFunction(()=>!document.getElementById('app').classList.contains('rail-open'));await page.locator('.focused[data-message]').waitFor();assert.equal(await page.locator('#waiting-pointer').textContent(),'! 2 waiting for you');
   const turn=page.locator('[data-message="turn:api-new"] [data-workspace-link]');await turn.scrollIntoViewIfNeeded();assert.equal(await turn.getAttribute('href'),'#/w/run_test/coder-1');assert(await turn.evaluate(n=>!n.closest('details')));assert.equal(await page.locator('[data-message="turn:api-new"] [data-workspace-link]').count(),1);await layoutCheck(page,'device-turn-summary',size,width);await page.screenshot({animations:'disabled',path:path.join(out,'device-turn-summary-'+size+'-'+colorScheme+'.png')});shots++;await turn.click();await page.locator('#workspace-terminal').waitFor();await page.locator('[data-back-room]').click();
   await page.locator('#session-menu > summary').click();assert((await page.locator('#session-menu').textContent()).includes('Workspaces'));assert.equal(await page.locator('#session-menu [data-decision]').count(),0);for(const member of f.state.agents)assert.equal(await page.locator('#session-menu a[href="#/w/run_test/'+encodeURIComponent(member.name)+'"]').count(),1);await layoutCheck(page,'device-menu-workspaces',size,width);await page.screenshot({animations:'disabled',path:path.join(out,'device-menu-workspaces-'+size+'-'+colorScheme+'.png')});shots++;const menu=page.locator('#session-menu a[href="#/w/run_test/hermes"]');await menu.click();await page.locator('#workspace-hermes').waitFor();await page.locator('[data-back-room]').click();await page.waitForFunction(()=>document.activeElement?.id==='menu-workspace-hermes');assert(await menu.evaluate(n=>n===document.activeElement));await page.evaluate(()=>window.returnedWorkspaceEntry=document.activeElement);await page.evaluate(()=>AC.core.refresh());assert(await page.evaluate(()=>returnedWorkspaceEntry.isConnected && returnedWorkspaceEntry===document.activeElement),'The actual menu entry must survive a subsequent recorded-state render');await menu.click();await page.locator('#workspace-hermes').waitFor();await page.keyboard.press('Escape');assert(await menu.evaluate(n=>n===document.activeElement),'Escape returns to the same menu entry');
   const after=await page.locator('#room-footer').boundingBox();assert.equal(after.height,footer.height);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);records.push({size,colorScheme,footer:footer.height,waiting:2,post:0});
  }catch(e){failures.push({size,colorScheme,error:e.message});}finally{await page.close();}
 }
 fs.writeFileSync(path.join(out,'device-discovery-results.json'),JSON.stringify({cases:4,records,failures},null,2));assert.deepEqual(failures,[]);return {shots,cases:4};
}

async function deviceViewportCases(browser,out){
 const results=[];let shots=0;
 for(const [size,[width,height]] of Object.entries({phone:[390,844],landscape:[844,390],tablet:[768,1024]}))for(const colorScheme of ['light','dark']){
  const page=await browser.newPage({viewport:{width,height},colorScheme}),record={size,colorScheme,checks:[],failures:[]};let f=fx.decisionFixture('critical');const errors=[];page.on('pageerror',e=>errors.push(e.message));
  page.setDefaultTimeout(4000);
  const check=async(name,fn)=>{try{const evidence=await fn();record.checks.push({name,...evidence});}catch(e){record.failures.push({name,error:e.message});}};
  try{
   f.thread.messages.unshift(fx.threadMessage('ev:device-history','goal',Array.from({length:90},(_,i)=>'Recorded history line '+i).join('\n')));
   await page.addInitScript(({width,height})=>{const vv=new EventTarget();Object.assign(vv,{width,height,offsetTop:0,offsetLeft:0,scale:1});Object.defineProperty(window,'visualViewport',{value:vv,configurable:true});window.setTestViewport=(values,event='resize')=>{Object.assign(vv,values);vv.dispatchEvent(new Event(event));};},{width,height});
   await page.route('**/*',async route=>{const u=new URL(route.request().url());assert.notEqual(route.request().method(),'POST','Device geometry must not make decisions');if(u.pathname.startsWith('/api/'))return route.fulfill({status:u.pathname==='/api/events'?503:200,contentType:'application/json',body:JSON.stringify(u.pathname==='/api/state'?f.state:u.pathname==='/api/channels'?f.channels:u.pathname==='/api/thread'?f.thread:u.pathname==='/api/workspace/preflight'?fx.composerPreflight:{})});const file=u.pathname==='/chat'?'index.html':u.pathname.slice('/chat/'.length);return route.fulfill({path:path.join(root,file),contentType:{'.html':'text/html','.js':'text/javascript','.css':'text/css'}[path.extname(file)]});});
   await page.goto('http://agentcontrol.test/chat');await check('sign-in input font',async()=>{await accessibilityAudit(page,'device-sign-in',size);});await page.evaluate(()=>AC.core.connect('test-key',false));await page.locator('[data-decision="approve"]').waitFor();await page.evaluate(()=>AC.core.stop());
   await check('viewport meta and input font',async()=>{const meta=await page.locator('meta[name="viewport"]').getAttribute('content');assert(meta.includes('interactive-widget=resizes-content'));assert(!/maximum-scale|user-scalable/.test(meta));await accessibilityAudit(page,'device-room',size);});
   const originalFooter=await page.locator('#room-footer').boundingBox(),keyboardHeight=Math.min(480,height-150);
   for(const offsetTop of [0,260])await check('keyboard composer offset '+offsetTop,async()=>{
    await page.evaluate(({height,offsetTop})=>{const t=document.getElementById('timeline');t.scrollTop=t.scrollHeight;setTestViewport({height,offsetTop,scale:1});},{height:keyboardHeight,offsetTop});await page.evaluate(()=>new Promise(requestAnimationFrame));
    for(const selector of ['#composer','#send-message','#composer-target']){const b=await page.locator(selector).boundingBox();assert(b.y>=offsetTop-1 && b.y+b.height<=offsetTop+keyboardHeight+1,selector+' outside visual viewport');}
    const footer=await page.locator('#room-footer').boundingBox();assert(Math.abs(footer.y+footer.height-(offsetTop+keyboardHeight))<=1,'Footer bottom must equal visual viewport bottom');const bottom=await page.locator('#timeline').evaluate(n=>n.scrollHeight-n.scrollTop-n.clientHeight);assert(bottom<=1,'Newest message stays visible');return {footerBottom:footer.y+footer.height,height:keyboardHeight,offsetTop,bottom};
   });
   await check('scrolled-up history survives keyboard resize',async()=>{await page.evaluate(h=>{setTestViewport({height:h,offsetTop:0});const t=document.getElementById('timeline');t.scrollTop=120;},height);await page.evaluate(()=>new Promise(requestAnimationFrame));const before=await page.locator('#timeline').evaluate(n=>n.scrollTop);await page.evaluate(h=>setTestViewport({height:h,offsetTop:260}),keyboardHeight);const after=await page.locator('#timeline').evaluate(n=>n.scrollTop);assert.equal(after,before);return {before,after};});
   await check('pinch shrinking freezes app and composer geometry and resumes after unzoom',async()=>{
    const selectors=['#app','#room-footer','#composer','#send-message','#composer-target','#waiting-pointer'];
    const geometry=()=>page.evaluate(selectors=>Object.fromEntries(selectors.map(selector=>{const n=document.querySelector(selector),b=n.getBoundingClientRect();return [selector,{y:b.y,height:b.height,bottom:b.bottom}];})),selectors);
    // First zoom from the panned keyboard, then from the full unzoomed layout.
    try {for(const baseHeight of [keyboardHeight,height]){
     const top=baseHeight===keyboardHeight?260:0;await page.evaluate(({height,offsetTop})=>setTestViewport({height,offsetTop,scale:1}),{height:baseHeight,offsetTop:top});
     await page.evaluate(()=>{const input=document.getElementById('composer');input.value='Multiline draft\n'.repeat(12);input.dispatchEvent(new Event('input',{bubbles:true}));});const before=await geometry();
     await page.evaluate(h=>setTestViewport({height:h/2,scale:2,offsetTop:300},'scroll'),baseHeight);
     await page.evaluate(()=>document.getElementById('composer').dispatchEvent(new Event('input',{bubbles:true})));assert.deepEqual(await geometry(),before,'Zoom must not collapse or reflow composer/waiting');
     assert.equal(await page.locator('html').evaluate(n=>n.style.getPropertyValue('--viewport-height')),baseHeight+'px');assert.equal(await page.locator('html').evaluate(n=>n.style.getPropertyValue('--viewport-top')),top+'px');
     for(const selector of selectors.slice(2)){const b=await page.locator(selector).boundingBox();assert(b.height>0 && b.y>=top-1 && b.y+b.height<=top+baseHeight+1,selector+' remains visible in the preserved layout');if(selector!=='#composer-target')assert(b.width>=40 && b.height>=40,selector+' interactive target remains at least 40 px');}
     await page.evaluate(h=>setTestViewport({height:h,scale:1,offsetTop:0}),baseHeight);const restored=await page.locator('#app').boundingBox();assert.equal(restored.height,baseHeight);assert.equal(restored.y,0);
    }
    } finally {await page.evaluate(h=>{setTestViewport({height:h,scale:1,offsetTop:0});const input=document.getElementById('composer');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));},height);}return {scale:2,zoomHeight:height/2,preservedHeight:height};
   });
   await page.evaluate(h=>setTestViewport({height:h,offsetTop:0,scale:1}),height);
   await page.locator('[data-decision="approve"]').click();await page.locator('#decision-dialog[open]').waitFor();assert(await page.evaluate(()=>document.activeElement.hasAttribute('data-cancel-decision')));await page.locator('#decision-dialog [name="confirm"]').focus();
   for(const offsetTop of [0,260])await check('focused critical sheet offset '+offsetTop,async()=>{
    await page.evaluate(({height,offsetTop})=>setTestViewport({height,offsetTop,scale:1}),{height:keyboardHeight,offsetTop});const sheet=await page.locator('#decision-dialog').boundingBox();assert(sheet.height<=keyboardHeight*.75+1);
    if(size==='tablet')assert(Math.abs(sheet.y+sheet.height/2-(offsetTop+keyboardHeight/2))<=1,'Tablet card centred in visual viewport');else assert(Math.abs(sheet.y+sheet.height-(offsetTop+keyboardHeight))<=1,'Decision sheet bottom follows visual viewport');
    for(const sel of ['[name="confirm"]','[data-cancel-decision]','[data-confirm-decision]']){const b=await page.locator('#decision-dialog '+sel).boundingBox();assert(b.y>=offsetTop-1 && b.y+b.height<=offsetTop+keyboardHeight+1,'Confirmation controls outside viewport');}
    await accessibilityAudit(page,'device-confirm',size);return {sheet};
   });
   await check('pinch shrinking preserves focused confirmation field and controls',async()=>{
    const selectors=['#decision-dialog','#decision-dialog [name="confirm"]','#decision-dialog [data-cancel-decision]','#decision-dialog [data-confirm-decision]'];const boxes=async()=>Promise.all(selectors.map(selector=>page.locator(selector).boundingBox()));const before=await boxes();
    try {await page.evaluate(h=>setTestViewport({height:h/2,scale:2,offsetTop:300}),keyboardHeight);assert.deepEqual(await boxes(),before,'Zoom must not collapse the confirmation sheet');assert(await page.locator('[name="confirm"]').evaluate(n=>n===document.activeElement));for(const b of before.slice(1))assert(b.height>=40 && b.y>=260-1 && b.y+b.height<=260+keyboardHeight+1);
    } finally {await page.evaluate(h=>setTestViewport({height:h,scale:1,offsetTop:260}),keyboardHeight);}assert.deepEqual(await boxes(),before);return {scale:2,zoomHeight:keyboardHeight/2,preservedHeight:keyboardHeight};
   });
   await page.evaluate(()=>setTestViewport({offsetTop:0}));await page.screenshot({path:path.join(out,'device-critical-'+size+'-'+colorScheme+'.png')});shots++;await page.locator('[data-cancel-decision]').click();
   await page.evaluate(h=>setTestViewport({height:h,offsetTop:0}),height);await page.locator('#session-menu > summary').click();await page.locator('[data-session-control="stop"]').click();
   await check('Stop sheet above panned keyboard',async()=>{await page.evaluate(h=>setTestViewport({height:h,offsetTop:260}),keyboardHeight);const b=await page.locator('#stop-dialog').boundingBox();assert(b.y>=260-1 && b.y+b.height<=260+keyboardHeight+1);if(size!=='tablet')assert(Math.abs(b.y+b.height-(260+keyboardHeight))<=1);});await page.evaluate(()=>setTestViewport({offsetTop:0}));await page.locator('#cancel-stop').click();
   await page.evaluate(h=>setTestViewport({height:h,offsetTop:0}),height);await page.evaluate(()=>{location.hash='#/s/run_test';AC.shell.route();});await page.locator('#context:not([hidden])').waitFor();
   await check('context sheet within panned viewport',async()=>{await page.evaluate(h=>setTestViewport({height:h,offsetTop:260}),keyboardHeight);const b=await page.locator('#context').boundingBox();assert(b.height<=keyboardHeight*.75+1);if(size==='tablet')assert(Math.abs(b.y+b.height/2-(260+keyboardHeight/2))<=1);else assert(Math.abs(b.y+b.height-(260+keyboardHeight))<=1);});await page.evaluate(h=>setTestViewport({height:h,offsetTop:0}),height);await page.locator('#close-context').click();
   f=fx.composerFixture('new');await page.evaluate(()=>{location.hash='#/';AC.shell.route();});await page.evaluate(()=>AC.core.refresh());await page.evaluate(h=>setTestViewport({height:h,offsetTop:0}),height);await page.locator('#composer-settings').click();await page.locator('#settings-sheet:not([hidden])').waitFor();await page.locator('#settings-advanced > summary').click();await page.locator('[data-setting="max_steps"]').focus();
   for(const offsetTop of [0,260])await check('focused Settings offset '+offsetTop,async()=>{await page.evaluate(({height,offsetTop})=>setTestViewport({height,offsetTop}),{height:keyboardHeight,offsetTop});const sheet=await page.locator('#settings-sheet').boundingBox();assert(sheet.height<=keyboardHeight*.75+1);if(size==='tablet')assert(Math.abs(sheet.y+sheet.height/2-(offsetTop+keyboardHeight/2))<=1);else assert(Math.abs(sheet.y+sheet.height-(offsetTop+keyboardHeight))<=1);await page.locator('[data-setting="max_steps"]').scrollIntoViewIfNeeded();for(const selector of ['[data-setting="max_steps"]','#close-settings']){const b=await page.locator(selector).boundingBox();assert(b.y>=offsetTop-1 && b.y+b.height<=offsetTop+keyboardHeight+1,selector+' outside viewport');}await accessibilityAudit(page,'device-settings',size);return {sheet};});
   await page.evaluate(()=>setTestViewport({offsetTop:0}));await page.screenshot({path:path.join(out,'device-settings-'+size+'-'+colorScheme+'.png')});shots++;await page.locator('#close-settings').click();
   await check('close keyboard restores footer geometry',async()=>{await page.evaluate(h=>setTestViewport({height:h,offsetTop:0,scale:1}),height);const footer=await page.locator('#room-footer').boundingBox();assert(Math.abs(footer.y+footer.height-height)<=1);assert(footer.height<=72);return {waitingFooter:originalFooter.height,idleFooter:footer.height};});
   await check('six-line growth uses visual height',async()=>{await page.evaluate(h=>setTestViewport({height:h,offsetTop:0}),keyboardHeight);await page.locator('#composer').fill('Multiline draft\n'.repeat(12));const b=await page.locator('#composer').boundingBox();assert(b.height<=keyboardHeight*.4+1);});assert.deepEqual(errors,[]);
  }catch(e){record.failures.push({name:'setup/workflow',error:e.message});}finally{results.push(record);await page.close();}
 }
 fs.writeFileSync(path.join(out,'device-viewport-results.json'),JSON.stringify(results,null,2));const failures=results.flatMap(r=>r.failures.map(f=>({size:r.size,colorScheme:r.colorScheme,...f})));assert.deepEqual(failures,[]);return {shots,cases:results.length};
}

async function accessibilitySpots(browser,out){
 const failures=[];let count=0;
 for(const mode of ['reduced-motion','forced-colors'])for(const colorScheme of ['light','dark']){
  const f=fx.workspaceDetails(),page=await browser.newPage({viewport:{width:1440,height:900},colorScheme}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{
   await page.route('**/*',async route=>{const u=new URL(route.request().url());assert.notEqual(route.request().method(),'POST');if(u.pathname.startsWith('/api/'))return route.fulfill({status:u.pathname==='/api/events'?503:200,contentType:'application/json',body:JSON.stringify(u.pathname==='/api/state'?f.state:u.pathname==='/api/channels'?f.channels:u.pathname==='/api/thread'?f.thread:{})});const file=u.pathname==='/chat'?'index.html':u.pathname.slice('/chat/'.length);return route.fulfill({path:path.join(root,file),contentType:{'.html':'text/html','.js':'text/javascript','.css':'text/css'}[path.extname(file)]});});
   await page.addInitScript(()=>localStorage.setItem('ac-dashboard-key','test-key'));await page.goto('http://agentcontrol.test/chat#/s/run_test');await page.locator('#context:not([hidden])').waitFor();await page.evaluate(()=>AC.core.stop());
   if(mode==='reduced-motion'){
    await page.emulateMedia({reducedMotion:'reduce'});await page.addStyleTag({content:'#timeline {scroll-behavior:smooth;transition:opacity 2s} #timeline::before {content:"";transition:opacity 2s}'});
    const styles=await page.locator('#timeline').evaluate(n=>[getComputedStyle(n),getComputedStyle(n,'::before')].map(s=>({transition:s.transitionDuration,animation:s.animationDuration,scroll:s.scrollBehavior})));for(const v of styles){assert.equal(v.transition,'0s');assert.equal(v.animation,'0s');assert.equal(v.scroll,'auto');}
    await page.locator('#waiting-pointer').click();assert.equal(await page.locator('.focused[data-message]').evaluate(n=>parseFloat(getComputedStyle(n).outlineWidth)),2);
   }else{
    await page.emulateMedia({forcedColors:'active'});assert(await page.evaluate(()=>matchMedia('(forced-colors: active)').matches));await page.locator('#members-tab').click();const selected=await page.locator('#members-tab').evaluate(n=>({width:parseFloat(getComputedStyle(n).outlineWidth),style:getComputedStyle(n).outlineStyle,weight:getComputedStyle(n).fontWeight}));assert(selected.width>=2 && selected.style!=='none' && Number(selected.weight)>=700,'Forced-colour selection needs a visible outline and weight');
   }
   await accessibilityAudit(page,mode,colorScheme);await focusCheck(page,mode,colorScheme);assert.deepEqual(errors,[]);await page.screenshot({animations:'disabled',path:path.join(out,mode+'-'+colorScheme+'.png')});count++;
  }catch(e){failures.push({mode,colorScheme,error:e.message});}finally{await page.close();}
 }
 fs.writeFileSync(path.join(out,'accessibility-spots.json'),JSON.stringify({cases:4,failures},null,2));assert.deepEqual(failures,[]);return count;
}
async function focusCheck(page,name,size){
 await page.evaluate(()=>{window.__focusAudit={original:document.activeElement,scrolls:[...document.querySelectorAll('*')].map(n=>[n,n.scrollTop,n.scrollLeft])};});
 await page.keyboard.press('Tab');
 const result=await page.evaluate(()=>{
  const {original,scrolls}=window.__focusAudit;delete window.__focusAudit;let count=0,outlineMinimum=Infinity,insetMinimum=Infinity;const errors=[];
  for(const node of document.querySelectorAll('a[href],button,input,textarea,select,summary,[tabindex]')){
   if(node.disabled || node.closest('[hidden],[inert]') || !node.getClientRects().length || getComputedStyle(node).visibility==='hidden')continue;
   node.scrollIntoView({block:'nearest',inline:'nearest'});node.focus({preventScroll:true});
   if(document.activeElement!==node)continue;
   count++;const style=getComputedStyle(node),width=parseFloat(style.outlineWidth),offset=parseFloat(style.outlineOffset);
   outlineMinimum=Math.min(outlineMinimum,width);insetMinimum=Math.min(insetMinimum,-offset);
   if(width<2 || style.outlineStyle==='none' || offset>-width)errors.push((node.id || node.getAttribute('aria-label') || node.tagName)+' missing an inset focus ring');
  }
  original?.focus({preventScroll:true});for(const [node,top,left] of scrolls){node.scrollTop=top;node.scrollLeft=left;}
  return {count,errors,outlineMinimum,insetMinimum};
 });
 assert.deepEqual(result.errors,[],`${name}/${size} focus visibility`);assert(result.count>0);focusMeasurements.push({name,size,count:result.count,outline:result.outlineMinimum,inset:result.insetMinimum});
}
async function emptyHistoryCases(browser,out){
 const failures=[];let count=0;
 for(const width of [1440,390])for(const colorScheme of ['light','dark']){
  const f={state:fx.richCompleted(),thread:fx.threadLong()[0]};f.channels=fx.threadChannels(f.thread,0);let exhausted=false,reads=0;const page=await browser.newPage({viewport:{width,height:844},colorScheme}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{
   await page.route('**/*',async route=>{const u=new URL(route.request().url());assert.notEqual(route.request().method(),'POST');if(u.pathname.startsWith('/api/')){let body=u.pathname==='/api/state'?f.state:u.pathname==='/api/channels'?f.channels:{};if(u.pathname==='/api/thread'){reads++;if(u.searchParams.has('before')){exhausted=true;body={...f.thread,messages:[],before:null};}else body={...f.thread,...(exhausted?{before:null}:{})};}return route.fulfill({status:u.pathname==='/api/events'?503:200,contentType:'application/json',body:JSON.stringify(body)});}const file=u.pathname==='/chat'?'index.html':u.pathname.slice('/chat/'.length);return route.fulfill({path:path.join(root,file),contentType:{'.html':'text/html','.js':'text/javascript','.css':'text/css'}[path.extname(file)]});});
   await page.addInitScript(()=>localStorage.setItem('ac-dashboard-key','test-key'));await page.goto('http://agentcontrol.test/chat');await page.locator('#load-earlier').waitFor();await page.evaluate(()=>{AC.core.stop();window.__historyButton=document.getElementById('load-earlier');window.__historyIds=[...AC.core.getState().thread.ids];});
   await keyboardFocus(page,'#load-earlier');await page.keyboard.press('Enter');await page.waitForFunction(()=>AC.core.getState().thread.before===null);assert(await page.evaluate(()=>__historyButton.isConnected && document.activeElement===__historyButton),'Empty final page must preserve native button focus');assert.equal(await page.locator('#load-earlier').getAttribute('aria-disabled'),'true');assert.equal(await page.locator('#load-earlier').getAttribute('aria-busy'),'false');assert(await page.evaluate(()=>JSON.stringify(__historyIds)===JSON.stringify(AC.core.getState().thread.ids)));const before=reads;await page.keyboard.press('Enter');await page.evaluate(()=>new Promise(requestAnimationFrame));assert.equal(reads,before,'Exhausted focused control cannot read again');await accessibilityAudit(page,'empty-history',String(width));await focusCheck(page,'empty-history',String(width));await page.screenshot({animations:'disabled',path:path.join(out,'empty-history-'+width+'-'+colorScheme+'.png')});count++;
   await page.keyboard.press('Tab');await page.evaluate(()=>AC.core.refresh());assert.equal(await page.locator('#load-earlier').count(),0);assert.deepEqual(errors,[]);
  }catch(e){failures.push({width,colorScheme,error:e.message});}finally{await page.close();}
 }
 fs.writeFileSync(path.join(out,'empty-history-results.json'),JSON.stringify({cases:4,failures},null,2));assert.deepEqual(failures,[]);return count;
}
async function phonePanelCases(browser,out){
 const failures=[];let count=0;
 for(const width of [390,320])for(const colorScheme of ['light','dark']){
  const f=fx.membersFixture('teamRunning'),page=await browser.newPage({viewport:{width,height:844},colorScheme}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{
   await page.route('**/*',async route=>{const u=new URL(route.request().url());assert.notEqual(route.request().method(),'POST');if(u.pathname.startsWith('/api/'))return route.fulfill({status:u.pathname==='/api/events'?503:200,contentType:'application/json',body:JSON.stringify(u.pathname==='/api/state'?f.state:u.pathname==='/api/channels'?f.channels:u.pathname==='/api/thread'?f.thread:{})});const file=u.pathname==='/chat'?'index.html':u.pathname.slice('/chat/'.length);return route.fulfill({path:path.join(root,file),contentType:{'.html':'text/html','.js':'text/javascript','.css':'text/css'}[path.extname(file)]});});
   await page.addInitScript(()=>localStorage.setItem('ac-dashboard-key','test-key'));await page.goto('http://agentcontrol.test/chat#/s/run_test');await page.locator('#context:not([hidden])').waitFor();await page.evaluate(()=>AC.core.stop());await page.locator('#members-tab').click();await page.locator('.task-graph').scrollIntoViewIfNeeded();const pane=await page.locator('#context').boundingBox();assert(Math.abs(pane.y+pane.height-844)<1,'Tall graph scrolling must keep the phone sheet at the viewport bottom');assert.equal(await page.locator('#app').evaluate(n=>n.scrollTop),0,'The outer grid must not scroll');await accessibilityAudit(page,'phone-panel',String(width));await focusCheck(page,'phone-panel',String(width));assert.deepEqual(errors,[]);await page.screenshot({animations:'disabled',path:path.join(out,'phone-panel-'+width+'-'+colorScheme+'.png')});count++;
  }catch(e){failures.push({width,colorScheme,error:e.message});}finally{await page.close();}
 }
 fs.writeFileSync(path.join(out,'phone-panel-results.json'),JSON.stringify({cases:4,failures},null,2));assert.deepEqual(failures,[]);return count;
}
async function keyboardFocus(page,selector,reverse=false){
 for(let i=0;i<160;i++){if(await page.evaluate(s=>document.activeElement?.matches(s),selector))return;await page.keyboard.press(reverse?'Shift+Tab':'Tab');}
 throw Error('Keyboard could not reach '+selector);
}
async function keyboardPaths(browser,out){
 const failures=[],shots=[];let cases=0;
 for(const name of ['start','note','question','typed-approve','deny-redirect','workspace','history','context-tabs'])for(const width of [1440,390])for(const colorScheme of ['light','dark']){
  cases++;const f=name==='history'?{state:fx.richCompleted(),thread:fx.threadLong()[0],pages:fx.threadLong()}:['question','typed-approve','deny-redirect'].includes(name)?fx.decisionFixture(name==='question'?'question':'critical'):['workspace','context-tabs'].includes(name)?fx.workspaceDetails():fx.composerFixture(name==='start'?'new':'active');f.channels ||= fx.threadChannels(f.thread,f.thread.messages.filter(m=>m.action && m.kind!=='outcome').length);
  const posted=[],errors=[],page=await browser.newPage({viewport:{width,height:844},colorScheme});page.on('pageerror',e=>errors.push(e.message));
  try{
   await page.route('**/*',async route=>{const u=new URL(route.request().url());if(u.pathname.startsWith('/api/')){assert.equal(route.request().headers().authorization,'Bearer test-key');if(route.request().method()==='POST'){posted.push({path:u.pathname,body:route.request().postDataJSON()});return route.fulfill({contentType:'application/json',body:JSON.stringify(u.pathname==='/api/runs'?{id:'keyboard-new'}:{ok:true})});}const body=u.pathname==='/api/channels'?f.channels:u.pathname==='/api/thread'?f.pages && u.searchParams.get('before')==='long:250'?f.pages[1]:f.thread:u.pathname==='/api/workspace/preflight'?fx.composerPreflight:u.pathname==='/api/sandbox'?f.state.sandbox || {}:f.state;return route.fulfill({status:u.pathname==='/api/events'?503:200,contentType:'application/json',body:JSON.stringify(body)});}const file=u.pathname==='/chat'?'index.html':u.pathname.slice('/chat/'.length);return route.fulfill({path:path.join(root,file),contentType:{'.html':'text/html','.js':'text/javascript','.css':'text/css'}[path.extname(file)]});});
   await page.addInitScript(()=>localStorage.setItem('ac-dashboard-key','test-key'));await page.goto('http://agentcontrol.test/chat');await page.locator('#room-header h1').waitFor();await page.evaluate(()=>AC.core.stop());
   assert.equal(await page.locator('#skip-conversation').count(),1,'Keyboard workflow requires the conversation skip link');await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'skip-conversation');await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>document.activeElement.id),'timeline');
   if(name==='start'||name==='note'){await keyboardFocus(page,'#composer');await page.keyboard.type(name==='start'?'Keyboard goal':'Keyboard note');await page.keyboard.press('Control+Enter');await page.waitForFunction(()=>document.getElementById('composer').value==='');assert.deepEqual(posted,[{path:name==='start'?'/api/runs':'/api/control',body:name==='start'?{goal:'Keyboard goal'}:{run:'run_test',action:'instruction',text:'Keyboard note'}}]);}
   if(name==='question'){await keyboardFocus(page,'.decision-question input[value="JSON"]');await page.keyboard.press('Space');await keyboardFocus(page,'[data-decision="answer"]');await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('.decision-status').textContent.startsWith('Sent'));assert.deepEqual(posted,[{path:'/api/review',body:{...f.thread.messages.find(m=>m.action).action.fields,action:'answer',answers:[['JSON']]}}]);}
   if(name==='typed-approve'||name==='deny-redirect'){
    await keyboardFocus(page,'[data-decision="'+(name==='typed-approve'?'approve':'reject')+'"]');await page.keyboard.press('Enter');await page.locator('#decision-dialog[open]').waitFor();assert(await page.evaluate(()=>document.activeElement.hasAttribute('data-cancel-decision')));assert(await page.locator('#room').evaluate(n=>n.inert));
    await keyboardFocus(page,'#decision-dialog [name="'+(name==='typed-approve'?'confirm':'redirect')+'"]');await page.keyboard.type(name==='typed-approve'?'CONFIRM-TEST':'Use a safer approach');await keyboardFocus(page,'[data-confirm-decision]');await page.keyboard.press('Enter');await page.waitForFunction(()=>!document.getElementById('decision-dialog').open);await page.waitForFunction(()=>document.querySelector('.decision-status').textContent.startsWith('Sent'));
    assert.deepEqual(posted,[{path:'/api/review',body:{...f.thread.messages.find(m=>m.action).action.fields,action:name==='typed-approve'?'approve':'reject',...(name==='typed-approve'?{confirm:'CONFIRM-TEST'}:{redirect:'Use a safer approach'})}}]);assert.equal(await page.locator('#waiting-pointer').textContent(),'! 1 waiting for you');assert.equal(await page.locator('[data-actionable]').count(),1,'Keyboard click cannot manufacture a recorded decision');
   }
   if(name==='history'){await keyboardFocus(page,'#load-earlier');await page.keyboard.press('Enter');await page.waitForFunction(id=>document.activeElement?.dataset.message===id,f.pages[1].messages.find(m=>m.kind!=='session_start').id);assert.equal(posted.length,0);}
   if(name==='workspace'||name==='context-tabs'){
    if(width<1200){await keyboardFocus(page,'#open-rail',true);await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>document.activeElement.id),'close-rail');}
    await keyboardFocus(page,'#session-list a[href="#/s/run_test"]');await page.keyboard.press('Enter');await page.locator('#context:not([hidden])').waitFor();await keyboardFocus(page,'#session-tab',width<1200);await page.keyboard.press('ArrowRight');assert.equal(await page.evaluate(()=>document.activeElement.id),'members-tab');assert.equal(await page.locator('#members-tab').getAttribute('aria-selected'),'true');
    if(name==='context-tabs'){await page.keyboard.press('Home');assert.equal(await page.evaluate(()=>document.activeElement.id),'session-tab');await page.keyboard.press('End');assert.equal(await page.evaluate(()=>document.activeElement.id),'members-tab');}
    else{await keyboardFocus(page,'#live-members [data-member="coder-1"] [data-workspace-link]');await page.keyboard.press('Enter');await page.locator('#workspace-terminal').waitFor();assert(await page.evaluate(()=>document.activeElement.hasAttribute('data-back-room')));await keyboardFocus(page,'#ws-latest');await page.keyboard.press('Home');assert.equal(await page.evaluate(()=>document.activeElement.dataset.wsTurn),'ws-first');await page.keyboard.press('Enter');assert((await page.locator('#workspace-terminal').textContent()).includes('Earlier recorded turn'));await page.keyboard.press('End');await page.keyboard.press('Enter');await keyboardFocus(page,'#workspace-terminal');await page.keyboard.press('Home');assert.equal(await page.locator('#workspace-terminal').evaluate(n=>n.scrollTop),0);await keyboardFocus(page,'#ws-jump',true);await page.keyboard.press('Enter');await page.keyboard.press('Escape');await page.waitForFunction(()=>document.getElementById('workspace').hidden);assert(await page.evaluate(()=>document.activeElement.matches('[data-workspace-link]')));}
    assert.equal(posted.length,0);
   }
   await accessibilityAudit(page,'keyboard-'+name,String(width));await focusCheck(page,'keyboard-'+name,String(width));assert.deepEqual(errors,[]);const file=`keyboard-${name}-${width}-${colorScheme}.png`;await page.screenshot({animations:'disabled',path:path.join(out,file)});shots.push(file);
  }catch(e){failures.push({name,width,colorScheme,error:e.message});}finally{await page.close();}
 }
 fs.writeFileSync(path.join(out,'keyboard-results.json'),JSON.stringify({cases,failures},null,2));assert.equal(failures.length,0,JSON.stringify(failures));return {cases,screenshots:shots.length};
}
async function layoutCheck(page,name,size,width){
 await accessibilityAudit(page,name,size);
 await focusCheck(page,name,size);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${name}/${size}: page overflow`);
 const targets=await page.locator('a[href],button,input,textarea,select,summary,[role="tab"],[tabindex="0"]').evaluateAll(nodes=>nodes.filter(n=>n.getClientRects().length && getComputedStyle(n).visibility!=='hidden').map(n=>({name:n.id || n.getAttribute('aria-label') || n.textContent.slice(0,50),width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height})));
 targetMeasurements.push({name,size,width,colorScheme:await page.evaluate(()=>matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'),targets});
 if(width<1200){
  for(const t of targets)assert(t.width>=39.9 && t.height>=39.9,`${name}/${size} target ${t.name}: ${t.width}×${t.height}`);
 }
 if(size==='laptop'||size==='tablet'||size==='phone-landscape'){
  assert(await page.locator('#open-rail').isVisible(),'M8 tablet/landscape rail is a drawer');
  if(await page.locator('#context').isVisible()){const box=await page.locator('#context').boundingBox();assert(box.width<=560 && Math.abs(box.x-(width-box.width)/2)<1,'M8 tablet context card is centred and bounded');}
  for(const id of ['decision-dialog','stop-dialog','settings-sheet'])if(await page.locator('#'+id).isVisible()){const box=await page.locator('#'+id).boundingBox();assert(box.width<=560 && Math.abs(box.x-(width-box.width)/2)<1,'M8 tablet dialog/sheet is centred and bounded');}
 }
}
async function safeAreaCheck(page,selectors){
 const css=fs.readFileSync(path.join(root,'chat.css'),'utf8').replace(/env\(safe-area-inset-(?:bottom|left|right|top)\)/g,'20px');
 const style=await page.addStyleTag({content:css});
 for(const [selector,property] of selectors)assert.equal(await page.locator(selector).evaluate((n,p)=>getComputedStyle(n)[p],property),'20px','M8 emulated safe-area '+selector);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'M8 emulated inset overflow');await style.evaluate(n=>n.remove());
}
async function zoomCheck(page,name,colorScheme,out){
 const viewport=page.viewportSize();
 await page.setViewportSize({width:1280,height:800});await page.waitForFunction(()=>Math.abs(document.querySelector('#app').getBoundingClientRect().height-innerHeight)<1);
 const before=await page.locator('body').evaluate(n=>parseFloat(getComputedStyle(n).fontSize));
 await page.evaluate(()=>document.documentElement.style.fontSize='32px');
 const after=await page.locator('body').evaluate(n=>parseFloat(getComputedStyle(n).fontSize));
 assert(Math.abs(after-before*2)<.1,'M8 text zoom must actually double the text');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,name+' zoom overflow');
 if(await page.locator('#room-footer').isVisible()){const b=await page.locator('#composer').boundingBox();assert(b.y+b.height<=800 && b.height>=40,`${name} M8 zoom composer reachable: ${JSON.stringify(b)}`);}
 for(const box of await page.locator('button,summary,select,input:not([type="checkbox"]):not([type="radio"])').evaluateAll(nodes=>nodes.filter(n=>n.getClientRects().length).map(n=>({name:n.id || n.textContent.slice(0,30),scroll:n.scrollWidth,width:n.clientWidth}))))assert(box.scroll<=box.width+1,name+' zoom clipped control '+box.name);
 await accessibilityAudit(page,name,'text-zoom');await focusCheck(page,name,'text-zoom');
 await page.screenshot({animations:'disabled',path:path.join(out,`${name}-text-zoom-${colorScheme}.png`)});
 await page.evaluate(()=>document.documentElement.style.fontSize='');await page.setViewportSize(viewport);
}
const empty = fx.fixture();Object.assign(empty,{runs:[],run:null,inbox:[],agents:[]});
const active = fx.richActive();active.agents=[{name:'hermes',type:'orchestrator',state:'idle'},{name:'coder-1',type:'coder',state:'waiting_on_you',task:'Run tests'}];
const team=fx.clone(active);team.run.mode='team';team.agents.push({name:'coder-2',type:'coder',state:'working',task:'Build the CLI'},{name:'reviewer-1',type:'reviewer',state:'idle'});
(async()=>{
 fs.mkdirSync(out,{recursive:true});const browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});let count=0,combinations=0,cutoverCases=0;
 const composerCases={composerIdle:fx.composerFixture('new'),composerNote:fx.composerFixture('active'),composerPaused:fx.composerFixture('paused'),composerFollow:fx.composerFixture('finished'),composerBasic:fx.composerFixture('new'),composerAdvanced:fx.composerFixture('new'),composerStop:fx.composerFixture('active'),composerLiteral:fx.composerFixture('active'),composerTarget:fx.composerFixture('active'),composerCleanSettings:fx.composerFixture('new'),composerRestored:fx.composerFixture('finished')};
 const decisionCases=Object.fromEntries([['decisionCritical','critical'],['decisionQuestion','question'],['decisionTeam','proposal'],['decisionResearch','research'],['decisionInstall','skillInstall'],['decisionApply','outcome'],['decisionSent','low'],['decision409','low']].map(([name,kind])=>[name,fx.decisionFixture(kind)]));
 const membersCases=Object.fromEntries(['teamProposing','teamProposed','teamUnusable','teamRunning','teamReview','teamFinished','singleMembers','connections'].map(name=>[name,fx.membersFixture(name)]));membersCases.railPaged=fx.membersHistory();for(const name of ['teamStopping','teamExpired'])membersCases[name]=fx.endedPlan(name);
 const workspaceCases=Object.fromEntries(['workspaceLive','workspaceHistorical','workspaceUnknown','workspaceReviewer','workspaceNoOutput','workspaceNoTurns','workspaceResearcher','workspaceHermes','workspaceSurfaces'].map(name=>[name,fx.workspaceDetails(name)]));
 const longTitle='Long project '+('wide-title-' .repeat(80))+'<img src=x>';
 const longRoom=fx.composerFixture('active');longRoom.state.run.title=longTitle;longRoom.thread.sessions[0].title=longTitle;longRoom.channels=fx.threadChannels(longRoom.thread,1);longRoom.channels.channels[0].title=longTitle;composerCases.longRoom=longRoom;
 const longWorkspace=fx.workspaceDetails('workspaceHistorical');longWorkspace.state.run.title=longTitle;longWorkspace.thread.sessions[0].title=longTitle;longWorkspace.state.run.workspace.agents['coder-1'].branch='agent/'+('branch/'.repeat(100));longWorkspace.state.agents.find(a=>a.name==='coder-1').task=longTitle;workspaceCases.workspaceLong=longWorkspace;
 const measurements=[];let keyboardCases=0,deviceCases=0,discoveryCases=0;
 if(process.argv.includes('--cutover-only')){try{console.log((await cutoverSmoke(browser,out)).cases+' cutover smoke cases passed');}finally{await browser.close();}return;}
 if(process.argv.includes('--device-discovery-only')){try{console.log((await deviceDiscoveryCases(browser,out)).cases+' device discovery cases passed');}finally{await browser.close();}return;}
 if(process.argv.includes('--device-viewport-only')){try{console.log((await deviceViewportCases(browser,out)).cases+' device viewport cases passed');}finally{await browser.close();}return;}
 if(process.argv.includes('--phone-panels-only')){try{console.log(await phonePanelCases(browser,out)+' phone panel cases passed');}finally{await browser.close();}return;}
 if(process.argv.includes('--empty-history-only')){try{console.log(await emptyHistoryCases(browser,out)+' empty history cases passed');}finally{await browser.close();}return;}
 if(process.argv.includes('--accessibility-spots-only')){try{const shots=await accessibilitySpots(browser,out);console.log(shots+' accessibility spot checks passed');}finally{await browser.close();}return;}
 const contrast=fx.contrastReport(fs.readFileSync(path.join(root,'tokens.css'),'utf8'));fs.writeFileSync(path.join(out,'contrast-measurements.json'),JSON.stringify(contrast,null,2));assert.deepEqual(contrast.filter(v=>v.ratio<v.minimum),[]);
 try {const cutover=await cutoverSmoke(browser,out);count+=cutover.shots;cutoverCases=cutover.cases;const discovery=await deviceDiscoveryCases(browser,out);count+=discovery.shots;discoveryCases=discovery.cases;const device=await deviceViewportCases(browser,out);count+=device.shots;deviceCases=device.cases;count+=await accessibilitySpots(browser,out);count+=await emptyHistoryCases(browser,out);count+=await phonePanelCases(browser,out);const keyboard=await keyboardPaths(browser,out);count+=keyboard.screenshots;keyboardCases=keyboard.cases;for(const [name,state] of Object.entries({empty,active,completed:fx.richCompleted(),team,threadActive:active,threadTeam:team,threadLong:fx.richCompleted(),...Object.fromEntries(Object.entries({...composerCases,...decisionCases,...membersCases,...workspaceCases}).map(([name,f])=>[name,f.state]))}))for(const [size,[width,height]] of Object.entries(viewports))for(const colorScheme of ['light','dark']){
  combinations++;
  const pages=workspaceCases[name]?[workspaceCases[name].thread]:membersCases[name] ? [membersCases[name].thread,...(membersCases[name].older?[membersCases[name].older]:[])] : decisionCases[name] ? [decisionCases[name].thread] : composerCases[name] ? [composerCases[name].thread] : name==='threadLong' ? fx.threadLong() : [name==='empty' ? fx.threadResponse([],[]) : name==='threadTeam'||name==='team' ? fx.threadTeam() : name==='completed' ? fx.threadSingle() : fx.threadActive()];
  const page=await browser.newPage({viewport:{width,height},colorScheme,...(width<1200?{hasTouch:true,...(width<768 || size==='phone-landscape'?{isMobile:true}:{})}:{})});const errors=[];page.on('pageerror',err=>errors.push(err.message));
  await page.route('**/*',async route=>{const url=new URL(route.request().url());if(url.pathname.startsWith('/api/')){assert.equal(route.request().headers().authorization,'Bearer test-key');if(route.request().method()==='POST')return route.fulfill({status:name==='decision409'?409:200,contentType:'application/json',body:JSON.stringify(name==='decision409'?{error:'The requested action changed. Review the current request.'}:{ok:true})});if(url.pathname==='/api/workspace/preflight')return route.fulfill({contentType:'application/json',body:JSON.stringify(fx.composerPreflight)});if(url.pathname==='/api/sandbox')return route.fulfill({contentType:'application/json',body:JSON.stringify(state.sandbox || {unavailable:'No runtime',models_configured:false})});if(url.pathname==='/api/events')return route.fulfill({status:503,body:'unavailable'});if(url.pathname==='/api/channels')return route.fulfill({contentType:'application/json',body:JSON.stringify(workspaceCases[name]?.channels || membersCases[name]?.channels || composerCases[name]?.channels || fx.threadChannels(pages[0],pages[0].messages.filter(m=>m.action && m.kind!=='outcome').length))});if(url.pathname==='/api/thread'){if(url.searchParams.get('session')==='bogus')return route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({error:'Unknown session'})});const cursor=url.searchParams.get('before');return route.fulfill({contentType:'application/json',body:JSON.stringify(cursor==='members:older'?pages[1]:cursor==='long:250'?pages[1]:cursor==='long:50'?pages[2]:pages[0])});}return route.fulfill({contentType:'application/json',body:JSON.stringify(url.searchParams.get('run')==='bogus'?{...state,run:null,agents:[]}:state)});}const file=url.pathname==='/chat'? 'index.html':url.pathname.slice('/chat/'.length);assert(!file.includes('/'));return route.fulfill({path:path.join(root,file),contentType:{'.html':'text/html','.js':'text/javascript','.css':'text/css'}[path.extname(file)]});});
  await page.addInitScript(name=>{localStorage.setItem('ac-dashboard-key','test-key');if(name==='composerCleanSettings'||name==='composerRestored')localStorage.setItem('acx-settings',JSON.stringify({verifier:'V1',max_steps:4,mode:'single',title:'Old title',goal_checks:['Old check'],allow_dirty:true}));},name);await page.goto('http://agentcontrol.test/chat');await page.locator('#live').waitFor();if(name!=='empty' && pages[0].messages.length)await page.locator('#thread-items > article').first().waitFor({state:'attached'});
  const overflow=()=>page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  if(name==='longRoom')assert.equal(await page.locator('#room-header h1').getAttribute('title'),longTitle);
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
      if(size==='phone'){await safeAreaCheck(page,[['#decision-dialog','paddingBottom'],['#decision-dialog','paddingLeft']]);const sheet=await page.locator('#decision-dialog').boundingBox(), header=await page.locator('#room-header').boundingBox();assert(sheet.y>=header.y+header.height,'Bottom sheet must not cover the room header');assert(Math.abs(sheet.y+sheet.height-height)<1,'Dialog must sit at the phone bottom');assert(Math.abs(sheet.width-width)<1 && sheet.x===0,'Phone sheet must span the viewport');}
    }
    if(name==='decisionSent'||name==='decision409') {await card.locator('[data-decision="approve"]').click();await page.waitForFunction(([id,text])=>document.querySelector('[data-message="'+id+'"] .decision-status').textContent===text,[actionable.id,name==='decisionSent'?'Sent · waiting for AgentControl to record it':'The requested action changed. Review the current request.']);assert.equal(await page.locator('#waiting-pointer').textContent(),'! 1 waiting for you');}
    if(size==='phone') {
      for(const selector of ['.decision-buttons > button','#decision-dialog[open] button'])for(const box of await page.locator(selector).evaluateAll(nodes=>nodes.filter(node=>node.getClientRects().length).map(node=>({height:node.getBoundingClientRect().height,width:node.getBoundingClientRect().width,parent:node.parentElement.getBoundingClientRect().width})))){assert(box.height>=40,'Decision target must be at least 40 px');assert(Math.abs(box.width-box.parent)<1,'Phone decision buttons must span their row');}
      for(const height of await page.locator('.decision-question label,.decision-remember').evaluateAll(nodes=>nodes.filter(node=>node.getClientRects().length).map(node=>node.getBoundingClientRect().height)))assert(height>=40,'Phone answer and remember labels must provide a 40 px target');
    }
  }
  if(membersCases[name]) {
    await page.evaluate(id=>location.hash='#/s/'+id,state.run.id);await page.locator('#context:not([hidden])').waitFor();await page.locator('#members-tab').click();
    await page.waitForFunction(()=>document.querySelector('#live-members'));
    assert.equal(await page.locator('#context [data-decision]').count(),0);
    if(name==='teamProposed'){assert.equal(await page.locator('#live-members [data-member]').count(),1);assert.equal(await page.locator('#rail .members [data-member]').count(),1);assert((await page.locator('#context').textContent()).includes('Proposed team · not running yet'));}
    if(name==='teamStopping'||name==='teamExpired'){assert((await page.locator('#context').textContent()).includes('Proposed team · never approved'));assert.equal(await page.locator('[data-room-link="proposal"]').count(),0);assert(!(await page.locator('#rail').textContent()).includes('Team plan pending'));assert.equal(await page.locator('#live-members [data-member]').count(),1);}
    if(name==='teamRunning'){assert.equal(await page.locator('.task-group').count(),3);assert((await page.locator('#context').textContent()).includes('✕ Failed'));assert((await page.locator('#context').textContent()).includes('! Blocked'));const boxes=await page.locator('.task-title > :first-child').evaluateAll(nodes=>nodes.map(n=>({x:n.getBoundingClientRect().x,width:n.getBoundingClientRect().width})));assert(boxes.every(b=>Math.abs(b.x-boxes[0].x)<1 && Math.abs(b.width-boxes[0].width)<1),'M8 task ids must align regardless of whether they link to a turn');}
    if(name==='connections' || name==='railPaged'){await page.locator('#close-context').click();if(width<1200)await page.locator('#open-rail').click();}
    if(name==='connections'){await page.locator('#connections > summary').click();assert((await page.locator('#connections').textContent()).includes('! Needs attention'));await page.locator('#connections').scrollIntoViewIfNeeded();}
    if(name==='railPaged'){await page.locator('#load-earlier-sessions').click();await page.waitForFunction(()=>document.querySelectorAll('#session-list a').length===35);assert.equal(await page.locator('#session-count').count(),0);await page.locator('#session-list a').last().scrollIntoViewIfNeeded();}
    if(size==='phone')for(const height of await page.locator('#context a,#context button,#rail-check-connections,#load-earlier-sessions').evaluateAll(nodes=>nodes.filter(n=>n.getClientRects().length).map(n=>n.getBoundingClientRect().height)))assert(height>=40,'M6 phone target must be at least 40 px');
    for(const sentinel of ['TRANSCRIPT-SENTINEL','RESULT-SENTINEL','PROMPT-SENTINEL'])assert(!(await page.locator('body').textContent()).includes(sentinel));
  }
  if(workspaceCases[name]) {
    await page.evaluate(([run,agent])=>location.hash='#/w/'+encodeURIComponent(run)+'/'+encodeURIComponent(agent),[state.run.id,({workspaceUnknown:'absent-agent',workspaceReviewer:'reviewer-1',workspaceResearcher:'researcher-1',workspaceHermes:'hermes'})[name] || 'coder-1']);await page.locator('#workspace:not([hidden])').waitFor();
    await page.waitForFunction(()=>!document.querySelector('#workspace').textContent.includes('Loading Workspace…'));
    assert.equal(await page.locator('#workspace [data-decision]').count(),0);assert.equal(await overflow(),false);
    await layoutCheck(page,name,size,width);
    if(width>=1200){const room=await page.locator('#room').boundingBox(),ws=await page.locator('#workspace').boundingBox(),rail=await page.locator('#rail').boundingBox();assert(room.width>=420,'M8 desktop room must keep 420 px beside Workspace');assert(Math.abs(ws.width-Math.min(960,width-rail.width-420))<1);assert(await page.locator('#composer-target').evaluate(n=>n.scrollWidth<=n.clientWidth),'M8 composer chip must be untruncated');assert(await page.locator('#waiting .waiting-strip').evaluateAll(nodes=>nodes.every(n=>getComputedStyle(n).flexWrap==='nowrap')),'M8 waiting strip stays on one line');}

    if(name==='workspaceUnknown')assert((await page.locator('#workspace').textContent()).includes('No recorded agent named'));
    else assert((await page.locator('#workspace').textContent()).includes(({workspaceReviewer:'reviewer-1 (Review)',workspaceResearcher:'researcher-1',workspaceHermes:'Hermes'})[name] || 'coder-1 (API)'));
    if(size==='desktop'){const ws=await page.locator('#workspace').boundingBox(),room=await page.locator('#room').boundingBox();assert(ws.x>=room.x+room.width-1);assert(room.width>0);assert((await page.locator('#timeline').boundingBox()).height>height*.5,'Room conversation must remain usable beside the Workspace');assert((await page.locator('#room-header h1').boundingBox()).height<80,'Room title must remain readable');assert((await page.locator('#composer').boundingBox()).width>room.width*.7,'Room composer must remain usable');}
    if(size==='desktop' && name==='workspaceLive'){await page.locator('#session-menu > summary').click();await page.locator('[data-session-control="stop"]').click();await page.locator('#stop-dialog[open]').waitFor();await page.keyboard.press('Escape');assert.equal(await page.locator('#stop-dialog').evaluate(node=>node.open),false);assert.equal(await page.locator('#workspace').isVisible(),true);await page.locator('#session-menu > summary').click();}
    if(size==='desktop' && name==='workspaceLive'){await page.setViewportSize({width:1200,height});assert((await page.locator('#timeline').boundingBox()).height>height*.5);assert((await page.locator('#room-header h1').boundingBox()).height<80);assert((await page.locator('#composer').boundingBox()).width>(await page.locator('#room').boundingBox()).width*.7);assert(await page.locator('#waiting .waiting-strip').evaluate(n=>n.scrollWidth<=n.clientWidth),'Waiting pointer and recovery link must fit beside Workspace');assert.equal(await overflow(),false);await page.screenshot({path:path.join(out,`${name}-compact-desktop-${colorScheme}.png`)});count++;await page.setViewportSize({width,height});}
    if(name==='workspaceLive'){
      if(size==='phone')await safeAreaCheck(page,[['#workspace > header','paddingTop'],['#workspace > header','paddingRight']]);
      const terminal=page.locator('#workspace-terminal');assert.equal(await terminal.getAttribute('aria-live'),'off');assert.equal(await page.locator('#workspace img').count(),0);
      assert(await page.locator('[data-output-status="running"] > pre').evaluate(n=>n.scrollWidth>n.clientWidth),'Long tool output must scroll inside its pre');assert(await page.locator('[data-output-status="error"]').evaluate(n=>n.open));
      await terminal.evaluate(n=>{n.scrollTop=0;n.dispatchEvent(new Event('scroll'));});assert(await page.locator('#ws-jump').isVisible());
      const output=page.locator('[data-output-status="completed"]');await output.evaluate(n=>n.open=true);await output.locator('summary').focus();
      await page.evaluate(()=>AC.core.refresh());assert(await output.evaluate(n=>n.open));assert.equal(await page.evaluate(()=>document.activeElement.closest('details').dataset.outputStatus),'completed');
      await page.locator('[data-ws-turn="ws-first"]').click();assert((await terminal.textContent()).includes('Earlier recorded turn'));await page.locator('[data-ws-latest]').click();assert((await terminal.textContent()).includes('TRANSCRIPT-SENTINEL'));await terminal.evaluate(n=>{n.scrollTop=0;n.dispatchEvent(new Event('scroll'));});
      await page.locator('[data-output-status="error"] > summary').scrollIntoViewIfNeeded();assert(await page.locator('#ws-jump').isVisible());await page.screenshot({path:path.join(out,`${name}-${size}-${colorScheme}-error.png`)});count++;await terminal.evaluate(n=>{n.scrollTop=0;n.dispatchEvent(new Event('scroll'));});
      await page.locator('#workspace-terminal-section').scrollIntoViewIfNeeded();
    }
    if(name==='workspaceReviewer')assert((await page.locator('#workspace').textContent()).includes('OpenCode · read-only'));
    if(name==='workspaceHistorical'){
      assert((await page.locator('#workspace-verification').textContent()).includes('Verification failed · Exit code 1'));assert((await page.locator('#workspace-changes').textContent()).includes('Preview truncated'));assert.equal(await page.locator('#workspace-diff img').count(),0);assert.equal(await page.locator('#workspace-verification details').evaluate(n=>n.open),false);await page.locator('#workspace-changes').scrollIntoViewIfNeeded();
    }
    if(name==='workspaceResearcher'){assert.equal(await page.locator('.workspace-sources li').count(),8);assert.equal(await page.locator('.workspace-sources a').count(),0);await page.locator('#workspace-research').scrollIntoViewIfNeeded();}
    if(name==='workspaceHermes'){assert.equal(await page.locator('#workspace-hermes .workspace-records > li').count(),40);assert(!(await page.locator('#workspace').textContent()).includes('HERMES-REQUEST-SENTINEL'));await page.locator('#workspace-hermes').scrollIntoViewIfNeeded();}
    if(name==='workspaceSurfaces'){assert.equal(await page.locator('#workspace-surfaces a').count(),1);assert.equal(await page.locator('#workspace-surfaces img,#workspace-surfaces iframe,#workspace-surfaces button,#workspace-surfaces input').count(),0);await page.locator('#workspace-surfaces').scrollIntoViewIfNeeded();}
    if(name!=='workspaceUnknown'){const pane=await page.locator('#workspace').boundingBox(),header=await page.locator('#workspace > header').boundingBox();assert(Math.abs(header.y-pane.y)<2,'Workspace navigation must cover the pane top while scrolling');}
    if(await page.locator('.workspace-stages').count())for(const box of await page.locator('.workspace-stages .sr-only').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect())))assert(box.width<=1 && box.height<=1,'Stage state must be available without adding visible status clutter');
    if(name==='workspaceNoOutput')assert((await page.locator('#workspace-terminal').textContent()).includes('No output yet.'));
    if(name==='workspaceNoTurns')assert((await page.locator('#workspace').textContent()).includes('No turns yet.'));
    for(const sentinel of ['REASONING-SENTINEL','TOOLRESULTS-SENTINEL','UNKNOWN-SENTINEL'])assert(!(await page.locator('body').textContent()).includes(sentinel));
    for(const selector of ['#timeline','#context','#rail'])for(const sentinel of ['TRANSCRIPT-SENTINEL','PROMPT-SENTINEL','RESULT-SENTINEL'])assert(!(await page.locator(selector).textContent()).includes(sentinel));
    if(size==='phone'){assert.equal(await page.locator('#room-footer').isVisible(),false);for(const height of await page.locator('#workspace a,#workspace button,#workspace summary').evaluateAll(nodes=>nodes.filter(n=>!n.hidden).map(n=>n.getBoundingClientRect().height)))assert(height>=40);await page.setViewportSize({width:320,height});assert.equal(await overflow(),false);await page.screenshot({path:path.join(out,`${name}-narrow-phone-${colorScheme}.png`)});count++;await page.setViewportSize({width,height});}
    await page.screenshot({path:path.join(out,`${name}-${size}-${colorScheme}.png`)});count++;
    if(size==='desktop'){await zoomCheck(page,name,colorScheme,out);count++;}
    await page.locator('#workspace [data-back-room]').click();await page.waitForFunction(()=>document.querySelector('#workspace').hidden);assert.equal(await overflow(),false);
  }
  if(size==='phone' && (name==='composerNote'||name==='composerPaused'||name==='composerTarget'||name==='composerLiteral'))assert.equal(await page.locator('#composer-target').evaluate(node=>node.scrollWidth<=node.clientWidth),true,'Note target must be fully visible');
  if(size==='phone'){const heights=await page.evaluate(()=>({footer:document.getElementById('room-footer').getBoundingClientRect().height,waiting:document.querySelector('#waiting .waiting-strip')?.getBoundingClientRect().height || 0,timeline:document.getElementById('timeline').getBoundingClientRect().height,viewport:innerHeight}));measurements.push({name,size,colorScheme,...heights});assert(heights.footer <= (heights.waiting?120:72),`${name} footer ${heights.footer}`);assert(heights.waiting<=40 && (!heights.waiting || heights.waiting>=32),`${name} waiting row ${heights.waiting}`);if(heights.waiting){const baseline=await page.evaluate(()=>{const textTop=node=>{const range=document.createRange();range.selectNodeContents(node);return range.getBoundingClientRect().top;};return Math.abs(textTop(document.getElementById('waiting-pointer'))-textTop(document.querySelector('#waiting a')));});assert(baseline<1,`${name} waiting text/link misaligned by ${baseline}px`);}assert(heights.timeline>=heights.viewport*.65,`${name} timeline ${heights.timeline}`);}
  await layoutCheck(page,name,size,width);
  if(size==='phone-landscape'){const h=await page.evaluate(()=>({footer:document.querySelector('#room-footer').getBoundingClientRect().height,waiting:document.querySelector('#waiting .waiting-strip')?.getBoundingClientRect().height || 0,timeline:document.querySelector('#timeline').getBoundingClientRect().height,viewport:innerHeight}));measurements.push({name,size,colorScheme,...h});assert(h.footer<=(h.waiting?112:72),`${name} landscape footer ${h.footer}`);assert(h.timeline>=h.viewport*.45,`${name} landscape conversation ${h.timeline}`);}
  assert.equal(await page.evaluate(()=>[...document.querySelectorAll('body *')].some(node=>node.textContent.includes('youOpen'))),false,`${name}/${size}/${colorScheme} joined waiting link`);
  assert.equal(await overflow(),false,`${name}/${size}/${colorScheme} overflow`);
  if(size==='phone' && name.startsWith('thread')){const newest=page.locator('[data-message]:not([hidden])').last();assert(await newest.isVisible());const box=await newest.boundingBox();const area=await page.locator('#timeline').boundingBox();assert(box.y<area.y+area.height && box.y+box.height>area.y,'Newest message clipped out of timeline');if(state.inbox.length)assert(await page.locator('#waiting').isVisible());}
  if(name==='composerIdle' && size==='phone'){
    const safeCss=fs.readFileSync(path.join(root,'chat.css'),'utf8').replace(/env\(safe-area-inset-(?:bottom|left|right|top)\)/g,'20px');const style=await page.addStyleTag({content:safeCss});
    assert.equal(await page.locator('#room-footer').evaluate(n=>getComputedStyle(n).paddingBottom),'20px');assert.equal(await overflow(),false,'M8 emulated safe-area overflow');await page.screenshot({path:path.join(out,`safe-area-phone-${colorScheme}.png`)});count++;await style.evaluate(n=>n.remove());
await page.locator('#composer').fill(Array.from({length:10},()=>"A full line of a growing draft").join('\n'));const inputHeight=await page.locator('#composer').evaluate(node=>({height:node.getBoundingClientRect().height,line:parseFloat(getComputedStyle(node).lineHeight)}));assert(inputHeight.height<=Math.min(6*inputHeight.line+16,height*.4));await page.locator('#composer').fill('');await page.setViewportSize({width,height:480});await page.waitForFunction(()=>Math.abs(document.getElementById('app').getBoundingClientRect().height-visualViewport.height)<1);const keyboard=await page.locator('#room-footer').boundingBox();assert(keyboard.y+keyboard.height<=480,'Composer must remain above the emulated keyboard viewport');await page.screenshot({path:path.join(out,`composerKeyboard-phone-${colorScheme}.png`)});count++;await page.setViewportSize({width,height});await page.waitForFunction(()=>Math.abs(document.getElementById('app').getBoundingClientRect().height-visualViewport.height)<1);}
  await layoutCheck(page,name,size,width);
  await page.screenshot({animations:'disabled',path:path.join(out,`${name}-${size}-${colorScheme}${workspaceCases[name]?'-room':''}.png`)});count++;
  if(name==='teamRunning'){await page.locator('.task-graph').scrollIntoViewIfNeeded();if(width<1200){const header=await page.locator('#context > header').boundingBox(),pane=await page.locator('#context').boundingBox();assert(header.y>=pane.y-1 && header.y<=pane.y+17,'M8 context navigation stays visible while scrolling');}await page.screenshot({animations:'disabled',path:path.join(out,`${name}-${size}-${colorScheme}-tasks.png`)});count++;if(size==='phone'){await page.locator('#context').evaluate(node=>node.scrollTop=node.scrollHeight);await page.screenshot({animations:'disabled',path:path.join(out,`${name}-${size}-${colorScheme}-task-end.png`)});count++;}}
  if(size==='phone' && ['teamProposed','teamRunning','connections','railPaged','teamStopping','teamExpired'].includes(name)){await page.setViewportSize({width:320,height});assert.equal(await overflow(),false,`${name} narrow phone overflow`);for(const target of await page.locator('#context a,#context button,#rail button').evaluateAll(nodes=>nodes.filter(n=>n.getClientRects().length).map(n=>({height:n.getBoundingClientRect().height,right:n.getBoundingClientRect().right})))){assert(target.height>=40);assert(target.right<=320);}await page.screenshot({animations:'disabled',path:path.join(out,`${name}-narrow-phone-${colorScheme}.png`)});count++;await page.setViewportSize({width,height});}
  if(name==='decisionQuestion' && size==='phone') {
    await page.locator('#composer').fill('/apply');await page.locator('#composer').press('Control+Enter');await page.waitForFunction(()=>document.getElementById('composer-status').textContent==='Nothing to apply here');
    const budget=await page.evaluate(()=>({footer:document.getElementById('room-footer').getBoundingClientRect().height,timeline:document.getElementById('timeline').getBoundingClientRect().height,viewport:innerHeight}));assert(budget.footer<=120 && budget.timeline>=budget.viewport*.65,'M5 command errors must preserve the waiting footer budget');assert.equal(await overflow(),false);await page.screenshot({path:path.join(out,`decisionCommandError-phone-${colorScheme}.png`)});count++;
    const notice=await page.locator('#composer-status').boundingBox(), pointer=await page.locator('#waiting-pointer').boundingBox();assert(notice.y+notice.height<=pointer.y,'Command errors must not cover the waiting pointer');await page.locator('#waiting-pointer').click();assert(await page.locator('[data-message="m5:question"]').evaluate(node=>node.classList.contains('focused')));
  }
  if(state.run && name!=='threadLong' && !composerCases[name] && !decisionCases[name] && !membersCases[name] && !workspaceCases[name]){await page.evaluate(id=>location.hash='#/s/'+id,state.run.id);await page.locator('#context:not([hidden])').waitFor();assert.equal(await overflow(),false);await page.screenshot({animations:'disabled',path:path.join(out,`${name}-${size}-${colorScheme}-context.png`)});count++;await page.locator('#close-context').click();}
  if(size==='phone' && !composerCases[name] && !decisionCases[name] && !membersCases[name] && !workspaceCases[name]){await page.locator('#open-rail').click();assert.equal(await page.locator('#rail').isVisible(),true);assert.equal(await overflow(),false);await page.screenshot({animations:'disabled',path:path.join(out,`${name}-${size}-${colorScheme}-drawer.png`)});count++;await page.keyboard.press('Escape');assert.equal(await page.locator('#rail').isVisible(),false);}
  if(size==='desktop' && !workspaceCases[name]){await zoomCheck(page,name,colorScheme,out);count++;}
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
 {
  const f=fx.workspaceDetails(),page=await browser.newPage({viewport:{width:390,height:844}});let hold=false,release,signal,stateReads=0;
  const held=new Promise(resolve=>signal=resolve);
  await page.route('**/*',async route=>{const url=new URL(route.request().url());assert.notEqual(route.request().method(),'POST','Workspace must remain read-only');if(url.pathname==='/api/events')return route.fulfill({status:503,body:'unavailable'});if(url.pathname==='/api/channels')return route.fulfill({contentType:'application/json',body:JSON.stringify(f.channels)});if(url.pathname==='/api/thread')return route.fulfill({contentType:'application/json',body:JSON.stringify(f.thread)});if(url.pathname==='/api/state'){stateReads++;if(hold){signal();await new Promise(resolve=>release=resolve);}return route.fulfill({contentType:'application/json',body:JSON.stringify(f.state)});}if(url.pathname==='/api/sandbox')return route.fulfill({contentType:'application/json',body:JSON.stringify(f.state.sandbox || {})});const file=url.pathname==='/chat'?'index.html':url.pathname.slice('/chat/'.length);return route.fulfill({path:path.join(root,file),contentType:{'.html':'text/html','.js':'text/javascript','.css':'text/css'}[path.extname(file)]});});
  await page.addInitScript(()=>localStorage.setItem('ac-dashboard-key','test-key'));await page.goto('http://agentcontrol.test/chat');await page.locator('#thread-items article').first().waitFor();await page.evaluate(()=>AC.core.stop());
  hold=true;await page.evaluate(()=>{window.pendingLiveRead=AC.core.refresh();});await held;const before=stateReads;await page.evaluate(()=>{location.hash='#/w/run_test/coder-1';AC.shell.route();});await page.locator('#workspace-terminal').waitFor();assert.equal(stateReads,before,'Opening during a live read must not add a read');f.state.steps[1].transcript.push({type:'text',text:'BROWSER-RACE-RECORDED-OUTPUT'});hold=false;release();await page.evaluate(()=>pendingLiveRead);assert((await page.locator('#workspace-terminal').textContent()).includes('BROWSER-RACE-RECORDED-OUTPUT'));await page.screenshot({path:path.join(out,'regression-workspace-live-focus-phone.png')});count++;await page.close();
 }
 fs.writeFileSync(path.join(out,'input-font-measurements.json'),JSON.stringify(inputFontMeasurements,null,2));
 fs.writeFileSync(path.join(out,'accessibility-measurements.json'),JSON.stringify(accessibilityMeasurements,null,2));
 fs.writeFileSync(path.join(out,'target-measurements.json'),JSON.stringify(targetMeasurements,null,2));
 fs.writeFileSync(path.join(out,'focus-measurements.json'),JSON.stringify(focusMeasurements,null,2));
 fs.writeFileSync(path.join(out,'footer-measurements.json'),JSON.stringify(measurements,null,2));
 }finally{await browser.close();}console.log(`${count} screenshots; ${combinations} state/viewport/appearance combinations and ${19+keyboardCases+deviceCases+discoveryCases+cutoverCases} regression cases passed`);
})().catch(error=>{console.error(error);process.exitCode=1;});
