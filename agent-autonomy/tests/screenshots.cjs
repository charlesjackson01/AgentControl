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

const CLEAN_GIT = {is_repo: true, usable: true, reason: '', branch: 'main', subdir: '', changes: [], untracked: [], dirty_count: 0};
const SANDBOX = {runtime: 'podman', rootless: true, version: '5.2.0', image: true, error: '', unavailable: '', allow_rootful: false, models_configured: true, build_command: ''};
function teamState() { const s = fx.richActive(); s.inbox = []; s.run.status = 'coding'; s.run.mode = 'team';
    s.run.team = {state: 'running', agents: {'coder-1': {label: 'core'}, 'coder-2': {label: 'docs-ui'}},
      tasks: [{id: 't1', title: 'JSON storage with tests', agent: 'coder-1', depends_on: [], status: 'done', attempts: 1, steps: [s.steps[0].id]},
              {id: 't2', title: 'Static HTML task list', agent: 'coder-2', depends_on: [], status: 'running', attempts: 2, reason: 'conflicts with already-merged work in demo_app/README.md', steps: [s.steps[1].id]},
              {id: 't3', title: 'CLI commands and README usage', agent: 'coder-1', depends_on: ['t1'], status: 'running', attempts: 1, steps: []}]};
    s.steps[0].agent = 'coder-1'; s.steps[1].agent = 'coder-2'; s.steps[1].title = 't2: Static HTML task list';
    s.agents = [{name: 'hermes', state: 'idle'}, {name: 'coder-1', state: 'working', task: 't3: CLI commands'}, {name: 'coder-2', state: 'working', task: 't2: Static HTML task list'}];
    return s;
}

