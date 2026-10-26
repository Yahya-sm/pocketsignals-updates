const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  win: cmd => ipcRenderer.send('win', cmd),
  openExternal: url => ipcRenderer.send('open-external', url),
  onPinned: cb => ipcRenderer.on('pinned', (_e, on) => cb(on)),
  version: ipcRenderer.sendSync('version'),
  onCompact: cb => ipcRenderer.on('compact', (_e, on) => cb(on)),
  miniHeight: h => ipcRenderer.send('mini-height', h),
  expand: () => ipcRenderer.send('expand'),
  miniPointer: () => ipcRenderer.send('mini-pointer'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  checkOnline: () => ipcRenderer.invoke('check-online'),
  installOnline: url => ipcRenderer.invoke('install-online', url),
});
