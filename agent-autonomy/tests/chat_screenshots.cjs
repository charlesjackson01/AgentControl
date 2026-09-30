/* Offline M1 browser matrix. Images stay in /tmp; CHROMIUM_PATH overrides discovery. */
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
 try {for(const [name,state] of Object.entries({empty,active,completed:fx.richCompleted(),team}))for(const [size,[width,height]] of Object.entries({desktop:[1440,900],laptop:[1024,768],phone:[390,844]}))for(const colorScheme of ['light','dark']){
  const page=await browser.newPage({viewport:{width,height},colorScheme});const errors=[];page.on('pageerror',err=>errors.push(err.message));
  await page.route('**/*',async route=>{const url=new URL(route.request().url());if(url.pathname.startsWith('/api/')){assert.equal(route.request().headers().authorization,'Bearer test-key');if(url.pathname==='/api/events')return route.fulfill({status:503,body:'unavailable'});return route.fulfill({contentType:'application/json',body:JSON.stringify(url.pathname==='/api/agents'?{agents:state.agents||[]}:state)});}const file=url.pathname==='/chat'? 'index.html':url.pathname.slice('/chat/'.length);assert(!file.includes('/'));return route.fulfill({path:path.join(root,file),contentType:{'.html':'text/html','.js':'text/javascript','.css':'text/css'}[path.extname(file)]});});
  await page.addInitScript(()=>localStorage.setItem('ac-dashboard-key','test-key'));await page.goto('http://agentcontrol.test/chat');await page.locator('#live').waitFor();
  const overflow=()=>page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(await overflow(),false,`${name}/${size}/${colorScheme} overflow`);
  await page.screenshot({animations:'disabled',path:path.join(out,`${name}-${size}-${colorScheme}.png`)});count++;
  if(state.run){await page.evaluate(id=>location.hash='#/s/'+id,state.run.id);await page.locator('#context:not([hidden])').waitFor();assert.equal(await overflow(),false);await page.screenshot({animations:'disabled',path:path.join(out,`${name}-${size}-${colorScheme}-context.png`)});count++;await page.locator('#close-context').click();}
  if(size==='phone'){await page.locator('#open-rail').click();assert.equal(await page.locator('#rail').isVisible(),true);assert.equal(await overflow(),false);await page.screenshot({animations:'disabled',path:path.join(out,`${name}-${size}-${colorScheme}-drawer.png`)});count++;await page.keyboard.press('Escape');assert.equal(await page.locator('#rail').isVisible(),false);}
  assert.deepEqual(errors,[]);await page.close();
 }}finally{await browser.close();}console.log(`${count} screenshots; 24 state/viewport/appearance combinations passed`);
})().catch(error=>{console.error(error);process.exitCode=1;});
