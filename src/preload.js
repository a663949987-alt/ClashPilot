const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('clashPilot', {
  chooseConfig: () => ipcRenderer.invoke('config:choose'),
  chooseExecutable: () => ipcRenderer.invoke('executable:choose'),
  resolveExecutable: (path) => ipcRenderer.invoke('executable:resolve', path),
  loadConfig: (path) => ipcRenderer.invoke('config:load', path),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  applyRules: (payload) => ipcRenderer.invoke('rules:apply', payload),
  listBackups: () => ipcRenderer.invoke('backup:list'),
  restoreBackup: (id) => ipcRenderer.invoke('backup:restore', id),
  deleteBackup: (id) => ipcRenderer.invoke('backup:delete', id),
  getStartup: () => ipcRenderer.invoke('startup:get'),
  setStartup: (payload) => ipcRenderer.invoke('startup:set', payload),
  testController: (payload) => ipcRenderer.invoke('controller:test', payload),
  getTraffic: (payload) => ipcRenderer.invoke('monitor:snapshot', payload),
  notify: (payload) => ipcRenderer.invoke('notification:show', payload),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  openPath: (path) => ipcRenderer.invoke('path:open', path),
  onMenuAction: (handler) => ipcRenderer.on('menu:action', (_, action) => handler(action))
});
