/**
 * check_i18n.js — 界面文案表一致性校验
 *
 * ## 为什么需要
 *
 * i18n 的键一多，就会出两类问题：
 *   1. **缺键**：界面直接显示 key 本身（`asPermDeniedApk` 这种），
 *      越南学员看到一串英文标识符。
 *   2. **语种不对齐**：vi 有、zh 没有（或反过来），切换语言时一半文案不变。
 *
 * 之前这两种问题都存在，只能靠人肉点页面发现。
 * 现在这个脚本在 CI 里跑，改漏了立刻红。
 *
 * 检查项：
 *   1. 代码里用到的 T('key') / asT('key') / data-i18n="key" 都必须存在于文案表
 *   2. 两种语言的键集合必须完全一致
 *   3. 同一个语言段里不允许出现重复键（后者会静默覆盖前者）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');

/** 解析 i18n.js，取出各语言的键集合 */
function parseLangKeys(file) {
  const src = fs.readFileSync(file, 'utf8');
  const langs = {};
  const langRe = /^\s{4}(\w+):\s*\{/gm;
  let m;
  while ((m = langRe.exec(src))) {
    const lang = m[1];
    const start = m.index + m[0].length;
    // 从 start 起找该段的结束大括号（按缩进层级）
    let depth = 1;
    let i = start;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    const body = src.slice(start, i);
    const keys = [];
    const seen = new Map();
    const keyRe = /^\s{6}([A-Za-z_$][\w$]*)\s*:/gm;
    let k;
    while ((k = keyRe.exec(body))) {
      keys.push(k[1]);
      seen.set(k[1], (seen.get(k[1]) || 0) + 1);
    }
    langs[lang] = { keys, dupes: [...seen.entries()].filter(([, n]) => n > 1).map(([k2]) => k2) };
  }
  return langs;
}

/** 扫描代码与 HTML 里引用到的 i18n 键 */
function collectUsedKeys() {
  const used = new Map();   // key -> [来源]

  const add = (key, where) => {
    if (!key || !/^[A-Za-z_$][\w$]*$/.test(key)) return;
    if (!used.has(key)) used.set(key, []);
    used.get(key).push(where);
  };

  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'vendor' || e.name === 'audio' || e.name === 'data') continue;
        walk(p);
      } else if (/\.(js|html)$/.test(e.name)) {
        files.push(p);
      }
    }
  };
  walk(WEB);

  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');

    // T('key') / asT('key') / t('key')
    const fnRe = /\b(?:T|asT|t)\(\s*'([A-Za-z_$][\w$]*)'/g;
    let m;
    while ((m = fnRe.exec(src))) add(m[1], rel);

    // data-i18n="key"
    const attrRe = /data-i18n\s*=\s*"([A-Za-z_$][\w$]*)"/g;
    while ((m = attrRe.exec(src))) add(m[1], rel);

    // data-i18n-placeholder / data-i18n-title 等变体
    const attr2Re = /data-i18n-[a-z]+\s*=\s*"([A-Za-z_$][\w$]*)"/g;
    while ((m = attr2Re.exec(src))) add(m[1], rel);
  }
  return used;
}

const langs = parseLangKeys(path.join(WEB, 'js', 'i18n.js'));
const langNames = Object.keys(langs);

if (!langNames.length) {
  console.error('[FAIL] 没能从 i18n.js 解析出任何语言段');
  process.exit(1);
}

let failed = 0;

console.log('\n[i18n] 语言段：' + langNames.join(' / '));

// ---- 1. 重复键 ----
console.log('\n[1] 同一语言段内的重复键');
for (const lang of langNames) {
  const d = langs[lang].dupes;
  if (d.length) {
    failed++;
    console.log(`  [FAIL] ${lang}: 重复键 ${d.join(', ')}  （后者会静默覆盖前者）`);
  } else {
    console.log(`  [OK]   ${lang}: 无重复键`);
  }
}

// ---- 2. 语种键集合对齐 ----
console.log('\n[2] 两种语言的键集合必须一致');
if (langNames.length >= 2) {
  const base = langNames[0];
  const baseSet = new Set(langs[base].keys);
  for (const lang of langNames.slice(1)) {
    const set = new Set(langs[lang].keys);
    const missing = [...baseSet].filter(k => !set.has(k));
    const extra = [...set].filter(k => !baseSet.has(k));
    if (missing.length || extra.length) {
      failed++;
      if (missing.length) console.log(`  [FAIL] ${lang} 缺少: ${missing.join(', ')}`);
      if (extra.length) console.log(`  [FAIL] ${lang} 多出: ${extra.join(', ')}`);
    } else {
      console.log(`  [OK]   ${base} ↔ ${lang} 键集合一致（${baseSet.size} 个）`);
    }
  }
} else {
  console.log('  [跳过] 只有一种语言');
}

// ---- 3. 代码里引用的键必须存在 ----
console.log('\n[3] 代码里引用的键必须存在于文案表');
const used = collectUsedKeys();
const allKeys = new Set();
for (const lang of langNames) langs[lang].keys.forEach(k => allKeys.add(k));

const missing = [];
for (const [key, where] of used) {
  if (!allKeys.has(key)) missing.push(`${key}  (${[...new Set(where)].join(', ')})`);
}
if (missing.length) {
  failed++;
  console.log(`  [FAIL] ${missing.length} 个键未定义：`);
  missing.forEach(m => console.log('         ' + m));
} else {
  console.log(`  [OK]   ${used.size} 个引用键全部已定义`);
}

// ---- 汇总 ----
console.log(`\n=== ${failed ? failed + ' 项不通过' : '全部通过'} ===`);
process.exit(failed ? 1 : 0);
