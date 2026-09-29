/* AgentControl Workspaces (W1: tabbed mode).

   A workspace is a view of one agent in the current run, built only from /api/state that the
   dashboard already fetches. Opening, closing or switching workspaces never sends anything to
   the server: an agent's life is the engine's business, a workspace's life is the browser's.
   The only requests made from here are the existing ones you trigger yourself (approve, deny,
   redirect, a note to Hermes about this agent).

   Theme-specific looks live in workspace.css under :root[data-theme=…]; nothing here depends on
   the theme. */

const WS_KEY = 'ac-workspaces';
let wsState = wsLoad();          // {run, open, active, known, fresh, changed: [names], states: {name: state}}
const wsTurn = {};               // agent -> the turn chosen in its pane (null = follow the latest)
const wsTerm = makeTerm(() => ({box: $('ws-term'), body: $('ws-term-body'), held: $('ws-term-held'), empty: $('ws-term-empty'),
  title: $('ws-term-title'), meta: $('ws-term-meta'), jump: $('ws-term-jump'), follow: $('ws-term-follow')}), () => wsState.active || 'opencode');
let wsShown = '';                 // which agent the pane currently shows

function wsLoad() {
  try {
    const saved = JSON.parse(readItem('local', WS_KEY) || '{}');
    return {run: saved.run || '', open: saved.open || [], active: saved.active || '', known: saved.known || [], fresh: saved.fresh || [],
      changed: saved.changed || [], states: saved.states || {}};
  } catch { return {run: '', open: [], active: '', known: [], fresh: [], changed: [], states: {}}; }
}
function wsSave() { try { localStorage.setItem(WS_KEY, JSON.stringify(wsState)); } catch {} }

/* Keep the tab list in step with the run's agents. New agents Hermes adds become tabs marked
   "new" but never take focus away from the workspace you are looking at. */
function wsSync() {
  if (!current) return [];
  const agents = missionAgents(), names = agents.map(a => a.name);
  if (wsState.run !== current.id) {
    const first = agents.find(a => a.state === 'waiting_on_you') || agents.find(a => a.state === 'working' && a.name !== 'hermes') || agents.find(a => a.name !== 'hermes') || agents[0];
    wsState = {run: current.id, open: [...names], active: first?.name || '', known: [...names], fresh: [], changed: [],
      states: Object.fromEntries(agents.map(a => [a.name, a.state]))};
    wsSave();
    return agents;
  }
  // A tab you are not looking at is marked when its agent starts waiting on you, needs attention,
  // fails or finishes. Opening the tab clears the mark.
  let moved = false;
  for (const a of agents) {
    if (wsState.states[a.name] === a.state) continue;
    const watching = view === 'workspace' && wsState.active === a.name;
    if (wsState.states[a.name] && WS_NOTICE.has(a.state) && !watching && !wsState.changed.includes(a.name)) wsState.changed.push(a.name);
    wsState.states[a.name] = a.state;
    moved = true;
  }
  if (moved) wsSave();
  const added = names.filter(n => !wsState.known.includes(n));
  if (added.length) {
    wsState.known.push(...added);
    wsState.open.push(...added.filter(n => !wsState.open.includes(n)));
    wsState.fresh.push(...added);
    wsSave();
  }
  wsState.open = wsState.open.filter(n => names.includes(n));
  if (!wsState.open.includes(wsState.active)) wsState.active = wsState.open[0] || '';
  return agents;
}

function openWorkspace(name) {
  if (!current) return;
  wsSync();
  if (!wsState.open.includes(name)) wsState.open.push(name);
  wsState.active = name;
  wsState.fresh = wsState.fresh.filter(n => n !== name);
  wsState.changed = wsState.changed.filter(n => n !== name);
  wsSave();
  closeWsMenu();
  showView('workspace');
  renderWorkspace();
}
function closeWorkspace(name) {
  // Closing a tab only hides the view; the agent keeps working. Reopen it from +.
  wsState.open = wsState.open.filter(n => n !== name);
  wsState.fresh = wsState.fresh.filter(n => n !== name);
  if (wsState.active === name) wsState.active = wsState.open[0] || '';
  wsSave();
  renderWorkspace();
}
function stepWorkspace(delta) {
  const open = wsState.open, i = open.indexOf(wsState.active);
  if (open.length) openWorkspace(open[(i + delta + open.length) % open.length]);
}
function closeWsMenu() { $('ws-menu')?.classList.add('hidden'); $('ws-add')?.setAttribute('aria-expanded', 'false'); }

