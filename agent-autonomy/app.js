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

const VIEWS = ['mission', 'workspace', 'runs', 'approvals', 'activity', 'new', 'project', 'skills', 'usage'];
/* A pop-out (W5) is this page opened as ?popout=<agent>&run=<id>: one workspace, fed by the main
   dashboard over a BroadcastChannel (see workspace.js), with its own requests only as a fallback. */
const POPOUT = urlParam('popout'), relay = {seen: 0, boot: Date.now()};
function urlParam(name) { const m = String(globalThis.location?.search || '').match(new RegExp('[?&]' + name + '=([^&#]*)')); try { return m ? decodeURIComponent(m[1]) : ''; } catch { return ''; } }
/* True while a pop-out is (or may soon be) fed by the main window, so it fetches nothing itself. */
function relayFresh() { return !!POPOUT && (relay.seen ? Date.now() - relay.seen < 20000 : Date.now() - relay.boot < 1500); }
let key = readKey(), selected = POPOUT ? urlParam('run') : '', data = null, current = null, view = POPOUT ? 'workspace' : savedView();
let agentFilter = null;
let refreshing = false, connected = false, reviewBusy = false, reviewing = null, stopRunId = '', parentRun = null;
let refreshAgain = false;
let toastTimer, errorTimer, pollTimer, failures = 0, announcedRequests = '', diffText = '', lastStateTime = null;
let selectedTurn = null, shownStage = '';
let runScope = 'current', projectBrowse = null;   // run history: this project or all; the Projects dialog's folder
const seenRequests = new Set();
const balloon = {seen: new Set(), timer: 0};
const dismissedReceipts = new Set();

