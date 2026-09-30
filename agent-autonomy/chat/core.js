(function (root) {
  'use strict';
  const storageKey = 'ac-dashboard-key';
  function read(storage, name) { try { return root[storage].getItem(name); } catch { return null; } }
  function write(storage, name, value) { try { value === null ? root[storage].removeItem(name) : root[storage].setItem(name,value); } catch {} }
  let key = read('localStorage',storageKey) || read('sessionStorage',storageKey) || '';
  let state = null, focused = '', refreshing = false, again = false, scheduled = null, poll = null, retry = null, abort = null, epoch = 0, failures = 0;
  let live = 'Reconnecting…', error = '', authError = '';
  const agentsByRun = {}, listeners = new Set();
  const emit = () => listeners.forEach(fn=>fn(getState()));
  function getState() { return {state,agentsByRun,focused,live,error,authError,authenticated:!!key}; }
  function stop() { epoch++; abort?.abort(); abort = null; [poll,retry,scheduled].forEach(clearTimeout); poll = retry = scheduled = null; }
  function rejectKey(message) { stop(); key = ''; state = null; Object.keys(agentsByRun).forEach(id=>delete agentsByRun[id]); write('localStorage',storageKey,null); write('sessionStorage',storageKey,null); authError = message; emit(); }
  async function api(path, method = 'GET', body) {
    try {
      const response = await fetch(path,{method,headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},cache:'no-store',...(body === undefined ? {} : {body:JSON.stringify(body)})});
      const result = await response.json();
      if (response.status === 401) { rejectKey(result.error || 'Please connect again.'); throw Error(result.error || 'Please connect again.'); }
      if (!response.ok) throw Error(result.error || 'Request failed ('+response.status+')');
      return result;
    } catch (exception) { if (key) { error = exception.message; emit(); } throw exception; }
  }
  function schedulePoll() {
    clearTimeout(poll);
    if (!key || live === 'Live') return;
    // Mirrors engine.TERMINAL; the selected session may differ from the active one.
    const active = (state?.runs || []).some(r=>!['completed','blocked','failed','stopped','limit_reached'].includes(r.status));
    poll = setTimeout(async()=>{await refresh(); schedulePoll();},active ? 2000 : 10000);
  }
  async function refresh() {
    if (!key) return;
    if (refreshing) { again = true; return; }
    refreshing = true;
    const requested = focused, generation = epoch;
    try {
      const result = await api('/api/state?scope=current&run='+encodeURIComponent(requested));
      const runId = requested || (result.runs || []).find(r=>!['completed','blocked','failed','stopped','limit_reached'].includes(r.status))?.id || result.run?.id;
      const roster = runId ? await api('/api/agents?run='+encodeURIComponent(runId)) : {agents:[]};
      if (generation !== epoch || requested !== focused) return;
      if (runId) agentsByRun[runId] = roster.agents || [];
      state = {...result,agents:roster.agents || []}; error = ''; emit();
    } catch {} finally {
      refreshing = false;
      if (again) { again = false; scheduleRefresh(); }
      schedulePoll();
    }
  }
  function scheduleRefresh() { if (!scheduled && key) scheduled = setTimeout(()=>{scheduled = null; refresh();},0); }
  // Copied and adapted from classic connectEvents(): authenticated fetch streaming, no key in URLs.
  function handleEventBlock(block) { const name = (block.match(/^event:\s*(.*)$/m)||[])[1]; if (name === 'hello' || name === 'change') scheduleRefresh(); }
  async function connectEvents() {
    if (!key) return;
    const generation = epoch, controller = new AbortController(); abort = controller;
    try {
      const response = await fetch('/api/events',{headers:{Authorization:'Bearer '+key},cache:'no-store',signal:controller.signal});
      if (generation !== epoch) return;
      if (response.status === 401) { const result = await response.json(); rejectKey(result.error || 'Please connect again.'); return; }
      if (!response.ok || !response.body?.getReader) throw Error('Stream unavailable');
      live = 'Live'; failures = 0; clearTimeout(poll); emit();
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
      for (;;) {
        const {value,done} = await reader.read(); if (generation !== epoch || done) break;
        buffer += decoder.decode(value,{stream:true});
        buffer = buffer.replace(/\r\n/g,'\n');
        let end; while ((end = buffer.indexOf('\n\n')) >= 0) {handleEventBlock(buffer.slice(0,end)); buffer = buffer.slice(end+2);}
      }
    } catch {} finally {
      if (generation === epoch && key) { abort = null; live = 'Reconnecting…'; emit(); schedulePoll(); retry = setTimeout(connectEvents,Math.min(30000,1000*2**Math.min(failures++,5))); }
    }
  }
  function start() { if (key) { refresh(); connectEvents(); } else emit(); }
  function connect(value, remember) { stop(); key = value.trim(); authError = ''; write('localStorage',storageKey,remember ? key : null); write('sessionStorage',storageKey,remember ? null : key); emit(); start(); }
  function focus(id) { if (id !== focused) { focused = id; scheduleRefresh(); } }
  const core = {api,subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn);},getState,start,connect,focus,refresh,scheduleRefresh,handleEventBlock,stop,read,write,dismissError(){error='';emit();}};
  root.AC = root.AC || {}; root.AC.core = core;
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
})(typeof window !== 'undefined' ? window : globalThis);
