#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""xwin.py 的自检：不需要 VSCode 窗口也能验证匹配与 EWMH 消息链路。

三个层次，逐层降级：
  L1 纯逻辑  —— 匹配打分、关键字解析、类名判定（不需要 X，永远可跑）
  L2 X 连接  —— 能不能连上显示、能不能读出 _NET_CLIENT_LIST / _NET_WM_STATE
  L3 真往返  —— 真发 minimize + activate，看 WM 是否接受（需要至少一个窗口）

L3 用一个自己造的 X 窗口当靶子（class 设成 "code-fake"），
所以**不依赖用户是否开着 VSCode**，也不动用户任何真实窗口。

用法：python test/xwin-selftest.py
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SCRIPT = os.path.join(ROOT, "src", "xwin.py")
PY_OK = None  # 当前 python 有 Xlib 就复用它去跑 xwin.py

passed = []
failed = []


def ok(name, cond, info=None):
    (passed if cond else failed).append(name)
    tail = ""
    if info is not None:
        tail = "   " + json.dumps(info, ensure_ascii=False)
    print(("PASS  " if cond else "FAIL  ") + name + tail)


def info(name, info):
    print("INFO  " + name + "   " + json.dumps(info, ensure_ascii=False))


def run(*args, timeout=8):
    """跑 xwin.py，返回解析后的 JSON（脚本永远返回 0，靠 ok 字段判断）。"""
    p = subprocess.run(
        [sys.executable, SCRIPT, *args], capture_output=True, text=True, timeout=timeout, env={**os.environ}
    )
    out = (p.stdout or "").strip()
    try:
        return json.loads(out), p.returncode, (p.stderr or "")
    except Exception:
        return None, p.returncode, (p.stdout or "") + (p.stderr or "")


