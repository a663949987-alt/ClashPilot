const api = window.clashPilot;
const state = { settings: {}, rules: [], traffic: null, filter: 'all', restoreId: null, monitorTimer: null, bypassStreak: 0, lastAlertKey: '' };
const $ = (id) => document.getElementById(id);

function toast(message, error = false) {
  const el = document.createElement('div'); el.className = `toast${error ? ' error' : ''}`; el.textContent = message;
  $('toastHost').appendChild(el); setTimeout(() => el.remove(), 3600);
}
function readableError(error) { return error?.message?.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') || String(error); }
function formatTime(iso) { return new Intl.DateTimeFormat('zh-CN', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }).format(new Date(iso)); }
function shortProcess(name) { return (name || '?').replace(/\.exe$/i, '').slice(0, 1).toUpperCase(); }

function go(page) {
  document.querySelectorAll('.nav-item').forEach(x => x.classList.toggle('active', x.dataset.page === page));
  document.querySelectorAll('.page').forEach(x => x.classList.toggle('active', x.id === `page-${page}`));
  if (page === 'backups') loadBackups();
  if (page === 'monitor') refreshTraffic();
}

async function init() {
  state.settings = await api.getSettings();
  $('configPath').value = state.settings.configPath || '';
  $('executablePath').value = state.settings.executablePath || '';
  $('startupPathHint').textContent = state.settings.executablePath ? state.settings.executablePath.split(/[\\/]/).pop() : '尚未选择程序位置';
  $('controller').value = state.settings.controller || '127.0.0.1:9090';
  $('secret').value = state.settings.secret || '';
  $('policyName').value = state.settings.policy || 'PROXY';
  const mode=state.settings.enforcementMode || (state.settings.strictMode===false?'compatible':'strict');
  const modeInput=document.querySelector(`input[name="enforcementMode"][value="${mode}"]`); if(modeInput)modeInput.checked=true;
  updateModeUi();
  const startup = await api.getStartup(); setStartupUi(startup.enabled);
  if (state.settings.configPath) await loadConfig(state.settings.configPath, false);
  renderRules();
  await testController(false);
  startMonitor();
}

function setStartupUi(enabled) {
  $('startupToggle').checked = enabled; $('settingsStartupToggle').checked = enabled;
  $('startupText').textContent = enabled ? '已开启' : '已关闭';
}

async function loadConfig(configPath, notify = true) {
  try {
    const config = await api.loadConfig(configPath);
    state.settings.configPath = configPath; $('configPath').value = configPath;
    $('configSummary').innerHTML = `<b>${config.mode.toUpperCase()} 模式</b> · ${config.ruleCount} 条规则 · Controller ${config.controller}`;
    $('ruleHealth').textContent = `${config.ruleCount} 条规则，YAML 结构有效`; $('ruleCheck').textContent = '✓';
    const managedMap = new Map();
    config.processRules.filter(x => x).forEach(value => {
      const p=value.split(','); const kind=p.shift(); const policy=p.pop(); const target=p.join(',');
      const process=target.split(/[\\/]/).pop(); const key=process.toLowerCase();
      const existing=managedMap.get(key)||{process,policy,fullPath:''};
      if(kind==='PROCESS-PATH') existing.fullPath=target;
      managedMap.set(key,existing);
    });
    const managed=[...managedMap.values()]; if (managed.length) state.rules = managed;
    if (!state.settings.controller || state.settings.controller === '127.0.0.1:9090') { $('controller').value = config.controller; state.settings.controller = config.controller; }
    if (!state.settings.secret && config.secret) { $('secret').value = config.secret; state.settings.secret = config.secret; }
    await saveSettings(); renderRules(); updateHealth();
    if (notify) toast('配置已载入并通过 YAML 校验');
  } catch (e) { $('ruleHealth').textContent = '配置读取失败'; $('ruleCheck').textContent = '!'; toast(readableError(e), true); }
}

async function saveSettings() {
  state.settings = await api.saveSettings({
    configPath: $('configPath').value, executablePath: $('executablePath').value,
    controller: $('controller').value.trim(), secret: $('secret').value,
    policy: $('policyName').value.trim() || 'PROXY', fallback: 'DIRECT', enforcementMode:getEnforcementMode()
  });
}

