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

/* ⚠ 必须强制 X11，绝不能用 auto（auto 会选中 Wayland）：
     用户桌面是 GNOME Wayland 会话时，ozone-platform-hint=auto 让壳跑在
     Wayland 后端上。而 **Wayland 协议不允许客户端给窗口定位**——
     setBounds 传的 x/y 会被合成器无视，窗口被摆到它想放的地方
     （实测球出现在屏幕中上部而不是沉在底边）。
     更坑的是 Electron 的 getBounds() 返回的是"请求值"，
     日志里 bounds=936,1030 看起来全对，视觉上完全不对。
     XWayland 下 X11 客户端可以自定位置（ConfigureRequest），mutter 会尊重。
     可用 BRANCH_ORBS_OZONE=wayland 覆盖（纯 Wayland 无 XWayland 的环境）。 */
app.commandLine.appendSwitch(
  'ozone-platform',
  process.env.BRANCH_ORBS_OZONE || 'x11'
);

/* ── 关键开关：必须用 appendSwitch，不能靠命令行 ──
   ⚠ 这条是本轮排查的核心教训。把 --no-sandbox / --disable-dev-shm-usage
     写在可执行文件后面，这个 Electron 构建会直接拒绝：
       electron: bad option: --no-sandbox
     进程立刻退出，扩展侧只看到"壳进程运行中"然后马上死掉。
   appendSwitch 在这里一定生效，且与 CLI 解析规则无关。

   为什么非要 --disable-dev-shm-usage：
     Chromium 的字体服务要把字体数据写共享内存，默认落在 /dev/shm。
     容器/精简系统上 /dev/shm 常常只有 10~64MB，写满后直接 FATAL：
       components/services/font_data/font_data_service_impl.cc:379
       Check failed: . : 设备上没有空间 (28)
     整个 renderer 崩溃 → 球永远画不出来，而日志干净得像没问题
     （preload 注入成功、did-finish-load 成功、就是 balls:0）。 */
