const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, Notification } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const YAML = require('yaml');

const APP_NAME = 'ClashPilot';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'ClashPilotManagedClash';
let mainWindow;

function dataDir() { return path.join(app.getPath('userData'), 'data'); }
function settingsFile() { return path.join(dataDir(), 'settings.json'); }
function backupsDir() { return path.join(dataDir(), 'backups'); }

async function ensureDirs() {
  await fs.mkdir(backupsDir(), { recursive: true });
}

async function readSettings() {
  await ensureDirs();
  try {
    return JSON.parse(await fs.readFile(settingsFile(), 'utf8'));
  } catch {
    return {
      configPath: '', executablePath: '', controller: '127.0.0.1:9090',
      secret: '', policy: 'PROXY', fallback: 'DIRECT', autoMonitor: true, enforcementMode: 'strict'
    };
  }
}

async function writeSettings(next) {
  await ensureDirs();
  const current = await readSettings();
  const merged = { ...current, ...next };
  await atomicWrite(settingsFile(), JSON.stringify(merged, null, 2));
  return merged;
}

async function atomicWrite(target, content) {
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, content, 'utf8');
  await fs.rename(temporary, target);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr })); else resolve(stdout);
    });
  });
}

async function runElevatedPowerShell(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const launcher = `$p=Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'); exit $p.ExitCode`;
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', launcher]);
}

function psQuote(value) { return `'${String(value).replace(/'/g, "''")}'`; }

async function setForcedFirewall(rules, enabled) {
  const group = 'ClashPilot Forced Mode';
  if (!enabled) {
    const existing = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-NetFirewallRule -Group ${psQuote(group)} -ErrorAction SilentlyContinue | Measure-Object).Count`]);
    if (Number(existing.trim()) === 0) return { enabled: false, count: 0 };
  }
  const lines = [
    "$ErrorActionPreference='Stop'",
    `Get-NetFirewallRule -Group ${psQuote(group)} -ErrorAction SilentlyContinue | Remove-NetFirewallRule`
  ];
  if (enabled) {
    const paths = [...new Set(rules.map(r => String(r.fullPath || '')).filter(Boolean))];
    if (paths.length !== rules.length) throw new Error('强制模式要求每个应用都有完整 .exe 路径，请重新拖入或选择程序');
    for (const program of paths) {
      if (!fsSync.existsSync(program)) throw new Error(`找不到程序：${program}`);
      const label = safeName(path.basename(program));
      for (const type of ['Wired', 'Wireless']) {
        lines.push(`New-NetFirewallRule -DisplayName ${psQuote(`ClashPilot Force - ${label} - ${type}`)} -Group ${psQuote(group)} -Direction Outbound -Program ${psQuote(program)} -InterfaceType ${type} -Action Block -Profile Any -Enabled True | Out-Null`);
      }
    }
  }
  await runElevatedPowerShell(lines.join('; '));
  if (enabled) {
    const output = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-NetFirewallRule -Group ${psQuote(group)} -ErrorAction SilentlyContinue | Measure-Object).Count`]);
    if (Number(output.trim()) < rules.length * 2) throw new Error('防火墙规则未完整创建，可能已取消管理员授权');
  }
  return { enabled, count: enabled ? rules.length * 2 : 0 };
}

function safeName(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}

function resolveExecutablePath(inputPath) {
  const candidate = String(inputPath || '').trim().replace(/^"|"$/g, '');
  if (!candidate) throw new Error('请输入程序或快捷方式路径');
  if (/\.exe$/i.test(candidate)) return candidate;
  if (/\.lnk$/i.test(candidate)) {
    const details = shell.readShortcutLink(candidate);
    if (details?.target && /\.exe$/i.test(details.target)) return details.target;
    throw new Error('这个快捷方式没有指向 .exe 程序');
  }
  throw new Error('仅支持 .exe 程序或 .lnk 快捷方式');
}