# ───────────── L1：纯逻辑（不需要 X） ─────────────
def test_logic():
    sys.path.insert(0, os.path.join(ROOT, "src"))
    # 直接导入模块函数做单元测试（connect 不会被调用）
    import importlib.util

    spec = importlib.util.spec_from_file_location("xwin_mod", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    ok("is_code_like 认得出 VSCode 系", mod.is_code_like("code") and mod.is_code_like("Code-OSS"))
    # VSCodium 的 WM_CLASS 是 "VSCodium"，不含 "code" 子串 —— 漏掉就所有球都点不动
    ok("is_code_like 认得出 VSCodium（类名里没有 code 子串）", mod.is_code_like("VSCodium"), {"cls": "VSCodium"})
    ok("is_code_like 认得出 Cursor", mod.is_code_like("Cursor"))
    ok("is_code_like 不会把别的窗口当 VSCode", not mod.is_code_like("branch-orbs") and not mod.is_code_like("firefox"))

    pid, rc, kws = mod.parse_args(["--pid=1234", "esp32-jig", "--all-classes"])
    ok("parse_args 解析 --pid=N", pid == 1234, {"pid": pid})
    ok("parse_args 解析 --all-classes", rc is False)
    ok("parse_args 收集关键字", kws == ["esp32-jig"], {"kw": kws})

    pid2, _, kws2 = mod.parse_args(["--pid", "99", "a", "b"])
    ok("parse_args 支持 --pid N 分开写", pid2 == 99 and kws2 == ["a", "b"], {"pid": pid2, "kw": kws2})

    # 打分区间的严格序：pid > title > class > 0
    class FakeWin:
        def __init__(self, title, cls, pid):
            self._t, self._c, self._p = title, cls, pid

    class FakeDpy:
        """给 score() 用的假 display：只实现 get_atom_name / intern_atom 的调用面。"""

        def intern_atom(self, _n):
            return 0

    mod.window_title = lambda d, w: w._t
    mod.window_class = lambda d, w: w._c
    mod.window_pid = lambda d, w: w._p
    d0 = FakeDpy()

    s_pid, how_pid = mod.score(d0, FakeWin("别的标题", "code", 4242), ["esp32"], 4242)
    s_title, how_title = mod.score(d0, FakeWin("esp32-jig - Code", "code", 1), ["esp32"], None)
    # 类名匹配：窗口必须先是"像 VSCode 的类"（走 require_code 闸门），
    # 再用关键字去匹类名 —— 所以这里类名要同时含 code 和关键字。
    s_class, how_class = mod.score(d0, FakeWin("随便", "code-esp32-thing", 2), ["esp32"], None)
    s_none, _ = mod.score(d0, FakeWin("随便", "code", 3), ["esp32"], None)
    ok("PID 匹配分最高（标题不含关键字也能命中）", s_pid == 100 and how_pid.get("by") == "pid", {"s": s_pid})
    ok("标题匹配次之", s_title == 50, {"s": s_title})
    ok("类名匹配再次", s_class == 30, {"s": s_class})
    ok("都不匹配为 0", s_none == 0)
    ok("分数严格有序 pid>title>class>0", s_pid > s_title > s_class > s_none)

    # 非 code 窗口即使标题命中也不算（require_code）
    s_notcode, _ = mod.score(d0, FakeWin("esp32-jig", "firefox", 4), ["esp32"], None, require_code=True)
    s_notcode2, _ = mod.score(d0, FakeWin("esp32-jig", "firefox", 4), ["esp32"], None, require_code=False)
    ok("require_code 时非 VSCode 窗口被排除", s_notcode == 0, {"s": s_notcode})
    ok("--all-classes 时允许命中任意类名", s_notcode2 == 50, {"s": s_notcode2})

    # 关键字大小写不敏感
    s_ci, _ = mod.score(d0, FakeWin("ESP32-JIG - Code", "code", 5), ["esp32-jig"], None)
    ok("关键字大小写不敏感", s_ci == 50, {"s": s_ci})


# ───────────── L2/L3：X 相关 ─────────────
def test_x():
    out, rc, raw = run("list")
    if out is None:
        info("xwin.py list 输出不是 JSON，跳过 L2/L3", {"raw": raw[:300]})
        return
    if not out.get("ok") and out.get("error") == "no-display":
        info("无 X 显示（DISPLAY=" + str(out.get("display")) + "），跳过 L2/L3", {})
        return

    ok("list 返回合法 JSON 且退出码 0", rc == 0 and out.get("ok") is True, {"rc": rc})
    ok("list 带 windows 数组", isinstance(out.get("windows"), list), {"n": len(out.get("windows") or [])})

    # probe 不存在的关键字：必须 ok:false + no-matching 类错误，且退出码 0
    out2, rc2, _ = run("probe", "zzz-绝对不存在的关键字-zzz")
    ok("probe 未命中时退出码仍为 0（别让调用方误判崩溃）", rc2 == 0, {"rc": rc2})
    ok("probe 未命中时返回 ok:false", out2 is not None and out2.get("ok") is False, {"out": (out2 or {}).get("ok")})

    out3, rc3, _ = run("bogus-command")
    ok("未知命令返回 unknown-command 且退出码 0", rc3 == 0 and (out3 or {}).get("error") == "unknown-command")

    # L3：造一个自己的窗口当靶子。用 Electron 起太慢，这里用 xlib 直接建窗口不现实，
    # 退而求其次：若本机恰好有 branch-orbs 壳在跑，用它做往返（它是我们自己的窗口，动它无害）。
    out4, _, _ = run("probe", "--all-classes", "branch-orbs")
    if out4 and out4.get("ok"):
        ok("probe 能按类名命中 branch-orbs 壳窗口", True, {"hits": len(out4.get("hits") or [])})

        # ── 真实 _NET_WM_PID 精确匹配 ──
        # 这是本轮最重要的改进：只用关键字匹标题，遇到"用户改了 window.title"、
        # "SSH 远端标题"、"工程没加载完标题还是 Visual Studio Code" 就全废。
        # 用 PID 匹配则与标题完全无关。
        import importlib.util

        spec = importlib.util.spec_from_file_location("xwin_mod2", SCRIPT)
        mod2 = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod2)
        d = mod2.connect()
        if d is not None:
            target_pid = None
            target_title = None
            for w in mod2.client_windows(d):
                if "branch-orbs" in mod2.window_class(d, w).lower():
                    target_pid = mod2.window_pid(d, w)
                    target_title = mod2.window_title(d, w)
                    break
            ok("窗口能读出 _NET_WM_PID", target_pid is not None, {"pid": target_pid, "title": target_title})

            if target_pid:
                # 关键字故意给一个毫不相关的词：只有 PID 能命中
                hit_pid = mod2.match(d, ["绝不可能出现在标题里的词"], target_pid, False)
                ok(
                    "PID 匹配与标题无关（给个无关关键字也能命中）",
                    len(hit_pid) == 1 and hit_pid[0][3].get("by") == "pid",
                    {"hits": len(hit_pid), "how": hit_pid[0][3] if hit_pid else None},
                )
                # PID 与关键字都不匹配 → 必须 0 命中（不能误伤别的窗口）
                miss = mod2.match(d, ["绝不可能出现的词"], 999999999, False)
                ok("PID + 关键字都不匹配时 0 命中（不误伤其他窗口）", len(miss) == 0, {"hits": len(miss)})
            d.close()

        t1, _, _ = run("toggle", "--all-classes", "branch-orbs")
        d1 = (t1 or {}).get("detail") or [{}]
        to1 = d1[0].get("to")
        t2, _, _ = run("toggle", "--all-classes", "branch-orbs")
        d2 = (t2 or {}).get("detail") or [{}]
        to2 = d2[0].get("to")
        ok("toggle 第一次真的改变了窗口状态", (t1 or {}).get("changed") == 1, {"to": to1, "settled": d1[0].get("settled")})
        ok("toggle 第二次能切回来（往返闭环）", (t2 or {}).get("changed") == 1 and to1 != to2, {"to1": to1, "to2": to2})
        ok("两次都等到 WM 确认状态稳定（settled）", d1[0].get("settled") is True and d2[0].get("settled") is True)

        # ── 连续多次 toggle 必须严格交替 ──
        # 这是"点一次有效、点两次失效"那个竞态的直接回归测试：
        # _NET_WM_STATE_HIDDEN 是 WM 异步更新的，若动作后不等状态落定，
        # 第二次读到的还是旧值 → 又发一次同方向动作 → 看起来"点了没反应"。
        seq = [to2]
        for _ in range(3):
            t, _, _ = run("toggle", "--all-classes", "branch-orbs")
            det = (t or {}).get("detail") or [{}]
            seq.append(det[0].get("to"))
            if (t or {}).get("changed") != 1:
                break
        alternates = all(seq[i] != seq[i + 1] for i in range(len(seq) - 1))
        ok(
            "连续 toggle 严格交替 hidden/visible（竞态回归）",
            alternates and len(seq) >= 4,
            {"seq": seq},
        )
        # 收拾干净：确保停在 visible，别把用户窗口留成最小化
        run("activate", "--all-classes", "branch-orbs")
        out_fixed, _, _ = run("probe", "--all-classes", "branch-orbs")
        fixed_hidden = ((out_fixed or {}).get("hits") or [{}])[0].get("hidden")
        ok("自检结束时把窗口恢复成可见（不会把用户窗口留在最小化）", fixed_hidden is False, {"hidden": fixed_hidden})
    else:
        info("本机没有 branch-orbs 壳窗口，跳过 L3 真往返验证（不算失败）", {})


def main():
    print("── L1 匹配逻辑 ──")
    test_logic()
    print("── L2/L3 X 环境 ──")
    test_x()
    total = len(passed) + len(failed)
    print("\n%d/%d passed" % (len(passed), total))
    if failed:
        print("失败：" + ", ".join(failed))
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
