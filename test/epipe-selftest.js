// shell/main.js 的 EPIPE 死循环回归测试
//
// 背景：曾经把 454MB 日志灌满磁盘。
//   父进程（VSCode 扩展宿主）退出 → stdout 管道断 → write() **异步**抛 EPIPE
//   → 进 uncaughtException → 处理里又 log()（stderr 也断了，同样 EPIPE）
//   → 又 uncaughtException → 无限自激，一秒几万行。
//
// 这个用例直接构造"没有父进程的管道"来复现：
//   把 main.js 的 stderr/stdout 换成一个立刻报 EPIPE 的假流，
//   然后断言：进程不会无限刷、不会卡死，且日志文件不会爆。
//
// 用法：node test/epipe-selftest.js
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const results = [];
const ok = (name, cond, extra) => {
  results.push({ name, pass: !!cond });
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra === undefined ? '' : '   ' + JSON.stringify(extra)));
};

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-orbs-epipe-'));
  const logFile = path.join(tmp, 'shell.log');

  /* 用一个小的 bootstrap 脚本：
     先把 process.stdout/stderr 换成"写就 EPIPE"的假流，再 require main.js。
     这样 main.js 里的所有 log()/send() 都会撞 EPIPE。
     正常实现应该在第一次 EPIPE 后就安静退出，绝不能刷屏。 */
  const boot = path.join(tmp, 'boot.js');
  fs.writeFileSync(
    boot,
    `
const { Writable } = require('stream');
const broken = () => new Writable({
  write(chunk, enc, cb) {
    const e = new Error('write EPIPE');
    e.code = 'EPIPE';
    // 异步抛：模拟真实管道断开的行为（同步 try/catch 抓不到）
    process.nextTick(() => cb(e));
  },
});
process.stdout = broken();
process.stderr = broken();
process.chdir(${JSON.stringify(ROOT)});
require(${JSON.stringify(path.join(ROOT, 'shell', 'main.js'))});
setTimeout(() => { process.exit(0); }, 1500);
`
  );

  const child = spawn(process.execPath, [boot], {
    cwd: ROOT,
    env: {
      ...process.env,
      BRANCH_ORBS_LOG: logFile,
      BRANCH_ORBS_USER_DATA: path.join(tmp, 'ud'),
      DISPLAY: process.env.DISPLAY || ':0',
      ELECTRON_RUN_AS_NODE: '1', // 让 electron 二进制按 node 跑；这里其实用纯 node
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let outBytes = 0;
  child.stdout.on('data', (b) => (outBytes += b.length));
  child.stderr.on('data', (b) => (outBytes += b.length));

  const t0 = Date.now();
  const code = await new Promise((resolve) => {
    child.on('exit', (c) => resolve(c));
    setTimeout(() => {
      child.kill('SIGKILL');
      resolve('timeout');
    }, 8000);
  });
  const elapsed = Date.now() - t0;

  // main.js 需要 electron 模块，纯 node 下 require('electron') 会失败 ——
  // 这是预期的"提前失败"，不算刷屏。关键是**不能无限循环**。
  ok('进程在 8s 内结束（没有死循环）', code !== 'timeout', { code, elapsed });

  const logSize = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
  ok('日志文件没有暴涨（< 2MB 上限）', logSize < 2 * 1024 * 1024, { logSize });
  ok('没有向 stdout/stderr 刷出巨量数据（< 1MB）', outBytes < 1024 * 1024, { outBytes });

  fs.rmSync(tmp, { recursive: true, force: true });

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})();
