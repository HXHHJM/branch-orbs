#!/usr/bin/env python3
"""读 EWMH 工作区 —— 给壳进程当 workArea 的可信来源。

Electron 的 screen.workArea 在 XWayland 下返回整屏（1920x1080），
但 mutter 其实设了 _NET_WORKAREA = [0, 31, 1920, 987]。
两者差 31px 顶栏 + 缩放，足以让球"跑到屏幕中上部"。

用法（壳进程通过 execFileSync 调用）：
  python3 workarea.py
输出（stdout 一行 JSON）：
  {"ok":true,"x":0,"y":31,"width":1920,"height":987,"source":"_NET_WORKAREA"}
失败时：
  {"ok":false,"error":"..."}
"""
import os
import json
import sys

try:
    from Xlib import X, display
except Exception as e:  # 没装 python-xlib 也不能让壳崩
    print(json.dumps({"ok": False, "error": "no-xlib: %s" % e}))
    sys.exit(0)


def main():
    disp = os.environ.get("DISPLAY", ":0")
    try:
        d = display.Display(disp)
    except Exception as e:
        print(json.dumps({"ok": False, "error": "connect: %s" % e}))
        return

    root = d.screen().root
    try:
        prop = root.get_full_property(d.intern_atom("_NET_WORKAREA"), X.AnyPropertyType)
    except Exception as e:
        print(json.dumps({"ok": False, "error": "prop: %s" % e}))
        return

    if not prop or len(prop.value) < 4:
        print(json.dumps({"ok": False, "error": "no-_NET_WORKAREA"}))
        return

    # _NET_WORKAREA 是 CARDINAL[4*n]，每个虚拟桌面一组 (x, y, w, h)。
    # 用当前桌面 _NET_CURRENT_DESKTOP 索引，别总取第 0 组 ——
    # 多桌面时第 0 组可能是另一个显示器的。
    vals = list(prop.value)
    cur = 0
    try:
        cd = root.get_full_property(d.intern_atom("_NET_CURRENT_DESKTOP"), X.AnyPropertyType)
        if cd and cd.value:
            cur = int(cd.value[0])
    except Exception:
        pass
    off = cur * 4
    if off + 4 > len(vals):
        off = 0
    x, y, w, h = vals[off:off + 4]

    # 明显不合理的值（0 尺寸）就报失败，让调用方退回 Electron 的 workArea
    if w <= 0 or h <= 0:
        print(json.dumps({"ok": False, "error": "bad-geometry"}))
        return

    print(json.dumps({
        "ok": True, "x": x, "y": y, "width": w, "height": h,
        "desktop": cur, "source": "_NET_WORKAREA",
    }))


main()