// Mission control (M11): agent identities, per-agent usage, a request for coder-2, the model queue.
function withMission(s) {
  const team = s.run.mode === 'team';
  s.agents = [{name: 'hermes', type: 'orchestrator', role: 'Orchestrator', runtime: 'hermes-cli', model: 'Hermes profile test-profile', state: team ? 'idle' : 'idle', task: '', stats: {turns: 3, tool_calls: 0}},
    {name: 'coder-1', type: 'coder', role: 'Coder', runtime: 'opencode', model: "OpenCode server's configured model", state: 'working', task: team ? 't3: CLI commands and README usage' : s.steps.at(-1).title, stats: {turns: team ? 1 : s.steps.length, tool_calls: 7}},
    ...(team ? [{name: 'coder-2', type: 'coder', role: 'Coder', runtime: 'opencode', model: "OpenCode server's configured model", state: 'waiting_on_you', task: 't2: Static HTML task list', stats: {turns: 1, tool_calls: 4}}] : [])];
  s.run.plan = ['Storage module with tests', 'CLI commands', 'README usage'];
  s.run.decision_count = 3;
  s.run.workspace = {mode: 'worktree', base_branch: 'main', base: 'abc123', integration: {branch: `agentcontrol/${s.run.id}/integration`},
    agents: Object.fromEntries(s.agents.filter(a => a.type === 'coder').map(a => [a.name, {branch: `agentcontrol/${s.run.id}/${a.name}`}]))};
  if (team) { s.inbox = [{...fx.richActive().inbox[0], run: s.run.id, agent: 'coder-2'}]; s.steps[1].status = 'running'; }
  s.models = {configured: true, endpoints: [{id: 'local', url: 'http://127.0.0.1:8080', slots: 1, default: true, in_flight: [{agent: 'coder-1'}], queued: team ? [{agent: 'hermes'}] : [], health: {state: 'online', latency_ms: 11}}]};
  s.usage = {total: {calls: 6, tokens_in: 31200, tokens_out: 3900, cost: 0}, by_agent: {hermes: {calls: 3, tokens_in: 12480, tokens_out: 1500}, 'coder-1': {calls: 2, tokens_in: 11920, tokens_out: 1700},
    ...(team ? {'coder-2': {calls: 1, tokens_in: 6800, tokens_out: 700}} : {})}};
  return s;
}
// Specialists (M12): a reviewer with findings, a researcher with a report and a new question waiting.
function withSpecialists(s) {
  s = withMission(s);
  const base = s.steps[0];
  s.run.team.agents['reviewer-1'] = {label: 'qa', role: 'reviewer'};
  s.run.team.agents['researcher-1'] = {label: 'docs', role: 'researcher'};
  s.agents.push({name: 'reviewer-1', type: 'reviewer', role: 'Reviewer', runtime: 'opencode', state: 'idle', stats: {turns: 1, tool_calls: 6}},
    {name: 'researcher-1', type: 'researcher', role: 'Researcher', runtime: 'hermes-cli', state: 'waiting_on_you', task: 'Waiting for your approval: t5: Retry-After', stats: {turns: 1}});
  s.steps.push({...base, id: 'step_rev', number: 3, title: 't4: Review the storage module', agent: 'reviewer-1', role: 'reviewer', status: 'finished',
    findings: {verdict: 'changes', summary: 'Saving is atomic, but a corrupt file crashes list.', findings: [
      {file: 'demo_app/todo.py', line: 41, severity: 'high', issue: 'json.load raises on a corrupt tasks.json and the CLI exits with a traceback.', suggestion: 'Catch JSONDecodeError and explain how to recover.'},
      {file: 'demo_app/test_todo.py', line: 0, severity: 'low', issue: 'No test covers an empty file.', suggestion: 'Add a test that starts from an empty tasks.json.'}]},
    verification: {status: 'not applicable', output: ''}, evidence: {changed_files: [], diff: '', file_stats: []}},
    {...base, id: 'step_res', number: 4, title: 't0: File locking', agent: 'researcher-1', role: 'researcher', status: 'finished', question: 'How can a Python CLI write a JSON file atomically on Linux and Windows?',
      report: {summary: 'Write to a temporary file in the same folder, flush and fsync it, then os.replace() it over the original.', findings: [
        {claim: 'os.replace is atomic on POSIX and overwrites the destination on Windows.', sources: ['https://docs.python.org/3/library/os.html#os.replace']},
        {claim: 'The temporary file must be on the same filesystem as the target.', sources: ['https://docs.python.org/3/library/tempfile.html']}], open_questions: [], sources: []},
      verification: {status: 'not applicable', output: ''}, evidence: {changed_files: [], diff: '', file_stats: []}});
  s.research_requests = [{run: s.run.id, step: 'step_ask', number: 5, title: 't5: Retry-After', agent: 'researcher-1', question: 'Is there a standard format for a "last modified" line in a plain-text CLI listing?',
    why: 'The list command should show when each task changed.', toolsets: ['web'], max_turns: 8, seconds: 600, fingerprint: 'fp', created: s.run.created}];
  s.roles = {coder: '', tester: '', reviewer: '', researcher: ''};
  return s;
}
const USAGE_REPORT = {period: 'month', monthly_cap: 20, total: {calls: 14, tokens_in: 182000, tokens_out: 21400, cost: 0.1832}, rows: [
  {run: 'run_live', title: 'Todo app', agent: 'hermes', endpoint: 'router', paid: true, calls: 4, tokens_in: 41200, tokens_out: 5100, cost: 0.1832},
  {run: 'run_live', title: 'Todo app', agent: 'coder-1', endpoint: 'local', paid: false, calls: 7, tokens_in: 120400, tokens_out: 14100, cost: 0},
  {run: 'run_live', title: 'Todo app', agent: 'researcher-1', endpoint: 'local', paid: false, calls: 3, tokens_in: 20400, tokens_out: 2200, cost: 0}]};
const MODEL_OPTIONS = {default: 'local', monthly_cap: 20, endpoints: [{id: 'router', model: 'anthropic/claude-sonnet', paid: true, cost_per_mtok_in: 3, cost_per_mtok_out: 15}],
  unavailable: {orchestrator: '', coder: '', tester: '', reviewer: '', researcher: 'Hermes reaches other models only through the gateway: start with --gateway-port and --hermes-provider (see the README).'}};
