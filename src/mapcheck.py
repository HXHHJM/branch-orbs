#!/usr/bin/env python3
"""检查"这个 PID 的窗口在 X 上到底 map 了没有"。

用途：壳进程 show 完窗口后 1.2s 反查一次。
     Electron 侧的证据会全部正常（isVisible()=true、DOM 里有球、
     did-finish-load 成功），但窗口可能**从未被 mutter map** ——
     屏幕上一片空白，而日志全是绿的。这是"球一直不出现"里最难查的一种。

两条路径（都不需要额外装包）：
  ① python-xlib：递归遍历窗口树，按 _NET_WM_PID 找自己
  ② xprop + xwininfo：没有 xlib 时用 xprop 逐个读 _NET_WM_PID
     ⚠ 这条路径是踩坑后补的：首版写死 `python3 -c`，
       而系统 python3 没装 Xlib，校验脚本自己就崩了，
       日志只有一句 "X map 校验失败(可忽略)"，等于白做。

用法：python3 mapcheck.py <pid>
输出（stdout 一行 JSON）：
  {"ok":true,"mapped":true,"windows":[[x,y,w,h]],"via":"xlib"}
  {"ok":true,"mapped":false,"windows":[],"via":"xprop"}
  {"ok":false,"error":"..."}   ← 两条路径都不可用
"""
import json
import os
import shutil
import subprocess
import sys


def emit(obj):
    print(json.dumps(obj))
    sys.exit(0)


def list_clients_xlib():
    """返回 [(win_id, pid, (x,y,w,h), map_state)]；不可用返回 None。"""
    try:
        from Xlib import X, display
    except Exception:
        return None
    try:
        d = display.Display(os.environ.get("DISPLAY", ":0"))
    except Exception:
        return None
    root = d.screen().root
    out = []

    def walk(w, dep=0):
        if dep > 4:
            return
        try:
            children = w.query_tree().children
        except Exception:
            return
        for c in children:
            try:
                pm = c.get_full_property(d.intern_atom("_NET_WM_PID"), X.AnyPropertyType)
                pid = int(pm.value[0]) if pm and pm.value else None
                g = c.get_geometry()
                st = c.get_attributes().map_state
                out.append((c.id, pid, (g.x, g.y, g.width, g.height), st))
            except Exception:
                pass
            walk(c, dep + 1)

    walk(root)
    return out


def xprop_value(name, wid=None):
    """读 xprop 的值部分，返回字符串；失败返回 None。

    ⚠ 两种输出格式，踩过一次：
        root 属性：  _NET_CLIENT_LIST(WINDOW): window id # 0xa00004, 0xa00005
        window 属性： _NET_WM_PID(CARDINAL) = 12345
       前者用**冒号**分隔、后面还带类型注解，只有后者是等号。
       首版一律 split("=") → root 那条永远解析不到 → 兜底路径静默失效。
    """
    xprop = shutil.which("xprop")
    if not xprop:
        return None
    cmd = [xprop, "-root", name] if wid is None else [xprop, "-id", wid, name]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
    except Exception:
        return None
    if r.returncode != 0:
        return None
    out = r.stdout.strip()
    if "not found" in out or "no such atom" in out.lower():
        return None
    if "=" in out:
        return out.split("=", 1)[1].strip()
    if ":" in out:
        return out.split(":", 1)[1].strip()
    return None


def xlib_detail():
    """除"在不在 client list"之外，再单独扫一遍窗口树，给出**每个**自己的窗口的
    详细状态。这一步是本轮排查的关键：

      _NET_CLIENT_LIST 只收**已映射**的窗口，所以"不在里面"既可能是
      "窗口没创建"，也可能是"创建了但 map 失败"。两者处置完全不同，
      只看 NOT_MAPPED 永远分不清，就会一直在错的方向上改代码。

    返回 {"clients": [...]|None, "mine": [{id,state,override,geom,attrs...}]}
    """
    try:
        from Xlib import X, display
    except Exception:
        return None
    try:
        d = display.Display(os.environ.get("DISPLAY", ":0"))
    except Exception:
        return None
    root = d.screen().root

    def walk(w, dep=0, acc=None):
        acc = acc if acc is not None else []
        if dep > 5:
            return acc
        try:
            children = w.query_tree().children
        except Exception:
            return acc
        for c in children:
            try:
                pm = c.get_full_property(d.intern_atom("_NET_WM_PID"), X.AnyPropertyType)
                pid = int(pm.value[0]) if pm and pm.value else None
                g = c.get_geometry()
                at = c.get_attributes()
                acc.append({
                    "id": hex(c.id),
                    "pid": pid,
                    "map_state": at.map_state,       # 0=未映射 1=IsUnmapped 2=IsViewable
                    "override_redirect": bool(at.override_redirect),
                    "depth": at.depth,
                    "geom": [g.x, g.y, g.width, g.height],
                })
            except Exception:
                pass
            walk(c, dep + 1, acc)
        return acc

    return walk(root)


