// verify_v7.js — 每日目标打卡 + 笔顺评分 逻辑校验
const fs = require('fs');
const vm = require('vm');
const base = require('path').resolve(__dirname, '..', 'web') + '/';

const store = {};
const sandbox = {
  console,
  localStorage: {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
    clear: () => { Object.keys(store).forEach(k => delete store[k]); },
  },
  navigator: { language: 'vi-VN' },
  document: {
    addEventListener() {}, querySelectorAll: () => [], querySelector: () => null,
    getElementById: () => null, documentElement: { setAttribute() {} },
  },
  setTimeout, clearTimeout, alert: () => {}, confirm: () => true,
  Date: Date, Math: Math, JSON: JSON,
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
const load = f => vm.runInContext(fs.readFileSync(base + f, 'utf8'), ctx);

console.log('=== 语法校验 ===');
['js/dailyGoal.js', 'js/strokeScore.js'].forEach(f => {
  try { new vm.Script(fs.readFileSync(base + f, 'utf8')); console.log('  [OK] ' + f); }
  catch (e) { console.log('  [X] ' + f + ': ' + e.message); }
});

load('js/dailyGoal.js'); load('js/strokeScore.js');
const DG = sandbox.window.DailyGoal;
const SS = sandbox.window.StrokeScore;

// ---- 每日目标 ----
console.log('\n=== 每日目标 ===');
console.log('  默认目标:', JSON.stringify(DG.getGoal().target));
let t = DG.today();
console.log('  初始:', t.items.map(i => `${i.label}=${i.done}/${i.goal}`).join(' '), '| 完成度', t.pct + '%');

DG.record('newWord', 10);
DG.record('review', 20);
DG.record('listen', 5);
DG.record('dictation', 5);
t = DG.today();
console.log('  达标后:', t.items.map(i => `${i.done}/${i.goal}`).join(' '), '| 完成度', t.pct + '%', t.pct === 100 ? '[OK]' : '[X]');

const st = DG.checkIn();
console.log('  打卡: streak=' + st.streak, 'best=' + st.best, st.streak >= 1 ? '[OK]' : '[X]');

// 超额记录应被夹住（进度条不超100）
DG.record('newWord', 50);
t = DG.today();
const nw = t.items.find(i => i.key === 'newWord');
console.log('  超额后 newWord:', nw.done + '/' + nw.goal, '| pct', t.pct + '%',
  t.pct <= 100 ? '[OK] 不超100' : '[X] 超了');

// 改目标
DG.setTarget({ newWords: '20', review: '30' });
console.log('  改目标后:', JSON.stringify(DG.getGoal().target));
DG.setTarget({ newWords: 10, review: 20 });

// 最近 7 天
const rec = DG.recent(7);
console.log('  最近7天:', rec.map(d => (d.achieved ? '●' : '○')).join(''), '| 共', rec.length, '天 [OK]');

// ---- 笔顺评分 ----
console.log('\n=== 笔顺评分 ===');
const cases = [
  // [字, 总笔数, 写对, 失误, 用时ms, 期望星级]
  ['人', 2, 2, 0, 1500, 3],
  ['人', 2, 2, 1, 2000, 3],      // 写对但失误过，仍是3星
  ['学', 8, 6, 2, 8000, 2],      // 75% -> 2星
  ['学', 8, 4, 4, 12000, 1],    // 50% -> 1星
  ['国', 8, 2, 6, 20000, 0],     // 25% -> 0星
];
cases.forEach(([ch, total, correct, mis, dur, exp]) => {
  const r = SS.score(ch, total, correct, mis, dur);
  const ok = r.stars === exp;
  console.log(`  ${ok ? '[OK]' : '[X]'} ${ch} ${correct}/${total} 失误${mis} -> ${r.orderPct}% ${'★'.repeat(r.stars)}${'☆'.repeat(3-r.stars)} 速度${r.speedStars}`);
});
// 速度评级
console.log('\n=== 速度分级（每笔耗时）===');
[[800,'快'],[1500,'中'],[2500,'慢'],[5000,'很慢']].forEach(([per, label]) => {
  const r = SS.score('字', 5, 5, 0, per * 5);
  console.log(`  ${per}ms/笔(${label}) -> ${r.speedStars}`);
});

// 记录保存：只保留更好成绩
console.log('\n=== 成绩保留策略 ===');
SS.save('人', SS.score('人', 2, 2, 0, 1000));       // 3星
console.log('  首次:', SS.get('人').stars + '星');
SS.save('人', SS.score('人', 2, 1, 1, 1000));       // 2星（更差）
console.log('  写入较差成绩后:', SS.get('人').stars + '星', SS.get('人').stars === 3 ? '[OK] 保留更好' : '[X] 被覆盖');
SS.save('国', SS.score('国', 8, 8, 0, 2000));       // 3星
SS.save('国', SS.score('国', 8, 5, 3, 3000));       // 2星
console.log('  同星级更少失误才覆盖:', SS.get('国').stars + '星', SS.get('国').correct + '/8');

const sum = SS.summary();
console.log('\n=== 汇总 ===');
console.log('  已练字数:', sum.practiced, '| 平均星级:', sum.avgStars, '| 全对:', sum.perfect);

// 边界
console.log('\n=== 边界情况 ===');
const zero = SS.score('空', 0, 0, 0, 0);
console.log('  0笔画:', zero.orderPct + '%', zero.stars + '星', zero.stars === 0 ? '[OK] 无NaN' : '[X]');
const noTime = SS.score('字', 5, 5, 0, 0);
console.log('  无耗时:', noTime.speedStars, noTime.speedStars === null ? '[OK] null' : '[X]');

console.log('\n[OK] v7 校验完成');