#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""X11 窗口控制：找到 VSCode 窗口并切换 最小化/恢复。

用法：
  xwin.py list                      列出所有 Code 窗口（JSON 行）
  xwin.py toggle  <关键字...>       隐藏的就激活恢复，可见的就最小化
  xwin.py activate <关键字...>      只恢复/置前
  xwin.py minimize <关键字...>      只最小化
  xwin.py probe   <关键字...>       只报匹配结果，不动窗口（排查用）
  xwin.py selftest                  在本机 X 上做一轮 minimize→activate 往返验证

为什么存在：VSCode 的扩展宿主里没有"取消最小化"的命令（只有 minimizeWindow，
恢复不了）；系统的 xdotool/wmctrl 在本机不存在。悬浮球壳进程是普通 Electron
应用，跑在 X 会话里，所以由扩展调用本脚本，用 EWMH 客户端消息
（_NET_ACTIVE_WINDOW / WM_CHANGE_STATE）控制窗口状态 —— 纯 python-xlib。

── 匹配策略（按优先级，命中即停） ──
  1. PID　  窗口 _NET_WM_PID 与 --pid 给出的值一致 → 精确，最可靠
  2. 标题　 标题含关键字（不区分大小写）
  3. 类名　 WM_CLASS / WM_CLASS 的 instance 含关键字
关键字可以有多个，任一命中即算命中（OR）。这样即使仓库名和窗口标题
不一致（用户改了 title、SSH 远端、文件夹被重命名），也能用路径末段
或带路径的关键字兜住。

为什么不能只靠标题：VSCode 窗口标题可被用户改（window.title 设置）、
可能是 "SSH: xxx"、也可能在工程还没加载完时就是 "Visual Studio Code"。
上一轮就是栽在"标题不带工程名 → 一颗球都点不动"。

⚠ 本脚本**永远返回 0**。区分"执行失败"和"没命中/无显示"靠 JSON 的
   ok / error 字段 —— 返回非零会让调用方 execFile 走 error 分支，
   分不清"窗口没找到"和"python 崩了"。
"""
import json
import os
import sys
import time

from Xlib import X, Xutil, protocol, display

DISPLAY = os.environ.get("DISPLAY", ":0")


# ────────────────────────── 连接 ──────────────────────────
def connect(dpy=None):
    """连不上 X 显示时返回 None（调用方统一按 'no-display' 处理）。
    常见于：SSH 无转发、Wayland-only 会话、容器里 DISPLAY 指向已死的 X。"""
    try:
        return display.Display(dpy or DISPLAY)
    except Exception:
        return None


# ────────────────────────── 属性读取 ──────────────────────────
def get_prop(d, w, atom, default=None):
    try:
        p = w.get_full_property(d.intern_atom(atom), X.AnyPropertyType)
        return p.value if p else default
    except Exception:
        return default


def client_windows(d):
    """通过 _NET_CLIENT_LIST 拿所有受管窗口（比递归遍历树快且准）。"""
    ids = get_prop(d, d.screen().root, "_NET_CLIENT_LIST", [])
    return [d.create_resource_object("window", wid) for wid in (ids or [])]


def window_title(d, w):
    """_NET_WM_NAME（UTF-8）优先，退回 WM_NAME（可能是 latin-1）。"""
    v = get_prop(d, w, "_NET_WM_NAME")
    if v is None:
        v = get_prop(d, w, "WM_NAME")
    if not v:
        return ""
    try:
        return bytes(v).decode("utf-8", "replace")
    except Exception:
        return str(v)


def window_class(d, w):
    try:
        cls = w.get_wm_class()
        if cls:
            return " ".join(cls)
    except Exception:
        pass
    return ""


def window_pid(d, w):
    """_NET_WM_PID 是 CARDINAL，值为单个 int。"""
    v = get_prop(d, w, "_NET_WM_PID")
    if not v:
        return None
    try:
        return int(v[0])
    except Exception:
        return None


def state_atoms(d, w):
    """返回窗口 _NET_WM_STATE 里的原子名集合（用于判断 hidden / above 等）。"""
    raw = get_prop(d, w, "_NET_WM_STATE", []) or []
    out = set()
    for a in raw:
        try:
            out.add(d.get_atom_name(a))
        except Exception:
            pass
    return out


def is_hidden(d, w):
    """最小化后 WM 会给窗口加 _NET_WM_STATE_HIDDEN。
    ⚠ 部分 WM 有延迟（几十 ms），调用方需要"等一下再看"，见 wait_hidden()。"""
    return "_NET_WM_STATE_HIDDEN" in state_atoms(d, w)


# 各类 VSCode 衍生版的 WM_CLASS 关键字。
# ⚠ 不能只查 "code"：VSCodium 的类名是 "VSCodium"，里面没有 "code" 子串，
#   漏掉会让所有球都点不动，而报错信息只有 no-matching-window，极难定位。
CODE_CLASS_HINTS = ("code", "vscodium", "codium", "code-oss", "cursor", "windsurf")


def is_code_like(cls):
    """WM_CLASS 是否像 VSCode 系编辑器（含 VSCodium / Cursor / Code-OSS）。
    取 instance 或 class 任一段包含任一关键字（不区分大小写）即算。"""
    low = (cls or "").lower()
    return any(h in low for h in CODE_CLASS_HINTS)


# ─────────────────── 等待窗口状态稳定 ───────────────────
def wait_state(d, w, want_hidden, timeout=0.8):
    """发完客户端消息后等 WM 真正改变状态。
    WM 是异步的：send_event 只是"请求"，立刻读属性大概率还是旧值。
    上一轮"点一次有效、点两次失效"就是这个竞态。返回是否达成目标状态。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if is_hidden(d, w) == want_hidden:
            return True
        d.flush()
        time.sleep(0.03)
    return is_hidden(d, w) == want_hidden


