(function (root) {
  'use strict';
  // Mirrors engine.TERMINAL: paused and interrupted remain active.
  const terminal = new Set(['completed', 'blocked', 'failed', 'stopped', 'limit_reached']);
  const presence = {working:['●','Working'], waiting_on_you:['!','Waiting on you'], needs_attention:['!','Needs attention'], paused:['Ⅱ','Paused'], idle:['◌','Idle'], finished:['✓','Finished'], failed:['✕','Failed'], stopped:['■','Stopped'], blocked:['!','Blocked'], limit_reached:['■','Limit reached']};
  // Copied and adapted from classic app.js helpers.
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const timeLabel = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? 'Unknown time' : date.toLocaleString(); };
  const relTime = (value, now = Date.now()) => { const seconds = Math.max(0, (now - new Date(value).getTime()) / 1000); return !Number.isFinite(seconds) ? '' : seconds < 60 ? 'just now' : seconds < 3600 ? Math.floor(seconds / 60)+'m ago' : seconds < 86400 ? Math.floor(seconds / 3600)+'h ago' : Math.floor(seconds / 86400)+'d ago'; };
  const projectName = state => String(state.project || 'Project').replace(/\/+$/, '').split('/').pop() || 'Project';
  function sessionsFromState(state) {
    return (state.runs || []).map(run => {
      const line = String(run.title || run.goal || 'Untitled session').split('\n')[0].trim();
      const status = run.status || 'unknown';
      return {id:run.id, title:line.length > 80 ? line.slice(0,79)+'…' : line, status, statusLabel:status.replace(/_/g,' ').replace(/^./, c=>c.toUpperCase()), symbol:['waiting','attention','blocked'].includes(status) ? '!' : status === 'completed' ? '✓' : status === 'failed' ? '✕' : status === 'stopped' ? '■' : !terminal.has(status) ? '●' : '◌', created:run.created, parent:run.parent_run || null, promptCount:run.prompt_count || 0, active:!terminal.has(status)};
    }).sort((a,b) => (Date.parse(b.created)||0)-(Date.parse(a.created)||0));
  }
  function waitingFromState(state) { const inbox = state.inbox || []; return {count:inbox.length, runs:[...new Set(inbox.map(item=>item.run).filter(Boolean))]}; }
  function channelsFromState(state) { const sessions = sessionsFromState(state); return [{id:'main',kind:'project',title:projectName(state),sessions:sessions.length,active_session:sessions.find(s=>s.active)?.id || null,waiting:waitingFromState(state).count}]; }
  function membersFromState(state) {
    const agents = [...(state.agents || [])];
    // Keep the M1 helper's default for an absent snapshot; a recorded empty roster stays empty.
    if(!Object.hasOwn(state,'agents'))agents.unshift({name:'hermes',type:'orchestrator',state:'idle'});
    const count=(n,singular)=>n+' '+singular+(n===1?'':'s');
    return agents.map(a=>{
      const status=a.state || 'idle',info=Object.hasOwn(presence,status)?presence[status]:['◌',status],stats=a.stats || {};
      const activity=a.name==='hermes' ? (Number.isFinite(stats.turns)?count(stats.turns,'decision'):'') :
        [Number.isFinite(stats.turns)?count(stats.turns,'turn'):'',Number.isFinite(stats.tool_calls)?count(stats.tool_calls,'tool call'):''].filter(Boolean).join(' · ');
      return {name:a.name,displayName:agentLabel(a.name,state.run),role:a.role || a.type || '',state:status,stateLabel:info[1],symbol:info[0],task:boundText(a.task || ''),since:a.since || null,activity};
    }).sort((a,b)=>a.name === 'hermes' ? -1 : b.name === 'hermes' ? 1 : 0);
  }
  const boundText=value=>{const text=String(value ?? '');return text.length>300?text.slice(0,299)+'…':text;};
  function agentLabel(name,run) {const label=run?.team?.agents?.[name]?.label;return boundText(name==='hermes'?'Hermes':label?name+' ('+label+')':name);}
  function boundedList(list) {return {items:(list || []).slice(0,50),omitted:Math.max(0,(list || []).length-50)};}
  function teamFromRun(run={}) {
    run=run || {};
    const team=run.team || {},state=team.state,undecided=['proposing','proposed','unusable'].includes(state),expired=terminal.has(run.status) && undecided,stopping=!!run.stop && !terminal.has(run.status) && undecided;
    const tasks=team.tasks || [],done=tasks.filter(t=>t.status==='done').length;
    const summaries={proposing:'Hermes is proposing a team. Nothing runs until you approve it.',proposed:'Proposed team · not running yet',unusable:'Hermes could not produce a usable team plan:',single:'Running with one agent, as chosen',approved:`Team · ${done} of ${tasks.length} tasks done`,running:`Team · ${done} of ${tasks.length} tasks done`,review:`Team · ${done} of ${tasks.length} tasks done · Hermes reviews the merged result`};
    const source=team.proposal?.agents || {},roster=Array.isArray(source)?source.map(a=>[a.name || a.id,a]):Object.entries(source),proposed=boundedList(roster);
    return {state,expired,pending:!terminal.has(run.status) && !run.stop && undecided,summary:expired?'Not decided before the session ended':stopping?'Not decided · the session is stopping':Object.hasOwn(summaries,state)?summaries[state]:boundText(state || ''),
      proposed:{...proposed,items:proposed.items.map(([name,a])=>({name:boundText(name),label:boundText(a.label),responsibility:boundText(a.responsibility)}))},
      warnings:boundedList(team.warnings),problems:boundedList(team.problems),proposals:team.proposals,
      auto:run.auto?{outcome:run.mode==='single'?'one agent':state==='single'?'one agent after Hermes’s review':'a team plan for your approval',reasons:boundedList(run.auto.reasons)}:null};
  }
  // Classic taskDepths: missing ids and cycles return zero at the recursion boundary.
  function taskDepths(tasks) {
    const byId=new Map(tasks.map(t=>[t.id,t])),depth=Object.create(null);
    const of=(id,seen=new Set())=>{if(depth[id]!==undefined)return depth[id];if(seen.has(id) || !byId.has(id))return 0;seen.add(id);return depth[id]=Math.max(0,...(byId.get(id).depends_on || []).map(d=>of(d,seen)+1));};
    tasks.forEach(t=>of(t.id));return {...depth};
  }
  const taskStates={waiting:['◌','Waiting'],running:['●','Running'],done:['✓','Done'],failed:['✕','Failed'],blocked:['!','Blocked']};
  function taskStatus(state) {const info=Object.hasOwn(taskStates,state)?taskStates[state]:['◌',state];return {symbol:info[0],label:info[1]};}
  function tasksFromRun(run={}) {
    const tasks=run.team?.tasks || [],bounded=boundedList(tasks),depth=taskDepths(tasks),groups=new Map();
    for(const task of bounded.items){const d=depth[task.id];if(!groups.has(d))groups.set(d,[]);groups.get(d).push({id:boundText(task.id),title:boundText(task.title),agent:agentLabel(task.agent,run),dependencies:boundedList(task.depends_on),...taskStatus(task.status),attempts:task.attempts,reason:['failed','blocked'].includes(task.status)?boundText(task.reason):'',turn:task.steps?.length?'turn:'+task.steps.at(-1):''});}
    return {total:tasks.length,done:tasks.filter(t=>t.status==='done').length,omitted:bounded.omitted,groups:[...groups].sort(([a],[b])=>a-b).map(([depth,tasks])=>({depth,label:depth?'After step '+depth:'Can start now',tasks}))};
  }
  function railSessions(state,cache,total) {
    const byId=new Map(Object.values(cache?.sessions || {}).map(s=>[s.id,{...s,parent_run:s.parent}]));
    for(const r of state.runs || [])byId.set(r.id,{...byId.get(r.id),...r});
    const sessions=sessionsFromState({runs:[...byId.values()]});return {sessions,note:total!==undefined && sessions.length!==total?'Showing '+sessions.length+' of '+total+' session'+(total===1?'':'s'):''};
  }
  function connectionsFromState(state) { const health = state.health || {}; return {ready:!!health.ready,label:health.ready ? 'Connections ready' : 'Connections need attention',message:boundText(health.message),items:Object.entries(health.agents || {}).slice(0,50).map(([name,item])=>({name:boundText(name),state:item.state,label:boundText(item.label || item.state || 'Unknown'),status:item.state==='ready'?'✓ Ready':'! Needs attention'}))}; }
  const symbolHTML=value=>`<span aria-hidden="true">${esc(value)}</span>`;
  const statusMarkup=value=>esc(value).replace(/(^| · )([●!✓✕■◌▶◇⌕▧–])(?= )/g,'$1<span aria-hidden="true">$2</span>');
  const model = {symbolHTML,statusMarkup,channelsFromState,sessionsFromState,membersFromState,connectionsFromState,waitingFromState,esc,relTime,timeLabel,projectName,boundText,boundedList,agentLabel,teamFromRun,taskDepths,taskStatus,tasksFromRun,railSessions};
  root.AC = root.AC || {}; root.AC.model = model;
  if (typeof module !== 'undefined' && module.exports) module.exports = model;
})(typeof window !== 'undefined' ? window : globalThis);
