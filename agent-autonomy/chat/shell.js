(function (root) {
  'use strict';
  const {core,model:m} = root.AC, e = m.esc, $ = id=>document.getElementById(id);
  let focused = '', tab = 'session', locating = false, located = '', routedHash=null;
  let connectionsError='',pagingSessions=false,workspaceRoute=null,roomRoute='#/',workspaceOpener=null,workspaceContextOpen=false;
  const workspace=root.AC.workspace.mount($('workspace'));
  const members=root.AC.members.mount(()=>render(core.getState()));
  let contextOpen = core.read('localStorage','acx-context-open') === 'true';
  const decisions=root.AC.decisions.mount($('timeline'),$('decision-dialog'));
  const timeline = root.AC.thread.mount($('timeline'),{older:()=>core.loadOlder(),decisions});
  let menuError='', stopTarget=null, stopDraft=false, stopFocus=null;
  const composer = root.AC.composer.mount($('composer-host'),{bottom:()=>timeline.bottom(),stop:openStop,decision:(command,text)=>decisions.command(command,text),error:value=>{menuError=value;const node=$('control-error');if(node){node.textContent=value;node.hidden=!value;}},busy:controlBusy,stateChanged:()=>render(core.getState())});
  // Modal focus is presentation only: it never sends a request or changes a decision.
  let modal=null,activator=null,previousFocus=null,syncingFocus=false;
  const modalStack=[],inerted=new Map();
  function visible(node) {
    if(!node?.isConnected || node.closest('[hidden]'))return false;
    const style=root.getComputedStyle?.(node);if(style?.display==='none' || style?.visibility==='hidden')return false;
    if(node.getClientRects && !node.getClientRects().length)return false;
    for(let parent=node.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DIALOG' && !parent.hasAttribute('open') || parent.tagName==='DETAILS' && !parent.open && !parent.querySelector('summary')?.contains(node))return false;
    return true;
  }
  function focusable(node){return visible(node) && !node.disabled && !node.hasAttribute('disabled') && !node.closest('[inert]') && (!node.hasAttribute('tabindex') || Number(node.getAttribute('tabindex'))>=0);}
  function focusNodes(host){return [...host.querySelectorAll('button,a[href],input:not([type="hidden"]),textarea,select,summary,[tabindex]')].filter(focusable);}
  function restoreBackground(){for(const [node,saved] of inerted){for(const key of ['inert','aria-hidden','tabindex']){if(saved[key]===null)node.removeAttribute(key);else node.setAttribute(key,saved[key]);}}inerted.clear();}
  function isolate(host){
    for(let branch=host,parent=host.parentElement;parent && parent!==document.documentElement;branch=parent,parent=parent.parentElement)for(const node of parent.children)if(node!==branch && !['live','waiting-live'].includes(node.id)){
      const saved={};for(const key of ['inert','aria-hidden','tabindex'])saved[key]=node.getAttribute(key);inerted.set(node,saved);
      if(['scrim','settings-scrim'].includes(node.id)){node.setAttribute('aria-hidden','true');node.setAttribute('tabindex','-1');}
      else{node.setAttribute('inert','');node.setAttribute('aria-hidden','true');}
    }
  }
  function currentModal(){
    if($('app').hidden)return null;
    for(const id of ['decision-dialog','stop-dialog','project-dialog'])if($(id).hasAttribute('open'))return $(id);
    if(!$('settings-sheet').hidden)return $('settings-sheet');
    if(root.matchMedia?.('(max-width: 1199px)').matches){if($('app').classList.contains('rail-open'))return $('rail');if(!$('workspace').hidden)return $('workspace');if(!$('context').hidden)return $('context');}
    return null;
  }
  function safeFocus(host){return host.querySelector('[data-cancel-project],[data-cancel-decision],#cancel-stop,#close-settings,#close-rail,#close-context,[data-back-room]') || focusNodes(host)[0];}
  function syncModal(prior=previousFocus){
    if(syncingFocus)return;const next=currentModal();if(next===modal)return;
    syncingFocus=true;
    const old=modal;restoreBackground();modal=next;
    let returning=null;
    const index=modalStack.findIndex(record=>record.node===next);
    if(!next || index>=0){const closed=modalStack.splice(next?index+1:0);returning=closed[0]?.opener;}
    else{const node=activator && !next.contains(activator)?activator:prior && !next.contains(prior)?prior:$('composer');modalStack.push({node:next,opener:{node,id:node?.id}});}
    if(next)isolate(next);
    if(returning){const candidate=returning.node?.isConnected?returning.node:$(returning.id);if(focusable(candidate) && (!next || next.contains(candidate)))candidate.focus({preventScroll:true});else if(next)safeFocus(next)?.focus({preventScroll:true});else if(!visible(document.activeElement) || old?.contains(document.activeElement))$('timeline').focus({preventScroll:true});}
    else if(next)safeFocus(next)?.focus({preventScroll:true});
    syncingFocus=false;
  }
  document.addEventListener('click',event=>{const target=event.target.closest('button,a[href],input,textarea,summary,[tabindex]');if(target)activator=target;},true);
  document.addEventListener('keydown',()=>{if(!modal)activator=document.activeElement;},true);
  document.addEventListener('focusin',event=>{const prior=previousFocus;previousFocus=event.target;syncModal(prior);if(modal && !modal.contains(event.target) && !syncingFocus)safeFocus(modal)?.focus({preventScroll:true});});
  function controlBusy(value) {document.querySelectorAll('[data-session-control],#confirm-stop').forEach(node=>node.disabled=value);}
  const sessionHref = id=>'#/s/'+encodeURIComponent(id);
  function setContext(open) { contextOpen = open; core.write('localStorage','acx-context-open',String(open)); render(core.getState()); }
  function panels() {for(const node of document.querySelectorAll('#open-rail,#open-section-panel'))node.setAttribute('aria-expanded',String($('app').classList.contains('rail-open')));$('scrim').hidden = !$('app').classList.contains('rail-open') && $('context').hidden; }
  function render(snapshot) {
    if($('live').textContent!==snapshot.live)$('live').textContent=snapshot.live;
    decisions.update(snapshot);
    members.update(snapshot,focused);
    $('skip-conversation').hidden=!snapshot.authenticated;
    $('sign-in').hidden = snapshot.authenticated; $('app').hidden = !snapshot.authenticated;
    $('sign-in-error').textContent = snapshot.authError;
    $('banner').hidden = !snapshot.error; $('banner-text').textContent = snapshot.error;
    if (!snapshot.authenticated) {workspaceRoute=null;workspace.clear();$('app').classList.remove('workspace-open');composer.render(snapshot);if($('stop-dialog').hasAttribute('open'))closeStop();syncModal();return;}
    if (!snapshot.focused && focused && root.location.hash === '#/') focused = '';
    const state = snapshot.state;
    if (!state) { $('room-header').textContent = 'Connecting…'; return; }
    composer.render(snapshot);const controlState=composer.getView();
    const railData=m.railSessions(state,snapshot.thread,snapshot.channels?.channels?.[0]?.sessions),sessions=railData.sessions,roster=m.membersFromState({...state,agents:state.agents || []}),connections=m.connectionsFromState(state),team=m.teamFromRun(state.run);
    const channel = snapshot.channels?.channels?.[0], roomSession = snapshot.thread?.sessions[channel?.active_session];
    const name = channel?.title || m.projectName(state), active = roomSession && m.sessionsFromState({runs:[roomSession]})[0], threadSession = (snapshot.single || snapshot.thread)?.sessions[focused], selected = sessions.find(s=>s.id === focused) || (threadSession && m.sessionsFromState({runs:[{...threadSession,parent_run:threadSession.parent}]})[0]);
    const liveRun=channel?.active_session===state.run?.id?state.run.id:'';
    const menuOpen = $('session-menu')?.open;
    const detailsOpen = $('connections')?.open, moreOpen = $('more')?.open;
    const railScroll = $('rail').scrollTop, contextScroll = $('context').scrollTop;
    const focusedElement = document.activeElement, focusId = focusedElement?.id, focusHref = focusedElement?.getAttribute('href');
    const oldPanel=`<header><strong title="${e(state.project)}">${e(name)}</strong><button id="close-rail" aria-label="Close navigation"><span aria-hidden="true">×</span></button></header><section><h2>Channels</h2>${(snapshot.channels?.channels || m.channelsFromState(state)).map(channel=>`<a class="selected" href="#/" aria-current="page"># ${e(channel.title)}${channel.waiting ? `<span class="badge">${e(channel.waiting)}</span>` : ''}</a>`).join('')}<div id="rail-waiting">${channel?.waiting?`<a id="rail-waiting-link" href="#/">${m.symbolHTML('!')} ${e(channel.waiting)} waiting for you</a>`:'<p class="muted">Nothing is waiting for you</p>'}</div></section><section><h2>Sessions</h2><div id="session-list" role="list">${sessions.map(s=>`<div role="listitem"><a aria-label="${e(s.title+' · '+s.statusLabel)}" href="${e(sessionHref(s.id))}" class="${s.id === focused ? 'selected' : ''}" ${s.id === focused ? 'aria-current="true"' : ''}>${m.symbolHTML(s.symbol)}<span class="truncate" title="${e((state.runs || []).find(r=>r.id===s.id)?.title || snapshot.thread?.sessions[s.id]?.title || s.title)}">${e(s.title)}<small>${e(m.relTime(s.created))}</small></span></a></div>`).join('') || '<p class="muted">No sessions yet</p>'}</div>${railData.note?`<p id="session-count" class="muted">${e(railData.note)}</p>`:''}${channel?.sessions>sessions.length && snapshot.thread?.before?`<button id="load-earlier-sessions" ${pagingSessions?'disabled':''}>Load earlier sessions</button>`:''}</section><section><h2>Members</h2><ul class="members">${root.AC.members.rosterHTML(roster,false,liveRun)}</ul>${team.pending && state.run?.mode==='team'?'<p class="muted">Team plan pending</p>':''}</section><div class="rail-bottom"><details id="connections" ${detailsOpen ? 'open' : ''}><summary>${m.symbolHTML(connections.ready ? '●' : '!')} ${e(connections.label)}</summary><ul>${connections.items.map(item=>`<li data-member="service:${e(item.name)}"><strong>${e(item.name)}</strong><small>${m.statusMarkup(item.status)}</small><small>${e(item.label)}</small></li>`).join('')}</ul>${connections.message?`<p class="connection-message">${e(connections.message)}</p>`:''}<button id="rail-check-connections" ${snapshot.writeOwner?'disabled':''}>Check connections</button><p id="connections-error" role="status" ${connectionsError?'':'hidden'}>${e(connectionsError)}</p></details><details id="more" ${moreOpen ? 'open' : ''}><summary>More</summary>${['Skills','Usage','Activity','Settings','Switch project','Classic dashboard'].map(label=>`<a href="/classic">${label}</a>`).join('')}</details></div>`;
    // Keep menu entry identity and focus across the live render that follows Back.
    root.AC.members.patch($('room-header'),`<button id="open-rail" aria-label="Open navigation" aria-controls="rail" aria-expanded="${$('app').classList.contains('rail-open')}"><span aria-hidden="true">☰</span></button><div class="heading"><h1 title="${e(name)}">${e(name)}</h1><p title="${e(roomSession?.title || active?.title || 'Project room')}">${e(state.project)} · ${e(channel?.sessions ?? sessions.length)} sessions · ${e(active?.statusLabel || 'No active session')}</p></div><span id="connection-label" aria-hidden="true">${e(snapshot.live)}</span>${selected ? `<button id="open-context" aria-expanded="${contextOpen}">Session details</button>` : ''}<details id="session-menu" ${menuOpen ? 'open' : ''}><summary aria-label="Session menu"><span aria-hidden="true">⋯</span></summary><div>${active && !root.AC.composer.composerState(snapshot).reason ? `<button data-session-control="${controlState.paused ? 'resume' : 'pause'}">${controlState.paused ? 'Resume' : 'Pause'}</button><button data-session-control="stop">Stop…</button>` : ''}${liveRun && roster.length?`<section aria-labelledby="menu-workspaces-title"><h2 id="menu-workspaces-title">Turn details</h2>${roster.slice(0,50).map(member=>`<a id="menu-workspace-${e(encodeURIComponent(member.name))}" data-workspace-link href="${e(root.AC.members.workspaceHref(liveRun,member.name))}">${e(member.displayName)} · ${member.name==='hermes'?'Open log':'Open turn details'}</a>`).join('')}</section>`:''}<a href="/classic">Classic dashboard</a><p id="control-error" role="status" ${menuError ? '' : 'hidden'}>${e(menuError)}</p></div></details>`);
    const cache = snapshot.single || snapshot.thread;
    const count = snapshot.channels?.channels?.[0]?.waiting || 0;
    const waitingText=count+' waiting for you';if($('waiting-live').textContent!==waitingText)$('waiting-live').textContent=waitingText;
    $('waiting').innerHTML = count ? `<div class="waiting-strip"><button id="waiting-pointer">${m.symbolHTML("!")} ${e(count)} waiting for you</button><span aria-hidden="true"> · </span><a href="/classic">Open classic dashboard</a></div>` : '';
    if(!workspaceRoute && focused && cache && located !== focused && !locating) {
      locating=true;const id=focused;
      Promise.resolve().then(()=>core.locateSession(id)).then(()=>{if(focused===id){timeline.reveal(id);located=id;}}).catch(()=>{}).finally(()=>{locating=false;if(focused!==id)render(core.getState());});
    }
    $('context').hidden = !!workspaceRoute || !contextOpen || !selected;
    $('app').classList.toggle('workspace-open',!!workspaceRoute);
    workspace.render(snapshot,workspaceRoute,members.getState(),roomRoute);
    $('app').classList.toggle('context-open',!$('context').hidden);
    if (selected) {
      const detail=members.getState().data;
      const run = detail?.run?.id===selected.id?detail.run:state.run?.id === selected.id ? {...(state.runs || []).find(r=>r.id === selected.id),...state.run} : {...(threadSession || selected),...(state.runs || []).find(r=>r.id === selected.id)};
      const goalOpen = $('goal-details')?.open;
      root.AC.members.patch($('context'),`<header><div role="tablist" aria-label="Session context"><button id="session-tab" role="tab" aria-selected="${tab === 'session'}" tabindex="${tab==='session'?0:-1}" aria-controls="context-content">Session</button><button id="members-tab" role="tab" aria-selected="${tab === 'members'}" tabindex="${tab==='members'?0:-1}" aria-controls="context-content">${run.mode==='team'?'Team':'Members'}</button></div><button id="close-context" aria-label="Close context"><span aria-hidden="true">×</span></button></header><div id="context-content" role="tabpanel" aria-labelledby="${tab === 'session' ? 'session-tab' : 'members-tab'}">${tab === 'members' ? members.html() : `<h2>${e(selected.title)}</h2><h3>Goal</h3><details id="goal-details" ${goalOpen ? 'open' : ''}><summary>Show more</summary><p>${e(run.goal)}</p></details><p class="goal-preview">${e(run.goal)}</p><dl><dt>Status</dt><dd>${m.symbolHTML(selected.symbol)} ${e(selected.statusLabel)}</dd><dt>Created</dt><dd>${e(m.timeLabel(selected.created))}</dd><dt>Mode</dt><dd>${e(run.mode || 'single')}</dd><dt>Turns</dt><dd>${e(selected.promptCount)}</dd></dl>${run.verifier?.length ? `<h3>Verifier command</h3><pre>${e(Array.isArray(run.verifier) ? run.verifier.join(' ') : run.verifier)}</pre>` : ''}${selected.parent ? `<p>continues <a href="${e(sessionHref(selected.parent))}">${e(sessions.find(s=>s.id === selected.parent)?.title || selected.parent)}</a></p>` : ''}<a href="/classic">View in classic</a>`}</div>`);
    }
    if(cache) timeline.render(cache,snapshot.single ? focused : '');
    $('rail').scrollTop = railScroll; $('context').scrollTop = contextScroll;
    // Restore focus for replaced controls; the sign-in inputs and composer are never replaced.
    if (focusedElement && !$('app').contains(focusedElement)) {
      const replacement = focusId ? $(focusId) : [...$('app').querySelectorAll('a')].find(a=>a.getAttribute('href') === focusHref);
      if(focusable(replacement))replacement.focus({preventScroll:true});
    }
    root.AC.sections.render(snapshot,oldPanel);controlBusy(composer.getBusy());panels();syncModal();
  }
  function route() {
    const hash=root.location.hash || '#/';const sectionMatch=hash.match(/^#\/(primary|agents|projects|workspace|skills|settings)$/);
    if(sectionMatch){root.AC.sections.go(sectionMatch[1]);{workspaceRoute=null;workspace.clear();$('app').classList.remove('workspace-open','rail-open');render(core.getState());routedHash=hash;return;}}else root.AC.sections.go('projects');
    const next=root.AC.workspace.parseRoute(hash),returning=!!workspaceRoute && !next;let id='';
    if(next){if(!workspaceRoute){workspaceContextOpen=contextOpen;roomRoute=/^#\/s\/[^/]+$/.test(lastRoomRoute)?lastRoomRoute:'#/';workspaceOpener=document.activeElement?.matches('a,button,input,textarea,summary,[tabindex]')?document.activeElement:null;}workspaceRoute=next;id=next.run;}
    else{workspaceRoute=null;if(returning)contextOpen=workspaceContextOpen;try{const match=hash.match(/^#\/s\/([^/]+)$/);if(match)id=decodeURIComponent(match[1]);else if(!['#/','#/projects'].includes(hash))root.location.hash='#/';}catch{root.location.hash='#/';}lastRoomRoute=root.location.hash || '#/';}
    if(id!==focused){focused=id;located='';if(id && !next && !returning){contextOpen=true;core.write('localStorage','acx-context-open','true');}core.focus(id,!workspaceRoute);}
    $('app').classList.remove('rail-open');render(core.getState());routedHash=root.location.hash;
  }
  let lastRoomRoute=/^#\/s\/[^/]+$/.test(root.location.hash)?root.location.hash:'#/';
  function closeWorkspace(){
    const run=workspaceRoute?.run,opener=workspaceOpener;root.location.hash=roomRoute;route();
    let returning=opener?.isConnected?opener:opener?.id?$(opener.id):null;
    if(opener?.id?.startsWith('menu-workspace-') && !focusable(returning))returning=$('session-menu')?.querySelector('summary');
    if(returning?.closest('#rail') && root.matchMedia?.('(max-width: 1199px)').matches){$('app').classList.add('rail-open');panels();syncModal();}
    if(focusable(returning))returning.focus({preventScroll:true});else if(run)timeline.reveal(run,true);
  }
  $('connect-form').addEventListener('submit',event=>{event.preventDefault();core.connect($('dashboard-key').value,$('remember-key').checked);$('dashboard-key').value='';});
  $('dismiss-error').addEventListener('click',core.dismissError);
  document.addEventListener('click',event=>{
    if(event.target.closest('#skip-conversation')){event.preventDefault();$(root.AC.sections.getSection()==='projects'?'timeline':'section-stage').focus({preventScroll:true});return;}
    const workspaceLink=event.target.closest('[data-workspace-link]');if(workspaceLink){if(event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)return;event.preventDefault();workspaceOpener=workspaceLink;root.location.hash=workspaceLink.getAttribute('href');route();workspaceOpener=workspaceLink;$('workspace').querySelector('[data-back-room]')?.focus?.({preventScroll:true});return;}
    if(event.target.closest('[data-back-room]')){event.preventDefault();closeWorkspace();return;}
    const link=event.target.closest('[data-room-link]');if(link){event.preventDefault();if(workspaceRoute)closeWorkspace();if(root.matchMedia?.('(max-width: 1199px)').matches)setContext(false);locateRoomLink(link).catch(()=>{});return;}
    const reply=event.target.closest('[data-reply]');if(reply){event.preventDefault();composer.reply(reply.dataset.reply);}
    const action=event.target.closest('[data-session-control]')?.dataset.sessionControl;
    if(action==='stop')openStop({id:root.AC.composer.composerState(core.getState()).run,title:composer.activeTitle()});else if(action)composer.control(action);
    const id = event.target.closest('button')?.id;
    if(id==='cancel-stop')closeStop();
    if(id==='retry-team')members.retry();
    if(id==='rail-check-connections')checkConnections();
    if(id==='load-earlier-sessions' && !pagingSessions){pagingSessions=true;render(core.getState());core.loadOlder().catch(()=>{}).finally(()=>{pagingSessions=false;render(core.getState());});}
    if(id==='confirm-stop' && stopTarget){const target=stopTarget;if(root.AC.composer.composerState(core.getState()).run!==target.id){closeStop();menuError='The active session changed. Read its current state before stopping.';render(core.getState());}else composer.control('stop',stopDraft,target.id).then(ok=>{if(ok)closeStop();});}
    if (id === 'waiting-pointer' || event.target.closest('#rail-waiting-link,[data-locate-waiting]')) { event.preventDefault();$('app').classList.remove('rail-open');panels();syncModal(); if(root.location.hash !== '#/') {root.location.hash='#/';route();} core.locateWaiting().then(id=>{if(id)timeline.reveal(id);}).catch(()=>{}); }
    if (id === 'open-rail') {$('app').classList.add('rail-open');panels();}
    if (id === 'close-rail') {$('app').classList.remove('rail-open');panels();}
    if (id === 'open-context') setContext(!contextOpen);
    if (id === 'close-context') setContext(false);
    if (id === 'scrim') {$('app').classList.remove('rail-open');setContext(false);}
    if (id === 'session-tab' || id === 'members-tab') {tab = id === 'session-tab' ? 'session' : 'members';render(core.getState());}
  });
  document.addEventListener('click',()=>syncModal());
  for(const id of ['stop-dialog','decision-dialog'])$(id).addEventListener('close',()=>syncModal());
  async function locateRoomLink(link) {
    const kind=link.dataset.roomLink,run=link.dataset.run;
    const match=message=>message.session===run && (kind==='turn'?message.id===link.dataset.messageId:message.action!=null && message.kind!=='outcome' && (kind==='proposal'?message.kind==='proposal':message.actor===link.dataset.actor));
    let walks=0;
    for(;walks<=10;){
      const cache=core.getState().single || core.getState().thread;
      const id=cache?.ids.find(id=>match(cache.messages[id]));
      if(id){timeline.reveal(id);return;}
      if(walks===10 || !cache?.before)break;
      walks++;
      if(!await core.loadOlder())break;
    }
    if(kind==='waiting'){const id=await core.locateWaiting(Math.max(0,10-walks));if(id){timeline.reveal(id);return;}}
    root.location.hash=sessionHref(run);route();
  }
  async function checkConnections() {
    if(core.getState().writeOwner)return;
    connectionsError='';if(!core.beginWrite('connections'))return;
    try {await core.post('/api/check',{});await core.refreshNow();}
    catch(exception){if(core.getState().authenticated)connectionsError=exception.message;}
    finally{core.endWrite('connections');render(core.getState());}
  }
  function closeStop() {if($('stop-dialog').close)$('stop-dialog').close();else $('stop-dialog').removeAttribute('open');stopTarget=null;(stopFocus?.isConnected ? stopFocus : $('composer')).focus?.({preventScroll:true});}
  function openStop(target,clear=false) {if(!target.id || composer.getBusy())return;stopTarget=target;stopDraft=clear;stopFocus=clear?$('composer'):document.activeElement;if(clear)activator=$('composer');$('stop-title').textContent='Stop '+target.title+'?';if($('stop-dialog').showModal)$('stop-dialog').showModal();else $('stop-dialog').setAttribute('open','');$('cancel-stop').focus();}
  $('stop-dialog').addEventListener('cancel',event=>{event.preventDefault();closeStop();});
  document.addEventListener('keydown',event=>{
    syncModal();if(event.defaultPrevented)return;
    if(event.key==='Tab' && modal){const nodes=focusNodes(modal),index=nodes.indexOf(document.activeElement);if(!nodes.length || event.shiftKey && index<=0 || !event.shiftKey && (index<0 || index===nodes.length-1)){event.preventDefault();nodes[event.shiftKey?nodes.length-1:0]?.focus({preventScroll:true});}return;}
    const currentTab=event.target.closest?.('[role="tab"]');
    if(currentTab && ['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const tabs=[...$('context').querySelectorAll('[role="tab"]')],index=tabs.indexOf(currentTab),next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tab=tabs[next].id==='session-tab'?'session':'members';render(core.getState());$(tab+'-tab').focus();return;}
if(event.key==='Escape' && $('stop-dialog').hasAttribute('open')){event.preventDefault();closeStop();return;}if(event.key==='Escape' && workspaceRoute){event.preventDefault();closeWorkspace();return;}if (event.key === 'Escape') {$('app').classList.remove('rail-open');setContext(false);syncModal();}});
  root.addEventListener('hashchange',()=>{if(root.location.hash!==routedHash)route();});
  core.subscribe(render); route(); core.start();
  const shell = {render,route,prepareModal(opener){activator=opener;},getConnectionsError:()=>connectionsError,syncPanels(){panels();syncModal();},setContext,composer,decisions,members,workspace}; root.AC.shell = shell;
  if (typeof module !== 'undefined' && module.exports) module.exports = shell;
})(window);
