/* Shared simulated /api/state payloads for DOM tests and screenshots.
   Nothing here is real run data; it only exercises the interface. */
const clone = value => JSON.parse(JSON.stringify(value));

function fixture(question = false) {
  const run = {
    id: 'run_test', goal: 'Exercise the dashboard with simulated data.', created: '2026-09-28T16:00:00Z',
    deadline: 1790613000, time_limit_seconds: 1800, max_steps: 6, status: 'waiting', phase: 'code', session: 'ses_test',
    pause: false, stop: false, summary: 'A test permission is waiting.', verifier: ['python3', '-m', 'unittest'],
    instructions: [], decision_count: 1, goal_checks: [{criterion: 'Persist a saved task', status: 'pending', evidence: null}],
  };
  const request = {
    run: run.id, goal: run.goal, sessionID: run.session, kind: question ? 'question' : 'permission', id: 'req_test',
    request_id: 'req_test', fingerprint: 'fingerprint-original', permission: 'bash', patterns: ['python3 -m unittest'],
    context: {input: {command: 'python3 -m unittest'}}, metadata: {}, receipt: null,
  };
  if (question) request.questions = [{header: 'Storage', question: 'Which format?', options: [
    {label: 'JSON', description: 'Use a local file'}, {label: 'SQLite', description: 'Use a database'}], custom: true}];
  return {
    version: '5.0', product: 'AgentControl', profile: 'test-profile', project: '/tmp/project', opencode_url: 'http://127.0.0.1:4096',
    health: {ready: true, message: 'Test services ready', agents: {hermes: {state: 'ready', label: 'CLI ready; model unchecked'}, opencode: {state: 'ready', label: 'API reachable'}}},
    limits: {max_run_seconds: 7200}, capabilities: {}, runs: [{...run, prompt_count: 1}], run,
    steps: [{id: 'step_test', number: 1, title: 'Implement task storage', created: run.created, status: 'running',
      prompt: 'Save tasks to JSON.', result: 'Preparing the tests.',
      activity: [{created: run.created, kind: 'read', detail: 'tasks.py', status: 'completed'}]}],
    inbox: [request], reviews: [], events: [],
  };
}

const longGoal = 'Build a small Python command-line todo app in demo_app/. It must add tasks, list tasks, mark tasks done, and save them to a JSON file. Use only the Python standard library. Include meaningful unittest tests. Finish when the tests pass and a short usage README is present.';

function transcript(extra = 0) {
  const parts = [
    {type: 'text', text: 'I will start by reading the existing module and tests.'},
    {type: 'tool', id: 't1', tool: 'read', status: 'completed', summary: 'demo_app/todo.py', output: 'import json\nimport sys\n...'},
    {type: 'tool', id: 't2', tool: 'edit', status: 'completed', summary: 'demo_app/todo.py', output: 'Applied 1 edit.'},
    {type: 'text', text: 'Storage now writes atomically through a temporary file. Running the tests next.'},
    {type: 'tool', id: 't3', tool: 'bash', status: 'running', summary: "python3 -m unittest discover -s demo_app -p 'test_*.py'", output: 'test_add (test_todo.TodoTests) ... ok\ntest_done (test_todo.TodoTests) ... ok'},
  ];
  for (let i = 0; i < extra; i++) parts.push({type: 'text', text: `Progress line ${i + 1}: checking edge cases for empty task lists.`});
  return parts;
}

