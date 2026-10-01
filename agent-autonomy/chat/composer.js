(function (root) {
  'use strict';
  const terminal = new Set(['completed','blocked','failed','stopped','limit_reached']);
  const limits = {goal:12000,title:120,note:5000,checks:20,check:1000,max_steps:20,run_minutes:120,command:2000,team_size:3};
  const decisionCommands = ['verify','apply','discard','team'];
  const commands = ['pause','resume','stop','check','title','help',...decisionCommands];
  const preferenceKeys = ['verifier','max_steps','run_minutes','mode','team_size','isolation','network','cpus','memory_gb','setup','preview'];
  const settingKeys = ['title','goal_checks',...preferenceKeys];
  function preferencesOnly(values) {
    const saved={};for(const key of preferenceKeys)if(values?.[key]!==undefined && !(key==='network' && values[key]==='internet'))saved[key]=values[key];return saved;
  }
  function composerState(snapshot, follow = null, agent = '') {
    const state = snapshot.state || {}, live = snapshot.thread?.live || {}, channel = snapshot.channels?.channels?.[0];
    const other = (state.runs || []).find(r=>!terminal.has(r.status) && r.project && r.project !== state.project);
    const id = live.session || channel?.active_session;
    const run = state.run?.id === id ? state.run : (state.runs || []).find(r=>r.id===id);
    const paused = !!id && (run?.pause || ['paused','interrupted'].includes(run?.status || live.status));
    const kind = id ? 'note' : follow ? 'follow-up' : 'new';
    const chip = kind==='note' ? 'Note → '+(agent ? '@'+agent : 'Hermes') : follow ? 'Follow-up · '+follow.title : 'New session';
    const reason = other ? 'A session is running in '+other.project+'. Finish it there first.' : !snapshot.state ? 'Connecting…' : kind!=='note' && state.health?.ready===false ? 'Connections are not ready' : '';
    return {kind,run:id || '',paused,chip,reason,placeholder:reason || (kind==='note' ? 'Message '+(agent ? '@'+agent : 'Hermes')+'…' : follow ? 'Reply in '+follow.title+'…' : 'Start a new session…')};
  }
  function parseSlash(text) {
    const match = text.trim().match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
    if (!match) return null;
    const command=match[1].toLowerCase(), argument=(match[2] || '').trim();
    const teamError=command==='team' && !/^(?:approve|single|repropose\s+\S[\s\S]*)$/.test(argument) ? 'Use /team approve, /team single or /team repropose <text>.' : '';
    return {command,text:argument,error:!commands.includes(command) ? 'Unknown command /'+command+'. Use /help.' : teamError || (['check','title'].includes(command) && !argument ? 'Add text after /'+command+'.' : !['check','title','team'].includes(command) && argument ? '/'+command+' does not take text.' : '')};
  }
  function parseMention(text, agents = []) {
    const names = new Set(agents.filter(a=>a.type!=='orchestrator' && a.role!=='orchestrator' && a.name!=='hermes').map(a=>a.name));
    const leading=text.match(/^@([\w-]+)(?:\s|$)/);
    return leading && names.has(leading[1]) ? {text:text.slice(leading[0].length),agent:leading[1]} : {text,agent:''};
  }
  function noteBody(run, text, agents) {
    const mention=parseMention(text,agents);
    return {run,action:'instruction',text:mention.text,...(mention.agent ? {agent:mention.agent} : {})};
  }
  // A verifier stored as argv must round-trip through the server's shlex parser.
  function followUpDefaults(run) {
    const quote=value=>/^[\w./:-]+$/.test(value) ? value : "'"+value.replace(/'/g,"'\\''")+"'";
    return {verifier:Array.isArray(run.verifier) ? run.verifier.map(quote).join(' ') : run.verifier || '',max_steps:run.max_steps ?? 8,mode:run.mode || 'single'};
  }
  function runBody(goal, settings = {}, parent = '') {
    const body={goal};
    for(const key of settingKeys)if(settings[key]!==undefined)body[key]=settings[key];
    if(body.network==='internet')throw Error('Internet during work must be set in the classic dashboard.');
    if(body.isolation!=='container' && body.isolation!=='vm')for(const key of ['network','cpus','memory_gb'])delete body[key];
    if(body.mode!=='team' && body.mode!=='auto')delete body.team_size;
    if(body.preview?.mode==='none')delete body.preview;
    if(settings.allow_dirty===true)body.allow_dirty=true;
    if(parent)body.parent_run=parent;
    return body;
  }
  function mount(host, controls) {
    const {core,model:m}=root.AC, e=m.esc, $=id=>document.getElementById(id);
    const input=$('composer'), status=$('composer-status'), sheet=$('settings-sheet');
    let snapshot={}, follow=null, preferences={}, sessionSettings={}, busy=false, selected=0, popover='', choices=[], preflight=null, sandbox=null, details=null, detailsSource=null, detailsTask=null, settingsGeneration=0, previewTimer=null, statusTimer=null, visiblePreviewKey='', previewTask=null;
    const stored=core.read('localStorage','acx-settings');
    try {preferences=preferencesOnly(JSON.parse(stored || '{}'));}catch{}
    if(stored)core.write('localStorage','acx-settings',JSON.stringify(preferences));
    const currentSettings=()=>({...preferences,...follow?.settings,...sessionSettings});
    function setSetting(key,value) {
      if(['title','goal_checks'].includes(key)){sessionSettings[key]=value;return;}
      if(!preferenceKeys.includes(key))return;
      if(follow){follow.settings[key]=value;follow.changed.add(key);}
      else if(value===undefined)delete preferences[key];else preferences[key]=value;
    }
    function clearSession() {sessionSettings={};$('allow-dirty').checked=false;visiblePreviewKey='';}
    function cancelFollowUp() {follow=null;clearSession();closeSettings();render(snapshot);}
    input.value=core.read('sessionStorage','acx-draft') || '';
    const agents=()=>((snapshot.state?.run?.id===view().run ? snapshot.state.agents : details?.run?.id===view().run ? details.agents : snapshot.agentsByRun?.[view().run]) || []).filter(a=>a.name!=='hermes' && a.type!=='orchestrator' && a.role!=='orchestrator');
    const view=()=>{const id=snapshot.thread?.live?.session || snapshot.channels?.channels?.[0]?.active_session;return composerState(id && details?.run?.id===id && snapshot.state?.run?.id!==id ? {...snapshot,state:{...snapshot.state,run:details.run}} : snapshot,follow);};
    function tell(value, classic=false, decisionCommand=false) {clearTimeout(statusTimer);status.textContent=value;status.hidden=!value;status.classList.toggle('decision-command-status',decisionCommand && !!value);$('composer-classic').hidden=!classic;}
    function resize() {
      if(!input.value){input.style.height='40px';return;}
      input.style.height='auto';
      const line=Number.parseFloat(root.getComputedStyle?.(input).lineHeight) || 22.5;
      input.style.height=Math.min(Math.max(40,input.scrollHeight || 40),6*line+16,(root.visualViewport?.height || root.innerHeight || 844)*0.4)+'px';
    }
    function closePopover() {popover='';choices=[];$('composer-options').hidden=true;input.removeAttribute('aria-activedescendant');input.setAttribute('aria-expanded','false');}
    function showChoices(kind, values) {
      if(!values.length){closePopover();return;}
      popover=kind;choices=values;selected=0;const list=$('composer-options');
      list.innerHTML=values.map((value,i)=>`<button type="button" role="option" id="composer-option-${i}" data-choice="${i}" aria-selected="${i===selected}">${e(kind==='mention' ? '@'+value : '/'+value)}</button>`).join('');
      list.hidden=!values.length;input.setAttribute('aria-expanded',String(!!values.length));if(values.length)input.setAttribute('aria-activedescendant','composer-option-0');
    }
    function choose(index) {
      const name=choices[index];if(!name)return;
      if(popover==='mention')input.value=input.value.replace(/^@[\w-]*/,'@'+name+' ');
      else input.value='/'+name+(['check','title'].includes(name)?' ':'');
      closePopover();draftChanged(false);input.focus();
    }
    function draftChanged(suggest=true) {
      core.write('sessionStorage','acx-draft',input.value || null);resize();render(snapshot);
      if(suggest){const token=input.value.match(/^@([\w-]*)$/);if(view().kind==='note' && token)showChoices('mention',agents().map(a=>a.name).filter(name=>name.startsWith(token[1])));
        else if(/^\/[\w]*$/.test(input.value))showChoices('slash',commands.filter(name=>name.startsWith(input.value.slice(1))));else closePopover();}
      if(currentSettings().mode==='auto')schedulePreview();
    }
    function render(next) {
      snapshot=next;
      if(view().run && follow){follow=null;clearSession();closeSettings();}
      const v=view(), mention=v.kind==='note' ? parseMention(input.value,agents()) : {agent:''};
      $('composer-target').textContent=v.kind==='note' ? 'Note → '+(mention.agent ? '@'+mention.agent : 'Hermes') : v.chip;$('composer-target').title=$('composer-target').textContent;$('composer-target').dataset.kind=v.kind;
      input.placeholder=composerState(snapshot,follow,mention.agent).placeholder;input.disabled=!!v.reason;
      input.maxLength=v.kind==='note'?limits.note:limits.goal;
      $('send-message').disabled=busy || !!previewTask || !!core.getState().writeOwner || !!v.reason || !input.value.trim();
      $('composer-settings').hidden=v.kind==='note' || !!v.reason && v.reason!=='Connections are not ready';
      $('cancel-follow-up').hidden=!follow;$('resume-session').hidden=!v.paused || !!v.reason;$('resume-session').disabled=busy || !!core.getState().writeOwner;
      $('composer-blocked').textContent=v.reason;$('composer-blocked').hidden=!v.reason;$('check-connections').hidden=v.reason!=='Connections are not ready';$('check-connections').disabled=busy || !!core.getState().writeOwner;
      if(v.run && snapshot.state?.run?.id!==v.run && detailsSource!==snapshot.state && !detailsTask){
        detailsSource=snapshot.state;const id=v.run;
        detailsTask=core.api('/api/state?scope=current&run='+encodeURIComponent(id)).then(data=>{if(view().run===id){details=data;render(snapshot);controls.stateChanged?.();}}).catch(()=>{}).finally(()=>{detailsTask=null;if(detailsSource!==snapshot.state)render(snapshot);});
      }
      if(!next.authenticated)closeSettings();
      resize();controls.busy?.(busy || !!previewTask || !!core.getState().writeOwner);
    }
    async function request(path,body,clear=false,submittedDraft=input.value) {
      if(busy || previewTask || core.getState().writeOwner && core.getState().writeOwner!=='composer')return false;
      busy=true;if(!core.getState().writeOwner && !core.beginWrite('composer')){busy=false;return false;}
      tell('Sending…');controls.error?.('');render(snapshot);closePopover();
      try {
        await core.post(path,body);
        if(clear && input.value===submittedDraft){input.value='';core.write('sessionStorage','acx-draft',null);}
        tell('Sent · it will appear in the room');statusTimer=setTimeout(()=>{status.textContent='';status.hidden=true;},3000);
        controls.bottom();core.refreshNow();return true;
      }catch(error){tell(error.message);controls.error?.(error.message);return false;}
      finally{busy=false;core.endWrite('composer');render(core.getState());input.focus?.({preventScroll:true});}
    }
    async function control(action, clear=false, run=view().run) {
      if(view().reason){tell(view().reason);return false;}
      if(!run){tell('There is no active session.');return false;}
      return request('/api/control',{run,action},clear);
    }
    async function ensurePreflight(force=false) {
      const project=snapshot.state?.project;
      if(force || preflight?.project!==project){const data=await core.api('/api/workspace/preflight');preflight={...data,project};}
      return preflight;
    }
    async function submit() {
      if(busy || previewTask || core.getState().writeOwner)return;
      const v=view(), draft=input.value, text=draft.trim();if(!text)return;
      const slash=parseSlash(text);
      if(slash){
        if(slash.error){tell(slash.error,false,decisionCommands.includes(slash.command));return;}
        if(slash.command==='help'){tell('');showChoices('slash',commands);return;}
        if(decisionCommands.includes(slash.command)){tell(controls.decision(slash.command,slash.text),false,true);closePopover();return;}
        const run=slash.command==='title' ? v.run || snapshot.focused : v.run;
        if(!run || v.reason && v.reason!=='Connections are not ready'){tell(v.reason || 'There is no active session.');return;}
        if(slash.command==='stop'){controls.stop({id:run,title:activeTitle()},true);return;}
        if(['pause','resume'].includes(slash.command)){await control(slash.command,true,run);return;}
        await request('/api/control',{run,action:slash.command==='check'?'goal_check':'title',text:slash.text},true);return;
      }
      if(v.reason){tell(v.reason);return;}
      if(v.kind==='note'){await request('/api/control',noteBody(v.run,draft,agents()),true,draft);return;}
      // Preparation shares the submission lock so repeated Enter cannot start a second session.
      busy=true;if(!core.beginWrite('composer')){busy=false;return;}render(snapshot);
      try {
        await ensurePreflight(true);
        if(preflight.dirty_count>0 && !$('allow-dirty').checked){tell(preflight.dirty_count+' uncommitted changes. Open Settings and choose “Start anyway with uncommitted changes”.');await openSettings();$('settings-advanced').open=true;return;}
        if(currentSettings().mode==='auto'){if(visiblePreviewKey!==previewKey()){await openSettings();tell('Auto preview is in Settings. Close Settings when ready to send.');return;}await modePreview();if($('mode-preview').dataset.failed==='true')return;}
        const settings=currentSettings(), changed=follow ? [...follow.changed].map(key=>[key,settings[key]]) : [];
        const body=runBody(text,{...settings,...(preflight.dirty_count>0 && $('allow-dirty').checked?{allow_dirty:true}:{})},follow?.id);
        busy=false;
        if(await request('/api/runs',body,true,draft)){
          // Inherited parent defaults never become preferences unless explicitly edited.
          for(const [key,value] of changed)if(value===undefined)delete preferences[key];else preferences[key]=value;
          core.write('localStorage','acx-settings',JSON.stringify(preferencesOnly(preferences)));follow=null;clearSession();closeSettings();render(snapshot);
        }
      }catch(error){tell(error.message);}finally{busy=false;core.endWrite('composer');render(core.getState());}
    }
    function activeTitle() {const id=view().run;return snapshot.thread?.sessions[id]?.title || snapshot.state?.runs?.find(r=>r.id===id)?.title || id;}
    async function reply(id) {
      if(busy)return;if(view().run || view().reason && view().reason!=='Connections are not ready'){tell('Finish the active session before starting a follow-up.');return;}
      try {
        const project=snapshot.state?.project, data=await core.api('/api/state?scope=current&run='+encodeURIComponent(id)), run=data.run;
        if(snapshot.state?.project!==project)return;
        if(!run || !terminal.has(run.status) || run.project && run.project!==project)throw Error('That session is not a finished session in this project.');
        if(view().run)throw Error('Finish the active session before starting a follow-up.');
        clearSession();follow={id,title:run.title || run.goal?.split('\n')[0] || id,settings:followUpDefaults(run),changed:new Set()};closeSettings();tell('');render(snapshot);input.focus();
      }catch(error){tell(error.message);}
    }
    const defaults={title:'',verifier:'',max_steps:8,run_minutes:30,mode:'single',team_size:3,isolation:'host',network:'setup',cpus:4,memory_gb:8,setup:''};
    function field(key,label,type='text',max) {return `<label>${e(label)}<input data-setting="${key}" id="setting-${key}" type="${type}" value="${e(currentSettings()[key] ?? defaults[key])}" ${max ? `maxlength="${max}"` : ''} ${type==='number'?`min="${key==='cpus'?0.5:key==='team_size'?2:1}" step="${key==='cpus'?0.5:1}" max="${key==='memory_gb'?128:key==='cpus'?32:key==='team_size'?3:key==='max_steps'?20:120}"`:''}></label>`;}
    function select(key,label,values) {return `<label>${label}<select id="setting-${key}" data-setting="${key}">${values.map(value=>`<option value="${value}" ${(currentSettings()[key] ?? defaults[key])===value?'selected':''}>${value[0].toUpperCase()+value.slice(1)}</option>`).join('')}</select></label>`;}
    function fillSheet() {
      const acknowledgement=$('dirty-acknowledgement');acknowledgement.remove();
      sheet.querySelector('#settings-fields').innerHTML=`<section aria-labelledby="settings-basic"><h3 id="settings-basic">Basic</h3>${field('title','Title (optional)','text',limits.title)}${field('verifier','Verification command','text',limits.command)}<fieldset><legend>Goal checks</legend><div id="goal-checks"></div><button type="button" id="add-goal-check">Add goal check</button></fieldset>${select('mode','Mode',['single','team','auto'])}<div id="team-size-field">${field('team_size','Largest team','number')}</div><p id="mode-preview" class="muted" role="status" hidden></p></section><details id="settings-advanced"><summary>Advanced</summary>${field('max_steps','Turn limit','number')}${field('run_minutes','Time limit (minutes)','number')}<fieldset><legend>Isolation</legend><div id="isolation-options"></div></fieldset><div id="isolated-fields">${select('network','Network',['setup','none'])}${field('cpus','CPUs','number')}${field('memory_gb','Memory (GB)','number')}<p>For internet during work, use the <a href="/classic">classic dashboard</a>.</p></div>${field('setup','Setup command','text',limits.command)}<fieldset><legend>Preview</legend><label>Mode<select id="preview-mode"><option value="none">None</option>${(snapshot.state?.capabilities?.preview_modes || []).map(mode=>`<option value="${e(mode)}">${e(mode)}</option>`).join('')}</select></label><div id="preview-fields"></div></fieldset><div id="dirty-folder"></div></details><p>Paid models and the stuck watch: set them in the <a href="/classic">classic dashboard</a></p>`;
      $('settings-advanced').appendChild(acknowledgement);
      $('preview-mode').value=currentSettings().preview?.mode || 'none';renderChecks();renderIsolation();renderPreviewFields();updateSettingsVisibility();
    }
    function renderChecks() {$('goal-checks').innerHTML=(currentSettings().goal_checks || []).map((text,i)=>`<div class="check-row"><input aria-label="Goal check ${i+1}" maxlength="1000" data-check="${i}" value="${e(text)}"><button type="button" data-remove-check="${i}" aria-label="Remove goal check ${i+1}">×</button></div>`).join('');$('add-goal-check').disabled=(currentSettings().goal_checks || []).length>=limits.checks;}
    function renderIsolation() {
      const reason=value=>value==='host' ? '' : (value==='container'?sandbox:snapshot.state?.vm_env)?.unavailable || (!(value==='container'?sandbox:snapshot.state?.vm_env) ? 'Checking availability…' : !preflight?.usable ? preflight?.reason || 'Needs a git project with a first commit.' : !(value==='container'?sandbox:snapshot.state?.vm_env)?.models_configured ? 'Configure the model server in the classic dashboard first.' : '');
      $('isolation-options').innerHTML=['host','container','vm'].map(value=>{const why=reason(value);return `<div class="isolation-choice ${why?'muted':''}"><label><input type="radio" name="composer-isolation" value="${value}" ${value===(currentSettings().isolation || 'host')?'checked':''} ${why?'disabled':''}> ${value==='vm'?'VM':value[0].toUpperCase()+value.slice(1)}</label>${why?`<details><summary>why?</summary><p>${e(why)}</p></details>`:''}</div>`;}).join('');
      $('dirty-folder').innerHTML=preflight?.dirty_count>0 ? `<p>${e(preflight.dirty_count)} uncommitted changes</p>` : '';
      // The acknowledgement itself is stable and never remembered between sessions.
      $('dirty-acknowledgement').hidden=!(preflight?.dirty_count>0);
    }
    function updateSettingsVisibility() {if(!sheet.hidden){$('team-size-field').hidden=currentSettings().mode!=='team';$('mode-preview').hidden=currentSettings().mode!=='auto';$('isolated-fields').hidden=!['container','vm'].includes(currentSettings().isolation);}}
    function renderPreviewFields() {
      const mode=$('preview-mode').value, spec=currentSettings().preview || {};
      const previewInput=(key,label,fallback='',type='text')=>`<label>${label}<input id="preview-${key}" data-preview="${key}" type="${type}" value="${e(spec[key] ?? fallback)}"></label>`;
      $('preview-fields').innerHTML=mode==='none' ? '' : (mode==='static'?previewInput('path','Path','.'):previewInput('command','Command'))+(mode==='web'?previewInput('port','Port',0,'number'):mode==='cli'?previewInput('args','Arguments'):mode==='desktop'?previewInput('width','Width',1280,'number')+previewInput('height','Height',800,'number'):'');
    }
    // Copied from classic app.js readPreviewSpec(): the existing preview request shape.
    function previewSpec() {
      const mode=$('preview-mode').value;if(mode==='none')return {mode};
      const spec={mode};if(mode!=='static')spec.command=$('preview-command').value.trim();
      if(mode==='cli' && $('preview-args').value.trim())spec.args=$('preview-args').value.trim();
      if(mode==='web')spec.port=Number($('preview-port').value) || 0;
      if(mode==='static')spec.path=$('preview-path').value.trim() || '.';
      if(mode==='desktop'){spec.width=Number($('preview-width').value) || 1280;spec.height=Number($('preview-height').value) || 800;}return spec;
    }
    const previewKey=()=>JSON.stringify({goal:input.value,goal_checks:currentSettings().goal_checks || [],verifier:currentSettings().verifier || '',max_steps:currentSettings().max_steps ?? 8});
    function modePreview() {
      if(previewTask)return previewTask;
      const key=previewKey(), task=performModePreview();previewTask=task;render(snapshot);
      return task.finally(()=>{if(previewTask===task){previewTask=null;render(snapshot);if(currentSettings().mode==='auto' && key!==previewKey())schedulePreview();}});
    }
    async function performModePreview() {
      const node=$('mode-preview');if(!node || currentSettings().mode!=='auto')return;
      node.hidden=false;if(!input.value.trim()){node.textContent='Write a goal to see what Auto would choose.';return;}
      if(core.getState().writeOwner && core.getState().writeOwner!=='composer')return;
      const ownsLock=!core.getState().writeOwner;
      if(ownsLock && !core.beginWrite('composer'))return;
      const goal=input.value, generation=settingsGeneration, key=previewKey();
      try {
        const data=await core.post('/api/mode/preview',{goal,goal_checks:currentSettings().goal_checks || [],verifier:currentSettings().verifier || '',max_steps:currentSettings().max_steps ?? 8});
        if(generation!==settingsGeneration || currentSettings().mode!=='auto' || key!==previewKey())return;
        node.textContent='Auto would '+(data.mode==='team'?'ask Hermes for a team plan':'use one agent')+'. '+(data.reasons || []).join(' ');node.dataset.failed='false';if(!sheet.hidden)visiblePreviewKey=previewKey();
      }catch(error){if(generation!==settingsGeneration || key!==previewKey())return;node.textContent=error.message;node.dataset.failed='true';tell(error.message);}
      finally{if(ownsLock)core.endWrite('composer');}
    }
    function schedulePreview() {clearTimeout(previewTimer);previewTimer=setTimeout(()=>{if(!busy)modePreview();},400);}
    async function openSettings() {
      if(view().kind==='note')return;
      const generation=++settingsGeneration;sheet.hidden=false;$('settings-scrim').hidden=false;fillSheet();$('close-settings').focus();
      try {const [p,s]=await Promise.all([ensurePreflight(),core.api('/api/sandbox')]);if(generation!==settingsGeneration || sheet.hidden)return;sandbox=s;preflight=p;renderIsolation();updateSettingsVisibility();if(currentSettings().mode==='auto')await modePreview();}catch(error){tell(error.message);}
    }
    function closeSettings() {settingsGeneration++;sheet.hidden=true;$('settings-scrim').hidden=true;clearTimeout(previewTimer);}
    input.addEventListener('input',()=>draftChanged());
    input.addEventListener('keydown',event=>{
      if(event.isComposing)return;
      if(popover && !event.ctrlKey && !event.metaKey && !event.shiftKey){
        if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();selected=(selected+(event.key==='ArrowDown'?1:-1)+choices.length)%choices.length;for(const [i,node] of [...$('composer-options').children].entries())node.setAttribute('aria-selected',String(i===selected));input.setAttribute('aria-activedescendant','composer-option-'+selected);return;}
        if(event.key==='Enter'){event.preventDefault();choose(selected);return;}
        if(event.key==='Escape'){event.preventDefault();closePopover();return;}
      }
      if(event.key==='Escape' && follow){event.preventDefault();cancelFollowUp();return;}
      if(event.key==='Enter' && !event.shiftKey && (event.ctrlKey || event.metaKey || !root.matchMedia?.('(pointer: coarse)').matches)){event.preventDefault();submit();}
    });
    host.addEventListener('click',event=>{const choice=event.target.closest('[data-choice]');if(choice){choose(Number(choice.dataset.choice));return;}const id=event.target.closest('button')?.id;if(id==='send-message')submit();if(id==='composer-settings')openSettings();if(id==='cancel-follow-up'){cancelFollowUp();input.focus();}if(id==='resume-session')control('resume');if(id==='check-connections')request('/api/check',{});});
    sheet.addEventListener('input',event=>{
      const node=event.target,key=node.dataset.setting;
      if(key){setSetting(key,node.type==='number'?Number(node.value):node.value);if(key==='mode' && currentSettings().mode==='auto')schedulePreview();updateSettingsVisibility();}
      if(node.dataset.check!==undefined){const checks=[...currentSettings().goal_checks];checks[Number(node.dataset.check)]=node.value;setSetting('goal_checks',checks);}
      if(node.dataset.preview)setSetting('preview',previewSpec());
    });
    sheet.addEventListener('change',event=>{
      const node=event.target;if(node.dataset.setting){setSetting(node.dataset.setting,node.type==='number'?Number(node.value):node.value);updateSettingsVisibility();if(node.dataset.setting==='mode' && currentSettings().mode==='auto')modePreview();}
      if(node.name==='composer-isolation'){setSetting('isolation',node.value);updateSettingsVisibility();}
      if(node.id==='preview-mode'){setSetting('preview',node.value==='none'?undefined:{mode:node.value});renderPreviewFields();if(node.value!=='none')setSetting('preview',previewSpec());}
    });
    sheet.addEventListener('click',event=>{const node=event.target.closest('button');if(node?.id==='close-settings'){closeSettings();input.focus();}if(node?.id==='add-goal-check' && (currentSettings().goal_checks || []).length<limits.checks){setSetting('goal_checks',[...(currentSettings().goal_checks || []),'']);renderChecks();$('goal-checks').lastElementChild?.querySelector('input').focus();}if(node?.dataset.removeCheck!==undefined){setSetting('goal_checks',currentSettings().goal_checks.filter((_,i)=>i!==Number(node.dataset.removeCheck)));renderChecks();}});
    $('settings-scrim').addEventListener('click',()=>{closeSettings();input.focus();});
    sheet.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();closeSettings();input.focus();}if(event.key==='Tab'){const nodes=[...sheet.querySelectorAll('button,input,select,summary,a')].filter(n=>!n.disabled && !n.closest('[hidden]') && (!n.closest('#settings-advanced') || $('settings-advanced').open || n.tagName==='SUMMARY'));const i=nodes.indexOf(document.activeElement);if(event.shiftKey && i===0 || !event.shiftKey && i===nodes.length-1){event.preventDefault();nodes[event.shiftKey?nodes.length-1:0]?.focus();}}});
    if(root.visualViewport){const viewport=()=>{document.documentElement.style.setProperty('--viewport-height',root.visualViewport.height+'px');resize();};root.visualViewport.addEventListener('resize',viewport);root.visualViewport.addEventListener('scroll',viewport);viewport();}
    return {render,submit,control,reply,openSettings,closeSettings,activeTitle,getView:view,getBusy:()=>busy || !!previewTask || !!core.getState().writeOwner};
  }
  const composer={composerState,parseSlash,parseMention,runBody,noteBody,followUpDefaults,limits,mount};root.AC=root.AC || {};root.AC.composer=composer;
  if(typeof module!=='undefined' && module.exports)module.exports=composer;
})(typeof window!=='undefined' ? window : globalThis);
