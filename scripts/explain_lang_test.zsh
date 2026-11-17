#!/bin/zsh
# 释义语言判定的本机测试（需要对应词典已下载）：bash build.sh && zsh scripts/explain_lang_test.zsh
# 每项是 词典:词=期望释义语言；判的是释义，不是词头语言
cd "$(dirname "$0")/.."
C=build/dictionaries-test.json; total=0; ok=0
build/dictlookup --list-dictionaries --json --cache $C >/dev/null
for spec in "Gran Diccionario Oxford - Español-Inglés • Inglés-Español:agua=en gobierno=en casa=en banco=en libro=en ley=en water=es government=es house=es law=es" \
  "Oxford-Hachette French Dictionary:eau=en gouvernement=en maison=en livre=en loi=en water=fr government=fr house=fr law=fr" \
  "Oxford German Dictionary:Wasser=en Regierung=en Haus=en Buch=en Gesetz=en water=de house=de law=de government=de" \
  "Diccionari Català-Anglès:aigua=en casa=en llibre=en llei=en water=ca house=ca law=ca" \
  "Oxford Paravia Il Dizionario inglese - italiano/italiano - inglese:acqua=en governo=en casa=en libro=en legge=en water=it house=it law=it" \
  "Oxford Portuguese Dictionary - Português-Inglês • Inglês-Português:água=en governo=en casa=en livro=en lei=en water=pt house=pt law=pt" \
  "New Oxford American Dictionary:water=en government=en interest=en capital=en law=en colossal=en algebra=en philosophy=en democracy=en rhythm=en" \
  "Oxford Dictionary of English:water=en colour=en law=en" \
  "牛津英汉汉英词典:water=zh-Hans law=zh-Hans colossal=zh-Hans algebra=zh-Hans 水=en 法律=en" "譯典通英漢雙向字典:water=zh-Hant 水=en"; do
  d=${spec%%:*}; ws=${spec#*:}; line=""
  for we in ${=ws}; do w=${we%%=*}; want=${we#*=}; total=$((total+1))
    got=$(build/dictlookup "$w" --order "$d" --cache $C | python3 -I -c "import json,sys;e=json.load(sys.stdin)['entries'];print(e[0]['explains'] if e else 'miss')")
    if [[ $got == $want ]]; then ok=$((ok+1)); line="$line ✓$w"; else line="$line ✗$w($got≠$want)"; fi
  done; echo "${d[1,22]}:$line"
done
# 任务书原样的复现命令（不带 --cache、默认顺序）：词源里有法语、拉丁语、希腊语的英语词，NOAD 必须判为 en
for w in colossal algebra government philosophy; do total=$((total+1))
  got=$(build/dictlookup "$w" | python3 -I -c "import json,sys;e=json.load(sys.stdin)['entries'];print(e[0]['explains'] if e else 'miss')")
  if [[ $got == en ]]; then ok=$((ok+1)); echo "无缓存 ✓$w"; else echo "无缓存 ✗$w($got)"; fi
done
echo "$ok/$total 正确"; [[ $ok -ge $((total - 1)) ]]
