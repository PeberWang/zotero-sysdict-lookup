#!/bin/zsh
# 测试用假 dictsummary：两次都不合格（第一次带编号，重试仍带语体标签）
if [[ " $* " == *" --feedback "* ]]; then
  print -r -- '{"available":true,"ranked":false,"summary":"informal extremely large","senses":["informal extremely large"],"targetLang":"en"}'
else
  print -r -- '{"available":true,"ranked":false,"summary":"1 extremely large; 2 huge","senses":["1 extremely large","2 huge"],"targetLang":"en"}'
fi
