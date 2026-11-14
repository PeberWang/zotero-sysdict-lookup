#!/bin/zsh
# 编译通用二进制助手 → 生成 base64 模块 → 打包 xpi
set -euo pipefail
cd "$(dirname "$0")"

DEST="$HOME/Library/Application Support/Zotero/sysdict"
mkdir -p build "$DEST/bin"

echo "==> 编译 dictlookup（arm64 + x86_64）"
clang -O2 -fobjc-arc -arch arm64 -arch x86_64 \
    -framework Foundation -framework CoreServices \
    -o build/dictlookup native/dictlookup.m

lipo -info build/dictlookup | sed 's/^/    /'

echo "==> 生成 base64 模块"
mkdir -p addon/native
printf '// 由 build.sh 生成：macOS 通用二进制 dictlookup 的 base64\nvar SYSDICT_B64 = "%s";\n' \
    "$(base64 -i build/dictlookup | tr -d '\n')" > addon/native/dictlookup.b64.js

# 本机开发时也放一份，方便直接调试
cp build/dictlookup "$DEST/bin/.dictlookup.new"
chmod 755 "$DEST/bin/.dictlookup.new"
mv -f "$DEST/bin/.dictlookup.new" "$DEST/bin/dictlookup"

echo "==> 打包 xpi"
rm -f build/sysdict-lookup.xpi
(cd addon && zip -q -r -X ../build/sysdict-lookup.xpi . -x '.*' -x '__MACOSX/*')

echo ""
echo "助手: $DEST/bin/dictlookup"
echo "插件: $(pwd)/build/sysdict-lookup.xpi ($(du -h build/sysdict-lookup.xpi | cut -f1))"
