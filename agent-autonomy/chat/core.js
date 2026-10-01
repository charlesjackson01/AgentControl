(function (root) {
  'use strict';
  const storageKey = 'ac-dashboard-key';
  function read(storage, name) { try { return root[storage].getItem(name); } catch { return null; } }
  function write(storage, name, value) { try { value === null ? root[storage].removeItem(name) : root[storage].setItem(name,value); } catch {} }
  let key = read('localStorage',storageKey) || read('sessionStorage',storageKey) || '';
  let state = null, focused = '', refreshing = false, again = false, scheduled = null, poll = null, retry = null, abort = null, epoch = 0, failures = 0;
  let channels = null, threadCache = null, single = null, olderTask = null;
  let writeOwner = '', readSerial = 0, readIds = [];
  const refreshTargets = new Set();
  let live = 'Reconnecting…', error = '', authError = '';
  const agentsByRun = {}, listeners = new Set();
  const emit = () => listeners.forEach(fn=>fn(getState()));
  function getState() { return {state,channels,thread:threadCache,single,agentsByRun,focused,live,error,authError,authenticated:!!key,writeOwner,readSerial,readIds}; }
  function beginWrite(owner) { if (writeOwner || !key) return false; writeOwner=owner;emit();return true; }
  function endWrite(owner) { if (writeOwner===owner) {writeOwner='';emit();} }
  function stop() { epoch++; abort?.abort(); abort = null; [poll,retry,scheduled].forEach(clearTimeout); poll = retry = scheduled = null; }
  function rejectKey(message) { stop(); key = ''; state = null; channels = threadCache = single = null; writeOwner='';refreshTargets.clear();readIds=[];Object.keys(agentsByRun).forEach(id=>delete agentsByRun[id]); write('localStorage',storageKey,null); write('sessionStorage',storageKey,null); authError = message; emit(); }
  async function api(path, method = 'GET', body) {
    try {
      const response = await fetch(path,{method,headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},cache:'no-store',...(body === undefined ? {} : {body:JSON.stringify(body)})});
      const result = await response.json();
      if (response.status === 401) { rejectKey(result.error || 'Please connect again.'); throw Object.assign(Error(result.error || 'Please connect again.'),{status:401}); }
      if (!response.ok) throw Object.assign(Error(result.error || 'Request failed ('+response.status+')'),{status:response.status});
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
    const requested = focused, generation = epoch, targets = [...refreshTargets];
    try {
      const t = root.AC.thread, cached = threadCache || t.emptyCache();
      const known = cached.windowIds.slice(-2000).map(id=>id+':'+cached.messages[id].rev).join(',');
      // Keep the live snapshot on the active session. M6 reads a selected historical
      // session once through its guarded detail loader, rather than polling it here.
      const activeId=channels?.channels?.[0]?.active_session || state?.runs?.find(r=>!['completed','blocked','failed','stopped','limit_reached'].includes(r.status))?.id || '';
      const [stateResult,channelResult,newest] = await Promise.all([
        api('/api/state?scope=current&run='+encodeURIComponent(activeId)), api('/api/channels'),
        api('/api/thread?channel=main&limit=200'+(known ? '&known='+encodeURIComponent(known) : ''))
      ]);
      if (generation !== epoch) return;
      let page = {...newest,newestIds:newest.messages.map(m=>m.id)}, walks = 0;
      const newestIds = new Set(page.newestIds);
      const stale = cached.ids.filter(id=>cached.messages[id].action != null && !newestIds.has(id));
      const previousWaiting = channels?.project === channelResult.project ? channels.channels?.[0]?.waiting : undefined;
      const revalidate = targets.length>0 || newest.messages.some(m=>!m.same && m.kind==='outcome') ||
        previousWaiting !== undefined && channelResult.channels?.[0]?.waiting < previousWaiting;
      while (t.findGap(cached,page) && page.before && walks < 5) {
        const older = await api('/api/thread?channel=main&limit=200&before='+encodeURIComponent(page.before));
        page = {...page,messages:[...older.messages,...page.messages],sessions:[...older.sessions,...page.sessions],before:older.before};walks++;
        if (generation !== epoch) return;
      }
      // Decisions outside the newest window must be re-read from the server. Share the
      // ten-page budget with gap recovery; discard unverifiable history at the bound.
      const uncovered = ()=>[...stale,...targets].some(id=>!page.messages.some(m=>m.id===id));
      while (revalidate && uncovered() && page.before && walks < 10) {
        const older = await api('/api/thread?channel=main&limit=200&before='+encodeURIComponent(page.before));
        page = {...page,messages:[...older.messages,...page.messages],sessions:[...older.sessions,...page.sessions],before:older.before};walks++;
        if (generation !== epoch) return;
      }
      if (generation !== epoch) return;
      threadCache = t.mergeNewest(threadCache || cached,page,revalidate && uncovered() || t.findGap(cached,page) || !page.messages.length || cached.project && cached.project !== page.project);channels = channelResult;
      readIds=page.messages.map(m=>m.id);
      // The visible live fallback shares this refresh; terminal history only needs
      // the existing targeted decision recovery, with no additional polling.
      const fallbackLive=single?.sessions[requested] && !['completed','blocked','failed','stopped','limit_reached'].includes(single.sessions[requested].status);
      if(single && requested===focused && (fallbackLive || targets.some(id=>single.messages[id]))) {
        const knownSingle=single.ids.slice(-2000).map(id=>id+':'+single.messages[id].rev).join(',');
        let detailPage=await api('/api/thread?session='+encodeURIComponent(requested)+'&limit=200&known='+encodeURIComponent(knownSingle));
        while(targets.some(id=>!detailPage.messages.some(m=>m.id===id)) && detailPage.before && walks<10) {
          const older=await api('/api/thread?session='+encodeURIComponent(requested)+'&limit=200&before='+encodeURIComponent(detailPage.before));walks++;
          detailPage={...detailPage,messages:[...older.messages,...detailPage.messages],sessions:[...older.sessions,...detailPage.sessions],before:older.before};
        }
        if(generation!==epoch || requested!==focused)return;
        single=t.mergeNewest(single,detailPage,targets.some(id=>!detailPage.messages.some(m=>m.id===id)));
        readIds=[...readIds,...detailPage.messages.map(m=>m.id)];
      }
      targets.forEach(id=>refreshTargets.delete(id));readSerial++;
      // The live read follows the active session, independently of room/Workspace focus.
      // Opening an active Workspace must neither discard this read nor start another one.
      if (stateResult.run?.id) agentsByRun[stateResult.run.id] = stateResult.agents || [];
      state = stateResult;
      error = '';emit();
    } catch {} finally {
      refreshing = false;
      if (again) { again = false; scheduleRefresh(); }
      schedulePoll();
    }
  }
  async function loadOlder() {
    if (olderTask) return olderTask;
    const target = single || threadCache;
    if (!target?.before) return false;
    const generation = epoch, cursor = target.before, mode = single;
    olderTask = (async()=>{
      const page = await api('/api/thread?'+(mode ? 'session='+encodeURIComponent(focused) : 'channel=main')+'&limit=200&before='+encodeURIComponent(cursor));
      if (generation !== epoch || mode !== single) return false;
      const current = single || threadCache;
      if (current.before !== cursor) return false;
      const merged = root.AC.thread.prependOlder(current,page);
      if (mode) single=merged;else threadCache=merged;
      emit();return true;
    })();
    try{return await olderTask;}finally{olderTask=null;}
  }
  async function locateSession(id) {
    const generation=epoch;single=null;
    for(let page=0;page<=10;page++){
      if(focused!==id || generation!==epoch)return;
      if(threadCache?.ids.some(key=>threadCache.messages[key].session===id && threadCache.messages[key].kind==='session_start')){emit();return;}
      if(page===10 || !threadCache?.before)break;
      await loadOlder();
    }
    try {
      const page=await api('/api/thread?session='+encodeURIComponent(id)+'&limit=200');
      if(focused!==id || generation!==epoch)return;
      single=root.AC.thread.mergeNewest(root.AC.thread.emptyCache(),page);emit();
    }catch(exception){if(exception.status===404 && focused===id && generation===epoch){focused='';single=null;error="That session is not in this project's history.";root.location.replace('#/');emit();}}
  }
  async function locateWaiting(budget=10) {
    single=null;
    for(let page=0;page<=budget;page++){
      const id=threadCache?.ids.find(id=>threadCache.messages[id].action != null && threadCache.messages[id].kind!=='outcome');
      if(id){emit();return id;}
      if(page===budget || !threadCache?.before)break;
      await loadOlder();
    }
    return null;
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
  // Shared M6 selected-session reader: one guarded read for panel and Workspace.
  function selectedSession(changed) {
    let selected='',status,active=false,generation=0,data=null,error='',loading=false,flight=null,errorStatus=0;
    function clear(){selected='';status=undefined;data=null;error='';errorStatus=0;loading=false;generation++;}
    function read() {
      if(!selected || active || flight || !core.getState().authenticated)return;
      const id=selected,version=generation;loading=true;error='';
      flight=core.api('/api/state?scope=current&run='+encodeURIComponent(id)).then(result=>{
        if(version!==generation || selected!==id || !core.getState().authenticated)return;
        if(result.run?.id!==id)throw Object.assign(Error('That session is not available.'),{status:404});data=result;
      }).catch(exception=>{if(version===generation && selected===id && core.getState().authenticated){error=exception.message;errorStatus=exception.status || 0;}}).finally(()=>{
        flight=null;
        if(version===generation){loading=false;changed();}
        else if(selected && !active && !data && !error){read();changed();}
      });
    }
    function update(snapshot,id) {
      if(!snapshot.authenticated){clear();return;}
      const nextStatus=snapshot.state?.runs?.find(r=>r.id===id)?.status;
      const isActive=!!id && snapshot.channels?.channels?.[0]?.active_session===id;
      if(selected!==id || active!==isActive){selected=id;status=nextStatus;active=isActive;data=null;error='';errorStatus=0;loading=false;generation++;}
      else if(nextStatus!==undefined && nextStatus!==status){status=nextStatus;data=null;error='';generation++;}
      if(active){data=snapshot.state?.run?.id===id?snapshot.state:null;loading=false;}
      else if(id && !data && !error){loading=true;if(snapshot.state && snapshot.channels)read();}
    }
    function retry(){if(flight)return;error='';data=null;read();changed();}
    return {update,retry,getState:()=>({data,selected,loading,error,errorStatus})};
  }
  function focus(id, refreshOnChange=true) { if (id !== focused) { focused = id; single = null; if(refreshOnChange)scheduleRefresh(); } }
  function post(path,body) { return api(path,'POST',body); }
  function refreshNow(messageId) { if(messageId)refreshTargets.add(messageId);clearTimeout(scheduled);scheduled=null;return refresh(); }
  const core = {selectedSession,api,post,beginWrite,endWrite,refreshNow,loadOlder,locateSession,locateWaiting,subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn);},getState,start,connect,focus,refresh,scheduleRefresh,handleEventBlock,stop,read,write,dismissError(){error='';emit();}};
  root.AC = root.AC || {}; root.AC.core = core;
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
})(typeof window !== 'undefined' ? window : globalThis);
