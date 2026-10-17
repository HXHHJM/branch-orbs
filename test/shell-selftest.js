// 壳进程自测：用 Playwright 驱动 shell/main.js，验证窗口几何、穿透、悬停、卡片
//
// 用法：node test/shell-selftest.js
//   需要 BRANCH_ORBS_ELECTRON 或 .workbuddy/electron-runtime 下的独立 Electron
//   （不能用 code 自带二进制：它会强行加载自己的 resources/app，把参数当成工作区）
const path = require('path');
const fs = require('fs');
const { _electron: electron } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const WORK = '/home/hy/WorkBuddy/2026-10-17-12-49-03/.workbuddy';
const TMP = path.join(WORK, 'tmp');
fs.mkdirSync(TMP, { recursive: true });

const ELECTRON =
  process.env.BRANCH_ORBS_ELECTRON ||
  path.join(WORK, 'electron-runtime', 'node_modules', 'electron', 'dist', 'electron');

function env() {
  const e = { ...process.env };
  delete e.ELECTRON_RUN_AS_NODE;
  delete e.NODE_OPTIONS;
  e.BRANCH_ORBS_HTML = path.join(ROOT, 'shell', 'orbs.html');
  e.BRANCH_ORBS_USER_DATA = fs.mkdtempSync(path.join(TMP, 'ud-'));
  e.BRANCH_ORBS_LOG = path.join(WORK, 'shell-test.log');
  e.BRANCH_ORBS_TEST = '1'; // 打开 __orbsDriver 注入点
  e.TMPDIR = TMP;
  try { fs.writeFileSync(e.BRANCH_ORBS_LOG, ''); } catch (_) {}
  return e;
}

const REPOS = [
  { root: '/x/proj', name: 'proj', branch: 'main', changed: 3, added: 42, deleted: 7, ahead: 2, behind: 0,
    lastCommit: { subject: 'refactor: 拆出 anchor 计算', when: '2 hours ago', author: 'hy' }, isActive: true },
  { root: '/x/second', name: 'second', branch: 'feature/sinking-orbs', changed: 0, added: 0, deleted: 0, ahead: 0, behind: 1,
    lastCommit: { subject: 'wip', when: 'yesterday', author: 'hy' }, isActive: false },
  { root: '/x/dirty', name: 'dirty', branch: 'hotfix/charge-threshold', changed: 1, added: 4, deleted: 0, ahead: 0, behind: 0,
    lastCommit: { subject: 'fix: 12600±600', when: '3 days ago', author: 'hy' }, isActive: false },
];

const CFG = { dock: 'bottom', size: 30, gap: 8, sink: 0.32, offset: 0, showCard: true, drag: true };