function savedView() { const v = readItem('local', 'ac-view'); return VIEWS.includes(v) && v !== 'new' ? v : 'mission'; }
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
/* "12m 0s of 30m 0s", or, past the limit, "30m limit · over by 3h 2m" (the limit includes time waiting for you). */
function budgetLabel(b) {
  return b.allowed && b.used > b.allowed ? `${duration(b.allowed)} limit · over by ${duration(b.used - b.allowed)}` : `${duration(b.used)} of ${duration(b.allowed)}`;
}
function overBudget(b) { return !!b.allowed && b.used > b.allowed; }
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
  if (POPOUT) return;   // the main dashboard already notifies
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
  return isLive() && ['runs', 'mission'].includes(view) ? 1000 : 2000;
}
function schedule(delay = nextDelay()) {
  clearTimeout(pollTimer);
  if (key) pollTimer = setTimeout(async () => { await refresh(); schedule(); }, delay);
}
/* Replace each {same: true} stub with the turn already held. False when one is missing. */
function mergeSteps(result) {
  if (!(result.steps || []).some(s => s.same)) return true;
  const held = new Map((data?.steps || []).map(s => [s.id, s]));
  if (result.steps.some(s => s.same && held.get(s.id)?.rev !== s.rev)) return false;
  result.steps = result.steps.map(s => s.same ? held.get(s.id) : s);
  return true;
}
/* Show a fresh /api/state snapshot (from our own request, or relayed by the main window). */
function applyState(result) {
  data = result; current = data.run; connected = true; failures = 0; lastStateTime = Date.now();
  $('auth').classList.add('hidden');
  $('boot').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('auth-error').textContent = '';
  render();
}
async function refresh() {
  if (!key || relayFresh()) return;
  // A change notice that arrives mid-refresh must not be lost: remember it and refresh once more.
  if (refreshing) { refreshAgain = true; return; }
  refreshing = true;
  const requestedRun = selected;
  try {
    // Turns the dashboard already holds are sent back as small stubs when unchanged (see mergeSteps).
    const known = data?.run && (!selected || data.run.id === selected) ? (data.steps || []).filter(s => s.rev !== undefined).map(s => s.id + ':' + s.rev).join(',') : '';
    const query = [selected && 'run=' + encodeURIComponent(selected), runScope === 'all' && 'scope=all', known && 'known=' + encodeURIComponent(known)].filter(Boolean).join('&');
    let result = await api('/api/state' + (query ? '?' + query : ''));
    if (requestedRun !== selected) return;
    if (!mergeSteps(result)) {
      // A stub for a turn this page no longer holds: ask once more, in full.
      result = await api('/api/state' + (query ? '?' + query.replace(/&?known=[^&]*/, '') : ''));
      if (requestedRun !== selected) return;
    }
    applyState(result);
    globalThis.wsRelayPost?.();   // pop-outs showing this run get the same snapshot, without a request of their own
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
  if (relayFresh()) return;   // a pop-out fed by the main window needs no stream of its own
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
  renderMission();
  globalThis.renderWorkspace?.();
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
  renderIsolation();
  renderModelsPicker();

  const crumbs = [project, {mission: 'Mission', workspace: 'Workspace', new: 'New run', runs: 'Runs', approvals: 'Approvals', activity: 'Activity', project: 'Project', skills: 'Skills', usage: 'Usage'}[view]];
  if (current && !['new', 'mission'].includes(view)) crumbs.push('#' + current.id.slice(0, 6));
  if (view === 'runs' && agentFilter) crumbs.push('Agent · ' + agentFilter);
  if (view === 'workspace' && current && globalThis.workspaceActive?.()) crumbs.push(workspaceActive());
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
  const budgetText = current ? `${data.steps.length}/${current.max_steps} prompts · ${overBudget(b) ? budgetLabel(b) : `${duration(b.used)} / ${duration(b.allowed)}`}` : '';
  $('terminal-budget').textContent = budgetText;
  $('xp-budget').textContent = budgetText;
  $('xp-status').textContent = connected ? state.text : 'Reconnecting';
  $('xp-folder').textContent = data.project;

  const waitingSkills = pendingSkills().length + researchRequests().length, waiting = inbox.length + waitingSkills;
  $('nav-count').textContent = waiting;
  $('nav-count').classList.toggle('hidden', !waiting);
  $('tab-count').textContent = waiting;
  $('tab-count').classList.toggle('hidden', !waiting);
  $('approval-total').textContent = `${waiting} pending`;
  $('tray-count').textContent = inbox.length ? `⚠ ${inbox.length}` : '';
  $('tray-clock').textContent = new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
  // XP's balloon pops up for a request you have not seen yet, then hides itself; the tray keeps the count.
  const keys = inbox.map(requestKey), unseen = keys.filter(k => !balloon.seen.has(k));
  balloon.seen = new Set(keys);
  if (!inbox.length) { clearTimeout(balloon.timer); $('xp-notification').classList.add('hidden'); }
  else if (unseen.length) {
    $('notification-text').textContent = requestTitle(inbox.find(p => unseen.includes(requestKey(p))));
    $('xp-notification').classList.remove('hidden');
    clearTimeout(balloon.timer);
    balloon.timer = setTimeout(() => $('xp-notification').classList.add('hidden'), 8000);
  }
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
function projectLabel(path) { return path ? path.split('/').filter(Boolean).pop() : 'project not recorded'; }
function activeRun() { return (data?.runs || []).find(r => !ended.has(r.status)); }
async function loadProjectFolder(path = '') {
  $('projects-error').textContent = '';
  try { projectBrowse = await api('/api/projects/browse' + (path ? '?path=' + encodeURIComponent(path) : '')); renderProjects(); }
  catch (error) { $('projects-error').textContent = error.message; }
}
function renderProjects() {
  if (!projectBrowse || !data) return;
  const busy = activeRun(), root = projectBrowse.root;
  $('projects-current').textContent = data.project;
  $('projects-root-prefix').textContent = root.replace(/\/$/, '') + '/';
  $('projects-blocked').classList.toggle('hidden', !busy);
  $('projects-blocked').textContent = busy ? `Finish or stop “${runTitle(busy, 60)}” before switching or creating a project.` : '';
  ['project-create', 'project-use-browsed'].forEach(id => { $(id).disabled = !!busy; });
  const atRoot = projectBrowse.path === root;
  $('project-use-browsed').classList.toggle('hidden', atRoot);   // your whole home folder is never meant as a project
  $('project-use-browsed').dataset.path = projectBrowse.path;
  $('project-use-browsed').textContent = projectBrowse.path === data.project ? 'Current project' : `Use ${projectLabel(projectBrowse.path)}`;
  if (projectBrowse.path === data.project) $('project-use-browsed').disabled = true;
  const rel = projectBrowse.path.slice(root.length).split('/').filter(Boolean);
  const crumbs = [[root, '~']].concat(rel.map((part, i) => [root + '/' + rel.slice(0, i + 1).join('/'), part]));
  setHTML($('projects-crumbs'), crumbs.map(([path, name]) => `<button class="link-button" data-action="project-open" data-path="${esc(path)}">${esc(name)}</button>`).join(' / '));
  const rows = projectBrowse.entries.map(e => `<div class="project-row"><button class="project-folder" data-action="project-open" data-path="${esc(e.path)}">
      <svg class="icon" aria-hidden="true"><use href="#icon-folder"/></svg><span>${esc(e.name)}</span>${e.git ? '<span class="chip">git</span>' : ''}${e.path === data.project ? '<span class="chip">current</span>' : ''}</button>
      <button class="ac-btn small-btn" data-action="project-use" data-path="${esc(e.path)}" ${busy || e.path === data.project ? 'disabled' : ''}>Use</button></div>`);
  if (projectBrowse.parent) rows.unshift(`<div class="project-row"><button class="project-folder" data-action="project-open" data-path="${esc(projectBrowse.parent)}"><span>..</span><span class="muted small">up</span></button></div>`);
  setHTML($('projects-list'), rows.join('') || '<p class="small muted">No folders here.</p>');
}
async function useProject(result, message) {
  $('projects-dialog').close();
  selected = ''; selectedTurn = null; agentFilter = null; termReset(null);
  toast(message + (result.git ? '' : ' It has no git repository: runs change the folder directly and team runs are off.'));
  await refresh();
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
      <span><span class="run-name">${esc(runTitle(r, 90))}</span><small>${runScope === 'all' ? esc(projectLabel(r.project)) + ' · ' : ''}${esc(s.text)} · ${r.prompt_count ?? '—'} prompt${r.prompt_count === 1 ? '' : 's'} · ${esc(relTime(r.created))}</small></span>
    </button>`;
  }).join('') || `<p class="small muted">${query ? 'No runs match this filter.' : runScope === 'all' ? 'Your runs will appear here.' : 'No runs in this project yet.'}</p>`);
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
  if (!current) { agentFilter = null; return; }
  const all = data.steps || [], coder = coderFilter(), finished = ended.has(current.status);
  if (agentFilter && !coder && agentFilter !== 'hermes') agentFilter = null;
  const steps = coder ? agentSteps() : all, pending = runRequests().filter(p => !coder || (p.agent || 'coder-1') === coder);
  renderAgentHead();
  renderRunHeader(all, runRequests(), finished);
  renderOutcome(all, finished);
  renderWorkflow(steps, pending, finished);
  $('steering').placeholder = coder ? `A note about ${coder} for Hermes. Hermes decides what ${coder} is told.` : 'Tell Hermes something. It goes into the next prompt.';
  $('steering-form').classList.toggle('hidden', finished);
  $('steering-form').querySelectorAll('button').forEach(button => { button.disabled = !connected || (button.dataset.action === 'verify-now' && !canVerifyNow()); });
  const asks = researchRequests(current.id).filter(r => !agentFilter || r.agent === agentFilter);
  setHTML($('inline-approvals'), pending.map(approvalCard).join('') + asks.map(r => researchCard(r, 'inline')).join('') || (finished ? '' : recentDecisionHTML()));
  if (coder) setHTML($('team-panel'), ''); else renderTeam();
  renderChecks();
  renderVerification();
  renderModelUsage();
  renderBranch();
  renderContainer();
  renderVm();
  renderSpecialistPanels();
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
    <div class="run-meta"><span class="mono">${esc(data.project)}</span><span class="${overBudget(b) ? 'warning-text' : ''}">${budgetLabel(b)}</span>
      <span>${finished ? 'Used' : 'Prompt'} ${steps.length} of ${current.max_steps}</span><span>Started ${when(current.created)}</span></div>
    ${current.parent_run ? `<p class="small muted">Follow-up to <button class="text-button" data-run="${esc(current.parent_run)}">#${esc(current.parent_run.slice(0, 6))}</button></p>` : ''}
    <details class="brief" data-key="brief-${esc(current.id)}"><summary>Read brief</summary><p>${esc(current.goal)}</p></details>
    <div class="xp-only xp-time-meter ${overBudget(b) ? 'over' : ''}" role="progressbar" aria-label="Run time budget used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(percent)}"><span style="width:${percent}%"></span></div>
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
  const next = planningNext(current, data.steps || []) && !(coderFilter() && isTeam());
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
    const role = step?.role || roleOf(step?.agent);
    const actor = name === 'code' && role === 'researcher' ? 'Hermes · web research' : name === 'code' && role === 'reviewer' ? 'OpenCode · read-only' : who;
    const by = name === 'code' && step && (isTeam() || role !== 'coder') ? `${actor} · ${agentName(step.agent)}` : actor;
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
/* A live terminal view over one agent's recorded turns (OpenCode text and tool parts only).
   The Runs page has one; every workspace pane makes its own, so each keeps its own scroll and follow state. */
function makeTerm(els, label = () => 'opencode') {
  const t = {turn: null, count: 0, omitted: 0, last: '', follow: true, els};
  t.reset = turn => { t.turn = turn; t.count = 0; t.omitted = 0; t.last = ''; const e = els(); if (e.body) e.body.innerHTML = ''; };
  t.setFollow = on => {
    t.follow = on;
    const e = els();
    e.follow?.setAttribute('aria-pressed', String(on));
    if (on && e.body) { e.body.scrollTop = e.body.scrollHeight; e.jump?.classList.add('hidden'); }
  };
  t.onScroll = () => {
    const e = els(), atBottom = e.body.scrollHeight - e.body.scrollTop - e.body.clientHeight < 24;
    if (atBottom !== t.follow) { t.follow = atBottom; e.follow?.setAttribute('aria-pressed', String(atBottom)); }
    if (atBottom) e.jump?.classList.add('hidden');
  };
  t.render = (step, state, pending, isLast) => {
    const e = els();
    if (!e.body) return;
    const running = ['active', 'waiting'].includes(state);
    const entries = transcriptOf(step);
    const omitted = step?.transcript_omitted || 0;
    if (t.turn !== (step?.id || 'next') || entries.length < t.count || omitted !== t.omitted) t.reset(step?.id || 'next');
    t.omitted = omitted;
    const body = e.body, atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
    let changed = false;
    entries.forEach((entry, i) => {
      const html = termEntryHTML(entry, running);
      if (i < t.count - 1) return;
      if (i === t.count - 1) {
        if (html === t.last) return;
        // Replace the last entry in place; it is the one that grows while OpenCode works.
        const wasOpen = body.lastElementChild?.querySelector?.('details')?.open || body.lastElementChild?.open;
        body.querySelectorAll(`[data-entry="${i}"]`).forEach(x => x.remove());
        body.insertAdjacentHTML('beforeend', `<div class="term-entry" data-entry="${i}">${html}</div>`);
        if (wasOpen) body.lastElementChild.querySelector('details')?.setAttribute('open', '');
      } else body.insertAdjacentHTML('beforeend', `<div class="term-entry" data-entry="${i}">${html}</div>`);
      t.last = html; changed = true;
    });
    t.count = entries.length;
    const held = isLast && running ? pending.map(p => `<div class="term-line term-held"><span class="term-prompt">!</span><span class="term-cmd">${esc(requestText(p))}</span><button class="term-review" data-review="${esc(requestKey(p))}">Review</button></div>`).join('') : '';
    setHTML(e.held, held);
    const empty = !entries.length && !held;
    e.empty.textContent = !step ? 'OpenCode output appears here once Hermes sends the next prompt.' : ['prepared', 'dispatching'].includes(step.status) ? 'Sending the prompt to OpenCode…' : 'No OpenCode output was recorded for this turn.';
    e.empty.classList.toggle('hidden', !empty);
    e.box.classList.toggle('running', running);
    e.box.dataset.state = state;
    const tools = entries.filter(x => x.type === 'tool').length;
    const end = step?.ended ? Date.parse(step.ended) : Date.now();
    const elapsed = step ? duration((end - Date.parse(step.created)) / 1000) : '—';
    e.title.textContent = step ? `${label()} — turn ${step.number}` : `${label()} — waiting`;
    e.meta.textContent = `${state === 'waiting' ? 'waiting on you' : running ? 'running' : state === 'failed' ? 'failed' : step ? 'idle' : 'queued'} · ${elapsed} · ${plural(tools, 'tool call')}${omitted ? ` · ${omitted} earlier hidden` : ''}`;
    if (changed || held) {
      if (t.follow || atBottom) body.scrollTop = body.scrollHeight;
      else e.jump?.classList.remove('hidden');
    }
  };
  t.text = steps => transcriptOf((steps || []).find(x => x.id === t.turn)).map(x => x.type === 'text' ? x.text : `${TOOL_SYMBOL[x.tool] || '•'} ${x.tool === 'bash' ? '' : x.tool + ' '}${x.summary || ''}${x.output ? '\n' + x.output : ''}`).join('\n');
  return t;
}
const term = makeTerm(() => ({box: $('term'), body: $('term-body'), held: $('term-held'), empty: $('term-empty'), title: $('term-title'), meta: $('term-meta'), jump: $('term-jump'), follow: $('term-follow')}));
function termReset(turn) { term.reset(turn); }
function renderTerminal(step, state, pending, isLast) { term.render(step, state, pending, isLast); }
function terminalText() { return term.text(data?.steps); }
function setFollow(on) { term.setFollow(on); }
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
  // Until a check has actually been evaluated, it is a saved requirement, not "0 of N": no progress bar that reads as failing.
  const evaluated = checks.some(c => ['passed', 'failed'].includes(c.status));
  if (checks.length && !evaluated) {
    setHTML($('goal-checks'), `<section class="ac-panel"><h2 class="ac-panel__title">Goal checks <span class="muted">· ${plural(checks.length, 'saved requirement')}</span></h2>
      ${list}<p class="small muted">Not checked one by one yet. Hermes works toward them; your verification command is the independent check.</p></section>`);
    return;
  }
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
  if (!usage?.total?.calls && !endpoint && !data.spend?.cap) { setHTML($('model-usage'), ''); return; }
  const queue = endpoint ? `<p class="small muted">${esc(endpoint.id)} · ${endpoint.in_flight.length} of ${endpoint.slots} busy${endpoint.queued.length ? ` · ${endpoint.queued.length} waiting (${esc(endpoint.queued.map(q => q.agent).join(', '))})` : ''}${models.gateway ? ' · gateway on' : ''}</p>` : '';
  const agents = Object.entries(usage?.by_agent || {}).filter(([name]) => !coderFilter() || [coderFilter(), 'hermes'].includes(name)).map(([name, u]) => `<div class="usage-row"><span>${esc(name)}</span><span class="mono small">${u.calls} call${u.calls === 1 ? '' : 's'} · ${tokens(u.tokens_in)} in · ${tokens(u.tokens_out)} out${u.queued_ms ? ` · waited ${Math.round(u.queued_ms / 1000)} s` : ''}${u.cost > 0 ? ` · ${money(u.cost, 4)}` : ''}</span></div>`).join('');
  const total = usage?.total || {calls: 0, cost: 0};
  setHTML($('model-usage'), `<section class="ac-panel"><h2 class="ac-panel__title">Model usage</h2>${queue}
    ${agents || '<p class="small muted">Token counts appear after Hermes or OpenCode finish a call.</p>'}
    ${spendHTML() || `<p class="small muted">${total.cost > 0 ? `Spend on paid providers: $${total.cost.toFixed(4)}` : 'Local model · no spend'}</p>`}</section>`);
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
// ---- mission control (M11) -------------------------------------------------
// Everything here is drawn from /api/state; nothing is sent to an agent from this view.
const AGENT_STATE = {working: ['Working', 'running'], waiting_on_you: ['Waiting on you', 'attention'], needs_attention: ['Needs attention', 'attention'],
  paused: ['Paused', ''], idle: ['Idle', ''], finished: ['Finished', 'completed'], failed: ['Failed', 'failed'], stopped: ['Stopped', ''],
  blocked: ['Blocked', 'attention'], limit_reached: ['Budget used', 'attention']};
function coderFilter() {
  if (!agentFilter || agentFilter === 'hermes' || !current) return null;
  return missionAgents().some(a => a.name === agentFilter) ? agentFilter : null;
}
function agentSteps(name = coderFilter()) { return (data?.steps || []).filter(s => (s.agent || 'coder-1') === name); }
function missionAgents() {
  if (!current) return [];
  if ((data.agents || []).length) return data.agents;
  const coders = Object.keys(current.team?.agents || {}).length ? Object.keys(current.team.agents) : ['coder-1'];
  return [{name: 'hermes', type: 'orchestrator', role: 'Orchestrator', state: 'idle'}, ...coders.map(name => ({name, type: 'coder', role: 'Coder', state: 'idle'}))];
}
function agentUsage(name) {
  const by = data.usage?.by_agent || {};
  return by[name] || (name === 'coder-1' && !isTeam() ? by.opencode : null);
}
function agentRequests(name) {
  return runRequests().filter(p => name === 'hermes' ? false : (p.agent || 'coder-1') === name);
}
function openAgent(name) {
  agentFilter = name; selectedTurn = null; termReset(null);
  showView('runs');
  if (data) renderRun();
  if (name !== 'hermes') showStage('code', false);  // on phones the terminal comes first
  $('workspace').scrollTop = 0;
}
/* The last few lines of an agent's latest turn, as plain one-line entries. */
function transcriptTail(step, count = 6) {
  return transcriptOf(step).slice(-count).map(e => {
    if (e.type === 'text') return {cls: 'text', text: String(e.text || '').trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 200)};
    const tool = e.tool || 'tool';
    return {cls: 'tool ' + (e.status || ''), text: `${TOOL_SYMBOL[tool] || '•'} ${tool === 'bash' ? '' : tool + ' '}${e.summary || e.title || ''}`.slice(0, 200)};
  }).filter(e => e.text);
}
function agentCard(a) {
  const name = a.name, hermes = a.type === 'orchestrator', finished = ended.has(current.status);
  const [label, tone] = AGENT_STATE[a.state] || [String(a.state || 'idle').replaceAll('_', ' '), ''];
  const step = hermes ? null : [...(data.steps || [])].reverse().find(s => (s.agent || 'coder-1') === name);
  const role = roleOf(name);
  const lines = hermes || role === 'researcher' ? [] : transcriptTail(step);
  const u = agentUsage(name), waiting = agentRequests(name).length;
  const teamWaiting = hermes && current.status === 'awaiting_approval';
  const ws = current.workspace?.agents?.[name], skills = (data.skills?.installs || []).filter(i => i.agent === name && i.state === 'installed').length;
  const title = current.team?.agents?.[name]?.label;
  const stats = [
    u ? `${tokens(u.tokens_in)} in · ${tokens(u.tokens_out)} out` : 'no model calls yet',
    hermes ? plural(current.decision_count || 0, 'decision') : `${plural(a.stats?.turns ?? agentSteps(name).length, 'turn')} · ${plural(a.stats?.tool_calls || 0, 'tool call')}`];
  const where = hermes ? `<span>${esc(data.profile || 'Hermes')}</span>` : role === 'researcher' ? '<span>scratch folder · no project files</span>'
    : `${ws?.branch ? `<span class="mono">${esc(ws.branch)}</span>` : '<span>project folder</span>'}${current.isolation === 'container' ? '<span>in container</span>' : ''}${skills ? `<span>${plural(skills, 'skill')}</span>` : ''}`;
  const body = role === 'researcher'
    ? `<p class="small agent-task">${esc(step ? step.question || step.title : 'No question yet')}</p>
      <p class="small ${step?.status === 'awaiting_approval' ? 'warning-text' : 'muted'}">${esc(step?.report?.summary?.slice(0, 220) || {awaiting_approval: 'Waiting for your approval.', researching: 'Researching…', rejected: 'You declined it.', failed: 'Did not finish.'}[step?.status] || 'Runs only after you approve each question.')}</p>
      ${step?.report?.sources?.length ? `<p class="small muted">${plural(step.report.sources.length, 'source')}</p>` : ''}`
    : hermes
    ? `<p class="small">${esc(a.task || (finished ? current.summary : current.summary || 'Waiting for the next decision.'))}</p>${(current.plan || []).length ? `<ol class="mission-plan small">${current.plan.slice(0, 4).map(p => `<li>${esc(typeof p === 'string' ? p : p.title || pretty(p))}</li>`).join('')}</ol>` : ''}`
    : `<p class="small agent-task">${esc(a.task || (step ? `Turn ${step.number}: ${step.title}` : 'No turn yet'))}</p>
      ${role === 'reviewer' && step?.findings ? `<p class="small">${esc({ok: 'No problems found', changes: plural(step.findings.findings.length, 'finding'), unknown: 'Unstructured review'}[step.findings.verdict] || '')}</p>` : ''}
      <pre class="mission-tail" aria-label="Latest output from ${esc(name)}">${lines.length ? lines.map(l => `<span class="${esc(l.cls)}">${esc(l.text)}</span>`).join('\n') : '<span class="muted">No output yet.</span>'}</pre>`;
  return `<article class="agent-card ${tone}" data-agent-card="${esc(name)}">
    <header class="agent-card__head"><span class="agent-avatar ${hermes ? 'hermes' : 'opencode'} role-${esc(roleOf(name))}">${esc(roleMark(name))}</span>
      <button class="agent-card__name" data-agent="${esc(name)}" aria-label="Open ${esc(name)}"><strong>${esc(hermes ? 'Hermes' : name)}</strong><small>${esc(title || a.role || (hermes ? 'Orchestrator' : 'Coder'))}</small></button>
      <span class="ac-status ${tone}" ${a.since ? `title="${esc(label)} since ${esc(new Date(a.since).toLocaleString())}"` : ''}><span class="dot"></span>${esc(label)}</span></header>
    ${body}
    <footer class="agent-card__foot"><span class="small muted">${stats.map(esc).join(' · ')}</span><span class="agent-where small muted">${where}</span>
      <button class="ac-btn compact" data-workspace="${esc(name)}" aria-label="Open ${esc(hermes ? 'Hermes' : name)}'s workspace">Workspace</button>
      ${waiting ? `<button class="ac-btn compact attention-button" data-view="approvals">${plural(waiting, 'request')} waiting</button>` : ''}
      ${teamWaiting ? '<button class="ac-btn compact attention-button" data-view="runs">Team plan needs you</button>' : ''}
      ${researchRequests(current.id).some(r => r.agent === name) ? '<button class="ac-btn compact attention-button" data-view="approvals">Approve the question</button>' : ''}</footer>
  </article>`;
}
function taskDepths(tasks) {
  const byId = Object.fromEntries(tasks.map(t => [t.id, t])), depth = {};
  const of = (id, seen = new Set()) => {
    if (depth[id] !== undefined) return depth[id];
    if (seen.has(id) || !byId[id]) return 0;
    seen.add(id);
    return depth[id] = Math.max(0, ...(byId[id].depends_on || []).map(d => of(d, seen) + 1));
  };
  tasks.forEach(t => of(t.id));
  return depth;
}
function renderMissionTasks() {
  const tasks = current.team?.tasks || [];
  if (isTeam() && tasks.length) {
    const depth = taskDepths(tasks), columns = [];
    tasks.forEach(t => (columns[depth[t.id]] ||= []).push(t));
    const done = tasks.filter(t => t.status === 'done').length;
    const cols = columns.map((col, i) => `<div class="task-col" role="list" aria-label="${i ? `After step ${i}` : 'Can start now'}">${col.map(t => {
      const inner = `<span class="mono small">${esc(t.id)}</span><strong>${esc(t.title)}</strong><small>${esc(agentName(t.agent))}</small><small class="${TASK_TONE[t.status] || ''}">${esc(t.status || 'waiting')}${t.attempts > 1 ? ` · ${t.attempts} tries` : ''}</small>`;
      const node = t.steps?.length ? `<button class="task-node ${esc(t.status || '')}" data-turn="${esc(t.steps.at(-1))}" aria-label="Task ${esc(t.id)}: ${esc(t.title)}, ${esc(t.status)}">${inner}</button>`
        : `<div class="task-node ${esc(t.status || '')}">${inner}</div>`;
      return `<div role="listitem" class="task-item">${node}${t.agent ? `<button class="text-button small task-ws" data-workspace="${esc(t.agent)}" aria-label="Open ${esc(agentName(t.agent))}'s workspace">Workspace ›</button>` : ''}</div>`;
    }).join('')}</div>`).join('<span class="task-arrow" aria-hidden="true">→</span>');
    return `<section class="ac-panel"><h2 class="ac-panel__title">Tasks <span class="muted small">· ${done} of ${tasks.length} done</span></h2><div class="task-graph">${cols}</div>
      <p class="small muted">A task starts once the tasks it depends on are merged. Select a task to open its latest turn.</p></section>`;
  }
  const steps = data.steps || [];
  const rows = steps.slice(-8).reverse().map(s => `<button class="turn-row" data-turn="${esc(s.id)}"><span class="chip-number">${s.number}</span><span><strong>${esc(s.title)}</strong><small class="muted">${isTeam() ? esc(agentName(s.agent)) + ' · ' : ''}${esc(verificationLabel(s))}</small></span></button>`).join('');
  return `<section class="ac-panel"><h2 class="ac-panel__title">Turns <span class="muted small">· ${steps.length} of ${current.max_steps}</span></h2>
    ${rows || '<p class="small muted">Hermes is preparing the first turn.</p>'}</section>`;
}
function renderMissionResources() {
  const endpoint = (data.models?.endpoints || []).find(e => e.default), c = data.container, p = previewStatus();
  const model = endpoint ? `<dt>Model</dt><dd>${esc(endpoint.id)} · ${endpoint.health?.state === 'online' ? '<span class="success-text">online</span>' : esc(endpoint.health?.state || 'unchecked')}
      <small class="muted">${endpoint.in_flight.length} of ${endpoint.slots} slot${endpoint.slots === 1 ? '' : 's'} busy${endpoint.in_flight.length ? ` (${esc(endpoint.in_flight.map(x => x.agent).join(', '))})` : ''}${endpoint.queued.length ? ` · waiting: ${esc(endpoint.queued.map(x => x.agent).join(', '))}` : ''}</small></dd>`
    : `<dt>Model</dt><dd>${esc(data.health.agents?.opencode?.label ? 'OpenCode’s configured model' : 'Not described')} <small class="muted">Describe it in state/models.json to see the queue.</small></dd>`;
  const box = c ? `<dt>Container</dt><dd>${esc({running: 'Running', exited: 'Stopped', removed: 'Removed', pending: 'Starts with the first turn', missing: 'Not created yet'}[c.live] || c.live)}
      <small class="muted">${esc(c.runtime)}${c.rootless ? ' · rootless' : ''} · ${esc(String(c.cpus))} CPUs · ${esc(String(c.memory_gb))} GB · network ${c.network === 'internet' ? 'on' : c.network_cut || c.network === 'none' ? 'off' : 'on for setup'}</small></dd>`
    : `<dt>Isolation</dt><dd>This machine <small class="muted">Agents run under your OpenCode permissions.</small></dd>`;
  const mine = p.run === current.id && previewLive(p);
  const previewLine = `<dt>Preview</dt><dd>${mine ? `<span class="success-text">${esc(p.state)}</span> · ${esc(p.mode)}` : current.preview ? esc(current.preview.mode) + ' · not running' : 'None set'}
      <button class="text-button small" data-view="project">Open Project</button></dd>`;
  const s = data.spend || {};
  const spend = s.cap || s.run ? `<dt>Spend</dt><dd>${money(s.run, 4)}${s.cap ? ` of ${money(s.cap)} cap` : ''}</dd>` : '';
  return `<section class="ac-panel"><h2 class="ac-panel__title">Resources</h2><dl class="facts small">${model}${box}${spend}${previewLine}</dl></section>`;
}
function renderMission() {
  const finished = !current || ended.has(current.status);
  const waiting = (data.inbox || []).length + pendingSkills().length + researchRequests().length;
  if (!current) {
    setHTML($('mission-head'), `<section class="ac-panel mission-empty"><div class="eyebrow">Mission control</div><h1 id="mission-title">No run yet</h1>
      <p class="muted">Start a run to see Hermes and every coder here, live.</p><button class="ac-btn primary" data-action="new">Start a new run</button></section>`);
    ['mission-agents', 'mission-tasks', 'mission-resources', 'mission-activity'].forEach(id => setHTML($(id), ''));
    return;
  }
  const b = budget(current), steps = data.steps || [];
  const canResume = current.pause || ['interrupted', 'attention'].includes(current.status);
  const controls = finished ? `<button class="ac-btn" data-action="new">New run</button><button class="ac-btn" data-action="followup">Follow-up run</button>`
    : `<button class="ac-btn compact" data-action="pause">${icon(canResume ? 'play' : 'pause')}<span>${canResume ? 'Resume' : 'Pause'}</span></button><button class="ac-btn compact danger-button" data-action="stop">${icon('stop')}<span>Stop</span></button>`;
  setHTML($('mission-head'), `<section class="mission-head">
    <div class="mission-title"><div class="eyebrow">Mission control${finished ? ' · last run' : ''}</div>
      <h1 id="mission-title">${esc(runTitle(current, 120))}</h1>
      <p class="small muted">${statusHTML(current, runRequests())} <span>${isTeam() ? plural(Object.keys(current.team?.agents || {}).length, 'agent') : 'One coder'}</span> · <span>${steps.length} of ${current.max_steps} prompts</span> · <span class="${overBudget(b) ? 'warning-text' : ''}">${budgetLabel(b)}</span></p>
      <p class="small">${esc(current.summary)}</p></div>
    <div class="mission-actions row wrap">${waiting ? `<button class="ac-btn primary" data-view="approvals" aria-live="polite">${plural(waiting, 'item')} waiting for you</button>` : '<span class="small muted" aria-live="polite">Nothing waiting for you</span>'}
      <button class="ac-btn" data-run="${esc(current.id)}">Open run</button>${controls}</div></section>`);
  setHTML($('mission-agents'), missionAgents().map(agentCard).join(''));
  setHTML($('mission-tasks'), renderMissionTasks());
  setHTML($('mission-resources'), renderMissionResources());
  // State changes are listed on the Activity page and in each workspace; here they would crowd out the rest.
  const events = (data.events || []).filter(e => e.kind !== 'agent state').slice(-8).reverse().map(e => {
    let parsed; try { parsed = JSON.parse(e.detail); } catch {}
    return `<li><span class="muted small">${when(e.created)}</span> <strong class="small">${esc(e.kind)}</strong> <span class="small">${esc(String(eventSummary(e, parsed) || '').slice(0, 160))}</span></li>`;
  }).join('');
  setHTML($('mission-activity'), `<section class="ac-panel"><h2 class="ac-panel__title">Latest activity <button class="text-button small" data-view="activity">All activity</button></h2>
    ${events ? `<ul class="mission-events">${events}</ul>` : '<p class="small muted">Nothing recorded yet.</p>'}</section>`);
}
function renderAgentHead() {
  if (!agentFilter || !current) { setHTML($('agent-head'), ''); return; }
  const agents = missionAgents(), a = agents.find(x => x.name === agentFilter);
  if (!a) { setHTML($('agent-head'), ''); return; }
  const [label, tone] = AGENT_STATE[a.state] || [String(a.state || 'idle'), ''];
  const hermes = a.type === 'orchestrator', ws = current.workspace?.agents?.[a.name];
  const switcher = agents.map(x => `<button class="ac-btn compact ${x.name === a.name ? 'primary' : ''}" data-agent="${esc(x.name)}" aria-pressed="${x.name === a.name}">${esc(x.name === 'hermes' ? 'Hermes' : x.name)}</button>`).join('');
  setHTML($('agent-head'), `<section class="agent-head ac-panel">
    <div class="row wrap between"><button class="text-button" data-action="agent-clear">← Mission</button><div class="row wrap agent-switch" role="group" aria-label="Agents">${switcher}</div></div>
    <div class="agent-head__id"><span class="agent-avatar ${hermes ? 'hermes' : 'opencode'}">${esc(hermes ? 'H' : a.name.replace(/\D/g, '') || 'C')}</span>
      <div><h2>${esc(hermes ? 'Hermes' : agentName(a.name))} <span class="ac-status ${tone}"><span class="dot"></span>${esc(label)}</span></h2>
      <p class="small muted">${esc(a.role || '')}${a.runtime ? ' · ' + esc(a.runtime) : ''}${a.model ? ' · ' + esc(a.model) : ''}${ws?.branch ? ` · <span class="mono">${esc(ws.branch)}</span>` : ''}${current.isolation === 'container' ? ' · in the run’s container' : ''}</p>
      ${a.task ? `<p class="small">${esc(a.task)}</p>` : ''}</div></div>
    <p class="small muted">${hermes ? 'Hermes plans every turn below; notes you send go to it directly.' : `Showing only ${esc(a.name)}’s turns, requests and changes. Notes you send go to Hermes, marked for ${esc(a.name)}; Hermes decides what ${esc(a.name)} is told.`}</p>
  </section>`);
}
// ---- specialists, models and spend (M12) ------------------------------------
const ROLE_NAMES = ['coder', 'tester', 'reviewer', 'researcher'];
function roleOf(name) {
  if (name === 'hermes') return 'orchestrator';
  const base = String(name || 'coder-1').replace(/-\d+$/, '');
  return ROLE_NAMES.includes(base) ? base : 'coder';
}
function roleMark(name) {
  const role = roleOf(name);
  return role === 'orchestrator' ? 'H' : role === 'tester' ? 'T' : role === 'reviewer' ? 'Rv' : role === 'researcher' ? 'W' : (name.replace(/\D/g, '') || 'C');
}
function researchRequests(run = null) { return (data?.research_requests || []).filter(r => !run || r.run === run); }
function money(n, digits = 2) { return '$' + Number(n || 0).toFixed(digits); }
function researchCard(r, where = 'list') {
  const id = esc(r.step), field = esc(`research-confirm-${where}-${r.step}`);
  return `<article class="approval-card research-card" tabindex="-1" data-research-card="${id}">
    <div class="approval-titlebar">Research needs your approval</div>
    <div class="row between"><div class="approval-icon">${icon('shield')}</div><span class="risk-badge risk-critical">R3 · Critical</span></div>
    <h2>Let ${esc(r.agent)} look this up on the web?</h2>
    <pre class="command">${esc(r.question)}</pre>
    ${r.why && r.why !== r.question ? `<p class="small"><strong>Why:</strong> ${esc(r.why.slice(0, 600))}</p>` : ''}
    <p class="small">Hermes browses the internet <strong>from this machine</strong> with only these toolsets: <span class="mono">${esc((r.toolsets || []).join(', '))}</span>. At most ${esc(String(r.max_turns))} steps and ${Math.round((r.seconds || 0) / 60)} minutes. It gets no project files, shell or file tools. The question may reach search engines and websites.</p>
    <label for="${field}" class="small">Type <strong>approve</strong> to allow it</label>
    <input id="${field}" autocomplete="off" placeholder="approve">
    <p class="error small" role="alert"></p>
    <div class="approval-actions"><button class="ac-btn" data-action="research-reject" data-step="${id}" data-research-run="${esc(r.run)}" data-fp="${esc(r.fingerprint)}">Decline</button>
      <button class="ac-btn primary" data-action="research-approve" data-step="${id}" data-research-run="${esc(r.run)}" data-fp="${esc(r.fingerprint)}">Approve research</button></div>
    <p class="policy-note">Run #${esc(r.run.slice(0, 6))} · ${esc(r.agent)} · The report comes back labelled as untrusted web content.</p>
  </article>`;
}
async function researchDecision(button, action) {
  const card = button.closest('[data-research-card]'), step = button.dataset.step;
  const confirm = card?.querySelector('input')?.value || '', errorBox = card?.querySelector('.error');
  try {
    await api('/api/research/decide', 'POST', {run: button.dataset.researchRun, step, action, fingerprint: button.dataset.fp, confirm});
    toast(action === 'approve' ? 'Research approved.' : 'Research declined; Hermes carries on without it.');
    await refresh();
  } catch (error) { if (errorBox) errorBox.textContent = error.message; else toast(error.message); }
}
function latestStep(role) {
  const coder = coderFilter();
  return [...(data.steps || [])].reverse().find(s => (s.role || roleOf(s.agent)) === role && (!agentFilter || s.agent === agentFilter || (!coder && agentFilter === 'hermes')));
}
function findingsHTML(f) {
  const tone = {high: 'error', medium: 'warning-text', low: 'muted'};
  return (f.findings || []).map(x => `<div class="finding"><span class="${tone[x.severity] || ''} small">${esc(x.severity)}</span>
    <div><strong class="small mono">${esc(x.file || '')}${x.line ? ':' + x.line : ''}</strong><p class="small">${esc(x.issue)}</p>${x.suggestion ? `<p class="small muted">${esc(x.suggestion)}</p>` : ''}</div></div>`).join('');
}
function renderSpecialistPanels() {
  const review = latestStep('reviewer'), research = latestStep('researcher');
  const f = review?.findings;
  setHTML($('review-panel'), f ? `<section class="ac-panel"><h2 class="ac-panel__title">Review <span class="muted small">· ${esc(review.agent)} · turn ${review.number}</span></h2>
    <p class="small"><span class="ac-status ${f.verdict === 'ok' ? 'completed' : f.verdict === 'changes' ? 'attention' : ''}">${esc({ok: 'No problems found', changes: 'Changes suggested', unknown: 'No structured findings'}[f.verdict] || f.verdict)}</span></p>
    ${f.summary ? `<p class="small">${esc(f.summary)}</p>` : ''}${findingsHTML(f)}
    <p class="small muted">The reviewer cannot edit. Hermes decides what, if anything, a coder changes.</p></section>` : '');
  if (!research) { setHTML($('research-panel'), ''); return; }
  const r = research.report, state = research.status;
  const body = r ? `<p class="small">${esc(r.summary)}</p>${(r.findings || []).map(x => `<div class="finding"><span class="small muted">•</span><div><p class="small">${esc(x.claim)}</p>${x.sources.map(u => `<a class="small source-link" href="${esc(u)}" target="_blank" rel="noopener noreferrer nofollow">${esc(u)}</a>`).join('')}</div></div>`).join('')}
      ${(r.open_questions || []).length ? `<p class="small muted">Open: ${esc(r.open_questions.join(' · '))}</p>` : ''}`
    : `<p class="small muted">${esc({awaiting_approval: 'Waiting for your approval in Approvals.', approved: 'Approved; starting.', researching: 'Researching…', rejected: 'You declined this research.', failed: research.result || 'The research did not finish.'}[state] || state)}</p>`;
  setHTML($('research-panel'), `<section class="ac-panel"><h2 class="ac-panel__title">Research <span class="muted small">· ${esc(research.agent)}</span></h2>
    <pre class="command small">${esc(research.question || '')}</pre>${body}
    ${r ? '<p class="small muted">Web content, labelled untrusted when passed to agents. Links open in a new tab.</p>' : ''}</section>`);
}
// Models picker in New run: only shown when models.json lists more than your local model.
function renderModelsPicker() {
  const o = data?.model_options, isolation = $('iso-container')?.checked || $('iso-vm')?.checked ? 'container' : 'host';
  $('models-section').classList.toggle('hidden', !o?.endpoints?.length);
  if (!o?.endpoints?.length) return;
  const roles = [['orchestrator', 'Hermes (planning)'], ['coder', 'Coders'], ['tester', 'Tester'], ['reviewer', 'Reviewer'], ['researcher', 'Researcher']];
  const previous = Object.fromEntries(roles.map(([r]) => [r, $('model-' + r)?.value || '']));
  setHTML($('models-picker'), roles.map(([role, label]) => {
    // A container's OpenCode always reaches the gateway, so coder-side roles are open there.
    const why = isolation === 'container' && !['orchestrator', 'researcher'].includes(role) ? '' : o.unavailable?.[role];
    return `<div class="model-row"><label for="model-${role}">${esc(label)}</label><select id="model-${role}" data-model-role="${role}" ${why ? 'disabled' : ''}>
      <option value="">Your local model (${esc(o.default || 'default')})</option>
      ${o.endpoints.map(e => `<option value="${esc(e.id)}" ${previous[role] === e.id ? 'selected' : ''}>${esc(e.id)} · ${esc(e.model || '')}${e.paid ? ` · paid ${money(e.cost_per_mtok_in)}/${money(e.cost_per_mtok_out)} per M tokens` : ''}</option>`).join('')}
    </select>${why ? `<small class="muted">${esc(why)}</small>` : ''}</div>`;
  }).join(''));
  togglePaidFields();
}
function chosenModels() {
  const out = {};
  document.querySelectorAll('[data-model-role]').forEach(s => { if (s.value && !s.disabled) out[s.dataset.modelRole] = s.value; });
  return out;
}
function paidChosen() {
  const paid = new Set((data?.model_options?.endpoints || []).filter(e => e.paid).map(e => e.id));
  return Object.values(chosenModels()).some(id => paid.has(id));
}
function togglePaidFields() { $('paid-fields').classList.toggle('hidden', !paidChosen()); }
function modelsBody() {
  const models = chosenModels();
  if (!Object.keys(models).length) return {};
  return {models, ...(paidChosen() ? {spend_cap: Number($('spend-cap').value)} : {})};
}
function spendHTML() {
  const s = data.spend || {}, paidRun = s.cap !== null && s.cap !== undefined;
  if (!paidRun && !s.run) return '';
  const models = Object.entries(current.models || {}).map(([r, e]) => `${r}: ${e}`).join(' · ');
  const capped = /Spend cap reached|Monthly spend cap/.test(current.summary || '');
  return `<div class="spend-box"><p class="small"><strong>${money(s.run, 4)}</strong>${paidRun ? ` of ${money(s.cap)} cap` : ''} spent in this run${s.monthly_cap ? ` · ${money(s.month)} of ${money(s.monthly_cap)} this month` : ''}</p>
    ${models ? `<p class="small muted">Paid choices: ${esc(models)}</p>` : ''}
    ${paidRun && !ended.has(current.status) ? `<details ${capped ? 'open' : ''}><summary class="small">Change the cap or go back to your local model</summary>
      <label for="cap-new" class="small">New cap · $</label><input id="cap-new" type="number" min="0.01" max="1000" step="0.01" value="${esc(String((s.cap || 1) * 2))}">
      <label for="cap-confirm" class="small">Type <strong>approve</strong> to raise it</label><input id="cap-confirm" autocomplete="off" placeholder="approve">
      <div class="row wrap"><button class="ac-btn compact" data-action="cap-raise">Raise cap</button><button class="ac-btn compact" data-action="models-local">Use my local model</button></div>
      <p id="cap-error" class="error small" role="alert"></p></details>` : ''}</div>`;
}
async function capAction(kind) {
  try {
    if (kind === 'raise') await api('/api/models/set', 'POST', {run: current.id, spend_cap: Number($('cap-new').value), confirm: $('cap-confirm').value});
    else await api('/api/models/set', 'POST', {run: current.id, models: Object.fromEntries(Object.keys(current.models || {}).map(r => [r, null]))});
    toast(kind === 'raise' ? 'Cap raised. Resume the run to continue.' : 'Every role uses your local model again.');
    await refresh();
  } catch (error) { if ($('cap-error')) $('cap-error').textContent = error.message; else toast(error.message); }
}
let usageData = null;
async function loadUsage() {
  try { usageData = await api('/api/usage?period=' + encodeURIComponent($('usage-period').value)); } catch (error) { usageData = {error: error.message}; }
  renderUsage();
}
function renderUsage() {
  const u = usageData;
  if (!u) { setHTML($('usage-report'), '<p class="small muted">Loading…</p>'); return; }
  if (u.error) { setHTML($('usage-report'), `<p class="error">${esc(u.error)}</p>`); return; }
  const rows = u.rows.map(r => `<tr><td><button class="text-button" data-run="${esc(r.run || '')}">${esc(r.title || (r.run || '—').slice(0, 6))}</button></td><td>${esc(r.agent || '—')}</td>
    <td class="mono small">${esc(r.endpoint || '—')}${r.paid ? ' <span class="paid-tag">paid</span>' : ''}</td><td class="num">${r.calls}</td><td class="num">${tokens(r.tokens_in)} / ${tokens(r.tokens_out)}</td>
    <td class="num">${r.paid ? money(r.cost, 4) : '<span class="muted">local · $0</span>'}</td></tr>`).join('');
  setHTML($('usage-report'), `<section class="ac-panel"><div class="usage-totals"><div><small>Calls</small><strong>${u.total.calls}</strong></div><div><small>Tokens in / out</small><strong>${tokens(u.total.tokens_in)} / ${tokens(u.total.tokens_out)}</strong></div>
      <div><small>Spend</small><strong>${money(u.total.cost, 4)}</strong>${u.monthly_cap ? `<small>of ${money(u.monthly_cap)} monthly cap</small>` : ''}</div></div>
    ${rows ? `<div class="table-wrap"><table class="team-table usage-table"><thead><tr><th>Run</th><th>Agent</th><th>Model</th><th class="num">Calls</th><th class="num">Tokens in / out</th><th class="num">Cost</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<p class="small muted">No model calls recorded in this period.</p>'}
    <p class="small muted">Token counts come from Hermes, OpenCode and the gateway. Only paid providers cost money; your local model is always $0.</p></section>`);
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
  const agents = Object.keys(ws.agents || {}).filter(a => !coderFilter() || a === coderFilter());
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
  setHTML($('skill-proposals'), researchRequests().map(r => researchCard(r)).join('') + pendingSkills().map(skillCard).join(''));
  renderSkillsView();
  setHTML($('approval-list'), data.inbox.length ? data.inbox.map(approvalCard).join('') : pendingSkills().length || researchRequests().length ? '' : '<section class="ac-panel"><h2>Nothing waiting on you.</h2><p class="muted small">New permission requests and questions will appear here.</p></section>');
  setHTML($('rule-list'), rulesHTML());
  setHTML($('audit-list'), auditHTML());
  setHTML($('decision-history'), data.reviews.length ? data.reviews.map(r => {
    const tone = r.state === 'confirmed' ? (r.action === 'reject' ? 'error' : 'success-text') : 'warning-text';
    const mark = r.state === 'confirmed' ? (r.action === 'reject' ? '×' : '✓') : '◌';
    return `<button class="history-button" data-review="${esc(requestKey(r))}"><span class="${tone}">${mark}</span><span><strong>${esc(receiptLabel(r))} · ${esc(requestTitle(r.request))}</strong><small>${esc(requestText(r.request).slice(0, 120))}</small></span>${when(r.updated)}</button>`;
  }).join('') : '<p class="small muted">Decisions for the selected run will be recorded here.</p>');
}
function stateName(state) { return state ? (AGENT_STATE[state]?.[0] || String(state).replaceAll('_', ' ')).toLowerCase() : 'joined'; }
function eventSummary(e, parsed) {
  if (!parsed || typeof parsed !== 'object') return e.detail;
  if (e.kind === 'agent state' && parsed.agent) return `${parsed.agent}: ${stateName(parsed.from)} → ${stateName(parsed.to)}${parsed.task ? ' · ' + parsed.task : ''}`;
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
const preview = {offset: 0, buffer: '', timer: null, screenURL: '', lastStatus: {}, opened: new Set(), width: '100%'};
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
  const vmLive = data.vm?.live === 'running';
  $('vm-console').classList.toggle('hidden', !vmLive);
  $('vm-console-meta').textContent = vmLive ? `· ${data.vm.name}` : '';
  if (vmLive && view === 'project' && !vmScreenURL) refreshVmScreen().catch(() => {});
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
/* Point a preview iframe (the Project tab's, or a workspace viewer's) at the running preview.
   Each frame redeems its own one-time ticket. */
async function ensurePreviewFrame(p, frame = $('preview-frame'), address = $('preview-address')) {
  const key = `${p.run}:${p.started}`;
  if (frame.dataset.key === key) return;
  frame.dataset.key = key;
  try {
    const {ticket, port} = await api('/api/preview/ticket', 'POST', {});
    const base = `${location.protocol}//${location.hostname}:${port}`;
    frame.src = `${base}/__ac/enter?ticket=${encodeURIComponent(ticket)}`;
    if (address) address.textContent = base + '/';
  } catch (error) { frame.dataset.key = ''; pageError(error.message); }
}
function appendPreviewOutput(text, reset) {
  const clean = stripAnsi(text);
  // Kept so a workspace viewer opened later starts with what was already printed.
  preview.buffer = ((reset ? '' : preview.buffer || '') + clean).slice(-200000);
  for (const target of [$('preview-term-body'), $('preview-log'), ...document.querySelectorAll('[data-surface-output]')]) {
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
  // The Project tab, or a workspace viewer that is open and showing this surface, needs updates.
  const watch = globalThis.wsSurfaceWatch?.() || {};
  try {
    if (key && connected && (view === 'project' || watch.preview) && previewForCurrent() && !document.hidden) {
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
    if (key && connected && (view === 'project' || watch.vm) && data?.vm?.live === 'running' && !document.hidden) await refreshVmScreen();
  } catch {}
  preview.timer = setTimeout(pollPreview, delay);
}
/* One frame fetch updates every screen showing the desktop preview (Project tab and workspace panes). */
async function refreshScreen() {
  const response = await fetch('/api/preview/frame', {headers: {Authorization: 'Bearer ' + key}});
  if (!response.ok) return;
  const url = URL.createObjectURL(await response.blob());
  document.querySelectorAll('img[data-surface-screen="preview"]').forEach(img => { img.src = url; });
  if (preview.screenURL) URL.revokeObjectURL(preview.screenURL);
  preview.screenURL = url;
}
function resetPreviewOutput() {
  preview.offset = 0; preview.buffer = '';
  $('preview-term-body').textContent = ''; $('preview-log').textContent = '';
  document.querySelectorAll('[data-surface-output]').forEach(e => { e.textContent = ''; });
}
async function previewAction(action, extra = {}) {
  const status = await api('/api/preview', 'POST', {run: current.id, action, ...extra});
  if (status && status.state) data.preview = status;
  if (['start', 'restart'].includes(action)) { resetPreviewOutput(); document.querySelectorAll('iframe[data-key]').forEach(f => { f.dataset.key = ''; }); }
  renderProject();
  pollPreview();
  return status;
}
function autoOpenProject() {
  if (!current || POPOUT) return;
  const before = preview.lastStatus[current.id];
  preview.lastStatus[current.id] = current.status;
  if (before && before !== 'completed' && current.status === 'completed' && current.preview && !preview.opened.has(current.id)) {
    preview.opened.add(current.id);
    showView('project');
    toast('Run complete. Opening the live preview.');
  }
}
function screenClick(event) {
  const p = previewStatus(), img = event.target?.closest?.('img[data-surface-screen]') || $('preview-screen'), rect = img.getBoundingClientRect();
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
  $('review-footer').innerHTML = `<small>${permission ? (p.risk?.decision === 'confirm' ? 'Critical: type the confirmation word first.' : (p.risk?.remember_allowed ? 'Approval applies to this request only unless you tick the box above.' : 'Approval applies to this request only.')) : 'Answers go to this OpenCode session.'}</small>
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
  if (!VIEWS.includes(next)) return;
  view = next;
  if (next !== 'new' && !POPOUT) { try { localStorage.setItem('ac-view', next); } catch {} }
  document.querySelectorAll('.view').forEach(e => e.classList.toggle('hidden', e.id !== 'view-' + next));
  document.querySelectorAll('.nav [data-view], .tabbar [data-view]').forEach(b => { b.classList.toggle('active', b.dataset.view === next); b.setAttribute('aria-current', b.dataset.view === next ? 'page' : 'false'); });
  closeDrawer();
  if (data) { renderShell(); if (next === 'project') { renderProject(); pollPreview(); } if (next === 'workspace') globalThis.renderWorkspace?.(); }
  if (next === 'usage') loadUsage();
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
  renderIsolation();
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
function containerBlocker() {
  const s = data?.sandbox;
  if (!s) return 'Checking for a container runtime…';
  if (s.unavailable) return s.unavailable;
  if (!preflight?.usable) return 'Containers need a git project with at least one commit: the container works on the run’s own worktrees.';
  if (!s.models_configured) return 'Describe your model server in state/models.json first; the container reaches it only through AgentControl.';
  return '';
}
function vmBlocker() {
  const v = data?.vm_env;
  if (!v) return 'Checking for KVM and libvirt…';
  if (v.unavailable) return v.unavailable;
  if (!preflight?.usable) return 'VMs need a git project with at least one commit: the VM works on copies of the run’s worktrees.';
  if (!v.models_configured) return 'Describe your model server in state/models.json first; the VM reaches it only through AgentControl.';
  return '';
}
function renderIsolation() {
  const vmBlocked = vmBlocker(), vmOption = $('iso-vm');
  vmOption.disabled = Boolean(vmBlocked);
  if (vmBlocked && vmOption.checked) { vmOption.checked = false; $('iso-host').checked = true; }
  setHTML($('vm-unavailable'), vmBlocked ? `<p class="small muted">Virtual machine can’t be used yet: ${esc(vmBlocked)}</p>`
    : data?.vm_env ? `<p class="small muted">KVM · ${esc(data.vm_env.version || 'libvirt')} · clones ${esc((data.vm_env.baseline || '').split('/').pop())}</p>` : '');
  const blocked = containerBlocker(), option = $('iso-container'), s = data?.sandbox;
  option.disabled = Boolean(blocked);
  if (blocked && option.checked) { option.checked = false; $('iso-host').checked = true; }
  const imageMissing = s?.runtime && !s.image && s.build_command;
  setHTML($('container-unavailable'), blocked ? `<p class="small muted">Container can’t be used yet: ${esc(blocked)}</p>
    ${imageMissing ? details('Build the agent image', s.build_command, 'image-build') : ''}<button type="button" class="text-button small" data-action="sandbox-check">Check again</button>`
    : s?.runtime ? `<p class="small muted">${esc(s.runtime)} ${esc(s.version || '')} · ${s.rootless ? 'rootless ✓' : '<span class="warning-text">runs as root (allowed by --allow-rootful-containers)</span>'}</p>` : '');
  const on = $('iso-container').checked || $('iso-vm').checked;
  $('container-fields').classList.toggle('hidden', !on);
  $('container-confirm-field').classList.toggle('hidden', !on || $('container-network').value !== 'internet');
}
function isolationBody() {
  const isolation = $('iso-vm').checked ? 'vm' : $('iso-container').checked ? 'container' : '';
  if (!isolation) return {};
  const network = $('container-network').value;
  return {isolation, cpus: Number($('container-cpus').value), memory_gb: Number($('container-memory').value), network,
    ...(network === 'internet' ? {confirm: $('container-confirm').value.trim()} : {})};
}
const NETWORK_LABEL = {setup: 'internet for setup only', none: 'none', internet: 'internet while agents work'};
function renderContainer() {
  const c = data.container;
  if (!c) { setHTML($('container-panel'), ''); return; }
  const title = '<h2 class="ac-panel__title">Container</h2>';
  if (c.live === 'removed') { setHTML($('container-panel'), `<section class="ac-panel">${title}<p class="small muted">Removed ${c.removed ? when(c.removed) : ''} with the run’s branch.</p></section>`); return; }
  const live = {running: 'Running', exited: 'Stopped', created: 'Created', missing: 'Not created yet', pending: 'Starts with the first turn'}[c.live] || c.live;
  const net = c.network === 'internet' ? '<span class="warning-text">Internet on while agents work</span>'
    : c.network_cut ? `Cut off after setup at ${esc(timeLabel(c.network_cut))}`
    : c.network_state === 'online' ? '<span class="warning-text">On for the setup command</span>' : 'None';
  const working = !ended.has(current.status) && !current.pause && !['paused', 'interrupted', 'attention'].includes(current.status);
  const button = c.live === 'running'
    ? `<button class="ac-btn compact" data-action="container-stop" ${!connected || working ? 'disabled' : ''}>Stop container</button>`
    : ['exited', 'created', 'missing'].includes(c.live) ? `<button class="ac-btn compact" data-action="container-start" ${connected ? '' : 'disabled'}>Start container</button>` : '';
  setHTML($('container-panel'), `<section class="ac-panel">${title}
    <dl class="facts small"><dt>State</dt><dd class="${c.live === 'running' ? 'success-text' : ''}">${esc(live)}</dd>
    <dt>Runtime</dt><dd>${esc(c.runtime)} · ${c.rootless ? 'rootless ✓' : '<span class="warning-text">as root</span>'}</dd>
    <dt>Image</dt><dd class="mono">${esc(c.image)}</dd><dt>Limits</dt><dd>${esc(String(c.cpus))} CPUs · ${esc(String(c.memory_gb))} GB</dd>
    <dt>Network</dt><dd>${net}</dd></dl>
    ${button ? `<div class="row wrap">${button}</div>` : ''}${working && c.live === 'running' ? '<p class="small muted">Pause the run to stop the container.</p>' : ''}
    <p class="small muted">The Project tab shows previews running inside this container, including its desktop.</p></section>`);
}
function renderVm() {
  const v = data.vm;
  if (!v) { setHTML($('vm-panel'), ''); return; }
  const title = '<h2 class="ac-panel__title">Virtual machine</h2>';
  if (v.live === 'removed') { setHTML($('vm-panel'), `<section class="ac-panel">${title}<p class="small muted">Removed ${v.removed ? when(v.removed) : ''} with the run’s branch.</p></section>`); return; }
  const live = {running: 'Running', stopped: 'Stopped', paused: 'Paused', missing: 'Not created yet', pending: 'Starts with the first turn'}[v.live] || v.live;
  const net = v.network === 'internet' ? '<span class="warning-text">Internet on while agents work</span>'
    : v.network_cut ? `Host-only since ${esc(timeLabel(v.network_cut))}` : v.network_state === 'online' ? '<span class="warning-text">On for provisioning and setup</span>' : 'Host-only';
  const working = !ended.has(current.status) && !current.pause && !['paused', 'interrupted', 'attention'].includes(current.status);
  const button = v.live === 'running' ? `<button class="ac-btn compact" data-action="container-stop" ${!connected || working ? 'disabled' : ''}>Shut down VM</button>`
    : ['stopped', 'missing'].includes(v.live) ? `<button class="ac-btn compact" data-action="container-start" ${connected ? '' : 'disabled'}>Start VM</button>` : '';
  setHTML($('vm-panel'), `<section class="ac-panel">${title}
    <dl class="facts small"><dt>State</dt><dd class="${v.live === 'running' ? 'success-text' : ''}">${esc(live)}</dd>
    <dt>Clone of</dt><dd class="mono">${esc((v.baseline || '').split('/').pop())}</dd><dt>Limits</dt><dd>${esc(String(v.cpus))} vCPUs · ${esc(String(v.memory_gb))} GB</dd>
    <dt>Network</dt><dd>${net}</dd>${v.ip ? `<dt>Address</dt><dd class="mono">${esc(v.ip)}</dd>` : ''}</dl>
    ${button ? `<div class="row wrap">${button}</div>` : ''}${working && v.live === 'running' ? '<p class="small muted">Pause the run to shut the VM down.</p>' : ''}
    <p class="small muted">Agents work as an unprivileged user inside. The Project tab shows the VM’s screen; you can click and type into it.</p></section>`);
}
let vmScreenURL = '', vmSize = [0, 0];
async function refreshVmScreen() {
  if (!current || data?.vm?.live !== 'running') return;
  const response = await fetch('/api/vm/screen?run=' + encodeURIComponent(current.id), {headers: {Authorization: 'Bearer ' + key}});
  if (!response.ok) { $('vm-console-meta').textContent = '· screen unavailable'; return; }
  const blob = await response.blob(), url = URL.createObjectURL(blob);
  document.querySelectorAll('img[data-surface-screen="vm"]').forEach(img => { img.src = url; });
  if (vmScreenURL) URL.revokeObjectURL(vmScreenURL);
  vmScreenURL = url;
}
async function vmInput(body) {
  try { await api('/api/vm/input', 'POST', {run: current.id, ...body}); await refreshVmScreen(); } catch (error) { pageError(error.message); }
}
function vmClick(event) {
  const img = event.target?.closest?.('img[data-surface-screen]') || $('vm-screen'), rect = img.getBoundingClientRect(), width = img.naturalWidth, height = img.naturalHeight;
  if (!rect.width || !width) return;
  const x = Math.min(width - 1, Math.max(0, Math.round((event.clientX - rect.left) / rect.width * width)));
  const y = Math.min(height - 1, Math.max(0, Math.round((event.clientY - rect.top) / rect.height * height)));
  vmInput({action: 'click', x, y, width, height, button: event.button === 2 ? 3 : 1});
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
async function control(action, text = '', id = current?.id, agent = null) {
  if (!id) throw Error('Choose a run first.');
  const result = await api('/api/control', 'POST', {run: id, action, text, ...(agent ? {agent} : {})});
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
  projects: async () => {
    $('project-new-name').value = ''; $('projects-error').textContent = '';
    $('projects-dialog').showModal();
    const inside = data && data.projects_root && (data.project + '/').startsWith(data.projects_root.replace(/\/$/, '') + '/');
    await loadProjectFolder(inside ? data.project.split('/').slice(0, -1).join('/') || data.projects_root : '');
  },
  'project-open': button => loadProjectFolder(button.dataset.path),
  'project-use': async button => {
    $('projects-error').textContent = '';
    try { const result = await api('/api/projects/select', 'POST', {path: button.dataset.path}); await useProject(result, `Switched to ${projectLabel(result.project)}.`); }
    catch (error) { $('projects-error').textContent = error.message; }
  },
  new: () => openNew(),
  followup: () => openNew(true),
  connections: () => $('connection-dialog').showModal(),
  help: () => $('help-dialog').showModal(),
  drawer: toggleDrawer,
  'drawer-close': closeDrawer,
  'focus-steer': focusSteer,
  'agent-clear': () => { agentFilter = null; selectedTurn = null; termReset(null); showView('mission'); if (data) renderRun(); },
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
  'research-approve': button => researchDecision(button, 'approve'),
  'research-reject': button => researchDecision(button, 'reject'),
  'cap-raise': () => capAction('raise'),
  'models-local': () => capAction('local'),
  'usage-refresh': () => loadUsage(),
  'container-stop': async () => { await control('container_stop'); toast('Container stopped.'); },
  'container-start': async () => { await control('container_start'); toast('Starting the container…'); },
  'sandbox-check': async () => { try { data.sandbox = await api('/api/sandbox?check=1'); } catch (error) { toast(error.message); } renderIsolation(); },
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
  'preview-reload': () => { $('preview-frame').dataset.key = ''; ensurePreviewFrame(previewStatus()); },
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
  if (globalThis.workspaceKey?.(event)) { event.preventDefault(); return; }
  const actions = {a: 'key-approve', d: 'key-deny', p: 'pause', x: 'stop', '/': 'focus-steer', t: 'term-expand'};
  if (data.capabilities?.verify_now) actions.v = 'verify-now';
  if (actions[event.key]) { event.preventDefault(); act(actions[event.key]).catch(e => pageError(e.message)); }
}

// ---------------------------------------------------------------------------
// Start-up and event wiring
// ---------------------------------------------------------------------------
async function onClick(event) {
  const b = event.target.closest('button');
  // The whole agent card opens that agent; its own buttons keep their meaning.
  const card = !b && event.target.closest?.('[data-agent-card]');
  if (card && !String(globalThis.getSelection?.() || '')) { openAgent(card.dataset.agentCard); return; }
  if (!b || b.disabled) return;
  try {
    if (await globalThis.workspaceClick?.(b)) return;
    if (b.dataset.theme) setTheme(b.dataset.theme);
    if (b.dataset.close) $(b.dataset.close).close();
    if (b.dataset.view) showView(b.dataset.view);
    if (b.dataset.action) await act(b.dataset.action, b);
    if (b.dataset.run) { selected = b.dataset.run; selectedTurn = null; agentFilter = null; termReset(null); showView('runs'); await refresh(); }
    if (b.dataset.agent) openAgent(b.dataset.agent);
    if (b.dataset.turn) {
      selectedTurn = ['latest'].includes(b.dataset.turn) ? null : b.dataset.turn;
      if (selectedTurn && agentFilter && !agentSteps().some(s => s.id === selectedTurn)) agentFilter = null;
      if (view === 'mission') showView('runs');
      if (data) renderRun();
    }
    if (b.dataset.stageTab) showStage(b.dataset.stageTab);
    if (b.dataset.previewWidth) {
      preview.width = b.dataset.previewWidth;
      $('preview-frame').style.width = preview.width;
      document.querySelectorAll('[data-preview-width]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    }
    if (b.dataset.previewKey) await previewAction('input', {text: b.dataset.previewKey});
    if (b.dataset.vmKey) await vmInput({action: 'key', key: b.dataset.vmKey});
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
  if (POPOUT) document.body.classList.add('popout');
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
    if (($('iso-container').checked || $('iso-vm').checked) && $('container-network').value === 'internet' && $('container-confirm').value.trim().toLowerCase() !== 'approve') { $('start-error').textContent = 'Type approve to let agents use the internet, or choose another network setting.'; return; }
    if (paidChosen() && $('paid-confirm').value.trim().toLowerCase() !== 'approve') { $('start-error').textContent = 'Type approve to allow paid models, or pick your local model for every role.'; return; }
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
        ...isolationBody(),
        ...modelsBody(),
        ...(paidChosen() ? {confirm: $('paid-confirm').value.trim()} : {}),
        ...(preflight?.usable && $('setup-cmd').value.trim() ? {setup: $('setup-cmd').value.trim()} : {})});
      selected = result.id; parentRun = null; selectedTurn = null; $('run-title').value = '';
      showView('runs');
      await refresh();
      toast('Hermes is preparing the first turn.');
    } catch (error) { $('start-error').textContent = error.message; $('start-run').disabled = false; }
  };
  document.querySelectorAll('input[name="run-mode"]').forEach(radio => { radio.onchange = scheduleAutoPreview; });
  document.querySelectorAll('input[name="isolation"]').forEach(radio => { radio.onchange = () => { renderIsolation(); renderModelsPicker(); }; });
  // A VM, like a container, reaches other models through the run gateway.
  $('models-picker').addEventListener('change', togglePaidFields);
  $('usage-period').onchange = loadUsage;
  $('container-network').onchange = renderIsolation;
  ['goal', 'verify', 'max-prompts'].forEach(id => $(id).addEventListener('input', scheduleAutoPreview));
  $('verify-enabled').onchange = () => { $('verify').disabled = !$('verify-enabled').checked; $('verify').required = $('verify-enabled').checked; };
  $('steering-form').onsubmit = async event => {
    event.preventDefault();
    const field = $('steering'), note = field.value.trim(), runId = current.id, about = coderFilter();
    try {
      await control('instruction', note, runId, about);
      if (field.value.trim() === note) { field.value = ''; growSteering(); }
      $('steering-feedback').textContent = about ? `Saved for Hermes, marked for ${about}.` : 'Saved for the next Hermes prompt.';
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
  $('runs-all').addEventListener('change', async event => { runScope = event.target.checked ? 'all' : 'current'; selected = ''; await refresh(); });
  $('project-create-form').onsubmit = async event => {
    event.preventDefault();
    $('projects-error').textContent = '';
    $('project-create').disabled = true;
    try { const result = await api('/api/projects/create', 'POST', {name: $('project-new-name').value.trim()}); await useProject(result, `Created and switched to ${projectLabel(result.project)}.`); }
    catch (error) { $('projects-error').textContent = error.message; }
    finally { $('project-create').disabled = !!activeRun(); }
  };
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
  // Clicks on any screen: the Project tab's, or one in a workspace viewer (right-click is button 3).
  const onScreen = event => {
    const img = event.target?.closest?.('img[data-surface-screen]');
    if (!img) return;
    if (event.type === 'contextmenu') event.preventDefault();
    (img.dataset.surfaceScreen === 'vm' ? vmClick : screenClick)(event);
  };
  document.addEventListener('click', onScreen);
  document.addEventListener('contextmenu', onScreen);
  $('vm-type-form').onsubmit = async event => {
    event.preventDefault();
    if (!$('vm-type').value) return;
    await vmInput({action: 'type', text: $('vm-type').value});
    $('vm-type').value = '';
  };
  $('term-body').addEventListener('scroll', term.onScroll);
  $('terminal-dialog').addEventListener('close', () => expandTerminal(false));
  $('stage-track').addEventListener('scroll', () => {
    const track = $('stage-track');
    if (track.scrollWidth <= track.clientWidth + 4) return;
    const index = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
    const name = STAGES[Math.min(STAGES.length - 1, index)][0];
    document.querySelectorAll('[data-stage-tab]').forEach(t => t.setAttribute('aria-selected', String(t.dataset.stageTab === name)));
  });
  showView(view);
  refresh().then(() => { schedule(); connectEvents(); });
}
if (typeof document !== 'undefined') init();
if (typeof module !== 'undefined' && module.exports) module.exports = {stripAnsi, esc, duration, budget, stateLabel, requestKey, requestTitle, requestText, receiptLabel, verificationLabel, fileStats, phaseIndex, ignoresShortcut, shellQuote, relTime, runTitle, stageStates, transcriptOf, planningNext, nextDelay};
