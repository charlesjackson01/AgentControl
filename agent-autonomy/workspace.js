/* AgentControl Workspaces: tabbed (W1) and split (W4) layouts.

   A workspace is a view of one agent in the current run, built only from /api/state that the
   dashboard already fetches. Opening, closing or switching workspaces never sends anything to
   the server: an agent's life is the engine's business, a workspace's life is the browser's.
   The only requests made from here are the existing ones you trigger yourself (approve, deny,
   redirect, a note to Hermes about this agent).

   Theme-specific looks live in workspace.css under :root[data-theme=…]; nothing here depends on
   the theme.

   Split view shows two panes side by side. Pane 0 shows wsState.active and pane 1 wsState.second;
   a tab opens its agent in the focused pane. Both panes are drawn by the same code: pane 0 keeps
   the element ids ws-<part>, pane 1 uses ws-<part>-1. */

const WS_KEY = 'ac-workspaces';
let wsState = wsLoad();          // {run, open, active, known, fresh, changed, states, mode, second, focus, ratio}
const wsTurn = {};               // agent -> the turn chosen in its pane (null = follow the latest)

/* One pane: its elements (by part name), its own terminal, and the agent it currently shows. */
function wsPane(i) {
  const suffix = i ? '-' + i : '';
  const pane = {i, suffix, shown: '', part: name => $('ws-' + name + suffix)};
  pane.term = makeTerm(() => ({box: pane.part('term'), body: pane.part('term-body'), held: pane.part('term-held'), empty: pane.part('term-empty'),
    title: pane.part('term-title'), meta: pane.part('term-meta'), jump: pane.part('term-jump'), follow: pane.part('term-follow')}), () => pane.shown || 'opencode');
  return pane;
}
function wsPaneHTML(i) {
  const x = i ? '-' + i : '';
  return `${i !== undefined ? `<button class="ws-pane-bar" data-ws-focus="${i}" aria-label="Focus this pane"><span id="ws-pane-name${x}" class="ws-pane-name"></span><span class="ws-pane-hint small">${i ? 'right' : 'left'} pane</span></button>` : ''}
    <header id="ws-head${x}" class="ws-head"></header>
    <div class="ws-grid">
      <section class="ws-main" aria-label="Output">
        <div id="ws-turns${x}" class="ws-turns"></div>
        <div id="ws-term${x}" class="term" data-state="pending">
          <div class="term-bar"><span class="term-lights" aria-hidden="true"><i></i><i></i><i></i></span><strong id="ws-term-title${x}" class="term-title">opencode</strong><span id="ws-term-meta${x}" class="term-meta"></span>
            <span class="term-actions"><button id="ws-term-follow${x}" class="term-button" data-action="ws-term-follow" aria-pressed="true" title="Keep the newest output in view">Follow</button><button class="term-button" data-action="ws-term-copy" title="Copy this turn's output">Copy</button></span></div>
          <div id="ws-term-body${x}" class="term-body" role="log" aria-label="Agent output" tabindex="0"></div>
          <div id="ws-term-held${x}"></div><p id="ws-term-empty${x}" class="term-empty hidden"></p>
          <button id="ws-term-jump${x}" class="term-jump hidden" data-action="ws-term-jump">↓ New output</button>
        </div>
        <div id="ws-log${x}" class="ws-log hidden" role="log" aria-label="Recorded calls"></div>
      </section>
      <aside class="ws-side"><div id="ws-approvals${x}"></div><div id="ws-task${x}"></div><div id="ws-files${x}"></div></aside>
    </div>
    <section id="ws-notes${x}" class="ws-notes"></section>
    <details id="ws-preview-box${x}" class="ws-preview ac-panel" data-ws-viewer="${i}"><summary><span>Preview</span><span id="ws-preview-sum${x}" class="small muted ws-preview-sum"></span></summary>
      <div id="ws-preview${x}" class="ws-surface-head"></div><div id="ws-surface${x}" class="ws-surface-body"></div></details>`;
}
[0, 1].forEach(i => { const root = $(i ? 'ws-pane-1' : 'ws-pane'); if (root) root.innerHTML = wsPaneHTML(i); });
const wsPanes = [wsPane(0), wsPane(1)];
const wsTerm = wsPanes[0].term;   // the first pane's terminal (kept for callers of W1)

function wsSplitFits() { try { return !window.matchMedia || window.matchMedia('(min-width: 1000px)').matches; } catch { return true; } }
function wsSplit() { return wsState.mode === 'split' && !!wsState.second && wsState.second !== wsState.active; }
function wsPaneAgent(i) { return i ? (wsSplit() ? wsState.second : '') : wsState.active; }
/* The pane a tab click or key loads into; in tabbed mode, or when split does not fit, the only pane. */
function wsFocusIndex() { return wsSplit() && wsState.focus ? 1 : 0; }
function wsFocused() { return wsPaneAgent(wsFocusIndex()); }
function wsVisible() { return wsSplit() && wsSplitFits() ? [wsState.active, wsState.second] : [wsFocused() || wsState.active]; }