// A VM run (M13): a KVM clone, cut off to the host-only network after setup.
function withVm(s) {
  s.inbox = []; s.run.status = 'coding'; s.run.isolation = 'vm';
  s.run.workspace = {mode: 'worktree', base_branch: 'main', base: 'abc123', integration: {branch: `agentcontrol/${s.run.id}/integration`}, agents: {'coder-1': {branch: `agentcontrol/${s.run.id}/coder-1`}}};
  s.workspace = {state: 'open', exists: true, commits: 1, shortstat: '1 file changed, 12 insertions(+)', apply_blocked: '', last_integration: {status: 'merged', files: []}};
  s.vm = {name: `agentcontrol-${s.run.id}`, baseline: '/home/you/ai-arch/vms/ai-arch-baseline-with-tailscale.qcow2', cpus: 4, memory_gb: 8, network: 'setup',
    state: 'running', live: 'running', network_state: 'none', network_cut: s.run.created, ip: '192.168.231.20'};
  return s;
}
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
  projects: {state: () => { const s = fx.richCompleted(); s.projects_root = '/home/you'; s.project = '/home/you/todo-app'; return s; },
    api: {'/api/projects/browse': {root: '/home/you', path: '/home/you', parent: null, git: false, current: '/home/you/todo-app', truncated: false,
      entries: [{name: 'ac-demo', path: '/home/you/ac-demo', git: true}, {name: 'ai-arch', path: '/home/you/ai-arch', git: true},
        {name: 'Documents', path: '/home/you/Documents', git: false}, {name: 'todo-app', path: '/home/you/todo-app', git: true},
        {name: 'a-folder-with-a-rather-long-name-to-check-wrapping', path: '/home/you/a-folder-with-a-rather-long-name-to-check-wrapping', git: false}]}},
    click: '#project-name'},
  activity: {state: fx.richActive, click: '[data-view="activity"]'},
  review: {state: fx.richActive, click: '#inline-approvals [data-intent="approve"]'},
  newrun: {state: fx.empty, click: '#empty-state [data-action="new"]'},
  critical: {state: () => withRisk(fx.richActive()), click: '#inline-approvals [data-intent="approve"]'},
  branch: {state: () => { const s = fx.richCompleted();
    s.run.workspace = {mode: 'worktree', base_branch: 'main', base: 'abc123', integration: {branch: `agentcontrol/${s.run.id}/integration`}, agents: {'coder-1': {branch: `agentcontrol/${s.run.id}/coder-1`}}};
    s.workspace = {state: 'open', exists: true, commits: 2, shortstat: '2 files changed, 105 insertions(+)', apply_blocked: '', last_integration: {status: 'merged', files: []}};
    return s; }},
  proposal: {state: () => { const s = fx.richActive(); s.inbox = []; s.steps = []; s.run.status = 'awaiting_approval'; s.run.mode = 'team';
    s.run.summary = 'Hermes proposes 2 agents and 3 tasks. Review the plan.';
    s.run.team = {state: 'proposed', max_agents: 3, proposals: 1, notes: [], agents: {}, tasks: [], problems: [],
      warnings: ['t2 (coder-2) and t3 (coder-1) both touch demo_app/README.md and may conflict'],
      proposal: {mode: 'multi', reason: 'Storage and the CLI are independent; the README and HTML view depend on both.',
        agents: {'coder-1': {label: 'core', responsibility: 'Task storage and the command-line interface'}, 'coder-2': {label: 'docs-ui', responsibility: 'README and the static HTML view'}},
        tasks: [{id: 't1', title: 'JSON storage with tests', agent: 'coder-1', depends_on: [], files: ['demo_app/store.py', 'demo_app/test_store.py']},
                {id: 't2', title: 'Static HTML task list', agent: 'coder-2', depends_on: [], files: ['demo_app/index.html', 'demo_app/README.md']},
                {id: 't3', title: 'CLI commands and README usage', agent: 'coder-1', depends_on: ['t1'], files: ['demo_app/todo.py', 'demo_app/README.md']}]}};
    return s; }},
  team: {state: () => teamState()},
  skills: {state: () => withSkills(fx.richActive()), click: '[data-view="approvals"]'},
  skillsrun: {state: () => withSkills(fx.richActive())},
  skillstab: {state: () => withSkills(fx.richActive()), click: '[data-view="skills"]'},
  dirty: {state: fx.empty, click: '#empty-state [data-action="new"]',
    preflight: {is_repo: true, usable: true, reason: '', branch: 'main', subdir: '', changes: ['demo_app/todo.py'], untracked: ['notes.txt'], dirty_count: 2}},
  rules: {state: () => withRisk(fx.richActive()), click: '[data-view="approvals"]'},
  models: {state: () => { const s = fx.richActive(); s.inbox = []; s.run.status = 'coding';
    s.health.agents.model = {state: 'ready', label: 'local online · 12 ms'};
    s.models = {configured: true, gateway: {port: 8768}, endpoints: [{id: 'local', url: 'http://127.0.0.1:8080', slots: 1, default: true,
      in_flight: [{agent: 'opencode'}], queued: [{agent: 'hermes', role: 'orchestrator'}], health: {state: 'online', latency_ms: 12}}]};
    s.usage = {total: {calls: 4, tokens_in: 21400, tokens_out: 2300, cost: 0}, by_agent: {
      hermes: {calls: 3, tokens_in: 10480, tokens_out: 1300, queued_ms: 4000}, 'coder-1': {calls: 1, tokens_in: 10920, tokens_out: 1000, queued_ms: 0}}};
    return s; }},
  mission: {state: () => withMission(teamState()), view: 'mission'},
  missionsingle: {state: () => withMission((() => { const s = fx.richActive(); s.inbox[0].agent = 'coder-1'; return s; })()), view: 'mission'},
  missionempty: {state: fx.empty, view: 'mission'},
  agent: {state: () => withMission(teamState()), view: 'mission', click: '[data-agent="coder-2"]'},
  specialists: {state: () => withSpecialists(teamState()), view: 'mission'},
  researchask: {state: () => withSpecialists(teamState()), view: 'approvals'},
  findings: {state: () => withSpecialists(teamState()), view: 'runs'},
  paidrun: {state: () => { const s = fx.richActive(); s.inbox = []; s.run.status = 'paused'; s.run.pause = true; s.run.models = {orchestrator: 'router'}; s.run.spend_cap = 0.5;
    s.run.summary = 'Spend cap reached ($0.5012 of $0.50). Raise the cap or switch the role to your local model, then Resume.';
    s.spend = {run: 0.5012, cap: 0.5, month: 3.2, monthly_cap: 20};
    s.usage = {total: {calls: 6, tokens_in: 31200, tokens_out: 3900, cost: 0.5012}, by_agent: {hermes: {calls: 3, tokens_in: 12480, tokens_out: 1500, cost: 0.5012}, 'coder-1': {calls: 3, tokens_in: 18720, tokens_out: 2400, cost: 0}}};
    s.models = {configured: true, endpoints: [{id: 'local', slots: 1, default: true, in_flight: [], queued: [], health: {state: 'online'}}]}; return s; }},
  modelsnew: {state: () => ({...fx.empty(), model_options: MODEL_OPTIONS}), click: ['#empty-state [data-action="new"]'], preflight: CLEAN_GIT},
  usage: {state: fx.richActive, view: 'usage', api: {'/api/usage': USAGE_REPORT}},
  vmnew: {state: () => ({...fx.empty(), vm_env: {unavailable: '', models_configured: true, version: 'libvirt 10.9.0', baseline: '/home/you/ai-arch/vms/ai-arch-baseline-with-tailscale.qcow2'}}),
    click: ['#empty-state [data-action="new"]', '#iso-vm'], preflight: CLEAN_GIT},
  vmrun: {state: () => withVm(fx.richActive()), view: 'runs'},
  vmconsole: {state: () => withVm(fx.richActive()), view: 'project'},
  containernew: {state: () => ({...fx.empty(), sandbox: SANDBOX}), click: ['#empty-state [data-action="new"]', '#iso-container'], preflight: CLEAN_GIT},
  containeroff: {state: () => ({...fx.empty(), sandbox: {...SANDBOX, rootless: false, unavailable: 'docker runs as root on this machine. Agent containers need rootless Docker or Podman (see the README), or start AgentControl with --allow-rootful-containers.'}}),
    click: '#empty-state [data-action="new"]', preflight: CLEAN_GIT},
  container: {state: () => { const s = fx.richActive(); s.inbox = []; s.run.status = 'coding'; s.run.isolation = 'container';
    s.run.workspace = {mode: 'worktree', base_branch: 'main', base: 'abc123', integration: {branch: `agentcontrol/${s.run.id}/integration`}, agents: {'coder-1': {branch: `agentcontrol/${s.run.id}/coder-1`}}};
    s.workspace = {state: 'open', exists: true, commits: 1, shortstat: '1 file changed, 12 insertions(+)', apply_blocked: '', last_integration: {status: 'merged', files: []}};
    s.container = {name: `agentcontrol-${s.run.id}`, runtime: 'podman', rootless: true, image: 'agentcontrol-agent:1', cpus: 4, memory_gb: 8, network: 'setup',
      state: 'running', live: 'running', network_state: 'none', network_cut: s.run.created, networks: ['none']};
    return s; }},
};

