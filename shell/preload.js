// preload：把最小面积的 IPC 桥挂到页面上。
// 只暴露一个 send(channel, payload) 与一个 on(fn)，不给页面任何 require / node 能力。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orbs', {
  send: (channel, payload) => ipcRenderer.send(channel, payload || {}),
  on: (fn) => {
    ipcRenderer.on('state', (_e, msg) => fn(msg));
  },
});
