#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""X11 窗口控制：按标题片段找到 VSCode 窗口，切换 最小化/恢复。

用法：
  xwin.py list                 列出所有 Code 窗口（JSON 行）
  xwin.py toggle <标题片段>    隐藏的就激活恢复，可见的就最小化
  xwin.py activate <标题片段>  只恢复/置前
  xwin.py minimize <标题片段>  只最小化

为什么存在：VSCode 的扩展宿主里没有"取消最小化"的命令（只有 minimizeWindow，
恢复不了）；系统的 xdotool/wmctrl 在本机不存在。悬浮球壳进程是普通 Electron
应用，跑在 X 会话里，所以由它（或扩展）调用本脚本，用 EWMH 客户端消息
（_NET_ACTIVE_WINDOW / WM_CHANGE_STATE）控制窗口状态 —— 纯 python-xlib，无
其他依赖。

匹配规则：WM_CLASS 含 "code"（不区分大小写）且 标题含 <标题片段>。
VSCode 窗口标题默认是 "<文件/文件夹名> - Visual Studio Code"，
所以传仓库名（= 文件夹名）即可命中对应窗口。
"""
import json
import os
import sys

from Xlib import X, Xutil, protocol, display

DISPLAY = os.environ.get("DISPLAY", ":0")


def connect():
    """连不上 X 显示时返回 None（调用方统一按 'no-display' 处理）。
    常见于：SSH 无转发、Wayland-only 会话、容器里 DISPLAY 指向已死的 X。"""
    try:
        return display.Display(DISPLAY)
    except Exception:
        return None


def client_windows(d):
    """通过 _NET_CLIENT_LIST 拿所有受管窗口（比递归遍历树快且准）。"""
    root = d.screen().root
    prop = root.get_full_property(d.intern_atom("_NET_CLIENT_LIST"), X.AnyPropertyType)
    if not prop or not prop.value:
        return []
    return [d.create_resource_object("window", wid) for wid in prop.value]


def window_title(d, w):
    for name_atom in ("_NET_WM_NAME", "WM_NAME"):
        try:
            p = w.get_full_property(d.intern_atom(name_atom), X.AnyPropertyType)
        except Exception:
            p = None
        if p and p.value:
            v = p.value
            try:
                return bytes(v).decode("utf-8", "replace")
            except Exception:
                return str(v)
    return ""


def window_class(d, w):
    try:
        cls = w.get_wm_class()
        if cls:
            return " ".join(cls)
    except Exception:
        pass
    return ""


def is_hidden(d, w):
    p = w.get_full_property(d.intern_atom("_NET_WM_STATE"), X.AnyPropertyType)
    if not p or not p.value:
        return False
    return d.intern_atom("_NET_WM_STATE_HIDDEN") in p.value


def send_root_message(d, w, client_type, values):
    root = d.screen().root
    ev = protocol.event.ClientMessage(window=w, client_type=client_type, data=(32, values))
    root.send_event(ev, event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask)
    d.flush()


def activate(d, w):
    # source indication=1 (pager), timestamp 0（多数 WM 接受），当前活动窗口 0
    send_root_message(d, w, d.intern_atom("_NET_ACTIVE_WINDOW"), [1, 0, 0, 0, 0])


def minimize(d, w):
    # ICCCM XIconifyWindow 等价：WM_CHANGE_STATE -> IconicState
    send_root_message(d, w, d.intern_atom("WM_CHANGE_STATE"), [Xutil.IconicState, 0, 0, 0, 0])


def match(d, sub):
    """返回 (class 含 code 且标题含 sub) 的窗口列表"""
    sub = (sub or "").lower()
    out = []
    for w in client_windows(d):
        cls = window_class(d, w).lower()
        if "code" not in cls:
            continue
        title = window_title(d, w)
        if sub and sub not in title.lower():
            continue
        out.append((w, title))
    return out


def main():
    args = sys.argv[1:]
    cmd = args[0] if args else "list"
    sub = args[1] if len(args) > 1 else ""
    d = connect()
    if d is None:
        # 必须返回 0：无显示环境是"功能不可用"，不是"执行出错"。
        # 返回非零会让调用方把"无法控窗"误判成脚本崩溃。
        print(json.dumps({"ok": False, "error": "no-display", "display": DISPLAY}, ensure_ascii=False))
        return 0

    if cmd == "list":
        for w in client_windows(d):
            cls = window_class(d, w)
            if "code" not in cls.lower():
                continue
            print(json.dumps({"title": window_title(d, w), "hidden": is_hidden(d, w)}, ensure_ascii=False))
        return 0

    hits = match(d, sub)
    if not hits:
        # 注意：这里必须返回 0。命中不到窗口是**正常情况**（比如工程还没
        # 加载完、标题还没带上文件夹名），不是脚本执行失败。
        # 返回非零会让 execFile 走进 error 分支，调用方就分不清
        # "窗口没找到" 和 "python 崩了"。
        print(json.dumps({"ok": False, "error": "no-matching-window", "sub": sub}, ensure_ascii=False))
        return 0

    changed = 0
    for w, title in hits:
        hidden = is_hidden(d, w)
        if cmd == "toggle":
            if hidden:
                activate(d, w)
            else:
                minimize(d, w)
            changed += 1
        elif cmd == "activate":
            if hidden:
                activate(d, w)
            changed += 1
        elif cmd == "minimize":
            if not hidden:
                minimize(d, w)
            changed += 1
    print(json.dumps({"ok": True, "cmd": cmd, "changed": changed, "hits": len(hits)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
