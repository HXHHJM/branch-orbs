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

> 更完整的排查请查 **[`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md)** ——
> 按现象查表，收录了 9 层实测根因（球不可见 / 点击被吞 / 连点失效 / 壳冻结 /
> 误收聊天窗 / 输入区吞点击 / 双壳打架 / **VSCode 跑成 native Wayland**）与对应判定命令。

## 使用

| 动作 | 效果 |
| --- | --- |
| 悬停 | 球上探 + 信息卡（分支名 / 仓库名 / ↑↓ / 最近提交） |
| 左键点球 | **展开 / 收起对应的 VSCode 窗口**（最小化 ⇄ 恢复置前） |
| 右键 | 复制分支名 / 打开 / 刷新 / 隐藏 |
| 沿底边拖球 | 调整 `branchOrbs.offset`（自动写回设置） |
| 命令面板 `Branch Orbs` | 显示 / 隐藏 / 刷新 / 诊断 |

### 点球展开 / 收起窗口是怎么做的

VSCode **只提供** `workbench.action.minimizeWindow`（收起），**没有取消最小化的命令** ——
收起来就回不来了。所以这条路必须绕到窗口管理器层，走 X11 EWMH：

| 方向 | 发出的消息 | 说明 |
| --- | --- | --- |
| 收起 | `WM_CHANGE_STATE` + `IconicState` | 等价于 ICCCM 的 `XIconifyWindow` |
| 展开 | `_NET_ACTIVE_WINDOW` | 恢复并置前（`source=1` pager 来源） |
| 判态 | `_NET_WM_STATE` 里是否含 `_NET_WM_STATE_HIDDEN` | 决定这次是收起还是展开 |

实现在 `src/xwin.py`（纯 `python-xlib`，不需要 xdotool/wmctrl）。

**窗口怎么匹配到具体的球**，按优先级：

1. **PID 精确匹配** —— 窗口的 `_NET_WM_PID` == 本窗口主进程 pid。与标题完全无关，最可靠。
   扩展向上遍历 `/proc` 父链，跳过 `--type=extensionHost` 这类子进程，找到真正持有
   `BrowserWindow` 的主进程。
2. **标题包含关键字** —— 关键字是「仓库名 / 路径末段 / 完整路径」，任一命中即可。
3. **类名包含关键字** —— 同上。

> 为什么不能只用「仓库名匹配标题」：
> 窗口标题可以被 `window.title` 设置改掉、SSH 远端窗口标题是 `SSH: xxx`、
> 工程还没加载完时标题就是 `Visual Studio Code`。这三种情况下按仓库名匹配**全部失效**。

`_NET_WM_STATE_HIDDEN` 由窗口管理器异步更新，所以 `xwin.py` 每次动作后都会
`wait_state()` 轮询到状态真正改变才返回（`settled` 字段），避免"连点两下失效"的竞态。

匹配到窗口后还有一道**进程命令行裁决**（`editor_verdict`）：读 `_NET_WM_PID` →
`/proc/<pid>/cmdline`，只有确认属于 VSCode 系编辑器才允许收/展；
属于聊天客户端等其他 Electron 应用（路径含 `/opt/<app>`）的窗口**一律拒绝**。
兜底也从「屏幕上只有一个像编辑器的窗口就用它」改成了「唯一**通过裁决的**编辑器窗口」——
**宁可没反应，绝不收错窗口**。

未命中时只弹一句非模态提示，**不会去动宿主 UI**（旧版会执行 `workbench.view.scm` 切侧边栏，
表现成「点一下界面乱跳」，已移除）。

> ⚠ **Wayland 用户必读**：如果目标 VSCode 以 native Wayland 运行，X11 层面**根本不存在**它的窗口，
> 匹配必然失败。判定与修复见 [`docs/TROUBLESHOOTING.md` 第 9 条](docs/TROUBLESHOOTING.md)。

排查点击无效：

```bash
# 看当前能匹配到哪些 VSCode 窗口（每个都带 verdict: editor / chat / null）
python3 src/xwin.py list
# 试匹配（不动窗口）
python3 src/xwin.py probe 你的仓库名
# 在本机做一轮 minimize→activate 往返验证
python3 src/xwin.py selftest
```

### 跑全部自检

```bash
bash test/all.sh              # 8 个自检，约 106 条断言
WITH_SHELL=1 bash test/all.sh # 额外跑"真起 Electron 壳"（慢，需要 X）
```

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
7. **`setShape` 传的是 DIP，且内部会再乘 `scaleFactor`**：自己再乘一次就是双重换算，
   shape 整体越界窗外 → 窗口 mapped、页面有像素、屏幕上却永远看不见。
8. **`setShape` 同时裁剪绘制与输入**（当前 Electron 无 `setInputRegion`）：
   输入区必须精确贴合球本身，横向铺满全宽会把下面所有窗口的底边点击全部吃掉。
9. **native Wayland 窗口对 X11 完全不可见**（安全模型限制，非 bug）：
   需要 `--ozone-platform=x11` 让目标跑 XWayland，见 `docs/TROUBLESHOOTING.md`。

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

## 状态栏豆子：**有几个仓库就有几颗豆子**

激活时会在状态栏右侧为**每个识别到的仓库**常驻一颗豆子，各显示自己的分支名：

```
$(circle-large-filled) new_s11x_motor ●   $(circle-large-filled) master   $(circle-large-filled) dev
```

- **活动仓库排最右**（状态栏从右往左读，第一眼看到的就是当前文件所在的仓库）
- 分支名后的 `●` = 这个仓库有未提交改动
- 图标区分：实心 `$(circle-large-filled)` = 当前仓库，空心 `$(circle-large-outline)` = 其他仓库，`$(warning)` = 读取异常
- **点活动仓库那颗** → 显示/隐藏悬浮球
- **点其他仓库那颗** → 跳到那个仓库（已在本工作区就切 SCM 视图，否则新窗口打开）
- **悬停任意一颗** → 该仓库的分支、领先/落后、改动文件数、增删行数、最近一条提交
- 豆子上限 12 颗，多出来的折成一颗 `$(ellipsis) +N`（点开是仓库列表）

> ⚠ **别 hover 错豆子**：VSCode 内置 Git 扩展也会在状态栏放一颗 `⑂ 分支名`，
> 文字和我们的豆子一模一样。悬停它弹出来的是"Checkout Branch/Tag…"，
> 那是 Git 的菜单提示，不是 Branch Orbs 的仓库信息。
> 我们的豆子图标是 ● / ○（tooltip 首行写"Branch Orbs 豆子"），
> 且排在状态栏**最右端**。悬停出浮层需要停 ~1 秒，划太快不会触发。

豆子的 `name` 是 `Branch Orbs · 当前 · <仓库名>` / `Branch Orbs · <仓库名>`，
所以右键状态栏 → 可以**单独**隐藏某一个仓库的豆子，不影响其他。

### 跨窗口：开了几个 VSCode 窗口，就汇总几个窗口的仓库

每个 VSCode 窗口把自己的仓库快照写到
`~/.vscode-branch-orbs/branch-orbs-windows/<windowId>.json`（15s 心跳），
再读回所有人的条目合并显示。所以：

- 三个窗口各开一个工程 → 状态栏三颗豆子、屏幕底部三颗球
- 窗口关掉 → 自己的条目被摘除，其他窗口的豆子立刻少一颗（另有 45s TTL 兜住崩溃退出的情况）
- 同一个仓库被两个窗口打开 → 只显示一颗（按 root 去重）

没识别到仓库时显示 `$(circle-large-outline) Branch Orbs`；
还没读完（首次启动 VSCode 很慢，实测要 48~66 秒）显示 `$(sync~spin) Branch Orbs 读取中`。

有了它，即使悬浮球被其他窗口盖住、或 Electron 起不来，你也能立刻确认：
**扩展活着、git 读到了、一共几个仓库、各自在哪个分支**。

打包：`node scripts/pack.js`（离线自打包，不依赖 npm registry）
或 `npm run package`（需要能联网装 vsce）。

## License

MIT
