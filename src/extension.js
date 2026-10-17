'use strict';
// 扩展主体：负责三件事
//   ① 数据：读 git（分支/改动/最近提交），监听编辑器与保存事件去刷新
//   ② 位置：跟踪 **VSCode 主窗口矩形**，把它上报给壳进程（壳自己看不到别人的窗口）
//   ③ 桥接：把点击/右键/拖动换算成 VSCode 命令
// 画面不在这个进程里 —— 见 shell/main.js 开头的说明（扩展宿主是 utility 进程，没有 BrowserWindow）

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const { loadConfig, effectiveSide } = require('./config');
const { Shell } = require('./shell');
const { launchArgs, spawnEnv, findElectron } = require('./launcher');
const gitModel = require('./git');
const registry = require('./registry');

const STATE_KEY = 'branchOrbs.shellUserData';
/* 跨窗口注册表放在 globalStorage 的上一层，这样同一台机器上所有 VSCode 窗口
   （哪怕用不同的 --user-data-dir 启动）都能读写同一个目录。
   不能放 workspaceStorage —— 那是按工作区分的，窗口之间看不到彼此。 */
const REGISTRY_DIR_NAME = 'branch-orbs-windows';

/* ── git 可执行文件解析 ──
   ⚠ 踩过的坑：VSCode 的扩展宿主**不一定会继承你终端里的 PATH**（尤其是从
     桌面图标/启动器拉起时，PATH 常常只有 /usr/local/bin:/usr/bin:/bin）。
     此时 execFile('git') 抛 ENOENT，discoverRepos 拿到空数组，
     → 球一个都不出现，而且**界面上没有任何错误提示**。
     所以这里做三级兜底：PATH → 常见安装位置 → VSCode 自带 git 设置。 */
let gitPathCache = null;
function resolveGit() {
  if (gitPathCache !== null) return gitPathCache;

  const exe = process.platform === 'win32' ? 'git.exe' : 'git';
  const cands = [];

  // ① 用户显式指定
  const cfgGit = vscode.workspace.getConfiguration('git').get('path');
  if (cfgGit && typeof cfgGit === 'string') cands.push(cfgGit);

  // ② PATH 上能跑通的那个（用 which/where 探，别直接信 PATH 里第一个）
  try {
    const probe = cp.execFileSync(process.platform === 'win32' ? 'where' : 'which', ['git'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const first = String(probe).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first) cands.push(first);
  } catch (_) {}

  // ③ 常见安装位置
  if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) {
      if (base) cands.push(path.join(base, 'Git', 'cmd', exe), path.join(base, 'Programs', 'Git', 'cmd', exe));
    }
    // 便携版常见位置
    cands.push('C:\\Program Files\\Git\\bin\\git.exe', 'C:\\Program Files\\Git\\cmd\\git.exe');
  } else {
    cands.push(
      '/usr/bin/git', '/usr/local/bin/git', '/bin/git',
      '/opt/homebrew/bin/git', '/usr/local/git/bin/git',
      '/snap/bin/git', '/opt/local/bin/git'
    );
    // 便携/自建工具链：按 PATH 里已有的目录猜兄弟目录，别硬编码某台机器
    for (const p of (process.env.PATH || '').split(path.delimiter)) {
      if (p) cands.push(path.join(p, 'git'));
    }
  }

  // ④ VSCode 自带的 git（有些发行版把 git 塞进 resources/app）
  if (process.platform !== 'win32') {
    cands.push(path.join(process.env.VSCODE_RESOURCES || '/usr/share/code/resources', 'app', 'node_modules', '.bin', 'git'));
  }

  // ⑤ 兜底：直接试 'git'（PATH 里有但 which 不可用时仍能跑）
  cands.push('git');

  for (const c of cands) {
    try {
      if (c !== 'git' && !fs.existsSync(c)) continue;
      cp.execFileSync(c, ['--version'], { timeout: 3000, stdio: 'ignore' });
      gitPathCache = c;
      return c;
    } catch (_) {}
  }
  gitPathCache = null;
  return null;
}

