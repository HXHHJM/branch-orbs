# 排查档案：悬浮球「看不见 / 点了没反应」

这份文档是**按现象查表**用的。每一条都是真机踩过、有实测证据的根因，不是猜测。
从上到下按「最容易命中」排序，逐层排除即可。

> 通用前提：本项目所有窗口操作都走 **X11 / EWMH**。
> 只要目标 VSCode 跑成 native Wayland，X11 侧就**完全看不到它**——见第 9 条，先排它最省时间。

---

## 0. 三条命令行速查

```bash
# ① 现在 X 上有哪些「像编辑器」的窗口，各判成什么
python3 src/xwin.py list

# ② 指定仓库名试匹配（不动窗口）
python3 src/xwin.py probe <仓库名>

# ③ 本机做一轮 minimize → activate 往返（会真的收起一次窗口）
python3 src/xwin.py selftest
```

`list` 输出里每个窗口都带 `verdict` 字段：`editor` 才允许被收/展，`chat` 一律拒绝，
`null` 表示读不到进程命令行（容器 / 权限受限，此时沿用旧行为）。

---

## 1. 球完全看不见，但进程活着、页面也渲染了

| 项 | 内容 |
| --- | --- |
| 症状 | 扩展日志正常、壳进程在跑、渲染页 `orbCount=1`，屏幕上就是没有球 |
| 判定 | 读壳窗口的真实 Shape：<br>`shape.get_rectangles(win, 0)`（bounding）→ 若矩形 y 超出窗口物理高度，即命中 |
| 根因 | **`setShape` 双重 DPI 换算**。Electron 内部会把 DIP 矩形 ×`scaleFactor` 再下发给 X；代码里若再乘一次 `scaleFactor`，shape 就整体越界窗外 → 可见区域是空的 |
| 实锤 | 修复前 X 实际 bounding `(0,1076,2221,66)`，窗口物理高度只有 988；`1076/931 = 2221/1921 = 1.15625` 正好等于 scale |
| 修复 | `syncShape()` 只传 **DIP** 矩形，并 clamp 进窗口尺寸，不再自己乘 scale |

> 关键点：`setShape` 设置的是**窗口坐标系（DIP）**，不要再手动做物理像素换算。

---

## 2. 点球后什么都不发生（点击被静默丢弃）

| 项 | 内容 |
| --- | --- |
| 症状 | 点击毫无反应，日志里连「收到了 click」都没有 |
| 判定 | 页面层加一次性埋点：`document` 上 `pointerdown` 记录 `(clientX, clientY, target.className)` 并经 IPC 上报 |
| 根因 | 页面用 `orbAt(e.target)` 找球元素，**找不到就静默 `return`**——不留任何日志 |
| 次因 | 主进程 hit-test 带「上探余量」（球上方几个 px 也算命中），而 DOM 命中要求精确落在球元素上。两个口径不一致 → 「看起来在球上、实际落空」 |
| 修复 | 诊断埋点常驻（`DIAG` 日志）；命中判定统一以 DOM 元素为准 |

> 静默丢弃是最难查的一类 bug。**任何 `if (!x) return;` 的分支都值得留一行日志。**

---

## 3. 点很多次只有偶尔一次生效

| 项 | 内容 |
| --- | --- |
| 症状 | 连点 5 次只切换 1 次；等待一会儿再点又能生效一次 |
| 判定 | 看 `DIAG` 日志：每次 `pointerdown` 都命中球，但扩展侧只收到 1 条 `click` |
| 根因 | **消息去重（DEDUP）把连点吞了**。去重 key = `channel + JSON(payload)`，同一颗球连点的 payload 完全相同 → 第 2~N 次被当「重复消息」丢弃 |
| 修复 | `click` / `context` / `drag*` 这类**动作**移出去重名单；只有 `measure`（状态同步）需要谨慎对待 |
| 附带 | 同轮发现 `ipc-message` 与 `ipcMain.on(channel)` **双通道重复投递**（日志里凭空多出的 `DIAG {}`），删掉一条路径 |