/* A richer active run for screenshots: two turns, the second one live. */
function richActive() {
  const state = fixture();
  Object.assign(state.run, {goal: longGoal, summary: 'Add atomic save and reload', decision_count: 2,
    verifier: ['python3', '-m', 'unittest', 'discover', '-s', 'demo_app'], instructions: [{time: '2026-09-28T16:03:00Z', text: 'Keep the storage format simple.'}],
    goal_checks: [{criterion: 'Add, list, and complete tasks from the command line.', status: 'pending', evidence: null},
      {criterion: 'Save tasks to JSON and reload them.', status: 'pending', evidence: null}]});
  state.runs = [{...state.run, goal: longGoal.slice(0, 120), prompt_count: 2},
    {id: 'run_old', goal: 'Describe the files in this project.', status: 'completed', created: '2026-09-27T10:00:00Z', prompt_count: 1}];
  state.steps = [
    {id: 'step_1', number: 1, title: 'Create the todo module and tests', created: '2026-09-28T16:00:30Z', ended: '2026-09-28T16:04:00Z', status: 'finished',
      prompt: 'Create demo_app/todo.py with add, list, and done commands. Add unittest tests.', result: 'Created todo.py and test_todo.py.',
      activity: [{created: '2026-09-28T16:01:00Z', kind: 'write', detail: 'demo_app/todo.py', status: 'completed'}],
      transcript: [{type: 'tool', id: 'a', tool: 'write', status: 'completed', summary: 'demo_app/todo.py', output: ''},
        {type: 'tool', id: 'b', tool: 'write', status: 'completed', summary: 'demo_app/test_todo.py', output: ''},
        {type: 'text', text: 'Created todo.py and test_todo.py.'}],
      verified: true, verification: {status: 'passed', exit_code: 0, argv: ['python3', '-m', 'unittest'], output: 'Ran 4 tests in 0.01s\n\nOK'},
      evidence: {changed_files: ['demo_app/todo.py', 'demo_app/test_todo.py'], file_stats: [
        {path: 'demo_app/todo.py', change: 'added', added: 64, removed: 0, partial: false},
        {path: 'demo_app/test_todo.py', change: 'added', added: 41, removed: 0, partial: false}],
        diff: '--- /dev/null\n+++ demo_app/todo.py\n@@ -0,0 +1,3 @@\n+import json\n+import sys\n+TASKS = "tasks.json"\n--- /dev/null\n+++ demo_app/test_todo.py\n@@ -0,0 +1,2 @@\n+import unittest\n+import todo'},
      hermes_verdict: {action: 'continue', summary: 'Tests pass; saving is not atomic yet.'}},
    {id: 'step_2', number: 2, title: 'Add atomic save and reload', created: '2026-09-28T16:05:00Z', status: 'running',
      prompt: 'Make save() write through a temporary file and os.replace. Add a reload test.', result: 'Storage now writes atomically through a temporary file.',
      activity: [{created: '2026-09-28T16:05:20Z', kind: 'edit', detail: 'demo_app/todo.py', status: 'completed'}], transcript: transcript()},
  ];
  state.inbox[0].goal = longGoal;
  state.events = [
    {id: 1, created: '2026-09-28T16:00:00Z', kind: 'goal', detail: longGoal},
    {id: 2, created: '2026-09-28T16:00:20Z', kind: 'Hermes decision', detail: JSON.stringify({action: 'continue', title: 'Create the todo module and tests', summary: 'Start with the module.'})},
    {id: 3, created: '2026-09-28T16:04:00Z', kind: 'verification', detail: JSON.stringify({status: 'passed', output: 'OK'})},
    {id: 4, created: '2026-09-28T16:05:30Z', kind: 'OpenCode tool', detail: JSON.stringify({tool: 'edit', status: 'completed', title: 'demo_app/todo.py'})},
  ];
  return state;
}

function richCompleted() {
  const state = richActive();
  Object.assign(state.run, {status: 'completed', phase: 'manager', summary: 'The todo app works and its tests pass.', ended: '2026-09-28T16:12:00Z'});
  state.runs[0].status = 'completed';
  state.inbox = [];
  Object.assign(state.steps[1], {status: 'finished', ended: '2026-09-28T16:10:00Z', verified: true,
    transcript: transcript().map(p => p.status === 'running' ? {...p, status: 'completed', output: p.output + '\n\nRan 5 tests in 0.02s\n\nOK'} : p),
    verification: {status: 'passed', exit_code: 0, argv: ['python3', '-m', 'unittest'], output: 'Ran 5 tests in 0.02s\n\nOK'},
    evidence: {changed_files: ['demo_app/todo.py'], file_stats: [{path: 'demo_app/todo.py', change: 'modified', added: 12, removed: 3, partial: false}],
      diff: '--- demo_app/todo.py\n+++ demo_app/todo.py\n@@ -10,3 +10,12 @@\n-    open(path, "w").write(data)\n+    tmp = path + ".tmp"\n+    os.replace(tmp, path)'}});
  state.reviews = [{run: 'run_test', kind: 'permission', request_id: 'req_test', action: 'approve', state: 'confirmed', updated: '2026-09-28T16:06:00Z', request: clone(fixture().inbox[0])}];
  return state;
}

function empty() {
  const state = fixture();
  Object.assign(state, {runs: [], run: null, steps: [], inbox: [], reviews: [], events: []});
  return state;
}

module.exports = {clone, fixture, richActive, richCompleted, empty, transcript, longGoal};
