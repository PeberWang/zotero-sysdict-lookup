#!/bin/zsh
# 不依赖 Zotero UI 的语境重排演示：同一词在不同文章里排序不同
# 先 bash build.sh，再 zsh scripts/rank_demo.sh
set -euo pipefail
zmodload zsh/datetime
cd "$(dirname "$0")/.."

LOOKUP=build/dictlookup
SUMMARY=build/dictsummary
[[ -x $LOOKUP && -x $SUMMARY ]] || { echo "先运行 bash build.sh"; exit 1; }

entry() {
    $LOOKUP "$1" | python3 -I -c '
import json, sys
d = json.load(sys.stdin)
for e in d.get("entries", []):
    if "New Oxford" in e["dict"] or "Oxford Dictionary of English" in e["dict"]:
        print(e.get("text", "")); break'
}

show() {
    python3 -I -c '
import json, sys
d = json.loads(sys.stdin.read())
print("  ranked     :", d.get("ranked"))
for i, s in enumerate(d.get("senses") or [], 1):
    print("  %d.%s %s" % (i, " *" if i == 1 and d.get("ranked") else "  ", s))
for x in d.get("dropped") or []:
    print("  dropped    :", x)
if d.get("reason"):
    print("  reason     :", d["reason"])
print("  promptChars:", d.get("promptChars"))'
}

case_run() {
    local label=$1 word=$2; shift 2
    echo "== $label"
    echo "  word       : $word"
    local a
    for a in "$@"; do [[ $a == --* ]] && printf "  %-11s: " "${a#--}" || echo "$a"; done
    local raw; raw=$(entry "$word")
    local t0=$EPOCHREALTIME
    $SUMMARY --word "$word" --raw "$raw" "$@" | show
    printf "  elapsed    : %.2fs\n\n" $(( EPOCHREALTIME - t0 ))
}

case_run "1 完整元数据 + 历史（货币政策）" interest \
    --title "Bank lending and the transmission of monetary policy" \
    --journal "Journal of Finance" --year 2019 \
    --abstract "We study how changes in the policy rate pass through to loan rates and credit supply of commercial banks." \
    --history "collateral,lender,spread"

case_run "2 完整元数据 + 历史（土地产权）" interest \
    --title "Property rights and land tenure in rural China" \
    --journal "Journal of Development Economics" --year 2021 \
    --abstract "We examine how insecure land tenure affects investment by farm households." \
    --history "tenure,title,lease"

case_run "3 只有元数据（利益集团）" interest \
    --title "Special interests and lobbying in the U.S. Congress" \
    --journal "American Political Science Review"

case_run "4 只有元数据（威权政治）" regime \
    --title "Authoritarian regime durability and elite coalitions" \
    --journal "World Politics"

case_run "5 完整元数据 + 历史（流体力学）" regime \
    --title "Turbulent flow regimes in pipe transport" \
    --journal "Journal of Fluid Mechanics" \
    --abstract "We characterize laminar, transitional and turbulent conditions in pipe flow." \
    --history "laminar,Reynolds"

case_run "6 无元数据无历史（退化到上下文无关精简，不排序）" interest