// Permission risk (M4): a critical request, one remembered rule, and a short audit trail.
function withRisk(s) {
  s.permissions = {confirm_word: 'approve', labels: {low: 'Low', sensitive: 'Sensitive', critical: 'Critical'}};
  s.inbox[0].risk = {class: 'critical', level: 'R3', label: 'Critical', permission: 'bash', decision: 'confirm', remember_allowed: false,
    impact: 'Runs a shell command in the project folder. It can change files, install software, or reach the network.', reasons: ['recursive delete']};
  s.inbox[0].patterns = ['rm -rf demo_app/build'];
  s.inbox[0].context = {input: {command: 'rm -rf demo_app/build'}};
  s.run.grants = [{id: 'a1b2c3d4e5f6', permission: 'bash', match: 'python3 -m unittest discover -s demo_app', class: 'sensitive', level: 'R2', revoked: false}];
  s.audit = [
    {seq: 11, created: s.run.created, action: 'requested', actor: 'coder-1', risk: 'R2', permission: 'bash', target: 'python3 -m unittest discover -s demo_app'},
    {seq: 12, created: s.run.created, action: 'permission approve', actor: 'You, via dashboard', risk: 'R2', permission: 'bash', target: 'python3 -m unittest discover -s demo_app'},
    {seq: 13, created: s.run.created, action: 'rule added', actor: 'You, via dashboard', risk: 'R2', permission: 'bash', target: 'python3 -m unittest discover -s demo_app'},
    {seq: 14, created: s.run.created, action: 'requested', actor: 'coder-1', risk: 'R3', permission: 'bash', target: 'rm -rf demo_app/build'}];
  s.audit_chain = {intact: true, broken_at: null};
  return s;
}

