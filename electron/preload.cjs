// Minimal, isolated bridge for the main window. Exposes only two fixed actions; no Node access.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  openInBrowser: () => ipcRenderer.invoke('desktop:openInBrowser'),
  openDataFolder: () => ipcRenderer.invoke('desktop:openDataFolder'),
  getSettings: () => ipcRenderer.invoke('desktop:settings:get'),
  saveSettings: (passphrase, values) => ipcRenderer.invoke('desktop:settings:save', { passphrase, values }),
  workloads: {
    list: () => ipcRenderer.invoke('desktop:wl:list'),
    pick: () => ipcRenderer.invoke('desktop:wl:pick'),
    save: (passphrase, workload, useNewProgram) => ipcRenderer.invoke('desktop:wl:save', { passphrase, workload, useNewProgram }),
    toggle: (id, on) => ipcRenderer.invoke('desktop:wl:toggle', id, on),
    remove: (id) => ipcRenderer.invoke('desktop:wl:remove', id),
  },
  getPrefs: () => ipcRenderer.invoke('desktop:prefs:get'),
  setPrefs: (p) => ipcRenderer.invoke('desktop:prefs:set', p),
  openShare: () => ipcRenderer.invoke('desktop:openShare'),
});
window.addEventListener('DOMContentLoaded', () => document.documentElement.classList.add('desktop'));
