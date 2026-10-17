#!/usr/bin/env bash
# 把 vsix 装到本机所有 VSCode profile。
#
# 用法：bash scripts/install.sh [vsix路径]
#
# ⚠ 为什么不用 `code --install-extension` 一步到位：
#   两种 profile 都要装（见 README："从桌面图标启动" 用的是 ~/.config/Code，
#   命令行 code 用的是 ~/.vscode，两者的 extensions 目录**互相独立**），
#   而 --force 对已存在的同名版本目录并不会真正覆盖文件，
#   会出现"装完还是旧代码"的假象（本文件就是因此出现的）。
#   另外某些沙箱环境会把解压步骤拦掉，但 CLI 仍打印 "successfully installed"，
#   所以这里装完必须逐个校验关键文件的存在与大小。
set -u

cd "$(dirname "$0")/.." || exit 1
ROOT=$(pwd)

VSIX="${1:-}"
if [ -z "$VSIX" ]; then
  VSIX=$(ls -t "$ROOT"/branch-orbs-*.vsix 2>/dev/null | head -1)
fi
if [ -z "$VSIX" ] || [ ! -f "$VSIX" ]; then
  echo "找不到 vsix。先跑：node scripts/pack.js" >&2
  exit 1
fi
echo "安装包：$VSIX"

# 期望：包内几个关键文件的大小（用来校验装进去的确实是这一版）
sizes() {
  /home/hy/.workbuddy/binaries/python/envs/default/bin/python - "$VSIX" "$1" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    print(z.getinfo('extension/' + sys.argv[2]).file_size)
PY
}
WANT_XWIN=$(sizes 'src/xwin.py')
WANT_WA=$(sizes 'src/workarea.py')
WANT_MC=$(sizes 'src/mapcheck.py')
WANT_MAIN=$(sizes 'shell/main.js')
echo "包内指纹：xwin.py=$WANT_XWIN  workarea.py=$WANT_WA  mapcheck.py=$WANT_MC  main.js=$WANT_MAIN"

# 两个 profile：命令行 code 默认用 ~/.vscode，桌面图标默认用 ~/.config/Code
PROFILES=("$HOME/.vscode" "$HOME/.config/Code")
RC=0

for UD in "${PROFILES[@]}"; do
  echo "── $UD ──"
  mkdir -p "$UD/extensions"

  # 1) 先让 CLI 登记 extensions.json（它负责元数据）
  /usr/share/code/bin/code --user-data-dir="$UD" --install-extension "$VSIX" --force >/dev/null 2>&1 || true

  # 2) 手工确保文件真的落地（CLI 可能静默失败，见文件头说明）
  /home/hy/.workbuddy/binaries/python/envs/default/bin/python - "$VSIX" "$UD" <<'PY'
import sys, os, zipfile, shutil, json
vsix, ud = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(vsix) as z:
    pkg = json.loads(z.read('extension/package.json').decode('utf-8'))
name = pkg['name']
publisher = pkg.get('publisher', 'heyuying')
target = os.path.join(ud, 'extensions', '%s.%s-%s' % (publisher, name, pkg['version']))

if os.path.isdir(target):
    shutil.rmtree(target, ignore_errors=True)
tmp = target + '.tmp'
os.makedirs(tmp, exist_ok=True)
with zipfile.ZipFile(vsix) as z:
    z.extractall(tmp)
# vsix 本体在 extension/ 下，VSCode 期望 package.json 直接在扩展根
inner = os.path.join(tmp, 'extension')
if os.path.isdir(inner):
    for n in os.listdir(inner):
        shutil.move(os.path.join(inner, n), os.path.join(tmp, n))
    shutil.rmtree(inner, ignore_errors=True)
for junk in ('[Content_Types].xml', 'extension.vsixmanifest'):
    p = os.path.join(tmp, junk)
    if os.path.exists(p):
        os.remove(p)
if os.path.isdir(target):
    shutil.rmtree(target, ignore_errors=True)
