(function (root) {
  'use strict';
  const {core,model:m} = root.AC, e = m.esc, $ = id=>document.getElementById(id);
  let focused = '', tab = 'session', locating = false, located = '';
  let contextOpen = core.read('localStorage','acx-context-open') === 'true';
  const decisions=root.AC.decisions.mount($('timeline'),$('decision-dialog'));
  const timeline = root.AC.thread.mount($('timeline'),{older:()=>core.loadOlder(),decisions});
  let menuError='', stopTarget=null, stopDraft=false, stopFocus=null;
  const composer = root.AC.composer.mount($('composer-host'),{bottom:()=>timeline.bottom(),stop:openStop,decision:(command,text)=>decisions.command(command,text),error:value=>{menuError=value;const node=$('control-error');if(node){node.textContent=value;node.hidden=!value;}},busy:controlBusy,stateChanged:()=>render(core.getState())});
  function controlBusy(value) {document.querySelectorAll('[data-session-control],#confirm-stop').forEach(node=>node.disabled=value);}
  const sessionHref = id=>'#/s/'+encodeURIComponent(id);
  function setContext(open) { contextOpen = open; core.write('localStorage','acx-context-open',String(open)); render(core.getState()); }
  function panels() { $('scrim').hidden = !$('app').classList.contains('rail-open') && $('context').hidden; }
  function memberList(members, full = false) { return members.map(member=>`<li><span class="member-name">${e(member.name)}</span><span class="muted">${e(member.role)}</span><span>${e(member.symbol)} ${e(member.stateLabel)}</span>${full && member.task ? `<p>${e(member.task)}</p>` : ''}${full && member.since ? `<small>Since ${e(m.timeLabel(member.since))}</small>` : ''}</li>`).join(''); }
  function render(snapshot) {
    decisions.update(snapshot);
    $('sign-in').hidden = snapshot.authenticated; $('app').hidden = !snapshot.authenticated;
    $('sign-in-error').textContent = snapshot.authError;
    $('banner').hidden = !snapshot.error; $('banner-text').textContent = snapshot.error;
    if (!snapshot.authenticated) {composer.render(snapshot);if($('stop-dialog').hasAttribute('open'))closeStop();return;}
    if (!snapshot.focused && focused && root.location.hash === '#/') focused = '';
    const state = snapshot.state;
    if (!state) { $('room-header').textContent = 'Connecting…'; return; }
    composer.render(snapshot);const controlState=composer.getView();
    const sessions = m.sessionsFromState(state), members = m.membersFromState(state), connections = m.connectionsFromState(state);
    const channel = snapshot.channels?.channels?.[0], roomSession = snapshot.thread?.sessions[channel?.active_session];
    const name = channel?.title || m.projectName(state), active = roomSession && m.sessionsFromState({runs:[roomSession]})[0], threadSession = (snapshot.single || snapshot.thread)?.sessions[focused], selected = sessions.find(s=>s.id === focused) || (threadSession && m.sessionsFromState({runs:[{...threadSession,parent_run:threadSession.parent}]})[0]);
    const menuOpen = $('session-menu')?.open;
    const detailsOpen = $('connections')?.open, moreOpen = $('more')?.open;
    const railScroll = $('rail').scrollTop, contextScroll = $('context').scrollTop;
    const focusedElement = document.activeElement, focusId = focusedElement?.id, focusHref = focusedElement?.getAttribute('href');
    $('rail').innerHTML = `<header><strong title="${e(state.project)}">${e(name)}</strong><button id="close-rail" aria-label="Close navigation">×</button></header><section><h2>Channels</h2>${(snapshot.channels?.channels || m.channelsFromState(state)).map(channel=>`<a class="selected" href="#/" aria-current="page"># ${e(channel.title)}${channel.waiting ? `<span class="badge">${e(channel.waiting)}</span>` : ''}</a>`).join('')}</section><section><h2>Sessions</h2><div id="session-list">${sessions.map(s=>`<a href="${e(sessionHref(s.id))}" class="${s.id === focused ? 'selected' : ''}" ${s.id === focused ? 'aria-current="true"' : ''}><span>${e(s.symbol)}</span><span class="truncate">${e(s.title)}<small>${e(m.relTime(s.created))}</small></span></a>`).join('') || '<p class="muted">No sessions yet</p>'}</div>${channel?.sessions > sessions.length ? `<p class="muted">Showing ${e(sessions.length)} of ${e(channel.sessions)} sessions · older sessions are in the room history</p>` : ''}</section><section><h2>Members</h2><ul class="members">${memberList(members)}</ul></section><div class="rail-bottom"><details id="connections" ${detailsOpen ? 'open' : ''}><summary>${connections.ready ? '●' : '!'} ${e(connections.label)}</summary><ul>${connections.items.map(item=>`<li>${e(item.name)}<small>${e(item.label)}</small></li>`).join('')}</ul></details><details id="more" ${moreOpen ? 'open' : ''}><summary>More</summary>${['Skills','Usage','Activity','Settings','Switch project','Classic dashboard'].map(label=>`<a href="/classic">${label}</a>`).join('')}</details></div>`;
    $('room-header').innerHTML = `<button id="open-rail" aria-label="Open navigation" aria-expanded="${$('app').classList.contains('rail-open')}">☰</button><div class="heading"><h1># ${e(name)}</h1><p>${active ? `${e(active.title)} · ${e(active.symbol)} ${e(active.statusLabel)}` : 'Project room'}</p></div><span id="live" role="status">${e(snapshot.live)}</span>${selected ? `<button id="open-context" aria-expanded="${contextOpen}">Session details</button>` : ''}<details id="session-menu" ${menuOpen ? 'open' : ''}><summary aria-label="Session menu">⋯</summary><div>${active && !root.AC.composer.composerState(snapshot).reason ? `<button data-session-control="${controlState.paused ? 'resume' : 'pause'}">${controlState.paused ? 'Resume' : 'Pause'}</button><button data-session-control="stop">Stop…</button>` : ''}<a href="/classic">Classic dashboard</a><p id="control-error" role="status" ${menuError ? '' : 'hidden'}>${e(menuError)}</p></div></details>`;
    const cache = snapshot.single || snapshot.thread;
    const count = snapshot.channels?.channels?.[0]?.waiting || 0;
    $('waiting').innerHTML = count ? `<div class="waiting-strip"><button id="waiting-pointer">! ${e(count)} waiting for you</button><span aria-hidden="true"> · </span><a href="/classic">Open classic dashboard</a></div>` : '';
    if(focused && cache && located !== focused && !locating) {
      locating=true;const id=focused;
      Promise.resolve().then(()=>core.locateSession(id)).then(()=>{if(focused===id){timeline.reveal(id);located=id;}}).catch(()=>{}).finally(()=>{locating=false;if(focused!==id)render(core.getState());});
    }
    $('context').hidden = !contextOpen || !selected;
    $('app').classList.toggle('context-open',!$('context').hidden);
    if (selected) {
      const run = state.run?.id === selected.id ? {...(state.runs || []).find(r=>r.id === selected.id),...state.run} : (state.runs || []).find(r=>r.id === selected.id) || threadSession || selected;
      const goalOpen = $('goal-details')?.open;
      $('context').innerHTML = `<header><div role="tablist" aria-label="Session context"><button id="session-tab" role="tab" aria-selected="${tab === 'session'}" aria-controls="context-content">Session</button><button id="members-tab" role="tab" aria-selected="${tab === 'members'}" aria-controls="context-content">Members</button></div><button id="close-context" aria-label="Close context">×</button></header><div id="context-content" role="tabpanel" aria-labelledby="${tab === 'session' ? 'session-tab' : 'members-tab'}">${tab === 'members' ? `<ul class="members">${memberList(members,true)}</ul>` : `<h2>${e(selected.title)}</h2><h3>Goal</h3><details id="goal-details" ${goalOpen ? 'open' : ''}><summary>Show more</summary><p>${e(run.goal)}</p></details><p class="goal-preview">${e(run.goal)}</p><dl><dt>Status</dt><dd>${e(selected.symbol)} ${e(selected.statusLabel)}</dd><dt>Created</dt><dd>${e(m.timeLabel(selected.created))}</dd><dt>Mode</dt><dd>${e(run.mode || 'single')}</dd><dt>Turns</dt><dd>${e(selected.promptCount)}</dd></dl>${run.verifier?.length ? `<h3>Verifier command</h3><pre>${e(Array.isArray(run.verifier) ? run.verifier.join(' ') : run.verifier)}</pre>` : ''}${selected.parent ? `<p>continues <a href="${e(sessionHref(selected.parent))}">${e(sessions.find(s=>s.id === selected.parent)?.title || selected.parent)}</a></p>` : ''}<a href="/classic">View in classic</a>`}</div>`;
    }
    if(cache) timeline.render(cache,snapshot.single ? focused : '');
    $('rail').scrollTop = railScroll; $('context').scrollTop = contextScroll;
    // Restore focus for replaced controls; the sign-in inputs and composer are never replaced.
    if (focusedElement && !$('app').contains(focusedElement)) {
      const replacement = focusId ? $(focusId) : [...$('app').querySelectorAll('a')].find(a=>a.getAttribute('href') === focusHref);
      replacement?.focus?.({preventScroll:true});
    }
    controlBusy(composer.getBusy());panels();
  }
  function route() {
    const hash = root.location.hash || '#/'; let id = '';
    try { const match = hash.match(/^#\/s\/([^/]+)$/); if (match) id = decodeURIComponent(match[1]); else if (hash !== '#/') root.location.hash = '#/'; } catch {root.location.hash = '#/';}
    if (id !== focused) { focused = id; located = ''; if (id) { contextOpen = true; core.write('localStorage','acx-context-open','true'); } core.focus(id); }
    $('app').classList.remove('rail-open'); render(core.getState());
  }
  $('connect-form').addEventListener('submit',event=>{event.preventDefault();core.connect($('dashboard-key').value,$('remember-key').checked);$('dashboard-key').value='';});
  $('dismiss-error').addEventListener('click',core.dismissError);
  document.addEventListener('click',event=>{
    const reply=event.target.closest('[data-reply]');if(reply){event.preventDefault();composer.reply(reply.dataset.reply);}
    const action=event.target.closest('[data-session-control]')?.dataset.sessionControl;
    if(action==='stop')openStop({id:root.AC.composer.composerState(core.getState()).run,title:composer.activeTitle()});else if(action)composer.control(action);
    const id = event.target.closest('button')?.id;
    if(id==='cancel-stop')closeStop();
    if(id==='confirm-stop' && stopTarget){const target=stopTarget;if(root.AC.composer.composerState(core.getState()).run!==target.id){closeStop();menuError='The active session changed. Read its current state before stopping.';render(core.getState());}else composer.control('stop',stopDraft,target.id).then(ok=>{if(ok)closeStop();});}
    if (id === 'waiting-pointer') { if(root.location.hash !== '#/') {root.location.hash='#/';route();} core.locateWaiting().then(id=>{if(id)timeline.reveal(id);}).catch(()=>{}); }
    if (id === 'open-rail') {$('app').classList.add('rail-open');panels();}
    if (id === 'close-rail') {$('app').classList.remove('rail-open');panels();}
    if (id === 'open-context') setContext(!contextOpen);
    if (id === 'close-context') setContext(false);
    if (id === 'scrim') {$('app').classList.remove('rail-open');setContext(false);}
    if (id === 'session-tab' || id === 'members-tab') {tab = id === 'session-tab' ? 'session' : 'members';render(core.getState());}
  });
  function closeStop() {if($('stop-dialog').close)$('stop-dialog').close();else $('stop-dialog').removeAttribute('open');stopTarget=null;(stopFocus?.isConnected ? stopFocus : $('composer')).focus?.({preventScroll:true});}
  function openStop(target,clear=false) {if(!target.id || composer.getBusy())return;stopTarget=target;stopDraft=clear;stopFocus=document.activeElement;$('stop-title').textContent='Stop '+target.title+'?';if($('stop-dialog').showModal)$('stop-dialog').showModal();else $('stop-dialog').setAttribute('open','');$('cancel-stop').focus();}
  $('stop-dialog').addEventListener('cancel',event=>{event.preventDefault();closeStop();});
  document.addEventListener('keydown',event=>{if(event.defaultPrevented)return;if(event.key==='Escape' && $('stop-dialog').hasAttribute('open')){event.preventDefault();closeStop();return;}if (event.key === 'Escape') {$('app').classList.remove('rail-open');setContext(false);}});
  root.addEventListener('hashchange',route);
  core.subscribe(render); route(); core.start();
  const shell = {render,route,setContext,composer,decisions}; root.AC.shell = shell;
  if (typeof module !== 'undefined' && module.exports) module.exports = shell;
})(window);
