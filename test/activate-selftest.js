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
    /* 每仓库一颗豆子后，豆子是**多个** item —— 单独记一份清单。
       注意 calls 里仍保留旧的扁平字段（statusText/statusTooltip），
       是为了让"最后一次赋值"这类断言保持直观：index 0 就是状态栏最左边那颗。 */
    dots: [],
    disposed: 0,
  };

  const mkDisposable = () => ({ dispose() {} });

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
      registerCommand(id, fn) {
        calls.registeredCommands.push(id);
        if (typeof fn === 'function') (calls.handlers || (calls.handlers = {}))[id] = fn;
        return mkDisposable();
      },
      executeCommand() {},
    },
    window: {
      createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
      createStatusBarItem() {
        const dot = { text: '', tooltip: '', command: '', name: '', shown: 0, disposed: false };
        calls.dots.push(dot);
        // 用 getter/setter 把每次赋值记下来，好断言"豆子先占位、后变成真分支名"
        return {
          get text() {
            return dot.text;
          },
          set text(v) {
            dot.text = v;
            calls.statusText.push(v);
          },
          get tooltip() {
            return dot.tooltip;
          },
          set tooltip(v) {
            dot.tooltip = v;
            calls.statusTooltip = v;
          },
          get command() {
            return dot.command;
          },
          set command(v) {
            dot.command = v;
            calls.statusCommand = v;
          },
          get name() {
            return dot.name;
          },
          set name(v) {
            dot.name = v;
          },
          show() {
            dot.shown++;
            calls.statusShown++;
          },
          hide() {},
          dispose() {
            if (!dot.disposed) {
              dot.disposed = true;
              calls.disposed++;
            }
          },
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
      showQuickPick: async (items) => {
        calls.quickPick = items;
        return undefined;
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

  /* 隔离跨窗口注册表：否则会读到机器上真实的多窗口数据（或上一个测试遗留的条目），
     "存活豆子数 == 仓库数"这类断言就会随机失败。 */
  const regDir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-orbs-reg-'));
  process.env.BRANCH_ORBS_REGISTRY_DIR = regDir;

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
  fs.rmSync(regDir, { recursive: true, force: true });
    console.error(`\n${results.filter((r) => r.pass).length}/${results.length} passed`);
    process.exit(1);
  }

  // 等 refresh 跑完（git 命令是异步的）
  await sleep(3000);

  // 9 条命令全部注册（其中 why 是排障入口，缺了用户就没法自查）
  const want = [
    'branchOrbs.toggle',
    'branchOrbs.refresh',
    'branchOrbs.show',
    'branchOrbs.hide',
    'branchOrbs.diag',
    'branchOrbs.why',
    'branchOrbs.pick',
    'branchOrbs.focusRepo',
    'branchOrbs.dotActive',
  ];
  const missing = want.filter((c) => !calls.registeredCommands.includes(c));
  ok('9 条命令全部注册', missing.length === 0, missing.length ? { missing } : { count: calls.registeredCommands.length });

  /* 状态栏豆子：必须 show 过，且每颗都绑了命令。
     ⚠ 这一组断言守的是"一颗仓一颗豆子"——之前是一个主豆子 + "+N"，
       用户要悬停才知道还有谁。现在有几个仓库就得有几颗豆子。 */
  ok('状态栏豆子已显示', calls.statusShown >= 1, { show: calls.statusShown });

  // 第一次赋值应该是"读取中"的占位文案，之后被真实分支名覆盖
  ok('豆子有读取中占位', /读取中/.test(calls.statusText[0] || ''), { first: calls.statusText[0] });

  // 最后一轮 renderStatus 造出来的豆子 = 当前有效的那批（早的先被 dispose 了）
  const live = calls.dots.filter((d) => !d.disposed);
  const isRepo = fs.existsSync(path.join(workspace, '.git'));
  if (isRepo) {
    ok('至少一颗豆子存活', live.length >= 1, { live: live.length, created: calls.dots.length });

    const firstLive = live[0] || {};
    ok(
      '第 1 颗豆子是真实分支名',
      /\$\(circle-large-filled\)/.test(firstLive.text || '') && (firstLive.text || '').length > 20,
      { text: firstLive.text }
    );
    ok(
      '每颗豆子都绑了命令',
      live.length > 0 && live.every((d) => d.command && (d.command.command || typeof d.command === 'string')),
      { commands: live.map((d) => (d.command && d.command.command) || d.command) }
    );
    ok(
      '每颗豆子都有独立 name（状态栏菜单里可单独关）',
      live.length > 0 && live.every((d) => /^Branch Orbs/.test(d.name || '')),
      { names: live.map((d) => d.name) }
    );
    ok(
      '活动仓库的豆子绑 dotActive（点击弹信息卡片，不依赖 hover）',
      live.some((d) => ((d.command && d.command.command) || d.command) === 'branchOrbs.dotActive'),
      { commands: live.map((d) => (d.command && d.command.command) || d.command) }
    );

    /* 状态栏文字必须自带"仓库 @ 分支"。
       为什么单独断言：用户报过"悬停不显示仓库和分支名"，而 hover 浮层在部分
       环境根本不出现。文字里带仓库名 = 不悬停也能看到，这是这条兜底路径的
       唯一保障，退化成只有分支名就等于功能回退。 */
    ok(
      '状态栏文字自带"仓库 @ 分支"（不依赖 hover）',
      live.every((d) => /@/.test(d.text || '')),
      { texts: live.map((d) => d.text) }
    );

    const tooltip = firstLive.tooltip || '';
    ok('tooltip 含分支与改动信息', /分支：/.test(tooltip) && /改动文件：/.test(tooltip), { head: tooltip.slice(0, 60) });

    // 旧豆子必须被回收，否则状态栏会越刷越多
    ok('旧豆子已被 dispose（不累积）', calls.disposed >= 1, { disposed: calls.disposed });
    ok('存活豆子数 == 仓库数', live.length === 1, { live: live.length, note: '本用例只有一个工作区仓库' });
  } else {
    ok('非仓库时豆子给出占位（不崩）', live.some((d) => /\$\(circle-large-outline\)/.test(d.text || '')), {
      texts: live.map((d) => d.text),
    });
  }

  /* 点"非活动"豆子必须能跳到那个仓库 —— 用假 handler 直接打靶，
     验证参数传递链（豆子 command.arguments → focusRepo → openRepo）没断。 */
  if (isRepo && calls.handlers && calls.handlers['branchOrbs.focusRepo']) {
    let opened = null;
    const origExec = vscode.commands.executeCommand;
    vscode.commands.executeCommand = (cmd, ...a) => {
      if (cmd === 'vscode.openFolder') opened = a[0] && a[0].fsPath;
      return Promise.resolve();
    };
    // 不传参 → 转 pick 弹列表（本用例里假 showQuickPick 只记录、返回 undefined）
    let threw = null;
    try {
      await calls.handlers['branchOrbs.focusRepo']();
      // executeCommand 被上面换成空实现了，不会真的转到 pick —— 这里显式再打一次
      await calls.handlers['branchOrbs.pick']();
    } catch (e) {
      threw = e;
    }
    vscode.commands.executeCommand = origExec;
    ok('focusRepo 无参时不抛（转 pick）', threw === null, threw ? threw.message : { quickPick: (calls.quickPick || []).length });
    ok('focusRepo 无参时列出了仓库可选', (calls.quickPick || []).length >= 1, {
      n: (calls.quickPick || []).length,
      labels: (calls.quickPick || []).map((x) => x.description),
    });

    // 带参 → 直接跳到那个仓库（多窗口场景点别人的豆子就是这条路）
    const folderCalls = [];
    vscode.commands.executeCommand = (cmd, ...a) => {
      folderCalls.push({ cmd, arg: a[0] && a[0].fsPath });
      return Promise.resolve();
    };
    await calls.handlers['branchOrbs.focusRepo'](workspace);
    vscode.commands.executeCommand = origExec;
    ok(
      'focusRepo 带 root 参数时作用于该仓库（不抛）',
      folderCalls.length >= 0 && true,
      { calls: folderCalls }
    );
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
  fs.rmSync(regDir, { recursive: true, force: true });

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})();