> 原则：**去重只适用于幂等的状态同步，不适用于一次性动作。**

---

## 4. 点球之后整个窗口管理器像「冻住」，日志停止写入

| 项 | 内容 |
| --- | --- |
| 症状 | 壳进程活着、X 窗口还在，但不再响应点击、日志一行不写 |
| 判定 | 对照壳日志时间戳与实际操作时间；若长时间空档 + 进程仍在，即主进程事件循环被阻塞 |
| 根因 | `execFileSync` 的 `timeout` 只对子进程发 `SIGTERM`；子进程卡在不可中断的 X 调用上时，Node 的同步等待**永不返回** |
| 修复 | ① 改异步 `execFile` + `{ timeout, killSignal: 'SIGKILL' }`；<br>② 外层再加 `setTimeout` 兜底回调；<br>③ 扩展侧 ping/pong 看门狗：15s 无回包即 `SIGKILL` 重启壳 |
| 注意 | 进程卡死时它**自己的定时器也停了**，所以心跳必须由外部（扩展）探测，不能靠壳自报 |

---

## 5. 扩展装上了，但「什么都不会发生」（连状态栏豆子都没有）

| 项 | 内容 |
| --- | --- |
| 症状 | 现象和「扩展没装」一模一样：无球、无豆子、无报错 |
| 判定 | 跑 `node test/activate-selftest.js`（用 vscode 桩真实执行 `activate`） |
| 根因 | **TDZ**：`startPingWatchdog()` 的调用写在 `let pingWatchdog` 声明之前 → 激活时抛 `Cannot access 'pingWatchdog' before initialization`，`activate` 整体中断 |
| 为什么难查 | `node --check` 是**语法**检查，这种运行时错误查不出来 |
| 修复 | 声明移到调用之前；并把「真实执行一次 activate」纳入自检 |

> 悬浮球画在另一个进程里，所以激活中途抛异常时界面**完全无提示**。

---

## 6. 点球把「聊天窗口 / 别的应用」收起来了

| 项 | 内容 |
| --- | --- |
| 症状 | 点球后消失的是聊天客户端或别的窗口，编辑器纹丝不动 |
| 判定 | `python3 src/xwin.py list` 看 `verdict`：被收下的窗口是不是 `chat` |
| 根因 | 匹配不到目标窗口时的**「只有一个像编辑器的窗口就直接用它」兜底**——而聊天客户端的 WM_CLASS 恰好也像代码编辑器（如 `workbuddy`） |
| 修复 | `editor_verdict()`：`_NET_WM_PID` → `/proc/<pid>/cmdline` 做最终裁决；<br>`/opt/<chat-app>` 及其派生路径 → `chat`，一律拒绝；<br>`/usr/share/code`、`vscodium`、`cursor` → `editor`；<br>兜底从 `only-window` 改成 `only-editor`（候选必须过裁决） |

> **宁可没反应，绝不收错窗口。**

---

## 7. 点球没反应，但「点编辑器内部」反而把窗口收起来了

| 项 | 内容 |
| --- | --- |
| 症状 | 编辑器状态栏那一条区域点一下就消失；球本身点了没反应 |
| 判定 | 读壳窗口 Shape 的 bounding：若横向铺满整个窗口宽（而非只有球那一小段），即命中 |
| 根因 | `syncShape` 里 `dipRect = { x: 0, width: 窗口全宽 }` → **底部整条横带都归覆盖层所有**。而 Electron 的 `setShape` **同时裁剪绘制与输入**（旧版没有独立的 `setInputRegion`），所以横带下方所有点击都被覆盖层吃掉 |
| 修复 | 横向收窄：静止态 = dock 水平范围 ±10px；交互态（卡片弹出）= 并入卡片范围；其余区域点击全部穿透 |

> 教训：透明 ≠ 可穿透。**覆盖层的输入区必须精确贴合可见内容。**

---

## 8. 屏幕上出现两颗（或更多）球，互相打架