// Skills (M9): one installed, one Hermes proposal with a script, one waiting to be fetched.
function withSkills(s) {
  s.inbox = [];
  s.run.workspace = {mode: 'worktree', base_branch: 'main', base: 'abc', integration: {branch: `agentcontrol/${s.run.id}/integration`}, agents: {'coder-1': {branch: 'b'}}};
  s.workspace = {state: 'open', exists: true, commits: 1, shortstat: '2 files changed, 105 insertions(+)', apply_blocked: '', last_integration: {status: 'merged', files: []}};
  const installed = {id: 'cap1', run: s.run.id, agent: 'coder-1', name: 'python-testing', state: 'installed', risk: 'low', source: {type: 'library', folder: 'python-testing'}, files: [{path: 'SKILL.md', size: 812}], created: s.run.created};
  const proposed = {id: 'cap2', run: s.run.id, agent: 'coder-1', name: 'json-schema', state: 'proposed', risk: 'sensitive', requested_by: 'hermes', created: s.run.created,
    reason: 'Validate the saved task file against a schema.', description: 'Write and check JSON Schemas for data files.',
    reasons: ['contains a script or program: scripts/validate.py'], source: {type: 'git', url: 'https://github.com/example/agent-skills.git', commit: '9f2c1e7ab04d5e6f7a8b9c0d', path: 'json-schema'},
    files: [{path: 'SKILL.md', size: 1480}, {path: 'scripts/validate.py', size: 610}, {path: 'reference.md', size: 2210}],
    skill_md: '---\nname: json-schema\ndescription: Write and check JSON Schemas for data files.\n---\n\n# JSON Schema\n\n1. Draft the schema next to the data file.\n2. Run scripts/validate.py to check it.\n'};
  const fetchable = {id: 'cap3', run: s.run.id, agent: 'coder-1', name: 'readme-style', state: 'awaiting_fetch', requested_by: 'hermes', created: s.run.created,
    reason: 'Match the README conventions.', source: {type: 'git', url: 'https://github.com/example/docs-skills.git', ref: 'main', path: 'readme'}};
  s.skills = {library_path: '/home/you/agentcontrol/skills', installs: [installed, proposed, fetchable], log: [proposed, fetchable, installed],
    library: [{name: 'python-testing', folder: 'python-testing', description: 'unittest patterns and running tests quickly.', files: [{path: 'SKILL.md'}], risk: 'low', trusted: true, error: ''},
      {name: 'cli-design', folder: 'cli-design', description: 'argparse layouts, help text and exit codes.', files: [{path: 'SKILL.md'}, {path: 'examples.md'}], risk: 'low', trusted: false, error: ''},
      {name: 'old-notes', folder: 'old-notes', error: 'old-notes: SKILL.md is missing'}]};
  return s;
}

