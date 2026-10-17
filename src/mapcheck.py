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


_DISP = None


def get_display():
    """进程内复用同一个 X 连接。

    ⚠ 踩过：list_clients_xlib 与 xlib_detail 各自 display.Display() 一次，
      第二个连接在部分环境会建不起来（返回 None），于是
      "clients 里有自己的窗口，ownWindows 却是 0" —— 两个函数互相打脸。
      共用一个连接就没有这个窗口期问题。
    """
    global _DISP
    if _DISP is not None:
        return _DISP
    try:
        from Xlib import display
        _DISP = display.Display(os.environ.get("DISPLAY", ":0"))
    except Exception:
        _DISP = None
    return _DISP


def list_clients_xlib():
    """返回 [(win_id, pid, (x,y,w,h), map_state)]；不可用返回 None。

    注意：这里遍历的是**整棵窗口树**，未映射窗口也会被收进来。
    调用方按 map_state 过滤。之所以不用 _NET_CLIENT_LIST，
    是因为那个列表在 GNOME/XWayland 下只收 NORMAL 类型的窗口。
    """
    try:
        from Xlib import X
    except Exception:
        return None
    d = get_display()
    if d is None:
        return None
    root = d.screen().root
    out = []
    pid_atom = d.intern_atom("_NET_WM_PID")

    def walk(w, dep=0):
        # ⚠ 用 dep 上限保护递归深度，但**不能 return 掉 for 循环**
        #   （首版写法是 `if dep > 4: return`，它会让同层后续兄弟节点被跳过，
        #    于是 gnome-shell 的窗口在客户端列表里出现、在 ownWindows 里却是 0）。
        if dep > 5:
            return
        try:
            children = w.query_tree().children
        except Exception:
            return
        for c in children:
            try:
                pm = c.get_full_property(pid_atom, X.AnyPropertyType)
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
    """给出**每个**窗口的详细状态（含未映射的、含 override_redirect）。

    为什么不能只看 _NET_CLIENT_LIST：它只收 mutter 愿意托管的窗口
    （GNOME/XWayland 下基本只收 NORMAL 类型），所以"不在里面"既可能是
    "窗口没创建"，也可能是"创建了但没登记/没 map"，处置完全不同。

    ⚠ 复用一个 Display 连接，不要跟 list_clients_xlib 各连一次：
      两次快照之间窗口状态可能变化，对不上就会得出自相矛盾的结论
      （实测发生过：clients 里有 gnome-shell 的窗口，ownWindows 却是 0）。
    """
    try:
        from Xlib import X
    except Exception:
        return None
    d = get_display()
    if d is None:
        return None
    root = d.screen().root
    pid_atom = d.intern_atom("_NET_WM_PID")
    acc = []
    # ⚠ 不能写裸 `except: pass`：本轮就因为它把一个
    #   "at.depth 抛 AttributeError" 的 bug 藏了整整一轮排查，
    #   表现只是"列表空空"，看起来像"没有窗口"。
    #   现在把跳过的窗口数和第一个错误记下来，一起输出。
    skipped = []

    def walk(w, dep=0):
        if dep > 5:
            return
        try:
            children = w.query_tree().children
        except Exception as e:
            skipped.append("tree:" + type(e).__name__)
            return
        for c in children:
            try:
                pm = c.get_full_property(pid_atom, X.AnyPropertyType)
                pid = int(pm.value[0]) if pm and pm.value else None
                g = c.get_geometry()
                at = c.get_attributes()
                # ⚠ WindowAttributes 没有 .depth！写 at.depth 会抛 AttributeError，
                #   而 except: pass 会把它静默吞掉 —— 表现是
                #   "xlib_detail() 永远返回空列表"，被误读成"没有窗口"。
                #   深度要从 geometry 取（get_geometry 才有 depth）。
                acc.append({
                    "id": hex(c.id),
                    "pid": pid,
                    "map_state": at.map_state,       # 0=未映射 1=IsUnmapped 2=IsViewable
                    "override_redirect": bool(at.override_redirect),
                    "depth": getattr(g, "depth", None),
                    "geom": [g.x, g.y, g.width, g.height],
                })
            except Exception as e:
                if len(skipped) < 5:
                    skipped.append(hex(c.id) + ":" + type(e).__name__)
            walk(c, dep + 1)

    walk(root)
    xlib_detail.last_skipped = skipped
    return acc


xlib_detail.last_skipped = []


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
        if via == "xlib":
            # 关键：xlib 路径下 clients 本来就是**整棵树**（含未映射窗口），
            # 直接在这里分出"属于本进程的所有窗口"，不必再走一遍。
            # ⚠ 但要补上 override_redirect/depth 这些只有 attributes 才有的字段，
            #   所以仍调 xlib_detail() 一次（开销可忽略，只在启动时跑）。
            tree = xlib_detail()
            if tree is not None:
                own = [w for w in tree if w.get("pid") == want]
                res["ownWindows"] = own[:6]
                res["ownCount"] = len(own)
                res["ownViewable"] = sum(1 for w in own if w.get("map_state") == 2)
                res["env"] = wm_env()
        emit(res)

    emit({"ok": False, "error": "no-xlib-and-no-xprop"})


main()