function renderRules() {
  const host = $('ruleList'); $('managedCount').textContent = state.rules.length; $('statApps').textContent = state.rules.length;
  if (!state.rules.length) { host.innerHTML = '<div class="rule-empty"><div><b>还没有受管应用</b><p>点击“添加应用”，选择要走代理的 .exe 文件</p></div></div>'; return; }
  host.innerHTML = state.rules.map((r, i) => `<div class="rule-row"><div class="app-avatar">${shortProcess(r.process)}</div><div class="rule-name"><b>${escapeHtml(r.process)}</b><small>${escapeHtml(r.fullPath || '仅按进程名匹配')}</small></div><span class="rule-policy">${escapeHtml(r.policy || $('policyName').value)}</span><button class="remove-rule" data-remove="${i}" title="移除">×</button></div>`).join('');
}

function escapeHtml(value) { const d=document.createElement('div'); d.textContent=value; return d.innerHTML; }

async function addRule() {
  const file = await api.chooseExecutable(); if (!file) return;
  await addRulePath(file);
}

async function addRulePath(file) {
  let fullPath;
  try { fullPath=await api.resolveExecutable(String(file||'').trim().replace(/^"|"$/g,'')); }
  catch(e){ return toast(readableError(e),true); }
  const process = fullPath.split(/[\\/]/).pop();
  if (state.rules.some(x => x.process.toLowerCase() === process.toLowerCase())) return toast('这个进程已经在规则列表中');
  state.rules.push({ process, fullPath, policy: $('policyName').value.trim() || 'PROXY' }); renderRules();
  $('manualAppPath').value='';
}

async function applyRules() {
  if (!$('configPath').value) return go('settings');
  try {
    await saveSettings();
    const mode=getEnforcementMode();
    const result = await api.applyRules({ configPath:$('configPath').value, rules:state.rules, policy:$('policyName').value, fallback:'DIRECT', enforcementMode:mode });
    const labels={compatible:'兼容',strict:'严格',force:'强制'};
    toast(`已写入 ${result.count} 个应用 · ${labels[mode]}模式${result.firewall.enabled?' · 防火墙已闭锁':''}`); await loadConfig($('configPath').value, false);
  } catch (e) { toast(readableError(e), true); }
}

async function setStartup(enabled) {
  try { await saveSettings(); await api.setStartup({ enabled, executablePath:$('executablePath').value }); setStartupUi(enabled); toast(enabled ? 'Clash 已设为开机启动' : '已关闭 Clash 开机启动'); }
  catch (e) { setStartupUi(!enabled); toast(readableError(e), true); }
}

async function testController(notify = true) {
  await saveSettings();
  try {
    const result = await api.testController({ controller:$('controller').value.trim(), secret:$('secret').value });
    $('sideStatusDot').classList.add('online'); $('sideStatus').textContent = 'Controller 在线'; $('sideVersion').textContent = result.version;
    $('controllerCheck').textContent='✓'; $('controllerHealth').textContent=`已连接 · ${result.version}`;
    $('heroState').textContent='监控已就绪'; $('heroTitle').textContent='规则与连接都在掌控中'; $('heroDescription').textContent='正在核对 Clash 连接与 Windows 实际流量。';
    updateHealth(); if (notify) toast(`连接成功 · ${result.version}`); await refreshTraffic(); return true;
  } catch (e) {
    $('sideStatusDot').classList.remove('online'); $('sideStatus').textContent='Controller 离线'; $('sideVersion').textContent='检查地址、Secret 与外部控制';
    $('controllerCheck').textContent='!'; $('controllerHealth').textContent='无法连接 Controller'; updateHealth(); if (notify) toast(readableError(e), true); return false;
  }
}

function updateHealth() {
  let score=40; if ($('configPath').value) score+=30; if ($('sideStatusDot').classList.contains('online')) score+=30;
  $('healthScore').textContent=`${score}%`;
}

