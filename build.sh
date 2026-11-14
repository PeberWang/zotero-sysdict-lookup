#!/bin/zsh
# 编译助手（通用二进制）→ base64 模块 → 打包 xpi
set -euo pipefail
cd "$(dirname "$0")"

DEST="$HOME/Library/Application Support/Zotero/sysdict"
mkdir -p build "$DEST/bin" addon/native

echo "==> 编译 dictlookup（arm64 + x86_64）"
clang -O2 -fobjc-arc -arch arm64 -arch x86_64 \
    -framework Foundation -framework CoreServices \
    -o build/dictlookup native/dictlookup.m
lipo -info build/dictlookup | sed 's/^/    /'

echo "==> 编译 dictsummary（Foundation Models，arm64 + x86_64）"
swiftc -O -parse-as-library -target arm64-apple-macos26.0 native/dictsummary.swift -o build/ds-arm64
swiftc -O -parse-as-library -target x86_64-apple-macos26.0 native/dictsummary.swift -o build/ds-x86_64
lipo -create -output build/dictsummary build/ds-arm64 build/ds-x86_64
lipo -info build/dictsummary | sed 's/^/    /'

echo "==> 生成 base64 模块"
for name in dictlookup dictsummary; do
    printf '// 由 build.sh 生成：macOS 通用二进制 %s 的 base64\nvar SYSDICT_%s_B64 = "%s";\n' \
        "$name" "${name:u}" "$(base64 -i "build/$name" | tr -d '\n')" \
        > "addon/native/$name.b64.js"
done

# 本机开发时直接落一份，方便调试
for name in dictlookup dictsummary; do
    cp "build/$name" "$DEST/bin/.$name.new"
    chmod 755 "$DEST/bin/.$name.new"
    mv -f "$DEST/bin/.$name.new" "$DEST/bin/$name"
done

echo "==> 打包 xpi"
rm -f build/sysdict-lookup.xpi
(cd addon && zip -q -r -X ../build/sysdict-lookup.xpi . -x '.*' -x '__MACOSX/*')

echo ""
echo "助手: $DEST/bin/{dictlookup,dictsummary}"
echo "插件: $(pwd)/build/sysdict-lookup.xpi ($(du -h build/sysdict-lookup.xpi | cut -f1))"
