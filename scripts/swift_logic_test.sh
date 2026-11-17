#!/bin/zsh
# dictsummary 落地校验与解析的自测（不调模型）：zsh scripts/swift_logic_test.sh
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -x build/dictlookup ]] || { echo "先运行 bash build.sh"; exit 1; }
tmp=build/swift-test; mkdir -p $tmp
sed -e 's/^@main$//' -e 's/^struct Main {/struct MainDisabled {/' native/dictsummary.swift > $tmp/ds_lib.swift
build/dictlookup interest | python3 -I -c '
import json, sys
d = json.load(sys.stdin)
print([e for e in d["entries"] if "New Oxford" in e["dict"]][0]["text"], end="")' > $tmp/raw_interest.txt
swiftc -parse-as-library -target arm64-apple-macos26.0 $tmp/ds_lib.swift scripts/tests/ground_test.swift -o $tmp/ground_test
$tmp/ground_test $tmp/raw_interest.txt
