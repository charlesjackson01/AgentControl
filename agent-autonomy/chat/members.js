(function(root){
  'use strict';
  const core=root.AC?.core,m=root.AC?.model || require('./model.js'),e=m.esc;
  const workspaceHref=(run,agent)=>'#/w/'+encodeURIComponent(run)+'/'+encodeURIComponent(agent);
  const href=id=>'#/s/'+encodeURIComponent(id);
  const omitted=n=>n?`<p class="muted">…and ${e(n)} more</p>`:'';
  const lines=(list,cls='')=>`<ul class="team-notes ${cls}">${list.items.map(value=>`<li>${e(m.boundText(value))}</li>`).join('')}</ul>${omitted(list.omitted)}`;
  function rosterHTML(members,full=false,run='') {
    return members.slice(0,50).map(member=>`<li data-member="${e(member.name)}"><span class="member-name">${e(member.displayName)}</span><span class="muted">${e(m.boundText(member.role))}</span><span>${e(member.symbol)} ${e(member.stateLabel)}</span>${full && member.task?`<p class="member-task" title="${e(member.task)}">${e(member.task)}</p>`:''}${full && member.since?`<small>since ${e(m.relTime(member.since))}</small>`:''}${full && member.activity?`<small>${e(member.activity)}</small>`:''}${full?`<a class="room-link" data-workspace-link href="${e(workspaceHref(run,member.name))}">${member.name==='hermes'?'Open log':'Open workspace'}</a>`:''}${full && member.state==='waiting_on_you'?`<a class="room-link" href="${e(href(run))}" data-room-link="waiting" data-run="${e(run)}" data-actor="${e(member.name)}">Go to waiting item</a>`:''}</li>`).join('');
  }
  function panelHTML(data) {
    const run=data.run || {},members=m.membersFromState({...data,agents:data.agents || []}),plan=m.teamFromRun(run),graph=m.tasksFromRun(run);
    let html=`<section><h3>Members</h3><ul id="live-members" class="members">${rosterHTML(members,true,run.id)}</ul>${members.length?'': '<p class="muted">No recorded members</p>'}${omitted(Math.max(0,members.length-50))}</section>`;
    if(run.mode!=='team')return html;
    const auto=plan.auto?`<p class="auto-note"><strong>Auto mode:</strong> ${e(plan.auto.outcome)}.</p>${lines(plan.auto.reasons,'muted')}`:'';
    const summary=plan.state==='proposed' && plan.pending?`<h3>${e(plan.summary)}</h3>`:`<p class="${plan.expired?'muted':''}">${e(plan.summary)}</p>`+(plan.state==='proposed'?'<h3>Proposed team · never approved</h3>':'');
    html+=`<section><h3>Team plan</h3>${auto}${plan.state==='single' && plan.auto?'':summary}`;
    if(plan.state==='proposed')html+=`<ul class="proposed-members">${plan.proposed.items.map(a=>`<li data-proposed="${e(a.name)}"><strong>${e(a.name)}</strong>${a.label?` <span class="muted">(${e(a.label)})</span>`:''}<p>${e(a.responsibility)}</p></li>`).join('')}</ul>${omitted(plan.proposed.omitted)}${lines(plan.warnings,'warning')}${plan.proposals!==undefined?`<p class="muted">Proposal ${e(plan.proposals)}</p>`:''}`;
    if(plan.state==='unusable')html+=lines(plan.problems);
    if(plan.pending && ['proposed','unusable'].includes(plan.state))html+=`<a class="room-link" href="${e(href(run.id))}" data-room-link="proposal" data-run="${e(run.id)}">Decide in the room</a>`;
    html+='</section>';
    if(graph.total)html+=`<section class="task-graph"><h3>Tasks · ${e(graph.done)} of ${e(graph.total)} done</h3>${graph.groups.map(group=>`<section class="task-group" data-depth="${e(group.depth)}"><h3 id="task-depth-${e(group.depth)}">${e(group.label)}</h3><ul aria-labelledby="task-depth-${e(group.depth)}">${group.tasks.map(task=>`<li data-task="${e(task.id)}"><div class="task-title">${task.turn?`<button data-room-link="turn" data-run="${e(run.id)}" data-message-id="${e(task.turn)}" aria-label="Show the latest turn of task ${e(task.id)}: ${e(task.title)}">${e(task.id)}</button>`:`<span class="task-id">${e(task.id)}</span>`}<strong>${e(task.title)}</strong></div><small>${e(task.agent)}</small>${members.find(a=>m.agentLabel(a.name,run)===task.agent)?`<a class="room-link" data-workspace-link href="${e(workspaceHref(run.id,members.find(a=>m.agentLabel(a.name,run)===task.agent).name))}">Workspace</a>`:''}${task.dependencies.items.length?`<small>After ${e(task.dependencies.items.map(m.boundText).join(', '))}</small>${omitted(task.dependencies.omitted)}`:''}<p>${e(task.symbol)} ${e(task.label)}${task.attempts>1?' · '+e(task.attempts)+' tries':''}</p>${task.reason?`<p class="muted task-reason">${e(task.reason)}</p>`:''}</li>`).join('')}</ul></section>`).join('')}${omitted(graph.omitted)}</section>`;
    return html;
  }
  // Reconcile keyed items and their children in place; focused links and scroll survive reads.
  function patch(host,html) {
    const focused=host.contains(document.activeElement)?document.activeElement:null;
    const owner=focused?.closest('[data-task],[data-member]');
    const template=document.createElement('template');template.innerHTML=html;
    const key=node=>node.nodeType!==1?'':node.id?'id:'+node.id:['data-member','data-proposed','data-task','data-depth'].find(a=>node.hasAttribute(a))?['data-member','data-proposed','data-task','data-depth'].filter(a=>node.hasAttribute(a)).map(a=>a+':'+node.getAttribute(a)).join('|'):node.hasAttribute('data-workspace-link')?'workspace:'+(node.closest('[data-task]')?.getAttribute('data-task') || node.closest('[data-member]')?.getAttribute('data-member'))+':'+node.getAttribute('href'):node.hasAttribute('data-room-link')?'room:'+node.getAttribute('data-room-link')+':'+node.getAttribute('data-run')+':'+(node.getAttribute('data-room-link')==='turn' ? node.closest('[data-task]')?.getAttribute('data-task') || node.getAttribute('data-message-id') : node.getAttribute('data-actor') || ''):node.tagName==='A' && node.getAttribute('href')?.startsWith('#/')?'href:'+node.getAttribute('href'):'';
    const keyed=new Map([...host.querySelectorAll('*')].map(node=>[key(node),node]).filter(([key])=>key));
    function sync(parent,fresh) {
      const old=[...parent.childNodes],used=new Set();let cursor=parent.firstChild;
      for(const next of [...fresh.childNodes]) {
        const id=key(next);let node=id?keyed.get(id):old.find(n=>!used.has(n) && !key(n) && n.nodeType===next.nodeType && n.nodeName===next.nodeName);
        if(!node || node.nodeName!==next.nodeName)node=next.cloneNode(false);
        used.add(node);
        if(next.nodeType===1){for(const a of [...node.attributes])if(!next.hasAttribute(a.name))node.removeAttribute(a.name);for(const a of [...next.attributes])if(node.getAttribute(a.name)!==a.value)node.setAttribute(a.name,a.value);sync(node,next);}else if(node.nodeValue!==next.nodeValue)node.nodeValue=next.nodeValue;
        if(node!==cursor)parent.insertBefore(node,cursor);cursor=node.nextSibling;
      }
      for(const node of [...parent.childNodes])if(!used.has(node))node.remove();
    }
    sync(host,template.content);
    if(focused && (!focused.isConnected || document.activeElement!==focused)){if(focused.isConnected)focused.focus?.({preventScroll:true});else if(owner?.isConnected){const target=owner.querySelector('button,a,summary') || owner;if(target===owner)target.tabIndex=-1;target.focus?.({preventScroll:true});}}
  }
  function mount(changed) {
    const reader=core.selectedSession(changed);
    function html(){const {loading,error,data}=reader.getState();return loading?'<p role="status">Loading team…</p>':error?`<p role="status">${e(error)}</p><button id="retry-team">Retry</button>`:data?panelHTML(data):'<p class="muted">No recorded members</p>';}
    return {...reader,html};
  }
  const members={mount,patch,panelHTML,rosterHTML};
  root.AC=root.AC || {};root.AC.members=members;
  if(typeof module!=='undefined' && module.exports)module.exports=members;
})(typeof window!=='undefined'?window:globalThis);
