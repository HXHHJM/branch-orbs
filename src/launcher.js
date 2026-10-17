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
 */
function makeShimApp(root) {
  const dir = path.join(os.tmpdir(), 'branch-orbs-app');
  fs.mkdirSync(dir, { recursive: true });
  const pkg = { name: 'branch-orbs', version: '0.1.0', main: path.join(root, 'shell', 'main.js') };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  return dir;
}

function devShmTooSmall() {
  if (process.platform !== 'linux') return false;
  try {
    const out = execFileSync('df', ['-k', '/dev/shm'], { encoding: 'utf8' });
    const line = out.trim().split('\n').pop() || '';
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
  const args = [];
  const bundled = path.join(root, 'shell', 'node_modules', 'electron', 'dist', 'electron');
  const isBundled = path.resolve(electron) === path.resolve(bundled);
  if (!isBundled) args.push(makeShimApp(root));
  args.push(path.join(root, 'shell'));
  if (o.extra) args.push(...o.extra);
  args.push(...(BASE_FLAGS[process.platform] || []));
  if (devShmTooSmall()) args.push('--disable-dev-shm-usage');
  if (process.platform === 'linux' && process.getuid && process.getuid() === 0) args.push('--no-sandbox');
  return { electron, args, isBundled };
}

function spawnEnv(root, opts) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  env.BRANCH_ORBS_HTML = path.join(root, 'shell', 'orbs.html');
  env.BRANCH_ORBS_USER_DATA = (opts && opts.userData) || path.join(os.tmpdir(), 'branch-orbs-ud');
  env.BRANCH_ORBS_LOG = (opts && opts.logFile) || path.join(os.tmpdir(), 'branch-orbs.log');
  // 临时目录不要落在 10MB 的 /tmp 上
  if (process.platform === 'linux' && (opts && opts.tmpdir)) env.TMPDIR = opts.tmpdir;
  return env;
}

module.exports = { findElectron, launchArgs, spawnEnv, makeShimApp, devShmTooSmall, candidates, shallowFindElectron };
