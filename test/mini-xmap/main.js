// 最小复现：Electron 能否把一个小窗口 map 到 X（XWayland）上
//
// 用法： env -u ELECTRON_RUN_AS_NODE TMPDIR=/var/tmp <electron> <本目录> --no-sandbox
// 输出全部走 stderr（stdout 留给协议，虽然这个脚本没协议）。
'use strict';
const { app, BrowserWindow, screen } = require('electron');
const { execFileSync } = require('child_process');

const MODE = process.env.MINI_MODE || 'normal';   // normal|toolbar|dock|undecorated
const W = Number(process.env.MINI_W || 48);
const H = Number(process.env.MINI_H || 50);
const OZONE = process.env.MINI_OZONE || 'x11';
const TRANSPARENT = process.env.MINI_TRANSPARENT !== '0';

function L(...a) {
  process.stderr.write('[mini ' + new Date().toISOString().slice(11, 23) + '] ' + a.join(' ') + '\n');
}

L('mode=' + MODE, 'size=' + W + 'x' + H, 'ozone=' + OZONE, 'transparent=' + TRANSPARENT);
L('env DISPLAY=' + process.env.DISPLAY + ' WAYLAND_DISPLAY=' + process.env.WAYLAND_DISPLAY +
  ' XDG_SESSION_TYPE=' + process.env.XDG_SESSION_TYPE);

app.commandLine.appendSwitch('ozone-platform', OZONE);
app.commandLine.appendSwitch('disable-dev-shm-usage');
if (process.getuid && process.getuid() === 0) app.commandLine.appendSwitch('no-sandbox');
app.disableHardwareAcceleration();

function xpropTree() {
  try {
    const out = execFileSync('xwininfo', ['-root', '-tree'], { encoding: 'utf8', timeout: 4000 });
    const lines = out.split('\n').filter((l) => /0x[0-9a-f]+/.test(l));
    return lines
      .map((l) => l.trim())
      .filter((l) => /\d+x\d+\+/.test(l))
      .slice(0, 40)
      .join('\n    ');
  } catch (e) {
    return 'xwininfo 失败: ' + e.message;
  }
}

function selfProps(id) {
  try {
    const out = execFileSync('xprop', ['-id', id, '_NET_WM_PID', '_NET_WM_WINDOW_TYPE', 'WM_STATE', 'override-redirect'],
      { encoding: 'utf8', timeout: 4000 });
    return out.trim().replace(/\n/g, ' | ');
  } catch (e) {
    return 'xprop 失败: ' + e.message;
  }
}

app.whenReady().then(() => {
  const wa = screen.getPrimaryDisplay().workArea;
  L('workArea', JSON.stringify(wa));
  const x = wa.x + Math.round((wa.width - W) / 2);
  const y = wa.y + wa.height - H - 4;

  const opts = {
    x, y, width: W, height: H,
    frame: false,
    transparent: TRANSPARENT,
    backgroundColor: TRANSPARENT ? '#00000000' : '#1e1e22',
    hasShadow: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    focusable: true,
    alwaysOnTop: true,
    show: false,
    useContentSize: true,
  };
  if (MODE === 'undecorated') opts.type = 'desktop';
  else opts.type = MODE;

  L('构造选项', JSON.stringify(opts));
  const win = new BrowserWindow(opts);
  win.loadURL('data:text/html,' + encodeURIComponent(
    '<html><body style="margin:0;background:' + (TRANSPARENT ? 'transparent' : '#1e1e22') +
    '"><div style="width:' + W + 'px;height:' + H + 'px;border-radius:50%;background:#e0533d"></div></body></html>'
  ));

  win.once('ready-to-show', () => {
    win.showInactive();
    L('show 之后: visible=' + win.isVisible() + ' bounds=' + JSON.stringify(win.getBounds()));
    // getNativeWindowHandle 给的是 X11 Window id（Linux）
    let handle = 'n/a';
    try {
      const buf = win.getNativeWindowHandle();
      handle = '0x' + buf.readUInt32LE(0).toString(16);
      L('native handle = ' + handle);
      L('该窗口的 xprop: ' + selfProps(handle));
    } catch (e) {
      L('getNativeWindowHandle 失败: ' + e.message);
    }
    setTimeout(() => {
      L('--- xwininfo -root -tree ---\n    ' + xpropTree());
      L('--- 结束 ---');
      app.exit(0);
    }, 1500);
  });

  win.webContents.on('did-finish-load', () => L('did-finish-load'));
  win.webContents.on('render-process-gone', (_e, d) => L('renderer gone', JSON.stringify(d)));

  setTimeout(() => {
    L('超时兜底 exit');
    app.exit(2);
  }, 15000);
});