async function makeBackup(configPath, reason = '自动备份') {
  await ensureDirs();
  const content = await fs.readFile(configPath, 'utf8');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 10);
  const name = `${stamp}__${safeName(path.basename(configPath))}__${hash}.yaml`;
  const fullPath = path.join(backupsDir(), name);
  await fs.writeFile(fullPath, content, 'utf8');
  await fs.writeFile(`${fullPath}.json`, JSON.stringify({
    id: name, createdAt: new Date().toISOString(), source: configPath, reason, hash
  }, null, 2));
  return { id: name, fullPath, hash };
}

function parseConfig(text) {
  const doc = YAML.parseDocument(text, { keepSourceTokens: true, prettyErrors: true });
  if (doc.errors.length) throw new Error(doc.errors.map(e => e.message).join('\n'));
  return doc;
}

function readManagedRules(doc) {
  const rules = doc.get('rules');
  if (!rules || !Array.isArray(rules.items)) return [];
  return rules.items.map((item, index) => ({ value: String(item?.value ?? ''), index, managed: String(item?.comment || '').includes('ClashPilot') }))
    .filter(x => x.managed && /^(PROCESS-NAME|PROCESS-PATH),/.test(x.value));
}

async function applyManagedRules({ configPath, rules, policy, fallback, enforcementMode = 'strict' }) {
  if (!configPath) throw new Error('请先选择 Clash 配置文件');
  const original = await fs.readFile(configPath, 'utf8');
  const doc = parseConfig(original);
  const backup = await makeBackup(configPath, '应用进程规则前');

  let sequence = doc.get('rules', true);
  if (!sequence) {
    doc.set('rules', []);
    sequence = doc.get('rules', true);
  }
  if (!Array.isArray(sequence.items)) throw new Error('配置中的 rules 不是有效列表');

  // Only replace rules marked by this app. User-authored rules remain untouched.
  sequence.items = sequence.items.filter(item => !String(item?.comment || '').includes('ClashPilot'));

  const cleanRules = (rules || [])
    .map(r => ({
      process: path.basename(String(r.process || r.fullPath || '').trim()),
      fullPath: String(r.fullPath || '').trim(),
      policy: String(r.policy || policy || 'PROXY').trim()
    }))
    .filter(r => r.process && r.policy);

  const nodes = cleanRules.flatMap(rule => {
    const values = [];
    if (enforcementMode !== 'compatible' && rule.fullPath) values.push(`PROCESS-PATH,${rule.fullPath},${rule.policy}`);
    values.push(`PROCESS-NAME,${rule.process},${rule.policy}`);
    return values.map(value => {
      const node = doc.createNode(value);
      node.comment = ' ClashPilot';
      return node;
    });
  });
  sequence.items.unshift(...nodes);

  if (fallback === 'DIRECT') {
    sequence.items = sequence.items.filter(item => {
      const value = String(item?.value ?? '');
      return !(String(item?.comment || '').includes('ClashPilot') && /^(MATCH|FINAL),/.test(value));
    });
    const match = doc.createNode('MATCH,DIRECT');
    match.comment = ' ClashPilot';
    sequence.items.splice(nodes.length, 0, match);
  }

  if (enforcementMode !== 'compatible') {
    doc.set('find-process-mode', 'strict');
    let tun = doc.get('tun', true);
    if (!tun || typeof tun.set !== 'function') {
      doc.set('tun', {});
      tun = doc.get('tun', true);
    }
    tun.set('enable', true);
    tun.set('auto-route', true);
    tun.set('strict-route', true);
  }

  const rendered = String(doc);
  parseConfig(rendered);
  await atomicWrite(configPath, rendered);
  const firewall = await setForcedFirewall(cleanRules, enforcementMode === 'force');
  await writeSettings({ configPath, policy, fallback, enforcementMode });
  return { backupId: backup.id, count: cleanRules.length, rules: cleanRules, changed: rendered !== original, enforcementMode, firewall };
}

