(function(root){
  'use strict';
  const {core,model:m,members}=root.AC,e=m.esc,$=id=>document.getElementById(id);
  const names=['Primary','Agents','Projects','Workspace','Skills','Settings'];
  const icons=['M4 5h16v12H9l-5 4V5z','M8 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 22v-4a6 6 0 0 1 12 0v4m2-12a4 4 0 0 0 0-8m2 12a6 6 0 0 1 4 6v4','M2 6h8l2 2h10v14H2V6z','M3 3h18v18H3V3zm0 6h18M9 9v12','M12 2v6m0 8v6M2 12h6m8 0h6M5 5l4 4m6 6 4 4M5 19l4-4m6-6 4-4','M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2m10-10 2-2'];
  const settings=['Connections','Approvals','Memory','Usage and activity','Appearance','Sign-in','Classic dashboard'];
  let section='projects',setting='Connections',browse=null,skills=null,browseError='',skillsError='',flights=new Map(),filter='',dialogKind='',selection=null,dialogError='',savedRoomFocus=null,savedScroll=0,returningRoom=false,loadedAuth=false,browseRequested=false;
  const icon=i=>`<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path d="${icons[i]}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
  function drawNav(snapshot){
    const count=snapshot.channels?.channels?.[0]?.waiting || 0;
    const links=names.map((name,i)=>`<a data-section="${name.toLowerCase()}" title="${name}" href="#/${name.toLowerCase()}" ${section===name.toLowerCase()?'aria-current="page"':''} ${name==='Projects' && count?`data-locate-waiting aria-label="Projects, ${e(count)} waiting for you"`:''}>${icon(i)}<span>${name}</span>${name==='Projects' && count?`<span class="projects-badge" aria-hidden="true">! ${e(count)}</span>`:''}</a>`).join('');
    members.patch($('section-nav'),`<button id="ac-mark" aria-label="AgentControl, open Primary">AC</button>${links}<button id="key-avatar" aria-label="Sign-in and key">○</button>`);
    members.patch($('bottom-nav'),links);
  }
  async function read(kind,path=''){
    const request=kind+':'+path;if(flights.has(request) || !core.getState().authenticated)return;
    if(kind==='browse')browseRequested=true;
    const task=core.readView(kind==='skills'?'/api/skills':'/api/projects/browse'+(path?'?path='+encodeURIComponent(path):''));flights.set(request,task);
    try{const data=await task;if(data){if(kind==='skills'){skills=data;skillsError='';}else{browse=data;browseError='';}}}catch(error){if(kind==='skills')skillsError=error.message;else browseError=error.message;}finally{flights.delete(request);root.AC.shell?.render(core.getState());}
  }
  function panelOpened(){if(section==='projects')read('browse');}
  function go(next){
    if(section===next)return;
    if(section==='projects' && next!=='projects'){if($('room').contains(document.activeElement))savedRoomFocus=document.activeElement;savedScroll=$('timeline').scrollTop;}
    const returning=section!=='projects' && next==='projects';returningRoom=returningRoom || returning;section=next;filter='';
    $('app').dataset.section=section;$('room').hidden=section!=='projects';$('section-stage').hidden=section==='projects';
    if(returning){$('timeline').scrollTop=savedScroll;if(savedRoomFocus?.isConnected && !savedRoomFocus.closest('[hidden]'))savedRoomFocus.focus({preventScroll:true});}
    if(next==='skills')read('skills');if(next==='projects' && root.matchMedia?.('(min-width: 1200px)').matches)read('browse');
  }
  const search=label=>`<label class="sr-only" for="panel-search">${e(label)}</label><input id="panel-search" type="search" placeholder="Search" value="${e(filter)}">`;
  function projectPanel(snapshot,oldHTML){
    const state=snapshot.state,path=state.project || '',rootPath=browse?.root || state.projects_root || '',name=m.projectName(state),relative=path===rootPath?'.':rootPath && path.startsWith(rootPath+'/')?path.slice(rootPath.length+1):path;
    const template=document.createElement('template');template.innerHTML=oldHTML;
    const sections=[...template.content.querySelectorAll('section')];
    const channel=sections[0]?.innerHTML || '',sessions=sections[1]?.outerHTML || '',roster=(sections[2]?.outerHTML || '').replace('<h2>Members</h2>','<h2>In this session</h2>');
    return `<header><button id="close-rail" aria-label="Close navigation">×</button><h2>Projects</h2><button id="create-project" aria-label="Create project">+</button></header>${search('Search projects')}<section id="current-project"><h3>${e(name)} <small>Current</small></h3><p class="directory">${e(relative)}</p>${channel}${sessions}${roster}</section><section id="project-folders"><h3>Folders in ${e(rootPath)}</h3><div class="browse-actions"><button data-browse-path="">Root</button>${browse?.parent?`<button data-browse-path="${e(browse.parent)}">Parent folder</button>`:''}<button id="refresh-folders">Refresh</button></div><p class="directory">${e(browse?.path || rootPath)}</p>${browseError?`<p role="alert">${e(browseError)}</p>`:''}${(browse?.entries || []).map((folder,i)=>`<div class="folder-row" data-filter="${e(folder.name)}"><button data-select-project="${i}"><strong>${e(folder.name)}</strong><small>${folder.git?'Git project':'No git · Team sessions need git'}</small></button><button data-browse-path="${e(folder.path)}" aria-label="Browse ${e(folder.name)}">›</button></div>`).join('')}${browse?.truncated?'<p class="muted">More folders exist. Open a folder to browse it.</p>':''}${!browse && !browseError?'<p role="status">Open the panel or Refresh to browse folders.</p>':''}</section>`;
  }
  function panel(){
    const head=title=>`<header><h2>${title}</h2><button id="close-rail" aria-label="Close navigation">×</button></header>`;
    if(section==='primary')return head('Primary')+search('Search Primary')+'<a href="#/primary" data-filter="Primary">Primary · Everyday</a>';
    if(section==='agents')return head('Agent library')+'<p class="muted">No agents yet</p>';
    if(section==='workspace')return head('Workspace')+search('Search Workspace').replace('type="search"','type="search" disabled aria-describedby="workspace-unavailable"')+'<p id="workspace-unavailable" class="muted">Not available yet</p>';
    if(section==='settings')return head('Settings')+search('Search Settings')+settings.map(name=>name==='Classic dashboard'?'<a href="/classic">Classic dashboard</a>':`<button data-filter="${e(name)}" data-setting="${e(name)}" ${setting===name?'aria-current="page"':''}>${e(name)}</button>`).join('');
    return head('Skills')+search('Search skills')+(skills?.library || []).map((skill,i)=>`<button data-skill-card="${i}" data-filter="${e(skill.name)}">${e(skill.name)}</button>`).join('');
  }
  function connectionHTML(snapshot){const c=m.connectionsFromState(snapshot.state);return `<details id="connections" open><summary>${m.symbolHTML(c.ready?'●':'!')} ${e(c.label)}</summary><ul>${c.items.map(item=>`<li data-member="service:${e(item.name)}"><strong>${e(item.name)}</strong><small>${m.statusMarkup(item.status)}</small><small>${e(item.label)}</small></li>`).join('')}</ul>${c.message?`<p class="connection-message">${e(c.message)}</p>`:''}<button id="rail-check-connections" ${snapshot.writeOwner?'disabled':''}>Check connections</button><p id="connections-error" role="status" ${root.AC.shell?.getConnectionsError()?'':'hidden'}>${e(root.AC.shell?.getConnectionsError() || '')}</p></details>`;}
  function settingHTML(snapshot){
    if(setting==='Connections')return connectionHTML(snapshot);
    if(setting==='Approvals')return '<p>Requests appear as cards in Projects. Critical requests need you to type <code>approve</code>.</p><p>A remembered approval covers identical requests in one session only, and can be revoked in classic. OpenCode\'s own permission settings decide which requests it asks about.</p><a href="/classic">Remembered approvals and full history: classic</a>';
    if(setting==='Memory')return [['Primary memory','Only the everyday thread. Survives project switches.'],['Specialist memory',"One store per library agent. Used by that agent's direct thread and by that agent inside a team."],['Project context','Notes and decisions for that directory. Visible to members of that project. Not written into primary memory.']].map(([name,scope])=>`<section class="memory-scope"><h2>${name}</h2><p>${scope}</p><p class="muted">Not available yet</p></section>`).join('');
    if(setting==='Appearance')return '<p>AgentControl uses one dark appearance.</p>';
    if(setting==='Sign-in')return '<p>This browser is signed in with the dashboard key.</p><button id="forget-key">Forget key and sign out</button><button id="phone-key-avatar" aria-label="Sign-in and key">Sign-in and key</button>';
    return '<a href="/classic">Usage</a><a href="/classic">Activity</a><a href="/classic">Settings</a>';
  }
  function stage(snapshot){
    const path=snapshot.state.project || '',title=names.find(n=>n.toLowerCase()===section),context={primary:'Everyday',agents:'Library',workspace:path+" · the current project's folder",skills:'Shared catalog · '+(skills?.library_path || ''),settings:setting}[section];
    let body='',action='';
    if(section==='primary')body='<div class="system-notice"><p>Your primary agent isn\'t available yet. It will be one everyday conversation that stays with you across projects.</p><p id="primary-reason">Not available yet</p></div><footer class="primary-composer"><label class="sr-only" for="primary-composer">Message the primary agent</label><textarea id="primary-composer" disabled placeholder="Message the primary agent" aria-describedby="primary-reason"></textarea></footer>';
    if(section==='agents')body='<p>Creating and configuring your own agents isn\'t available yet. Sessions choose their agents automatically. To see who is working, open <a href="#/projects" data-open-session-details>Projects › Session details</a>.</p><p class="muted">Direct conversations: Not available yet</p>';
    if(section==='workspace')body='<div id="project-files-empty"><p>Browsing project files isn\'t available yet.</p><p>Live preview, program, VM and desktop screens: <a href="/classic">Open in classic</a></p><p>Turn details for each agent are in Projects.</p></div>';
    if(section==='settings')body=settingHTML(snapshot);
    if(section==='skills'){
      action='<button id="refresh-skills">Refresh</button>';body=`<a href="/classic">Add or remove skills in classic</a>${skillsError?`<p role="alert">${e(skillsError)}</p>`:''}<div class="skill-grid">${(skills?.library || []).map((skill,i)=>`<article class="skill-card" id="skill-card-${i}" tabindex="-1"><h2>${e(skill.name)}</h2><details><summary class="clamp-three">${e(skill.description || 'Description')}</summary><p class="plain">${e(skill.description)}</p></details><p>${skill.error?'Problem: '+e(skill.error):'Ready'}</p><details><summary>${!skill.error && skill.risk==='sensitive'?'Sensitive':!skill.error && skill.risk==='low'?'Low':'Risk: not assessed'}</summary><ul>${(skill.reasons || []).map(reason=>`<li>${e(reason)}</li>`).join('')}</ul></details><p>${skill.trusted?'Reviewed version':'Not reviewed yet'}</p><p>Assigned to: assigning skills isn't available yet</p><p>Tool permission: uses the existing approval gate</p></article>`).join('')}</div>${skills && !skills.library?.length?`<p>No skills in ${e(skills.library_path)}.</p>`:''}`;
    }
    members.patch($('section-stage'),`<header class="section-header"><button id="open-section-panel" aria-label="Open navigation" aria-controls="rail" aria-expanded="${$('app').classList.contains('rail-open')}">☰</button><div class="heading"><h1>${title}</h1><p title="${e(context)}">${e(context)}</p></div><span class="muted">${e(snapshot.live)}</span>${action}</header><div class="section-content">${body}</div>`);
  }
  function applyFilter(){for(const node of $('rail').querySelectorAll('[data-filter]'))node.hidden=!node.dataset.filter.toLocaleLowerCase().includes(filter.toLocaleLowerCase());}
  function render(snapshot,oldPanel){
    if(!snapshot.authenticated){loadedAuth=false;browseRequested=false;browse=skills=null;return;}
    if(!snapshot.state)return;const skip=$('skip-conversation');skip.textContent=section==='projects'?'Skip to conversation':'Skip to '+names.find(name=>name.toLowerCase()===section);skip.setAttribute('href',section==='projects'?'#timeline':'#section-stage');drawNav(snapshot);if(returningRoom && section==='projects'){returningRoom=false;$('timeline').scrollTop=savedScroll;if(savedRoomFocus?.isConnected && !savedRoomFocus.closest('[hidden]'))savedRoomFocus.focus({preventScroll:true});}
    $('app').dataset.section=section;$('room').hidden=section!=='projects';$('section-stage').hidden=section==='projects';
    members.patch($('rail'),section==='projects'?projectPanel(snapshot,oldPanel):panel());applyFilter();
    if(section!=='projects')stage(snapshot);
    $('context').hidden=section!=='projects' || $('context').hidden;
    if(!loadedAuth){loadedAuth=true;if(section==='skills')read('skills');}
    if(section==='projects' && !browseRequested && !$('app').classList.contains('workspace-open') && root.matchMedia?.('(min-width: 1200px)').matches)read('browse');
    const channel=snapshot.channels?.channels?.[0],status=channel?.active_session?(snapshot.thread?.sessions[channel.active_session]?.status || snapshot.state.run?.status || 'Active'):'No active session';
    const summary=$('project-summary');if(summary)summary.innerHTML=`<strong>${e(m.projectName(snapshot.state))}</strong><span class="directory">${e(snapshot.state.project)}</span><span>${e(channel?.sessions ?? snapshot.state.runs?.length ?? 0)} ${(channel?.sessions ?? snapshot.state.runs?.length ?? 0)===1?'session':'sessions'} · ${e(status)} · ${e(channel?.waiting || 0)} waiting for you</span>`;
  }
  function dialog(kind,item,opener){root.AC.shell.prepareModal(opener);dialogKind=kind;selection=item;dialogError='';drawDialog();const host=$('project-dialog');if(host.showModal)host.showModal();else host.setAttribute('open','');host.querySelector('[data-cancel-project]')?.focus();}
  function drawDialog(){const host=$('project-dialog'),state=core.getState().state;
    host.innerHTML=`<h2 id="project-dialog-title">${dialogKind==='create'?'Create project':dialogKind==='forget'?'Forget key and sign out?':e('Switch to '+selection.name+'?')}</h2>${dialogKind==='create'?`<label for="project-name">Name</label><input id="project-name" required><label for="project-directory">Directory</label><input id="project-directory" readonly value="${e((browse?.root || state.projects_root || '')+'/')}"><p>AgentControl creates this folder with git and a first commit. Choosing agents for a project isn't available yet.</p>`:dialogKind==='select'?`<p>${e(m.projectName(state))}'s sessions stay in its history.</p>`:'<p>The key will be removed from this browser.</p>'}<p id="project-dialog-error" role="alert" hidden></p><div class="decision-dialog-buttons"><button id="confirm-project">${dialogKind==='create'?'Create project':dialogKind==='select'?'Switch project':'Forget key and sign out'}</button><button data-cancel-project autofocus>Cancel</button></div>`;
  }
  function closeDialog(){if($('project-dialog').close)$('project-dialog').close();else $('project-dialog').removeAttribute('open');}
  async function submitProject(){
    if(dialogKind==='forget'){closeDialog();core.signOut();return;}
    const name=$('project-name')?.value?.trim();if(dialogKind==='create' && !name){$('project-name').focus();return;}
    if(!core.beginWrite('project'))return;const kind=dialogKind,body=kind==='create'?{name}:{path:selection.path};$('confirm-project').disabled=true;
    try{await core.post('/api/projects/'+kind,body);closeDialog();core.focus('',false);root.location.hash='#/';root.AC.shell.route();await core.refreshNow();browse=null;await read('browse');}
    catch(error){if(core.getState().authenticated){$('project-dialog-error').textContent=error.message;$('project-dialog-error').hidden=false;}}
    finally{core.endWrite('project');$('confirm-project')?.removeAttribute('disabled');}
  }
  document.addEventListener('focusin',event=>{if($('room').contains(event.target))savedRoomFocus=event.target;});
  document.addEventListener('keydown',event=>{if(event.key==='Escape' && $('project-dialog').hasAttribute('open')){event.preventDefault();closeDialog();}});
  document.addEventListener('input',event=>{if(event.target.id==='panel-search'){filter=event.target.value;applyFilter();}if(event.target.id==='project-name')$('project-directory').value=(browse?.root || core.getState().state.projects_root || '')+'/'+event.target.value;});
  document.addEventListener('click',event=>{
    const target=event.target.closest('button,a');if(!target)return;
    if(target.id==='ac-mark')root.location.hash='#/primary';
    if(['key-avatar','phone-key-avatar'].includes(target.id)){setting='Sign-in';root.location.hash='#/settings';go('settings');root.AC.shell.route();}
    if(target.dataset.setting){setting=target.dataset.setting;root.AC.shell.render(core.getState());$('app').classList.remove('rail-open');root.AC.shell.syncPanels();$('section-stage').focus();}
    if(target.id==='open-section-panel'){$('app').classList.add('rail-open');panelOpened();root.AC.shell.render(core.getState());}
    if(target.id==='open-rail')panelOpened();
    if(target.id==='create-project')dialog('create',null,target);
    if(target.dataset.selectProject!==undefined)dialog('select',browse.entries[Number(target.dataset.selectProject)],target);
    if(target.id==='forget-key')dialog('forget',null,target);
    if(target.hasAttribute('data-cancel-project'))closeDialog();
    if(target.id==='confirm-project')submitProject();
    if(target.hasAttribute('data-browse-path'))read('browse',target.dataset.browsePath);
    if(target.id==='refresh-folders')read('browse');if(target.id==='refresh-skills')read('skills');
    if(target.dataset.skillCard!==undefined){$('app').classList.remove('rail-open');root.AC.shell.syncPanels();$('skill-card-'+target.dataset.skillCard)?.focus();}
    if(target.hasAttribute('data-open-session-details')){event.preventDefault();root.location.hash='#/projects';root.AC.shell.route();const active=core.getState().channels?.channels?.[0]?.active_session;if(active){root.location.hash='#/s/'+encodeURIComponent(active);root.AC.shell.route();}}
  });
  $('project-dialog').addEventListener('cancel',event=>{event.preventDefault();closeDialog();});
  root.AC.sections={go,render,panelOpened,getSection:()=>section};
})(window);
