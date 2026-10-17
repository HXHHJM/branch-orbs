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
  // ③ VSCode 自己的 Electron：把 resources/app 换成一个只有 main 的临时 app 目录即可复用二进制
  //    这条在"用户机器上只有 VSCode、没装 electron"时是唯一的出路。
  const vscodeRes = process.env.VSCODE_RESOURCES || '/usr/share/code/resources';
  out.push(path.join(vscodeRes, 'app', 'node_modules', 'electron', 'dist', 'electron'));
  // ④ 常见系统安装位置
  out.push('/usr/lib/electron/electron', '/usr/lib/electron4/electron', '/opt/Electron/electron');
  if (process.platform === 'darwin') out.push('/Applications/Visual Studio Code.app/Contents/MacOS/Electron');
  if (process.platform === 'win32') {
    out.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'));
  }
  return out.filter(Boolean);
}

function findElectron(root) {
  for (const c of candidates(root)) {
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

module.exports = { findElectron, launchArgs, spawnEnv, makeShimApp, devShmTooSmall, candidates };
