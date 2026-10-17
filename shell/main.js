'use strict';
// Branch Orbs —— 悬浮球壳进程（一个独立的 Electron 主进程）
//
// 为什么必须是独立进程：
//   VSCode 的扩展宿主是 Electron 的 **utility 进程**（process.type==='utility'），
//   require('electron') 只能拿到 net / systemPreferences，
//   **没有 BrowserWindow、没有 screen、也没有 app**。
//   所以扩展自己「开一个透明窗口」是物理上做不到的 —— 必须 spawn 一个自己的 Electron。
//
// 通信：扩展 → 壳 用 stdin 的 JSONL（一行一个对象）；
//       壳 → 扩展 用 stdout 的 JSONL。stdout 里绝不能出现别的东西（包括 console.log），
//       所有日志走 stderr，否则会毒化协议。

const { app, BrowserWindow, screen, ipcMain, Menu, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

if (process.env.BRANCH_ORBS_USER_DATA) {
  app.setPath('userData', process.env.BRANCH_ORBS_USER_DATA);
}

app.commandLine.appendSwitch('ozone-platform-hint', 'auto');

const logFile = process.env.BRANCH_ORBS_LOG || null;

/* ⚠ 踩过的严重坑：日志写死循环，把磁盘灌了 454MB。
   stdout 是管道，父进程（VSCode 扩展宿主）一退出，write() 就 **异步** 抛 EPIPE ——
   这个异常 try/catch 抓不到，会直接进 uncaughtException。
   而 uncaughtException 处理里又调 log() 写 stderr（也是管道，同样 EPIPE）…
   于是"写日志失败 → 报错 → 再写日志"无限循环，一秒几万行。
   修法三层：
     ① log 里对 stderr 写入也包 try/catch，并且**出错就自废**（dead 标记）
     ② stdout 挂 'error' 监听（异步 EPIPE 走这里，不再变成 uncaught）
     ③ 日志文件超过上限就停写（防止任何意外把磁盘写满） */
let logDead = false;
let logBytes = 0;
const LOG_MAX_BYTES = 2 * 1024 * 1024; // 2MB 上限，超了就不再追加

function log(...args) {
  if (logDead) return;
  const line = '[shell ' + new Date().toISOString().slice(11, 23) + '] ' + args.join(' ') + '\n';
  try {
    process.stderr.write(line);
  } catch (_) {
    // stderr 也断了：说明父进程没了，彻底闭嘴（但不要递归）
    logDead = true;
  }
  if (logFile && logBytes < LOG_MAX_BYTES) {
    try {
      if (logBytes === 0) logBytes = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
      if (logBytes < LOG_MAX_BYTES) {
        fs.appendFileSync(logFile, line);
        logBytes += Buffer.byteLength(line);
      } else {
        fs.appendFileSync(logFile, '[shell] 日志超过 2MB 上限，后续不再写入\n');
      }
    } catch (_) {}
  }
}

/* stdout 的异步错误必须就地吃掉：否则每次 EPIPE 都会触发 uncaughtException，
   而 uncaughtException 里又要发消息 → 又 EPIPE → 死循环。 */
let outDead = false;
if (process.stdout && typeof process.stdout.on === 'function') {
  process.stdout.on('error', () => {
    outDead = true; // 父进程已经走了，安静退出，别再刷
    try {
      app.quit();
    } catch (_) {}
  });
}

function send(msg) {
  if (outDead) return;
  try {
    process.stdout.write(JSON.stringify(msg) + '\n');
  } catch (_) {
    outDead = true;
  }
}

/* ══════════════════════════════════════════════════════════════════
   几何：窗口 = 三条区带（lane）
     · dock 带  —— 球休息时的位置，最贴屏边的一段
     · hot  带  —— 球悬停上探后占据的高度
     · card 带  —— 信息卡占据的矩形
   指针落在任何一条带里窗口就收事件；不在任何一条带里就穿透。
   ⚠ 绝不轮询 screen.getCursorScreenPoint()：X11 下它是事件驱动缓存，
     窗口一旦穿透读回的位置就冻住，判定恒为"在外边" → 永久死锁。
   ══════════════════════════════════════════════════════════════════ */

const LANE_IDLE = 'idle';
const LANE_HOT = 'hot';
const LANE_CARD = 'card';

const state = {
  win: null,
  view: null, // { dockW, dockH, cardW, cardH } —— 由页面测量回来
  lane: LANE_IDLE,
  hot: -1,
  repos: [],
  cfg: null,
  drag: null,
  dragPreview: null, // 拖动时的临时窗口位置
  lastRect: null,
  repaintTimer: null,
  hideMenus: [],
  tray: null,
};

function cfg() {
  return (
    state.cfg || {
      dock: 'bottom',
      size: 30,
      gap: 8,
      sink: 0.32,
      offset: 0,
      showCard: true,
      drag: true,
    }
  );
}

/** VSCode 主窗口矩形：由扩展侧上报（壳进程看不到别人的窗口） */
let anchorWin = null;

function workAreaFor(rect) {
  if (rect && typeof rect.width === 'number') {
    const d = screen.getDisplayMatching(rect);
    return d.workArea;
  }
  return screen.getPrimaryDisplay().workArea;
}

/** 窗口尺寸的硬下限：mutter/xcb 会把 <128px 的窗口当成 0×0（球直接消失），
    而且 setBounds 之后它再也不会长回来。所有尺寸都必须过这一道。 */
const MIN_WIN_W = 48;
const MIN_WIN_H = 30;

function anchors() {
  const c = cfg();
  const v = state.view;
  const wa = workAreaFor(anchorWin);
  const D = c.size;
  const R = D / 2;
  const sinkPx = Math.round(R * c.sink);
  const LIFT = Math.ceil(D * 0.62);
  // ⚠ 只用"测量值"，绝不用当前窗口尺寸反推：
  //   页面宽度被窗口夹住 → 量出来的球列也跟着变窄 → 窗口再变窄，会一路缩到 0。
  //   这就是所谓"把测量结果当成需求的输入"的自激振荡。
  const dockW = v ? v.dockW : D + 12;
  const dockH = v ? v.dockH : D + 8;
  // 卡片尺寸只在它真的显示时才有意义：页面 measure() 在卡片移除 .on 后会把
  // cardW/cardH 报成 0，于是窗口自然缩回去。不需要额外"等下一次测量"。
  const cardW = c.showCard && v ? v.cardW || 0 : 0;
  const cardH = c.showCard && v ? v.cardH || 0 : 0;

  const vertical = c.dock === 'bottom' || c.dock === 'top';
  const wide = Math.max(dockW, cardW);
  // 球探出需要的额外高度由 LIFT 提供，但 dockH 之外还要留出 LIFT，
  // 否则悬停时球会被窗口顶边裁掉。同时卡片带也要算进去。
  const winW = Math.max(MIN_WIN_W, Math.round(wide) + 2);
  const winH = Math.max(MIN_WIN_H, Math.round(dockH + LIFT + cardH) + 1);

  // ⚠ X11（mutter）会把窗口裁到不会被工作区边吃掉的位置：
  //   把窗口放到工作区下方之外，它会被"拉回来"贴在底边上，
  //   于是 sink 永远不生效（观察到的现象是 bottomGap 恒为 0）。
  //   对策：窗口本身**不下沉**，位置就贴工作区边；
  //   下沉靠页面内的 CSS 把球往下推（body.sink），球超出窗口的部分被裁掉。
  //   视觉等价，且完全不受 WM 的钳制。
  let winX;
  let winY;
  if (vertical) {
    winX = Math.round(wa.x + (wa.width - winW) / 2 + c.offset);
    winX = Math.min(Math.max(winX, wa.x), Math.max(wa.x, wa.x + wa.width - winW));
    winY = c.dock === 'top'
      ? Math.round(wa.y)
      : Math.round(wa.y + wa.height - winH);
  } else {
    winY = Math.round(wa.y + wa.height - winH);
    winX = c.dock === 'bottom-right'
      ? Math.round(wa.x + wa.width - winW)
      : Math.round(wa.x);
  }

  // 三条带（窗口内坐标，y 向下）
  let hotTop;
  let hotBottom;
  let cardTop;
  let cardBottom;
  if (c.dock === 'top') {
    hotTop = 0;
    hotBottom = Math.round(dockH + LIFT);
    cardTop = hotBottom;
    cardBottom = Math.round(cardTop + cardH);
  } else {
    // hot 带必须完整覆盖"球原位 + 上探"的那一段。用窗口坐标从下往上量：
    //   窗口底边 = dockH（球位，已被 sink 切掉一部分）
    //   上探后顶部 = dockH + LIFT
    hotBottom = winH;
    hotTop = Math.round(winH - dockH - LIFT);
    cardBottom = hotTop;
    cardTop = Math.round(cardBottom - cardH);
  }

  // 被屏幕边缘吃掉多少（下沉时底边那一段在屏幕外）
  const top = Math.max(winY, wa.y);
  const bottom = Math.min(winY + winH, wa.y + wa.height);
  const visibleH = Math.max(1, bottom - top);

  return {
    win: { x: winX, y: winY, width: winW, height: winH },
    bands: {
      dock: {
        top: c.dock === 'top' ? 0 : winH - Math.round(dockH),
        bottom: c.dock === 'top' ? Math.round(dockH) : winH,
      },
      hot: { top: hotTop, bottom: hotBottom },
      card: { top: cardTop, bottom: cardBottom },
    },
    metrics: { D, R, sinkPx, lift: LIFT, dockW, dockH, cardW, cardH, gap: c.gap, winW, winH, wide },
    workArea: wa,
    visible: { top: top - winY, height: visibleH },
    occluded: Math.max(0, winH - visibleH),
  };
}

function setLane(l) {
  if (l === state.lane) return;
  state.lane = l;
  if (!state.win || state.win.isDestroyed()) return;
  if (l === LANE_IDLE) state.win.setIgnoreMouseEvents(true, { forward: true });
  else state.win.setIgnoreMouseEvents(false);
  // Linux 上 BrowserWindow 没有 isIgnoringMouseEvents()，自己记账给诊断用
  state.ignoring = l === LANE_IDLE;
  log('lane →', l);
  pushProbe();
}

/** 把"主进程才知道的状态"镜像给页面，纯粹为了自测能读到（页面自己读不到 isIgnoreMouseEvents） */
function pushProbe() {
  if (!state.win || state.win.isDestroyed()) return;
  try {
    const payload = {
      lane: state.lane,
      ignoring: state.ignoring,
      bounds: state.win.getBounds(),
    };
    state.win.webContents
      .executeJavaScript('window.__shellProbe = ' + JSON.stringify(payload) + ';true')
      .catch(() => {});
  } catch (_) {}
}

function laneAt(px, py) {
  const a = anchors();
  const b = a.bands;
  if (py >= b.hot.top - 2 && py <= b.hot.bottom + 2) return LANE_HOT;
  if (cfg().showCard && py >= b.card.top - 2 && py <= b.card.bottom + 2) return LANE_CARD;
  return LANE_IDLE;
}

/** 把窗口内的点换算成"命中第几个球"，供诊断与自测用。
    球的几何必须和 orbs.html 的 CSS 完全一致：
      · dock 在窗口内水平居中，宽 = m.dockW
      · 球顶贴窗口底边往上 dockH - padBottom，即球占 [winH-dockH, winH-padBottom]
      · top 停靠时镜像到窗口顶边 */
function hitAt(px, py) {
  const a = anchors();
  const c = cfg();
  if (laneAt(px, py) !== LANE_HOT) return -1;
  const m = a.metrics;
  const padBottom = 3;
  const lift = cfg().size * 0.62;
  const dockLeft = (m.winW - m.dockW) / 2 + 6;
  const isTop = c.dock === 'top';
  // 球位（窗口内坐标，未下沉）：bottom 停靠时球贴在窗口底边上方 dockH 那一条里
  const orbTop = isTop ? 0 : m.winH - m.dockH;
  const orbBottom = orbTop + c.size;
  for (let i = 0; i < state.repos.length; i++) {
    const cx = dockLeft + i * (c.size + c.gap) + c.size / 2;
    const cy = (orbTop + orbBottom) / 2;
    // 命中框：球本体 + 上探余量（悬停时球会抬起 lift）
    const halfH = (orbBottom - orbTop) / 2 + m.lift;
    if (Math.abs(px - cx) <= c.size / 2 + 5 && Math.abs(py - cy) <= halfH) return i;
  }
  return -1;
}

/* ───────────────────────── 窗口 ───────────────────────── */

function createWindow() {
  const a = anchors();
  log('createWindow', JSON.stringify(a.win), 'wa', JSON.stringify(a.workArea), 'view', JSON.stringify(state.view));
  const win = new BrowserWindow({
    x: a.win.x,
    y: a.win.y,
    width: a.win.width,
    height: a.win.height,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // ⚠ focusable 必须为 true：在 X11 上 focusable:false 的窗口拿不到输入事件，
    // 悬停/点击全部失效（球可见但怎么点都没反应）。抢焦点的问题用 showInactive() 规避。
    focusable: true,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    show: false,
    useContentSize: true,
    backgroundColor: '#00000000',
    type: 'toolbar',
    webPreferences: {
      // ⚠ preload 漏了 = 页面上没有 window.orbs，第一行 post('ready') 就抛
      // "Cannot read properties of undefined (reading 'send')"，球永远画不出来。
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      devTools: true,
    },
  });
  state.win = win;
  try {
    win.setAlwaysOnTop(true, 'floating');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch (e) {
    log('alwaysOnTop/workspace:', e.message);
  }
  win.setIgnoreMouseEvents(true, { forward: true });
  state.lane = LANE_IDLE;
  state.ignoring = true;

  // 自测驱动口：只在 BRANCH_ORBS_TEST=1 时挂上。
  // 外部（Playwright）没法往 stdin 里写字，所以留一个等价的注入点 ——
  // 它直接调用 onLine，走的完全是扩展推消息的同一条路径，不是旁路。
  if (process.env.BRANCH_ORBS_TEST === '1') {
    global.__orbsDriver = (msg) => onLine(JSON.stringify(msg));
    global.__orbsState = () => ({
      lane: state.lane,
      ignoring: state.ignoring,
      hot: state.hot,
      view: state.view,
      bounds: state.win && !state.win.isDestroyed() ? state.win.getBounds() : null,
      anchors: anchors(),
      repos: state.repos.length,
      cfg: state.cfg,
      pushStateType: typeof pushState,
      hasWin: !!state.win,
    });
    global.__orbsPush = () => {
      try { pushState(); return 'ok'; } catch (e) { return 'ERR ' + e.message; }
    };
  }

  // ⚠ 不能只依赖 webContents 的 'ipc-message' 转发：那条路径在部分 Electron 版本
  //   与沙箱渲染器组合下拿不到，页面发来的 measure/hover/click 会被静默丢弃
  //   （症状：球画出来了，但窗口永远停在初始尺寸、悬停毫无反应）。
  //   两边都挂，用 channel 白名单去重，谁先到用谁。
  const PAGE_CHANNELS = ['measure', 'hover', 'click', 'context', 'dragstart', 'dragmove', 'dragend', 'ready'];
  // ⚠ 只对"一次性的动作"做去重（ready/click/context/drag*）。
  //   measure 和 hover 是状态同步，内容相同也必须每条都算 ——
  //   否则"卡片收起 → 报 0×0"会被和上一次的空态当成重复丢掉，
  //   窗口就永远停在悬停时的大尺寸上（球收不回来）。
  const DEDUP = new Set(['ready', 'click', 'context', 'dragstart', 'dragmove', 'dragend']);
  const seen = new Set();
  function deliver(channel, payload) {
    if (!PAGE_CHANNELS.includes(channel)) return;
    if (DEDUP.has(channel)) {
      const key = channel + '|' + JSON.stringify(payload || {});
      if (seen.has(key)) return;
      seen.add(key);
      if (seen.size > 64) seen.clear();
    }
    onPage(channel, payload || {});
  }
  ipcMain.on('__orbs', (_e, channel, payload) => deliver(channel, payload));
  for (const ch of PAGE_CHANNELS) ipcMain.on(ch, (_e, payload) => deliver(ch, payload));
  win.webContents.on('ipc-message', (_e, channel, args) => deliver(channel, (args && args[0]) || {}));
  win.webContents.on('console-message', (e, level, msg) => {
    log('page:', msg);
    send({ type: 'page-log', level, msg });
  });
  win.webContents.on('did-finish-load', () => {
    // 页面加载完成后再推一次 —— 首帧 'ready' 可能与预加载 bridge 的时序错开
    pushState();
  });
  // 页面里的未捕获异常只在 renderer 侧，主进程默认看不到 ——
  // 没有这一条，render() 抛错会表现成"球永远不出现"，而日志一片干净。
  win.webContents.on('render-process-gone', () => {
    log('renderer gone, rebuild');
    state.win = null;
    setTimeout(bootBall, 400);
  });
  win.once('ready-to-show', () => {
    win.showInactive();
    repaint(true);
  });
  win.on('closed', () => {
    state.win = null;
  });

  const html = process.env.BRANCH_ORBS_HTML;
  if (html && fs.existsSync(html)) {
    win.loadFile(html);
  } else {
    log('缺少 BRANCH_ORBS_HTML');
  }
  return win;
}

/** 唯一的移动入口 —— setBounds 且每次显式带 w/h。setPosition 每调一次尺寸就涨 1~2px。 */
function place(x, y, w, h) {
  if (!state.win || state.win.isDestroyed()) return;
  const r = {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(MIN_WIN_W, Math.round(w)),
    height: Math.max(MIN_WIN_H, Math.round(h)),
  };
  const b = state.win.getBounds();
  if (b.x === r.x && b.y === r.y && b.width === r.width && b.height === r.height) return;
  const prev = state.win.getBounds();
  state.win.setBounds(r);
  state.lastRect = r;
  const now = state.win.getBounds();
  if (process.env.BRANCH_ORBS_TRACE) log('place', JSON.stringify(r), 'prev', JSON.stringify(prev), 'now', JSON.stringify(now));
  pushProbe();
}

function repaint(force) {
  if (!state.win || state.win.isDestroyed()) return;
  if (state.drag && !force) return;
  const a = anchors();
  if (state.dragPreview && !force) {
    place(state.dragPreview.x, state.dragPreview.y, a.win.width, a.win.height);
  } else {
    place(a.win.x, a.win.y, a.win.width, a.win.height);
  }
}

/** 页面测得的尺寸会改变窗口 → 窗口又改变页面排版 → 再测。
   这里做 30ms 合并，并限制连续收敛次数，避免抖动。 */
let repaintBurst = 0;
function scheduleRepaint() {
  if (state.repaintTimer) return;
  state.repaintTimer = setTimeout(() => {
    state.repaintTimer = null;
    if (repaintBurst++ < 40) repaint();
  }, 30);
}

function pushState() {
  if (!state.win || state.win.isDestroyed()) return;
  const c = cfg();
  // ⚠ 必须带 type:'state' —— 页面侧 api.on 的第一行就是 `if (msg.type !== 'state') return;`。
  //   漏了它，页面收到消息后静默返回，球永远不出现，而且不报任何错。
  state.win.webContents.send('state', { type: 'state', repos: state.repos, cfg: c });
}
/* ───────────────────────── 页面事件 ───────────────────────── */

function onPage(channel, m) {
  if (channel === 'measure') {
    const next = {
      dockW: Math.max(1, Math.round(m.dockW || 0)),
      dockH: Math.max(1, Math.round(m.dockH || 0)),
      cardW: Math.max(0, Math.round(m.cardW || 0)),
      cardH: Math.max(0, Math.round(m.cardH || 0)),
    };
    // 尺寸收敛：直接采纳。
    // ⚠ 曾经试过"变小时等下一次测量再确认"，结果窗口永远缩不回去：
    //   页面 measure() 自带 lastPosted 去重，同一组数值只发一次，
    //   第二次"确认"永远等不到。收敛必须一次到位。
    //   闪屏风险交给页面侧：卡片先移出 .on 再 measure()，一次报出 0。
    const p = state.view;
    if (!p || p.dockW !== next.dockW || p.dockH !== next.dockH || p.cardW !== next.cardW || p.cardH !== next.cardH) {
      state.view = next;
      repaintBurst = 0;
      scheduleRepaint();
    }
    return;
  }
  if (channel === 'hover') {
    state.hot = typeof m.index === 'number' ? m.index : -1;
    setLane(state.hot >= 0 ? LANE_HOT : LANE_IDLE);
    send({ type: 'hover', index: state.hot });
    return;
  }
  if (channel === 'click') {
    const repo = state.repos[m.index];
    setLane(LANE_IDLE);
    send({ type: 'click', index: m.index, repo: repo || null });
    return;
  }
  if (channel === 'context') {
    state.hot = typeof m.index === 'number' ? m.index : -1;
    setLane(LANE_CARD);
    openContextMenu(m.index);
    return;
  }
  if (channel === 'dragstart') {
    if (!cfg().drag) return;
    const b = state.win.getBounds();
    state.drag = { x0: b.x, y0: b.y, px0: null, py0: null, wa: anchors().workArea };
    setLane(LANE_HOT);
    return;
  }
  if (channel === 'dragmove') {
    if (!state.drag) return;
    const d = state.drag;
    if (d.px0 == null) {
      d.px0 = m.screenX;
      d.py0 = m.screenY;
    }
    const b = state.win.getBounds();
    const nx = Math.round(Math.min(Math.max(d.x0 + (m.screenX - d.px0), d.wa.x - 40), d.wa.x + d.wa.width - 40));
    const ny = Math.round(Math.min(Math.max(d.y0 + (m.screenY - d.py0), d.wa.y - 40), d.wa.y + d.wa.height - 40));
    state.dragPreview = { x: nx, y: ny };
    place(nx, ny, b.width, b.height);
    return;
  }
  if (channel === 'dragend') {
    const prev = state.dragPreview;
    const d = state.drag;
    state.drag = null;
    state.dragPreview = null;
    if (prev && d) {
      const centerX = prev.x + (state.lastRect ? state.lastRect.width : 0) / 2;
      const offset = Math.round(centerX - (d.wa.x + d.wa.width / 2));
      send({ type: 'dragcommit', offset });
    }
    repaintBurst = 0;
    repaint(true);
    return;
  }
  if (channel === 'ready') {
    pushState();
    send({ type: 'ready' });
  }
}

function openContextMenu(index) {
  const repo = state.repos[index];
  const items = repo
    ? [
        { label: `复制分支名「${repo.branch}」`, click: () => send({ type: 'menu', action: 'copy', index }) },
        { label: '在这个仓库新开窗口', click: () => send({ type: 'menu', action: 'open', index }) },
        { label: '刷新', click: () => send({ type: 'menu', action: 'refresh', index }) },
        { type: 'separator' },
        { label: '隐藏悬浮球', click: () => send({ type: 'menu', action: 'hide', index }) },
      ]
    : [{ label: '刷新', click: () => send({ type: 'menu', action: 'refresh', index: -1 }) }];
  const menu = Menu.buildFromTemplate(items);
  state.hideMenus.push(menu);
  menu.popup({
    window: state.win,
    callback: () => {
      setTimeout(() => setLane(LANE_IDLE), 120);
    },
  });
}

/* ───────────────────────── stdin 协议 ───────────────────────── */

function onLine(line) {
  if (!line.trim()) return;
  let m;
  try {
    m = JSON.parse(line);
  } catch (e) {
    log('bad json', line.slice(0, 200));
    return;
  }
  switch (m.type) {
    case 'config':
      state.cfg = m.cfg;
      repaintBurst = 0;
      repaint(true);
      if (state.win && !state.win.isDestroyed()) pushState();
      break;
    case 'repos':
      state.repos = Array.isArray(m.repos) ? m.repos : [];
      pushState();
      setTimeout(() => {
        repaintBurst = 0;
        repaint();
      }, 80);
      break;
    case 'anchor':
      if (m.rect && typeof m.rect.width === 'number' && m.rect.width > 0) {
        const changed = !anchorWin || ['x', 'y', 'width', 'height'].some((k) => anchorWin[k] !== m.rect[k]);
        anchorWin = m.rect;
        if (changed) repaint();
      }
      break;
    case 'show':
      bootBall();
      break;
    case 'hide':
      if (state.win && !state.win.isDestroyed()) state.win.destroy();
      state.win = null;
      break;
    case 'ping':
      send({ type: 'pong', t: m.t });
      break;
    case 'quit':
      app.quit();
      break;
    case 'diag': {
      const a = anchors();
      send({
        type: 'diag',
        id: m.id,
        data: {
          bounds: state.win && !state.win.isDestroyed() ? state.win.getBounds() : null,
          lane: state.lane,
          ignoring: state.ignoring,
          hot: state.hot,
          visible: state.win && !state.win.isDestroyed() ? state.win.isVisible() : false,
          view: state.view,
          anchors: a,
          repos: state.repos.map((r) => ({ name: r.name, branch: r.branch, changed: r.changed })),
          anchorWin,
          displays: screen.getAllDisplays().map((d) => ({ id: d.id, workArea: d.workArea, scale: d.scaleFactor })),
          drag: !!state.drag,
        },
      });
      break;
    }
    case 'hit': {
      send({ type: 'hit-result', id: m.id, lane: laneAt(m.x, m.y), index: hitAt(m.x, m.y) });
      break;
    }
    case 'screen-point': {
      // 仅用于自测：读一次全局指针（不轮询）
      const p = screen.getCursorScreenPoint();
      send({ type: 'screen-point', id: m.id, point: p });
      break;
    }
    default:
      log('unknown msg', m.type);
  }
}

function bootBall() {
  if (state.win && !state.win.isDestroyed()) {
    state.win.showInactive();
    repaint(true);
    return;
  }
  createWindow();
}

/* ───────────────────────── 启动 ───────────────────────── */

app.whenReady().then(() => {
  try {
    app.dock && app.dock.hide();
  } catch (_) {}
  bootBall();
  // ⚠ stdin 可能根本不存在（Playwright/Cron/某些启动器里为 null 或立刻 EOF）。
  // 直接给 process.stdin 挂 'end' 会在启动瞬间 quit，表现是
  // "Target page, context or browser has been closed" —— 而手动跑一切正常。
  // 只有"确实有过一条消息、并且之后才 EOF"才算父进程走了。
  if (process.stdin && process.stdin.readable) {
    let sawMessage = false;
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', (line) => {
      sawMessage = true;
      onLine(line);
    });
    rl.on('close', () => {
      if (sawMessage) {
        log('stdin 关闭，退出');
        app.quit();
      }
    });
  } else {
    log('无 stdin：以独立模式运行（自测/手动启动）');
  }
  send({ type: 'boot', pid: process.pid, electron: process.versions.electron });
});

