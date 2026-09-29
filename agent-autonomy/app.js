'use strict';
/* AgentControl dashboard. Plain browser JavaScript; the server supplies all state
   through GET /api/state and every mutation goes through a small POST API. */

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#icon-${name}"/></svg>`;
const pretty = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const ended = new Set(['completed', 'blocked', 'failed', 'stopped', 'limit_reached']);
const KEY_NAME = 'ac-dashboard-key', LEGACY_KEY_NAME = 'trial-dashboard-key';

let key = readKey(), selected = '', data = null, current = null, view = 'runs';
let refreshing = false, connected = false, reviewBusy = false, reviewing = null, stopRunId = '', parentRun = null;
let refreshAgain = false;
let toastTimer, errorTimer, pollTimer, failures = 0, announcedRequests = '', diffText = '', lastStateTime = null;
let selectedTurn = null, shownStage = '';
const seenRequests = new Set();
const dismissedReceipts = new Set();
const term = {turn: null, count: 0, omitted: 0, last: '', follow: true};

function storage(kind) { try { return kind === 'local' ? localStorage : sessionStorage; } catch { return null; } }
function readItem(kind, name) { try { return storage(kind)?.getItem(name) || ''; } catch { return ''; } }
function readKey() { return readItem('local', KEY_NAME) || readItem('session', KEY_NAME) || readItem('session', LEGACY_KEY_NAME); }
function saveKey(value, remember) {
  for (const [kind, keep] of [['local', remember], ['session', !remember]]) {
    try { if (keep) storage(kind).setItem(KEY_NAME, value); else storage(kind).removeItem?.(KEY_NAME); } catch {}
  }
}
function forgetKey() {
  for (const kind of ['local', 'session']) for (const name of [KEY_NAME, LEGACY_KEY_NAME]) try { storage(kind).removeItem?.(name); } catch {}
  key = '';
}

function timeLabel(value) {
  const date = new Date(value);
  return isNaN(date) ? '—' : date.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
}
function relTime(value, now = Date.now()) {
  const date = new Date(value);
  if (isNaN(date)) return '—';
  const seconds = (now - date) / 1000;
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (new Date(now).toDateString() === date.toDateString()) return timeLabel(value);
  return date.toLocaleDateString([], {month: 'short', day: 'numeric'}) + ', ' + timeLabel(value);
}
function when(value) {
  const date = new Date(value);
  if (isNaN(date)) return '<time>—</time>';
  return `<time datetime="${esc(date.toISOString())}" title="${esc(date.toLocaleString())}">${esc(relTime(value))}</time>`;
}
function duration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const n = Math.max(0, Math.floor(seconds));
  return n >= 3600 ? `${Math.floor(n / 3600)}h ${Math.floor(n % 3600 / 60)}m` : `${Math.floor(n / 60)}m ${n % 60}s`;
}
function budget(run, now = Date.now()) {
  if (!run) return {used: 0, allowed: 0};
  const start = Date.parse(run.created), end = run.ended ? Date.parse(run.ended) : now;
  const allowed = run.time_limit_seconds ?? (run.deadline * 1000 - start) / 1000;
  return {used: Number.isFinite(start) ? Math.max(0, (end - start) / 1000) : 0, allowed: Math.max(0, Math.round(allowed || 0))};
}
function runTitle(run, limit = 140) {
  const text = (run?.title || run?.goal || '').split('\n')[0].trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), limit * .6)).replace(/[\s,.;:]+$/, '') + '…';
}
function shellQuote(value) { return "'" + String(value).replaceAll("'", "'\"'\"'") + "'"; }
function details(title, text, id) { return `<details data-key="${esc(id)}"><summary>${esc(title)}</summary><pre>${esc(text)}</pre></details>`; }
function diffHTML(text) {
  return text.split('\n').map(line => {
    const tone = /^(@@|\+\+\+|---)/.test(line) ? 'diff-heading' : line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-remove' : '';
    return `<span class="diff-line ${tone}">${esc(line)}</span>`;
  }).join('');
}
/* Replace markup only when it changed, keeping <details> open/closed state. */
function setHTML(element, html) {
  if (element.dataset.rendered === html) return;
  const expanded = new Map([...element.querySelectorAll('details[data-key]')].map(e => [e.dataset.key, e.open]));
  element.innerHTML = html;
  element.dataset.rendered = html;
  element.querySelectorAll('details[data-key]').forEach(e => { if (expanded.has(e.dataset.key)) e.open = expanded.get(e.dataset.key); });
}
function toast(message) {
  $('toast').textContent = message;
  $('toast').classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 4500);
}
function pageError(message) {
  $('page-error-text').textContent = message || '';
  $('page-error').classList.toggle('hidden', !message);
  clearTimeout(errorTimer);
  if (message) errorTimer = setTimeout(() => pageError(''), 15000);
}

// ---------------------------------------------------------------------------
// Labels derived from recorded state (never invented)
// ---------------------------------------------------------------------------
function requestKey(p) { return `${p.run}:${p.kind}:${p.request_id}`; }
function runRequests(run = current) { return (data?.inbox || []).filter(p => p.run === run?.id); }
function stateLabel(run, pending = []) {
  if (!run) return {text: 'Ready', tone: ''};
  if (!ended.has(run.status) && pending.length) return {text: pending.some(p => p.kind === 'permission') ? 'Needs your approval' : 'Needs your answer', tone: 'attention'};
  if (run.status === 'waiting') return {text: 'Resuming', tone: 'running'};
  const map = {awaiting_approval: ['Needs your decision', 'attention'], planning: ['Planning', 'running'], coding: ['Running', 'running'], reviewing: ['Verifying', 'running'], resuming: ['Resuming', 'running'],
    paused: ['Paused', ''], interrupted: ['Interrupted', 'attention'], attention: ['Needs attention', 'attention'], completed: ['Completed', 'completed'],
    failed: ['Failed', 'failed'], stopped: ['Stopped', ''], blocked: ['Blocked', 'attention'], limit_reached: ['Budget exhausted', 'attention']};
  const pair = map[run.status] || [run.status, ''];
  return {text: pair[0], tone: pair[1]};
}
function statusHTML(run, pending = []) {
  const s = stateLabel(run, pending);
  return `<span class="ac-status ${s.tone}"><span class="dot"></span>${esc(s.text)}</span>`;
}
function requestTitle(p) {
  if (p.kind === 'question') return p.questions?.[0]?.header || 'OpenCode has a question';
  return ({bash: 'OpenCode wants to run a command', edit: 'OpenCode wants to edit files', write: 'OpenCode wants to write a file', read: 'OpenCode wants to read a file',
    external_directory: 'OpenCode requests directory access', webfetch: 'OpenCode requests web access', task: 'OpenCode wants to start a subtask',
    doom_loop: 'OpenCode requests a repeated action'})[p.permission] || p.title || 'OpenCode requests permission';
}
function requestText(p) {
  const input = p.context?.input || {}, meta = p.metadata || {};
  return input.command || meta.command || input.filePath || input.path || (Array.isArray(p.patterns) ? p.patterns.join('\n') : p.pattern)
    || (p.kind === 'question' ? p.questions?.map(q => q.question).join('\n') : 'See full request');
}
function receiptLabel(r) {
  if (r.state === 'confirmed') return r.action === 'approve' ? 'Approved once' : r.action === 'reject' ? 'Denied' : 'Answered';
  return ({sent: 'Awaiting confirmation', dispatching: 'Sending decision', uncertain: 'Delivery uncertain', resolved: 'Request resolved', failed: 'Delivery failed'})[r.state] || r.state;
}
function verificationLabel(step) {
  const state = step?.verification?.status;
  return state === 'passed' ? 'Verification passed' : state === 'failed' ? 'Verification failed' : state === 'not configured' ? 'Review only'
    : step?.status === 'failed' ? 'Coding failed' : 'Not verified yet';
}
function fileStats(steps) {
  const files = new Map();
  for (const step of steps || []) for (const path of step.evidence?.changed_files || []) {
    const stat = step.evidence?.file_stats?.find(f => f.path === path);
    const previous = files.get(path);
    if (!previous) {
      files.set(path, {path, change: stat?.change || 'changed', added: stat?.added ?? null, removed: stat?.removed ?? null, partial: stat?.partial || !stat});
      continue;
    }
    previous.added = previous.added === null || stat?.added === undefined ? null : previous.added + stat.added;
    previous.removed = previous.removed === null || stat?.removed === undefined ? null : previous.removed + stat.removed;
    previous.partial ||= stat?.partial || !stat;
    if (stat?.change === 'deleted') previous.change = 'deleted';
    else if (previous.change === 'deleted') previous.change = 'changed';
  }
  return [...files.values()];
}
function phaseIndex(run, steps) {
  const last = steps.at(-1);
  if (run?.status === 'completed') return 4;
  if (last && ['prepared', 'dispatching'].includes(last.status)) return 1;
  if (run?.phase === 'code') return 2;
  if (run?.phase === 'verify' || (run?.phase === 'manager' && steps.length)) return 3;
  return 0;
}
function stepCounts(step) {
  const stats = step.evidence?.file_stats;
  if (!stats) return '';
  const added = stats.reduce((n, x) => n + x.added, 0), removed = stats.reduce((n, x) => n + x.removed, 0);
  return `<span class="added">+${added}</span> <span class="removed">−${removed}</span>${stats.some(x => x.partial) ? ' (partial)' : ''}`;
}
/* Hermes is planning another turn: the latest turn is verified and the run is still live. */
function planningNext(run, steps) {
  if (!run || ended.has(run.status)) return false;
  const last = steps.at(-1);
  return !last || (run.phase === 'manager' && !!last.verified);
}
function stageStates(run, step, isLast, pending, next) {
  if (next) return {plan: 'active', prompt: 'pending', code: 'pending', verify: 'pending'};
  const s = step.status, live = !ended.has(run.status);
  const code = ['prepared', 'dispatching'].includes(s) ? 'pending'
    : ['running', 'waiting'].includes(s) ? (isLast && pending.length ? 'waiting' : live ? 'active' : 'failed')
    : s === 'failed' ? 'failed' : 'done';
  const verify = step.verification ? (step.verification.status === 'failed' ? 'failed' : 'done')
    : isLast && live && run.phase === 'verify' ? 'active' : 'pending';
  return {plan: 'done', prompt: ['prepared', 'dispatching'].includes(s) ? 'active' : 'done', code, verify};
}
const TOOL_SYMBOL = {bash: '$', edit: '✎', write: '+', patch: '✎', read: '›', list: '›', glob: '›', grep: '›', webfetch: '⇣', task: '↳', todowrite: '☐'};
/* Ordered terminal entries. Older steps without a transcript fall back to recorded activity. */
function transcriptOf(step) {
  if (Array.isArray(step?.transcript)) return step.transcript;
  const entries = (step?.activity || []).map(e => ({type: 'tool', tool: e.kind, status: e.status || '', summary: e.detail || '', output: e.output || ''}));
  if (step?.result) entries.push({type: 'text', text: step.result});
  return entries;
}