const WS_NOTICE = new Set(['waiting_on_you', 'needs_attention', 'failed', 'finished', 'blocked', 'limit_reached']);
/* "for 5 min" within the hour, else "since 10:42". Only shown when the server recorded the change. */
function wsSince(value) {
  const date = new Date(value);
  if (!value || isNaN(date)) return '';
  const seconds = (Date.now() - date) / 1000;
  return seconds < 45 ? 'just now' : seconds < 3600 ? `for ${Math.round(seconds / 60)} min` : `since ${timeLabel(value)}`;
}
const WS_MARK = {working: '●', waiting_on_you: '!', needs_attention: '!', paused: '‖', idle: '○', finished: '✓', failed: '×', stopped: '■', blocked: '!', limit_reached: '!'};
function workspaceActive() { return wsState.active ? wsAgentLabel(wsState.active) : ''; }
function wsAgentLabel(name) { return name === 'hermes' ? 'Hermes' : name; }
function wsTone(a) { return (AGENT_STATE[a?.state] || ['', ''])[1]; }

function renderWsTabs(agents) {
  const byName = Object.fromEntries(agents.map(a => [a.name, a]));
  const tabs = wsState.open.map((name, i) => {
    const a = byName[name] || {name, state: 'idle'}, [label] = AGENT_STATE[a.state] || [a.state || 'idle'];
    const active = name === wsState.active, fresh = wsState.fresh.includes(name), changed = wsState.changed.includes(name), since = wsSince(a.since);
    return `<span class="ws-tab ${active ? 'active' : ''} ${esc(wsTone(a))}" data-index="${i + 1}">
      <button role="tab" aria-selected="${active}" data-ws-open="${esc(name)}" title="${esc(wsAgentLabel(name))} · ${esc(label)}${since ? ' ' + esc(since) : ''}${changed ? ' · changed while you were away' : ''}${i < 9 ? ` · key ${i + 1}` : ''}">
        <span class="ws-mark" aria-hidden="true">${WS_MARK[a.state] || '○'}</span><span class="ws-tab-name">${esc(wsAgentLabel(name))}</span>${fresh ? '<span class="ws-new">new</span>' : ''}${changed ? '<span class="ws-changed" aria-hidden="true"></span>' : ''}<span class="sr-only">, ${esc(label)}${changed ? ', changed while you were away' : ''}</span></button>
      <button class="ws-close" data-ws-close="${esc(name)}" aria-label="Close ${esc(wsAgentLabel(name))}'s workspace (the agent keeps working)" title="Close tab · the agent keeps working">×</button></span>`;
  }).join('');
  setHTML($('ws-tabs'), `<button class="ws-tab ws-home" data-view="mission" title="Back to Mission">Mission</button>${tabs}`);
  // Keep the active tab visible in a scrolling tab bar without scrolling the page.
  const bar = $('ws-tabs'), tab = bar.querySelector('.ws-tab.active');
  if (tab && (tab.offsetLeft < bar.scrollLeft || tab.offsetLeft + tab.offsetWidth > bar.scrollLeft + bar.clientWidth)) bar.scrollLeft = Math.max(0, tab.offsetLeft - 8);
  const closed = agents.filter(a => !wsState.open.includes(a.name));
  $('ws-add-new').classList.toggle('hidden', !wsState.fresh.length && !wsState.changed.some(n => !wsState.open.includes(n)));
  setHTML($('ws-menu'), agents.map(a => {
    const [label] = AGENT_STATE[a.state] || [a.state || 'idle'];
    const changed = wsState.changed.includes(a.name);
    return `<button role="menuitem" data-ws-open="${esc(a.name)}"><span class="ws-mark ${esc(wsTone(a))}" aria-hidden="true">${WS_MARK[a.state] || '○'}</span><span>${esc(wsAgentLabel(a.name))}${changed ? ' <span class="ws-changed" aria-hidden="true"></span>' : ''}</span><small class="muted">${esc(a.role || '')} · ${esc(label)}${a.since ? ' ' + esc(wsSince(a.since)) : ''}${changed ? ' · changed' : ''}${wsState.open.includes(a.name) ? '' : ' · closed'}</small></button>`;
  }).join('') + (closed.length ? '' : '<p class="small muted">Every agent of this run is open.</p>'));
  const waiting = agents.filter(a => a.state === 'waiting_on_you').length;
  const badge = $('ws-nav-count');
  if (badge) { badge.textContent = String(waiting); badge.classList.toggle('hidden', !waiting); }
}