async function open(browser, theme, [width, height], scenario) {
  const context = await browser.newContext({viewport: {width, height}, deviceScaleFactor: 1, reducedMotion: 'reduce', colorScheme: process.env.COLOR_SCHEME || 'light'});
  const page = await context.newPage();
  const state = scenario.state();
  await page.addInitScript(([theme, key, view]) => {
    localStorage.setItem('ac-theme', theme);
    localStorage.setItem('ac-view', view);
    if (key) sessionStorage.setItem('trial-dashboard-key', 'screenshot-key');
  }, [theme, scenario.key !== false, scenario.view || 'runs']);
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/vm/screen') {
      return route.fulfill({status: 200, contentType: 'image/png', body: fs.readFileSync(path.join(__dirname, 'assets', 'vm-console.png'))});
    }
    if (url.pathname.startsWith('/api/')) {
      if (scenario.key === false) return route.fulfill({status: 401, contentType: 'application/json', body: JSON.stringify({error: 'Enter the dashboard key printed in your server terminal.'})});
      const body = (scenario.api || {})[url.pathname] ? scenario.api[url.pathname]
        : url.pathname === '/api/state' ? (typeof scenario.live === 'function' ? scenario.live(state) : state)
        : url.pathname === '/api/workspace/preflight' ? (scenario.preflight || {is_repo: false, usable: false, reason: '', changes: [], untracked: [], dirty_count: 0}) : {ok: true};
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
  for (const click of [].concat(scenario.click || [])) {
    if (!(await page.locator(click + ':visible').count()) && (await page.locator('[data-action="drawer"]:visible').count())) {
      // Navigation lives in the drawer on phones.
      await page.click('[data-action="drawer"]:visible');
    }
    await page.locator(click + ':visible').first().click({timeout: 5000});
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
