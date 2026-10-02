(function (root) {
  'use strict';
  const emptyCache = () => ({ids:[],messages:{},sessions:{},windowIds:[],before:null,live:{session:null},project:''});
  function applyStubs(messages, cached) { return messages.map(m=>m.same ? cached[m.id] : m).filter(Boolean); }
  function findGap(cache, page) { return cache.ids.length > 0 && page.messages.length > 0 && !page.messages.some(m=>cache.messages[m.id]); }
  function mergeNewest(cache, page, reset = false) {
    const fresh = applyStubs(page.messages,cache.messages), incoming = new Set(fresh.map(m=>m.id));
    const overlap = cache.ids.findIndex(id=>incoming.has(id));
    const boundary = overlap < 0 ? cache.ids.length : overlap;
    const prefix = reset ? [] : cache.ids.slice(0,boundary).filter(id=>!incoming.has(id));
    const ids = [...prefix,...fresh.map(m=>m.id)], messages = {};
    for (const id of prefix) messages[id] = cache.messages[id];
    for (const m of fresh) messages[m.id] = m;
    const sessions = reset ? {} : {...cache.sessions};
    for (const s of page.sessions) sessions[s.id] = s;
    return {ids,messages,sessions,windowIds:page.newestIds || fresh.map(m=>m.id),before:prefix.length ? cache.before : page.before,live:page.live,project:page.project};
  }
  function prependOlder(cache, page) {
    const older = applyStubs(page.messages,cache.messages).filter(m=>!cache.messages[m.id]), messages = {...cache.messages};
    for (const m of older) messages[m.id] = m;
    const sessions = {...cache.sessions}; for (const s of page.sessions) sessions[s.id] = s;
    return {...cache,ids:[...older.map(m=>m.id),...cache.ids],messages,sessions,before:page.before};
  }
  function groupQuiet(messages) {
    const groups = [];
    for (const message of messages) {
      const last = groups.at(-1), quiet = ['progress','system'].includes(message.kind);
      if (quiet && !message.action && last?.quiet && last.session === message.session && new Date(last.items.at(-1).at).toLocaleDateString() === new Date(message.at).toLocaleDateString()) last.items.push(message);
      else groups.push({id:message.id,session:message.session,quiet:quiet && !message.action,items:[message]});
    }
    return groups;
  }
  function sessionCollapsed(session, newest, live, expanded = {}) { return expanded[session.id] ?? (session.id !== newest && session.id !== live.session); }
  function liveLabel(live) { return live?.session ? ({manager:'Hermes is planning…',code:'Agents are working…',verify:'Verifying…'}[live.phase] || '') : ''; }
  function pendingHint(message, messages, live) {
    const index = messages.findIndex(m=>m.id === message.id);
    return message.kind === 'note' && live.session === message.session && !messages.slice(index+1).some(m=>m.session === message.session && m.kind === 'decision');
  }
  function mount(host, controls) {
    const m = root.AC.model, e = m.esc, expanded = {}, nodes = new Map(), disclosures = new Map();
    let cache = emptyCache(), initial = true, follow = true, unseen = 0, mode = '', paging = false, emptyPageFocused = false;
    host.innerHTML = '<div id="thread-mode"></div><div id="thread-history"></div><div id="thread-items" role="list"></div><p id="thread-live" role="status"></p>';
    const $ = id=>host.querySelector('#'+id), items = $('thread-items');
    const pill = document.createElement('button'); pill.id = 'new-messages'; pill.hidden = true;
    host.parentNode.insertBefore(pill,host.nextSibling);
    function bottom() {host.scrollTop = host.scrollHeight;follow = true;unseen = 0;pill.hidden = true;}
    pill.addEventListener('click',bottom);
    host.addEventListener('scroll',()=>{follow = host.scrollHeight-host.scrollTop-host.clientHeight <= 32;if(follow){unseen=0;pill.hidden=true;}});
    const status = value=>{const info=m.sessionsFromState({runs:[{status:value}]})[0];return m.symbolHTML(info.symbol)+' '+e(info.statusLabel);};
    const time = at=>`<time title="${e(m.timeLabel(at))}">${e(m.relTime(at))}</time>`;
    const actor = name=>`<span class="actor"><span aria-hidden="true">${name === 'you' ? '◌' : name === 'hermes' ? '◇' : name?.startsWith('reviewer') ? '✓' : name?.startsWith('researcher') ? '⌕' : name?.startsWith('tester') ? '▧' : '●'}</span> ${e(name === 'agentcontrol' ? 'AgentControl' : name)}</span>`;
    const text = (value,cls='',decorative=false)=>`<p class="plain ${cls}">${decorative?m.statusMarkup(value):e(value)}</p>`;
    const fields = (obj,keys)=>`<dl>${keys.filter(k=>obj?.[k] !== undefined && obj[k] !== null).map(k=>`<dt>${e(k.replace(/_/g,' '))}</dt><dd class="plain">${e(Array.isArray(obj[k]) ? obj[k].join(', ') : typeof obj[k] === 'object' ? '' : obj[k])}</dd>`).join('')}</dl>`;
    const risk = value=>value ? fields(value,['level','label','class','reasons']) : '';
    const receiptActor = name=>name === 'You, via dashboard' ? 'you' : name;
    const verificationStatus = {running:'running',passed:'passed',failed:'failed'};
    function publicText(message) {const d=message.detail || {};return message.kind==='system' && Array.isArray(d.argv) && d.ended && ['passed','failed'].includes(d.status) ? 'Verification (on demand) · '+d.status : message.text;}
    function receiptState(r) {
      if (!r) return '';
      // Copied from classic app.js receiptLabel(): recorded decisions and delivery states.
      const label = r.state === 'confirmed' ? (r.action === 'approve' ? 'Approved once' : r.action === 'reject' ? 'Denied' : 'Answered')
        : ({sent:'Awaiting confirmation',dispatching:'Sending decision',uncertain:'Delivery uncertain',resolved:'Request resolved',failed:'Delivery failed'})[r.state] || r.state;
      return [label,r.actor && 'by '+receiptActor(r.actor),r.action === 'reject' && r.redirect && 'redirected'].filter(Boolean).join(' · ');
    }
    function body(message, hint) {
      const d = message.detail || {}, action = message.action != null;
      const decisionLink = action ? '<div class="waiting-line"><span class="waiting-state"><span aria-hidden="true">!</span> Waiting for you</span> · <a class="decision-classic" href="/classic">Open in classic dashboard</a></div>' : '';
      let summary = '', detail = '', type = 'line';
      switch (message.kind) {
        case 'goal': case 'note':
          type='bubble you-bubble';summary=text(message.text,'clamp-six');detail=text(message.text);
          if (message.kind === 'note') summary = `<small class="recipient">${e(d.redirect_for ? 'Redirect after denying request '+d.redirect_for : d.to ? '→ @'+d.to : '→ Hermes')}</small>`+summary+(hint ? '<small>Hermes reads this before the next turn</small>' : '');
          break;
        case 'decision':
          type='bubble';summary=text(message.text)+(d.title ? text('Next: '+d.title) : '')+(d.repaired ? '<small>repaired reply</small>' : '')+(d.planning ? text('Team plan · '+d.proposal_counts?.agents+' agents · '+d.proposal_counts?.tasks+' tasks','muted') : '');
          detail= d.plan?.length ? '<ol>'+d.plan.map(p=>`<li class="plain">${e(p)}</li>`).join('')+'</ol>' : '';break;
        case 'turn': {
          const files=d.files || [], add=files.reduce((n,f)=>n+(Number(f.added)||0),0), remove=files.reduce((n,f)=>n+(Number(f.removed)||0),0);
          const v=d.verification?.status, verification=v==='passed' ? '✓ passed' : v==='failed' ? '✕ failed' : '– not configured';
          summary=text('turn '+d.number+' · '+message.text)+text(statusText(d.status)+' · '+verification+' · '+(files.length+(d.files_omitted || 0))+' files +'+add+'/−'+remove,'',true)+(d.uncertain ? text('! submission uncertain','warning',true) : '');
          // This is the bounded public task from /api/thread, never the Hermes request prompt.
          detail=(d.prompt ? '<h3>Task</h3><details class="task-more"><summary>Show more</summary>'+text(d.prompt)+'</details>'+text(d.prompt,'task-preview') : '')+'<ul class="files">'+files.map(f=>`<li class="plain">${e(f.path)} · ${e(f.change)} +${e(f.added)}/−${e(f.removed)}</li>`).join('')+'</ul>'+(d.files_omitted ? text(d.files_omitted+' more files') : '')+(d.result_tail ? `<pre>${e(d.result_tail)}</pre>` : '')+(d.ended ? text('Ended '+m.timeLabel(d.ended)) : '')+`<a data-workspace-link href="#/w/${e(encodeURIComponent(message.session))}/${e(encodeURIComponent(message.refs?.agent || message.actor))}">Open workspace</a>`;break;
        }
        case 'research': summary=text('research · '+message.text)+text(d.expired ? 'Not decided before the session ended' : statusText(d.status),d.expired ? 'muted' : '',true);detail=fields(d.request,['question','why','toolsets','max_turns','seconds'])+(d.events || []).map(event=>text(event.kind+' · '+event.text)+time(event.created)).join('');break;
        case 'request': type='request-card';summary=text(message.text)+`<p class="risk ${['R2','R3'].includes(d.risk?.level) ? 'warning' : 'muted'}" data-risk-class="${e(d.risk?.class)}">${e([d.risk?.level,d.risk?.label,d.risk?.class].filter(Boolean).join(' · '))}</p>`+text(receiptState(d.receipt));detail=action ? '' : (d.patterns || []).map(p=>text(p)).join('')+(d.questions || []).map(q=>fields(q,['header','question'])+(q.options || []).map(o=>fields(o,['label','description'])).join('')).join('')+risk(d.risk)+fields(d.receipt,['action','state','risk','created','updated','redirect'])+(d.receipt?.actor ? text('Recorded actor: '+receiptActor(d.receipt.actor)) : '')+(d.refresh_needed ? text('Request needs refresh in classic') : '');break;
        case 'proposal': {
          const agents=Array.isArray(d.proposal?.agents) ? d.proposal.agents : Object.entries(d.proposal?.agents || {}).map(([name,agent])=>({name,...agent}));
          type='request-card';summary=text(message.text)+(action ? text('Team proposal waiting for your decision') : '');detail=action ? '' : '<h3>Agents</h3>'+agents.map(a=>fields(a,['name','role','task','responsibility','model','skills'])).join('')+'<h3>Tasks</h3>'+(d.proposal?.tasks || []).map(t=>fields(t,['id','title','agent','depends_on','description'])).join('')+(d.warnings || []).map(w=>text(w,'warning')).join('');break;
        }
        case 'skill':type='quiet';summary=d.expired ? '<p class="plain">'+[...[message.text,d.agent].filter(Boolean).map(e),'<span class="muted">Not decided before the session ended</span>'].join(' · ')+'</p>' : text([message.text,d.agent,d.state].filter(Boolean).join(' · '));detail=fields(d,['source','reasons'])+risk(d.risk);break;
        case 'alert':type='warning';summary=text('! '+message.text,'',true);detail=fields(d,['title','reason','summary','status','error']);break;
        case 'outcome':type='outcome';summary=text(statusText(d.status),'',true)+text(message.text,'clamp-three')+(d.workspace?.state ? text('Workspace '+d.workspace.state) : '')+(d.workspace?.apply_blocked ? text('apply blocked: '+d.workspace.apply_blocked,'warning') : '')+(d.verification?.status ? text('Verification (on demand) · '+(Object.hasOwn(verificationStatus,d.verification.status) ? verificationStatus[d.verification.status] : d.verification.status)+((d.verification.status==='running'?d.verification.created:d.verification.ended) ? ' · '+m.relTime(d.verification.status==='running'?d.verification.created:d.verification.ended) : ''),'muted') : '');detail=text(message.text);break;
        case 'system':type='quiet';summary=text(publicText(message));break;
        default:type='quiet';summary=text(message.text);
      }
      if(action && (message.kind==='proposal' || message.kind==='request' || message.kind==='research'))detail='';
      return `<h2 class="sr-only">${e(message.kind)} · ${e(m.boundText(message.text))}</h2><div class="message ${type}"><div class="message-meta">${actor(message.actor)} ${time(message.at)}</div>${summary}${detail ? `<details class="message-detail"><summary>${['goal','note','outcome'].includes(message.kind) ? 'Show more' : 'Details'}</summary><div>${detail}</div></details>` : ''}${decisionLink}${message.kind==='outcome' && ['completed','blocked','failed','stopped','limit_reached'].includes(d.status) ? `<a class="reply-session" href="#/" data-reply="${e(message.session)}">Reply in session</a>` : ''}</div>`;
    }
    function statusText(value) {if(value==='finished')return '✓ Finished';return m.sessionsFromState({runs:[{status:value}]})[0].symbol+' '+m.sessionsFromState({runs:[{status:value}]})[0].statusLabel;}
    function anchor() {
      const top=host.getBoundingClientRect?.().top || 0;
      const node=[...items.children].find(n=>!n.hidden && n.getBoundingClientRect?.().bottom > top);
      return {node,offset:node ? node.getBoundingClientRect().top-top : 0,height:host.scrollHeight,scroll:host.scrollTop};
    }
    function render(next, viewMode = '', keepPagingControl=false) {
      let focusedGroup=null;
      for(const record of nodes.values())if(record.messageIds?.length){
        const open=[...record.node.querySelectorAll('details')].map(d=>d.open);
        for(const id of record.messageIds)disclosures.set(id,open);
        if(record.node.contains(document.activeElement))focusedGroup={ids:record.messageIds,index:[...record.node.querySelectorAll('a,button,summary')].indexOf(document.activeElement)};
      }
      const saved = anchor(), oldIds=new Set(cache.ids), newCount=next.ids.filter(id=>!oldIds.has(id)).length, modeChanged=mode!==viewMode;
      const addedNewest= next.windowIds.filter(id=>!oldIds.has(id)).length;
      if(cache.ids.length && next.ids[0]!==cache.ids[0] && next.ids.includes(cache.ids[0]) && next.windowIds.join(',')===cache.windowIds.join(','))follow=false;
      cache=next;mode=viewMode;
      $('thread-mode').innerHTML=mode ? '<strong>Viewing one session</strong> <a href="#/">Back to room</a>' : '';
      const history=$('thread-history');emptyPageFocused=keepPagingControl || emptyPageFocused && history.querySelector('#load-earlier')?.contains(document.activeElement);
      if(cache.before || paging || emptyPageFocused){if(!history.querySelector('#load-earlier'))history.innerHTML='<button id="load-earlier">Load earlier</button>';const button=history.querySelector('#load-earlier');button.disabled=paging;button.setAttribute('aria-busy',String(paging));button.setAttribute('aria-disabled',String(!cache.before));}
      else history.innerHTML="<p class=\"muted\">Beginning of this project's history</p>";
      const messages=cache.ids.map(id=>cache.messages[id]), newest=messages.at(-1)?.session, desired=[];let day='', session='';
      function keyed(id,key,html,messageIds=[]) {
        let record=nodes.get(id);
        if (!record || record.key!==key) {
          const node=document.createElement('article');node.dataset.key=id;node.setAttribute('role','listitem');node.tabIndex=-1;node.innerHTML=html;
          const remembered=messageIds.map(id=>disclosures.get(id)).find(state=>state?.some(Boolean));
          if(remembered)[...node.querySelectorAll('details')].forEach((d,i)=>{d.open=!!remembered[i];});
          if(record){const opens=[...record.node.querySelectorAll('details')].map(d=>d.open);[...node.querySelectorAll('details')].forEach((d,i)=>{d.open=!!opens[i];});
            const focused=document.activeElement, hadFocus=record.node.contains(focused);record.node.replaceWith(node);if(hadFocus) {const index=[...record.node.querySelectorAll('a,button,summary')].indexOf(focused);(node.querySelectorAll('a,button,summary')[index] || node).focus?.({preventScroll:true});} }
          record={key,node};nodes.set(id,record);
        }
        record.messageIds=messageIds;desired.push(record.node);return record.node;
      }
      for(const group of groupQuiet(messages)) {
        const message=group.items[0], s=cache.sessions[message.session];if(!s)continue;
        const collapsed=sessionCollapsed(s,newest,cache.live,expanded);
        if(session!==s.id){session=s.id;const parent=cache.sessions[s.parent], count=messages.filter(msg=>msg.session===s.id && msg.kind!=='session_start').length;
          const partial=!messages.some(msg=>msg.session===s.id && msg.kind==='session_start') || cache.before && messages[0]?.session===s.id && messages[0]?.kind!=='session_start';
          const label=partial?'Show messages':'Show '+count+' message'+(count===1?'':'s');
          const node=keyed('divider:'+s.id,JSON.stringify(s)+collapsed+label+(parent?.title || ''),`<div class="session-divider" data-session="${e(s.id)}"><a class="session-title" href="#/s/${e(encodeURIComponent(s.id))}">${e(s.title)}</a><span>${status(s.status)} · ${time(s.created)} ${s.mode === 'team' ? '<span class="badge">team</span>' : ''}</span>${s.parent ? `<small>continues <a href="#/s/${e(encodeURIComponent(s.parent))}">${e(parent?.title || s.parent)}</a></small>` : ''}<button data-collapse="${e(s.id)}" aria-expanded="${!collapsed}">${collapsed ? label : 'Collapse session'}</button></div>`);node.hidden=false;
        }
        const localDay=new Date(message.at).toLocaleDateString();if(localDay!==day){day=localDay;const node=keyed('day:'+message.id,localDay,`<p class="day-separator">${e(localDay)}</p>`);node.hidden=collapsed;}
        if(message.kind==='session_start')continue;
        const hint=pendingHint(message,messages,cache.live), key=group.items.map(msg=>msg.id+':'+msg.rev).join(',')+hint;
        const html=group.quiet && group.items.length>1 ? `<details class="quiet updates"><summary>${group.items.length} updates</summary>${group.items.map(msg=>text(publicText(msg))+time(msg.at)).join('')}</details>` : body(message,hint);
        const node=keyed(message.id,key,html,group.items.map(msg=>msg.id));node.dataset.message=message.id;node.dataset.sessionId=s.id;
        node.classList.toggle('collapsed-preview',collapsed && ['goal','outcome'].includes(message.kind));node.hidden=collapsed && !['goal','outcome'].includes(message.kind);
      }
      const keep=new Set(desired);for(const [id,record] of nodes)if(!keep.has(record.node)){record.node.remove();nodes.delete(id);}
      // Move only nodes whose order actually changed; unchanged nodes retain focus and identity.
      let cursor=items.firstChild;for(const node of desired){if(node===cursor)cursor=cursor.nextSibling;else items.insertBefore(node,cursor);}
      for(const message of messages){const node=nodes.get(message.id)?.node;if(node)controls.decisions?.attach(node,message);}
      if(focusedGroup && !host.contains(document.activeElement)){const replacement=[...nodes.values()].find(record=>record.messageIds?.some(id=>focusedGroup.ids.includes(id)));replacement?.node.querySelectorAll('a,button,summary')[focusedGroup.index]?.focus?.({preventScroll:true});}
      if(!messages.length)items.innerHTML='<div class="empty"><h2>A room for your project</h2><p>Write a goal below to start the first session.</p></div>';
      else items.querySelector('.empty')?.remove();
      if($('thread-live').textContent!==liveLabel(cache.live))$('thread-live').textContent=liveLabel(cache.live);$('thread-live').hidden=!liveLabel(cache.live);
      if(initial || modeChanged || follow){bottom();initial=false;}else{
        if(saved.node && keep.has(saved.node))host.scrollTop=saved.scroll+saved.node.getBoundingClientRect().top-host.getBoundingClientRect().top-saved.offset;
        else if(newCount && !addedNewest)host.scrollTop=saved.scroll+host.scrollHeight-saved.height;
        unseen+=addedNewest;pill.textContent=unseen+' new ↓';pill.hidden=!unseen;
      }
    }
    host.addEventListener('click',async event=>{
      const toggle=event.target.closest('[data-collapse]');if(toggle){const id=toggle.dataset.collapse;expanded[id]=toggle.getAttribute('aria-expanded')==='true';render(cache,mode);}
      const button=event.target.closest('#load-earlier');
      if(button && !paging && cache.before){const previous=new Set(cache.ids);paging=true;render(cache,mode);try{await controls.older();}catch{}finally{
        const first=cache.ids.find(id=>!previous.has(id) && cache.messages[id].kind!=='session_start'),record=first && [...nodes.values()].find(record=>record.messageIds?.includes(first));
        paging=false;render(cache,mode,!first);
        if(record){if(record.node.hidden){expanded[cache.messages[first].session]=false;render(cache,mode);}record.node.focus?.({preventScroll:true});}
        else $('load-earlier')?.focus?.({preventScroll:true});
      }}
    });
    function reveal(id, focus=false) {
      const node=nodes.get('divider:'+id)?.node || nodes.get(id)?.node;if(!node)return false;
      const session=node.dataset.sessionId || node.querySelector('[data-session]')?.dataset.session;
      if(session){expanded[session]=false;render(cache,mode);}
      const target=nodes.get('divider:'+id)?.node || nodes.get(id)?.node;follow=false;target.scrollIntoView?.({block:'start'});if(focus)target.focus?.({preventScroll:true});target.classList.add('focused');setTimeout(()=>target.classList.remove('focused'),1600);return true;
    }
    return {render,reveal,bottom,getCache:()=>cache};
  }
  const thread={emptyCache,applyStubs,mergeNewest,prependOlder,findGap,groupQuiet,sessionCollapsed,liveLabel,pendingHint,mount};
  root.AC=root.AC || {};root.AC.thread=thread;
  if(typeof module!=='undefined' && module.exports)module.exports=thread;
})(typeof window!=='undefined' ? window : globalThis);