async function listBackups() {
  await ensureDirs();
  const entries = await fs.readdir(backupsDir());
  const result = [];
  for (const file of entries.filter(x => x.endsWith('.yaml'))) {
    try {
      const stat = await fs.stat(path.join(backupsDir(), file));
      let meta = {};
      try { meta = JSON.parse(await fs.readFile(path.join(backupsDir(), `${file}.json`), 'utf8')); } catch {}
      result.push({ id: file, size: stat.size, createdAt: meta.createdAt || stat.birthtime.toISOString(), source: meta.source || '', reason: meta.reason || '备份', hash: meta.hash || '' });
    } catch {}
  }
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function controllerFetch(controller, secret, endpoint) {
  const base = /^https?:\/\//i.test(controller) ? controller : `http://${controller}`;
  const headers = secret ? { Authorization: `Bearer ${secret}` } : {};
  const response = await fetch(`${base.replace(/\/$/, '')}${endpoint}`, { headers, signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error(`Controller 返回 HTTP ${response.status}`);
  return response.json();
}

async function getWindowsConnections() {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    '$rows = Get-NetTCPConnection -State Established | ForEach-Object {',
    ' $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue',
    ' if ($p) { [PSCustomObject]@{ process=($p.ProcessName + ".exe"); pid=$_.OwningProcess; localAddress=$_.LocalAddress; localPort=$_.LocalPort; remoteAddress=$_.RemoteAddress; remotePort=$_.RemotePort } }',
    '}',
    '$rows | ConvertTo-Json -Compress'
  ].join('; ');
  try {
    const stdout = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    const value = stdout.trim() ? JSON.parse(stdout) : [];
    return Array.isArray(value) ? value : [value];
  } catch { return []; }
}

function isLocalAddress(ip) {
  return !ip || ip === '127.0.0.1' || ip === '::1' || ip === '0.0.0.0' || ip.startsWith('10.') || ip.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || ip.startsWith('fe80:');
}

function normalizeProcess(value) { return path.basename(String(value || '')).toLowerCase(); }

async function monitorSnapshot({ controller, secret, trackedProcesses = [] }) {
  const [clashResult, windowsConnections] = await Promise.allSettled([
    controllerFetch(controller, secret, '/connections'), getWindowsConnections()
  ]);
  if (clashResult.status === 'rejected') throw new Error(`无法读取 Clash 连接：${clashResult.reason.message}`);
  const raw = clashResult.value?.connections || [];
  const clashConnections = raw.map(c => ({
    id: c.id,
    process: path.basename(c.metadata?.processPath || c.metadata?.process || c.metadata?.processName || '未知进程'),
    host: c.metadata?.host || c.metadata?.destinationIP || '—',
    destinationIP: c.metadata?.destinationIP || '', destinationPort: Number(c.metadata?.destinationPort || 0),
    sourceIP: c.metadata?.sourceIP || '', sourcePort: Number(c.metadata?.sourcePort || 0),
    rule: c.rule || '—', rulePayload: c.rulePayload || '', chains: c.chains || [],
    upload: c.upload || 0, download: c.download || 0, start: c.start || ''
  }));
  const tracked = new Set(trackedProcesses.map(normalizeProcess));
  const win = windowsConnections.status === 'fulfilled' ? windowsConnections.value : [];
  const bypasses = win.filter(c => tracked.has(normalizeProcess(c.process)) && !isLocalAddress(c.remoteAddress)).filter(c => {
    return !clashConnections.some(x => normalizeProcess(x.process) === normalizeProcess(c.process) && (
      (x.destinationIP === c.remoteAddress && x.destinationPort === Number(c.remotePort)) ||
      (x.sourcePort && x.sourcePort === Number(c.localPort))
    ));
  });
  return {
    timestamp: new Date().toISOString(), clashConnections, bypasses,
    stats: {
      total: clashConnections.length,
      proxied: clashConnections.filter(c => !c.chains.some(x => String(x).toUpperCase() === 'DIRECT')).length,
      direct: clashConnections.filter(c => c.chains.some(x => String(x).toUpperCase() === 'DIRECT')).length,
      bypass: bypasses.length
    }
  };
}

function createWindow() {
  nativeTheme.themeSource = 'light';
  mainWindow = new BrowserWindow({
    width: 760, height: 560, minWidth: 700, minHeight: 520,
    backgroundColor: '#f5f5f7', titleBarStyle: 'hidden', titleBarOverlay: { color: '#f8f8fa', symbolColor: '#3b3b3f', height: 46 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  await ensureDirs();
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.handle('settings:get', readSettings);
ipcMain.handle('settings:save', (_, value) => writeSettings(value));
ipcMain.handle('config:choose', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { title: '选择 Clash / Mihomo 配置文件', properties: ['openFile'], filters: [{ name: 'YAML 配置', extensions: ['yaml', 'yml'] }] });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('executable:choose', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { title: '选择程序或快捷方式', properties: ['openFile'], filters: [{ name: 'Windows 程序与快捷方式', extensions: ['exe', 'lnk'] }] });
  return result.canceled ? null : resolveExecutablePath(result.filePaths[0]);
});
ipcMain.handle('executable:resolve', (_, inputPath) => resolveExecutablePath(inputPath));
ipcMain.handle('config:load', async (_, configPath) => {
  const text = await fs.readFile(configPath, 'utf8');
  const doc = parseConfig(text);
  const all = readManagedRules(doc);
  const mode = String(doc.get('mode') || 'rule');
  const controller = String(doc.get('external-controller') || '127.0.0.1:9090');
  const secret = String(doc.get('secret') || '');
  return { path: configPath, mode, controller, secret, ruleCount: doc.get('rules')?.items?.length || 0, processRules: all.map(x => x.value) };
});
ipcMain.handle('rules:apply', (_, payload) => applyManagedRules(payload));
ipcMain.handle('backup:list', listBackups);
ipcMain.handle('backup:restore', async (_, id) => {
  const safeId = path.basename(id);
  const backupPath = path.join(backupsDir(), safeId);
  const meta = JSON.parse(await fs.readFile(`${backupPath}.json`, 'utf8'));
  if (!meta.source) throw new Error('该备份缺少原配置路径');
  if (fsSync.existsSync(meta.source)) await makeBackup(meta.source, '恢复前保护备份');
  const content = await fs.readFile(backupPath, 'utf8');
  parseConfig(content);
  await atomicWrite(meta.source, content);
  return { restoredTo: meta.source };
});
ipcMain.handle('backup:delete', async (_, id) => {
  const safeId = path.basename(id);
  await Promise.allSettled([fs.unlink(path.join(backupsDir(), safeId)), fs.unlink(path.join(backupsDir(), `${safeId}.json`))]);
  return true;
});
ipcMain.handle('startup:get', async () => {
  try {
    const out = await run('reg.exe', ['query', RUN_KEY, '/v', RUN_VALUE]);
    const match = out.match(/REG_SZ\s+(.+)$/m);
    return { enabled: true, command: match ? match[1].trim() : '' };
  } catch { return { enabled: false, command: '' }; }
});
ipcMain.handle('startup:set', async (_, { enabled, executablePath }) => {
  if (enabled) {
    if (!executablePath || !fsSync.existsSync(executablePath)) throw new Error('请先选择有效的 Clash 客户端程序');
    await run('reg.exe', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', `"${executablePath}"`, '/f']);
  } else {
    try { await run('reg.exe', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f']); } catch {}
  }
  await writeSettings({ executablePath });
  return { enabled };
});
ipcMain.handle('controller:test', async (_, { controller, secret }) => {
  const version = await controllerFetch(controller, secret, '/version');
  return { ok: true, version: version.version || version.meta || '已连接' };
});
ipcMain.handle('monitor:snapshot', (_, payload) => monitorSnapshot(payload));
ipcMain.handle('notification:show', (_, { title, body }) => {
  if (Notification.isSupported()) new Notification({ title, body, silent: false }).show();
  return true;
});
ipcMain.handle('path:open', (_, target) => shell.showItemInFolder(target));
