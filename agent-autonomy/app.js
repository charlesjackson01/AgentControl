'use strict';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#icon-${name}"/></svg>`;
const pretty = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const ended = new Set(['completed','blocked','failed','stopped','limit_reached']);
let key = readSession('trial-dashboard-key'), selected = '', data = null, current = null, view = 'runs';
let refreshing = false, connected = false, reviewBusy = false, reviewing = null, stopRunId = '', parentRun = null;
let toastTimer, announcedRequests = '', diffText = '', lastStateTime = null;
const dismissedReceipts = new Set();
function readSession(name) { try { return sessionStorage.getItem(name) || ''; } catch { return ''; } }
function timeLabel(value) { const date = new Date(value); return isNaN(date) ? '—' : date.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}); }
function duration(seconds) { if (!Number.isFinite(seconds)) return '—'; const n=Math.max(0,Math.floor(seconds)); return n>=3600 ? `${Math.floor(n/3600)}h ${Math.floor(n%3600/60)}m` : `${Math.floor(n/60)}m ${n%60}s`; }
function budget(run, now=Date.now()) {
  if (!run) return {used:0, allowed:0};
  const start=Date.parse(run.created), end=run.ended ? Date.parse(run.ended) : now;
  const allowed=run.time_limit_seconds ?? (run.deadline*1000-start)/1000;
  return {used:Number.isFinite(start) ? Math.max(0,(end-start)/1000) : 0, allowed:Math.max(0,Math.round(allowed || 0))};
}
function requestKey(p) { return `${p.run}:${p.kind}:${p.request_id}`; }
function runRequests(run=current) { return (data?.inbox || []).filter(p => p.run===run?.id); }
function stateLabel(run, pending=[]) {
  if (!run) return {text:'Ready',tone:''};
  if (!ended.has(run.status) && pending.length) return {text:pending.some(p=>p.kind==='permission')?'Needs your approval':'Needs your answer',tone:'attention'};
  if (run.status==='waiting') return {text:'Resuming',tone:'running'};
  const map={planning:['Planning','running'],coding:['Running','running'],reviewing:['Verifying','running'],resuming:['Resuming','running'],paused:['Paused',''],interrupted:['Interrupted','attention'],attention:['Needs attention','attention'],completed:['Completed','completed'],failed:['Failed','failed'],stopped:['Stopped',''],blocked:['Blocked','attention'],limit_reached:['Budget exhausted','attention']};
  const pair=map[run.status]||[run.status,'']; return {text:pair[0],tone:pair[1]};
}
function statusHTML(run, pending=[]) { const s=stateLabel(run,pending); return `<span class="ac-status ${s.tone}"><span class="dot"></span>${esc(s.text)}</span>`; }
function requestTitle(p) {
  if(p.kind==='question') return p.questions?.[0]?.header || 'OpenCode has a question';
  return ({bash:'OpenCode wants to run a command',edit:'OpenCode wants to edit files',write:'OpenCode wants to write a file',read:'OpenCode wants to read a file',external_directory:'OpenCode requests directory access',webfetch:'OpenCode requests web access',task:'OpenCode wants to start a subtask',doom_loop:'OpenCode requests a repeated action'})[p.permission] || p.title || 'OpenCode requests permission';
}
function requestText(p) {
  const input=p.context?.input || {}, meta=p.metadata || {};
  return input.command || meta.command || input.filePath || input.path || (Array.isArray(p.patterns)?p.patterns.join('\n'):p.pattern) || (p.kind==='question'?p.questions?.map(q=>q.question).join('\n'):'See full request');
}
function receiptLabel(r) { if(r.state==='confirmed')return r.action==='approve'?'Approved once':r.action==='reject'?'Denied':'Answered'; return ({sent:'Awaiting confirmation',dispatching:'Sending decision',uncertain:'Delivery uncertain',resolved:'Request resolved',failed:'Delivery failed'})[r.state] || r.state; }
function verificationLabel(step) { const state=step?.verification?.status; return state==='passed'?'Verification passed':state==='failed'?'Verification failed':state==='not configured'?'Review only':step?.status==='failed'?'Coding failed':'Not verified yet'; }
function fileStats(steps) {
  const files=new Map();
  for(const step of steps || []) for(const path of step.evidence?.changed_files || []) {
    const stat=step.evidence?.file_stats?.find(f=>f.path===path);
    const previous=files.get(path);
    if(!previous) files.set(path,{path,change:stat?.change || 'changed',added:stat?.added ?? null,removed:stat?.removed ?? null,partial:stat?.partial || !stat});
    else { previous.added=previous.added===null || stat?.added===undefined ? null : previous.added+stat.added; previous.removed=previous.removed===null || stat?.removed===undefined ? null : previous.removed+stat.removed; previous.partial ||= stat?.partial || !stat; if(stat?.change==='deleted')previous.change='deleted'; else if(previous.change==='deleted')previous.change='changed'; }
  }
  return [...files.values()];
}
function phaseIndex(run, steps) {
  const last=steps.at(-1);
  if(run?.status==='completed')return 4;
  if(last && ['prepared','dispatching'].includes(last.status))return 1;
  if(run?.phase==='code')return 2;
  if(run?.phase==='verify' || (run?.phase==='manager' && steps.length))return 3;
  return 0;
}
function shellQuote(value) { return "'"+String(value).replaceAll("'", "'\"'\"'")+"'"; }
function details(title, text, id) { return `<details data-key="${esc(id)}"><summary>${esc(title)}</summary><pre>${esc(text)}</pre></details>`; }
function diffHTML(text) { return text.split('\n').map(line=>`<span class="diff-line ${/^(@@|\+\+\+|---)/.test(line)?'diff-heading':line.startsWith('+')?'diff-add':line.startsWith('-')?'diff-remove':''}">${esc(line)}</span>`).join(''); }
function setHTML(element, html) {
  if(element.dataset.rendered===html)return;
  const expanded=new Map([...element.querySelectorAll('details[data-key]')].map(e=>[e.dataset.key,e.open]));
  element.innerHTML=html; element.dataset.rendered=html;
  element.querySelectorAll('details[data-key]').forEach(e=>{if(expanded.has(e.dataset.key))e.open=expanded.get(e.dataset.key)});
}
function toast(message) { $('toast').textContent=message; $('toast').classList.remove('hidden'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('toast').classList.add('hidden'),4500); }
function pageError(message) { $('page-error').textContent=message; $('page-error').classList.toggle('hidden',!message); }
function setTheme(theme, save=true) {
  if(!['mac','terminal','xp'].includes(theme))theme='mac';
  document.documentElement.dataset.theme=theme;
  document.querySelectorAll('button[data-theme]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.theme===theme)));
  if(save)try{localStorage.setItem('ac-theme',theme)}catch{toast('Theme changed for this visit. Browser storage is unavailable.')}
}
async function api(path, method='GET', body) {
  const response=await fetch(path,{method,headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  let result; try{result=await response.json()}catch{throw Error('The controller returned an unreadable response.')}
  if(response.status===401){connected=false;$('app').classList.add('hidden');$('auth').classList.remove('hidden')}
  if(!response.ok)throw Error(result.error || `Request failed (${response.status})`);
  return result;
}
async function refresh() {
  if(!key || refreshing)return;
  refreshing=true;const requestedRun=selected;
  try {
    const result=await api('/api/state'+(selected?'?run='+encodeURIComponent(selected):''));
    if(requestedRun!==selected)return;
    data=result; current=data.run; connected=true;lastStateTime=Date.now();
    $('auth').classList.add('hidden');$('app').classList.remove('hidden');$('auth-error').textContent='';render();
  } catch(error) {
    connected=false;$('auth-error').textContent=error.message;
    $('connection-banner').textContent='Disconnected. Reconnecting… '+error.message;$('connection-banner').classList.remove('hidden');
    refreshReview();
  } finally { refreshing=false; if(requestedRun!==selected)refresh(); }
}
function render() {
  renderShell();renderRun();renderApprovals();renderActivity();refreshReview();
}
function renderShell() {
  const inbox=data.inbox || [], active=data.runs.some(r=>!ended.has(r.status)), project=data.project.split('/').filter(Boolean).pop() || 'Project';
  document.title=(inbox.length?`(${inbox.length}) `:'')+'AgentControl';
  $('project-name').textContent=project;$('footer-project').textContent=data.project;
  $('working-folder').value=data.project;$('new-profile').textContent=data.profile;
  const maximum=Math.max(1,Math.floor((data.limits?.max_run_seconds || 7200)/60));
  $('run-minutes').max=maximum; if(Number($('run-minutes').value)>maximum)$('run-minutes').value=maximum;
  $('start-run').disabled=active || !data.health.ready || !connected;
  if(view==='new' && active)$('start-error').textContent='Finish or stop the active run before starting another.';
  const crumbs=[project,view==='new'?'New run':view==='runs'?'Runs':view==='approvals'?'Approvals':'Activity'];
  if(current && view!=='new')crumbs.push('#'+current.id.slice(0,6));
  $('breadcrumb').textContent=crumbs.join(' / ');$('xp-address').textContent=crumbs.join('\\');
  $('window-title').textContent='AgentControl'+(current?' — '+current.goal.split('\n')[0].slice(0,100):'');
  const state=stateLabel(current,runRequests());$('terminal-status').textContent=state.text;$('terminal-status').className='terminal-only terminal-status '+state.tone;
  const xpResume=current?.pause || ['interrupted','attention'].includes(current?.status);
  setHTML($('xp-run-controls'),current&&!ended.has(current.status)?`<button class="toolbar-tool" data-action="pause" aria-label="${xpResume?'Resume':'Pause'}" aria-keyshortcuts="p"><span class="tool-badge pause-badge">${icon(xpResume?'play':'pause')}</span><span class="tool-label">${xpResume?'Resume':'Pause'}</span></button><button class="toolbar-tool" data-action="stop" aria-label="Stop run" aria-keyshortcuts="x"><span class="tool-badge stop-badge">${icon('stop')}</span><span class="tool-label">Stop</span></button>`:'');
  const b=budget(current);const budgetText=current?`${data.steps.length}/${current.max_steps} prompts · ${duration(b.used)} / ${duration(b.allowed)}`:'';
  $('terminal-budget').textContent=budgetText;$('xp-budget').textContent=budgetText;$('xp-status').textContent=connected?state.text:'Reconnecting';$('xp-folder').textContent=data.project;
  $('nav-count').textContent=inbox.length;$('nav-count').classList.toggle('hidden',!inbox.length);
  $('approval-total').textContent=`${inbox.length} pending`;$('tray-count').textContent=inbox.length?`⚠ ${inbox.length}`:'';
  $('tray-clock').textContent=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  $('xp-notification').classList.toggle('hidden',!inbox.length);$('notification-text').textContent=inbox.length?requestTitle(inbox[0]):'';
  const signature=inbox.map(requestKey).sort().join(',');
  if(signature!==announcedRequests){$('approval-announcement').textContent=inbox.length?`${inbox.length} OpenCode request${inbox.length===1?'':'s'} waiting for your review.`:'No requests waiting for review.';announcedRequests=signature}
  const healthMessage=!connected?'Disconnected. Reconnecting…':!data.health.ready?data.health.message:'';
  $('connection-banner').textContent=healthMessage;$('connection-banner').classList.toggle('hidden',!healthMessage);
  $('last-updated').textContent='Updated '+new Date(lastStateTime).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  setHTML($('recent-runs'),data.runs.map(r=>{const p=inbox.filter(x=>x.run===r.id),s=stateLabel(r,p);return `<button class="recent-run ${r.id===current?.id?'active':''}" data-run="${esc(r.id)}"><span class="dot ${s.tone==='attention'?'warning-text':s.tone==='failed'?'error':s.tone==='completed'?'success-text':''}"></span><span><span class="run-name">${esc(r.goal)}</span><small>${esc(s.text)} · ${r.prompt_count ?? '—'} prompt${r.prompt_count===1?'':'s'}</small></span></button>`}).join('') || '<p class="small muted">Your runs will appear here.</p>');
  const agents=data.health.agents || {};
  setHTML($('agent-list'),[['hermes','Hermes','Orchestrator',data.profile],['opencode','OpenCode','Coder',project]].map(([id,name,role,host])=>{const agent=agents[id];return `<div class="agent-row"><span class="agent-avatar ${id}">${name[0]}</span><div><strong>${name}</strong><small>${role} · ${esc(host)}</small><div class="agent-status ${agent?.state==='ready'?'success-text':agent?.state==='unavailable'?'error':'muted'}"><span class="dot"></span> ${esc(!connected?'Unknown · disconnected':agent?.label || 'Not checked')}</div></div></div>`}).join(''));
  setHTML($('connection-details'),`<p>${esc(data.health.message)}</p><p class="small muted">Last check: ${timeLabel(data.health.checked_at)}. Hermes readiness checks its CLI; it does not call the model.</p><label>OpenCode</label><pre>${esc(data.opencode_url)}</pre><label>Hermes profile</label><pre>${esc(data.profile)}</pre><label>Project</label><pre>${esc(data.project)}</pre>${current?.session?'<label>Attach from your server terminal</label><pre>'+esc('opencode attach '+shellQuote(data.opencode_url)+' --session '+shellQuote(current.session))+'</pre>':''}`);
}
function renderRun() {
  $('empty-state').classList.toggle('hidden',!!current);$('run-layout').classList.toggle('hidden',!current);
  if(!current)return;
  const steps=data.steps || [], pending=runRequests(), finished=ended.has(current.status), last=steps.at(-1), b=budget(current);
  const canResume=current.pause || ['interrupted','attention'].includes(current.status);
  const controls=finished?`<button class="ac-btn primary" data-action="followup">Start follow-up run</button>`:`<div class="row run-controls"><button class="ac-btn" data-action="pause" aria-label="${canResume?'Resume':'Pause after the active turn'}" aria-keyshortcuts="p">${icon(canResume?'play':'pause')}<span class="control-label">${canResume?'Resume':'Pause'}</span></button><button class="ac-btn danger-button" data-action="stop" aria-label="Stop run" aria-keyshortcuts="x">${icon('stop')}<span class="control-label">Stop</span></button></div>`;
  setHTML($('run-header'),`<header class="run-header">${statusHTML(current,pending)}<h1>${esc(current.goal.split('\n')[0].slice(0,150))}</h1><div class="run-meta"><span class="mono">${esc(data.project)}</span><span>${duration(b.used)} of ${duration(b.allowed)}</span><span>${finished?'Used':'Prompt'} ${steps.length} of ${current.max_steps}</span><span>Started ${timeLabel(current.created)}</span></div>${current.parent_run?`<p class="small muted">Follow-up to <button class="text-button" data-run="${esc(current.parent_run)}">#${esc(current.parent_run.slice(0,6))}</button></p>`:''}<details class="brief" data-key="brief-${esc(current.id)}"><summary>Read brief</summary><p>${esc(current.goal)}</p></details><div class="xp-only xp-time-meter" role="progressbar" aria-label="Run time budget used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100,Math.round(b.used/Math.max(1,b.allowed)*100))}"><span style="width:${Math.min(100,b.used/Math.max(1,b.allowed)*100)}%"></span></div><div class="run-actions">${controls}${current.pause && current.status!=='paused'?'<span class="small warning-text">Pause requested at the next boundary</span>':''}</div><p class="run-summary">${esc(current.summary)}</p></header>`);
  const files=fileStats(steps), verified=last?.verification?.status==='passed';
  setHTML($('outcome'),finished?`<section class="outcome-banner ${current.status}"><h2>${current.status==='completed'?(verified?'Completed with a passing verification command':'Completed · review only'):esc(stateLabel(current).text)}</h2><p class="small muted">${esc(current.summary)}</p><div class="outcome-stats"><div><small>Verification</small><strong>${verified?'Passed':last?.verification?.status==='failed'?'Failed':'Review only'}</strong><small>${verified?'Actual command output recorded':'See verification details'}</small></div><div><small>Prompts</small><strong>${steps.length} / ${current.max_steps}</strong><small>Budget used</small></div><div><small>Files</small><strong>${files.length}</strong><small>Captured paths</small></div></div></section>`:'');
  const phase=phaseIndex(current,steps);
  setHTML($('loop-strip'),finished?'':`<div class="loop-strip" aria-label="Workflow: ${['Plan','Prompt','Code','Verify','Complete'][phase]}">${['Plan','Prompt','Code','Verify'].map((name,i)=>`<div class="loop-step ${i<phase?'done':''} ${i===phase?'active':''} ${i===2&&pending.length?'waiting':''}"><span class="loop-dot">${i<phase?'✓':i===phase?'▶':'○'}</span><span>${name}${i===2&&pending.length?'<small>Waiting on you</small>':''}</span></div>`).join('')}<span class="loop-note">Loops while Hermes reviews the goal, within your limits.</span></div>`);
  setHTML($('turns'),steps.length?'<div class="xp-only turn-table-head"><span>Turn</span><span class="turn-from">From</span><span>Summary</span><span>Result</span></div>'+steps.map((s,i)=>turnHTML(s,i===steps.length-1&&!finished,pending)).join(''):'<section class="ac-panel"><h2 class="ac-panel__title">The next turn</h2><p class="small muted">Hermes is preparing the first coding prompt.</p></section>');
  $('steering-form').classList.toggle('hidden',finished);
  $('steering-form').querySelectorAll('button').forEach(button=>{if(button.title.includes('not supported'))return;button.disabled=!connected});
  setHTML($('inline-approvals'),pending.map(approvalCard).join('') || recentDecisionHTML());
  renderChecks();renderVerification();renderFiles(files);renderTimeline();
  setHTML($('original-brief'),finished?`<section class="ac-panel"><h2 class="ac-panel__title">Original brief</h2><p class="small">${esc(current.goal)}</p></section>`:'');
}
function turnHTML(step, expanded, pending) {
  const stats=step.evidence?.file_stats, changed=step.evidence?.changed_files || [], v=step.verification;
  const counts=stats?` · <span class="added">+${stats.reduce((n,x)=>n+x.added,0)}</span> <span class="removed">−${stats.reduce((n,x)=>n+x.removed,0)}</span>${stats.some(x=>x.partial)?' (partial)':''}`:'';
  const activity=step.activity || [], isLast=step.id===data.steps.at(-1)?.id;
  const held=isLast?pending.map(p=>`<div class="log-line held"><span class="log-text">${icon('terminal')} ${esc(requestText(p))} · waiting for your ${p.kind==='question'?'answer':'approval'}</span></div>`).join(''):'';
  return `<details class="ac-panel turn" data-key="turn-${esc(step.id)}" ${expanded?'open':''}><summary><span class="turn-number">${step.number}</span><span class="turn-from xp-only">Hermes → OpenCode</span><span class="turn-summary"><strong>${esc(step.title)}</strong><small>${changed.length?`${changed.length} captured file${changed.length===1?'':'s'}${counts}`:'File evidence pending'}</small></span><span class="turn-result ${v?.status==='passed'?'success-text':v?.status==='failed'?'error':'muted'}">${isLast&&pending.length?'Waiting for you':verificationLabel(step)}</span></summary><div class="turn-body"><div class="message"><div class="message-heading"><span class="agent-avatar hermes">H</span><span class="hermes-label">Hermes → OpenCode</span><time>${timeLabel(step.created)}</time></div><div class="message-content hermes-message">${esc(step.prompt)}</div></div><div class="message"><div class="message-heading"><span class="agent-avatar opencode">O</span><span class="opencode-label">OpenCode · ${esc(step.status)}</span></div><div class="activity-log">${activity.map((e,i)=>`<div class="log-line"><span class="log-text"><strong>${esc(e.kind)}</strong> ${esc(e.detail || e.status || '')}</span><time>${timeLabel(e.created)}</time></div>${e.output?`<details class="tool-output" data-key="tool-${esc(step.id)}-${i}"><summary>Tool output</summary><pre>${esc(e.output)}</pre></details>`:''}`).join('')}${!activity.length&&!held?'<div class="log-line muted">No timestamped tool activity recorded for this turn.</div>':''}${held}</div>${step.result?`<details class="brief" data-key="result-${esc(step.id)}" ${expanded?'open':''}><summary>OpenCode’s result</summary><div class="result-text">${esc(step.result)}</div></details>`:''}</div>${v?details('Verification · '+v.status,(v.argv? v.argv.join(' ')+'\n\n':'')+(v.output || 'No output.'),'verify-'+step.id):''}${step.evidence?`<button class="text-button" data-diff="${esc(step.id)}">View this turn’s diff</button>`:''}${step.hermes_verdict?`<p class="small"><strong class="hermes-label">Hermes’s review:</strong> ${esc(step.hermes_verdict.summary)} <span class="muted">(proposed ${esc(step.hermes_verdict.action)})</span></p>`:''}${expanded?`<p class="next-hint">Next: ${current.verifier.length?'AgentControl runs your verification command. Hermes reviews the output and captured changes.':'Hermes reviews the captured changes. No independent verification command is configured.'}</p>`:''}</div></details>`;
}
function renderChecks() {
  const checks=current.goal_checks || [], passed=checks.filter(c=>c.status==='passed').length;
  setHTML($('goal-checks'),`<section class="ac-panel"><h2 class="ac-panel__title">Goal checks ${checks.length?`<span class="check-ring mac-only" aria-hidden="true" style="--check-progress:${passed/checks.length*100}%"></span><span class="muted">· ${passed} of ${checks.length} verified</span>`:''}</h2>${checks.length?`<div class="check-progress" aria-label="${passed} of ${checks.length} checks verified">${checks.map(c=>`<span class="${['passed','failed'].includes(c.status)?c.status:''}"></span>`).join('')}</div><div class="terminal-only block-progress" aria-label="${passed} of ${checks.length} verified">${checks.map(c=>`<span class="${c.status==='passed'?'success-text':c.status==='failed'?'error':'muted'}">${c.status==='pending'?'░░':'██'}</span>`).join('')}</div>${checks.map(c=>`<div class="check-row ${esc(c.status)}"><span class="check-symbol">${c.status==='passed'?'✓':c.status==='failed'?'×':'○'}</span><span><span class="sr-only">${esc(c.status)}: </span>${esc(c.criterion)}${c.evidence?'<small>'+esc(pretty(c.evidence))+'</small>':''}</span></div>`).join('')}<p class="small muted">Individual verification evidence is not supplied yet. These are saved requirements.</p>`:'<p class="small muted">No separate goal checks were recorded for this run. The brief remains the source of requirements.</p>'}</section>`);
}
function renderVerification() {
  const step=[...data.steps].reverse().find(s=>s.verification), v=step?.verification;
  setHTML($('verification'),`<section class="ac-panel"><h2 class="ac-panel__title">Independent verification</h2>${v?`<span class="ac-status ${v.status==='passed'?'completed':v.status==='failed'?'failed':''}">${esc(v.status)}</span><p class="small muted">Turn ${step.number} · ${v.status==='not configured'?'No independent command configured.':'Command executed by AgentControl.'}</p>${details('Command and output',(v.argv?v.argv.join(' ')+'\n\n':'')+(v.output||'No output.'),'latest-verification')}`:`<p class="small muted">${current.verifier.length?'Your command runs after the coding turn finishes.':'Review only. No independent verification command was configured.'}</p>`}</section>`);
}
function renderFiles(files) {
  setHTML($('changed-files'),`<section class="ac-panel"><h2 class="ac-panel__title"><span class="not-terminal">Changed files</span><span class="terminal-only">diff --stat · captured</span></h2>${files.length?files.map(f=>`<div class="file-row">${icon('file')}<span class="file-path">${esc(f.path)}</span><span class="file-change">${esc(f.change)}</span>${f.added!==null?`<span class="file-counts"><span class="added">+${f.added}</span><span class="removed">−${f.removed}${f.partial?'*':''}</span></span>`:''}</div>`).join(''):'<p class="small muted">File changes appear after a coding turn finishes.</p>'}${files.length?'<button class="text-button" data-action="diff">View recorded diffs</button>':''}<p class="small muted">Counts cover captured text across turns; repeated edits can be counted again. Excluded files are not audited.</p></section>`);
}
function renderTimeline() {
  if(!ended.has(current.status)){setHTML($('run-timeline'),'');return}
  const steps=data.steps, verified=steps.filter(s=>s.verified).length;
  setHTML($('run-timeline'),`<section class="ac-panel"><h2 class="ac-panel__title">How the run went</h2><div class="timeline-item"><span class="agent-avatar hermes">H</span><div><strong class="small">Hermes planned</strong><p class="muted">${current.decision_count || 0} recorded planning decision${current.decision_count===1?'':'s'}.</p></div></div><div class="timeline-item"><span class="agent-avatar opencode">O</span><div><strong class="small">OpenCode worked</strong><p class="muted">${steps.length} coding prompt${steps.length===1?'':'s'} submitted in the managed session.</p></div></div><div class="timeline-item"><span class="agent-avatar hermes">✓</span><div><strong class="small">Evidence collected</strong><p class="muted">${verified} turn${verified===1?'':'s'} reached file comparison and verification review.</p></div></div><button class="text-button" data-view="activity">Open the full recorded activity</button></section>`);
}
function approvalCard(p) {
  const receipt=p.receipt, question=p.kind==='question';
  return `<article class="approval-card" tabindex="-1" data-approval-card="${esc(requestKey(p))}"><div class="approval-titlebar">${question?'Question from OpenCode':'Approval needed'}</div><div class="approval-icon">${icon('shield')}</div><h2>${esc(requestTitle(p))}</h2><pre class="command">${esc(requestText(p))}</pre><p class="approval-note muted">${receipt?esc(receiptLabel(receipt)):'Hermes has not provided a recommendation for this request.'}</p>${receipt?.redirect_saved?'<p class="small muted">Your redirection is saved for the next Hermes prompt.</p>':''}<div class="approval-actions">${question?`<button class="ac-btn primary" data-review="${esc(requestKey(p))}" data-intent="answer">${receipt?'View decision':'Answer question'}</button>`:receipt?`<button class="ac-btn" data-review="${esc(requestKey(p))}">View decision</button>`:`<button class="ac-btn" data-review="${esc(requestKey(p))}" data-intent="reject" aria-keyshortcuts="d">Deny and redirect</button><button class="ac-btn" data-review="${esc(requestKey(p))}" data-intent="approve" aria-keyshortcuts="a">Approve once</button>`}</div><button class="text-button" data-review="${esc(requestKey(p))}">Inspect full request</button><p class="policy-note">Run #${esc(p.run.slice(0,6))} · ${question?'Clarification':'Permission: '+esc(p.permission || 'unspecified')}<br>Applied policy details are not supplied by OpenCode.</p></article>`;
}
function recentDecisionHTML() {
  const r=data.reviews.find(r=>['confirmed','sent','uncertain','resolved'].includes(r.state) && !dismissedReceipts.has(requestKey(r)));
  if(!r)return '';
  return `<section class="notice ${r.state==='confirmed'?'success':''}"><div class="row between"><strong>${esc(receiptLabel(r))}</strong><button class="icon-button" data-dismiss="${esc(requestKey(r))}" aria-label="Dismiss decision confirmation">×</button></div><p class="small">${esc(requestText(r.request))}</p>${r.redirect_saved?'<p class="small">Redirection saved for Hermes’s next prompt.</p>':''}<button class="text-button" data-review="${esc(requestKey(r))}">View decision</button></section>`;
}
function renderApprovals() {
  setHTML($('approval-list'),data.inbox.length?data.inbox.map(approvalCard).join(''):'<section class="ac-panel"><h2>Nothing waiting on you.</h2><p class="muted small">New permission requests and questions will appear here.</p></section>');
  setHTML($('decision-history'),data.reviews.length?data.reviews.map(r=>`<button class="history-button" data-review="${esc(requestKey(r))}"><span class="${r.state==='confirmed'?(r.action==='reject'?'error':'success-text'):'warning-text'}">${r.state==='confirmed'?(r.action==='reject'?'×':'✓'):'◌'}</span><span><strong>${esc(receiptLabel(r))} · ${esc(requestTitle(r.request))}</strong><small>${esc(requestText(r.request).slice(0,120))}</small></span><time>${timeLabel(r.updated)}</time></button>`).join(''):'<p class="small muted">Decisions for the selected run will be recorded here.</p>');
}
function renderActivity() {
  const filter=$('event-filter').value;
  setHTML($('activity-list'),[...(data.events || [])].reverse().filter(e=>filter==='all'||e.kind.toLowerCase().includes(filter.toLowerCase())).map(e=>{let parsed;try{parsed=JSON.parse(e.detail)}catch{}const summary=parsed?.summary || parsed?.title || parsed?.status || (typeof parsed==='object'?'':e.detail);return `<article class="event"><div class="event-header"><strong>${esc(e.kind)}</strong><time>${timeLabel(e.created)}</time></div>${summary?`<p class="muted">${esc(String(summary).slice(0,260))}</p>`:''}${details('View recorded details',parsed?pretty(parsed):e.detail,'event-'+e.id)}</article>`}).join('') || '<p class="small muted">No activity matches this view.</p>');
}
function findRequest(id) {
  const p=data.inbox.find(p=>requestKey(p)===id);if(p)return p;
  const receipt=data.reviews.find(r=>requestKey(r)===id);return receipt?{...receipt.request,run:receipt.run,goal:current?.goal || '',receipt}:null;
}
function openReview(id, intent) {
  const found=findRequest(id);if(!found)return;
  reviewing=JSON.parse(JSON.stringify(found));reviewBusy=false;const p=reviewing, input=p.context?.input || {},meta=p.metadata || {};
  let html=`<span class="ac-status attention">OpenCode · #${esc(p.run.slice(0,6))}</span><h2>${esc(requestTitle(p))}</h2><p class="small muted">${esc(p.goal)}</p>`;
  if(p.kind==='permission') {
    html+=`<section class="request-section"><h3>Exact command or scope</h3><pre>${esc(requestText(p))}</pre></section>`;
    if(typeof meta.description==='string')html+=`<p class="small">${esc(meta.description)}</p>`;
    const diff=meta.diff || input.diff;
    if(diff)html+=`<section class="request-section"><h3>Proposed changes</h3><pre>${diffHTML(pretty(diff))}</pre></section>`;
    else if(input.oldString!==undefined || input.newString!==undefined)html+=`<section class="request-section"><h3>Current text</h3><pre>${esc(input.oldString || '')}</pre><h3>Proposed text</h3><pre>${esc(input.newString || '')}</pre></section>`;
    else if(typeof input.content==='string')html+=`<section class="request-section"><h3>Proposed file contents</h3><pre>${esc(input.content)}</pre></section>`;
    html+=`<label for="redirect-note">Redirection for Hermes <span class="muted">· sent when you deny</span></label><textarea id="redirect-note" rows="3" maxlength="5000">${esc(p.receipt?.redirect || 'Choose another approach that avoids this denied action and stays within my brief.')}</textarea><p class="small muted">Saved for the next Hermes planning turn. OpenCode receives the denial immediately.</p>`;
  } else html+=(p.questions || []).map((q,i)=>`<section class="question-block"><div class="eyebrow">${esc(q.header || 'Question '+(i+1))}</div><h3>${esc(q.question)}</h3>${(q.options || []).map(o=>`<label class="choice"><input type="${q.multiple?'checkbox':'radio'}" name="question-${i}" value="${esc(o.label)}"><span><strong>${esc(o.label)}</strong><small>${esc(o.description || '')}</small></span></label>`).join('')}${q.custom!==false?`<label class="choice"><input type="${q.multiple?'checkbox':'radio'}" name="question-${i}" data-custom-choice="${i}" value=""><span><strong>Write an answer</strong></span></label><label class="sr-only" for="custom-${i}">Custom answer ${i+1}</label><textarea id="custom-${i}" data-custom="${i}" rows="2" maxlength="5000"></textarea>`:''}</section>`).join('');
  html+=details('Full OpenCode request',pretty(Object.fromEntries(Object.entries(p).filter(([k])=>!['run','goal','receipt','fingerprint'].includes(k)))),'raw-request');
  html+='<div id="review-feedback" role="status"></div>';$('review-body').innerHTML=html;
  $('review-footer').innerHTML=`<small>${p.kind==='permission'?'Approval applies to this request only.':'Answers go to this OpenCode session.'}</small><button class="ac-btn danger-button" id="deny-review" aria-keyshortcuts="d">${p.kind==='permission'?'Deny and redirect':'Reject question'}</button><button class="ac-btn" id="approve-review" aria-keyshortcuts="a">${p.kind==='permission'?'Approve once':'Send answers'}</button>`;
  $('deny-review').onclick=()=>submitReview('reject');$('approve-review').onclick=()=>submitReview(p.kind==='permission'?'approve':'answer');
  p.receipt?.answers?.forEach((values,i)=>values.forEach(value=>{const inputs=[...$('review-body').querySelectorAll(`input[name="question-${i}"]`)];const option=inputs.find(el=>!el.hasAttribute('data-custom-choice')&&el.value===value);if(option)option.checked=true;else if($('custom-'+i)){const custom=inputs.find(el=>el.hasAttribute('data-custom-choice'));if(custom)custom.checked=true;$('custom-'+i).value=value}}));
  if(p.receipt && p.receipt.state!=='failed')$('review-body').querySelectorAll('input,textarea').forEach(e=>e.disabled=true);
  if(!$('review-dialog').open)$('review-dialog').showModal();refreshReview();
  if(intent==='reject' && $('redirect-note') && !p.receipt)$('redirect-note').focus();
}
function reviewFeedback(message,tone='') { const e=$('review-feedback');if(e){e.textContent=message;e.className=message?'notice '+tone:''} }
function refreshReview() {
  if(!$('review-dialog').open || !reviewing || reviewBusy || !data)return;
  const live=data.inbox.find(p=>requestKey(p)===requestKey(reviewing));
  const receipt=live?.receipt || data.reviews.find(r=>requestKey(r)===requestKey(reviewing)) || reviewing.receipt;
  const stale=!live || live.fingerprint!==reviewing.fingerprint || !live.fingerprint;
  const disabled=!connected || stale || !!receipt&&receipt.state!=='failed';
  $('approve-review').disabled=disabled;$('deny-review').disabled=disabled;
  if(!connected)reviewFeedback('Reconnecting. Decisions are unavailable until the controller responds.');
  else if(receipt?.state==='confirmed')reviewFeedback(receiptLabel(receipt)+'. OpenCode accepted the reply and no longer lists the request as pending.','success');
  else if(receipt?.state==='sent' || receipt?.state==='dispatching')reviewFeedback('Decision sent. Waiting for OpenCode to remove the pending request.');
  else if(receipt?.state==='uncertain')reviewFeedback('Delivery could not be confirmed. This decision will not be sent again automatically. Check the session in OpenCode.','danger');
  else if(receipt?.state==='resolved')reviewFeedback('This request is resolved. Delivery of the earlier reply could not be confirmed.');
  else if(receipt?.state==='failed')reviewFeedback((receipt.redirect_saved?'Your redirection was saved. ':'')+(receipt.error || 'Delivery failed. You may retry.'),'danger');
  else if(stale)reviewFeedback(live?'The action changed. Close this window and inspect the new request.':'This request is no longer pending.','danger');
}
async function submitReview(action) {
  if(reviewBusy || !reviewing || !connected)return;
  const p=reviewing;let answers,redirect;
  if(action==='answer'){
    answers=(p.questions || []).map((q,i)=>[...$('review-body').querySelectorAll(`input[name="question-${i}"]:checked`)].map(el=>el.hasAttribute('data-custom-choice')?$('custom-'+i).value.trim():el.value));
    if(answers.some(list=>!list.length || list.some(x=>!x))){reviewFeedback('Answer each question before sending.','danger');return}
  }
  if(action==='reject'&&p.kind==='permission'){redirect=$('redirect-note').value.trim();if(!redirect){reviewFeedback('Add a redirection for Hermes before denying.','danger');return}}
  reviewBusy=true;$('approve-review').disabled=true;$('deny-review').disabled=true;reviewFeedback('Sending your decision…');
  try{const receipt=await api('/api/review','POST',{run:p.run,kind:p.kind,request_id:p.request_id,fingerprint:p.fingerprint,action,...(answers?{answers}:{}),...(redirect?{redirect}:{})});p.receipt=receipt;toast(receiptLabel(receipt));await refresh()}
  catch(error){reviewFeedback(error.message,'danger')}
  finally{reviewBusy=false;refreshReview()}
}
function showView(next) {
  if(!['runs','approvals','activity','new'].includes(next))return;
  view=next;document.querySelectorAll('.view').forEach(e=>e.classList.toggle('hidden',e.id!=='view-'+next));
  document.querySelectorAll('.nav [data-view]').forEach(b=>{b.classList.toggle('active',b.dataset.view===next);b.setAttribute('aria-current',b.dataset.view===next?'page':'false')});
  closeDrawer();if(data)renderShell();
}
function openNew(followup=false) {
  if(followup && !current)return;
  parentRun=followup?current.id:null;
  if(followup){$('goal').value='';$('verify').value=current.verifier.map(shellQuote).join(' ');$('new-checks').innerHTML='';$('followup-context').textContent='Follow-up to #'+current.id.slice(0,6)+'. Its brief and summary will be supplied to Hermes.'}
  $('followup-context').classList.toggle('hidden',!followup);$('start-error').textContent='';showView('new');$('goal').focus();
}
function addCheckInput(text='') {
  if($('new-checks').children.length>=20){toast('A run supports up to 20 goal checks.');return}
  const row=document.createElement('div');row.className='new-check';
  const unique='criterion-'+Date.now()+'-'+Math.random().toString(36).slice(2,6);
  row.innerHTML=`<label for="${unique}" class="sr-only">Goal check</label><textarea id="${unique}" rows="1" maxlength="1000" required placeholder="A specific condition for completion">${esc(text)}</textarea><button type="button" class="icon-button" data-action="remove-check" aria-label="Remove goal check">×</button>`;
  $('new-checks').append(row);if(!text)row.querySelector('textarea').focus();
}
async function control(action,text='',id=current?.id) {
  if(!id)throw Error('Choose a run first.');
  const result=await api('/api/control','POST',{run:id,action,text});await refresh();return result;
}
function askStop() {
  if(!current || ended.has(current.status)){toast('There is no active run to stop.');return}
  stopRunId=current.id;$('stop-title').textContent='Stop run #'+current.id.slice(0,6)+'?';$('stop-error').textContent='';$('stop-dialog').showModal();
}
function focusSteer() { if(!current || ended.has(current.status)){toast('Steering is available during an active run.');return}showView('runs');$('steering').focus();$('steering').scrollIntoView({block:'center'}); }
function focusApproval() {
  if(!data?.inbox.length){toast('No requests are waiting.');return}
  showView('approvals');const card=$('approval-list').querySelector('[data-approval-card]');card?.scrollIntoView({block:'center'});card?.focus();
}
function keyboardReview(intent) {
  if($('review-dialog').open && reviewing){const button=$(intent==='approve'?'approve-review':'deny-review');if(!button.disabled)button.click();return}
  const p=runRequests()[0] || data?.inbox[0];if(p)openReview(requestKey(p),intent);else toast('No requests are waiting.');
}
function openDiff(stepId) {
  const steps=stepId?data.steps.filter(s=>s.id===stepId):data.steps;
  diffText=steps.filter(s=>s.evidence).map(s=>`# Turn ${s.number}: ${s.title}\n${s.evidence.diff || '(No captured text changes)'}${s.evidence.diff_truncated?'\n[Preview truncated]':''}`).join('\n\n');
  $('diff-body').innerHTML='<p class="small muted">Recorded text previews. This is not a complete repository audit.</p><pre>'+diffHTML(diffText || 'No file evidence captured yet.')+'</pre>';
  $('diff-dialog').showModal();
}
function closeDrawer() { $('sidebar').classList.remove('drawer-open');$('drawer-scrim').classList.add('hidden');document.querySelector('[data-action="drawer"]').setAttribute('aria-expanded','false'); }
function toggleDrawer() { const open=$('sidebar').classList.toggle('drawer-open');$('drawer-scrim').classList.toggle('hidden',!open);document.querySelector('[data-action="drawer"]').setAttribute('aria-expanded',String(open));if(open)$('sidebar').querySelector('button').focus(); }
async function act(action,button) {
  if(action==='new')openNew();
  else if(action==='followup')openNew(true);
  else if(action==='connections')$('connection-dialog').showModal();
  else if(action==='help')$('help-dialog').showModal();
  else if(action==='drawer')toggleDrawer();
  else if(action==='drawer-close')closeDrawer();
  else if(action==='focus-steer')focusSteer();
  else if(action==='focus-approval')focusApproval();
  else if(action==='stop')askStop();
  else if(action==='pause'){if(!current || ended.has(current.status)){toast('Choose an active run.');return}const resume=current.pause||['interrupted','attention'].includes(current.status);await control(resume?'resume':'pause');toast(resume?'Resuming the workflow':'Pause requested at the next boundary')}
  else if(action==='add-check'){if(!current || ended.has(current.status))return;$('check-error').textContent='';$('check-dialog').showModal();$('criterion').focus()}
  else if(action==='ask-status'){focusSteer();$('steering').value='At your next planning turn, summarize what is complete, what remains, and any blockers.';$('steering').focus()}
  else if(action==='new-check')addCheckInput();
  else if(action==='remove-check')button.closest('.new-check').remove();
  else if(action==='key-approve')keyboardReview('approve');
  else if(action==='key-deny')keyboardReview('reject');
  else if(action==='diff')openDiff();
  else if(action==='download-diff'){const url=URL.createObjectURL(new Blob([diffText],{type:'text/plain'}));const a=document.createElement('a');a.href=url;a.download='AgentControl-'+(current?.id || 'run')+'.diff';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
  else if(action==='check-connections'){await api('/api/check','POST',{});toast('Checking the Hermes CLI and OpenCode API…');await refresh()}
}
function ignoresShortcut(event) { return event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !!event.target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])'); }
function handleShortcut(event) {
  if(ignoresShortcut(event) || !data || $('app').classList.contains('hidden'))return;
  const modal=document.querySelector('dialog[open]');
  if(modal){if(modal.id==='review-dialog'&&['a','d'].includes(event.key)){event.preventDefault();keyboardReview(event.key==='a'?'approve':'reject')}return}
  const actions={a:'key-approve',d:'key-deny',p:'pause',x:'stop','/':'focus-steer'};
  if(actions[event.key]){event.preventDefault();act(actions[event.key]).catch(e=>pageError(e.message))}
}
function init() {
  setTheme(document.documentElement.dataset.theme,false);
  document.addEventListener('click',async event=>{
    const b=event.target.closest('button');if(!b || b.disabled)return;
    try {
      if(b.dataset.theme)setTheme(b.dataset.theme);
      if(b.dataset.close)$(b.dataset.close).close();
      if(b.dataset.view)showView(b.dataset.view);
      if(b.dataset.action)await act(b.dataset.action,b);
      if(b.dataset.run){selected=b.dataset.run;showView('runs');await refresh()}
      if(b.dataset.review)openReview(b.dataset.review,b.dataset.intent);
      if(b.dataset.diff)openDiff(b.dataset.diff);
      if(b.dataset.dismiss){dismissedReceipts.add(b.dataset.dismiss);renderRun()}
      if(b.dataset.step){const el=$('max-prompts');el.value=Math.max(1,Math.min(20,Number(el.value)+Number(b.dataset.step)))}
      if(b.closest('.xp-menu'))document.querySelectorAll('.xp-menu details[open]').forEach(e=>e.open=false);
    } catch(error){pageError(error.message)}
  });
  document.addEventListener('keydown',handleShortcut);
  document.addEventListener('keydown',event=>{if(!$('sidebar').classList.contains('drawer-open'))return;if(event.key==='Escape'){closeDrawer();document.querySelector('[data-action="drawer"]').focus()}if(event.key==='Tab'){const focusable=[...$('sidebar').querySelectorAll('button:not(:disabled),a[href]')].filter(e=>e.getClientRects().length);const first=focusable[0],last=focusable.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}}});
  $('drawer-scrim').onclick=closeDrawer;
  $('auth-form').onsubmit=async event=>{event.preventDefault();key=$('key').value.trim();try{sessionStorage.setItem('trial-dashboard-key',key)}catch{}$('auth-error').textContent='Connecting…';await refresh()};
  $('new-form').onsubmit=async event=>{
    event.preventDefault();$('start-error').textContent='';if($('verify-enabled').checked&&!$('verify').value.trim()){$('start-error').textContent='Enter a verification command or turn off independent verification.';return}$('start-run').disabled=true;
    try { const result=await api('/api/runs','POST',{goal:$('goal').value,verifier:$('verify-enabled').checked?$('verify').value:'',max_steps:Number($('max-prompts').value),run_minutes:Number($('run-minutes').value),goal_checks:[...$('new-checks').querySelectorAll('textarea')].map(e=>e.value.trim()),parent_run:parentRun});selected=result.id;parentRun=null;showView('runs');await refresh();toast('Hermes is preparing the first turn.') }
    catch(error){$('start-error').textContent=error.message;$('start-run').disabled=false}
  };
  $('verify-enabled').onchange=()=>{$('verify').disabled=!$('verify-enabled').checked;$('verify').required=$('verify-enabled').checked};
  $('steering-form').onsubmit=async event=>{event.preventDefault();const field=$('steering'),note=field.value.trim(),runId=current.id;try{await control('instruction',note,runId);if(field.value.trim()===note)field.value='';$('steering-feedback').textContent='Saved for the next Hermes prompt.'}catch(error){$('steering-feedback').textContent=error.message}};
  $('confirm-stop').onclick=async()=>{const id=stopRunId;$('confirm-stop').disabled=true;try{await control('stop','',id);$('stop-dialog').close();toast('Stop requested. Reconciling the OpenCode session.')}catch(error){$('stop-error').textContent=error.message}finally{$('confirm-stop').disabled=false}};
  $('check-form').onsubmit=async event=>{event.preventDefault();try{await control('goal_check',$('criterion').value);$('criterion').value='';$('check-dialog').close();toast('Goal check added for the next prompt.')}catch(error){$('check-error').textContent=error.message}};
  $('review-body').addEventListener('input',event=>{const i=event.target.dataset.custom;if(i!==undefined){const choice=$('review-body').querySelector(`input[data-custom-choice="${i}"]`);if(choice)choice.checked=true}});
  $('event-filter').onchange=renderActivity;
  $('example').onclick=()=>{$('goal').value='Build a small Python command-line todo app in demo_app/. It must add tasks, list tasks, mark tasks done, and save them to a JSON file. Use only the Python standard library. Include meaningful unittest tests. Preserve existing project files. Finish when the tests pass and a short usage README is present.';$('verify-enabled').checked=true;$('verify').disabled=false;$('verify').required=true;$('verify').value="python3 -m unittest discover -s demo_app -p 'test_*.py'";$('new-checks').innerHTML='';['Add, list, and complete tasks from the command line.','Save tasks to JSON and reload them.','Tests cover adding, completing, and save/reload behavior.','Document usage in demo_app/README.md.'].forEach(addCheckInput)};
  setInterval(refresh,2000);refresh();
}
if(typeof document!=='undefined')init();
if(typeof module!=='undefined' && module.exports)module.exports={esc,duration,budget,stateLabel,requestKey,requestTitle,requestText,receiptLabel,verificationLabel,fileStats,phaseIndex,ignoresShortcut,shellQuote};
