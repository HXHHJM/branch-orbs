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
const os = require('os');
const readline = require('readline');

if (process.env.BRANCH_ORBS_USER_DATA) {
  app.setPath('userData', process.env.BRANCH_ORBS_USER_DATA);
}

/* ⚠⚠⚠ 这一整段是"球一直不出现"的最终根因，改之前务必读完。

   原来的写法：
     app.commandLine.appendSwitch('ozone-platform', 'x11')
   **不生效**。Ozone 平台的选择发生在 Chromium 初始化最早期
   （electron_main_delegate 里就定了），比 JS 入口更早；
   JS 里的 appendSwitch 只是在事后往命令行尾部补一条，平台早选完了。
   于是壳跑在 **Wayland ozone 后端**上，连锁假象（全部实测）：

     · Electron 自认为正常：isVisible()=true，getBounds() 精确正确
     · 球其实画在 Wayland 面上，看不到 X 窗口
     · X11 侧只留一个占位窗口，id 恒为 0x1（非法 ID）
     · 日志：XGetWindowAttributes failed for window 1
     · getNativeWindowHandle() → 0x1；xprop -id 0x1 → BadWindow
     · xwininfo -root -tree 里永远没有那个 48×50 的窗口
   ——也就是说我们之前所有的 X 校验，都在查一个根本不存在的窗口。

   正解：--ozone-platform=x11 必须作为**进程命令行参数**传入
   （见 src/launcher.js 的 launchArgs）。实测对比：
     仅 appendSwitch → handle=0x1，X 树里无此窗口
     命令行传参     → handle=0x2400004，xwininfo 可见 65x68，
                      _NET_WM_WINDOW_TYPE_NORMAL，WM_STATE: Normal  ✅

   下面的自愈逻辑在 log() 定义之后（见文件后部「ozone 自愈」段），
   因为它要用 log()，而 log 依赖 logFile 常量，放这里会 TDZ 崩。 */
const WANT_OZONE = process.env.BRANCH_ORBS_OZONE || 'x11';
const ozoneOnArgv = process.argv.some((a) => /^--ozone-platform=/.test(a));
/* 先无条件补一条 appendSwitch：对少数构建仍然有效，且完全无害。
   真正兜底的重启逻辑在 log() 定义之后执行。 */
if (process.platform === 'linux' && WANT_OZONE === 'x11') {
  app.commandLine.appendSwitch('ozone-platform', 'x11');
}

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
/* ⚠ 关闭 occlusion tracker：XWayland 上它会把"无焦点 + 铺满工作区的透明窗口"
   误判为被遮挡 → Chromium 停止产帧 → 球"出现过一下然后永久消失"。
   实测证据链：启动 2s 时 capturePage 有 849 个彩色像素（页面在画），
   一小时后 xlib GetImage 读窗口内容全 0（帧没提交到 X）。
   命令行（launcher.js BASE_FLAGS）是主通道；appendSwitch 是
   re-exec/直接 node shell 路径的兜底。双保险无害。 */
app.commandLine.appendSwitch(
  'disable-features',
  'CalculateNativeWinOcclusion'
);
if (process.platform === 'linux' && process.getuid && process.getuid() === 0) {
  // root 下 Chromium 拒绝启用沙箱，必须显式关闭，否则启动即 FATAL
  app.commandLine.appendSwitch('no-sandbox');
}

/* ── 透明窗口在 Wayland 宿主 + XWayland 客户端下必须走软件合成 ──
   ⚠ 这是"球一直不出现"的最后一层根因，日志证据链：
       createWindow {"x":0,"y":0,"width":1920,"height":1080}   ← 尺寸算对了
       after show: visible=true bounds={...1920x1080}          ← Electron 认为显示了
       XGetWindowAttributes failed for window 1                ← 但 X 上根本没有这个窗口
       GPU process exited unexpectedly: exit_code=139          ← SIGSEGV，连崩 3 次
     `_NET_CLIENT_LIST` 里查不到 branch-orbs —— 窗口**从未被 map**。
     原因：宿主桌面是 Wayland 原生会话（VSCode 自己跑 --ozone-platform=wayland），
     而壳被我们强制成 x11（XWayland）。这种"Wayland 宿主 + XWayland 客户端"混合形态下
     Chromium 的 GPU 进程拿不到可用的合成后端，崩溃后 renderer 无法提交首帧，
     于是 mutter 永远不 map 这个窗口。
     对策：强制软件渲染。悬浮球本身是纯 CSS（圆 + 径向渐变 + 阴影），
     软件合成完全够用，帧率不成问题（页面是静止的，只有 hover 时一次 transform 过渡）。
     顺带把日志里那两条 "Failed to create shader cache" 也消掉。 */
/* 用 app.disableHardwareAcceleration() 而不是 --disable-gpu 命令行开关：
   ⚠ 两者的区别非常实际 ——
     · `--disable-gpu` 会让 Chromium 连 GPU 进程都不启动，
       Playwright 的 --remote-debugging-pipe 握手会超时（"Process failed to launch!"），
       自测从此跑不起来，等于为了修一个显示 bug 把回归网拆了。
     · `app.disableHardwareAcceleration()` 只把合成器切到软件路径
       （内部就是 --disable-gpu-compositing），GPU 进程照常存在，
       CDP 握手正常，自测能跑。
   而且必须放在 app.whenReady() 之前调用才有效，所以写在模块顶层。 */