// 单实例锁默认**不开**：请求锁会让 Electron 走 second-instance 路径，
// 在自动化（Playwright）下表现为 "Target page, context or browser has been closed"。
// 需要去重的场景用 BRANCH_ORBS_SINGLE=1 显式打开。
if (process.env.BRANCH_ORBS_SINGLE === '1') {
  if (!app.requestSingleInstanceLock()) {
    log('已有同类实例，退出');
    setTimeout(() => process.exit(0), 0);
  }
}

/* uncaughtException 只报一次就退出 —— 绝不能在这里继续写日志写消息：
   之前这里 log + send，两者都可能 EPIPE，于是形成无限自激（磁盘被灌 454MB）。 */
let fatalReported = false;
process.on('uncaughtException', (e) => {
  if (fatalReported) return;
  fatalReported = true;
  const msg = e && e.message ? String(e.message) : String(e);
  // EPIPE / 管道关闭 = 父进程没了，属于正常退出，不必当成崩溃
  if (/EPIPE|ECONNRESET|ERR_STREAM_DESTROYED/.test(msg)) {
    try {
      app.quit();
    } catch (_) {}
    return;
  }
  try {
    log('uncaught:', e && e.stack ? e.stack : String(e));
  } catch (_) {}
  send({ type: 'fatal', message: msg });
  setTimeout(() => {
    try {
      process.exit(1);
    } catch (_) {}
  }, 100);
});

app.on('window-all-closed', () => {
  /* 悬浮球被销毁不等于退出 —— 由 stdin 关闭决定生命周期 */
});
