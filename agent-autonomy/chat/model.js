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
    if (!agents.some(a=>a.name === 'hermes')) agents.unshift({name:'hermes',type:'orchestrator',state:'idle'});
    return agents.map(a=>{const status = a.state || 'idle', info = presence[status] || ['◌',status.replace(/_/g,' ')]; return {name:a.name,role:a.role || a.type || '',state:status,stateLabel:info[1],symbol:info[0],task:a.task || '',since:a.since || null};}).sort((a,b)=>a.name === 'hermes' ? -1 : b.name === 'hermes' ? 1 : 0);
  }
  function connectionsFromState(state) { const health = state.health || {}; return {ready:!!health.ready,label:health.ready ? 'Connections ready' : 'Connections need attention',items:Object.entries(health.agents || {}).map(([name,item])=>({name,state:item.state,label:item.label || item.state || 'Unknown'}))}; }
  const model = {channelsFromState,sessionsFromState,membersFromState,connectionsFromState,waitingFromState,esc,relTime,timeLabel,projectName};
  root.AC = root.AC || {}; root.AC.model = model;
  if (typeof module !== 'undefined' && module.exports) module.exports = model;
})(typeof window !== 'undefined' ? window : globalThis);