app.commandLine.appendSwitch('disable-dev-shm-usage');
if (process.platform === 'linux' && process.getuid && process.getuid() === 0) {
  // root 下 Chromium 拒绝启用沙箱，必须显式关闭，否则启动即 FATAL
  app.commandLine.appendSwitch('no-sandbox');
}

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
  dragShift: 0, // overlay 模式：拖动时球的实时水平偏移（叠加在 cfg.offset 上）
  lastRect: null,
  hitIdx: -1, // 轮询算出的"光标压在第几个球上"（-1 = 不在任何球上）
  ignoring: true,
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

  /* ── Linux：全屏覆盖层模式（本轮"球跑屏幕中间"的根治方案） ──
     现象：Electron setBounds(936,1030) 底部正中，球却出现在屏幕中上部。
     原因：用户桌面是 GNOME Wayland 会话，ozone=auto 时壳跑在 Wayland 后端，
       而 **Wayland 协议不允许客户端给窗口定位**，位置由合成器决定；
       即使强制 X11（XWayland），mutter 对小窗口的位置映射同样不可靠
       （实测 setBounds(806,830) 后 X 报告的实际位置是 (-933,-960)）。
     对策：**窗口直接铺满整个工作区**（透明 + 点击穿透），
       球由页面画在工作区底边/顶边 —— 窗口位置天然正确，
       彻底不依赖任何 setBounds 定位。水平偏移（offset/拖动）改由页面内完成。
     副作用控制：点击穿透由页面 hover 事件驱动（球上才接收点击），
       空白区域始终 setIgnoreMouseEvents(true,{forward:true})，不挡下层应用。 */
  const OVERLAY = process.platform === 'linux';
  const shift = Math.round((c.offset || 0) + (state.dragShift || 0));

  // 球探出需要的额外高度由 LIFT 提供，但 dockH 之外还要留出 LIFT，
  // 否则悬停时球会被窗口顶边裁掉。同时卡片带也要算进去。
  // （overlay 模式下窗口 = 整个工作区，这两个约束天然满足）
  const winW = OVERLAY ? wa.width : Math.max(MIN_WIN_W, Math.round(wide) + 2);
  const winH = OVERLAY ? wa.height : Math.max(MIN_WIN_H, Math.round(dockH + LIFT + cardH) + 1);

  // ⚠ X11（mutter）会把窗口裁到不会被工作区边吃掉的位置：
  //   把窗口放到工作区下方之外，它会被"拉回来"贴在底边上，
  //   于是 sink 永远不生效（观察到的现象是 bottomGap 恒为 0）。
  //   对策：窗口本身**不下沉**，位置就贴工作区边；
  //   下沉靠页面内的 CSS 把球往下推（body.sink），球超出窗口的部分被裁掉。
  //   视觉等价，且完全不受 WM 的钳制。
  let winX;
  let winY;
  if (OVERLAY) {
    winX = wa.x;
    winY = wa.y;
  } else if (vertical) {
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

  // dock 的水平范围（窗口内坐标）：laneAt / hitAt 的横向门禁。
  // overlay 模式下窗口铺满工作区，热带不能再横贯全宽（否则整条底部
  // 都会拦鼠标），必须收窄到球列真实占用的那一段。
  let dockL;
  if (OVERLAY && c.dock === 'bottom-right') dockL = winW - 12 - dockW + shift;
  else if (OVERLAY && c.dock === 'bottom-left') dockL = 12 + shift;
  else dockL = (winW - dockW) / 2 + 6 + shift;

  // 被屏幕边缘吃掉多少（下沉时底边那一段在屏幕外）
  const top = Math.max(winY, wa.y);
  const bottom = Math.min(winY + winH, wa.y + wa.height);
  const visibleH = Math.max(1, bottom - top);

  /* input region（窗口内矩形，X Shape 用）：静止态只有这一块能接收鼠标。
     横向 = 球列 ± 8px 余量；纵向 = 球带（球本体 + 上探余量）。
     没有它，overlay 会把整个工作区的点击全部吃掉 —— 用户点桌面任何地方都没反应。
     ⚠ 纵向不能只用"球本体 30px"：悬停时球要上探 LIFT，而切 hot 的那一瞬间
       指针可能已经在球的上半部分，收窄的区域会让 pointerdown 打在窗外。 */
  const regL = Math.round(dockL - 8);
  const regT = Math.round(Math.min(hotTop, c.dock === 'top' ? 0 : winH - dockH - LIFT));
  const region = {
    x: regL,
    y: Math.max(0, regT),
    width: Math.round(dockW + 16),
    height: Math.max(1, Math.round(winH - Math.max(0, regT))),
  };

  return {
    win: { x: winX, y: winY, width: winW, height: winH },
    bands: {
      dock: {
        top: c.dock === 'top' ? 0 : winH - Math.round(dockH),
        bottom: c.dock === 'top' ? Math.round(dockH) : winH,
        left: Math.round(dockL),
        right: Math.round(dockL + dockW),
      },
      hot: { top: hotTop, bottom: hotBottom },
      card: { top: cardTop, bottom: cardBottom },
    },
    region,
    metrics: { D, R, sinkPx, lift: LIFT, dockW, dockH, cardW, cardH, gap: c.gap, winW, winH, wide, shift, overlay: OVERLAY },
    workArea: wa,
    visible: { top: top - winY, height: visibleH },
    occluded: Math.max(0, winH - visibleH),
  };
}

function setLane(l) {
  if (l === state.lane) return;
  state.lane = l;
  if (!state.win || state.win.isDestroyed()) return;
  applyInputShape(l);
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
  if (py >= b.hot.top - 2 && py <= b.hot.bottom + 2 && px >= b.dock.left - 8 && px <= b.dock.right + 8) return LANE_HOT;
  if (cfg().showCard && py >= b.card.top - 2 && py <= b.card.bottom + 2) return LANE_CARD;
  return LANE_IDLE;
}

