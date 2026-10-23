/**
 * strokeScore.js — 笔画书写评分
 *
 * hanzi-writer 的 quiz 模式会在写对/写错每一笔时回调，
 * 我们据此算出「笔顺正确率」，而不是只有「对/错」两个结果。
 *
 * 评分维度
 * --------
 *  1. 笔顺正确率= 写对的笔数 / 总笔数（onCorrectStroke / strokeCount）
 *  2. 首次通过率  = 一次写完没失误的次数 / 总练习次数
 *  3. 综合星级    = 满分 3 星：笔顺全对；2 星：≥70%；1 星：≥40%；0：更低
 *
 * 数据落盘：localStorage，供设置页展示「书写记录」
 */
(function (global) {
  'use strict';

  var KEY = 'vietchinese.strokerecord';

  function loadAll() {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || {};
    } catch (e) {
      return {};
    }
  }

  function saveAll(d) {
    try {
      localStorage.setItem(KEY, JSON.stringify(d));
    } catch (e) { /* 忽略 */ }
  }

  /**
   * 生成 quiz 配置（挂在 HanziWriter.quiz 上）
   * @param {string} ch 汉字
   * @param {object} total 总笔画数
   * @param {function} onDone 结束回调(summary)
   */
  function buildQuizOptions(ch, total, onDone) {
    var rec = {
      ch: ch,
      total: total,
      correct: 0,
      mistakes: 0,
      hintUsed: 0,
      startAt: Date.now(),
    };

    return {
      showHintAfterMisses: 2,
      showHintAfterCorrectAnswers: 3,
      highlightOnComplete: true,

      onCorrectStroke: function () {
        rec.correct++;
      },
      onMistake: function () {
        rec.mistakes++;
      },
      onComplete: function (summary) {
        rec.duration = Date.now() - rec.startAt;
        // hanzi-writer 自带 summary：totalMistakes 等
        var totalMistakes = summary && summary.totalMistakes != null
          ? summary.totalMistakes : rec.mistakes;
        var result = score(ch, total, rec.correct, totalMistakes, rec.duration);
        save(ch, result);
        onDone(result);
      },
    };
  }

  /**
   * 计算评分
   * @param {number} correct 写对的笔数
   * @param {number} mistakes 失误次数
   * @param {number} duration 耗时 ms
   */
  function score(ch, total, correct, mistakes, duration) {
    var orderPct = total > 0 ? Math.round(correct / total * 100) : 0;
    var stars =
      orderPct >= 100 ? 3 : orderPct >= 70 ? 2 : orderPct >= 40 ? 1 : 0;

    // 用时评分：合理区间内越快越好（太慢说明不熟）
    var speedScore = null;
    if (duration > 0) {
      var perStroke = duration / Math.max(total, 1);
      if (perStroke < 900) speedScore = 3;
      else if (perStroke < 1800) speedScore = 2;
      else if (perStroke < 3200) speedScore = 1;
      else speedScore = 0;
    }

    return {
      ch: ch,
      total: total,
      correct: correct,
      mistakes: mistakes,
      orderPct: orderPct,
      stars: stars,
      speedStars: speedScore,
      duration: duration || 0,
      at: Date.now(),
    };
  }

  function save(ch, result) {
    var all = loadAll();
    var cur = all[ch];
    // 只保留更好的成绩（星级高、或同星级但失误更少）
    if (!cur ||
        result.stars > cur.stars ||
        (result.stars === cur.stars && result.mistakes < cur.mistakes)) {
      all[ch] = result;
      saveAll(all);
    }
  }

  /** 取单字最好成绩 */
  function get(ch) {
    return loadAll()[ch] || null;
  }

  /** 汇总：练过多少字、平均星级、全对率 */
  function summary() {
    var all = loadAll();
    var keys = Object.keys(all);
    if (!keys.length) {
      return { practiced: 0, avgStars: 0, perfect: 0, records: {} };
    }
    var starSum = 0, perfect = 0;
    keys.forEach(function (k) {
      starSum += all[k].stars;
      if (all[k].stars >= 3) perfect++;
    });
    return {
      practiced: keys.length,
      avgStars: Math.round(starSum / keys.length * 10) / 10,
      perfect: perfect,
      records: all,
    };
  }

  function clear() {
    try { localStorage.removeItem(KEY); } catch (e) { /* 忽略 */ }
  }

  global.StrokeScore = {
    buildQuizOptions: buildQuizOptions,
    score: score,
    save: save,
    get: get,
    summary: summary,
    clear: clear,
  };
})(window);