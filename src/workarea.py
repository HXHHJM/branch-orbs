#!/usr/bin/env python3
"""读 EWMH 工作区 —— 给壳进程当 workArea 的可信来源。

Electron 的 screen.workArea 在 XWayland 下返回整屏（1920x1080），
但 mutter 其实设了 _NET_WORKAREA = [0, 31, 1920, 987]。
两者差 31px 顶栏，足以让球"跑到屏幕中上部"。

两条读取路径（按可靠性排序，都不需要额外装包就能跑）：

  ① python-xlib（最准，能顺带读 _NET_CURRENT_DESKTOP 选对桌面组）
  ② xprop（/usr/bin/xprop，几乎所有 X 环境自带）
     ⚠ 这条路径是本轮踩坑后补的：壳进程首版只试 python3，
       而系统 python3 没装 Xlib，日志刷 "no-xlib: No module named 'Xlib'"
       然后退回 Electron 的整屏值 —— 等于没修。
       Xlib 装不装是环境运气，xprop 基本一定有。
  ③ 都不可用 → 输出 ok:false，让调用方退回 Electron 的 workArea

用法：python3 workarea.py
输出（stdout 一行 JSON）：
  {"ok":true,"x":0,"y":31,"width":1920,"height":987,"source":"_NET_WORKAREA","via":"xlib"}
"""
import json
import os
import shutil
import subprocess
import sys


def emit(obj):
    print(json.dumps(obj))
    sys.exit(0)


def from_xlib():
    """返回 (vals, desktop) 或 None。vals 是 4 的倍数长度的列表。"""
    try:
        from Xlib import X, display
    except Exception:
        return None
    try:
        d = display.Display(os.environ.get("DISPLAY", ":0"))
    except Exception:
        return None
    root = d.screen().root
    try:
        prop = root.get_full_property(d.intern_atom("_NET_WORKAREA"), X.AnyPropertyType)
    except Exception:
        return None
    if not prop or len(prop.value) < 4:
        return None
    vals = [int(v) for v in prop.value]
    cur = 0
    try:
        cd = root.get_full_property(d.intern_atom("_NET_CURRENT_DESKTOP"), X.AnyPropertyType)
        if cd and cd.value:
            cur = int(cd.value[0])
    except Exception:
        pass
    return vals, cur


def xprop_prop(name):
    """xprop 读一个 root 属性，返回 int 列表（读不到返回 []）。"""
    exe = shutil.which("xprop") or "/usr/bin/xprop"
    if not os.path.exists(exe):
        return []
    try:
        out = subprocess.run([exe, "-root", name], capture_output=True, text=True, timeout=4)
    except Exception:
        return []
    if out.returncode != 0 or "=" not in out.stdout:
        return []
    raw = out.stdout.split("=", 1)[1].replace("\n", " ").strip()
    nums = []
    for part in raw.split(","):
        part = part.strip()
        if part.lstrip("-").isdigit():
            nums.append(int(part))
    return nums


def from_xprop():
    vals = xprop_prop("_NET_WORKAREA")
    if len(vals) < 4:
        return None
    cur = xprop_prop("_NET_CURRENT_DESKTOP")
    return vals, (cur[0] if cur else 0)


def main():
    got = from_xlib()
    via = "xlib"
    if not got:
        got = from_xprop()
        via = "xprop"
    if not got:
        emit({"ok": False, "error": "no-_NET_WORKAREA"})

    vals, cur = got
    # _NET_WORKAREA 是 CARDINAL[4*n]，每个虚拟桌面一组 (x, y, w, h)。
    # 用当前桌面索引，别总取第 0 组 —— 多桌面时第 0 组可能是另一个显示器的。
    off = cur * 4
    if off + 4 > len(vals):
        off = 0
    x, y, w, h = vals[off:off + 4]

    if w <= 0 or h <= 0:
        emit({"ok": False, "error": "bad-geometry", "raw": vals[:4]})

    emit({
        "ok": True, "x": x, "y": y, "width": w, "height": h,
        "desktop": cur, "source": "_NET_WORKAREA", "via": via,
    })


main()
