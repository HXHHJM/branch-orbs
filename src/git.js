'use strict';
// 仓库模型：发现工作区里的 git 仓库，读到"当前分支 + 改动数 + 最近提交"。
//
// 纪律：这个文件同时被激活进 VSCode，也被 scripts/diag.js 在纯 Node 下复用。
// 所以它 **不 require('vscode')**，只吃一个 ctx 对象：
//   ctx.exec(cwd, args) -> Promise<{code, stdout, stderr}>
//   ctx.workspaceFolders() -> string[]
//   ctx.warn(msg) -> void

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

/** 一个目录是不是 git 仓库根（.git 可能是目录，也可能是 worktree/submodule 的 gitfile） */
function isRepoRoot(dir) {
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

/** 从 dir 向上找到最近的仓库根；碰到文件系统根就放弃 */
function findGitRoot(dir) {
  let cur = path.resolve(dir);
  for (let i = 0; i < 40; i++) {
    if (isRepoRoot(cur)) return cur;
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
  return null;
}

function nodeCtx() {
  return {
    workspaceFolders: () => [],
    warn: (m) => process.stderr.write(String(m) + '\n'),
    exec: (cwd, args) =>
      new Promise((resolve) => {
        execFile(
          'git',
          ['-c', 'core.quotepath=false', ...args],
          { cwd, timeout: 8000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
          (err, stdout, stderr) =>
            resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout || '', stderr: stderr || '' })
        );
      }),
  };
}

/**
 * 收集仓库列表。
 * 规则（按优先级，去重后截断到 max）：
 *   1. 当前活动文件所在的仓库（编辑到哪，球就跟到哪，排最前面）
 *   2. 多根工作区里的每个文件夹（各自最近的仓库根）
 *   3. 单根工作区：根目录及其直接子目录（含隐藏目录的兄弟，比如 packages/*）
 */
async function discoverRepos(ctx, opts) {
  const max = Math.max(1, opts && opts.max ? opts.max : 6);
  const activeDir = (opts && opts.activeDir) || null;
  const found = [];
  const seen = new Set();

  const add = (root) => {
    if (!root || seen.has(root)) return;
    seen.add(root);
    found.push(root);
  };

  // 自测/无 vscode 时可以直接传 roots
  const folders = opts && opts.workspaceFolders ? opts.workspaceFolders : ctx.workspaceFolders() || [];

  if (activeDir) add(findGitRoot(activeDir));

  for (const f of folders) add(findGitRoot(f));

  if (folders.length === 1) {
    const root = findGitRoot(folders[0]) || path.resolve(folders[0]);
    add(root);
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      entries = [];
    }
    entries
      .filter((d) => d.isDirectory() && !['node_modules', '.git'].includes(d.name))
      .map((d) => path.join(root, d.name))
      .filter(isRepoRoot)
      .forEach(add);
  }

  return found.slice(0, max);
}

async function git(ctx, cwd, args) {
  const r = await ctx.exec(cwd, args);
  return r.code === 0 ? r.stdout : null;
}

/** 解析 `git status --porcelain=v2 --branch` 的头部 */
function parseStatusV2(text) {
  const out = { branch: '', detached: false, ahead: 0, behind: 0, changed: 0, added: 0, deleted: 0 };
  if (!text) return out;
  for (const line of text.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const v = line.slice('# branch.head '.length).trim();
      if (v === '(detached)') out.detached = true;
      else out.branch = v;
    } else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+)\s+-(\d+)/.exec(line);
      if (m) {
        out.ahead = +m[1];
        out.behind = +m[2];
      }
    } else if (line.length > 2 && (line[0] === '1' || line[0] === '2' || line[0] === 'u')) {
      out.changed++;
    }
  }
  return out;
}

/** 数 `git diff --numstat` 的增删行（只统计已跟踪文件，未跟踪的不算行数） */
function parseNumstat(text) {
  let added = 0;
  let deleted = 0;
  if (!text) return { added, deleted };
  for (const line of text.split('\n')) {
    const m = /^(-|\d+)\t(-|\d+)\t/.exec(line);
    if (!m) continue;
    if (m[1] !== '-') added += +m[1];
    if (m[2] !== '-') deleted += +m[2];
  }
  return { added, deleted };
}

/** 把一个仓库读成一个"球"的数据 */
async function readRepo(ctx, root) {
  const name = path.basename(root);
  const info = {
    root,
    name,
    branch: '',
    detached: false,
    ahead: 0,
    behind: 0,
    changed: 0,
    added: 0,
    deleted: 0,
    lastCommit: null,
    error: null,
  };

  const statusText = await git(ctx, root, ['status', '--porcelain=v2', '--branch', '-uno']);
  if (statusText == null) {
    info.error = 'not-a-repo';
    return info;
  }
  Object.assign(info, parseStatusV2(statusText));

  // 空仓库（还没有任何提交）：status 会返回未出生的分支名（master/main），
  // 但这时树是空的、也没有"当前分支"可言 —— 明确显示成 (no commits) 更好读。
  const hasCommit = (await git(ctx, root, ['rev-parse', '--verify', 'HEAD'])) != null;
  if (!hasCommit) {
    info.branch = '(no commits)';
  } else if (info.detached) {
    // detached（CI 检出、rebase 中间态）：用短 sha 代替分支名
    const sha = await git(ctx, root, ['rev-parse', '--short', 'HEAD']);
    info.branch = '@' + ((sha || '').trim() || 'HEAD');
  }

  // 只改未暂存/已暂存的行数：diff HEAD 一次拿全（含暂存）
  const [numstat, log] = await Promise.all([
    git(ctx, root, ['diff', '--numstat', 'HEAD']).then((t) => t ?? git(ctx, root, ['diff', '--numstat'])),
    git(ctx, root, ['log', '-1', '--pretty=%s\x1f%ar\x1f%an']),
  ]);
  const lines = parseNumstat(numstat);
  info.added = lines.added;
  info.deleted = lines.deleted;

  if (log) {
    const parts = log.replace(/\n$/, '').split('\x1f');
    info.lastCommit = { subject: parts[0] || '', when: parts[1] || '', author: parts[2] || '' };
  }
  return info;
}

module.exports = { discoverRepos, readRepo, findGitRoot, isRepoRoot, parseStatusV2, parseNumstat, nodeCtx };