shutil.move(tmp, target)
print('  → ' + target)
PY

  # 3) 校验：关键文件必须在，且大小与包内一致
  #    用多个文件做指纹，不只盯一个 —— 单文件校验挡不住"新旧版本恰好同大小"，
  #    也挡不住"只有新加的文件没装进去"（workarea.py 就是本轮新增的，
  #    漏掉它的症状是球跑回屏幕中上部，和没修一样）。
  for SPEC in "xwin.py:$WANT_XWIN" "workarea.py:$WANT_WA" "mapcheck.py:$WANT_MC" "shell/main.js:$WANT_MAIN"; do
    NAME="${SPEC%%:*}"
    WANT="${SPEC##*:}"
    F="$UD/extensions/heyuying.branch-orbs-0.1.0/src/$NAME"
    [ "$NAME" = "shell/main.js" ] && F="$UD/extensions/heyuying.branch-orbs-0.1.0/shell/main.js"
    if [ -f "$F" ]; then
      GOT=$(stat -c %s "$F" 2>/dev/null || echo 0)
      if [ "$GOT" = "$WANT" ]; then
        echo "  ✅ $NAME $GOT 字节，与包内一致"
      else
        echo "  ❌ $NAME $GOT 字节，期望 $WANT（装进去的是旧版！）"
        RC=1
      fi
    else
      echo "  ❌ 缺少 $NAME —— 解压被拦或路径不对"
      RC=1
    fi
  done

  # 4) extensions.json 里必须登记了这个扩展，否则 VSCode 根本不扫描这个目录。
  #    ⚠ CLI 的 --install-extension 自己解压时可能留下半成品 <id>.tmp 目录，
  #      并把 relativeLocation 写成 *.tmp —— 之后 VSCode 按登记去读
  #      <id>.tmp/package.json 就报 "Unable to resolve nonexistent file"。
  #      必须把登记纠正回真实目录，并清掉 CLI 留下的 tmp 残留。
  EJ="$UD/extensions/extensions.json"
  /home/hy/.workbuddy/binaries/python/envs/default/bin/python - "$UD" <<'PY'
import sys, os, json, shutil
ud = sys.argv[1]
extdir = os.path.join(ud, 'extensions')
ej = os.path.join(extdir, 'extensions.json')
if not os.path.exists(ej):
    print('  ❌ extensions.json 不存在')
    sys.exit(1)
entries = json.load(open(ej))
changed = False
for e in entries:
    loc = e.get('relativeLocation', '')
    if loc.endswith('.tmp'):
        fixed = loc[:-4]
        if os.path.isdir(os.path.join(extdir, fixed)):
            e['relativeLocation'] = fixed
            e['location']['path'] = os.path.join(extdir, fixed)
            e['location']['fsPath'] = e['location']['path']
            e['location']['external'] = 'file://' + e['location']['path']
            changed = True
            print('  🔧 已纠正登记：' + loc + ' → ' + fixed)
# CLI 可能还留着半成品 tmp 目录，清掉（里面没有完整 package.json，留着必报错）
for n in os.listdir(extdir):
    if n.startswith('heyuying.branch-orbs') and n.endswith('.tmp'):
        shutil.rmtree(os.path.join(extdir, n), ignore_errors=True)
        print('  🧹 已清理残留：' + n)
if changed:
    json.dump(entries, open(ej, 'w'))
PY

  if [ -f "$EJ" ] && grep -q 'heyuying.branch-orbs' "$EJ" && ! grep -q '\.tmp' "$EJ"; then
    echo "  ✅ extensions.json 已登记且指向真实目录"
  else
    echo "  ❌ extensions.json 缺失/未登记/仍指向 .tmp"
    RC=1
  fi
done

if [ "$RC" -ne 0 ]; then
  echo -e "\n有 profile 安装不完整，见上面 ❌" >&2
  exit 1
fi
echo -e "\n全部 profile 安装完成。重启 VSCode 生效。"