// ---------------------------------------------------------------------------
// Themes, favicon, notifications
// ---------------------------------------------------------------------------
function setTheme(theme, save = true) {
  if (!['mac', 'terminal', 'xp'].includes(theme)) theme = 'mac';
  document.documentElement.dataset.theme = theme;
  document.querySelectorAll('button[data-theme]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.theme === theme)));
  if (save) try { localStorage.setItem('ac-theme', theme); } catch { toast('Theme changed for this visit. Browser storage is unavailable.'); }
}
function faviconHref(count) {
  const badge = count ? `<circle cx="24" cy="8" r="8" fill="#FF9500"/><text x="24" y="12" font-size="11" font-family="sans-serif" font-weight="700" text-anchor="middle" fill="#fff">${count > 9 ? '9+' : count}</text>` : '';
  return 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="1" y="3" width="28" height="28" rx="7" fill="#0071E3"/><text x="15" y="24" font-size="18" font-family="sans-serif" font-weight="700" text-anchor="middle" fill="#fff">A</text>${badge}</svg>`);
}
function setFavicon(count) {
  const link = $('favicon');
  if (link && link.dataset.count !== String(count)) { link.href = faviconHref(count); link.dataset.count = String(count); }
}
function notificationsOn() { return readItem('local', 'ac-notify') === 'on' && typeof Notification !== 'undefined' && Notification.permission === 'granted'; }
function notifyNewRequests(inbox) {
  const fresh = inbox.filter(p => !seenRequests.has(requestKey(p)));
  const firstLoad = !seenRequests.size && !announcedRequests;
  inbox.forEach(p => seenRequests.add(requestKey(p)));
  if (firstLoad || !fresh.length || !notificationsOn() || !document.hidden) return;
  try {
    const n = new Notification('AgentControl: ' + requestTitle(fresh[0]), {body: requestText(fresh[0]).slice(0, 180), tag: 'ac-approval'});
    n.onclick = () => { window.focus(); focusApproval(); n.close(); };
  } catch {}
}
async function toggleNotifications() {
  if (typeof Notification === 'undefined') { toast('This browser does not support notifications.'); return; }
  if (notificationsOn()) { try { localStorage.setItem('ac-notify', 'off'); } catch {} toast('Browser notifications turned off.'); }
  else {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') { toast('Notifications were not allowed by the browser.'); return; }
    try { localStorage.setItem('ac-notify', 'on'); } catch {}
    toast('You will be notified about new requests while this tab is in the background.');
  }
  renderShell();
}

// ---------------------------------------------------------------------------
// Network and polling
// ---------------------------------------------------------------------------
function showAuth(message = '') {
  document.documentElement.classList.remove('has-key');
  $('boot').classList.add('hidden');
  $('app').classList.add('hidden');
  $('auth').classList.remove('hidden');
  $('auth-error').textContent = message;
}
async function api(path, method = 'GET', body) {
  const response = await fetch(path, {method, headers: {Authorization: 'Bearer ' + key, 'Content-Type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)});
  let result;
  try { result = await response.json(); } catch { throw Error('The controller returned an unreadable response.'); }
  if (response.status === 401) { connected = false; showAuth(result.error || 'Enter the dashboard key.'); }
  if (!response.ok) throw Error(result.error || `Request failed (${response.status})`);
  return result;
}
function isLive() {
  const last = data?.steps?.at(-1);
  return !!current && !ended.has(current.status) && ['running', 'dispatching', 'waiting'].includes(last?.status);
}
function nextDelay() {
  if (!connected) return Math.min(30000, 2000 * 2 ** Math.min(failures, 4));
  if (live.state === 'live') return 15000;  // changes arrive over the stream; this is only a safety net
  if (document.hidden) return 10000;
  return isLive() && view === 'runs' ? 1000 : 2000;
}
function schedule(delay = nextDelay()) {
  clearTimeout(pollTimer);
  if (key) pollTimer = setTimeout(async () => { await refresh(); schedule(); }, delay);
}
async function refresh() {
  if (!key) return;
  // A change notice that arrives mid-refresh must not be lost: remember it and refresh once more.
  if (refreshing) { refreshAgain = true; return; }
  refreshing = true;
  const requestedRun = selected;
  try {
    const result = await api('/api/state' + (selected ? '?run=' + encodeURIComponent(selected) : ''));
    if (requestedRun !== selected) return;
    data = result; current = data.run; connected = true; failures = 0; lastStateTime = Date.now();
    $('auth').classList.add('hidden');
    $('boot').classList.add('hidden');
    $('app').classList.remove('hidden');
    $('auth-error').textContent = '';
    render();
  } catch (error) {
    connected = false; failures++;
    if (!$('auth').classList.contains('hidden')) $('auth-error').textContent = error.message;
    $('connection-banner').textContent = 'Disconnected. Reconnecting… ' + error.message;
    $('connection-banner').classList.remove('hidden');
    refreshReview();
  } finally {
    refreshing = false;
    if (requestedRun !== selected || refreshAgain) { refreshAgain = false; refresh(); }
  }
}

// ---------------------------------------------------------------------------
// Live updates: the server streams small change notices (Server-Sent Events) and the
// dashboard re-reads /api/state on each. Uses fetch so the dashboard key stays in a header,
// never in a URL. If streaming is unavailable, polling (above) carries on as before.
// ---------------------------------------------------------------------------
const live = {state: 'off', abort: null, failures: 0, retry: null};
function setLive(state) {
  live.state = state;
  if (data) renderShell();
}
function handleEventBlock(block) {
  const name = (block.match(/^event: (.*)$/m) || [])[1];
  if (name === 'change' || name === 'hello') refresh();
}
async function connectEvents() {
  clearTimeout(live.retry);
  if (!key || live.state !== 'off' || typeof fetch !== 'function' || typeof TextDecoder === 'undefined') return;
  live.state = 'connecting';
  const abort = typeof AbortController === 'function' ? new AbortController() : null;
  live.abort = abort;
  let status = 0;
  try {
    const response = await fetch('/api/events', {headers: {Authorization: 'Bearer ' + key}, cache: 'no-store', signal: abort?.signal});
    status = response.status;
    if (!response.ok || !response.body || typeof response.body.getReader !== 'function') throw Error('Live updates unavailable');
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '';
    live.failures = 0;
    setLive('live');
    schedule();
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {stream: true}).replace(/\r\n/g, '\n');
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        handleEventBlock(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
      }
    }
  } catch {}
  const wasAborted = abort?.signal.aborted;
  live.abort = null;
  setLive('off');
  schedule();
  // Reconnect with backoff, except after sign-out or a rejected key (polling shows the sign-in).
  if (key && !wasAborted && status !== 401) {
    live.failures++;
    live.retry = setTimeout(connectEvents, Math.min(30000, 1000 * 2 ** Math.min(live.failures, 5)));
  }
}
function disconnectEvents() {
  clearTimeout(live.retry);
  live.abort?.abort();
}

// ---------------------------------------------------------------------------
// Rendering: shell
// ---------------------------------------------------------------------------
function render() {
  autoOpenProject();
  renderShell();
  renderRun();
  renderProject();
  renderApprovals();
  renderActivity();
  refreshReview();
}
function startBlocker(active) {
  if (!connected) return 'Reconnecting to the controller…';
  if (active) return 'Finish or stop the active run before starting another.';
  if (!data.health.ready) return (data.health.message || 'Connections are not ready.') + ' Open Connections to check again.';
  return '';
}
function renderShell() {
  const inbox = data.inbox || [], active = data.runs.some(r => !ended.has(r.status));
  const project = data.project.split('/').filter(Boolean).pop() || 'Project';
  document.title = (inbox.length ? `(${inbox.length}) ` : '') + 'AgentControl';
  setFavicon(inbox.length);
  notifyNewRequests(inbox);
  $('project-name').textContent = project;
  $('footer-project').textContent = data.project;
  $('working-folder').value = data.project;
  $('new-profile').textContent = data.profile;
  const maximum = Math.max(1, Math.floor((data.limits?.max_run_seconds || 7200) / 60));
  $('run-minutes').max = maximum;
  if (Number($('run-minutes').value) > maximum) $('run-minutes').value = maximum;
  const blocker = startBlocker(active);
  $('start-run').disabled = !!blocker;
  $('start-reason').textContent = blocker;
  $('start-reason').classList.toggle('hidden', !blocker);
  document.querySelectorAll('[data-capability]').forEach(e => e.classList.toggle('hidden', !data.capabilities?.[e.dataset.capability]));
  togglePreviewFields('new');

  const crumbs = [project, {new: 'New run', runs: 'Runs', approvals: 'Approvals', activity: 'Activity', project: 'Project', skills: 'Skills'}[view]];
  if (current && view !== 'new') crumbs.push('#' + current.id.slice(0, 6));
  $('breadcrumb').textContent = crumbs.join(' / ');
  $('xp-address').textContent = crumbs.join('\\');
  $('window-title').textContent = 'AgentControl' + (current ? ' — ' + runTitle(current, 100) : '');

  const state = stateLabel(current, runRequests());
  $('terminal-status').textContent = state.text;
  $('terminal-status').className = 'terminal-only terminal-status ' + state.tone;
  const xpResume = current?.pause || ['interrupted', 'attention'].includes(current?.status);
  setHTML($('xp-run-controls'), current && !ended.has(current.status) ? `
    <button class="toolbar-tool" data-action="pause" aria-label="${xpResume ? 'Resume' : 'Pause'}" aria-keyshortcuts="p"><span class="tool-badge pause-badge">${icon(xpResume ? 'play' : 'pause')}</span><span class="tool-label">${xpResume ? 'Resume' : 'Pause'}</span></button>
    <button class="toolbar-tool" data-action="stop" aria-label="Stop run" aria-keyshortcuts="x"><span class="tool-badge stop-badge">${icon('stop')}</span><span class="tool-label">Stop</span></button>` : '');
  const b = budget(current);
  const budgetText = current ? `${data.steps.length}/${current.max_steps} prompts · ${duration(b.used)} / ${duration(b.allowed)}` : '';
  $('terminal-budget').textContent = budgetText;
  $('xp-budget').textContent = budgetText;
  $('xp-status').textContent = connected ? state.text : 'Reconnecting';
  $('xp-folder').textContent = data.project;

  const waitingSkills = pendingSkills().length, waiting = inbox.length + waitingSkills;
  $('nav-count').textContent = waiting;
  $('nav-count').classList.toggle('hidden', !waiting);
  $('approval-total').textContent = `${waiting} pending`;
  $('tray-count').textContent = inbox.length ? `⚠ ${inbox.length}` : '';
  $('tray-clock').textContent = new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
  $('xp-notification').classList.toggle('hidden', !inbox.length);
  $('notification-text').textContent = inbox.length ? requestTitle(inbox[0]) : '';
  const signature = inbox.map(requestKey).sort().join(',');
  if (signature !== announcedRequests) {
    $('approval-announcement').textContent = inbox.length ? `${plural(inbox.length, 'OpenCode request')} waiting for your review.` : 'No requests waiting for review.';
    announcedRequests = signature;
  }
  const healthMessage = !connected ? 'Disconnected. Reconnecting…' : !data.health.ready ? data.health.message : '';
  $('connection-banner').textContent = healthMessage;
  $('connection-banner').classList.toggle('hidden', !healthMessage);
  $('last-updated').textContent = 'Updated ' + new Date(lastStateTime).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'})
    + (live.state === 'live' ? ' · live' : ' · polling');
  $('last-updated').title = live.state === 'live' ? 'Changes stream in as they happen.' : 'Checking for changes every few seconds.';
  renderRecentRuns(inbox);
  renderAgents(project);
  renderConnections();
}
function renderRecentRuns(inbox) {
  const query = $('run-filter').value.trim().toLowerCase();
  $('run-filter-row').classList.toggle('hidden', data.runs.length < 5);
  const runs = data.runs.filter(r => !query || (r.title || r.goal).toLowerCase().includes(query) || stateLabel(r).text.toLowerCase().includes(query));
  setHTML($('recent-runs'), runs.map(r => {
    const s = stateLabel(r, inbox.filter(x => x.run === r.id));
    const tone = s.tone === 'attention' ? 'warning-text' : s.tone === 'failed' ? 'error' : s.tone === 'completed' ? 'success-text' : '';
    return `<button class="recent-run ${r.id === current?.id ? 'active' : ''}" data-run="${esc(r.id)}" ${r.id === current?.id ? 'aria-current="true"' : ''}>
      <span class="dot ${tone}"></span>
      <span><span class="run-name">${esc(runTitle(r, 90))}</span><small>${esc(s.text)} · ${r.prompt_count ?? '—'} prompt${r.prompt_count === 1 ? '' : 's'} · ${esc(relTime(r.created))}</small></span>
    </button>`;
  }).join('') || `<p class="small muted">${query ? 'No runs match this filter.' : 'Your runs will appear here.'}</p>`);
}
function renderAgents(project) {
  const agents = data.health.agents || {};
  const rows = [['hermes', 'Hermes', 'Orchestrator', data.profile], ['opencode', 'OpenCode', 'Coder', project]];
  const endpoint = data.models?.endpoints?.find(e => e.default);
  if (endpoint || agents.model) rows.push(['model', 'Model server', endpoint ? `${endpoint.slots} slot${endpoint.slots === 1 ? '' : 's'}` : 'Registry', endpoint?.url || 'models.json']);
  setHTML($('agent-list'), rows.map(([id, name, role, host]) => {
    const agent = agents[id];
    const tone = agent?.state === 'ready' ? 'success-text' : agent?.state === 'unavailable' ? 'error' : agent?.state === 'warning' ? 'warning-text' : 'muted';
    return `<div class="agent-row"><span class="agent-avatar ${id}">${name[0]}</span><div><strong>${name}</strong><small>${role} · ${esc(host)}</small>
      <div class="agent-status ${tone}"><span class="dot"></span> ${esc(!connected ? 'Unknown · disconnected' : agent?.label || 'Not checked')}</div></div></div>`;
  }).join(''));
}
function renderConnections() {
  const attach = current?.session ? `<label>Attach from your server terminal</label><pre>${esc('opencode attach ' + shellQuote(data.opencode_url) + ' --session ' + shellQuote(current.session))}</pre>` : '';
  setHTML($('connection-details'), `<p>${esc(data.health.message)}</p>
    <p class="small muted">Last check: ${when(data.health.checked_at)}. Hermes readiness checks its CLI; it does not call the model.</p>
    <label>OpenCode</label><pre>${esc(data.opencode_url)}</pre><label>Hermes profile</label><pre>${esc(data.profile)}</pre>
    <label>Project</label><pre>${esc(data.project)}</pre>${attach}
    <h3>This browser</h3>
    <p class="small muted">Notifications for new approval requests: <strong>${notificationsOn() ? 'on' : 'off'}</strong>. Dashboard key: ${readItem('local', KEY_NAME) ? 'remembered on this device' : 'kept for this tab only'}.</p>
    <div class="row wrap"><button class="ac-btn" data-action="notifications">${notificationsOn() ? 'Turn off notifications' : 'Notify me about requests'}</button><button class="ac-btn" data-action="sign-out">Forget key and sign out</button></div>`);
}

// ---------------------------------------------------------------------------
// Rendering: run view (header, horizontal turn rail, stage board)
// ---------------------------------------------------------------------------
function renderRun() {
  $('empty-state').classList.toggle('hidden', !!current);
  $('run-layout').classList.toggle('hidden', !current);
  if (!current) return;
  const steps = data.steps || [], pending = runRequests(), finished = ended.has(current.status);
  renderRunHeader(steps, pending, finished);
  renderOutcome(steps, finished);
  renderWorkflow(steps, pending, finished);
  $('steering-form').classList.toggle('hidden', finished);
  $('steering-form').querySelectorAll('button').forEach(button => { button.disabled = !connected || (button.dataset.action === 'verify-now' && !canVerifyNow()); });
  setHTML($('inline-approvals'), pending.map(approvalCard).join('') || (finished ? '' : recentDecisionHTML()));
  renderTeam();
  renderChecks();
  renderVerification();
  renderModelUsage();
  renderBranch();
  renderSkillsPanel();
  renderFiles(fileStats(steps));
  renderTimeline();
  setHTML($('original-brief'), finished ? `<section class="ac-panel"><h2 class="ac-panel__title">Original brief</h2><p class="small">${esc(current.goal)}</p></section>` : '');
}
function renderRunHeader(steps, pending, finished) {
  const b = budget(current), canResume = current.pause || ['interrupted', 'attention'].includes(current.status);
  const controls = finished ? `<button class="ac-btn primary" data-action="followup">Start follow-up run</button>` : `
    <div class="row run-controls">
      <button class="ac-btn" data-action="pause" aria-label="${canResume ? 'Resume' : 'Pause after the active turn'}" aria-keyshortcuts="p">${icon(canResume ? 'play' : 'pause')}<span class="control-label">${canResume ? 'Resume' : 'Pause'}</span></button>
      <button class="ac-btn danger-button" data-action="stop" aria-label="Stop run" aria-keyshortcuts="x">${icon('stop')}<span class="control-label">Stop</span></button>
    </div>`;
  const percent = Math.min(100, b.used / Math.max(1, b.allowed) * 100);
  setHTML($('run-header'), `<header class="run-header">
    ${statusHTML(current, pending)}
    <div class="title-row"><h1 title="${esc(current.goal.split('\n')[0])}">${esc(runTitle(current))}</h1>${data.capabilities?.run_titles ? `<button class="text-button rename-button" data-action="rename" aria-label="Rename this run">Rename</button>` : ''}</div>
    <div class="run-meta"><span class="mono">${esc(data.project)}</span><span>${duration(b.used)} of ${duration(b.allowed)}</span>
      <span>${finished ? 'Used' : 'Prompt'} ${steps.length} of ${current.max_steps}</span><span>Started ${when(current.created)}</span></div>
    ${current.parent_run ? `<p class="small muted">Follow-up to <button class="text-button" data-run="${esc(current.parent_run)}">#${esc(current.parent_run.slice(0, 6))}</button></p>` : ''}
    <details class="brief" data-key="brief-${esc(current.id)}"><summary>Read brief</summary><p>${esc(current.goal)}</p></details>
    <div class="xp-only xp-time-meter" role="progressbar" aria-label="Run time budget used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(percent)}"><span style="width:${percent}%"></span></div>
    <div class="run-actions">${controls}${current.pause && current.status !== 'paused' ? '<span class="small warning-text">Pause requested at the next boundary</span>' : ''}</div>
    <p class="run-summary">${esc(current.summary)}</p>
  </header>`);
}
function renderOutcome(steps, finished) {
  const last = steps.at(-1), verified = last?.verification?.status === 'passed', files = fileStats(steps);
  const heading = current.status === 'completed' ? (verified ? 'Completed with a passing verification command' : 'Completed · review only') : stateLabel(current).text;
  setHTML($('outcome'), finished ? `<section class="outcome-banner ${current.status}"><h2>${esc(heading)}</h2><p class="small muted">${esc(current.summary)}</p>
    <div class="outcome-stats">
      <div><small>Verification</small><strong>${verified ? 'Passed' : last?.verification?.status === 'failed' ? 'Failed' : 'Review only'}</strong><small>${verified ? 'Actual command output recorded' : 'See verification details'}</small></div>
      <div><small>Prompts</small><strong>${steps.length} / ${current.max_steps}</strong><small>Budget used</small></div>
      <div><small>Files</small><strong>${files.length}</strong><small>Captured paths</small></div>
    </div></section>` : '');
}
function renderWorkflow(steps, pending, finished) {
  const next = planningNext(current, steps);
  const ids = steps.map(s => s.id);
  if (selectedTurn && selectedTurn !== 'next' && !ids.includes(selectedTurn)) selectedTurn = null;
  if (selectedTurn === 'next' && !next) selectedTurn = null;
  const turnId = selectedTurn || (next ? 'next' : ids.at(-1) || 'next');
  const step = steps.find(s => s.id === turnId);
  renderRail(steps, pending, next, turnId);
  const phase = phaseIndex(current, steps);
  $('stage-board').setAttribute('aria-label', `Workflow for ${step ? 'turn ' + step.number : 'the next turn'}; current phase ${['Plan', 'Prompt', 'Code', 'Verify', 'Complete'][phase]}`);
  const states = step ? stageStates(current, step, step.id === ids.at(-1), pending, false) : stageStates(current, null, true, pending, true);
  renderStages(step, states, steps.length + 1, pending, finished);
  renderTerminal(step, states.code, pending, steps.at(-1)?.id === step?.id);
}
function renderRail(steps, pending, next, turnId) {
  const chips = steps.map(s => {
    const isLast = s.id === steps.at(-1).id, waiting = isLast && pending.length && !ended.has(current.status);
    const result = waiting ? 'Waiting for you' : ['running', 'dispatching', 'prepared'].includes(s.status) && !ended.has(current.status) ? 'Coding…' : verificationLabel(s);
    const tone = waiting ? 'warning-text' : s.verification?.status === 'passed' ? 'success-text' : s.verification?.status === 'failed' || s.status === 'failed' ? 'error' : 'muted';
    const counts = stepCounts(s);
    return `<button class="turn-chip ${s.id === turnId ? 'selected' : ''}" data-turn="${esc(s.id)}" aria-pressed="${s.id === turnId}">
      <span class="chip-number">${s.number}</span>
      <span class="chip-text"><strong>${esc(s.title)}</strong><small>${isTeam() ? `<span class="agent-tag">${esc(agentName(s.agent))}</span> · ` : ''}<span class="${tone}">${esc(result)}</span>${counts ? ' · ' + counts : ''}</small></span>
    </button>`;
  });
  if (next) chips.push(`<button class="turn-chip planning ${turnId === 'next' ? 'selected' : ''}" data-turn="next" aria-pressed="${turnId === 'next'}">
    <span class="chip-number">${steps.length + 1}</span><span class="chip-text"><strong>Next turn</strong><small class="hermes-label">Hermes is planning…</small></span></button>`);
  setHTML($('turn-rail'), `<div class="rail-head"><h2 class="section-label">Turns</h2>${selectedTurn ? '<button class="text-button" data-turn="latest">Follow latest</button>' : '<span class="small muted">Following the latest turn</span>'}</div>
    <div class="rail-track" role="group" aria-label="Coding turns">${chips.join('')}</div>`);
  const chip = $('turn-rail').querySelector('.turn-chip.selected');
  if (chip && $('turn-rail').dataset.shown !== turnId) { chip.scrollIntoView?.({block: 'nearest', inline: 'nearest'}); $('turn-rail').dataset.shown = turnId; }
}
const STAGES = [['plan', 'Plan', 'Hermes'], ['prompt', 'Prompt', 'Hermes → OpenCode'], ['code', 'Code', 'OpenCode'], ['verify', 'Verify', 'AgentControl']];
function stageHead(name, label, who, state) {
  const mark = {done: '✓', active: '▶', waiting: '!', failed: '×', pending: '○'}[state];
  const note = {waiting: 'Waiting on you', active: 'In progress', failed: 'Failed'}[state] || '';
  return `<span class="stage-dot" aria-hidden="true">${mark}</span><span class="stage-name">${label}</span><small class="stage-who">${who}</small>${note ? `<small class="stage-note">${note}</small>` : ''}<span class="sr-only">: ${state}</span>`;
}
function renderStages(step, states, nextNumber, pending, finished) {
  for (const [name, label, who] of STAGES) {
    const section = $('stage-' + name);
    section.className = `stage stage-${name} ${states[name]}`;
    const by = name === 'code' && step && isTeam() ? `${who} · ${agentName(step.agent)}` : who;
    setHTML($(`stage-${name}-head`), stageHead(name, label, by, states[name]));
    const tab = document.querySelector(`[data-stage-tab="${name}"]`);
    tab.className = `stage-tab ${states[name]}`;
  }
  setHTML($('stage-plan-body'), planBody(step, nextNumber));
  setHTML($('stage-prompt-body'), promptBody(step));
  setHTML($('stage-verify-body'), verifyBody(step, states.verify, finished));
  // On phones the board is a carousel: bring the stage that needs attention into view once.
  const focus = ['waiting', 'active'].map(s => STAGES.find(([n]) => states[n] === s)?.[0]).find(Boolean) || (states.verify === 'pending' ? 'code' : 'verify');
  const signature = (step?.id || 'next') + ':' + focus;
  if (shownStage !== signature) { shownStage = signature; showStage(focus, false); }
}
function planBody(step, nextNumber) {
  if (!step) {
    const plan = (current.plan || []).map(item => `<li>${esc(item)}</li>`).join('');
    const notes = (current.instructions || []).slice(-3).map(i => `<li>${esc(i.text)}</li>`).join('');
    return `<p class="small"><strong>Turn ${nextNumber}.</strong> ${esc(current.summary || 'Hermes is choosing the next coding prompt.')}</p>
      ${plan ? `<h4>Plan</h4><ol class="stage-list">${plan}</ol>` : ''}${notes ? `<h4>Your recent notes</h4><ul class="stage-list">${notes}</ul>` : ''}
      <p class="small muted">Hermes reviews the evidence and your notes, then writes the next prompt.</p>`;
  }
  const plan = (step.plan || []).map(item => `<li>${esc(item)}</li>`).join('');
  const notes = (step.instructions_seen || []).map(text => `<li>${esc(text)}</li>`).join('');
  return `<p class="stage-title"><strong>${esc(step.title)}</strong>${step.kind === 'correction' ? ' <span class="ac-status attention">correction</span>' : ''}</p>
    <p class="small">${esc(step.plan_summary || 'The planning summary for this turn was not recorded.')}</p>
    ${plan ? `<h4>Plan</h4><ol class="stage-list">${plan}</ol>` : ''}${notes ? `<h4>Notes it used</h4><ul class="stage-list">${notes}</ul>` : ''}
    <p class="small muted">${when(step.created)}</p>`;
}
function promptBody(step) {
  if (!step) return '<p class="small muted">The exact prompt appears here before it is sent to OpenCode.</p>';
  const brief = step.manager_prompt || step.prompt;
  return `<div class="message-content hermes-message stage-prompt">${esc(brief)}</div>
    ${step.manager_prompt ? details('Exact text sent, with workflow constraints', step.prompt, 'prompt-' + step.id) : ''}
    <p class="small muted">${step.status === 'prepared' ? 'Prepared; not sent yet.' : 'Sent to the managed OpenCode session.'}</p>`;
}
function verifyBody(step, state, finished) {
  if (!step) return '<p class="small muted">Runs after the next coding turn.</p>';
  const v = step.verification;
  const verdict = step.hermes_verdict ? `<p class="small"><strong class="hermes-label">Hermes’s review:</strong> ${esc(step.hermes_verdict.summary)} <span class="muted">(proposed ${esc(step.hermes_verdict.action)})</span></p>` : '';
  const files = step.evidence ? `<p class="small">${plural(step.evidence.changed_files?.length || 0, 'captured file')} ${stepCounts(step)} <button class="text-button" data-diff="${esc(step.id)}">View diff</button></p>` : '';
  if (!v) {
    const text = state === 'active' ? 'Collecting file changes and running your verification command…'
      : !current.verifier.length ? 'Review only. No independent verification command is configured.'
      : finished ? 'This turn did not reach verification.' : 'Your command runs after OpenCode finishes this turn.';
    return `<p class="small muted">${text}</p>${files}${verdict}`;
  }
  const output = v.output || 'No output.';
  const tail = output.split('\n').slice(-8).join('\n');
  return `<span class="ac-status ${v.status === 'passed' ? 'completed' : v.status === 'failed' ? 'failed' : ''}">${esc(v.status)}</span>
    ${v.argv ? `<pre class="stage-command">$ ${esc(v.argv.join(' '))}</pre>` : ''}
    <pre class="stage-output">${esc(tail)}</pre>
    ${output.split('\n').length > 8 ? details('Full output', output, 'verify-' + step.id) : ''}${files}${verdict}`;
}
function showStage(name, smooth = true) {
  document.querySelectorAll('[data-stage-tab]').forEach(t => t.setAttribute('aria-selected', String(t.dataset.stageTab === name)));
  const track = $('stage-track'), stage = $('stage-' + name);
  // Only the phone carousel scrolls horizontally; wider layouts show every stage.
  if (track && stage && track.scrollWidth > track.clientWidth + 4) track.scrollTo?.({left: stage.offsetLeft - track.offsetLeft, behavior: smooth ? 'smooth' : 'auto'});
}

// ---------------------------------------------------------------------------
// Live OpenCode terminal (incremental, so scrolling and open outputs survive polls)
// ---------------------------------------------------------------------------
function termEntryHTML(entry, running) {
  if (entry.type === 'text') return `<div class="term-line term-text">${esc(entry.text)}</div>`;
  const tool = entry.tool || 'tool', symbol = TOOL_SYMBOL[tool] || '•';
  const label = tool === 'bash' ? entry.summary || entry.title : `${tool} ${entry.summary || entry.title || ''}`;
  const status = entry.status && entry.status !== 'completed' ? `<span class="term-status ${esc(entry.status)}">${esc(entry.status)}</span>` : '';
  const lines = entry.output ? entry.output.split('\n').length : 0;
  const output = entry.output ? `<details class="term-output" data-open-key="${esc(entry.id || '')}" ${running && entry.status === 'running' ? 'open' : ''}><summary>output · ${plural(lines, 'line')}</summary><pre>${esc(entry.output)}</pre></details>` : '';
  return `<div class="term-line term-tool ${esc(entry.status || '')}"><span class="term-prompt">${esc(symbol)}</span><span class="term-cmd">${esc(label)}</span>${status}</div>${output}`;
}
function termReset(turn) {
  term.turn = turn; term.count = 0; term.omitted = 0; term.last = '';
  $('term-body').innerHTML = '';
}
function renderTerminal(step, state, pending, isLast) {
  const running = ['active', 'waiting'].includes(state);
  const entries = transcriptOf(step);
  const omitted = step?.transcript_omitted || 0;
  if (term.turn !== (step?.id || 'next') || entries.length < term.count || omitted !== term.omitted) termReset(step?.id || 'next');
  term.omitted = omitted;
  const body = $('term-body'), atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
  let changed = false;
  entries.forEach((entry, i) => {
    const html = termEntryHTML(entry, running);
    if (i < term.count - 1) return;
    if (i === term.count - 1) {
      if (html === term.last) return;
      // Replace the last entry in place; it is the one that grows while OpenCode works.
      const wasOpen = body.lastElementChild?.querySelector?.('details')?.open || body.lastElementChild?.open;
      body.querySelectorAll(`[data-entry="${i}"]`).forEach(e => e.remove());
      body.insertAdjacentHTML('beforeend', `<div class="term-entry" data-entry="${i}">${html}</div>`);
      if (wasOpen) body.lastElementChild.querySelector('details')?.setAttribute('open', '');
    } else body.insertAdjacentHTML('beforeend', `<div class="term-entry" data-entry="${i}">${html}</div>`);
    term.last = html; changed = true;
  });
  term.count = entries.length;
  const held = isLast && running ? pending.map(p => `<div class="term-line term-held"><span class="term-prompt">!</span><span class="term-cmd">${esc(requestText(p))}</span><button class="term-review" data-review="${esc(requestKey(p))}">Review</button></div>`).join('') : '';
  setHTML($('term-held'), held);
  const empty = !entries.length && !held;
  $('term-empty').textContent = !step ? 'OpenCode output appears here once Hermes sends the next prompt.' : ['prepared', 'dispatching'].includes(step.status) ? 'Sending the prompt to OpenCode…' : 'No OpenCode output was recorded for this turn.';
  $('term-empty').classList.toggle('hidden', !empty);
  const box = $('term');
  box.classList.toggle('running', running);
  box.dataset.state = state;
  const tools = entries.filter(e => e.type === 'tool').length;
  const end = step?.ended ? Date.parse(step.ended) : Date.now();
  const elapsed = step ? duration((end - Date.parse(step.created)) / 1000) : '—';
  $('term-title').textContent = step ? `opencode — turn ${step.number}` : 'opencode — waiting';
  $('term-meta').textContent = `${state === 'waiting' ? 'waiting on you' : running ? 'running' : state === 'failed' ? 'failed' : step ? 'idle' : 'queued'} · ${elapsed} · ${plural(tools, 'tool call')}${omitted ? ` · ${omitted} earlier hidden` : ''}`;
  if (changed || held) {
    if (term.follow || atBottom) body.scrollTop = body.scrollHeight;
    else $('term-jump').classList.remove('hidden');
  }
}
function terminalText() {
  const step = data?.steps?.find(s => s.id === term.turn);
  return transcriptOf(step).map(e => e.type === 'text' ? e.text : `${TOOL_SYMBOL[e.tool] || '•'} ${e.tool === 'bash' ? '' : e.tool + ' '}${e.summary || ''}${e.output ? '\n' + e.output : ''}`).join('\n');
}
function setFollow(on) {
  term.follow = on;
  $('term-follow').setAttribute('aria-pressed', String(on));
  if (on) { const body = $('term-body'); body.scrollTop = body.scrollHeight; $('term-jump').classList.add('hidden'); }
}
function expandTerminal(open) {
  const box = $('term');
  if (open) { $('terminal-dialog-body').append(box); $('terminal-dialog').showModal(); }
  else $('term-home').append(box);
  $('term-expand').setAttribute('aria-label', open ? 'Close full screen' : 'Open terminal full screen');
  setFollow(term.follow);
}

// ---------------------------------------------------------------------------
// Rendering: side panels, approvals, activity
// ---------------------------------------------------------------------------
function renderChecks() {
  const checks = current.goal_checks || [], passed = checks.filter(c => c.status === 'passed').length;
  const list = checks.map(c => `<div class="check-row ${esc(c.status)}"><span class="check-symbol">${c.status === 'passed' ? '✓' : c.status === 'failed' ? '×' : '○'}</span><span><span class="sr-only">${esc(c.status)}: </span>${esc(c.criterion)}${c.evidence ? '<small>' + esc(pretty(c.evidence)) + '</small>' : ''}</span></div>`).join('');
  setHTML($('goal-checks'), `<section class="ac-panel"><h2 class="ac-panel__title">Goal checks ${checks.length ? `<span class="check-ring mac-only" aria-hidden="true" style="--check-progress:${passed / checks.length * 100}%"></span><span class="muted">· ${passed} of ${checks.length} verified</span>` : ''}</h2>
    ${checks.length ? `<div class="check-progress" aria-label="${passed} of ${checks.length} checks verified">${checks.map(c => `<span class="${['passed', 'failed'].includes(c.status) ? c.status : ''}"></span>`).join('')}</div>
      <div class="terminal-only block-progress" aria-label="${passed} of ${checks.length} verified">${checks.map(c => `<span class="${c.status === 'passed' ? 'success-text' : c.status === 'failed' ? 'error' : 'muted'}">${c.status === 'pending' ? '░░' : '██'}</span>`).join('')}</div>
      ${list}<p class="small muted">Individual verification evidence is not supplied yet. These are saved requirements.</p>`
    : '<p class="small muted">No separate goal checks were recorded for this run. The brief remains the source of requirements.</p>'}</section>`);
}
function canVerifyNow(run = current) {
  return !!run?.verifier?.length && (ended.has(run.status) || ['paused', 'interrupted', 'attention'].includes(run.status)) && run.manual_verification?.status !== 'running';
}
function renderVerification() {
  const step = [...data.steps].reverse().find(s => s.verification), v = step?.verification, m = current.manual_verification;
  const pill = status => `<span class="ac-status ${status === 'passed' ? 'completed' : status === 'failed' ? 'failed' : status === 'running' ? 'running' : ''}">${esc(status)}</span>`;
  const latest = v ? `${pill(v.status)}<p class="small muted">Turn ${step.number} · ${v.status === 'not configured' ? 'No independent command configured.' : 'Command executed by AgentControl.'}</p>${details('Command and output', (v.argv ? v.argv.join(' ') + '\n\n' : '') + (v.output || 'No output.'), 'latest-verification')}`
    : `<p class="small muted">${current.verifier.length ? 'Your command runs after the coding turn finishes.' : 'Review only. No independent verification command was configured.'}</p>`;
  const manual = m ? `<h3 class="small">On demand · ${when(m.created)}</h3>${pill(m.status)}${m.status === 'running' ? '<p class="small muted">Running your saved command…</p>' : details('Command and output', (m.argv ? m.argv.join(' ') + '\n\n' : '') + (m.output || 'No output.'), 'manual-verification')}` : '';
  const button = data.capabilities?.verify_now && current.verifier.length
    ? `<button class="ac-btn compact" data-action="verify-now" ${canVerifyNow() ? '' : 'disabled'} aria-keyshortcuts="v">Verify now</button>${canVerifyNow() || m?.status === 'running' ? '' : '<p class="small muted">Pause the run to verify on demand, so the check cannot overlap a coding turn.</p>'}` : '';
  setHTML($('verification'), `<section class="ac-panel"><h2 class="ac-panel__title">Independent verification</h2>${latest}${manual}${button}</section>`);
}
function tokens(n) { return n >= 10000 ? Math.round(n / 1000) + 'k' : String(n || 0); }
function renderModelUsage() {
  const usage = data.usage, models = data.models || {}, endpoint = (models.endpoints || []).find(e => e.default);
  if (!usage?.total?.calls && !endpoint) { setHTML($('model-usage'), ''); return; }
  const queue = endpoint ? `<p class="small muted">${esc(endpoint.id)} · ${endpoint.in_flight.length} of ${endpoint.slots} busy${endpoint.queued.length ? ` · ${endpoint.queued.length} waiting (${esc(endpoint.queued.map(q => q.agent).join(', '))})` : ''}${models.gateway ? ' · gateway on' : ''}</p>` : '';
  const agents = Object.entries(usage?.by_agent || {}).map(([name, u]) => `<div class="usage-row"><span>${esc(name)}</span><span class="mono small">${u.calls} call${u.calls === 1 ? '' : 's'} · ${tokens(u.tokens_in)} in · ${tokens(u.tokens_out)} out${u.queued_ms ? ` · waited ${Math.round(u.queued_ms / 1000)} s` : ''}</span></div>`).join('');
  const total = usage?.total || {calls: 0, cost: 0};
  setHTML($('model-usage'), `<section class="ac-panel"><h2 class="ac-panel__title">Model usage</h2>${queue}
    ${agents || '<p class="small muted">Token counts appear after Hermes or OpenCode finish a call.</p>'}
    <p class="small muted">${total.cost > 0 ? `Spend on paid providers: $${total.cost.toFixed(4)}` : 'Local model · no spend'}</p></section>`);
}
function isTeam(run = current) { return run?.mode === 'team'; }
function agentName(name = 'coder-1') {
  const label = current?.team?.agents?.[name]?.label;
  return label ? `${name} (${label})` : name;
}
const TASK_TONE = {done: 'success-text', running: 'warning-text', failed: 'error', blocked: 'error', waiting: 'muted'};
function taskRows(tasks, withStatus) {
  return tasks.map(t => `<tr>
    <td class="mono">${withStatus && t.steps?.length ? `<button class="text-button mono" data-turn="${esc(t.steps.at(-1))}" aria-label="Show the latest turn of task ${esc(t.id)}">${esc(t.id)}</button>` : esc(t.id)}</td><td>${esc(t.title)}${t.reason && withStatus ? `<small class="muted">${esc(t.reason)}</small>` : ''}</td>
    <td>${esc(agentName(t.agent))}</td><td class="small">${t.depends_on?.length ? esc(t.depends_on.join(', ')) : '—'}</td>
    ${withStatus ? `<td class="${TASK_TONE[t.status] || ''}">${esc(t.status)}${t.attempts > 1 ? ` · ${t.attempts} tries` : ''}</td>` : `<td class="small mono">${esc((t.files || []).join(', ') || '—')}</td>`}</tr>`).join('');
}
function renderTeam() {
  const team = current.team;
  if (!isTeam() || !team) {
    setHTML($('team-panel'), current.auto && !ended.has(current.status) ? `<section class="ac-panel team-panel">${autoNote()}</section>` : '');
    return;
  }
  const finished = ended.has(current.status);
  if (team.state === 'proposing') {
    setHTML($('team-panel'), finished ? '' : `<section class="ac-panel team-panel"><h2 class="ac-panel__title">Team plan</h2>${autoNote()}<p class="small muted">Hermes is proposing a team. Nothing runs until you approve it.</p></section>`);
    return;
  }
  if (['proposed', 'unusable'].includes(team.state) && !finished) {
    const p = team.proposal, usable = team.state === 'proposed';
    const agents = usable ? Object.entries(p.agents).map(([name, a]) => `<li><strong>${esc(name)}</strong> <span class="muted">(${esc(a.label)})</span> · ${esc(a.responsibility)}</li>`).join('') : '';
    const left = 3 - (team.proposals || 0);
    setHTML($('team-panel'), `<section class="ac-panel team-panel proposal" aria-live="polite"><h2 class="ac-panel__title">Team plan <span class="ac-status attention">needs your decision</span></h2>${autoNote()}
      ${usable ? `<p class="small">${esc(p.reason || '')}</p><h3 class="small">Agents</h3><ul class="small team-agents">${agents}</ul>
        <h3 class="small">Tasks</h3><div class="table-wrap"><table class="team-table"><thead><tr><th>Task</th><th>What</th><th>Agent</th><th>After</th><th>Files</th></tr></thead><tbody>${taskRows(p.tasks, false)}</tbody></table></div>
        ${(team.warnings || []).map(w => `<p class="small warning-text">⚠ ${esc(w)}</p>`).join('')}
        <p class="small muted">Each agent works in its own worktree; finished tasks are merged and verified. Every agent's approvals still come to you.</p>`
      : `<p class="small error">Hermes could not produce a usable team plan:</p><ul class="small">${(team.problems || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul>`}
      <div class="row wrap team-actions">
        <button class="ac-btn primary" data-action="approve-team" ${usable && connected ? '' : 'disabled'}>Approve plan</button>
        <button class="ac-btn" data-action="single-agent" ${connected ? '' : 'disabled'}>Run as a single agent</button>
      </div>
      <label for="team-note" class="small">Ask for a different plan <span class="muted">· ${left > 0 ? `${left} left` : 'none left'}</span></label>
      <textarea id="team-note" rows="2" maxlength="2000" placeholder="e.g. Use two agents and keep the tests with the API" ${left > 0 ? '' : 'disabled'}></textarea>
      <button class="ac-btn compact" data-action="repropose" ${left > 0 && connected ? '' : 'disabled'}>Ask again</button>
      <p id="team-error" class="error small" role="alert"></p></section>`);
    return;
  }
  if (team.state === 'single') {
    setHTML($('team-panel'), `<section class="ac-panel team-panel"><h2 class="ac-panel__title">Team plan</h2>${current.auto ? autoNote() : '<p class="small muted">Running with one agent, as chosen.</p>'}</section>`);
    return;
  }
  const tasks = team.tasks || [], done = tasks.filter(t => t.status === 'done').length;
  const states = Object.fromEntries((data.agents || []).map(a => [a.name, a]));
  const agents = Object.keys(team.agents || {}).map(name => {
    const a = states[name] || {};
    const tone = a.state === 'working' ? 'running' : a.state === 'waiting_on_you' ? 'attention' : '';
    return `<li><span class="ac-status ${tone}">${esc((a.state || 'idle').replaceAll('_', ' '))}</span> <strong>${esc(agentName(name))}</strong>${a.task ? ` · <span class="small">${esc(a.task)}</span>` : ''}</li>`;
  }).join('');
  setHTML($('team-panel'), `<section class="ac-panel team-panel"><h2 class="ac-panel__title">Team <span class="muted small">· ${done} of ${tasks.length} tasks done${team.state === 'review' ? ' · Hermes reviews the merged result' : ''}</span></h2>
    <ul class="team-agents live">${agents}</ul>
    <div class="table-wrap"><table class="team-table"><thead><tr><th>Task</th><th>What</th><th>Agent</th><th>After</th><th>Status</th></tr></thead><tbody>${taskRows(tasks, true)}</tbody></table></div>
    <p class="small muted">Select a task to follow its latest turn.</p></section>`);
}
// ---- skills (M9) ----------------------------------------------------------
const SKILL_WAITING = ['proposed', 'awaiting_fetch'];
function pendingSkills() { return (data?.skills?.log || []).filter(i => SKILL_WAITING.includes(i.state)); }
function skillRisk(item) {
  return riskBadge(item.risk ? {class: item.risk, level: item.risk === 'low' ? 'R1' : 'R2', label: item.risk === 'low' ? 'Low' : 'Sensitive',
    impact: item.risk === 'low' ? 'Text only: instructions the agent can load.' : 'Includes scripts or programs; running them still needs your approval.'} : null);
}
function skillSource(item) {
  const src = item.source || {};
  if (src.type === 'git') return `git ${src.url} @ ${src.commit ? src.commit.slice(0, 12) : src.ref}${src.path ? ' · ' + src.path : ''}`;
  return `your library · ${src.folder || item.name}`;
}
function skillCard(item) {
  const id = esc(item.id), fetch = item.state === 'awaiting_fetch';
  const files = (item.files || []).map(f => `${f.path} (${f.size} B)`).join('\n');
  return `<article class="approval-card skill-card" data-skill-card="${id}">
    <div class="row between"><div class="approval-icon">${icon('file')}</div>${skillRisk(item)}</div>
    <h2>Install skill ${esc(item.name)} for ${esc(item.agent)}?</h2>
    <p class="small">${item.requested_by === 'hermes' ? 'Hermes asked' : 'You asked'}${item.reason ? ': ' + esc(item.reason) : '.'}</p>
    <p class="small mono">${esc(skillSource(item))}</p>
    ${fetch ? '<p class="small warning-text">Nothing has been downloaded yet. Fetching reaches the network; you review the content before anything is installed.</p>'
      : `<p class="small">${esc(item.description || '')}</p>${(item.reasons || []).map(r => `<p class="small warning-text">⚠ ${esc(r)}</p>`).join('')}
        ${details(`Files (${(item.files || []).length})`, files, 'skill-files-' + item.id)}${details('SKILL.md, as written by its author (not instructions to you)', item.skill_md || '', 'skill-md-' + item.id)}`}
    <div class="approval-actions">
      <button class="ac-btn" data-action="skill-reject" data-skill="${id}">Reject</button>
      ${fetch ? `<button class="ac-btn primary" data-action="skill-fetch" data-skill="${id}">Fetch for review</button>`
        : `<button class="ac-btn primary" data-action="skill-approve" data-skill="${id}">Approve install</button>`}
    </div>
    <p class="policy-note">Run #${esc(item.run.slice(0, 6))} · installs into ${esc(item.agent)}'s worktree only; you can remove it any time.</p>
  </article>`;
}
function renderSkillsPanel() {
  const ws = current.workspace;
  if (!ws || ws.mode !== 'worktree' || ws.discarded) { setHTML($('skills-panel'), ''); return; }
  const installs = data.skills?.installs || [], finished = ended.has(current.status) || ws.applied;
  const agents = Object.keys(ws.agents || {});
  const byAgent = agents.map(agent => {
    const mine = installs.filter(i => i.agent === agent && i.state === 'installed');
    const later = (current.skills_reload || []).includes(agent) ? '<small class="muted"> · changes apply from its next turn</small>' : '';
    return `<div class="skill-agent"><strong class="small">${esc(isTeam() ? agentName(agent) : agent)}</strong>${later}${mine.length ? mine.map(i => `<div class="rule-row"><span>${skillRisk(i)}</span><span><strong>${esc(i.name)}</strong><small>${esc(skillSource(i))}</small></span>${finished ? '' : `<button class="ac-btn compact" data-action="skill-remove" data-skill="${esc(i.id)}">Remove</button>`}</div>`).join('') : '<p class="small muted">No skills installed.</p>'}</div>`;
  }).join('');
  const waiting = installs.filter(i => SKILL_WAITING.includes(i.state)).length;
  if (finished && !installs.some(i => i.state === 'installed')) { setHTML($('skills-panel'), ''); return; }
  const library = (data.skills?.library || []).filter(e => !e.error);
  const agentSelect = id => agents.length > 1 ? `<label for="${id}" class="sr-only">Agent</label><select id="${id}">${agents.map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join('')}</select>` : '';
  const add = finished ? '' : `<div class="skill-add">
      ${library.length ? `<label for="skill-pick" class="small">Add a skill from your library</label><div class="row wrap"><select id="skill-pick">${library.map(e => `<option value="${esc(e.name)}">${esc(e.name)}${e.trusted ? ' · reviewed' : ' · needs review'}</option>`).join('')}</select>${agentSelect('skill-agent')}<button class="ac-btn compact" data-action="skill-add">Add</button></div>`
        : `<p class="small muted">Your library (${esc(data.skills?.library_path || '')}) has no skills yet. Each skill is a folder with a SKILL.md.</p>`}
      <details><summary class="small">Add from a git repository</summary><div class="skill-git">
        <label for="skill-url" class="small">Repository URL or path</label><input id="skill-url" placeholder="https://github.com/org/skills.git">
        <label for="skill-ref" class="small">Branch, tag or commit</label><input id="skill-ref" placeholder="main">
        <label for="skill-path" class="small">Folder in the repository <span class="muted">· optional</span></label><input id="skill-path" placeholder="skills/pdf">
        ${agentSelect('skill-git-agent')}<button class="ac-btn compact" data-action="skill-add-git">Fetch for review</button></div></details>
      <p id="skill-error" class="error small" role="alert"></p></div>`;
  setHTML($('skills-panel'), `<section class="ac-panel"><h2 class="ac-panel__title">Skills</h2>${byAgent}
    ${waiting ? `<p class="small warning-text">${plural(waiting, 'skill')} waiting for your review in <button class="text-button" data-view="approvals">Approvals</button>.</p>` : ''}${add}</section>`);
}
function renderSkillsView() {
  const s = data.skills || {library: [], log: []};
  const rows = s.library.map(e => `<tr><td><strong>${esc(e.name)}</strong>${e.error ? '' : `<small class="muted">${esc(e.description || '')}</small>`}</td>
    <td>${e.error ? `<span class="error small">${esc(e.error)}</span>` : skillRisk(e)}</td>
    <td class="small">${e.error ? '—' : `${(e.files || []).length} files`}</td><td class="small ${e.trusted ? 'success-text' : 'muted'}">${e.error ? '' : e.trusted ? 'reviewed' : 'not reviewed yet'}</td></tr>`).join('');
  setHTML($('skills-library'), `<section class="ac-panel"><h2 class="ac-panel__title">Your library <span class="muted small">· ${esc(s.library_path || '')}</span></h2>
    ${rows ? `<div class="table-wrap"><table class="team-table"><thead><tr><th>Skill</th><th>Risk</th><th>Files</th><th>Trust</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<p class="small muted">No skills yet. Add folders that each contain a SKILL.md with a name and description.</p>'}
    <p class="small muted">"Reviewed" means you approved this exact version once; a changed skill is reviewed again. Add skills to an agent from the run page.</p></section>`);
  const log = (s.log || []).map(i => `<tr><td class="small">${when(i.updated || i.created)}</td><td><strong>${esc(i.name)}</strong></td><td class="small">${esc(i.agent)} · #${esc(i.run.slice(0, 6))}</td>
    <td class="small">${esc(i.state.replace('_', ' '))}${i.reason && ['removed', 'rejected'].includes(i.state) ? ` <span class="muted">(${esc(i.reason)})</span>` : ''}</td><td class="small mono">${esc(skillSource(i))}</td></tr>`).join('');
  setHTML($('skills-log'), `<section class="ac-panel"><h2 class="ac-panel__title">Installs and removals</h2>
    ${log ? `<div class="table-wrap"><table class="team-table"><thead><tr><th>When</th><th>Skill</th><th>Agent</th><th>State</th><th>Source</th></tr></thead><tbody>${log}</tbody></table></div>` : '<p class="small muted">Nothing installed yet.</p>'}</section>`);
}
async function skillCall(path, body, done) {
  try { await api(path, 'POST', body); if (done) toast(done); await refresh(); }
  catch (error) { if ($('skill-error')) $('skill-error').textContent = error.message; else toast(error.message); }
}
function renderBranch() {
  const w = data.workspace, ws = current.workspace;
  if (!w || !ws || ws.mode !== 'worktree') { setHTML($('branch-panel'), ''); return; }
  const title = '<h2 class="ac-panel__title">Branch</h2>';
  if (w.state === 'discarded') { setHTML($('branch-panel'), `<section class="ac-panel">${title}<p class="small muted">The run branch was discarded.</p></section>`); return; }
  if (w.state === 'error') { setHTML($('branch-panel'), `<section class="ac-panel">${title}<p class="small error">${esc(w.error)}</p></section>`); return; }
  const branch = ws.integration.branch, base = ws.base_branch, li = w.last_integration;
  let html = `<p class="mono small branch-name">${esc(branch)}</p>
    <p class="small muted">From ${esc(base)} · ${plural(w.commits || 0, 'commit')}${w.shortstat ? ' · ' + esc(w.shortstat) : ''}</p>`;
  if (li && ['conflict', 'unresolved'].includes(li.status))
    html += `<p class="small error">${li.status === 'conflict' ? 'Last turn conflicts with the integration branch' : 'Conflict markers remain'}: ${esc(li.files.join(', '))}. Hermes has been told.</p>`;
  if (w.state === 'applied') {
    html += `<p class="small success-text">Applied to ${esc(base)} (${esc(ws.applied.commit.slice(0, 10))}).</p>`;
  } else if (ended.has(current.status)) {
    const blocked = w.apply_blocked;
    html += `<div class="row wrap branch-actions"><button class="ac-btn primary compact" data-action="apply-branch" ${blocked || !connected ? 'disabled' : ''}>Apply to ${esc(base)}</button><button class="ac-btn compact" data-action="discard-branch" ${connected ? '' : 'disabled'}>Discard branch</button></div>
      ${blocked ? `<p class="small warning-text">Apply is unavailable: ${esc(blocked)}.</p>` : `<p class="small muted">Apply merges the branch into ${esc(base)} with a merge commit.</p>`}`;
  } else {
    html += '<p class="small muted">Your checkout is untouched. Apply becomes available when the run finishes.</p>';
  }
  if (w.state !== 'applied')
    html += details('Inspect it yourself', `git log --oneline ${base}..${branch}\ngit diff ${base}...${branch}\ngit merge --no-ff ${branch}`, 'branch-commands');
  setHTML($('branch-panel'), `<section class="ac-panel">${title}${html}</section>`);
}
let confirming = null;
function askConfirm(title, body, label, danger, run) {
  confirming = run;
  $('confirm-title').textContent = title;
  $('confirm-body').innerHTML = body;
  $('confirm-error').textContent = '';
  $('confirm-go').textContent = label;
  $('confirm-go').className = 'ac-btn ' + (danger ? 'danger-button' : 'primary');
  $('confirm-go').disabled = false;
  $('confirm-dialog').showModal();
}
function renderFiles(files) {
  const rows = files.map(f => `<div class="file-row">${icon('file')}<span class="file-path">${esc(f.path)}</span><span class="file-change">${esc(f.change)}</span>${f.added !== null ? `<span class="file-counts"><span class="added">+${f.added}</span><span class="removed">−${f.removed}${f.partial ? '*' : ''}</span></span>` : ''}</div>`).join('');
  setHTML($('changed-files'), `<section class="ac-panel"><h2 class="ac-panel__title"><span class="not-terminal">Changed files</span><span class="terminal-only">diff --stat · captured</span></h2>
    ${rows || '<p class="small muted">File changes appear after a coding turn finishes.</p>'}${files.length ? '<button class="text-button" data-action="diff">View recorded diffs</button>' : ''}
    <p class="small muted">Counts cover captured text across turns; repeated edits can be counted again. Excluded files are not audited.</p></section>`);
}
function renderTimeline() {
  if (!ended.has(current.status)) { setHTML($('run-timeline'), ''); return; }
  const steps = data.steps, verified = steps.filter(s => s.verified).length;
  const item = (avatar, cls, title, text) => `<div class="timeline-item"><span class="agent-avatar ${cls}">${avatar}</span><div><strong class="small">${title}</strong><p class="muted">${text}</p></div></div>`;
  setHTML($('run-timeline'), `<section class="ac-panel"><h2 class="ac-panel__title">How the run went</h2>
    ${item('H', 'hermes', 'Hermes planned', `${plural(current.decision_count || 0, 'recorded planning decision')}.`)}
    ${item('O', 'opencode', 'OpenCode worked', `${plural(steps.length, 'coding prompt')} submitted in the managed session.`)}
    ${item('✓', 'hermes', 'Evidence collected', `${plural(verified, 'turn')} reached file comparison and verification review.`)}
    <button class="text-button" data-view="activity">Open the full recorded activity</button></section>`);
}
function approvalCard(p) {
  const receipt = p.receipt, question = p.kind === 'question', id = esc(requestKey(p));
  const actions = question ? `<button class="ac-btn primary" data-review="${id}" data-intent="answer">${receipt ? 'View decision' : 'Answer question'}</button>`
    : receipt ? `<button class="ac-btn" data-review="${id}">View decision</button>`
    : `<button class="ac-btn" data-review="${id}" data-intent="reject" aria-keyshortcuts="d">Deny and redirect</button><button class="ac-btn primary" data-review="${id}" data-intent="approve" aria-keyshortcuts="a">Approve once</button>`;
  return `<article class="approval-card" tabindex="-1" data-approval-card="${id}">
    <div class="approval-titlebar">${question ? 'Question from OpenCode' : 'Approval needed'}</div>
    <div class="row between"><div class="approval-icon">${icon('shield')}</div>${riskBadge(p.risk)}</div>
    <h2>${esc(requestTitle(p))}</h2><pre class="command">${esc(requestText(p))}</pre>
    <p class="approval-note muted">${receipt ? esc(receiptLabel(receipt)) : 'Hermes has not provided a recommendation for this request.'}</p>
    ${receipt?.redirect_saved ? '<p class="small muted">Your redirection is saved for the next Hermes prompt.</p>' : ''}
    <div class="approval-actions">${actions}</div>
    <button class="text-button" data-review="${id}">Inspect full request</button>
    <p class="policy-note">Run #${esc(p.run.slice(0, 6))}${p.agent ? ' · ' + esc(p.agent) : ''} · ${question ? 'Clarification' : 'Permission: ' + esc(p.permission || 'unspecified')}<br>${riskNote(p.risk)}</p>
  </article>`;
}
// Risk comes from AgentControl's own registry (permissions.py), never from the model.
function riskBadge(risk) {
  if (!risk) return '';
  return `<span class="risk-badge risk-${esc(risk.class)}" title="${esc(risk.impact)}">${esc(risk.level)} · ${esc(risk.label)}</span>`;
}
function riskNote(risk) {
  if (!risk) return 'Risk class not recorded for this request.';
  return esc(risk.impact) + (risk.reasons?.length ? ` <strong class="error">Critical: ${esc(risk.reasons.join('; '))}.</strong>` : '');
}
function riskHTML(p) {
  const risk = p.risk;
  if (!risk) return '';
  const done = p.receipt && p.receipt.state !== 'failed', word = data.permissions?.confirm_word || 'approve';
  let html = `<section class="request-section risk-section risk-${esc(risk.class)}"><h3>Risk ${riskBadge(risk)}</h3><p class="small">${esc(risk.impact)}</p>`;
  if (risk.reasons?.length) html += `<ul class="small risk-reasons">${risk.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>`;
  if (p.kind === 'permission' && !done && risk.decision === 'confirm')
    html += `<label for="confirm-word">Type <strong>${esc(word)}</strong> to approve this critical request</label><input id="confirm-word" autocomplete="off" spellcheck="false" data-confirm-word="${esc(word)}">`;
  if (p.kind === 'permission' && !done && risk.remember_allowed)
    html += `<label class="choice"><input type="checkbox" id="remember-rule"><span><strong>Approve identical requests for the rest of this run</strong><small>Only this exact ${esc(risk.permission)} request. You can revoke it under Approvals. Critical requests are always asked.</small></span></label>`;
  return html + '</section>';
}
function rulesHTML() {
  const rules = (current?.grants || []).filter(g => !g.revoked);
  if (!rules.length) return '<p class="small muted">No remembered approvals. Every request is asked.</p>';
  return rules.map(g => `<div class="rule-row">${riskBadge({class: g.class, level: g.level, label: data.permissions?.labels?.[g.class] || g.class, impact: ''})}<span><strong>${esc(g.permission)}</strong><small class="mono">${esc(g.match || '(no command or path)')}</small></span><button class="ac-btn compact" data-action="revoke-rule" data-rule="${esc(g.id)}">Revoke</button></div>`).join('');
}
function auditHTML() {
  const entries = data.audit || [], chain = data.audit_chain;
  const status = chain ? (chain.intact ? '<p class="small success-text">Audit chain intact. Each entry carries the hash of the one before it.</p>'
    : `<p class="small error">Audit chain broken at entry ${esc(String(chain.broken_at))}. An entry was edited or removed outside AgentControl.</p>`) : '';
  const rows = entries.slice().reverse().map(e => `<div class="audit-row"><span class="mono small">${esc(e.risk || '')}</span><span><strong>${esc(e.action)}</strong> · ${esc(e.permission || e.kind || '')}<small>${esc(e.actor || '')}${e.target ? ' · ' + esc(e.target.slice(0, 160)) : ''}${e.reason ? ' · ' + esc(e.reason) : ''}</small></span>${when(e.created)}</div>`).join('');
  return status + (rows || '<p class="small muted">Permission requests and decisions for the selected run are recorded here.</p>');
}
function recentDecisionHTML() {
  const r = data.reviews.find(r => ['confirmed', 'sent', 'uncertain', 'resolved'].includes(r.state) && !dismissedReceipts.has(requestKey(r)));
  if (!r) return '';
  return `<section class="notice ${r.state === 'confirmed' ? 'success' : ''}"><div class="row between"><strong>${esc(receiptLabel(r))}</strong><button class="icon-button" data-dismiss="${esc(requestKey(r))}" aria-label="Dismiss decision confirmation">×</button></div>
    <p class="small">${esc(requestText(r.request))}</p>${r.redirect_saved ? '<p class="small">Redirection saved for Hermes’s next prompt.</p>' : ''}
    <button class="text-button" data-review="${esc(requestKey(r))}">View decision</button></section>`;
}
function renderApprovals() {
  setHTML($('skill-proposals'), pendingSkills().map(skillCard).join(''));
  renderSkillsView();
  setHTML($('approval-list'), data.inbox.length ? data.inbox.map(approvalCard).join('') : pendingSkills().length ? '' : '<section class="ac-panel"><h2>Nothing waiting on you.</h2><p class="muted small">New permission requests and questions will appear here.</p></section>');
  setHTML($('rule-list'), rulesHTML());
  setHTML($('audit-list'), auditHTML());
  setHTML($('decision-history'), data.reviews.length ? data.reviews.map(r => {
    const tone = r.state === 'confirmed' ? (r.action === 'reject' ? 'error' : 'success-text') : 'warning-text';
    const mark = r.state === 'confirmed' ? (r.action === 'reject' ? '×' : '✓') : '◌';
    return `<button class="history-button" data-review="${esc(requestKey(r))}"><span class="${tone}">${mark}</span><span><strong>${esc(receiptLabel(r))} · ${esc(requestTitle(r.request))}</strong><small>${esc(requestText(r.request).slice(0, 120))}</small></span>${when(r.updated)}</button>`;
  }).join('') : '<p class="small muted">Decisions for the selected run will be recorded here.</p>');
}
function eventSummary(e, parsed) {
  if (!parsed || typeof parsed !== 'object') return e.detail;
  if (parsed.tool) return `${parsed.tool}${parsed.title ? ': ' + parsed.title : ''}${parsed.status ? ' · ' + parsed.status : ''}`;
  return parsed.summary || parsed.title || (parsed.text ? String(parsed.text) : '') || parsed.status || '';
}
function renderActivity() {
  const filter = $('event-filter').value, query = $('event-search').value.trim().toLowerCase();
  const events = [...(data.events || [])].reverse().filter(e => (filter === 'all' || e.kind.toLowerCase().includes(filter.toLowerCase()))
    && (!query || (e.kind + ' ' + e.detail).toLowerCase().includes(query)));
  setHTML($('activity-list'), events.map(e => {
    let parsed;
    try { parsed = JSON.parse(e.detail); } catch {}
    const summary = eventSummary(e, parsed);
    return `<article class="event"><div class="event-header"><strong>${esc(e.kind)}</strong>${when(e.created)}</div>
      ${summary ? `<p class="muted">${esc(String(summary).slice(0, 260))}</p>` : ''}${details('View recorded details', parsed ? pretty(parsed) : e.detail, 'event-' + e.id)}</article>`;
  }).join('') || '<p class="small muted">No activity matches this view.</p>');
}


// ---------------------------------------------------------------------------
// Live project preview (Project tab)
// ---------------------------------------------------------------------------
const preview = {offset: 0, frameKey: '', timer: null, screenURL: '', lastStatus: {}, opened: new Set(), width: '100%'};
function previewStatus() { return data?.preview || {state: 'idle'}; }
function previewForCurrent() { const p = previewStatus(); return !!current && p.run === current.id; }
function previewLive(p = previewStatus()) { return ['starting', 'running'].includes(p.state); }
function stripAnsi(text) {
  return text.replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b[()][A-Z0-9]/g, '')
    .replace(/\r\n/g, '\n').replace(/\r/g, '').replace(/[^\n]\x08/g, '');
}
function readPreviewSpec(prefix) {
  const mode = $(`${prefix}-preview-mode`).value;
  if (mode === 'none') return {mode: 'none'};
  const spec = {mode};
  if (mode !== 'static') spec.command = $(`${prefix}-preview-command`).value.trim();
  if (mode === 'cli' && $(`${prefix}-preview-args`).value.trim()) spec.args = $(`${prefix}-preview-args`).value.trim();
  if (mode === 'web') spec.port = Number($(`${prefix}-preview-port`).value) || 0;
  if (mode === 'static') spec.path = $(`${prefix}-preview-path`).value.trim() || '.';
  if (mode === 'desktop') { spec.width = Number($(`${prefix}-preview-width`).value) || 1280; spec.height = Number($(`${prefix}-preview-height`).value) || 800; }
  return spec;
}
function fillPreviewSpec(prefix, spec) {
  $(`${prefix}-preview-mode`).value = spec?.mode || 'none';
  $(`${prefix}-preview-command`).value = spec?.command || '';
  $(`${prefix}-preview-port`).value = spec?.port || '';
  $(`${prefix}-preview-args`).value = spec?.args || '';
  $(`${prefix}-preview-path`).value = spec?.path || '';
  $(`${prefix}-preview-width`).value = spec?.width || 1280;
  $(`${prefix}-preview-height`).value = spec?.height || 800;
  togglePreviewFields(prefix);
}
function togglePreviewFields(prefix) {
  const form = document.querySelector(`[data-preview-form="${prefix}"]`), mode = $(`${prefix}-preview-mode`).value;
  form.querySelectorAll('[data-for]').forEach(e => e.classList.toggle('hidden', !e.dataset.for.split(' ').includes(mode)));
  const modes = data?.capabilities?.preview_modes;
  const desktop = form.querySelector('option[value="desktop"]');
  if (modes && desktop) desktop.disabled = !modes.includes('desktop');
  const missing = data?.capabilities?.preview_missing || [];
  form.querySelector('.preview-missing').textContent = missing.length ? `Needs ${missing.join(', ')} installed on the server.` : '';
}
function previewControlsHTML(p, mine) {
  if (!current?.preview) return '';
  const running = mine && previewLive(p);
  return running
    ? `<button class="ac-btn" data-action="preview-restart">${icon('play')}<span>Restart</span></button><button class="ac-btn danger-button" data-action="preview-stop">${icon('stop')}<span>Stop preview</span></button>`
    : `<button class="ac-btn primary" data-action="preview-start">${icon('play')}<span>Start preview</span></button>`;
}
function previewStateHTML(p, mine) {
  const labels = {idle: 'Not running', starting: 'Starting…', running: 'Running', exited: 'Exited', failed: 'Failed'};
  const tone = {running: 'completed', starting: 'running', failed: 'failed', exited: ''}[p.state] || '';
  return mine ? `<span class="ac-status ${tone}"><span class="dot"></span>${labels[p.state] || p.state}</span>` : `<span class="ac-status"><span class="dot"></span>Not running</span>`;
}
function renderProject() {
  if (!data) return;
  const p = previewStatus(), mine = previewForCurrent(), spec = current?.preview;
  $('preview-dot').classList.toggle('hidden', !previewLive(p));
  $('project-title').textContent = current ? runTitle(current, 90) : 'Project';
  const modeNames = {web: 'Web app', static: 'Static page', cli: 'Command-line app', desktop: 'Desktop app'};
  $('project-sub').innerHTML = !current ? 'Start a run to preview what it builds.'
    : spec ? `${esc(modeNames[spec.mode])} · <span class="mono">${esc(spec.command || spec.path)}</span>${mine && p.started ? ' · started ' + when(new Date(p.started * 1000).toISOString()) : ''}`
    : 'No preview is configured for this run yet. Add one below.';
  setHTML($('preview-controls'), current ? previewStateHTML(p, mine) + previewControlsHTML(p, mine) : '');
  const other = previewLive(p) && !mine;
  const banner = other ? `A preview from run #${esc(p.run.slice(0, 6))} is running. Starting this one stops it.` : mine && p.error ? p.error : '';
  $('preview-banner').textContent = banner;
  $('preview-banner').className = 'notice ' + (mine && p.error ? 'danger' : '') + (banner ? '' : ' hidden');
  renderPreviewStrip();
  const mode = mine ? p.mode : null, live = mine && previewLive(p);
  const show = {web: live && ['web', 'static'].includes(mode), cli: mine && mode === 'cli' && p.state !== 'idle', desktop: live && mode === 'desktop'};
  $('preview-web').classList.toggle('hidden', !show.web);
  $('preview-cli').classList.toggle('hidden', !show.cli);
  $('preview-desktop').classList.toggle('hidden', !show.desktop);
  const empty = !show.web && !show.cli && !show.desktop;
  $('preview-empty').classList.toggle('hidden', !empty);
  if (empty) setHTML($('preview-empty'), !current ? '<p class="muted">No run selected.</p>'
    : !spec ? '<h2>Nothing to preview yet</h2><p class="small muted">Choose how to run this project in <strong>Preview settings</strong>. The preview runs your saved command in the project folder.</p>'
    : mine && p.state === 'starting' ? '<h2>Starting the preview…</h2><p class="small muted">Waiting for it to answer. The process log below shows its output.</p>'
    : `<h2>${mine && p.state === 'failed' ? 'The preview stopped' : 'Preview is not running'}</h2><p class="small muted">Press <strong>Start preview</strong> to run <span class="mono">${esc(spec.command || spec.path)}</span>.</p>`);
  $('preview-term-title').textContent = spec?.command ? spec.command.split(' ').slice(0, 3).join(' ') : 'program';
  $('preview-term-meta').textContent = mine ? `${p.state}${p.exit_code !== null && p.exit_code !== undefined ? ' · exit ' + p.exit_code : ''}` : '';
  $('preview-term').classList.toggle('running', live);
  $('preview-input').disabled = !live;
  $('preview-log-wrap').classList.toggle('hidden', !mine || mode === 'cli' || mode === 'static');
  if (show.web) ensurePreviewFrame(p);
  if (view === 'project' && !$('preview-settings').contains(document.activeElement) && $('preview-settings').dataset.run !== current?.id) {
    $('preview-settings').dataset.run = current?.id || '';
    fillPreviewSpec('cfg', spec);
    $('preview-args').value = spec?.args || '';
  }
  togglePreviewFields('cfg');
}
function renderPreviewStrip() {
  if (!current) { setHTML($('preview-strip'), ''); return; }
  const last = [...(data.steps || [])].reverse().find(s => s.verification)?.verification, files = fileStats(data.steps), checks = current.goal_checks || [];
  const manual = current.manual_verification;
  const v = manual && (!last || manual.created > (last.created || '')) ? manual : last;
  setHTML($('preview-strip'), `<div class="strip-item"><small>Run</small>${statusHTML(current, runRequests())}</div>
    <div class="strip-item"><small>Verification</small><span class="ac-status ${v?.status === 'passed' ? 'completed' : v?.status === 'failed' ? 'failed' : ''}">${esc(v?.status || 'not run')}</span></div>
    <div class="strip-item"><small>Files changed</small><strong>${files.length}</strong></div>
    <div class="strip-item"><small>Goal checks</small><strong>${checks.length}</strong></div>
    <div class="strip-item"><button class="text-button" data-view="runs">Open the run</button>${files.length ? '<button class="text-button" data-action="diff">View changes</button>' : ''}</div>`);
}
async function ensurePreviewFrame(p) {
  const key = `${p.run}:${p.started}`;
  if (preview.frameKey === key) return;
  preview.frameKey = key;
  try {
    const {ticket, port} = await api('/api/preview/ticket', 'POST', {});
    const base = `${location.protocol}//${location.hostname}:${port}`;
    $('preview-frame').src = `${base}/__ac/enter?ticket=${encodeURIComponent(ticket)}`;
    $('preview-address').textContent = base + '/';
  } catch (error) { preview.frameKey = ''; pageError(error.message); }
}
function appendPreviewOutput(text, reset) {
  const clean = stripAnsi(text);
  for (const target of [$('preview-term-body'), $('preview-log')]) {
    const atBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 24;
    if (reset) target.textContent = '';
    if (clean) target.append(clean);
    if (target.textContent.length > 250000) target.textContent = target.textContent.slice(-200000);
    if (atBottom || reset) target.scrollTop = target.scrollHeight;
  }
}
async function pollPreview() {
  clearTimeout(preview.timer);
  const p = previewStatus();
  let delay = 1500;
  try {
    if (key && connected && view === 'project' && previewForCurrent() && !document.hidden) {
      if (previewLive(p) || preview.offset < (p.offset || 0)) {
        const result = await api('/api/preview/output?since=' + preview.offset);
        if (typeof result.text === 'string') {
          // A smaller offset than ours means the preview restarted elsewhere; start the view over.
          appendPreviewOutput(result.text, result.from < preview.offset);
          preview.offset = result.offset;
          if (result.status) {
            const changed = result.status.state !== data.preview?.state || result.status.exit_code !== data.preview?.exit_code;
            data.preview = result.status;
            if (changed) renderProject();
          }
        }
        delay = 1000;
      }
      if (previewLive(p) && p.mode === 'desktop') await refreshScreen();
    }
  } catch {}
  preview.timer = setTimeout(pollPreview, delay);
}
async function refreshScreen() {
  const response = await fetch('/api/preview/frame', {headers: {Authorization: 'Bearer ' + key}});
  if (!response.ok) return;
  const url = URL.createObjectURL(await response.blob());
  $('preview-screen').src = url;
  if (preview.screenURL) URL.revokeObjectURL(preview.screenURL);
  preview.screenURL = url;
}
function resetPreviewOutput() { preview.offset = 0; $('preview-term-body').textContent = ''; $('preview-log').textContent = ''; }
async function previewAction(action, extra = {}) {
  const status = await api('/api/preview', 'POST', {run: current.id, action, ...extra});
  if (status && status.state) data.preview = status;
  if (['start', 'restart'].includes(action)) { resetPreviewOutput(); preview.frameKey = ''; }
  renderProject();
  pollPreview();
  return status;
}
function autoOpenProject() {
  if (!current) return;
  const before = preview.lastStatus[current.id];
  preview.lastStatus[current.id] = current.status;
  if (before && before !== 'completed' && current.status === 'completed' && current.preview && !preview.opened.has(current.id)) {
    preview.opened.add(current.id);
    showView('project');
    toast('Run complete. Opening the live preview.');
  }
}
function screenClick(event) {
  const p = previewStatus(), img = $('preview-screen'), rect = img.getBoundingClientRect();
  if (!rect.width || !p.width) return;
  const x = Math.round((event.clientX - rect.left) / rect.width * p.width), y = Math.round((event.clientY - rect.top) / rect.height * p.height);
  previewAction('click', {x: Math.max(0, x), y: Math.max(0, y), button: event.button === 2 ? 3 : 1}).then(refreshScreen).catch(e => pageError(e.message));
}

