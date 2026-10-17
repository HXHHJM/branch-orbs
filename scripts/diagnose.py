#!/usr/bin/env python3
"""诊断你的桌面能不能显示 branch-orbs 的悬浮球。

用法（在能看见桌面的终端里跑，不要 sudo）：
    python3 scripts/diagnose.py

它会依次检查 6 件事，每件都给"能不能过"和"不过该怎么办"：
  1. 会话类型 / DISPLAY
  2. 窗口管理器（mutter/kwin/...）在不在
  3. 合成器（_NET_WM_CM_S0）在不在 —— 决定透明窗口能不能用
  4. 屏幕与工作区几何
  5. XWayland 下"未映射窗口"的普遍程度（判断是否环境性问题）
  6. 能不能创建并映射一个最小窗口（**决定性证据**）

为什么需要 6：前 5 项都正常、窗口仍然不出现的情况真实存在
（见 boot.log 里 NOT_MAPPED 但 page probe / 像素体检都正常）。
第 6 项直接用 python-xlib 建一个 override_redirect 小窗并 map 它，
如果连这个都失败，说明是 X 侧环境问题，跟 Electron/插件无关。
"""
import json
import os
import shutil
import subprocess
import sys

OK = "  ✅"
NO = "  ❌"
WARN = "  ⚠️ "
INFO = "  ·"

problems = []


def head(t):
    print("\n" + t)
    print("-" * max(20, len(t)))


def run(cmd, timeout=8):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except Exception as e:
        return type("R", (), {"returncode": -1, "stdout": "", "stderr": str(e)})()


# ── 1 会话 ────────────────────────────────────────────────────────────────
head("1. 会话类型")
print(INFO, "XDG_SESSION_TYPE =", os.environ.get("XDG_SESSION_TYPE", "(未设)"))
print(INFO, "DISPLAY          =", os.environ.get("DISPLAY", "(未设)"))
print(INFO, "WAYLAND_DISPLAY  =", os.environ.get("WAYLAND_DISPLAY", "(未设)"))
print(INFO, "XDG_CURRENT_DESKTOP =", os.environ.get("XDG_CURRENT_DESKTOP", "(未设)"))
if not os.environ.get("DISPLAY"):
    print(NO, "没有 DISPLAY —— X 程序无法显示任何窗口")
    problems.append("没有 DISPLAY")
else:
    print(OK, "有 DISPLAY")

# ── 2 窗口管理器 ──────────────────────────────────────────────────────────
head("2. 窗口管理器")
if shutil.which("xprop"):
    r = run(["xprop", "-root", "_NET_SUPPORTING_WM_CHECK"])
    ids = [t for t in r.stdout.replace("\n", " ").split() if t.startswith("0x")]
    if ids:
        n = run(["xprop", "-id", ids[0], "_NET_WM_NAME"])
        name = n.stdout.split("=", 1)[-1].strip().strip('"') if "=" in n.stdout else "?"
        print(OK, "窗口管理器:", name)
    else:
        print(NO, "_NET_SUPPORTING_WM_CHECK 不存在 —— 没有窗口管理器")
        print("     ", "没有 WM 的话，任何窗口都不会被摆放/映射。")
        problems.append("没有窗口管理器")
else:
    print(WARN, "没有 xprop，跳过")

# ── 3 合成器 ──────────────────────────────────────────────────────────────
head("3. 合成器（决定透明窗口能不能用）")
if shutil.which("xprop"):
    r = run(["xprop", "-root", "_NET_WM_CM_S0"])
    txt = r.stdout.strip()
    has = "=" in txt and "not found" not in txt
    if has:
        print(OK, "有合成器，透明窗口可用（球可以真正悬浮）")
    else:
        print(WARN, "没有 _NET_WM_CM_S0（通常只代表 XWayland 侧没有，属正常）")
        print("     ", "插件会自动降级为不透明窗口（球贴在小深色条上）")
else:
    print(WARN, "没有 xprop，跳过")

