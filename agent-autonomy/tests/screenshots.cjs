/* Rendered screenshots of the dashboard with simulated data.
   Optional development check; needs playwright-core and the preinstalled Chromium:
     npm install --prefix /tmp/ac-tests --no-save playwright-core linkedom cssom
     NODE_PATH=/tmp/ac-tests/node_modules node agent-autonomy/tests/screenshots.cjs [outdir] [filter]
   No services are contacted: every request is answered from tests/fixtures.cjs. */
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright-core');
const fx = require('./fixtures.cjs');

const root = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || path.join(__dirname, 'screenshots'));
const only = process.argv[3] || '';
const executablePath = process.env.CHROMIUM_PATH || ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].find(p => fs.existsSync(p) && fs.statSync(p).isFile());
const types = {'.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript'};
const widths = {desktop: [1440, 900], laptop: [1024, 768], phone: [390, 844]};
const themes = ['mac', 'terminal', 'xp'];

const scenarios = {
  login: {state: fx.richActive, key: false},
  empty: {state: fx.empty},
  active: {state: fx.richActive},
  running: {state: () => { const s = fx.richActive(); s.inbox = []; s.run.status = 'coding'; return s; }},
  completed: {state: fx.richCompleted},
  project: {state: () => { const s = fx.richCompleted(); s.run.preview = {mode: 'cli', command: 'python3 demo_app/todo.py', args: 'list'};
    s.preview = {state: 'exited', run: s.run.id, mode: 'cli', command: 'python3 demo_app/todo.py', args: 'list', exit_code: 0, offset: 0, started: 1790600000, error: ''}; return s; },
    click: '.nav [data-view="project"]'},
  approvals: {state: fx.richActive, click: '[data-view="approvals"]'},
  activity: {state: fx.richActive, click: '[data-view="activity"]'},
  review: {state: fx.richActive, click: '#inline-approvals [data-intent="approve"]'},
  newrun: {state: fx.empty, click: '#empty-state [data-action="new"]'},
};

async function open(browser, theme, [width, height], scenario) {
  const context = await browser.newContext({viewport: {width, height}, deviceScaleFactor: 1, reducedMotion: 'reduce', colorScheme: process.env.COLOR_SCHEME || 'light'});
  const page = await context.newPage();
  const state = scenario.state();
  await page.addInitScript(([theme, key]) => {
    localStorage.setItem('ac-theme', theme);
    if (key) sessionStorage.setItem('trial-dashboard-key', 'screenshot-key');
  }, [theme, scenario.key !== false]);
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) {
      if (scenario.key === false) return route.fulfill({status: 401, contentType: 'application/json', body: JSON.stringify({error: 'Enter the dashboard key printed in your server terminal.'})});
      const body = url.pathname === '/api/state' ? (typeof scenario.live === 'function' ? scenario.live(state) : state) : {ok: true};
      return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(body)});
    }
    const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: 'not found'});
    return route.fulfill({status: 200, contentType: types[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
  });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://agentcontrol.test/', {waitUntil: 'domcontentloaded'});
  await page.waitForTimeout(400);
  if (scenario.click) {
    if (!(await page.locator(scenario.click + ':visible').count()) && (await page.locator('[data-action="drawer"]:visible').count())) {
      // Navigation lives in the drawer on phones.
      await page.click('[data-action="drawer"]:visible');
    }
    await page.locator(scenario.click + ':visible').first().click({timeout: 5000});
    await page.waitForTimeout(250);
  }
  return {context, page, errors};
}

async function overflow(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const wide = doc.scrollWidth > doc.clientWidth + 1;
    const culprits = wide ? [...document.querySelectorAll('body *')].filter(e => {
      const r = e.getBoundingClientRect();
      return r.width && r.right > doc.clientWidth + 1 && getComputedStyle(e).position !== 'fixed';
    }).slice(0, 5).map(e => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ').join('.') : '')) : [];
    return {wide, scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, culprits};
  });
}

async function main() {
  if (!executablePath) throw Error('Chromium not found; set CHROMIUM_PATH.');
  fs.mkdirSync(out, {recursive: true});
  const browser = await chromium.launch({executablePath});
  const report = [];
  for (const [name, scenario] of Object.entries(scenarios)) for (const theme of themes) for (const [size, viewport] of Object.entries(widths)) {
    const file = `${name}-${theme}-${size}.png`;
    if (only && !file.includes(only)) continue;
    const {context, page, errors} = await open(browser, theme, viewport, scenario);
    await page.screenshot({path: path.join(out, file), fullPage: true});
    const o = await overflow(page);
    report.push({file, errors, ...o});
    if (errors.length || o.wide) console.log(`WARN ${file}`, JSON.stringify({errors, ...o}));
    await context.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`${report.length} screenshots in ${out}; ${report.filter(r => r.wide || r.errors.length).length} with warnings.`);
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = {scenarios, open, executablePath};