# ────────────────────────── 动作 ──────────────────────────
def send_root_message(d, w, client_type, values):
    """EWMH 规定的标准做法：把 ClientMessage 发到 root，
    掩码 CONFIGURE 类的 SubstructureRedirect|SubstructureNotify，由 WM 接收。"""
    root = d.screen().root
    ev = protocol.event.ClientMessage(window=w, client_type=d.intern_atom(client_type), data=(32, values))
    root.send_event(ev, event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask)
    d.flush()


def activate(d, w):
    # source indication=1 (pager)，timestamp=0（多数 WM 接受），其余填 0
    send_root_message(d, w, "_NET_ACTIVE_WINDOW", [1, 0, 0, 0, 0])


def minimize(d, w):
    # ICCCM XIconifyWindow 等价：WM_CHANGE_STATE -> IconicState
    send_root_message(d, w, "WM_CHANGE_STATE", [Xutil.IconicState, 0, 0, 0, 0])


# ────────────────────────── 匹配 ──────────────────────────
def score(d, w, keywords, pid, require_code=True):
    """给窗口打分，0 = 不匹配。分数只用于排序与调试输出。
    优先级：PID 命中 > 标题命中 > 类名命中。"""
    cls = window_class(d, w)
    if require_code and not is_code_like(cls):
        return 0, {}
    title = window_title(d, w)
    wp = window_pid(d, w)

    if pid is not None and wp == pid:
        return 100, {"by": "pid"}

    for k in keywords:
        if k and k.lower() in title.lower():
            return 50, {"by": "title", "kw": k}
    for k in keywords:
        if k and k.lower() in cls.lower():
            return 30, {"by": "class", "kw": k}
    return 0, {"title": title, "cls": cls, "pid": wp}


def match(d, keywords, pid=None, require_code=True):
    """返回 [(window, title, score, how)]，按分数降序。
    有 pid 且命中时只返回那一批（精确优先，避免误伤同名仓库的其他窗口）。"""
    hits = []
    for w in client_windows(d):
        s, how = score(d, w, keywords, pid, require_code)
        if s > 0:
            hits.append((w, window_title(d, w), s, how))
    if not hits:
        return []
    best = max(h[2] for h in hits)
    if best >= 100:  # PID 精确命中：只动这些
        hits = [h for h in hits if h[2] >= 100]
    hits.sort(key=lambda h: -h[2])
    return hits


# ────────────────────────── 命令 ──────────────────────────
def parse_args(argv):
    """支持 --pid=123 / --pid 123 / --all-classes / 位置参数（关键字）。"""
    pid = None
    require_code = True
    keywords = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a.startswith("--pid="):
            pid = int(a.split("=", 1)[1] or 0) or None
        elif a == "--pid" and i + 1 < len(argv):
            i += 1
            pid = int(argv[i] or 0) or None
        elif a == "--all-classes":
            require_code = False
        elif not a.startswith("--"):
            keywords.append(a)
        i += 1
    return pid, require_code, keywords


