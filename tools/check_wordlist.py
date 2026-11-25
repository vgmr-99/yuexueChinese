# -*- coding: utf-8 -*-
"""check_wordlist.py — 校验词级汉越音表的正确性。

重点检查：
  1. 重复 key（JSON 里后者会静默覆盖前者，是最隐蔽的错误）
  2. key 必须是纯汉字
  3. value 必须是合法越语（含带音符号的拉丁字母 + 空格）
"""
import json
import re
import sys
import unicodedata

PATH = 'data/wordlist_hanviet.json'

# 越语字母：ASCII 字母 + 组合附加符号（越南语的ế/ộ等是 e+combining）
OK_CHARS = re.compile(r"^[A-Za-zÀ-Ỹ\s]+$")
HAN = re.compile(r"^[\u4e00-\u9fff]+$")

raw = open(PATH, encoding='utf-8').read()
pairs = json.loads(raw, object_pairs_hook=lambda p: p)

seen = {}
dups = []
for k, v in pairs:
    if k.startswith('_'):
        continue
    if k in seen:
        dups.append((k, seen[k], v))
    seen[k] = v

print(f'词级条目: {len(seen)}')

if dups:
    print(f'\n[X] 重复 key {len(dups)} 个（后者覆盖前者）：')
    for k, a, b in dups:
        print(f'   {k}: "{a}"  被  "{b}" 覆盖')
else:
    print('[OK] 无重复 key')

bad_key = [k for k in seen if not HAN.match(k)]
bad_val = [(k, v) for k, v in seen.items() if not OK_CHARS.match(v)]
print(f'\nkey 非纯汉字: {len(bad_key)} {bad_key}')
print(f'value 非法字符: {len(bad_val)} {bad_val}')

# 音节数与字数一致性（粗检：汉越音通常每字一个音节，用空格分）
odd = [(k, v) for k, v in seen.items() if len(v.split()) != len(k)]
if odd:
    print(f'\n[!]音节数≠字数（可能正常，如词组固定读法），共 {len(odd)}:')
    for k, v in odd[:12]:
        print(f'   {k} ({len(k)}字) -> "{v}" ({len(v.split())}音节)')

sys.exit(1 if (dups or bad_key or bad_val) else 0)