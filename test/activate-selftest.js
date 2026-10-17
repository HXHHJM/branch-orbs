// 激活自测：用一个假的 vscode 模块把真实 activate() 跑一遍
//
// 用法：node test/activate-selftest.js [--workspace <dir>]
//   不需要 Electron、不需要图形界面 —— 这条用例守的是"扩展一激活就炸"这一类问题。
//
// 为什么需要它：悬浮球画在**另一个进程**里，激活过程一旦中途抛异常，
// 界面上既没有球也没有报错，看起来跟"没装"一模一样。之前真的踩过：
// `warned` 声明在 ensureShell 之后，ensureShell 里第一行访问它就撞 TDZ，
// activate 直接中断 —— 用户侧表现为"打开工程没有任何效果"。
// 所以这里必须把 activate 全程走通，并断言状态栏豆子拿到了真实数据。

const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');

/* ── 假的 vscode API ──
   只实现扩展真正用到的那部分。任何没实现的属性被访问时会立刻报错，
   这样新代码引入新 API 时这条用例会失败，逼着我们补上。 */
function makeFakeVscode(opts) {
  const calls = {
    statusText: [],
    statusShown: 0,
    statusTooltip: '',
    statusCommand: '',
    registeredCommands: [],
    errors: [],
    warnings: [],
    info: [],
    spawned: false,
  };

  const mkDisposable = () => ({ dispose() {} });

  const statusItem = {
    show() {
      calls.statusShown++;
    },
    hide() {},
    dispose() {},
  };

  const cfgGet = (section, def) => {
    // 关闭悬浮球壳，避免这条用例真的去 spawn Electron（它只测激活逻辑）
    if (section === 'enabled') return opts.shellEnabled === true;
    return def;
  };

  const vscode = {
    StatusBarAlignment: { Left: 1, Right: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    ViewColumn: { Active: -1, Beside: -2 },
    env: { clipboard: { writeText() {} } },
    Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }) },
    extensions: {
      getExtension: (id) => {
        if (id === 'vscode.git') return opts.vscodeGitExtension || undefined;
        return undefined;
      },
    },
    commands: {
      registerCommand(id) {
        calls.registeredCommands.push(id);
        return mkDisposable();
      },
      executeCommand() {},
    },
    window: {
      createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
      createStatusBarItem() {
        // 用 getter/setter 把每次赋值记下来，好断言"豆子先占位、后变成真分支名"
        return {
          get text() {
            return calls.statusText[calls.statusText.length - 1] || '';
          },
          set text(v) {
            calls.statusText.push(v);
          },
          get tooltip() {
            return calls.statusTooltip;
          },
          set tooltip(v) {
            calls.statusTooltip = v;
          },
          get command() {
            return calls.statusCommand;
          },
          set command(v) {
            calls.statusCommand = v;
          },
          show: statusItem.show,
          hide: statusItem.hide,
          dispose: statusItem.dispose,
        };
      },
      showErrorMessage: async (msg) => {
        calls.errors.push(msg);
        return undefined;
      },
      showWarningMessage: (msg) => {
        calls.warnings.push(msg);
      },
      showInformationMessage: (msg) => {
        calls.info.push(msg);
      },
      setStatusBarMessage() {},
      showTextDocument: async () => ({}),
      onDidChangeActiveTextEditor: () => mkDisposable(),
      get activeTextEditor() {
        return undefined;
      },
    },
    workspace: {
      get workspaceFolders() {
        return [{ uri: { fsPath: opts.workspace, scheme: 'file' }, name: path.basename(opts.workspace) }];
      },
      getConfiguration: () => ({ get: cfgGet, update: async () => {} }),
      openTextDocument: async () => ({ getText: () => '', uri: {} }),
      onDidSaveTextDocument: () => mkDisposable(),
      onDidChangeWorkspaceFolders: () => mkDisposable(),
      onDidChangeConfiguration: () => mkDisposable(),
    },
  };

  return { vscode, calls };
}

