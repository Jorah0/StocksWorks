// Bridge for the first-run setup window only.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setup', {
  totp: () => ipcRenderer.invoke('setup:totp'),
  save: (data) => ipcRenderer.invoke('setup:save', data),
});
