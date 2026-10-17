#!/usr/bin/env node
// 用 Playwright 托管方式启动 VSCode（本环境唯一能稳定跑起来的方式）
//
// 背景：直接 nohup / setsid 启动 /usr/share/code/code 时，主进程创建工作区日志目录后
// 就静默退出（logs/<ts>/ 是空的，main.log 完全没有），扩展宿主永远起不来。
// 而用 Playwright 的 _electron.launch 托管（走它自己的进程管理与环境注入），
// 同一个二进制、同一套参数就能正常跑到扩展宿主激活、豆子刷新。
//
// 用法：node launch-vscode-playwright.js [工程路径] [--keep]
//   --keep  脚本退出后不关闭 VSCode（默认关闭，因为 Playwright 关闭会带走进程）

const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const { _electron: electron } = require('playwright');

const WORK = '/home/hy/WorkBuddy/2026-10-17-12-49-03/.workbuddy';
const PROJ = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : '/home/hy/WorkBuddy/2026-10-15-23-45-07/esp32-jig-framwork';
const KEEP = process.argv.includes('--keep');

/* ⚠ 每轮必须用全新的 user-data-dir。
   复用同一个目录会踩两个坑：
     ① VSCode 单实例机制会把本次启动转交给上一轮残留的实例，
        新窗口根本没开，状态栏自然没有我们的条目；
     ② 上一轮的 boot.log 还在，会被误判成"本轮第 1 秒就激活了"
        （日志时间戳一比对就露馅）。 */
const UD = path.join(WORK, 'pw-ud-' + Date.now());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 清掉可能残留的实例，避免单实例转交
try {
  cp.execSync('pkill -f "/usr/share/code" 2>/dev/null || true', { stdio: 'ignore', shell: '/bin/bash' });
} catch (_) {}

(async () => {
  fs.mkdirSync(UD, { recursive: true });
  const boot = path.join(UD, 'User/globalStorage/heyuying.branch-orbs/boot.log');
  // 新目录本来就没有 boot.log，但保险起见显式确认一次
  if (fs.existsSync(boot)) fs.unlinkSync(boot);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  delete env.VSCODE_IPC_HOOK_CLI;
  env.DISPLAY = env.DISPLAY || ':0';
  env.PATH = '/home/hy/.workbuddy/binaries/tools/bin:' + env.PATH;
  env.TMPDIR = path.join(WORK, 'tmp');
  env.BRANCH_ORBS_ELECTRON = path.join(WORK, 'electron-runtime/node_modules/electron/dist/electron');
  fs.mkdirSync(env.TMPDIR, { recursive: true });

  console.log('──────── Branch Orbs 启动器（Playwright 托管）────────');
  console.log(' 工程     ' + PROJ);
  console.log(' git      ' + (fs.existsSync('/home/hy/.workbuddy/binaries/tools/bin/git') ? '✅' : '❌'));
  console.log(' electron ' + (fs.existsSync(env.BRANCH_ORBS_ELECTRON) ? '✅' : '❌'));
  console.log(' 扩展     ' + (fs.existsSync('/home/hy/.vscode/extensions/heyuying.branch-orbs-0.1.0') ? '✅' : '❌'));
  console.log('────────────────────────────────────────────────');

  console.log('启动 VSCode…');
  const app = await electron.launch({
    executablePath: '/usr/share/code/code',
    args: [
      '--user-data-dir=' + UD,
      '--extensions-dir=/home/hy/.vscode/extensions',
      '--no-sandbox',
      '--ozone-platform=x11',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--new-window',
      PROJ,
    ],
    env,
    timeout: 60000,
  });

  const win = await app.firstWindow({ timeout: 60000 });
  await win.waitForLoadState('domcontentloaded');
  console.log('窗口就绪，等待扩展激活（首启约 45~60 秒）…');

  /* 轮询 boot.log 出现。注意不能只判断"文件存在" —— 上一轮同目录的残留日志
     会让这里第 1 秒就返回 true，结论完全错（已踩过一次）。
     现在用全新 UD 目录 + 反查日志里的 workspaceFolders 确认是本轮。 */
  let activated = -1;
  let bootText = '';
  for (let i = 1; i <= 120; i++) {
    if (fs.existsSync(boot)) {
      bootText = fs.readFileSync(boot, 'utf8');
      if (bootText.includes(PROJ)) {
        activated = i;
        break;
      }
    }
    if (i % 15 === 0) console.log('   … 已等 ' + i + 's');
    await sleep(1000);
  }

  if (activated < 0) {
    console.log('❌ 120s 内扩展未激活（boot.log 未出现或内容不属于本轮工程）');
    console.log('   boot.log 路径：' + boot);
    if (bootText) console.log('   内容片段：' + bootText.slice(0, 300));
    await app.close();
    process.exit(1);
  }
  console.log('✅ 第 ' + activated + ' 秒扩展已激活');
  await sleep(10000); // 等 git 读完、豆子刷成分支名

  // 打印激活日志（滤掉 dbus 之类噪声）
  console.log('\n──────── 激活日志 ────────');
  const keep = /workspaceFolders|git=|statusItem created|renderStatus shown|about to|shell booted|createWindow|refresh 完成|兜底/;
  for (const line of fs.readFileSync(boot, 'utf8').split('\n')) {
    if (keep.test(line)) console.log('  ' + line);
  }

  // 读状态栏真实 DOM
  const st = await win.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.statusbar-item'));
    return items
      .filter((el) => /Branch Orbs/.test((el.getAttribute('aria-label') || '') + (el.textContent || '')))
      .map((el) => ({
        text: (el.textContent || '').trim(),
        aria: el.getAttribute('aria-label'),
        w: el.offsetWidth,
        h: el.offsetHeight,
      }));
  });

  console.log('\n──────── 状态栏豆子 ────────');
  if (st.length === 0) {
    console.log('  ❌ 状态栏里没有 Branch Orbs 条目');
  } else {
    for (const x of st) {
      console.log('  文本: ' + x.text + '   宽高: ' + x.w + '×' + x.h);
      console.log('  aria: ' + (x.aria || '').split('\n').join(' | '));
    }
  }

  const good = st.some((x) => /new_s11x_motor|circle-large-filled/.test((x.aria || '') + x.text));
  console.log('\n' + (good
    ? '✅ 一切正常：豆子已显示真实分支，悬浮球应已出现在屏幕底边。'
    : '⚠️ 豆子未拿到分支名，运行 bash ~/branch-orbs-diag.sh 进一步排查。'));

  // 存一张 VSCode 窗口截图，方便肉眼确认状态栏
  try {
    const shotDir = path.join(WORK, 'shots');
    fs.mkdirSync(shotDir, { recursive: true });
    const shot = path.join(shotDir, 'vscode-statusbar.png');
    const img = await win.screenshot({ path: shot });
    console.log('\n截图已保存：' + shot + '（' + img.length + ' 字节）');
  } catch (e) {
    console.log('截图失败：' + e.message);
  }

  if (!KEEP) {
    console.log('\n（用 --keep 可保持 VSCode 不关闭）');
    await app.close();
  } else {
    console.log('\nVSCode 保持运行中。按 Ctrl+C 结束。');
    await new Promise(() => {});
  }
  process.exit(good ? 0 : 1);
})().catch((e) => {
  console.error('启动失败：' + e.message);
  process.exit(2);
});
