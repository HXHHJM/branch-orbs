# Branch Orbs

把工作区里的 git 仓库收进一列**沉在屏幕底边的并列小球**，鼠标放上去即显示分支名、增删数与最近提交。

```
                                  ┌──────────────────────────┐
                                  │ ● feature/sinking-orbs   │
                                  │   firmware               │
                                  │   工作区干净  ↓1          │
                                  │   wip: orbs 下沉量对齐    │
                                  └──────────────────────────┘
                        ⬤   ⬤   ⬤        ← 悬停的球上探，卡片展开
        ════════════════════════════════════════  ← 屏幕底边（球沉下去一截）
```

## 安装

```bash
code --install-extension branch-orbs-0.1.0.vsix
```

装完重启 VSCode，球自动出现在屏幕底边正中。

### 看不到球？跑一次自检

命令面板 → **`Branch Orbs: 自检：为什么看不到悬浮球`**

它会逐项打 ✅/❌：git 是否可用、工作区文件夹、识别到几个仓库、Electron 是否找到、
壳进程是否在跑、窗口 bounds 与屏幕 workArea。绝大多数"没效果"都是下面两条之一：

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| 完全没有球，也无报错 | **扩展宿主的 PATH 里没有 git**（从桌面图标启动时很常见） | 装 git；或在 `settings.json` 里填 `"git.path": "C:/Program Files/Git/cmd/git.exe"` |
| 弹"找不到 Electron" | deb 版 VSCode 剥掉了 electron 模块 | `npm i -g electron` 后设 `BRANCH_ORBS_ELECTRON=$(which electron)`，重启 VSCode |
| 有球但只有一个空窗 | 当前打开的目录不是 git 仓库 | 打开一个 `git init` 过的项目 |

## 使用

| 动作 | 效果 |
| --- | --- |
| 悬停 | 球上探 + 信息卡（分支名 / 仓库名 / ↑↓ / 最近提交） |
| 左键点球 | 打开该仓库（已在工作区则打开源代码管理面板） |
| 右键 | 复制分支名 / 打开 / 刷新 / 隐藏 |
| 沿底边拖球 | 调整 `branchOrbs.offset`（自动写回设置） |
| 命令面板 `Branch Orbs` | 显示 / 隐藏 / 刷新 / 诊断 |

## 配置（settings.json）

```jsonc
{
  "branchOrbs.enabled": true,     // 激活即显示
  "branchOrbs.dock": "bottom",    // bottom | bottom-left | bottom-right | top
  "branchOrbs.sink": 0.32,        // 下沉比例（球半径的 32% 藏在屏幕外）
  "branchOrbs.ballSize": 30,
  "branchOrbs.gap": 8,
  "branchOrbs.offset": 0,         // 沿边缘偏移，留开任务栏
  "branchOrbs.showCard": true,
  "branchOrbs.drag": true,
  "branchOrbs.maxRepos": 6
}
```

## 架构（为什么需要一个独立壳进程）

VSCode 扩展宿主是 `process.type === 'utility'` 的进程，`require('electron')` 只有
`net` / `systemPreferences` —— **没有 `BrowserWindow`、没有 `screen`**，扩展自己开不了窗口。

所以本扩展分两半：

```
src/extension.js  ──JSONL over stdin/stdout──▶  shell/main.js（独立 Electron 进程）
     │                                              │
     │ 读 git、监听编辑器事件                          │ 无边框置顶透明窗口
     │ 推 {type:'repos'} / {type:'config'}           │ 渲染 orbs.html（三区带穿透）
     ▶ 收 click / hover / dragcommit                 ▶ 把命中结果发回扩展
```

- **协议**：一行一个 JSON。stdout 只解析 `{` 开头的行，其余（Electron 杂音）转日志，协议不会被弄坏。
- **Electron 从哪来**：优先扩展自带的 `shell/node_modules/electron`，其次 `BRANCH_ORBS_ELECTRON`
  环境变量，最后尝试 VSCode 自带二进制（deb 版 VSCode 通常已剥掉，此时会提示设置环境变量）。

## 已知限制（每条都在真机踩过）

1. **X11 窗口最小尺寸**：小于 128px 会被 mutter 降级成 0×0 且 `setBounds` 无法恢复。
   壳里用 `MIN_WIN_W=48 / MIN_WIN_H=30` 兜底。
2. **mutter 钳制窗口位置**：把窗口挪到工作区之外会被拉回来，"下沉"无法靠窗口越界实现。
   对策：窗口贴边不动，下沉由页面 CSS（`body.sink #dock { bottom: calc(-1*var(--sink)) }`）完成。
3. **`focusable:false` 收不到输入**：必须 `focusable:true` + `showInactive()`。
4. **`setPosition()` 会涨尺寸**：只用 `setBounds` 且每次显式带 width/height。
5. **绝不轮询 `screen.getCursorScreenPoint()`**：X11 下是事件驱动缓存，窗口穿透后读数冻结。
6. **Linux `/dev/shm` < 64MB** 时 Chromium 会 FATAL，壳自动加 `--disable-dev-shm-usage`。

## 开发 / 自测

```bash
node test/git-selftest.js       # 16 条：git 解析（含中文路径、detached、二进制 numstat）
node test/activate-selftest.js  # 9 条：激活全流程（假 vscode 模块跑真实 activate）
node test/shell-selftest.js     # 35 条：窗口几何、穿透、悬停、卡片、四种停靠
node test/live-scene.js         # 实景出图：真跑在 X11 上，输出几何证据 + 截图
```

`activate-selftest.js` 可以用 `--workspace <目录>` 指定工作区，验证分支名是否被正确读出：

```bash
node test/activate-selftest.js --workspace /path/to/your/repo
```

它守的是"扩展一激活就炸"这一类问题。因为悬浮球画在**另一个进程**里，激活中途抛异常时，
界面上既没有球也没有报错，用户看到的现象跟"扩展没装"完全一样。
（真实踩过：`warned` 声明在使用它的函数之后，撞 `const` 的 TDZ，activate 直接中断。）

## 状态栏豆子：看不到球时的第一手信号

激活时会在状态栏右侧常驻一颗豆子，内容就是当前分支名：

```
$(circle-large-filled) new_s11x_motor
```

- **点击** → 显示/隐藏悬浮球（等同 `Branch Orbs: 显示/隐藏悬浮球`）
- **悬停** → 分支、领先/落后、改动文件数、增删行数、最近一条提交
- 没识别到仓库时显示 `$(circle-large-outline) Branch Orbs`

有了它，即使悬浮球被其他窗口盖住、或 Electron 起不来，你也能立刻确认：
**扩展活着、git 读到了、分支是哪个**。

打包：`npm run package`（或 `npx vsce package --no-dependencies --allow-missing-repository`）。

## License

MIT