if (process.platform === 'linux') {
  app.disableHardwareAcceleration();
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

/* ── ozone 自愈：命令行没带 --ozone-platform=x11 就重启自己 ──
   ⚠ 为什么必须重启而不是"补一下开关"：
     走到这一行时 Chromium 的平台早已选定（Wayland），JS 再怎么 appendSwitch
     都改不回来 —— 这正是本 bug 的本质。唯一的修法是用正确的命令行重新 exec。
     子进程继承 stdin/stdout，扩展侧的 JSONL 协议完全无感。
     加 BRANCH_ORBS_OZONE_REEXEC 防递归：万一子进程也认为没带，就认命继续跑。 */
if (process.platform === 'linux' && WANT_OZONE === 'x11' && !ozoneOnArgv &&
    !process.env.BRANCH_ORBS_OZONE_REEXEC) {
  try {
    const { spawn } = require('child_process');
    /* process.argv[1] 起是"应用路径 + 应用参数"。
       要在**应用路径之前**插入开关 —— 找到第一个真实存在的目录参数。 */
    const rest = process.argv.slice(1);
    const at = rest.findIndex((a) => {
      try { return fs.statSync(a).isDirectory(); } catch (_) { return false; }
    });
    const next = rest.slice();
    next.splice(at < 0 ? 0 : at, 0, '--ozone-platform=x11');
    log('ozone 平台未在命令行指定 → 用 --ozone-platform=x11 重启壳（球可见的前提）');
    const child = spawn(process.execPath, next, {
      env: { ...process.env, BRANCH_ORBS_OZONE_REEXEC: '1' },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    try { process.stdin.pipe(child.stdin); } catch (_) {}
    child.stdout.pipe(process.stdout);
    child.on('exit', (code) => process.exit(code == null ? 0 : code));
    child.on('error', (e) => log('ozone 重启失败:', e.message));
    /* 本进程就地停摆：不建窗口、不抢日志，等子进程接手后随父进程退出。 */
    setInterval(() => {}, 1 << 30);
  } catch (e) {
    log('ozone 自愈失败（继续按 appendSwitch 跑，球可能不可见）:', e.message);
  }
} else if (process.platform === 'linux' && ozoneOnArgv) {
  log('ozone 平台: 命令行已带 --ozone-platform=x11 ✓');
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
  /* ── 透明能力探测结果 ──
     transparent:true 的窗口必须有合成器（_NET_WM_CM_S0）才会被 map；
     没有合成器时窗口创建成功、像素也渲染了，但 map 失败 → 屏幕空白。
     探测到没有合成器就降级成"不透明小窗"，用实心底色代替透明。 */
  opaque: false,
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

/* ── 工作区：**以 X 的 _NET_WORKAREA 为准**，不信 Electron ──

   ⚠ 这是"球跑到屏幕中上部"的最后一颗钉子，实测数据：
       Electron screen.getPrimaryDisplay().workArea → {x:0, y:0,  width:1920, height:1080}
       X  _NET_WORKAREA（mutter 真正设的）        → {x:0, y:31, width:1920, height:987}
     差 31px 顶栏。overlay 窗口按 1080 高铺满后，球被画到 y≈1050 一线；
     GNOME 顶栏 + 缩放下这 31px 让球整体偏出可视区，
     看起来就是"球不知道跑哪去了"。
     根因：XWayland 下 Electron 的 screen API 从 RandR 拿整屏尺寸，
     没有把 mutter 的 workarea 避让算进去。

   为什么不用 anchorWin 反推：VSCode 主窗口最大化时它的矩形恰好≈工作区，
     但窗口没最大化时（用户拖成小窗）反推会得到错的值，球会跟着窗口跑。

   实现：壳进程自己是个 Node 进程，没有 xlib，所以 spawn 一个 python 小脚本读。
     只读一次并缓存（工作区只有在分辨率/顶栏变化时才会变）。
     读不到就退回 Electron 的 workArea —— 至少 Xorg 会话下是对的。 */
let cachedWA = null;
let waTried = false;
function xWorkArea() {
  if (cachedWA) return cachedWA;
  if (waTried) return null; // 试过一轮就够，别在每次 anchors() 里重复 spawn
  waTried = true;
  if (process.platform !== 'linux') return null;
  const script = path.join(__dirname, '..', 'src', 'workarea.py');
  if (!fs.existsSync(script)) return null;
  for (const py of pythonCandidates()) {
    try {
      const out = require('child_process').execFileSync(py, [script], {
        encoding: 'utf8',
        timeout: 3000,
        env: process.env,
      });
      const r = JSON.parse((out || '').trim().split('\n').pop() || '{}');
      if (r && r.ok) {
        /* ⚠⚠ 坐标系必须统一到 **Electron 的逻辑像素（DIP）**，这是本轮另一个
           隐蔽的根因，实测数据：
             · _NET_WORKAREA（X 物理像素）：{0,31,1920,987}
             · screen.getPrimaryDisplay().workArea（DIP）：{0,26,1661,855}
             · scaleFactor = 1.15625
           1920 / 1661 ≈ 1.156、987 / 855 ≈ 1.15 —— 同一个东西的两套坐标。
           而 Electron 的 BrowserWindow 构造函数和 setBounds 收的都是**DIP**。
           原来直接把 X 的 1920×987 当成 DIP 传进去，等于请求了一个
           1920 DIP = 2220 物理像素的窗口 —— 这也是日志里一直看到
           "X 报 2220x1142" 的真正原因（不是装饰！）。
           副作用：窗口比工作区大一圈，球的"居中"算在错的基准上，
           水平看着偏、下沉被裁、卡片位置也错。

           正确做法：**位置和尺寸以 Electron 的 workArea 为准**，
           X 只用来借"顶部有没有被顶栏占掉"这个信息（Wayland 下
           Electron 的 workArea 有时不带顶栏高度）。 */
        const ed = screen.getPrimaryDisplay();
        const ewa = ed.workArea;
        const sf = ed.scaleFactor || 1;
        /* 把 X 的物理 y 偏移换算成 DIP，与 Electron 的取较大者（谁扣得多信谁） */
        const xTopDip = Math.round(r.y / sf);
        const topDip = Math.max(ewa.y, xTopDip);
        cachedWA = {
          x: ewa.x,
          y: topDip,
          width: ewa.width,
          height: Math.max(1, ewa.y + ewa.height - topDip),
        };
        log('workArea（DIP）:', JSON.stringify(cachedWA),
          '| Electron', JSON.stringify(ewa), '| X 物理', JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height }),
          '| scale', sf, '| py', py);
        return cachedWA;
      }
      log('workArea 读不到（' + py + '）:', r && r.error);
    } catch (e) {
      log('workArea 脚本失败（' + py + '）:', e.message);
    }
  }
  log('workArea：所有解释器都拿不到 _NET_WORKAREA，退回 Electron workArea（Wayland 下会偏一个顶栏）');
  return null;
}

/* 候选解释器，按"更可能有 python-xlib"排序。
   ⚠ 踩过的坑：首版只试 python3 / /usr/bin/python3，而系统 python3 没装 Xlib，
     日志刷三行 "no-xlib: No module named 'Xlib'"，workArea 退回 Electron 的整屏值，
     球又跑回屏幕中上部 —— 和没修一模一样。
     xwin.py 早就依赖 python-xlib（点击球控窗在用），所以**它自己就是最好的探针**：
     哪个解释器能 import Xlib，就用哪个。
   顺序：
     ① BRANCH_ORBS_PY 显式指定（用户兜底）
     ② pi 安装的那套 venv（本机就是它，实测 Xlib 0.33 可用）
     ③ python3 / python（PATH 里的，可能装了也可能没有）
     ④ /usr/bin/python3（系统自带的，通常没有 Xlib，但别漏） */
function pythonCandidates() {
  const list = [];
  const add = (p) => {
    if (p && !list.includes(p)) list.push(p);
  };
  add(process.env.BRANCH_ORBS_PY);
  // WorkBuddy 托管 venv：路径固定，且 xwin.py 也是用这套跑通的
  add('/home/hy/.workbuddy/binaries/python/envs/default/bin/python');
  // 用户家目录下的常见 venv 位置（换机器时兜底）
  add(path.join(os.homedir(), '.branch-orbs', 'venv', 'bin', 'python3'));
  add('python3');
  add('python');
  add('/usr/bin/python3');
  return list;
}

function workAreaFor(rect) {
  const d = rect && typeof rect.width === 'number'
    ? screen.getDisplayMatching(rect)
    : screen.getPrimaryDisplay();
  const ew = d.workArea;
  /* ⚠ xWorkArea() 返回的已经是**换算好的 DIP**（见其内部注释：
     _NET_WORKAREA 是物理像素，除以 scaleFactor 才是 DIP）。
     这里直接整块用它，绝不能再混回 X 的 width/height ——
     原来写的是 `{x: ew.x, y: xw.y, width: xw.width, height: xw.height}`，
     把 DIP 的 y 和物理像素的 width/height 拼在一起，
     于是窗口尺寸算成 1920×987（DIP），而真正的工作区只有 1661×855。
     表现就是"窗口比工作区大一圈、球看起来偏、下沉被裁"。
     现在整块取一个来源，保证同一坐标系。 */
  const xw = xWorkArea();
  if (xw) return { x: xw.x, y: xw.y, width: xw.width, height: xw.height };
  return ew;
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

  /* ── Linux：铺满工作区 + shape 裁剪（最终方案，实测通过） ──

     ⚠ 这一段的每个数字都是**实测**的，不是推测。同一份 Electron 43.7.7
     （ozone=x11，mutter/XWayland），各种窗口形态下 X 报告的实际几何：

       请求                      X 实际                Δ位置      判定
       1920×987 @0,31          1924×996 @0,34       (+0,+3)    ✅ 准（铺满工作区）
       1920×58  @0,960         1924×74  @0,1000     (+0,+40)   x准，y被往下推
       1920×120 @0,923         1924×148 @0,981      (+0,+58)   x准，y被往下推
       1920×200 @0,?           1924×238 @0,33       (+0,?)     高度超了就推
       960×120  @480,923       1115×148 @555,870    (+75,-53)  ❌ 全偏
       48×58    @936,949        65×77  @1081,941    (+145,-8)  ❌ 全偏

     规律：
       · **窗口宽度 = 工作区宽度 → x 精确**；不够宽就立刻偏（mutter 重排）
       · **窗口高度 = 工作区高度 → y 也精确**；不够高就被往下推，
         推到超过屏幕下沿也不管（"底边溢出"就是这么来的）
       —— 也就是说，**只有"铺满整个工作区"这一种形态 mutter 完全不干预**。
       小窗无论怎么摆都会被重排 100px 以上，而且偏移量随尺寸变，补偿不准。

     所以正解是：窗口铺满工作区（位置天然精确），再用 **setShape** 把
     "可见区域 + 可接收鼠标的区域"裁成只有球带那一条。
     实测这条组合的结果：
       X 几何 1924×996 @0,34           ← 位置准
       Window shape extents: ...x167+...  ← 只剩底部 167px 高的一条
     于是：位置准 + 不再挡住整个桌面。

     ⚠ 为什么必须用 setShape 而不是 setInputRegion：
       Electron 43.7.7 **没有 setInputRegion**（实测 typeof 为 undefined），
       原来那段 `if (typeof w.setInputRegion === 'function')` 的分支
       从来没执行过 —— 等于 overlay 一直在拦截整个桌面的点击。
       setShape 同时裁剪绘制与输入，是当前版本唯一可用的工具。
       代价：球要"上探/展开卡片"时必须同步更新 shape（见 syncShape()）。 */
  const OVERLAY = process.platform === 'linux' && !state.opaque;
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

  /* dock 的水平范围（窗口内坐标）：laneAt / hitAt 的横向门禁。
     满宽条模式下窗口 = 整个工作区宽度，所以球的水平偏移完全由页面内
     --dock-shift 表达，窗口 x 永远不动（也就不会触发 mutter 重排）。 */
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
     ⚠ 满宽条本身就只覆盖球带那一条（不像 overlay 铺满整个桌面），
       所以即便 shape 完全失效，也只会拦住屏幕底部那 100 多像素，
       不会"点桌面任何地方都没反应"。
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

  state.overlayMode = OVERLAY;
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

/* lane 的唯一写入者是 pollHit（Linux）——见 onPage('hover') 处那段注释。
   这里保留给 click / context / dragstart / 右键菜单回调这类"非指针驱动"的
   一次性切换：它们确实需要立刻改 shape（比如菜单弹出时必须让卡片区可点），
   但下一帧 pollHit 会按真实指针位置重新收拢，所以不会打架。 */
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

/* ── 从 X 读指针位置（常驻子进程） ────────────────────────────
   ⚠⚠ 为什么不能用 screen.getCursorScreenPoint()：**它在 XWayland 下是死的**。
   实测同一台机器（Electron 43.7.7 + ozone=x11 + GNOME Wayland 宿主）：

       X 侧 XQueryPointer  → 700,500        （XTEST 把指针搬过去了）
       Electron EPTR       → 345,259        （纹丝不动）
       再搬到 400,300
       X 侧 XQueryPointer  → 400,300
       Electron EPTR       → 345,259        （还是不变）

   也就是说：窗口在、球画出来了、日志干净，但鼠标压上去毫无反应，
   因为主进程拿到的光标位置永远是启动时那一个点。
   整个 overlay 悬停机制都建在这个 API 上，所以它一失效，交互全废。

   修法：指针位置从 **X 侧**读（XQueryPointer 才是真实位置）。
   为了不每帧 fork（python 启动 ~35ms 比 32ms 轮询周期还长），
   做成**常驻进程**：stdin 写一行 → stdout 回一行 JSON，往返 < 1ms。
   见 src/pointer.py。

   ⚠ 坐标单位：XQueryPointer 返回**物理像素**，而窗口几何是 DIP。
     必须除以 scaleFactor 才能和 lastRect 相减。 */
const pointer = {
  proc: null,
  py: null,
  dead: false,
  last: null,
  pending: false,
  diagLogged: false,
};

function startPointer() {
  if (process.platform !== 'linux' || pointer.proc || pointer.dead) return;
  const script = path.join(__dirname, '..', 'src', 'pointer.py');
  if (!fs.existsSync(script)) { log('pointer.py 缺失，读不到 X 指针'); pointer.dead = true; return; }
  for (const py of pythonCandidates()) {
    try {
      const p = require('child_process').spawn(py, [script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
      p.on('error', () => {});
      p.stdout.setEncoding('utf8');
      let buf = '';
      p.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          try {
            const r = JSON.parse(line);
            if (r && r.ok) {
              pointer.last = { x: r.x, y: r.y, at: Date.now(), phys: true };
            }
          } catch (_) {}
        }
      });
      p.stderr.on('data', () => {});
      p.on('exit', () => { pointer.proc = null; });
      pointer.proc = p;
      pointer.py = py;
      log('指针读取器已启动（XQueryPointer，常驻）:', py);
      return;
    } catch (_) {}
  }
  pointer.dead = true;
  log('⚠ 指针读取器启动失败 —— 悬停将不可用（screen.getCursorScreenPoint 在 XWayland 下无效）');
}

function stopPointer() {
  if (!pointer.proc) return;
  try { pointer.proc.stdin.end(); } catch (_) {}
  try { pointer.proc.kill(); } catch (_) {}
  pointer.proc = null;
}

/* 请求一次指针位置（异步：写一行 stdin，结果落在 pointer.last）。
   ⚠ 不要在这里等回包（会阻塞事件循环），轮询本来就是 32ms 一次，
     拿到的是"上一帧请求的结果"，延迟一帧完全可以接受。

   ⚠ pending 用**时间窗**而不是"收到回包才清"：
     初版靠 stdout 回包清标记，一旦某次回包丢了（进程刚起、管道缓冲、
     kill 竞态），pending 就永久为 true，**指针读取从此彻底停摆**，
     而日志上什么都看不出来 —— 表现就是"悬停完全不响应"。
     现在标记只挡 8ms，最长 8ms 后必然放行下一条请求。 */
function requestPointer() {
  if (!pointer.proc) { startPointer(); return; }
  if (pointer.pending) return;
  try {
    pointer.proc.stdin.write('q\n');
    pointer.pending = true;
    setTimeout(() => { pointer.pending = false; }, 8);
  } catch (_) {
    pointer.proc = null;
    pointer.pending = false;
  }
}

/* 当前指针的屏幕坐标（**DIP**）。优先用 X 的路，拿不到才退回 Electron。 */
function cursorScreen() {
  if (process.platform === 'linux' && pointer.last) {
    const sf = (() => {
      try { return screen.getPrimaryDisplay().scaleFactor || 1; } catch (_) { return 1; }
    })();
    return { x: Math.round(pointer.last.x / sf), y: Math.round(pointer.last.y / sf), src: 'x' };
  }
  try {
    const p = screen.getCursorScreenPoint();
    return { x: p.x, y: p.y, src: 'electron' };
  } catch (_) {
    return null;
  }
}

/* 指针在窗口内的坐标。
   ⚠ 窗口原点必须用 **X 报告的真实几何**（state.lastRect，由 place() 刷新），
     不能用 getBounds()，更不能用自己记的请求值。实测两条都会错：
       · 请求值 936,960  → X 实际 1070,949  （mutter 重定位）
       · getBounds 935,967 / 49x51 → X 实际 79x81（Chromium 把 content/frame 混了）
     偏差大到这种程度时，指针明明压在球上，算出来的坐标却在窗外：
     hitIdx 恒 -1、lane 恒 IDLE，30fps 每帧在 hot/idle 之间翻，
     日志里是十几条/秒的抖动，而球永不亮起、点击穿透判定也全乱。 */
let geomRefreshAt = 0;
function cursorInWin() {
  if (!state.win || state.win.isDestroyed()) return null;
  const p = cursorScreen();
  if (!p) return null;
  const now = Date.now();
  /* 兜底：万一 place() 还没跑过（首帧前），先拿 getBounds 顶上。
     ⚠ 只在 lastRect 为空时用 getBounds —— 它含偏差，
       长期拿它当基准指针判定会偏 9~10px。 */
  if (!state.lastRect || now - geomRefreshAt > 5000) {
    geomRefreshAt = now;
    if (!state.lastRect) {
      try { state.lastRect = state.win.getBounds(); } catch (_) { return null; }
    }
  }
  const r = state.lastRect;
  return { x: p.x - r.x, y: p.y - r.y, screen: p, rect: r, src: p.src };
}

function pollHit() {
  if (!state.win || state.win.isDestroyed() || !state.repos.length) {
    if (pollStale++ < 2) {
      log('poll 跳过: win=' + !!state.win, 'destroyed=' + (state.win ? state.win.isDestroyed() : 'n/a'),
        'repos=' + state.repos.length);
    }
    return;
  }
  const c = cursorInWin();
  if (!c) { if (pollStale++ < 2) log('poll 跳过: cursorInWin 返回 null'); return; }
  const a = anchors();
  const inside = c.x >= 0 && c.y >= 0 && c.x <= a.win.width && c.y <= a.win.height;
  const idx = inside ? hitAt(c.x, c.y) : -1;
  /* 诊断：前几次轮询把光标与窗口的相对坐标打出来，能立刻看出坐标系对不对 */
  /* 诊断：只在 idx 变化时打一条，避免 32ms 刷屏。
     ⚠ 之前的写法是"前 8 次都打"，结果诊断全用在指针移动之前，
     warp 之后的判定一条都没记录下来 —— 等于白打。 */
  if (idx !== state.diagIdx) {
    state.diagIdx = idx;
    log('cursor', c.x + ',' + c.y, 'win', a.win.width + 'x' + a.win.height,
      'rect', JSON.stringify(state.lastRect), 'inside', inside, 'idx', idx,
      'dock', JSON.stringify(a.bands.dock));
  }
  /* ⚠⚠ lane 必须与 idx **同源**，这里踩过一个自激振荡，值得记下来：

     原来写的是  lane = laneAt(c.x, c.y)，而 laneAt 的判据比 hitAt 宽松得多
     （laneAt：球列 ±8px、纵向整条 hot 带；hitAt：球心 ±(D/2+5)、纵向含上探余量）。
     于是出现 "lane=HOT 但 idx=-1" 的状态：
       lane=HOT → applyInputShape 把 input region 放大到整窗
                → 指针瞬间落在"窗口内但不在球上"的位置
                → 浏览器发现指针离开了原来的元素 → pointerleave 冒出来
                → 页面 post('hover',{index:-1})，而页面里的 driverHot 保护
                  只在 __orbsHover 被调用过之后才生效；idx=-1 时这个函数
                  **没被调用**，保护形同虚设 → 页面自己把 hot 撤了
                → setLane(IDLE) 收窄 shape → 指针又回到球带 → lane=HOT …
     30fps 下就是日志里那种十几条/秒的 "lane → hot"/"lane → idle" 抖动，
     球反复闪、点击穿透判定也跟着乱。
     把 lane 绑定到 idx 之后，"进了球才算 HOT"，振荡的回路被切断。 */
  const lane = inside && idx >= 0 ? LANE_HOT
    : (inside && cfg().showCard && c.y >= a.bands.card.top - 2 && c.y <= a.bands.card.bottom + 2)
      ? LANE_CARD : LANE_IDLE;
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
  /* ⚠ 判据用 **lane** 而不是 ignoring：ignoring 是给 setIgnoreMouseEvents 记账的，
     而 Linux 上那条路根本不走（见 applyInputShape）。用 ignoring 判断会出现
     "lane 变了但 ignoring 没变 → 不刷新 shape" → 球上探的那一截被裁掉。
     现在 lane 是唯一入口：变了才重算 shape。 */
  if (lane !== state.lane) {
    state.lane = lane;
    state.ignoring = lane === LANE_IDLE;
    applyInputShape(lane);
    log('poll lane →', lane, 'idx', idx, 'ignore', state.ignoring);
    pushProbe();
  }
}

/* ── 用 setShape 把"可见 + 可点击"的区域裁成球带那一条 ──

   ⚠⚠ 两个必须记住的事实：

   ① **Electron 43.7.7 没有 setInputRegion**（实测 typeof 为 undefined）。
      原代码写的是 `if (typeof w.setInputRegion === 'function') { ... }`，
      分支从来没执行过 —— 也就是 overlay 一直在拦截整个桌面的点击，
      而日志干净、无异常，属于最难发现的一类 bug。
      现在显式探测并打印，缺了就走 setShape。

   ② **setShape 同时裁剪绘制与输入**（X Shape 的 bounding + input 两套）。
      实测生效：xwininfo -shape 报
        Window shape extents: 2220x167+0+1041
      即只剩底部一条，桌面其余部分完全穿透。

   代价：球"上探 / 弹卡片"时可见区域变大，shape 必须同步放大，
   否则上探的那一截和卡片会被裁掉（看起来像"球悬停后消失"）。
   所以 shape 按当前 lane 取：
     IDLE → 只有球带（最严格，桌面完全不被打扰）
     HOT/CARD → 球带上探段 + 卡片段（够球和卡片用，仍不覆盖整个桌面）

   ⚠ 不要用"整窗 shape = null"来图省事：overlay 铺满工作区时，
     那等于把一个透明窗口盖在整个桌面上，点击全被吃掉。 */
let shapeLogged = false;
function syncShape(lane) {
  if (!state.win || state.win.isDestroyed()) return;
  const w = state.win;
  if (process.platform !== 'linux') return;
  if (!state.overlayMode) {
    /* 非 overlay（没有合成器时的降级小窗）：窗口本来就只占球带，
       不需要 shape。但若 Electron 有 setInputRegion 就用它。 */
    try {
      if (typeof w.setInputRegion === 'function') w.setInputRegion(anchors().region);
    } catch (_) {}
    return;
  }
  const a = anchors();
  const idle = lane === LANE_IDLE;
  /* 矩形一律按"窗口内坐标"给，且必须夹在窗口范围内 ——
     setShape 传越界矩形在部分版本上会整块失效（表现为什么都不显示）。 */
  const clamp = (x, y, ww, hh) => ({
    x: Math.max(0, Math.round(x)),
    y: Math.max(0, Math.round(y)),
    width: Math.max(1, Math.round(ww)),
    height: Math.max(1, Math.round(hh)),
  });
  const bands = a.bands;
  /* ⚠⚠⚠ setShape 的 Rect 是**物理像素**，不是 DIP —— 这是本轮最贵的一课。

     实测链条（球亮一下就灭、指针被"弹开"）：
       球带 in DIP（窗口内）      y = 824 .. 854
       换算到屏幕物理            y = 983 .. 1018   （窗口物理原点 y=31，scale=1.15625）
       我传的 setShape 矩形       {y:797, h:57}     ← DIP
       X 实际理解的覆盖范围       y = 828 .. 885    ← 直接当物理用
     两者错位 155px：**shape 把球本身裁在了外面**。

     视觉上看不出来（裁掉的区域本来就透明），但指针一旦压到球上，
     它就落在"窗口 shape 之外"的位置 —— X 认为指针下面是桌面的空白，
     于是把指针弹走（实测弹到 (784,487)），主进程下一次轮询读到
     idx=-1 → 卡片收回 → 球落回。表现就是"悬停闪一下就没了"。

     对照实验（同一台机器，不启动 Electron）：纯 XTEST warp 到 (961,1009)，
     2.5 秒内指针纹丝不动 —— 证明搬走指针的是我们自己的 setShape。

     所以这里必须乘 scaleFactor。用 X 报告的真实窗口原点不方便（它是屏幕
     坐标，而 shape 要的是窗口内坐标），直接用 Electron 的 scaleFactor 即可：
     窗口内 DIP × scaleFactor = 窗口内物理。 */
  const sf = (() => {
    try { return screen.getPrimaryDisplay().scaleFactor || 1; } catch (_) { return 1; }
  })();
  const rects = [];
  let topDip;
  if (idle) {
    /* 静止态：只留球带（球本体 + 上探余量用满，避免刚命中时被裁） */
    topDip = Math.max(0, bands.hot.top);
  } else {
    /* 交互态：球带上探段 + 卡片段。两段分别给，别合并成一大块。 */
    topDip = Math.max(0, Math.min(bands.hot.top, bands.card.top));
  }
  /* 先把 DIP 矩形算好，再整体换算到物理。宽度/高度也要乘 —— 只乘位置不乘尺寸
     会得到一条"位置对了但高度不够"的窄带，球的下半部分照样被裁。 */
  const dipRect = {
    x: 0,
    y: topDip,
    width: a.win.width,
    height: a.win.height - topDip,
  };
  const physRect = {
    x: Math.round(dipRect.x * sf),
    y: Math.round(dipRect.y * sf),
    width: Math.round(dipRect.width * sf),
    height: Math.round(dipRect.height * sf),
  };
  rects.push(clamp(physRect.x, physRect.y, physRect.width, physRect.height));
  try {
    if (typeof w.setShape === 'function') {
      w.setShape(rects);
      if (!shapeLogged) {
        shapeLogged = true;
        log('setShape 生效（物理像素）: ' + JSON.stringify(rects) +
          ' | DIP: ' + JSON.stringify(dipRect) + ' | scale ' + sf);
      }
    } else if (typeof w.setInputRegion === 'function') {
      w.setInputRegion(a.region);
    } else if (!shapeLogged) {
      shapeLogged = true;
      log('⚠ 既没有 setShape 也没有 setInputRegion —— overlay 会挡住整个桌面的点击');
    }
  } catch (e) {
    log('syncShape:', e.message);
  }
}

/* 兼容旧名字：内部若干处仍调 applyInputShape。
   Linux/overlay 走 syncShape；其它平台走 setIgnoreMouseEvents。 */
function applyInputShape(lane) {
  if (!state.win || state.win.isDestroyed()) return;
  const w = state.win;
  if (process.platform === 'linux') {
    /* ⚠ Linux 上**永远不要**开 setIgnoreMouseEvents(true)：
       X11 下它是靠把 window 的 input shape 置空实现的，
       而 shape 为空时指针事件根本不会投递到窗口，
       主进程 30fps 轮询虽然还能判定"指针在球上"，
       但 pointerdown 会打在窗外 → 点击永远失效。
       穿透完全交给 syncShape 的矩形裁剪。 */
    try { w.setIgnoreMouseEvents(false); } catch (_) {}
    syncShape(lane);
    return;
  }
  const idle = lane === LANE_IDLE;
  try {
    w.setIgnoreMouseEvents(idle, idle ? { forward: true } : undefined);
  } catch (e) {
    log('applyInputShape:', e.message);
  }
}

function startPoll() {
  if (pollTimer || process.platform !== 'linux') return;
  startPointer();
  pollTimer = setInterval(() => {
    try {
      requestPointer(); // 先发请求，本次用上一次的结果（延迟一帧，可接受）
      pollHit();
    } catch (e) {
      if (pollStale++ < 3) log('poll error:', e.message);
    }
  }, POLL_MS);
  /* ⚠⚠ 绝不能对 pollTimer 调 unref()。这是本轮排查里最阴的一个：
     unref() 的语义是"这个定时器不该让 Node 进程保持存活"，
     而 Electron 主进程的事件循环在"没有任何 ref 定时器"时，
     会把这段时间当成可睡眠窗口 —— 定时器被无限期延后，
     **pollHit 一次都不会跑**。
     症状极具误导性：窗口在、球画出来了、page probe 正常、
     日志干净，只是"悬停完全没反应、点击也没反应"，
     而且每隔很久可能突然跑一次（有其他事件把它唤醒时），
     看起来像"偶发失灵"。
     overlay 模式完全依赖这个轮询（页面收不到 pointer 事件时要靠它判悬停），
     所以它必须保持 ref 状态。进程退出由 app.quit / 窗口关闭负责。 */
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
  /* ⚠⚠ 这里不能一上来就 `if (laneAt(px,py) !== HOT) return -1;`。
     踩过的坑（表现为"悬停闪一下就没了"）：
       指针压在球上 → idx=0 → lane=HOT → 卡片弹出、球上探（transform 抬 lift）
       → 球的视觉位置变了 → 指针相对**新**球位已经"不在球上"
       → hitAt 返回 -1 → lane=IDLE → 卡片收起、球落回
       → 指针又压在球上 → ……
     30fps 下每秒来回十几次，卡片一闪一闪。
     并且卡片本身也在球上方，指针若在卡片上，也应该维持 hot（否则卡片
     刚弹出来就把自己关掉）。

     对策：命中判定用**静止态球位**（不随 hot 的 transform 变），
     并且把卡片带也算作 hot 的延续。这样指针只要还在"球 + 上探区"或
     "卡片区"里，hot 就稳定。 */
  const m = a.metrics;
  const lift = cfg().size * 0.62;
  const dockLeft = a.bands.dock.left;
  const isTop = c.dock === 'top';
  /* 静止态的球位：球贴在窗口底边上方 dockH 那一条里。
     注意**不用 m.winH - m.dockH 这种随窗口变化的量**，
     而是直接用 bands.dock（它由 anchors 按 dockH 算出，与 hot 无关）。 */
  const orbTop = isTop ? a.bands.dock.top : a.bands.dock.bottom - c.size;
  const orbBottom = orbTop + c.size;
  const cy = (orbTop + orbBottom) / 2;
  const halfH = c.size / 2 + lift + 6; // 球本体 + 上探余量 + 手指容差

  // 卡片带：指针在卡片里也算还在这个球上
  const inCard = cfg().showCard &&
    py >= a.bands.card.top - 4 && py <= a.bands.card.bottom + 4 &&
    px >= dockLeft - 12 && px <= dockLeft + m.dockW + 12;

  for (let i = 0; i < state.repos.length; i++) {
    const cx = dockLeft + i * (c.size + c.gap) + c.size / 2;
    const dx = Math.abs(px - cx);
    const dy = Math.abs(py - cy);
    if (dx <= c.size / 2 + 6 && dy <= halfH) return i;
    if (inCard && dx <= c.size / 2 + 20) return i;
  }
  return -1;
}

/* ── "Electron 说显示了，X 上却没这个窗口" ──
   ⚠ 这是"球一直不出现"里最难查的一种：所有 JS 层证据都正常 ——
       createWindow 尺寸正确、after show: visible=true、
       did-finish-load 成功、page probe 拿到 orbs/hasDock、DOM 里有 3 个球…
     但 X 的 _NET_CLIENT_LIST 里根本没有这个窗口，屏幕上一片空白。
     实测触发条件：宿主是 Wayland 会话（XDG_SESSION_TYPE=wayland），
     壳被强制 ozone=x11 走 XWayland，GPU 进程又崩了
     （XGetWindowAttributes failed + GPU exit_code=139）时必然发生。

     对策：show 之后 1.2s 用 X 反查一次"我这个 PID 有没有 mapped 窗口"，
     没有就自动降级重试（关硬件加速 → 再不行就报错给扩展侧显示）。
     不这么做的话，用户只能看到"没有球"，日志全是绿的。 */
/* ── 合成器探测：决定能不能用透明窗口 ──

   ⚠ 这是"球一直不出现"的**真正根因**，前面几轮全在错的方向上修：
     实测日志 page probe 显示球在 DOM 里、尺寸 30×30、opacity 1、有背景色，
     像素体检也在球带扫到 183 个不透明像素 —— **球确实画出来了**。
     但 X map 校验 NOT_MAPPED，扫了 41 个窗口没有我们。

   X 侧实测：
       _NET_SUPPORTING_WM_CHECK → 有（窗口管理器在）
       _NET_WM_CM_S0            → **not found（没有合成器）**
       根窗口 depth             → 24（32 位 ARGB visual 虽存在但无人选用）

   transparent:true 的窗口要求合成器做 alpha 混合。没有合成器时，
   ARGB 窗口在 X 上没有可用的 present 路径（伴随 x11_software_bitmap_presenter
   报 XGetWindowAttributes failed），于是 map 失败 → 像素画在看不见的窗口里。

   对策：先探测，没有合成器就直接用**不透明窗口** + 实心底色。
   视觉上从"圆球浮在桌面上"退化成"一条小色块贴在底边"，
   但它是**真的能看见的** —— 比一个完美的透明球但看不见强得多。 */
function detectCompositor() {
  if (process.platform !== 'linux') return true;
  /* ⚠⚠ 这里改过一次判据，原来的判据是**错的**，代价是球彻底看不见。

     原判据：xprop -root _NET_WM_CM_S0 有值 → 有合成器
     问题：**XWayland 下这个属性永远 not found**。合成器跑在 Wayland 侧
           （mutter 就是 Wayland 合成器），它根本不需要给 XWayland 注册这个选区。
           于是判据恒为 false → 走不透明降级 → 不再用 overlay 模式 →
           退回"48px 小窗"形态 → 被 mutter 重排到偏 145px 的地方 →
           看起来像"球没出现/球跑偏了"。

     正确判据：**看 X 是否提供 32 位 ARGB visual**。透明窗口必须建立在
       depth=32 的 visual 上；合成器在场时 XWayland 一定会导出 ARGB visual。
       实测本机：`xwininfo -id <窗口>` 报 Depth: 32 —— 透明窗口创建成功，
       说明合成器一直在，只是 _NET_WM_CM_S0 不认。
     辅助判据：GNOME Shell 在跑（_NET_SUPPORTING_WM_CHECK）也说明有合成器
       （mutter 是自合成 WM，Wayland 侧统一合成）。

     ⚠ 另外必须知道：overlay（铺满工作区）不只是"为了不依赖定位"，
       它是**唯一位置准确的形态**。实测同一份代码：
         铺满工作区 1920×987 @0,31  →  X 1924×996 @0,34   偏差 (+0,+3)  ✅
         小窗 48×58 @936,949        →  X 65×77  @1081,941  偏差 (+145,-8) ❌
       mutter 只重排"小窗口"（防越界/避让），对铺满工作区的窗口它不动。
       所以**透明 + overlay 是正确路线**，不透明降级只是没有合成器时的兜底。 */
  try {
    const xt = require('child_process');
    const argb = (() => {
      try {
        const out = xt.execFileSync('xprop', ['-root', '_NET_SUPPORTED'], {
          encoding: 'utf8', timeout: 3000, env: process.env,
        });
        return /_NET_WM_WINDOW_OPACITY|32_BIT_VISUAL|ARGB/i.test(out);
      } catch (_) { return false; }
    })();
    let cmSel = '';
    try {
      cmSel = xt.execFileSync('xprop', ['-root', '_NET_WM_CM_S0'], {
        encoding: 'utf8', timeout: 3000, env: process.env,
      });
    } catch (_) {}
    const cmSelHas = /=/.test(cmSel) && !/not found/i.test(cmSel);
    let wmName = '';
    try {
      wmName = xt.execFileSync('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK'], {
        encoding: 'utf8', timeout: 3000, env: process.env,
      });
    } catch (_) {}
    const wmHas = /window id #|#\s*0x|=/.test(wmName) && !/not found/i.test(wmName);
    const has = cmSelHas || argb || wmHas;
    log('合成器探测: _NET_WM_CM_S0=' + (cmSelHas ? '有' : '无') +
      ' ARGB集=' + (argb ? '有' : '无') + ' WM=' + (wmHas ? '在' : '无') +
      ' → ' + (has ? '判定有合成器（用透明 + overlay，这是位置最准的形态）'
        : '判定无合成器（降级为不透明小窗）'));
    return has;
  } catch (e) {
    log('合成器探测失败，按"无合成器"处理（宁可丑，也要看得见）:', e.message);
    return false;
  }
}

function verifyMapped() {
  if (process.platform !== 'linux' || !state.win || state.win.isDestroyed()) return;
  const pid = process.pid;
  const probe = () => {
    /* ⚠ 踩过的坑：首版把 Python 源码内联成 `python3 -c "..."`，
       而系统 python3 没装 python-xlib → 校验脚本自己先崩，
       日志只剩一句 "X map 校验失败(可忽略)"，等于校验白做。
       现在改为外部脚本 src/mapcheck.py（xlib → xprop 双路径）+ 解释器探测。 */
    const script = path.join(__dirname, '..', 'src', 'mapcheck.py');
    if (!fs.existsSync(script)) { log('X map 校验跳过：缺少 mapcheck.py'); return; }
    let r = null;
    let used = null;
    for (const py of pythonCandidates()) {
      try {
        /* 后四个参数是期望几何：XWayland 下 Chromium 顶层窗口可能不带
           _NET_WM_PID（xprop 全 None），按 PID 找会永远 NOT_MAPPED，
           但窗口其实在屏幕上。传几何让它用尺寸认领。 */
        const want = (() => {
          try {
            const b = state.win.getBounds();
            return [b.width, b.height];
          } catch (_) { return null; }
        })();
        const args = [script, String(pid)];
        if (want) args.push('0', '0', String(want[0]), String(want[1]));
        const out = require('child_process').execFileSync(py, args, {
          encoding: 'utf8', timeout: 5000, env: process.env,
        });
        r = JSON.parse((out || '').trim().split('\n').pop() || '{}');
        used = py;
        if (r && r.ok) break;
        log('X map 校验拿不到结果（' + py + '）:', r && r.error);
      } catch (e) {
        log('X map 校验脚本失败（' + py + '）:', e.message);
      }
    }
    if (!r || !r.ok) {
      log('X map 校验：所有解释器都失败，本项跳过（不影响显示）:', r && r.error);
      return;
    }
    log('X map 校验:', r.mapped ? 'MAPPED' : 'NOT_MAPPED',
      'via', r.via, 'py', used, 'windows', JSON.stringify(r.windows), 'scanned', r.scanned,
      r.mappedBy ? ('mappedBy=' + r.mappedBy) : '');
    if (r.ownWindows) log('X 窗口树自查: 属于本进程的窗口',
      r.ownCount, JSON.stringify(r.ownWindows), 'env', JSON.stringify(r.env));
    /* 屏幕上（IsViewable）到底有哪些窗口、在什么位置。
       ⚠ 这一行是为了抓一类假阴性：override_redirect 的窗口不进 _NET_CLIENT_LIST，
         所以"列表里没有"≠"屏幕上看不到"。如果我们的球带几何出现在这里，
         说明窗口其实在屏幕上，只是被 client list 漏报了。 */
    if (r.allViewable) log('X 屏幕上的窗口(' + r.allViewableCount + '):',
      JSON.stringify(r.allViewable));

    /* ⚠ _NET_CLIENT_LIST 不是唯一证据，这点很关键：
       实测两类窗口"在屏幕上但不在列表里"：
         ① mutter 对非 NORMAL 类型（toolbar 等）不登记
         ② override_redirect=1 的窗口**从来不进** client list
            （我用 python-xlib 建过：map_state=2，屏幕上真在，列表里没有）

       所以证据按强弱排三级，任一成立就算"已在屏幕上"：
         1) PID 命中且 IsViewable
         2) 几何完全吻合的 IsViewable 无主窗口
         3) 上面都没有，才算真的没映射 */
    const b = (() => { try { return state.win.getBounds(); } catch (_) { return null; } })();
    const geoHit = !!b && (r.allViewable || []).some(
      (w) => w && w.geom && w.geom[2] === b.width && w.geom[3] === b.height);
    if (!r.mapped && geoHit) {
      log('→ client list 没收录，但屏幕上有同尺寸窗口（' + b.width + '×' + b.height +
        '）—— 已可见，属正常漏报');
      return;
    }
    const treeVisible = (r.ownWindows || []).some((w) => w && w.map_state === 2);
    if (!r.mapped && treeVisible) {
      log('→ client list 没收录，但窗口树里 IsViewable —— 已可见');
      return;
    }
    if (!r.mapped) {
      /* 走到这里说明：Electron 侧全绿，X 上也真没映射。
         ⚠ 不要再 reloadIgnoringCache / 关 GPU —— 实测无效，
         而且会把页面状态整个重来一遍，把诊断信息冲掉。 */
      log('⚠ 窗口未映射到 X —— 屏幕上看不到球（Electron isVisible 会骗人）');
      log('   屏幕上的窗口共 ' + (r.allViewableCount || 0) + ' 个，期望尺寸 ' +
        (b ? b.width + '×' + b.height : '?') + '；以上面那行 "X 屏幕上的窗口" 为准');
      send({ type: 'diag', warn: 'window-not-mapped', via: r.via, scanned: r.scanned });
    }
  };
  setTimeout(probe, 1300);
  /* 第二道体检：**像素级**。
     前面所有证据（isVisible / did-finish-load / DOM 里有 .orb / X 里 MAPPED）
     都只能证明"东西在那儿"，不能证明"球被画出来了"。
     透明窗口里球完全可以是 0 宽、opacity:0、或被 CSS 推到视口外 —— 全都"正常"。
     所以最后再截一次图，统计球带区域的不透明像素：
       底部停靠时，窗口最后 dockH+lify 那一条里必须有非透明像素。 */
  setTimeout(probePixels, 1900);
}

/* ── 降级：不透明窗口重建 ──

   为什么是"重建"而不是"改属性"：transparent 是 BrowserWindow 的
   **构造期**选项，创建后无法切换。想让窗口变成不透明，只能销毁重建。

   布局也要跟着改：不透明窗口不能铺满整个工作区（会盖死桌面），
   所以降级时切回"小窗口"形态 —— 只占球带那一小条。 */
function rebuildOpaque() {
  if (state.opaque) return;
  state.opaque = true;
  log('→ 降级为不透明窗口（小窗形态，只占球带一条）');
  try {
    state.opaqueRebuilding = true;
    if (state.win && !state.win.isDestroyed()) state.win.destroy();
  } catch (e) {
    log('销毁旧窗口失败:', e.message);
  }
  state.win = null;
  setTimeout(() => {
    try {
      const w = createWindow();
      if (w) log('不透明窗口已创建');
    } catch (e) {
      log('不透明窗口创建失败:', e.message);
    }
  }, 120);
}

/** 抓图统计球带区域的不透明像素，作为"用户真的看得见"的最终证据。 */
function probePixels() {
  if (!state.win || state.win.isDestroyed()) return;
  const a = anchors();
  state.win.webContents
    .capturePage()
    .then((img) => {
      const size = img.getSize();
      const bmp = img.toBitmap(); // BGRA
      if (!size.width || !size.height || bmp.length < size.width * size.height * 4) {
        log('像素体检：截图尺寸异常', JSON.stringify(size));
        return;
      }
      /* 球带在页面坐标里的纵向范围：底部停靠 → 视口最后 dockH 高的一条（含上探 lift）。
         这里按 dockH + lift 取保守带宽，宁可多扫一点也不能漏。
         ⚠ dockH / lift 在 anchors().metrics 里，不在 anchors() 顶层。 */
      const met = a.metrics || {};
      const bandH = Math.max(1, Math.round((met.dockH || 38) + (met.lift || 19)));
      const bandTop = Math.max(0, size.height - bandH);
      /* ⚠ 不能只数 alpha>16 就完事：
         不透明降级后窗口底色 #1e1e22 本身 alpha=255，于是"整窗 100% 不透明"
         —— 这个指标会告诉你"有东西"，但那个东西只是背景板，球可能根本不在。
         实测就踩到了：600/600 (100%)，可球一个像素都没有。
         所以再按"饱和度/亮度是否偏离中性灰"数一遍：底色是近中性深灰，
         球是 hsl(46~72% 饱和) 的彩色，用 max-min 通道差就能分开。 */
      let opaque = 0;
      let total = 0;
      let colored = 0; // 真正像"球"的像素（有彩度 / 明显亮于底色）
      for (let y = bandTop; y < size.height; y += 1) {
        for (let x = 0; x < size.width; x += 1) {
          const i = (y * size.width + x) * 4;
          const b = bmp[i];
          const g = bmp[i + 1];
          const r = bmp[i + 2];
          const al = bmp[i + 3];
          total++;
          if (al > 16) opaque++;
          const mx = Math.max(r, g, b);
          const mn = Math.min(r, g, b);
          // 彩度 > 24 且不太暗：球的高光/本体都会落在这一档
          if (al > 16 && mx - mn > 24 && mx > 60) colored++;
        }
      }
      const pct = total ? (colored / total) : 0;
      log('像素体检: 球带彩色像素 ' + colored + '/' + total +
        ' (' + (pct * 100).toFixed(2) + '%)  含底色不透明 ' + opaque +
        '  band=' + JSON.stringify({
          top: bandTop, h: size.height - bandTop, dockH: Math.round(met.dockH || 0),
        }) + ' view=' + JSON.stringify({ w: size.width, h: size.height }));
      if (colored === 0) {
        log('⚠ 球带里没有任何彩色像素 —— 球确实没画出来（只有底色板）');
        send({ type: 'diag', warn: 'orbs-invisible-pixels' });
      }
    })
    .catch((e) => log('像素体检失败(可忽略): ' + e.message));
}

/* ── 内容自愈：X 侧持续盯梢 ─────────────────────────────

   ⚠ 为什么 capturePage 不够：它读的是 Chromium **自己**的帧缓冲。
      用户实机实测（进程跑一小时后）：
        capturePage → 849 个彩色像素（页面一直在画，认为一切正常）
        xlib GetImage 读 X 窗口 → 全 0（帧根本没提交到 X）
      用户看不到球，而所有 Electron 侧证据都是绿的 —— 这就是
      "球过一会儿消失"难以排查的原因：必须从 **X 侧**验尸。

   机制（不依赖 occlusion 开关是否生效，作为最后兜底）：
     每 30s 用 xlib 对窗口球带做一次 GetImage，数彩色像素；
     连续 2 次全 0 且有仓库数据时，依次尝试三级自愈：
       ① webContents.invalidate() —— 强制 Chromium 重绘一帧
       ② 页面里触发强制重排 + 合成（对 compositor 施压）
       ③ reload 页面（最重的一档，会闪一下，但球回来）
     自愈成功后重置计数。 */

let contentWatchTimer = null;
let contentEmptyStreak = 0;
let contentHealStage = 0;

function bandColoredViaX() {
  if (process.platform !== 'linux') return -1; // 非 linux 不监控
  if (!state.win || state.win.isDestroyed()) return -1;
  try {
    const buf = state.win.getNativeWindowHandle();
    const id = buf.readUInt32LE(0);
    if (!id || id === 1) return -1; // ozone 选错，另一个问题，不在这里处理
    const py = pythonCandidates()[0];
    if (!py) return -1;
    /* 球带（窗口内物理像素）：bottom 停靠 → 窗口底部 dockH+lift 那一条。
       传给 xlib 时全部乘 scale（GetImage 用物理像素，见 syncShape 的教训）。 */
    const sf = (() => {
      try { return screen.getPrimaryDisplay().scaleFactor || 1; } catch (_) { return 1; }
    })();
    const met = anchors().metrics || {};
    const bandH = Math.max(4, Math.round(((met.dockH || 38) + (met.lift || 19)) * sf));
    const winPhysW = Math.round(state.win.getBounds().width * sf);
    const out = require('child_process').execFileSync(py, ['-c', [
      'import sys,json',
      'from Xlib import display,X',
      'd=display.Display(":0")',
      'w=d.create_resource_object("window",int(sys.argv[1],0))',
      'g=w.get_geometry()',
      'bh,bw=int(sys.argv[2]),int(sys.argv[3])',
      'img=w.get_image(0,max(0,g.height-bh),min(bw,g.width),min(bh,g.height),X.ZPixmap,0xffffffff)',
      'dd=img.data; n=max(1,g.width)',
      'c=0',
      'for y in range(min(bh,g.height)):',
      '    row=dd[y*n*4:(y+1)*n*4]',
      '    for x in range(min(bw,g.width)):',
      '        b,gr,r=row[x*4],row[x*4+1],row[x*4+2]',
      '        if abs(r-gr)>18 or abs(gr-b)>18 or abs(r-b)>18: c+=1',
      'print(c)',
    ].join('\n'), '0x' + id.toString(16), String(bandH), String(winPhysW)], {
      encoding: 'utf8', timeout: 5000, env: process.env,
    });
    return parseInt(out.trim(), 10) || 0;
  } catch (_) {
    return -1;
  }
}

function healContent(stage) {
  const wc = state.win && !state.win.isDestroyed() ? state.win.webContents : null;
  if (stage <= 1) {
    if (!wc) return;
    log('自愈①: webContents.invalidate()');
    try { wc.invalidate(); } catch (_) {}
  } else if (stage === 2) {
    if (!wc) return;
    log('自愈②: 页面强制合成');
    wc.executeJavaScript(
      '(function(){var s=document.documentElement.style;' +
      's.transform="translateZ(0)";void document.body.offsetWidth;' +
      'requestAnimationFrame(function(){s.transform="";});})()'
    ).catch(() => {});
  } else if (stage === 3) {
    /* ③ 重建为不透明窗口。
       ⚠ 不要再用 reload —— 本机对照实验已证明 reload 无效：
         页面一直在画（capturePage 有彩色像素），但 X 窗口内容全空，
         问题不在页面，在"透明 overlay 的帧提交"这一层。
         而同屏 VSCode（不透明 depth-24）窗口内容 100% 可读 —— 不透明窗口能呈现。
         透明是构造期选项，只能销毁重建（rebuildOpaque 之前从未被调用过）。 */
    log('自愈③: X 内容持续为空 → 降级重建不透明窗口');
    rebuildOpaque();
  } else {
    log('自愈④: 建议切换 Electron 运行时（当前版本帧提交失效）');
  }
}

function startContentWatch() {
  if (contentWatchTimer || process.platform !== 'linux') return;
  contentWatchTimer = setInterval(() => {
    if (!state.win || state.win.isDestroyed() || !state.repos.length) return;
    const n = bandColoredViaX();
    if (n < 0) return; // 读不到（非 X 环境/handle 无效）就不下结论
    if (n > 0) {
      if (contentEmptyStreak > 0) log('X 内容自检恢复: 彩色像素 ' + n);
      contentEmptyStreak = 0;
      contentHealStage = 0;
      return;
    }
    contentEmptyStreak++;
    log('⚠ X 侧内容自检: 球带全空 (' + contentEmptyStreak + '/2)');
    if (contentEmptyStreak >= 2) {
      contentHealStage++;
      healContent(contentHealStage);
      contentEmptyStreak = 0;
      /* stage 3 已改为"重建不透明窗口"（reload 对帧提交失效无济于事）。
         若重建后仍然空（stage 4+），说明连不透明都呈现不了，
         重置 stage 只会原地循环 → 改为永久停在 4，只留日志不再折腾。 */
      if (contentHealStage > 4) contentHealStage = 4;
    }
  }, 5000);
  log('X 内容自检已启动（每 5s 盯一次球带）');
}

/* ───────────────────────── 窗口 ───────────────────────── */

function createWindow() {
  const a = anchors(); // 顺带写入 state.overlayMode
  const gpad = state.overlayMode ? { w: 0, h: 0, x: 0, y: 0 } : GEOM_PAD;
  log('createWindow', JSON.stringify(a.win), 'wa', JSON.stringify(a.workArea),
    'view', JSON.stringify(state.view), 'opaque', state.opaque);
  const win = new BrowserWindow({
    /* ⚠ 构造期也要扣掉 XWayland 的小窗偏差（GEOM_PAD），否则首帧位置就偏。
       overlay 形态（铺满工作区）不需要补偿，gpad 已按形态取零。 */
    x: a.win.x - gpad.x,
    y: a.win.y - gpad.y,
    width: Math.max(MIN_WIN_W, a.win.width - gpad.w),
    height: Math.max(MIN_WIN_H, a.win.height - gpad.h),
    frame: false,
    /* ⚠ 透明与否是**构造期**选项，创建后不能改。
       没有合成器时 transparent:true 会导致窗口 map 失败（屏幕空白），
       所以 detectCompositor() 的结论在这里生效。 */
    transparent: !state.opaque,
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
    /* 不透明降级时给一个深色底：球是浅色的，贴在深底上比白底清楚得多，
       也更接近"悬浮条"的观感（而不是一块白板）。 */
    backgroundColor: state.opaque ? '#1e1e22' : '#00000000',
    /* ⚠ type:'toolbar' 在 GNOME Shell (mutter) + XWayland 下**不会被托管**：
       窗口能创建、能渲染、pixels 都在，但 mutter 不把它写进 _NET_CLIENT_LIST，
       就等于没有 map 到屏幕 —— 于是"球明明画出来了却看不见"。

       实测证据（xprop -root）：
         _NET_SUPPORTING_WM_CHECK = "GNOME Shell"   ← mutter 在
         _NET_WM_CM_S0            = not found       ← XWayland 下本来就没有
         _NET_CLIENT_LIST         = 只有 3 个窗口，全是 _NET_WM_WINDOW_TYPE_NORMAL
       而我们那个是 TOOLBAR，一个都没进列表。

       所以走 NORMAL（mutter 一定托管），要的"工具窗"效果改用
       skipTaskbar + alwaysOnTop + focusable:false 组合来实现。 */
    type: process.platform === 'linux' ? 'normal' : 'toolbar',
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
  startContentWatch();

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
  /* preload 把页面侧异常转发到这里。⚠ console-message 那条路在某些 Electron
     版本/合成路径下收不到页面 console.error，所以异常必须单独走一条 IPC。 */
  ipcMain.on('log', (_e, m) => {
    if (!m || !m.text) return;
    /* 环形缓冲，只做上限，不无限涨 */
    state.pageLogs = state.pageLogs || [];
    state.pageLogs.push(String(m.text).slice(0, 4000));
    if (state.pageLogs.length > 200) state.pageLogs.splice(0, state.pageLogs.length - 200);
    log('PAGE-' + (m.level || 'log') + ': ' + m.text);
  });
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
    /* ⚠ 探针选择器写错了一次：球的实际 class 是 .orb，探针查的是 .ball，
       于是日志永远打印 balls:0 —— 看起来像"DOM 里没球"，
       实际球可能一直都在。假阴性比没有日志更坏，它会把排查带偏。
       现在同时取 .orb 数量和第一个球的实测几何/透明度，
       只有"有球 + 尺寸 > 0 + opacity > 0 + 在窗口内"才算真的看得见。 */
    win.webContents
      .executeJavaScript(
        [
          '(function(){',
          '  var d=document.getElementById("dock");',
          '  var bs=document.querySelectorAll(".orb");',
          '  var out={orbs:typeof window.orbs,hasDock:!!d,orbsDom:bs.length};',
          '  if(d){var dr=d.getBoundingClientRect();',
          '    out.dockRect=[Math.round(dr.left),Math.round(dr.top),Math.round(dr.width),Math.round(dr.height)];}',
          '  if(bs.length){var r=bs[0].getBoundingClientRect();var cs=getComputedStyle(bs[0]);',
          '    out.first=[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)];',
          '    out.opacity=cs.opacity;out.visibility=cs.visibility;out.display=cs.display;',
          '    out.bg=cs.backgroundColor;}',
          '  out.vw=innerWidth;out.vh=innerHeight;',
          '  return out;})()',
        ].join('\n'),
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
    /* 初始化指针换算基准。用 anchors() 算出的**目标位置**（a.win），
       而不是 X 读回值 —— 读回值含 GEOM_PAD 那部分偏差（窗口实际比需求大
       9×10px），拿它当基准，指针在球右侧 9px 内会被判成"在球上"。
       这里仍然打印一次 X 真实几何，纯粹为了发现"平台选错/被 WM 大挪"这类异常。 */
    state.lastRect = { x: a.win.x, y: a.win.y, width: a.win.width, height: a.win.height };
    const real = realGeomFromX();
    if (real) {
      log('X 真实几何: ' + JSON.stringify(real));
      const dx = Math.abs(real.x - a.win.x);
      const dy = Math.abs(real.y - a.win.y);
      if (dx > 6 || dy > 6) {
        log('⚠ 窗口实际位置与目标差 (' + dx + ',' + dy + ') —— 若持续偏移，' +
            '多半是 ozone 平台或 WM 策略问题（本次按目标位置做指针换算）');
      }
    } else {
      log('⚠ 读不到 X 真实几何（handle 为 0x1 说明 ozone 仍是 wayland）');
    }
    verifyMapped();
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

/** 唯一的移动入口 —— setBounds 且每次显式带 w/h。setPosition 每调一次尺寸就涨 1~2px。

    ⚠⚠ XWayland 下 Electron 的 getBounds() 与 X 实际几何**不一致**，实测：
         after show: bounds={"x":935,"y":967,"width":49,"height":51}   ← Electron 说
         xwininfo:   79x81+1070+949                                     ← X 实际
       两个方向都错：(135, -18) 的位置偏差、+30 的尺寸偏差（Chromium 的
       XWayland 路径把 content 尺寸和 frame 尺寸混了，且 mutter 会重定位）。
       后果非常实在：拿 getBounds 算"指针相对窗口的坐标"，球明明在指针下面
       也算不中，于是 hot 恒为 -1、球永不亮起 —— 看起来就是"球在那但没反应"。

       所以：**以 X 为真理**。setBounds 之后用 xwininfo 读回真实几何，
       存进 state.realRect，指针换算一律用它。读不到时退回 getBounds
       （至少还能工作，只是可能有偏差）。 */
function realGeomFromX() {
  if (process.platform !== 'linux' || !state.win || state.win.isDestroyed()) return null;
  try {
    const { execFileSync } = require('child_process');
    /* 只查自己这个窗口，比全树扫描快得多。
       getNativeWindowHandle() 在**正确的 ozone=x11** 下返回真实 X window id；
       在 ozone=wayland 时它恒为 0x1（非法），这里查不到就直接返回 null。 */
    const buf = state.win.getNativeWindowHandle();
    const id = '0x' + buf.readUInt32LE(0).toString(16);
    if (id === '0x1') return null; // 占位窗口，说明 ozone 平台还是选错了
    const out = execFileSync('xwininfo', ['-id', id], { encoding: 'utf8', timeout: 2000 });
    const gx = /Absolute upper-left X:\s*(-?\d+)/.exec(out);
    const gy = /Absolute upper-left Y:\s*(-?\d+)/.exec(out);
    const gw = /Width:\s*(\d+)/.exec(out);
    const gh = /Height:\s*(\d+)/.exec(out);
    const mv = /Map State:\s*(\w+)/.exec(out);
    if (!gx || !gy || !gw || !gh) return null;
    return {
      x: +gx[1], y: +gy[1], width: +gw[1], height: +gh[1],
      mapped: !mv || mv[1] === 'IsViewable',
      source: 'xwininfo',
    };
  } catch (_) {
    return null;
  }
}

/* ── XWayland 几何偏差补偿 ──────────────────────────────────
   ⚠ 实测结论（本机 Electron + ozone=x11 + mutter/XWayland，重复多次一致）：

     形态                         请求                  X 实际              偏差
     铺满工作区(overlay)     1920×987 @0,31       1924×996 @0,34      (+0,+3)  ✅
     小窗                    48×58   @936,949     65×77   @1081,941   (+145,-8) ❌
     小窗(居中)              48×58   @940,500     66×78   @1086,578   (+146,+78)❌
     小窗(靠左上)            48×58   @100,100     66×79   @115,115    (+15,+15) ❌

   规律：**mutter 会重排"小窗口"**（往工作区内推、避让边缘），窗口越小越靠边
   推得越狠；而**铺满工作区的窗口它不动**（+3px 属于 client-side 装饰的尺度）。
   所以正解不是"算补偿值"（它和小窗尺寸/位置都相关，算不准），
   而是**走 overlay 形态**——顺带也彻底摆脱 setBounds 定位的不可靠。

   下面这个 padding 只在"没有合成器、被迫用小窗"的降级路径里起作用：
   实测小窗在 X 上总比请求大 17×19 左右，位置被推 +145，
   那就反向扣掉，让降级形态至少能落在正确的地方（不完美但比偏 145px 强）。 */
const GEOM_PAD = (() => {
  if (process.platform !== 'linux' || process.env.BRANCH_ORBS_NO_GEOM_FIX) {
    return { w: 0, h: 0, x: 0, y: 0 };
  }
  /* 小窗降级路径的经验值：X 会把窗口放大 ~17×19，并把位置往内推 ~145。 */
  return { w: 17, h: 19, x: 145, y: 8 };
})();

function place(x, y, w, h) {
  if (!state.win || state.win.isDestroyed()) return;
  const want = {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(MIN_WIN_W, Math.round(w)),
    height: Math.max(MIN_WIN_H, Math.round(h)),
  };
  /* overlay 形态铺满工作区，不需要任何补偿
     （mutter 不动铺满的窗口，实测偏差只有 +3px）。
     直接看 state.overlayMode —— 由 anchors() 在每次计算时写入，
     比在 place() 里再调一次 anchors() 便宜。 */
  const pad = state.overlayMode ? { w: 0, h: 0, x: 0, y: 0 } : GEOM_PAD;
  const req = {
    x: want.x - pad.x,
    y: want.y - pad.y,
    width: Math.max(MIN_WIN_W, want.width - pad.w),
    height: Math.max(MIN_WIN_H, want.height - pad.h),
  };
  const b = state.win.getBounds();
  if (b.x === req.x && b.y === req.y && b.width === req.width && b.height === req.height) return;
  state.win.setBounds(req);
  const now = state.win.getBounds();
  /* ⚠ 不要在这里读 xwininfo：place 被 scheduleRepaint 高频调用，
     每次 fork 一个 xwininfo（~2ms）会把主线程拖住。
     指针换算要的是"我们要求的屏幕位置"（want），它本身就是准的
     （overlay 下 +3px 已经落在球半径的容差内）。 */
  state.lastRect = want;
  /* ⚠ shape 是"窗口内坐标的矩形"，窗口一变就必须重算 ——
     否则窗口长大/缩小之后，裁剪区域还停在旧位置，球会被裁掉一半。 */
  syncShape(state.lane || LANE_IDLE);
  if (process.env.BRANCH_ORBS_TRACE) {
    log('place want', JSON.stringify(want), 'req', JSON.stringify(req), 'now', JSON.stringify(now));
  }
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
  state.win.webContents.send('state', {
    type: 'state',
    repos: state.repos,
    cfg: c,
    shift: Math.round((c.offset || 0) + (state.dragShift || 0)),
    opaque: !!state.opaque,
    /* Linux 上悬停判定永远归主进程（input shape 收窄后页面收不到 pointer 事件），
       所以从一开始就告诉页面"别自己判"，否则两边的 pointerleave 会互相打架。 */
    driverHot: process.platform === 'linux',
  });
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
    /* ⚠⚠ Linux/overlay 下**不要**在这里改 lane。
       踩过的坑（日志表现是 setLane 的 idle/hot 每隔几毫秒来回翻）：

         页面 __orbsHover(1) → post('hover',{index:1})
                            → 这里 setLane(HOT)
         同时 pollHit 也在每 32ms 判一次，按 shape 需要写 state.lane
       两个写入方交替覆盖 state.lane，setLane 的 `if (l === state.lane) return`
       守卫只在"值没变"时挡住，挡不住这种交替写。
       而 lane 的权威来源必须是 pollHit —— 只有它同时掌握
       "指针在哪 + shape 该多大"这两件事（shape 要跟着指针走，
       页面根本不知道指针在哪）。

       所以 Linux 下这里只同步 state.hot，lane 交给 pollHit 的下一帧。 */
    if (process.platform !== 'linux') setLane(state.hot >= 0 ? LANE_HOT : LANE_IDLE);
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
  /* 建窗口**之前**先问清楚有没有合成器。
     有 → 透明 overlay（球浮在桌面底边，理想形态）
     没有 → 不透明小窗（球贴在一条深色条上，退化但真的看得见）
     这个判断必须在 new BrowserWindow 之前，因为 transparent 是构造期选项。 */
  if (!detectCompositor()) state.opaque = true;
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
