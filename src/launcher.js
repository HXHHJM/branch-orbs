'use strict';
// 壳进程的启动器：找到 Electron 可执行文件并拉起 shell/main.js
//
// 关键约束（每一条都踩过）：
//   1. 必须 unset ELECTRON_RUN_AS_NODE —— 环境里若带着它，Electron 会退化成纯 node，
//      GUI 参数全部被当成"bad option"，最后什么都不显示（本机就是这种情况）。
//   2. 不能用 code 自带的 resources/app/code 去跑自己的脚本：VSCode 的 app 会被当成入口。
//      要么用 electron 依赖，要么用系统里另一个 electron 安装。
//   3. Linux 上 /dev/shm 小于 ~64MB 时 Chromium 会 FATAL（font_data_service ENOSPC）。
//      发现太小就自动加 --disable-dev-shm-usage，让它走 /tmp 之外的临时目录。
//   4. 子进程 stdout 是协议通道，启动期的任何杂音都会打乱它 —— 所以 spawn 时把
//      stdio 显式指定为 ['pipe','pipe','pipe']，并且绝不在 stdout 上写非 JSON。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

function exists(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 候选 Electron 可执行文件（按优先级） */
function candidates(root) {
  const out = [];
  // ① 扩展自带的依赖（打包发布后走这条）
  const bundled = path.join(root, 'shell', 'node_modules', 'electron');
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(bundled, 'package.json'), 'utf8'));
    void pj;
    const p = path.join(bundled, 'dist', 'electron');
    out.push(p);
  } catch (_) {}
  // ② 环境变量直指（CI / 自测）
  if (process.env.BRANCH_ORBS_ELECTRON) out.push(process.env.BRANCH_ORBS_ELECTRON);
  // ②' 固化安装位置：install 时把 electron 运行时拷到这里（见 scripts/install-electron.sh）。
  //    ⚠ 踩过的坑：用户从桌面图标启动 VSCode 时，进程环境里**没有** BRANCH_ORBS_ELECTRON，
  //    之前只靠环境变量 + VSCode 内嵌副本（VSCode 根本不带）→ 永远找不到 → 弹"看不到悬浮球"。
  const home = os.homedir();
  out.push(path.join(home, '.branch-orbs', 'electron', 'node_modules', 'electron', 'dist', 'electron'));
  // ③ VSCode 自己的 Electron：把 resources/app 换成一个只有 main 的临时 app 目录即可复用二进制
  const vscodeRes = process.env.VSCODE_RESOURCES || '/usr/share/code/resources';
  out.push(path.join(vscodeRes, 'app', 'node_modules', 'electron', 'dist', 'electron'));
  // ④ 常见系统安装位置 + npm 全局
  out.push(
    '/usr/lib/electron/electron',
    '/usr/lib/electron4/electron',
    '/opt/Electron/electron',
    path.join(home, '.npm-global', 'lib', 'node_modules', 'electron', 'dist', 'electron'),
    '/usr/lib/node_modules/electron/dist/electron'
  );
  if (process.platform === 'darwin') out.push('/Applications/Visual Studio Code.app/Contents/MacOS/Electron');
  if (process.platform === 'win32') {
    out.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'));
  }
  return out.filter(Boolean);
}

/** 浅扫兜底：上面全失败时在 home//opt//usr/local 里找形如 dist/electron 的二进制（深度 4） */
function shallowFindElectron() {
  if (process.platform === 'win32') return [];
  const roots = [os.homedir(), '/opt', '/usr/local'];
  const found = [];
  const MAX = 4;
  const walk = (dir, depth) => {
    if (depth > MAX || found.length >= 5) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      if (found.length >= 5) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (['proc', 'sys', 'dev', 'snap', 'lib32', 'libx32', 'share', 'man'].includes(e.name)) continue;
        walk(full, depth + 1);
      } else if (e.name === 'electron' && dir.endsWith(path.join('dist')) ) {
        try {
          fs.accessSync(full, fs.constants.X_OK);
          found.push(full);
        } catch (_) {}
      }
    }
  };
  for (const r of roots) walk(r, 0);
  return found;
}

function findElectron(root) {
  for (const c of candidates(root)) {
    if (exists(c)) return c;
  }
  for (const c of shallowFindElectron()) {
    if (exists(c)) return c;
  }
  return null;
}

/**
 * 若只能用 VSCode 自带的 Electron（它的 resources/app 是 VSCode 本体），
 * 就造一个极小的 app 目录把 resources/app 顶掉，让二进制去跑我们的 main.js。
 *
 * ⚠ 不能放 os.tmpdir()：容器/精简系统上 /tmp 常常是 10MB 的 tmpfs，
 *   写 package.json 都可能失败；而且 /tmp 会被系统清理，壳启动到一半路径就没了。
 *   放到 ~/.branch-orbs/shim 下（和 Electron 运行时同一个持久目录）。
 */