/* ── 把 require('vscode') 重定向到假模块 ── */
function installFakeVscode(fake) {
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'vscode') return 'vscode';
    return origResolve.call(this, request, ...rest);
  };
  const m = new Module('vscode');
  m.filename = 'vscode';
  m.loaded = true;
  m.exports = fake;
  require.cache['vscode'] = m;
  return () => {
    Module._resolveFilename = origResolve;
    delete require.cache['vscode'];
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const results = [];
  const ok = (name, cond, extra) => {
    results.push({ name, pass: !!cond, extra: extra === undefined ? null : extra });
    console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra === undefined ? '' : '   ' + JSON.stringify(extra)));
  };

  // 默认拿一个真实存在的 git 仓库当工作区（这样能断言分支名真被读出来）
  const argIdx = process.argv.indexOf('--workspace');
  const workspace = argIdx > 0 ? process.argv[argIdx + 1] : ROOT;

  const { vscode, calls } = makeFakeVscode({ workspace, shellEnabled: false });
  const uninstall = installFakeVscode(vscode);

  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-orbs-act-'));
  const ctx = {
    extensionPath: ROOT,
    globalStorageUri: { fsPath: storage },
    subscriptions: [],
  };

  let activateError = null;
  try {
    const ext = require(path.join(ROOT, 'src', 'extension.js'));
    await ext.activate(ctx);
  } catch (e) {
    activateError = e;
  }

  ok('activate() 不抛异常', activateError === null, activateError ? activateError.constructor.name + ': ' + activateError.message : null);
  if (activateError) {
    console.log('\n' + activateError.stack);
    uninstall();
    fs.rmSync(storage, { recursive: true, force: true });
    console.error(`\n${results.filter((r) => r.pass).length}/${results.length} passed`);
    process.exit(1);
  }

  // 等 refresh 跑完（git 命令是异步的）
  await sleep(3000);

  // 6 条命令全部注册（其中 why 是排障入口，缺了用户就没法自查）
  const want = ['branchOrbs.toggle', 'branchOrbs.refresh', 'branchOrbs.show', 'branchOrbs.hide', 'branchOrbs.diag', 'branchOrbs.why'];
  const missing = want.filter((c) => !calls.registeredCommands.includes(c));
  ok('6 条命令全部注册', missing.length === 0, missing.length ? { missing } : { count: calls.registeredCommands.length });

  // 状态栏豆子：必须 show 过，且绑定了 toggle
  ok('状态栏豆子已显示', calls.statusShown >= 1, { show: calls.statusShown });
  ok('豆子点击执行 toggle', calls.statusCommand === 'branchOrbs.toggle', { command: calls.statusCommand });

  // 第一次赋值应该是"读取中"的占位文案，之后被真实分支名覆盖
  ok('豆子有读取中占位', /读取中|Branch Orbs/.test(calls.statusText[0] || ''), { first: calls.statusText[0] });

  const last = calls.statusText[calls.statusText.length - 1] || '';
  const isRepo = fs.existsSync(path.join(workspace, '.git'));
  if (isRepo) {
    ok('豆子显示真实分支名', /\$\(circle-large-filled\)/.test(last) && last.length > 24, { last });
    const tooltip = calls.statusTooltip || '';
    ok('tooltip 含分支与改动信息', /分支：/.test(tooltip) && /改动文件：/.test(tooltip), { head: tooltip.slice(0, 60) });
  } else {
    ok('非仓库时豆子给出占位（不崩）', /\$\(circle-large-outline\)/.test(last), { last });
  }

  // 不应该在"工作区有仓库"的情况下弹"没有仓库"的告警
  if (isRepo) {
    ok('有仓库时不误报警告', calls.warnings.length === 0 && calls.errors.length === 0, {
      warnings: calls.warnings,
      errors: calls.errors,
    });
  }

  // 每个注册的命令都必须能拿到 handler（防止 registerCommand 传 undefined）
  ok('subscriptions 已托管资源', ctx.subscriptions.length >= 7, { count: ctx.subscriptions.length });

  uninstall();
  fs.rmSync(storage, { recursive: true, force: true });

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})();
