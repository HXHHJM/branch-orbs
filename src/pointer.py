#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""X11 指针位置常驻读取器。

用法：
  pointer.py           常驻模式：读 stdin 的一行（任意内容）→ 回一行 JSON 到 stdout
  pointer.py once      一次性：打印一行 JSON 就退出
  pointer.py selftest  本机自检

输出（单行 JSON）：
  {"ok": true, "x": 831, "y": 872, "phys": true}
  {"ok": false, "error": "..."}

──────────────────────── 为什么需要这个脚本 ────────────────────────
Electron 的 `screen.getCursorScreenPoint()` 在 **XWayland 会话下读不到外部
指针移动**。实测（同一台机器，ozone=x11 的 Electron 43.7.7）：

    X 侧 query_pointer  → 700,500      （XTEST 搬过去的）
    Electron EPTR       → 345,259      （纹丝不动，永远这个值）
    再搬到 400,300
    X 侧 query_pointer  → 400,300
    Electron EPTR       → 345,259      （还是不变）

原因：Electron 在 Wayland 显示栈下拿的是**合成器侧的指针状态**，
而 XTEST / 真实鼠标事件在 XWayland 的 X 输入域里；两套状态在这个会话组合下
不同步。于是"轮询光标判断悬停"这条路彻底失效：
窗口在、球画出来了、日志干净，但鼠标压上去毫无反应。

所以指针位置必须从 **X 侧**读：XQueryPointer 拿到的才是真实位置。

──────────────────────── 为什么是常驻进程 ────────────────────────
悬停判定 30fps，每帧 fork 一次 python（~35ms 启动 + import Xlib）
比轮询周期还长，主进程会被拖死。所以做成常驻：
主进程往 stdin 写一个字节，脚本回一行 JSON，往返 < 1ms。

⚠ 退出与容错：
  · stdin EOF（父进程走了）→ 立刻退出，不留孤儿进程
  · 任何异常都回 {"ok": false}，绝不把 traceback 写到 stdout
    （stdout 是协议通道，脏一行就全乱）
"""

import json
import os
import sys


def _connect(display_name=None):
    from Xlib import display as _d
    name = display_name or os.environ.get("DISPLAY", ":0")
    return _d.Display(name)


def _query(d):
    """XQueryPointer。返回 X 根窗口坐标（物理像素）。"""
    root = d.screen().root
    q = root.query_pointer()
    return int(q.root_x), int(q.root_y)


def main(argv):
    mode = (argv[1] if len(argv) > 1 else "").strip()

    if mode == "selftest":
        return selftest()

    try:
        d = _connect()
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": "connect: %s: %s" % (type(e).__name__, e)}))
        return 1

    if mode == "once":
        try:
            x, y = _query(d)
            print(json.dumps({"ok": True, "x": x, "y": y, "phys": True}))
            return 0
        except Exception as e:  # noqa: BLE001
            print(json.dumps({"ok": False, "error": "%s: %s" % (type(e).__name__, e)}))
            return 1

    # ── 常驻模式 ──
    # 每读到一行就回一行。用 readline 阻塞读，不轮询 CPU。
    out = sys.stdout
    while True:
        try:
            line = sys.stdin.readline()
        except Exception:  # noqa: BLE001
            break
        if not line:
            break  # EOF：父进程没了
        try:
            x, y = _query(d)
            out.write(json.dumps({"ok": True, "x": x, "y": y, "phys": True}) + "\n")
        except Exception as e:  # noqa: BLE001
            out.write(json.dumps({"ok": False, "error": "%s: %s" % (type(e).__name__, e)}) + "\n")
        try:
            out.flush()
        except Exception:  # noqa: BLE001
            break
    return 0


def selftest():
    ok_all = True

    def ok(name, cond, detail=""):
        nonlocal ok_all
        print(("PASS  " if cond else "FAIL  ") + name + ("  " + str(detail) if detail else ""))
        if not cond:
            ok_all = False

    try:
        d = _connect()
    except Exception as e:  # noqa: BLE001
        ok("能连上 X 显示", False, "%s: %s" % (type(e).__name__, e))
        print("\n自检失败：连不上 X，后续项全部跳过")
        return 1

    ok("能连上 X 显示", True, os.environ.get("DISPLAY", ":0"))

    try:
        x, y = _query(d)
        ok("query_pointer 返回整数坐标", isinstance(x, int) and isinstance(y, int), (x, y))
        scr = d.screen()
        ok("坐标落在屏幕范围内",
           -1 <= x <= scr.width_in_pixels and -1 <= y <= scr.height_in_pixels,
           {"x": x, "y": y, "screen": [scr.width_in_pixels, scr.height_in_pixels]})
    except Exception as e:  # noqa: BLE001
        ok("query_pointer 可用", False, "%s: %s" % (type(e).__name__, e))

    # 常驻模式协议：写一行 → 读一行
    import subprocess
    try:
        p = subprocess.Popen(
            [sys.executable, os.path.abspath(__file__)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=dict(os.environ),
        )
        p.stdin.write(b"ping\n")
        p.stdin.flush()
        line = p.stdout.readline().decode("utf-8", "replace").strip()
        r = json.loads(line)
        ok("常驻模式：一次往返能拿到 JSON", r.get("ok") is True and "x" in r, r)
        # 连发三次，确认不是只回一次
        got = 0
        for _ in range(3):
            p.stdin.write(b"ping\n")
            p.stdin.flush()
            if json.loads(p.stdout.readline().decode("utf-8", "replace").strip()).get("ok"):
                got += 1
        ok("常驻模式：连续 3 次都能回", got == 3, {"got": got})
        p.stdin.close()
        code = p.wait(timeout=5)
        ok("stdin EOF 后进程自行退出（不留孤儿）", code == 0, {"exit": code})
    except Exception as e:  # noqa: BLE001
        ok("常驻模式可用", False, "%s: %s" % (type(e).__name__, e))

    print("\n自检%s" % ("全部通过" if ok_all else "有失败项"))
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