function makeShimApp(root) {
  const dir = path.join(os.homedir(), '.branch-orbs', 'shim');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    // HOME 不可写才退回 tmp
    const alt = path.join(os.tmpdir(), 'branch-orbs-app');
    fs.mkdirSync(alt, { recursive: true });
    fs.writeFileSync(path.join(alt, 'package.json'), JSON.stringify({ name: 'branch-orbs', version: '0.1.0', main: path.join(root, 'shell', 'main.js') }));
    return alt;
  }
  const pkg = { name: 'branch-orbs', version: '0.1.0', main: path.join(root, 'shell', 'main.js') };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  return dir;
}

/* /dev/shm 太小会让 Chromium 的字体服务直接 FATAL 掉：
     FATAL components/services/font_data/font_data_service_impl.cc:379
     Check failed: . : 设备上没有空间 (28)
   症状极具误导性 —— 壳进程活着、窗口在正确位置，但**球永远画不出来**，
   日志里没有 page: 也没有 measure，看起来像"页面 JS 没跑"。
   容器里 /dev/shm 常常只有 64MB 甚至 10MB，必须传 --disable-dev-shm-usage
   让它改用 /tmp 做共享内存。 */
function devShmTooSmall() {
  if (process.platform !== 'linux') return false;
  try {
    const out = execFileSync('df', ['-k', '/dev/shm'], { encoding: 'utf8' });
    const line = out.trim().split('\n').pop() || '';
    // df -k 的第 4 列是 Available（字段顺序不是固定的，用正则找数字更稳）
    const kb = parseInt(line.split(/\s+/)[3], 10);
    if (Number.isFinite(kb)) return kb < 64 * 1024;
  } catch (_) {}
  return false;
}

const BASE_FLAGS = {
  linux: ['--ozone-platform=x11'],
  win32: [],
  darwin: [],
};

function launchArgs(root, opts) {
  const o = opts || {};
  const electron = o.electron || findElectron(root);
  if (!electron) return null;
  /* ⚠ 不要把 Chromium 开关（--no-sandbox / --disable-dev-shm-usage /
     --ozone-platform）放在命令行上！这个 Electron 构建会直接拒绝：
       electron: bad option: --no-sandbox
     进程秒退，扩展侧只看到"壳启动后立刻消失"。
     这些开关统一在 shell/main.js 里用 app.commandLine.appendSwitch 设置
     —— 那里一定生效，且不受 CLI 解析规则限制。
     这里只负责：应用路径（顺序有意义）。 */
  const args = [];
  const bundled = path.join(root, 'shell', 'node_modules', 'electron', 'dist', 'electron');
  const isBundled = path.resolve(electron) === path.resolve(bundled);
  if (!isBundled) args.push(makeShimApp(root));
  args.push(path.join(root, 'shell'));
  if (o.extra) args.push(...o.extra);

  return { electron, args, isBundled };
}

/* 壳进程的临时/数据目录 —— 全部落在 ~/.branch-orbs 下，**绝不用 os.tmpdir()**。
   ⚠ 这是本轮排查出来的最深的坑：
     容器/精简系统的 /tmp 常常是 10MB 的 tmpfs。Chromium 的字体服务
     （font_data_service）要把字体数据写共享内存，空间不够就
       FATAL components/services/font_data/font_data_service_impl.cc:379
       Check failed: . : 设备上没有空间 (28)
     整个 renderer 直接崩掉。症状极具误导性：
       壳进程活着 / 窗口在正确位置 / preload 注入成功 / did-finish-load 成功
       但 page probe 显示 balls:0，页面再也没上报 measure，日志干净得像没问题。
     光加 --disable-dev-shm-usage 不够 —— 它只是把共享内存从 /dev/shm 挪到
     TMPDIR，如果 TMPDIR 本身也是小 tmpfs，照样爆。
     所以：TMPDIR + userData + 日志 全部指到 ~/.branch-orbs。 */
function persistentTmp(root) {
  const base = path.join(os.homedir(), '.branch-orbs', 'tmp');
  try {
    fs.mkdirSync(base, { recursive: true });
    return base;
  } catch (_) {
    return os.tmpdir();
  }
}

function spawnEnv(root, opts) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const tmp = (opts && opts.tmpdir) || persistentTmp(root);
  env.BRANCH_ORBS_HTML = path.join(root, 'shell', 'orbs.html');
  env.BRANCH_ORBS_USER_DATA = (opts && opts.userData) || path.join(os.homedir(), '.branch-orbs', 'shell-ud');
  env.BRANCH_ORBS_LOG = (opts && opts.logFile) || path.join(tmp, 'branch-orbs.log');
  if (process.platform === 'linux') {
    env.TMPDIR = tmp;
    env.TMP = tmp;
    env.TEMP = tmp;
    // Chromium 自己的缓存目录别落在 /tmp
    env.XDG_CACHE_HOME = env.XDG_CACHE_HOME || path.join(os.homedir(), '.branch-orbs', 'cache');
  }
  return env;
}

module.exports = { findElectron, launchArgs, spawnEnv, makeShimApp, devShmTooSmall, persistentTmp, candidates, shallowFindElectron };
