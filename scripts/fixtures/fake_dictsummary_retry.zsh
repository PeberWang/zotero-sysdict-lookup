#!/bin/zsh
# 测试用假 dictsummary：第一次故意带词性与音标，带 --feedback 重试时给出合格输出
if [[ " $* " == *" --feedback "* ]]; then
  print -r -- '{"available":true,"ranked":false,"summary":"extremely large; (of a statue) at least twice life size","senses":["extremely large","(of a statue) at least twice life size"],"targetLang":"en"}'
else
  print -r -- '{"available":true,"ranked":false,"summary":"adjective extremely large; | kəˈläs(ə)l | huge","senses":["adjective extremely large","| kəˈläs(ə)l | huge"],"targetLang":"en"}'
fi
