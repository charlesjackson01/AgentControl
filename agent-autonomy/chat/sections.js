(function(root){
  'use strict';
  const {core,model:m,members}=root.AC,e=m.esc,$=id=>document.getElementById(id);
  const names=['Primary','Agents','Projects','Workspace','Skills','Settings'];
  const icons=['M4 5h16v12H9l-5 4V5z','M8 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 22v-4a6 6 0 0 1 12 0v4m2-12a4 4 0 0 0 0-8m2 12a6 6 0 0 1 4 6v4','M2 6h8l2 2h10v14H2V6z','M3 3h18v18H3V3zm0 6h18M9 9v12','M12 2v6m0 8v6M2 12h6m8 0h6M5 5l4 4m6 6 4 4M5 19l4-4m6-6 4-4','M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2m10-10 2-2'];
  const settings=['Connections','Approvals','Memory','Usage and activity','Appearance','Sign-in','Classic dashboard'];
  let section='projects',setting='Connections',browse=null,folder=null,folderError='',addMenuOpen=false,skills=null,browseError='',skillsError='',flights=new Map(),filter='',dialogKind='',selection=null,dialogError='',savedRoomFocus=null,savedScroll=0,returningRoom=false,loadedAuth=false,browseRequested=false;
  const icon=i=>`<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path d="${icons[i]}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
  function drawNav(snapshot){
    const count=snapshot.channels?.channels?.[0]?.waiting || 0;
    // D13: the Projects count is the only waiting cue outside the cards; it locates the first card.
    const links=names.map((name,i)=>`<a data-section="${name.toLowerCase()}" title="${name}" href="#/${name.toLowerCase()}" ${section===name.toLowerCase()?'aria-current="page"':''} aria-label="${name==='Projects' && count?`Projects, ${e(count)} waiting for you`:name}" ${name==='Projects' && count?'data-locate-waiting':''}>${icon(i)}<span class="nav-label">${name}</span>${name==='Projects' && count?`<span class="projects-badge" aria-hidden="true">! ${e(count)}</span>`:''}</a>`).join('');
    members.patch($('section-nav'),`<button id="ac-mark" aria-label="AgentControl, open Primary">AC</button>${links}<button id="key-avatar" aria-label="Sign-in and key">○</button>`);
    members.patch($('bottom-nav'),links);fitBottomLabels();
  }
  // Below 720px: every label when all six fit on one line in equal cells, otherwise only the active item's label.
  // Hidden labels keep their natural width (scrollWidth), so measuring never toggles the layout it measures.
  const labelObserver=root.ResizeObserver?new root.ResizeObserver(()=>fitBottomLabels()):null;
  function fitBottomLabels(){
    const bar=$('bottom-nav');if(!bar)return;
    const labels=[...bar.querySelectorAll('.nav-label')];if(labelObserver){labelObserver.observe(bar);for(const label of labels)labelObserver.observe(label);}
    if(!bar.getClientRects?.().length || !labels.length)return;
    const cell=bar.clientWidth/labels.length,crowded=labels.some(label=>label.scrollWidth>cell);
    if(bar.classList.contains('active-label-only')!==crowded)bar.classList.toggle('active-label-only',crowded);
  }
  root.addEventListener?.('resize',fitBottomLabels);
  async function read(kind,path=''){
    const request=kind+':'+path;if(flights.has(request) || !core.getState().authenticated)return;
    if(kind==='browse')browseRequested=true;
    const task=core.readView(kind==='skills'?'/api/skills':'/api/projects/browse'+(path?'?path='+encodeURIComponent(path):''));flights.set(request,task);
    try{const data=await task;if(data){if(kind==='skills'){skills=data;skillsError='';}else if(kind==='folder'){folder=data;folderError='';}else{browse=data;browseError='';}}}catch(error){if(kind==='skills')skillsError=error.message;else if(kind==='folder')folderError=error.message;else browseError=error.message;}finally{flights.delete(request);if(kind==='folder' && dialogKind==='folder' && $('project-dialog').hasAttribute('open'))drawDialog(true);root.AC.shell?.render(core.getState());}
  }
  function panelOpened(){if(section==='projects')read('browse');}
  function go(next){
    if(section===next)return;
    if(section==='projects' && next!=='projects'){if($('room').contains(document.activeElement))savedRoomFocus=document.activeElement;savedScroll=$('timeline').scrollTop;}
    const returning=section!=='projects' && next==='projects';returningRoom=returningRoom || returning;section=next;filter='';addMenuOpen=false;
    $('app').dataset.section=section;$('room').hidden=section!=='projects';$('section-stage').hidden=section==='projects';
    if(returning){$('timeline').scrollTop=savedScroll;if(savedRoomFocus?.isConnected && !savedRoomFocus.closest('[hidden]'))savedRoomFocus.focus({preventScroll:true});}
    if(next==='skills')read('skills');if(next==='projects' && root.matchMedia?.('(min-width: 1200px)').matches)read('browse');
  }
  const search=label=>`<label class="sr-only" for="panel-search">${e(label)}</label><input id="panel-search" type="search" placeholder="Search" value="${e(filter)}">`;
  // D13: Projects only. The current project, then the git projects inside the projects root.
  function projectPanel(snapshot){
    const state=snapshot.state,path=state.project || '',rootPath=browse?.root || state.projects_root || '',name=m.projectName(state);
    const rows=(browse?.entries || []).map((entry,i)=>({entry,i})).filter(({entry})=>entry.git && entry.path!==path);
    return `<header><button id="close-rail" aria-label="Close projects">×</button><h2>Projects</h2><div id="project-add"><button id="project-add-button" aria-label="Add project" aria-haspopup="true" aria-expanded="${addMenuOpen}" aria-controls="project-add-menu">+</button><div id="project-add-menu" ${addMenuOpen?'':'hidden'}><button id="create-project">Create project</button><button id="open-folder">Open folder…</button></div></div></header>${search('Search projects')}<div id="project-list" role="list"><div role="listitem" id="current-project" data-filter="${e(name)}"><span class="project-row current" aria-current="true"><span class="avatar-tile" aria-hidden="true">${e(name.slice(0,1).toUpperCase())}</span><span class="project-meta"><strong>${e(name)}</strong><small>Current</small><span class="directory">${e(path)}</span></span></span></div>${rows.map(({entry,i})=>`<div role="listitem" class="project-item" data-filter="${e(entry.name)}"><button class="project-row" data-select-project="${i}"><span class="avatar-tile" aria-hidden="true">${e(entry.name.slice(0,1).toUpperCase())}</span><span class="project-meta"><strong>${e(entry.name)}</strong><span class="directory">${e(entry.path || (rootPath ? rootPath+'/'+entry.name : entry.name))}</span></span></button></div>`).join('')}</div>${browseError?`<p role="alert">${e(browseError)}</p>`:''}${browse?.truncated?'<p class="muted">More folders exist. Use Open folder… to browse them.</p>':''}${!browse && !browseError?'<p role="status" class="muted">Looking for projects…</p>':''}`;
  }
  function panel(){
    const head=title=>`<header><h2>${title}</h2><button id="close-rail" aria-label="Close navigation">×</button></header>`;
    if(section==='primary')return head('Primary')+search('Search Primary')+'<a href="#/primary" data-filter="Primary">Primary · Everyday</a>';
    if(section==='agents')return head('Agent library')+'<p class="muted">No agents yet</p>';
    if(section==='workspace')return head('Workspace')+search('Search Workspace').replace('type="search"','type="search" disabled aria-describedby="workspace-unavailable"')+'<p id="workspace-unavailable" class="muted">Not available yet</p>';
    if(section==='settings')return head('Settings')+search('Search Settings')+settings.map(name=>`<button data-filter="${e(name)}" data-setting="${e(name)}" ${setting===name?'aria-current="page"':''}>${e(name)}</button>`).join('');
    return head('Skills')+search('Search skills')+(skills?.library || []).map((skill,i)=>`<button data-skill-card="${i}" data-filter="${e(skill.name)}">${e(skill.name)}</button>`).join('');
  }
  function connectionHTML(snapshot){const c=m.connectionsFromState(snapshot.state);return `<details id="connections" open><summary>${m.symbolHTML(c.ready?'●':'!')} ${e(c.label)}</summary><ul>${c.items.map(item=>`<li data-member="service:${e(item.name)}"><strong>${e(item.name)}</strong><small>${m.statusMarkup(item.status)}</small><small>${e(item.label)}</small></li>`).join('')}</ul>${c.message?`<p class="connection-message">${e(c.message)}</p>`:''}<button id="rail-check-connections" ${snapshot.writeOwner?'disabled':''}>Check connections</button><p id="connections-error" role="status" ${root.AC.shell?.getConnectionsError()?'':'hidden'}>${e(root.AC.shell?.getConnectionsError() || '')}</p></details>`;}
  function settingHTML(snapshot){
    if(setting==='Connections')return connectionHTML(snapshot);
    if(setting==='Approvals')return '<p>Requests appear as cards in Projects. Critical requests need you to type <code>approve</code>.</p><p>A remembered approval covers identical requests in one session only, and can be revoked in classic. OpenCode\'s own permission settings decide which requests it asks about.</p><a href="/classic">Remembered approvals and full history: classic</a>';
    if(setting==='Memory')return [['Primary memory','Only the everyday thread. Survives project switches.'],['Specialist memory',"One store per library agent. Used by that agent's direct thread and by that agent inside a team."],['Project context','Notes and decisions for that directory. Visible to members of that project. Not written into primary memory.']].map(([name,scope])=>`<section class="memory-scope"><h2>${name}</h2><p>${scope}</p><p class="muted">Not available yet</p></section>`).join('');
    if(setting==='Appearance')return '<p>AgentControl uses one dark appearance.</p>';
    if(setting==='Sign-in')return '<p>This browser is signed in with the dashboard key.</p><button id="forget-key">Forget key and sign out</button><button id="phone-key-avatar" aria-label="Sign-in and key">Sign-in and key</button>';
    if(setting==='Classic dashboard')return '<p>The classic dashboard keeps the controls that are not in this app yet.</p><ul class="classic-list"><li><a href="/classic">Open classic dashboard</a></li><li>Internet during work, paid models and the stuck watch: set them in classic Settings.</li><li>Add or remove skills: classic Skills.</li><li>Live preview, program, VM and desktop screens: classic Workspace. Each turn\'s Turn details also has its own pop-out.</li><li>Remembered approvals and full history: classic Approvals.</li></ul>';
    return '<a href="/classic">Usage</a><a href="/classic">Activity</a><a href="/classic">Settings</a>';
  }
  function stage(snapshot){
    const path=snapshot.state.project || '',title=names.find(n=>n.toLowerCase()===section),context={primary:'Everyday',agents:'Library',workspace:path+" · the current project's folder",skills:'Shared catalog · '+(skills?.library_path || ''),settings:setting}[section];
    let body='',action='';
    if(section==='primary')body='<div class="system-notice"><p>Your primary agent isn\'t available yet. It will be one everyday conversation that stays with you across projects.</p><p id="primary-reason">Not available yet</p></div><footer class="primary-composer"><label class="sr-only" for="primary-composer">Message the primary agent</label><textarea id="primary-composer" disabled placeholder="Message the primary agent" aria-describedby="primary-reason"></textarea></footer>';
    if(section==='agents')body='<p>Creating and configuring your own agents isn\'t available yet. Sessions choose their agents automatically. To see who is working, open <a href="#/projects" data-open-session-details>Projects › Session details</a>.</p><p class="muted">Direct conversations: Not available yet</p>';
    if(section==='workspace')body='<div id="project-files-empty"><p>Browsing project files isn\'t available yet.</p><p>Live preview, program, VM and desktop screens: <a href="#/settings" data-setting-link="Classic dashboard">Settings › Classic dashboard</a></p><p>Turn details for each agent are in Projects.</p></div>';
    if(section==='settings')body=settingHTML(snapshot);
    if(section==='skills'){
      action='<button id="refresh-skills">Refresh</button>';body=`<p>Add or remove skills: <a href="#/settings" data-setting-link="Classic dashboard">Settings › Classic dashboard</a></p>${skillsError?`<p role="alert">${e(skillsError)}</p>`:''}<div class="skill-grid">${(skills?.library || []).map((skill,i)=>`<article class="skill-card" id="skill-card-${i}" tabindex="-1"><h2>${e(skill.name)}</h2><details><summary class="clamp-three">${e(skill.description || 'Description')}</summary><p class="plain">${e(skill.description)}</p></details><p>${skill.error?'Problem: '+e(skill.error):'Ready'}</p><details><summary>${!skill.error && skill.risk==='sensitive'?'Sensitive':!skill.error && skill.risk==='low'?'Low':'Risk: not assessed'}</summary><ul>${(skill.reasons || []).map(reason=>`<li>${e(reason)}</li>`).join('')}</ul></details><p>${skill.trusted?'Reviewed version':'Not reviewed yet'}</p><p>Assigned to: assigning skills isn't available yet</p><p>Tool permission: uses the existing approval gate</p></article>`).join('')}</div>${skills && !skills.library?.length?`<p>No skills in ${e(skills.library_path)}.</p>`:''}`;
    }
    members.patch($('section-stage'),`<header class="section-header"><button id="open-section-panel" aria-label="Open navigation" aria-controls="rail" aria-expanded="${$('app').classList.contains('rail-open')}">☰</button><div class="heading"><h1>${title}</h1><p title="${e(context)}">${e(context)}</p></div>${snapshot.live!=='Live'?`<span class="muted">${e(snapshot.live)}</span>`:''}${action}</header><div class="section-content ${section==='settings'?'settings-canvas':''}">${body}</div>`);
  }
  function applyFilter(){for(const node of $('rail').querySelectorAll('[data-filter]'))node.hidden=!node.dataset.filter.toLocaleLowerCase().includes(filter.toLocaleLowerCase());}
  function render(snapshot){
    if(!snapshot.authenticated){loadedAuth=false;browseRequested=false;browse=skills=null;return;}
    if(!snapshot.state)return;const skip=$('skip-conversation');skip.textContent=section==='projects'?'Skip to conversation':'Skip to '+names.find(name=>name.toLowerCase()===section);skip.setAttribute('href',section==='projects'?'#timeline':'#section-stage');drawNav(snapshot);if(returningRoom && section==='projects'){returningRoom=false;$('timeline').scrollTop=savedScroll;if(savedRoomFocus?.isConnected && !savedRoomFocus.closest('[hidden]'))savedRoomFocus.focus({preventScroll:true});}
    $('app').dataset.section=section;$('room').hidden=section!=='projects';$('section-stage').hidden=section==='projects';
    members.patch($('rail'),section==='projects'?projectPanel(snapshot):panel());applyFilter();
    if(section!=='projects')stage(snapshot);
    $('context').hidden=section!=='projects' || $('context').hidden;
    if(!loadedAuth){loadedAuth=true;if(section==='skills')read('skills');}
    if(section==='projects' && !browseRequested && !$('app').classList.contains('workspace-open') && root.matchMedia?.('(min-width: 1200px)').matches)read('browse');
  }
  function dialog(kind,item,opener){root.AC.shell.prepareModal(opener);dialogKind=kind;selection=item;dialogError='';if(kind==='folder'){folder=browse;folderError='';}drawDialog();const host=$('project-dialog');if(host.showModal)host.showModal();else host.setAttribute('open','');host.querySelector('[data-cancel-project]')?.focus();if(kind==='folder' && !folder)read('folder');}
  // Open folder…: browse inside the projects root; non-git folders appear only here.
  function folderHTML(state){
    const rootPath=folder?.root || browse?.root || state.projects_root || '';
    return `<div class="browse-actions"><button data-browse-path="">Root</button>${folder?.parent?`<button data-browse-path="${e(folder.parent)}">Parent folder</button>`:''}<button id="refresh-folders">Refresh</button></div><p id="folder-path" class="directory" tabindex="-1">${e(folder?.path || rootPath)}</p>${folderError?`<p role="alert">${e(folderError)}</p>`:''}<div id="folder-list" role="list">${(folder?.entries || []).map((entry,i)=>`<div class="folder-row" role="listitem"><button data-folder-select="${i}"><strong>${e(entry.name)}</strong><small>${entry.git?'Git project':'No git · Team sessions need git'}</small></button><button data-browse-path="${e(entry.path)}" aria-label="Browse ${e(entry.name)}">›</button></div>`).join('')}</div>${folder?.truncated?'<p class="muted">More folders exist. Open a folder to browse it.</p>':''}${!folder && !folderError?'<p role="status">Loading folders…</p>':''}${folder && !folder.entries?.length?'<p class="muted">No folders here.</p>':''}`;
  }
  function drawDialog(keepFocus=false){const host=$('project-dialog'),state=core.getState().state,hadFocus=keepFocus && host.contains(document.activeElement);
    if(dialogKind==='folder'){host.innerHTML=`<h2 id="project-dialog-title">Open folder</h2>${folderHTML(state)}<div class="decision-dialog-buttons"><button data-cancel-project>Cancel</button></div>`;if(hadFocus)$('folder-path')?.focus();return;}
    host.innerHTML=`<h2 id="project-dialog-title">${dialogKind==='create'?'Create project':dialogKind==='forget'?'Forget key and sign out?':e('Switch to '+selection.name+'?')}</h2>${dialogKind==='create'?`<label for="project-name">Name</label><input id="project-name" required><label for="project-directory">Directory</label><input id="project-directory" readonly value="${e((browse?.root || state.projects_root || '')+'/')}"><p>AgentControl creates this folder with git and a first commit. Choosing agents for a project isn't available yet.</p>`:dialogKind==='select'?`<p>${e(m.projectName(state))}'s sessions stay in its history.</p>${selection.git===false?'<p>No git · Team sessions need git</p>':''}`:'<p>The key will be removed from this browser.</p>'}<p id="project-dialog-error" role="alert" hidden></p><div class="decision-dialog-buttons"><button id="confirm-project" class="solid">${dialogKind==='create'?'Create project':dialogKind==='select'?'Switch project':'Forget key and sign out'}</button><button data-cancel-project autofocus>Cancel</button></div>`;
  }
  function closeDialog(){if($('project-dialog').close)$('project-dialog').close();else $('project-dialog').removeAttribute('open');if(dialogKind==='folder' || selection?.fromFolder)folder=null;}
  function setAddMenu(open,focusButton=false){addMenuOpen=open;root.AC.shell.render(core.getState());if(focusButton)$('project-add-button')?.focus();}
  async function submitProject(){
    if(dialogKind==='forget'){closeDialog();core.signOut();return;}
    const name=$('project-name')?.value?.trim();if(dialogKind==='create' && !name){$('project-name').focus();return;}
    if(!core.beginWrite('project'))return;const kind=dialogKind,body=kind==='create'?{name}:{path:selection.path};$('confirm-project').disabled=true;
    try{await core.post('/api/projects/'+kind,body);closeDialog();core.focus('',false);root.location.hash='#/';root.AC.shell.route();await core.refreshNow();browse=null;await read('browse');}
    catch(error){if(core.getState().authenticated){$('project-dialog-error').textContent=error.message;$('project-dialog-error').hidden=false;}}
    finally{core.endWrite('project');$('confirm-project')?.removeAttribute('disabled');}
  }
  document.addEventListener('focusin',event=>{if($('room').contains(event.target))savedRoomFocus=event.target;});
  document.addEventListener('keydown',event=>{if(event.key==='Escape' && $('project-dialog').hasAttribute('open')){event.preventDefault();closeDialog();}else if(event.key==='Escape' && addMenuOpen){event.preventDefault();setAddMenu(false,true);}});
  document.addEventListener('input',event=>{if(event.target.id==='panel-search'){filter=event.target.value;applyFilter();}if(event.target.id==='project-name')$('project-directory').value=(browse?.root || core.getState().state.projects_root || '')+'/'+event.target.value;});
  document.addEventListener('click',event=>{
    if(addMenuOpen && !event.target.closest('#project-add') && !$('project-dialog').contains(event.target))setAddMenu(false);
    const target=event.target.closest('button,a');if(!target)return;
    if(target.id==='project-add-button')setAddMenu(!addMenuOpen);
    // A menu choice closes the menu; its dialog returns focus to +.
    if(target.id==='open-folder' || target.id==='create-project'){addMenuOpen=false;root.AC.shell.render(core.getState());dialog(target.id==='open-folder'?'folder':'create',null,$('project-add-button'));}
    if(target.dataset.folderSelect!==undefined){const entry=folder?.entries?.[Number(target.dataset.folderSelect)];if(entry){dialogKind='select';selection={...entry,fromFolder:true};drawDialog();$('project-dialog').querySelector('[data-cancel-project]')?.focus();}}
    if(target.dataset.settingLink){setting=target.dataset.settingLink;if(!$('settings-sheet').hidden)$('close-settings')?.click();}
    if(target.id==='ac-mark')root.location.hash='#/primary';
    if(['key-avatar','phone-key-avatar'].includes(target.id)){setting='Sign-in';root.location.hash='#/settings';go('settings');root.AC.shell.route();}
    if(target.dataset.setting){setting=target.dataset.setting;root.AC.shell.render(core.getState());$('app').classList.remove('rail-open');root.AC.shell.syncPanels();$('section-stage').focus();}
    if(target.id==='open-section-panel'){$('app').classList.add('rail-open');panelOpened();root.AC.shell.render(core.getState());}
    if(target.id==='open-rail')panelOpened();
    if(target.dataset.selectProject!==undefined)dialog('select',browse.entries[Number(target.dataset.selectProject)],target);
    if(target.id==='forget-key')dialog('forget',null,target);
    if(target.hasAttribute('data-cancel-project'))closeDialog();
    if(target.id==='confirm-project')submitProject();
    if(target.hasAttribute('data-browse-path'))read('folder',target.dataset.browsePath);
    if(target.id==='refresh-folders')read('folder',folder?.path && folder.path!==folder.root?folder.path:'');if(target.id==='refresh-skills')read('skills');
    if(target.dataset.skillCard!==undefined){$('app').classList.remove('rail-open');root.AC.shell.syncPanels();$('skill-card-'+target.dataset.skillCard)?.focus();}
    // Session details opens only from its Details button, so this link leads to that button.
    if(target.hasAttribute('data-open-session-details')){event.preventDefault();root.location.hash='#/projects';root.AC.shell.route();const details=$('open-context');if(details && !details.disabled)details.focus();else $('timeline').focus({preventScroll:true});}
  });
  $('project-dialog').addEventListener('cancel',event=>{event.preventDefault();closeDialog();});
  root.AC.sections={go,render,panelOpened,getSection:()=>section};
})(window);
