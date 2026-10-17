// preload：把最小面积的 IPC 桥挂到页面上。
// 只暴露一个 send(channel, payload) 与一个 on(fn)，不给页面任何 require / node 能力。
const { contextBridge, ipcRenderer } = require('electron');

/* ⚠ 页面里的异常以前只走 console.error，主进程完全看不见 ——
   表现是"日志一切正常、屏幕上没有球"。render() 里已经有一层 try/catch，
   但它的 catch 也只 console.error，等于异常在原地消失。

   这里把页面侧的 console.error / console.warn 与未捕获异常
   统一转成 log 通道发给主进程，写进 boot.log。
   只在真的出错时发，不刷正常日志，不会把文件撑爆。 */
function relay(level, text) {
  try {
    ipcRenderer.send('log', { level, text: String(text).slice(0, 4000) });
  } catch (_) {}
}

window.addEventListener('error', (e) => {
  const err = e && e.error;
  relay('error', 'page-error: ' + (err && err.stack ? err.stack : (e && e.message) || e));
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e && e.reason;
  relay('error', 'page-rejection: ' + (r && r.stack ? r.stack : r));
});

const _err = console.error.bind(console);
console.error = function (...a) {
  relay('error', a.map((x) => (x && x.stack) || String(x)).join(' '));
  _err(...a);
};
const _warn = console.warn.bind(console);
console.warn = function (...a) {
  relay('warn', a.map((x) => (x && x.stack) || String(x)).join(' '));
  _warn(...a);
};

contextBridge.exposeInMainWorld('orbs', {
  send: (channel, payload) => ipcRenderer.send(channel, payload || {}),
  on: (fn) => {
    ipcRenderer.on('state', (_e, msg) => fn(msg));
  },
});
