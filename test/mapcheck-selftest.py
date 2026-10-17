#!/usr/bin/env python3
"""mapcheck.py 的自检。

它存在的唯一理由：**"球一直不出现"这一族故障里，唯一可靠的证据就是
"这个 PID 的窗口在 _NET_CLIENT_LIST 里吗"**。而这个校验脚本自己出过一次
致命 bug —— 写死 `python3 -c` 内联源码，用户机器上系统 python3 没装
python-xlib，于是校验脚本先崩，日志只剩 "X map 校验失败(可忽略)"，
等于整条诊断链白做。

所以本自检必须覆盖：
  L1 输出契约：任何情况都输出一行合法 JSON、退出码 0
  L2 双路径：xlib 可用时走 xlib；**屏蔽 Xlib 后必须自动降级到 xprop**
  L3 真 X 命中：拿一个确实已 map 的窗口 PID，必须报 mapped=true
  L4 反向：拿一个不存在的 PID，必须报 mapped=false（不能永远说 true）
  L5 xprop 解析：root 属性是 "冒号" 分隔（曾按等号切 → 兜底静默失效）
"""
import json
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "src", "mapcheck.py")
PY = sys.executable

results = []


def ok(name, cond, extra=None):
    results.append({"name": name, "pass": bool(cond), "extra": extra})
    print(("PASS  " if cond else "FAIL  ") + name +
          ("" if extra is None else "   " + json.dumps(extra, ensure_ascii=False)))


def run(args=None, env_extra=None, prelude=None):
    """跑 mapcheck.py。

    prelude：在真正脚本前插入的代码（用来注入 __import__ 钩子屏蔽 Xlib）。
             用 exec() 链式执行，让脚本里的 sys.exit 依然生效。
    """
    cmd = [PY]
    if prelude:
        cmd += ["-c", prelude, SCRIPT] + list(args or [])
    else:
        cmd += [SCRIPT] + list(args or [])
    env = dict(os.environ)
    if env_extra:
        env.update(env_extra)
    return subprocess.run(cmd, capture_output=True, text=True, timeout=15, env=env)


def parse(p):
    try:
        return json.loads(p.stdout.strip().splitlines()[-1])
    except Exception:
        return None


# ── L1 输出契约 ──────────────────────────────────────────────────────────
p = run(args=["999999"])
ok("退出码 0（查不到也不许崩）", p.returncode == 0,
   {"rc": p.returncode, "err": p.stderr[:160]})
r = parse(p)
ok("输出是合法 JSON", r is not None, {"stdout": p.stdout[:200]})
ok("有 ok/mapped 字段", isinstance(r, dict) and "ok" in r and "mapped" in r,
   list(r.keys()) if isinstance(r, dict) else None)

p2 = run(args=[])
r2 = parse(p2)
ok("缺参数时输出 ok:false 而非抛栈", p2.returncode == 0 and isinstance(r2, dict)
   and r2.get("ok") is False, r2)

p3 = run(args=["not-a-pid"])
r3 = parse(p3)
ok("非法 pid 时输出 ok:false", p3.returncode == 0 and isinstance(r3, dict)
   and r3.get("ok") is False, r3)

# ── L2 屏蔽 Xlib → 必须降级 xprop ────────────────────────────────────────
BLOCK_XLIB = (
    "import sys, builtins\n"
    "_real = builtins.__import__\n"
    "def _imp(name, *a, **k):\n"
    "    if name == 'Xlib' or name.startswith('Xlib.'):\n"
    "        raise ImportError('blocked-for-test')\n"
    "    return _real(name, *a, **k)\n"
    "builtins.__import__ = _imp\n"
    "sys.argv = [sys.argv[1]] + sys.argv[2:]\n"
    "exec(compile(open(sys.argv[0]).read(), sys.argv[0], 'exec'))\n"
)
px = run(args=["999999"], prelude=BLOCK_XLIB)
rx = parse(px)
ok("屏蔽 Xlib 后仍能出结果（兜底生效）", px.returncode == 0 and isinstance(rx, dict)
   and rx.get("ok") is True, rx)
ok("屏蔽 Xlib 后 via 自报 xprop", (rx or {}).get("via") == "xprop",
   (rx or {}).get("via"))

# ── L3 真 X 命中：找一个确实已 map 的窗口 ────────────────────────────────
target_pid = None
if shutil.which("xprop"):
    lst = subprocess.run(["xprop", "-root", "_NET_CLIENT_LIST"],
                         capture_output=True, text=True, timeout=8)
    if lst.returncode == 0:
        ids = re.findall(r"0x[0-9a-fA-F]+", lst.stdout)
        for wid in ids:
            pr = subprocess.run(["xprop", "-id", wid, "_NET_WM_PID"],
                                capture_output=True, text=True, timeout=6)
            m = re.search(r"=\s*(\d+)", pr.stdout)
            if m:
                target_pid = int(m.group(1))
                break

if target_pid:
    pm = run(args=[str(target_pid)])
    rm = parse(pm)
    ok("真实已 map 的窗口 → mapped=true", (rm or {}).get("mapped") is True, rm)
    ok("返回了窗口几何（不能是全 0）",
       bool((rm or {}).get("windows")) and any(
           w[2] > 0 and w[3] > 0 for w in rm["windows"]),
       (rm or {}).get("windows"))
    rmx = parse(run(args=[str(target_pid)], prelude=BLOCK_XLIB))
    ok("xprop 路径同样能命中同一个窗口", (rmx or {}).get("mapped") is True, rmx)
else:
    ok("（跳过）环境里拿不到已 map 的窗口 PID", True, {"reason": "no-xprop-or-no-client"})

# ── L4 反向：不存在的 PID 必须是 false，不能永远 true ────────────────────
rn = parse(run(args=["999999"]))
ok("不存在的 PID → mapped=false（不是无脑 true）",
   (rn or {}).get("mapped") is False, rn)

# ── L5 xprop 解析格式回归 ────────────────────────────────────────────────
# root 属性是 "_NET_CLIENT_LIST(WINDOW): window id # 0xa..."（冒号），
# window 属性是 "_NET_WM_PID(CARDINAL) = 123"（等号）。混用会让兜底静默失败。
if shutil.which("xprop"):
    raw = subprocess.run(["xprop", "-root", "_NET_CLIENT_LIST"],
                         capture_output=True, text=True, timeout=8).stdout
    ok("root 属性确实以冒号分隔（回归：曾按等号切）",
       ":" in raw and "(WINDOW)" in raw, raw.strip()[:120])
else:
    ok("（跳过）无 xprop", True)

# ── 汇总 ────────────────────────────────────────────────────────────────
npass = sum(1 for x in results if x["pass"])
print("\n%d/%d passed" % (npass, len(results)))
sys.exit(0 if npass == len(results) else 1)