// ---------------------------------------------------------------------------
// Review dialog
// ---------------------------------------------------------------------------
function findRequest(id) {
  const p = data.inbox.find(p => requestKey(p) === id);
  if (p) return p;
  const receipt = data.reviews.find(r => requestKey(r) === id);
  return receipt ? {...receipt.request, run: receipt.run, goal: current?.goal || '', receipt} : null;
}
function permissionHTML(p) {
  const input = p.context?.input || {}, meta = p.metadata || {};
  let html = `<section class="request-section"><h3>Exact command or scope</h3><pre>${esc(requestText(p))}</pre></section>`;
  if (typeof meta.description === 'string') html += `<p class="small">${esc(meta.description)}</p>`;
  const diff = meta.diff || input.diff;
  if (diff) html += `<section class="request-section"><h3>Proposed changes</h3><pre>${diffHTML(pretty(diff))}</pre></section>`;
  else if (input.oldString !== undefined || input.newString !== undefined) html += `<section class="request-section"><h3>Current text</h3><pre>${esc(input.oldString || '')}</pre><h3>Proposed text</h3><pre>${esc(input.newString || '')}</pre></section>`;
  else if (typeof input.content === 'string') html += `<section class="request-section"><h3>Proposed file contents</h3><pre>${esc(input.content)}</pre></section>`;
  html += `<label for="redirect-note">Redirection for Hermes <span class="muted">· sent when you deny</span></label>
    <textarea id="redirect-note" rows="3" maxlength="5000">${esc(p.receipt?.redirect || 'Choose another approach that avoids this denied action and stays within my brief.')}</textarea>
    <p class="small muted">Saved for the next Hermes planning turn. OpenCode receives the denial immediately.</p>`;
  return html;
}
function questionsHTML(p) {
  return (p.questions || []).map((q, i) => {
    const type = q.multiple ? 'checkbox' : 'radio';
    const options = (q.options || []).map(o => `<label class="choice"><input type="${type}" name="question-${i}" value="${esc(o.label)}"><span><strong>${esc(o.label)}</strong><small>${esc(o.description || '')}</small></span></label>`).join('');
    const custom = q.custom !== false ? `<label class="choice"><input type="${type}" name="question-${i}" data-custom-choice="${i}" value=""><span><strong>Write an answer</strong></span></label><label class="sr-only" for="custom-${i}">Custom answer ${i + 1}</label><textarea id="custom-${i}" data-custom="${i}" rows="2" maxlength="5000"></textarea>` : '';
    return `<section class="question-block"><div class="eyebrow">${esc(q.header || 'Question ' + (i + 1))}</div><h3>${esc(q.question)}</h3>${options}${custom}</section>`;
  }).join('');
}
function openReview(id, intent) {
  const found = findRequest(id);
  if (!found) return;
  reviewing = JSON.parse(JSON.stringify(found));
  reviewBusy = false;
  const p = reviewing, permission = p.kind === 'permission';
  const raw = pretty(Object.fromEntries(Object.entries(p).filter(([k]) => !['run', 'goal', 'receipt', 'fingerprint', 'risk'].includes(k))));
  $('review-body').innerHTML = `<span class="ac-status attention">OpenCode · #${esc(p.run.slice(0, 6))}</span><h2>${esc(requestTitle(p))}</h2><p class="small muted">${esc(p.goal)}</p>
    ${riskHTML(p)}${permission ? permissionHTML(p) : questionsHTML(p)}${details('Full OpenCode request', raw, 'raw-request')}<div id="review-feedback" role="status"></div>`;
  $('review-footer').innerHTML = `<small>${permission ? (p.risk?.decision === 'confirm' ? 'Critical: type the confirmation word first.' : 'Approval applies to this request only unless you tick the box above.') : 'Answers go to this OpenCode session.'}</small>
    <button class="ac-btn danger-button" id="deny-review" aria-keyshortcuts="d">${permission ? 'Deny and redirect' : 'Reject question'}</button>
    <button class="ac-btn primary" id="approve-review" aria-keyshortcuts="a">${permission ? 'Approve once' : 'Send answers'}</button>`;
  $('deny-review').onclick = () => submitReview('reject');
  $('approve-review').onclick = () => submitReview(permission ? 'approve' : 'answer');
  p.receipt?.answers?.forEach((values, i) => values.forEach(value => {
    const inputs = [...$('review-body').querySelectorAll(`input[name="question-${i}"]`)];
    const option = inputs.find(el => !el.hasAttribute('data-custom-choice') && el.value === value);
    if (option) option.checked = true;
    else if ($('custom-' + i)) { const custom = inputs.find(el => el.hasAttribute('data-custom-choice')); if (custom) custom.checked = true; $('custom-' + i).value = value; }
  }));
  if (p.receipt && p.receipt.state !== 'failed') $('review-body').querySelectorAll('input,textarea').forEach(e => { e.disabled = true; });
  if (!$('review-dialog').open) $('review-dialog').showModal();
  refreshReview();
  if (intent === 'reject' && $('redirect-note') && !p.receipt) $('redirect-note').focus();
}
function reviewFeedback(message, tone = '') {
  const e = $('review-feedback');
  if (e) { e.textContent = message; e.className = message ? 'notice ' + tone : ''; }
}
function refreshReview() {
  if (!$('review-dialog').open || !reviewing || reviewBusy || !data) return;
  const live = data.inbox.find(p => requestKey(p) === requestKey(reviewing));
  const receipt = live?.receipt || data.reviews.find(r => requestKey(r) === requestKey(reviewing)) || reviewing.receipt;
  const stale = !live || live.fingerprint !== reviewing.fingerprint || !live.fingerprint;
  const disabled = !connected || stale || !!receipt && receipt.state !== 'failed';
  $('approve-review').disabled = disabled;
  $('deny-review').disabled = disabled;
  if (!connected) reviewFeedback('Reconnecting. Decisions are unavailable until the controller responds.');
  else if (receipt?.state === 'confirmed') reviewFeedback(receiptLabel(receipt) + '. OpenCode accepted the reply and no longer lists the request as pending.', 'success');
  else if (receipt?.state === 'sent' || receipt?.state === 'dispatching') reviewFeedback('Decision sent. Waiting for OpenCode to remove the pending request.');
  else if (receipt?.state === 'uncertain') reviewFeedback('Delivery could not be confirmed. This decision will not be sent again automatically. Check the session in OpenCode.', 'danger');
  else if (receipt?.state === 'resolved') reviewFeedback('This request is resolved. Delivery of the earlier reply could not be confirmed.');
  else if (receipt?.state === 'failed') reviewFeedback((receipt.redirect_saved ? 'Your redirection was saved. ' : '') + (receipt.error || 'Delivery failed. You may retry.'), 'danger');
  else if (stale) reviewFeedback(live ? 'The action changed. Close this window and inspect the new request.' : 'This request is no longer pending.', 'danger');
}
async function submitReview(action) {
  if (reviewBusy || !reviewing || !connected) return;
  const p = reviewing;
  let answers, redirect, confirm, remember = false;
  if (action === 'approve') {
    const box = $('confirm-word');
    if (box) {
      confirm = box.value.trim();
      if (confirm.toLowerCase() !== box.dataset.confirmWord) { reviewFeedback(`Type ${box.dataset.confirmWord} to approve this critical request.`, 'danger'); box.focus(); return; }
    }
    remember = !!$('remember-rule')?.checked;
  }
  if (action === 'answer') {
    answers = (p.questions || []).map((q, i) => [...$('review-body').querySelectorAll(`input[name="question-${i}"]:checked`)].map(el => el.hasAttribute('data-custom-choice') ? $('custom-' + i).value.trim() : el.value));
    if (answers.some(list => !list.length || list.some(x => !x))) { reviewFeedback('Answer each question before sending.', 'danger'); return; }
  }
  if (action === 'reject' && p.kind === 'permission') {
    redirect = $('redirect-note').value.trim();
    if (!redirect) { reviewFeedback('Add a redirection for Hermes before denying.', 'danger'); return; }
  }
  reviewBusy = true;
  $('approve-review').disabled = true;
  $('deny-review').disabled = true;
  reviewFeedback('Sending your decision…');
  try {
    const receipt = await api('/api/review', 'POST', {run: p.run, kind: p.kind, request_id: p.request_id, fingerprint: p.fingerprint, action, ...(answers ? {answers} : {}), ...(redirect ? {redirect} : {}), ...(confirm ? {confirm} : {}), ...(remember ? {remember: true} : {})});
    p.receipt = receipt;
    toast(receiptLabel(receipt));
    await refresh();
  } catch (error) { reviewFeedback(error.message, 'danger'); }
  finally { reviewBusy = false; refreshReview(); }
}