function activate(context) {
  const channel = vscode.window.createOutputChannel('Branch Orbs');

  /* 引导期日志：输出通道在扩展宿主刚起来时可能还没 flush 到磁盘，
     排障时等于全黑。所以先往一个固定文件里写，postmortem 才有东西可看。
     ⚠ 落点必须是 **持久目录**，不能用 os.tmpdir() —— 那里会被系统清理，
       而且各次启动的 TMPDIR 可能不同，出问题回头根本找不到文件。 */
  const bootLogPath = path.join(context.globalStorageUri ? context.globalStorageUri.fsPath : os.homedir(), 'boot.log');

  /* 跨窗口注册表目录：用一个**固定位置**，不能被 --user-data-dir 影响，
     否则用不同 user-data 启动的窗口互相看不见。
     优先 ~/.vscode-branch-orbs/windows（跨 user-data 共享），失败才退回 globalStorage。 */
  const registryDir = (() => {
    const shared = path.join(os.homedir(), '.vscode-branch-orbs', REGISTRY_DIR_NAME);
    if (registry.ensureDir(shared)) return shared;
    const local = path.join(context.globalStorageUri ? context.globalStorageUri.fsPath : os.tmpdir(), REGISTRY_DIR_NAME);
    registry.ensureDir(local);
    return local;
  })();

  /* 每个 VSCode 窗口一个稳定 id。存在 globalState 里，同一窗口重载后不变；
     这样注册表文件不会被"每次激活换一个文件名"搞成一堆孤儿。 */
  const windowId = (() => {
    let id = null;
    try {
      id = context.globalState && context.globalState.get('branchOrbs.windowId');
    } catch (_) {}
    if (!id) {
      id = 'w-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      try {
        if (context.globalState) context.globalState.update('branchOrbs.windowId', id);
      } catch (_) {}
    }
    return id;
  })();

  function rawLog(line) {
    try {
      fs.mkdirSync(path.dirname(bootLogPath), { recursive: true });
      fs.appendFileSync(bootLogPath, '[' + new Date().toISOString().slice(11, 23) + '] ' + line + '\n');
    } catch (_) {}
  }
  try {
    fs.writeFileSync(bootLogPath, '[' + new Date().toISOString() + '] activate() entered\n');
  } catch (_) {}

  const log = (...a) => {
    const line = '[' + new Date().toTimeString().slice(0, 8) + '] ' + a.join(' ');
    channel.appendLine(line);
    rawLog(line);
  };
  rawLog('extensionPath=' + context.extensionPath);
  rawLog('process.type=' + process.type + ' electron=' + process.versions.electron);
  rawLog('BRANCH_ORBS_ELECTRON=' + (process.env.BRANCH_ORBS_ELECTRON || '(unset)'));
  rawLog('git=' + resolveGit());
  rawLog('workspaceFolders=' + JSON.stringify((vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath)));

  /* ── 状态栏豆子 ──
     ⚠ 踩过的坑：悬浮球是**另一个进程画的窗口**，它可能被别的窗口盖住、
       可能因为找不到 Electron 起不来、也可能飘在屏幕边缘用户根本没注意。
       一旦如此，用户界面上就"什么都没有"，看起来像扩展没装。
       所以这里在 VSCode 自己的状态栏常驻一颗豆子 —— 它在编辑器里一定可见，
       点一下就能显示/隐藏悬浮球。球没出来时，用户至少知道扩展活着。 */
  rawLog('creating statusItem…');
  let statusItem = null;
  try {
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusItem.command = 'branchOrbs.toggle';
    statusItem.name = 'Branch Orbs';
    rawLog('statusItem created ok');
  } catch (e) {
    rawLog('createStatusBarItem 失败：' + e.message);
  }

  /* 是否已经至少完整读过一次仓库。没读过时豆子显示"读取中"而不是"没有仓库" ——
     这两件事对用户意义完全不同：前者等一下就好，后者要去排查。
     实测首启时 VSCode 要 48s 才激活扩展，之后还要 6s 跑 git，
     中间这段空白期如果显示"没有仓库"，会被误判成故障。 */
  let firstRefreshDone = false;

  function renderStatus() {
    if (!statusItem) return;
    try {
      const repos = diagnostic.repos || [];
      const r = repos.find((x) => x.isActive) || repos[0];
      if (!r) {
        if (!firstRefreshDone) {
          statusItem.text = '$(sync~spin) Branch Orbs 读取中';
          statusItem.tooltip = 'Branch Orbs 正在读取 git 仓库…（首次启动 VSCode 较慢，请稍候）';
        } else {
          statusItem.text = '$(circle-large-outline) Branch Orbs';
          statusItem.tooltip = '没有识别到 git 仓库。点击这里在状态栏切换悬浮球，或运行「Branch Orbs: 自检」排查。';
        }
      } else {
        const extra = repos.length > 1 ? ' +' + (repos.length - 1) : '';
        statusItem.text = '$(circle-large-filled) ' + r.branch + extra;
        const lines = [
          'Branch Orbs（点击显示/隐藏悬浮球）',
          '分支：' + r.branch + (r.isActive ? '  ← 当前文件' : ''),
        ];
        if (r.ahead || r.behind) lines.push('领先 ' + r.ahead + ' / 落后 ' + r.behind);
        lines.push('改动文件：' + (r.changed || 0) + '   增删行：+' + (r.added || 0) + ' -' + (r.deleted || 0));
        if (r.lastCommit) lines.push('最近：' + r.lastCommit.subject + '  (' + r.lastCommit.when + ')');
        if (repos.length > 1) {
          lines.push('');
          const wins = diagnostic.windows || [];
          lines.push('全部仓库（' + repos.length + ' 个' + (wins.length > 1 ? '，来自 ' + wins.length + ' 个 VSCode 窗口' : '') + '）：');
          for (const x of repos) lines.push('  · ' + x.name + '  [' + x.branch + ']');
        }
        statusItem.tooltip = lines.join('\n');
      }
      statusItem.show();
      rawLog('renderStatus shown: ' + statusItem.text);
    } catch (e) {
      rawLog('renderStatus 抛异常：' + e.message);
    }
  }

  /* ── 兜底数据源：VSCode 自带 git 扩展的 API ──
     我们的主通道是直接跑 git 命令。但万一机器上没有 git、或 PATH 异常、
     或 git 版本太老不支持 --porcelain=v2，主通道会空手而归。
     此时 VSCode 内置 git 扩展（如果启用）已经算好了同样的数据 —— 借它的结果，
     至少能让豆子和球显示正确的分支名。 */
  async function reposFromVscodeGit() {
    let ext;
    try {
      ext = vscode.extensions.getExtension('vscode.git');
    } catch (_) {
      return null;
    }
    if (!ext) return null;
    try {
      if (!ext.isActive) {
        // 别 await 太久：内置 git 扩展在超大仓库上激活可能很慢，超时就放弃这条兜底
        await Promise.race([ext.activate(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]);
      }
      const api = ext.exports && (ext.exports.getAPI ? ext.exports.getAPI(1) : ext.exports);
      if (!api || !api.repositories) return null;
      const list = api.repositories;
      if (!list || list.length === 0) return null;
      const out = [];
      for (const repo of list) {
        const h = repo.state && repo.state.HEAD;
        const root = repo.rootUri && repo.rootUri.fsPath;
        if (!root) continue;
        out.push({
          root,
          name: path.basename(root),
          branch: (h && h.name) || (h && h.commit ? '@' + String(h.commit).slice(0, 7) : '(no commits)'),
          detached: !!(h && !h.name && h.commit),
          ahead: (h && h.ahead) || 0,
          behind: (h && h.behind) || 0,
          changed: (repo.state && repo.state.workingTreeChanges ? repo.state.workingTreeChanges.length : 0) +
            (repo.state && repo.state.indexChanges ? repo.state.indexChanges.length : 0),
          added: 0,
          deleted: 0,
          lastCommit: null,
          isActive: false,
          error: null,
        });
      }
      return out;
    } catch (e) {
      log('vscode.git 兜底失败：' + e.message);
      return null;
    }
  }

  /* ── 数据源：一个目录里的 git 命令 ── */
  const model = {
    exec: (cwd, args) => {
      const git = resolveGit();
      if (!git) {
        // 没有 git 就不要假装"仓库列表为空"——那是不可诊断的静默失败
        return Promise.resolve({
          code: 127,
          stdout: '',
          stderr: 'git not found（找不到 git 可执行文件，请确认 git 已安装并在 PATH 中，或设置 git.path）',
        });
      }
      return new Promise((resolve) => {
        cp.execFile(
          git,
          ['-c', 'core.quotepath=false', ...args],
          { cwd, timeout: 12000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
          (err, stdout, stderr) =>
            resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout || '', stderr: stderr || '' })
        );
      });
    },
    workspaceFolders: () => (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath),
    warn: (m) => log('warn', m),
  };

  function activeDir() {
    const ed = vscode.window.activeTextEditor;
    if (ed && ed.document && ed.document.uri && ed.document.uri.scheme === 'file') {
      return path.dirname(ed.document.uri.fsPath);
    }
    return null;
  }

  /* ── 主窗口矩形存活在 renderer 进程里，扩展侧能通过"执行命令时注入的 window"拿到 ──
     这里用 workspace.fs 无法访问；退而求其次：用 VSCode 自己的窗口标题作为线索不可靠，
     所以直接把"当前工作区/活动文件"作为锚点交给壳去贴合屏幕。真正精确的做法是
     通过 vscode.env 里没有的 screen —— 因此壳侧用 workArea 兜底，见 shell/main.js 的 anchor。 */
  function anchorRect() {
    return null;
  }

  /* ── 壳进程 ── */
  const root = context.extensionPath;
  const userData = path.join(context.globalStorageUri ? context.globalStorageUri.fsPath : os.tmpdir(), 'shell-ud');
  try {
    fs.mkdirSync(userData, { recursive: true });
  } catch (_) {}
  const tmpdir = path.join(userData, 'tmp');
  try {
    fs.mkdirSync(tmpdir, { recursive: true });
  } catch (_) {}

  const launch = launchArgs(root, {});
  rawLog('root=' + root);
  rawLog('launch=' + (launch ? JSON.stringify({ electron: launch.electron, args: launch.args }) : 'NULL'));
  if (!launch) {
    rawLog('candidates=' + JSON.stringify(require('./launcher').candidates(root)));
  }
  let shell = null;
  let lastCfg = null;

  /* ⚠ 这个变量必须在使用它的函数（ensureShell / refresh）之前声明。
     之前它被放在了 refresh 附近（靠后），而 ensureShell 在激活末尾就会被调用 ——
     `const` 的 TDZ 会让 ensureShell 抛 ReferenceError，整个激活链条断在这里，
     界面上表现依旧是"什么都没发生"。所有"只提示一次"的闸门统一放这里。 */
  const warned = { empty: false, launch: false };

  const diagnostic = {
    lane: null,
    hot: -1,
    bounds: null,
    anchors: null,
    repos: [],
    log: [],
    shellAlive: () => !!(shell && shell.alive()),
    launch: launch ? { electron: launch.electron, args: launch.args } : null,
    lastConfig: () => lastCfg,
    send: (msg) => shell && shell.send(msg),
    request: (msg, t) => (shell ? shell.request(msg, t) : Promise.resolve(null)),
    refresh: () => refresh(),
    shellLog: () => (shell ? shell.recentLines.slice() : []),
  };

  function ensureShell() {
    if (!launch) {
      /* 没找到 Electron 是"结构性失败"，界面上必须说清楚，否则用户只看到没球。
         提示一次就够，别在每 1.5s 的守护定时器里反复弹。 */
      log('ensureShell: launch=NULL，找不到 Electron');
      if (!warned.launch) {
        warned.launch = true;
        vscode.window
          .showErrorMessage(
            'Branch Orbs：找不到可用的 Electron 运行时，悬浮球无法显示。' +
              '请设置环境变量 BRANCH_ORBS_ELECTRON 指向 electron 可执行文件后重启 VSCode。',
            '查看候选路径'
          )
          .then((pick) => {
            if (pick) {
              const cands = require('./launcher').candidates(root);
              const doc = vscode.workspace.openTextDocument({
                language: 'plaintext',
                content: '试图查找的 Electron 路径（都不存在）：\n\n' + cands.join('\n') + '\n\n' +
                  '解决办法：\n' +
                  '  1. npm i -g electron  然后 export BRANCH_ORBS_ELECTRON=$(which electron)\n' +
                  '  2. 或用 npx electron 下载一个，把它的 dist/electron 路径填进环境变量\n',
              });
              doc.then((d) => vscode.window.showTextDocument(d, { preview: true }));
            }
          });
      }
      return null;
    }
    if (shell && shell.alive()) return shell;
    shell = new Shell({
      root,
      launch,
      env: spawnEnv(root, { userData, tmpdir, logFile: path.join(userData, 'shell.log') }),
      logger: (m) => log(m),
      onEvent: onShellEvent,
      onExit: () => {
        diagnostic.log.push('shell exit');
      },
    });
    diagnostic.log.push('shell start');
    shell.start();
    return shell;
  }

  function onShellEvent(m) {
    if (!m || !m.type) return;
    switch (m.type) {
      case 'boot':
        log('shell booted pid', m.pid, 'electron', m.electron);
        pushConfig();
        refresh();
        break;
      case 'ready':
        pushConfig();
        refresh();
        break;
      case 'click': {
        const repo = m.repo || diagnostic.repos[m.index];
        if (repo) openRepo(repo);
        break;
      }
      case 'menu': {
        const repo = diagnostic.repos[m.index];
        if (m.action === 'copy' && repo) {
          vscode.env.clipboard.writeText(repo.branch);
          vscode.window.setStatusBarMessage('已复制 ' + repo.branch, 1500);
        } else if (m.action === 'open' && repo) {
          vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(repo.root), { forceNewWindow: true });
        } else if (m.action === 'refresh') {
          refresh();
        } else if (m.action === 'hide') {
          toggle(false);
        }
        break;
      }
      case 'dragcommit':
        vscode.workspace
          .getConfiguration('branchOrbs')
          .update('offset', m.offset, vscode.ConfigurationTarget.Global)
          .then(() => pushConfig());
        break;
      case 'fatal':
        log('shell fatal:', m.message);
        break;
      case 'hover':
        diagnostic.hot = m.index;
        break;
      case 'page-log':
        log('page:', m.msg);
        break;
      default:
        break;
    }
  }

  /* ── 配置 → 壳 ── */
  function readCfg() {
    const raw = loadConfig(vscode);
    const side = effectiveSide(raw);
    return {
      dock: side.kind === 'corner' ? (side.corner === 'right' ? 'bottom-right' : 'bottom-left') : raw.dock,
      size: raw.ballSize,
      gap: raw.gap,
      sink: raw.sink,
      offset: raw.offset,
      showCard: raw.showCard,
      drag: raw.drag,
      maxRepos: raw.maxRepos,
    };
  }

  function pushConfig() {
    if (!shell) return;
    lastCfg = readCfg();
    shell.send({ type: 'config', cfg: lastCfg });
  }

  function pushAnchor() {
    if (!shell) return;
    const r = anchorRect();
    if (r) shell.send({ type: 'anchor', rect: r });
  }

  /* ── 刷新仓库 ── */
  let refreshing = null;
  let lastRefreshAt = 0;
  async function refresh(force) {
    const now = Date.now();
    if (!force && now - lastRefreshAt < 300) return diagnostic.repos;
    lastRefreshAt = now;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const c = lastCfg || readCfg();
      const aDir = activeDir();
      let roots = [];
      try {
        roots = await gitModel.discoverRepos(model, { max: c.maxRepos, activeDir: aDir });
      } catch (e) {
        log('discover failed', e.message);
      }
      const activeRoot = aDir ? gitModel.findGitRoot(aDir) : null;
      const repos = [];
      for (const r of roots) {
        try {
          const info = await gitModel.readRepo(model, r);
          info.isActive = !!activeRoot && r === activeRoot;
          repos.push(info);
        } catch (e) {
          repos.push({ root: r, name: path.basename(r), branch: '?', error: e.message, changed: 0 });
        }
      }

      /* ── 跨窗口汇聚 ──
         先把本窗口的仓库写进注册表，再读回所有窗口的。
         这一步做完，用户开了三个 VSCode 窗口、每个开一个工程，
         底部就会有三颗球，而不是只有当前窗口那一个。
         注册表读写失败不能影响主流程（只读文件系统），所以整体 try 包住。 */
      let merged = repos;
      try {
        registry.writeWindowRepos(registryDir, windowId, repos, {
          workspace: (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath),
        });
        const all = registry.readAllRepos(registryDir);
        if (all.repos.length > 0) {
          // 本窗口的 isActive 优先（别的窗口也会上报 isActive，那是"它那边的活动文件"）
          const mine = new Map(repos.map((r) => [r.root, r]));
          merged = all.repos.map((r) => {
            const local = mine.get(r.root);
            if (local) return { ...r, isActive: local.isActive };
            return r;
          });
          if (all.windows.length > 1) {
            log('跨窗口汇聚：' + all.windows.length + ' 个窗口，共 ' + merged.length + ' 个仓库');
          }
        }
      } catch (e) {
        log('跨窗口注册表失败（忽略，仅影响多窗口）：' + e.message);
      }

      diagnostic.repos = merged;
      diagnostic.windows = (() => {
        try {
          return registry.readAllRepos(registryDir).windows;
        } catch (_) {
          return [];
        }
      })();

      /* 主通道空手而归时走兜底 —— 否则用户只看到"没有球"，而内置 git 明明知道分支。 */
      if (merged.length === 0) {
        const alt = await reposFromVscodeGit();
        if (alt && alt.length) {
          const activeRoot2 = aDir ? gitModel.findGitRoot(aDir) : null;
          for (const x of alt) x.isActive = !!activeRoot2 && x.root === activeRoot2;
          diagnostic.repos = alt;
          log('主通道无仓库，采用 vscode.git 兜底：' + alt.length + ' 个');
          if (shell && shell.alive()) shell.send({ type: 'repos', repos: stripHeavy(alt) });
          firstRefreshDone = true;
          renderStatus();
          return alt;
        }
      }

      if (shell && shell.alive()) shell.send({ type: 'repos', repos: stripHeavy(merged) });
      firstRefreshDone = true;
      renderStatus();

      /* 静默失败是最糟的体验：球不出来，用户完全不知道发生了什么。
         这里把两种"必然没球"的原因显式说出来（只提示一次，别反复弹）。 */
      if (repos.length === 0 && !warned.empty) {
        warned.empty = true;
        if (!resolveGit()) {
          const pick = await vscode.window.showErrorMessage(
            'Branch Orbs：找不到 git，无法读取分支。请安装 git，或在设置里填 git.path。',
            '打开设置'
          );
          if (pick) vscode.commands.executeCommand('workbench.action.openSettings', 'git.path');
        } else {
          vscode.window.showWarningMessage(
            'Branch Orbs：当前工作区里没有 git 仓库，所以没有球。打开一个 git 项目试试。'
          );
        }
      }
      return repos;
    })();
    try {
      return await refreshing;
    } finally {
      refreshing = null;
    }
  }

  /** 只把壳要用的字段发过去（别把整条 log 发过管道） */
  function stripHeavy(repos) {
    return repos.map((r) => ({
      root: r.root,
      name: r.name,
      branch: r.branch,
      detached: r.detached,
      ahead: r.ahead,
      behind: r.behind,
      changed: r.changed,
      added: r.added,
      deleted: r.deleted,
      lastCommit: r.lastCommit,
      isActive: !!r.isActive,
      error: r.error || null,
    }));
  }

  function openRepo(repo) {
    const folders = vscode.workspace.workspaceFolders || [];
    const inWs = folders.find((f) => repo.root === f.uri.fsPath || repo.root.startsWith(f.uri.fsPath + path.sep));
    if (inWs) {
      vscode.commands.executeCommand('workbench.view.scm');
      vscode.window.showInformationMessage('已在工作区：' + repo.branch, { modal: false });
      return;
    }
    vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(repo.root), { forceNewWindow: false });
  }

  /* ── 显示 / 隐藏 ── */
  async function toggle(show) {
    const want = typeof show === 'boolean' ? show : !(shell && shell.alive());
    if (want) {
      ensureShell();
      pushConfig();
      await refresh(true);
    } else if (shell) {
      shell.send({ type: 'hide' });
      shell.stop();
      shell = null;
    }
    await vscode.workspace
      .getConfiguration('branchOrbs')
      .update('enabled', want, vscode.ConfigurationTarget.Global);
  }

  /* ── 注册 ── */
  context.subscriptions.push(
    channel,
    statusItem,
    { dispose: () => shell && shell.stop() },
    vscode.commands.registerCommand('branchOrbs.toggle', () => toggle()),
    vscode.commands.registerCommand('branchOrbs.refresh', async () => {
      await refresh(true);
      vscode.window.setStatusBarMessage('$(sync) Branch Orbs 已刷新', 1500);
    }),
    vscode.commands.registerCommand('branchOrbs.show', () => toggle(true)),
    vscode.commands.registerCommand('branchOrbs.hide', () => toggle(false)),
    vscode.commands.registerCommand('branchOrbs.diag', async () => {
      ensureShell();
      const d = await diagnostic.request({ type: 'diag' }, 2500);
      const payload = {
        launch: diagnostic.launch,
        shellAlive: diagnostic.shellAlive(),
        extHost: { type: process.type || null, versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node } },
        shellDiag: d ? d.data : null,
        cfg: lastCfg,
        repos: diagnostic.repos.map((r) => ({ name: r.name, branch: r.branch, changed: r.changed, active: !!r.isActive })),
        shellLog: diagnostic.shellLog(),
      };
      const doc = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(payload, null, 2) });
      await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    }),

    /* 一键自检：把"为什么没有球"的整条链路都摊开。
       比 diag 更面向"用户看不懂 JSON"的场景 —— 纯文本、直接给结论。 */
    vscode.commands.registerCommand('branchOrbs.why', async () => {
      await refresh(true);
      const git = resolveGit();
      const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
      const lines = [];
      const OK = (b) => (b ? '✅' : '❌');

      lines.push('Branch Orbs 自检');
      lines.push('='.repeat(50));
      lines.push('');
      lines.push(OK(!!git) + ' git 可执行文件：' + (git || '找不到'));
      lines.push(OK(folders.length > 0) + ' 工作区文件夹：' + (folders.length ? folders.join(', ') : '（无，请先打开一个文件夹）'));
      lines.push(OK(diagnostic.repos.length > 0) + ' 识别到的仓库：' + diagnostic.repos.length + ' 个');
      for (const r of diagnostic.repos) {
        lines.push('     · ' + r.name + '  [' + r.branch + ']  改动 ' + (r.changed || 0) +
          (r.isActive ? '  ← 当前' : '') + (r.error ? '  ⚠ ' + r.error : ''));
      }
      lines.push('');
      lines.push(OK(!!launch) + ' Electron：' + (launch ? launch.electron : '找不到（悬浮球无法显示）'));
      if (!launch) {
        lines.push('     候选路径（都不存在）：');
        for (const c of require('./launcher').candidates(root)) lines.push('       ' + c);
        lines.push('     → 设置环境变量 BRANCH_ORBS_ELECTRON 指向 electron 可执行文件');
      }
      lines.push(OK(diagnostic.shellAlive()) + ' 壳进程：' + (diagnostic.shellAlive() ? '运行中' : '未运行'));
      const sd = await diagnostic.request({ type: 'diag' }, 2000);
      if (sd && sd.data) {
        lines.push('     窗口 bounds：' + JSON.stringify(sd.data.bounds));
        lines.push('     屏幕 workArea：' + JSON.stringify(sd.data.workArea));
        lines.push('     当前车道：' + sd.data.lane + (sd.data.ignoring ? '（穿透中）' : ''));
      }
      lines.push('');
      lines.push('启动日志：' + bootLogPath);

      const doc = await vscode.workspace.openTextDocument({ language: 'plaintext', content: lines.join('\n') });
      await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    }),
    vscode.window.onDidChangeActiveTextEditor(() => refresh()),
    vscode.workspace.onDidSaveTextDocument(() => refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => refresh(true)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('branchOrbs')) return;
      pushConfig();
      refresh(true);
    })
  );

  // 兜底：每隔一会儿把 anchors 同步进诊断，并确保壳还没死
  const timer = setInterval(() => {
    if (!shell) return;
    pushAnchor();
    if (!shell.alive() && vscode.workspace.getConfiguration('branchOrbs').get('enabled', true)) {
      log('shell 意外退出，重启');
      shell = null;
      ensureShell();
      pushConfig();
      refresh(true);
    }
  }, 1500);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  /* ── 跨窗口心跳 ──
     每 15s 重写一次本窗口的注册表文件（顺带刷新 git 数据），
     别的窗口读到的 updatedAt 就不会过期。
     同时读回全部窗口：如果"总仓库数"或"窗口数"和上次不同，
     说明别的窗口开了/关了工程 —— 立刻把新列表推给壳，球会跟着增减。
     这个定时器**不依赖 shell 是否存在**：没球时也要维持心跳，
     否则别的窗口会以为我这个窗口已经关了。 */
  let lastSeen = '';
  function heartbeat(tick) {
    let snapshot = null;
    try {
      registry.writeWindowRepos(registryDir, windowId, diagnostic.repos || [], {
        workspace: (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath),
      });
      snapshot = registry.readAllRepos(registryDir);
    } catch (_) {
      return;
    }
    diagnostic.windows = snapshot.windows;
    const sig = snapshot.repos.map((r) => r.root + '|' + r.branch).join(',') + '#' + snapshot.windows.length;
    if (sig !== lastSeen) {
      lastSeen = sig;
      // 别的窗口有新东西：重新走一遍 refresh，让本窗口也把合并结果发给壳
      refresh(true).catch(() => {});
    } else if (tick % 4 === 0) {
      // 纯心跳：顺带刷新本窗口 git 状态（可能会变，比如刚切了分支）
      refresh(true).catch(() => {});
    }
  }
  const hbTimer = setInterval(() => heartbeat(Math.floor(Date.now() / 15000)), 15000);
  context.subscriptions.push({ dispose: () => clearInterval(hbTimer) });

  /* 窗口关闭时把自己从注册表里摘掉 —— 否则别人的球里会残留一个死仓库
     （虽然有 TTL 兜底，但主动清理能让反馈快 45 秒变成即时）。 */
  context.subscriptions.push({
    dispose: () => {
      try {
        registry.removeWindow(registryDir, windowId);
      } catch (_) {}
    },
  });

  /* 先把状态栏豆子亮起来 —— 这一行一定成功（纯 VSCode API），
     即便后面壳进程起不来，用户也能在状态栏看到扩展在跑、能点开自检。 */
  rawLog('about to renderStatus (初始占位)');
  renderStatus();

  rawLog('about to ensureShell');
  try {
    if (vscode.workspace.getConfiguration('branchOrbs').get('enabled', true)) {
      ensureShell();
    }
  } catch (e) {
    rawLog('ensureShell 抛异常：' + e.message + ' | ' + (e.stack || '').split('\n').slice(0, 3).join(' / '));
  }

  // 无论球能不能起来，都把仓库读一遍：豆子需要数据，自检也需要
  rawLog('about to first refresh');
  refresh(true)
    .then((repos) => rawLog('首次 refresh 完成，repos=' + (repos ? repos.length : 'null')))
    .catch((e) => rawLog('首次 refresh 失败：' + (e && e.message)));
}

function deactivate() {}

module.exports = { activate, deactivate };