async function refreshTraffic() {
  if (!$('controller').value.trim()) return;
  try {
    const data = await api.getTraffic({ controller:$('controller').value.trim(), secret:$('secret').value, trackedProcesses:state.rules.map(x=>x.process) });
    state.traffic=data; renderTraffic();
    if(data.stats.bypass>0) state.bypassStreak+=1; else state.bypassStreak=0;
    if(state.bypassStreak>=2){
      const names=[...new Set(data.bypasses.map(x=>x.process))].join('、'); const key=names+data.stats.bypass;
      if(key!==state.lastAlertKey){state.lastAlertKey=key;await api.notify({title:'ClashPilot：发现疑似绕行',body:`${names} 有 ${data.stats.bypass} 条公网连接未出现在 Clash 中，请检查严格 TUN 模式。`});toast(`自动检查发现疑似绕行：${names}`,true)}
    }
    $('lastCheck').textContent=`刚刚 · ${new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}`;
  } catch (e) {
    if (document.querySelector('#page-monitor.active')) toast(readableError(e), true);
  }
}

function renderTraffic() {
  const d=state.traffic; if (!d) return;
  ['statProxy','mProxy'].forEach(id=>$(id).textContent=d.stats.proxied); ['statDirect','mDirect'].forEach(id=>$(id).textContent=d.stats.direct); ['statBypass','mBypass'].forEach(id=>$(id).textContent=d.stats.bypass); $('mTotal').textContent=d.stats.total;
  $('monitorTime').textContent=`采样于 ${new Date(d.timestamp).toLocaleTimeString('zh-CN')}`;
  $('monitorDot').style.display=d.stats.total?'block':'none';
  const recent=d.clashConnections.slice(0,4); $('recentConnections').classList.toggle('empty-state',!recent.length);
  $('recentConnections').innerHTML=recent.length?recent.map(c=>`<div class="conn-row"><div class="app-avatar">${shortProcess(c.process)}</div><div><b>${escapeHtml(c.process)}</b><small>${escapeHtml(c.host)} · ${escapeHtml(c.rule)} ${escapeHtml(c.rulePayload)}</small></div><span class="conn-chain">${escapeHtml(c.chains.join(' → ')||'—')}</span></div>`).join(''):'当前没有活动连接';
  const proxy=d.clashConnections.filter(c=>!c.chains.some(x=>String(x).toUpperCase()==='DIRECT')).map(c=>({...c,type:'proxy'}));
  const direct=d.clashConnections.filter(c=>c.chains.some(x=>String(x).toUpperCase()==='DIRECT')).map(c=>({...c,type:'direct'}));
  const bypass=d.bypasses.map(c=>({process:c.process,host:`${c.remoteAddress}:${c.remotePort}`,rule:'未出现在 Clash Controller',chains:[],type:'bypass'}));
  let rows=[...proxy,...direct,...bypass]; if(state.filter!=='all') rows=rows.filter(x=>x.type===state.filter);
  $('trafficTable').innerHTML=rows.length?rows.map(c=>`<tr><td><b>${escapeHtml(c.process)}</b></td><td>${escapeHtml(c.host)}</td><td>${escapeHtml(c.rule)} ${escapeHtml(c.rulePayload||'')}</td><td>${escapeHtml((c.chains||[]).join(' → ')||'—')}</td><td><span class="status-chip ${c.type==='direct'?'direct':c.type==='bypass'?'warn':''}">${c.type==='proxy'?'经代理':c.type==='direct'?'规则直连':'疑似绕行'}</span></td></tr>`).join(''):'<tr><td colspan="5" class="table-empty">此筛选下没有活动连接</td></tr>';
}

async function loadBackups() {
  try {
    const items=await api.listBackups(); const host=$('backupList');
    host.innerHTML=items.length?items.map(x=>`<div class="backup-row"><div class="backup-icon">↶</div><div><b>${formatTime(x.createdAt)} · ${escapeHtml(x.reason)}</b><small>${escapeHtml(x.source)} · ${(x.size/1024).toFixed(1)} KB · ${escapeHtml(x.hash)}</small></div><div class="backup-actions"><button data-restore="${escapeHtml(x.id)}">恢复</button><button class="danger" data-delete="${escapeHtml(x.id)}">删除</button></div></div>`).join(''):'<div class="empty-state">还没有备份。首次应用规则时会自动创建。</div>';
  } catch(e){toast(readableError(e),true)}
}

