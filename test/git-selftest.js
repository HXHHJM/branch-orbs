// git.js 的纯 node 自测：造几个临时仓库，验证解析逻辑
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const gitModel = require('../src/git');

const TMP = '/home/hy/WorkBuddy/2026-10-17-12-49-03/.workbuddy/tmp/repos';
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

function sh(cwd, cmd) {
  return cp.execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function mkrepo(name, branch, opts) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, 'git init -q');
  sh(dir, 'git config user.email t@t.t');
  sh(dir, 'git config user.name tester');
  sh(dir, 'git config commit.gpgsign false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  sh(dir, 'git add -A && git commit -qm "init commit"');
  sh(dir, `git checkout -q -b ${branch}`);
  if (opts && opts.dirty) {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\nworld\nmore\n');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'untracked\n');
  }
  return dir;
}

const results = [];
const ok = (n, c, extra) => {
  results.push({ name: n, pass: !!c, extra });
  console.log((c ? 'PASS  ' : 'FAIL  ') + n + (extra === undefined ? '' : '  ' + JSON.stringify(extra)));
};

(async () => {
  const ctx = gitModel.nodeCtx();
  const r1 = mkrepo('alpha', 'feature/charge-threshold', { dirty: true });
  const r2 = mkrepo('beta', 'main', {});

  // 1) 分支名
  const a = await gitModel.readRepo(ctx, r1);
  ok('读到分支名', a.branch === 'feature/charge-threshold', a.branch);
  ok('改动数 = 1（已跟踪）', a.changed === 1, { changed: a.changed });
  ok('增删行数被统计', a.added > 0, { added: a.added, deleted: a.deleted });
  ok('最近提交被读到', a.lastCommit && a.lastCommit.subject === 'init commit', a.lastCommit && a.lastCommit.subject);

  // 2) 干净仓库
  const b = await gitModel.readRepo(ctx, r2);
  ok('干净仓库 changed=0', b.changed === 0, b.changed);
  ok('干净仓库分支名 = main', b.branch === 'main', b.branch);

  // 3) 向上查找仓库根
  const deep = path.join(r1, 'x', 'y', 'z');
  fs.mkdirSync(deep, { recursive: true });
  ok('能从深层目录找到仓库根', gitModel.findGitRoot(deep) === r1, { got: gitModel.findGitRoot(deep), want: r1 });

  // 4) 非仓库返回 null
  const plain = path.join(TMP, 'plain');
  fs.mkdirSync(plain, { recursive: true });
  ok('非仓库返回 null', gitModel.findGitRoot(plain) === null);

  // 5) detached HEAD
  const r3 = mkrepo('gamma', 'tmp', {});
  sh(r3, 'git checkout -q --detach HEAD');
  const c = await gitModel.readRepo(ctx, r3);
  ok('detached 时显示 @sha', /^@[0-9a-f]{4,}/.test(c.branch), c.branch);
  ok('detached 标记', c.detached === true);

  // 6) 发现：多仓并列
  const found = await gitModel.discoverRepos(ctx, { max: 6, workspaceFolders: [TMP] });
  ok('发现目录下多个仓库（含深层同名前缀）', found.length >= 2, found.map((f) => path.basename(f)));

  // 7) 中文/空格路径
  const r4 = mkrepo('中文 仓库名', 'feat/中文分支', {});
  const d = await gitModel.readRepo(ctx, r4);
  ok('中文路径与分支名不乱码', d.branch === 'feat/中文分支', d.branch);
  ok('中文仓库名', d.name === '中文 仓库名', d.name);

  // 8) 空仓库（无提交）
  const empty = path.join(TMP, 'empty');
  fs.mkdirSync(empty, { recursive: true });
  sh(empty, 'git init -q');
  const e = await gitModel.readRepo(ctx, empty);
  ok('空仓库显示 (no commits)', e.branch === '(no commits)', e.branch);

  // 9) numstat 解析（二进制文件显示 - -）
  const ns = gitModel.parseNumstat('12\t3\ta.txt\n-\t-\timg.png\n');
  ok('numstat 忽略二进制', ns.added === 12 && ns.deleted === 3, ns);

  // 10) status v2 解析
  const st = gitModel.parseStatusV2('# branch.oid abc\n# branch.head dev\n# branch.ab +2 -3\n1 M. N... 100644 100644 100644 abc def a.txt\n');
  ok('status v2 解析 ahead/behind', st.ahead === 2 && st.behind === 3 && st.changed === 1, st);

  const passed = results.filter((r) => r.pass).length;
  console.log('\n' + passed + '/' + results.length + ' passed');
  fs.writeFileSync('/home/hy/WorkBuddy/2026-10-17-12-49-03/.workbuddy/git-selftest.json', JSON.stringify(results, null, 2));
  process.exit(passed === results.length ? 0 : 1);
})();