/* ─────────── 原生命中轮询（overlay 模式的"悬停"就靠它）───────────

   症状：overlay 铺满全屏后，把真实指针搬到球心，页面 **一个 pointer 事件都收不到**
   （实测 document 上捕 pointermove/pointerover/mousemove，全空），
   于是悬停永不触发、卡片永不弹。

   根因有两层，缺一不可：
     ① `setIgnoreMouseEvents(true, {forward:true})` 的 forward 在 Linux 上不可靠 ——
        它在 X11 下靠窗口 input shape 置空来实现"穿透"，
        而 input shape 为空时，指针事件根本不会投递到这个窗口，
        Chromium 再想"转发"也没有素材。容器/合成器环境下连 shape 操作本身都可能被忽略。
     ② overlay 覆盖整个工作区，如果不定制 input shape，它会把所有点击吃掉（挡死下层应用）。

   对策（Linux）：**完全不走 forward**。
     · 窗口 input shape 只保留"球带"那一小块矩形（xwin.setInputRegion），
       其余区域对 X 来说根本不存在 → 天然穿透下层应用，且不需要 forward。
     · 悬停判定改由主进程用 screen.getCursorScreenPoint() 轮询（30fps），
       命中球带就 setIgnoreMouseEvents(false)（全窗接收），指针移开再恢复。
   为什么轮询不丢精度：命中区就是球本身（30~35px），指针速度再快也会在离开前
   至少落在它上一帧里一次；30fps 下 900px/s 的手速也只会跳过 30px —— 正好一个球。 */
const POLL_MS = 32;
let pollTimer = null;
let pollStale = 0;

function cursorInWin() {
  if (!state.win || state.win.isDestroyed()) return null;
  const p = screen.getCursorScreenPoint();
  const r = state.lastRect || state.win.getBounds();
  return { x: p.x - r.x, y: p.y - r.y, screen: p, rect: r };
}

function pollHit() {
  if (!state.win || state.win.isDestroyed() || !state.repos.length) return;
  const c = cursorInWin();
  if (!c) return;
  const a = anchors();
  const inside = c.x >= 0 && c.y >= 0 && c.x <= a.win.width && c.y <= a.win.height;
  const idx = inside ? hitAt(c.x, c.y) : -1;
  const lane = inside ? laneAt(c.x, c.y) : LANE_IDLE;
  const pr = state.win.webContents;
  if (!pr || pr.isDestroyed()) return;

  // ① 球的 hot 态：主进程判定后直接告诉页面（页面自己收不到 pointer 事件）
  if (idx !== state.hitIdx) {
    state.hitIdx = idx;
    state.hot = idx;
    pr.executeJavaScript(
      'window.__orbsHover && window.__orbsHover(' + JSON.stringify({ index: idx, x: Math.round(c.x), y: Math.round(c.y) }) + ');true'
    ).catch(() => {});
    send({ type: 'hover', index: idx });
  }
  // ② 输入区域：球上要能被点，别处要能穿透下层（Linux 靠 input shape 精确圈定）
  const wantIgnore = lane === LANE_IDLE;
  if (wantIgnore !== state.ignoring) {
    state.ignoring = wantIgnore;
    state.lane = lane;
    applyInputShape(lane);
    log('poll lane →', lane, 'idx', idx, 'ignore', wantIgnore);
    pushProbe();
  } else if (lane !== state.lane) {
    state.lane = lane;
    pushProbe();
  }
}

/* 把"哪里能接收鼠标"同步给窗口。
   Linux 走 Electron 原生的 setInputRegion（X11 input shape），
   非 Linux 走 setIgnoreMouseEvents（macOS/Windows 支持 forward，没有 shape 问题）。

   ⚠ 这里**只允许"整窗接收"与"球带接收"两态，绝不允许"整窗穿透"**。
     踩过的坑：页面里还留着 pointerleave/pointermove 监听（非 overlay 平台要用），
     一旦把 input region 清空，窗口边缘穿过指针会立刻产生 pointerleave，
     页面就 post('hover',{index:-1}) 把 hot 撤掉 —— 球刚亮起来就自己灭，
     主进程随后又把它点亮，来回抖。日志里表现为
       poll lane → hot idx 1 ignore false
       lane → idle      ← 页面自己退的
       lane → hot
     所以 idle 态的 input region 始终保留球带矩形（球带本来就不挡下层），
     "不挡下层"由球带之外的区域天然缺失保证，不靠清空整个 region。 */
