#!/usr/bin/env python3
"""workarea.py 的自检：三层，和 xwin-selftest.py 同一套路子。

L1 纯逻辑：JSON 输出格式、失败路径不抛异常
L2 真 X：能连上 X 就读 _NET_WORKAREA，读到的值必须落在屏幕内
L3 一致性：与 xprop 的输出交叉验证（有 xprop 才做）

为什么值得单独自检：workArea 错了的表现是"球跑到奇怪的地方"，
而日志里一切正常（createWindow 尺寸看着对）。没有断言就只能靠肉眼。
"""
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "src", "workarea.py")
PY = sys.executable

results = []


def ok(name, cond, extra=None):
    results.append({"name": name, "pass": bool(cond), "extra": extra})
    print(("PASS  " if cond else "FAIL  ") + name + ("" if extra is None else "   " + json.dumps(extra, ensure_ascii=False)))


def run(env_extra=None, args=None):
    env = dict(os.environ)
    if env_extra:
        env.update(env_extra)
    p = subprocess.run([PY] + (args or [SCRIPT]), capture_output=True, text=True,
                       timeout=10, env=env)
    return p


# ── L1: 输出一定是合法 JSON、退出码一定 0（绝不能因为读不到就崩掉壳）──
p = run({"DISPLAY": ":0"})
ok("退出码 0（读不到也不许崩）", p.returncode == 0, {"rc": p.returncode, "err": p.stderr[:120]})
try:
    r = json.loads(p.stdout.strip().splitlines()[-1])
    ok("输出是合法 JSON", True, r)
except Exception as e:
    ok("输出是合法 JSON", False, {"stdout": p.stdout[:200], "e": str(e)})
    r = {}

ok("有 ok 字段", "ok" in r, list(r.keys()))

# 连不上 X 时必须走失败分支且仍然 JSON
p2 = run({"DISPLAY": ":99"})
ok("连不上 X 时退出码仍为 0", p2.returncode == 0, {"rc": p2.returncode})
try:
    r2 = json.loads(p2.stdout.strip().splitlines()[-1])
    ok("连不上 X 时返回 ok:false", r2.get("ok") is False, r2)
except Exception:
    ok("连不上 X 时返回 ok:false", False, p2.stdout[:200])

# ── L2: 真 X 上读到的值必须合理 ──
r = json.loads(p.stdout.strip().splitlines()[-1])
if r.get("ok"):
    ok("读到 _NET_WORKAREA", True, {k: r[k] for k in ("x", "y", "width", "height")})
    ok("宽高为正", r["width"] > 0 and r["height"] > 0, [r["width"], r["height"]])
    # 工作区不可能比屏幕大（XWayland 报整屏是 Electron 的毛病，不是它的）
    try:
        import Xlib  # noqa: F401
        from Xlib import display as _d
        dd = _d.Display(os.environ.get("DISPLAY", ":0"))
        sw, sh = dd.screen().width_in_pixels, dd.screen().height_in_pixels
        ok("工作区不超过屏幕尺寸", r["width"] <= sw and r["height"] <= sh,
           {"wa": [r["width"], r["height"]], "screen": [sw, sh]})
    except Exception as e:
        print("INFO  跳过屏幕尺寸交叉校验:", e)
    ok("y 偏移非负（顶栏避让方向正确）", r["y"] >= 0, r["y"])
    # via 字段必须自报家门：xlib / xprop。
    # 这条断言是踩坑后加的 —— 首版只走 xlib，环境里没装就静默退回整屏值，
    # 而日志只有一行 "no-xlib"，很容易被当成无害警告划过去。
    ok("报告了读取方式 via", r.get("via") in ("xlib", "xprop"), r.get("via"))
else:
    print("INFO  当前会话读不到 _NET_WORKAREA，跳过 L2（Xorg 下应该能读到）")

# ── L2b: 强制走 xprop 路径（把 Xlib 屏蔽掉），结果必须与正常路径一致 ──
# 这是关键回归：用户机器上系统 python3 没装 Xlib，只有 xprop 可用。
# 不给这条路径单独断言的话，xprop 分支坏了也发现不了。
block = (
    "import sys, builtins\n"
    "_real = builtins.__import__\n"
    "def _imp(name, *a, **k):\n"
    "    if name == 'Xlib' or name.startswith('Xlib.'):\n"
    "        raise ImportError('blocked-for-test')\n"
    "    return _real(name, *a, **k)\n"
    "builtins.__import__ = _imp\n"
    "exec(compile(open(sys.argv[1]).read(), sys.argv[1], 'exec'))\n"
)
p3 = subprocess.run([PY, "-c", block, SCRIPT], capture_output=True, text=True, timeout=10,
                    env=dict(os.environ, DISPLAY=os.environ.get("DISPLAY", ":0")))
try:
    r3 = json.loads(p3.stdout.strip().splitlines()[-1])
    ok("屏蔽 Xlib 后仍能读（xprop 兜底生效）", r3.get("ok") is True, r3)
    if r.get("ok") and r3.get("ok"):
        same = [r3["x"], r3["y"], r3["width"], r3["height"]] == [r["x"], r["y"], r["width"], r["height"]]
        ok("xprop 路径与 xlib 路径结果一致", same,
           {"xlib": [r["x"], r["y"], r["width"], r["height"]],
            "xprop": [r3["x"], r3["y"], r3["width"], r3["height"]]})
        ok("xprop 路径自报 via=xprop", r3.get("via") == "xprop", r3.get("via"))
except Exception as e:
    ok("屏蔽 Xlib 后仍能读（xprop 兜底生效）", False, {"rc": p3.returncode, "err": p3.stderr[:200], "e": str(e)})

# ── L3: 与 xprop 交叉验证 ──
if shutil.which("xprop") and r.get("ok"):
    try:
        out = subprocess.run(["xprop", "-root", "_NET_WORKAREA"], capture_output=True,
                             text=True, timeout=5).stdout
        # 形如 _NET_WORKAREA(CARDINAL) = 0, 31, 1920, 987, 0, 31, ...
        nums = [int(x) for x in out.split("=", 1)[1].replace("\n", "").split(",")] if "=" in out else []
        if len(nums) >= 4:
            same = nums[:4] == [r["x"], r["y"], r["width"], r["height"]]
            ok("与 xprop 读数一致", same, {"ours": [r["x"], r["y"], r["width"], r["height"]], "xprop": nums[:4]})
    except Exception as e:
        print("INFO  xprop 交叉校验失败:", e)
else:
    print("INFO  无 xprop，跳过 L3")

passed = sum(1 for x in results if x["pass"])
print("\n%d/%d passed" % (passed, len(results)))
sys.exit(0 if passed == len(results) else 1)
