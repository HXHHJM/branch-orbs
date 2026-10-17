// 实景验证：把壳进程真的跑在 X11 桌面上，截图并采集几何证据
//
// 与 shell-selftest.js 的分工：
//   selftest  = 断言驱动（35 条），全都走 __orbsDriver，不产图
//   live-scene = 出图 + 采集真实 X11 几何，用来给人看"球确实沉在屏幕底边"
//
// 用法：node test/live-scene.js [outdir]
//
// 关键：这里**不用** BrowserWindow.capturePage 取图 —— 那个拿的是离屏表面，
// 不含"窗口在屏幕上的位置"这一信息。要证明"沉在屏幕底边"，必须从**屏幕**截。
// X11 下用 xwd 抓 root window 的一个矩形，再转 png。

const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const { _electron: electron } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const WORK = '/home/hy/WorkBuddy/2026-10-17-12-49-03/.workbuddy';
const TMP = path.join(WORK, 'tmp');
const OUT = process.argv[2] || path.join(WORK, 'shots');
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const ELECTRON =
  process.env.BRANCH_ORBS_ELECTRON ||
  path.join(WORK, 'electron-runtime', 'node_modules', 'electron', 'dist', 'electron');

// 三个仓库，覆盖"干净/有改动/多分支"三种球态
const REPOS = [
  {
    root: '/x/proj', name: 'proj', branch: 'main', changed: 3, added: 42, deleted: 7, ahead: 2, behind: 0,
    lastCommit: { subject: 'refactor: 拆出 anchor 计算', when: '2 小时前', author: 'hy' }, isActive: true,
  },
  {
    root: '/x/firmware', name: 'firmware', branch: 'feature/sinking-orbs', changed: 0, added: 0, deleted: 0, ahead: 0, behind: 1,
    lastCommit: { subject: 'wip: orbs 下沉量对齐 CSS', when: '昨天', author: 'hy' }, isActive: false,
  },
  {
    root: '/x/jig', name: 'jig', branch: 'hotfix/charge-threshold', changed: 1, added: 4, deleted: 0, ahead: 0, behind: 0,
    lastCommit: { subject: 'fix: 12600±600', when: '3 天前', author: 'hy' }, isActive: false,
  },
];

const CFG = { dock: 'bottom', size: 30, gap: 8, sink: 0.32, offset: 0, showCard: true, drag: true, maxRepos: 6 };