def wm_env():
    """把"为什么映射不上"的环境前提一并抓出来，避免下次又靠猜。

    合成器（_NET_WM_CM_S0）是 transparent 窗口的前提：
    根窗口没有合成器时，ARGB 窗口在 X 上无法正常 present，
    表现就是 **窗口创建成功、map 失败、像素却已经渲染好**。
    """
    out = {}
    try:
        xt = shutil.which("xprop")
        if not xt:
            return out
        r = subprocess.run([xt, "-root", "_NET_WM_CM_S0"], capture_output=True,
                           text=True, timeout=5)
        out["compositor"] = "not found" not in r.stdout and "=" in r.stdout
        r2 = subprocess.run([xt, "-root", "_NET_SUPPORTING_WM_CHECK"], capture_output=True,
                            text=True, timeout=5)
        out["wm_present"] = "=" in r2.stdout or "#" in r2.stdout
    except Exception:
        pass
    return out


def list_clients_xprop():
    """用 xprop/xwininfo 枚举 _NET_CLIENT_LIST 并读 PID；不可用返回 None。"""
    xwininfo = shutil.which("xwininfo")
    if not xwininfo:
        return None
    raw = xprop_value("_NET_CLIENT_LIST")
    if raw is None:
        # 少数 WM 不设 _NET_CLIENT_LIST，退回 _NET_CLIENT_LIST_STACKING
        raw = xprop_value("_NET_CLIENT_LIST_STACKING")
    if raw is None:
        return None
    ids = []
    for tok in raw.replace("\n", " ").replace("#", "").split(","):
        tok = tok.strip()
        # 形如 "window id # 0xa00004" 的第一项、或纯 "0xa00005"
        if "window id" in tok:
            tok = tok.split("window id")[-1].strip()
        if tok.split() and tok.split()[-1].startswith("0x"):
            tok = tok.split()[-1]
        if tok.startswith("0x"):
            try:
                int(tok, 16)
            except ValueError:
                continue
            ids.append(tok)

    out = []
    for wid in ids:
        try:
            pid = None
            pv = xprop_value("_NET_WM_PID", wid)
            if pv is not None:
                # "_NET_WM_PID(CARDINAL) = 12345" 已在 xprop_value 里切掉前缀
                digits = "".join(ch for ch in pv.split()[0] if ch.isdigit()) if pv.split() else ""
                if digits:
                    pid = int(digits)
            # map 状态：xwininfo 里 "Map State: IsViewable"
            ir = subprocess.run([xwininfo, "-id", wid], capture_output=True, text=True, timeout=4)
            st = 2 if "IsViewable" in ir.stdout else 0
            geom = (0, 0, 0, 0)
            for line in ir.stdout.splitlines():
                s = line.strip()
                if s.startswith("Absolute upper-left X:"):
                    geom = (int(s.split(":")[1]), geom[1], geom[2], geom[3])
                elif s.startswith("Absolute upper-left Y:"):
                    geom = (geom[0], int(s.split(":")[1]), geom[2], geom[3])
                elif s.startswith("Width:"):
                    geom = (geom[0], geom[1], int(s.split(":")[1]), geom[3])
                elif s.startswith("Height:"):
                    geom = (geom[0], geom[1], geom[2], int(s.split(":")[1]))
            out.append((int(wid, 16), pid, geom, st))
        except Exception:
            continue
    return out


def main():
    if len(sys.argv) < 2:
        emit({"ok": False, "error": "usage: mapcheck.py <pid>"})
    try:
        want = int(sys.argv[1])
    except ValueError:
        emit({"ok": False, "error": "bad-pid"})

    for via, fn in (("xlib", list_clients_xlib), ("xprop", list_clients_xprop)):
        clients = fn()
        if clients is None:
            continue
        mine = [(wid, g) for (wid, pid, g, st) in clients if pid == want and st == 2]
        res = {
            "ok": True,
            "mapped": bool(mine),
            "count": len(mine),
            "windows": [list(g) for _w, g in mine][:3],
            "via": via,
            "scanned": len(clients),
        }
        # 详细树扫描：只走得到 xlib 时做一次，用来说明"未映射"到底是哪种
        # —— 窗口根本没创建 / 创建了但 map_state != IsViewable。
        if via == "xlib":
            tree = xlib_detail()
            if tree is not None:
                own = [w for w in tree if w.get("pid") == want]
                res["ownWindows"] = own[:6]
                res["ownCount"] = len(own)
                res["env"] = wm_env()
        emit(res)

    emit({"ok": False, "error": "no-xlib-and-no-xprop"})


main()
