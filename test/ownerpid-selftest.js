'use strict';
/* windowOwnerPid 的父链遍历逻辑自检。
 *
 * 为什么要单独测：这个函数决定"点击悬浮球能否精确命中本窗口"。
 *   拿对 → xwin.py 用 --pid 精确匹配，与窗口标题无关，最可靠
 *   拿错 → 可能最小化**别的** VSCode 窗口（用户视角：点了这颗球，另一颗窗口消失了）
 *   拿不到 → 退回关键字匹配，功能仍可用
 * 而真实桌面环境（父链完整）在容器里造不出来，所以用注入假的 /proc
 * 读取函数来覆盖各种父链形态。
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const passed = [];
const failed = [];
function ok(name, cond, info) {
  (cond ? passed : failed).push(name);
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (info === undefined ? '' : '   ' + JSON.stringify(info)));
}

/* ── 把 extension.js 里的两个纯函数抠出来复刻一份（保持逻辑一致） ──
   为什么不在 extension.js 里导出：那里顶层就 require('vscode')，
   在测试进程里加载不了。所以这里按源码做等价实现，并用源码文本校验
   "两边的判定条件一致"，避免复刻走样。 */
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.js'), 'utf8');

function makeWalker(fsMap) {
  // fsMap: { pid: { cmdline, ppid } }
  const procCmdline = (pid) => {
    const e = fsMap[pid];
    return e && e.cmdline !== undefined ? e.cmdline : '';
  };
  const procParent = (pid) => {
    const e = fsMap[pid];
    return e && Number.isFinite(e.ppid) ? e.ppid : null;
  };
  return function windowOwnerPid(startPid) {
    let pid = startPid;
    for (let i = 0; i < 8; i++) {
      const ppid = procParent(pid);
      if (!ppid || ppid <= 1) break;
      const cmd = procCmdline(ppid);
      if (!cmd) break;
      if (!cmd.includes('--type=')) return ppid;
      pid = ppid;
    }
    return null;
  };
}

/* ── 源码一致性校验：确保 extension.js 里的判定条件没被改歪 ── */
ok('源码里限制父链最多上溯 8 层（防死循环）', /for \(let i = 0; i < 8; i\+\+\)/.test(SRC));
ok('源码里 ppid<=1 时放弃（容器里父链常被接到 init）', /ppid <= 1\) break/.test(SRC));
ok('源码里 cmdline 读不到时放弃（父链不可信）', /if \(!cmd\) break/.test(SRC));
ok('源码里排除 --type= 子进程（扩展宿主自身不算）', /!cmd\.includes\('--type='\)/.test(SRC));
ok('源码用 lastIndexOf(")") 切 stat（comm 含空格/括号时不跑偏）', /lastIndexOf\('\)'\)/.test(SRC));

/* ── 场景 1：标准 VSCode 形态 ──
   main(1000, 无 --type) → zygote-ish(1001, --type=zygote)
   → extensionHost(1002, --type=extensionHost) → 扩展进程(1003)
   期望：返回 1000（主进程），而不是 1002 */
{
  const w = makeWalker({
    1003: { cmdline: '/usr/share/code/code --type=utility --utility-sub-type=node.mojom.NodeService', ppid: 1002 },
    1002: { cmdline: '/usr/share/code/code --type=extensionHost --transform-uri', ppid: 1001 },
    1001: { cmdline: '/usr/share/code/code --type=zygote', ppid: 1000 },
    1000: { cmdline: '/usr/share/code/code /home/hy/proj', ppid: 1 },
  });
  ok('标准形态：返回主进程 pid（跳过 --type= 的中间层）', w(1003) === 1000, { got: w(1003) });
}

/* ── 场景 2：父链完整，但中间有一层 cmdline 读不到（权限/竞态） ──
   期望：安全放弃返回 null，而不是返回一个错的值 */
{
  const w = makeWalker({
    2002: { cmdline: '/code --type=extensionHost', ppid: 2001 },
    2001: { cmdline: '', ppid: 2000 },
    2000: { cmdline: '/code /proj', ppid: 1 },
  });
  ok('中间层 cmdline 读不到时返回 null（宁可退回关键字匹配，也不乱选）', w(2002) === null, { got: w(2002) });
}

/* ── 场景 3：容器形态，ppid 直接是 1 ── */
{
  const w = makeWalker({ 3001: { cmdline: '/code --type=extensionHost', ppid: 1 } });
  ok('父进程是 init 时返回 null（容器里的正常情况，不是错误）', w(3001) === null, { got: w(3001) });
}

/* ── 场景 4：环（异常情况）不能死循环 ── */
{
  const w = makeWalker({
    4002: { cmdline: '/code --type=a', ppid: 4001 },
    4001: { cmdline: '/code --type=b', ppid: 4002 },
  });
  const t0 = Date.now();
  const got = w(4002);
  ok('父链成环时不死循环（8 层上限兜住）', got === null && Date.now() - t0 < 1000, { got, ms: Date.now() - t0 });
}

/* ── 场景 5：主进程命令行里恰好含 "--type" 字样但不含 "--type=" ──
   典型：用户把工程放在叫 "--type" 的目录下，或 --user-data-dir 带这词。
   我们的判定是 includes('--type=')，所以不应误跳过。 */
{
  const w = makeWalker({
    5002: { cmdline: '/code --type=extensionHost', ppid: 5001 },
    5001: { cmdline: '/code --user-data-dir=/tmp/--type-notes /proj', ppid: 1 },
  });
  ok('主进程命令行含 "--type" 但非 "--type=" 时不被误跳过', w(5002) === 5001, { got: w(5002) });
}

/* ── 场景 6：紧邻父进程就是主进程（没有 --type= 中间层） ── */
{
  const w = makeWalker({ 6002: { cmdline: '/usr/share/code/bin/code /proj', ppid: 6001 }, 6001: { cmdline: 'bash', ppid: 1 } });
  ok('中间层全为 --type= 以外进程时取最近的那个', w(6002) === 6001, { got: w(6002) });
}

console.log('\n' + passed.length + '/' + (passed.length + failed.length) + ' passed');
if (failed.length) {
  console.log('失败：' + failed.join(', '));
  process.exit(1);
}