function wsLoad() {
  try {
    const saved = JSON.parse(readItem('local', WS_KEY) || '{}');
    return {run: saved.run || '', open: saved.open || [], active: saved.active || '', known: saved.known || [], fresh: saved.fresh || [],
      changed: saved.changed || [], states: saved.states || {}, mode: saved.mode === 'split' ? 'split' : 'tabs',
      second: saved.second || '', focus: saved.focus ? 1 : 0, ratio: Math.min(.8, Math.max(.2, Number(saved.ratio) || .5))};
  } catch { return {run: '', open: [], active: '', known: [], fresh: [], changed: [], states: {}, mode: 'tabs', second: '', focus: 0, ratio: .5}; }
}
function wsSave() { try { localStorage.setItem(WS_KEY, JSON.stringify(wsState)); } catch {} }

/* Keep the tab list in step with the run's agents. New agents Hermes adds become tabs marked
   "new" but never take focus away from the workspace you are looking at. */
function wsSync() {
  if (!current) return [];
  const agents = missionAgents(), names = agents.map(a => a.name);
  if (wsState.run !== current.id) {
    const first = agents.find(a => a.state === 'waiting_on_you') || agents.find(a => a.state === 'working' && a.name !== 'hermes') || agents.find(a => a.name !== 'hermes') || agents[0];
    // A new run keeps your layout choice (tabs or split, pane widths); the panes start over.
    wsState = {run: current.id, open: [...names], active: first?.name || '', known: [...names], fresh: [], changed: [],
      states: Object.fromEntries(agents.map(a => [a.name, a.state])), mode: wsState.mode, focus: 0, ratio: wsState.ratio,
      second: wsPickSecond(first?.name, names, agents)};
    wsSave();
    return agents;
  }
  // A tab you are not looking at is marked when its agent starts waiting on you, needs attention,
  // fails or finishes. Opening the tab clears the mark.
  let moved = false;
  for (const a of agents) {
    if (wsState.states[a.name] === a.state) continue;
    const watching = view === 'workspace' && wsVisible().includes(a.name);
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
  if (!wsState.open.includes(wsState.active)) wsState.active = wsState.second && wsState.open.includes(wsState.second) ? wsState.second : wsState.open[0] || '';
  if (!wsState.open.includes(wsState.second) || wsState.second === wsState.active) wsState.second = wsPickSecond(wsState.active, wsState.open, agents);
  return agents;
}
/* The agent for the second pane: one waiting on you, else working, else the next open tab. */
function wsPickSecond(first, names, agents) {
  const others = (agents || []).filter(a => a.name !== first && names.includes(a.name));
  return (others.find(a => a.state === 'waiting_on_you') || others.find(a => a.state === 'working') || others[0])?.name || names.find(n => n !== first) || '';
}

function openWorkspace(name) {
  if (!current) return;
  wsSync();
  if (!wsState.open.includes(name)) wsState.open.push(name);
  if (wsSplit() && wsSplitFits()) {
    // Already on screen: focus its pane. Otherwise it replaces the focused pane's agent.
    if (name === wsState.active) wsState.focus = 0;
    else if (name === wsState.second) wsState.focus = 1;
    else if (wsState.focus) wsState.second = name;
    else wsState.active = name;
  } else {
    // The workspace you were just reading becomes the second pane's agent (like alt-tab).
    if (name !== wsState.active && wsState.active) wsState.second = wsState.active;
    wsState.active = name;
    wsState.focus = 0;
  }
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
  if (wsState.active === name) { wsState.active = wsState.second && wsState.open.includes(wsState.second) ? wsState.second : wsState.open[0] || ''; wsState.focus = 0; }
  if (wsState.second === name || wsState.second === wsState.active) wsState.second = wsPickSecond(wsState.active, wsState.open, missionAgents());
  wsSave();
  renderWorkspace();
}
function stepWorkspace(delta) {
  const open = wsState.open, i = open.indexOf(wsFocused());
  if (open.length) openWorkspace(open[(i + delta + open.length) % open.length]);
}
/* Layout changes are browser-only too: nothing is sent, no agent is touched. */
function setWorkspaceMode(mode) {
  if (mode === 'split') {
    wsSync();
    if (!wsState.second) wsState.second = wsPickSecond(wsState.active, wsState.open, missionAgents());
    if (!wsState.second) { toast('Open a second agent to split the view.'); return; }
    if (!wsSplitFits()) toast('Split view needs a wider window; it applies when there is room.');
  }
  wsState.mode = mode === 'split' ? 'split' : 'tabs';
  wsState.focus = 0;
  wsSave();
  renderWorkspace();
}
function focusPane(i) {
  if (!wsSplit() || !wsSplitFits() || (wsState.focus ? 1 : 0) === i) return;
  wsState.focus = i;
  wsSave();
  // Only the focus marks change; the panes are not redrawn, so a click inside one still lands.
  [0, 1].forEach(n => $(n ? 'ws-pane-1' : 'ws-pane').classList.toggle('focused', n === i));
  const agents = missionAgents();
  renderWsTabs(agents);
  renderXpTasks(agents);
}
function setPaneRatio(ratio, save = true) {
  wsState.ratio = Math.min(.8, Math.max(.2, Math.round(ratio * 100) / 100));
  const panes = $('ws-panes');
  panes?.style.setProperty('--ws-left', wsState.ratio + 'fr');
  panes?.style.setProperty('--ws-right', (1 - wsState.ratio).toFixed(2) + 'fr');
  $('ws-divider')?.setAttribute('aria-valuenow', String(Math.round(wsState.ratio * 100)));
  if (save) wsSave();
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
function workspaceActive() { const name = wsFocused(); return name ? wsAgentLabel(name) : ''; }
function wsAgentLabel(name) { return name === 'hermes' ? 'Hermes' : name; }
function wsTone(a) { return (AGENT_STATE[a?.state] || ['', ''])[1]; }

function renderWsTabs(agents) {
  const byName = Object.fromEntries(agents.map(a => [a.name, a]));
  const tabs = wsState.open.map((name, i) => {
    const a = byName[name] || {name, state: 'idle'}, [label] = AGENT_STATE[a.state] || [a.state || 'idle'];
    const active = name === wsFocused(), shown = !active && wsVisible().includes(name), fresh = wsState.fresh.includes(name), changed = wsState.changed.includes(name), since = wsSince(a.since);
    return `<span class="ws-tab ${active ? 'active' : ''} ${shown ? 'shown' : ''} ${esc(wsTone(a))}" data-index="${i + 1}">
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
  const split = wsSplit(), fits = wsSplitFits(), both = split && fits;
  document.querySelectorAll('[data-ws-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.wsMode === (split ? 'split' : 'tabs'))));
  if (!current) {
    setHTML($('ws-tabs'), '<button class="ws-tab ws-home" data-view="mission">Mission</button>');
    wsPanes.forEach(p => $(p.i ? 'ws-pane-1' : 'ws-pane').classList.add('hidden'));
    $('ws-divider').classList.add('hidden');
    $('ws-narrow').classList.add('hidden');
    $('ws-empty').classList.remove('hidden');
    setHTML($('ws-empty'), '<section class="ac-panel"><h1>No run yet</h1><p class="muted">Each agent of a run gets a workspace here: its live terminal, task, approvals, files and notes.</p><button class="ac-btn primary" data-action="new">Start a new run</button></section>');
    renderXpTasks([]);
    return;
  }
  const agents = wsSync();
  renderWsTabs(agents);
  renderXpTasks(agents);
  const byName = Object.fromEntries(agents.map(a => [a.name, a]));
  // When split does not fit (phones, narrow windows) the focused pane is shown alone.
  const first = both ? byName[wsState.active] : byName[wsFocused()] || byName[wsState.active];
  const second = both ? byName[wsState.second] : null;
  $('ws-empty').classList.toggle('hidden', !!first);
  $('ws-pane').classList.toggle('hidden', !first);
  $('ws-pane-1').classList.toggle('hidden', !second);
  $('ws-divider').classList.toggle('hidden', !second);
  $('ws-panes').classList.toggle('split', !!second);
  $('ws-narrow').classList.toggle('hidden', !(split && !fits && view === 'workspace'));
  setPaneRatio(wsState.ratio, false);
  if (!first) {
    setHTML($('ws-empty'), '<section class="ac-panel"><p>All workspace tabs are closed. The agents keep working; open one again with <strong>+</strong>.</p></section>');
    return;
  }
  if (view !== 'workspace') return;   // hidden panes are not redrawn
  [first, second].forEach((a, i) => {
    const root = $(i ? 'ws-pane-1' : 'ws-pane');
    root.classList.toggle('focused', !!second && wsFocusIndex() === i);
    if (a) renderWsPane(wsPanes[i], a, !!second);
  });
}

function renderWsPane(p, a, split) {
  if (p.shown !== a.name) { p.shown = a.name; p.term.reset(null); p.term.setFollow(true); p.part('term-body').scrollTop = 0; }
  const name = p.part('pane-name');
  if (name) name.textContent = split ? `${wsAgentLabel(a.name)} · ${(AGENT_STATE[a.state] || [a.state])[0]}` : '';
  const steps = (data.steps || []).filter(s => (s.agent || 'coder-1') === a.name);
  const hermes = a.type === 'orchestrator', researcher = roleOf(a.name) === 'researcher';
  renderWsHead(p, a, steps);
  renderWsTask(p, a, steps);
  renderWsApprovals(p, a);
  renderWsFiles(p, a, steps);
  renderWsNotes(p, a);
  renderWsSurface(p, a);
  const recordedOnly = hermes || researcher;
  p.part('term').classList.toggle('hidden', recordedOnly);
  p.part('log').classList.toggle('hidden', !recordedOnly);
  if (recordedOnly) { setHTML(p.part('turns'), ''); renderWsLog(p, a, steps); return; }
  const chosen = wsTurn[a.name] && steps.find(s => s.id === wsTurn[a.name]);
  const step = chosen || steps.at(-1);
  setHTML(p.part('turns'), steps.length > 1 ? `<div class="ws-turn-chips" role="group" aria-label="${esc(a.name)}'s turns">${steps.map(s =>
    `<button class="ws-chip ${s.id === step?.id ? 'active' : ''}" data-ws-turn="${esc(s.id)}" data-ws-agent="${esc(a.name)}" aria-pressed="${s.id === step?.id}" title="${esc(s.title)}">#${s.number}</button>`).join('')}
    <button class="ws-chip ${!chosen ? 'active' : ''}" data-ws-turn="" data-ws-agent="${esc(a.name)}" aria-pressed="${!chosen}">Latest</button></div>` : '');
  const live = step && !ended.has(current.status) && ['running', 'dispatching', 'waiting'].includes(step.status);
  const pending = agentRequests(a.name);
  p.term.render(step, live ? (pending.length ? 'waiting' : 'active') : step?.status === 'failed' ? 'failed' : 'done', pending, !chosen);
}

function renderWsHead(p, a, steps) {
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
  setHTML(p.part('head'), `<div class="ws-id"><span class="agent-avatar ${hermes ? 'hermes' : 'opencode'} role-${esc(role)}">${esc(roleMark(a.name))}</span>
      <div><h1 id="ws-title${p.suffix}">${esc(wsAgentLabel(a.name))} <span class="ac-status ${tone}"><span class="dot"></span>${esc(label)}</span>${a.since ? `<span class="small muted ws-since" title="${esc(new Date(a.since).toLocaleString())}">${esc(wsSince(a.since))}</span>` : ''}</h1>
      <p class="small muted">${esc(title || a.role || '')}${a.runtime ? ' · ' + esc(a.runtime) : ''} · run “${esc(runTitle(current, 60))}”</p>
      ${a.task ? `<p class="small ws-now">${esc(a.task)}</p>` : ''}</div></div>
    <dl class="ws-facts small">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`);
}

function renderWsTask(p, a, steps) {
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
  setHTML(p.part('task'), `<section class="ac-panel"><h2 class="ac-panel__title">${a.type === 'orchestrator' ? 'Plan' : 'Task'}</h2>${body}${verify}</section>`);
}

function renderWsApprovals(p, a) {
  const cards = agentRequests(a.name).map(approvalCard).concat(researchRequests(current.id).filter(r => r.agent === a.name).map(r => researchCard(r, 'ws')));
  const teamPlan = a.type === 'orchestrator' && current.status === 'awaiting_approval'
    ? '<section class="ac-panel"><h2 class="ac-panel__title">Team plan</h2><p class="small">Hermes proposed a team and waits for your decision.</p><button class="ac-btn primary" data-view="runs">Review the team plan</button></section>' : '';
  setHTML(p.part('approvals'), cards.length || teamPlan ? `<div class="ws-approvals">${teamPlan}${cards.join('')}</div>` : '');
}

function renderWsFiles(p, a, steps) {
  const withEvidence = steps.filter(s => s.evidence);
  const files = fileStats(withEvidence);
  const rows = files.slice(0, 40).map(f => `<div class="file-row">${icon('file')}<span class="file-path">${esc(f.path)}</span><span class="file-change">${esc(f.change)}</span>${f.added !== null ? `<span class="file-counts"><span class="added">+${f.added}</span><span class="removed">−${f.removed}${f.partial ? '*' : ''}</span></span>` : ''}</div>`).join('');
  const diffs = withEvidence.slice(-4).reverse().map(s => `<button class="text-button small" data-ws-diff="${esc(s.id)}">Turn ${s.number} diff</button>`).join(' ');
  setHTML(p.part('files'), a.type === 'orchestrator' ? '' : `<section class="ac-panel"><h2 class="ac-panel__title">Files <span class="muted small">· ${files.length}</span></h2>
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

function renderWsNotes(p, a) {
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
  setHTML(p.part('notes'), `<section class="ac-panel"><h2 class="ac-panel__title">Notes &amp; activity</h2>
    <p class="small muted">Recorded instructions, Hermes’s summaries and this agent’s events. Private model reasoning is not recorded and is never shown.</p>
    ${lifecycle.length ? `<h3 class="ws-subhead small">State changes</h3><ul class="ws-list ws-lifecycle">${lifecycle.join('')}</ul>` : ''}
    ${[...notes, ...decisions].length ? `<ul class="ws-list">${[...notes, ...decisions].join('')}</ul>` : ''}
    ${mine.length ? `<ul class="ws-list">${mine.join('')}</ul>` : '<p class="small muted">No events recorded for this agent yet.</p>'}
    ${finished ? '' : `<form class="ws-note" data-ws-note="${esc(a.name)}"><label class="sr-only" for="ws-note-text${p.suffix}">Note</label><input id="ws-note-text${p.suffix}" maxlength="5000" placeholder="${a.type === 'orchestrator' ? 'Tell Hermes something' : 'Note for Hermes about ' + esc(a.name)}" autocomplete="off"><button class="ac-btn">Send</button></form>
      <p class="small muted">${a.type === 'orchestrator' ? 'Goes into Hermes’s next decision.' : `Goes to Hermes, marked for ${esc(a.name)}; Hermes decides what ${esc(a.name)} is told.`}</p>`}</section>`);
}

function renderWsLog(p, a, steps) {
  if (roleOf(a.name) === 'researcher') {
    const items = steps.map(s => `<div class="ws-log-item"><div class="term-line"><span class="term-prompt">?</span><span class="term-cmd">${esc(s.question || s.title)}</span><span class="term-status">${esc(s.status || '')}</span></div>
      ${s.report ? `<p class="small">${esc(s.report.summary || '')}</p>${(s.report.sources || []).length ? `<ul class="small">${s.report.sources.slice(0, 8).map(u => `<li class="mono">${esc(u)}</li>`).join('')}</ul>` : ''}` : ''}</div>`).join('');
    setHTML(p.part('log'), `<p class="small muted ws-log-note">The researcher runs Hermes once per approved question; its report is recorded when that call ends. There is no live stream.</p>${items || '<p class="small muted">No questions yet.</p>'}`);
    return;
  }
  const calls = (data.events || []).filter(e => ['Hermes request', 'Hermes decision', 'Hermes JSON repaired'].includes(e.kind)).slice(-40);
  const items = calls.map(e => {
    let parsed; try { parsed = JSON.parse(e.detail); } catch {}
    const request = e.kind === 'Hermes request';
    const text = request ? String(e.detail || '') : parsed ? [parsed.action, parsed.title, parsed.summary].filter(Boolean).join(' · ') : String(e.detail || '');
    return `<details class="ws-log-item" data-key="ws${p.suffix}-${esc(String(e.id))}"><summary><span class="term-prompt">${request ? '→' : '←'}</span> <span class="muted small">${when(e.created)}</span> ${esc(request ? `request to Hermes · ${plural(text.length, 'character')}` : e.kind === 'Hermes JSON repaired' ? 'reply repaired' : 'decision: ' + text.slice(0, 160))}</summary><pre>${esc(text.slice(-6000))}</pre></details>`;
  }).join('');
  setHTML(p.part('log'), `<p class="small muted ws-log-note">Hermes runs as one call per decision, so this is the recorded log of those calls (what AgentControl sent and what came back), not a live stream.</p>${items || '<p class="small muted">No Hermes calls recorded yet.</p>'}`);
}

/* ---- Preview surfaces (W6) --------------------------------------------------------------------
   The run's surfaces (data.surfaces, from surfaces.py) shown inside a pane: the web preview in an
   iframe, a program's output, the desktop preview or the VM screen as a clickable image. Frames are
   fetched only while a viewer is open and on screen, one fetch per surface for every viewer showing
   it. Opening or expanding a viewer never starts anything; Start and Stop stay explicit buttons. */
const SURFACE_LABEL = {web: 'Web', terminal: 'Program', desktop: 'Desktop', 'vm-console': 'VM screen', 'browser-session': 'Browser', vnc: 'VNC'};
function wsSurfaces(agent) { return (data?.surfaces || []).filter(x => x.agents === 'all' || (x.agents || []).includes(agent)); }
function wsViewerOpen(p) { return view === 'workspace' && !document.hidden && !!p.part('preview-box')?.open && !!p.shown && !$(p.i ? 'ws-pane-1' : 'ws-pane').classList.contains('hidden'); }
function wsChosenSurface(p, list) { return list.find(x => x.id === p.surface) || list.find(x => ['starting', 'running'].includes(x.state)) || list[0] || null; }
/* What the shared preview loop (pollPreview in app.js) should fetch for open workspace viewers. */
function wsSurfaceWatch() {
  const watch = {preview: false, vm: false, generic: []};
  wsPanes.forEach(p => {
    if (!wsViewerOpen(p)) return;
    const x = wsChosenSurface(p, wsSurfaces(p.shown));
    if (x?.frame === 'preview' || x?.kind === 'terminal') watch.preview = true;
    if (x?.frame === 'vm') watch.vm = true;
    if (x?.frame === 'surface' && !watch.generic.includes(x.id)) watch.generic.push(x.id);
  });
  return watch;
}

function renderWsSurface(p, a) {
  const list = wsSurfaces(a.name), x = wsChosenSurface(p, list), status = previewStatus();
  const mine = status.run === current.id, live = x && ['starting', 'running'].includes(x.state);
  p.part('preview-sum').textContent = x ? `· ${x.title} · ${x.state}` : '· none';
  const picker = list.length > 1 ? `<div class="ws-surface-pick" role="group" aria-label="Surfaces">${list.map(y =>
    `<button class="ws-chip ${y.id === x.id ? 'active' : ''}" data-ws-surface="${esc(y.id)}" aria-pressed="${y.id === x.id}">${esc(SURFACE_LABEL[y.kind] || y.kind)}</button>`).join('')}</div>` : '';
  const controls = x?.provider === 'preview' ? previewControlsHTML(status, mine) : '';
  const expanded = p.part('preview-box').classList.contains('expanded');
  setHTML(p.part('preview'), !x
    ? `<p class="small muted">No preview is set up for this run. Choose how to run it in the Project tab.</p><p><button class="ac-btn compact" data-view="project">Open Project</button></p>`
    : `${picker}<div class="ws-surface-bar"><span class="small"><strong>${esc(x.title)}</strong> ${x.note ? `<span class="mono muted">${esc(x.note)}</span>` : ''}</span>
      <span class="row wrap">${controls}<button class="ac-btn compact" data-ws-expand="${p.i}" aria-pressed="${expanded}">${expanded ? 'Collapse' : 'Expand'}</button></span></div>`);
  // The body only changes when the surface or whether it runs changes, so an iframe is not reloaded on every refresh.
  const body = !x ? '' : !live ? `<p class="small muted ws-surface-idle">${x.provider === 'preview' ? 'Not running. Start it with the button above; nothing starts by opening this view.' : 'Not available right now.'}</p>`
    : x.kind === 'web' ? `<iframe class="ws-surface-frame" title="Live preview of the project" referrerpolicy="no-referrer" sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals allow-downloads"></iframe><p class="small muted ws-surface-address"></p>`
    : x.kind === 'terminal' ? `<pre class="ws-surface-output" data-surface-output role="log" aria-label="Program output"></pre>${wsTypeForm(p, 'preview-input', 'Type input for the program')}`
    : x.frame ? `<img class="ws-surface-screen" alt="${esc(x.title)}; click to click, right-click to right-click" data-surface-screen="${esc(x.frame === 'surface' ? 'surface' : x.frame)}" data-surface-id="${esc(x.id)}">
        ${x.interactive ? wsTypeForm(p, x.frame === 'vm' ? 'vm' : x.frame === 'surface' ? 'surface' : 'desktop', 'Type text') + wsKeys(x.frame) : ''}`
    : '<p class="small muted">This surface has no viewer yet.</p>';
  setHTML(p.part('surface'), body);
  if (!x || !live) return;
  const box = p.part('surface');
  if (x.kind === 'web') { const frame = box.querySelector('iframe'); if (frame && wsViewerOpen(p)) ensurePreviewFrame(status, frame, box.querySelector('.ws-surface-address')); }
  const out = box.querySelector('[data-surface-output]');
  if (out && !out.dataset.filled) { out.textContent = preview.buffer || ''; out.dataset.filled = '1'; out.scrollTop = out.scrollHeight; }
  const img = box.querySelector('img[data-surface-screen]');
  if (img && !img.getAttribute('src')) {
    const url = x.frame === 'vm' ? vmScreenURL : x.frame === 'preview' ? preview.screenURL : wsGenericURL[x.id];
    if (url) img.src = url;
  }
}
function wsTypeForm(p, target, label) {
  return `<form class="preview-input ws-surface-type" data-ws-type="${esc(target)}"><label class="sr-only" for="ws-type${p.suffix}">${esc(label)}</label><input id="ws-type${p.suffix}" autocomplete="off" placeholder="${esc(label)}"><button class="ac-btn compact">Send</button></form>`;
}
function wsKeys(frame) {
  const attr = frame === 'vm' ? 'data-vm-key' : frame === 'preview' ? 'data-desktop-key' : 'data-ws-surface-key';
  return `<span class="row wrap desktop-keys">${[['Return', 'Enter'], ['Escape', 'Esc'], ['Tab', 'Tab'], ['BackSpace', '⌫']].map(([k, l]) => `<button type="button" class="ac-btn compact" ${attr}="${k}">${l}</button>`).join('')}</span>`;
}

/* Surfaces from other providers (not the preview or the VM) are read through /api/surface/frame. */
const wsGenericURL = {};
let wsGenericTimer = 0;
async function wsPollGeneric() {
  clearTimeout(wsGenericTimer);
  const ids = key && connected && current ? wsSurfaceWatch().generic : [];
  for (const id of ids) {
    try {
      const response = await fetch(`/api/surface/frame?run=${encodeURIComponent(current.id)}&id=${encodeURIComponent(id)}`, {headers: {Authorization: 'Bearer ' + key}});
      if (!response.ok) continue;
      const url = URL.createObjectURL(await response.blob());
      document.querySelectorAll(`img[data-surface-screen="surface"][data-surface-id="${CSS?.escape ? CSS.escape(id) : id}"]`).forEach(img => { img.src = url; });
      if (wsGenericURL[id]) URL.revokeObjectURL(wsGenericURL[id]);
      wsGenericURL[id] = url;
    } catch {}
  }
  if (ids.length) wsGenericTimer = setTimeout(wsPollGeneric, 1000);
}
function wsSurfaceInput(id, body) { return api('/api/surface/input', 'POST', {run: current.id, id, ...body}); }
/* Opening a viewer starts the shared preview loop (it may not be running if the Project tab was never opened). */
function wsViewerChanged() {
  renderWorkspace();
  const watch = wsSurfaceWatch();
  if (watch.preview || watch.vm) pollPreview();
  if (watch.generic.length) wsPollGeneric();
}
/* Expanding moves the pane's viewer into a modal dialog (the browser's top layer, so no theme frame
   can clip it) and back when it closes. A moved iframe reloads, so it is given a fresh ticket. */
function wsExpand(i, on) {
  const p = wsPanes[i], box = p.part('preview-box'), dialog = $('ws-viewer-dialog'), host = $('ws-viewer-host');
  if (on === box.classList.contains('expanded')) return;
  const forgetFrame = () => p.part('surface').querySelectorAll('iframe[data-key]').forEach(f => { f.dataset.key = ''; });
  if (on) {
    if (dialog.open) dialog.close();   // one expanded viewer at a time
    box.open = true;
    box.classList.add('expanded');
    dialog.dataset.pane = String(i);
    $('ws-viewer-title').textContent = `Preview · ${wsAgentLabel(p.shown)}`;
    host.append(p.part('preview'), p.part('surface'));
    forgetFrame();
    dialog.showModal();
  } else {
    box.classList.remove('expanded');
    box.append(p.part('preview'), p.part('surface'));
    forgetFrame();
    if (dialog.open && dialog.dataset.pane === String(i)) dialog.close();
  }
  wsViewerChanged();
}

/* On the XP theme every open workspace is a window button on the taskbar, flashing when its agent waits for you. */
function renderXpTasks(agents) {
  const bar = document.querySelector('.xp-taskbar');
  if (!bar) return;
  bar.querySelectorAll('.xp-ws-task').forEach(e => e.remove());
  const tray = $('xp-tray'), byName = Object.fromEntries(agents.map(a => [a.name, a]));
  wsState.open.filter(n => byName[n]).forEach(name => {
    const a = byName[name], button = document.createElement('button');
    button.className = `xp-task xp-ws-task ${a.state === 'waiting_on_you' ? 'xp-flash' : ''} ${view === 'workspace' && wsVisible().includes(name) ? 'active' : ''}`;
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
  if (b.dataset.wsTurn !== undefined) {
    const pane = wsPanes[Number(b.closest('[data-pane]')?.dataset.pane) || 0];
    wsTurn[b.dataset.wsAgent || pane.shown] = b.dataset.wsTurn || null; pane.term.reset(null); renderWorkspace(); return true;
  }
  if (b.dataset.wsMode !== undefined) { setWorkspaceMode(b.dataset.wsMode); return true; }
  if (b.dataset.wsSurface !== undefined) { wsPaneOf(b).surface = b.dataset.wsSurface; wsViewerChanged(); return true; }
  if (b.dataset.wsExpand !== undefined) { const i = Number(b.dataset.wsExpand); wsExpand(i, !wsPanes[i].part('preview-box').classList.contains('expanded')); return true; }
  if (b.dataset.wsSurfaceKey !== undefined) {
    const img = wsPaneOf(b).part('surface').querySelector('img[data-surface-id]');
    if (img) await wsSurfaceInput(img.dataset.surfaceId, {action: 'key', key: b.dataset.wsSurfaceKey}).catch(e => pageError(e.message));
    return true;
  }
  if (b.dataset.wsFocus !== undefined) { focusPane(Number(b.dataset.wsFocus)); return true; }
  if (b.dataset.wsDiff !== undefined) { openDiff(b.dataset.wsDiff); return true; }
  return false;
}
function workspaceKey(event) {
  if (view !== 'workspace') return false;
  if (/^[1-9]$/.test(event.key)) { const name = wsState.open[Number(event.key) - 1]; if (name) openWorkspace(name); return true; }
  if (event.key === ']') { stepWorkspace(1); return true; }
  if (event.key === '[') { stepWorkspace(-1); return true; }
  if (event.key === '\\') { setWorkspaceMode(wsSplit() ? 'tabs' : 'split'); return true; }
  if (event.key === 'o' && wsSplit() && wsSplitFits()) { focusPane(wsState.focus ? 0 : 1); return true; }
  return false;
}

Object.assign(ACTIONS, {
  'ws-menu': () => {
    const menu = $('ws-menu'), open = menu.classList.toggle('hidden') === false;
    $('ws-add').setAttribute('aria-expanded', String(open));
  },
  'ws-term-follow': b => { const t = wsPaneOf(b).term; t.setFollow(!t.follow); },
  'ws-term-jump': b => wsPaneOf(b).term.setFollow(true),
  'ws-term-copy': async b => { try { await navigator.clipboard.writeText(wsPaneOf(b).term.text(data?.steps)); toast('Terminal output copied.'); } catch { toast('Copy is unavailable in this browser.'); } },
});
function wsPaneOf(el) { return wsPanes[Number(el?.closest?.('[data-pane]')?.dataset.pane) || 0]; }

document.addEventListener('submit', async event => {
  const typing = event.target.closest?.('[data-ws-type]');
  if (typing) {
    event.preventDefault();
    const input = typing.querySelector('input'), text = input.value, target = typing.dataset.wsType;
    if (!text) return;
    try {
      if (target === 'preview-input') await previewAction('input', {text: text + '\n'});
      else if (target === 'desktop') { await previewAction('type', {text}); await refreshScreen(); }
      else if (target === 'vm') await vmInput({action: 'type', text});
      else {
        const img = typing.closest('.ws-surface-body').querySelector('img[data-surface-id]');
        await wsSurfaceInput(img.dataset.surfaceId, {action: 'type', text});
      }
      input.value = '';
    } catch (error) { pageError(error.message); }
    return;
  }
  const form = event.target.closest?.('[data-ws-note]');
  if (!form) return;
  event.preventDefault();
  const input = form.querySelector('input'), text = input.value.trim(), agent = form.dataset.wsNote;
  if (!text) return;
  try { await control('instruction', text, current.id, agent === 'hermes' ? null : agent); input.value = ''; toast('Note saved for Hermes’s next decision.'); }
  catch (error) { pageError(error.message); }
});
wsPanes.forEach(p => p.part('term-body')?.addEventListener('scroll', p.term.onScroll));
wsPanes.forEach(p => p.part('preview-box')?.addEventListener('toggle', () => { if (!p.part('preview-box').open) wsExpand(p.i, false); else wsViewerChanged(); }));
// Esc, × or Collapse close the dialog; the viewer then returns to its pane.
$('ws-viewer-dialog')?.addEventListener('close', () => {
  const i = Number($('ws-viewer-dialog').dataset.pane);
  if (wsPanes[i]?.part('preview-box').classList.contains('expanded')) wsExpand(i, false);
});
// Clicks on a provider's own surface (the preview and VM screens are handled in app.js).
document.addEventListener('click', event => {
  const img = event.target?.closest?.('img[data-surface-screen="surface"]');
  if (!img || !img.naturalWidth) return;
  const rect = img.getBoundingClientRect();
  const x = Math.round((event.clientX - rect.left) / rect.width * img.naturalWidth), y = Math.round((event.clientY - rect.top) / rect.height * img.naturalHeight);
  wsSurfaceInput(img.dataset.surfaceId, {action: 'click', x, y, width: img.naturalWidth, height: img.naturalHeight, button: 1}).catch(e => pageError(e.message));
});
// Clicking anywhere in a pane focuses it, so the next tab opens there.
[0, 1].forEach(i => $(i ? 'ws-pane-1' : 'ws-pane')?.addEventListener('pointerdown', () => focusPane(i)));

/* The divider: drag it, use the arrow keys on it, or double-click it to share the width evenly. */
(function wsDivider() {
  const divider = $('ws-divider'), panes = $('ws-panes');
  if (!divider || !panes) return;
  let dragging = false;
  const move = event => {
    if (!dragging) return;
    const box = panes.getBoundingClientRect();
    if (box.width) setPaneRatio((event.clientX - box.left) / box.width, false);
  };
  divider.addEventListener('pointerdown', event => { dragging = true; divider.setPointerCapture?.(event.pointerId); divider.classList.add('dragging'); event.preventDefault(); });
  divider.addEventListener('pointermove', move);
  const stop = () => { if (!dragging) return; dragging = false; divider.classList.remove('dragging'); wsSave(); };
  divider.addEventListener('pointerup', stop);
  divider.addEventListener('pointercancel', stop);
  divider.addEventListener('dblclick', () => setPaneRatio(.5));
  divider.addEventListener('keydown', event => {
    const step = {ArrowLeft: -.05, ArrowRight: .05}[event.key];
    if (step) { event.preventDefault(); event.stopPropagation(); setPaneRatio(wsState.ratio + step); }
    if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); setPaneRatio(event.key === 'Home' ? .2 : .8); }
    if (event.key === 'Enter') { event.preventDefault(); setPaneRatio(.5); }
  });
})();
let wsResize = 0;
window.addEventListener?.('resize', () => {
  globalThis.cancelAnimationFrame?.(wsResize);
  wsResize = globalThis.requestAnimationFrame?.(() => renderWorkspace()) || 0;
});