function applyInputShape(lane) {
  if (!state.win || state.win.isDestroyed()) return;
  const w = state.win;
  const idle = lane === LANE_IDLE;
  try {
    if (process.platform === 'linux') {
      // ignore 恒为 false：靠 input shape 精确圈定可交互区域，比 ignore 更细。
      w.setIgnoreMouseEvents(false);
      if (typeof w.setInputRegion === 'function') {
        w.setInputRegion(idle ? anchors().region : null);
      }
    } else {
      w.setIgnoreMouseEvents(idle, idle ? { forward: true } : undefined);
    }
  } catch (e) {
    log('applyInputShape:', e.message);
  }
}

function startPoll() {
  if (pollTimer || process.platform !== 'linux') return;
  pollTimer = setInterval(() => {
    try {
      pollHit();
    } catch (e) {
      if (pollStale++ < 3) log('poll error:', e.message);
    }
  }, POLL_MS);
  if (pollTimer.unref) pollTimer.unref();
}

function stopPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

/** 把窗口内的点换算成"命中第几个球"，供诊断与自测用。
    球的几何必须和 orbs.html 的 CSS 完全一致：
      · dock 在窗口内水平居中（overlay 模式加 shift 偏移），宽 = m.dockW
      · 球顶贴窗口底边往上 dockH - padBottom，即球占 [winH-dockH, winH-padBottom]
      · top 停靠时镜像到窗口顶边 */
