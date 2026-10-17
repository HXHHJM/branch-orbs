#!/usr/bin/env bash
# 跑全部自检。任何一个失败 → 整体退出码非 0。
#
# 用法：bash test/all.sh
#
# ⚠ 环境注意：
#   * PATH 要带上工具链自带的 git，否则 git-selftest 报 "git: not found"
#   * ELECTRON_RUN_AS_NODE 必须清掉：宿主注入它会让 Electron 二进制退化成 node
#   * CODEBUDDY_SAFE_DELETE_* 会让脚本里的删除操作被拦（沙箱）
#   * NODE_PATH 指向 playwright 所在目录（shell-selftest 需要）
set -u

cd "$(dirname "$0")/.." || exit 1
ROOT=$(pwd)

export PATH="/home/hy/.workbuddy/binaries/tools/bin:$PATH"
NODE=/home/hy/.workbuddy/binaries/node/versions/22.22.2/bin/node
PY=/home/hy/.workbuddy/binaries/python/envs/default/bin/python
export NODE_PATH="/home/hy/.workbuddy/binaries/node/workspace/node_modules"

# 清掉会污染自检的环境变量
CLEAN_ENV=(env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS)
for v in $(env | grep -o '^CODEBUDDY_SAFE_DELETE[_A-Z]*' || true); do
  CLEAN_ENV+=(-u "$v")
done

PASS=0
FAIL=0
FAILED_LIST=()

run_one() {
  local name="$1"
  shift
  printf '\n\033[1m═══ %s ═══\033[0m\n' "$name"
  if "$@" 2>&1 | tail -40; then
    # tail 会吃掉退出码，改用 PIPESTATUS
    :
  fi
  local rc=${PIPESTATUS[0]}
  if [ "$rc" -eq 0 ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAILED_LIST+=("$name")
    printf '\033[31m✗ %s 退出码 %s\033[0m\n' "$name" "$rc"
  fi
}

# ── 不需要 GUI 的纯逻辑自检 ──
run_one "launcher（启动参数/环境：/dev/shm、TMPDIR、ELECTRON_RUN_AS_NODE）" \
  "${CLEAN_ENV[@]}" "$NODE" test/launcher-selftest.js

run_one "xwin（X11 窗口匹配 + toggle 往返）" \
  "${CLEAN_ENV[@]}" "$PY" test/xwin-selftest.py

run_one "ownerpid（窗口所属主进程 pid 的父链遍历）" \
  "${CLEAN_ENV[@]}" "$NODE" test/ownerpid-selftest.js

# workArea 走 python 读 _NET_WORKAREA：Electron 在 XWayland 下会把整屏当工作区，
# 靠这个脚本纠正（错了球会跑到屏幕中上部，且日志全绿，所以必须有断言）
run_one "workarea（EWMH 工作区：顶栏避让）" \
  "${CLEAN_ENV[@]}" "$PY" test/workarea-selftest.py

run_one "activate（激活/状态栏豆子）" \
  "${CLEAN_ENV[@]}" "$NODE" test/activate-selftest.js

run_one "registry（跨窗口注册表）" \
  "${CLEAN_ENV[@]}" "$NODE" test/registry-selftest.js

run_one "git（git 解析）" \
  "${CLEAN_ENV[@]}" "$NODE" test/git-selftest.js

run_one "git-resolve（仓库发现）" \
  "${CLEAN_ENV[@]}" "$NODE" test/git-resolve-selftest.js

run_one "epipe（壳通道断开处理）" \
  "${CLEAN_ENV[@]}" "$NODE" test/epipe-selftest.js

# ── 需要真起 Electron 的自检，单独开关（慢 + 依赖 X） ──
if [ "${WITH_SHELL:-0}" = "1" ]; then
  run_one "shell（真起 Electron 壳）" \
    "${CLEAN_ENV[@]}" "$NODE" test/shell-selftest.js
else
  printf '\n\033[33mSKIP  shell-selftest（需要真起 Electron；要跑请 WITH_SHELL=1）\033[0m\n'
fi

printf '\n\033[1m────────────────────────\033[0m\n'
printf '通过 %d 项，失败 %d 项\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf '\033[31m失败：%s\033[0m\n' "${FAILED_LIST[*]}"
  exit 1
fi
printf '\033[32m全部通过\033[0m\n'
exit 0