function env() {
  const e = { ...process.env };
  delete e.ELECTRON_RUN_AS_NODE;
  delete e.NODE_OPTIONS;
  e.BRANCH_ORBS_HTML = path.join(ROOT, 'shell', 'orbs.html');
  e.BRANCH_ORBS_USER_DATA = fs.mkdtempSync(path.join(TMP, 'ud-live-'));
  e.BRANCH_ORBS_LOG = path.join(WORK, 'shell-live.log');
  e.BRANCH_ORBS_TEST = '1';
  e.TMPDIR = TMP;
  e.DISPLAY = process.env.DISPLAY || ':0';
  try { fs.writeFileSync(e.BRANCH_ORBS_LOG, ''); } catch (_) {}
  return e;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── X11 抓屏：xwd 某一个矩形 → png ──
   xwd 只能抓整个窗口或用 -root 抓全屏，没有"抓矩形"的开关。
   所以抓全屏再裁。ImageMagick 没装，裁剪用 python3 的 PIL 兜底；
   PIL 也没有就退化为"整屏 + 打印裁切框"。 */
function grabScreen(file) {
  const raw = path.join(TMP, 'root.xwd');
  try {
    cp.execFileSync('xwd', ['-root', '-silent', '-out', raw], { env: { ...process.env, DISPLAY: ':0' } });
  } catch (e) {
    return { ok: false, why: 'xwd failed: ' + e.message };
  }
  const py = `
import sys
src, dst = sys.argv[1], sys.argv[2]
try:
    from PIL import Image
except ImportError:
    sys.exit(3)
im = Image.open(src)
im.save(dst)
`;
  try {
    cp.execFileSync('python3', ['-c', py, raw, file], { stdio: 'pipe' });
    return { ok: true, file };
  } catch (e) {
    if (e.status === 3) return { ok: false, why: 'no PIL' };
    return { ok: false, why: 'convert failed: ' + e.message };
  }
}

/* 用 PIL 把全屏按矩形裁出来（窗口四周多留一点，好看出"沉在边缘"） */
function cropRect(srcFull, dst, rect, pad) {
  const py = `
import sys
from PIL import Image
im = Image.open(sys.argv[1])
x, y, w, h, pad = int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6]), int(sys.argv[7])
box = (max(0, x - pad), max(0, y - pad), min(im.width, x + w + pad), min(im.height, y + h + pad))
im.crop(box).save(sys.argv[2])
print(json.dumps({"box": box, "size": [box[2]-box[0], box[3]-box[1]]}) if False else "")
`;
  cp.execFileSync('python3', ['-c', py, srcFull, dst, String(rect.x), String(rect.y), String(rect.width), String(rect.height), String(pad)]);
}

(async () => {
  if (!fs.existsSync(ELECTRON)) {
    console.error('找不到 Electron：' + ELECTRON);
    process.exit(2);
  }

  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [
      path.join(ROOT, 'shell'),
      '--ozone-platform=x11',
      '--disable-dev-shm-usage',
      '--no-sandbox',
    ],
    cwd: ROOT,
    env: env(),
  });

  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await sleep(700);

  // 注入数据（走主进程驱动口，等价于扩展推消息）
  await app.evaluate(({}, r) => global.__orbsDriver({ type: 'repos', repos: r }), REPOS);
  await app.evaluate(({}, c) => global.__orbsDriver({ type: 'config', cfg: c }), CFG);
  await sleep(900);

  // 真实 X11 几何
  const geo = await app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const b = w.getBounds();
    const d = screen.getPrimaryDisplay();
    return { bounds: b, workArea: d.workArea, display: d.bounds, scale: d.scaleFactor };
  });

  const wa = geo.workArea;
  const b = geo.bounds;
  const winBottom = b.y + b.height;
  const waBottom = wa.y + wa.height;
  const bottomGap = waBottom - winBottom;          // 0 = 窗口底边正好压在工作区底边
  const centerOff = Math.abs((b.x + b.width / 2) - (wa.x + wa.width / 2));

  // 页面内的球几何（球底边越出窗口多少 = 视觉下沉量）
  const orbs = await win.evaluate(() => window.__probe ? window.__probe() : null);
  const orbGeom = await win.evaluate(() => {
    const out = [];
    for (const n of document.querySelectorAll('#dock .orb')) {
      const r = n.getBoundingClientRect();
      out.push({
        branch: n.dataset.branch || null,
        left: +r.left.toFixed(2), right: +r.right.toFixed(2),
        top: +r.top.toFixed(2), bottom: +r.bottom.toFixed(2),
        bottomOverflow: +(r.bottom - window.innerHeight).toFixed(2),
      });
    }
    return out;
  });

  console.log('--- 几何 ---');
  console.log('workArea  ', JSON.stringify(wa));
  console.log('winBounds ', JSON.stringify(b));
  console.log('bottomGap ', bottomGap, '(0 = 贴住工作区底边)');
  console.log('centerOff ', centerOff.toFixed(1), 'px');
  console.log('orbs      ', JSON.stringify(orbGeom));

  /* ── 截图 ── */
  const shots = [];

  // ① 静止态：窗口区域（含周边留白，看得出球沉在边缘）
  const full = path.join(TMP, 'screen-full.png');
  const g = grabScreen(full);
  if (g.ok) {
    const p1 = path.join(OUT, 'live-idle.png');
    cropRect(full, p1, b, 40);
    shots.push(p1);
  } else {
    console.log('抓屏不可用：' + g.why + ' → 退化为 capturePage（不含屏幕位置）');
    const p1 = path.join(OUT, 'live-idle.png');
    await win.screenshot({ path: p1 });
    shots.push(p1);
  }

  // ② 悬停态：把鼠标移到第 2 颗球上
  // ⚠ 页面监听的是 `pointerover` / `pointermove`，手工 dispatch('mousemove') 触发不了
  //   （PointerEvent 与 MouseEvent 在 Chromium 里是两套事件）。必须用真实输入。
  const c2 = orbGeom[1];
  if (c2) {
    const cx = Math.round((c2.left + c2.right) / 2);
    const cy = Math.round((c2.top + c2.bottom) / 2);
    await win.mouse.move(cx - 30, cy - 30);
    await sleep(120);
    await win.mouse.move(cx, cy, { steps: 4 });
    await sleep(650);
  }

  const geo2 = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  const full2 = path.join(TMP, 'screen-hover.png');
  const g2 = grabScreen(full2);
  if (g2.ok) {
    const p2 = path.join(OUT, 'live-hover.png');
    cropRect(full2, p2, geo2, 40);
    shots.push(p2);
  } else {
    const p2 = path.join(OUT, 'live-hover.png');
    await win.screenshot({ path: p2 });
    shots.push(p2);
  }

  const hoverState = await win.evaluate(() => (window.__probe ? window.__probe() : null));

  console.log('--- 悬停后 ---');
  console.log('winBounds ', JSON.stringify(geo2));
  console.log('probe     ', JSON.stringify(hoverState));

  await app.close();

  console.log('--- 截图 ---');
  for (const s of shots) console.log(s, fs.existsSync(s) ? fs.statSync(s).size + 'B' : 'MISSING');
})().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
