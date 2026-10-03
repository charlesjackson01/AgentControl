(function (root) {
  'use strict';
  const endpoints = new Set(['/api/review','/api/control','/api/research/decide','/api/skills/fetch','/api/skills/decide']);
  const inFlightReceipt = message=>['dispatching','sent','uncertain'].includes(message.detail?.receipt?.state);
  const object=value=>!!value && typeof value==='object' && !Array.isArray(value);
  const strings=value=>Array.isArray(value) && value.every(item=>typeof item==='string');
  const textFields=(value,keys)=>object(value) && keys.every(key=>value[key]===undefined || typeof value[key]==='string');
  function supportedQuestions(questions) {
    return Array.isArray(questions) && questions.length>0 && questions.every(q=>textFields(q,['header','question']) && typeof q.question==='string' && Array.isArray(q.options) && q.options.every(o=>textFields(o,['label','description']) && typeof o.label==='string') && ['multiple','custom'].every(key=>q[key]===undefined || typeof q[key]==='boolean'));
  }
  function supportedProposal(proposal) {
    const agents=Array.isArray(proposal?.agents)?proposal.agents:object(proposal?.agents)?Object.values(proposal.agents):null;
    return !!agents?.length && agents.every(a=>textFields(a,['name','id','role','responsibility','task','model']) && (a.skills===undefined || strings(a.skills))) && Array.isArray(proposal.tasks) && proposal.tasks.every(t=>textFields(t,['id','title','agent','description','question']) && typeof t.title==='string' && typeof t.agent==='string' && (t.files===undefined || strings(t.files)) && (t.depends_on===undefined || strings(t.depends_on)));
  }
  function confirmed(input,permissions) {return typeof input==='string' && typeof permissions.confirm_word==='string' && !!permissions.confirm_word && input.trim().toLowerCase()===permissions.confirm_word.toLowerCase();}
  function allowedEndpoint(message, choice) {
    const endpoint=message?.action?.endpoint;
    if(!endpoints.has(endpoint))return null;
    // The owner's sole endpoint exception: refuse an actionable, unfetched skill.
    if(choice==='reject' && message.kind==='skill' && message.detail?.state==='awaiting_fetch' && endpoint==='/api/skills/fetch' && (!message.action.choices || message.action.choices.includes(choice)))return '/api/skills/decide';
    return endpoint;
  }
  function controlsFor(message, permissions = {}) {
    const endpoint=allowedEndpoint(message), d=message?.detail || {};
    if(!endpoint || inFlightReceipt(message))return [];
    let controls=[];
    const add=(choice,label,primary=false,dialog=false,blocked=false)=>controls.push({choice,label,primary,dialog,disabled:!!blocked});
    const truncated=!!d.review_truncated;
    if(message.kind==='request' && endpoint==='/api/review') {
      if(d.kind==='permission') {
        add('approve','Approve once',true,d.risk?.decision==='confirm',truncated || !textFields(d.review,['command','file','description','diff','old_text','new_text','content']) || d.risk?.decision==='confirm' && !permissions.confirm_word);
        add('reject','Deny…',false,true);
      } else if(d.kind==='question') {
        add('answer','Answer',true,false,truncated || !supportedQuestions(d.questions));add('reject','Dismiss');
      }
    } else if(message.kind==='proposal' && endpoint==='/api/control') {
      add('approve_team','Approve team',true,false,truncated || !supportedProposal(d.proposal));add('single_agent','Run as one agent');add('repropose','Ask for another plan…',false,true);
    } else if(message.kind==='research' && endpoint==='/api/research/decide') {
      const req=d.request;
      add('approve','Allow research…',true,true,truncated || !textFields(req,['question','why']) || typeof req?.question!=='string' || !strings(req?.toolsets) || !Number.isFinite(req?.max_turns) || !Number.isFinite(req?.seconds) || !permissions.confirm_word);add('reject','Decline');
    } else if(message.kind==='skill') {
      if(d.state==='awaiting_fetch' && endpoint==='/api/skills/fetch') {add('fetch','Fetch for review',true);add('reject','Reject');}
      if(d.state==='proposed' && endpoint==='/api/skills/decide') {add('approve','Install',true,false,truncated || !textFields(d.review,['description','skill_md']) || typeof d.review?.skill_md!=='string' || !strings(d.review?.files) || !Number.isFinite(d.review?.size));add('reject','Reject');}
    } else if(message.kind==='outcome' && endpoint==='/api/control') {
      const ws=d.workspace || {};
      add('apply','Apply to '+(typeof ws.base_branch==='string' && ws.base_branch || 'your branch')+'…',false,true,truncated || !textFields(ws,['branch','base_branch','shortstat']) || !ws.branch || !ws.base_branch || !Number.isInteger(ws.commits) || typeof ws.shortstat!=='string');
      add('discard_workspace','Discard work…',false,true,typeof ws.branch!=='string' || !ws.branch);add('verify','Verify now',true);
    }
    return controls.filter(control=>!message.action.choices || message.action.choices.includes(control.choice));
  }
  function requireControl(message, choice, permissions) {
    const control=controlsFor(message,permissions).find(c=>c.choice===choice);
    if(!control || control.disabled)throw Error('Review this decision in the classic dashboard.');
  }
  function fields(message, keys) {
    const source=message.action?.fields || {}, result={};
    for(const key of keys) {if(source[key]===undefined || source[key]===null || source[key]==='')throw Error('This decision needs a fresh read.');result[key]=source[key];}
    return result;
  }
  function answersFrom(questions, answers) {
    if(!Array.isArray(questions) || !questions.length)throw Error('This question has no supported answer fields. Use the classic dashboard.');
    if(!Array.isArray(answers) || answers.length!==questions.length)throw Error('Answer every question before submitting');
    return answers.map((values,i)=>{
      if(!Array.isArray(values) || !values.length || values.some(v=>typeof v!=='string' || !v.trim() || v.length>5000))throw Error('Each question needs at least one nonempty answer of at most 5,000 characters');
      if(new Set(values).size!==values.length)throw Error('Duplicate answers are not allowed');
      if(!questions[i].multiple && values.length!==1)throw Error('Choose one answer for this question');
      if(questions[i].custom===false && values.some(v=>!(questions[i].options || []).some(o=>o.label===v)))throw Error('Choose one of the supplied options');
      return [...values];
    });
  }
  function reviewBody(message, action, inputs = {}, permissions = {}) {
    requireControl(message,action,permissions);
    const body={...fields(message,['run','kind','request_id','fingerprint']),action};
    if(body.kind!==message.detail.kind)throw Error('This decision needs a fresh read.');
    if(action==='answer')body.answers=answersFrom(message.detail.questions,inputs.answers);
    if(action==='approve') {
      if(message.detail.risk?.remember_allowed && inputs.remember===true)body.remember=true;
      if(message.detail.risk?.decision==='confirm') {
        if(!confirmed(inputs.confirm,permissions))throw Error('Type '+permissions.confirm_word+' to approve');body.confirm=inputs.confirm;
      }
    }
    if(action==='reject' && body.kind==='permission' && inputs.redirect?.trim()) {
      if(typeof inputs.redirect!=='string' || inputs.redirect.length>5000)throw Error('Redirection must be 1–5,000 characters');body.redirect=inputs.redirect;
    }
    return body;
  }
  function controlBody(message, action, inputs = {}) {
    requireControl(message,action,{});
    const body={...fields(message,['run']),action};
    if(action==='repropose') {
      if(typeof inputs.text!=='string' || !inputs.text.trim() || inputs.text.length>2000)throw Error('Add a note of 1–2,000 characters');body.text=inputs.text;
    }
    return body;
  }
  function researchBody(message, action, inputs = {}, permissions = {}) {
    requireControl(message,action,permissions);
    const body={...fields(message,['run','step','fingerprint']),action};
    if(action==='approve') {if(!confirmed(inputs.confirm,permissions))throw Error('Type '+permissions.confirm_word+' to allow research');body.confirm=inputs.confirm;}
    return body;
  }
  function skillBody(message, action) { requireControl(message,action,{});return {...fields(message,['id']),...(action==='fetch'?{}:{action})}; }
  function cardStatus(message, transient = {}) {
    if(inFlightReceipt(message))return ({dispatching:'Sending decision',sent:'Awaiting confirmation',uncertain:'Delivery uncertain'})[message.detail.receipt.state]+' · by '+(message.detail.receipt.actor==='You, via dashboard' ? 'you' : message.detail.receipt.actor || 'you');
    return ({sending:'Sending your decision…',sent:'Sent · waiting for AgentControl to record it','not-recorded':'Not recorded yet.'})[transient.phase] || transient.error || '';
  }
  const escape=value=>root.AC.model.esc(value);
  const plain=value=>typeof value==='string' || typeof value==='number' ? escape(value) : '';
  function proposalAgents(proposal) {
    const agents=proposal?.agents || [];
    return Array.isArray(agents) ? agents : Object.entries(agents).map(([name,agent])=>({name,...agent}));
  }
  function reviewMarkup(message) {
    const d=message.detail || {}, r=d.review || {}, pre=(title,value)=>typeof value==='string' ? '<h3>'+escape(title)+'</h3><pre>'+escape(value)+'</pre>' : '';
    let content='';
    if(message.kind==='request' && d.kind==='permission') {
      for(const [key,title] of [['command','Command'],['file','File'],['description','Description'],['diff','Diff'],['old_text','Old text'],['new_text','New text'],['content','Content']])content+=pre(title,r[key]);
      content+=(d.patterns || []).map(pattern=>'<p class="plain">'+plain(pattern)+'</p>').join('')+(d.risk?.impact ? '<p class="plain">'+plain(d.risk.impact)+'</p>' : '')+(d.risk?.reasons || []).map(reason=>'<p class="plain">'+plain(reason)+'</p>').join('');
    } else if(message.kind==='research') {
      const req=d.request || {};
      content='<dl>'+['question','why','toolsets','max_turns','seconds'].filter(key=>req[key]!==undefined).map(key=>'<dt>'+escape(key.replace(/_/g,' '))+'</dt><dd class="plain">'+(Array.isArray(req[key]) ? req[key].map(plain).join(', ') : plain(req[key]))+'</dd>').join('')+'</dl>';
    } else if(message.kind==='skill' && d.state==='proposed') {
      content=pre('Description',r.description)+(r.size!==undefined ? '<p>'+plain(r.size)+' bytes</p>' : '')+'<h3>Files</h3><ul class="files">'+(Array.isArray(r.files)?r.files:[]).map(file=>'<li class="plain">'+plain(file)+'</li>').join('')+'</ul>'+pre('SKILL.md',r.skill_md);
    } else if(message.kind==='proposal') {
      content='<h3>Tasks</h3><ol>'+(Array.isArray(d.proposal?.tasks)?d.proposal.tasks:[]).filter(object).map(task=>'<li class="plain">'+[task.id,task.title,task.agent,task.description,task.question,strings(task.files)?task.files.join(', '):'',strings(task.depends_on) && task.depends_on.length ? 'After '+task.depends_on.join(', ') : ''].filter(Boolean).map(plain).join(' · ')+'</li>').join('')+'</ol>'+(d.warnings || []).map(w=>'<p class="warning">'+plain(w)+'</p>').join('');
    }
    if(!content)return '';
    const open=d.risk?.level==='R3' || message.kind==='research' || message.kind==='skill' && d.state==='proposed';
    return '<details class="message-detail review-detail" '+(open?'open':'')+'><summary>Review details</summary><div>'+content+'</div></details>';
  }
  function keyFacts(message) {
    const d=message.detail || {};
    if(message.kind==='request' && d.kind==='permission'){const fact=d.review?.command || d.review?.file || d.patterns?.[0];return fact?'<p class="plain decision-facts">'+plain(fact)+'</p>':'';}
    if(message.kind==='proposal' && supportedProposal(d.proposal))return '<p>'+escape(proposalAgents(d.proposal).length+' agents · '+d.proposal.tasks.length+' tasks')+'</p><dl class="proposal-agents">'+proposalAgents(d.proposal).map(a=>'<dt>'+plain(a.name || a.id)+' · '+plain(a.role)+'</dt><dd class="plain">'+[a.responsibility || a.task,a.model,Array.isArray(a.skills)?a.skills.join(', '):a.skills].filter(Boolean).map(plain).join(' · ')+'</dd>').join('')+'</dl>';
    if(message.kind==='research')return '<p class="plain">'+plain(d.request?.question)+'</p>';
    if(message.kind==='skill')return '<p class="muted">'+(typeof d.risk==='string' ? 'Risk · '+plain(d.risk) : [d.risk?.level,d.risk?.label].filter(Boolean).map(plain).join(' · '))+'</p><p class="plain muted">'+plain(typeof d.source==='string' ? d.source : d.source?.url || d.source?.folder)+'</p>';
    return '';
  }
  function questionMarkup(message) {
    return (message.detail.questions || []).map((q,i)=>'<fieldset class="decision-question" data-question="'+i+'"><legend>'+plain(q.header || q.question)+'</legend>'+(q.header ? '<p class="plain">'+plain(q.question)+'</p>' : '')+
      (q.options || []).map(o=>'<label><input type="'+(q.multiple?'checkbox':'radio')+'" name="q-'+escape(message.id)+'-'+i+'" value="'+plain(o.label)+'"> <span>'+plain(o.label)+(o.description ? '<small>'+plain(o.description)+'</small>' : '')+'</span></label>').join('')+
      (q.custom!==false ? '<label><input type="'+(q.multiple?'checkbox':'radio')+'" name="q-'+escape(message.id)+'-'+i+'" data-custom> Your answer</label><input class="custom-answer" aria-label="Your answer: '+plain(q.header || q.question)+'" maxlength="5000">' : '')+'</fieldset>').join('');
  }
  function mount(host, dialog) {
    const core=root.AC.core, cards=new Map();let snapshot=core.getState(), opened=null;
    const permissions=()=>snapshot.state?.permissions || {};
    const current=id=>snapshot.single?.messages[id] || snapshot.thread?.messages[id];
    function focusCard(record) {if(record?.node?.isConnected)record.node.focus?.({preventScroll:true});}
    function closeDialog(focus=true) {
      const record=opened && cards.get(opened.id);opened=null;
      if(dialog.close && dialog.hasAttribute('open'))dialog.close();else dialog.removeAttribute('open');
      dialog.querySelector('form')?.remove();if(focus)focusCard(record);
    }
    function render(record) {
      if(!record.node?.isConnected)return;
      const message=current(record.id) || record.message, status=record.status, busy=!!snapshot.writeOwner;
      record.statusNode.textContent=cardStatus(message,status);record.statusNode.hidden=!record.statusNode.textContent;
      const hidden=['sent','not-recorded','recovering'].includes(status.phase) || status.phase==='checking' && status.network;
      record.controls.hidden=hidden || inFlightReceipt(message);
      for(const button of record.controls.querySelectorAll('[data-decision]')) {
        const choice=controlsFor(message,permissions()).find(c=>c.choice===button.dataset.decision);
        button.disabled=busy || ['sending','checking'].includes(status.phase) || !choice || choice.disabled;
      }
      record.refresh.hidden=status.phase!=='not-recorded';record.refresh.disabled=busy;
      if(opened?.id===record.id)dialog.querySelector('[data-confirm-decision]').disabled=busy || ['sending','checking'].includes(status.phase);
    }
    function attach(node,message) {
      let record=cards.get(message.id);
      if(!record && !message.action)return;
      if(!record) {record={id:message.id,rev:message.rev,status:{phase:'idle'},statusNode:document.createElement('p'),refresh:document.createElement('button')};record.statusNode.className='decision-status';record.statusNode.setAttribute('role','status');record.refresh.textContent='Refresh';record.refresh.dataset.refreshDecision=message.id;record.refresh.setAttribute('aria-label','Refresh decision: '+message.text);cards.set(message.id,record);}
      record.node=node;record.message=message;node.tabIndex=-1;
      let container=node.querySelector('.decision-host');
      if(!container) {container=document.createElement('div');container.className='decision-host';node.querySelector('.message').insertBefore(container,node.querySelector('.waiting-line'));}
      if(message.action && allowedEndpoint(message))container.setAttribute('data-actionable','');else container.removeAttribute('data-actionable');
      if(record.container!==container || record.builtRev!==message.rev) {
        record.container=container;record.builtRev=message.rev;
        const catalogue=controlsFor(message,permissions()), d=message.detail || {};
        container.innerHTML=message.action && allowedEndpoint(message) ? keyFacts(message)+reviewMarkup(message) : '';
        if(record.reviewOpen!==undefined && container.querySelector('.review-detail'))container.querySelector('.review-detail').open=record.reviewOpen;
        record.reviewOpen=undefined;
        const controls=document.createElement('div');controls.className='decision-controls';
        if(catalogue.length) {
          if(message.kind==='request' && d.kind==='question' && supportedQuestions(d.questions))controls.innerHTML=questionMarkup(message);
          if(message.kind==='request' && d.kind==='permission' && d.risk?.remember_allowed)controls.innerHTML+='<label class="decision-remember"><input type="checkbox" data-remember> Also allow identical requests in this session</label>';
          controls.innerHTML+='<div class="decision-buttons">'+catalogue.map(c=>'<button type="button" data-decision="'+c.choice+'" class="'+(c.primary?'decision-primary':'')+'" aria-label="'+escape(c.label.replace(/…$/,'')+': '+message.text)+'">'+escape(c.label)+'</button>').join('')+'</div>';
          if(catalogue.some(c=>c.disabled))controls.innerHTML+='<p class="muted review-unavailable">'+(d.review_truncated?'Too large to review here':'Cannot review this approval here')+' · <a href="/classic">Open in classic</a></p>';
        }
        // D13: a waiting item this room cannot act on keeps its own classic fallback on the card.
        else if(message.action && !inFlightReceipt(message))controls.innerHTML='<p class="muted review-unavailable">'+(d.review_truncated?'Too large to review here':'Cannot review this approval here')+' · <a href="/classic">Open in classic</a></p>';
        record.controls=controls;container.append(controls,record.statusNode,record.refresh);
      }
      render(record);
    }
    function update(next) {
      snapshot=next;
      if(!next.authenticated) {closeDialog(false);for(const r of cards.values()){clearTimeout(r.timer);r.container?.remove();}cards.clear();return;}
      for(const record of cards.values()) {
        const message=current(record.id);
        if(!message) {if(opened?.id===record.id)closeDialog();clearTimeout(record.timer);continue;}
        if(message.rev!==record.rev) {
          record.reviewOpen=record.container?.querySelector('.review-detail')?.open;
          clearTimeout(record.timer);record.rev=message.rev;record.status={phase:'idle'};
          if(opened?.id===record.id) {closeDialog();record.status.error=message.action ? 'This decision changed. Review the updated item.' : 'This was decided elsewhere or is no longer waiting.';}
        }
        const status=record.status;
        if(next.readSerial> (status.lastRead ?? next.readSerial) && next.readIds.includes(record.id)) {
          status.lastRead=next.readSerial;
          if(status.phase==='sent' && ++status.cycles>=3) {clearTimeout(record.timer);status.phase='not-recorded';}
          if(status.phase==='checking') {if(status.network)record.status={phase:'idle'};else status.phase='idle';}
          if(status.phase==='recovering')record.status={phase:'idle'};
        }
        render(record);
      }
    }
    function inputsFrom(record) {
      const result={remember:!!record.controls.querySelector('[data-remember]')?.checked};
      if(record.message.detail?.kind==='question')result.answers=[...record.controls.querySelectorAll('[data-question]')].map(field=>[...field.querySelectorAll('input[type="radio"],input[type="checkbox"]')].filter(input=>input.checked).map(input=>input.hasAttribute('data-custom') ? field.querySelector('.custom-answer').value : input.value));
      return result;
    }
    async function send(record,choice,inputs={}) {
      const message=current(record.id), prior=record.status;
      if(!message || message.rev!==record.rev || snapshot.writeOwner || !['idle'].includes(prior.phase) || inFlightReceipt(message))return false;
      let body, endpoint;
      try {
        endpoint=allowedEndpoint(message,choice);
        body=endpoint==='/api/review' ? reviewBody(message,choice,inputs,permissions()) : endpoint==='/api/research/decide' ? researchBody(message,choice,inputs,permissions()) : endpoint==='/api/control' ? controlBody(message,choice,inputs) : skillBody(message,choice);
      } catch(error) {prior.error=error.message;render(record);if(opened)dialog.querySelector('.decision-dialog-error').textContent=error.message;return false;}
      const rev=message.rev;
      record.status={phase:'sending',lastRead:snapshot.readSerial,cycles:0};
      if(!core.beginWrite('decision')) {record.status=prior;render(record);return false;}
      update(core.getState());
      try {
        await core.post(endpoint,body);
        if(record.rev===rev) {
          record.status={phase:'sent',lastRead:core.getState().readSerial,cycles:0};
          record.timer=setTimeout(()=>{if(record.rev===rev && record.status.phase==='sent'){record.status.phase='not-recorded';render(record);}},15000);
        }
        if(opened?.id===record.id)closeDialog();focusCard(record);core.refreshNow(record.id);return true;
      } catch(error) {
        if(error.status===401 || !core.getState().authenticated){closeDialog(false);return false;}
        if(record.rev===rev) {
          const network=!error.status;
          record.status={phase:'checking',lastRead:core.getState().readSerial,network,error:network ? "Couldn't reach AgentControl. The decision may or may not have been recorded. Checking…" : error.message};
          if(opened?.id===record.id) {
            const confirm=dialog.querySelector('[name="confirm"]');if(confirm)confirm.value='';
            dialog.querySelector('.decision-dialog-error').textContent=record.status.error;
            if(network)closeDialog();
          }
        }
        core.dismissError();core.refreshNow(record.id);return false;
      } finally {core.endWrite('decision');update(core.getState());render(record);}
    }
    function open(record,choice,inputs={}) {
      const message=current(record.id), control=controlsFor(message,permissions()).find(c=>c.choice===choice);
      if(!control || control.disabled || snapshot.writeOwner || record.status.phase!=='idle')return false;
      if(!control.dialog){send(record,choice,{...inputsFrom(record),...inputs});return true;}
      closeDialog(false);opened={id:record.id,rev:record.rev,choice};
      const d=message.detail || {}, ws=d.workspace || {}, word=permissions().confirm_word;
      let title=control.label.replace(/…$/,'')+': '+message.text, content='', label=control.label.replace(/…$/,'');
      if(choice==='apply') {title='Apply '+ws.branch+'?';content='<p class="plain">'+escape('Merge '+ws.branch+' into '+ws.base_branch+'? '+ws.commits+' commits · '+ws.shortstat+'. This changes your branch.')+'</p>';label='Apply to '+ws.base_branch;}
      else if(choice==='discard_workspace') {title='Discard '+ws.branch+'?';content='<p class="plain">'+escape('Delete '+ws.branch+' and its worktrees? This cannot be undone.')+'</p>';label='Discard work';}
      else if(choice==='repropose')content='<label>Tell Hermes what to change<textarea name="text" maxlength="2000" required>'+escape(inputs.text || '')+'</textarea></label>';
      else if(choice==='reject')content='<label>Tell Hermes what to do instead (optional)<textarea name="redirect" maxlength="5000"></textarea></label>';
      else {
        content='<p class="plain">'+plain(message.kind==='research' ? d.request?.question : d.review?.command || d.review?.file || message.text)+'</p><label>Type '+escape(word)+' to '+(message.kind==='research'?'allow research':'approve')+'<input name="confirm" autocomplete="off" spellcheck="false" required></label>';
        if(d.risk?.remember_allowed)content+='<label class="decision-remember"><input type="checkbox" name="remember" '+(inputsFrom(record).remember?'checked':'')+'> Also allow identical requests in this session</label>';
      }
      dialog.innerHTML='<form><h2 id="decision-title">'+escape(title)+'</h2>'+content+'<p class="decision-dialog-error plain"></p><div class="decision-dialog-buttons"><button type="button" data-cancel-decision autofocus>Cancel</button><button type="submit" data-confirm-decision class="'+(['apply','discard_workspace'].includes(choice)?'decision-destructive':'decision-primary')+'" aria-label="'+escape(label+': '+message.text)+'">'+escape(label)+'</button></div></form>';
      if(dialog.showModal)dialog.showModal();else dialog.setAttribute('open','');dialog.querySelector('[data-cancel-decision]').focus();return true;
    }
    host.addEventListener('click',event=>{
      const refresh=event.target.closest('[data-refresh-decision]');
      if(refresh) {const record=cards.get(refresh.dataset.refreshDecision);if(record && !snapshot.writeOwner && record.status.phase==='not-recorded'){record.status={phase:'recovering',lastRead:snapshot.readSerial,error:'Not recorded yet. Checking…'};render(record);core.refreshNow(record.id);}return;}
      const button=event.target.closest('[data-decision]'), id=button?.closest('[data-message]')?.dataset.message, record=cards.get(id);
      if(record && !button.disabled)open(record,button.dataset.decision);
    });
    dialog.addEventListener('click',event=>{if(event.target.closest('[data-cancel-decision]'))closeDialog();});
    dialog.addEventListener('submit',event=>{
      event.preventDefault();if(!opened)return;const record=cards.get(opened.id);if(!record || current(opened.id)?.rev!==opened.rev)return;
      const inputs=inputsFrom(record);for(const name of ['confirm','redirect','text']) {const input=dialog.querySelector('[name="'+name+'"]');if(input)inputs[name]=input.value;}
      const remember=dialog.querySelector('[name="remember"]');if(remember)inputs.remember=remember.checked;
      send(record,opened.choice,inputs);
    });
    dialog.addEventListener('cancel',event=>{event.preventDefault();closeDialog();});
    document.addEventListener('keydown',event=>{if(!event.defaultPrevented && event.key==='Escape' && dialog.hasAttribute('open')) {event.preventDefault();closeDialog();}});
    function command(command, argument='') {
      const choice=({verify:'verify',apply:'apply',discard:'discard_workspace'})[command] || ({approve:'approve_team',single:'single_agent',repropose:'repropose'})[argument.split(/\s+/)[0]];
      const type=command==='team'?'proposal':'outcome', cache=snapshot.single || snapshot.thread;
      const message=cache?.ids.map(id=>cache.messages[id]).find(m=>m.kind===type && controlsFor(m,permissions()).some(c=>c.choice===choice));
      if(!message)return 'Nothing to '+(command==='team'?'decide for the team':command)+' here';
      const record=cards.get(message.id);if(!record || snapshot.writeOwner || record.status.phase!=='idle')return 'This decision is waiting for AgentControl. Refresh its card before sending again.';
      if(!open(record,choice,command==='team' && choice==='repropose' ? {text:argument.replace(/^repropose\s*/,'')} : {}))return 'Review this decision in the classic dashboard.';
      return '';
    }
    return {attach,update,command};
  }
  const decisions={controlsFor,reviewBody,controlBody,researchBody,skillBody,answersFrom,allowedEndpoint,cardStatus,mount};
  root.AC=root.AC || {};root.AC.decisions=decisions;
  if(typeof module!=='undefined' && module.exports)module.exports=decisions;
})(typeof window!=='undefined' ? window : globalThis);
