// 跨窗口注册表自测：多窗口合并、去重、TTL 过期、主动摘除
//
// 用法：node test/registry-selftest.js
// 不需要 VSCode，也不需要 Electron —— 纯文件系统逻辑。
const path = require('path');
const fs = require('fs');
const os = require('os');
const { writeWindowRepos, readAllRepos, removeWindow, STALE_MS } = require('../src/registry');

const results = [];
const ok = (name, cond, extra) => {
  results.push({ name, pass: !!cond });
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra === undefined ? '' : '   ' + JSON.stringify(extra)));
};

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orbs-reg-'));

const repo = (name, branch, extra) => ({
  root: '/x/' + name,
  name,
  branch,
  changed: 0,
  added: 0,
  deleted: 0,
  ahead: 0,
  behind: 0,
  isActive: false,
  ...extra,
});

// ── 1. 空目录 ──
{
  const r = readAllRepos(DIR);
  ok('空目录返回空数组', r.repos.length === 0 && r.windows.length === 0, r);
}

// ── 2. 单窗口 ──
{
  writeWindowRepos(DIR, 'w-a', [repo('alpha', 'main', { isActive: true })], { workspace: ['/x/alpha'] });
  const r = readAllRepos(DIR);
  ok('单窗口能读到仓库', r.repos.length === 1 && r.repos[0].branch === 'main', r.repos);
  ok('窗口计数为 1', r.windows.length === 1, r.windows);
}

// ── 3. 两个窗口，不同仓库 → 合并成两个 ──
{
  writeWindowRepos(DIR, 'w-b', [repo('beta', 'dev')], { workspace: ['/x/beta'] });
  const r = readAllRepos(DIR);
  const names = r.repos.map((x) => x.name).sort();
  ok('两窗口两仓库都保留', names.length === 2 && names.join(',') === 'alpha,beta', names);
  ok('窗口计数为 2', r.windows.length === 2, r.windows.map((w) => w.windowId));
}

// ── 4. 两个窗口打开同一个仓库 → 去重成一个 ──
{
  writeWindowRepos(DIR, 'w-c', [repo('alpha', 'main')], { workspace: ['/x/alpha'] });
  const r = readAllRepos(DIR);
  const alphaCount = r.repos.filter((x) => x.root === '/x/alpha').length;
  ok('同仓库被去重', alphaCount === 1, { alphaCount, total: r.repos.length });
  ok('去重后 isActive 取或', r.repos.find((x) => x.root === '/x/alpha').isActive === true, r.repos.find((x) => x.root === '/x/alpha'));
  removeWindow(DIR, 'w-c');
}

// ── 5. 更新同名窗口 → 覆盖而不是叠加 ──
{
  writeWindowRepos(DIR, 'w-a', [repo('alpha', 'feature/new')], { workspace: ['/x/alpha'] });
  const r = readAllRepos(DIR);
  const a = r.repos.find((x) => x.root === '/x/alpha');
  ok('同窗口重写会覆盖分支', a && a.branch === 'feature/new', a && a.branch);
}

// ── 6. TTL 过期 → 剔除并删除文件 ──
{
  const DIR2 = fs.mkdtempSync(path.join(os.tmpdir(), 'orbs-reg2-'));
  writeWindowRepos(DIR2, 'dead', [repo('ghost', 'main')], {});
  const before = readAllRepos(DIR2);
  ok('过期前能读到', before.repos.length === 1, before.repos.length);
  // 用"未来时间"读，模拟 45s 后
  const after = readAllRepos(DIR2, Date.now() + STALE_MS + 1000);
  ok('过期后被剔除', after.repos.length === 0, after.repos.length);
  ok('过期文件被物理删除', fs.readdirSync(DIR2).filter((f) => f.endsWith('.json')).length === 0, fs.readdirSync(DIR2));
}

// ── 7. 坏 JSON 不影响其他窗口 ──
{
  const DIR3 = fs.mkdtempSync(path.join(os.tmpdir(), 'orbs-reg3-'));
  writeWindowRepos(DIR3, 'good', [repo('goodrepo', 'main')], {});
  fs.writeFileSync(path.join(DIR3, 'broken.json'), '{ this is not json');
  const r = readAllRepos(DIR3);
  ok('坏 JSON 被跳过，好数据保留', r.repos.length === 1 && r.repos[0].name === 'goodrepo', r.repos.map((x) => x.name));
}

// ── 8. 主动摘除 ──
{
  const DIR4 = fs.mkdtempSync(path.join(os.tmpdir(), 'orbs-reg4-'));
  writeWindowRepos(DIR4, 'tmpwin', [repo('tmp', 'main')], {});
  ok('摘除前有数据', readAllRepos(DIR4).repos.length === 1);
  removeWindow(DIR4, 'tmpwin');
  ok('摘除后立刻消失', readAllRepos(DIR4).repos.length === 0);
}

// ── 9. 排序：活动仓库在前 ──
{
  const DIR5 = fs.mkdtempSync(path.join(os.tmpdir(), 'orbs-reg5-'));
  writeWindowRepos(DIR5, 'w1', [repo('zzz', 'main', { isActive: true }), repo('aaa', 'dev')], {});
  const r = readAllRepos(DIR5);
  ok('活动仓库排最前', r.repos[0].name === 'zzz', r.repos.map((x) => x.name));
  ok('其余按名字排序', r.repos[1].name === 'aaa', r.repos.map((x) => x.name));
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
