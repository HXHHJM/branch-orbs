'use strict';
// 跨窗口仓库注册表：让"所有 VSCode 窗口的仓库"都变成球。
//
// 背景：扩展是**按窗口**跑的 —— 每个窗口有独立的扩展宿主。窗口 A 的扩展
// 看不到窗口 B 打开了什么工程，所以默认只能显示自己窗口的仓库。
//
// 做法：每个窗口把"我有哪些仓库"写到共享目录里的一个 JSON 文件（按窗口 id 命名），
// 然后读回全部文件，按仓库根路径去重合并。带心跳（updatedAt），
// 窗口关掉后文件不再更新，超过 TTL 就当它过期、自动剔除 —— 不需要谁去清理。
//
// 这个文件不 require('vscode')，方便在 Node 下单独跑测试。

const fs = require('fs');
const path = require('path');

/** 心跳超过这个时间（ms）就认为窗口已关闭/失效，不再计入 */
const STALE_MS = 45 * 1000;

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch (_) {
    return false;
  }
}

/** 文件名用窗口 id；Windows 上有非法字符，统一替换掉 */
function safeName(id) {
  return String(id || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * 写入本窗口的仓库快照。
 * @param {string} dir     共享目录
 * @param {string} winId   窗口标识（扩展侧用 context.globalState 里的 uuid）
 * @param {Array}  repos   仓库数组
 * @param {object} extra   { workspace: string[] } 便于排障
 */
function writeWindowRepos(dir, winId, repos, extra) {
  if (!ensureDir(dir)) return false;
  const payload = {
    windowId: String(winId || 'unknown'),
    updatedAt: Date.now(),
    pid: process.pid,
    workspace: (extra && extra.workspace) || [],
    repos: (repos || []).map((r) => ({
      root: r.root,
      name: r.name,
      branch: r.branch,
      detached: !!r.detached,
      ahead: r.ahead || 0,
      behind: r.behind || 0,
      changed: r.changed || 0,
      added: r.added || 0,
      deleted: r.deleted || 0,
      lastCommit: r.lastCommit || null,
      isActive: !!r.isActive,
      error: r.error || null,
    })),
  };
  const file = path.join(dir, safeName(winId) + '.json');
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, file); // 原子替换，避免别的窗口读到半截 JSON
    return true;
  } catch (_) {
    try {
      fs.unlinkSync(tmp);
    } catch (__) {}
    return false;
  }
}

/**
 * 读出所有窗口的仓库，按 root 去重合并。
 * 同一仓库被多个窗口打开时（罕见，但会发生：同一工程开两次），
 * 保留"更新时间更晚"的那份，并给 isActive 一个或关系 —— 任一窗口里它处于活动状态就算活动。
 *
 * @returns {{ repos: Array, windows: Array<{windowId, ageMs, count, workspace}> }}
 */
function readAllRepos(dir, now) {
  const t = typeof now === 'number' ? now : Date.now();
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    return { repos: [], windows: [] };
  }

  const windows = [];
  const byRoot = new Map();

  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const full = path.join(dir, name);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (_) {
      continue;
    }
    if (!data || typeof data.updatedAt !== 'number') continue;

    const age = t - data.updatedAt;
    if (age > STALE_MS) {
      // 窗口早就没了，顺手把这个孤儿文件删掉，别让它越堆越多
      try {
        fs.unlinkSync(full);
      } catch (_) {}
      continue;
    }

    windows.push({
      windowId: data.windowId,
      ageMs: age,
      count: Array.isArray(data.repos) ? data.repos.length : 0,
      workspace: data.workspace || [],
    });

    for (const r of data.repos || []) {
      if (!r || !r.root) continue;
      const prev = byRoot.get(r.root);
      if (!prev) {
        byRoot.set(r.root, { ...r, _updatedAt: data.updatedAt, windowId: data.windowId });
      } else {
        // 合并：活动状态取或，数据取更新的那份
        const newer = data.updatedAt > prev._updatedAt ? { ...r, _updatedAt: data.updatedAt, windowId: data.windowId } : prev;
        newer.isActive = !!(prev.isActive || r.isActive);
        byRoot.set(r.root, newer);
      }
    }
  }

  const repos = Array.from(byRoot.values()).map((r) => {
    const { _updatedAt, windowId, ...rest } = r;
    return rest;
  });

  // 稳定顺序：活动仓库排最前，其余按名字排 —— 别让球的顺序每次刷新都乱跳
  repos.sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    return String(a.name).localeCompare(String(b.name));
  });

  return { repos, windows };
}

/**
 * 窗口关闭时主动摘掉自己的注册表文件。
 * 不做也能工作（readAllRepos 会按 TTL 剔掉过期的），但主动清理让别的窗口
 * 立刻少一颗球，而不是等 45 秒。
 */
function removeWindow(dir, winId) {
  const file = path.join(dir, safeName(winId) + '.json');
  try {
    fs.unlinkSync(file);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { writeWindowRepos, readAllRepos, removeWindow, ensureDir, safeName, STALE_MS };