(async () => {
  const results = [];
  const ok = (name, cond, extra) => {
    results.push({ name, pass: !!cond, extra: extra === undefined ? null : extra });
    console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra === undefined ? '' : '   ' + JSON.stringify(extra)));
  };

  if (!fs.existsSync(ELECTRON)) {
    console.error('找不到 Electron:', ELECTRON);
    process.exit(2);
  }

  const app = await electron.launch({
    cwd: ROOT,
    executablePath: ELECTRON,
    args: ['shell', '--ozone-platform=x11', '--no-sandbox', '--disable-dev-shm-usage'],
    env: env(),
  });

  const page = await app.firstWindow();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(700);

  // ── 测试驱动入口：模拟"扩展 → 壳"的两条消息 ──
  //   setRepos：{type:'repos'}   pushCfg：{type:'config'}
  // ⚠ 起初图省事直接用 webContents.send('state') 模拟，这是错的：
  //   它只改页面，不改主进程 state.cfg / state.repos，
  //   于是窗口几何永远不跟随，dock/offset 的断言全部假失败。
  //   壳进程必须在 main.js 里开一个 __orbs 调试口，否则外部没法注入。
  const setRepos = (repos) => app.evaluate(({}, r) => {
    global.__orbsDriver({ type: 'repos', repos: r });
  }, repos);
  const pushCfg = (cfg) => app.evaluate(({}, c) => {
    global.__orbsDriver({ type: 'config', cfg: c });
  }, cfg);
  const sendState = async (cfg) => {
    await setRepos(REPOS);
    await pushCfg(cfg || CFG);
  };

  const diag = () => app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const b = w.getBounds();
    const d = screen.getDisplayMatching(b);
    return { count: BrowserWindow.getAllWindows().length, b, vis: w.isVisible(), wa: d.workArea, scale: d.scaleFactor };
  });

  const probe = () => page.evaluate(() => window.__probe());

  /* ── 真实指针驱动（overlay 模式必须用它，不能用 page.mouse）──
     overlay 窗口铺满全屏：lane 切到 hot 后窗口停止穿透，
     **真实 X 指针**（测试机里静止在某处）进入窗口并触发 pointermove，
     页面判定"不在球上"→ 取消 hover。合成事件与真实指针打架，hover 永远稳不住。
     对策：把真实指针搬到球心，整条链路走真实输入。

     ⚠ 三个坑（逐个踩过）：
     1) python-xlib 的 warp_pointer 签名是
        warp_pointer(src_window, src_x, src_y, src_width, src_height, dst_x, dst_y)
        —— 全是位置参数，写成 dst_x=/dst_y= 关键字会抛 TypeError。
     2) XWarpPointer **在这个会话里完全无效**：调用不报错、sync 也成功，
        但 query_pointer 立刻回读仍是 (0,0)。
        实测只有 XTEST 扩展的 fake_input(MotionNotify) 能搬动指针
        （回读 700,500 精确命中）。所以这里走 XTEST，不走 warp。
     3) 不能用 translate_coords(root, 0, 0) 求窗口原点：overlay 铺满整屏时
        实测得到 (-933,-960) 这种负值。改用 get_geometry() 的 x/y。 */
  const cp = require('child_process');
  const PYX = '/home/hy/.workbuddy/binaries/python/envs/default/bin/python';
  const warpScript = path.join(TMP, 'warp-pointer.py');
  fs.writeFileSync(
    warpScript,
    [
      'import sys, os, json',
      'from Xlib import X, display',
      'from Xlib.ext import xtest',
      'd=display.Display(os.environ.get("DISPLAY",":0"))',
      'root=d.screen().root',
      'fx, fy = float(sys.argv[1]), float(sys.argv[2])',
      'p=root.get_full_property(d.intern_atom("_NET_CLIENT_LIST"), X.AnyPropertyType)',
      'out={"ok":False,"scan":[]}',
      'for wid in (p.value if p else []):',
      '    w=d.create_resource_object("window",wid)',
      '    cls=w.get_wm_class() or ("","")',
      '    name=((cls[0] or "")+(cls[1] or "")).lower()',
      '    g=w.get_geometry()',
      '    out["scan"].append({"name":name,"w":g.width,"h":g.height})',
      '    if "branch-orbs" in name:',
      '        px=int(g.x+fx*g.width); py=int(g.y+fy*g.height)',
      '        xtest.fake_input(d, X.MotionNotify, x=px, y=py, detail=0, root=root)',
      '        d.flush(); d.sync()',
      '        q=root.query_pointer()',
      '        out.update({"ok":True,"px":px,"py":py,"now":[q.root_x,q.root_y],"win":[g.x,g.y,g.width,g.height]})',
      '        break',
      'print(json.dumps(out))',
    ].join('\n')
  );
  const warpToViewport = async (vx, vy) => {
    const vp = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
    const out = cp.execFileSync(PYX, [warpScript, String(vx / vp[0]), String(vy / vp[1])], { encoding: 'utf8', timeout: 5000 });
    const r = JSON.parse((out || '').trim().split('\n').pop() || '{}');
    if (!r.ok) throw new Error('warp 失败：找不到 branch-orbs X 窗口 ' + JSON.stringify(r.scan || []));
    return r;
  };

  const g0 = await diag();
  ok('壳只开了一个窗口', g0.count === 1, g0.count);
  // overlay 模式下窗口启动即全工作区尺寸，show 是异步的 —— 轮询等到可见为止
  let vis = g0.vis;
  for (let i = 0; i < 20 && !vis; i++) {
    await page.waitForTimeout(300);
    vis = (await diag()).vis;
  }
  ok('窗口已显示', vis === true);
  ok('显示器缩放被读到', typeof g0.scale === 'number', { scale: g0.scale, screen: [g0.wa.width, g0.wa.height] });

  await sendState();
  await page.waitForTimeout(700);

  const p0 = await probe();
  ok('页面已挂载，球渲染出来', p0 && p0.orbs === 3, p0);

  // ── 1) 静止态：球的下沉由页面 CSS 完成，窗口本身贴工作区底边 ──
  //    （X11/mutter 会把窗口钳制在工作区内，把窗口挪出屏幕会被拉回来）
  const g1 = await diag();
  const sinkPx = Math.round((CFG.size / 2) * CFG.sink);
  const winBottomGap = g1.wa.y + g1.wa.height - (g1.b.y + g1.b.height);
  ok('静止态：窗口贴在工作区底边', Math.abs(winBottomGap) <= 2, { winBottomGap });

  const orbGeom = await page.$$eval('.orb', (els) => {
    const winH = window.innerHeight;
    return els.map((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, bottomOverflow: +(r.bottom - winH).toFixed(2) };
    });
  });
  ok('静止态：球底边越出窗口 ' + sinkPx + 'px（视觉下沉）',
     orbGeom.length > 0 && orbGeom.every((o) => Math.abs(o.bottomOverflow - sinkPx) <= 2),
     orbGeom.map((o) => o.bottomOverflow));

  // ── 2) 水平居中 ──
  const cx = g1.b.x + g1.b.width / 2;
  const waCx = g1.wa.x + g1.wa.width / 2;
  ok('静止态：水平居中于屏幕', Math.abs(cx - waCx) <= 2, { cx, waCx });

  // ── 3) overlay 模型：窗口铺满工作区，定位不再依赖 setBounds ──
  //    （Wayland 不允许客户端定位窗口；mutter/XWayland 对小窗口的位置映射也不可靠，
  //      所以 Linux 上窗口直接铺满工作区，球由页面画在工作区底边）
  ok('静止态（overlay）：窗口铺满工作区宽', g1.b.width >= g1.wa.width - 2, { w: g1.b.width, screenW: g1.wa.width });
  ok('静止态（overlay）：窗口铺满工作区高', g1.b.height >= g1.wa.height - 2, { h: g1.b.height, screenH: g1.wa.height });

  // ── 4) 球的尺寸/间距/配色 ──
  const orbs = await page.$$eval('.orb', (els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, c: getComputedStyle(e).getPropertyValue('--c').trim() };
    })
  );
  ok('球直径 = 30', orbs.length === 3 && orbs.every((o) => Math.abs(o.w - 30) < 1.5), orbs.map((o) => Math.round(o.w)));
  ok('球间距 = 8', orbs.length > 1 && Math.abs(orbs[1].x - (orbs[0].x + orbs[0].w) - 8) < 1.5,
     orbs.length > 1 ? { gap: +(orbs[1].x - (orbs[0].x + orbs[0].w)).toFixed(1) } : null);
  ok('不同分支颜色不同', new Set(orbs.map((o) => o.c)).size === 3, orbs.map((o) => o.c));

  // ── 5) 静止态穿透 ──
  const idle = await probe();
  ok('静止态：穿透开启', idle.ignoring === true, idle);
  ok('静止态：lane = idle', idle.lane === 'idle', idle.lane);

  // ── 6) 悬停（真实指针）──
  const t = orbs[1];
  await warpToViewport(t.x + t.w / 2, t.y + t.h / 2);
  await page.waitForTimeout(700);
  const hov = await probe();
  const card = await page.$eval('#card', (e) => ({
    on: e.classList.contains('on'), w: e.offsetWidth, h: e.offsetHeight,
    branch: document.getElementById('branch').textContent,
    repo: document.getElementById('repo').textContent,
    meta: document.getElementById('meta').textContent,
  }));
  ok('悬停：卡片弹出', card.on === true);
  ok('悬停：显示分支名', card.branch === REPOS[1].branch, card.branch);
  ok('悬停：显示仓库名', card.repo === 'second', card.repo);
  ok('悬停：显示领先/落后', /↓1/.test(card.meta), card.meta);
  ok('悬停：取消穿透（球能点）', hov.ignoring === false, hov);
  ok('悬停：lane = hot', hov.lane === 'hot', hov.lane);

  // ── 7) overlay：窗口尺寸恒定（不再为卡片变高），卡片整体在屏内 ──
  const g2 = await diag();
  ok('悬停（overlay）：窗口尺寸不变', g2.b.height === g1.b.height && g2.b.width === g1.b.width,
     { idleH: g1.b.height, hotH: g2.b.height });
  ok('悬停：卡片完整落在窗口内', card.h > 0 && card.w > 0 && card.h < g1.b.height, { cardW: card.w, cardH: card.h });
  // 悬停时被悬停的那颗球本来就要上探（-lift），所以只检查"没被悬停的球"仍保持下沉。
  // 被悬停的那颗只要确认它确实抬起来了（比静止位置更靠上）。
  const hotGeom = await page.$$eval('.orb', (els) => {
    const winH = window.innerHeight;
    return els.map((e) => ({
      hot: e.classList.contains('hot'),
      bottomOverflow: +(e.getBoundingClientRect().bottom - winH).toFixed(2),
    }));
  });
  const coldOrbs = hotGeom.filter((o) => !o.hot);
  ok('悬停：未悬停的球仍然保持下沉 ' + sinkPx + 'px',
     coldOrbs.length > 0 && coldOrbs.every((o) => Math.abs(o.bottomOverflow - sinkPx) <= 2),
     hotGeom.map((o) => [o.hot ? 'hot' : 'cold', o.bottomOverflow]));
  ok('悬停：被悬停的球上探了',
     hotGeom.some((o) => o.hot && o.bottomOverflow < sinkPx - 5),
     hotGeom.filter((o) => o.hot).map((o) => o.bottomOverflow));

  // ── 8) 移开回落（真实指针挪到屏幕角落）──
  await warpToViewport(2, 2);
  await page.waitForTimeout(700);
  const g3 = await diag();
  const back = await probe();
  ok('移开：回到静止尺寸', Math.abs(g3.b.height - g1.b.height) <= 2, { idle: g1.b.height, after: g3.b.height });
  ok('移开：恢复穿透', back.ignoring === true);
  ok('移开：lane 回 idle', back.lane === 'idle', back.lane);

  // ── 9) 反复进出 20 次：窗口不许"发胖" ──
  const b9 = (await diag()).b;
  for (let i = 0; i < 20; i++) {
    await warpToViewport(t.x + t.w / 2, t.y + t.h / 2);
    await page.waitForTimeout(60);
    await warpToViewport(2, 2);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(500);
  const g4 = await diag();
  ok('进出 20 次后尺寸不漂移', g4.b.width === b9.width && Math.abs(g4.b.height - b9.height) <= 2,
     { before: [b9.width, b9.height], after: [g4.b.width, g4.b.height] });

  // ── 10) 停靠变体 ──
  const overflowOf = () => page.$$eval('.orb', (els) => {
    const winH = window.innerHeight;
    const winW = window.innerWidth;
    return els.map((e) => {
      const r = e.getBoundingClientRect();
      return { dBottom: +(r.bottom - winH).toFixed(1), dTop: +r.top.toFixed(1), dLeft: +r.left.toFixed(1), dRight: +(r.right - winW).toFixed(1) };
    });
  });

  await sendState({ ...CFG, dock: 'top' });
  await page.waitForTimeout(700);
  const gt = await diag();
  const ot = await overflowOf();
  ok('top：窗口贴工作区顶边', Math.abs(gt.b.y - gt.wa.y) <= 2, { y: gt.b.y, waY: gt.wa.y });
  ok('top：球上边缘越出窗口 ' + sinkPx + 'px', ot.length > 0 && ot.every((o) => Math.abs(o.dTop + sinkPx) <= 2), ot.map((o) => o.dTop));

  await sendState({ ...CFG, dock: 'bottom-right' });
  await page.waitForTimeout(700);
  const gr = await diag();
  ok('bottom-right：窗口右边缘贴工作区', Math.abs((gr.b.x + gr.b.width) - (gr.wa.x + gr.wa.width)) <= 2,
     { rightGap: gr.wa.x + gr.wa.width - (gr.b.x + gr.b.width) });

  await sendState({ ...CFG, dock: 'bottom-left' });
  await page.waitForTimeout(700);
  const gl = await diag();
  ok('bottom-left：窗口左边缘贴工作区', Math.abs(gl.b.x - gl.wa.x) <= 2, { x: gl.b.x, waX: gl.wa.x });

  // ── 11) offset：overlay 模式下由页面内平移完成（窗口不动）──
  const orbCx0 = await page.$$eval('.orb', (els) => {
    const r = els[0].getBoundingClientRect();
    return r.x + r.width / 2;
  });
  await sendState({ ...CFG, offset: -300 });
  await page.waitForTimeout(700);
  const go = await diag();
  ok('offset=-300：窗口不动（overlay）', go.b.width === g1.b.width && go.b.height === g1.b.height,
     { w: go.b.width, h: go.b.height });
  const orbCx1 = await page.$$eval('.orb', (els) => {
    const r = els[0].getBoundingClientRect();
    return r.x + r.width / 2;
  });
  ok('offset=-300 → 球列整体左移 300', Math.abs((orbCx1 - orbCx0) - (-300)) <= 4,
     { delta: +(orbCx1 - orbCx0).toFixed(1), want: -300 });
  await sendState();

  // ── 12) 无脚本错误 ──
  ok('页面无 JS 错误', pageErrors.length === 0, pageErrors.slice(0, 3));

  // ── 13) 截图 ──
  const shots = path.join(WORK, 'shots');
  fs.mkdirSync(shots, { recursive: true });
  await sendState();
  await page.waitForTimeout(700);
  await page.mouse.move(1, 1);
  await page.waitForTimeout(450);
  await page.screenshot({ path: path.join(shots, 'ball-idle.png') });
  const oc = await page.$$eval('.orb', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }));
  if (oc[0]) await warpToViewport(oc[0][0], oc[0][1]);
  await page.waitForTimeout(550);
  await page.screenshot({ path: path.join(shots, 'ball-hover.png') });

  const passed = results.filter((r) => r.pass).length;
  console.log('\n' + passed + '/' + results.length + ' passed');
  fs.writeFileSync(path.join(WORK, 'shell-selftest.json'), JSON.stringify(results, null, 2));
  await app.close();
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error('FAILED:', e && e.stack ? e.stack : e);
  process.exit(2);
});
