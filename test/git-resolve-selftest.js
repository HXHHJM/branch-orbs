// 验证：在"系统里完全没有 git、PATH 里也没有"的环境下，
// resolveGit() 仍能找到工具链自带的那份 git。
//
// 这是本机的真实情况：/usr/bin/git 不存在，只有
//   ~/.workbuddy/binaries/tools/bin/git（托管 git 2.34.1）
// 之前的候选列表只覆盖了发行版标准位置，所以一个都找不到 → 没有豆子。
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// ── 假 vscode ──
const fake = {
  workspace: { getConfiguration: () => ({ get: () => undefined }), workspaceFolders: [] },
  window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
  commands: { registerCommand: () => ({ dispose() {} }) },
  StatusBarAlignment: { Right: 2 },
};
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  if (r === 'vscode') return 'vscode';
  return orig.call(this, r, ...a);
};
const m = new Module('vscode');
m.filename = 'vscode';
m.loaded = true;
m.exports = fake;
require.cache['vscode'] = m;

// ── 把 PATH 收紧成"标准系统路径，没有 git" ──
process.env.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

const src = fs.readFileSync(path.join(ROOT, 'src', 'extension.js'), 'utf8');
const start = src.indexOf('function gitCandidateDirs');
const end = src.indexOf('function activate(context)');
if (start < 0 || end < 0) {
  console.error('❌ 找不到 resolveGit 相关代码段');
  process.exit(2);
}
const code = src.slice(start, end);

const results = [];
const ok = (name, cond, extra) => {
  results.push({ name, pass: !!cond });
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra === undefined ? '' : '   ' + JSON.stringify(extra)));
};

let got = null;
let threw = null;
try {
  const fn = new Function(
    'vscode', 'path', 'fs', 'os', 'cp', 'process',
    code + '\nreturn resolveGit();'
  );
  got = fn(fake, path, fs, os, { execFileSync: cp.execFileSync, execFile: cp.execFile }, process);
} catch (e) {
  threw = e;
}

ok('resolveGit 不抛异常', threw === null, threw ? threw.message : null);
ok('在无系统 git 的 PATH 下仍能找到 git', !!got, { resolved: got });

if (got) {
  let ver = '';
  try {
    ver = cp.execFileSync(got, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
  } catch (e) {
    ver = 'ERR ' + e.message;
  }
  ok('找到的 git 能正常执行', /git version/.test(ver), { version: ver });
  ok('不是 PATH 里的空壳（路径真实存在）', fs.existsSync(got), { path: got });
}

// 顺带验证：候选目录列表里确实覆盖了工具链目录
ok(
  '候选目录覆盖工具链 bin 目录',
  /\.workbuddy.*binaries.*tools|binaries.*tools/.test(code) && /toolchainRoots/.test(code),
  null
);

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