function startMonitor(){clearInterval(state.monitorTimer);state.monitorTimer=setInterval(refreshTraffic,5000)}

function getEnforcementMode(){return document.querySelector('input[name="enforcementMode"]:checked')?.value||'strict'}
function updateModeUi(){const mode=getEnforcementMode();const labels={compatible:'兼容模式',strict:'严格模式',force:'强制模式 · 需管理员权限'};$('modeAdminHint').textContent=labels[mode];$('forceWarning').classList.toggle('show',mode==='force')}

document.addEventListener('click', async e => {
  const nav=e.target.closest('[data-page]'); if(nav) go(nav.dataset.page);
  const goEl=e.target.closest('[data-go]'); if(goEl) go(goEl.dataset.go);
  if(e.target.closest('#addRule')) addRule();
  if(e.target.closest('#addPathRule')) await addRulePath($('manualAppPath').value);
  const remove=e.target.closest('[data-remove]'); if(remove){state.rules.splice(Number(remove.dataset.remove),1);renderRules()}
  if(e.target.closest('#applyRules')) applyRules();
  if(e.target.closest('#chooseConfig')){const f=await api.chooseConfig();if(f)await loadConfig(f)}
  if(e.target.closest('#chooseExecutable')){const f=await api.chooseExecutable();if(f){$('executablePath').value=f;$('startupPathHint').textContent=f.split(/[\\/]/).pop();await saveSettings();toast('Clash 客户端位置已保存')}}
  if(e.target.closest('#testController')) testController(true);
  if(e.target.closest('#refreshMonitor')||e.target.closest('#refreshAll')) refreshTraffic();
  if(e.target.closest('#refreshBackups')) loadBackups();
  const filter=e.target.closest('[data-filter]');if(filter){document.querySelectorAll('[data-filter]').forEach(x=>x.classList.remove('active'));filter.classList.add('active');state.filter=filter.dataset.filter;renderTraffic()}
  const restore=e.target.closest('[data-restore]');if(restore){state.restoreId=restore.dataset.restore;$('confirmModal').classList.remove('hidden')}
  const del=e.target.closest('[data-delete]');if(del){await api.deleteBackup(del.dataset.delete);toast('备份已删除');loadBackups()}
  const modal=e.target.closest('[data-modal]');if(modal){if(modal.dataset.modal==='confirm'&&state.restoreId){try{const r=await api.restoreBackup(state.restoreId);toast(`已恢复到 ${r.restoredTo}`);await loadConfig(r.restoredTo,false);loadBackups()}catch(err){toast(readableError(err),true)}}$('confirmModal').classList.add('hidden');state.restoreId=null}
});
$('startupToggle').addEventListener('change',e=>setStartup(e.target.checked));
$('settingsStartupToggle').addEventListener('change',e=>setStartup(e.target.checked));
$('policyName').addEventListener('change',()=>{state.rules.forEach(x=>x.policy=$('policyName').value.trim()||'PROXY');renderRules()});
document.querySelectorAll('input[name="enforcementMode"]').forEach(x=>x.addEventListener('change',()=>{updateModeUi();saveSettings()}));
$('controller').addEventListener('change',saveSettings);$('secret').addEventListener('change',saveSettings);
$('manualAppPath').addEventListener('keydown',e=>{if(e.key==='Enter')addRulePath(e.target.value)});
const dropZone=$('appDropZone');
['dragenter','dragover'].forEach(name=>dropZone.addEventListener(name,e=>{e.preventDefault();dropZone.classList.add('dragging')}));
['dragleave','drop'].forEach(name=>dropZone.addEventListener(name,e=>{e.preventDefault();dropZone.classList.remove('dragging')}));
dropZone.addEventListener('drop',e=>{for(const file of e.dataTransfer.files){const p=api.getPathForFile(file);if(/\.(exe|lnk)$/i.test(p))addRulePath(p)}});
window.addEventListener('DOMContentLoaded',()=>init().catch(e=>toast(readableError(e),true)));