function hitAt(px, py) {
  const a = anchors();
  const c = cfg();
  if (laneAt(px, py) !== LANE_HOT) return -1;
  const m = a.metrics;
  const padBottom = 3;
  const lift = cfg().size * 0.62;
  const dockLeft = a.bands.dock.left;
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
  applyInputShape(LANE_IDLE);
  state.lane = LANE_IDLE;
  state.ignoring = true;
  startPoll();

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

  /* ── 启动体检 ──
     症状：壳起来了、窗口在正确位置，但球永远不出现，日志里连一条 page: 都没有。
     根因可能有三层，逐层取证，否则只能瞎猜：
       ① 页面文件根本没加载（路径错/环境变量没传）→ did-fail-load
       ② preload 没注入（沙箱/contextIsolation 组合问题）→ window.orbs 不存在
       ③ 页面脚本抛错但 console 事件没绑上 → 主动 executeJavaScript 探一下
     这三行日志是"球不出现"时唯一能定位问题的证据，不要删。 */
  win.webContents.on('did-finish-load', () => {
    log('did-finish-load url=' + win.webContents.getURL());
    win.webContents
      .executeJavaScript(
        '({orbs: typeof window.orbs, hasDock: !!document.getElementById("dock"), balls: document.querySelectorAll(".ball").length})',
        true
      )
      .then((r) => log('page probe: ' + JSON.stringify(r)))
      .catch((e) => log('page probe 失败: ' + e.message));
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log('did-fail-load code=' + code + ' desc=' + desc + ' url=' + url);
  });
  win.webContents.on('preload-error', (_e, p, err) => {
    log('preload-error path=' + p + ' msg=' + (err && err.message));
  });

  win.once('ready-to-show', () => {
    log('ready-to-show → showInactive');
    win.showInactive();
    repaint(true);
    try {
      log('after show: visible=' + win.isVisible() + ' bounds=' + JSON.stringify(win.getBounds()));
    } catch (_) {}
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
  //   shift：overlay 模式下球列的水平偏移（cfg.offset + 拖动实时量），页面据此平移 dock。
  state.win.webContents.send('state', { type: 'state', repos: state.repos, cfg: c, shift: Math.round((c.offset || 0) + (state.dragShift || 0)) });
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
    if (process.platform === 'linux') {
      // overlay 模式：窗口不动，拖动改的是"球列在窗口内的水平偏移"
      state.drag = { shift0: (cfg().offset || 0), px0: null, py0: null, wa: anchors().workArea };
    } else {
      const b = state.win.getBounds();
      state.drag = { x0: b.x, y0: b.y, px0: null, py0: null, wa: anchors().workArea };
    }
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
    if (process.platform === 'linux') {
      const dx = Math.round(m.screenX - d.px0);
      const half = Math.round(d.wa.width / 2);
      state.dragShift = Math.round(Math.min(Math.max(d.shift0 + dx, -half), half));
      // 实时把偏移推给页面（窗口不动，页面里球跟着走）
      pushState();
      return;
    }
    const b = state.win.getBounds();
    const nx = Math.round(Math.min(Math.max(d.x0 + (m.screenX - d.px0), d.wa.x - 40), d.wa.x + d.wa.width - 40));
    const ny = Math.round(Math.min(Math.max(d.y0 + (m.screenY - d.py0), d.wa.y - 40), d.wa.y + d.wa.height - 40));
    state.dragPreview = { x: nx, y: ny };
    place(nx, ny, b.width, b.height);
    return;
  }
  if (channel === 'dragend') {
    const d = state.drag;
    if (process.platform === 'linux') {
      // dragShift = shift0(=dragstart 时的 cfg.offset) + 拖动增量，即拖完的总偏移
      const total = Math.round(state.dragShift);
      state.drag = null;
      state.dragShift = 0;
      if (d) send({ type: 'dragcommit', offset: total });
      pushState();
      return;
    }
    const prev = state.dragPreview;
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
          /* workArea 单独给一份：扩展侧自检要显示它，之前只给了 displays 数组，
             自检读到 undefined —— 看起来像"屏幕信息获取失败"，其实是没这个字段。 */
          workArea: (() => {
            try {
              return workAreaFor(anchorWin);
            } catch (_) {
              return null;
            }
          })(),
          displays: screen.getAllDisplays().map((d) => ({ id: d.id, workArea: d.workArea, scale: d.scaleFactor })),
          drag: !!state.drag,
        },
      });
      break;
    }
    /* 自测专用：把球窗口自己截一张图存下来。
       容器里没有 import/xwd 之类的截图工具，而"球到底长什么样"
       只能靠截图回答 —— capturePage 是 Electron 自带的，不依赖外部命令。 */
    case 'screenshot': {
      if (!state.win || state.win.isDestroyed()) {
        send({ type: 'shot', id: m.id, error: 'no-window' });
        break;
      }
      state.win.webContents
        .capturePage()
        .then((img) => {
          const p = m.path || path.join(app.getPath('home'), '.branch-orbs', 'shot.png');
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, img.toPNG());
          send({ type: 'shot', id: m.id, path: p, size: img.getSize() });
        })
        .catch((e) => send({ type: 'shot', id: m.id, error: e.message }));
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
    /* 自测专用：把页面真实的 DOM 状况吐出来。
       "球不出现"时最需要知道的是：页面收到了 repos 吗？DOM 里有没有球节点？
       这些答案只在 renderer 里，主进程看不到，所以留一个查询口。 */
    case 'probe-dom': {
      if (!state.win || state.win.isDestroyed()) {
        send({ type: 'dom-probe', id: m.id, error: 'no-window' });
        break;
      }
      state.win.webContents
        .executeJavaScript(
          `(function(){
             var dock = document.getElementById('dock');
             /* 球的真实类名是 .orb（不是 .sw —— 那是早期版本的名字）。
                选错选择器会得到 balls:0 的假象，误判成"球没画出来"。 */
             var orbs = dock ? dock.querySelectorAll('.orb') : [];
             var styles = dock ? getComputedStyle(dock) : null;
             return {
               balls: orbs.length,
               orbSizes: Array.prototype.map.call(orbs, function(o){
                 var r = o.getBoundingClientRect();
                 return Math.round(r.width) + 'x' + Math.round(r.height) + (o.classList.contains('active') ? '*' : '');
               }),
               dockChildren: dock ? dock.children.length : -1,
               dockRect: dock ? (function(r){return {w:Math.round(r.width),h:Math.round(r.height)};})(dock.getBoundingClientRect()) : null,
               dockDisplay: styles ? styles.display : null,
               dockOpacity: styles ? styles.opacity : null,
               bodyClass: document.body.className,
               bodyHTMLlen: document.body.innerHTML.length,
             };
           })()`,
          true
        )
        .then((r) => send({ type: 'dom-probe', id: m.id, data: r }))
        .catch((e) => send({ type: 'dom-probe', id: m.id, error: e.message }));
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