def cmd_list(d, as_json=True):
    rows = []
    for w in client_windows(d):
        cls = window_class(d, w)
        if not is_code_like(cls):
            continue
        rows.append(
            {
                "title": window_title(d, w),
                "hidden": is_hidden(d, w),
                "pid": window_pid(d, w),
                "class": cls,
            }
        )
    return rows


def cmd_action(d, cmd, keywords, pid, require_code):
    hits = match(d, keywords, pid, require_code)
    if not hits:
        return {
            "ok": False,
            "error": "no-matching-window",
            "keywords": keywords,
            "pid": pid,
            "code_windows": [r["title"] for r in cmd_list(d)],
        }

    changed = 0
    detail = []
    for w, title, s, how in hits:
        hidden = is_hidden(d, w)
        if cmd == "toggle":
            want = not hidden
        elif cmd == "activate":
            want = False  # 目标：可见
        else:  # minimize
            want = True
        if hidden == want:
            detail.append({"title": title, "skip": "already", "hidden": hidden})
            continue
        if want:
            minimize(d, w)
            ok = wait_state(d, w, True)
        else:
            activate(d, w)
            ok = wait_state(d, w, False)
        changed += 1
        detail.append({"title": title, "to": "hidden" if want else "visible", "settled": ok, "by": how.get("by")})

    return {"ok": True, "cmd": cmd, "changed": changed, "hits": len(hits), "detail": detail}


def cmd_selftest(d):
    """在本机 X 上拿一个 Code 窗口做 minimize → activate 往返，
    验证 EWMH 消息真的被 WM 接受。没有 Code 窗口就报 skip。"""
    rows = cmd_list(d)
    if not rows:
        return {"ok": False, "error": "no-code-window", "hint": "先打开一个 VSCode 窗口再跑 selftest"}
    hits = match(d, [], None, True)
    if not hits:
        return {"ok": False, "error": "no-code-window"}
    w, title, _s, _how = hits[0]
    steps = []
    before = is_hidden(d, w)
    steps.append({"step": "initial", "hidden": before})

    minimize(d, w)
    got = wait_state(d, w, True)
    steps.append({"step": "minimize", "expect": True, "got": is_hidden(d, w), "settled": got})

    activate(d, w)
    got2 = wait_state(d, w, False)
    steps.append({"step": "activate", "expect": False, "got": is_hidden(d, w), "settled": got2})

    passed = all(s.get("settled", True) for s in steps[1:]) and steps[1]["got"] is True and steps[2]["got"] is False
    # 还原到初始状态
    if before:
        minimize(d, w)
        wait_state(d, w, True)
    return {"ok": True, "passed": passed, "title": title, "window": hex(w.id), "steps": steps}


def main():
    argv = sys.argv[1:]
    cmd = argv[0] if argv else "list"
    pid, require_code, keywords = parse_args(argv[1:] if argv else [])

    d = connect()
    if d is None:
        # 必须返回 0：无显示环境是"功能不可用"，不是"执行出错"。
        print(json.dumps({"ok": False, "error": "no-display", "display": DISPLAY}, ensure_ascii=False))
        return 0

    try:
        if cmd == "list":
            print(json.dumps({"ok": True, "windows": cmd_list(d)}, ensure_ascii=False))
        elif cmd == "probe":
            hits = match(d, keywords, pid, require_code)
            print(
                json.dumps(
                    {
                        "ok": bool(hits),
                        "keywords": keywords,
                        "pid": pid,
                        "hits": [{"title": t, "score": s, "how": h, "hidden": is_hidden(d, w)} for w, t, s, h in hits],
                        "all_code_windows": cmd_list(d),
                    },
                    ensure_ascii=False,
                )
            )
        elif cmd == "selftest":
            print(json.dumps(cmd_selftest(d), ensure_ascii=False))
        elif cmd in ("toggle", "activate", "minimize"):
            print(json.dumps(cmd_action(d, cmd, keywords, pid, require_code), ensure_ascii=False))
        else:
            print(json.dumps({"ok": False, "error": "unknown-command", "cmd": cmd}, ensure_ascii=False))
    finally:
        try:
            d.close()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