// ---------------------------------------------------------------------------
// Navigation and actions
// ---------------------------------------------------------------------------
function showView(next) {
  if (!['runs', 'approvals', 'activity', 'new', 'project', 'skills'].includes(next)) return;
  view = next;
  document.querySelectorAll('.view').forEach(e => e.classList.toggle('hidden', e.id !== 'view-' + next));
  document.querySelectorAll('.nav [data-view]').forEach(b => { b.classList.toggle('active', b.dataset.view === next); b.setAttribute('aria-current', b.dataset.view === next ? 'page' : 'false'); });
  closeDrawer();
  if (data) { renderShell(); if (next === 'project') { renderProject(); pollPreview(); } }
}
let preflight = null;
function chosenMode() { return document.querySelector('input[name="run-mode"]:checked')?.value || 'single'; }
function runModeBody() {
  const mode = chosenMode();
  if (mode === 'team' && preflight?.usable) return {mode: 'team', team_size: Number($('team-size').value)};
  if (mode === 'auto') return {mode: 'auto', team_size: Number($('team-size').value)};
  return {};
}
let autoTimer = null;
function scheduleAutoPreview() {
  const box = $('auto-preview');
  if (chosenMode() !== 'auto') { box.classList.add('hidden'); return; }
  clearTimeout(autoTimer);
  autoTimer = setTimeout(autoPreview, 400);
}
async function autoPreview() {
  const box = $('auto-preview');
  if (chosenMode() !== 'auto') return;
  box.classList.remove('hidden');
  if (!$('goal').value.trim()) { box.textContent = 'Write the brief to see what Auto would choose.'; return; }
  try {
    const d = await api('/api/mode/preview', 'POST', {goal: $('goal').value, verifier: $('verify-enabled').checked ? $('verify').value : '',
      max_steps: Number($('max-prompts').value), goal_checks: [...$('new-checks').querySelectorAll('textarea')].map(e => e.value.trim()).filter(Boolean)});
    setHTML(box, `<strong>Auto would ${d.mode === 'team' ? 'ask Hermes for a team plan' : 'use one agent'}.</strong> ${esc(d.reasons.join(' '))}`);
  } catch (error) { box.textContent = error.message; }
}
function autoNote(run = current) {
  const a = run?.auto;
  if (!a) return '';
  const team = run.team, outcome = run.mode === 'single' ? 'one agent' : team?.state === 'single' ? 'one agent after Hermes’s review' : 'a team plan for your approval';
  return `<p class="small auto-note"><strong>Auto mode:</strong> ${esc(outcome)}. <span class="muted">${esc(a.reasons.join(' '))}</span></p>`;
}
async function loadPreflight() {
  try { preflight = await api('/api/workspace/preflight'); } catch { preflight = null; }
  renderPreflight();
}
function renderPreflight() {
  const p = preflight, parent = parentRun && data?.runs ? current : null;
  $('setup-field').classList.toggle('hidden', !p?.usable);
  const teamOption = $('mode-team');
  if (teamOption) {
    teamOption.disabled = !p?.usable;
    if (!p?.usable) { teamOption.checked = false; $('mode-single').checked = true; }
    $('team-mode-note').textContent = p?.usable ? 'Hermes proposes the agents and tasks; nothing runs until you approve the plan.' : 'Teams need a git project with at least one commit.';
  }
  if (!p) { setHTML($('workspace-preflight'), ''); return; }
  if (!p.usable) {
    setHTML($('workspace-preflight'), `<p class="small muted">Works directly in the project folder${p.is_repo ? ': ' + esc(p.reason) : ' (not a git repository)'}.</p>`);
    return;
  }
  const from = parent?.workspace?.mode === 'worktree' && !parent.workspace.applied && !parent.workspace.discarded
    ? `the unapplied branch of run #${esc(parent.id.slice(0, 6))}` : `your last commit on <strong>${esc(p.branch)}</strong>`;
  let html = `<p class="small">Works on its own branch, starting from ${from}. Your checkout is not changed until you press <strong>Apply</strong>.</p>`;
  if (p.dirty_count) {
    const files = [...p.changes, ...p.untracked];
    html += `<div class="notice warning"><strong>${plural(p.dirty_count, 'uncommitted file')} in your project</strong>
      <p class="small">The run starts from your last commit, so the agent will not see these changes:</p>
      <pre class="small">${esc(files.slice(0, 12).join('\n'))}${files.length > 12 ? '\n…' : ''}</pre>
      <label class="choice"><input type="checkbox" id="allow-dirty"><span><strong>Start from my last commit anyway</strong><small>Your uncommitted changes stay in your checkout, untouched.</small></span></label></div>`;
  }
  setHTML($('workspace-preflight'), html);
}
function openNew(followup = false) {
  if (followup && !current) return;
  loadPreflight();
  parentRun = followup ? current.id : null;
  if (followup) {
    $('goal').value = '';
    $('verify').value = current.verifier.map(shellQuote).join(' ');
    $('new-checks').innerHTML = '';
    $('followup-context').textContent = 'Follow-up to #' + current.id.slice(0, 6) + '. Its brief and summary will be supplied to Hermes.';
  }
  $('followup-context').classList.toggle('hidden', !followup);
  $('start-error').textContent = '';
  showView('new');
  $('goal').focus();
}
function addCheckInput(text = '') {
  if ($('new-checks').children.length >= 20) { toast('A run supports up to 20 goal checks.'); return; }
  const row = document.createElement('div');
  row.className = 'new-check';
  const unique = 'criterion-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  row.innerHTML = `<label for="${unique}" class="sr-only">Goal check</label><textarea id="${unique}" rows="1" maxlength="1000" required placeholder="A specific condition for completion">${esc(text)}</textarea><button type="button" class="icon-button" data-action="remove-check" aria-label="Remove goal check">×</button>`;
  $('new-checks').append(row);
  if (!text) row.querySelector('textarea').focus();
}
async function control(action, text = '', id = current?.id) {
  if (!id) throw Error('Choose a run first.');
  const result = await api('/api/control', 'POST', {run: id, action, text});
  pageError('');
  await refresh();
  return result;
}
function askStop() {
  if (!current || ended.has(current.status)) { toast('There is no active run to stop.'); return; }
  stopRunId = current.id;
  $('stop-title').textContent = 'Stop run #' + current.id.slice(0, 6) + '?';
  $('stop-error').textContent = '';
  $('stop-dialog').showModal();
}
function focusSteer() {
  if (!current || ended.has(current.status)) { toast('Steering is available during an active run.'); return; }
  showView('runs');
  $('steering').focus();
  $('steering').scrollIntoView({block: 'center'});
}
function focusApproval() {
  if (!data?.inbox.length) { toast('No requests are waiting.'); return; }
  showView('approvals');
  const card = $('approval-list').querySelector('[data-approval-card]');
  card?.scrollIntoView({block: 'center'});
  card?.focus();
}
function keyboardReview(intent) {
  if ($('review-dialog').open && reviewing) { const button = $(intent === 'approve' ? 'approve-review' : 'deny-review'); if (!button.disabled) button.click(); return; }
  const p = runRequests()[0] || data?.inbox[0];
  if (p) openReview(requestKey(p), intent); else toast('No requests are waiting.');
}
function diffFiles(step) {
  const text = step.evidence.diff || '';
  const blocks = text.split(/\n(?=--- )/).filter(Boolean);
  return blocks.map(block => {
    const path = (block.match(/^--- (.*?)(?: \(before\))?$/m) || [])[1] || 'Captured change';
    const stat = step.evidence.file_stats?.find(f => f.path === path);
    return {path, stat, block};
  });
}
function openDiff(stepId) {
  const steps = (stepId ? data.steps.filter(s => s.id === stepId) : data.steps).filter(s => s.evidence);
  diffText = steps.map(s => `# Turn ${s.number}: ${s.title}\n${s.evidence.diff || '(No captured text changes)'}${s.evidence.diff_truncated ? '\n[Preview truncated]' : ''}`).join('\n\n');
  const sections = steps.map(s => {
    const files = diffFiles(s).map((f, i) => `<details class="diff-file" ${i < 3 ? 'open' : ''}><summary><span class="file-path">${esc(f.path)}</span>${f.stat ? `<span class="file-counts"><span class="added">+${f.stat.added}</span> <span class="removed">−${f.stat.removed}</span></span>` : ''}</summary><pre>${diffHTML(f.block)}</pre></details>`).join('');
    return `<section class="diff-turn"><h3>Turn ${s.number}: ${esc(s.title)}</h3>${files || '<p class="small muted">No captured text changes.</p>'}${s.evidence.diff_truncated ? '<p class="small warning-text">Preview truncated.</p>' : ''}</section>`;
  }).join('');
  $('diff-body').innerHTML = '<p class="small muted">Recorded text previews. This is not a complete repository audit.</p>' + (sections || '<p class="small muted">No file evidence captured yet.</p>');
  $('diff-dialog').showModal();
}
function closeDrawer() {
  $('sidebar').classList.remove('drawer-open');
  $('drawer-scrim').classList.add('hidden');
  document.querySelector('[data-action="drawer"]').setAttribute('aria-expanded', 'false');
}
function toggleDrawer() {
  const open = $('sidebar').classList.toggle('drawer-open');
  $('drawer-scrim').classList.toggle('hidden', !open);
  document.querySelector('[data-action="drawer"]').setAttribute('aria-expanded', String(open));
  if (open) $('sidebar').querySelector('button').focus();
}
function downloadDiff() {
  const url = URL.createObjectURL(new Blob([diffText], {type: 'text/plain'}));
  const a = document.createElement('a');
  a.href = url; a.download = 'AgentControl-' + (current?.id || 'run') + '.diff'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function togglePause() {
  if (!current || ended.has(current.status)) { toast('Choose an active run.'); return; }
  const resume = current.pause || ['interrupted', 'attention'].includes(current.status);
  await control(resume ? 'resume' : 'pause');
  toast(resume ? 'Resuming the workflow' : 'Pause requested at the next boundary');
}
const ACTIONS = {
  new: () => openNew(),
  followup: () => openNew(true),
  connections: () => $('connection-dialog').showModal(),
  help: () => $('help-dialog').showModal(),
  drawer: toggleDrawer,
  'drawer-close': closeDrawer,
  'focus-steer': focusSteer,
  'focus-approval': focusApproval,
  stop: askStop,
  pause: togglePause,
  'add-check': () => { if (!current || ended.has(current.status)) return; $('check-error').textContent = ''; $('check-dialog').showModal(); $('criterion').focus(); },
  'ask-status': () => { focusSteer(); $('steering').value = 'At your next planning turn, summarize what is complete, what remains, and any blockers.'; $('steering').focus(); },
  'skill-add': () => skillCall('/api/skills/propose', {run: current.id, agent: $('skill-agent')?.value || 'coder-1', source: {type: 'library', name: $('skill-pick').value}}, 'Skill added. New skills wait for your review in Approvals.'),
  'skill-add-git': () => skillCall('/api/skills/propose', {run: current.id, agent: $('skill-git-agent')?.value || 'coder-1',
    source: {type: 'git', url: $('skill-url').value.trim(), ref: $('skill-ref').value.trim(), path: $('skill-path').value.trim()}}, 'Fetched. Review it in Approvals.'),
  'skill-approve': button => skillCall('/api/skills/decide', {id: button.dataset.skill, action: 'approve'}, 'Skill installed.'),
  'skill-reject': button => skillCall('/api/skills/decide', {id: button.dataset.skill, action: 'reject'}, 'Skill rejected.'),
  'skill-fetch': button => skillCall('/api/skills/fetch', {id: button.dataset.skill}, 'Fetched. Review the content before installing.'),
  'skill-remove': button => skillCall('/api/skills/remove', {id: button.dataset.skill}, 'Skill removed from the agent.'),
  'approve-team': async () => { await control('approve_team'); toast('Plan approved. Starting the team.'); },
  'single-agent': async () => { await control('single_agent'); toast('Running as a single agent.'); },
  repropose: async () => {
    const note = $('team-note').value.trim();
    if (!note) { $('team-error').textContent = 'Tell Hermes what to change.'; return; }
    await control('repropose', note);
    toast('Asked Hermes for a different plan.');
  },
  'apply-branch': () => {
    const ws = current.workspace, w = data.workspace, id = current.id;
    askConfirm(`Apply to ${ws.base_branch}?`, `<p>Merge <code>${esc(ws.integration.branch)}</code> into <strong>${esc(ws.base_branch)}</strong> with a merge commit.</p>
      <p class="small muted">${plural(w.commits || 0, 'commit')}${w.shortstat ? ' · ' + esc(w.shortstat) : ''}. Your repository's git hooks run as usual. If the merge conflicts, it is undone and your branch stays as it is.</p>`,
      `Apply to ${ws.base_branch}`, false, async () => { await control('apply', '', id); toast(`Applied to ${ws.base_branch}.`); });
  },
  'discard-branch': () => {
    const ws = current.workspace, id = current.id;
    askConfirm('Discard this branch?', `<p>Delete <code>${esc(ws.integration.branch)}</code>, the agent branch, and their worktrees.</p><p class="small muted">Work that was not applied is lost. Your checkout is not touched.</p>`,
      'Discard branch', true, async () => { await control('discard_workspace', '', id); toast('Branch discarded.'); });
  },
  'revoke-rule': async button => { await control('revoke_rule', button.dataset.rule); toast('Rule revoked. Matching requests will be asked again.'); },
  'verify-now': async () => {
    if (!canVerifyNow()) { toast(current?.verifier?.length ? 'Pause the run first; Verify now cannot overlap a coding turn.' : 'This run has no verification command.'); return; }
    await control('verify');
    toast('Running your verification command…');
  },
  rename: () => { $('rename-input').value = current?.title || ''; $('rename-error').textContent = ''; $('rename-dialog').showModal(); $('rename-input').focus(); },
  'new-check': () => addCheckInput(),
  'remove-check': button => button.closest('.new-check').remove(),
  'key-approve': () => keyboardReview('approve'),
  'key-deny': () => keyboardReview('reject'),
  diff: () => openDiff(),
  'download-diff': downloadDiff,
  'check-connections': async () => { await api('/api/check', 'POST', {}); toast('Checking the Hermes CLI and OpenCode API…'); await refresh(); },
  'dismiss-error': () => pageError(''),
  notifications: toggleNotifications,
  'sign-out': () => { forgetKey(); clearTimeout(pollTimer); disconnectEvents(); $('connection-dialog').close(); $('key').value = ''; showAuth('Signed out. The key was removed from this browser.'); },
  'term-follow': () => setFollow(!term.follow),
  'term-jump': () => setFollow(true),
  'term-copy': async () => { try { await navigator.clipboard.writeText(terminalText()); toast('Terminal output copied.'); } catch { toast('Copy is unavailable in this browser.'); } },
  'preview-start': () => previewAction('start'),
  'preview-restart': () => previewAction('restart'),
  'preview-stop': () => previewAction('stop'),
  'preview-reload': () => { preview.frameKey = ''; ensurePreviewFrame(previewStatus()); },
  'preview-open': async () => {
    const {ticket, port} = await api('/api/preview/ticket', 'POST', {});
    window.open(`${location.protocol}//${location.hostname}:${port}/__ac/enter?ticket=${encodeURIComponent(ticket)}`, '_blank', 'noopener');
  },
  'preview-clear': () => { $('preview-term-body').textContent = ''; },
  'preview-save': async () => {
    $('preview-settings-error').textContent = '';
    try { await api('/api/preview', 'POST', {run: current.id, action: 'config', preview: readPreviewSpec('cfg')}); toast('Preview settings saved.'); $('preview-settings').dataset.run = ''; await refresh(); }
    catch (error) { $('preview-settings-error').textContent = error.message; }
  },
  'term-expand': () => { if ($('terminal-dialog').open) $('terminal-dialog').close(); else expandTerminal(true); },
};
async function act(action, button) { await ACTIONS[action]?.(button); }

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------
function ignoresShortcut(event) {
  return event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
    || !!event.target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
}
function handleShortcut(event) {
  if (!data || $('app').classList.contains('hidden')) return;
  const editable = !!event.target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
  if (event.key === '?' && !editable && !event.ctrlKey && !event.metaKey && !event.altKey && !document.querySelector('dialog[open]')) { event.preventDefault(); $('help-dialog').showModal(); return; }
  if (ignoresShortcut(event)) return;
  const modal = document.querySelector('dialog[open]');
  if (modal) {
    if (modal.id === 'review-dialog' && ['a', 'd'].includes(event.key)) { event.preventDefault(); keyboardReview(event.key === 'a' ? 'approve' : 'reject'); }
    return;
  }
  const actions = {a: 'key-approve', d: 'key-deny', p: 'pause', x: 'stop', '/': 'focus-steer', t: 'term-expand'};
  if (data.capabilities?.verify_now) actions.v = 'verify-now';
  if (actions[event.key]) { event.preventDefault(); act(actions[event.key]).catch(e => pageError(e.message)); }
}

// ---------------------------------------------------------------------------
// Start-up and event wiring
// ---------------------------------------------------------------------------
async function onClick(event) {
  const b = event.target.closest('button');
  if (!b || b.disabled) return;
  try {
    if (b.dataset.theme) setTheme(b.dataset.theme);
    if (b.dataset.close) $(b.dataset.close).close();
    if (b.dataset.view) showView(b.dataset.view);
    if (b.dataset.action) await act(b.dataset.action, b);
    if (b.dataset.run) { selected = b.dataset.run; selectedTurn = null; termReset(null); showView('runs'); await refresh(); }
    if (b.dataset.turn) { selectedTurn = ['latest'].includes(b.dataset.turn) ? null : b.dataset.turn; if (data) renderRun(); }
    if (b.dataset.stageTab) showStage(b.dataset.stageTab);
    if (b.dataset.previewWidth) {
      preview.width = b.dataset.previewWidth;
      $('preview-frame').style.width = preview.width;
      document.querySelectorAll('[data-preview-width]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    }
    if (b.dataset.previewKey) await previewAction('input', {text: b.dataset.previewKey});
    if (b.dataset.desktopKey) { await previewAction('key', {key: b.dataset.desktopKey}); await refreshScreen(); }
    if (b.dataset.review) openReview(b.dataset.review, b.dataset.intent);
    if (b.dataset.diff) openDiff(b.dataset.diff);
    if (b.dataset.dismiss) { dismissedReceipts.add(b.dataset.dismiss); renderRun(); }
    if (b.dataset.step) { const el = $('max-prompts'); el.value = Math.max(1, Math.min(20, Number(el.value) + Number(b.dataset.step))); }
    if (b.closest('.xp-menu')) document.querySelectorAll('.xp-menu details[open]').forEach(e => { e.open = false; });
  } catch (error) { pageError(error.message); }
}
function trapDrawerFocus(event) {
  if (!$('sidebar').classList.contains('drawer-open')) return;
  if (event.key === 'Escape') { closeDrawer(); document.querySelector('[data-action="drawer"]').focus(); }
  if (event.key !== 'Tab') return;
  const focusable = [...$('sidebar').querySelectorAll('button:not(:disabled),a[href],input')].filter(e => e.getClientRects().length);
  const first = focusable[0], last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
function growSteering() {
  const field = $('steering');
  field.style.height = 'auto';
  if (field.scrollHeight) field.style.height = Math.min(200, field.scrollHeight) + 'px';
}
function fillExample() {
  $('goal').value = 'Build a small Python command-line todo app in demo_app/. It must add tasks, list tasks, mark tasks done, and save them to a JSON file. Use only the Python standard library. Include meaningful unittest tests. Preserve existing project files. Finish when the tests pass and a short usage README is present.';
  $('verify-enabled').checked = true; $('verify').disabled = false; $('verify').required = true;
  $('verify').value = "python3 -m unittest discover -s demo_app -p 'test_*.py'";
  $('new-checks').innerHTML = '';
  fillPreviewSpec('new', {mode: 'cli', command: 'python3 demo_app/todo.py', args: 'list'});
  ['Add, list, and complete tasks from the command line.', 'Save tasks to JSON and reload them.', 'Tests cover adding, completing, and save/reload behavior.', 'Document usage in demo_app/README.md.'].forEach(addCheckInput);
}
function init() {
  setTheme(document.documentElement.dataset.theme, false);
  setFavicon(0);
  if (key) { $('auth').classList.add('hidden'); $('boot').classList.remove('hidden'); }
  else showAuth();
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', handleShortcut);
  document.addEventListener('keydown', trapDrawerFocus);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); schedule(); connectEvents(); } });
  $('drawer-scrim').onclick = closeDrawer;
  $('auth-form').onsubmit = async event => {
    event.preventDefault();
    key = $('key').value.trim();
    saveKey(key, $('remember-key').checked);
    $('auth-error').textContent = 'Connecting…';
    await refresh();
    schedule();
    connectEvents();
  };
  $('new-form').onsubmit = async event => {
    event.preventDefault();
    $('start-error').textContent = '';
    if ($('verify-enabled').checked && !$('verify').value.trim()) { $('start-error').textContent = 'Enter a verification command or turn off independent verification.'; return; }
    if (preflight?.usable && preflight.dirty_count && !$('allow-dirty')?.checked) { $('start-error').textContent = 'Your project has uncommitted changes. Commit them, or tick “Start from my last commit anyway”.'; return; }
    $('start-run').disabled = true;
    try {
      const result = await api('/api/runs', 'POST', {goal: $('goal').value, verifier: $('verify-enabled').checked ? $('verify').value : '',
        max_steps: Number($('max-prompts').value), run_minutes: Number($('run-minutes').value),
        goal_checks: [...$('new-checks').querySelectorAll('textarea')].map(e => e.value.trim()), parent_run: parentRun,
        ...($('run-title').value.trim() ? {title: $('run-title').value.trim()} : {}),
        ...(readPreviewSpec('new').mode !== 'none' ? {preview: readPreviewSpec('new')} : {}),
        ...($('allow-dirty')?.checked ? {allow_dirty: true} : {}),
        ...runModeBody(),
        ...(preflight?.usable && $('setup-cmd').value.trim() ? {setup: $('setup-cmd').value.trim()} : {})});
      selected = result.id; parentRun = null; selectedTurn = null; $('run-title').value = '';
      showView('runs');
      await refresh();
      toast('Hermes is preparing the first turn.');
    } catch (error) { $('start-error').textContent = error.message; $('start-run').disabled = false; }
  };
  document.querySelectorAll('input[name="run-mode"]').forEach(radio => { radio.onchange = scheduleAutoPreview; });
  ['goal', 'verify', 'max-prompts'].forEach(id => $(id).addEventListener('input', scheduleAutoPreview));
  $('verify-enabled').onchange = () => { $('verify').disabled = !$('verify-enabled').checked; $('verify').required = $('verify-enabled').checked; };
  $('steering-form').onsubmit = async event => {
    event.preventDefault();
    const field = $('steering'), note = field.value.trim(), runId = current.id;
    try {
      await control('instruction', note, runId);
      if (field.value.trim() === note) { field.value = ''; growSteering(); }
      $('steering-feedback').textContent = 'Saved for the next Hermes prompt.';
    } catch (error) { $('steering-feedback').textContent = error.message; }
  };
  $('steering').addEventListener('input', growSteering);
  $('steering').addEventListener('keydown', event => {
    // Enter sends on devices with a keyboard; Shift+Enter keeps a newline. Phones keep Enter for newlines.
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !coarse && $('steering').value.trim()) { event.preventDefault(); $('steering-form').requestSubmit(); }
  });
  $('confirm-go').onclick = async () => {
    if (!confirming) return;
    $('confirm-go').disabled = true;
    try { await confirming(); $('confirm-dialog').close(); confirming = null; }
    catch (error) { $('confirm-error').textContent = error.message; }
    finally { $('confirm-go').disabled = false; }
  };
  $('confirm-stop').onclick = async () => {
    const id = stopRunId;
    $('confirm-stop').disabled = true;
    try { await control('stop', '', id); $('stop-dialog').close(); toast('Stop requested. Reconciling the OpenCode session.'); }
    catch (error) { $('stop-error').textContent = error.message; }
    finally { $('confirm-stop').disabled = false; }
  };
  $('rename-form').onsubmit = async event => {
    event.preventDefault();
    try { await control('title', $('rename-input').value, current.id); $('rename-dialog').close(); toast('Run renamed.'); }
    catch (error) { $('rename-error').textContent = error.message; }
  };
  $('check-form').onsubmit = async event => {
    event.preventDefault();
    try { await control('goal_check', $('criterion').value); $('criterion').value = ''; $('check-dialog').close(); toast('Goal check added for the next prompt.'); }
    catch (error) { $('check-error').textContent = error.message; }
  };
  $('review-body').addEventListener('input', event => {
    const i = event.target.dataset.custom;
    if (i !== undefined) { const choice = $('review-body').querySelector(`input[data-custom-choice="${i}"]`); if (choice) choice.checked = true; }
  });
  $('event-filter').onchange = renderActivity;
  $('event-search').addEventListener('input', () => data && renderActivity());
  $('run-filter').addEventListener('input', () => data && renderRecentRuns(data.inbox || []));
  $('example').onclick = fillExample;
  document.querySelectorAll('[data-preview-mode]').forEach(select => select.addEventListener('change', () => togglePreviewFields(select.id.split('-')[0])));
  togglePreviewFields('new');
  $('preview-input-form').onsubmit = async event => {
    event.preventDefault();
    try { await previewAction('input', {text: $('preview-input').value + '\n'}); $('preview-input').value = ''; } catch (error) { pageError(error.message); }
  };
  $('preview-args-form').onsubmit = async event => {
    event.preventDefault();
    try { await previewAction(previewLive() && previewForCurrent() ? 'restart' : 'start', {args: $('preview-args').value.trim()}); } catch (error) { pageError(error.message); }
  };
  $('desktop-type-form').onsubmit = async event => {
    event.preventDefault();
    if (!$('desktop-type').value) return;
    try { await previewAction('type', {text: $('desktop-type').value}); $('desktop-type').value = ''; await refreshScreen(); } catch (error) { pageError(error.message); }
  };
  $('preview-screen').addEventListener('click', screenClick);
  $('preview-screen').addEventListener('contextmenu', event => { event.preventDefault(); screenClick(event); });
  $('term-body').addEventListener('scroll', () => {
    const body = $('term-body'), atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
    if (atBottom !== term.follow) { term.follow = atBottom; $('term-follow').setAttribute('aria-pressed', String(atBottom)); }
    if (atBottom) $('term-jump').classList.add('hidden');
  });
  $('terminal-dialog').addEventListener('close', () => expandTerminal(false));
  $('stage-track').addEventListener('scroll', () => {
    const track = $('stage-track');
    if (track.scrollWidth <= track.clientWidth + 4) return;
    const index = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
    const name = STAGES[Math.min(STAGES.length - 1, index)][0];
    document.querySelectorAll('[data-stage-tab]').forEach(t => t.setAttribute('aria-selected', String(t.dataset.stageTab === name)));
  });
  refresh().then(() => { schedule(); connectEvents(); });
}
if (typeof document !== 'undefined') init();
if (typeof module !== 'undefined' && module.exports) module.exports = {stripAnsi, esc, duration, budget, stateLabel, requestKey, requestTitle, requestText, receiptLabel, verificationLabel, fileStats, phaseIndex, ignoresShortcut, shellQuote, relTime, runTitle, stageStates, transcriptOf, planningNext, nextDelay};