function renderWorkspace() {
  if (!data || !$('view-workspace')) return;
  if (!current) {
    setHTML($('ws-tabs'), '<button class="ws-tab ws-home" data-view="mission">Mission</button>');
    $('ws-pane').classList.add('hidden');
    $('ws-empty').classList.remove('hidden');
    setHTML($('ws-empty'), '<section class="ac-panel"><h1>No run yet</h1><p class="muted">Each agent of a run gets a workspace here: its live terminal, task, approvals, files and notes.</p><button class="ac-btn primary" data-action="new">Start a new run</button></section>');
    renderXpTasks([]);
    return;
  }
  const agents = wsSync();
  renderWsTabs(agents);
  renderXpTasks(agents);
  const a = agents.find(x => x.name === wsState.active);
  $('ws-empty').classList.toggle('hidden', !!a);
  $('ws-pane').classList.toggle('hidden', !a);
  if (!a) {
    setHTML($('ws-empty'), '<section class="ac-panel"><p>All workspace tabs are closed. The agents keep working; open one again with <strong>+</strong>.</p></section>');
    return;
  }
  if (view !== 'workspace') return;   // hidden panes are not redrawn
  if (wsShown !== a.name) { wsShown = a.name; wsTerm.reset(null); wsTerm.setFollow(true); $('ws-term-body').scrollTop = 0; }
  const steps = (data.steps || []).filter(s => (s.agent || 'coder-1') === a.name);
  const hermes = a.type === 'orchestrator', researcher = roleOf(a.name) === 'researcher';
  renderWsHead(a, steps);
  renderWsTask(a, steps);
  renderWsApprovals(a);
  renderWsFiles(a, steps);
  renderWsNotes(a);
  renderWsPreview();
  const recordedOnly = hermes || researcher;
  $('ws-term').classList.toggle('hidden', recordedOnly);
  $('ws-log').classList.toggle('hidden', !recordedOnly);
  if (recordedOnly) { setHTML($('ws-turns'), ''); renderWsLog(a, steps); return; }
  const chosen = wsTurn[a.name] && steps.find(s => s.id === wsTurn[a.name]);
  const step = chosen || steps.at(-1);
  setHTML($('ws-turns'), steps.length > 1 ? `<div class="ws-turn-chips" role="group" aria-label="${esc(a.name)}'s turns">${steps.map(s =>
    `<button class="ws-chip ${s.id === step?.id ? 'active' : ''}" data-ws-turn="${esc(s.id)}" aria-pressed="${s.id === step?.id}" title="${esc(s.title)}">#${s.number}</button>`).join('')}
    <button class="ws-chip ${!chosen ? 'active' : ''}" data-ws-turn="" aria-pressed="${!chosen}">Latest</button></div>` : '');
  const live = step && !ended.has(current.status) && ['running', 'dispatching', 'waiting'].includes(step.status);
  const pending = agentRequests(a.name);
  wsTerm.render(step, live ? (pending.length ? 'waiting' : 'active') : step?.status === 'failed' ? 'failed' : 'done', pending, !chosen);
}

function renderWsHead(a, steps) {
  const [label, tone] = AGENT_STATE[a.state] || [String(a.state || 'idle').replaceAll('_', ' '), ''];
  const hermes = a.type === 'orchestrator', role = roleOf(a.name), u = agentUsage(a.name);
  const ws = current.workspace?.agents?.[a.name], title = current.team?.agents?.[a.name]?.label;
  const chosenModel = current.models?.[role === 'orchestrator' ? 'hermes' : role];
  const skills = (data.skills?.installs || []).filter(i => i.agent === a.name && i.state === 'installed').map(i => i.name);
  const tools = role === 'reviewer' ? 'read-only: read, grep, glob, list (edit and shell tools withheld)' : (a.tools || []).length ? a.tools.join(', ') : hermes ? 'plans and reviews; no file tools' : 'OpenCode tools, under your permission rules';
  const where = hermes ? 'Hermes profile ' + (data.profile || 'default') : role === 'researcher' ? 'scratch folder, no project files'
    : `${ws?.branch ? ws.branch : 'project folder'}${current.isolation === 'container' ? ' · in the run’s container' : current.isolation === 'vm' ? ' · in the run’s VM' : ''}`;
  const facts = [
    ['Model', chosenModel ? `${chosenModel} (chosen for this run)` : a.model || '—'],
    ['Tools', tools],
    ['Skills', skills.length ? skills.join(', ') : 'none installed'],
    ['Works in', where],
    ['Usage', `${hermes ? plural(current.decision_count || 0, 'decision') : `${plural(steps.length, 'turn')} · ${plural(a.stats?.tool_calls || 0, 'tool call')}`}${u ? ` · ${tokens(u.tokens_in)} in / ${tokens(u.tokens_out)} out${u.cost ? ' · ' + money(u.cost, 4) : ''}` : ' · no model calls yet'}`]];
  setHTML($('ws-head'), `<div class="ws-id"><span class="agent-avatar ${hermes ? 'hermes' : 'opencode'} role-${esc(role)}">${esc(roleMark(a.name))}</span>
      <div><h1 id="ws-title">${esc(wsAgentLabel(a.name))} <span class="ac-status ${tone}"><span class="dot"></span>${esc(label)}</span>${a.since ? `<span class="small muted ws-since" title="${esc(new Date(a.since).toLocaleString())}">${esc(wsSince(a.since))}</span>` : ''}</h1>
      <p class="small muted">${esc(title || a.role || '')}${a.runtime ? ' · ' + esc(a.runtime) : ''} · run “${esc(runTitle(current, 60))}”</p>
      ${a.task ? `<p class="small ws-now">${esc(a.task)}</p>` : ''}</div></div>
    <dl class="ws-facts small">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`);
}

function renderWsTask(a, steps) {
  const tasks = (current.team?.tasks || []).filter(t => t.agent === a.name);
  const latest = steps.at(-1);
  let body;
  if (a.type === 'orchestrator') {
    const plan = (current.plan || []).map(p => `<li>${esc(typeof p === 'string' ? p : p.title || pretty(p))}</li>`).join('');
    body = `<p class="small">${esc(current.summary || 'Waiting for the next decision.')}</p>${plan ? `<ol class="small">${plan}</ol>` : ''}
      ${(current.goal_checks || []).length ? `<p class="small muted">${current.goal_checks.filter(c => c.status === 'passed').length} of ${current.goal_checks.length} goal checks verified</p>` : ''}`;
  } else if (tasks.length) {
    body = tasks.map(t => `<div class="ws-task ${esc(t.status || '')}"><strong class="small"><span class="mono">${esc(t.id)}</span> ${esc(t.title)}</strong>
      <small class="${TASK_TONE[t.status] || ''}">${esc(t.status || 'waiting')}${t.attempts > 1 ? ` · ${t.attempts} tries` : ''}</small>
      ${(t.depends_on || []).length ? `<small class="muted">After ${t.depends_on.map(esc).join(', ')}</small>` : '<small class="muted">No dependencies</small>'}
      ${t.reason ? `<small class="muted">${esc(t.reason)}</small>` : ''}</div>`).join('');
  } else {
    body = latest ? `<p class="small"><strong>Turn ${latest.number}:</strong> ${esc(latest.title)}</p>` : '<p class="small muted">No turn yet.</p>';
  }
  const verify = latest && a.type !== 'orchestrator' ? `<p class="small">Verification: ${esc(verificationLabel(latest))}</p>` : '';
  setHTML($('ws-task'), `<section class="ac-panel"><h2 class="ac-panel__title">${a.type === 'orchestrator' ? 'Plan' : 'Task'}</h2>${body}${verify}</section>`);
}

function renderWsApprovals(a) {
  const cards = agentRequests(a.name).map(approvalCard).concat(researchRequests(current.id).filter(r => r.agent === a.name).map(r => researchCard(r, 'ws')));
  const teamPlan = a.type === 'orchestrator' && current.status === 'awaiting_approval'
    ? '<section class="ac-panel"><h2 class="ac-panel__title">Team plan</h2><p class="small">Hermes proposed a team and waits for your decision.</p><button class="ac-btn primary" data-view="runs">Review the team plan</button></section>' : '';
  setHTML($('ws-approvals'), cards.length || teamPlan ? `<div class="ws-approvals">${teamPlan}${cards.join('')}</div>` : '');
}

function renderWsFiles(a, steps) {
  const withEvidence = steps.filter(s => s.evidence);
  const files = fileStats(withEvidence);
  const rows = files.slice(0, 40).map(f => `<div class="file-row">${icon('file')}<span class="file-path">${esc(f.path)}</span><span class="file-change">${esc(f.change)}</span>${f.added !== null ? `<span class="file-counts"><span class="added">+${f.added}</span><span class="removed">−${f.removed}${f.partial ? '*' : ''}</span></span>` : ''}</div>`).join('');
  const diffs = withEvidence.slice(-4).reverse().map(s => `<button class="text-button small" data-ws-diff="${esc(s.id)}">Turn ${s.number} diff</button>`).join(' ');
  setHTML($('ws-files'), a.type === 'orchestrator' ? '' : `<section class="ac-panel"><h2 class="ac-panel__title">Files <span class="muted small">· ${files.length}</span></h2>
    ${rows || '<p class="small muted">Files this agent changed appear after each of its turns.</p>'}${diffs ? `<p>${diffs}</p>` : ''}</section>`);
}

function wsEventAgent(e) {
  let d = e.detail;
  if (typeof d === 'string' && /^[[{]/.test(d)) { try { d = JSON.parse(d); } catch {} }
  if (d && typeof d === 'object' && !Array.isArray(d) && d.agent) return d.agent;
  if (Array.isArray(d) && d[0]?.agent) return d[0].agent;
  if (e.kind === 'session' && typeof d === 'string' && d.includes(': ')) return d.split(': ')[0];
  return {'Hermes request': 'hermes', 'Hermes decision': 'hermes', 'Hermes JSON repaired': 'hermes', 'OpenCode prompt': 'coder-1', 'OpenCode tool': 'coder-1',
    'OpenCode result': 'coder-1', 'OpenCode needs input': 'coder-1', 'submission uncertain': 'coder-1', 'session': 'coder-1'}[e.kind] || 'agentcontrol';
}

function renderWsNotes(a) {
  const notes = (current.instructions || []).filter(n => a.type === 'orchestrator' ? !n.agent : n.agent === a.name)
    .map(n => `<li><span class="muted small">${when(n.created)}</span> <strong class="small">Your note${n.agent ? ' for ' + esc(n.agent) : ''}</strong> <span class="small">${esc(n.text)}</span></li>`);
  const lifecycle = (data.events || []).filter(e => e.kind === 'agent state' && wsEventAgent(e) === a.name).slice(-12).reverse().map(e => {
    let d = {}; try { d = JSON.parse(e.detail); } catch {}
    return `<li><span class="muted small">${when(e.created)}</span> <span class="small">${esc(stateName(d.from))} → <strong>${esc(stateName(d.to))}</strong>${d.task ? ' · ' + esc(d.task) : ''}</span></li>`;
  });
  const mine = (data.events || []).filter(e => e.kind !== 'agent state' && wsEventAgent(e) === a.name).slice(-30).reverse().map(e => {
    let parsed; try { parsed = JSON.parse(e.detail); } catch {}
    return `<li><span class="muted small">${when(e.created)}</span> <strong class="small">${esc(e.kind)}</strong> <span class="small">${esc(String(eventSummary(e, parsed) || '').slice(0, 200))}</span></li>`;
  });
  const decisions = a.type === 'orchestrator' ? [] : (data.steps || []).filter(s => (s.agent || 'coder-1') === a.name && (s.summary || s.decision?.summary)).slice(-5).reverse()
    .map(s => `<li><strong class="small">Hermes, turn ${s.number}</strong> <span class="small">${esc(s.summary || s.decision.summary)}</span></li>`);
  const finished = ended.has(current.status);
  setHTML($('ws-notes'), `<section class="ac-panel"><h2 class="ac-panel__title">Notes &amp; activity</h2>
    <p class="small muted">Recorded instructions, Hermes’s summaries and this agent’s events. Private model reasoning is not recorded and is never shown.</p>
    ${lifecycle.length ? `<h3 class="ws-subhead small">State changes</h3><ul class="ws-list ws-lifecycle">${lifecycle.join('')}</ul>` : ''}
    ${[...notes, ...decisions].length ? `<ul class="ws-list">${[...notes, ...decisions].join('')}</ul>` : ''}
    ${mine.length ? `<ul class="ws-list">${mine.join('')}</ul>` : '<p class="small muted">No events recorded for this agent yet.</p>'}
    ${finished ? '' : `<form class="ws-note" data-ws-note="${esc(a.name)}"><label class="sr-only" for="ws-note-text">Note</label><input id="ws-note-text" maxlength="5000" placeholder="${a.type === 'orchestrator' ? 'Tell Hermes something' : 'Note for Hermes about ' + esc(a.name)}" autocomplete="off"><button class="ac-btn">Send</button></form>
      <p class="small muted">${a.type === 'orchestrator' ? 'Goes into Hermes’s next decision.' : `Goes to Hermes, marked for ${esc(a.name)}; Hermes decides what ${esc(a.name)} is told.`}</p>`}</section>`);
}

function renderWsLog(a, steps) {
  if (roleOf(a.name) === 'researcher') {
    const items = steps.map(s => `<div class="ws-log-item"><div class="term-line"><span class="term-prompt">?</span><span class="term-cmd">${esc(s.question || s.title)}</span><span class="term-status">${esc(s.status || '')}</span></div>
      ${s.report ? `<p class="small">${esc(s.report.summary || '')}</p>${(s.report.sources || []).length ? `<ul class="small">${s.report.sources.slice(0, 8).map(u => `<li class="mono">${esc(u)}</li>`).join('')}</ul>` : ''}` : ''}</div>`).join('');
    setHTML($('ws-log'), `<p class="small muted ws-log-note">The researcher runs Hermes once per approved question; its report is recorded when that call ends. There is no live stream.</p>${items || '<p class="small muted">No questions yet.</p>'}`);
    return;
  }
  const calls = (data.events || []).filter(e => ['Hermes request', 'Hermes decision', 'Hermes JSON repaired'].includes(e.kind)).slice(-40);
  const items = calls.map(e => {
    let parsed; try { parsed = JSON.parse(e.detail); } catch {}
    const request = e.kind === 'Hermes request';
    const text = request ? String(e.detail || '') : parsed ? [parsed.action, parsed.title, parsed.summary].filter(Boolean).join(' · ') : String(e.detail || '');
    return `<details class="ws-log-item" data-key="ws-${esc(String(e.id))}"><summary><span class="term-prompt">${request ? '→' : '←'}</span> <span class="muted small">${when(e.created)}</span> ${esc(request ? `request to Hermes · ${plural(text.length, 'character')}` : e.kind === 'Hermes JSON repaired' ? 'reply repaired' : 'decision: ' + text.slice(0, 160))}</summary><pre>${esc(text.slice(-6000))}</pre></details>`;
  }).join('');
  setHTML($('ws-log'), `<p class="small muted ws-log-note">Hermes runs as one call per decision, so this is the recorded log of those calls (what AgentControl sent and what came back), not a live stream.</p>${items || '<p class="small muted">No Hermes calls recorded yet.</p>'}`);
}

function renderWsPreview() {
  const p = previewStatus(), mine = p.run === current.id && previewLive(p);
  const vm = current.isolation === 'vm';
  setHTML($('ws-preview'), `<p class="small">${mine ? `Live preview: <strong>${esc(p.mode)}</strong> · ${esc(p.state)}` : current.preview ? `Preview set up (${esc(current.preview.mode)}), not running.` : 'No preview is set up for this run.'}</p>
    <p class="row wrap"><button class="ac-btn compact" data-view="project">${mine ? 'Open the live preview' : 'Open Project'}</button>${vm ? '<button class="ac-btn compact" data-view="project">Open the VM screen</button>' : ''}</p>
    <p class="small muted">The preview is shared by every view. Opening it here does not start another program.</p>`);
}

/* On the XP theme every open workspace is a window button on the taskbar, flashing when its agent waits for you. */
function renderXpTasks(agents) {
  const bar = document.querySelector('.xp-taskbar');
  if (!bar) return;
  bar.querySelectorAll('.xp-ws-task').forEach(e => e.remove());
  const tray = $('xp-tray'), byName = Object.fromEntries(agents.map(a => [a.name, a]));
  wsState.open.filter(n => byName[n]).forEach(name => {
    const a = byName[name], button = document.createElement('button');
    button.className = `xp-task xp-ws-task ${a.state === 'waiting_on_you' ? 'xp-flash' : ''} ${view === 'workspace' && wsState.active === name ? 'active' : ''}`;
    button.dataset.wsOpen = name;
    button.textContent = `${WS_MARK[a.state] || '○'} ${wsAgentLabel(name)}`;
    bar.insertBefore(button, tray);
  });
}

/* Clicks and keys that belong to workspaces. Returns true when handled. */
async function workspaceClick(b) {
  if (b.dataset.wsOpen !== undefined) { openWorkspace(b.dataset.wsOpen); return true; }
  if (b.dataset.wsClose !== undefined) { closeWorkspace(b.dataset.wsClose); return true; }
  if (b.dataset.workspace !== undefined) { openWorkspace(b.dataset.workspace); return true; }
  if (b.dataset.wsTurn !== undefined) { wsTurn[wsState.active] = b.dataset.wsTurn || null; wsTerm.reset(null); renderWorkspace(); return true; }
  if (b.dataset.wsDiff !== undefined) { openDiff(b.dataset.wsDiff); return true; }
  return false;
}
function workspaceKey(event) {
  if (view !== 'workspace') return false;
  if (/^[1-9]$/.test(event.key)) { const name = wsState.open[Number(event.key) - 1]; if (name) openWorkspace(name); return true; }
  if (event.key === ']') { stepWorkspace(1); return true; }
  if (event.key === '[') { stepWorkspace(-1); return true; }
  return false;
}

Object.assign(ACTIONS, {
  'ws-menu': () => {
    const menu = $('ws-menu'), open = menu.classList.toggle('hidden') === false;
    $('ws-add').setAttribute('aria-expanded', String(open));
  },
  'ws-term-follow': () => wsTerm.setFollow(!wsTerm.follow),
  'ws-term-jump': () => wsTerm.setFollow(true),
  'ws-term-copy': async () => { try { await navigator.clipboard.writeText(wsTerm.text(data?.steps)); toast('Terminal output copied.'); } catch { toast('Copy is unavailable in this browser.'); } },
});

document.addEventListener('submit', async event => {
  const form = event.target.closest?.('[data-ws-note]');
  if (!form) return;
  event.preventDefault();
  const input = form.querySelector('input'), text = input.value.trim(), agent = form.dataset.wsNote;
  if (!text) return;
  try { await control('instruction', text, current.id, agent === 'hermes' ? null : agent); input.value = ''; toast('Note saved for Hermes’s next decision.'); }
  catch (error) { pageError(error.message); }
});
$('ws-term-body')?.addEventListener('scroll', wsTerm.onScroll);