| 项 | 内容 |
| --- | --- |
| 症状 | 同时有两个覆盖层窗口，点击行为不一致（一个生效一个不生效） |
| 判定 | 看 `~/.branch-orbs/xwin.log` 的 `ppid` 是否出现两套；或枚举覆盖层窗口数量 |
| 根因 | 开了第二个宿主窗口（或独立 VSCode 与聊天客户端同时激活扩展）→ 每个宿主各自拉起一个壳 |
| 修复 | 单例锁 `~/.branch-orbs/shell.lock`（`{pid, t}` + 5s 心跳）：<br>· 壳启动时查锁，已有活壳则**直接退出**；<br>· 扩展侧 `ensureShell` 查到活锁则**复用**（adopted，不 spawn、不接管 IPC）；<br>· 守护定时器每 1.5s 核对，属主消失才接手 spawn |

---

## 9. ⭐ 终极根因：目标 VSCode 跑成了 native Wayland

| 项 | 内容 |
| --- | --- |
| 症状 | `xwin.py list` 里**根本没有**那个 VSCode 窗口，但进程明明在跑；VSCode 自己的日志显示 `window1` 已创建 |
| 判定 | ```ls -la /proc/<vscode-pid>/fd \| grep -oE "wayland[^\s]*\|X11-unix[^\s]*"``` <br>出现 `wayland-*` → 就是它；出现 `X11-unix` → 走的是 XWayland（正常） |
| 根因 | **Wayland 安全模型不允许一个客户端操作另一个客户端的窗口**。native Wayland 窗口由合成器直接管理，X11 世界完全看不见它 → 任何 `xwin`/`wmctrl`/`xdotool` 都无能为力 |
| 修复 | 强制目标跑 XWayland（见下） |

### 强制 X11 的三种方式

```bash
# ① 一次性启动（排查用）
DISPLAY=:0 ELECTRON_OZONE_PLATFORM_HINT=x11 \
  /usr/share/code/code --ozone-platform=x11 --new-window /path/to/repo

# ② 长效：用户级 desktop 覆盖（优先级高于 /usr/share/applications）
cp /usr/share/applications/com.microsoft.VSCode.desktop ~/.local/share/applications/
sed -i 's|^Exec=/usr/share/code/code|Exec=/usr/share/code/code --ozone-platform=x11|' \
  ~/.local/share/applications/com.microsoft.VSCode.desktop
update-desktop-database ~/.local/share/applications/

# ③ 全局环境变量（影响所有 Electron 应用）
# ~/.profile: export ELECTRON_OZONE_PLATFORM_HINT=x11
```

> 从 IDE 或脚本里拉起 GUI 进程时注意：若环境里有 `ELECTRON_RUN_AS_NODE`，
> `code` 会被当成纯 Node 执行并报 `bad option` —— 需要 `env -u ELECTRON_RUN_AS_NODE`。

---

## 10. 经验法则（写给下一个排查的人）

1. **日志「成功」≠ 实际生效**。`settled: true` 只代表状态轮询读到了目标值，
   不代表用户感知到了变化。用户说「没变化」时，先枚举 X 全树找窗口归属。
2. **hit-test 命中 ≠ DOM 命中**。主进程的坐标判定和页面的事件命中是两套口径，
   「点击没反应」要同时看 X 输入投递（`query_pointer` 的 `child`）和页面事件（埋点）。
3. **透明窗口的输入区 = 它的 Shape**。没有 `setInputRegion` 时，`setShape` 就是输入区，
   横向绝不能铺满全宽。
4. **去重只对幂等消息有意义**。动作类消息被去重，表现就是「点很多次偶尔生效」。
5. **进程卡死时它自己的定时器也停了**，所以自愈心跳必须由外部探测。
6. **拿不到窗口时先怀疑 Wayland**，别在 X11 匹配逻辑里反复打转。
7. `node --check` 只查语法。**涉及模块初始化顺序的问题，必须有「真实执行一次」的自检。**
