// verify_v2.js — 端到端校验 v2（数据 + 三语 + SRS 逻辑）
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
  },
  navigator: { language: 'vi-VN' },
  document: {
    addEventListener() {},
    querySelectorAll: () => [],
    getElementById: () => null,
    documentElement: { setAttribute() {}, lang: 'vi' },
  },
  XMLHttpRequest: function () {},
  Audio: function () { this.play = () => {}; },
  setTimeout, alert: () => {},
  speechSynthesis: { speak() {}, cancel() {} },
  SpeechSynthesisUtterance: function () {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);

// 语法检查
const files = ['data/app-data.js', 'js/pinyin.js', 'js/i18n.js', 'js/srs.js', 'js/app.js'];
console.log('=== 语法校验 ===');
for (const f of files) {
  try { new vm.Script(fs.readFileSync(base + f, 'utf8')); console.log('  ✅ ' + f); }
  catch (e) { console.log('  ❌ ' + f + ': ' + e.message); }
}

// 载入数据
vm.runInContext(fs.readFileSync(base + 'data/app-data.js', 'utf8'), ctx);
const D = sandbox.window.APP_DATA;
console.log('\n=== 数据 ===');
console.log('  版本:', D.meta.version, '| 总词:', D.meta.vocabTotal);
console.log('  等级分布:', JSON.stringify(D.meta.levels));
console.log('  汉越音:', D.meta.hanVietHit, '| 英文:', D.meta.englishHit, '| 音频:', D.meta.audioCount);

// 载入模块
vm.runInContext(fs.readFileSync(base + 'js/i18n.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync(base + 'js/srs.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync(base + 'js/pinyin.js', 'utf8'), ctx);

// 三语校验
console.log('\n=== 三语界面 ===');
for (const lang of ['vi', 'zh', 'en']) {
  sandbox.window.I18N.setLang(lang);
  console.log(`  ${lang}: appTitle="${sandbox.window.I18N.t('appTitle')}" review="${sandbox.window.I18N.t('review')}" dueToday="${sandbox.window.I18N.t('dueToday')}"`);
}
sandbox.window.I18N.setLang('vi');

// SRS逻辑校验（SM-2）
console.log('\n=== SRS (SM-2) 逻辑 ===');
const SRS = sandbox.window.SRS;
SRS.reset();
let now = Date.now();
// 连续答对 4 次，间隔应递增
for (let i = 0; i < 4; i++) {
  const c = SRS.review('你好', 5, now);
  console.log(`  第${i + 1}次答对: interval=${c.interval}d reps=${c.reps} ease=${c.ease.toFixed(2)}`);
  now += c.interval * 86400000;
}
// 答错后应重置
let c2 = SRS.review('你好', 1, now);
console.log(`  答错后: interval=${c2.interval}d reps=${c2.reps} lapses=${c2.lapses} (应 interval=1, reps=0)`);
const st = SRS.stats();
console.log(`  统计: total=${st.total} due=${st.due} mastered=${st.mastered}`);
const due = SRS.dueCards(Object.values(D.levels).flat(), 10);
console.log(`  到期卡数: ${due.length}`);

// 词卡字段完整性
console.log('\n=== 词卡字段抽样 ===');
const all = Object.values(D.levels).flat();
for (const w of ['你好', '银行', '学习']) {
  const it = all.find(x => x.hanzi === w);
  if (it) console.log(`  ${it.hanzi} | ${it.pinyin} |汉越音:${it.han_viet} | 越:${(it.vi || '').slice(0, 22)} | 英:${(it.en || '').slice(0, 26)} | 音频:${it.has_audio} | ${it.stroke_count}画`);
}
const withAudio = all.filter(x => x.has_audio).length;
console.log(`  有预生成音频的词: ${withAudio}`);
const noVi = all.filter(x => !x.vi).length;
const noHv = all.filter(x => !x.han_viet).length;
console.log(`  缺越南语: ${noVi} |缺汉越音: ${noHv}`);

// 音频文件抽查
console.log('\n=== 音频文件抽查 ===');
['你好', '银行', '学习'].forEach(w => {
  const p = `C:/Users/PC/WorkBuddy/2026-10-16-13-34-21/viet-chinese-app/web/audio/words/w_${w}.mp3`;
  const ok = fs.existsSync(p);
  console.log(`  w_${w}.mp3: ${ok ? '✅ ' + fs.statSync(p).size + ' bytes' : '❌ 缺失'}`);
});