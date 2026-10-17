// launcher 自测：启动参数与环境变量。
//
// 这几条断言全部来自真机踩过的坑，每一条对应一个"球永远不出现"的故障：
//   ① Chromium 开关不能出现在命令行（会让 Electron 报 bad option 秒退）
//   ② TMPDIR 不能落在 /tmp（10MB tmpfs → 字体服务 FATAL → renderer 崩）
//   ③ shim 应用目录不能落在 /tmp（同上，且会被系统清理）
//   ④ ELECTRON_RUN_AS_NODE 必须从子进程环境里删掉（否则 Electron 变 node）
const path = require('path');
const os = require('os');
const l = require('../src/launcher.js');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('PASS  ' + name + (detail ? '   ' + JSON.stringify(detail) : ''));
  } else {
    fail++;
    console.log('FAIL  ' + name + '   ' + JSON.stringify(detail || {}));
  }
}

const ROOT = path.resolve(__dirname, '..');
const FAKE_ELECTRON = '/some/where/electron';

// ── ① 命令行里不能有 Chromium 开关 ──
const r = l.launchArgs(ROOT, { electron: FAKE_ELECTRON });
ok('launchArgs 返回非空', !!r, { r: !!r });
const badSwitches = r.args.filter((a) => /^--(no-sandbox|disable-dev-shm-usage|ozone-platform|disable-gpu)/.test(a));
ok(
  '命令行不含 Chromium 开关（否则 Electron 报 bad option 秒退）',
  badSwitches.length === 0,
  { badSwitches }
);
ok(
  '命令行 = [shim/应用目录, shell 目录]',
  r.args.length === 2 && r.args[1] === path.join(ROOT, 'shell'),
  { args: r.args }
);

// ── ② shim 目录必须在 HOME 下，不能在 /tmp ──
const shim = l.makeShimApp(ROOT);
ok('shim 目录不在 /tmp（tmpfs 会被清 / 写满）', !shim.startsWith('/tmp'), { shim });
ok('shim 在 ~/.branch-orbs 下', shim.includes(path.join(os.homedir(), '.branch-orbs')), { shim });

// ── ③ spawnEnv 的临时目录在持久盘 ──
const env = l.spawnEnv(ROOT, {});
ok('TMPDIR 不在 /tmp', env.TMPDIR && !env.TMPDIR.startsWith('/tmp'), { TMPDIR: env.TMPDIR });
ok('BRANCH_ORBS_HTML 指向 shell/orbs.html', /shell[\\/]orbs\.html$/.test(env.BRANCH_ORBS_HTML || ''), {
  html: env.BRANCH_ORBS_HTML,
});
ok('日志不在 /tmp', env.BRANCH_ORBS_LOG && !env.BRANCH_ORBS_LOG.startsWith('/tmp'), {
  log: env.BRANCH_ORBS_LOG,
});

// ── ④ ELECTRON_RUN_AS_NODE 必须被删掉 ──
const saved = process.env.ELECTRON_RUN_AS_NODE;
process.env.ELECTRON_RUN_AS_NODE = '1';
const env2 = l.spawnEnv(ROOT, {});
ok('spawnEnv 删除了 ELECTRON_RUN_AS_NODE（否则 Electron 跑成 node）', env2.ELECTRON_RUN_AS_NODE === undefined, {
  value: env2.ELECTRON_RUN_AS_NODE,
});
if (saved === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
else process.env.ELECTRON_RUN_AS_NODE = saved;

// ── ⑤ devShmTooSmall 在当前机器应判定为"太小"（/dev/shm 10MB） ──
try {
  const tiny = l.devShmTooSmall();
  console.log('INFO  devShmTooSmall() = ' + tiny + '（当前 /dev/shm 情况）');
} catch (_) {}

console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail === 0 ? 0 : 1);
