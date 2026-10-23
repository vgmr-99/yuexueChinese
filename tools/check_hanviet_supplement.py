# -*- coding: utf-8 -*-
"""check_hanviet_supplement.py — 校验汉越音补充表。

补充表必须是**单字**键（多字词应放wordlist_hanviet.json），
且不得有重复 key（JSON 会静默覆盖）。
"""
import json
import re
import sys

PATH = sys.argv[1] if len(sys.argv) > 1 else 'data/hanviet_supplement.json'

raw = open(PATH, encoding='utf-8').read()
pairs = json.loads(raw, object_pairs_hook=lambda p: p)

HAN = re.compile(r"^[\u4e00-\u9fff]$")          # 必须是单个汉字
VI = re.compile(r"^[A-Za-zÀ-ỹ\s]+$")           # 拉丁+越南语符号+空格

seen = {}
dups, bad_key, bad_val = [], [], []

for k, v in pairs:
    if k.startswith('_'):
        continue
    if k in seen:
        dups.append((k, seen[k], v))
    seen[k] = v
    if not HAN.match(k):
        bad_key.append(k)
    if not VI.match(str(v)):
        bad_val.append((k, v))

print(f'条目数: {len(seen)}')
if dups:
    print(f'\n❌ 重复 key {len(dups)} 个:')
    for k, a, b in dups:
        print(f'   {k}: "{a}" 被 "{b}" 覆盖')
else:
    print('✅ 无重复 key')

if bad_key:
    print(f'\n❌ 非单字 key {len(bad_key)} 个（应放词级表）:')
    for k in bad_key:
        print(f'   {k}')
else:
    print('✅ key 均为单字')

if bad_val:
    print(f'\n❌ value 含非法字符 {len(bad_val)} 个:')
    for k, v in bad_val:
        print(f'   {k}: {v!r}')
else:
    print('✅ value 均为合法越语')

sys.exit(1 if (dups or bad_key or bad_val) else 0)