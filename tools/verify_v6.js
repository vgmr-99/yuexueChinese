// verify_v6.js — v6 校验：听写判分 / 错词本 / 跨级搜索 / 句子音频
const fs = require('fs');
const vm = require('vm');
const base = 'C:/Users/PC/WorkBuddy/2026-10-16-13-34-21/viet-chinese-app/web/';

const store = {};
const sandbox = {
  console,
  localStorage: {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
    clear: () => { Object.keys(store).forEach(k => delete store[k]); },
  },
  navigator: { language: 'vi-VN', clipboard: { writeText() {} } },
  document: {
    addEventListener() {}, querySelectorAll: () => [], querySelector: () => null,
    getElementById: () => null, documentElement: { setAttribute() {} },
  },
  XMLHttpRequest: function () {},
  Audio: function () { this.play = () => {}; },
  setTimeout, clearTimeout, alert: () => {}, confirm: () => true,
  speechSynthesis: { speak() {}, cancel() {} },
  SpeechSynthesisUtterance: function () {},
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
const load = f => vm.runInContext(fs.readFileSync(base + f, 'utf8'), ctx);

// ---- 语法 ----
console.log('=== 语法校验 ===');
['data/app-data.js', 'js/pinyin.js', 'js/i18n.js', 'js/srs.js',
 'js/settings.js', 'js/dictation.js', 'js/app.js'].forEach(f => {
  try { new vm.Script(fs.readFileSync(base + f, 'utf8')); console.log('  ✅ ' + f); }
  catch (e) { console.log('  ❌ ' + f + ': ' + e.message); }
});

load('data/app-data.js'); load('js/pinyin.js');
load('js/i18n.js'); load('js/srs.js'); load('js/settings.js');
load('js/dictation.js');

const D = sandbox.window.APP_DATA;
const Dict = sandbox.window.Dictation;
const Set = sandbox.window.Settings;

// ---- 听写判分逻辑 ----
console.log('\n=== 听写判分 ===');
const cases = [
  ['你好', '你好', 'correct'],
  ['你好', '你号', 'partial'],
  ['你好', '再见', 'wrong'],
  ['银行', '银行', 'correct'],
  ['你好！', '你好', 'correct'],   // 带标点应归一化后算对
  ['  你好 ', '你好', 'correct'],  // 带空格
  ['', '你好', 'wrong'],
];
cases.forEach(([inp, ans, exp]) => {
  const r = Dict.grade(inp, ans);
  const ok = r.level === exp;
  console.log(`  ${ok ? '✅' : '❌'} "${inp}" vs "${ans}" -> ${r.level}(${r.score})`);
});

// ---- 候选字 ----
console.log('\n=== 候选字 ===');
const all = Object.values(D.levels).flat();
const cands = Dict.charCandidates('银', D.levels['2'], 4);
console.log('  银 的候选:', cands.join(' '), cands.length === 4 ? '✅' : '❌');
console.log('  含正确项:', cands.includes('银') ? '✅' : '❌');

// ---- 错词本 ----
console.log('\n=== 错词本 ===');
Set.addWrong('银行', 'quiz');
Set.addWrong('银行', 'srs');
Set.addWrong('学习', 'dictation');
console.log('  加错后:', JSON.stringify(Set.getWrongList().map(r => r.word + '×' + r.data.count)));
Set.clearWrong('银行');
console.log('  答对移除 银行 后:', JSON.stringify(Set.getWrongList().map(r => r.word)));
Set.clearAllWrong();
console.log('  清空后:', Set.getWrongList().length, '条');

// ---- 导出/导入往返 ----
console.log('\n=== 导出/导入往返 ===');
sandbox.localStorage.setItem('vietchinese.progress.v1',
  JSON.stringify({ learned: { '银行': 1000, '学习': 2000 } }));
Set.addWrong('吃饭', 'quiz');
const dump = Set.exportData();
console.log('  导出长度:', dump.length, '| 含wrong:', dump.includes('"wrong"'));
// 清空后再导入
sandbox.localStorage.clear();
const r = Set.importData(dump);
console.log('  导入结果:', JSON.stringify(r));
const back = Set.getWrongList().map(x => x.word);
console.log('  错词本恢复:', JSON.stringify(back), back.includes('吃饭') ? '✅' : '❌');
const st = Set.collectStats();
console.log('  统计: 已学', st.learnedTotal, '| 错词', st.wrongTotal);

// ---- 分级重置 ----
console.log('\n=== 分级重置 ===');
const n = Set.resetLevel('2');
console.log('  重置 HSK2，删除', n, '条');
const after = Set.collectStats();
console.log('  重置后已学:', after.learnedTotal);

// ---- 句子音频 ----
console.log('\n=== 句子音频 ===');
const manifest = JSON.parse(fs.readFileSync(base + 'audio/sentences/manifest.json', 'utf8'));
console.log('  清单条数:', manifest.length);
let ci = 0, si = 0, miss = [];
D.courses.forEach((c, i) => {
  c.sentences.forEach((s, j) => {
    const k = `s_${i}_${j}`;
    if (!manifest.includes(k)) miss.push(k);
  });
});
console.log('  缺失音频:', miss.length, miss.length ? miss.slice(0,5) : '✅ 无');
// 文件是否真实存在
let noFile = manifest.filter(k => !fs.existsSync(base + 'audio/sentences/' + k + '.mp3'));
console.log('  清单有但磁盘无:', noFile.length, noFile.length ? noFile.slice(0,3) : '✅ 无');

console.log('\n✅ v6 校验完成');