# ── 4 几何 ────────────────────────────────────────────────────────────────
head("4. 屏幕与工作区")
try:
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
    wa = subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), "..", "src", "workarea.py")],
                        capture_output=True, text=True, timeout=10)
    j = json.loads(wa.stdout.strip().splitlines()[-1])
    if j.get("ok"):
        print(OK, "工作区: %dx%d @ %d,%d（via %s）" %
              (j["width"], j["height"], j["x"], j["y"], j.get("via")))
        if j["height"] < 200:
            print(NO, "工作区高度异常小，窗口放不下")
            problems.append("工作区过小")
    else:
        print(WARN, "读不到工作区:", j.get("error"))
except Exception as e:
    print(WARN, "工作区检查失败:", e)

# ── 5 未映射窗口的普遍程度 ────────────────────────────────────────────────
head("5. 窗口树概况（判断是不是环境性问题）")
try:
    from Xlib import X, display
    d = display.Display(os.environ.get("DISPLAY", ":0"))
    root = d.screen().root
    tot = [0, 0, 0]

    def walk(w, dep=0):
        if dep > 5:
            return
        try:
            ch = w.query_tree().children
        except Exception:
            return
        for c in ch:
            try:
                st = c.get_attributes().map_state
                tot[st if st <= 2 else 0] += 1
            except Exception:
                pass
            walk(c, dep + 1)

    walk(root)
    print(INFO, "窗口总数 %d：已映射(IsViewable) %d，未映射 %d" % (sum(tot), tot[2], tot[0] + tot[1]))
    if tot[2] == 0:
        print(NO, "一个已映射的窗口都没有 —— 整个 X 会话的窗口都没上屏")
        problems.append("X 会话无任何已映射窗口")
    else:
        print(OK, "存在已映射窗口，X 显示链路是通的")
except ImportError:
    print(WARN, "没有 python-xlib，第 5/6 项跳过（可 pip install python-xlib）")
except Exception as e:
    print(WARN, "扫描失败:", e)

# ── 6 建一个最小窗口并 map（决定性） ──────────────────────────────────────
head("6. 能不能创建并映射一个窗口（决定性证据）")
try:
    from Xlib import X, display
    d = display.Display(os.environ.get("DISPLAY", ":0"))
    scr = d.screen()
    w = scr.root.create_window(60, 60, 120, 40, 0, scr.root_depth,
                               X.InputOutput, X.CopyFromParent,
                               background_pixel=scr.black_pixel,
                               override_redirect=1,
                               event_mask=X.ExposureMask)
    w.map()
    d.sync()
    st = w.get_attributes().map_state
    g = w.get_geometry()
    if st == 2:
        print(OK, "最小窗口已成功映射（%dx%d @ %d,%d）—— X 显示链路正常"
              % (g.width, g.height, g.x, g.y))
        print("     ", "如果插件仍然不显示，那是 Electron/插件层的问题，不是 X。")
    else:
        print(NO, "最小窗口创建成功但**没有被映射**（map_state=%d）" % st)
        print("     ", "这是 X 会话层面的问题：合成器/WM 拒绝映射新窗口。")
        print("     ", "通常重启会话（注销再登录）可恢复。")
        problems.append("X 无法映射新窗口")
    try:
        w.destroy()
        d.sync()
    except Exception:
        pass
except Exception as e:
    print(WARN, "第 6 项无法执行:", e)

# ── 结论 ──────────────────────────────────────────────────────────────────
head("结论")
if not problems:
    print(OK, "环境检查全部通过。")
    print("     ", "如果球仍然不出现，请把 boot.log 里这几行发出来：")
    print("     ", "  grep -E '合成器探测|X map 校验|X 窗口树自查|page probe|像素体检' \\")
    print("     ", "    ~/.config/Code/User/globalStorage/heyuying.branch-orbs/boot.log")
else:
    print(NO, "发现 %d 个问题：" % len(problems))
    for p in problems:
        print("     -", p)
    print()
    print("     ", "对策：注销当前会话再重新登录（不是关机重启）。")
    print("     ", "GNOME/Unity 会话有时会在长时间使用后丢失合成器或窗口映射能力，")
    print("     ", "重新登录会重建整个显示栈。")
sys.exit(0 if not problems else 1)
