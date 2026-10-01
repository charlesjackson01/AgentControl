(function(root){
  'use strict';
  const m=root.AC?.model || require('./model.js'),e=m.esc;
  const href=(run,agent)=>'#/w/'+encodeURIComponent(run)+'/'+encodeURIComponent(agent);
  const popout=(run,agent)=>'/?popout='+encodeURIComponent(agent)+'&run='+encodeURIComponent(run);
  function parseRoute(hash){
    const match=hash.match(/^#\/w\/([^/]+)\/([^/]+)$/);if(!match)return null;
    try{const run=decodeURIComponent(match[1]),agent=decodeURIComponent(match[2]);return [run,agent].every(value=>value && !/[\/\x00-\x1f\x7f]/.test(value))?{run,agent}:null;}catch{return null;}
  }
  function belongsToProject(data,snapshot){
    const run=data?.run;if(!run)return false;
    const project=snapshot.channels?.project || snapshot.state?.project;
    const recorded=run.project || (run.workspace?.toplevel?run.workspace.toplevel.replace(/\/$/,'')+(run.workspace.subdir?'/'+run.workspace.subdir:''):'');
    if(snapshot.channels?.channels?.[0]?.active_session===run.id)return true;
    if(recorded)return recorded===project;
    return !!((snapshot.single || snapshot.thread)?.sessions?.[run.id] || snapshot.state?.runs?.some(r=>r.id===run.id && (!r.project || r.project===project)));
  }
  // Where wording copied from classic workspace.js renderWsHead.
  function headerHTML(data,agent){
    const run=data.run,member=m.membersFromState({...data,agents:data.agents || []}).find(a=>a.name===agent);
    if(!data.agents?.some(a=>a.name===agent) || !member)return `<p>No recorded agent named ‹${e(agent)}› in this session.</p>`;
    const branch=run.workspace?.agents?.[agent]?.branch,where=member.role==='researcher'?'scratch folder · no project files':run.isolation==='container'?'in container':'';
    return `<h2>${e(member.displayName)}</h2><p>${e(member.role)} · ${e(member.symbol)} ${e(member.stateLabel)}</p>${member.task?`<p>${e(member.task)}</p>`:''}${member.since?`<small>since ${e(m.relTime(member.since))}</small>`:''}${branch?`<p class="workspace-branch">Branch · ${e(branch)}</p>`:''}${where?`<p class="muted">${e(where)}</p>`:''}${member.state==='waiting_on_you'?`<a class="room-link" data-room-link="waiting" data-run="${e(run.id)}" data-actor="${e(agent)}" href="#/s/${e(encodeURIComponent(run.id))}">Go to waiting item</a>`:''}<a class="room-link" data-popout href="${e(popout(run.id,agent))}" target="_blank" rel="noopener noreferrer">Open in classic pop-out</a>`;
  }
  // Copied from classic app.js: planningNext and stageStates (including terminal run states).
  const ended=new Set(['completed','blocked','failed','stopped','limit_reached']);
  function planningNext(run,steps){
    if(!run || ended.has(run.status))return false;
    const last=steps.at(-1);
    return !last || (run.phase==='manager' && !!last.verified);
  }
  function stageStates(run,step,isLast,pending,next){
    if(next)return {plan:'active',prompt:'pending',code:'pending',verify:'pending'};
    const s=step.status,live=!ended.has(run.status);
    const code=['prepared','dispatching'].includes(s)?'pending'
      :['running','waiting'].includes(s)?(isLast && pending.length?'waiting':live?'active':'failed')
      :s==='failed'?'failed':'done';
    const verify=step.verification?(step.verification.status==='failed'?'failed':'done')
      :isLast && live && run.phase==='verify'?'active':'pending';
    return {plan:'done',prompt:['prepared','dispatching'].includes(s)?'active':'done',code,verify};
  }
  // Copied from classic app.js: STAGES and stageHead marks/notes.
  const STAGES=[['plan','Plan','Hermes'],['prompt','Prompt','Hermes → OpenCode'],['code','Code','OpenCode'],['verify','Verify','AgentControl']];
  function stageHead(label,who,state){
    const mark={done:'✓',active:'▶',waiting:'!',failed:'×',pending:'○'}[state];
    const note={waiting:'Waiting on you',active:'In progress',failed:'Failed'}[state] || '';
    return `<span aria-hidden="true">${mark}</span> <strong>${e(label)}</strong> <small>${e(who)}</small>${note?` <small>${e(note)}</small>`:''}<span class="sr-only">: ${e(state)}</span>`;
  }
  // Copied from classic app.js: TOOL_SYMBOL and transcriptOf activity/result fallback.
  const TOOL_SYMBOL={bash:'$',edit:'✎',write:'+',patch:'✎',read:'›',list:'›',glob:'›',grep:'›',webfetch:'⇣',task:'↳',todowrite:'☐'};
  function transcriptOf(step){
    if(Array.isArray(step?.transcript))return step.transcript;
    const entries=(step?.activity || []).map(e=>({type:'tool',tool:e.kind,status:e.status || '',summary:e.detail || '',output:e.output || ''}));
    if(step?.result)entries.push({type:'text',text:step.result});
    return entries;
  }
  const terminalEntries=step=>transcriptOf(step).filter(entry=>entry?.type==='text' || entry?.type==='tool');
  const turnsFor=(steps,agent)=>(steps || []).filter(step=>(step.agent || 'coder-1')===agent).sort((a,b)=>a.number-b.number);
  const selectedTurn=(steps,pinned='')=>steps.find(step=>step.id===pinned) || steps.at(-1) || null;
  // Copied from classic app.js: verificationLabel and diffHTML line-prefix semantics.
  function verificationLabel(step){
    const state=step?.verification?.status;
    return state==='passed'?'Verification passed':state==='failed'?'Verification failed':state==='not configured'?'Review only'
      :step?.status==='failed'?'Coding failed':'Not verified yet';
  }
  function diffHTML(text){
    return String(text).split('\n').map(line=>{
      const tone=/^(@@|\+\+\+|---)/.test(line)?'diff-heading':line.startsWith('+')?'diff-add':line.startsWith('-')?'diff-remove':'';
      return `<span class="diff-line ${tone}">${e(line)}</span>`;
    }).join('');
  }
  function fileList(evidence){const files=evidence?.file_stats || [];return {items:files.slice(0,50),omitted:Math.max(0,files.length-50)};}
  function changesHTML(run,step){
    const evidence=step.evidence,files=fileList(evidence),verification=step.verification;
    const live=!ended.has(run.status) && ['prepared','dispatching','running','waiting'].includes(step.status);
    const rows=files.items.map(file=>`<li id="ws-file-${e(encodeURIComponent(file.path))}">${e(file.path)} · ${e(file.change)} +${e(file.added ?? '—')}/−${e(file.removed ?? '—')}${file.partial?' (partial)':''}</li>`).join('');
    return `<section id="workspace-changes"><h3>Changed files</h3>${live && !evidence?'<p class="muted">Changes appear when the turn ends.</p>':''}${rows?`<ul class="workspace-files">${rows}</ul>`:''}${files.omitted?`<p class="muted">…and ${e(files.omitted)} more</p>`:''}<h3>Diff</h3>${evidence?.diff_truncated?'<p class="muted">Preview truncated</p>':''}${evidence?.diff?`<pre id="workspace-diff">${diffHTML(evidence.diff)}</pre>`:'<p class="muted">No captured text changes</p>'}</section><section id="workspace-verification"><h3>Verification</h3><p>${e(verificationLabel(step))}${verification?.exit_code!==undefined && verification.exit_code!==null?' · Exit code '+e(verification.exit_code):''}</p>${verification?.output?`<details id="ws-verification-output-${e(encodeURIComponent(step.id))}"><summary>Verification output</summary><pre>${e(verification.output)}</pre></details>`:''}</section>`;
  }
  // Copied from classic workspace.js renderWsLog, excluding Hermes request entirely.
  function hermesCalls(events){
    return (events || []).filter(event=>['Hermes decision','Hermes JSON repaired'].includes(event.kind)).slice(-40).map(event=>{
      let parsed;try{parsed=typeof event.detail==='string'?JSON.parse(event.detail):event.detail;}catch{}
      const text=parsed && typeof parsed==='object'?[parsed.action,parsed.title,parsed.summary].filter(value=>typeof value==='string' || typeof value==='number').join(' · '):String(event.detail || '');
      return {id:event.id,kind:event.kind,created:event.created,text:text.slice(-6000)};
    });
  }
  function logsHTML(data,agent,role){
    if(role==='researcher'){
      const items=turnsFor(data.steps,agent).map(step=>`<li id="ws-question-${e(encodeURIComponent(step.id))}"><p><strong>${e(step.question || step.title)}</strong> <small>${e(step.status || '')}</small></p>${step.report?`<p>${e(String(step.report.summary || '').slice(0,2000))}</p>${step.report.sources?.length?`<ul class="workspace-sources">${step.report.sources.slice(0,8).map(source=>`<li>${e(source)}</li>`).join('')}</ul>`:''}`:''}</li>`).join('');
      return `<section id="workspace-research"><h3>Research log</h3><p class="muted">The researcher runs Hermes once per approved question; its report is recorded when that call ends. There is no live stream.</p>${items?`<ul class="workspace-records">${items}</ul>`:'<p>No questions yet.</p>'}</section>`;
    }
    const items=hermesCalls(data.events).map(event=>`<li id="ws-call-${e(encodeURIComponent(event.id))}"><small>${e(m.timeLabel(event.created))}</small><p><strong>${e(event.kind)}</strong></p><p class="workspace-text">${e(event.text)}</p></li>`).join('');
    return `<section id="workspace-hermes"><h3>Hermes log</h3><p class="muted">Hermes runs as one call per decision. This is the recorded log of its replies; there is no live stream.</p>${items?`<ul class="workspace-records">${items}</ul>`:'<p>No Hermes calls recorded yet.</p>'}</section>`;
  }
  // Copied from classic workspace.js: SURFACE_LABEL and wsSurfaces filtering.
  const SURFACE_LABEL={web:'Web',terminal:'Program',desktop:'Desktop','vm-console':'VM screen','browser-session':'Browser',vnc:'VNC'};
  const surfaceLabel=kind=>Object.prototype.hasOwnProperty.call(SURFACE_LABEL,kind)?SURFACE_LABEL[kind]:kind;
  const surfacesFor=(surfaces,agent)=>(surfaces || []).filter(surface=>surface.agents==='all' || Array.isArray(surface.agents) && surface.agents.includes(agent));
  function surfacesHTML(data,agent){
    const list=surfacesFor(data.surfaces,agent);
    return `<section id="workspace-surfaces"><h3>Available surfaces</h3>${list.length?`<ul class="workspace-records">${list.map(surface=>`<li id="ws-surface-${e(encodeURIComponent(surface.id))}"><p><strong>${e(surface.title)}</strong> · ${e(surfaceLabel(surface.kind))} · ${e(surface.state)}</p>${surface.note?`<p class="workspace-text workspace-surface-note">${e(surface.note)}</p>`:''}</li>`).join('')}</ul>`:'<p>No surfaces for this agent.</p>'}<a class="room-link" data-popout href="${e(popout(data.run.id,agent))}" target="_blank" rel="noopener noreferrer">Open in classic pop-out</a><p class="muted">Live view and input are in the classic pop-out for now.</p></section>`;
  }
  function pendingFor(snapshot,run,agent){
    const cache=snapshot.single || snapshot.thread;
    return (cache?.ids || []).map(id=>cache.messages[id]).filter(message=>message.action!=null && message.kind!=='outcome' && message.session===run && message.actor===agent);
  }
  const entryKey=(step,entry,index)=>'ws-entry-'+encodeURIComponent(step.id)+'-'+(entry.type==='tool' && entry.id?'tool-'+encodeURIComponent(entry.id):'index-'+index);
  function entryHTML(step,entry,index){
    const key=entryKey(step,entry,index);
    if(entry.type==='text')return `<p id="${e(key)}" class="workspace-text">${e(entry.text)}</p>`;
    const tool=entry.tool || 'tool',label=tool==='bash'?entry.summary || entry.title || '':tool+' '+(entry.summary || entry.title || '');
    const output=entry.output?`<details id="${e(key)}-output" data-output-status="${e(entry.status || '')}" ${['running','error'].includes(entry.status)?'open':''}><summary>Output</summary><pre>${e(entry.output)}</pre></details>`:'';
    return `<div id="${e(key)}" class="workspace-tool"><p><span aria-hidden="true">${e(Object.prototype.hasOwnProperty.call(TOOL_SYMBOL,tool)?TOOL_SYMBOL[tool]:'•')}</span> <span>${e(label)}</span>${entry.status?` <small class="workspace-tool-status">${e(entry.status)}</small>`:''}</p>${output}</div>`;
  }
  function turnsHTML(data,agent,snapshot,pinned,follow){
    const steps=turnsFor(data.steps,agent),step=selectedTurn(steps,pinned);
    const picker=`<nav id="workspace-turns" aria-label="Agent turns">${steps.map(turn=>`<button id="ws-turn-${e(encodeURIComponent(turn.id))}" data-ws-turn="${e(turn.id)}" title="${e(turn.title || '')}" aria-pressed="${pinned===turn.id}">#${e(turn.number)}</button>`).join('')}<button id="ws-latest" data-ws-latest aria-pressed="${!pinned}">Latest</button></nav>`;
    if(!step)return picker+'<p>No turns yet.</p>';
    const pending=pendingFor(snapshot,data.run.id,agent),isLast=step===steps.at(-1),next=!pinned && planningNext(data.run,steps);
    const states=stageStates(data.run,step,isLast,pending,next),code=stageStates(data.run,step,isLast,pending,false).code;
    const state=code==='pending'?'active':code,role=step.role || m.membersFromState(data).find(a=>a.name===agent)?.role;
    const prompt=String(step.prompt || ''),bounded=prompt.slice(0,8000)+(prompt.length>8000?'…truncated':'');
    const stages=STAGES.map(([name,label,who])=>{
      const actor=name==='code' && role==='reviewer'?'OpenCode · read-only':who;
      const by=name==='code' && data.run.mode==='team'?actor+' · '+m.agentLabel(agent,data.run):actor;
      return `<li id="ws-stage-${name}" data-state="${e(states[name])}">${stageHead(label,by,states[name])}${name==='prompt'?`<details id="ws-prompt"><summary>Prompt sent to OpenCode</summary><pre>${e(bounded)}</pre></details>`:''}</li>`;
    }).join('');
    const entries=terminalEntries(step);
    return `${picker}<h3>Turn ${e(step.number)} · ${e(step.title || '')}</h3>${next?'<p class="muted">Planning the next turn · showing the latest recorded turn below.</p>':''}<ol class="workspace-stages">${stages}</ol><section id="workspace-terminal-section"><div class="workspace-terminal-heading"><h3>Terminal</h3><button id="ws-jump" data-ws-jump ${follow || pinned?'hidden':''}>Jump to latest</button></div><p id="workspace-turn-status" role="status">Turn ${e(step.number)} · ${e(state)}</p><div id="workspace-terminal" role="log" aria-live="off" tabindex="0" aria-label="Recorded terminal output">${step.transcript_omitted>0?`<p id="ws-omitted" class="muted">${e(step.transcript_omitted)} earlier entries were not kept</p>`:''}${entries.map((entry,index)=>entryHTML(step,entry,index)).join('') || '<p>No output yet.</p>'}</div></section>${changesHTML(data.run,step)}`;
  }
  function mount(host){
    let current=null,selection='',pinned='',follow=true,shown='';
    function clear(){host.hidden=true;host.replaceChildren();current=null;selection='';pinned='';follow=true;shown='';}
    host.addEventListener('click',event=>{
      const turn=event.target.closest('[data-ws-turn]');
      if(turn){pinned=turn.dataset.wsTurn;follow=false;rerender();}
      else if(event.target.closest('[data-ws-latest],[data-ws-jump]')){pinned='';follow=true;rerender();}
    });
    host.addEventListener('scroll',event=>{
      const terminal=event.target;if(terminal.id!=='workspace-terminal' || pinned)return;
      if(terminal.scrollHeight-terminal.scrollTop-terminal.clientHeight>24){follow=false;const jump=host.querySelector('#ws-jump');if(jump)jump.hidden=false;}
    },true);
    function rerender(){if(current)render(...current);}
    function render(snapshot,route,detail,back){
      if(!route || !snapshot.authenticated){clear();return;}
      const identity=route.run+'\0'+route.agent;if(selection!==identity){selection=identity;pinned='';follow=true;shown='';host.replaceChildren();}
      current=[snapshot,route,detail,back];
      host.hidden=false;
      const data=detail.data,member=data?.agents?.find(a=>a.name===route.agent);
      const role=member && m.membersFromState(data).find(a=>a.name===route.agent)?.role;
      const material=member?(route.agent==='hermes' || ['orchestrator','researcher'].includes(role)?logsHTML(data,route.agent,role):turnsHTML(data,route.agent,snapshot,pinned,follow))+surfacesHTML(data,route.agent):'';
      const body=detail.loading?'<p role="status">Loading Workspace…</p>':detail.error?`<p role="status">${e(detail.errorStatus===404?"That session is not in this project's history.":detail.error)}</p>${detail.errorStatus===404?'':'<button id="retry-team">Retry</button>'}`:data?.run?.id===route.run?belongsToProject(data,snapshot)?headerHTML(data,route.agent)+material:`<p>That session is not in this project's history.</p>`:'<p role="status">Loading Workspace…</p>';
      const oldTerminal=host.querySelector('#workspace-terminal'),scroll=oldTerminal?.scrollTop || 0;
      const open=new Map([...host.querySelectorAll('details[id]')].map(node=>[node.id,{open:node.open,status:node.dataset.outputStatus}]));
      const step=member?selectedTurn(turnsFor(data.steps,route.agent),pinned):null,turn=step?.id || '';
      root.AC.members.patch(host,`<header><a class="room-link" data-back-room href="${e(back)}">Back to room</a><span class="muted">Workspace</span></header><div id="workspace-content">${body}</div>`);
      host.querySelectorAll('details[id]').forEach(node=>{const previous=open.get(node.id);if(previous && (previous.open || previous.status===node.dataset.outputStatus || !['running','error'].includes(node.dataset.outputStatus)))node.open=previous.open;});
      const terminal=host.querySelector('#workspace-terminal');
      if(terminal){terminal.scrollTop=!pinned && follow?terminal.scrollHeight:shown===turn?scroll:0;shown=turn;}
    }
    return {render,clear,getState:()=>({pinned,follow})};
  }
  const workspace={href,popout,parseRoute,belongsToProject,headerHTML,planningNext,stageStates,STAGES,transcriptOf,terminalEntries,turnsFor,selectedTurn,verificationLabel,diffHTML,fileList,hermesCalls,logsHTML,SURFACE_LABEL,surfaceLabel,surfacesFor,surfacesHTML,pendingFor,entryHTML,turnsHTML,mount};root.AC=root.AC || {};root.AC.workspace=workspace;
  if(typeof module!=='undefined' && module.exports)module.exports=workspace;
})(typeof window!=='undefined'?window:globalThis);
