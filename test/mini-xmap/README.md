# mini-xmap —— 最小复现：Electron 窗口能不能真的 map 到 X

这个目录**不是产品代码**，也不是自动测试。它是一次真实排查留下的最小复现工程，
把当时最难查的一个问题压缩成了 60 行。

## 它复现的是什么

「Electron 说窗口显示了，X 上却没有这个窗口」。

当时的所有 JS 层证据都是绿的：

```
createWindow {"x":0,"y":27,"width":1661,"height":854}     尺寸正确
after show: visible=true bounds={...}                      显示成功
did-finish-load url=file:///.../orbs.html                  页面加载完
page probe {"orbsDom":3,"dockRect":[778,831,106,30]}       球真的画出来了
```

但 X 侧一片空白：

```
X 窗口树自查: 属于本进程的窗口 0 []
X 屏幕上的窗口(10): [... 10 个窗口，没有一个是我们 ...]
```

根因不是几何、不是合成器、不是 shape —— 是 **ozone 平台选错了**：

```js
// main.js 顶层调用这个，**完全不生效**
app.commandLine.appendSwitch('ozone-platform', 'x11');
```

Ozone 平台在 `electron_main_delegate` 里就定死了，比 JS 入口更早。
必须作为**进程命令行参数**传进去。两者对比：

| 方式 | getNativeWindowHandle() | xwininfo 可见 |
|---|---|---|
| 仅 `appendSwitch` | `0x1`（非法占位） | ❌ |
| 命令行传 `--ozone-platform=x11` | `0x2400004` | ✅ 65x68 |

`handle === 0x1` 是判定「ozone 选错」最可靠的信号 —— 见 `shell/main.js`
里的 `realGeomFromX()`，它把这个判断做成了自动告警。

## 怎么用

需要单独一份 Electron 运行时（不能用 VSCode 自带的，它会强行加载自己的
`resources/app` 并把参数当工作区）：

```bash
env -u ELECTRON_RUN_AS_NODE TMPDIR=/var/tmp \
  /path/to/electron test/mini-xmap --no-sandbox
```

输出全走 stderr。可选环境变量：

| 变量 | 作用 |
|---|---|
| `MINI_MODE` | `normal` / `toolbar` / `dock` / `undecorated` —— 换窗口类型 |
| `MINI_W` `MINI_H` | 窗口尺寸，默认 48x50 |
| `MINI_OZONE` | `x11` / `wayland` —— 用来对比两种平台 |
| `MINI_TRANSPARENT` | 设为 `0` 关掉透明 |

跑起来之后，另开一个终端看 X 侧到底有没有它：

```bash
xwininfo -root -tree | grep -i mini
```

## 为什么留在仓库里

因为它验证的是一个**只能在真实 X 环境里验证**的假设，而且结论反直觉
（JS 层全绿、X 层全空）。以后再遇到「Electron 窗口看不见」，
先跑这个，三十秒就能排除或确认 ozone 这条线，
不用重新走一遍当时那几小时的弯路。
